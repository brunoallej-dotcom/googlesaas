import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { KnownHeadsProvider, ResultsLedgerPort } from '../src/lib/link-audit-decisions';
import { evaluateProtection, verifyTags, type DecisionRef, type LedgerRecord, type ProtectionInput, type ResultsEvidence } from '../src/lib/link-audit-ledger';
import { createOriginAuthenticator } from '../src/lib/link-audit-origin';
import { RESULTS_HTTP_STATUS } from '../src/lib/link-audit-scoring-runs/results';
import type { ScoreRun } from '../src/lib/link-audit-scoring-runs/results-types';
import { clearStorageFatal, seal, serialize } from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, clock, hashTree, must, rec, registerCleanup, withAutoHead } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, LEDGER_AUTH_A, ledgerFor, ledgerRecords, ledgerWorld, refOf, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { servicesOver, witnessOver } from './helpers/link-audit-ledger-results-fixtures';
import { OTHER_ORIGIN_KEY, TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_A, OP_B, receiptPath, runPath, type ResultsEnv } from './helpers/link-audit-results-fixtures';
import { chainOf, runRefOf, type Chain, type RunBody } from './helpers/link-audit-results-ledger-fixtures';
import { bodyNow, everythingOf, finalizeAs, finalizerOver, openRunWorld, protectedWorld, runsOf, type FinalizerOver } from './helpers/link-audit-results-ledger-finalize-fixtures';

/*
 * R1.6 — REEMISSÃO DO RECIBO DE RESULTADO CONFIRMADO (spec do livro §16.17.5, "Reemissão do recibo de resultado confirmado", MAJOR-3; D-10, D-12, D-R1-2). Um recibo `ak`
 * removido DEPOIS do `RUN_CONFIRMED(k)` deixa só os resultados fechados (`runs.state = UNRESOLVED`, `RESULT_RECEIPT_REMOVED`; as decisões seguem vigentes). A saída é a ação
 * PRÓPRIA `POST …/results {"action":"REISSUE_RECEIPT"}`, de QUALQUER operador: só os passos 0, 1 e 1b e a reemissão (nunca o `build`, nunca a avaliação), sem origem, sem
 * reconferências e sem registro no livro; regrava o recibo de MESMO `headSha256`, sincroniza ESTRITAMENTE recibos, resultados, os diretórios-pai e o livro, e responde 200 com a
 * vista atualizada. A finalização nunca reemite (M-R38). Conferências antes de qualquer gravação (espelho da reemissão do recibo de DECISÃO depois da revisão da R1.2): as
 * testemunhas R6-05 (sem elas não há `runs`), a testemunha das DECISÕES resolvida (R7-06) e a releitura R2 dos resultados, que é a única leitura que julga o recibo removido.
 * Cobre RL-09, RL-24 (ação), RL-33 e RL-20 (reemissão), M-R15 (receita), M-R17 (reemissão), M-R20, M-R22 (1b da ação) e M-R38. Pastas reais em diretórios temporários, chaves de
 * TESTE, e-mails fictícios `@empresa.com`, nenhuma rede.
 */
registerCleanup();
test.afterEach(() => clearStorageFatal());

const show = (value: unknown): string => JSON.stringify(value).slice(0, 360);
const ACTION = { action: 'REISSUE_RECEIPT' } as const;
const REMEDY = /livro: RESULT_RECEIPT_REMOVED — o recibo de um resultado já confirmado pelo livro foi removido\. Qualquer operador pode reemiti-lo pela ação 'Reemitir recibo do resultado' no painel do livro de cabeças; nada foi gravado\./;
const codeOf = (result: { ok: boolean }): string | null => (result.ok ? null : ((result as unknown as { code: string }).code ?? null));
const issuesOf = (result: { ok: boolean }): readonly string[] => (result.ok ? [] : ((result as unknown as { issues: readonly string[] }).issues ?? []));

/** Auditoria protegida com `n` resultados confirmados PELO LIVRO (finalizados por Ana; um `naModel` entre eles para o segundo ser um pedido novo). */
async function confirmedWorld(n: 1 | 2 = 1, options: Parameters<typeof protectedWorld>[0] = {}): Promise<{ w: LedgerWorld; e: ResultsEnv; runs: readonly ScoreRun[] }> {
  const { w, e } = await protectedWorld(options);
  for (let index = 0; index < n; index += 1) {
    if (index > 0) await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
    const done = await finalizeAs(finalizerOver(w, e), OP_A, w.auditId);
    assert.ok(done.ok, show(done));
  }
  const { runs, pending } = await runsOf(e, w.auditId);
  assert.deepEqual([runs.length, pending], [n, null]);
  return { w, e, runs };
}
const removeReceipt = (e: ResultsEnv, auditId: string, seq: number): void => fs.rmSync(receiptPath(e, seq, auditId));
const receiptOf = (e: ResultsEnv, auditId: string, seq: number): { seq: number; headSha256: string; prevAnchorSha256: string | null; contentSha256: string } => JSON.parse(fs.readFileSync(receiptPath(e, seq, auditId), 'utf8'));
const viewOf = async (w: LedgerWorld, e: ResultsEnv) => (await must(servicesOver(w, e).list(BIA, w.auditId, clock()))).ledger;
const reissueAs = (w: LedgerWorld, e: ResultsEnv, actor = OP_B, over: FinalizerOver = {}) => finalizerOver(w, e, over).results.reissueReceipt(actor, w.auditId, ACTION);

/** A reemissão deu certo: 200 com a vista atualizada (runs OK, nada a reemitir), o recibo de MESMO headSha256 encadeado, livro inalterado e os resultados consultáveis de novo. */
async function assertReissued(w: LedgerWorld, e: ResultsEnv, done: Awaited<ReturnType<typeof reissueAs>>, run: ScoreRun, ledgerBefore: Record<string, string>, label: string): Promise<void> {
  assert.ok(done.ok, `${label}: ${show(done)}`);
  assert.equal(done.value.action, 'REISSUE_RECEIPT', `${label}: resposta da D-R1-2`);
  assert.deepEqual([done.value.ledger.runs?.state, done.value.ledger.runs?.reason, done.value.ledger.runs?.receiptReissuable], ['OK', null, false], `${label}: vista atualizada`);
  const receipt = receiptOf(e, w.auditId, run.seq);
  assert.equal(receipt.headSha256, run.contentSha256, `${label}: recibo de MESMO headSha256`);
  const previous = run.seq > 1 ? receiptOf(e, w.auditId, run.seq - 1).contentSha256 : null;
  assert.equal(receipt.prevAnchorSha256, previous, `${label}: encadeado ao recibo anterior`);
  assert.deepEqual(hashTree(w.ledgerDir), ledgerBefore, `${label}: NENHUM registro no livro (D-10)`);
  const read = await runsOf(e, w.auditId);
  assert.deepEqual([read.runs.length, read.pending], [run.seq, null], `${label}: o resultado volta a ter recibo`);
  const list = await finalizerOver(w, e).results.list(OP_B, w.auditId);
  assert.ok(list.ok && list.value.confirmation === 'LEDGER' && list.value.head?.sha256 === run.contentSha256, `${label}: consultável de novo: ${show(list)}`);
}

/* ============================================================================ modelo: a receita REISSUE_RUN_RECEIPT */

const AUD = 'auditoria-reissue-01';
const D1 = refOf(1, null, 'dec');
const runOf = (record: LedgerRecord | undefined): RunBody => (record as unknown as { run: RunBody }).run;
const runsIn = (chain: Chain) => chain.records.filter((r) => r.event === 'RUN_INTENT').map(runOf);
const NONE: ResultsEvidence = { ok: true, hasResults: false, ledgerHeads: [], unverifiedLedgerHeads: [] };
type Ref = ReturnType<typeof runRefOf>;
const seen = (anchored: readonly Ref[], pending: Ref | null = null, over: Partial<Extract<ResultsEvidence, { ok: true }>> = {}): ResultsEvidence => ({ ok: true, hasResults: anchored.length > 0 || pending !== null, ledgerHeads: [], unverifiedLedgerHeads: [], runs: { anchored, pending }, ...over });
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
const planOf = (evaluation: ReturnType<typeof evaluate>): { kind: string; runSeq?: number; runSha256?: string } => {
  const plan = evaluation.runPlan as unknown as { kind: string; confirmed?: { runSeq: number; runSha256: string } };
  return { kind: plan.kind, ...(plan.confirmed ? { runSeq: plan.confirmed.runSeq, runSha256: plan.confirmed.runSha256 } : {}) };
};

test('modelo / M-R15 / M-R20: REISSUE_RUN_RECEIPT só com RESULT_RECEIPT_REMOVED julgado sobre R2 (a releitura posterior ao livro), para o ÚLTIMO resultado confirmado; nunca sem R2, com RESULT_REGRESSED ou com runs OK', () => {
  const chain = chainOf(AUD).genesis().decision(D1).run();
  const [run] = runsIn(chain);
  const sha = run?.runSha256 as string;
  const removed = evaluate(chain, NONE, { resultsAfterLedger: seen([], runRefOf(1, sha)) });
  assert.deepEqual([removed.view.state, removed.view.runs?.reason, removed.view.runs?.receiptReissuable], ['PROTECTED', 'RESULT_RECEIPT_REMOVED', true]);
  assert.deepEqual(planOf(removed), { kind: 'REISSUE_RUN_RECEIPT', runSeq: 1, runSha256: sha }, 'a receita aponta o RUN_CONFIRMED cujo recibo sumiu');
  // sem R2 (só R1, lida ANTES do livro): o recibo removido é julgado de forma fechada para os resultados, mas NÃO há receita — a releitura posterior ao livro é obrigatória
  const r1only = evaluate(chain, seen([], runRefOf(1, sha)));
  assert.deepEqual([r1only.view.runs?.reason, r1only.needsFreshResults, planOf(r1only).kind], ['RESULT_RECEIPT_REMOVED', true, 'NONE']);
  // resultado sumido (RESULT_REGRESSED) não tem receita; com os dois problemas, vale RESULT_REGRESSED (sem receita)
  assert.equal(planOf(evaluate(chain, NONE, { resultsAfterLedger: NONE })).kind, 'NONE');
  // tudo ancorado: nada a reemitir pela receita
  assert.equal(planOf(evaluate(chain, seen([runRefOf(1, sha)]))).kind, 'NONE');
  // dois confirmados, recibo do ÚLTIMO removido: a receita aponta o segundo
  const two = chainOf(AUD).genesis().decision(D1).run().run();
  const [first, second] = runsIn(two);
  const lastRemoved = evaluate(two, NONE, { resultsAfterLedger: seen([runRefOf(1, first?.runSha256 as string)], runRefOf(2, second?.runSha256 as string, { prevSha256: first?.runSha256 })) });
  assert.deepEqual(planOf(lastRemoved), { kind: 'REISSUE_RUN_RECEIPT', runSeq: 2, runSha256: second?.runSha256 });
});

test('modelo (16.17.5: "vale mesmo com HISTORY_UNRESOLVED por razão de DECISÃO"; RL-24): com razão de decisão a receita existe; sem runs (testemunha que não confere, contradição de R1) não há receita', () => {
  const chain = chainOf(AUD).genesis().decision(D1).run();
  const [run] = runsIn(chain);
  const sha = run?.runSha256 as string;
  const r2 = { resultsAfterLedger: seen([], runRefOf(1, sha)) };
  // recibo da DECISÃO 1 removido (razão de decisão) + recibo do resultado removido
  const decisionReason = evaluate(chain, NONE, r2, [], D1);
  assert.deepEqual([decisionReason.view.state, decisionReason.view.reason, decisionReason.view.runs?.reason], ['HISTORY_UNRESOLVED', 'RECEIPT_REMOVED', 'RESULT_RECEIPT_REMOVED']);
  assert.equal(planOf(decisionReason).kind, 'REISSUE_RUN_RECEIPT', 'o recibo de resultado não concede confiança nova: a receita vale com razão de decisão');
  // testemunha R6-05: resultado citando posição que não confere ⇒ sem runs ⇒ sem receita (RL-24)
  const witness = evaluate(chain, seen([], runRefOf(1, sha), { ledgerHeads: [{ ledgerSeq: 2, sha256: 'e'.repeat(64) }] }), r2);
  assert.deepEqual([witness.view.reason, witness.view.runs, planOf(witness).kind], ['RESULT_LEDGER_MISMATCH', undefined, 'NONE']);
  // contradição julgada sobre R1 (resultado de outro hash no número confirmado) ⇒ congela tudo, sem runs, sem receita
  const diverges = evaluate(chain, seen([], runRefOf(1, 'd'.repeat(64))), r2);
  assert.deepEqual([diverges.view.reason, diverges.view.runs, planOf(diverges).kind], ['RESULT_DIVERGES', undefined, 'NONE']);
});

/* ============================================================================ RL-09: recibo removido depois do RUN_CONFIRMED */

test('RL-09: sem a000k ⇒ runs UNRESOLVED/RESULT_RECEIPT_REMOVED, ledger PROTECTED, decisões vigentes; antes da ação a finalização e as consultas respondem RESULT_INTEGRITY com o TEXTO DE REMÉDIO e nada gravam (nem reemitem: M-R38)', async () => {
  const { w, e, runs } = await confirmedWorld();
  const [run] = runs;
  removeReceipt(e, w.auditId, 1);
  const decisions = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([decisions.ledger.state, decisions.ledger.runs?.state, decisions.ledger.runs?.reason, decisions.ledger.runs?.receiptReissuable], ['PROTECTED', 'UNRESOLVED', 'RESULT_RECEIPT_REMOVED', true]);
  assert.deepEqual([decisions.decisions.length, decisions.finalizable], [1, true], 'as decisões seguem vigentes (D-21)');
  const before = await everythingOf(w, e);
  const f = finalizerOver(w, e);
  // o reenvio IDÊNTICO do autor (o que a finalização faria se reemitisse como efeito colateral) e um pedido de outro operador
  const body = { expectedHead: (run as ScoreRun).decisions.head, expectedInputSha256: (run as ScoreRun).inputSha256 };
  for (const [label, actor] of [['autor, pedido idêntico', OP_A], ['outro operador', OP_B]] as const) {
    const refused = await f.results.finalize(actor, w.auditId, body);
    assert.equal(codeOf(refused), 'RESULT_INTEGRITY', `${label}: ${show(refused)}`);
    assert.ok(issuesOf(refused).some((issue) => REMEDY.test(issue)), `${label}: texto de remédio da 16.17.5: ${show(refused)}`);
  }
  for (const [label, read] of [['list', await f.results.list(OP_B, w.auditId)], ['get', await f.results.get(OP_B, w.auditId, 1)]] as const) {
    assert.equal(codeOf(read), 'RESULT_INTEGRITY', `${label}: ${show(read)}`);
    assert.ok(issuesOf(read).some((issue) => REMEDY.test(issue)), `${label}: texto de remédio: ${show(read)}`);
  }
  assert.deepEqual(await everythingOf(w, e), before, 'nada gravado: nem resultado, nem recibo, nem livro');
  // pedido NOVO (decisão nova, entrada diferente): também recusado com o remédio, sem gravar s0002 nem reemitir a0001
  await must(withAutoHead(servicesOver(w, e)).create(BIA, w.auditId, { record: rec.naModel() }, clock()));
  const middle = await everythingOf(w, e);
  const fresh = await f.results.finalize(OP_B, w.auditId, await bodyNow(f, OP_B, w.auditId));
  assert.equal(codeOf(fresh), 'RESULT_INTEGRITY', show(fresh));
  assert.ok(issuesOf(fresh).some((issue) => REMEDY.test(issue)), show(fresh));
  assert.deepEqual(await everythingOf(w, e), middle, 'pedido novo: nada gravado');
});

test('RL-09 / D-10 / D-R1-2: a reemissão de QUALQUER operador regrava o recibo de MESMO headSha256, sem registro novo no livro, capacidade igual, e responde 200 com a vista atualizada (runs OK)', async () => {
  const { w, e, runs } = await confirmedWorld();
  const [run] = runs;
  removeReceipt(e, w.auditId, 1);
  const ledgerBefore = hashTree(w.ledgerDir);
  const capacityBefore = (await viewOf(w, e)).capacity;
  const done = await reissueAs(w, e, OP_B);
  await assertReissued(w, e, done, run as ScoreRun, ledgerBefore, 'Bia');
  assert.ok(done.ok && JSON.stringify(done.value.ledger.capacity) === JSON.stringify(capacityBefore), 'capacidade igual (custo 0, D-10)');
  assert.ok(!JSON.stringify(done).includes('ana@empresa.com'), 'a vista nunca expõe a identidade do autor');
  assert.deepEqual(await ledgerRecords(w).then((records) => records.map((r) => r.event)), ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT', 'RUN_CONFIRMED']);
});

test('RL-09 (k = 2): recibo do último removido ⇒ reemitido encadeado ao a0001; o a0001 não muda', async () => {
  const { w, e, runs } = await confirmedWorld(2);
  const first = fs.readFileSync(receiptPath(e, 1, w.auditId), 'utf8');
  removeReceipt(e, w.auditId, 2);
  const ledgerBefore = hashTree(w.ledgerDir);
  await assertReissued(w, e, await reissueAs(w, e, OP_A), runs[1] as ScoreRun, ledgerBefore, 'k=2');
  assert.equal(fs.readFileSync(receiptPath(e, 1, w.auditId), 'utf8'), first, 'o recibo anterior não é tocado');
});

test('RL-09: sem s000k + a000k ⇒ RESULT_REGRESSED (decisões vigentes, sem receita): a ação responde 409 LEDGER_ACTION_INVALID e nada grava; as consultas seguem RESULT_INTEGRITY', async () => {
  const { w, e } = await confirmedWorld();
  removeReceipt(e, w.auditId, 1);
  fs.rmSync(runPath(e, 1, w.auditId));
  const view = await viewOf(w, e);
  assert.deepEqual([view.state, view.runs?.reason, view.runs?.receiptReissuable], ['PROTECTED', 'RESULT_REGRESSED', false]);
  const before = await everythingOf(w, e);
  const refused = await reissueAs(w, e);
  assert.equal(codeOf(refused), 'LEDGER_ACTION_INVALID', show(refused));
  assert.equal(RESULTS_HTTP_STATUS.LEDGER_ACTION_INVALID, 409, '16.17.5: "sem as condições ⇒ 409 LEDGER_ACTION_INVALID"');
  assert.ok(issuesOf(refused).some((issue) => /RESULT_REGRESSED/.test(issue)), show(refused));
  assert.deepEqual(await everythingOf(w, e), before, 'nada gravado');
  assert.equal(codeOf(await finalizerOver(w, e).results.list(OP_B, w.auditId)), 'RESULT_INTEGRITY');
});

/* ============================================================================ M-R20: as condições da reemissão */

test('M-R20: sem RUN_CONFIRMED a reemitir (nenhum resultado; operação aberta em B/C; auditoria não inscrita) ⇒ 409 LEDGER_ACTION_INVALID, nada gravado', async () => {
  const empty = await protectedWorld();
  const before = await everythingOf(empty.w, empty.e);
  assert.equal(codeOf(await reissueAs(empty.w, empty.e)), 'LEDGER_ACTION_INVALID', 'nenhum resultado confirmado');
  assert.deepEqual(await everythingOf(empty.w, empty.e), before);
  for (const phase of ['B', 'C'] as const) {
    const open = await openRunWorld(phase);
    const was = await everythingOf(open.w, open.e);
    const refused = await reissueAs(open.w, open.e);
    assert.equal(codeOf(refused), 'LEDGER_ACTION_INVALID', `fase ${phase}: a pendente só é concluída pelo autor (R1.4), nunca reemitida: ${show(refused)}`);
    assert.deepEqual(await everythingOf(open.w, open.e), was, `fase ${phase}: nada gravado`);
  }
  const pendingEnrollment = await ledgerWorld({ enroll: false });
  const notEnrolled = await finalizerOver(pendingEnrollment, (await protectedWorld()).e).results.reissueReceipt(OP_B, pendingEnrollment.auditId, ACTION);
  assert.equal(codeOf(notEnrolled), 'LEDGER_ACTION_INVALID', show(notEnrolled));
});

test('RL-24 na ação (M-R20, testemunhas ANTES): resultado citando posição do livro que não confere ⇒ sem runs ⇒ 409 LEDGER_ACTION_INVALID, nenhum recibo reemitido', async () => {
  const { w, e } = await confirmedWorld();
  removeReceipt(e, w.auditId, 1);
  const real = witnessOver(w, e);
  const lying: KnownHeadsProvider = async (auditId) => {
    const truth = await real(auditId);
    return truth.ok ? { ...truth, ledgerHeads: [...(truth.ledgerHeads ?? []), { ledgerSeq: 2, sha256: 'e'.repeat(64) }] } : truth;
  };
  const decisions = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: lying });
  const results = makeService(e, previewOver({ evidenceDir: w.evidenceDir, raw: decisions }), { ledger: decisions.resultsLedger as ResultsLedgerPort });
  const before = await everythingOf(w, e);
  const refused = await results.reissueReceipt(OP_B, w.auditId, ACTION);
  assert.equal(codeOf(refused), 'LEDGER_ACTION_INVALID', show(refused));
  assert.ok(issuesOf(refused).some((issue) => /RESULT_LEDGER_MISMATCH/.test(issue)), show(refused));
  assert.deepEqual(await everythingOf(w, e), before, 'nenhum recibo reemitido');
});

test('R7-06 (1), espelho da revisão da R1.2: testemunha das DECISÕES não resolvida ⇒ DECISIONS_HISTORY_UNRESOLVED, nada gravado (a ação não depende dela para ler, mas não grava sobre ela)', async () => {
  const { w, e } = await confirmedWorld();
  removeReceipt(e, w.auditId, 1);
  const real = witnessOver(w, e);
  // um resultado afirma uma cabeça de decisões que o histórico de hoje não tem (à frente): a testemunha das decisões fica HISTORY_REGRESSED; o livro e os resultados não mudam
  const ahead: KnownHeadsProvider = async (auditId) => {
    const truth = await real(auditId);
    return truth.ok ? { ...truth, heads: [...truth.heads, { seq: 7, sha256: 'f'.repeat(64) }] } : truth;
  };
  const decisions = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: ahead });
  assert.equal((await must(decisions.list(BIA, w.auditId, clock()))).ledger.runs?.reason, 'RESULT_RECEIPT_REMOVED', 'controle: a vista anuncia a reemissão');
  const results = makeService(e, previewOver({ evidenceDir: w.evidenceDir, raw: decisions }), { ledger: decisions.resultsLedger as ResultsLedgerPort });
  const before = await everythingOf(w, e);
  const refused = await results.reissueReceipt(OP_B, w.auditId, ACTION);
  assert.equal(codeOf(refused), 'DECISIONS_HISTORY_UNRESOLVED', show(refused));
  assert.deepEqual(await everythingOf(w, e), before, 'nada gravado');
});

test('16.17.5: a reemissão vale mesmo com ledger HISTORY_UNRESOLVED por razão de DECISÃO (recibo de decisão removido); o livro continua na razão de decisão e os resultados voltam a OK', async () => {
  const { w, e, runs } = await confirmedWorld();
  removeReceipt(e, w.auditId, 1);
  fs.rmSync(path.join(w.anchorDir, w.auditId, 'a0001.json'));
  const view = await viewOf(w, e);
  assert.deepEqual([view.state, view.reason, view.runs?.reason, view.runs?.receiptReissuable], ['HISTORY_UNRESOLVED', 'RECEIPT_REMOVED', 'RESULT_RECEIPT_REMOVED', true]);
  const ledgerBefore = hashTree(w.ledgerDir);
  const done = await reissueAs(w, e, OP_B);
  assert.ok(done.ok, show(done));
  assert.deepEqual([done.value.ledger.state, done.value.ledger.reason, done.value.ledger.runs?.state], ['HISTORY_UNRESOLVED', 'RECEIPT_REMOVED', 'OK']);
  assert.equal(receiptOf(e, w.auditId, 1).headSha256, (runs[0] as ScoreRun).contentSha256);
  assert.deepEqual(hashTree(w.ledgerDir), ledgerBefore, 'nenhum registro no livro (o RECEIPT_REISSUED da decisão é outra ação, só do autor)');
});

/* ============================================================================ M-R22: conferência objeto × livro da ação (passo 1b) */

/** O MESMO número com outro conteúdo VÁLIDO e encadeado (sem chave), para a leitura R0 do serviço de resultados; a testemunha do livro (outro FsOps) vê o genuíno. */
function forgeX(g: ScoreRun): string {
  const { contentSha256: _hash, ...body } = g as unknown as Record<string, unknown>;
  void _hash;
  return serialize(seal({ ...body, finalizedAt: g.finalizedAt.replace(/\.\d{3}Z$/, '.999Z') }));
}
function swappingRun(e: ResultsEnv, auditId: string, seq: number, x: string, times: number): { readonly fs: FsOps; readonly reads: () => number } {
  let reads = 0;
  const target = runPath(e, seq, auditId);
  return {
    reads: () => reads,
    fs: {
      ...nodeFsOps,
      async readFile(file, maxBytes) {
        if (file === target) {
          reads += 1;
          if (reads <= times) return x;
        }
        return nodeFsOps.readFile(file, maxBytes);
      },
    },
  };
}

test('M-R22 (persistente): R0 vê X no lugar do resultado confirmado e a vista vê G ⇒ relê até 3 vezes e recusa (LEDGER_ACTION_INVALID), nenhum recibo; o hash de X nunca sai', async () => {
  const { w, e, runs } = await confirmedWorld();
  const g = runs[0] as ScoreRun;
  removeReceipt(e, w.auditId, 1);
  const swap = swappingRun(e, w.auditId, 1, forgeX(g), Number.POSITIVE_INFINITY);
  const before = await everythingOf(w, e);
  const refused = await reissueAs(w, e, OP_B, { resultsFs: swap.fs });
  assert.equal(codeOf(refused), 'LEDGER_ACTION_INVALID', show(refused));
  assert.ok(issuesOf(refused).some((issue) => /não são os que o livro de cabeças confirma/.test(issue)), show(refused));
  assert.equal(swap.reads(), 3, 'R0 relida até 3 vezes antes de recusar');
  assert.deepEqual(await everythingOf(w, e), before, 'nada gravado');
});

test('M-R22 (transitório): a troca só na primeira leitura é resolvida pela releitura; o recibo reemitido é o do resultado que o livro confirma (G)', async () => {
  const { w, e, runs } = await confirmedWorld();
  const g = runs[0] as ScoreRun;
  removeReceipt(e, w.auditId, 1);
  const ledgerBefore = hashTree(w.ledgerDir);
  const swap = swappingRun(e, w.auditId, 1, forgeX(g), 1);
  await assertReissued(w, e, await reissueAs(w, e, OP_B, { resultsFs: swap.fs }), g, ledgerBefore, 'troca transitória');
  assert.ok(swap.reads() >= 2, 'houve releitura');
});

/* ============================================================================ RL-33: chave de origem vencida e autor ausente */

const at = (iso: string) => () => new Date(iso);

test('RL-33 (MAJOR-3): último resultado confirmado; chave de origem rotacionada e aposentada VENCIDA (relógio injetado); autor ausente; a000k removido ⇒ decisões vigentes e revogáveis; a reemissão de outro operador reemite e volta a runs OK', async () => {
  const { w, e, runs } = await confirmedWorld();
  const run = runs[0] as ScoreRun;
  removeReceipt(e, w.auditId, 1);
  // a chave que assinou s0001 foi aposentada e venceu: nada assinado por ela é comprovável hoje (KEY_EXPIRED)
  const rotated = createOriginAuthenticator({ current: OTHER_ORIGIN_KEY, retired: [`${TEST_ORIGIN_KEY}:2026-11-01`], now: at('2026-12-15T12:00:00Z') });
  assert.equal(rotated.verify('RUN', run), 'KEY_EXPIRED', 'controle: a origem de s0001 não é mais comprovável');
  const over: FinalizerOver = { origin: rotated, witnessOrigin: rotated };
  const f = finalizerOver(w, e, over);
  const view = await must(f.decisions.list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.runs?.reason, view.ledger.runs?.receiptReissuable, view.decisions.length, view.finalizable], ['PROTECTED', 'RESULT_RECEIPT_REMOVED', true, 1, true], 'decisões vigentes');
  // revogável por outro operador (o recibo removido de RESULTADO não congela as decisões, D-21)
  const revoked = await withAutoHead(f.decisions).revoke(BIA, w.auditId, { revokes: 'op-0001', reason: 'Revogada pelo operador: o juízo foi refeito depois da conferência.' }, clock());
  assert.ok(revoked.ok, show(revoked));
  // o autor (Ana) não age; Bia reemite — sem depender da chave de origem nem do autor
  const ledgerBefore = hashTree(w.ledgerDir);
  await assertReissued(w, e, await f.results.reissueReceipt(OP_B, w.auditId, ACTION), run, ledgerBefore, 'chave vencida, autor ausente');
});

test('RL-33 / M-R38: a reemissão não exige o autenticador de origem (serviço de resultados SEM chave de origem) nem o autor', async () => {
  const { w, e, runs } = await confirmedWorld();
  removeReceipt(e, w.auditId, 1);
  const f = finalizerOver(w, e);
  const withoutOrigin = makeService(e, f.preview, { ledger: f.decisions.resultsLedger as ResultsLedgerPort, origin: undefined });
  const ledgerBefore = hashTree(w.ledgerDir);
  await assertReissued(w, e, await withoutOrigin.reissueReceipt({ email: 'carla@empresa.com' }, w.auditId, ACTION), runs[0] as ScoreRun, ledgerBefore, 'sem chave de origem');
});

/* ============================================================================ corpo e configuração */

test('corpo ESTRITO `{"action":"REISSUE_RECEIPT"}`; identidade e auditId validados; sem a porta do livro ⇒ LEDGER_ACTION_INVALID; nada gravado em nenhum caso', async () => {
  const { w, e } = await confirmedWorld();
  removeReceipt(e, w.auditId, 1);
  const results = finalizerOver(w, e).results;
  const before = await everythingOf(w, e);
  const cases: ReadonlyArray<readonly [string, () => Promise<{ ok: boolean }>, string]> = [
    ['corpo vazio', () => results.reissueReceipt(OP_B, w.auditId, {}), 'INVALID_BODY'],
    ['outra ação', () => results.reissueReceipt(OP_B, w.auditId, { action: 'RECOVER' }), 'INVALID_BODY'],
    ['campo a mais', () => results.reissueReceipt(OP_B, w.auditId, { action: 'REISSUE_RECEIPT', expectedHead: null }), 'FORBIDDEN_FIELDS'],
    ['nulo', () => results.reissueReceipt(OP_B, w.auditId, null), 'INVALID_BODY'],
    ['lista', () => results.reissueReceipt(OP_B, w.auditId, [ACTION]), 'INVALID_BODY'],
    ['auditId inválido', () => results.reissueReceipt(OP_B, '../x', ACTION), 'INVALID_PARAMS'],
    ['identidade inválida', () => results.reissueReceipt({ email: 'sem-arroba' }, w.auditId, ACTION), 'OPERATOR_IDENTITY_INVALID'],
    ['sem a porta do livro', () => finalizerOver(w, e, { port: false }).results.reissueReceipt(OP_B, w.auditId, ACTION), 'LEDGER_ACTION_INVALID'],
  ];
  for (const [label, run, code] of cases) assert.equal(codeOf(await run()), code, label);
  assert.deepEqual(await everythingOf(w, e), before, 'nada gravado');
});

/* ============================================================================ RL-20 / M-R17: durabilidade da reemissão */

const fsyncFailure = (code: string): Error => Object.assign(new Error(`fsync simulado (${code})`), { code });
/** FsOps cujo fsync de `dir` falha, só depois de o recibo reemitido existir (a sincronização que o tornaria durável). */
function failingAfterReceipt(dir: string, receipt: string, code = 'EIO'): FsOps {
  return {
    ...nodeFsOps,
    async syncDirectory(target) {
      if (target === dir && fs.existsSync(receipt)) throw fsyncFailure(code);
      return nodeFsOps.syncDirectory(target);
    },
  };
}

test('RL-20 / M-R17 (reemissão): fsync falho na pasta de recibos, na de resultados, nas duas raízes ou no livro (pasta e raiz) ⇒ nunca sucesso, RESULT_DURABILITY_UNKNOWN, base trava; depois do reinício o MESMO pedido conclui sem duplicar o recibo', async () => {
  const targets: ReadonlyArray<readonly [string, (w: LedgerWorld, e: ResultsEnv) => FinalizerOver]> = [
    ['pasta de recibos da auditoria', (w, e) => ({ resultsFs: failingAfterReceipt(path.join(e.anchors, w.auditId), receiptPath(e, 1, w.auditId)) })],
    ['pasta de resultados da auditoria', (w, e) => ({ resultsFs: failingAfterReceipt(path.join(e.base, w.auditId), receiptPath(e, 1, w.auditId), 'ENOTSUP') })],
    ['raiz de resultados (pai)', (w, e) => ({ resultsFs: failingAfterReceipt(e.base, receiptPath(e, 1, w.auditId)) })],
    ['raiz de recibos (pai)', (w, e) => ({ resultsFs: failingAfterReceipt(e.anchors, receiptPath(e, 1, w.auditId), 'EINVAL') })],
    ['pasta do livro', (w, e) => ({ ledger: { fs: failingAfterReceipt(path.join(w.ledgerDir, w.auditId), receiptPath(e, 1, w.auditId)) } })],
    ['raiz do livro', (w, e) => ({ ledger: { fs: failingAfterReceipt(w.ledgerDir, receiptPath(e, 1, w.auditId)) } })],
  ];
  for (const [label, over] of targets) {
    const { w, e, runs } = await confirmedWorld();
    removeReceipt(e, w.auditId, 1);
    const done = await reissueAs(w, e, OP_B, over(w, e));
    assert.equal(codeOf(done), 'RESULT_DURABILITY_UNKNOWN', `${label}: ${show(done)}`);
    assert.deepEqual(issuesOf(done).filter((issue) => /[\\/]/.test(issue)), [], `${label}: sem caminho no texto`);
    // depois do reinício: o recibo já existe (a gravação veio antes do fsync); o MESMO pedido o ADOTA (nada é regravado), sincroniza e responde 200
    clearStorageFatal();
    const bytes = fs.readFileSync(receiptPath(e, 1, w.auditId), 'utf8');
    const again = await reissueAs(w, e, OP_B);
    assert.ok(again.ok && again.value.ledger.runs?.state === 'OK', `${label}: depois do reinício: ${show(again)}`);
    assert.equal(fs.readFileSync(receiptPath(e, 1, w.auditId), 'utf8'), bytes, `${label}: o recibo não é duplicado nem regravado`);
    assert.equal(receiptOf(e, w.auditId, 1).headSha256, (runs[0] as ScoreRun).contentSha256);
    clearStorageFatal();
  }
});

test('R7-04 / D1 (espelho): com o recibo já presente (runs OK) a ação não grava nada, mas só responde 200 depois de sincronizar recibos, resultados, os pais e o livro AGORA', async () => {
  const { w, e } = await confirmedWorld();
  const synced: string[] = [];
  const spy = (inner: FsOps): FsOps => ({ ...inner, async syncDirectory(target) { synced.push(target); return inner.syncDirectory(target); } });
  const before = await everythingOf(w, e);
  const done = await reissueAs(w, e, OP_B, { resultsFs: spy(nodeFsOps), ledger: { fs: spy(nodeFsOps) } });
  assert.ok(done.ok && done.value.ledger.runs?.state === 'OK', show(done));
  assert.deepEqual(await everythingOf(w, e), before, 'nada gravado (o recibo existente é ADOTADO, nunca regravado)');
  for (const dir of [path.join(e.anchors, w.auditId), path.join(e.base, w.auditId), e.anchors, e.base, path.join(w.ledgerDir, w.auditId), w.ledgerDir]) assert.ok(synced.includes(dir), `sincronizou ${path.basename(dir)}: ${show(synced.map((d) => path.basename(d)))}`);
});
