import { createScoringBasisReader } from '../../src/lib/link-audit-evidence/scoring-basis';
import type { DecisionDto, Head, ListPayload, PendingDto } from '../../src/lib/link-audit-decisions';
import type { OperatorRecord } from '../../src/lib/link-audit/scoring';
import { createScoringPreviewService, type PreviewDeps } from '../../src/lib/link-audit-scoring-runs';
import { ANA, type World } from './link-audit-decisions-fixtures';
import { TRUSTING_EVIDENCE_POLICY } from './link-audit-evidence-provenance-fixtures';

/* Dados 100% FICTÍCIOS. Stores reais (pastas temporárias) para o fluxo normal; doubles só onde a falha não é alcançável sem adulterar o disco. */
export const NOW = '2026-10-23T10:00:00.000Z';
export const clockFixed = (): string => NOW;
export { ANA };

/** Prévia sobre as pastas reais de um `world()` (leitor de pontuação real + serviço de decisões real, sem `expectedHead` automático). */
export function previewOver(w: Pick<World, 'evidenceDir' | 'raw'>, over: Partial<PreviewDeps> = {}) {
  return createScoringPreviewService({
    basisReader: createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true }),
    decisions: w.raw,
    clock: clockFixed,
    evidenceProvenance: TRUSTING_EVIDENCE_POLICY, // testes de OUTROS assuntos; a prova de coleta tem testes próprios com a política real
    ...over,
  });
}

const BASIS = { capture: 1, report: { capture: 1, revision: 1 }, collectedAt: '2026-10-22T12:54:48.079Z' };

/** `ListPayload` sintético para os casos que o disco normal não produz (várias decisões conflitantes, head que muda). */
export function fakeList(auditId: string, records: readonly OperatorRecord[], over: { head?: Head | null; pending?: PendingDto | null; finalizable?: boolean; basisCapture?: number | null; siteDependent?: readonly string[] } = {}): ListPayload {
  const decisions: DecisionDto[] = records.map((record, index) => {
    const { id, operatorEmail, recordedAt, ...client } = record as unknown as Record<string, unknown> & { id: string; operatorEmail: string; recordedAt: string };
    return {
      decisionId: id,
      seq: index + 1,
      kind: record.kind,
      record: client as never,
      recordedAt,
      recordedBy: operatorEmail,
      supersedes: null,
      supersededBy: null,
      revokedAtSeq: null,
      status: 'ACTIVE',
      basis: { ...BASIS, capture: over.basisCapture === undefined ? 1 : over.basisCapture },
      siteDependent: over.siteDependent?.includes(id) ?? false,
    };
  });
  return {
    auditId,
    head: over.head === undefined ? { seq: records.length, sha256: 'b'.repeat(64) } : over.head,
    pending: over.pending ?? null,
    finalizable: over.finalizable ?? true,
    decisions,
    ambiguousDecisionIds: [],
    witness: { status: 'NOT_REQUIRED', knownHeads: 0, coveredSeq: null, unwitnessedAffecting: 0 },
    ledger: { state: 'NOT_REQUIRED', reason: null, head: null, decisionHead: null, confirmedDecisions: 0, openOperation: null, recoverable: false, receiptReissuable: false, externalGuard: 'NOT_CONFIGURED' },
    history: [],
    allDecisions: decisions,
    operatorRecords: records,
    limits: { maxEffectiveRecords: 200, maxEntries: 9999, reservedForRevocations: 100 },
    anchors: {} as never,
    integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles: records.length, ignoredFiles: 0, note: 'teste' },
  };
}

export const operatorRecord = (id: string, over: Record<string, unknown>): OperatorRecord =>
  ({ id, operatorEmail: ANA.email, recordedAt: '2026-10-22T13:00:00.000Z', justification: 'Confirmação feita pelo operador com base no perfil exibido.', ...over }) as unknown as OperatorRecord;
export const c2Record = (id: string, value = 'COMPATIBLE'): OperatorRecord => operatorRecord(id, { kind: 'JUDGEMENT', subcriterionId: 'C2', value });
export const s4Record = (id: string): OperatorRecord => operatorRecord(id, { kind: 'NOT_APPLICABLE', subcriterionIds: ['S4'], code: 'BUSINESS_MODEL', causeEvidenceIds: [] });
export const equivalenceRecord = (id: string): OperatorRecord => operatorRecord(id, { kind: 'NAME_EQUIVALENCE', nameA: 'Padaria Exemplo Ltda', nameB: 'Padaria Exemplo' });
