import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { KnownHeadsProvider } from '../src/lib/link-audit-decisions';
import { evaluateProtection, verifyTags, type DecisionRef, type LedgerRecord, type ProtectionInput, type ResultsEvidence } from '../src/lib/link-audit-ledger';
import { ANA, BIA, clock, hashTree, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, LEDGER_AUTH_A, ledgerFor, ledgerRecords, ledgerWorld, refOf } from './helpers/link-audit-ledger-fixtures';
import { sealResult, servicesOver, witnessOver } from './helpers/link-audit-ledger-results-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { appendLedger, chainOf, hashOf, runIntentMaker, runMakersFor, runRefOf, type Chain, type RunBody } from './helpers/link-audit-results-ledger-fixtures';
import { makeService, OP_A, receiptPath, resultsEnv, runPath } from './helpers/link-audit-results-fixtures';

/*
 * R1.2 — `runs` NA VISTA DO LIVRO (spec §16.17.2, 16.17.4, 16.17.5 e 16.17.9, no que esta fatia deriva do livro e da testemunha dos resultados): resultados confirmados
 * pelo livro, a operação de resultado aberta (fase A/B/C pela leitura mais recente), `RESULT_REGRESSED` / `RESULT_RECEIPT_REMOVED` (só resultados, julgados SÓ sobre R2,
 * D-21) e a reemissão anunciada. `runs` só existe depois das TESTEMUNHAS (citações `ledgerHead` e guarda; R6-05, RL-24) e o cruzamento de resultados vem ANTES do
 * cruzamento livro × decisões (M-R21). As contradições julgadas sobre R1 (UNLEDGERED_RESULT, RESULT_DIVERGES, RESULT_PUBLISHED_AFTER_ABORT) são da R1.5 (D-R1-5).
 */
registerCleanup();
const AUD = 'auditoria-runs-0003';
const D1 = refOf(1, null, 'dec');
const runOf = (record: LedgerRecord | undefined): RunBody => (record as unknown as { run: RunBody }).run;
const runsOf = (chain: Chain) => chain.records.filter((r) => r.event === 'RUN_INTENT').map(runOf);
const NONE: ResultsEvidence = { ok: true, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [] };
type Ref = ReturnType<typeof runRefOf>;
const seen = (anchored: readonly Ref[], pending: Ref | null = null, over: Partial<Extract<ResultsEvidence, { ok: true }>> = {}): ResultsEvidence => ({
  ok: true,
  hasResults: anchored.length > 0 || pending !== null,
  ledgerHeads: [],
  unverifiedLedgerHeads: [],
  runs: { anchored, pending },
  ...over,
});

function evaluate(chain: Chain, results: ResultsEvidence, over: Partial<ProtectionInput> = {}, confirmed: readonly DecisionRef[] = [D1], pending: DecisionRef | null = null) {
  const input: ProtectionInput = {
    configured: true,
    read: { kind: 'PRESENT', records: chain.records, tagFailure: verifyTags(chain.records, LEDGER_AUTH_A) },
    auditId: AUD,
    decisions: { confirmed, pending },
    entryOriginProven: () => true,
    results,
    guard: { status: 'NOT_CONFIGURED' },
    ageMsOf: () => 1_000,
    staleMs: 120_000,
    currentKeyId: LEDGER_AUTH_A.keyId,
    ...over,
  };
  return evaluateProtection(input);
}
const base = (): Chain => chainOf(AUD).genesis().decision(D1);

test('runs: resultado confirmado pelo livro e ancorado em R1 ⇒ OK sem pedir R2; a vista traz só hashes e posições (nunca identidade)', () => {
  const chain = base().run();
  const [run] = runsOf(chain);
  const evaluation = evaluate(chain, seen([runRefOf(1, run?.runSha256 as string)]));
  assert.equal(evaluation.view.state, 'PROTECTED');
  assert.equal(evaluation.needsFreshResults, false, 'R1 bastou');
  assert.deepEqual(evaluation.view.runs, { state: 'OK', reason: null, confirmed: [{ runSeq: 1, runSha256: run?.runSha256 }], open: null, receiptReissuable: false });
  assert.ok(!JSON.stringify(evaluation.view).includes('@'), 'nenhum e-mail (autor ou finalizedBy) na vista');
});

test('runs.open: fase pela leitura mais recente — A (nada no disco), B (sk com o hash do RUN_INTENT, sem recibo), C (sk e recibo, sem RUN_CONFIRMED); idade pela chave run:<runOpId> (R7-09)', () => {
  const chain = base().runIntent();
  const [intent] = runsOf(chain);
  const sha = intent?.runSha256 as string;
  const keys: Array<string | undefined> = [];
  const ages = (ms: number) => ({ ageMsOf: (_recordedAt: string, key?: string) => (keys.push(key), ms) });
  const cases: Array<[string, ResultsEvidence, number, 'A' | 'B' | 'C', boolean, boolean]> = [
    // [rótulo, R1, idade, fase, vencida, receita]
    ['A recente', NONE, 1_000, 'A', false, false],
    ['A vencida (qualquer operador aborta, R1.3)', NONE, 200_000, 'A', true, true],
    ['B (só o autor conclui; origem comprovada)', seen([], runRefOf(1, sha)), 1_000, 'B', false, true],
    ['B com origem NÃO comprovada (D-16: aberta, sem receita)', seen([], runRefOf(1, sha, { originProven: false })), 200_000, 'B', true, false],
    ['C (só o autor conclui)', seen([runRefOf(1, sha)]), 1_000, 'C', false, true],
    ['C com origem NÃO comprovada', seen([runRefOf(1, sha, { originProven: false })]), 1_000, 'C', false, false],
    ['sk de OUTRO hash no lugar (contradição da R1.5): nunca B/C e nunca receita, nem vencida', seen([], runRefOf(1, hashOf('outro'))), 200_000, 'A', true, false],
  ];
  for (const [label, results, age, phase, stale, recoverable] of cases) {
    const evaluation = evaluate(chain, results, ages(age));
    assert.equal(evaluation.view.state, 'PROTECTED', `${label}: nenhuma fase é contradição`);
    assert.deepEqual(evaluation.view.runs?.open, { runOpId: intent?.runOpId, runSeq: 1, runSha256: sha, phase, ageMs: age, stale, recoverable }, label);
    assert.deepEqual([evaluation.view.openOperation, evaluation.view.recoverable], [null, false], `${label}: os campos de topo continuam só de decisão`);
  }
  assert.ok(keys.includes(`run:${intent?.runOpId}`), `idade observada pela chave da operação de resultado (${keys.join(', ')})`);
});

test('L → R2: confirmado NÃO ancorado em R1 pede R2; só R2 decide RESULT_REGRESSED / RESULT_RECEIPT_REMOVED, que fecham só os resultados (D-21)', () => {
  const chain = base().run();
  const [run] = runsOf(chain);
  const sha = run?.runSha256 as string;
  const first = evaluate(chain, NONE);
  assert.equal(first.needsFreshResults, true, 'R1 (lida antes do livro) não viu o resultado: pede R2');
  const cases: Array<[string, ResultsEvidence, ResultsEvidence, 'OK' | 'UNRESOLVED', string | null]> = [
    ['R2 ancorado (corrida legítima)', NONE, seen([runRefOf(1, sha)]), 'OK', null],
    ['R2 sem sk', NONE, NONE, 'UNRESOLVED', 'RESULT_REGRESSED'],
    ['R2 com sk de outro hash', NONE, seen([runRefOf(1, hashOf('outro'))]), 'UNRESOLVED', 'RESULT_REGRESSED'],
    ['R2 com sk certo e sem recibo', NONE, seen([], runRefOf(1, sha)), 'UNRESOLVED', 'RESULT_RECEIPT_REMOVED'],
    ['R1 já sem recibo, R2 idem', seen([], runRefOf(1, sha)), seen([], runRefOf(1, sha)), 'UNRESOLVED', 'RESULT_RECEIPT_REMOVED'],
  ];
  for (const [label, r1, r2, state, reason] of cases) {
    const evaluation = evaluate(chain, r1, { resultsAfterLedger: r2 });
    assert.equal(evaluation.needsFreshResults, false, `${label}: com R2 nada mais é pedido`);
    assert.deepEqual([evaluation.view.state, evaluation.view.reason, evaluation.view.confirmedDecisions], ['PROTECTED', null, 1], `${label}: o livro e as decisões seguem protegidos`);
    assert.deepEqual([evaluation.view.runs?.state, evaluation.view.runs?.reason], [state, reason], label);
    assert.equal(evaluation.view.runs?.receiptReissuable, reason === 'RESULT_RECEIPT_REMOVED', `${label}: reemissão anunciada só com o recibo removido`);
    assert.equal(evaluation.view.receiptReissuable, false, `${label}: o receiptReissuable de topo continua só de decisão`);
  }
  // sem R2 disponível (quem chamou não sabe reler): julga sobre R1, falhando fechado para os resultados — nunca "OK"
  assert.deepEqual([first.view.runs?.state, first.view.runs?.reason], ['UNRESOLVED', 'RESULT_REGRESSED']);
  // precedência: um resultado sumido vale mais do que um recibo removido
  const two = base().run().run();
  const [r1, r2] = runsOf(two);
  const both = evaluate(two, NONE, { resultsAfterLedger: seen([], runRefOf(2, r2?.runSha256 as string)) });
  assert.equal(both.view.runs?.reason, 'RESULT_REGRESSED', `s0001 sumiu (${r1?.runSha256.slice(0, 6)})`);
  // R2 nunca é pedido quando o livro não tem RUN_CONFIRMED não ancorado
  assert.equal(evaluate(base().runIntent(), NONE).needsFreshResults, false);
});

test('a receita do resultado só é anunciada em PROTECTED e com runs OK; com razão de DECISÃO o runs continua existindo (16.17.9) e o R2 continua sendo pedido (M-R21)', () => {
  const chain = base().run().runIntent();
  const [run] = runsOf(chain);
  const stale = { ageMsOf: () => 200_000 };
  // decisão: recibo da entrada 1 removido (o livro a confirmou; a pasta de decisões a mostra pendente) ⇒ HISTORY_UNRESOLVED / RECEIPT_REMOVED (razão de DECISÃO)
  const decisionReason = evaluate(chain, NONE, stale, [], D1);
  assert.deepEqual([decisionReason.view.state, decisionReason.view.reason], ['HISTORY_UNRESOLVED', 'RECEIPT_REMOVED']);
  assert.ok(decisionReason.view.runs, 'runs existe com razão de decisão: o cruzamento de resultados vem ANTES do cruzamento livro × decisões');
  assert.equal(decisionReason.needsFreshResults, true, 'e pede R2 mesmo assim');
  assert.equal(decisionReason.view.runs?.open?.recoverable, false, 'fora de PROTECTED, nenhum RUN_* (o RUN_ABORTED só em PROTECTED)');
  assert.equal(decisionReason.view.runs?.open?.stale, true);
  // decisões à frente (fase C de decisão) e decisões regredidas: idem
  for (const [label, confirmed, pending, reason] of [
    ['HISTORY_REGRESSED', [], null, 'HISTORY_REGRESSED'],
    ['UNLEDGERED_PENDING', [D1], refOf(2, D1.sha256, 'dec'), 'UNLEDGERED_PENDING'],
  ] as const) {
    const evaluation = evaluate(chain, seen([runRefOf(1, run?.runSha256 as string)]), stale, confirmed, pending);
    assert.deepEqual([evaluation.view.state, evaluation.view.reason], ['HISTORY_UNRESOLVED', reason], label);
    assert.equal(evaluation.view.runs?.state, 'OK', `${label}: runs presente`);
  }
  // runs UNRESOLVED (resultado confirmado sumiu): a fase A vencida não é anunciada como receita
  const regressed = evaluate(chain, NONE, { ...stale, resultsAfterLedger: NONE });
  assert.deepEqual([regressed.view.state, regressed.view.runs?.state, regressed.view.runs?.open?.phase, regressed.view.runs?.open?.recoverable], ['PROTECTED', 'UNRESOLVED', 'A', false]);
  // controle: PROTECTED, runs OK, fase A vencida ⇒ receita anunciada
  const healthy = evaluate(chain, seen([runRefOf(1, run?.runSha256 as string)]), stale);
  assert.deepEqual([healthy.view.state, healthy.view.runs?.state, healthy.view.runs?.open?.recoverable], ['PROTECTED', 'OK', true]);
});

test('RL-24 (R6-05): as TESTEMUNHAS vêm antes de qualquer receita de resultado — citação que não confere, indício que contradiz ou guarda divergente ⇒ sem runs, sem R2, nada anunciado', () => {
  const chain = base().run().runIntent();
  const [run] = runsOf(chain);
  const stale = { ageMsOf: () => 200_000 };
  const cited = { ledgerSeq: 3, sha256: 'e'.repeat(64) };
  const cases: Array<[string, ResultsEvidence, Partial<ProtectionInput>, string]> = [
    ['citação de resultado que não confere', seen([], null, { ledgerHeads: [cited] }), stale, 'RESULT_LEDGER_MISMATCH'],
    ['indício (pendente sem origem) que contradiz', seen([], null, { unverifiedLedgerHeads: [cited] }), stale, 'UNTRUSTED'],
    ['guarda externa divergente', NONE, { ...stale, guard: { status: 'READ', head: cited } }, 'GUARD_MISMATCH'],
  ];
  for (const [label, results, over, reason] of cases) {
    const evaluation = evaluate(chain, results, over);
    assert.deepEqual([evaluation.view.state, evaluation.view.reason], ['HISTORY_UNRESOLVED', reason], label);
    assert.equal(evaluation.view.runs, undefined, `${label}: sem runs (nenhuma receita de resultado pode ser oferecida)`);
    assert.equal(evaluation.needsFreshResults, false, `${label}: nem releitura`);
    assert.equal(evaluation.plan.kind, 'NONE', label);
  }
  // controle: sem desacordo, a mesma fase A vencida seria receita
  assert.equal(evaluate(chain, seen([runRefOf(1, run?.runSha256 as string)]), stale).view.runs?.open?.recoverable, true);
});

/* ------------------------------------------------------------------ serviço real: testemunha dos resultados (RunRef) e a vista */

test('testemunha dos resultados: createResultsKnownHeads entrega runs (ancorados e pendente, com origem julgada) e o serviço de decisões recusa runs malformados (UNTRUSTED, nunca "sem resultados")', async () => {
  const w = await ledgerWorld();
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const first = await sealResult(w, e);
  const read = await witnessOver(w, e)(w.auditId);
  assert.ok(read.ok);
  assert.deepEqual(read.runs, { anchored: [{ seq: 1, sha256: first.contentSha256, prevSha256: null, schemaVersion: 2, ledgerHead: first.ledgerHead, finalizedBy: 'ana@empresa.com', originProven: true }], pending: null });
  fs.rmSync(receiptPath(e, 1, w.auditId));
  const pending = await witnessOver(w, e)(w.auditId);
  assert.ok(pending.ok);
  assert.deepEqual([pending.runs?.anchored.length, pending.runs?.pending?.seq, pending.runs?.pending?.sha256], [0, 1, first.contentSha256]);

  const good = { seq: 1, sha256: hashOf('r1'), prevSha256: null, schemaVersion: 2, ledgerHead: null, finalizedBy: 'ana@empresa.com', originProven: true };
  const malformed: Array<[string, unknown]> = [
    ['runs não é objeto', 'x'],
    ['anchored não é lista', { anchored: {}, pending: null }],
    ['hash inválido', { anchored: [{ ...good, sha256: 'xyz' }], pending: null }],
    ['sequência com lacuna', { anchored: [{ ...good, seq: 2, prevSha256: hashOf('r0') }], pending: null }],
    ['encadeamento quebrado', { anchored: [good, { ...good, seq: 2, sha256: hashOf('r2'), prevSha256: hashOf('outro') }], pending: null }],
    ['pendente fora de ordem', { anchored: [good], pending: { ...good, seq: 3, sha256: hashOf('r3'), prevSha256: good.sha256 } }],
    ['origem sem booleano', { anchored: [{ ...good, originProven: 'sim' }], pending: null }],
    ['versão desconhecida', { anchored: [{ ...good, schemaVersion: 3 }], pending: null }],
    ['autor ausente', { anchored: [{ ...good, finalizedBy: '' }], pending: null }],
  ];
  for (const [label, runs] of malformed) {
    const provider: KnownHeadsProvider = async () => ({ ok: true, heads: [], unverifiedHeads: [], hasResults: true, ledgerHeads: [], unverifiedLedgerHeads: [], runs }) as never;
    const view = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: provider }).list(BIA, w.auditId, clock()));
    assert.deepEqual([view.witness.status, view.ledger.state, view.ledger.reason], ['UNTRUSTED', 'HISTORY_UNRESOLVED', 'RESULTS_EVIDENCE_UNAVAILABLE'], label);
  }
});

test('vista real: resultado + RUN_CONFIRMED ⇒ runs OK; recibo removido ⇒ RESULT_RECEIPT_REMOVED (decisões seguem vigentes, reemissão anunciada); resultado sumido ⇒ RESULT_REGRESSED', async () => {
  const w = await ledgerWorld();
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const run = await sealResult(w, e);
  await appendLedger(w, LEDGER_AUTH_A, ...runMakersFor(run));
  const healthy = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual(healthy.ledger.runs, { state: 'OK', reason: null, confirmed: [{ runSeq: 1, runSha256: run.contentSha256 }], open: null, receiptReissuable: false });
  fs.rmSync(receiptPath(e, 1, w.auditId));
  const removed = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([removed.ledger.state, removed.ledger.runs?.state, removed.ledger.runs?.reason, removed.ledger.runs?.receiptReissuable], ['PROTECTED', 'UNRESOLVED', 'RESULT_RECEIPT_REMOVED', true]);
  assert.deepEqual([removed.decisions.length, removed.finalizable], [1, true], 'as decisões seguem vigentes (D-21)');
  fs.chmodSync(runPath(e, 1, w.auditId), 0o644);
  fs.rmSync(runPath(e, 1, w.auditId));
  const regressed = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([regressed.ledger.state, regressed.ledger.runs?.state, regressed.ledger.runs?.reason, regressed.decisions.length], ['PROTECTED', 'UNRESOLVED', 'RESULT_REGRESSED', 1]);
});

test('RL-24 no serviço: resultado citando posição que não confere + RUN_INTENT vencido ⇒ sem runs; RECOVER e finalização não gravam nada (nenhum RUN_ABORTED, RUN_CONFIRMED ou recibo)', async () => {
  const w = await ledgerWorld();
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  await appendLedger(w, LEDGER_AUTH_A, runIntentMaker());
  const real = witnessOver(w, e);
  const lying: KnownHeadsProvider = async (auditId) => {
    const truth = await real(auditId);
    return truth.ok ? { ...truth, hasResults: true, ledgerHeads: [{ ledgerSeq: 2, sha256: 'e'.repeat(64) }] } : truth;
  };
  const LATER = '2026-12-01T00:00:00.000Z';
  const service = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, staleOperationMs: 1 }), knownHeads: lying });
  const view = await must(service.list(BIA, w.auditId, LATER));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.runs], ['HISTORY_UNRESOLVED', 'RESULT_LEDGER_MISMATCH', undefined]);
  const trees = () => ({ ledger: hashTree(w.ledgerDir), results: hashTree(e.base), anchors: hashTree(e.anchors) });
  const before = trees();
  const recover = await service.ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, LATER);
  assert.ok(!recover.ok && recover.code === 'DECISIONS_HISTORY_UNRESOLVED', JSON.stringify(recover).slice(0, 200));
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: service });
  const evaluated = await preview.evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok);
  const attempt = await makeService(e, preview).finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string });
  assert.ok(!attempt.ok && attempt.code === 'NOT_FINALIZABLE', JSON.stringify(attempt).slice(0, 200));
  assert.deepEqual(trees(), before, 'nada gravado em canal algum');
  assert.deepEqual((await ledgerRecords(w)).map((r) => r.event), ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT']);
  // controle: com a testemunha honesta, a mesma fase A vencida aparece como receita do resultado
  const honest = await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null, staleOperationMs: 1 }), knownHeads: real }).list(BIA, w.auditId, LATER));
  assert.deepEqual([honest.ledger.state, honest.ledger.runs?.open?.phase, honest.ledger.runs?.open?.stale, honest.ledger.runs?.open?.recoverable], ['PROTECTED', 'A', true, true]);
});
