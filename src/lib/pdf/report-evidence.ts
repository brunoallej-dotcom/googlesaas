import type {
  BattlefieldMetrics,
  FrontierLead,
  JudgeChecklistItem,
  ReputationMetrics,
  RivalsMetrics,
  VitrineMetrics,
} from '@/types/gmn';
import type { BattlefieldMapModel } from '@/lib/battlefield-map-adapter';
import { assessAllCriteria } from '@/lib/evidence/criteria';
import type { AuditEvidence, EvidenceStatus } from '@/lib/evidence/types';
import { formatDate, formatNumber, formatPercent, formatRating } from './report-format';
import type {
  CriterionDisplayStatus,
  SimulationOrigin,
  CriterionGroupKey,
  DataOrigin,
  EvidenceClass,
  ReportSourceData,
} from './report-types';

/**
 * ============================================================================
 * EVIDÊNCIA: separa o que foi realmente coletado do que é simulado ou sem fonte.
 *
 * Os agentes de coleta ainda produzem alguns dados simulados ou com valores padrão. Este módulo
 * não os corrige (isso é uma fase própria); ele os RECONHECE pelos marcadores que deixam nos
 * resultados persistidos, para o relatório nunca apresentá-los como fatos.
 * ============================================================================
 */

export {
  detectBattlefieldOrigin,
  detectReputationOrigin,
  detectVitrineOrigin,
  leadRatingIsDefault,
  leaderValuesAreDefault,
} from '@/lib/evidence/origins';
import {
  detectBattlefieldOrigin,
  detectReputationOrigin,
  detectVitrineOrigin,
  leadRatingIsDefault,
  leaderValuesAreDefault,
} from '@/lib/evidence/origins';

export interface DataOrigins {
  readonly reputation: DataOrigin;
  readonly vitrine: DataOrigin;
  readonly battlefield: DataOrigin;
  readonly leadRatingIsDefault: boolean;
}

export function detectOrigins(data: ReportSourceData): DataOrigins {
  return {
    reputation: detectReputationOrigin(data.reputation, data.lead.placeId),
    vitrine: detectVitrineOrigin(data.vitrine, data.lead.placeId),
    battlefield: detectBattlefieldOrigin(data.battlefield),
    leadRatingIsDefault: leadRatingIsDefault(data.lead),
  };
}

/* -------------------------------------------------------------------------- */
/* Grupos de apresentação dos 21 critérios                                    */
/* -------------------------------------------------------------------------- */

export interface CriterionGroup {
  readonly key: CriterionGroupKey;
  readonly label: string;
  readonly codes: readonly string[];
}

export const CRITERION_GROUPS: readonly CriterionGroup[] = [
  {
    key: 'IDENTITY',
    label: 'Identidade e configurações do perfil',
    codes: ['NAP_01_CLAIMED', 'NAP_02_NAME_SEMANTICS', 'NAP_03_ADDRESS_CONTEXT', 'CAT_09_ATTRIBUTES_HOURS'],
  },
  {
    key: 'CONVERSION',
    label: 'Conversão e presença digital',
    codes: ['NAP_04_WHATSAPP_CONVERSION', 'NAP_05_OWN_WEBSITE'],
  },
  {
    key: 'CATEGORIES',
    label: 'Categorias e serviços',
    codes: ['CAT_06_PRIMARY_MATCH', 'CAT_07_SECONDARY_DEPTH', 'CAT_08_SERVICES_CATALOG'],
  },
  {
    key: 'REPUTATION',
    label: 'Reputação e avaliações',
    codes: [
      'REP_10_RATING_HEALTH',
      'REP_11_VOLUME_VS_LEADER',
      'REP_12_VELOCITY_30D',
      'REP_13_OWNER_RESPONSE_RATE',
      'REP_14_KEYWORD_RICHTEXT_REVIEWS',
    ],
  },
  {
    key: 'MEDIA',
    label: 'Fotos, vídeos e publicações',
    codes: ['VIT_15_PHOTO_VOLUME', 'VIT_16_VIDEO_ASSETS', 'VIT_17_MEDIA_FRESHNESS', 'VIT_18_GOOGLE_POSTS_CADENCE'],
  },
  {
    key: 'GEO',
    label: 'Posicionamento geográfico e concorrencial',
    codes: ['GEO_19_TOP3_SHARE', 'GEO_20_TOP7_PRESENCE', 'GEO_21_INVISIBILITY_SHIELD'],
  },
];

const OTHER_GROUP_LABEL = 'Outros critérios';

export function groupLabel(key: CriterionGroupKey): string {
  return CRITERION_GROUPS.find((group) => group.key === key)?.label ?? OTHER_GROUP_LABEL;
}

export function groupKeyForCode(code: string): CriterionGroupKey {
  return CRITERION_GROUPS.find((group) => group.codes.includes(code))?.key ?? 'OTHER';
}

/* -------------------------------------------------------------------------- */
/* Avaliação de cada critério                                                 */
/* -------------------------------------------------------------------------- */

export interface CriterionAssessment {
  readonly itemNumber: number;
  readonly code: string;
  readonly title: string;
  readonly groupKey: CriterionGroupKey;
  readonly weight: number;
  /** Pontuação atribuída pelo agente (0..100). `null` = sem base de pontuação (não é zero nem 100). */
  readonly agentScore: number | null;
  readonly agentStatus: JudgeChecklistItem['status'];
  readonly evidenceClass: EvidenceClass;
  readonly displayStatus: CriterionDisplayStatus;
  /** Por que o critério não foi comprovado (nulo quando comprovado). */
  readonly reason: string | null;
  /** Evidência escrita a partir de dados comprovados (nula quando não comprovado). */
  readonly evidence: string | null;
  /** Recomendação coerente com a evidência; para não comprovados, o que validar. */
  readonly recommendation: string;
  /** O que a conclusão NÃO cobre (limitações da evidência). */
  readonly limitations: readonly string[];
  /** Fonte e data da evidência, quando conhecidas. */
  readonly source: string | null;
  /** Origem do dado simulado (só quando `evidenceClass` é SIMULATED). */
  readonly simulationOrigin: SimulationOrigin | null;
}

/**
 * Distingue o dado simulado LEGADO (gravado por auditorias anteriores à Fase 4) do dado simulado ATUAL
 * (modo demonstração) e do sintético de fixtures. Auditorias novas nunca geram simulação fora do modo
 * demonstração; qualquer simulação nelas só pode ser DEMO.
 */
export function simulationOriginOf(data: ReportSourceData): SimulationOrigin {
  if (data.testFixture) return 'FIXTURE';
  if (data.judge.evidenceBundle?.demo || data.battlefield.dataOrigin === 'SIMULATED') return 'DEMO';
  const phase4Collection = data.reputation.reviewsAvailability !== undefined || data.vitrine.availability !== undefined;
  return phase4Collection ? 'DEMO' : 'LEGACY';
}

export const SIMULATION_ORIGIN_LABEL: Record<SimulationOrigin, string> = {
  LEGACY: 'SIMULADO (LEGADO, ANTERIOR À FASE 4)',
  DEMO: 'SIMULADO (MODO DEMONSTRAÇÃO)',
  FIXTURE: 'SINTÉTICO (FIXTURE DE TESTE)',
};

interface Context {
  readonly lead: FrontierLead;
  readonly reputation: ReputationMetrics;
  readonly vitrine: VitrineMetrics;
  readonly battlefield: BattlefieldMetrics;
  readonly rivals: RivalsMetrics;
  readonly model: BattlefieldMapModel;
  readonly origins: DataOrigins;
}

interface Verdict {
  readonly cls: EvidenceClass;
  readonly reason?: string;
  readonly evidence?: string;
}

const verified = (evidence: string): Verdict => ({ cls: 'VERIFIED', evidence });
const notVerified = (reason: string): Verdict => ({ cls: 'NOT_VERIFIED', reason });
const simulated = (reason: string): Verdict => ({ cls: 'SIMULATED', reason });

const SIMULATED_REPUTATION =
  'As avaliações desta auditoria vieram de um conjunto simulado pelo sistema (não são avaliações reais do perfil).';
const SIMULATED_VITRINE =
  'Fotos, vídeos e publicações desta auditoria vieram de um conjunto simulado pelo sistema (não foram lidos do perfil).';
const SIMULATED_GEO =
  'Os pontos do território desta auditoria vieram de um conjunto simulado pelo sistema (não são buscas reais).';

function reputationVerdict(ctx: Context, build: () => Verdict): Verdict {
  if (ctx.origins.reputation === 'SIMULATED') return simulated(SIMULATED_REPUTATION);
  if (ctx.origins.reputation === 'NOT_VERIFIED') return notVerified('Nenhuma avaliação foi coletada nesta auditoria.');
  return build();
}

function vitrineVerdict(ctx: Context, build: () => Verdict): Verdict {
  if (ctx.origins.vitrine === 'SIMULATED') return simulated(SIMULATED_VITRINE);
  if (ctx.origins.vitrine === 'NOT_VERIFIED') return notVerified('Nenhuma mídia foi coletada nesta auditoria.');
  return build();
}

function geoVerdict(ctx: Context, build: () => Verdict): Verdict {
  if (ctx.origins.battlefield === 'SIMULATED') return simulated(SIMULATED_GEO);
  if (ctx.origins.battlefield === 'NOT_VERIFIED' || ctx.model.coverage.valid === 0) {
    return notVerified('Nenhuma leitura válida do território foi coletada.');
  }
  return build();
}

function topRival(ctx: Context): RivalsMetrics['topDominators'][number] | undefined {
  return ctx.rivals?.topDominators?.[0];
}

const VERDICTS: Record<string, (ctx: Context) => Verdict> = {
  NAP_01_CLAIMED: () =>
    notVerified('A coleta não informa se o perfil foi reivindicado: o sistema assume "sim" por padrão.'),
  NAP_02_NAME_SEMANTICS: () =>
    notVerified('Heurística sobre o nome comercial: não comprova otimização semântica nem excesso de palavras-chave.'),
  NAP_03_ADDRESS_CONTEXT: ({ lead }) =>
    lead.addressRaw && lead.addressRaw.trim().length >= 5 && !lead.isAddressHidden
      ? verified(`Endereço público na listagem: ${lead.addressRaw.trim()}.`)
      : notVerified('Endereço ausente na coleta: não é possível comprovar se está oculto nem o modelo de atendimento.'),
  NAP_04_WHATSAPP_CONVERSION: ({ lead }) =>
    lead.whatsappStatus === 'VERIFIED_WHATSAPP'
      ? verified('Link público de WhatsApp informado na listagem do perfil.')
      : notVerified(
          lead.phoneRaw
            ? 'Há telefone na listagem, mas a existência de WhatsApp ativo não foi confirmada.'
            : 'Nenhum telefone foi coletado; a ausência na coleta não comprova que o perfil não tenha WhatsApp.'
        ),
  NAP_05_OWN_WEBSITE: ({ lead }) =>
    lead.websiteUrl
      ? verified(
          lead.websiteStatus === 'OWN_DOMAIN'
            ? `Domínio próprio informado na listagem: ${lead.websiteUrl} (indexação e dados estruturados não foram verificados).`
            : `A listagem aponta apenas para rede social ou agregador: ${lead.websiteUrl}.`
        )
      : notVerified('Nenhum site foi coletado; a ausência na coleta não comprova que o perfil não tenha site.'),
  CAT_06_PRIMARY_MATCH: () =>
    notVerified('Resultado fixo do agente (sempre aprovado): a aderência da categoria não é medida.'),
  CAT_07_SECONDARY_DEPTH: ({ lead }) =>
    lead.secondaryCategories.length > 0
      ? verified(`${lead.secondaryCategories.length} categoria(s) secundária(s) na listagem coletada.`)
      : notVerified('Nenhuma categoria secundária foi encontrada na coleta; isso não comprova que o perfil não as tenha.'),
  CAT_08_SERVICES_CATALOG: () =>
    notVerified('O número de serviços é estimado a partir de tipos de local, não lido da lista de serviços do perfil.'),
  CAT_09_ATTRIBUTES_HOURS: () =>
    notVerified('Os atributos do perfil não são coletados (o valor usado pelo agente é fixo).'),
  REP_10_RATING_HEALTH: (ctx) =>
    ctx.origins.leadRatingIsDefault
      ? notVerified('Nota e avaliações coincidem com os valores padrão do prospector (dado ausente na coleta).')
      : verified(`Nota ${formatRating(ctx.lead.rating)} com ${ctx.lead.totalReviews} avaliações na listagem do Google.`),
  REP_11_VOLUME_VS_LEADER: (ctx) => {
    const leader = topRival(ctx);
    if (ctx.origins.leadRatingIsDefault) {
      return notVerified('O total de avaliações da empresa coincide com o valor padrão do prospector.');
    }
    if (!leader || ctx.origins.battlefield !== 'COLLECTED') {
      return notVerified('Não há líder territorial coletado para comparação.');
    }
    if (leaderValuesAreDefault(leader.rating, leader.totalReviews)) {
      return notVerified('Os dados do líder coincidem com valores padrão do sistema (nota 4,8 e 140 avaliações).');
    }
    return verified(
      `${ctx.lead.totalReviews} avaliações da empresa contra ${leader.totalReviews} do líder territorial (${leader.businessName}), ambos coletados na listagem.`
    );
  },
  REP_12_VELOCITY_30D: (ctx) =>
    reputationVerdict(ctx, () =>
      verified(
        `${ctx.reputation.interactionsLast30Days} avaliações nos últimos 30 dias, na amostra de ${ctx.reputation.recentReviewsSample.length} avaliações mais recentes coletadas.`
      )
    ),
  REP_13_OWNER_RESPONSE_RATE: (ctx) =>
    reputationVerdict(ctx, () =>
      verified(
        `${formatPercent(ctx.reputation.ownerResponseRatePercent)} das avaliações da amostra (${ctx.reputation.recentReviewsSample.length} mais recentes) têm resposta do proprietário.`
      )
    ),
  REP_14_KEYWORD_RICHTEXT_REVIEWS: () =>
    notVerified('Resultado fixo do agente: o texto das avaliações não é analisado.'),
  VIT_15_PHOTO_VOLUME: (ctx) =>
    vitrineVerdict(ctx, () =>
      verified(`${ctx.vitrine.totalPhotosCount} fotos (${ctx.vitrine.ownerPhotosCount} do proprietário e ${ctx.vitrine.customerPhotosCount} de clientes).`)
    ),
  VIT_16_VIDEO_ASSETS: (ctx) =>
    vitrineVerdict(ctx, () => verified(`${ctx.vitrine.totalVideosCount} vídeo(s) na galeria.`)),
  VIT_17_MEDIA_FRESHNESS: (ctx) =>
    vitrineVerdict(ctx, () =>
      ctx.vitrine.daysSinceLastMedia === null
        ? notVerified('Nenhuma data de mídia foi coletada.')
        : verified(`Última mídia publicada há ${ctx.vitrine.daysSinceLastMedia} dias.`)
    ),
  VIT_18_GOOGLE_POSTS_CADENCE: (ctx) =>
    vitrineVerdict(ctx, () =>
      ctx.vitrine.daysSinceLastPost === null
        ? notVerified('Nenhuma data de publicação foi coletada.')
        : verified(`Última publicação há ${ctx.vitrine.daysSinceLastPost} dias.`)
    ),
  GEO_19_TOP3_SHARE: (ctx) =>
    geoVerdict(ctx, () =>
      verified(
        `${ctx.model.counts.top3} de ${ctx.model.coverage.valid} leituras válidas no Top 3 (${formatPercent(ctx.model.percentages.top3)}).`
      )
    ),
  GEO_20_TOP7_PRESENCE: (ctx) =>
    geoVerdict(ctx, () =>
      verified(
        `${ctx.model.counts.top7} de ${ctx.model.coverage.valid} leituras válidas até a 7ª posição (${formatPercent(ctx.model.percentages.top7)}); posição média ${ctx.model.averagePosition === null ? 'não disponível' : formatNumber(ctx.model.averagePosition)}.`
      )
    ),
  GEO_21_INVISIBILITY_SHIELD: (ctx) =>
    geoVerdict(ctx, () =>
      verified(
        `${ctx.model.counts.above20} de ${ctx.model.coverage.valid} leituras válidas fora das 20 primeiras posições (${formatPercent(ctx.model.percentages.above20)}).`
      )
    ),
};

/** O que validar manualmente quando o critério não foi comprovado. */
export const VERIFY_HINTS: Record<string, string> = {
  NAP_01_CLAIMED: 'Confirmar no painel do perfil se a propriedade está verificada.',
  NAP_02_NAME_SEMANTICS: 'Conferir se o nome comercial segue as diretrizes do Google (sem palavras-chave extras).',
  NAP_03_ADDRESS_CONTEXT: 'Conferir no perfil se o endereço está exibido ou oculto e o tipo de atendimento.',
  NAP_04_WHATSAPP_CONVERSION: 'Confirmar se o número tem WhatsApp ativo e se há link de mensagem no perfil.',
  NAP_05_OWN_WEBSITE: 'Conferir no perfil o link do site e se ele abre corretamente.',
  CAT_06_PRIMARY_MATCH: 'Comparar a categoria principal com a dos líderes do território.',
  CAT_07_SECONDARY_DEPTH: 'Conferir no painel as categorias secundárias cadastradas.',
  CAT_08_SERVICES_CATALOG: 'Conferir no painel a lista de serviços cadastrados e suas descrições.',
  CAT_09_ATTRIBUTES_HOURS: 'Conferir no painel os atributos e os horários (inclusive feriados).',
  REP_12_VELOCITY_30D: 'Contar no painel as avaliações recebidas nos últimos 30 dias.',
  REP_13_OWNER_RESPONSE_RATE: 'Conferir no painel quantas avaliações estão sem resposta.',
  REP_14_KEYWORD_RICHTEXT_REVIEWS: 'Ler as avaliações recentes e verificar se citam o serviço prestado.',
  VIT_15_PHOTO_VOLUME: 'Conferir no perfil o total de fotos do proprietário e de clientes.',
  VIT_16_VIDEO_ASSETS: 'Conferir no perfil se há vídeos publicados.',
  VIT_17_MEDIA_FRESHNESS: 'Conferir no perfil a data da última foto ou vídeo.',
  VIT_18_GOOGLE_POSTS_CADENCE: 'Conferir no painel a data da última publicação (Google Posts).',
  REP_10_RATING_HEALTH: 'Conferir a nota atual diretamente no perfil.',
  REP_11_VOLUME_VS_LEADER: 'Comparar, no Google Maps, o total de avaliações com o do líder do território.',
  GEO_19_TOP3_SHARE: 'Repetir a coleta territorial para confirmar as posições.',
  GEO_20_TOP7_PRESENCE: 'Repetir a coleta territorial para confirmar as posições.',
  GEO_21_INVISIBILITY_SHIELD: 'Repetir a coleta territorial para confirmar as posições.',
};

const MAINTAIN: Record<string, string> = {
  NAP_03_ADDRESS_CONTEXT: 'Manter o endereço igual em todos os canais (site, perfil e cadastros).',
  NAP_04_WHATSAPP_CONVERSION: 'Manter o link de WhatsApp ativo e acompanhar os contatos recebidos.',
  NAP_05_OWN_WEBSITE: 'Manter o site no ar e atualizado.',
  CAT_07_SECONDARY_DEPTH: 'Manter as categorias secundárias alinhadas aos serviços prestados.',
  REP_10_RATING_HEALTH: 'Critério atendido: manter a qualidade do atendimento e o monitoramento da nota.',
  REP_11_VOLUME_VS_LEADER: 'Critério atendido: manter o ritmo de novas avaliações.',
  REP_12_VELOCITY_30D: 'Critério atendido: manter o ritmo de avaliações.',
  REP_13_OWNER_RESPONSE_RATE: 'Critério atendido: manter as respostas em dia.',
  VIT_15_PHOTO_VOLUME: 'Critério atendido: manter o acervo atualizado.',
  VIT_16_VIDEO_ASSETS: 'Critério atendido: manter os vídeos atualizados.',
  VIT_17_MEDIA_FRESHNESS: 'Critério atendido: manter a rotina de novas mídias.',
  VIT_18_GOOGLE_POSTS_CADENCE: 'Critério atendido: manter a cadência de publicações.',
  GEO_19_TOP3_SHARE: 'Critério atendido: manter e ampliar a presença no Top 3.',
  GEO_20_TOP7_PRESENCE: 'Critério atendido: manter a presença até o Top 7.',
  GEO_21_INVISIBILITY_SHIELD: 'Critério atendido: manter a baixa invisibilidade.',
};

function improvement(code: string, ctx: Context): string {
  const leader = topRival(ctx);
  switch (code) {
    case 'NAP_05_OWN_WEBSITE':
      return 'Publicar um site em domínio próprio e vinculá-lo ao perfil.';
    case 'CAT_07_SECONDARY_DEPTH':
      return 'Avaliar, no painel, categorias secundárias adicionais relevantes (as dos líderes do território servem de referência).';
    case 'REP_10_RATING_HEALTH':
      return 'Identificar padrões nas avaliações de menor nota e tratá-los no atendimento.';
    case 'REP_11_VOLUME_VS_LEADER': {
      const gap = leader && leader.totalReviews !== null ? Math.max(0, leader.totalReviews - ctx.lead.totalReviews) : 0;
      return gap > 0
        ? `Há ${gap} avaliações de diferença para o líder territorial. Estruturar um pedido recorrente de avaliação a clientes reais, sem incentivo nem texto induzido.`
        : 'Manter o pedido recorrente de avaliações a clientes reais.';
    }
    case 'REP_12_VELOCITY_30D':
      return 'Criar uma rotina para pedir avaliação a clientes reais após o atendimento.';
    case 'REP_13_OWNER_RESPONSE_RATE':
      return 'Responder as avaliações pendentes com atenção ao que o cliente relatou.';
    case 'VIT_15_PHOTO_VOLUME':
      return 'Publicar fotos próprias e autênticas do espaço, da equipe e dos serviços.';
    case 'VIT_16_VIDEO_ASSETS':
      return 'Publicar vídeos curtos e reais do atendimento.';
    case 'VIT_17_MEDIA_FRESHNESS':
      return 'Definir uma rotina fixa de novas fotos e vídeos.';
    case 'VIT_18_GOOGLE_POSTS_CADENCE':
      return 'Retomar publicações no perfil com informações úteis e chamada para contato.';
    case 'GEO_19_TOP3_SHARE':
    case 'GEO_20_TOP7_PRESENCE': {
      const reachable = ctx.model.counts.top4to7 + ctx.model.counts.rank8to20;
      return reachable > 0
        ? `Priorizar os ${reachable} pontos em que já há presença entre as posições 4 e 20, para tentar levá-los ao Top 3.`
        : 'Sem pontos entre as posições 4 e 20: priorizar relevância da categoria, reputação e dados do perfil antes de ampliar o território.';
    }
    case 'GEO_21_INVISIBILITY_SHIELD':
      return 'Concentrar o esforço nas áreas onde a empresa já aparece e acompanhar o avanço na próxima medição.';
    default:
      return 'Validar o critério no painel do perfil e agir sobre o que for comprovado.';
  }
}

function displayStatusFor(
  cls: EvidenceClass,
  status: JudgeChecklistItem['status']
): CriterionDisplayStatus {
  if (cls === 'SIMULATED') return 'SIMULATED';
  if (cls === 'NOT_VERIFIED') return 'UNVERIFIED';
  if (cls === 'PARTIAL') return 'PARTIAL_EVIDENCE';
  if (status === 'PASS' || status === 'EXEMPT_BY_CONTEXT_RULE') return 'APPROVED';
  return status === 'PARTIAL' ? 'PARTIAL' : 'CRITICAL';
}

const CLASS_OF_STATUS: Record<EvidenceStatus, EvidenceClass> = {
  VERIFIED: 'VERIFIED',
  PARTIALLY_VERIFIED: 'PARTIAL',
  NOT_VERIFIED: 'NOT_VERIFIED',
  SIMULATED: 'SIMULATED',
};

/** Quanto maior, mais conservadora a classe (a evidência mais fraca prevalece). */
const CONSERVATISM: Record<EvidenceClass, number> = { VERIFIED: 0, PARTIAL: 1, NOT_VERIFIED: 2, SIMULATED: 2 };

function sourceLabel(evidence: AuditEvidence | undefined): string | null {
  if (!evidence?.sourceProvider) return null;
  const when = evidence.collectedAt ? ` · coletado em ${formatDate(evidence.collectedAt)}` : '';
  return `${evidence.sourceProvider}${when}`;
}

/**
 * Classifica os critérios do Juiz.
 *
 * - Auditorias da Fase 4 trazem a evidência de cada critério (`item.evidence`), que é usada como está.
 * - Auditorias anteriores NÃO têm evidência: a classe é a mais conservadora entre as regras da Fase 3
 *   e a reavaliação pelos critérios atuais sobre os dados guardados. Nada anterior é promovido a
 *   "verificado" por essa reavaliação, e a pontuação histórica gravada é preservada.
 * - A pontuação nunca é apresentada como aprovação ou reprovação sem evidência verificada.
 */
export function assessCriteria(
  data: ReportSourceData,
  model: BattlefieldMapModel,
  origins: DataOrigins = detectOrigins(data)
): readonly CriterionAssessment[] {
  const ctx: Context = {
    lead: data.lead,
    reputation: data.reputation,
    vitrine: data.vitrine,
    battlefield: data.battlefield,
    rivals: data.rivals,
    model,
    origins,
  };

  const recomputed = new Map(
    assessAllCriteria({
      lead: data.lead,
      reputation: data.reputation,
      vitrine: data.vitrine,
      battlefield: data.battlefield,
      rivals: data.rivals,
      siteCheck: null,
      isAddressHidden: data.lead.isAddressHidden,
      addressExceptionRuleTriggered: data.judge.businessModelContext.addressExceptionRuleTriggered,
      ...(data.testFixture ? { syntheticTestData: true } : {}),
    }).map((outcome) => [outcome.itemNumber, outcome])
  );

  const simulationOrigin = simulationOriginOf(data);

  return data.judge.checklist21Items.map((item): CriterionAssessment => {
    const common = {
      itemNumber: item.itemNumber,
      code: item.code,
      title: item.title,
      groupKey: groupKeyForCode(item.code),
      weight: item.maxWeight,
      agentScore: item.scoreAwarded,
      agentStatus: item.status,
    };

    // 1) Evidência nativa (Fase 4)
    if (item.evidence) {
      const cls = CLASS_OF_STATUS[item.evidence.status];
      return {
        ...common,
        evidenceClass: cls,
        displayStatus: displayStatusFor(cls, item.status),
        reason: cls === 'VERIFIED' ? null : item.evidence.explanation,
        evidence: cls === 'VERIFIED' || cls === 'PARTIAL' ? item.evidenceObserved : null,
        recommendation: item.technicalRecommendation,
        limitations: item.evidence.limitations,
        source: sourceLabel(item.evidence),
        simulationOrigin: cls === 'SIMULATED' ? simulationOrigin : null,
      };
    }

    // 2) Auditoria anterior: a classe mais conservadora entre a regra antiga e a reavaliação atual
    const rule = VERDICTS[item.code];
    const legacy: Verdict = rule ? rule(ctx) : notVerified('Critério sem regra de verificação cadastrada no relatório.');
    const fresh = recomputed.get(item.itemNumber);
    const freshClass = fresh ? CLASS_OF_STATUS[fresh.evidence.status] : 'NOT_VERIFIED';
    const cls = CONSERVATISM[freshClass] > CONSERVATISM[legacy.cls] ? freshClass : legacy.cls;
    const displayStatus = displayStatusFor(cls, item.status);
    const useFresh = fresh !== undefined && cls === freshClass && cls !== legacy.cls;

    let recommendation: string;
    if (cls === 'PARTIAL') {
      recommendation = fresh?.recommendation ?? VERIFY_HINTS[item.code] ?? 'Validar o critério diretamente no perfil.';
    } else if (cls !== 'VERIFIED') {
      recommendation = VERIFY_HINTS[item.code] ?? 'Validar o critério diretamente no perfil.';
    } else if (displayStatus === 'APPROVED') {
      recommendation = MAINTAIN[item.code] ?? 'Critério atendido: manter.';
    } else {
      recommendation = improvement(item.code, ctx);
    }

    return {
      ...common,
      evidenceClass: cls,
      displayStatus,
      reason: cls === 'VERIFIED' ? null : useFresh ? (fresh?.evidence.explanation ?? null) : (legacy.reason ?? fresh?.evidence.explanation ?? null),
      evidence:
        cls === 'VERIFIED'
          ? (legacy.evidence ?? null)
          : cls === 'PARTIAL'
            ? (useFresh ? (fresh?.observed ?? null) : (legacy.evidence ?? fresh?.observed ?? null))
            : null,
      recommendation,
      limitations: cls === 'VERIFIED' || cls === 'PARTIAL' || cls === 'NOT_VERIFIED' ? (fresh?.evidence.limitations ?? []) : [],
      source: fresh ? sourceLabel(fresh.evidence) : null,
      simulationOrigin: cls === 'SIMULATED' ? simulationOrigin : null,
    };
  });
}
