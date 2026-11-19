import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { LedgerPort, LedgerStep } from '../src/lib/link-audit-decisions';
import { ledgerRefOf, ledgerSnapshotOf, readLog } from '../src/lib/link-audit-decisions/store';
import { deriveCapacityPolicy, type DecisionRef, type ExternalGuardPort, type LedgerRecord } from '../src/lib/link-audit-ledger';
import type { PreviewEvaluator } from '../src/lib/link-audit-scoring-runs/results';
import { RESULTS_MESSAGE } from '../src/lib/link-audit-scoring-runs/results';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { createUnconfiguredLedger, replayLedger } from '../src/lib/link-audit-ledger';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { ANA, anchorPath, BIA, clock, hashTree, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, LEDGER_AUTH_A, ledgerFor, ledgerRecords, ledgerWorld, opOf, refOf, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { servicesOver, witnessOver } from './helpers/link-audit-ledger-results-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { abortedAttemptMakers, appendLedger, checkpointMaker, decisionsHeadOf, hashOf, plantWorld, runIntentMaker } from './helpers/link-audit-results-ledger-fixtures';
import { bodyNow, finalizeAs, finalizerOver, footprintOf, protectedWorld, publishedRunFiles, runsOf, type Finalizer } from './helpers/link-audit-results-ledger-finalize-fixtures';
import { makeService, OP_A, OP_B, resultsEnv, runPath, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R1.3 — A FINALIZAÇÃO GRAVA PELO LIVRO (spec §16.17.3; ADR-0002; porta de escrita D-R1-3). Caminho feliz e as conferências do passo 6: guarda conferida antes do
 * `RUN_INTENT` (RL-25), `RUN_INTENT` com a cabeça de DECISÕES citada, resultado selado, recibo e `RUN_CONFIRMED` gravado pelo AUTOR (RL-04); a finalização não muda a
 * entrada de outra (RL-13) e o resultado cita a cabeça de decisões (RL-14) de ponta a ponta; mudança concorrente de decisão antes do `RUN_INTENT` ⇒ `INPUT_CHANGED`,
 * nada publicado (RL-16, M-R12). Mais a autorização de uso ÚNICO emitida pelo `prepare`/`runPrepare` liberado (revisão da R1.2, `junin-02`).
 * Fase A, prazo do dono e RECOVER: `link-audit-results-ledger-phase-a`; concorrência, quedas e fsync: `-concurrency`, `-crash`, `-durability`.
 */
registerCleanup();

const show = (value: unknown): string => JSON.stringify(value).slice(0, 280);
/** Bem depois de qualquer hora gravada pelos testes: a idade de parede de qualquer `RUN_INTENT` passa do limite. */
const FAR = '2027-03-01T12:00:00.000Z';
const eventsOf = async (w: LedgerWorld): Promise<string[]> => (await ledgerRecords(w)).map((record) => record.event);
const at = (records: readonly LedgerRecord[], seq: number) => ({ ledgerSeq: seq, sha256: (records[seq - 1] as LedgerRecord).contentSha256 });

/** FsOps que anota, em ordem, cada `link()` (publicação) e cada fsync de diretório — dos resultados e do livro. */
function recorder(): { readonly log: string[]; readonly fs: FsOps } {
  const log: string[] = [];
  return {
    log,
    fs: {
      ...nodeFsOps,
      async link(from, to) {
        await nodeFsOps.link(from, to);
        log.push(`link ${to}`);
      },
      async syncDirectory(dir) {
        await nodeFsOps.syncDirectory(dir);
        log.push(`sync ${dir}`);
      },
    },
  };
}

/* ------------------------------------------------------------------ RL-04: caminho feliz */

test('RL-04 (caminho feliz): RUN_INTENT (cabeça de decisões citada, versão 2) ANTES de publicar s0001, recibo, e RUN_CONFIRMED pelo AUTOR DEPOIS do recibo; só então 200', async () => {
  const { w, e } = await protectedWorld();
  const trace = recorder();
  const f = finalizerOver(w, e, { ledger: { fs: trace.fs }, resultsFs: trace.fs });
  const before = await ledgerRecords(w);
  assert.deepEqual(before.map((r) => r.event), ['GENESIS', 'INTENT', 'CONFIRMED']);
  const done = await finalizeAs(f, OP_A, w.auditId);
  assert.ok(done.ok, show(done));
  assert.deepEqual([done.value.replayed, done.value.recoveredPending, done.value.head.seq], [false, false, 1]);

  const records = await ledgerRecords(w);
  assert.deepEqual(records.map((r) => r.event), ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT', 'RUN_CONFIRMED']);
  const [intent, confirmed] = records.slice(-2) as [LedgerRecord, LedgerRecord];
  const { runs } = await runsOf(e, w.auditId);
  const run = runs[0];
  assert.ok(run && run.ledgerHead, 'resultado v2 confirmado');
  assert.deepEqual([intent.schemaVersion, confirmed.schemaVersion], [2, 2], 'versão ⇔ família (D-3): RUN_* = 2');
  assert.deepEqual(intent.run, { runOpId: intent.run?.runOpId, runSeq: 1, prevRunSha256: null, runSha256: run.contentSha256, author: 'ana@empresa.com', citedLedgerHead: run.ledgerHead, decisionsHead: run.decisions.head });
  assert.match(intent.run?.runOpId ?? '', /^[0-9a-f]{32}$/);
  assert.deepEqual(run.ledgerHead, at(before, 3), 'o resultado cita a cabeça de DECISÕES (o CONFIRMED da decisão)');
  assert.deepEqual([intent.actor, confirmed.actor], ['ana@empresa.com', 'ana@empresa.com'], 'o RUN_CONFIRMED é gravado pelo autor (D-R1-1)');
  assert.deepEqual(confirmed.run, { ...intent.run, intentSeq: intent.ledgerSeq, anchorRef: { name: 'a0001.json', headSha256: run.contentSha256 } });

  // ordem de durabilidade: RUN_INTENT → s0001 → a0001 → RUN_CONFIRMED
  const links = trace.log.filter((line) => line.startsWith('link ')).map((line) => line.slice(5));
  const position = (file: string): number => links.indexOf(file);
  const ledgerFile = (seq: number): string => path.join(w.ledgerDir, w.auditId, `l${String(seq).padStart(6, '0')}.json`);
  const order = [ledgerFile(4), runPath(e, 1, w.auditId), path.join(e.anchors, w.auditId, 'a0001.json'), ledgerFile(5)].map(position);
  assert.ok(order.every((index) => index >= 0), `todas as publicações aconteceram: ${show(order)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `ordem RUN_INTENT → resultado → recibo → RUN_CONFIRMED: ${show(order)}`);

  // a vista do livro: confirmado PELO LIVRO, nada aberto, auditoria protegida e as decisões intactas
  const view = await must(f.decisions.list(BIA, w.auditId, clock()));
  assert.equal(view.ledger.state, 'PROTECTED');
  assert.deepEqual(view.ledger.runs?.confirmed, [{ runSeq: 1, runSha256: run.contentSha256 }]);
  assert.equal(view.ledger.runs?.open, null);
  assert.deepEqual(view.ledger.decisionHead, at(before, 3), 'finalizar não move a cabeça de decisões');
  assert.equal(view.finalizable, true);
});

test('RL-04: o reenvio idêntico de um resultado confirmado PELO LIVRO é 200 `replayed` (do autor e de outro operador) e não grava nada', async () => {
  const { w, e } = await protectedWorld();
  const f = finalizerOver(w, e);
  const body = await bodyNow(f, OP_A, w.auditId);
  const first = await f.results.finalize(OP_A, w.auditId, body);
  assert.ok(first.ok, show(first));
  const after = await footprintOf(w, e);
  for (const actor of [OP_A, OP_B]) {
    const again = await finalizerOver(w, e).results.finalize(actor, w.auditId, body);
    assert.ok(again.ok && again.value.replayed, `${actor.email}: ${show(again)}`);
  }
  assert.deepEqual(await footprintOf(w, e), after, 'nenhum RUN_* novo, nenhum resultado, nenhum recibo');
});

test('D-R1-3: sem a porta de escrita (dependência ausente) o comportamento é o de antes — resultado v2 citando a cabeça de decisões, nenhum RUN_* gravado', async () => {
  const { w, e } = await protectedWorld();
  const done = await finalizeAs(finalizerOver(w, e, { port: false }), OP_A, w.auditId);
  assert.ok(done.ok, show(done));
  assert.deepEqual(await eventsOf(w), ['GENESIS', 'INTENT', 'CONFIRMED']);
  assert.equal((await runsOf(e, w.auditId)).runs.length, 1);
});

test('livro NÃO configurado: a porta existe, não autoriza RUN_INTENT e a finalização é recusada pela avaliação (NOT_FINALIZABLE, como antes da R1.3); nada gravado', async () => {
  const { w, e } = await protectedWorld();
  const decisions = decisionsOver(w, { ledger: createUnconfiguredLedger(), knownHeads: witnessOver(w, e) });
  const port = decisions.resultsLedger;
  assert.ok(port, 'há porta: o livro existe na configuração das rotas, só não está configurado');
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: decisions });
  const evaluated = await preview.evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok, show(evaluated));
  const before = await footprintOf(w, e);
  const done = await makeService(e, preview, { ledger: port }).finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string });
  assert.ok(!done.ok && done.code === 'NOT_FINALIZABLE', show(done));
  const ctx = await port.context({ auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.ok(ctx.kind === 'OK' && ctx.view.reason === 'NOT_CONFIGURED', show(ctx));
  const records = await ledgerRecords(w);
  const intent = await port.intent({ session: ctx.session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: { runSeq: 1, prevRunSha256: null, runSha256: hashOf('r'), author: 'ana@empresa.com', citedLedgerHead: at(records, 3), decisionsHead: decisionsHeadOf(records) } });
  assert.ok(intent.kind === 'REFUSED' && intent.refusal.code === 'LEDGER_NOT_CONFIGURED', show(intent));
  assert.deepEqual(await footprintOf(w, e), before);
});

/* ------------------------------------------------------------------ RL-13 / RL-14 de ponta a ponta */

async function inputsOf(f: Finalizer, w: LedgerWorld) {
  const evaluated = await f.preview.evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok, show(evaluated));
  const now = await f.preview.fingerprintNow(OP_A, w.auditId);
  assert.ok(now.ok);
  const list = await must(f.decisions.list(BIA, w.auditId, clock()));
  return {
    head: list.ledger.head,
    decisionHead: list.ledger.decisionHead,
    expectedHead: evaluated.value.payload.finalization.expectedHead,
    expectedInputSha256: evaluated.value.payload.finalization.expectedInputSha256,
    allowed: evaluated.value.payload.finalization.allowed,
    fingerprint: evaluated.value.fingerprint,
    fingerprintNow: now.fingerprint,
    finalizable: list.finalizable,
    state: list.ledger.state,
  };
}

test('RL-13 (ponta a ponta): a finalização PELA PORTA não muda decisionHead, expectedHead, expectedInputSha256, impressão digital nem finalizable; head avança exatamente 2; a barreira com a expectativa de ANTES passa DEPOIS', async () => {
  const { w, e } = await protectedWorld();
  const f = finalizerOver(w, e);
  const before = await inputsOf(f, w);
  assert.deepEqual([before.state, before.allowed, before.finalizable], ['PROTECTED', true, true]);
  const done = await f.results.finalize(OP_A, w.auditId, { expectedHead: before.expectedHead, expectedInputSha256: before.expectedInputSha256 as string });
  assert.ok(done.ok && !done.value.replayed, show(done));
  const after = await inputsOf(f, w);
  assert.deepEqual(after.decisionHead, before.decisionHead, 'decisionHead');
  assert.deepEqual(after.expectedHead, before.expectedHead, 'expectedHead');
  assert.equal(after.expectedInputSha256, before.expectedInputSha256, 'expectedInputSha256');
  assert.equal(after.fingerprint, before.fingerprint, 'impressão digital (avaliação)');
  assert.equal(after.fingerprintNow, before.fingerprintNow, 'impressão digital (releitura)');
  assert.deepEqual([after.finalizable, after.allowed, after.state], [true, true, 'PROTECTED']);
  assert.equal(after.head?.ledgerSeq, (before.head?.ledgerSeq ?? 0) + 2, 'a cauda avançou exatamente 2 (RUN_INTENT + RUN_CONFIRMED)');
  const barrier = await f.preview.durabilityBarrier(OP_A, w.auditId, { decisionsHead: before.expectedHead, ledgerHead: before.decisionHead });
  assert.deepEqual(barrier, { ok: true }, 'a expectativa capturada antes da finalização continua valendo');
});

test('RL-14 (ponta a ponta): para k = 1, 2, 3, intercalando decisões, tentativa abortada e CHECKPOINT, s000k.ledgerHead === decisionHead === RUN_INTENT(k).citedLedgerHead, nunca uma posição RUN_*', async () => {
  const { w, e } = await protectedWorld();
  const rounds: Array<{ label: string; before: () => Promise<void> }> = [
    { label: 'k=1 (cauda = CONFIRMED da decisão)', before: async () => undefined },
    {
      label: 'k=2 (decisão nova e depois uma tentativa abortada: a cauda é RUN_ABORTED)',
      before: async () => {
        await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
        await appendLedger(w, LEDGER_AUTH_A, ...abortedAttemptMakers());
      },
    },
    {
      label: 'k=3 (revogação, CHECKPOINT e outra tentativa abortada: a cabeça de decisões é o CHECKPOINT)',
      before: async () => {
        await must(w.protectedService.revoke(ANA, w.auditId, { revokes: 'op-0002', reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.' }, clock()));
        await appendLedger(w, LEDGER_AUTH_A, checkpointMaker, ...abortedAttemptMakers());
      },
    },
  ];
  for (const [index, round] of rounds.entries()) {
    const k = index + 1;
    await round.before();
    const f = finalizerOver(w, e);
    const view = await must(f.decisions.list(BIA, w.auditId, clock()));
    assert.equal(view.ledger.state, 'PROTECTED', round.label);
    if (k > 1) assert.notDeepEqual(view.ledger.head, view.ledger.decisionHead, `${round.label}: a cauda é RUN_* (o caso que distingue as duas cabeças)`);
    const done = await finalizeAs(f, OP_A, w.auditId);
    assert.ok(done.ok && done.value.head.seq === k, `${round.label}: ${show(done)}`);
    const records = await ledgerRecords(w);
    const run = (await runsOf(e, w.auditId)).runs[k - 1];
    const intent = records.filter((r) => r.event === 'RUN_INTENT').at(-1) as LedgerRecord;
    assert.deepEqual(run?.ledgerHead, view.ledger.decisionHead, `${round.label}: o resultado cita a cabeça de decisões`);
    assert.deepEqual(intent.run?.citedLedgerHead, run?.ledgerHead, `${round.label}: RUN_INTENT(k).citedLedgerHead = ledgerHead do resultado`);
    assert.equal(intent.run?.runSeq, k);
    assert.equal(records[(run?.ledgerHead?.ledgerSeq ?? 0) - 1]?.event.startsWith('RUN_'), false, `${round.label}: a posição citada não é RUN_*`);
    assert.equal(records.at(-1)?.event, 'RUN_CONFIRMED');
  }
  const final = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.equal(final.ledger.state, 'PROTECTED');
  assert.equal(final.ledger.runs?.confirmed.length, 3);
});

/* ------------------------------------------------------------------ RL-16 (completo) */

/** Avaliador que faz a corrida ENTRE a barreira (que passa) e o passo 6: nada que a barreira leu está errado; a mudança chega depois dela. */
const racingAfterBarrier = (race: () => Promise<void>) => (preview: Finalizer['preview']): PreviewEvaluator => ({
  evaluate: (actor, auditId) => preview.evaluate(actor, auditId),
  fingerprintNow: (actor, auditId) => preview.fingerprintNow(actor, auditId),
  durabilityBarrier: async (actor, auditId, expected) => {
    const outcome = await preview.durabilityBarrier(actor, auditId, expected);
    if (outcome.ok) await race();
    return outcome;
  },
});

test('RL-16 / M-R12: decisão concorrente ENTRE a barreira e o RUN_INTENT — INTENT de decisão aberto, CHECKPOINT (D-6) ou decisão completa — ⇒ INPUT_CHANGED, nada publicado em resultados, nenhum RUN_*; estado final PROTECTED', async () => {
  const cases: Array<[string, (w: LedgerWorld) => Promise<void>, string[]]> = [
    [
      'INTENT de decisão aberto (passo 6 (c))',
      async (w) => {
        const records = await ledgerRecords(w);
        const head = decisionsHeadOf(records);
        await appendLedger(w, LEDGER_AUTH_A, () => ({ event: 'INTENT', actor: 'bia@empresa.com', op: opOf(refOf(2, head?.sha256 ?? null, 'concorrente', { author: 'bia@empresa.com' }), 'c'.repeat(32)) }));
      },
      ['GENESIS', 'INTENT', 'CONFIRMED', 'INTENT'],
    ],
    ['CHECKPOINT (passo 6 (d): a cabeça de decisões andou)', async (w) => void (await appendLedger(w, LEDGER_AUTH_A, checkpointMaker)), ['GENESIS', 'INTENT', 'CONFIRMED', 'CHECKPOINT']],
    ['decisão completa (passo 6 (d) e I-4)', async (w) => void (await must(w.protectedService.create(BIA, w.auditId, { record: rec.naModel() }, clock()))), ['GENESIS', 'INTENT', 'CONFIRMED', 'INTENT', 'CONFIRMED']],
  ];
  for (const [label, race, events] of cases) {
    const { w, e } = await protectedWorld();
    const f = finalizerOver(w, e, { evaluator: racingAfterBarrier(() => race(w)) });
    const done = await finalizeAs(f, OP_A, w.auditId);
    assert.ok(!done.ok && done.code === 'INPUT_CHANGED', `${label}: ${show(done)}`);
    assert.deepEqual(await eventsOf(w), events, `${label}: nenhum RUN_* gravado`);
    assert.deepEqual(publishedRunFiles(e), [], `${label}: nada publicado em resultados nem em recibos`);
    const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
    assert.equal(view.ledger.state, 'PROTECTED', label);
    assert.equal(view.ledger.runs?.open, null, `${label}: nenhuma operação de resultado aberta`);
  }
});

test('RL-16: a decisão NUNCA espera por operação de resultado — com RUN_INTENT aberto (fase A recente) uma decisão é gravada na hora; estado final PROTECTED', async () => {
  const { w, e } = await protectedWorld();
  await appendLedger(w, LEDGER_AUTH_A, runIntentMaker());
  const before = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.equal(before.ledger.runs?.open?.phase, 'A');
  assert.equal(before.ledger.runs?.open?.stale, false);
  const started = Date.now();
  await must(w.protectedService.create(BIA, w.auditId, { record: rec.naModel() }, clock()));
  assert.ok(Date.now() - started < 5_000, 'sem esperar pela operação de resultado');
  assert.deepEqual(await eventsOf(w), ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT', 'INTENT', 'CONFIRMED']);
  const after = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.equal(after.ledger.state, 'PROTECTED');
  assert.equal(after.ledger.runs?.open?.phase, 'A', 'a operação de resultado continua intacta');
});

/* ------------------------------------------------------------------ RL-25: guarda sintética */

test('RL-25: com guarda configurada a cabeça atual é publicada ANTES do RUN_INTENT e a nova cabeça (RUN_CONFIRMED) depois; guarda que não aceita publicação ⇒ LEDGER_GUARD_UNAVAILABLE antes do RUN_INTENT, nada gravado', async () => {
  const { w, e } = await protectedWorld({ withGuard: true });
  const published: number[] = [];
  const watching: ExternalGuardPort = {
    latest: (auditId) => w.guard.latest(auditId),
    publish: async (record) => {
      published.push(record.ledgerSeq);
      return w.guard.publish(record);
    },
  };
  const done = await finalizeAs(finalizerOver(w, e, { ledger: { guard: watching } }), OP_A, w.auditId);
  assert.ok(done.ok, show(done));
  const records = await ledgerRecords(w);
  assert.ok(published.includes(3), `a cabeça anterior (CONFIRMED da decisão, 3) publicada antes do RUN_INTENT: ${show(published)}`);
  assert.ok(published.indexOf(3) < published.indexOf(5), 'antes do RUN_CONFIRMED');
  const latest = await w.guard.latest(w.auditId);
  assert.ok(latest.ok && latest.head?.ledgerSeq === 5 && latest.head.sha256 === records[4]?.contentSha256, `a guarda guarda o RUN_CONFIRMED: ${show(latest)}`);

  const { w: w2, e: e2 } = await protectedWorld({ withGuard: true });
  const refusing: ExternalGuardPort = { latest: (auditId) => w2.guard.latest(auditId), publish: async () => ({ ok: false }) };
  const before = await footprintOf(w2, e2);
  const refused = await finalizeAs(finalizerOver(w2, e2, { ledger: { guard: refusing } }), OP_A, w2.auditId);
  assert.ok(!refused.ok && refused.code === 'LEDGER_GUARD_UNAVAILABLE', show(refused));
  assert.deepEqual((await footprintOf(w2, e2)).events, before.events, 'nenhum RUN_INTENT');
  assert.deepEqual(publishedRunFiles(e2), [], 'nada publicado em resultados');
});

/* ------------------------------------------------------------------ fail-closed: leitura do objeto × livro, fases B/C, capacidade */

test('passo 1b (falha fechada): resultado anterior à R1.3 numa auditoria inscrita (s0001 + a0001 sem RUN_*) ⇒ RESULT_INTEGRITY e nada gravado no livro nem em resultados', async () => {
  const { w, e } = await protectedWorld();
  const old = await finalizeAs(finalizerOver(w, e, { port: false }), OP_A, w.auditId);
  assert.ok(old.ok, show(old));
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
  const before = await footprintOf(w, e);
  const done = await finalizeAs(finalizerOver(w, e), OP_A, w.auditId);
  assert.ok(!done.ok && done.code === 'RESULT_INTEGRITY', show(done));
  assert.deepEqual(await footprintOf(w, e), before);
});

// R1.4 (spec §16.17.4, tabela das fases): este teste fixava, na R1.3, que NINGUÉM concluía B/C (nem o autor). Agora só o AUTOR conclui, pelo reenvio idêntico; outro operador
// continua recebendo RESULT_PENDING_UNCONFIRMED sem gravar nada. Os detalhes (reconferências, recibo adotado, identidade normalizada, R6-04) estão em
// `link-audit-results-ledger-author-close`.
test('fases B e C abertas ⇒ RESULT_PENDING_UNCONFIRMED para OUTRO operador, nada gravado; o AUTOR conclui pelo reenvio idêntico (R1.4)', async () => {
  for (const phase of ['B', 'C'] as const) {
    const { w, e } = await protectedWorld();
    // o dono cai depois do recibo (C) ou antes dele (B): o resultado existe, o RUN_CONFIRMED não
    const failing = (target: string): FsOps => ({
      ...nodeFsOps,
      async link(from, to) {
        if (to === target) throw Object.assign(new Error('falha simulada'), { code: 'ENOSPC' });
        return nodeFsOps.link(from, to);
      },
    });
    const ledgerTarget = path.join(w.ledgerDir, w.auditId, 'l000005.json');
    const receiptTarget = path.join(e.anchors, w.auditId, 'a0001.json');
    const owner = phase === 'C' ? finalizerOver(w, e, { ledger: { fs: failing(ledgerTarget) } }) : finalizerOver(w, e, { resultsFs: failing(receiptTarget) });
    const body = await bodyNow(owner, OP_A, w.auditId);
    const first = await owner.results.finalize(OP_A, w.auditId, body);
    assert.ok(!first.ok && first.code === 'RESULT_ANCHOR_PENDING', `${phase}: ${show(first)}`);
    const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
    assert.deepEqual([view.ledger.state, view.ledger.runs?.open?.phase], ['PROTECTED', phase], phase);
    const before = await footprintOf(w, e);
    const other = await finalizerOver(w, e).results.finalize(OP_B, w.auditId, body);
    assert.ok(!other.ok && other.code === 'RESULT_PENDING_UNCONFIRMED', `${phase}/${OP_B.email}: ${show(other)}`);
    assert.deepEqual(await footprintOf(w, e), before, `${phase}: nada gravado pelo não autor`);
    const own = await finalizerOver(w, e).results.finalize(OP_A, w.auditId, body);
    assert.ok(own.ok && own.value.recoveredPending, `${phase}/${OP_A.email}: ${show(own)}`);
    assert.deepEqual((await eventsOf(w)).slice(-2), ['RUN_INTENT', 'RUN_CONFIRMED'], `${phase}: o autor concluiu`);
  }
});

test('passo 6 (f): sem capacidade da classe RUN o RUN_INTENT é recusado ANTES de gravar (LEDGER_CAPACITY_EXHAUSTED) e nada é publicado em resultados', async () => {
  const policy = deriveCapacityPolicy(60, 3, 8);
  const w = await ledgerWorld({ enroll: false });
  const e = resultsEnv();
  // RECORD = RUN = 60 − 8 − (3×3 + ⌈9/8⌉ + 2) − 1 = 38: com 37 registros não cabem RUN_INTENT + fecho (37 + 2 > 38)
  await plantWorld(w, 1, (chain, refs) => void chain.decision(refs[0] as DecisionRef).fill(37));
  const records = await ledgerRecords(w);
  assert.equal(records.length, 37);
  const f = finalizerOver(w, e, { ledger: { capacityPolicy: policy, checkpointEvery: 8 } });
  const view = await must(f.decisions.list(BIA, w.auditId, clock()));
  assert.equal(view.ledger.capacity?.runsAvailable, 0, 'a vista anuncia o que o livro executa');
  const done = await finalizeAs(f, OP_A, w.auditId);
  assert.ok(!done.ok && done.code === 'LEDGER_CAPACITY_EXHAUSTED', show(done));
  assert.equal((await ledgerRecords(w)).length, 37, 'nada gravado no livro');
  assert.deepEqual(publishedRunFiles(e), []);
});

/* ------------------------------------------------------------------ a porta diretamente: o que o passo 6 confere sozinho */

async function contextOf(w: LedgerWorld, e: ResultsEnv, over: Parameters<typeof finalizerOver>[2] = {}) {
  const f = finalizerOver(w, e, over);
  const port = f.decisions.resultsLedger;
  assert.ok(port, 'o serviço de decisões com livro e testemunha oferece a porta de escrita');
  const ctx = await port.context({ auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.ok(ctx.kind === 'OK', show(ctx));
  const records = await ledgerRecords(w);
  const draft = { runSeq: 1, prevRunSha256: null, runSha256: hashOf('resultado-da-porta'), author: 'ana@empresa.com', citedLedgerHead: ctx.view.decisionHead as { ledgerSeq: number; sha256: string }, decisionsHead: decisionsHeadOf(records) };
  return { port, session: ctx.session, view: ctx.view, draft };
}

test('passo 6 (b)/(e)/autor: RUN_INTENT com runSeq ou resultado anterior que não são os do livro ⇒ RESTART; cabeça de decisões da entrada errada ⇒ STALE_INPUT; autor ≠ quem grava ⇒ recusa — nada gravado', async () => {
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ['runSeq além do livro (I-2)', { runSeq: 2, prevRunSha256: hashOf('x') }, 'RESTART', 'ana@empresa.com'],
    ['resultado anterior inventado (I-2)', { prevRunSha256: hashOf('x') }, 'RESTART', 'ana@empresa.com'],
    ['decisions.head diferente do último CONFIRMED (I-4)', { decisionsHead: { seq: 1, sha256: hashOf('outra-decisao') } }, 'STALE_INPUT', 'ana@empresa.com'],
    ['cabeça citada que não é a de decisões (passo 6 (d))', { citedLedgerHead: { ledgerSeq: 2, sha256: hashOf('x') } }, 'STALE_INPUT', 'ana@empresa.com'],
    ['autor diferente de quem grava', {}, 'LEDGER_UNAVAILABLE', 'bia@empresa.com'],
  ];
  for (const [label, over, expected, actor] of cases) {
    const { w, e } = await protectedWorld();
    const { port, session, draft } = await contextOf(w, e);
    const before = await eventsOf(w);
    const step = await port.intent({ session, auditId: w.auditId, actor, nowIso: clock(), run: { ...draft, ...over } as typeof draft });
    const kind = step.kind === 'REFUSED' ? step.refusal.code : step.kind;
    assert.equal(kind, expected, `${label}: ${show(step)}`);
    assert.deepEqual(await eventsOf(w), before, `${label}: nada gravado`);
  }
});

test('passo 6 / 7 / 11 pela porta: rascunho válido grava RUN_INTENT; a autorização é de uso ÚNICO; o RUN_CONFIRMED exige o MESMO resultado do RUN_INTENT desta sessão; sem RUN_INTENT não há prazo nem fecho', async () => {
  const { w, e } = await protectedWorld();
  const { port, session, draft } = await contextOf(w, e);
  const noIntentGate = await port.gate({ session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.ok(noIntentGate.kind === 'REFUSED', `prazo sem RUN_INTENT desta sessão: ${show(noIntentGate)}`);
  const noIntentClose = await port.confirmed({ session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: draft });
  assert.ok(noIntentClose.kind === 'REFUSED', `fecho sem RUN_INTENT desta sessão: ${show(noIntentClose)}`);
  const ok = await port.intent({ session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: draft });
  assert.equal(ok.kind, 'OK', show(ok));
  assert.deepEqual((await eventsOf(w)).slice(-1), ['RUN_INTENT']);
  const twice = await port.intent({ session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: draft });
  assert.ok(twice.kind === 'REFUSED', `a mesma autorização não serve duas vezes: ${show(twice)}`);
  const gate = await port.gate({ session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.equal(gate.kind, 'OK', show(gate));
  const other = await port.confirmed({ session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: { ...draft, runSha256: hashOf('outro-resultado') } });
  assert.ok(other.kind === 'REFUSED', `fecho de OUTRO resultado: ${show(other)}`);
  const notAuthor = await port.confirmed({ session, auditId: w.auditId, actor: 'bia@empresa.com', nowIso: clock(), run: draft });
  assert.ok(notAuthor.kind === 'REFUSED', `fecho de quem não é o autor: ${show(notAuthor)}`);
  assert.deepEqual((await eventsOf(w)).slice(-1), ['RUN_INTENT'], 'nenhum fecho gravado pelas recusas');
  const closed = await port.confirmed({ session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: draft });
  assert.equal(closed.kind, 'OK', show(closed));
  assert.deepEqual((await eventsOf(w)).slice(-2), ['RUN_INTENT', 'RUN_CONFIRMED']);
});

test('passo 6 (c) / M-R12: operação de DECISÃO aberta cuja INTENT é a própria cabeça citada ⇒ o RUN_INTENT é recusado (STALE_INPUT ⇒ INPUT_CHANGED); nunca um RUN_INTENT com decisão aberta (I-1)', async () => {
  const { w, e } = await protectedWorld();
  const head = decisionsHeadOf(await ledgerRecords(w));
  await appendLedger(w, LEDGER_AUTH_A, () => ({ event: 'INTENT', actor: 'bia@empresa.com', op: opOf(refOf(2, head?.sha256 ?? null, 'aberta', { author: 'bia@empresa.com' }), 'd'.repeat(32)) }));
  const { port, session, draft, view } = await contextOf(w, e);
  assert.equal(view.decisionHead?.ledgerSeq, 4, 'a cabeça de decisões é a própria INTENT aberta (o passo 6 (d) sozinho não a recusaria)');
  const before = await eventsOf(w);
  const step = await port.intent({ session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: draft });
  assert.ok(step.kind === 'REFUSED' && step.refusal.code === 'STALE_INPUT', show(step));
  assert.deepEqual(await eventsOf(w), before, 'nada gravado');
});

test('passo 6 (b): outra finalização abriu um RUN_INTENT depois do passo 1 ⇒ RESTART (recomeça do passo 0), nada gravado por esta', async () => {
  const { w, e } = await protectedWorld();
  const { port, session, draft } = await contextOf(w, e);
  await appendLedger(w, LEDGER_AUTH_A, runIntentMaker({ author: 'bia@empresa.com' }));
  const before = await eventsOf(w);
  const step = await port.intent({ session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: draft });
  assert.equal(step.kind, 'RESTART', show(step));
  assert.deepEqual(await eventsOf(w), before);
});

test('testemunha das DECISÕES não resolvida: o passo 1 não autoriza RUN_INTENT (a finalização é recusada pela avaliação; a porta, sozinha, também recusa)', async () => {
  const { w } = await protectedWorld();
  // cabeça de decisões que um resultado selado afirma e o histórico de hoje NÃO tem (outra entrada na posição 1): testemunha HISTORY_DIVERGES
  const lying = async () => ({ ok: true as const, heads: [{ seq: 1, sha256: hashOf('outra-entrada') }], unverifiedHeads: [], hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [] });
  const port = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: lying }).resultsLedger;
  assert.ok(port);
  const ctx = await port.context({ auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock() });
  assert.ok(ctx.kind === 'OK' && ctx.view.state === 'PROTECTED', show(ctx));
  const records = await ledgerRecords(w);
  const step = await port.intent({ session: ctx.session, auditId: w.auditId, actor: 'ana@empresa.com', nowIso: clock(), run: { runSeq: 1, prevRunSha256: null, runSha256: hashOf('r'), author: 'ana@empresa.com', citedLedgerHead: at(records, 3), decisionsHead: decisionsHeadOf(records) } });
  assert.ok(step.kind === 'REFUSED', show(step));
  assert.deepEqual(await eventsOf(w), ['GENESIS', 'INTENT', 'CONFIRMED']);
});

test('passo 1b / M-R22 (na finalização): R0 vê X (coerente, encadeado, com recibo) onde o livro confirma G ⇒ relê e o reenvio idêntico devolve G, nunca X; troca persistente ⇒ RESULT_INTEGRITY; X no lugar da pendente efetiva (fase B) ⇒ RESULT_INTEGRITY', async () => {
  const { w, e } = await protectedWorld();
  const f = finalizerOver(w, e);
  const body = await bodyNow(f, OP_A, w.auditId);
  assert.ok((await f.results.finalize(OP_A, w.auditId, body)).ok);
  const G = (await runsOf(e, w.auditId)).runs[0];
  assert.ok(G);
  const runFile = runPath(e, 1, w.auditId);
  const receiptFile = path.join(e.anchors, w.auditId, 'a0001.json');
  // X: o mesmo resultado com outra hora (selo refeito por quem escreve na pasta, sem etiqueta) e o recibo coerente com ele
  const { contentSha256: _g, origin: _o, ...unsealed } = G as unknown as Record<string, unknown>;
  const X = seal({ ...unsealed, finalizedAt: '2026-10-30T13:59:59.000Z' });
  const { contentSha256: _r, ...receipt } = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) as Record<string, unknown>;
  const XR = seal({ ...receipt, headSha256: X.contentSha256 });
  void _g;
  void _o;
  void _r;
  const swapping = (reads: number, files: readonly string[]): FsOps => {
    let served = 0;
    return {
      ...nodeFsOps,
      async readFile(target, max) {
        if (files.includes(target) && served < reads) {
          served += 1;
          return serialize(target === runFile ? X : XR);
        }
        return nodeFsOps.readFile(target, max);
      },
    };
  };
  const once = await finalizerOver(w, e, { resultsFs: swapping(2, [runFile, receiptFile]) }).results.finalize(OP_A, w.auditId, body);
  assert.ok(once.ok && once.value.replayed, show(once));
  assert.equal(once.value.head.sha256, G.contentSha256, 'devolve G, o resultado que o livro confirmou');
  const persistent = await finalizerOver(w, e, { resultsFs: swapping(Infinity, [runFile, receiptFile]) }).results.finalize(OP_A, w.auditId, body);
  assert.ok(!persistent.ok && persistent.code === 'RESULT_INTEGRITY', show(persistent));

  // fase B: o livro tem RUN_INTENT(G) aberto; R0 vê X no lugar da pendente efetiva
  const { w: wb, e: eb } = await protectedWorld();
  const failingReceipt: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      if (to === path.join(eb.anchors, wb.auditId, 'a0001.json')) throw Object.assign(new Error('falha simulada'), { code: 'ENOSPC' });
      return nodeFsOps.link(from, to);
    },
  };
  const owner = finalizerOver(wb, eb, { resultsFs: failingReceipt });
  const bodyB = await bodyNow(owner, OP_A, wb.auditId);
  const pending = await owner.results.finalize(OP_A, wb.auditId, bodyB);
  assert.ok(!pending.ok && pending.code === 'RESULT_ANCHOR_PENDING', show(pending));
  const GB = (await runsOf(eb, wb.auditId)).pending;
  assert.ok(GB);
  const { contentSha256: _gb, origin: _ob, ...unsealedB } = GB as unknown as Record<string, unknown>;
  const XB = seal({ ...unsealedB, finalizedAt: '2026-10-30T13:59:59.000Z' });
  void _gb;
  void _ob;
  const runFileB = runPath(eb, 1, wb.auditId);
  const swapB: FsOps = { ...nodeFsOps, readFile: async (target, max) => (target === runFileB ? serialize(XB) : nodeFsOps.readFile(target, max)) };
  const before = await footprintOf(wb, eb);
  const refused = await finalizerOver(wb, eb, { resultsFs: swapB }).results.finalize(OP_A, wb.auditId, bodyB);
  assert.ok(!refused.ok && refused.code === 'RESULT_INTEGRITY', `X não é a pendente que o RUN_INTENT amarra: ${show(refused)}`);
  assert.deepEqual(await footprintOf(wb, eb), before, 'nada gravado');
});

test('passo 11: a fase A é abortada por outro operador na janela entre o prazo do dono e o link() do resultado ⇒ o dono NUNCA grava RUN_CONFIRMED depois do RUN_ABORTED (RESULT_ANCHOR_PENDING) e o livro continua autêntico', async () => {
  const { w, e } = await protectedWorld();
  const target = runPath(e, 1, w.auditId);
  const abortFirst: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      if (to === target) await must(servicesOver(w, e, { ledger: ledgerFor(w, { guard: null }) }).ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, () => FAR));
      return nodeFsOps.link(from, to);
    },
  };
  const done = await finalizeAs(finalizerOver(w, e, { resultsFs: abortFirst }), OP_A, w.auditId);
  assert.ok(!done.ok && done.code === 'RESULT_ANCHOR_PENDING', show(done));
  const records = await ledgerRecords(w);
  assert.deepEqual(records.map((r) => r.event), ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT', 'RUN_ABORTED'], 'nenhum RUN_CONFIRMED depois do aborto');
  assert.ok(replayLedger(records, w.auditId).ok, 'o livro continua válido (I-5)');
});

/* ------------------------------------------------------------------ junin-02: autorização de uso único emitida pelo prepare liberado */

/** Auditoria com uma decisão confirmada pelo livro cujo RECIBO foi removido (`RECEIPT_REMOVED`: o `prepare` liberaria a reemissão). */
async function receiptRemovedWorld(): Promise<LedgerWorld> {
  const w = await ledgerWorld();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  fs.rmSync(anchorPath(w, 1));
  return w;
}
const EMPTY = { ok: true as const, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [], runs: { anchored: [], pending: null } };
async function viewInput(w: LedgerWorld, port: LedgerPort) {
  const session = await port.begin(w.auditId);
  const log = await readLog(w.decisionsDir, w.auditId, { anchorDir: w.anchorDir });
  assert.ok(log.ok);
  return { session, log: log.value, input: { session, auditId: w.auditId, snapshot: ledgerSnapshotOf(log.value.state.entries, log.value.pending), results: EMPTY, freshResults: async () => EMPTY, entryOriginProven: () => true, nowIso: clock() } };
}
const refused = (step: LedgerStep): boolean => step.kind === 'REFUSED';

test('junin-02: view() NÃO autoriza gravação — view() seguido de reissue() é recusado sem gravar; o prepare liberado autoriza UMA reemissão (a segunda chamada é recusada)', async () => {
  const w = await receiptRemovedWorld();
  const port = ledgerFor(w, { guard: null });
  const before = { events: await eventsOf(w), ledger: hashTree(w.ledgerDir) };
  const viewed = await viewInput(w, port);
  const view = await port.view(viewed.input);
  assert.deepEqual([view.state, view.reason, view.receiptReissuable], ['HISTORY_UNRESOLVED', 'RECEIPT_REMOVED', true], 'a vista reconhece a reemissão possível');
  const pending = viewed.log.pending;
  assert.ok(pending);
  const sneaky = await port.reissue({ session: viewed.session, auditId: w.auditId, actor: ANA.email, nowIso: clock(), entry: ledgerRefOf(pending) });
  assert.ok(refused(sneaky), `view() → reissue(): ${show(sneaky)}`);
  assert.deepEqual({ events: await eventsOf(w), ledger: hashTree(w.ledgerDir) }, before, 'nenhum RECEIPT_REISSUED');

  // o caminho certo: prepare liberado → UMA reemissão
  const prepared = await viewInput(w, port);
  const step = await port.prepare({ ...prepared.input, actor: ANA.email, rechecks: 0, intended: 'RECORD' });
  assert.ok(step.kind === 'OK' && step.pendingKind === 'RECEIPT_REMOVED', show(step));
  const entry = ledgerRefOf(prepared.log.pending as NonNullable<typeof prepared.log.pending>);
  const first = await port.reissue({ session: prepared.session, auditId: w.auditId, actor: ANA.email, nowIso: clock(), entry });
  assert.equal(first.kind, 'OK', show(first));
  assert.deepEqual((await eventsOf(w)).slice(-1), ['RECEIPT_REISSUED']);
  const second = await port.reissue({ session: prepared.session, auditId: w.auditId, actor: ANA.email, nowIso: clock(), entry });
  assert.ok(refused(second), `a mesma autorização não serve duas vezes: ${show(second)}`);
});

test('junin-02: uma view() DEPOIS do prepare liberado revoga a autorização — a gravação seguinte na mesma sessão é recusada', async () => {
  const w = await receiptRemovedWorld();
  const port = ledgerFor(w, { guard: null });
  const prepared = await viewInput(w, port);
  const step = await port.prepare({ ...prepared.input, actor: ANA.email, rechecks: 0, intended: 'RECORD' });
  assert.ok(step.kind === 'OK' && step.pendingKind === 'RECEIPT_REMOVED', show(step));
  await port.view(prepared.input);
  const before = await eventsOf(w);
  const reissued = await port.reissue({ session: prepared.session, auditId: w.auditId, actor: ANA.email, nowIso: clock(), entry: ledgerRefOf(prepared.log.pending as NonNullable<typeof prepared.log.pending>) });
  assert.ok(refused(reissued), show(reissued));
  assert.deepEqual(await eventsOf(w), before);
});

test('junin-02: view() seguido de intent() ou do RUN_INTENT é recusado sem gravar; prepare de RECOVER (manutenção) não autoriza INTENT', async () => {
  const { w } = await protectedWorld();
  const port = ledgerFor(w, { guard: null });
  const before = await eventsOf(w);
  const viewed = await viewInput(w, port);
  await port.view(viewed.input);
  const entry = refOf(2, decisionsHeadOf(await ledgerRecords(w))?.sha256 ?? null, 'sorrateira');
  const intent = await port.intent({ session: viewed.session, auditId: w.auditId, actor: ANA.email, nowIso: clock(), entry });
  assert.ok(refused(intent), `view() → intent(): ${show(intent)}`);
  const records = await ledgerRecords(w);
  const runIntent = await port.runIntent({ session: viewed.session, auditId: w.auditId, actor: ANA.email, nowIso: clock(), run: { runSeq: 1, prevRunSha256: null, runSha256: hashOf('r'), author: ANA.email, citedLedgerHead: at(records, 3), decisionsHead: decisionsHeadOf(records) } });
  assert.ok(runIntent.kind === 'REFUSED', `view() → RUN_INTENT: ${show(runIntent)}`);
  const recover = await viewInput(w, port);
  const maintenance = await port.prepare({ ...recover.input, actor: ANA.email, rechecks: 0, intended: 'NONE' });
  assert.equal(maintenance.kind, 'OK', show(maintenance));
  const afterRecover = await port.intent({ session: recover.session, auditId: w.auditId, actor: ANA.email, nowIso: clock(), entry });
  assert.ok(refused(afterRecover), `RECOVER → intent(): ${show(afterRecover)}`);
  assert.deepEqual(await eventsOf(w), before, 'nada gravado');
});

/* ------------------------------------------------------------------ textos (D-17) */

test('D-17: textos da finalização pelo livro — LEDGER_UNAVAILABLE diz que nenhum resultado foi publicado; RESULT_DURABILITY_UNKNOWN nunca diz "Nada foi gravado"; RESULT_WRITE_CONFLICT cobre o prazo; a pendente pode estar sem recibo OU sem a confirmação do livro', () => {
  assert.equal(RESULTS_MESSAGE.LEDGER_UNAVAILABLE, 'O livro de cabeças não pôde ser gravado; nenhum resultado foi publicado.');
  assert.ok(!/Nada foi gravado/i.test(RESULTS_MESSAGE.RESULT_DURABILITY_UNKNOWN), RESULTS_MESSAGE.RESULT_DURABILITY_UNKNOWN);
  assert.match(RESULTS_MESSAGE.RESULT_DURABILITY_UNKNOWN, /NÃO é sucesso/);
  assert.match(RESULTS_MESSAGE.RESULT_WRITE_CONFLICT, /prazo seguro/);
  assert.match(RESULTS_MESSAGE.RESULT_PENDING_UNCONFIRMED, /sem a confirmação do livro de cabeças/);
});
