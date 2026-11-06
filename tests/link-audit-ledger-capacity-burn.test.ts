import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerWorld, NO_RESULTS } from './helpers/link-audit-ledger-fixtures';

/*
 * RESERVA DE CAPACIDADE × TENTATIVAS QUE FALHAM. Cada tentativa de decisão que falha depois da INTENT custa 2 registros (INTENT + ABORTED) e consome a classe da operação. O que limita o ritmo de
 * consumo é que a INTENT fica ABERTA até vencer (`staleOperationMs`, padrão 120 s): enquanto isso toda outra tentativa recebe "operação em andamento" e NADA é gravado. Este teste prova esse limite
 * (no máximo UMA tentativa falha por período de vencimento ⇒ 2 registros por período) — diferente da reemissão de recibo, que antes gravava 1 registro por tentativa SEM esse freio (ver `-m2`).
 */
registerCleanup();
const REASON = 'Revogada porque o juízo estava errado e foi refeito pelo operador.';
const T0 = Date.parse('2026-11-05T12:00:00.000Z');
const at = (offsetSeconds: number) => (): string => new Date(T0 + offsetSeconds * 1000).toISOString();

test('revogações que FALHAM: no máximo uma por período de vencimento (2 registros: INTENT + ABORTED); as demais recebem "em andamento" e não gravam nada — o consumo é limitado pelo tempo', async () => {
  const failingRevocation = faulty({
    async link(from, to) {
      if (to.endsWith('d0002.json')) throw errno('ENOSPC');
      return nodeFsOps.link(from, to);
    },
  });
  const w = await ledgerWorld({ decisionsFs: failingRevocation });
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, at(0)));
  const svc = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, staleOperationMs: 120_000, pollMs: 1 }), knownHeads: NO_RESULTS, fs: failingRevocation });
  const revoke = async (seconds: number) => {
    const view = await must(svc.list(BIA, w.auditId, at(seconds)));
    return svc.revoke(ANA, w.auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, at(seconds));
  };
  const baseline = (await ledgerEvents(w)).length; // GENESIS, INTENT, CONFIRMED
  const first = await revoke(10);
  assert.ok(!first.ok, 'a entrada da revogação não consegue ser publicada');
  assert.equal((await ledgerEvents(w)).length, baseline + 1, 'só a INTENT foi gravada');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const again = await revoke(20 + attempt);
    assert.ok(!again.ok && again.code === 'LEDGER_OPERATION_IN_PROGRESS', `tentativa ${attempt}: ${JSON.stringify(again).slice(0, 160)}`);
  }
  assert.equal((await ledgerEvents(w)).length, baseline + 1, '12 tentativas seguidas dentro do período NÃO gravaram nada');
  // vencido o período: UM abortamento + UMA nova INTENT (2 registros), e de novo o freio
  const afterStale = await revoke(10 + 121);
  assert.ok(!afterStale.ok);
  assert.deepEqual((await ledgerEvents(w)).slice(baseline), ['INTENT', 'ABORTED', 'INTENT'], 'por período: ABORTED da anterior + INTENT da nova');
});
