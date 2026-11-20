import type { ApiOutcome, AuditApi } from '../../src/components/link-audit/audit-page/api';
import type { Ctx } from '../../src/components/link-audit/audit-page/controller';
import { newTokens } from '../../src/components/link-audit/audit-page/controller';
import type { Action, PageState } from '../../src/components/link-audit/audit-page/state';
import { initialPageState, pageReducer } from '../../src/components/link-audit/audit-page/state';
import type { DecisionDto, DecisionRequest, DecisionsList, FinalizeRequest, FinalizeSuccess, Head, LedgerActionKind, LedgerActionResult, PendingRun, PreviewPayload, ResultsList, RunDetail, RunDetailResponse, RunSummary } from '../../src/components/link-audit/audit-page/types';

/* Dados 100% FICTÍCIOS. Nenhuma auditoria real, nenhuma rede. */
export const AUDIT = 'auditoria-ui-0001';
export const H = (c: string): string => c.repeat(64).slice(0, 64);
export const head = (seq = 1, c = 'a'): Head => ({ seq, sha256: H(c) });

export function previewFixture(over: Partial<PreviewPayload> = {}): PreviewPayload {
  const base: PreviewPayload = {
    definitive: false,
    auditId: AUDIT,
    scoringAuditId: AUDIT,
    state: 'CALCULADO_FINALIZAVEL',
    company: { located: true, profileState: 'AVAILABLE', unavailableReason: null, websiteHost: 'www.padaria-exemplo.example', source: 'Serper (intermediário)' },
    evidence: {
      integrity: { status: 'OK', checkedFiles: 4 },
      provenance: { status: 'AUTHENTICATED', reason: null, missingRefs: [] },
      layout: 'VERSIONED',
      referenceDate: '2026-10-22',
      referenceDateSource: { ref: 'capture:c0001', observedAt: '2026-10-22T12:54:48.079Z' },
      profileSource: { ref: 'capture:c0001', observedAt: '2026-10-22T12:54:48.079Z' },
      bases: [{ ref: 'capture:c0001', kind: 'CAPTURE', observedAt: '2026-10-22T12:54:48.079Z', origin: 'GOOGLE_NATIVE', contentSha256: H('1'), legacy: false, superseded: false }],
    },
    decisions: { head: null, count: 0, pending: null, finalizable: true, witness: { status: 'NOT_REQUIRED', knownHeads: 0, coveredSeq: null, unwitnessedAffecting: 0 }, ledger: { state: 'NOT_REQUIRED', reason: null, head: null, confirmedDecisions: 0, operationOpen: false, externalGuard: 'NOT_CONFIGURED' }, applied: [], held: [] },
    decisionOptions: [
      { type: 'JUDGEMENT', subcriterionId: 'C2', code: null, available: true, reasonCode: null },
      { type: 'NOT_APPLICABLE', subcriterionId: 'S4', code: 'BUSINESS_MODEL', available: true, reasonCode: null },
    ],
    criteria: [
      {
        id: 'NAP', label: 'Dados essenciais e consistência NAP', maxPoints: 15, status: 'PARTIAL', evaluatedHalfPoints: 12,
        subcriteria: [
          { id: 'N1', label: 'Nome do perfil presente', maxHalfPoints: 6, source: 'AUTOMATICO', sourceReason: null, state: 'SCORED', stateReason: 'PRESENT', tier: 'presente', evaluatedHalfPoints: 6, decisionIds: [], evidenceRefs: ['capture:c0001'], potential: { family: null, halfPoints: 0 } },
          { id: 'N2', label: 'Endereço ou área de atendimento', maxHalfPoints: 6, source: 'BLOQUEADO', sourceReason: 'ADDRESS_NOT_STRUCTURED', state: 'NOT_VERIFIED', stateReason: 'ADDRESS_UNPARSED', tier: null, evaluatedHalfPoints: 0, decisionIds: [], evidenceRefs: [], potential: { family: 'ADDRESS_NOT_STRUCTURED', halfPoints: 6 } },
        ],
      },
      {
        id: 'CATEGORIES', label: 'Categorias', maxPoints: 10, status: 'NOT_VERIFIED', evaluatedHalfPoints: 0,
        subcriteria: [
          { id: 'C2', label: 'Compatibilidade da categoria principal', maxHalfPoints: 8, source: 'DECISAO_HUMANA', sourceReason: 'AWAITING_OPERATOR_DECISION', state: 'NOT_VERIFIED', stateReason: null, tier: null, evaluatedHalfPoints: 0, decisionIds: [], evidenceRefs: [], potential: { family: 'AWAITING_OPERATOR_DECISION', halfPoints: 8 } },
        ],
      },
    ],
    outcomePreview: { outcome: 'INCONCLUSIVO', level: null, reasonCode: 'COBERTURA_INSUFICIENTE', failedGates: ['COVERAGE_MIN', 'CRITERIA_MIN'], coveragePercent: 11, minimumCoveragePercent: 40 },
    result: {
      methodologyVersion: 'lumos-d3b', scoreModelVersion: 'regua-d3b-r2', rulerFingerprint: H('9'), inputSha256: H('2'), index: null, confidence: null,
      publication: { status: 'INSUFFICIENT', statusText: 'x', gates: [{ id: 'COVERAGE_MIN', passed: false, text: 'Cobertura global de 11% (mínimo de 40%).' }, { id: 'INTEGRITY', passed: true, text: 'Invariantes ok.' }] },
      limitations: [{ code: 'L1', text: 'Dados do painel ainda não coletados.' }],
    },
    blockers: [],
    missing: [{ family: 'NOT_COLLECTED', label: 'Dados do painel do perfil ainda não coletados', potentialHalfPoints: 82 }],
    finalization: { allowed: true, expectedHead: null, expectedInputSha256: H('2') },
  };
  return { ...base, ...over };
}

export function scoredPreview(): PreviewPayload {
  const base = previewFixture();
  return {
    ...base,
    outcomePreview: { outcome: 'PONTUADO', level: 'PROVISORIO', reasonCode: null, failedGates: [], coveragePercent: 62, minimumCoveragePercent: 40 },
    result: { ...(base.result ?? {}), index: { shown: 72, decimal2: '71.50', classificationLabel: 'Em desenvolvimento' }, confidence: { level: 'MEDIUM', levelLabel: 'Média' }, publication: { status: 'PROVISIONAL', gates: [{ id: 'COVERAGE_MIN', passed: true, text: 'Cobertura global de 62% (mínimo de 40%).' }] } },
    // contrato "ausência nunca vira zero": número só no avaliado, null no não avaliado
    criteria: base.criteria.map((criterion) => ({ ...criterion, obtainedHalfPoints: criterion.status === 'PARTIAL' || criterion.status === 'EVALUATED' ? 10 : null, subcriteria: criterion.subcriteria.map((sub) => ({ ...sub, obtainedHalfPoints: sub.state === 'SCORED' || sub.state === 'ABSENCE_PROVEN' ? 4 : null })) })),
  };
}

export function decisionDto(over: Partial<DecisionDto> = {}): DecisionDto {
  return { decisionId: 'op-0001', seq: 1, kind: 'JUDGEMENT', record: { kind: 'JUDGEMENT', subcriterionId: 'C2', value: 'COMPATIBLE', justification: 'Conferido no painel do perfil pelo operador.' }, recordedAt: '2026-10-23T10:00:00.000Z', recordedBy: 'ana@empresa.com', supersedes: null, supersededBy: null, status: 'ACTIVE', siteDependent: false, ...over };
}
export function decisionsFixture(over: Partial<DecisionsList> = {}): DecisionsList {
  return { auditId: AUDIT, head: null, pending: null, finalizable: true, decisions: [], witness: { status: 'NOT_REQUIRED', knownHeads: 0, coveredSeq: null, unwitnessedAffecting: 0 }, ledger: { state: 'NOT_REQUIRED', reason: null, head: null, confirmedDecisions: 0, openOperation: null, recoverable: false, receiptReissuable: false, externalGuard: 'NOT_CONFIGURED' }, ambiguousDecisionIds: [], history: [], allDecisions: [], ...over };
}
export function runSummary(over: Partial<RunSummary> = {}): RunSummary {
  return { seq: 1, finalizedAt: '2026-10-30T12:00:00.000Z', finalizedBy: 'bia@empresa.com', outcome: 'INCONCLUSIVO', level: null, reasonCode: 'COBERTURA_INSUFICIENTE', coveragePercent: 11, inputSha256: H('2'), resultSha256: H('3'), contentSha256: H('4'), decisionsHead: null, superseded: false, stale: false, decisionsChanged: false, ...over };
}
export function resultsFixture(over: Partial<ResultsList> = {}): ResultsList {
  const results = over.results ?? [];
  const last = results[results.length - 1];
  // por padrão o head da cadeia é o do último resultado (coerência exigida pelo validador)
  // R1.5: toda lista diz o que confirma os resultados (padrão: o livro de cabeças)
  return { definitive: true, auditId: AUDIT, confirmation: 'LEDGER', results, head: last ? { seq: last.seq, sha256: last.contentSha256 } : null, pending: null, currentInputSha256: H('2'), currentDecisionsHead: null, ...over };
}
export function pendingRun(over: Partial<PendingRun> = {}): PendingRun {
  return { seq: 1, finalizedAt: '2026-10-30T12:00:00.000Z', receipt: 'MISSING', blocksFinalization: true, origin: 'PROVEN', originDetail: null, isMine: true, outcome: 'INCONCLUSIVO', level: null, coveragePercent: 11, appliedDecisionCount: 0, inputSha256: H('2'), decisionsHead: null, matchesCurrent: true, contentSha256: H('4'), ...over };
}
export function runDetail(over: Partial<RunDetail> = {}): RunDetail {
  return {
    definitive: true, seq: 1, auditId: AUDIT, scoringAuditId: AUDIT, finalizedAt: '2026-10-30T12:00:00.000Z', finalizedBy: 'bia@empresa.com', outcome: 'INCONCLUSIVO', level: null,
    inconclusive: { reasonCode: 'COBERTURA_INSUFICIENTE', failedGates: ['COVERAGE_MIN'], coveragePercent: 11, minimumCoveragePercent: 40 },
    decisions: { head: null, count: 0, appliedIds: [] }, evidence: { layout: 'VERSIONED', referenceDate: '2026-10-22', bases: [] },
    versions: { mapper: 'lumos-map-v1', methodology: 'lumos-d3b', scoreModel: 'regua-d3b-r2', rulerFingerprint: H('9') },
    hashes: { inputSha256: H('2'), resultSha256: H('3'), contentSha256: H('4'), prevSha256: null },
    result: { index: null, confidence: null, publication: { status: 'INSUFFICIENT', gates: [{ id: 'COVERAGE_MIN', passed: false, text: 'Cobertura global de 11% (mínimo de 40%).' }] }, limitations: [] },
    ...over,
  };
}
export const detailResponse = (over: Partial<RunDetailResponse> = {}): RunDetailResponse => ({ confirmation: 'LEDGER', stale: false, decisionsChanged: false, superseded: false, run: runDetail(), ...over });
export const finalizeSuccess = (over: Partial<FinalizeSuccess> = {}): FinalizeSuccess => ({ definitive: true, replayed: false, head: head(1, '4'), anchored: true, stateChangedAfterFinalization: false, recoveredPending: false, run: runDetail(), ...over });

export const ok = <T,>(value: T, status = 200): ApiOutcome<T> => ({ kind: 'ok', status, value });
export const fail = (code: string, status = 409, extra: Record<string, unknown> = {}): ApiOutcome<never> => ({ kind: 'failure', status, code, message: `mensagem de ${code}`, issues: [], ...extra }) as ApiOutcome<never>;

type Queue<T> = Array<ApiOutcome<T> | (() => Promise<ApiOutcome<T>>)>;
/** API falsa: cada método consome uma fila de respostas (a última é repetida) e registra a chamada. */
export class FakeApi implements AuditApi {
  calls: Array<{ name: string; args: unknown[] }> = [];
  q: { evidence: Queue<never>; preview: Queue<PreviewPayload>; decisions: Queue<DecisionsList>; results: Queue<ResultsList>; detail: Queue<RunDetailResponse>; decide: Queue<Record<string, unknown>>; finalize: Queue<FinalizeSuccess> } = {
    evidence: [fail('NOT_SET', 500)], preview: [ok(previewFixture())], decisions: [ok(decisionsFixture())], results: [ok(resultsFixture())], detail: [ok(detailResponse())], decide: [ok({ anchored: true, replayed: false })], finalize: [ok(finalizeSuccess(), 201)],
  };
  private next<T>(queue: Queue<T>): Promise<ApiOutcome<T>> {
    const item = queue.length > 1 ? (queue.shift() as Queue<T>[number]) : (queue[0] as Queue<T>[number]);
    return typeof item === 'function' ? item() : Promise.resolve(item);
  }
  private log(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }
  count = (name: string): number => this.calls.filter((call) => call.name === name).length;
  evidence = (...a: unknown[]) => (this.log('evidence', ...a), this.next(this.q.evidence as never) as never);
  preview = (...a: unknown[]) => (this.log('preview', ...a), this.next(this.q.preview));
  decisions = (...a: unknown[]) => (this.log('decisions', ...a), this.next(this.q.decisions));
  results = (...a: unknown[]) => (this.log('results', ...a), this.next(this.q.results));
  resultDetail = (...a: unknown[]) => (this.log('resultDetail', ...a), this.next(this.q.detail));
  decide = (_id: string, request: DecisionRequest) => (this.log('decide', request), this.next(this.q.decide));
  finalize = (_id: string, request: FinalizeRequest) => (this.log('finalize', request), this.next(this.q.finalize));
  ledgerQueue: Queue<LedgerActionResult> = [ok({ action: 'ENROLL', ledger: { state: 'PROTECTED', reason: null, head: { ledgerSeq: 1, sha256: H('9') }, confirmedDecisions: 0, openOperation: null, recoverable: false, receiptReissuable: false, externalGuard: 'NOT_CONFIGURED' } })];
  ledger = (_id: string, action: LedgerActionKind) => (this.log('ledger', action), this.next(this.ledgerQueue));
}

/** Harness síncrono (mesma regra do gancho): o estado é atualizado ANTES de qualquer leitura seguinte. */
export function harness(api: FakeApi, initial?: (state: PageState) => PageState): { ctx: Ctx; state: () => PageState; actions: Action[] } {
  let current = initial ? initial(initialPageState(AUDIT)) : initialPageState(AUDIT);
  const actions: Action[] = [];
  const ctx: Ctx = {
    api,
    auditId: AUDIT,
    tokens: newTokens(),
    getState: () => current,
    dispatch: (action) => {
      actions.push(action);
      current = pageReducer(current, action);
    },
  };
  return { ctx, state: () => current, actions };
}
