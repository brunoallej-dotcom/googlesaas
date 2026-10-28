import { toBattlefieldMapModel } from '@/lib/battlefield-map-adapter';
import type { BattlefieldMapModel } from '@/lib/battlefield-map-adapter';
import { assessCriteria, detectOrigins, leadRatingIsDefault, simulationOriginOf } from './report-evidence';
import type { CriterionAssessment, DataOrigins } from './report-evidence';
import { formatDate, formatNumber, formatPercent, formatRating } from './report-format';
import { analyzeTerritory, buildRivalRows, computeScoreBreakdown } from './report-metrics';
import type { RivalRow, ScoreBreakdown, TerritoryAnalysis } from './report-metrics';
import { buildDiagnosis } from './report-narrative';
import type { Diagnosis } from './report-narrative';
import { buildPlan, PLAN_DISCLAIMER } from './report-plan';
import type { PlanWave } from './report-plan';
import type { CampaignSummary, DataOrigin, EvidenceClass, ReportSourceData } from './report-types';
import { runQualityChecks } from './report-validation';
import type { QualityCheck } from './report-validation';

export interface ReportInput {
  readonly source: ReportSourceData;
  readonly campaign?: CampaignSummary | null;
  /** Momento da geração do documento (distinto da coleta). */
  readonly generatedAt: string;
  /** Verdadeiro quando o PDF foi regenerado a partir de resultados já persistidos. */
  readonly regenerated?: boolean;
  /** O que está configurado no ambiente de geração (para declarar provedores sem inventar). */
  readonly environment?: { readonly serperConfigured: boolean; readonly dataForSeoConfigured: boolean };
}

export type ScoreLineKey = 'STORED_HISTORICAL' | 'RECALCULATED' | 'VERIFIED_PERFORMANCE';

/** Uma pontuação do Juiz, identificada pela origem e pela metodologia (nunca misturadas). */
export interface ScoreLine {
  readonly key: ScoreLineKey;
  readonly label: string;
  readonly value: number | null;
  readonly methodology: string;
  /** Soma dos pesos usados como denominador e o seu percentual do peso total. */
  readonly denominatorWeight: number;
  readonly denominatorPercent: number;
  readonly note: string;
}

export interface Kpi {
  readonly label: string;
  readonly value: string;
  readonly caption: string;
  readonly origin: EvidenceClass;
}

export type CoverageStatus = 'FULL' | 'PARTIAL' | 'NONE';

export interface ReportCoverage {
  readonly status: CoverageStatus;
  readonly stamp: string;
  readonly verifiedCriteria: number;
  readonly totalCriteria: number;
  readonly verifiedWeightPercent: number;
  /** Parcialmente verificados: contados à parte, nunca somados aos verificados. */
  readonly partialCriteria: number;
  readonly partialWeightPercent: number;
  readonly summary: string;
  /** Linha complementar sobre os parcialmente verificados (vazia quando não há). */
  readonly partialSummary: string | null;
}

export interface ProviderStatement {
  readonly area: string;
  readonly origin: DataOrigin;
  readonly statement: string;
}

export interface ReportModel {
  readonly meta: {
    readonly auditId: string;
    readonly auditIdShort: string;
    readonly generatedAt: string;
    readonly collectedAt: string | null;
    readonly regenerated: boolean;
    /** Documento de teste: dados sintéticos de fixture, nunca resultados de uma auditoria. */
    readonly testFixture: boolean;
    /** Auditoria gerada em modo demonstração (dados simulados, identificados como tal). */
    readonly demo: boolean;
  };
  readonly company: {
    readonly name: string;
    readonly placeId: string;
    readonly city: string | null;
    readonly state: string | null;
    readonly address: string | null;
    readonly keyword: string;
    readonly category: string;
    readonly frontier: string;
  };
  readonly coverage: ReportCoverage;
  readonly kpis: readonly Kpi[];
  readonly diagnosis: Diagnosis;
  readonly territory: {
    readonly map: BattlefieldMapModel;
    readonly analysis: TerritoryAnalysis;
    readonly kpis: readonly Kpi[];
    readonly origin: DataOrigin;
  };
  readonly competition: {
    readonly rivals: readonly RivalRow[];
    readonly comparison: string | null;
    readonly historyText: string;
    readonly hasRealHistory: boolean;
    /** Auditorias antigas gravaram estimativas dos rivais; elas continuam ocultas no relatório. */
    readonly estimatedFieldsHidden: boolean;
    readonly opportunities: readonly string[];
  };
  readonly judge: {
    readonly criteria: readonly CriterionAssessment[];
    readonly score: ScoreBreakdown;
    readonly healthClassification: string;
    /** Pontuações desta auditoria, cada uma com sua metodologia e denominador. */
    readonly scoreLines: readonly ScoreLine[];
  };
  readonly plan: readonly PlanWave[];
  readonly planDisclaimer: string;
  readonly methodology: {
    readonly stepMeters: number;
    readonly zoomLevel: string;
    readonly radiusMeters: number;
    readonly providers: readonly ProviderStatement[];
    readonly limitations: readonly string[];
  };
  readonly quality: readonly QualityCheck[];
}

const STORED_METHODOLOGY =
  'Fórmula original do Juiz: soma de (pontuação × peso) dividida pela soma dos pesos dos 21 critérios. Todos os critérios entram, inclusive os que dependiam de dado simulado, estimado ou fixo.';

/** Monta as pontuações desta auditoria, separando o valor gravado do recalculado e do verificado. */
export function buildScoreLines(source: ReportSourceData, score: ScoreBreakdown): readonly ScoreLine[] {
  const total = score.totalWeight;
  const lines: ScoreLine[] = [];

  // 1) Score Juiz histórico: só existe como valor GRAVADO (nunca recalculado).
  const stored =
    source.storedJudge !== undefined
      ? { value: source.storedJudge.overallScore, date: source.storedJudge.evaluatedAt, preserved: true }
      : source.judge.scoreMethod === undefined
        ? { value: source.judge.overallScore, date: source.judge.evaluatedAt, preserved: false }
        : null;
  if (stored) {
    lines.push({
      key: 'STORED_HISTORICAL',
      label: 'Score Juiz histórico (armazenado)',
      value: stored.value,
      methodology: STORED_METHODOLOGY,
      denominatorWeight: total,
      denominatorPercent: 100,
      note: `Valor gravado em ${formatDate(stored.date)}${stored.preserved ? ', preservado e não recalculado neste documento' : ''}. Inclui critérios sem comprovação.`,
    });
  }

  // 2) Pontuação recalculada: só quando a ficha usa a metodologia da Fase 4 (nova ou reavaliada).
  if (source.judge.scoreMethod === 'PHASE4_SCORED_WEIGHT') {
    lines.push({
      key: 'RECALCULATED',
      label: 'Pontuação recalculada (metodologia da Fase 4)',
      value: score.scoredWeight > 0 ? score.officialScore : null,
      methodology:
        'Mesma média ponderada, mas só sobre os critérios que têm pontuação. Critério sem pontuação não é tratado como zero nem como 100%.',
      denominatorWeight: score.scoredWeight,
      denominatorPercent: score.scoredWeightPercent,
      note: score.includesPartialIndicative
        ? 'Inclui pontuações apenas indicativas de critérios parcialmente verificados. Não é comparável ao score histórico.'
        : 'Não é comparável ao score histórico: o denominador e os critérios considerados são outros.',
    });
  }

  // 3) Desempenho nos critérios verificados (só evidência VERIFIED).
  lines.push({
    key: 'VERIFIED_PERFORMANCE',
    label: 'Desempenho nos critérios verificados',
    value: score.verified.performance,
    methodology: 'Mesma média ponderada, restrita aos critérios com evidência VERIFICADA. Parciais, não verificados e simulados ficam de fora.',
    denominatorWeight: score.verified.weight,
    denominatorPercent: score.verified.weightPercent,
    note: `${score.verified.count} de ${score.totalCriteria} critérios.`,
  });
  return lines;
}

export const NO_HISTORY_TEXT =
  'Primeira auditoria registrada. Ainda não existe base histórica suficiente para comparação.';

/** Extrai "Cidade - UF" de um endereço brasileiro ("..., Anápolis - GO, 75040-500, Brasil"). */
export function parseCityState(address: string | null): { city: string | null; state: string | null } {
  if (!address) return { city: null, state: null };
  const match = address.match(/,\s*([^,]+?)\s+-\s+([A-Z]{2})(?:,|$)/u);
  return match ? { city: match[1] ?? null, state: match[2] ?? null } : { city: null, state: null };
}

function coverageOf(score: ScoreBreakdown): ReportCoverage {
  const { verified, totalCriteria } = score;
  const status: CoverageStatus =
    verified.count === totalCriteria ? 'FULL' : verified.count === 0 && score.partial.count === 0 ? 'NONE' : 'PARTIAL';
  const stamp =
    status === 'FULL'
      ? 'AUDITORIA VERIFICADA'
      : status === 'NONE'
        ? 'AUDITORIA NÃO VERIFICADA'
        : 'AUDITORIA PARCIALMENTE VERIFICADA';
  return {
    status,
    stamp,
    verifiedCriteria: verified.count,
    totalCriteria,
    verifiedWeightPercent: verified.weightPercent,
    partialCriteria: score.partial.count,
    partialWeightPercent: score.partial.weightPercent,
    summary: `${verified.count} de ${totalCriteria} critérios verificados · ${formatPercent(verified.weightPercent, 0)} do peso total`,
    partialSummary:
      score.partial.count > 0
        ? `+ ${score.partial.count} parcialmente verificados · ${formatPercent(score.partial.weightPercent, 0)} do peso (contados à parte)`
        : null,
  };
}

function buildCoverKpis(
  source: ReportSourceData,
  map: BattlefieldMapModel,
  score: ScoreBreakdown,
  territoryOrigin: DataOrigin,
  ratingIsDefault: boolean
): readonly Kpi[] {
  const geoOk = territoryOrigin === 'COLLECTED' && map.coverage.valid > 0;
  const geoOrigin: EvidenceClass = geoOk ? 'VERIFIED' : territoryOrigin === 'SIMULATED' ? 'SIMULATED' : 'NOT_VERIFIED';
  const geoValue = (value: string | null): string => (geoOk && value !== null ? value : territoryOrigin === 'SIMULATED' ? 'Simulado' : 'Não verificado');
  return [
    {
      label: 'Desempenho nos critérios verificados',
      value: score.verified.performance === null ? 'Não disponível' : formatPercent(score.verified.performance),
      caption: `${score.verified.count} de ${score.totalCriteria} critérios · ${formatPercent(score.verified.weightPercent, 0)} do peso`,
      origin: score.verified.performance === null ? 'NOT_VERIFIED' : 'VERIFIED',
    },
    {
      label: 'Nota média do Google',
      value: ratingIsDefault ? 'Não verificado' : formatRating(source.lead.rating),
      caption: 'na listagem pública do perfil',
      origin: ratingIsDefault ? 'NOT_VERIFIED' : 'VERIFIED',
    },
    {
      label: 'Avaliações',
      value: ratingIsDefault ? 'Não verificado' : String(source.lead.totalReviews),
      caption: 'total na listagem pública',
      origin: ratingIsDefault ? 'NOT_VERIFIED' : 'VERIFIED',
    },
    {
      label: 'Índice de posição',
      value: geoValue(map.averagePosition === null ? null : formatNumber(map.averagePosition)),
      caption: geoOk
        ? `fora do Top 20 = 21${map.knownPositionAverage === null ? '' : ` · média no Top 20: ${formatNumber(map.knownPositionAverage)}`}`
        : 'sem leituras reais',
      origin: geoOrigin,
    },
    {
      label: 'Presença no Top 3',
      value: geoValue(formatPercent(map.percentages.top3)),
      caption: geoOk ? `${map.counts.top3} de ${map.coverage.valid} pontos` : 'sem leituras reais',
      origin: geoOrigin,
    },
    {
      label: 'Presença no Top 7',
      value: geoValue(formatPercent(map.percentages.top7)),
      caption: geoOk ? `${map.counts.top7} de ${map.coverage.valid} pontos` : 'sem leituras reais',
      origin: geoOrigin,
    },
  ];
}

function buildTerritoryKpis(map: BattlefieldMapModel, origin: DataOrigin): readonly Kpi[] {
  const ok = origin === 'COLLECTED' && map.coverage.valid > 0;
  const cls: EvidenceClass = ok ? 'VERIFIED' : origin === 'SIMULATED' ? 'SIMULATED' : 'NOT_VERIFIED';
  const na = origin === 'SIMULATED' ? 'Simulado' : 'Não verificado';
  const valid = map.coverage.valid;
  return [
    {
      label: 'Índice de posição',
      value: ok && map.averagePosition !== null ? formatNumber(map.averagePosition) : na,
      caption: `fora do Top 20 conta como 21 · ${valid} pontos válidos`,
      origin: cls,
    },
    {
      label: 'Posição média no Top 20',
      value: ok && map.knownPositionAverage !== null ? formatNumber(map.knownPositionAverage) : na,
      caption: ok ? `só os ${map.knownPositionPoints} pontos com posição conhecida` : 'sem leituras reais',
      origin: cls,
    },
    { label: 'Pontos válidos', value: `${valid} de ${map.coverage.expected}`, caption: `${map.coverage.unreadable} sem leitura (fora de todas as médias)${map.coverage.missing > 0 ? ` · ${map.coverage.missing} ausentes da coleta` : ''}`, origin: cls },
    { label: 'Pontos no Top 3', value: ok ? String(map.counts.top3) : na, caption: `${formatPercent(map.percentages.top3)} dos ${valid} válidos`, origin: cls },
    { label: 'Pontos no Top 7', value: ok ? String(map.counts.top7) : na, caption: `${formatPercent(map.percentages.top7)} dos ${valid} válidos`, origin: cls },
    { label: 'Fora do Top 20', value: ok ? String(map.counts.above20) : na, caption: ok ? `${formatPercent(map.percentages.above20)} dos ${valid} válidos` : 'sem leituras reais', origin: cls },
  ];
}

function buildProviders(
  origins: DataOrigins,
  env: { serperConfigured: boolean; dataForSeoConfigured: boolean },
  source: ReportSourceData,
  criteria: readonly CriterionAssessment[]
): readonly ProviderStatement[] {
  // Fixtures nunca são atribuídas a um provedor real.
  if (source.testFixture) {
    const synthetic = 'Dados sintéticos de teste (fixture). Nenhuma consulta foi feita ao Serper nem a qualquer outro provedor.';
    return [
      { area: 'Perfil e posição na prospecção', origin: 'SIMULATED', statement: synthetic },
      { area: 'Posicionamento territorial (49 pontos)', origin: 'SIMULATED', statement: synthetic },
      { area: 'Avaliações recentes e respostas', origin: 'SIMULATED', statement: synthetic },
      { area: 'Fotos, vídeos e publicações', origin: 'SIMULATED', statement: synthetic },
      { area: 'Site (resposta, indexabilidade e dados estruturados)', origin: 'SIMULATED', statement: synthetic },
    ];
  }
  const legacySuffix = simulationOriginOf(source) === 'LEGACY' ? ' Gravado por auditoria anterior à Fase 4 e preservado como histórico.' : '';
  const serper = env.serperConfigured;
  const reviews = source.reputation.reviewsAvailability;
  const vitrineInfo = source.vitrine.availability;
  const siteCriterion = criteria.find((item) => item.itemNumber === 5);
  const siteChecked = Boolean(siteCriterion?.source?.includes('Verificação técnica do site'));

  const reputationOrigin: DataOrigin = reviews ? (reviews.state === 'FETCHED' ? 'COLLECTED' : 'NOT_VERIFIED') : origins.reputation;
  const reputationStatement = reviews
    ? reviews.state === 'FETCHED'
      ? `Avaliações datadas obtidas por ${reviews.provider ?? 'provedor de avaliações'}: amostra de ${reviews.analysis?.sampleSize ?? 0} avaliações${reviews.analysis && !reviews.analysis.sampleIsComplete ? ' (parcial: não representa o total do perfil)' : ''}.`
      : `Avaliações datadas não coletadas: ${reviews.reason ?? 'nenhuma fonte configurada'}. Ritmo de avaliações e taxa de resposta ficam não verificados.`
    : origins.reputation === 'SIMULATED'
      ? `Conjunto simulado pelo sistema: não corresponde a avaliações reais do perfil.${legacySuffix}`
      : origins.reputation === 'NOT_VERIFIED'
        ? 'Nenhuma avaliação coletada.'
        : env.dataForSeoConfigured
          ? 'Amostra das avaliações mais recentes obtida por API de avaliações (DataForSEO).'
          : 'Amostra de avaliações coletada; o provedor não pôde ser identificado nesta emissão.';

  const vitrineOrigin: DataOrigin = vitrineInfo
    ? vitrineInfo.state === 'FETCHED' && vitrineInfo.fieldsProvided.length > 0
      ? 'COLLECTED'
      : origins.vitrine === 'SIMULATED'
        ? 'SIMULATED'
        : 'NOT_VERIFIED'
    : origins.vitrine;
  const vitrineStatement = vitrineInfo
    ? vitrineInfo.state === 'FETCHED' && vitrineInfo.fieldsProvided.length > 0
      ? `Somente os campos informados pela fonte: ${vitrineInfo.fieldsProvided.join(', ')}. Os demais não estão disponíveis.`
      : origins.vitrine === 'SIMULATED'
        ? `Conjunto simulado pelo sistema: não foi lido do perfil.${legacySuffix}`
        : `Não coletados: ${vitrineInfo.reason ?? 'nenhuma fonte disponível'} Dependem do painel do proprietário (acesso autorizado).`
    : origins.vitrine === 'SIMULATED'
      ? `Conjunto simulado pelo sistema: não foi lido do perfil.${legacySuffix}`
      : origins.vitrine === 'NOT_VERIFIED'
        ? 'Nenhuma mídia coletada.'
        : 'Mídias coletadas; o provedor não pôde ser identificado nesta emissão.';

  return [
    {
      area: 'Perfil e posição na prospecção',
      origin: 'COLLECTED',
      statement: serper
        ? 'Listagem pública do Google Maps obtida pelo provedor Serper.dev.'
        : 'Listagem pública do Google Maps; o provedor não pôde ser identificado nesta emissão.',
    },
    {
      area: 'Posicionamento territorial (49 pontos)',
      origin: origins.battlefield,
      statement:
        origins.battlefield === 'SIMULATED'
          ? `Conjunto simulado pelo sistema: não são buscas reais.${legacySuffix}`
          : origins.battlefield === 'NOT_VERIFIED'
            ? 'Nenhum ponto coletado.'
            : serper
              ? 'Buscas por coordenada no Google Maps, executadas pelo provedor Serper.dev.'
              : 'Buscas por coordenada no Google Maps; o provedor não pôde ser identificado nesta emissão.',
    },
    {
      area: 'Avaliações recentes e respostas',
      origin: reputationOrigin,
      statement: reputationStatement,
    },
    {
      area: 'Fotos, vídeos e publicações',
      origin: vitrineOrigin,
      statement: vitrineStatement,
    },
    {
      area: 'Site (resposta, indexabilidade e dados estruturados)',
      origin: siteChecked ? 'COLLECTED' : 'NOT_VERIFIED',
      statement: siteChecked
        ? 'Verificação técnica por requisição pública ao site informado na listagem (sem API paga). Não comprova a indexação no Google.'
        : 'Verificação técnica do site não executada nesta emissão; dados estruturados e indexabilidade não verificados.',
    },
  ];
}

export function buildReportModel(input: ReportInput): ReportModel {
  const { source, campaign, generatedAt } = input;
  const env = input.environment ?? { serperConfigured: false, dataForSeoConfigured: false };
  const { lead, battlefield } = source;

  const mapModel = toBattlefieldMapModel({ battlefield, lead, auditId: source.auditId });
  const origins = detectOrigins(source);
  const criteria = assessCriteria(source, mapModel, origins);
  const score = computeScoreBreakdown(criteria, source.judge.overallScore);
  const territory = analyzeTerritory(mapModel);
  const rivalRows = buildRivalRows(source.rivals);
  const keyword = battlefield.pureKeyword || campaign?.nicheKeyword || 'Não disponível';
  const ratingDefault = leadRatingIsDefault(lead);

  const parsed = parseCityState(lead.addressRaw);
  const city = campaign?.city ?? parsed.city;
  const state = campaign?.stateCode ?? parsed.state;

  const diagnosis = buildDiagnosis({
    data: source,
    criteria,
    model: mapModel,
    territory,
    rivalRows,
    score,
    keyword,
    territoryOrigin: origins.battlefield,
  });
  const plan = buildPlan(source, criteria, mapModel, territory, rivalRows);

  // Histórico: só com rodada anterior real (o adaptador descarta o baseline sem rodada).
  const evolution = mapModel.evolution;
  const historyText = evolution
    ? `Comparação com a auditoria anterior de ${formatDate(evolution.previousExecutedAt)} (mesma empresa e palavra-chave): pontos no Top 3 ${evolution.previousGreenTop3Count === null ? 'não disponível' : `de ${evolution.previousGreenTop3Count}`} para ${mapModel.counts.top3}${evolution.greenPointsDelta === null ? '' : ` (${evolution.greenPointsDelta >= 0 ? '+' : ''}${evolution.greenPointsDelta})`}${evolution.averagePositionDelta === null ? '' : `; variação da posição média ${evolution.averagePositionDelta > 0 ? '+' : ''}${formatNumber(evolution.averagePositionDelta, 2)} (valor negativo indica melhora)`}.`
    : source.battlefield.historicalEvolution?.incompatibleReason
      ? `Existe medição anterior desta empresa e palavra-chave, mas ela não é comparável com a atual: ${source.battlefield.historicalEvolution.incompatibleReason} Nenhuma evolução foi calculada.`
      : NO_HISTORY_TEXT;

  const leader = rivalRows[0];
  const comparison =
    leader && leader.ratingVerified && leader.totalReviews !== null && !ratingDefault
      ? `A empresa tem ${lead.totalReviews} avaliações (nota ${formatRating(lead.rating)}); o líder territorial, ${leader.name}, tem ${leader.totalReviews} (nota ${leader.rating === null ? 'não disponível' : formatRating(leader.rating)}). Valores coletados na listagem pública.`
      : null;

  const opportunities: string[] = [];
  if (mapModel.counts.top4to7 + mapModel.counts.rank8to20 > 0 && origins.battlefield === 'COLLECTED') {
    const reachable = mapModel.counts.top4to7 + mapModel.counts.rank8to20;
    opportunities.push(`${reachable} ${reachable === 1 ? 'ponto tem' : 'pontos têm'} a empresa entre as posições 4 e 20: são as áreas de conversão mais próxima em Top 3.`);
  }
  if (leader && leader.pointsLed > 0) {
    opportunities.push(`O líder territorial lidera ${leader.pointsLed} pontos: as áreas que ele domina são onde o ganho de posição é mais difícil.`);
  }
  if (territory.companyPointLabel === 'acima de 20') {
    opportunities.push('A empresa não aparece entre as 20 primeiras no próprio ponto onde está localizada: investigar a causa é a oportunidade mais direta.');
  }
  if (opportunities.length === 0) {
    opportunities.push('Não há oportunidades territoriais comprováveis com os dados desta auditoria.');
  }

  const radiusMeters = battlefield.stepMeters * 3;
  const limitations: string[] = [
    ...(source.testFixture ? ['DOCUMENTO DE TESTE: todos os dados são sintéticos (fixtures) e não vieram de nenhuma consulta real ao Serper ou a outro provedor.'] : []),
    'As posições refletem buscas por coordenada em um instante; mudam com o tempo, o dispositivo e o usuário.',
    `A grade 7x7 cobre cerca de ${formatNumber(radiusMeters / 1000, 1)} km em cada direção a partir do centro (passo de ${battlefield.stepMeters} m); áreas fora dela não foram medidas.`,
    'Os dados de perfil vêm da listagem pública do Google Maps. Informações internas do painel (propriedade, atributos, serviços) não são acessadas.',
    'Não houve acesso à API oficial do Google Business Profile.',
    source.rivals?.topDominators?.some((rival) => rival.totalPhotosCount !== null)
      ? 'Nota e avaliações de concorrentes vêm da listagem; valores iguais aos padrão do sistema foram tratados como não verificados. Fotos e taxa de resposta de concorrentes não são apresentadas porque são estimadas pelo sistema.'
      : 'Nota e avaliações de concorrentes vêm da listagem pública; fotos, ritmo de avaliações e taxa de resposta de concorrentes não são coletados e, por isso, não aparecem.',
    'A comparação histórica só ocorre entre rodadas compatíveis: mesma empresa e palavra-chave, mesmo centro, zoom e espaçamento da grade, cobertura mínima de leituras e dados reais. Do contrário, nenhuma evolução é calculada.',
    'O índice de posição é uma média limitada (pontos fora do Top 20 valem 21); a posição real nesses pontos é desconhecida.',
  ];
  if (origins.reputation === 'SIMULATED') limitations.push('As avaliações e a taxa de resposta desta auditoria são simuladas pelo sistema e não representam o perfil real.');
  if (source.reputation.reviewsAvailability?.state === 'UNAVAILABLE') {
    limitations.push('O ritmo de novas avaliações e a taxa de resposta do proprietário não foram comprovados: não há fonte de avaliações datadas ativa nesta auditoria.');
  }
  if (source.vitrine.availability?.state === 'UNAVAILABLE') {
    limitations.push('Fotos, vídeos, datas de mídia e publicações não foram comprovados: nenhuma fonte pública fornece esses dados, que dependem do painel do proprietário (acesso autorizado).');
  }
  if (origins.vitrine === 'SIMULATED') limitations.push('As fotos, vídeos e publicações desta auditoria são simulados pelo sistema e não representam o perfil real.');

  const texts: string[] = [
    ...diagnosis.situation,
    ...diagnosis.strengths,
    ...diagnosis.opportunities,
    ...diagnosis.risks,
    diagnosis.priority,
    ...territory.findings,
    ...opportunities,
    ...criteria.flatMap((c) => [c.recommendation, c.evidence ?? '', c.reason ?? '']),
    ...plan.flatMap((wave) => [...wave.maintain, ...wave.actions.flatMap((a) => [a.title, a.objective, a.justification, a.indicator])]),
  ];
  const quality = runQualityChecks({
    model: mapModel,
    score,
    criteria,
    plan,
    texts,
    rating: lead.rating,
    leaderReviews: leader?.totalReviews ?? null,
    myReviews: lead.totalReviews,
  });

  return {
    meta: {
      auditId: source.auditId,
      auditIdShort: source.auditId.slice(0, 8),
      generatedAt,
      collectedAt: battlefield.executedAt ?? null,
      regenerated: input.regenerated ?? false,
      testFixture: source.testFixture === true,
      demo: source.judge.evidenceBundle?.demo === true || source.battlefield.dataOrigin === 'SIMULATED',
    },
    company: {
      name: lead.businessName,
      placeId: lead.placeId,
      city,
      state,
      address: lead.addressRaw,
      keyword,
      category: lead.primaryCategory,
      frontier: `Posição ${lead.frontierRank} (${lead.frontierPage}ª página) na prospecção`,
    },
    coverage: coverageOf(score),
    kpis: buildCoverKpis(source, mapModel, score, origins.battlefield, ratingDefault),
    diagnosis,
    territory: {
      map: mapModel,
      analysis: territory,
      kpis: buildTerritoryKpis(mapModel, origins.battlefield),
      origin: origins.battlefield,
    },
    competition: {
      rivals: rivalRows,
      comparison,
      historyText,
      hasRealHistory: evolution !== null,
      estimatedFieldsHidden: source.rivals?.topDominators?.some((rival) => rival.totalPhotosCount !== null) ?? false,
      opportunities,
    },
    judge: { criteria, score, healthClassification: source.judge.healthClassification, scoreLines: buildScoreLines(source, score) },
    plan,
    planDisclaimer: PLAN_DISCLAIMER,
    methodology: {
      stepMeters: battlefield.stepMeters,
      zoomLevel: battlefield.zoomLevel,
      radiusMeters,
      providers: buildProviders(origins, env, source, criteria),
      limitations,
    },
    quality,
  };
}

