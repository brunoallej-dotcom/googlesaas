import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { NOT_REQUIRED_VIEW } from '../src/lib/link-audit-decisions/ledger-port';
import { createUnconfiguredLedger, evaluateProtection, replayLedger, verifyTags, type DecisionRef, type LedgerRecord, type ProtectionInput } from '../src/lib/link-audit-ledger';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import type { PreviewEvaluator } from '../src/lib/link-audit-scoring-runs/results';
import { ANA, BIA, clock, hashTree, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { LEDGER_AUTH_A, ledgerRecords, ledgerWorld, refOf, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { sealResult, servicesOver } from './helpers/link-audit-ledger-results-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { abortedAttemptMakers, appendLedger, chainOf, checkpointMaker, runIntentMaker, runMakersFor } from './helpers/link-audit-results-ledger-fixtures';
import { makeService, OP_A, resultsEnv, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R1.2 — CABEÇA DE DECISÕES × CABEÇA DO LIVRO (spec §16.17.7, D-6, D-7). `head` continua sendo a cauda (qualquer registro); `decisionHead` é o último registro que NÃO é
 * `RUN_*` (decisão, GENESIS, ABORTED, RECEIPT_REISSUED e CHECKPOINT). Uma finalização nunca muda a entrada de outra (RL-13), o resultado cita a cabeça de decisões e nunca
 * uma posição `RUN_*` (RL-14), e a barreira compara a cabeça de decisões (RL-16, no que dá para exercitar antes de a finalização gravar `RUN_*` na R1.3). Os `RUN_*` são
 * montados pelo teste com a chave de TESTE do livro sobre resultados REAIS (`runMakersFor`): é exatamente o par que a R1.3 vai gravar. Mutações M-R11.
 */
registerCleanup();
const AUD = 'auditoria-runs-0002';
const D1 = refOf(1, null, 'dec');
const D2 = refOf(2, D1.sha256, 'dec');
const at = (records: readonly LedgerRecord[], seq: number) => ({ ledgerSeq: seq, sha256: (records[seq - 1] as LedgerRecord).contentSha256 });

function evaluate(records: readonly LedgerRecord[], confirmed: readonly DecisionRef[], pending: DecisionRef | null = null) {
  const input: ProtectionInput = {
    configured: true,
    read: { kind: 'PRESENT', records, tagFailure: verifyTags(records, LEDGER_AUTH_A) },
    auditId: AUD,
    decisions: { confirmed, pending },
    entryOriginProven: () => true,
    results: { ok: true, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [] },
    guard: { status: 'NOT_CONFIGURED' },
    ageMsOf: () => 1_000,
    staleMs: 120_000,
    currentKeyId: LEDGER_AUTH_A.keyId,
  };
  return evaluateProtection(input);
}

test('D-6: o replay e a vista expõem decisionHead (último registro NÃO RUN_*, inclusive CHECKPOINT e INTENT de decisão) separado de head (a cauda, de qualquer tipo)', () => {
  const chain = chainOf(AUD).genesis().decision(D1);
  const steps: Array<[string, () => void, number, number, readonly DecisionRef[], DecisionRef | null]> = [
    // [rótulo, passo, head esperado, decisionHead esperado, decisões confirmadas, pendente]
    ['GENESIS + decisão', () => undefined, 3, 3, [D1], null],
    ['resultado completo (RUN_INTENT + RUN_CONFIRMED)', () => chain.run(), 5, 3, [D1], null],
    ['CHECKPOINT (manutenção move a cabeça de decisões)', () => chain.checkpoint(), 6, 6, [D1], null],
    ['RUN_INTENT aberto', () => chain.runIntent(), 7, 6, [D1], null],
    ['INTENT de decisão com resultado aberto (D-8)', () => chain.decision(D2, { open: true }), 8, 8, [D1], D2],
    ['RUN_ABORTED intercalado', () => chain.runAbort(), 9, 8, [D1], D2],
    ['CONFIRMED da decisão', () => chain.confirmDecision(), 10, 10, [D1, D2], null],
    ['outro resultado completo', () => chain.run(), 12, 10, [D1, D2], null],
  ];
  for (const [label, step, head, decisionHead, confirmed, pending] of steps) {
    step();
    const replay = replayLedger(chain.records, AUD);
    assert.ok(replay.ok, `${label}: ${replay.ok ? '' : replay.issues.join('; ')}`);
    assert.deepEqual(replay.value.head, at(chain.records, head), `${label}: head do replay`);
    assert.deepEqual(replay.value.decisionHead, at(chain.records, decisionHead), `${label}: decisionHead do replay`);
    const view = evaluate(chain.records, confirmed, pending).view;
    assert.equal(view.state, 'PROTECTED', label);
    assert.deepEqual([view.head, view.decisionHead], [at(chain.records, head), at(chain.records, decisionHead)], `${label}: vista`);
  }
  // sem livro lido não há cabeça nenhuma (nunca uma cabeça vazia implícita)
  assert.equal(NOT_REQUIRED_VIEW.decisionHead, null);
  const absent = evaluateProtection({ ...({} as ProtectionInput), configured: true, read: { kind: 'ABSENT' }, auditId: AUD, decisions: { confirmed: [], pending: null }, entryOriginProven: () => true, results: { ok: true, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [] }, guard: { status: 'NOT_CONFIGURED' }, ageMsOf: () => 0, staleMs: 1 });
  assert.deepEqual([absent.view.state, absent.view.head, absent.view.decisionHead], ['ENROLLMENT_PENDING', null, null]);
});

test('D-6: o livro NÃO configurado responde decisionHead nulo (falha fechada, nunca uma cabeça inventada)', async () => {
  const view = await createUnconfiguredLedger().view({ session: null, auditId: AUD, snapshot: { confirmed: [], pending: null }, results: { ok: false }, entryOriginProven: () => false, nowIso: clock() });
  assert.deepEqual([view.state, view.reason, view.head, view.decisionHead], ['HISTORY_UNRESOLVED', 'NOT_CONFIGURED', null, null]);
});

/* ------------------------------------------------------------------ RL-13 / RL-14 / RL-16 sobre o serviço real */

/** Tudo o que define a ENTRADA de uma finalização, visto pela prévia e pela listagem das decisões (a mesma leitura que a tela usa). */
async function inputsOf(w: LedgerWorld, e: ResultsEnv) {
  const decisions = servicesOver(w, e);
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: decisions });
  const evaluated = await preview.evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok, JSON.stringify(evaluated).slice(0, 200));
  const now = await preview.fingerprintNow(OP_A, w.auditId);
  assert.ok(now.ok);
  const list = await must(decisions.list(BIA, w.auditId, clock()));
  return {
    preview,
    state: list.ledger.state,
    head: list.ledger.head,
    decisionHead: list.ledger.decisionHead,
    previewDecisionHead: evaluated.value.payload.decisions.ledger.decisionHead,
    expectedHead: evaluated.value.payload.finalization.expectedHead,
    expectedInputSha256: evaluated.value.payload.finalization.expectedInputSha256,
    allowed: evaluated.value.payload.finalization.allowed,
    fingerprint: evaluated.value.fingerprint,
    fingerprintNow: now.fingerprint,
    finalizable: list.finalizable,
    openOperation: list.ledger.openOperation,
  };
}

/** Auditoria protegida com UMA decisão confirmada (livro: GENESIS, INTENT, CONFIRMED). */
async function protectedWithDecision(): Promise<{ w: LedgerWorld; e: ResultsEnv }> {
  const w = await ledgerWorld();
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  return { w, e };
}

test('RL-13: uma finalização (resultado + o par RUN_INTENT/RUN_CONFIRMED que ela grava) NÃO muda a entrada de outra — decisionHead, expectedHead, expectedInputSha256, impressão digital e finalizable idênticos; head avança exatamente 2; a barreira com a expectativa de ANTES passa DEPOIS', async () => {
  const { w, e } = await protectedWithDecision();
  const records = await ledgerRecords(w);
  const before = await inputsOf(w, e);
  assert.deepEqual([before.state, before.allowed, before.finalizable], ['PROTECTED', true, true]);
  assert.deepEqual(before.decisionHead, at(records, 3), 'a cabeça de decisões é o CONFIRMED');
  assert.deepEqual(before.previewDecisionHead, before.decisionHead, 'a prévia mostra a mesma cabeça de decisões (payload.decisions.ledger)');

  const run = await sealResult(w, e); // a finalização (na R1.2 ela grava só s0001 + a0001)…
  await appendLedger(w, LEDGER_AUTH_A, ...runMakersFor(run)); // …e o par que a R1.3 grava no livro
  assert.deepEqual((await ledgerRecords(w)).map((r) => r.event).slice(-2), ['RUN_INTENT', 'RUN_CONFIRMED']);

  const after = await inputsOf(w, e);
  assert.equal(after.state, 'PROTECTED', 'o par RUN_* é aceito pelo replay (a citação é a cabeça de decisões)');
  assert.deepEqual(after.decisionHead, before.decisionHead, 'decisionHead');
  assert.deepEqual(after.previewDecisionHead, before.previewDecisionHead, 'decisionHead da prévia');
  assert.deepEqual(after.expectedHead, before.expectedHead, 'expectedHead');
  assert.equal(after.expectedInputSha256, before.expectedInputSha256, 'expectedInputSha256');
  assert.equal(after.fingerprint, before.fingerprint, 'impressão digital (avaliação)');
  assert.equal(after.fingerprintNow, before.fingerprintNow, 'impressão digital (releitura da finalização)');
  assert.deepEqual([after.finalizable, after.allowed, after.openOperation], [true, true, null], 'finalizable');
  assert.equal(after.head?.ledgerSeq, (before.head?.ledgerSeq ?? 0) + 2, 'head avançou exatamente 2');
  assert.notDeepEqual(after.head, after.decisionHead, 'agora a cauda é um RUN_*: as duas cabeças diferem');

  const barrier = await after.preview.durabilityBarrier(OP_A, w.auditId, { decisionsHead: before.expectedHead, ledgerHead: before.decisionHead });
  assert.deepEqual(barrier, { ok: true }, 'a barreira compara a cabeça de DECISÕES: a expectativa capturada antes da finalização continua valendo');
  const stale = await after.preview.durabilityBarrier(OP_A, w.auditId, { decisionsHead: before.expectedHead, ledgerHead: after.head });
  assert.ok(!stale.ok && stale.code === 'INPUT_CHANGED', 'citar a cauda RUN_* não é a cabeça de decisões: recusada');
});

test('RL-14: para k = 1, 2, 3, intercalando decisões, tentativas abortadas e CHECKPOINT, s000k.ledgerHead === decisionHead === RUN_INTENT(k).citedLedgerHead, nunca uma posição RUN_*', async () => {
  const { w, e } = await protectedWithDecision();
  const rounds: Array<{ label: string; before: () => Promise<void>; tailIsRun: boolean }> = [
    { label: 'k=1 (cauda = CONFIRMED)', before: async () => undefined, tailIsRun: false },
    {
      label: 'k=2 (decisão, depois uma tentativa abortada: a cauda é RUN_ABORTED)',
      before: async () => {
        await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
        await appendLedger(w, LEDGER_AUTH_A, ...abortedAttemptMakers());
      },
      tailIsRun: true,
    },
    {
      label: 'k=3 (revogação, CHECKPOINT e outra tentativa abortada: a cabeça de decisões é o CHECKPOINT)',
      before: async () => {
        await must(w.protectedService.revoke(ANA, w.auditId, { revokes: 'op-0002', reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.' }, clock()));
        await appendLedger(w, LEDGER_AUTH_A, checkpointMaker, ...abortedAttemptMakers());
      },
      tailIsRun: true,
    },
  ];
  for (const [index, round] of rounds.entries()) {
    const k = index + 1;
    await round.before();
    const records = await ledgerRecords(w);
    const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
    assert.equal(view.ledger.state, 'PROTECTED', round.label);
    assert.equal(records[(view.ledger.decisionHead?.ledgerSeq ?? 0) - 1]?.event.startsWith('RUN_'), false, `${round.label}: a cabeça de decisões nunca é RUN_*`);
    if (round.tailIsRun) assert.notDeepEqual(view.ledger.head, view.ledger.decisionHead, `${round.label}: a cauda é RUN_* (o caso que distingue as duas cabeças)`);
    if (k === 3) assert.equal(records[(view.ledger.decisionHead?.ledgerSeq ?? 0) - 1]?.event, 'CHECKPOINT', `${round.label}: D-6 inclui o CHECKPOINT`);

    const run = await sealResult(w, e);
    assert.equal(run.seq, k, round.label);
    assert.deepEqual(run.ledgerHead, view.ledger.decisionHead, `${round.label}: o resultado cita a cabeça de decisões`);
    const written = await appendLedger(w, LEDGER_AUTH_A, ...runMakersFor(run));
    const intent = written[written.length - 2] as LedgerRecord;
    assert.equal(intent.event, 'RUN_INTENT');
    assert.deepEqual(intent.run?.citedLedgerHead, run.ledgerHead, `${round.label}: RUN_INTENT(k).citedLedgerHead = ledgerHead do resultado`);
    assert.equal(written[(run.ledgerHead?.ledgerSeq ?? 0) - 1]?.event.startsWith('RUN_'), false, `${round.label}: a posição citada não é RUN_*`);
    const after = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
    assert.equal(after.ledger.state, 'PROTECTED', `${round.label}: a I-3 aceita a citação (uma posição RUN_* deixaria o livro UNTRUSTED)`);
  }
});

test('RL-16: a barreira recusa (INPUT_CHANGED) quando a cabeça de DECISÕES muda entre a avaliação e o selamento — decisão nova, CHECKPOINT (D-6) ou INTENT aberto — e uma finalização assim não publica nada', async () => {
  const { w, e } = await protectedWithDecision();
  const before = await inputsOf(w, e);
  const expectation = { decisionsHead: before.expectedHead, ledgerHead: before.decisionHead };
  // CHECKPOINT: as decisões não mudam, mas a cabeça de decisões do livro sim (D-6; excluí-lo deixaria a barreira passar)
  await appendLedger(w, LEDGER_AUTH_A, checkpointMaker);
  const afterCheckpoint = await inputsOf(w, e);
  assert.deepEqual(afterCheckpoint.expectedHead, before.expectedHead, 'as decisões são as mesmas');
  assert.notDeepEqual(afterCheckpoint.decisionHead, before.decisionHead, 'a cabeça de decisões andou');
  const byCheckpoint = await afterCheckpoint.preview.durabilityBarrier(OP_A, w.auditId, expectation);
  assert.ok(!byCheckpoint.ok && byCheckpoint.code === 'INPUT_CHANGED', JSON.stringify(byCheckpoint));
  // decisão nova completa
  const fresh = await inputsOf(w, e);
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
  const byDecision = await fresh.preview.durabilityBarrier(OP_A, w.auditId, { decisionsHead: fresh.expectedHead, ledgerHead: fresh.decisionHead });
  assert.ok(!byDecision.ok && byDecision.code === 'INPUT_CHANGED', JSON.stringify(byDecision));

  // finalização com uma decisão concorrente ENTRE a avaliação e a barreira: INPUT_CHANGED e nada publicado em resultados
  const decisions = servicesOver(w, e);
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: decisions });
  const evaluated = await preview.evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok);
  const racing: PreviewEvaluator = {
    evaluate: (actor, auditId) => preview.evaluate(actor, auditId),
    fingerprintNow: (actor, auditId) => preview.fingerprintNow(actor, auditId),
    durabilityBarrier: async (actor, auditId, expected) => {
      await must(w.protectedService.revoke(ANA, w.auditId, { revokes: 'op-0002', reason: 'Revogada porque o juízo estava errado e foi refeito pelo operador.' }, clock()));
      return preview.durabilityBarrier(actor, auditId, expected);
    },
  };
  const files = () => ({ runs: hashTree(e.base), anchors: hashTree(e.anchors) });
  const results = files();
  const attempt = await makeService(e, racing).finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string });
  assert.ok(!attempt.ok && attempt.code === 'INPUT_CHANGED', JSON.stringify(attempt).slice(0, 200));
  assert.deepEqual(files(), results, 'nenhum resultado nem recibo publicado (a pasta da auditoria pode existir vazia)');
});

test('RL-16: INTENT de decisão aberto (publicação falhou) ⇒ a barreira recusa; um RUN_INTENT aberto NUNCA faz a decisão esperar nem torna finalizable falso (D-8, 16.17.7)', async () => {
  let failEntry = false;
  const w = await ledgerWorld({ decisionsFs: faulty({ async link(from, to) { if (failEntry && to.endsWith('d0003.json')) throw errno('ENOSPC'); return nodeFsOps.link(from, to); } }) });
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  // resultado aberto (fase A recente): a decisão segue sem esperar
  await appendLedger(w, LEDGER_AUTH_A, runIntentMaker());
  const open = await inputsOf(w, e);
  assert.deepEqual([open.state, open.openOperation, open.finalizable], ['PROTECTED', null, true], 'openRun não é operação de decisão e não bloqueia a finalização pela 6B');
  const started = Date.now();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
  assert.ok(Date.now() - started < 1_500, 'a decisão não esperou pela operação de resultado');
  assert.deepEqual((await ledgerRecords(w)).map((r) => r.event).slice(-3), ['RUN_INTENT', 'INTENT', 'CONFIRMED']);
  // INTENT de decisão que fica aberto (a publicação da entrada falha depois da INTENT)
  const expectation = await inputsOf(w, e);
  failEntry = true;
  assert.ok(!(await w.protectedService.create(ANA, w.auditId, { record: rec.naFeature() }, clock())).ok);
  failEntry = false;
  const withIntent = await inputsOf(w, e);
  assert.notEqual(withIntent.openOperation, null, 'operação de decisão aberta');
  const barrier = await withIntent.preview.durabilityBarrier(OP_A, w.auditId, { decisionsHead: expectation.expectedHead, ledgerHead: expectation.decisionHead });
  assert.ok(!barrier.ok && barrier.code === 'INPUT_CHANGED', JSON.stringify(barrier));
  assert.deepEqual(hashTree(path.join(e.base)), {}, 'nada em resultados');
});
