import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  boundGuard,
  createSyntheticGuard,
  evaluateProtection,
  GUARD_BEHIND_ALARM_MS,
  GUARD_MAX_LAG,
  GUARD_RESPONSE_TIMEOUT_MS,
  type DecisionRef,
  type ExternalGuardPort,
  type LedgerRecord,
  type ProtectionInput,
} from '../src/lib/link-audit-ledger';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, anchorPath, clock, must, rec, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { alarmLog, beforeLedgerLink, controlledGuard, EXPIRED_TIMER, kindsOf, manualTimer, rotatedOnce, rotatedTwice, saysNothingRecorded, type ControlledGuard } from './helpers/link-audit-guard-fixtures';
import { decisionsOver, LEDGER_AUTH_A, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, NO_RESULTS, refOf, syntheticLedger, T0, type LedgerServiceOver, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { appendLedger, runClosingMaker, runIntentMaker } from './helpers/link-audit-results-ledger-fixtures';

/*
 * G1.b.1 — CONTRATO DA GUARDA EXTERNA independente de provedor (spec `link-audit-production-gates.md` §5.1.4, regras 2, 3, 5 e 7; §5.1.7; PG-G01, PG-G02, PG-G05 sintético
 * e PG-G06). Só o adaptador SINTÉTICO e guardas simuladas: nenhuma rede, nenhum provedor real. O `L_max` (5) é o da contagem da G0; o teste que enumera os fluxos o trava.
 */
registerCleanup();
const H = (c: string): string => c.repeat(64);
const AUD_G = 'auditoria-guarda-07';

const serviceOver = (w: LedgerWorld, over: LedgerServiceOver = {}) => decisionsOver(w, { ledger: ledgerFor(w, over), knownHeads: NO_RESULTS });
/** Leitor "fresco" com a guarda sintética do mundo (o que outro processo veria). */
const viewOf = async (w: LedgerWorld, over: LedgerServiceOver = {}) => (await must(serviceOver(w, { guard: w.guard, ...over }).list(BIA, w.auditId, clock()))).ledger;
const lagOf = async (w: LedgerWorld): Promise<number> => {
  const latest = await w.guard.latest(w.auditId);
  if (!latest.ok) throw new Error('guarda sintética ilegível');
  return (await ledgerRecords(w)).length - (latest.head?.ledgerSeq ?? 0);
};

/* ============================================================================ PG-G05 — regra 7 no adaptador sintético */

test('PG-G05 (adaptador sintético, regra 7): mesmo trio ⇒ aceito sem registro novo, também abaixo do maior; mesmo ledgerSeq com outro sha256 ⇒ CONFLICT; ledgerSeq novo menor que o maior ⇒ STALE; maior ⇒ gravado; latest devolve o maior', async () => {
  const dir = tmpDir('lad-g7-');
  const guard = createSyntheticGuard({ dir });
  const files = (): string[] => fs.readdirSync(path.join(dir, AUD_G)).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(await guard.publish({ auditId: AUD_G, ledgerSeq: 1, sha256: H('a') }), { ok: true });
  assert.deepEqual(await guard.publish({ auditId: AUD_G, ledgerSeq: 3, sha256: H('c') }), { ok: true }, 'maior que o maior ⇒ gravado');
  assert.deepEqual(await guard.publish({ auditId: AUD_G, ledgerSeq: 1, sha256: H('a') }), { ok: true }, 'mesmo trio abaixo do maior ⇒ aceito (idempotente)');
  assert.deepEqual(await guard.publish({ auditId: AUD_G, ledgerSeq: 3, sha256: H('c') }), { ok: true }, 'mesmo trio na posição do maior ⇒ aceito');
  assert.equal(files().length, 2, 'nenhum registro novo pela republicação');
  assert.deepEqual(await guard.publish({ auditId: AUD_G, ledgerSeq: 3, sha256: H('d') }), { ok: false, reason: 'CONFLICT' });
  assert.deepEqual(await guard.publish({ auditId: AUD_G, ledgerSeq: 1, sha256: H('b') }), { ok: false, reason: 'CONFLICT' }, 'conflito também abaixo do maior');
  assert.deepEqual(await guard.publish({ auditId: AUD_G, ledgerSeq: 2, sha256: H('b') }), { ok: false, reason: 'STALE' }, 'posição nova abaixo do maior ⇒ atrasada');
  assert.equal(files().length, 2, 'recusas não gravam');
  assert.deepEqual(await guard.latest(AUD_G), { ok: true, head: { ledgerSeq: 3, sha256: H('c') } });
  assert.deepEqual(await guard.publish({ auditId: AUD_G, ledgerSeq: 4, sha256: H('e') }), { ok: true });
  assert.deepEqual(await guard.latest(AUD_G), { ok: true, head: { ledgerSeq: 4, sha256: H('e') } });
  // entrada inválida ou pasta da guarda ausente ⇒ indisponível (nunca "aceito", nunca "nenhuma cabeça")
  for (const bad of [{ auditId: '../fora', ledgerSeq: 5, sha256: H('f') }, { auditId: AUD_G, ledgerSeq: 0, sha256: H('f') }, { auditId: AUD_G, ledgerSeq: 1.5, sha256: H('f') }, { auditId: AUD_G, ledgerSeq: 5, sha256: 'curto' }]) {
    assert.deepEqual(await guard.publish(bad), { ok: false, reason: 'UNAVAILABLE' }, JSON.stringify(bad));
  }
  const missing = createSyntheticGuard({ dir: path.join(dir, 'nao-existe') });
  assert.deepEqual(await missing.publish({ auditId: AUD_G, ledgerSeq: 1, sha256: H('a') }), { ok: false, reason: 'UNAVAILABLE' });
  assert.deepEqual(await missing.latest(AUD_G), { ok: false });
});

test('PG-G05 (regra 7): publicações concorrentes no mesmo processo são serializadas por auditoria — nunca duas posições gravadas fora de ordem nem um conflito aceito', async () => {
  const dir = tmpDir('lad-g7c-');
  const guard = createSyntheticGuard({ dir });
  const outcomes = await Promise.all([guard.publish({ auditId: AUD_G, ledgerSeq: 2, sha256: H('b') }), guard.publish({ auditId: AUD_G, ledgerSeq: 2, sha256: H('c') }), guard.publish({ auditId: AUD_G, ledgerSeq: 1, sha256: H('a') })]);
  assert.deepEqual(outcomes, [{ ok: true }, { ok: false, reason: 'CONFLICT' }, { ok: false, reason: 'STALE' }]);
  assert.deepEqual(await guard.latest(AUD_G), { ok: true, head: { ledgerSeq: 2, sha256: H('b') } });
});

/* ============================================================================ PG-G06 / PG-G05 — prazo de 3 s, erro e resposta fora do esquema */

test('PG-G06 (porta): prazo de resposta de 3 s POR CHAMADA (D-G0-3), com timer injetável; esgotado, erro ou resposta fora do esquema ⇒ indisponível — latest nunca vira "nenhuma cabeça", publish vira UNAVAILABLE', async () => {
  assert.equal(GUARD_RESPONSE_TIMEOUT_MS, 3_000);
  const timer = manualTimer();
  const hanging: ExternalGuardPort = { latest: () => new Promise(() => undefined), publish: () => new Promise(() => undefined) };
  const bounded = boundGuard(hanging, timer);
  const pendingLatest = bounded.latest(AUD_G);
  const pendingPublish = bounded.publish({ auditId: AUD_G, ledgerSeq: 1, sha256: H('a') });
  assert.deepEqual(timer.asked, [3_000, 3_000], 'um prazo por chamada, de 3 s');
  timer.fire();
  assert.deepEqual(await pendingLatest, { ok: false });
  assert.deepEqual(await pendingPublish, { ok: false, reason: 'UNAVAILABLE' });

  const answering = (latest: unknown, publish: unknown, mode: 'resolve' | 'reject' | 'throw' = 'resolve'): ExternalGuardPort => {
    const act = (value: unknown) => {
      if (mode === 'throw') throw new Error('falha simulada');
      return mode === 'reject' ? Promise.reject(new Error('falha simulada')) : Promise.resolve(value);
    };
    return { latest: () => act(latest) as never, publish: () => act(publish) as never };
  };
  const cases: Array<[string, ExternalGuardPort, unknown, unknown]> = [
    ['rejeita', answering(null, null, 'reject'), { ok: false }, { ok: false, reason: 'UNAVAILABLE' }],
    ['lança', answering(null, null, 'throw'), { ok: false }, { ok: false, reason: 'UNAVAILABLE' }],
    ['sem head', answering({ ok: true }, { ok: false }), { ok: false }, { ok: false, reason: 'UNAVAILABLE' }],
    ['head com ledgerSeq 0', answering({ ok: true, head: { ledgerSeq: 0, sha256: H('a') } }, { ok: false, reason: 'OUTRO' }), { ok: false }, { ok: false, reason: 'UNAVAILABLE' }],
    ['sha256 fora do formato', answering({ ok: true, head: { ledgerSeq: 1, sha256: 'x' } }, 'sim'), { ok: false }, { ok: false, reason: 'UNAVAILABLE' }],
    ['campo a mais', answering({ ok: true, head: null, extra: 1 }, { ok: true, extra: 1 }), { ok: false }, { ok: false, reason: 'UNAVAILABLE' }],
    ['válidas', answering({ ok: true, head: null }, { ok: false, reason: 'STALE' }), { ok: true, head: null }, { ok: false, reason: 'STALE' }],
    ['válidas (cabeça e aceito)', answering({ ok: true, head: { ledgerSeq: 7, sha256: H('b') } }, { ok: true }), { ok: true, head: { ledgerSeq: 7, sha256: H('b') } }, { ok: true }],
  ];
  for (const [label, port, latest, published] of cases) {
    const quick = manualTimer();
    const guard = boundGuard(port, quick);
    assert.deepEqual(await guard.latest(AUD_G), latest, `${label}: latest`);
    assert.deepEqual(await guard.publish({ auditId: AUD_G, ledgerSeq: 1, sha256: H('a') }), published, `${label}: publish`);
    assert.equal(quick.active(), 0, `${label}: o prazo é cancelado quando a resposta chega`);
  }
});

test('PG-G06 (serviço): latest com erro, fora do esquema ou com o prazo esgotado ⇒ HISTORY_UNRESOLVED (GUARD_UNAVAILABLE), nada vigente, escrita recusada e alarme GUARD_UNAVAILABLE', async () => {
  const w = await ledgerWorld({ withGuard: true });
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const ports: Array<[string, ExternalGuardPort, LedgerServiceOver]> = [
    ['erro', { latest: async () => Promise.reject(new Error('falha simulada')), publish: (r) => w.guard.publish(r) }, {}],
    ['fora do esquema', { latest: async () => ({ ok: true }) as never, publish: (r) => w.guard.publish(r) }, {}],
    ['prazo esgotado', { latest: () => new Promise(() => undefined), publish: () => new Promise(() => undefined) }, { guardTimer: EXPIRED_TIMER }],
  ];
  for (const [label, port, over] of ports) {
    const log = alarmLog();
    const svc = serviceOver(w, { guard: port, guardAlarms: log.sink, ...over });
    const view = await must(svc.list(BIA, w.auditId, clock()));
    assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.externalGuard, view.decisions.length, view.finalizable], ['HISTORY_UNRESOLVED', 'GUARD_UNAVAILABLE', 'UNAVAILABLE', 0, false], label);
    const before = await ledgerEvents(w);
    const write = await svc.create(ANA, w.auditId, { record: rec.c3(), expectedHead: view.head }, clock());
    assert.ok(!write.ok, `${label}: escrita recusada`);
    assert.deepEqual(await ledgerEvents(w), before, `${label}: nada gravado`);
    assert.ok(log.alarms.some((alarm) => alarm.kind === 'GUARD_UNAVAILABLE' && alarm.call === 'LATEST'), `${label}: ${JSON.stringify(log.alarms)}`);
  }
});

/* ============================================================================ PG-G01 — regra 2 */

const AUD = 'auditoria-ledger-0001';
const decisionChain = (count: number): DecisionRef[] => {
  const refs: DecisionRef[] = [];
  for (let seq = 1; seq <= count; seq += 1) refs.push(refOf(seq, seq === 1 ? null : (refs[seq - 2] as DecisionRef).sha256, 'dec'));
  return refs;
};
function modelInput(records: readonly LedgerRecord[], refs: readonly DecisionRef[], guard: ProtectionInput['guard'], pendingOpen = false): ProtectionInput {
  return {
    configured: true,
    read: { kind: 'PRESENT', records, tagFailure: null },
    auditId: AUD,
    decisions: { confirmed: pendingOpen ? refs.slice(0, -1) : refs, pending: null },
    entryOriginProven: () => true,
    results: { ok: true, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [] },
    guard,
    ageMsOf: (iso) => T0 + 60_000 - Date.parse(iso),
    staleMs: 120_000,
  };
}
const headAt = (records: readonly LedgerRecord[], seq: number) => ({ ledgerSeq: seq, sha256: (records[seq - 1] as LedgerRecord).contentSha256 });

test('PG-G01 (modelo): guarda lida com head null ⇒ aceito só com o livro em ledgerSeq ≤ 1; com 2 registros (GENESIS + INTENT) ⇒ HISTORY_UNRESOLVED (GUARD_HEAD_MISSING)', () => {
  const one = syntheticLedger(LEDGER_AUTH_A, AUD, []);
  const accepted = evaluateProtection(modelInput(one, [], { status: 'READ', head: null })).view;
  assert.deepEqual([accepted.state, accepted.reason, accepted.externalGuard], ['PROTECTED', null, 'BEHIND']);
  const refs = decisionChain(1);
  const two = syntheticLedger(LEDGER_AUTH_A, AUD, refs, { open: true });
  assert.equal(two.length, 2);
  const missing = evaluateProtection(modelInput(two, refs, { status: 'READ', head: null }, true)).view;
  assert.deepEqual([missing.state, missing.reason, missing.externalGuard, missing.runs], ['HISTORY_UNRESOLVED', 'GUARD_HEAD_MISSING', 'BEHIND', undefined]);
  // a mesma auditoria com a cabeça publicada continua protegida
  const published = evaluateProtection(modelInput(two, refs, { status: 'READ', head: headAt(two, 1) }, true)).view;
  assert.deepEqual([published.state, published.externalGuard], ['PROTECTED', 'BEHIND']);
});

test('PG-G01 (serviço): livro com 1 registro e nenhuma cabeça na guarda ⇒ PROTECTED/BEHIND; com 3 registros ⇒ GUARD_HEAD_MISSING, nada vigente, escrita recusada e alarme', async () => {
  const w = await ledgerWorld(); // inscrita SEM guarda: o livro tem só o GENESIS
  const empty = createSyntheticGuard({ dir: tmpDir('lad-g0-') });
  const log = alarmLog();
  const svc = serviceOver(w, { guard: empty, guardAlarms: log.sink });
  const first = await must(svc.list(BIA, w.auditId, clock()));
  assert.deepEqual([first.ledger.state, first.ledger.externalGuard], ['PROTECTED', 'BEHIND']);
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock())); // gravado sem publicar (o livro sem guarda)
  const view = await must(svc.list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.externalGuard, view.decisions.length, view.finalizable], ['HISTORY_UNRESOLVED', 'GUARD_HEAD_MISSING', 'BEHIND', 0, false]);
  const write = await svc.create(ANA, w.auditId, { record: rec.c3(), expectedHead: view.head }, clock());
  assert.ok(!write.ok && write.code === 'DECISIONS_HISTORY_UNRESOLVED', JSON.stringify(write).slice(0, 200));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED']);
  assert.ok(kindsOf(log.alarms).includes('GUARD_HEAD_MISSING'), JSON.stringify(log.alarms));
});

/* ============================================================================ PG-G02 — regra 3 (L_max) */

test('PG-G02 (modelo): L_max = 5 (D-G0-4); atraso ≤ 5 ⇒ PROTECTED com BEHIND; atraso 6 ⇒ HISTORY_UNRESOLVED (GUARD_LAGGING); guarda em dia ⇒ CONSISTENT', () => {
  assert.equal(GUARD_MAX_LAG, 5);
  const refs = decisionChain(3);
  const records = syntheticLedger(LEDGER_AUTH_A, AUD, refs); // GENESIS + 3 × (INTENT, CONFIRMED) = 7
  assert.equal(records.length, 7);
  const at = (seq: number) => evaluateProtection(modelInput(records, refs, { status: 'READ', head: headAt(records, seq) })).view;
  assert.deepEqual([at(7).state, at(7).externalGuard], ['PROTECTED', 'CONSISTENT']);
  assert.deepEqual([at(2).state, at(2).reason, at(2).externalGuard], ['PROTECTED', null, 'BEHIND'], 'atraso 5 = L_max ⇒ ainda protegido');
  assert.deepEqual([at(1).state, at(1).reason, at(1).externalGuard, at(1).runs], ['HISTORY_UNRESOLVED', 'GUARD_LAGGING', 'BEHIND', undefined], 'atraso 6 ⇒ congela');
});

test('PG-G02 (modelo, leitura concorrente): atraso medido acima de L_max só porque o livro cresceu entre a leitura da guarda e a do livro NÃO é GUARD_LAGGING — vale a releitura da guarda feita depois do livro; ela nunca esconde um MISMATCH', () => {
  const refs = decisionChain(3);
  const records = syntheticLedger(LEDGER_AUTH_A, AUD, refs);
  const ev = (afterLedger: { ledgerSeq: number; sha256: string } | null) => evaluateProtection(modelInput(records, refs, { status: 'READ', head: headAt(records, 1), afterLedger })).view;
  assert.deepEqual([ev(headAt(records, 6)).state, ev(headAt(records, 6)).externalGuard], ['PROTECTED', 'BEHIND']);
  assert.deepEqual([ev({ ledgerSeq: 9, sha256: H('9') }).state, ev({ ledgerSeq: 9, sha256: H('9') }).externalGuard], ['PROTECTED', 'CONSISTENT'], 'a guarda já cobre além do que foi lido');
  assert.deepEqual([ev({ ledgerSeq: 6, sha256: H('f') }).state, ev({ ledgerSeq: 6, sha256: H('f') }).reason], ['HISTORY_UNRESOLVED', 'GUARD_MISMATCH'], 'releitura com cabeça que o livro não contém');
  assert.deepEqual([ev(null).reason, ev(headAt(records, 1)).reason], ['GUARD_LAGGING', 'GUARD_LAGGING'], 'a releitura não ajudou: continua acima do limite');
  // a cabeça lida ANTES do livro continua decidindo o MISMATCH (a releitura não o apaga)
  const forged = evaluateProtection(modelInput(records, refs, { status: 'READ', head: { ledgerSeq: 9, sha256: H('9') }, afterLedger: headAt(records, 7) })).view;
  assert.deepEqual([forged.reason, forged.externalGuard], ['GUARD_MISMATCH', 'MISMATCH']);
});

test('PG-G02 (serviço, leitura concorrente): a guarda lida ANTES do livro está 6 atrás porque outro processo escreveu e publicou no meio ⇒ o serviço relê a guarda depois do livro e a vista fica PROTECTED (nunca GUARD_LAGGING espúrio); sem a releitura ajudar, congela', async () => {
  const w = await ledgerWorld({ withGuard: true });
  for (const record of [rec.c2(), rec.c3(), rec.naModel()]) await must(w.protectedService.create(ANA, w.auditId, { record }, clock()));
  const records = await ledgerRecords(w);
  assert.equal(records.length, 7);
  const stale = { ledgerSeq: 1, sha256: (records[0] as LedgerRecord).contentSha256 };
  let calls = 0;
  const racing: ExternalGuardPort = { publish: (r) => w.guard.publish(r), latest: async (auditId) => (++calls === 1 ? { ok: true, head: stale } : w.guard.latest(auditId)) };
  const view = (await must(serviceOver(w, { guard: racing }).list(BIA, w.auditId, clock()))).ledger;
  assert.deepEqual([view.state, view.reason, view.externalGuard, calls], ['PROTECTED', null, 'CONSISTENT', 2], 'releu a guarda uma vez, depois do livro');
  const stuck: ExternalGuardPort = { publish: (r) => w.guard.publish(r), latest: async () => ({ ok: true, head: stale }) };
  const frozen = (await must(serviceOver(w, { guard: stuck }).list(BIA, w.auditId, clock()))).ledger;
  assert.deepEqual([frozen.state, frozen.reason], ['HISTORY_UNRESOLVED', 'GUARD_LAGGING']);
});

/**
 * ENUMERAÇÃO dos fluxos do protocolo (PG-G02). Publicações OBRIGATÓRIAS: `prepare` (antes da INTENT e do CHECKPOINT automático), `runIntent` (antes do RUN_INTENT), `ENROLL`
 * (depois do GENESIS) e — G1.b.1 — o `RECOVER` da rotação (antes do CHECKPOINT dele). Com TODAS as de melhor esforço falhando, o pior caso da tabela da §5.1.7 grava exatamente
 * 5 registros depois da última publicação aceita: CHECKPOINT automático + INTENT + fecho do resultado aberto + CONFIRMED + RECEIPT_REISSUED.
 */
test('PG-G02 (fluxos): o pior caso da §5.1.7 (CHECKPOINT automático, INTENT + fecho de decisão, fecho do resultado aberto, reemissão de recibo) com todas as publicações de melhor esforço falhando dá atraso 5 e vista BEHIND; nenhum fluxo legítimo grava o 6º; um registro a mais vira GUARD_LAGGING', async () => {
  const w = await ledgerWorld({ withGuard: true, checkpointEvery: 4 });
  const g = controlledGuard(w.guard);
  const log = alarmLog();
  const svc = (over: LedgerServiceOver = {}) => serviceOver(w, { guard: g.port, guardAlarms: log.sink, checkpointEvery: 4, ...over });
  await must(svc().create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  await appendLedger(w, LEDGER_AUTH_A, runIntentMaker()); // um resultado ABERTO antes da janela (o RUN_INTENT entrou depois de uma publicação obrigatória da cabeça 3)
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT']);
  assert.equal(await lagOf(w), 1);

  g.down(5); // a obrigatória do prepare publica a cabeça 4; daí em diante tudo falha
  // o fecho do resultado aberto cai entre a INTENT e o CONFIRMED (fechos intercalados): o CONFIRMED colide e é regravado na nova cauda
  const interleaved = beforeLedgerLink((record) => record.event === 'CONFIRMED', async () => void (await appendLedger(w, LEDGER_AUTH_A, runClosingMaker('RUN_ABORTED'))));
  await must(svc({ fs: interleaved }).create(ANA, w.auditId, { record: rec.c3(), expectedHead: (await must(svc().list(ANA, w.auditId, clock()))).head }, clock()));
  fs.rmSync(anchorPath(w, 2)); // recibo da decisão nova removido: o autor reenvia e a reemissão fica registrada
  const removed = await must(svc().list(ANA, w.auditId, clock()));
  assert.equal(removed.ledger.reason, 'RECEIPT_REMOVED');
  await must(svc().create(ANA, w.auditId, { record: rec.c3(), expectedHead: removed.head }, clock()));
  const window = ['CHECKPOINT', 'INTENT', 'RUN_ABORTED', 'CONFIRMED', 'RECEIPT_REISSUED'];
  assert.deepEqual((await ledgerEvents(w)).slice(4), window);
  assert.equal(await lagOf(w), GUARD_MAX_LAG, 'atraso = L_max');
  const behind = await viewOf(w, { checkpointEvery: 4 });
  assert.deepEqual([behind.state, behind.reason, behind.externalGuard], ['PROTECTED', null, 'BEHIND']);

  // nenhum caminho legítimo grava o 6º: operação nova (com CHECKPOINT automático devido), RECOVER (com rotação devida) e reenvio da reemissão
  const length = (await ledgerRecords(w)).length;
  const decisionsHead = (await must(svc().list(BIA, w.auditId, clock()))).head;
  const blocked = await svc().create(BIA, w.auditId, { record: rec.naModel(), expectedHead: decisionsHead }, clock());
  assert.ok(!blocked.ok && blocked.code === 'LEDGER_GUARD_UNAVAILABLE', JSON.stringify(blocked).slice(0, 200));
  const rotationRefused = await svc({ auth: rotatedOnce() }).ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(!rotationRefused.ok && rotationRefused.code === 'LEDGER_GUARD_UNAVAILABLE', JSON.stringify(rotationRefused).slice(0, 200));
  fs.rmSync(anchorPath(w, 2)); // o mesmo recibo removido de novo: a reemissão já registrada não grava outro registro (no máximo uma por entrada confirmada)
  const again = await must(svc().list(ANA, w.auditId, clock()));
  assert.equal(again.ledger.reason, 'RECEIPT_REMOVED');
  await must(svc().create(ANA, w.auditId, { record: rec.c3(), expectedHead: again.head }, clock()));
  assert.ok(fs.existsSync(anchorPath(w, 2)));
  assert.equal((await ledgerRecords(w)).length, length, 'nada novo entrou no livro');
  assert.equal(await lagOf(w), GUARD_MAX_LAG);

  // um registro a mais (o CHECKPOINT de uma segunda rotação, que a recusa impede) passa do limite
  await appendLedger(w, LEDGER_AUTH_A, (records) => {
    const tail = records[records.length - 1] as LedgerRecord;
    return { event: 'CHECKPOINT', actor: 'bia@empresa.com', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } };
  });
  assert.equal(await lagOf(w), GUARD_MAX_LAG + 1);
  const lagging = await must(svc().list(BIA, w.auditId, clock()));
  assert.deepEqual([lagging.ledger.state, lagging.ledger.reason, lagging.ledger.externalGuard, lagging.decisions.length, lagging.finalizable], ['HISTORY_UNRESOLVED', 'GUARD_LAGGING', 'BEHIND', 0, false]);
  assert.ok(kindsOf(log.alarms).includes('GUARD_LAGGING'), JSON.stringify(kindsOf(log.alarms)));
});

test('PG-G02 (fluxos): rotações repetidas dentro da mesma janela não acumulam — o CHECKPOINT de rotação (automático ou do RECOVER) só entra depois de uma publicação aceita; a inscrição com a publicação falha continua em 1 registro (regra 2)', async () => {
  // (a) inscrição: GENESIS gravado, publicação falha ⇒ 1 registro, head null, aceito; rotação + escrita + RECOVER com a guarda fora ⇒ nada novo (nunca GUARD_HEAD_MISSING)
  const w = await ledgerWorld({ enroll: false, withGuard: true });
  const g = controlledGuard(w.guard);
  g.down(1);
  const log = alarmLog();
  const svc = (over: LedgerServiceOver = {}) => serviceOver(w, { guard: g.port, guardAlarms: log.sink, ...over });
  const enrolled = await svc().ledgerAction(ANA, w.auditId, { action: 'ENROLL' }, clock());
  assert.ok(!enrolled.ok && enrolled.code === 'LEDGER_GUARD_UNAVAILABLE');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS']);
  for (const auth of [rotatedOnce(), rotatedTwice()]) {
    const write = await svc({ auth }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock());
    assert.ok(!write.ok && write.code === 'LEDGER_GUARD_UNAVAILABLE', JSON.stringify(write).slice(0, 200));
    const recover = await svc({ auth }).ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock());
    assert.ok(!recover.ok && recover.code === 'LEDGER_GUARD_UNAVAILABLE', JSON.stringify(recover).slice(0, 200));
  }
  assert.deepEqual(await ledgerEvents(w), ['GENESIS'], 'nenhum CHECKPOINT de rotação sem publicação aceita');
  const view = await viewOf(w, { auth: rotatedTwice() });
  assert.deepEqual([view.state, view.reason, view.externalGuard], ['PROTECTED', null, 'BEHIND']);

  // (b) com histórico: o atraso de uma decisão (CONFIRMED não publicado) não cresce com duas rotações e tentativas de escrita e manutenção
  const v = await ledgerWorld({ withGuard: true });
  const h = controlledGuard(v.guard);
  const svcV = (over: LedgerServiceOver = {}) => serviceOver(v, { guard: h.port, ...over });
  h.down(3);
  await must(svcV().create(ANA, v.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  assert.equal(await lagOf(v), 2);
  h.down(1);
  for (const auth of [rotatedOnce(), rotatedTwice()]) {
    const head = (await must(svcV({ auth }).list(ANA, v.auditId, clock()))).head;
    assert.ok(!(await svcV({ auth }).create(BIA, v.auditId, { record: rec.c3(), expectedHead: head }, clock())).ok);
    assert.ok(!(await svcV({ auth }).ledgerAction(ANA, v.auditId, { action: 'RECOVER' }, clock())).ok);
  }
  assert.equal(await lagOf(v), 2, 'o atraso não cresceu');
});

/* ============================================================================ recusa do RECOVER de rotação (revisão do PR #53) */

test('RECOVER de rotação com a guarda configurada e externalGuard ≠ CONSISTENT: a cabeça é publicada antes; se não publicar, recusa (LEDGER_GUARD_UNAVAILABLE) sem gravar o CHECKPOINT; com a guarda de volta, grava; sem guarda (NOT_CONFIGURED) segue como antes', async () => {
  const w = await ledgerWorld({ withGuard: true });
  const g = controlledGuard(w.guard);
  const log = alarmLog();
  const svc = (over: LedgerServiceOver = {}) => serviceOver(w, { guard: g.port, guardAlarms: log.sink, auth: rotatedOnce(), ...over });
  g.down(3);
  await must(serviceOver(w, { guard: g.port }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock())); // CONFIRMED não publicado ⇒ BEHIND
  const before = await viewOf(w, { auth: rotatedOnce() });
  assert.deepEqual([before.externalGuard, before.keyCoverage?.covered], ['BEHIND', false]);
  const refused = await svc().ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(!refused.ok && refused.code === 'LEDGER_GUARD_UNAVAILABLE', JSON.stringify(refused).slice(0, 240));
  assert.match(JSON.stringify(refused), /rota[cç][aã]o/i, 'o texto diz que é a rotação que espera a guarda');
  assert.match(JSON.stringify(refused), /runbook/i, 'e orienta o runbook');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED'], 'nenhum CHECKPOINT');
  assert.ok(kindsOf(log.alarms).includes('GUARD_UNAVAILABLE'));
  g.heal();
  const done = await must(svc().ledgerAction(ANA, w.auditId, { action: 'RECOVER' }, clock()));
  assert.equal(done.ledger.keyCoverage?.covered, true);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED', 'CHECKPOINT']);
  const after = await viewOf(w, { auth: rotatedOnce() });
  assert.deepEqual([after.state, after.externalGuard], ['PROTECTED', 'CONSISTENT'], 'a cabeça anterior e o CHECKPOINT foram publicados');

  // sem guarda configurada: o RECOVER da rotação grava o CHECKPOINT como antes (o portão G-1 é quem barra produção sem guarda)
  const plain = await ledgerWorld();
  await must(plain.protectedService.create(ANA, plain.auditId, { record: rec.c2() }, clock()));
  await must(serviceOver(plain, { guard: null, auth: rotatedOnce() }).ledgerAction(ANA, plain.auditId, { action: 'RECOVER' }, clock()));
  assert.deepEqual(await ledgerEvents(plain), ['GENESIS', 'INTENT', 'CONFIRMED', 'CHECKPOINT']);
});

test('RECOVER que já gravou uma receita (S4) e tem a rotação devida com a guarda fora: a resposta é de SUCESSO (regra 4), o ABORTED fica, o CHECKPOINT não entra e a rotação continua descoberta na vista', async () => {
  const w = await ledgerWorld({ withGuard: true, decisionsFs: { ...nodeFsOps, async link(from, to) { if (to.endsWith('d0001.json')) throw Object.assign(new Error('falha simulada'), { code: 'ENOSPC' }); return nodeFsOps.link(from, to); } } });
  assert.ok(!(await w.rawProtected.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock())).ok);
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT']);
  const g = controlledGuard(w.guard);
  g.down(2);
  const log = alarmLog();
  const done = await serviceOver(w, { guard: g.port, guardAlarms: log.sink, auth: rotatedOnce(), staleOperationMs: 1 }).ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => '2026-12-01T00:00:00.000Z');
  assert.ok(done.ok, JSON.stringify(done).slice(0, 240));
  assert.ok(!saysNothingRecorded(done));
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'ABORTED']);
  assert.equal(done.ok && done.value.ledger.keyCoverage?.covered, false);
  assert.ok(kindsOf(log.alarms).includes('GUARD_PUBLISH_FAILED_AFTER_RECORD:S4'), JSON.stringify(kindsOf(log.alarms)));
});

/* ============================================================================ regra 7 no serviço: STALE coberto, STALE não coberto, CONFLICT */

/** Gancho na publicação do CONFIRMED (posição 5) da segunda decisão: "outro processo" age ANTES de ela chegar à guarda. */
async function secondDecisionWith(act: (w: LedgerWorld, record: { auditId: string; ledgerSeq: number; sha256: string }) => Promise<void>) {
  const w = await ledgerWorld({ withGuard: true });
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const g: ControlledGuard = controlledGuard(w.guard);
  g.state.before = async (record) => {
    if (record.ledgerSeq !== 5) return;
    g.state.before = null;
    await act(w, record);
  };
  const log = alarmLog();
  const svc = serviceOver(w, { guard: g.port, guardAlarms: log.sink });
  const done = await svc.create(ANA, w.auditId, { record: rec.c3(), expectedHead: (await must(svc.list(ANA, w.auditId, clock()))).head }, clock());
  return { w, done, log };
}
const checkpointMaker = (records: readonly LedgerRecord[]) => {
  const tail = records[records.length - 1] as LedgerRecord;
  return { event: 'CHECKPOINT', actor: 'bia@empresa.com', checkpoint: { throughSeq: tail.ledgerSeq, throughSha256: tail.contentSha256 } };
};

test('PG-G05 (regra 7, serviço): publicação recusada como STALE e COBERTA (a cabeça maior da guarda está no livro) ⇒ sem alarme e sem atraso; STALE NÃO coberto (sequência falsa acima da real) ⇒ alarme, e a auditoria congela em GUARD_MISMATCH', async () => {
  const covered = await secondDecisionWith(async (w) => {
    const records = await appendLedger(w, LEDGER_AUTH_A, checkpointMaker, checkpointMaker); // outro processo gravou 6 e 7 e publicou 7
    const tail = records[records.length - 1] as LedgerRecord;
    assert.deepEqual(await w.guard.publish({ auditId: w.auditId, ledgerSeq: tail.ledgerSeq, sha256: tail.contentSha256 }), { ok: true });
  });
  assert.ok(covered.done.ok, JSON.stringify(covered.done).slice(0, 200));
  assert.deepEqual(covered.log.alarms, [], 'STALE coberto: nenhum alarme');
  const view = await viewOf(covered.w);
  assert.deepEqual([view.state, view.externalGuard], ['PROTECTED', 'CONSISTENT']);

  const uncovered = await secondDecisionWith(async (w) => {
    assert.deepEqual(await w.guard.publish({ auditId: w.auditId, ledgerSeq: 9, sha256: H('9') }), { ok: true }); // sequência falsa acima da real
  });
  assert.ok(uncovered.done.ok, 'S8: a resposta é final e de sucesso');
  assert.ok(uncovered.log.alarms.some((alarm) => alarm.kind === 'GUARD_PUBLISH_FAILED_AFTER_RECORD' && alarm.point === 'S8' && alarm.cause === 'STALE_UNCOVERED'), JSON.stringify(uncovered.log.alarms));
  const frozen = await viewOf(uncovered.w);
  assert.deepEqual([frozen.state, frozen.reason, frozen.externalGuard], ['HISTORY_UNRESOLVED', 'GUARD_MISMATCH', 'MISMATCH'], 'nunca esconde retrocesso: congela');
});

test('PG-G05 (regra 7, serviço): CONFLICT (outro sha256 na mesma posição) SEMPRE gera alarme — GUARD_CONFLICT e a falha no ponto S8 — e a auditoria congela em GUARD_MISMATCH', async () => {
  const conflict = await secondDecisionWith(async (w, record) => {
    assert.deepEqual(await w.guard.publish({ auditId: w.auditId, ledgerSeq: record.ledgerSeq, sha256: H('e') }), { ok: true });
  });
  assert.ok(conflict.done.ok);
  const kinds = kindsOf(conflict.log.alarms);
  assert.ok(kinds.includes('GUARD_CONFLICT') && kinds.includes('GUARD_PUBLISH_FAILED_AFTER_RECORD:S8'), JSON.stringify(kinds));
  assert.ok(conflict.log.alarms.some((alarm) => alarm.kind === 'GUARD_PUBLISH_FAILED_AFTER_RECORD' && alarm.cause === 'CONFLICT'));
  const view = await viewOf(conflict.w);
  assert.deepEqual([view.state, view.reason], ['HISTORY_UNRESOLVED', 'GUARD_MISMATCH']);
});

/* ============================================================================ GE-E6 (parte pura): alarmes sem PII, idade do BEHIND, porta que falha */

test('GE-E6: os alarmes não carregam auditId, e-mail nem caminho; BEHIND por mais de T = 15 min ⇒ GUARD_BEHIND_PROLONGED (menos que isso, não); uma porta de alarme que lança não muda o desfecho', async () => {
  assert.equal(GUARD_BEHIND_ALARM_MS, 15 * 60_000);
  const w = await ledgerWorld({ withGuard: true });
  const g = controlledGuard(w.guard);
  g.down(3);
  const log = alarmLog();
  const created = await must(serviceOver(w, { guard: g.port, guardAlarms: log.sink }).create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, clock()));
  assert.ok(created);
  const firstUnpublished = (await ledgerRecords(w))[1] as LedgerRecord; // a INTENT (2): a guarda tem o GENESIS
  const at = (ms: number) => () => new Date(Date.parse(firstUnpublished.recordedAt) + ms).toISOString();
  const quiet = alarmLog();
  await must(serviceOver(w, { guard: w.guard, guardAlarms: quiet.sink }).list(BIA, w.auditId, at(GUARD_BEHIND_ALARM_MS - 1_000)));
  assert.deepEqual(kindsOf(quiet.alarms), []);
  const loud = alarmLog();
  await must(serviceOver(w, { guard: w.guard, guardAlarms: loud.sink }).list(BIA, w.auditId, at(GUARD_BEHIND_ALARM_MS + 1_000)));
  assert.deepEqual([...new Set(loud.alarms.map((alarm) => alarm.kind))], ['GUARD_BEHIND_PROLONGED']);
  const text = JSON.stringify([...log.alarms, ...loud.alarms]);
  assert.ok(!text.includes(w.auditId), 'sem auditId em claro');
  assert.ok(!/@|\/|\\/.test(text), `sem e-mail nem caminho: ${text}`);

  const throwing = { emit: () => { throw new Error('logger fora do ar'); } };
  const view = await must(serviceOver(w, { guard: w.guard, guardAlarms: throwing }).list(BIA, w.auditId, at(GUARD_BEHIND_ALARM_MS + 1_000)));
  assert.deepEqual([view.ledger.state, view.ledger.externalGuard], ['PROTECTED', 'BEHIND']);
});
