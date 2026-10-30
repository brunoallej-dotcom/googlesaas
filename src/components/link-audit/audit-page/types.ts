/*
 * Tipos do CLIENTE da página da auditoria (Onda 6C, I5). Espelham o contrato PÚBLICO das rotas de prévia, decisões e resultados;
 * o navegador não importa nenhum módulo de servidor. Só aparece aqui o que a API autoriza exibir.
 */
export interface Head {
  readonly seq: number;
  readonly sha256: string;
}

export interface Blocker {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  readonly reasonCode: string | null;
  readonly decisionIds: readonly string[];
  readonly subcriterionIds: readonly string[];
}

export interface PreviewSubcriterion {
  readonly id: string;
  readonly label: string;
  readonly maxHalfPoints: number;
  readonly source: string;
  readonly sourceReason: string | null;
  readonly state: string | null;
  readonly stateReason: string | null;
  readonly tier: string | null;
  readonly evaluatedHalfPoints: number | null;
  readonly obtainedHalfPoints?: number;
  readonly decisionIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly potential: { readonly family: string | null; readonly halfPoints: number };
}

export interface PreviewCriterion {
  readonly id: string;
  readonly label: string;
  readonly maxPoints: number;
  /** `null` quando o motor não calculou (sem evidência, entrada recusada). */
  readonly status: string | null;
  readonly evaluatedHalfPoints: number | null;
  readonly obtainedHalfPoints?: number;
  readonly subcriteria: readonly PreviewSubcriterion[];
}

export interface OutcomePreview {
  readonly outcome: 'PONTUADO' | 'INCONCLUSIVO';
  readonly level: 'PROVISORIO' | 'PUBLICAVEL' | null;
  readonly reasonCode: string | null;
  readonly failedGates: readonly string[];
  readonly coveragePercent: number;
  readonly minimumCoveragePercent: number;
}

export interface PendingDecisionSummary {
  readonly seq: number;
  readonly action: 'RECORD' | 'REVOKE';
  readonly decisionId: string | null;
  readonly revokes: string | null;
}

export interface EvidenceBase {
  readonly ref: string;
  readonly kind: string;
  readonly observedAt: string;
  readonly origin: string;
  readonly contentSha256: string;
  readonly legacy: boolean;
  readonly superseded: boolean;
}

/** Parte pública do resultado do motor que a página sabe mostrar (tudo opcional: nada é presumido). */
export interface PublicResult {
  readonly methodologyVersion?: string;
  readonly scoreModelVersion?: string;
  readonly rulerFingerprint?: string;
  readonly inputSha256?: string;
  readonly resultSha256?: string;
  readonly referenceDate?: string;
  readonly publication?: { readonly status?: string; readonly statusText?: string; readonly gates?: ReadonlyArray<{ readonly id: string; readonly passed: boolean; readonly text: string }> };
  readonly index?: { readonly shown?: number; readonly decimal2?: string; readonly classificationLabel?: string } | null;
  readonly confidence?: { readonly level?: string; readonly levelLabel?: string } | null;
  readonly totals?: { readonly coveragePercent?: number };
  readonly limitations?: ReadonlyArray<{ readonly code: string; readonly text: string }>;
  readonly criteria?: ReadonlyArray<{ readonly id: string; readonly label?: string; readonly obtainedHalfPoints?: number; readonly evaluatedHalfPoints?: number }>;
}

export interface PreviewPayload {
  readonly definitive: false;
  readonly auditId: string;
  readonly scoringAuditId: string | null;
  readonly state: 'SEM_EVIDENCIA' | 'DECISAO_PENDENTE' | 'ENTRADA_RECUSADA' | 'CALCULADO_NAO_FINALIZAVEL' | 'CALCULADO_FINALIZAVEL';
  readonly company: { readonly located: boolean; readonly profileState: string; readonly unavailableReason: string | null; readonly websiteHost: string | null; readonly source: string };
  readonly evidence: {
    readonly integrity: { readonly status: string; readonly checkedFiles: number | null };
    readonly layout: string | null;
    readonly referenceDate: string | null;
    readonly referenceDateSource: { readonly ref: string; readonly observedAt: string } | null;
    readonly profileSource: { readonly ref: string; readonly observedAt: string } | null;
    readonly bases: readonly EvidenceBase[];
  };
  readonly decisions: { readonly head: Head | null; readonly count: number; readonly pending: PendingDecisionSummary | null; readonly finalizable: boolean; readonly applied: readonly string[]; readonly held: ReadonlyArray<{ readonly decisionId: string; readonly code: string }> };
  readonly decisionOptions: ReadonlyArray<{ readonly type: 'JUDGEMENT' | 'NOT_APPLICABLE'; readonly subcriterionId: string; readonly code: string | null; readonly available: boolean; readonly reasonCode: string | null }>;
  readonly criteria: readonly PreviewCriterion[];
  readonly outcomePreview: OutcomePreview | null;
  readonly result: PublicResult | null;
  readonly blockers: readonly Blocker[];
  readonly missing: ReadonlyArray<{ readonly family: string; readonly label: string; readonly potentialHalfPoints: number }>;
  readonly finalization: { readonly allowed: boolean; readonly expectedHead: Head | null; readonly expectedInputSha256: string | null };
}

export interface DecisionDto {
  readonly decisionId: string;
  readonly seq: number;
  readonly kind: string;
  readonly record: Record<string, unknown>;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
  readonly status: 'ACTIVE' | 'SUPERSEDED' | 'REVOKED' | string;
  readonly siteDependent: boolean;
}

export interface PendingDecision {
  readonly confirmed: false;
  readonly seq: number;
  readonly action: 'RECORD' | 'REVOKE';
  readonly decisionId: string | null;
  readonly revokes: string | null;
  readonly supersedes: string | null;
  readonly reason: string | null;
  readonly record: Record<string, unknown> | null;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface HistoryEntry {
  readonly seq: number;
  readonly action: 'RECORD' | 'REVOKE';
  readonly decisionId: string | null;
  readonly revokes: string | null;
  readonly reason: string | null;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface DecisionsList {
  readonly auditId: string;
  readonly head: Head | null;
  readonly pending: PendingDecision | null;
  readonly finalizable: boolean;
  readonly decisions: readonly DecisionDto[];
  readonly history: readonly HistoryEntry[];
  readonly allDecisions: readonly DecisionDto[];
}

export interface PendingRun {
  readonly seq: number;
  readonly finalizedAt: string;
  readonly isMine: boolean;
  readonly outcome: 'PONTUADO' | 'INCONCLUSIVO';
  readonly inputSha256: string;
  readonly decisionsHead: Head | null;
  readonly contentSha256: string;
}

export interface RunSummary {
  readonly seq: number;
  readonly finalizedAt: string;
  readonly finalizedBy: string;
  readonly outcome: 'PONTUADO' | 'INCONCLUSIVO';
  readonly level: string | null;
  readonly reasonCode: string | null;
  readonly coveragePercent: number;
  readonly inputSha256: string;
  readonly resultSha256: string;
  readonly contentSha256: string;
  readonly decisionsHead: Head | null;
  readonly superseded: boolean;
  readonly stale: boolean | null;
  readonly decisionsChanged: boolean | null;
}

export interface ResultsList {
  readonly definitive: true;
  readonly auditId: string;
  readonly results: readonly RunSummary[];
  readonly head: Head | null;
  readonly pending: PendingRun | null;
  readonly currentInputSha256: string | null;
  readonly currentDecisionsHead: Head | null;
}

export interface RunDetail {
  readonly definitive: true;
  readonly seq: number;
  readonly auditId: string;
  readonly scoringAuditId: string;
  readonly finalizedAt: string;
  readonly finalizedBy: string;
  readonly outcome: 'PONTUADO' | 'INCONCLUSIVO';
  readonly level: string | null;
  readonly inconclusive: { readonly reasonCode: string; readonly failedGates: readonly string[]; readonly coveragePercent: number; readonly minimumCoveragePercent: number } | null;
  readonly decisions: { readonly head: Head | null; readonly count: number; readonly appliedIds: readonly string[] };
  readonly evidence: { readonly layout: string; readonly referenceDate: string; readonly bases: readonly { readonly ref: string; readonly kind: string; readonly observedAt: string; readonly contentSha256: string }[] };
  readonly versions: { readonly mapper: string; readonly methodology: string; readonly scoreModel: string; readonly rulerFingerprint: string };
  readonly hashes: { readonly inputSha256: string; readonly resultSha256: string; readonly contentSha256: string; readonly prevSha256: string | null };
  readonly result: PublicResult;
}

export interface RunDetailResponse {
  readonly stale: boolean | null;
  readonly decisionsChanged: boolean | null;
  readonly superseded: boolean;
  readonly run: RunDetail;
}

export interface FinalizeSuccess {
  readonly definitive: true;
  readonly replayed: boolean;
  readonly head: Head;
  readonly anchored: true;
  readonly stateChangedAfterFinalization: boolean | null;
  readonly recoveredPending: boolean;
  readonly run: RunDetail;
}

export interface FinalizeRequest {
  readonly expectedHead: Head | null;
  readonly expectedInputSha256: string;
}

export type DecisionRequest =
  | { readonly kind: 'CREATE'; readonly body: { readonly record: Record<string, unknown>; readonly supersedes?: string; readonly expectedHead: Head | null } }
  | { readonly kind: 'REVOKE'; readonly body: { readonly revokes: string; readonly reason: string; readonly expectedHead: Head | null } };
