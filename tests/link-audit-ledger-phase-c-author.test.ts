import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, anchorPath, clock, entryPath, hashTree, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerWorld, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';

/*
 * Emenda §16.16 (16/11/2026, achado M-1 / RV3A-1): a fase C (entrada e recibo presentes, `CONFIRMED` ausente) só é concluída pelo AUTOR da entrada.
 * Os recibos não são autenticados: quem escreve só na pasta de recibos fabrica o recibo de uma pendente LEGÍTIMA de outro operador; escrita ou `RECOVER`
 * de OUTRO operador não pode promovê-la a confirmada.
 */
registerCleanup();
const RECOVER = JSON.parse('{"action":"RECOVER"}') as Record<string, unknown>;
const WHEN = '2026-12-01T00:00:00.000Z';

/** Ana publica a entrada e o recibo falha (fase B, `ANCHOR_PENDING`); em seguida um recibo FORJADO (só SHA-256) é plantado: o disco passa a parecer fase C. */
async function forgedReceiptWorld(): Promise<LedgerWorld> {
  const w = await ledgerWorld();
  const anchorRoot = w.anchorDir;
  const noReceipts = faulty({ async writeExclusive(target, data, mode) { return target.startsWith(anchorRoot) ? Promise.reject(errno('EACCES')) : nodeFsOps.writeExclusive(target, data, mode); } });
  const flaky = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS, fs: noReceipts });
  const pending = await flaky.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!pending.ok && pending.code === 'ANCHOR_PENDING');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT']);
  const entry = JSON.parse(fs.readFileSync(entryPath(w, 1), 'utf8')) as { contentSha256: string };
  const body = { schemaVersion: 1, kind: 'LINK_AUDIT_DECISION_ANCHOR', auditId: w.auditId, seq: 1, headSha256: entry.contentSha256, anchoredAt: '2026-10-21T12:00:00.000Z', prevAnchorSha256: null };
  fs.mkdirSync(path.dirname(anchorPath(w, 1)), { recursive: true });
  fs.writeFileSync(anchorPath(w, 1), serialize(seal(body)));
  return w;
}
const healthy = (w: LedgerWorld, staleOperationMs?: number) => decisionsOver(w, { ledger: ledgerFor(w, { guard: null, ...(staleOperationMs !== undefined ? { staleOperationMs } : {}) }), knownHeads: NO_RESULTS });

/** Nada mudou: livro, decisões e recibos byte a byte. */
const snapshotOf = (w: LedgerWorld) => ({ ledger: hashTree(w.ledgerDir), decisions: hashTree(w.decisionsDir), anchors: hashTree(w.anchorDir) });

async function assertStillPending(w: LedgerWorld, before: ReturnType<typeof snapshotOf>): Promise<void> {
  assert.deepEqual(snapshotOf(w), before, 'nada foi gravado no livro, nas decisões nem nos recibos');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT'], 'nenhum CONFIRMED');
  const list = await must(healthy(w).list(BIA, w.auditId));
  assert.notEqual(list.ledger.state, 'PROTECTED');
  assert.equal(list.finalizable, false);
  assert.ok(list.decisions.every((decision) => decision.status !== 'ACTIVE'), 'a decisão alheia NÃO é vigente');
}

test('RV3A-1 (regressão): recibo forjado + ESCRITA de outro operador ⇒ NÃO confirma (PENDING_UNCONFIRMED); depois o REPLAY do autor ⇒ CONFIRMED e vigente', async () => {
  const w = await forgedReceiptWorld();
  const before = snapshotOf(w);
  const attack = await healthy(w).create(BIA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!attack.ok && attack.code === 'PENDING_UNCONFIRMED', JSON.stringify(attack).slice(0, 200));
  const other = await healthy(w).revoke(BIA, w.auditId, { revokes: 'op-0001', reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.', expectedHead: null }, clock);
  assert.ok(!other.ok && other.code === 'PENDING_UNCONFIRMED', JSON.stringify(other).slice(0, 200));
  await assertStillPending(w, before);

  const replay = await must(healthy(w).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock));
  assert.equal(replay.replayed, true);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED']);
  const list = await must(healthy(w).list(BIA, w.auditId));
  assert.deepEqual([list.ledger.state, list.decisions.map((d) => [d.recordedBy, d.status])], ['PROTECTED', [['ana@empresa.com', 'ACTIVE']]]);
  assert.equal((await must(healthy(w).list(BIA, w.auditId))).decisions.length, 1);
});

test('RV3A-1 (regressão): recibo forjado + RECOVER de outro operador ⇒ NÃO confirma e nada é gravado; o RECOVER do AUTOR conclui', async () => {
  const w = await forgedReceiptWorld();
  const before = snapshotOf(w);
  const attack = await healthy(w).ledgerAction(BIA, w.auditId, RECOVER, clock);
  assert.ok(!attack.ok && attack.code === 'PENDING_UNCONFIRMED', JSON.stringify(attack).slice(0, 200));
  await assertStillPending(w, before);

  const own = await must(healthy(w).ledgerAction(ANA, w.auditId, RECOVER, clock));
  assert.equal(own.ledger.state, 'PROTECTED');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED']);
  assert.equal((await must(healthy(w).list(BIA, w.auditId))).decisions[0]?.status, 'ACTIVE');
});

test('fase C legítima (queda entre o recibo e o CONFIRMED): outro operador também NÃO conclui, em escrita ou RECOVER; o autor conclui', async () => {
  const w = await ledgerWorld();
  await must(w.rawProtected.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock));
  const confirmedPath = path.join(w.ledgerDir, w.auditId, 'l000003.json');
  const lost = fs.readFileSync(confirmedPath);
  fs.unlinkSync(confirmedPath); // fabrica a queda: entrada e recibo existem, o CONFIRMED não
  const before = snapshotOf(w);
  const write = await healthy(w).create(BIA, w.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!write.ok && write.code === 'PENDING_UNCONFIRMED', JSON.stringify(write).slice(0, 200));
  const recover = await healthy(w).ledgerAction(BIA, w.auditId, RECOVER, clock);
  assert.ok(!recover.ok && recover.code === 'PENDING_UNCONFIRMED', JSON.stringify(recover).slice(0, 200));
  assert.deepEqual(snapshotOf(w), before);
  assert.ok(lost.length > 0);
  await must(healthy(w).ledgerAction(ANA, w.auditId, RECOVER, clock));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED']);
});

test('R6-04 preservado: outro PROCESSO/serviço do MESMO autor conclui a fase C (idempotente); o dono depois recebe sucesso e nada é duplicado', async () => {
  const w = await ledgerWorld();
  await must(w.rawProtected.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock));
  fs.unlinkSync(path.join(w.ledgerDir, w.auditId, 'l000003.json'));
  const sameAuthor = await must(healthy(w).ledgerAction(ANA, w.auditId, RECOVER, clock));
  assert.equal(sameAuthor.ledger.state, 'PROTECTED');
  const owner = await must(w.rawProtected.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock));
  assert.equal(owner.replayed, true);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED']);
});

test('fases A e B inalteradas: o RECOVER de OUTRO operador ainda aborta a INTENT vencida (fase A) e não mexe na pendente (fase B)', async () => {
  // fase A: INTENT sem entrada (a gravação da entrada falhou) — qualquer operador a aborta depois de vencida
  const failing = faulty({ async link(from, to) { if (to.endsWith('d0001.json')) throw errno('ENOSPC'); return nodeFsOps.link(from, to); } });
  const a = await ledgerWorld({ decisionsFs: failing });
  assert.ok(!(await a.rawProtected.create(ANA, a.auditId, { record: rec.c2(), expectedHead: null }, clock)).ok);
  assert.deepEqual(await ledgerEvents(a), ['GENESIS', 'INTENT']);
  const aborted = await must(healthy(a, 1).ledgerAction(BIA, a.auditId, RECOVER, () => WHEN));
  assert.equal(aborted.ledger.openOperation, null);
  assert.deepEqual(await ledgerEvents(a), ['GENESIS', 'INTENT', 'ABORTED']);

  // fase B: entrada sem recibo — o RECOVER de outro operador não grava nada e a pendente segue pendente
  const anchorRoot = (b: LedgerWorld) => b.anchorDir;
  const b = await ledgerWorld();
  const noReceipts = faulty({ async writeExclusive(target, data, mode) { return target.startsWith(anchorRoot(b)) ? Promise.reject(errno('EACCES')) : nodeFsOps.writeExclusive(target, data, mode); } });
  const pending = await decisionsOver(b, { ledger: ledgerFor(b, { guard: null }), knownHeads: NO_RESULTS, fs: noReceipts }).create(ANA, b.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!pending.ok && pending.code === 'ANCHOR_PENDING');
  const before = snapshotOf(b);
  await healthy(b).ledgerAction(BIA, b.auditId, RECOVER, clock);
  assert.deepEqual(snapshotOf(b), before, 'a fase B não foi alterada pelo RECOVER de outro operador');
  const blocked = await healthy(b).create(BIA, b.auditId, { record: rec.c2(), expectedHead: null }, clock);
  assert.ok(!blocked.ok && blocked.code === 'PENDING_UNCONFIRMED');
});
