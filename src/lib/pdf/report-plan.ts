import type { StrategistOutput, TacticalWaveAction } from '@/types/gmn';
import type { BattlefieldMapModel } from '@/lib/battlefield-map-adapter';
import type { CriterionAssessment } from './report-evidence';
import { formatPercent, formatRating } from './report-format';
import type { RivalRow, TerritoryAnalysis } from './report-metrics';
import type { EvidenceClass, ReportSourceData } from './report-types';

export type WaveKey = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * ACTION: sustentada por evidência comprovada. HYPOTHESIS: depende de dado não comprovado ou de
 * ausência de dado; deve ser validada antes de executar.
 */
export type PlanKind = 'ACTION' | 'HYPOTHESIS' | 'NOT_APPLICABLE';

export interface PlanAction {
  readonly code: string;
  readonly wave: WaveKey;
  readonly title: string;
  readonly objective: string;
  readonly justification: string;
  readonly evidenceClass: EvidenceClass;
  readonly kind: PlanKind;
  readonly priority: string;
  readonly timeframe: string;
  readonly indicator: string;
  readonly source: 'STRATEGIST' | 'TERRITORY_ANALYSIS';
  /** Problema ou oportunidade e grau de confiança (recomendações da Fase 4). */
  readonly problem?: string;
  readonly confidence?: number;
}

export interface PlanWave {
  readonly wave: WaveKey;
  readonly title: string;
  readonly timeframe: string;
  readonly summary: string;
  readonly actions: readonly PlanAction[];
  /** Critérios já atendidos que a onda recomenda apenas manter. */
  readonly maintain: readonly string[];
}

const WAVES: Record<WaveKey, { title: string; timeframe: string; summary: string; priority: string }> = {
  P0: {
    title: 'Onda P0',
    timeframe: 'Dias 1 a 7',
    summary: 'Correções críticas e oportunidades imediatas.',
    priority: 'Imediata',
  },
  P1: {
    title: 'Onda P1',
    timeframe: 'Dias 8 a 30',
    summary: 'Otimizações de perfil, serviços, conteúdo e conversão.',
    priority: 'Alta',
  },
  P2: {
    title: 'Onda P2',
    timeframe: 'Dias 31 a 60',
    summary: 'Consolidação da reputação, presença digital e expansão territorial.',
    priority: 'Média',
  },
  P3: {
    title: 'Onda P3',
    timeframe: 'Dias 61 a 90',
    summary: 'Monitoramento e evolução competitiva.',
    priority: 'Contínua',
  },
};

export const PLAN_DISCLAIMER =
  'As ações abaixo são recomendações de trabalho. Nenhuma delas garante melhora de posição no Google: o ranking depende de fatores que a plataforma não controla.';

interface PlanContext {
  readonly data: ReportSourceData;
  readonly criteria: ReadonlyMap<string, CriterionAssessment>;
  readonly model: BattlefieldMapModel;
  readonly territory: TerritoryAnalysis;
  readonly rivalRows: readonly RivalRow[];
}

type Decision =
  | { readonly kind: 'ACTION' | 'HYPOTHESIS'; readonly justification: string; readonly evidenceClass: EvidenceClass }
  | { readonly kind: 'MAINTAIN'; readonly note: string };

interface CatalogEntry {
  readonly code: string;
  readonly wave: WaveKey;
  readonly title: string;
  readonly objective: string;
  readonly indicator: string;
  readonly decide: (ctx: PlanContext) => Decision;
}

const UNPROVEN =
  'Esta informação não pôde ser comprovada nesta auditoria. Confirmar no painel do perfil antes de agir.';

function criterion(ctx: PlanContext, code: string): CriterionAssessment | undefined {
  return ctx.criteria.get(code);
}

/** Critério comprovado: aprovado vira "manter"; não aprovado vira ação; sem comprovação vira hipótese. */
function fromCriterion(
  ctx: PlanContext,
  code: string,
  actionJustification: (evidence: string) => string,
  hypothesisJustification: string = UNPROVEN
): Decision {
  const item = criterion(ctx, code);
  if (!item || item.evidenceClass !== 'VERIFIED') {
    return { kind: 'HYPOTHESIS', justification: hypothesisJustification, evidenceClass: item?.evidenceClass ?? 'NOT_VERIFIED' };
  }
  if (item.displayStatus === 'APPROVED') {
    return { kind: 'MAINTAIN', note: item.recommendation };
  }
  return { kind: 'ACTION', justification: actionJustification(item.evidence ?? ''), evidenceClass: 'VERIFIED' };
}

const CATALOG: readonly CatalogEntry[] = [
  {
    code: 'P0_ACT_01',
    wave: 'P0',
    title: 'Responder as avaliações pendentes',
    objective: 'Mostrar gestão ativa do perfil e atender os clientes que avaliaram.',
    indicator: 'Percentual de avaliações respondidas (painel do perfil).',
    decide: (ctx) =>
      fromCriterion(
        ctx,
        'REP_13_OWNER_RESPONSE_RATE',
        (evidence) => `${evidence} Responder as pendentes é a ação mais rápida para melhorar este indicador.`,
        'A taxa de resposta do proprietário não pôde ser comprovada nesta auditoria. Conferir no painel quantas avaliações estão sem resposta; se houver pendências, respondê-las.'
      ),
  },
  {
    code: 'P0_ACT_02',
    wave: 'P0',
    title: 'Confirmar e vincular o WhatsApp ao perfil',
    objective: 'Facilitar o contato direto de quem encontra o perfil.',
    indicator: 'Contatos recebidos por WhatsApp (com link rastreável).',
    decide: (ctx) => {
      const { lead } = ctx.data;
      if (lead.whatsappStatus === 'VERIFIED_WHATSAPP') {
        return { kind: 'MAINTAIN', note: 'O link público de WhatsApp já consta na listagem: manter ativo e acompanhar os contatos.' };
      }
      return {
        kind: 'HYPOTHESIS',
        evidenceClass: 'NOT_VERIFIED',
        justification: lead.phoneRaw
          ? `A listagem tem o telefone ${lead.phoneRaw}, mas não traz link público de WhatsApp. Confirmar se o número tem WhatsApp ativo e, se tiver, vincular o link ao perfil.`
          : 'Nenhum telefone foi coletado na listagem. Conferir no perfil os canais de contato disponíveis.',
      };
    },
  },
  {
    code: 'P0_ACT_03',
    wave: 'P0',
    title: 'Retomar as publicações do perfil (Google Posts)',
    objective: 'Manter o perfil com informações recentes para quem o visita.',
    indicator: 'Data da última publicação e número de publicações por mês.',
    decide: (ctx) =>
      fromCriterion(
        ctx,
        'VIT_18_GOOGLE_POSTS_CADENCE',
        (evidence) => `${evidence} Retomar as publicações mantém o perfil atualizado.`,
        'A data da última publicação não pôde ser comprovada nesta auditoria. Conferir no painel e, se o perfil estiver inativo, retomar as publicações.'
      ),
  },
  {
    code: 'P1_ACT_01',
    wave: 'P1',
    title: 'Revisar serviços e categorias do perfil',
    objective: 'Garantir que o perfil descreva todos os serviços prestados.',
    indicator: 'Número de serviços e categorias cadastrados (painel do perfil).',
    decide: (ctx) => {
      const secondary = criterion(ctx, 'CAT_07_SECONDARY_DEPTH');
      if (secondary?.evidenceClass === 'VERIFIED' && secondary.displayStatus !== 'APPROVED') {
        return { kind: 'ACTION', evidenceClass: 'VERIFIED', justification: `${secondary.evidence ?? ''} Avaliar categorias secundárias adicionais relevantes.` };
      }
      return {
        kind: 'HYPOTHESIS',
        evidenceClass: 'NOT_VERIFIED',
        justification:
          'A lista de serviços e as categorias secundárias não puderam ser comprovadas nesta auditoria. Conferir no painel e completar o que estiver faltando.',
      };
    },
  },
  {
    code: 'P1_ACT_02',
    wave: 'P1',
    title: 'Atualizar fotos e vídeos do perfil',
    objective: 'Apresentar o negócio com imagens reais e recentes.',
    indicator: 'Total de fotos e vídeos e data da última mídia (perfil).',
    decide: (ctx) =>
      fromCriterion(
        ctx,
        'VIT_15_PHOTO_VOLUME',
        (evidence) => `${evidence} Ampliar o acervo com imagens autênticas.`,
        'O acervo de fotos e vídeos não pôde ser comprovado nesta auditoria. Conferir no perfil e complementar com imagens próprias e recentes.'
      ),
  },
  {
    code: 'P2_ACT_01',
    wave: 'P2',
    title: 'Criar uma rotina para pedir avaliações a clientes reais',
    objective: 'Aproximar o volume de avaliações do líder do território, sem incentivo nem texto induzido.',
    indicator: 'Novas avaliações por mês e total de avaliações em relação ao líder.',
    decide: (ctx) => {
      const item = criterion(ctx, 'REP_11_VOLUME_VS_LEADER');
      const leader = ctx.rivalRows[0];
      if (item?.evidenceClass === 'VERIFIED' && leader?.totalReviews != null) {
        const mine = ctx.data.lead.totalReviews;
        if (mine >= leader.totalReviews) {
          return { kind: 'MAINTAIN', note: 'O volume de avaliações já iguala ou supera o do líder territorial: manter o ritmo de pedidos.' };
        }
        return {
          kind: 'ACTION',
          evidenceClass: 'VERIFIED',
          justification: `A empresa tem ${mine} avaliações (nota ${formatRating(ctx.data.lead.rating)}); o líder territorial, ${leader.name}, tem ${leader.totalReviews}. Ambos os valores foram coletados na listagem.`,
        };
      }
      return {
        kind: 'HYPOTHESIS',
        evidenceClass: item?.evidenceClass ?? 'NOT_VERIFIED',
        justification:
          'A comparação de volume de avaliações com o líder não pôde ser comprovada nesta auditoria. Comparar no Google Maps antes de definir uma meta.',
      };
    },
  },
  {
    code: 'P2_ACT_02',
    wave: 'P2',
    title: 'Verificar os dados estruturados do site',
    objective: 'Reforçar a ligação entre o site e o perfil do negócio.',
    indicator: 'Resultado do teste de resultados avançados do Google para o site.',
    decide: (ctx) => {
      const site = criterion(ctx, 'NAP_05_OWN_WEBSITE');
      const lead = ctx.data.lead;
      if (site?.evidenceClass === 'VERIFIED' && lead.websiteStatus === 'SOCIAL_LINK_ONLY') {
        return { kind: 'ACTION', evidenceClass: 'VERIFIED', justification: `${site.evidence ?? ''} Um site em domínio próprio permite vincular dados estruturados ao perfil.` };
      }
      if (site?.evidenceClass === 'VERIFIED') {
        return {
          kind: 'HYPOTHESIS',
          evidenceClass: 'NOT_VERIFIED',
          justification: `O site ${lead.websiteUrl ?? ''} consta na listagem, mas a presença de dados estruturados não foi verificada. Testar a página com a ferramenta de resultados avançados do Google.`,
        };
      }
      return { kind: 'HYPOTHESIS', evidenceClass: 'NOT_VERIFIED', justification: 'Nenhum site foi coletado. Conferir no perfil se há site e avaliar a criação de um em domínio próprio.' };
    },
  },
  {
    code: 'P3_ACT_01',
    wave: 'P3',
    title: 'Manter uma campanha contínua de avaliações espontâneas',
    objective: 'Ampliar sinais de relevância nas áreas em que a empresa ainda não aparece, com avaliações reais que descrevam o serviço.',
    indicator: 'Percentual de pontos fora das 20 primeiras posições na próxima medição.',
    decide: (ctx) => {
      const above = ctx.model.percentages.above20;
      const item = criterion(ctx, 'GEO_21_INVISIBILITY_SHIELD');
      if (item?.evidenceClass === 'VERIFIED' && above !== null && above >= 50) {
        return {
          kind: 'ACTION',
          evidenceClass: 'VERIFIED',
          justification: `${item.evidence ?? ''} A maior parte do território ainda não mostra a empresa; avaliações reais aumentam os sinais de relevância. Sem incentivos, compra de avaliações ou texto induzido (políticas do Google).`,
        };
      }
      return { kind: 'MAINTAIN', note: 'A invisibilidade territorial não é predominante nesta auditoria: manter o acompanhamento.' };
    },
  },
  {
    code: 'P3_ACT_02',
    wave: 'P3',
    title: 'Repetir a medição territorial todo mês',
    objective: 'Acompanhar a evolução da posição e reagir a mudanças dos concorrentes.',
    indicator: 'Posição média, percentual no Top 3 e no Top 7, comparados a esta primeira medição.',
    decide: () => ({
      kind: 'ACTION',
      evidenceClass: 'VERIFIED',
      justification:
        'A comparação histórica só é possível com medições repetidas da mesma empresa e palavra-chave. Esta auditoria é a base de comparação.',
    }),
  },
];

const TERRITORY_ACTIONS: readonly CatalogEntry[] = [
  {
    code: 'TERR_FOCUS_PRESENCE',
    wave: 'P1',
    title: 'Priorizar os pontos em que a empresa já aparece',
    objective: 'Converter presença existente em posições melhores, onde o esforço é menor.',
    indicator: 'Número de pontos entre as posições 4 e 20 que passam ao Top 7 ou Top 3.',
    decide: (ctx) => {
      const { counts } = ctx.model;
      const reachable = counts.top4to7 + counts.rank8to20;
      const geo = criterion(ctx, 'GEO_19_TOP3_SHARE');
      if (geo?.evidenceClass !== 'VERIFIED' || reachable === 0) {
        return { kind: 'MAINTAIN', note: 'Não há pontos intermediários (posições 4 a 20) para priorizar nesta auditoria.' };
      }
      const north = ctx.territory.findings.find((finding) => /concentra a maior presença/.test(finding));
      return {
        kind: 'ACTION',
        evidenceClass: 'VERIFIED',
        justification: `${reachable} ${reachable === 1 ? 'ponto tem' : 'pontos têm'} a empresa entre as posições 4 e 20 (coletado). ${north ?? ''}`.trim(),
      };
    },
  },
  {
    code: 'TERR_COMPANY_POINT',
    wave: 'P0',
    title: 'Entender a posição no ponto onde a empresa está localizada',
    objective: 'Esclarecer por que a empresa não aparece entre as 20 primeiras no próprio endereço.',
    indicator: 'Posição lida no ponto central na próxima medição.',
    decide: (ctx) => {
      if (ctx.territory.companyPointLabel === 'acima de 20') {
        return {
          kind: 'HYPOTHESIS',
          evidenceClass: 'VERIFIED',
          justification:
            'No ponto da grade que coincide com a localização da empresa, ela não apareceu entre as 20 primeiras posições (coletado). A causa não foi determinada: conferir no Google Maps, para a mesma palavra-chave, a categoria principal, o volume de concorrentes e o aparecimento do perfil.',
        };
      }
      return { kind: 'MAINTAIN', note: 'A empresa aparece entre as 20 primeiras no ponto em que está localizada.' };
    },
  },
];

/** Promessas numéricas ou de resultado garantido não entram no relatório. */
const PROMISE_PATTERNS: readonly RegExp[] = [
  /\bgarant(?:ia|imos|ido|ida|idos|idas|e|em)\b/i,
  /\d+\s*%\s*(a|ate|até|-|–)\s*\d+\s*%/i,
  /aumento de \d+/i,
  /triplicar/i,
  /dobrar/i,
];

export function containsPromise(text: string): boolean {
  return PROMISE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Junta trechos sem repetir texto que já está contido em outro trecho. */
function joinDistinct(parts: readonly (string | undefined)[]): string {
  const clean = parts.map((part) => part?.trim() ?? '').filter((part) => part.length > 0);
  return clean.filter((part, index) => !clean.some((other, j) => j !== index && other.length > part.length && other.includes(part))).join(' ');
}

const KIND_OF_CLASSIFICATION: Record<NonNullable<TacticalWaveAction['classification']>, PlanKind> = {
  PROVEN_ACTION: 'ACTION',
  HYPOTHESIS: 'HYPOTHESIS',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
};

/** Plano a partir das recomendações ancoradas em evidência (auditorias da Fase 4 em diante). */
function buildNativePlan(strategist: StrategistOutput): readonly PlanWave[] {
  const waves: WaveKey[] = ['P0', 'P1', 'P2', 'P3'];
  return waves.map((wave): PlanWave => {
    const meta = WAVES[wave];
    const source = strategist.tacticalWaves.find((entry) => entry.wave === wave);
    const actions: PlanAction[] = (source?.actions ?? []).map((action): PlanAction => {
      const classification = action.classification ?? 'HYPOTHESIS';
      const confidence = action.confidence ?? 0.2;
      return {
        code: action.actionCode,
        wave,
        title: action.title,
        objective: action.expectedImpact,
        justification: joinDistinct([action.evidenceSummary, action.justification]),
        evidenceClass: classification === 'PROVEN_ACTION' ? 'VERIFIED' : classification === 'HYPOTHESIS' && confidence >= 0.3 ? 'PARTIAL' : 'NOT_VERIFIED',
        kind: KIND_OF_CLASSIFICATION[classification],
        priority: action.priority ?? meta.priority,
        timeframe: action.timeframe ?? meta.timeframe,
        indicator: action.indicator ?? 'A definir ao validar a ação.',
        source: action.actionCode.startsWith('TERR_') ? 'TERRITORY_ANALYSIS' : 'STRATEGIST',
        ...(action.problem ? { problem: action.problem } : {}),
        confidence,
      };
    });
    // As notas de "manter" ficam na última onda, que é de acompanhamento.
    const maintain = wave === 'P3' ? [...(strategist.maintainNotes ?? [])] : [];
    return { wave, title: meta.title, timeframe: meta.timeframe, summary: meta.summary, actions, maintain };
  });
}

export function buildPlan(
  data: ReportSourceData,
  criteria: readonly CriterionAssessment[],
  model: BattlefieldMapModel,
  territory: TerritoryAnalysis,
  rivalRows: readonly RivalRow[]
): readonly PlanWave[] {
  const strategistOutput = data.strategist as StrategistOutput | undefined;
  const hasNativeRecommendations = Boolean(
    strategistOutput?.tacticalWaves?.some((wave) => wave.actions.some((action) => action.classification))
  );
  if (hasNativeRecommendations && strategistOutput) return buildNativePlan(strategistOutput);

  const ctx: PlanContext = {
    data,
    criteria: new Map(criteria.map((item) => [item.code, item])),
    model,
    territory,
    rivalRows,
  };

  // O catálogo cobre as ações que o Estrategista emite; códigos desconhecidos viram hipótese.
  const strategistCodes = new Set(
    (data.strategist as StrategistOutput | undefined)?.tacticalWaves?.flatMap((wave) => wave.actions.map((a) => a.actionCode)) ?? []
  );
  const knownCodes = new Set(CATALOG.map((entry) => entry.code));

  const entries: CatalogEntry[] = [
    ...CATALOG.filter((entry) => strategistCodes.size === 0 || strategistCodes.has(entry.code)),
    ...TERRITORY_ACTIONS,
  ];

  const unknown = (data.strategist?.tacticalWaves ?? []).flatMap((wave) =>
    wave.actions
      .filter((action) => !knownCodes.has(action.actionCode))
      .map((action) => ({ action, wave: wave.wave as WaveKey }))
  );
  for (const { action, wave } of unknown) {
    entries.push({
      code: action.actionCode,
      wave,
      title: action.title,
      objective: containsPromise(action.expectedImpact) ? 'Objetivo não especificado.' : action.expectedImpact,
      indicator: 'A definir ao validar a ação.',
      decide: () => ({
        kind: 'HYPOTHESIS',
        evidenceClass: 'NOT_VERIFIED',
        justification: 'Ação sugerida pelo Estrategista sem vínculo com evidência comprovada nesta auditoria. Validar antes de executar.',
      }),
    });
  }

  const waves: WaveKey[] = ['P0', 'P1', 'P2', 'P3'];
  return waves.map((wave): PlanWave => {
    const meta = WAVES[wave];
    const actions: PlanAction[] = [];
    const maintain: string[] = [];
    for (const entry of entries.filter((e) => e.wave === wave)) {
      const decision = entry.decide(ctx);
      if (decision.kind === 'MAINTAIN') {
        maintain.push(decision.note);
        continue;
      }
      actions.push({
        code: entry.code,
        wave,
        title: entry.title,
        objective: entry.objective,
        justification: decision.justification,
        evidenceClass: decision.evidenceClass,
        kind: decision.kind,
        priority: meta.priority,
        timeframe: meta.timeframe,
        indicator: entry.indicator,
        source: entry.code.startsWith('TERR_') ? 'TERRITORY_ANALYSIS' : 'STRATEGIST',
      });
    }
    return { wave, title: meta.title, timeframe: meta.timeframe, summary: meta.summary, actions, maintain };
  });
}

export function planStats(plan: readonly PlanWave[]): { readonly actions: number; readonly hypotheses: number; readonly notApplicable: number } {
  const all = plan.flatMap((wave) => wave.actions);
  return {
    actions: all.filter((a) => a.kind === 'ACTION').length,
    hypotheses: all.filter((a) => a.kind === 'HYPOTHESIS').length,
    notApplicable: all.filter((a) => a.kind === 'NOT_APPLICABLE').length,
  };
}

export function formatPlanShare(plan: readonly PlanWave[]): string {
  const stats = planStats(plan);
  const total = stats.actions + stats.hypotheses + stats.notApplicable;
  return total === 0 ? '—' : formatPercent((stats.actions / total) * 100, 0);
}
