import assert from 'node:assert/strict';
import test from 'node:test';
import { GUARD_MAX_LAG, type GuardPseudonyms, type LedgerRecord } from '../src/lib/link-audit-ledger';
import { analyzeReconciliation, FINDING_CODES, gateVerdict, type AnalysisInput, type GuardRow } from '../src/lib/link-audit-guard-reconcile/model';
import type { BackupLedger, LedgerBackup } from '../src/lib/link-audit-guard-reconcile/backup';
import { GUARD_KEY_C, PSEUDONYMS_A, PSEUDONYMS_B_AFTER_A } from './helpers/link-audit-guard-db-fixtures';
import { createGuardPseudonyms } from '../src/lib/link-audit-ledger/guard-pseudonym';
import { ledgerOf, ROUND } from './helpers/link-audit-guard-reconcile-fixtures';

/*
 * G1.b.2b — NÚCLEO PURO da reconciliação externa (GE-E5, PG-G09; spec §5.1.4 regras 2, 3 e 6). Compara três coisas: as cabeças da guarda (a maior
 * linha de cada pseudônimo), o livro da rodada de backup (os `contentSha256` por posição) e o REGISTRO ANTERIOR da própria reconciliação (as linhas da
 * guarda que ela já viu). Acusa: cabeça da guarda ausente do backup (à frente da cópia, ou sem livro nenhum na cópia, ou sob chave desconhecida);
 * guarda que regrediu; backup à frente da guarda além de `L_max`; divergência de hash; auditoria sem cabeça com livro ≥ 2; livro ilegível na cópia.
 * O próximo registro guarda a "marca d'água": as cabeças de agora MAIS as linhas que regrediram, que continuam sendo cobradas na rodada seguinte.
 */
const A = 'auditoria-recon-a1';
const B = 'auditoria-recon-b1';
const C = 'auditoria-recon-c1';
const LEDGERS: Record<string, LedgerRecord[]> = { [A]: ledgerOf(A, 7), [B]: ledgerOf(B, 1), [C]: ledgerOf(C, 9) };

const backupOf = (ledgers: Readonly<Record<string, readonly LedgerRecord[]>>, unreadable: readonly string[] = []): LedgerBackup => ({
  round: ROUND,
  manifestSha256: 'f'.repeat(64),
  ledgers: [...Object.keys(ledgers), ...unreadable].sort().map((auditId): BackupLedger => (unreadable.includes(auditId) ? { auditId, status: 'UNREADABLE', reason: 'SEQUENCE_GAP' } : { auditId, status: 'OK', shas: (ledgers[auditId] ?? []).map((record) => record.contentSha256) })),
});
/** A linha que a guarda teria para `auditId` na posição `seq` (pseudônimo da chave `key`, hash do livro sintético). */
const rowOf = (auditId: string, seq: number, pseudonyms: GuardPseudonyms = PSEUDONYMS_A, sha?: string): GuardRow => {
  const ref = pseudonyms.current(auditId);
  return { auditRef: ref.auditRef, keyId: ref.keyId, ledgerSeq: seq, sha256: sha ?? (LEDGERS[auditId]?.[seq - 1]?.contentSha256 as string) };
};
const input = (over: Partial<AnalysisInput> = {}): AnalysisInput => ({
  backup: backupOf(LEDGERS),
  pseudonyms: PSEUDONYMS_A,
  guardHeads: [rowOf(A, 7), rowOf(C, 6)],
  previous: null,
  previousNow: [],
  ...over,
});
const codes = (analysis: ReturnType<typeof analyzeReconciliation>): string[] => analysis.findings.map((finding) => finding.code);

test('G1.b.2b reconciliação limpa: CONSISTENT (cabeça = cauda), BEHIND (atraso ≤ L_max) e NO_HEAD (livro com 1 registro, regra 2) sem achado; o próximo registro guarda as cabeças de agora', () => {
  const analysis = analyzeReconciliation(input());
  assert.deepEqual(analysis.findings, []);
  assert.deepEqual(analysis.audits.map((audit) => [audit.auditId, audit.status, audit.backupSeq, audit.guardSeq, audit.lag]), [
    [A, 'CONSISTENT', 7, 7, 0],
    [B, 'NO_HEAD', 1, null, null],
    [C, 'BEHIND', 9, 6, 3],
  ]);
  assert.deepEqual(analysis.summary, { audits: 3, consistent: 1, behind: 1, noHead: 1, divergent: 0, guardHeads: 2, findings: 0 });
  assert.deepEqual(analysis.witness, [rowOf(A, 7), rowOf(C, 6)].sort((x, y) => x.auditRef.localeCompare(y.auditRef)));
  for (const audit of analysis.audits) assert.equal(audit.auditRef, PSEUDONYMS_A.current(audit.auditId).auditRef, 'o pseudônimo listado é o da chave ATUAL');
});

test('PG-G09 cabeça da guarda AUSENTE DO BACKUP: guarda à frente da cópia (backup mais velho que a guarda) ⇒ GUARD_HEAD_NOT_IN_BACKUP, com o auditId que o backup fornece', () => {
  const analysis = analyzeReconciliation(input({ guardHeads: [rowOf(A, 7), { ...rowOf(C, 6), ledgerSeq: 11, sha256: 'a'.repeat(64) }] }));
  assert.deepEqual(analysis.findings, [{ code: 'GUARD_HEAD_NOT_IN_BACKUP', auditRef: PSEUDONYMS_A.current(C).auditRef, auditId: C, backupSeq: 9, guardSeq: 11, recordedSeq: null }]);
  assert.equal(analysis.audits.find((audit) => audit.auditId === C)?.status, 'DIVERGENT');
});

test('PG-G09 cabeça da guarda AUSENTE DO BACKUP: pseudônimo de uma chave conhecida sem livro na cópia ⇒ GUARD_HEAD_WITHOUT_LEDGER; de uma chave que a reconciliação não tem ⇒ GUARD_HEAD_UNKNOWN_KEY (os dois sem auditId: o backup não o fornece)', () => {
  const missing = rowOf('auditoria-recon-sumiu', 4, PSEUDONYMS_A, 'b'.repeat(64));
  const foreign = rowOf('auditoria-recon-outra', 2, createGuardPseudonyms(GUARD_KEY_C), 'c'.repeat(64));
  const analysis = analyzeReconciliation(input({ guardHeads: [rowOf(A, 7), rowOf(C, 6), missing, foreign] }));
  assert.deepEqual(analysis.findings, [
    { code: 'GUARD_HEAD_WITHOUT_LEDGER', auditRef: missing.auditRef, auditId: null, backupSeq: null, guardSeq: 4, recordedSeq: null },
    { code: 'GUARD_HEAD_UNKNOWN_KEY', auditRef: foreign.auditRef, auditId: null, backupSeq: null, guardSeq: 2, recordedSeq: null },
  ]);
  assert.ok(!JSON.stringify(analysis).includes('auditoria-recon-sumiu') && !JSON.stringify(analysis).includes('auditoria-recon-outra'), 'auditId que o backup não fornece nunca aparece');
});

test('PG-G09 guarda que REGREDIU em relação ao registro anterior: linha vista antes sumiu, mudou de hash ou de chave ⇒ GUARD_REGRESSED; a linha continua no próximo registro (marca d’água) e segue cobrada', () => {
  const previous = [rowOf(A, 7), rowOf(C, 6)];
  // a guarda "esqueceu" a posição 7 de A (só tem a 5) e a linha 6 de C mudou de hash
  const now: GuardRow[] = [{ ...rowOf(C, 6), sha256: 'd'.repeat(64) }];
  const analysis = analyzeReconciliation(input({ guardHeads: [rowOf(A, 5), { ...rowOf(C, 6), sha256: 'd'.repeat(64) }], previous, previousNow: now }));
  assert.ok(codes(analysis).includes('GUARD_REGRESSED'));
  const regressed = analysis.findings.filter((finding) => finding.code === 'GUARD_REGRESSED');
  assert.deepEqual(regressed.map((finding) => [finding.auditId, finding.recordedSeq, finding.guardSeq]), [[A, 7, 5], [C, 6, 6]]);
  assert.ok(analysis.witness.some((row) => row.auditRef === PSEUDONYMS_A.current(A).auditRef && row.ledgerSeq === 7), 'a linha que sumiu continua cobrada');
  assert.ok(analysis.witness.some((row) => row.ledgerSeq === 6 && row.sha256 === rowOf(C, 6).sha256), 'o hash registrado antes continua cobrado');
  // rodada seguinte com o mesmo estado: o registro novo (marca d'água) ainda acusa
  const again = analyzeReconciliation(input({ guardHeads: [rowOf(A, 5), { ...rowOf(C, 6), sha256: 'd'.repeat(64) }], previous: analysis.witness, previousNow: now.concat([rowOf(A, 5)]) }));
  assert.ok(codes(again).filter((code) => code === 'GUARD_REGRESSED').length >= 2);
  // outra chave na mesma posição também é regressão
  const relabeled = analyzeReconciliation(input({ previous: [rowOf(A, 7)], previousNow: [{ ...rowOf(A, 7), keyId: 'gk-test-z' }] }));
  assert.deepEqual(relabeled.findings.map((finding) => finding.code), ['GUARD_REGRESSED']);
});

test('PG-G09 guarda que avançou normalmente desde o registro anterior: sem regressão; as linhas antigas saem do registro novo', () => {
  const analysis = analyzeReconciliation(input({ previous: [rowOf(A, 5), rowOf(C, 6)], previousNow: [rowOf(A, 5), rowOf(C, 6)] }));
  assert.deepEqual(analysis.findings, []);
  assert.ok(!analysis.witness.some((row) => row.ledgerSeq === 5), 'a linha 5 de A foi superada pela 7');
});

test(`PG-G09 backup À FRENTE da guarda além de L_max (${GUARD_MAX_LAG}): atraso ${GUARD_MAX_LAG} ⇒ BEHIND; atraso ${GUARD_MAX_LAG + 1} ⇒ BACKUP_AHEAD_BEYOND_L_MAX`, () => {
  assert.equal(GUARD_MAX_LAG, 5, 'L_max da spec §5.1.7');
  const atLimit = analyzeReconciliation(input({ guardHeads: [rowOf(A, 7), rowOf(C, 9 - GUARD_MAX_LAG)] }));
  assert.deepEqual(atLimit.findings, []);
  assert.equal(atLimit.audits.find((audit) => audit.auditId === C)?.status, 'BEHIND');
  const beyond = analyzeReconciliation(input({ guardHeads: [rowOf(A, 7), rowOf(C, 9 - GUARD_MAX_LAG - 1)] }));
  assert.deepEqual(beyond.findings, [{ code: 'BACKUP_AHEAD_BEYOND_L_MAX', auditRef: PSEUDONYMS_A.current(C).auditRef, auditId: C, backupSeq: 9, guardSeq: 3, recordedSeq: null }]);
});

test('PG-G09 DIVERGÊNCIA DE HASH: a cabeça da guarda existe na posição, mas com outro hash que o do backup ⇒ HASH_MISMATCH (o backup não é o histórico testemunhado)', () => {
  const analysis = analyzeReconciliation(input({ guardHeads: [{ ...rowOf(A, 4), sha256: 'e'.repeat(64) }, rowOf(C, 6)] }));
  assert.deepEqual(analysis.findings, [{ code: 'HASH_MISMATCH', auditRef: PSEUDONYMS_A.current(A).auditRef, auditId: A, backupSeq: 7, guardSeq: 4, recordedSeq: null }]);
});

test('PG-G09 auditoria SEM CABEÇA com livro ≥ 2 ⇒ GUARD_HEAD_MISSING (regra 2); com 1 registro ⇒ NO_HEAD, sem achado', () => {
  const analysis = analyzeReconciliation(input({ guardHeads: [rowOf(C, 6)] }));
  assert.deepEqual(analysis.findings, [{ code: 'GUARD_HEAD_MISSING', auditRef: PSEUDONYMS_A.current(A).auditRef, auditId: A, backupSeq: 7, guardSeq: null, recordedSeq: null }]);
  assert.equal(analysis.audits.find((audit) => audit.auditId === B)?.status, 'NO_HEAD');
});

test('PG-G09 livro ILEGÍVEL na cópia ⇒ BACKUP_LEDGER_UNREADABLE daquela auditoria; as cabeças dela não viram "sem livro"', () => {
  const analysis = analyzeReconciliation(input({ backup: backupOf({ [A]: LEDGERS[A] as LedgerRecord[] }, [C]), guardHeads: [rowOf(A, 7), rowOf(C, 6)] }));
  assert.deepEqual(analysis.findings, [{ code: 'BACKUP_LEDGER_UNREADABLE', auditRef: PSEUDONYMS_A.current(C).auditRef, auditId: C, backupSeq: null, guardSeq: 6, recordedSeq: null }]);
});

test('G1.b.2b rotação da chave do pseudônimo: cabeças sob a aposentada e sob a atual pertencem à mesma auditoria; vale a maior; o pseudônimo listado é o da atual', () => {
  const old = rowOf(A, 5, PSEUDONYMS_A);
  const current = { auditRef: PSEUDONYMS_B_AFTER_A.current(A).auditRef, keyId: 'gk-test-b', ledgerSeq: 7, sha256: (LEDGERS[A]?.[6] as LedgerRecord).contentSha256 };
  const analysis = analyzeReconciliation(input({ pseudonyms: PSEUDONYMS_B_AFTER_A, guardHeads: [old, current, { ...rowOf(C, 6), auditRef: PSEUDONYMS_B_AFTER_A.current(C).auditRef, keyId: 'gk-test-b' }] }));
  assert.deepEqual(analysis.findings, []);
  const audit = analysis.audits.find((entry) => entry.auditId === A);
  assert.deepEqual([audit?.status, audit?.guardSeq, audit?.auditRef], ['CONSISTENT', 7, PSEUDONYMS_B_AFTER_A.current(A).auditRef]);
  // a aposentada com a cabeça mais alta que a atual também conta (cabeça antes da primeira publicação com a chave nova)
  const before = analyzeReconciliation(input({ pseudonyms: PSEUDONYMS_B_AFTER_A, guardHeads: [rowOf(A, 7, PSEUDONYMS_A), rowOf(C, 6, PSEUDONYMS_A)] }));
  assert.deepEqual(before.findings, []);
  assert.equal(before.audits.find((entry) => entry.auditId === A)?.status, 'CONSISTENT');
});

test('G1.b.2b achados em ordem estável (código, auditoria, pseudônimo) e códigos fechados', () => {
  assert.deepEqual([...FINDING_CODES], ['GUARD_REGRESSED', 'GUARD_HEAD_NOT_IN_BACKUP', 'GUARD_HEAD_WITHOUT_LEDGER', 'GUARD_HEAD_UNKNOWN_KEY', 'HASH_MISMATCH', 'BACKUP_AHEAD_BEYOND_L_MAX', 'GUARD_HEAD_MISSING', 'BACKUP_LEDGER_UNREADABLE']);
  const shuffled = [rowOf(C, 2), { ...rowOf(A, 9), sha256: 'a'.repeat(64) }];
  const one = analyzeReconciliation(input({ guardHeads: shuffled, previous: [rowOf(A, 7)], previousNow: [] }));
  const two = analyzeReconciliation(input({ guardHeads: [...shuffled].reverse(), previous: [rowOf(A, 7)], previousNow: [] }));
  assert.deepEqual(one, two);
  assert.deepEqual(codes(one), ['GUARD_REGRESSED', 'GUARD_HEAD_NOT_IN_BACKUP', 'BACKUP_AHEAD_BEYOND_L_MAX']);
});

test('G1.b.2b portão G-1 (núcleo): operante só com auditoria no backup, todas CONSISTENT e nenhum achado; sem nenhuma cabeça das auditorias ⇒ STACK_NOT_PUBLISHING', () => {
  const ok = analyzeReconciliation(input({ backup: backupOf({ [A]: LEDGERS[A] as LedgerRecord[] }), guardHeads: [rowOf(A, 7)] }));
  assert.deepEqual(gateVerdict(ok), { operational: true, code: null });
  assert.deepEqual(gateVerdict(analyzeReconciliation(input())), { operational: false, code: 'NOT_CONSISTENT' }, 'BEHIND e NO_HEAD não abrem o portão');
  assert.deepEqual(gateVerdict(analyzeReconciliation(input({ backup: backupOf({}), guardHeads: [] }))), { operational: false, code: 'NO_AUDITS' });
  assert.deepEqual(gateVerdict(analyzeReconciliation(input({ guardHeads: [] }))), { operational: false, code: 'STACK_NOT_PUBLISHING' });
  const orphan = analyzeReconciliation(input({ backup: backupOf({ [A]: LEDGERS[A] as LedgerRecord[] }), guardHeads: [rowOf(A, 7), rowOf('auditoria-recon-sumiu', 2, PSEUDONYMS_A, 'b'.repeat(64))] }));
  assert.deepEqual(gateVerdict(orphan), { operational: false, code: 'NOT_CONSISTENT' }, 'cabeça sem livro também fecha o portão');
});
