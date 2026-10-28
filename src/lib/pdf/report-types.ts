import type {
  BattlefieldMetrics,
  FrontierLead,
  JudgeTechnicalSheet,
  ReputationMetrics,
  RivalsMetrics,
  StrategistOutput,
  VitrineMetrics,
} from '@/types/gmn';

/** Tudo o que o dossiê recebe dos agentes (resultados já persistidos; nada é recoletado). */
export interface ReportSourceData {
  readonly auditId: string;
  readonly lead: FrontierLead;
  readonly reputation: ReputationMetrics;
  readonly vitrine: VitrineMetrics;
  readonly battlefield: BattlefieldMetrics;
  readonly rivals: RivalsMetrics;
  readonly judge: JudgeTechnicalSheet;
  readonly strategist: StrategistOutput;
  /**
   * Score Juiz histórico GRAVADO na auditoria (metodologia original, 21 critérios, denominador 102),
   * preservado quando a ficha do `judge` foi reavaliada só para este PDF. Nunca é recalculado.
   */
  readonly storedJudge?: { readonly overallScore: number; readonly evaluatedAt: string };
  /** `true` somente para fixtures de teste: o documento sai identificado como dados sintéticos. */
  readonly testFixture?: boolean;
}

export interface CampaignSummary {
  readonly city: string;
  readonly stateCode: string;
  readonly nicheKeyword: string;
}

/** Origem de um conjunto de dados, deduzida dos marcadores reais deixados pelos agentes. */
export type { DataOrigin } from '@/lib/evidence/origins';

/** De onde vem um dado SIMULADO: auditoria anterior à Fase 4, modo demonstração ou fixture de teste. */
export type SimulationOrigin = 'LEGACY' | 'DEMO' | 'FIXTURE';

/** Classe de evidência de um critério do Juiz (PARTIAL = parcialmente verificado). */
export type EvidenceClass = 'VERIFIED' | 'PARTIAL' | 'NOT_VERIFIED' | 'SIMULATED';

export type CriterionGroupKey =
  | 'IDENTITY'
  | 'CONVERSION'
  | 'CATEGORIES'
  | 'REPUTATION'
  | 'MEDIA'
  | 'GEO'
  | 'OTHER';

export type CriterionDisplayStatus =
  | 'APPROVED'
  | 'PARTIAL'
  | 'CRITICAL'
  | 'UNVERIFIED'
  | 'PARTIAL_EVIDENCE'
  | 'SIMULATED';
