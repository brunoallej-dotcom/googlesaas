import type { DecisionDto, DecisionsList, FinalizeSuccess, Head, PendingDecision, PendingRun, PreviewPayload, ResultsList, RunDetailResponse, RunSummary, LedgerActionResult } from './types';

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
const percentN = (v: unknown): boolean => v === null || percent(v);

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
/** Falha fechada ("ausência nunca vira zero"): número só em item avaliado; `null` só em item não avaliado; omitido é sempre válido (INCONCLUSIVO). `evaluated === null` = o motor não calculou o item: nada de pontos. */
const obtainedOk = (v: unknown, evaluated: boolean | null): boolean => v === undefined || (evaluated === true ? num(v) : evaluated === false && v === null);
const subOk = (s: unknown): boolean =>
  isObj(s) && str(s.id) && str(s.label) && num(s.maxHalfPoints) && str(s.source) && strN(s.sourceReason) && strN(s.state) && strN(s.stateReason) && strN(s.tier) && numN(s.evaluatedHalfPoints) && obtainedOk(s.obtainedHalfPoints, s.state === null ? null : s.state === 'SCORED' || s.state === 'ABSENCE_PROVEN') && strs(s.decisionIds) && strs(s.evidenceRefs) &&
  isObj(s.potential) && strN(s.potential.family) && num(s.potential.halfPoints);
const criterionOk = (c: unknown): boolean => isObj(c) && str(c.id) && str(c.label) && num(c.maxPoints) && strN(c.status) && // `status` é null quando o motor não calculou (SEM_EVIDENCIA, ENTRADA_RECUSADA)
   numN(c.evaluatedHalfPoints) && obtainedOk(c.obtainedHalfPoints, c.status === null ? null : c.status === 'EVALUATED' || c.status === 'PARTIAL') && arr(c.subcriteria, subOk);
const baseOk = (b: unknown): boolean => isObj(b) && str(b.ref) && str(b.kind) && str(b.observedAt) && str(b.origin) && isHex64(b.contentSha256) && bool(b.legacy) && bool(b.superseded);
const refSourceOk = (v: unknown): boolean => v === null || (isObj(v) && str(v.ref) && str(v.observedAt));

export function isPreviewPayload(value: unknown, auditId?: string): value is PreviewPayload {
  if (!isObj(value) || value.definitive !== false || !str(value.auditId) || (auditId !== undefined && value.auditId !== auditId) || !strN(value.scoringAuditId) || !oneOf(value.state, STATES)) return false;
  const { company, evidence, decisions, finalization } = value;
  if (!isObj(company) || !bool(company.located) || !str(company.profileState) || !strN(company.unavailableReason) || !strN(company.websiteHost) || !str(company.source)) return false;
  if (!isObj(evidence) || !isObj(evidence.integrity) || !str(evidence.integrity.status) || !(evidence.integrity.checkedFiles === null || int(evidence.integrity.checkedFiles)) || !strN(evidence.layout) || !strN(evidence.referenceDate)) return false;
  const prov = evidence.provenance;
  if (!(prov === null || (isObj(prov) && Array.isArray(prov.missingRefs) && prov.missingRefs.length <= 5 && (prov.missingRefs as unknown[]).every((r) => str(r) && /^[a-z-]+:c\d{4}(-r\d{4})?$/.test(r)) && ((prov.status === 'AUTHENTICATED' && prov.reason === null && prov.missingRefs.length === 0) || (prov.status === 'UNAUTHENTICATED' && oneOf(prov.reason, PROVENANCE_REASONS) && (prov.reason === 'EVIDENCE_MISSING') === (prov.missingRefs.length > 0)))))) return false;
  if (!refSourceOk(evidence.referenceDateSource) || !refSourceOk(evidence.profileSource) || !arr(evidence.bases, baseOk)) return false;
  if (!isObj(decisions) || !headN(decisions.head) || !int(decisions.count) || !pendingSummaryOk(decisions.pending) || !bool(decisions.finalizable) || !witnessOk(decisions.witness) || !previewLedgerOk(decisions.ledger) || !strs(decisions.applied) || !arr(decisions.held, (h) => isObj(h) && str(h.decisionId) && str(h.code))) return false;
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
    if (value.state !== 'CALCULADO_FINALIZAVEL' || outcome === null || finalization.expectedInputSha256 === null || blocking || (decisions as Rec).pending !== null || (decisions as Rec).finalizable !== true || unresolved((decisions as Rec).witness) || ledgerBlocks((decisions as Rec).ledger) || ((decisions as Rec).ledger as Rec).operationOpen === true || ((decisions as Rec).held as unknown[]).length > 0 || (evidence.integrity as Rec).status !== 'OK' || ((evidence.provenance as Rec | null)?.status !== 'AUTHENTICATED')) return false; // finalizável exige coleta AUTÊNTICA
    if (!sameHead(finalization.expectedHead as Head | null, (decisions as Rec).head as Head | null)) return false;
  }
  return true;
}

const decisionDtoOk = (d: unknown): boolean =>
  isObj(d) && str(d.decisionId) && /^op-\d{4}$/.test(d.decisionId) && int(d.seq) && str(d.kind) && isObj(d.record) && str(d.recordedAt) && str(d.recordedBy) && strN(d.supersedes) && strN(d.supersededBy) && oneOf(d.status, ['ACTIVE', 'SUPERSEDED', 'REVOKED', 'AMBIGUOUS']) && bool(d.siteDependent);
const PROVENANCE_REASONS = ['PROOF_NOT_CONFIGURED', 'NO_SEAL', 'LEGACY_NO_SEAL', 'SEAL_INVALID', 'EVIDENCE_NOT_SEALED', 'EVIDENCE_MISSING', 'EVIDENCE_HASH_MISMATCH', 'VERIFICATION_ERROR'] as const;
const WITNESS_STATUSES = ['NOT_REQUIRED', 'UNWITNESSED', 'CONSISTENT', 'RECEIPT_LOST_WITNESSED', 'HISTORY_REGRESSED', 'HISTORY_DIVERGES', 'UNTRUSTED', 'UNAVAILABLE', 'NOT_CONFIGURED'] as const;
const witnessOk = (w: unknown): boolean =>
  isObj(w) &&
  oneOf(w.status, WITNESS_STATUSES) &&
  int(w.knownHeads) &&
  (w.coveredSeq === null || (int(w.coveredSeq) && (w.coveredSeq as number) >= 1)) &&
  int(w.unwitnessedAffecting) &&
  (w.status !== 'NOT_REQUIRED' || w.knownHeads === 0) &&
  (w.status !== 'UNWITNESSED' || (w.knownHeads === 0 && w.coveredSeq === null)) &&
  (w.status !== 'CONSISTENT' || (w.knownHeads as number) >= 1);
const unresolved = (w: unknown): boolean => isObj(w) && ['HISTORY_REGRESSED', 'HISTORY_DIVERGES', 'UNTRUSTED', 'UNAVAILABLE', 'NOT_CONFIGURED'].includes(w.status as string);
const LEDGER_STATES = ['NOT_REQUIRED', 'LEGACY_READ_ONLY', 'ENROLLMENT_PENDING', 'PROTECTED', 'HISTORY_UNRESOLVED'] as const;
const GUARD_STATUSES = ['NOT_CONFIGURED', 'CONSISTENT', 'BEHIND', 'MISMATCH', 'UNAVAILABLE'] as const;
const ledgerHeadOk = (h: unknown): boolean => h === null || (isObj(h) && int(h.ledgerSeq) && (h.ledgerSeq as number) >= 1 && isHex64(h.sha256));
/** Estado do livro (decisões). Coerência: só PROTECTED tem cabeça; `HISTORY_UNRESOLVED` exige razão; os demais estados não têm operação aberta. */
/** Capacidade: números inteiros coerentes entre si (usado + restante = máximo; nível coerente com o que cabe). Ausente é válido (livro sem registros / não exigido). */
const capacityOk = (c: unknown): boolean =>
  c === undefined ||
  (isObj(c) &&
    int(c.maxRecords) && int(c.usedRecords) && int(c.remainingRecords) && int(c.decisionsAvailable) && int(c.revocationsAvailable) &&
    (c.usedRecords as number) <= (c.maxRecords as number) && (c.remainingRecords as number) === Math.max(0, (c.maxRecords as number) - (c.usedRecords as number)) &&
    oneOf(c.level, ['OK', 'REVOKE_ONLY', 'EXHAUSTED'] as const) &&
    (c.level === 'OK' ? (c.decisionsAvailable as number) > 0 : c.level === 'REVOKE_ONLY' ? c.decisionsAvailable === 0 && (c.revocationsAvailable as number) > 0 : c.decisionsAvailable === 0 && c.revocationsAvailable === 0));
const keyCoverageOk = (c: unknown): boolean => c === undefined || (isObj(c) && str(c.keyId) && /^[a-z0-9][a-z0-9-]{3,31}$/.test(c.keyId) && bool(c.covered) && int(c.otherKeyRecords));
const ledgerOk = (l: unknown): boolean => {
  if (!isObj(l) || !oneOf(l.state, LEDGER_STATES) || !(l.reason === null || (str(l.reason) && /^[A-Z_]{3,40}$/.test(l.reason))) || !ledgerHeadOk(l.head) || !int(l.confirmedDecisions) || !oneOf(l.externalGuard, GUARD_STATUSES)) return false;
  if (!bool(l.recoverable) || !bool(l.receiptReissuable)) return false;
  if (!capacityOk(l.capacity) || !keyCoverageOk(l.keyCoverage)) return false;
  const open = l.openOperation;
  if (!(open === null || (isObj(open) && str(open.opId) && /^[0-9a-f]{32}$/.test(open.opId) && int(open.decisionSeq) && ['A', 'B', 'C'].includes(open.phase as string) && int(open.ageMs) && bool(open.stale)))) return false;
  if (l.state === 'HISTORY_UNRESOLVED' && l.reason === null) return false;
  if (l.state === 'NOT_REQUIRED' && (l.head !== null || open !== null || l.confirmedDecisions !== 0)) return false;
  if ((l.state === 'ENROLLMENT_PENDING' || l.state === 'LEGACY_READ_ONLY') && (open !== null || l.head !== null)) return false;
  if (l.state === 'PROTECTED' && (l.reason !== null || l.head === null || l.receiptReissuable !== false)) return false;
  return true;
};
export const isLedgerActionPayload = (value: unknown): value is LedgerActionResult => isObj(value) && oneOf(value.action, ['ENROLL', 'RECOVER'] as const) && ledgerOk(value.ledger);
const ledgerBlocks = (l: unknown): boolean => isObj(l) && l.state !== 'PROTECTED' && l.state !== 'NOT_REQUIRED';
/** O que a PRÉVIA informa do livro (sem operação detalhada). */
const previewLedgerOk = (l: unknown): boolean =>
  isObj(l) && oneOf(l.state, LEDGER_STATES) && (l.reason === null || (str(l.reason) && /^[A-Z_]{3,40}$/.test(l.reason))) && ledgerHeadOk(l.head) && int(l.confirmedDecisions) && bool(l.operationOpen) && oneOf(l.externalGuard, GUARD_STATUSES) && !(l.state === 'HISTORY_UNRESOLVED' && l.reason === null);
const ORIGINS = ['PROVEN', 'UNPROVEN', 'UNVERIFIABLE'] as const;
const ORIGIN_DETAILS = ['MISSING', 'INVALID', 'KEY_MISMATCH', 'KEY_REVOKED', 'KEY_EXPIRED', 'NO_KEY'] as const;
/**
 * Coerência da ORIGEM (falha fechada): só uma pendência com origem COMPROVADA pode trazer conteúdo, autor ou `isMine`. Uma resposta que
 * diga o contrário (servidor com defeito, resposta forjada) é recusada por inteiro: a tela nunca apresenta como "sua" uma pendência
 * cuja origem não foi comprovada.
 */
const originOk = (p: Rec): boolean =>
  oneOf(p.origin, ORIGINS) && (p.origin === 'PROVEN' ? p.originDetail === null : oneOf(p.originDetail, ORIGIN_DETAILS)) && bool(p.isMine) && (p.isMine !== true || p.origin === 'PROVEN');
const pendingDecisionOk = (p: unknown): boolean =>
  isObj(p) &&
  p.confirmed === false &&
  int(p.seq) &&
  oneOf(p.action, ['RECORD', 'REVOKE']) &&
  strN(p.decisionId) &&
  strN(p.revokes) &&
  strN(p.supersedes) &&
  originOk(p) &&
  strN(p.reason) &&
  (p.record === null || isObj(p.record)) &&
  str(p.recordedAt) &&
  strN(p.recordedBy) &&
  isHex64(p.entrySha256) &&
  (p.origin === 'PROVEN' ? str(p.recordedBy) : p.recordedBy === null) &&
  (p.isMine === true || (p.record === null && p.reason === null));

export function isDecisionsPayload(value: unknown, auditId?: string): value is DecisionsList {
  if (!isObj(value) || !str(value.auditId) || (auditId !== undefined && value.auditId !== auditId) || !headN(value.head) || !bool(value.finalizable)) return false;
  if (!(value.pending === null || pendingDecisionOk(value.pending))) return false;
  if (!arr<DecisionDto>(value.decisions, decisionDtoOk) || !arr<DecisionDto>(value.allDecisions, decisionDtoOk)) return false;
  if (!arr(value.history, (h) => isObj(h) && int(h.seq) && oneOf(h.action, ['RECORD', 'REVOKE']) && strN(h.decisionId) && strN(h.revokes) && strN(h.reason) && str(h.recordedAt) && str(h.recordedBy))) return false;
  if ((value.decisions as DecisionDto[]).some((d) => d.status !== 'ACTIVE')) return false; // "vigentes" só contém ativas
  if (value.pending !== null && value.finalizable !== false) return false; // pendente = não finalizável (contrato da 6B)
  // decisões EM DÚVIDA: só existem com pendente, são exatamente as marcadas AMBIGUOUS e nunca contam como vigentes
  if (!Array.isArray(value.ambiguousDecisionIds) || !(value.ambiguousDecisionIds as unknown[]).every((id) => str(id) && /^op-\d{4}$/.test(id))) return false;
  const doubtful = (value.allDecisions as DecisionDto[]).filter((d) => d.status === 'AMBIGUOUS').map((d) => d.decisionId).sort();
  const declared = [...(value.ambiguousDecisionIds as string[])].sort();
  if (doubtful.length !== declared.length || doubtful.some((id, index) => id !== declared[index])) return false;
  if (declared.length > 0 && value.pending === null && !unresolved(value.witness) && !ledgerBlocks(value.ledger)) return false;
  if ((value.decisions as DecisionDto[]).some((d) => declared.includes(d.decisionId))) return false;
  // TESTEMUNHA: integridade NÃO resolvida ⇒ ZERO decisões vigentes, nada ACTIVE em lugar nenhum, nada finalizável; "recibo perdido" exige pendente
  if (!witnessOk(value.witness) || !ledgerOk(value.ledger)) return false;
  // LIVRO: fora de PROTECTED (a inscrever, legada ou não resolvida) o modo é restrito — mesma regra da testemunha; operação aberta no livro ⇒ não finalizável
  if (ledgerBlocks(value.ledger) && (value.finalizable !== false || (value.decisions as DecisionDto[]).length > 0 || (Array.isArray(value.operatorRecords) && value.operatorRecords.length > 0) || (value.allDecisions as DecisionDto[]).some((d) => d.status === 'ACTIVE'))) return false;
  if ((value.ledger as Rec).openOperation !== null && value.finalizable !== false) return false;
  if (unresolved(value.witness) && (value.finalizable !== false || (value.decisions as DecisionDto[]).length > 0 || (value.allDecisions as DecisionDto[]).some((d) => d.status === 'ACTIVE'))) return false;
  if ((value.witness as Rec).status === 'RECEIPT_LOST_WITNESSED' && value.pending === null) return false;
  // uma operação pendente que revoga/substitui X nunca deixa X vigente (R3-INFO-2)
  const pend = value.pending as Rec | null;
  const target = pend ? (pend.action === 'REVOKE' ? pend.revokes : pend.supersedes) : null;
  if (typeof target === 'string' && (value.decisions as DecisionDto[]).some((d) => d.decisionId === target)) return false;
  return true;
}

const runSummaryOk = (r: unknown): boolean =>
  isObj(r) && int(r.seq) && (r.seq as number) >= 1 && str(r.finalizedAt) && str(r.finalizedBy) && oneOf(r.outcome, OUTCOMES) && levelOk(r.outcome, r.level) && strN(r.reasonCode) && percent(r.coveragePercent) && isHex64(r.inputSha256) && isHex64(r.resultSha256) && isHex64(r.contentSha256) && headN(r.decisionsHead) && bool(r.superseded) && boolN(r.stale) && boolN(r.decisionsChanged);
const pendingRunOk = (p: unknown): boolean =>
  isObj(p) &&
  int(p.seq) &&
  (p.seq as number) >= 1 &&
  str(p.finalizedAt) &&
  p.receipt === 'MISSING' &&
  p.blocksFinalization === true &&
  originOk(p) &&
  (p.origin === 'PROVEN' ? oneOf(p.outcome, OUTCOMES) && percentN(p.coveragePercent) && (p.appliedDecisionCount === null || int(p.appliedDecisionCount)) && strN(p.level) : p.outcome === null && p.level === null && p.coveragePercent === null && p.appliedDecisionCount === null) &&
  isHex64(p.inputSha256) &&
  headN(p.decisionsHead) &&
  boolN(p.matchesCurrent) &&
  isHex64(p.contentSha256);

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
