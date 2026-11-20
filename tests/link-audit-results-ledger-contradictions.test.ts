import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { evaluateProtection, verifyTags, type DecisionRef, type LedgerRecord, type ProtectionInput, type ResultsEvidence } from '../src/lib/link-audit-ledger';
import type { ScoreRun } from '../src/lib/link-audit-scoring-runs/results-types';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { ANA, BIA, clock, hashTree, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { LEDGER_AUTH_A, ledgerFor, ledgerPath, ledgerRecords, ledgerWorld, refOf, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { sealResult, servicesOver } from './helpers/link-audit-ledger-results-fixtures';
import { bodyNow, finalizeAs, finalizerOver, openRunWorld, plantForgedRunReceipt, protectedWorld, runsOf } from './helpers/link-audit-results-ledger-finalize-fixtures';
import { appendLedger, chainOf, hashOf, runClosingMaker, runMakersFor, runRefOf, type Chain, type RunBody } from './helpers/link-audit-results-ledger-fixtures';
import { buildEvaluation, FakeEvaluator, makeService, OP_A, OP_B, receiptPath, resultsEnv, runPath, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R1.5 — CONTRADIÇÕES DE RESULTADO julgadas SÓ sobre R1 (spec §16.17.5; D-21): `UNLEDGERED_RESULT` (RL-08), `RESULT_DIVERGES` (RL-10) e `RESULT_PUBLISHED_AFTER_ABORT`
 * (o dono lento do RL-11). Vão em `ledger.reason` e CONGELAM também as decisões (`HISTORY_UNRESOLVED`: nada vigente, nada finalizável, consultas de resultados fechadas);
 * avaliadas DEPOIS das testemunhas (R6-05) e ANTES do cruzamento livro × decisões (M-R21). O que só R2 mostra nunca é acusado (M-R15). Livro truncado (RL-12).
 * As duas razões que o livro sozinho explica (`RESULT_REGRESSED`, `RESULT_RECEIPT_REMOVED`) continuam em `runs.reason` (M-R37). Chaves de TESTE, e-mails fictícios.
 */
registerCleanup();

const AUD = 'auditoria-contra-0005';
const D1 = refOf(1, null, 'dec');
const D2 = refOf(2, D1.sha256, 'dec');
const runOf = (record: LedgerRecord | undefined): RunBody => (record as unknown as { run: RunBody }).run;
const intents = (chain: Chain): RunBody[] => chain.records.filter((r) => r.event === 'RUN_INTENT').map(runOf);
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
const show = (value: unknown): string => JSON.stringify(value).slice(0, 300);

function evaluate(chain: Chain, results: ResultsEvidence, over: Partial<ProtectionInput> = {}, confirmed: readonly DecisionRef[] = [D1], pending: DecisionRef | null = null) {
  return evaluateProtection({
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
  });
}
const base = (): Chain => chainOf(AUD).genesis().decision(D1);
/** A contradição congela TUDO: estado e razão, sem `runs` (nenhuma receita de resultado), sem R2, sem plano de decisão nem de resultado. */
function assertFrozen(evaluation: ReturnType<typeof evaluate>, reason: string, label: string): void {
  assert.deepEqual([evaluation.view.state, evaluation.view.reason], ['HISTORY_UNRESOLVED', reason], label);
  assert.equal(evaluation.view.runs, undefined, `${label}: sem runs (contradição que congela as decisões, 16.17.2)`);
  assert.deepEqual([evaluation.plan.kind, evaluation.runPlan.kind, evaluation.needsFreshResults], ['NONE', 'NONE', false], label);
}

/* ------------------------------------------------------------------ modelo puro */

test('UNLEDGERED_RESULT (RL-08): sk em R1 sem RUN_INTENT vivo — ancorado, só pendente, além do último confirmado, v1 e cauda RUN_* removida — congela tudo', () => {
  const plain = base();
  for (const [label, results] of [
    ['s0001 + a0001 (resultado com recibo e sem livro)', seen([runRefOf(1, hashOf('forjado'))])],
    ['só s0001 (pendente forjada)', seen([], runRefOf(1, hashOf('forjado')))],
    ['s0001 v1 (sem ledgerHead) em auditoria protegida', seen([runRefOf(1, hashOf('v1'), { schemaVersion: 1 })])],
  ] as const) {
    assertFrozen(evaluate(plain, results), 'UNLEDGERED_RESULT', label);
  }
  // além do último confirmado: s0002 sem RUN_INTENT(2)
  const confirmed = base().run();
  const [first] = intents(confirmed);
  assertFrozen(evaluate(confirmed, seen([runRefOf(1, first?.runSha256 as string), runRefOf(2, hashOf('plantado'), { prevSha256: first?.runSha256 })])), 'UNLEDGERED_RESULT', 's0002 sem RUN_INTENT');
  assertFrozen(evaluate(confirmed, seen([runRefOf(1, first?.runSha256 as string)], runRefOf(2, hashOf('plantado'), { prevSha256: first?.runSha256 }))), 'UNLEDGERED_RESULT', 's0002 pendente sem RUN_INTENT');
  // a cauda RUN_* removida do livro: o resultado continua no disco e o livro não o conhece
  assertFrozen(evaluate(base(), seen([runRefOf(1, first?.runSha256 as string)])), 'UNLEDGERED_RESULT', 'RUN_INTENT + RUN_CONFIRMED removidos');
  // a operação aberta é de OUTRO número: o sk de k ≠ O.runSeq continua sem RUN_INTENT vivo
  const open = base().run().runIntent();
  const [r1, r2] = intents(open);
  assertFrozen(evaluate(open, seen([runRefOf(1, r1?.runSha256 as string), runRefOf(2, r2?.runSha256 as string, { prevSha256: r1?.runSha256 })], runRefOf(3, hashOf('y'), { prevSha256: r2?.runSha256 }))), 'UNLEDGERED_RESULT', 's0003 além da operação aberta s0002');
});

test('RESULT_DIVERGES (RL-10): sk com hash diferente do RUN_CONFIRMED(k) — com recibo coerente ou sem recibo — ou do RUN_INTENT aberto (e não de um abortado) congela tudo', () => {
  const chain = base().run();
  for (const [label, results] of [
    ['s0001 trocado, recibo coerente com o arquivo trocado', seen([runRefOf(1, hashOf('outro'))])],
    ['s0001 trocado, sem recibo', seen([], runRefOf(1, hashOf('outro')))],
  ] as const) {
    assertFrozen(evaluate(chain, results), 'RESULT_DIVERGES', label);
    // a mesma coisa vista SÓ em R2 continua sendo só dos resultados (L → R2 julga o que o livro cita; nunca a classe que congela)
    const onlyR2 = evaluate(chain, NONE, { resultsAfterLedger: results });
    assert.deepEqual([onlyR2.view.state, onlyR2.view.runs?.state, onlyR2.view.runs?.reason], ['PROTECTED', 'UNRESOLVED', 'RESULT_REGRESSED'], `${label} (só em R2)`);
  }
  const open = base().runIntent();
  const [intent] = intents(open);
  assertFrozen(evaluate(open, seen([], runRefOf(1, hashOf('outro')))), 'RESULT_DIVERGES', 'operação aberta com OUTRO conteúdo no nome (pendente)');
  assertFrozen(evaluate(open, seen([runRefOf(1, hashOf('outro'))])), 'RESULT_DIVERGES', 'operação aberta com OUTRO conteúdo no nome (com recibo)');
  // controle: o sk com o hash do RUN_INTENT é a fase B/C, nunca contradição
  assert.deepEqual([evaluate(open, seen([], runRefOf(1, intent?.runSha256 as string))).view.state, evaluate(open, seen([], runRefOf(1, intent?.runSha256 as string))).view.runs?.open?.phase], ['PROTECTED', 'B']);
});

test('RESULT_PUBLISHED_AFTER_ABORT: sk com o runSha256 de um RUN_ABORTED(k) e sem RUN_INTENT vivo com esse hash (dono lento) congela tudo; outro conteúdo no lugar é RESULT_DIVERGES', () => {
  const aborted = base().runIntent().runAbort();
  const [lost] = intents(aborted);
  assertFrozen(evaluate(aborted, seen([runRefOf(1, lost?.runSha256 as string)])), 'RESULT_PUBLISHED_AFTER_ABORT', 'abortado, sem operação aberta (com recibo)');
  assertFrozen(evaluate(aborted, seen([], runRefOf(1, lost?.runSha256 as string))), 'RESULT_PUBLISHED_AFTER_ABORT', 'abortado, sem operação aberta (sem recibo)');
  assertFrozen(evaluate(aborted, seen([], runRefOf(1, hashOf('nenhum')))), 'UNLEDGERED_RESULT', 'controle: hash que nenhum RUN_* cita');
  // nova tentativa do MESMO número aberta depois do aborto: o sk do abortado no lugar dela ⇒ publicado depois do aborto; um terceiro conteúdo ⇒ diverge
  const retried = base().runIntent().runAbort().runIntent();
  const [old, now] = intents(retried);
  assert.notEqual(old?.runSha256, now?.runSha256);
  assertFrozen(evaluate(retried, seen([], runRefOf(1, old?.runSha256 as string))), 'RESULT_PUBLISHED_AFTER_ABORT', 'abortado no lugar da nova tentativa');
  assertFrozen(evaluate(retried, seen([], runRefOf(1, hashOf('terceiro')))), 'RESULT_DIVERGES', 'terceiro conteúdo no lugar da nova tentativa');
  assert.deepEqual([evaluate(retried, seen([], runRefOf(1, now?.runSha256 as string))).view.runs?.open?.phase], ['B'], 'controle: o da nova tentativa é a fase B');
  // o casamento é com um abortado DO MESMO número: o hash de um abortado de k em outro número não o explica
  assertFrozen(evaluate(base().runIntent().runAbort(), seen([runRefOf(2, lost?.runSha256 as string)])), 'UNLEDGERED_RESULT', 'hash de abortado em outro número');
});

test('ordem: testemunhas (R6-05) antes; cruzamento de resultados antes do livro × decisões (M-R21) e antes da R2 indisponível; o que só R2 mostra nunca é acusado (M-R15)', () => {
  const plain = base();
  const forged = runRefOf(1, hashOf('forjado'));
  const cited = { ledgerSeq: 2, sha256: 'e'.repeat(64) };
  assertFrozen(evaluate(plain, seen([forged], null, { ledgerHeads: [cited] })), 'RESULT_LEDGER_MISMATCH', 'citação que não confere vence (testemunha primeiro)');
  assertFrozen(evaluate(plain, seen([forged]), { guard: { status: 'READ', head: cited } }), 'GUARD_MISMATCH', 'guarda divergente vence');
  // decisões também em desacordo: a razão de RESULTADO vem antes da de decisão
  assertFrozen(evaluate(plain, seen([forged]), {}, []), 'UNLEDGERED_RESULT', 'com as decisões regredidas');
  assertFrozen(evaluate(plain, seen([forged]), {}, [D1], D2), 'UNLEDGERED_RESULT', 'com decisão pendente sem INTENT');
  // a contradição julgada sobre R1 não depende de R2 (nem de ela ter falhado)
  assertFrozen(evaluate(plain, seen([forged]), { resultsAfterLedger: { ok: false } }), 'UNLEDGERED_RESULT', 'R2 indisponível');
  // R2 mostrando um resultado que R1 não mostrava (gravado depois da leitura do livro): nunca acusado
  const late = evaluate(plain, NONE, { resultsAfterLedger: seen([forged]) });
  assert.deepEqual([late.view.state, late.view.reason, late.view.runs?.state], ['PROTECTED', null, 'OK'], 'só R2: nada de UNLEDGERED_RESULT');
  const open = base().runIntent();
  const lateOther = evaluate(open, NONE, { resultsAfterLedger: seen([], runRefOf(1, hashOf('outro'))), ageMsOf: () => 500_000 });
  assert.deepEqual([lateOther.view.state, lateOther.view.runs?.open?.phase, lateOther.view.runs?.open?.recoverable], ['PROTECTED', 'A', false], 'só R2 com outro conteúdo: fase A sem receita, sem acusação');
});

test('M-R37: RESULT_REGRESSED e RESULT_RECEIPT_REMOVED ficam em runs.reason (decisões vigentes); as três contradições de R1 nunca aparecem em runs', () => {
  const chain = base().run();
  const [run] = intents(chain);
  const regressed = evaluate(chain, NONE, { resultsAfterLedger: NONE });
  assert.deepEqual([regressed.view.state, regressed.view.reason, regressed.view.runs?.reason], ['PROTECTED', null, 'RESULT_REGRESSED']);
  const removed = evaluate(chain, seen([], runRefOf(1, run?.runSha256 as string)), { resultsAfterLedger: seen([], runRefOf(1, run?.runSha256 as string)) });
  assert.deepEqual([removed.view.state, removed.view.reason, removed.view.runs?.reason], ['PROTECTED', null, 'RESULT_RECEIPT_REMOVED']);
});

test('runs.open.originKid: só o id PÚBLICO da chave de origem do sk cujo hash é o do RUN_INTENT aberto (B/C); fase A e conteúdo de outro hash ⇒ null', () => {
  const open = base().runIntent();
  const [intent] = intents(open);
  const sha = intent?.runSha256 as string;
  const kidB = evaluate(open, seen([], runRefOf(1, sha, { originKid: 'ok-test-a' })));
  assert.deepEqual([kidB.view.runs?.open?.phase, kidB.view.runs?.open?.originKid], ['B', 'ok-test-a']);
  const kidC = evaluate(open, seen([runRefOf(1, sha, { originKid: 'ok-test-b', originProven: false })]));
  assert.deepEqual([kidC.view.runs?.open?.phase, kidC.view.runs?.open?.originKid, kidC.view.runs?.open?.recoverable], ['C', 'ok-test-b', false], 'origem não comprovável (chave vencida): o kid é exatamente o que o portão do runbook procura');
  const unsigned = evaluate(open, seen([], runRefOf(1, sha, { originKid: null })));
  assert.equal(unsigned.view.runs?.open?.originKid, null, 'resultado sem etiqueta de origem');
  assert.equal(evaluate(open, NONE).view.runs?.open?.originKid, null, 'fase A');
  assert.equal(evaluate(open, NONE, { resultsAfterLedger: seen([], runRefOf(1, hashOf('outro'), { originKid: 'ok-test-z' })) }).view.runs?.open?.originKid, null, 'outro conteúdo só em R2: nunca o kid dele');
  assert.ok(!JSON.stringify(kidB.view).includes('@'), 'nenhuma identidade na vista');
});

/* ------------------------------------------------------------------ serviços reais sobre o disco */

const finalizer = (w: LedgerWorld, e: ResultsEnv) => finalizerOver(w, e);
async function readsOf(w: LedgerWorld, e: ResultsEnv, actor = OP_B) {
  const f = finalizer(w, e);
  return { list: await f.results.list(actor, w.auditId), get: await f.results.get(actor, w.auditId, 1) };
}
/** Contradição de R1 pelos serviços reais: decisões congeladas, prévia não finalizável, consultas 409 sem dado e nenhum disco tocado. */
async function assertFrozenEverywhere(w: LedgerWorld, e: ResultsEnv, reason: string, label: string): Promise<void> {
  const before = { ledger: hashTree(w.ledgerDir), results: hashTree(e.base), anchors: hashTree(e.anchors), decisions: hashTree(w.decisionsDir) };
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.runs], ['HISTORY_UNRESOLVED', reason, undefined], `${label}: ${show(view.ledger)}`);
  assert.deepEqual([view.decisions.length, view.operatorRecords.length, view.finalizable], [0, 0, false], `${label}: nenhuma decisão vigente (congela as decisões)`);
  const f = finalizer(w, e);
  const evaluated = await f.preview.evaluate(OP_A, w.auditId);
  assert.ok(evaluated.ok && !evaluated.value.payload.finalization.allowed, `${label}: prévia não finalizável`);
  const { list, get } = await readsOf(w, e);
  for (const [name, read] of [['list', list], ['get', get]] as const) {
    assert.ok(!read.ok, `${label}: ${name} sem dado`);
    assert.equal(read.code, 'RESULT_INTEGRITY', `${label}: ${name} ⇒ ${show(read)}`);
    assert.ok(read.issues.includes(`livro: ${reason}`), `${label}: ${name} diz a razão (${show(read.issues)})`);
    assert.ok(!('pending' in read), `${label}: ${name} nem a pendente`);
  }
  const recover = await servicesOver(w, e).ledgerAction(BIA, w.auditId, { action: 'RECOVER' }, clock());
  assert.ok(!recover.ok, `${label}: o RECOVER não grava nada sobre a contradição`);
  assert.deepEqual({ ledger: hashTree(w.ledgerDir), results: hashTree(e.base), anchors: hashTree(e.anchors), decisions: hashTree(w.decisionsDir) }, before, `${label}: nada gravado`);
}

test('RL-08 (serviços reais): s0001 + a0001 selados com etiqueta RUN válida e sem RUN_INTENT ⇒ HISTORY_UNRESOLVED/UNLEDGERED_RESULT, nada vigente, prévia não finalizável, list/get ⇒ RESULT_INTEGRITY', async () => {
  const { w, e } = await protectedWorld();
  await sealResult(w, e); // grava direto, SEM a porta do livro (só o atacante sem a chave do livro faria isto em produção)
  await assertFrozenEverywhere(w, e, 'UNLEDGERED_RESULT', 'par selado');
  // variante: só a pendente (sem recibo)
  fs.rmSync(receiptPath(e, 1, w.auditId));
  await assertFrozenEverywhere(w, e, 'UNLEDGERED_RESULT', 'só s0001');
});

test('RL-08 (variantes): resultado v1 em auditoria protegida e cauda RUN_* removida do livro ⇒ UNLEDGERED_RESULT', async () => {
  const v1 = await protectedWorld();
  const evaluation = buildEvaluation({ auditId: v1.w.auditId });
  const planted = await makeService(v1.e, new FakeEvaluator(evaluation)).finalize(OP_A, v1.w.auditId, { expectedHead: evaluation.decisions.head, expectedInputSha256: evaluation.inputSha256 as string });
  assert.ok(planted.ok, show(planted));
  assert.equal((await runsOf(v1.e, v1.w.auditId)).runs[0]?.schemaVersion, 1, 'formato v1 (sem ledgerHead)');
  await assertFrozenEverywhere(v1.w, v1.e, 'UNLEDGERED_RESULT', 'v1');

  const tail = await protectedWorld();
  const done = await finalizeAs(finalizer(tail.w, tail.e), OP_A, tail.w.auditId);
  assert.ok(done.ok, show(done));
  assert.deepEqual((await ledgerRecords(tail.w)).map((r) => r.event), ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT', 'RUN_CONFIRMED']);
  fs.rmSync(ledgerPath(tail.w, 5));
  fs.rmSync(ledgerPath(tail.w, 4));
  await assertFrozenEverywhere(tail.w, tail.e, 'UNLEDGERED_RESULT', 'cauda RUN_* removida');
});

/** Outro resultado VÁLIDO (selo, esquema e encadeamento) de MESMO número no lugar de `run` (quem escreve na pasta de resultados, sem nenhuma chave). */
function swapRun(e: ResultsEnv, auditId: string, run: ScoreRun, receipt: 'COHERENT' | 'REMOVED'): string {
  const { contentSha256: _hash, ...body } = run as unknown as Record<string, unknown>;
  void _hash;
  const other = seal({ ...body, finalizedAt: run.finalizedAt.replace(/\.\d{3}Z$/, '.999Z') }) as unknown as ScoreRun;
  fs.chmodSync(runPath(e, run.seq, auditId), 0o644);
  fs.writeFileSync(runPath(e, run.seq, auditId), serialize(other));
  fs.rmSync(receiptPath(e, run.seq, auditId));
  if (receipt === 'COHERENT') {
    const anchor = { schemaVersion: 1, kind: 'LINK_AUDIT_SCORE_RUN_ANCHOR', auditId, seq: run.seq, headSha256: other.contentSha256, anchoredAt: run.finalizedAt, prevAnchorSha256: null };
    fs.writeFileSync(receiptPath(e, run.seq, auditId), serialize(seal(anchor)), { mode: 0o444 });
  }
  return other.contentSha256;
}

test('RL-10 (serviços reais): s0001 trocado por outro resultado válido de mesmo número, com recibo coerente e sem recibo ⇒ RESULT_DIVERGES; X nunca é devolvido', async () => {
  for (const receipt of ['COHERENT', 'REMOVED'] as const) {
    const { w, e } = await protectedWorld();
    const done = await finalizeAs(finalizer(w, e), OP_A, w.auditId);
    assert.ok(done.ok, show(done));
    const [genuine] = (await runsOf(e, w.auditId)).runs;
    const forged = swapRun(e, w.auditId, genuine as ScoreRun, receipt);
    await assertFrozenEverywhere(w, e, 'RESULT_DIVERGES', `recibo ${receipt}`);
    const { list, get } = await readsOf(w, e, OP_A);
    assert.ok(!JSON.stringify([list, get]).includes(forged), `${receipt}: o hash de X nunca sai`);
  }
});

test('RESULT_PUBLISHED_AFTER_ABORT (serviços reais): RUN_INTENT abortado e o resultado com esse hash publicado depois (dono lento) ⇒ congela tudo; a finalização não grava nada', async () => {
  const { w, e } = await protectedWorld();
  const run = await sealResult(w, e);
  const [intent] = runMakersFor(run);
  await appendLedger(w, LEDGER_AUTH_A, intent, runClosingMaker('RUN_ABORTED'));
  await assertFrozenEverywhere(w, e, 'RESULT_PUBLISHED_AFTER_ABORT', 'dono lento');
  const f = finalizer(w, e);
  const attempt = await f.results.finalize(OP_A, w.auditId, await bodyNow(f, OP_A, w.auditId));
  assert.ok(!attempt.ok, show(attempt));
  assert.deepEqual((await ledgerRecords(w)).map((r) => r.event), ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT', 'RUN_ABORTED']);
});

test('RL-12 (livro truncado): sem o último RUN_CONFIRMED ⇒ fase C (o autor reconfirma, outro operador não); sem RUN_INTENT + RUN_CONFIRMED ⇒ UNLEDGERED_RESULT; sem a cabeça citada ⇒ RESULT_LEDGER_MISMATCH', async () => {
  const c = await protectedWorld();
  const done = await finalizeAs(finalizer(c.w, c.e), OP_A, c.w.auditId);
  assert.ok(done.ok, show(done));
  const [run] = (await runsOf(c.e, c.w.auditId)).runs;
  fs.rmSync(ledgerPath(c.w, 5)); // o RUN_CONFIRMED
  const view = await must(servicesOver(c.w, c.e).list(BIA, c.w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.runs?.state, view.ledger.runs?.open?.phase, view.ledger.runs?.confirmed], ['PROTECTED', 'OK', 'C', []], show(view.ledger));
  const { list, get } = await readsOf(c.w, c.e);
  assert.ok(list.ok, show(list));
  assert.deepEqual([list.value.results.length, list.value.head, list.value.pending?.seq, list.value.pending?.receipt, list.value.confirmation], [0, null, 1, 'PRESENT', 'LEDGER'], 'o recibo existe; o livro não confirma: nunca listado como confirmado');
  assert.ok(!get.ok && get.code === 'RESULT_PENDING_UNCONFIRMED' && get.pending?.receipt === 'PRESENT', show(get));
  const f = finalizer(c.w, c.e);
  const body = { expectedHead: run?.decisions.head ?? null, expectedInputSha256: run?.inputSha256 as string };
  const other = await f.results.finalize(OP_B, c.w.auditId, body);
  assert.ok(!other.ok && other.code === 'RESULT_PENDING_UNCONFIRMED', `outro operador não reconfirma: ${show(other)}`);
  const again = await f.results.finalize(OP_A, c.w.auditId, body);
  assert.ok(again.ok && again.value.recoveredPending, `o autor reconfirma: ${show(again)}`);
  const relisted = await finalizer(c.w, c.e).results.list(OP_B, c.w.auditId);
  assert.ok(relisted.ok && relisted.value.results.length === 1 && relisted.value.pending === null, show(relisted));

  const u = await protectedWorld();
  assert.ok((await finalizeAs(finalizer(u.w, u.e), OP_A, u.w.auditId)).ok);
  fs.rmSync(ledgerPath(u.w, 5));
  fs.rmSync(ledgerPath(u.w, 4));
  await assertFrozenEverywhere(u.w, u.e, 'UNLEDGERED_RESULT', 'sem o par');

  const m = await protectedWorld();
  assert.ok((await finalizeAs(finalizer(m.w, m.e), OP_A, m.w.auditId)).ok);
  for (const seq of [5, 4, 3]) fs.rmSync(ledgerPath(m.w, seq)); // o resultado cita o CONFIRMED (posição 3)
  await assertFrozenEverywhere(m.w, m.e, 'RESULT_LEDGER_MISMATCH', 'sem a cabeça citada');
});

test('RL-12 (com guarda sintética): sem o último RUN_CONFIRMED ⇒ GUARD_MISMATCH, nenhuma receita (nem reconfirmação do autor), consultas 409', async () => {
  const w = await ledgerWorld({ withGuard: true });
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  const f = finalizerOver(w, e, { ledger: { guard: w.guard } });
  const done = await finalizeAs(f, OP_A, w.auditId);
  assert.ok(done.ok, show(done));
  const [run] = (await runsOf(e, w.auditId)).runs;
  fs.rmSync(ledgerPath(w, 5));
  const view = await must(servicesOver(w, e, { ledger: ledgerFor(w) }).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.runs], ['HISTORY_UNRESOLVED', 'GUARD_MISMATCH', undefined], show(view.ledger));
  const g = finalizerOver(w, e, { ledger: { guard: w.guard } });
  const before = { ledger: hashTree(w.ledgerDir), anchors: hashTree(e.anchors) };
  const list = await g.results.list(OP_B, w.auditId);
  assert.ok(!list.ok && list.code === 'RESULT_INTEGRITY' && list.issues.includes('livro: GUARD_MISMATCH'), show(list));
  const author = await g.results.finalize(OP_A, w.auditId, { expectedHead: run?.decisions.head ?? null, expectedInputSha256: run?.inputSha256 as string });
  assert.ok(!author.ok, `nenhuma receita, nem para o autor: ${show(author)}`);
  assert.deepEqual({ ledger: hashTree(w.ledgerDir), anchors: hashTree(e.anchors) }, before, 'nada gravado');
});

test('RL-03 (espelho do RV3A-1, sem ação nenhuma): recibo FORJADO da pendente legítima em B ⇒ list não a traz em results (receipt PRESENT, head null), get ⇒ RESULT_PENDING_UNCONFIRMED; vista em fase C, PROTECTED', async () => {
  const { w, e, run } = await openRunWorld('B');
  plantForgedRunReceipt(e, w.auditId, run);
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.runs?.open?.phase, view.ledger.runs?.confirmed], ['PROTECTED', 'C', []]);
  const { list, get } = await readsOf(w, e);
  assert.ok(list.ok, show(list));
  assert.deepEqual([list.value.results, list.value.head, list.value.pending?.seq, list.value.pending?.receipt, list.value.pending?.contentSha256, list.value.confirmation], [[], null, 1, 'PRESENT', run.contentSha256, 'LEDGER']);
  assert.ok(!get.ok && get.code === 'RESULT_PENDING_UNCONFIRMED', show(get));
  assert.deepEqual([get.pending?.seq, get.pending?.receipt, get.pending?.blocksFinalization], [1, 'PRESENT', true]);
  // e a mesma operação em B legítima: pendente sem recibo
  const b = await openRunWorld('B');
  const reads = await readsOf(b.w, b.e);
  assert.ok(reads.list.ok && reads.list.value.pending?.receipt === 'MISSING' && reads.list.value.results.length === 0, show(reads.list));
});
