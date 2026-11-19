import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveCapacityPolicy } from '../src/lib/link-audit-ledger';
import { ANA, clock, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { ledgerEvents, ledgerWorld, refOf } from './helpers/link-audit-ledger-fixtures';

/*
 * R7-01 — a INTENT é o PONTO AUTORITATIVO da capacidade. A preparação (`prepare`) já recusa por classe, mas a porta do livro tem de se defender sozinha: uma chamada de `intent`
 * que chegue sem a preparação certa (outra classe, ou depois de uma corrida) NÃO pode abrir uma operação que não cabe junto do registro que a fecha. Teste direto na porta.
 */
registerCleanup();
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';
const POLICY = deriveCapacityPolicy(16, 1, 64, 2); // MAX 16, manutenção 2, reserva de 1 revogação (3 registros: INTENT + CONFIRMED + reemissão; +1 checkpoint +2 folga = 6), folga do fecho de resultado 1 (§16.17.6) ⇒ RECORD ≤ 7, REVOKE ≤ 14

test('porta: `intent` recusa por CLASSE e exige espaço para o fecho, sem depender de `prepare` (nada é gravado ao recusar)', async () => {
  assert.deepEqual([POLICY.RECORD, POLICY.REVOKE, POLICY.max], [7, 14, 16]);
  const w = await ledgerWorld({ capacityPolicy: POLICY });
  for (const record of [rec.c2(), rec.c3(), rec.p3(5)]) await must(w.protectedService.create(ANA, w.auditId, { record }, clock()));
  assert.equal((await ledgerEvents(w)).length, 7, 'no limite da classe RECORD');
  const record = refOf(4, 'a'.repeat(64), 'x');
  const before = (await ledgerEvents(w)).length;
  const refusedRecord = await w.ledger.intent({ session: await w.ledger.begin(w.auditId), auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), entry: record });
  assert.ok(refusedRecord.kind === 'REFUSED' && refusedRecord.refusal.code === 'LEDGER_CAPACITY_EXHAUSTED', `decisão nova no limite da classe RECORD: ${JSON.stringify(refusedRecord).slice(0, 160)}`);

  // revogações até o limite da classe REVOKE (7 → 9 → 11 → 13)
  for (const id of ['op-0001', 'op-0002', 'op-0003']) {
    const view = await must(w.rawProtected.list(ANA, w.auditId, clock()));
    await must(w.rawProtected.revoke(ANA, w.auditId, { revokes: id, reason: REASON, expectedHead: view.head }, clock()));
  }
  assert.equal((await ledgerEvents(w)).length, 13);
  const revoke = refOf(7, 'a'.repeat(64), 'y', { action: 'REVOKE', decisionId: null, revokes: 'op-0004', affectsPrior: true });
  const refusedRevoke = await w.ledger.intent({ session: await w.ledger.begin(w.auditId), auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), entry: revoke });
  assert.ok(refusedRevoke.kind === 'REFUSED' && refusedRevoke.refusal.code === 'LEDGER_CAPACITY_EXHAUSTED', `revogação sem espaço para o fecho: ${JSON.stringify(refusedRevoke).slice(0, 160)}`);
  assert.equal((await ledgerEvents(w)).length, 13);
  assert.ok(before === 7);
});
