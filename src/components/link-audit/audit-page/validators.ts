import type { DecisionDto, DecisionsList, FinalizeSuccess, Head, PendingDecision, PendingRun, PreviewPayload, ResultsList, RunDetailResponse, RunSummary } from './types';

/*
 * Validação ESTRUTURAL das respostas (I5/I6). Falha FECHADA: qualquer campo aninhado fora do formato, enum desconhecido, identidade de
 * auditoria diferente da pedida ou combinação incoerente (ex.: "pode finalizar" com bloqueio aberto; índice em resultado inconclusivo)
 * devolve `false` e a tela trata a resposta como inesperada — nunca habilita a finalização por interpretação incompleta.
 * Não recalcula nada da metodologia: só confere formas, enumerações e coerências que o próprio contrato público garante.
 */
type Rec = Record<string, unknown>;
export const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strN = (v: unknown): boolean => v === null || str(v);
const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numN = (v: unknown): boolean => v === null || num(v);
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const boolN = (v: unknown): boolean => v === null || bool(v);
export const isHex64 = (v: unknown): v is string => str(v) && /^[0-9a-f]{64}$/.test(v);
const arr = <T,>(v: unknown, guard: (item: unknown) => boolean): v is T[] => Array.isArray(v) && v.every(guard);
const strs = (v: unknown): boolean => arr<string>(v, str);
const oneOf = (v: unknown, values: readonly string[]): boolean => str(v) && values.includes(v);
const percent = (v: unknown): boolean => num(v) && (v as number) >= 0 && (v as number) <= 100;

export const isHead = (v: unknown): v is Head => isObj(v) && int(v.seq) && (v.seq as number) >= 1 && isHex64(v.sha256);
const headN = (v: unknown): boolean => v === null || isHead(v);
const sameHead = (a: Head | null, b: Head | null): boolean => (a === null || b === null ? a === b : a.seq === b.seq && a.sha256 === b.sha256);
const OUTCOMES = ['PONTUADO', 'INCONCLUSIVO'] as const;
const LEVELS = ['PROVISORIO', 'PUBLICAVEL'] as const;
const STATES = ['SEM_EVIDENCIA', 'DECISAO_PENDENTE', 'ENTRADA_RECUSADA', 'CALCULADO_NAO_FINALIZAVEL', 'CALCULADO_FINALIZAVEL'] as const;
const levelOk = (outcome: unknown, level: unknown): boolean => (outcome === 'PONTUADO' ? oneOf(level, LEVELS) : level === null);

/** Resultado público do motor (só a forma que a tela usa). Em INCONCLUSIVO nunca pode haver índice; em PONTUADO tem de haver. */
function resultOk(result: unknown, outcome: unknown, required: boolean): boolean {
  if (result === null) return !required;
  if (!isObj(result)) return false;
  const index = result.index;
  if (outcome === 'INCONCLUSIVO' && index !== null && index !== undefined) return false;
  if (outcome === 'PONTUADO') {
    if (!isObj(index) || !(str(index.decimal2) && /^\d{1,3}\.\d{2}$/.test(index.decimal2))) return false;
    if (index.classificationLabel !== undefined && !str(index.classificationLabel)) return false;
  }
  if (result.confidence !== undefined && result.confidence !== null && !(isObj(result.confidence) && (result.confidence.levelLabel === undefined || str(result.confidence.levelLabel)))) return false;
  if (outcome === 'INCONCLUSIVO' && result.confidence !== undefined && result.confidence !== null) return false;
  if (result.publication !== undefined) {
    const publication = result.publication;
    if (!isObj(publication)) return false;
    if (publication.gates !== undefined && !arr(publication.gates, (g) => isObj(g) && str(g.id) && bool(g.passed) && str(g.text))) return false;
  }
  if (result.limitations !== undefined && !arr(result.limitations, (l) => isObj(l) && str(l.code) && str(l.text))) return false;
  if (result.totals !== undefined && !(isObj(result.totals) && (result.totals.coveragePercent === undefined || percent(result.totals.coveragePercent)))) return false;
  return true;
}

const pendingSummaryOk = (v: unknown): boolean => v === null || (isObj(v) && int(v.seq) && oneOf(v.action, ['RECORD', 'REVOKE']) && strN(v.decisionId) && strN(v.revokes));
export const blockerOk = (b: unknown): boolean => isObj(b) && str(b.code) && oneOf(b.severity, ['BLOCKING', 'WARNING']) && str(b.message) && strN(b.reasonCode) && strs(b.decisionIds) && strs(b.subcriterionIds);
const subOk = (s: unknown): boolean =>
  isObj(s) && str(s.id) && str(s.label) && num(s.maxHalfPoints) && str(s.source) && strN(s.sourceReason) && strN(s.state) && strN(s.stateReason) && strN(s.tier) && numN(s.evaluatedHalfPoints) && (s.obtainedHalfPoints === undefined || num(s.obtainedHalfPoints)) && strs(s.decisionIds) && strs(s.evidenceRefs) &&
  isObj(s.potential) && strN(s.potential.family) && num(s.potential.halfPoints);
const criterionOk = (c: unknown): boolean => isObj(c) && str(c.id) && str(c.label) && num(c.maxPoints) && strN(c.status) && // `status` é null quando o motor não calculou (SEM_EVIDENCIA, ENTRADA_RECUSADA)
   numN(c.evaluatedHalfPoints) && (c.obtainedHalfPoints === undefined || num(c.obtainedHalfPoints)) && arr(c.subcriteria, subOk);
const baseOk = (b: unknown): boolean => isObj(b) && str(b.ref) && str(b.kind) && str(b.observedAt) && str(b.origin) && isHex64(b.contentSha256) && bool(b.legacy) && bool(b.superseded);
const refSourceOk = (v: unknown): boolean => v === null || (isObj(v) && str(v.ref) && str(v.observedAt));

export function isPreviewPayload(value: unknown, auditId?: string): value is PreviewPayload {
  if (!isObj(value) || value.definitive !== false || !str(value.auditId) || (auditId !== undefined && value.auditId !== auditId) || !strN(value.scoringAuditId) || !oneOf(value.state, STATES)) return false;
  const { company, evidence, decisions, finalization } = value;
  if (!isObj(company) || !bool(company.located) || !str(company.profileState) || !strN(company.unavailableReason) || !strN(company.websiteHost) || !str(company.source)) return false;
  if (!isObj(evidence) || !isObj(evidence.integrity) || !str(evidence.integrity.status) || !(evidence.integrity.checkedFiles === null || int(evidence.integrity.checkedFiles)) || !strN(evidence.layout) || !strN(evidence.referenceDate)) return false;
  if (!refSourceOk(evidence.referenceDateSource) || !refSourceOk(evidence.profileSource) || !arr(evidence.bases, baseOk)) return false;
  if (!isObj(decisions) || !headN(decisions.head) || !int(decisions.count) || !pendingSummaryOk(decisions.pending) || !bool(decisions.finalizable) || !strs(decisions.applied) || !arr(decisions.held, (h) => isObj(h) && str(h.decisionId) && str(h.code))) return false;
  if (!arr(value.decisionOptions, (o) => isObj(o) && str(o.type) && str(o.subcriterionId) && strN(o.code) && bool(o.available) && strN(o.reasonCode))) return false;
  if (!arr(value.criteria, criterionOk) || !arr(value.blockers, blockerOk) || !arr(value.missing, (m) => isObj(m) && str(m.family) && str(m.label) && num(m.potentialHalfPoints))) return false;
  const outcome = value.outcomePreview;
  if (outcome !== null) {
    if (!isObj(outcome) || !oneOf(outcome.outcome, OUTCOMES) || !levelOk(outcome.outcome, outcome.level) || !strN(outcome.reasonCode) || !strs(outcome.failedGates) || !percent(outcome.coveragePercent) || !percent(outcome.minimumCoveragePercent)) return false;
  }
  const calculated = value.state === 'CALCULADO_NAO_FINALIZAVEL' || value.state === 'CALCULADO_FINALIZAVEL';
  if (calculated && outcome === null) return false;
  if (!resultOk(value.result, isObj(outcome) ? outcome.outcome : null, calculated)) return false;
  if (!isObj(finalization) || !bool(finalization.allowed) || !headN(finalization.expectedHead) || !(finalization.expectedInputSha256 === null || isHex64(finalization.expectedInputSha256))) return false;
  if (finalization.allowed) {
    // "pode finalizar" só vale se TUDO que o contrato garante junto estiver presente e coerente
    const blocking = (value.blockers as Array<{ severity: string }>).some((b) => b.severity === 'BLOCKING');
    if (value.state !== 'CALCULADO_FINALIZAVEL' || outcome === null || finalization.expectedInputSha256 === null || blocking || (decisions as Rec).pending !== null || (decisions as Rec).finalizable !== true || ((decisions as Rec).held as unknown[]).length > 0 || (evidence.integrity as Rec).status !== 'OK') return false;
    if (!sameHead(finalization.expectedHead as Head | null, (decisions as Rec).head as Head | null)) return false;
  }
  return true;
}

const decisionDtoOk = (d: unknown): boolean =>
  isObj(d) && str(d.decisionId) && /^op-\d{4}$/.test(d.decisionId) && int(d.seq) && str(d.kind) && isObj(d.record) && str(d.recordedAt) && str(d.recordedBy) && strN(d.supersedes) && strN(d.supersededBy) && oneOf(d.status, ['ACTIVE', 'SUPERSEDED', 'REVOKED']) && bool(d.siteDependent);
const pendingDecisionOk = (p: unknown): boolean =>
  isObj(p) && p.confirmed === false && int(p.seq) && oneOf(p.action, ['RECORD', 'REVOKE']) && strN(p.decisionId) && strN(p.revokes) && strN(p.supersedes) && strN(p.reason) && (p.record === null || isObj(p.record)) && str(p.recordedAt) && str(p.recordedBy);

export function isDecisionsPayload(value: unknown, auditId?: string): value is DecisionsList {
  if (!isObj(value) || !str(value.auditId) || (auditId !== undefined && value.auditId !== auditId) || !headN(value.head) || !bool(value.finalizable)) return false;
  if (!(value.pending === null || pendingDecisionOk(value.pending))) return false;
  if (!arr<DecisionDto>(value.decisions, decisionDtoOk) || !arr<DecisionDto>(value.allDecisions, decisionDtoOk)) return false;
  if (!arr(value.history, (h) => isObj(h) && int(h.seq) && oneOf(h.action, ['RECORD', 'REVOKE']) && strN(h.decisionId) && strN(h.revokes) && strN(h.reason) && str(h.recordedAt) && str(h.recordedBy))) return false;
  if ((value.decisions as DecisionDto[]).some((d) => d.status !== 'ACTIVE')) return false; // "vigentes" só contém ativas
  if (value.pending !== null && value.finalizable !== false) return false; // pendente = não finalizável (contrato da 6B)
  return true;
}

const runSummaryOk = (r: unknown): boolean =>
  isObj(r) && int(r.seq) && (r.seq as number) >= 1 && str(r.finalizedAt) && str(r.finalizedBy) && oneOf(r.outcome, OUTCOMES) && levelOk(r.outcome, r.level) && strN(r.reasonCode) && percent(r.coveragePercent) && isHex64(r.inputSha256) && isHex64(r.resultSha256) && isHex64(r.contentSha256) && headN(r.decisionsHead) && bool(r.superseded) && boolN(r.stale) && boolN(r.decisionsChanged);
const pendingRunOk = (p: unknown): boolean => isObj(p) && int(p.seq) && (p.seq as number) >= 1 && str(p.finalizedAt) && bool(p.isMine) && oneOf(p.outcome, OUTCOMES) && isHex64(p.inputSha256) && headN(p.decisionsHead) && isHex64(p.contentSha256);

export function isResultsPayload(value: unknown, auditId?: string): value is ResultsList {
  if (!isObj(value) || value.definitive !== true || !str(value.auditId) || (auditId !== undefined && value.auditId !== auditId) || !headN(value.head)) return false;
  if (!arr<RunSummary>(value.results, runSummaryOk) || !(value.pending === null || pendingRunOk(value.pending)) || !(value.currentInputSha256 === null || isHex64(value.currentInputSha256)) || !headN(value.currentDecisionsHead)) return false;
  const runs = value.results as RunSummary[];
  // numeração contínua 1..n; só o último é "mais recente"; só ele traz stale/decisionsChanged
  for (const [index, run] of runs.entries()) {
    const latest = index === runs.length - 1;
    if (run.seq !== index + 1 || run.superseded === latest) return false;
    if (!latest && (run.stale !== null || run.decisionsChanged !== null)) return false;
  }
  const last = runs[runs.length - 1];
  if (last ? !(isHead(value.head) && value.head.seq === last.seq && value.head.sha256 === last.contentSha256) : value.head !== null) return false;
  if (value.pending !== null && (value.pending as PendingRun).seq !== runs.length + 1) return false;
  return true;
}

function runOk(run: unknown, auditId?: string): boolean {
  if (!isObj(run) || run.definitive !== true || !int(run.seq) || (run.seq as number) < 1 || !str(run.auditId) || (auditId !== undefined && run.auditId !== auditId) || !str(run.scoringAuditId) || !str(run.finalizedAt) || !str(run.finalizedBy)) return false;
  if (!oneOf(run.outcome, OUTCOMES) || !levelOk(run.outcome, run.level)) return false;
  const inconclusive = run.inconclusive;
  if (run.outcome === 'INCONCLUSIVO') {
    if (!isObj(inconclusive) || !str(inconclusive.reasonCode) || !strs(inconclusive.failedGates) || !percent(inconclusive.coveragePercent) || !percent(inconclusive.minimumCoveragePercent)) return false;
  } else if (inconclusive !== null) return false;
  if (!isObj(run.decisions) || !headN(run.decisions.head) || !int(run.decisions.count) || !strs(run.decisions.appliedIds)) return false;
  if (!isObj(run.evidence) || !str(run.evidence.layout) || !str(run.evidence.referenceDate) || !arr(run.evidence.bases, (b) => isObj(b) && str(b.ref) && str(b.kind) && str(b.observedAt) && isHex64(b.contentSha256))) return false;
  if (!isObj(run.versions) || !str(run.versions.mapper) || !str(run.versions.methodology) || !str(run.versions.scoreModel) || !isHex64(run.versions.rulerFingerprint)) return false;
  if (!isObj(run.hashes) || !isHex64(run.hashes.inputSha256) || !isHex64(run.hashes.resultSha256) || !isHex64(run.hashes.contentSha256) || !(run.hashes.prevSha256 === null || isHex64(run.hashes.prevSha256))) return false;
  return resultOk(run.result, run.outcome, true);
}

export function isRunDetailPayload(value: unknown, auditId?: string, seq?: number): value is RunDetailResponse {
  if (!isObj(value) || !boolN(value.stale) || !boolN(value.decisionsChanged) || !bool(value.superseded) || !runOk(value.run, auditId)) return false;
  return seq === undefined || (value.run as { seq: number }).seq === seq;
}

export function isFinalizePayload(value: unknown, auditId?: string): value is FinalizeSuccess {
  if (!isObj(value) || value.definitive !== true || !bool(value.replayed) || !isHead(value.head) || value.anchored !== true || !boolN(value.stateChangedAfterFinalization) || !bool(value.recoveredPending) || !runOk(value.run, auditId)) return false;
  const run = value.run as { seq: number; hashes: { contentSha256: string } };
  return value.head.seq === run.seq && value.head.sha256 === run.hashes.contentSha256; // o head devolvido é o do próprio registro confirmado
}

export function isEvidencePayload(value: unknown, auditId?: string): boolean {
  if (!isObj(value) || value.kind !== 'EVIDENCE_COLLECTION' || !str(value.auditId) || (auditId !== undefined && value.auditId !== auditId)) return false;
  const company = value.company;
  if (!isObj(company) || !strN(company.name) || !strN(company.city) || !strN(company.stateCode)) return false;
  if (!isObj(value.identifiers) || !arr(value.identifiers.confirmed, (c) => isObj(c) && str(c.type) && str(c.value))) return false;
  if (!isObj(value.integrity) || !str(value.integrity.status) || !isObj(value.source) || !str(value.source.label)) return false;
  return strN(value.collectedAt);
}

export type { PendingDecision };
