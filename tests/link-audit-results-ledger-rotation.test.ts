import assert from 'node:assert/strict';
import test from 'node:test';
import { ledgerCapacity, needsCheckpoint, LEDGER_CAPACITY_POLICY, replayLedger, rotationCheckpointDue, simulateOperations, verifyTags, CHECKPOINT_EVERY } from '../src/lib/link-audit-ledger';
import { ANA, BIA, clock, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, ledgerAuth, ledgerFor, ledgerRecords, ledgerWorld, LEDGER_AUTH_A, LEDGER_KEY_A, LEDGER_KEY_B, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { appendLedger, runClosingMaker, runIntentMaker } from './helpers/link-audit-results-ledger-fixtures';

/*
 * R1.1 — ROTAÇÃO da chave do livro com `RUN_*` (spec §16.17.6, D-7; RL-30): resultados NUNCA gravam nem pagam o CHECKPOINT da rotação (a finalização não move a
 * cabeça de decisões); o ponto devido é pago pelo `RECOVER` (ou pela próxima operação de decisão) e cobre também os `RUN_*`; nenhum registro da chave antiga
 * reaparece depois de um da nova (R6-06), qualquer que seja a família.
 */
registerCleanup();
const at = (iso: string) => () => new Date(iso);
const rotatedAuth = (now = '2026-11-03T12:00:00Z') => ledgerAuth({ current: LEDGER_KEY_B, retired: [`${LEDGER_KEY_A}:2026-12-02`], now: at(now) });
const AFTER_OLD_KEY_EXPIRED = '2026-12-20T12:00:00Z';
const rotatedService = (w: LedgerWorld, now?: string) => decisionsOver(w, { ledger: ledgerFor(w, { guard: null, auth: rotatedAuth(now) }), knownHeads: NO_RESULTS });
const kids = async (w: LedgerWorld) => (await ledgerRecords(w)).map((r) => `${r.event}:${r.origin.kid.slice(-1)}`);

/** Uma decisão confirmada sob a chave A e, depois da rotação, um resultado completo sob a chave B — sem CHECKPOINT entre eles. */
async function rotatedWithRun(): Promise<LedgerWorld> {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await appendLedger(w, rotatedAuth(), runIntentMaker(), runClosingMaker('RUN_CONFIRMED'));
  return w;
}

test('RL-30: RUN_* sob a chave nova NÃO gravam nem pagam o CHECKPOINT — a rotação continua sem cobertura e a conta de resultados não reserva ponto de verificação (D-7)', async () => {
  const w = await rotatedWithRun();
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CONFIRMED:a', 'RUN_INTENT:b', 'RUN_CONFIRMED:b'], 'nenhum CHECKPOINT antes dos RUN_* da chave nova');
  const view = await must(rotatedService(w).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.keyCoverage?.covered, view.ledger.keyCoverage?.otherKeyRecords], ['PROTECTED', false, 3], 'os RUN_* da chave nova não cobrem os registros da antiga');
  const records = await ledgerRecords(w);
  assert.equal(rotationCheckpointDue(records, 'lk-test-b'), true);
  assert.equal(needsCheckpoint(records, 'lk-test-b', CHECKPOINT_EVERY), true, 'o ponto continua devido para a próxima DECISÃO ou o RECOVER');
  const capacity = ledgerCapacity(records, 'lk-test-b');
  assert.equal(capacity.runsAvailable, Math.floor((LEDGER_CAPACITY_POLICY.RUN - records.length) / 2), 'resultados: nenhum registro reservado para o CHECKPOINT');
  assert.equal(capacity.decisionsAvailable, simulateOperations(records.length, records.length, true, CHECKPOINT_EVERY, LEDGER_CAPACITY_POLICY.RECORD), 'decisões: a primeira paga o CHECKPOINT devido');
  // sem o RECOVER, vencida a chave antiga, a auditoria morre (os RUN_* da nova não cobrem nada)
  const expired = await must(rotatedService(w, AFTER_OLD_KEY_EXPIRED).list(BIA, w.auditId, clock()));
  assert.deepEqual([expired.ledger.state, expired.ledger.reason], ['HISTORY_UNRESOLVED', 'KEY_EXPIRED']);
});

test('RL-30: o RECOVER grava UM CHECKPOINT da chave nova que cobre também os RUN_*; depois disso a chave antiga vence sem matar a auditoria', async () => {
  const w = await rotatedWithRun();
  const svc = rotatedService(w);
  assert.ok((await svc.ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock())).ok);
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CONFIRMED:a', 'RUN_INTENT:b', 'RUN_CONFIRMED:b', 'CHECKPOINT:b']);
  const records = await ledgerRecords(w);
  assert.deepEqual(records[5]?.checkpoint, { throughSeq: 5, throughSha256: records[4]?.contentSha256 }, 'o ponto cobre até o último RUN_*');
  assert.ok((await svc.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, clock())).ok);
  assert.equal((await ledgerRecords(w)).length, 6, 'idempotente');
  const later = await must(rotatedService(w, AFTER_OLD_KEY_EXPIRED).list(BIA, w.auditId, clock()));
  assert.deepEqual([later.ledger.state, later.ledger.keyCoverage?.covered, later.decisions.length], ['PROTECTED', true, 1]);
  assert.equal(verifyTags(records, rotatedAuth(AFTER_OLD_KEY_EXPIRED)), null);
});

test('RL-30: sem RECOVER, a próxima operação de DECISÃO paga o CHECKPOINT devido depois dos RUN_* (e ele os cobre)', async () => {
  const w = await rotatedWithRun();
  const svc = rotatedService(w);
  const view = await must(svc.list(BIA, w.auditId, clock()));
  await must(svc.create(ANA, w.auditId, { record: rec.c3(), expectedHead: view.head }, clock()));
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CONFIRMED:a', 'RUN_INTENT:b', 'RUN_CONFIRMED:b', 'CHECKPOINT:b', 'INTENT:b', 'CONFIRMED:b']);
  const later = await must(rotatedService(w, AFTER_OLD_KEY_EXPIRED).list(BIA, w.auditId, clock()));
  assert.deepEqual([later.ledger.state, later.decisions.length], ['PROTECTED', 2]);
});

test('RL-30 / R6-06: depois de um RUN_* da chave nova, nenhum registro da antiga é aceito (nem RUN_*, nem de decisão) — UNTRUSTED', async () => {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await appendLedger(w, rotatedAuth(), runIntentMaker());
  const records = await appendLedger(w, LEDGER_AUTH_A, runClosingMaker('RUN_CONFIRMED'));
  assert.ok(replayLedger(records, w.auditId).ok, 'controle: a estrutura é válida (o problema é a época de chave)');
  assert.deepEqual(verifyTags(records, rotatedAuth()), { reason: 'UNTRUSTED', seq: 5 }, 'RUN_CONFIRMED da chave antiga depois do RUN_INTENT da nova');
  const view = await must(rotatedService(w).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.decisions.length], ['HISTORY_UNRESOLVED', 'UNTRUSTED', 0]);
});
