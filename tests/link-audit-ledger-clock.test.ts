import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenObservations, MAX_OBSERVATIONS } from '../src/lib/link-audit-ledger';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';

/*
 * R7-09 — INTENT gravada com o relógio no FUTURO. Antes: idade negativa ⇒ a operação nunca vencia até o relógio real alcançá-la (centenas de dias) ⇒ a auditoria ficava presa em
 * "operação em andamento" e a recuperação NÃO a abortava (negação de serviço persistente; a reabertura administrativa não existe). Agora: hora gravada no futuro ⇒ a idade vem do
 * tempo MONOTÔNICO que este processo observa a operação aberta (`observed.ts`); passou `staleOperationMs` de observação ⇒ vence como qualquer outra. Hora gravada normal: nada muda.
 */
registerCleanup();
const FUTURE = '2027-06-01T00:00:00.000Z'; // relógio adiantado ~200 dias na hora da gravação
const NOW = '2026-11-03T12:00:00.000Z'; // o relógio voltou ao normal
const STALE = 120_000;

/** Auditoria cuja ÚNICA operação aberta é uma INTENT (fase A: sem entrada) gravada com o relógio adiantado. */
async function futureIntentWorld(): Promise<LedgerWorld> {
  const failingEntry = faulty({ async link(from, to) { if (to.endsWith('d0001.json')) throw errno('ENOSPC'); return nodeFsOps.link(from, to); } });
  const w = await ledgerWorld({ decisionsFs: failingEntry });
  const failed = await w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, () => FUTURE);
  assert.ok(!failed.ok);
  assert.equal((await ledgerEvents(w)).at(-1), 'INTENT');
  return w;
}
/** Relógio monotônico controlável (nenhum teste espera tempo de verdade). */
function fakeMonotonic() {
  let now = 1_000;
  return { ms: () => now, advance: (by: number) => { now += by; } };
}

test('R7-09: INTENT do futuro VENCE pela observação monotônica — antes não vencia, agora o RECOVER a aborta e a auditoria volta a gravar (provado sem esperar tempo real)', async () => {
  const w = await futureIntentWorld();
  const clockMs = fakeMonotonic();
  const observations = createOpenObservations(clockMs.ms);
  const service = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, staleOperationMs: STALE, pollMs: 1, observations }), knownHeads: NO_RESULTS });

  const first = await must(service.list(BIA, w.auditId, () => NOW));
  assert.equal(first.ledger.state, 'PROTECTED');
  assert.equal(first.ledger.openOperation?.stale, false, 'primeira observação: ainda não vencida (um dono vivo conclui em milissegundos)');
  assert.ok((first.ledger.openOperation?.ageMs ?? -1) >= 0, 'a idade NUNCA é negativa: vem da observação monotônica');

  const before = await ledgerEvents(w);
  clockMs.advance(STALE - 1);
  const almost = await must(service.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => NOW));
  assert.equal(almost.ledger.openOperation?.stale, false, 'um instante antes do limite: nada é abortado');
  assert.deepEqual(await ledgerEvents(w), before, 'nada gravado antes do limite');

  clockMs.advance(1);
  const stale = await must(service.list(BIA, w.auditId, () => NOW));
  assert.equal(stale.ledger.openOperation?.stale, true, 'no limite: vencida');
  assert.equal(stale.ledger.recoverable, true);
  const recovered = await must(service.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => NOW));
  assert.equal(recovered.ledger.openOperation, null);
  const records = await ledgerRecords(w);
  assert.deepEqual(records.map((record) => record.event), [...before, 'ABORTED']);
  assert.ok((records.at(-1)?.op?.observed?.ageMs ?? 0) >= STALE, 'o abortamento registra a idade OBSERVADA (nunca negativa)');

  // a auditoria voltou a gravar; a cadeia (hora gravada monotônica) continua íntegra e a decisão nova fica protegida
  const written = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null, observations }), knownHeads: NO_RESULTS }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, () => NOW));
  assert.ok(written.decision);
  const after = await must(service.list(BIA, w.auditId, () => NOW));
  assert.deepEqual([after.ledger.state, after.decisions.length], ['PROTECTED', 1]);
  assert.deepEqual((await ledgerEvents(w)).slice(-2), ['INTENT', 'CONFIRMED']);
});

test('R7-09: uma ESCRITA comum também destrava sozinha — espera a observação vencer, aborta a INTENT do futuro e grava (nada fica preso; sem ação administrativa)', async () => {
  const w = await futureIntentWorld();
  const clockMs = fakeMonotonic();
  const observations = createOpenObservations(clockMs.ms);
  // cada espera da escrita (pollMs) avança o relógio monotônico injetado: o vencimento chega sem tempo real
  const ledger = ledgerFor(w, { guard: null, staleOperationMs: STALE, pollMs: 1, observations });
  const ticking = new Proxy(ledger, { get: (target, key) => (key === 'prepare' ? async (input: Parameters<typeof target.prepare>[0]) => { clockMs.advance(STALE / 4); return target.prepare(input); } : Reflect.get(target, key)) });
  const service = decisionsOver(w, { ledger: ticking, knownHeads: NO_RESULTS });
  const written = await must(service.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, () => NOW));
  assert.ok(written.decision);
  const events = await ledgerEvents(w);
  assert.deepEqual(events, ['GENESIS', 'INTENT', 'ABORTED', 'INTENT', 'CONFIRMED'], events.join());
});

test('controle: com hora gravada NORMAL a idade de parede continua mandando (a observação não interfere) — INTENT recente espera, INTENT antiga vence', async () => {
  const failingEntry = faulty({ async link(from, to) { if (to.endsWith('d0001.json')) throw errno('ENOSPC'); return nodeFsOps.link(from, to); } });
  const w = await ledgerWorld({ decisionsFs: failingEntry });
  const failed = await w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, () => '2026-11-03T12:00:00.000Z');
  assert.ok(!failed.ok);
  const observations = createOpenObservations(fakeMonotonic().ms); // o relógio monotônico NUNCA avança: só a idade de parede pode vencer
  const service = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, staleOperationMs: STALE, pollMs: 1, observations }), knownHeads: NO_RESULTS });
  const young = await must(service.list(BIA, w.auditId, () => '2026-11-03T12:00:30.000Z'));
  assert.deepEqual([young.ledger.openOperation?.stale, young.ledger.openOperation?.ageMs], [false, 30_000]);
  const old = await must(service.list(BIA, w.auditId, () => '2026-11-03T12:02:00.000Z'));
  assert.deepEqual([old.ledger.openOperation?.stale, old.ledger.openOperation?.ageMs], [true, 120_000]);
  assert.equal(observations.size, 0, 'hora gravada normal não registra observação');
});

test('observações: memória LIMITADA (as mais antigas saem; sair só adia o vencimento), idade nunca negativa, cada chave tem a sua referência', () => {
  const clockMs = fakeMonotonic();
  const observations = createOpenObservations(clockMs.ms);
  assert.equal(observations.ageOf('a'), 0);
  clockMs.advance(500);
  assert.equal(observations.ageOf('a'), 500);
  assert.equal(observations.ageOf('b'), 0, 'outra chave começa do zero');
  for (let index = 0; index < MAX_OBSERVATIONS + 50; index += 1) observations.ageOf(`k${index}`);
  assert.ok(observations.size <= MAX_OBSERVATIONS, `tamanho ${observations.size}`);
  assert.equal(observations.ageOf('a'), 0, '"a" foi esquecida: recomeça (só adia)');
  const backwards = createOpenObservations(() => (clockMs.advance(-10), clockMs.ms()));
  assert.ok(backwards.ageOf('x') >= 0 && backwards.ageOf('x') >= 0, 'um relógio monotônico que retrocedesse nunca daria idade negativa');
});
