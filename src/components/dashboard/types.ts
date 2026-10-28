import type {
  AgentName,
  AuditPipelineStage,
  BattlefieldMetrics,
  DiagrammerOutput,
  JudgeTechnicalSheet,
  ReputationMetrics,
  ReviewerAuditResult,
  RivalsMetrics,
  StrategistOutput,
  VitrineMetrics,
} from '@/types/gmn';

export interface AuditJobTracker {
  readonly auditId: string;
  readonly leadId: string;
  readonly status: AuditPipelineStage;
  readonly progressPercent: number;
  readonly currentAgent: AgentName;
  readonly reputation?: ReputationMetrics;
  readonly vitrine?: VitrineMetrics;
  readonly battlefield?: BattlefieldMetrics;
  readonly rivals?: RivalsMetrics;
  readonly judge?: JudgeTechnicalSheet;
  readonly strategist?: StrategistOutput;
  readonly reviewerLogs?: readonly ReviewerAuditResult[];
  readonly diagrammer?: DiagrammerOutput;
  readonly errorMessage?: string;
  /** Fase derivada pelo servidor (inclui INTERRUPTED, que não existe no banco). */
  readonly phase?: 'WAITING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';
  readonly phaseReason?: string | null;
  readonly resumable?: boolean;
  /** `null` = o servidor não conseguiu consultar o Worker (Redis inacessível). */
  readonly workerAlive?: boolean | null;
  /** Resultado salvo reaberto do histórico (nada foi executado agora). */
  readonly recovered?: boolean;
  readonly createdAt?: string;
}
