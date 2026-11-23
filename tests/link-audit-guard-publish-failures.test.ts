import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { GuardAlarm } from '../src/lib/link-audit-ledger';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, anchorPath, clock, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { afterLink, alarmLog, controlledGuard, kindsOf, rotatedOnce, saysNothingRecorded, type ControlledGuard } from './helpers/link-audit-guard-fixtures';
import { decisionsOver, LEDGER_AUTH_A, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, NO_RESULTS, type LedgerServiceOver, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { servicesOver } from './helpers/link-audit-ledger-results-fixtures';
import { appendLedger, runIntentMaker } from './helpers/link-audit-results-ledger-fixtures';
import { AGED_OTHERS, finalizeAs, finalizerOver, publishedRunFiles } from './helpers/link-audit-results-ledger-finalize-fixtures';
import { OP_A, OP_B, resultsEnv, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * G1.b.1 — PG-G03: falha de publicação na guarda DEPOIS de um registro já gravado no livro, nos nove pontos S1–S9 da §5.1.2 (spec `link-audit-production-gates.md`,
 * regra 4 da §5.1.4). Para cada ponto: (i) a resposta nunca diz que nada foi gravado; (ii) a vista mostra BEHIND (S1, S6–S9, e S3–S5 terminando num RECOVER) ou a
 * publicação obrigatória seguinte recusa com LEDGER_GUARD_UNAVAILABLE (S2–S5 seguindo para operação nova); (iii) o alarme do ponto é emitido; (iv) a operação nova seguinte
 * recusa até conseguir publicar. Guarda sintética controlada (nenhuma rede); os números de linha da tabela são de `3899a67` — aqui vale o nome da função.
 */
registerCleanup();
const FAR = '2027-03-01T12:00:00.000Z';
const show = (value: unknown): string => JSON.stringify(value).slice(0, 280);

interface Rig {
  readonly w: LedgerWorld;
  readonly g: ControlledGuard;
  readonly alarms: GuardAlarm[];
  readonly over: LedgerServiceOver;
}
async function rig(options: Parameters<typeof ledgerWorld>[0] = {}): Promise<Rig> {
  const w = await ledgerWorld({ withGuard: true, ...options });
  const g = controlledGuard(w.guard);
  const log = alarmLog();
  return { w, g, alarms: log.alarms, over: { guard: g.port, guardAlarms: log.sink } };
}
const decisions = (r: Rig, over: LedgerServiceOver = {}) => decisionsOver(r.w, { ledger: ledgerFor(r.w, { ...r.over, ...over }), knownHeads: NO_RESULTS });
/** O que outro processo veria agora (a guarda sintética, sem o controle). */
async function freshView(w: LedgerWorld, over: LedgerServiceOver = {}) {
  return (await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: w.guard, ...over }), knownHeads: NO_RESULTS }).list(BIA, w.auditId, clock()))).ledger;
}
function assertPointAlarm(alarms: readonly GuardAlarm[], point: string, ledgerSeq: number): void {
  const found = alarms.find((alarm) => alarm.kind === 'GUARD_PUBLISH_FAILED_AFTER_RECORD' && alarm.point === point);
  assert.ok(found, `alarme do ponto ${point}: ${show(kindsOf(alarms))}`);
  assert.deepEqual(found, { kind: 'GUARD_PUBLISH_FAILED_AFTER_RECORD', point, cause: 'UNAVAILABLE', ledgerSeq });
}
/** (iv): a operação nova seguinte (uma decisão de outro operador) recusa com LEDGER_GUARD_UNAVAILABLE e não grava nada. */
async function assertNextOperationRefused(r: Rig, over: LedgerServiceOver = {}): Promise<void> {
  const before = await ledgerEvents(r.w);
  const svc = decisions(r, over);
  const head = (await must(svc.list(BIA, r.w.auditId, clock()))).head;
  const next = await svc.create(BIA, r.w.auditId, { record: rec.naModel(), expectedHead: head }, clock());
  assert.ok(!next.ok && next.code === 'LEDGER_GUARD_UNAVAILABLE', `operação nova: ${show(next)}`);
  assert.deepEqual(await ledgerEvents(r.w), before, 'a operação nova não gravou nada');
}

/** Decisão com o recibo falhando NÃO; com a ENTRADA falhando (fase A): GENESIS + INTENT, nada nas decisões. */
const failingEntry = { ...nodeFsOps, async link(from: string, to: string) { if (to.endsWith('d0001.json')) throw Object.assign(new Error('falha simulada'), { code: 'ENOSPC' }); return nodeFsOps.link(from, to); } };

/* ------------------------------------------------------------------ S1–S9 */

test('PG-G03 S1 (closeRun, RUN_CONFIRMED): publicação falha depois do fecho do resultado ⇒ sucesso, vista BEHIND, alarme S1; a operação nova seguinte recusa', async () => {
  const r = await rig();
  const e = resultsEnv();
  await must(decisions(r).create(ANA, r.w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  r.g.down(5); // a obrigatória do runIntent publica a cabeça 3; o RUN_CONFIRMED (5) não chega à guarda
  const done = await finalizeAs(finalizerOver(r.w, e, { ledger: r.over }), OP_A, r.w.auditId);
  assert.ok(done.ok, show(done));
  assert.ok(!saysNothingRecorded(done));
  assert.deepEqual((await ledgerEvents(r.w)).slice(-2), ['RUN_INTENT', 'RUN_CONFIRMED']);
  assert.equal(publishedRunFiles(e).length, 2, 'resultado e recibo publicados');
  const view = await freshViewWithResults(r.w, e);
  assert.deepEqual([view.state, view.externalGuard], ['PROTECTED', 'BEHIND']);
  assertPointAlarm(r.alarms, 'S1', 5);
  await assertNextOperationRefused(r);
});
async function freshViewWithResults(w: LedgerWorld, e: ResultsEnv) {
  return (await must(servicesOver(w, e, { ledger: ledgerFor(w, { guard: w.guard }) }).list(BIA, w.auditId, clock()))).ledger;
}

test('PG-G03 S2 (abortStaleRun, RUN_ABORTED da fase A vencida pela finalização): publicação falha ⇒ alarme S2 no ponto; a obrigatória do runIntent recusa com LEDGER_GUARD_UNAVAILABLE e o RUN_ABORTED continua gravado', async () => {
  const r = await rig();
  const e = resultsEnv();
  await must(decisions(r).create(ANA, r.w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  await appendLedger(r.w, LEDGER_AUTH_A, runIntentMaker()); // RUN_INTENT aberto e vencido de outro dono (4)
  r.g.down(5);
  const done = await finalizeAs(finalizerOver(r.w, e, { ledger: { ...r.over, ...AGED_OTHERS } }), OP_B, r.w.auditId);
  assert.ok(!done.ok && done.code === 'LEDGER_GUARD_UNAVAILABLE', show(done));
  assert.ok(!saysNothingRecorded(done));
  assert.deepEqual((await ledgerEvents(r.w)).slice(-2), ['RUN_INTENT', 'RUN_ABORTED'], 'o RUN_ABORTED ficou; nenhum RUN_INTENT novo');
  assert.deepEqual(publishedRunFiles(e), [], 'nada publicado em resultados');
  assertPointAlarm(r.alarms, 'S2', 5);
  assert.ok(r.alarms.some((alarm) => alarm.kind === 'GUARD_UNAVAILABLE' && alarm.call === 'PUBLISH'), show(r.alarms));
  const view = await freshViewWithResults(r.w, e);
  assert.deepEqual([view.state, view.externalGuard], ['PROTECTED', 'BEHIND']);
  await assertNextOperationRefused(r);
});

/** Fase C legítima: o CONFIRMED (3) nunca chegou à guarda e se perdeu do livro (queda entre o recibo e o CONFIRMED). Livro: GENESIS, INTENT; guarda: 1. */
async function phaseCRig(): Promise<Rig> {
  const r = await rig();
  r.g.down(3);
  await must(decisions(r).create(ANA, r.w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  fs.unlinkSync(path.join(r.w.ledgerDir, r.w.auditId, 'l000003.json'));
  r.alarms.length = 0;
  assert.deepEqual(await ledgerEvents(r.w), ['GENESIS', 'INTENT']);
  return r;
}

test('PG-G03 S3 (prepare, CONFIRMED da fase C): terminando num RECOVER ⇒ sucesso, vista BEHIND e alarme S3; seguindo para operação nova ⇒ a obrigatória recusa com LEDGER_GUARD_UNAVAILABLE, o CONFIRMED fica e o alarme sai no ponto', async () => {
  const a = await phaseCRig();
  const recovered = await decisions(a).ledgerAction(ANA, a.w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(recovered.ok, show(recovered));
  assert.ok(!saysNothingRecorded(recovered));
  assert.deepEqual(await ledgerEvents(a.w), ['GENESIS', 'INTENT', 'CONFIRMED']);
  const view = await freshView(a.w);
  assert.deepEqual([view.state, view.externalGuard], ['PROTECTED', 'BEHIND']);
  assertPointAlarm(a.alarms, 'S3', 3);
  await assertNextOperationRefused(a);

  const b = await phaseCRig();
  const svc = decisions(b);
  const head = (await must(svc.list(ANA, b.w.auditId, clock()))).head;
  const next = await svc.create(ANA, b.w.auditId, { record: rec.c3(), expectedHead: head }, clock());
  assert.ok(!next.ok && next.code === 'LEDGER_GUARD_UNAVAILABLE', show(next));
  assert.ok(!saysNothingRecorded(next));
  assert.deepEqual(await ledgerEvents(b.w), ['GENESIS', 'INTENT', 'CONFIRMED'], 'a fase C foi concluída; a operação nova não começou');
  assertPointAlarm(b.alarms, 'S3', 3);
  await assertNextOperationRefused(b);
});

/** Fase A: INTENT gravada e a entrada falhou. Livro: GENESIS, INTENT; guarda: 1 (a obrigatória publicou o GENESIS). */
async function phaseARig(): Promise<Rig> {
  const r = await rig({ decisionsFs: failingEntry });
  assert.ok(!(await r.w.rawProtected.create(ANA, r.w.auditId, { record: rec.c2(), expectedHead: null }, clock())).ok);
  assert.deepEqual(await ledgerEvents(r.w), ['GENESIS', 'INTENT']);
  r.g.down(2);
  return r;
}

test('PG-G03 S4 (prepare, ABORTED da fase A vencida): terminando num RECOVER ⇒ sucesso, vista BEHIND e alarme S4; seguindo para operação nova ⇒ a obrigatória recusa com LEDGER_GUARD_UNAVAILABLE, o ABORTED fica e o alarme sai no ponto', async () => {
  const a = await phaseARig();
  const recovered = await decisions(a, { staleOperationMs: 1 }).ledgerAction(BIA, a.w.auditId, { action: 'RECOVER' }, () => FAR);
  assert.ok(recovered.ok, show(recovered));
  assert.ok(!saysNothingRecorded(recovered));
  assert.deepEqual(await ledgerEvents(a.w), ['GENESIS', 'INTENT', 'ABORTED']);
  const view = await freshView(a.w);
  assert.deepEqual([view.state, view.externalGuard], ['PROTECTED', 'BEHIND']);
  assertPointAlarm(a.alarms, 'S4', 3);
  await assertNextOperationRefused(a);

  const b = await phaseARig();
  const svc = decisions(b, { staleOperationMs: 1 });
  const head = (await must(svc.list(BIA, b.w.auditId, () => FAR))).head;
  const next = await svc.create(BIA, b.w.auditId, { record: rec.c3(), expectedHead: head }, () => FAR);
  assert.ok(!next.ok && next.code === 'LEDGER_GUARD_UNAVAILABLE', show(next));
  assert.ok(!saysNothingRecorded(next));
  assert.deepEqual(await ledgerEvents(b.w), ['GENESIS', 'INTENT', 'ABORTED']);
  assertPointAlarm(b.alarms, 'S4', 3);
  await assertNextOperationRefused(b);
});

test('PG-G03 S5 (prepare, RUN_ABORTED do RECOVER): a manutenção termina num RECOVER ⇒ sucesso, vista BEHIND e alarme S5; a operação nova seguinte recusa', async () => {
  const r = await rig();
  const e = resultsEnv();
  await must(decisions(r).create(ANA, r.w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  await appendLedger(r.w, LEDGER_AUTH_A, runIntentMaker());
  r.g.down(5);
  const recovered = await servicesOver(r.w, e, { ledger: ledgerFor(r.w, r.over) }).ledgerAction(BIA, r.w.auditId, { action: 'RECOVER' }, () => FAR);
  assert.ok(recovered.ok, show(recovered));
  assert.ok(!saysNothingRecorded(recovered));
  assert.deepEqual((await ledgerEvents(r.w)).slice(-2), ['RUN_INTENT', 'RUN_ABORTED']);
  const view = await freshViewWithResults(r.w, e);
  assert.deepEqual([view.state, view.externalGuard], ['PROTECTED', 'BEHIND']);
  assertPointAlarm(r.alarms, 'S5', 5);
  await assertNextOperationRefused(r);
});

test('PG-G03 S6 (prepare, CHECKPOINT da rotação no RECOVER): com a guarda em dia o CHECKPOINT entra; a publicação dele falha ⇒ sucesso, vista BEHIND e alarme S6; a operação nova seguinte recusa', async () => {
  const r = await rig();
  await must(decisions(r).create(ANA, r.w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  r.g.down(4);
  const recovered = await decisions(r, { auth: rotatedOnce() }).ledgerAction(ANA, r.w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(recovered.ok, show(recovered));
  assert.ok(!saysNothingRecorded(recovered));
  assert.equal(recovered.ok && recovered.value.ledger.keyCoverage?.covered, true);
  assert.deepEqual(await ledgerEvents(r.w), ['GENESIS', 'INTENT', 'CONFIRMED', 'CHECKPOINT']);
  const view = await freshView(r.w, { auth: rotatedOnce() });
  assert.deepEqual([view.state, view.externalGuard], ['PROTECTED', 'BEHIND']);
  assertPointAlarm(r.alarms, 'S6', 4);
  await assertNextOperationRefused(r, { auth: rotatedOnce() });
});

test('PG-G03 S7 (reissue, RECEIPT_REISSUED): publicação falha depois da reemissão do recibo ⇒ sucesso (o recibo existe de novo), vista BEHIND e alarme S7; a operação nova seguinte recusa', async () => {
  const r = await rig();
  await must(decisions(r).create(ANA, r.w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  fs.rmSync(anchorPath(r.w, 1));
  r.g.down(4);
  const svc = decisions(r);
  const removed = await must(svc.list(ANA, r.w.auditId, clock()));
  assert.equal(removed.ledger.reason, 'RECEIPT_REMOVED');
  const resent = await svc.create(ANA, r.w.auditId, { record: rec.c2(), expectedHead: removed.head }, clock());
  assert.ok(resent.ok, show(resent));
  assert.ok(!saysNothingRecorded(resent));
  assert.ok(fs.existsSync(anchorPath(r.w, 1)));
  assert.deepEqual(await ledgerEvents(r.w), ['GENESIS', 'INTENT', 'CONFIRMED', 'RECEIPT_REISSUED']);
  const view = await freshView(r.w);
  assert.deepEqual([view.state, view.externalGuard], ['PROTECTED', 'BEHIND']);
  assertPointAlarm(r.alarms, 'S7', 4);
  await assertNextOperationRefused(r);
});

test('PG-G03 S8 (confirmed, CONFIRMED da decisão): publicação falha depois do fecho ⇒ sucesso (a decisão vale), vista BEHIND e alarme S8; a operação nova recusa até a guarda voltar, e então conclui', async () => {
  const r = await rig();
  r.g.down(3);
  const done = await decisions(r).create(ANA, r.w.auditId, { record: rec.c2(), expectedHead: null }, clock());
  assert.ok(done.ok, show(done));
  assert.ok(!saysNothingRecorded(done));
  assert.deepEqual(await ledgerEvents(r.w), ['GENESIS', 'INTENT', 'CONFIRMED']);
  const listed = await must(decisionsOver(r.w, { ledger: ledgerFor(r.w, { guard: r.w.guard }), knownHeads: NO_RESULTS }).list(BIA, r.w.auditId, clock()));
  assert.deepEqual([listed.ledger.state, listed.ledger.externalGuard, listed.decisions.length, listed.finalizable], ['PROTECTED', 'BEHIND', 1, true]);
  assertPointAlarm(r.alarms, 'S8', 3);
  await assertNextOperationRefused(r);
  r.g.heal();
  await must(decisions(r).create(BIA, r.w.auditId, { record: rec.c3(), expectedHead: listed.head }, clock()));
  assert.equal((await freshView(r.w)).externalGuard, 'CONSISTENT');
});

test('PG-G03 S9 (runGate, RUN_ABORTED do próprio dono depois do prazo): publicação falha ⇒ a resposta continua RUN_DEADLINE (RESULT_WRITE_CONFLICT), vista BEHIND e alarme S9; a operação nova seguinte recusa', async () => {
  const r = await rig();
  const e = resultsEnv();
  await must(decisions(r).create(ANA, r.w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  r.g.down(5);
  const STALE = 1_000;
  let now = 10_000;
  const f = finalizerOver(r.w, e, { ledger: { ...r.over, staleOperationMs: STALE, monotonicMs: () => now, fs: afterLink('l000004.json', () => void (now += STALE / 2 + 1)) } });
  const done = await finalizeAs(f, OP_A, r.w.auditId);
  assert.ok(!done.ok && done.code === 'RESULT_WRITE_CONFLICT', show(done));
  assert.ok(!saysNothingRecorded(done));
  assert.deepEqual((await ledgerEvents(r.w)).slice(-2), ['RUN_INTENT', 'RUN_ABORTED']);
  assert.equal((await ledgerRecords(r.w)).at(-1)?.actor, 'ana@empresa.com', 'o próprio dono abortou');
  assert.deepEqual(publishedRunFiles(e), []);
  const view = await freshViewWithResults(r.w, e);
  assert.deepEqual([view.state, view.externalGuard], ['PROTECTED', 'BEHIND']);
  assertPointAlarm(r.alarms, 'S9', 5);
  await assertNextOperationRefused(r);
});
