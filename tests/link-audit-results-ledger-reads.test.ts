import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { LedgerView, ResultsLedgerPort, ResultsLedgerRead } from '../src/lib/link-audit-decisions';
import { RESULTS_HTTP_STATUS, type ResultsFailure } from '../src/lib/link-audit-scoring-runs/results';
import type { ScoreRun } from '../src/lib/link-audit-scoring-runs/results-types';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { clearStorageFatal } from '../src/lib/link-audit-storage/files';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, BIA, clock, hashTree, must, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { decisionsOver, LEDGER_AUTH_A, ledgerFor, ledgerRecords, ledgerWorld, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { servicesOver, witnessOver } from './helpers/link-audit-ledger-results-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { bodyNow, failingLink, finalizeAs, finalizerOver, openRunWorld, protectedWorld, runsOf } from './helpers/link-audit-results-ledger-finalize-fixtures';
import { appendLedger, runIntentMaker } from './helpers/link-audit-results-ledger-fixtures';
import { buildEvaluation, FakeEvaluator, makeService, OP_A, OP_B, receiptPath, resultsEnv, runPath, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R1.5 — LEITURAS PELO LIVRO (spec §16.17.9; D-14, D-23; MINOR-3, MINOR-4). `list`/`get` só devolvem como CONFIRMADO o objeto cujo hash é o do `RUN_CONFIRMED` (conferido no
 * próprio objeto, M-R19/M-R22); a operação aberta em B/C sai como pendente (`receipt` MISSING/PRESENT); R0 e a vista são relidas até 3 vezes e a diferença persistente é
 * RESULT_INTEGRITY (RL-31, RL-35). A vista vem de uma leitura do livro que NÃO depende das evidências (RL-27). Disponibilidade ⇒ 503, integridade ⇒ 409, sem dado (RL-39,
 * M-R34). Sem prova do livro: `RECEIPT_ONLY` só no legado comprovado e sem a porta (RL-26, RL-38, M-R35). Pastas reais, chaves de TESTE, e-mails fictícios, sem rede.
 */
registerCleanup();

const show = (value: unknown): string => JSON.stringify(value).slice(0, 300);
const failed = (value: { ok: boolean }): ResultsFailure => {
  assert.ok(!value.ok, `esperava recusa: ${show(value)}`);
  return value as unknown as ResultsFailure;
};

/* ------------------------------------------------------------------ RL-26 / RL-38: sem prova do livro ⇒ RECEIPT_ONLY (e só aí) */

test('RL-26: sem a porta do livro (6C isolada, NOT_REQUIRED) as leituras seguem iguais, marcadas RECEIPT_ONLY; a pendente continua sem recibo (MISSING)', async () => {
  const e = resultsEnv();
  const evaluation = buildEvaluation();
  const service = makeService(e, new FakeEvaluator(evaluation));
  assert.ok((await service.finalize(OP_A, evaluation.payload.auditId, { expectedHead: evaluation.decisions.head, expectedInputSha256: evaluation.inputSha256 as string })).ok);
  const list = await service.list(OP_B, evaluation.payload.auditId);
  assert.ok(list.ok, show(list));
  assert.deepEqual([list.value.confirmation, list.value.results.length, list.value.pending], ['RECEIPT_ONLY', 1, null]);
  const get = await service.get(OP_B, evaluation.payload.auditId, 1);
  assert.ok(get.ok && get.value.confirmation === 'RECEIPT_ONLY', show(get));
  fs.rmSync(receiptPath(e, 1));
  const pending = await service.list(OP_B, evaluation.payload.auditId);
  assert.ok(pending.ok && pending.value.confirmation === 'RECEIPT_ONLY' && pending.value.results.length === 0 && pending.value.pending?.receipt === 'MISSING', show(pending));
});

/** Grava um resultado v1 (sem `ledgerHead`), como a 6C antes do livro: o serviço sem a porta, com uma avaliação cuja vista do livro é `NOT_REQUIRED`. */
async function plantV1(w: LedgerWorld, e: ResultsEnv): Promise<ScoreRun> {
  const evaluation = buildEvaluation({ auditId: w.auditId });
  const done = await makeService(e, new FakeEvaluator(evaluation)).finalize(OP_A, w.auditId, { expectedHead: evaluation.decisions.head, expectedInputSha256: evaluation.inputSha256 as string });
  assert.ok(done.ok, show(done));
  const run = (await runsOf(e, w.auditId)).runs[0] as ScoreRun;
  assert.deepEqual([run.schemaVersion, run.ledgerHead], [1, undefined]);
  return run;
}

test('RL-26 (LEGACY_READ_ONLY): auditoria com histórico e sem livro ⇒ leituras v1 marcadas RECEIPT_ONLY; nenhuma finalização nem conclusão', async () => {
  const w = await ledgerWorld();
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  fs.rmSync(path.join(w.ledgerDir, w.auditId), { recursive: true });
  const run = await plantV1(w, e);
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.reason], ['LEGACY_READ_ONLY', 'LEDGER_ABSENT_WITH_HISTORY']);
  const f = finalizerOver(w, e);
  const list = await f.results.list(OP_B, w.auditId);
  assert.ok(list.ok, show(list));
  assert.deepEqual([list.value.confirmation, list.value.results.map((r) => r.contentSha256)], ['RECEIPT_ONLY', [run.contentSha256]]);
  const get = await f.results.get(OP_B, w.auditId, 1);
  assert.ok(get.ok && get.value.confirmation === 'RECEIPT_ONLY', show(get));
  const before = { ledger: hashTree(w.ledgerDir), results: hashTree(e.base) };
  const attempt = await f.results.finalize(OP_A, w.auditId, await bodyNow(f, OP_A, w.auditId));
  assert.ok(!attempt.ok, `legado não finaliza: ${show(attempt)}`);
  // a conclusão de uma pendente v1 do legado também é recusada (o reenvio idêntico do arquivo plantado)
  fs.rmSync(receiptPath(e, 1, w.auditId));
  const conclude = await f.results.finalize(OP_A, w.auditId, { expectedHead: run.decisions.head, expectedInputSha256: run.inputSha256 });
  assert.ok(!conclude.ok && conclude.code === 'LEDGER_LEGACY_READ_ONLY', show(conclude));
  assert.deepEqual({ ledger: hashTree(w.ledgerDir), results: hashTree(e.base) }, { ledger: before.ledger, results: before.results }, 'nada gravado no livro nem em resultados');
  assert.ok(!fs.existsSync(receiptPath(e, 1, w.auditId)), 'nenhum recibo dado à pendente do legado');
});

test('RL-38 (rebaixamento a legado, MINOR-4): livro apagado de auditoria INSCRITA sem resultados + s0001/a0001 v1 plantados ⇒ LEGACY_READ_ONLY e list com confirmation RECEIPT_ONLY (nunca LEDGER)', async () => {
  const w = await ledgerWorld(); // inscrita (GENESIS), nenhuma decisão, nenhum resultado
  const e = resultsEnv();
  fs.rmSync(path.join(w.ledgerDir, w.auditId), { recursive: true });
  await plantV1(w, e);
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.equal(view.ledger.state, 'LEGACY_READ_ONLY');
  const list = await finalizerOver(w, e).results.list(OP_B, w.auditId);
  assert.ok(list.ok && list.value.confirmation === 'RECEIPT_ONLY' && list.value.results.length === 1, show(list));
});

test('livro apagado depois de um resultado CONFIRMADO PELO LIVRO (v2 cita o livro) ⇒ LEDGER_REMOVED_WITNESSED ⇒ 409, nunca RECEIPT_ONLY', async () => {
  const { w, e } = await protectedWorld();
  assert.ok((await finalizeAs(finalizerOver(w, e), OP_A, w.auditId)).ok);
  fs.rmSync(path.join(w.ledgerDir, w.auditId), { recursive: true });
  const list = failed(await finalizerOver(w, e).results.list(OP_B, w.auditId));
  assert.deepEqual([list.code, list.issues], ['RESULT_INTEGRITY', ['livro: LEDGER_REMOVED_WITNESSED']]);
});

/* ------------------------------------------------------------------ RL-27: a vista não depende das evidências */

test('RL-27: evidências ILEGÍVEIS e livro legível ⇒ a consulta continua (confirmada pelo livro, stale null); livro ILEGÍVEL ⇒ 503 RESULTS_STORAGE_UNAVAILABLE, sem dado', async () => {
  const { w, e } = await protectedWorld();
  assert.ok((await finalizeAs(finalizerOver(w, e), OP_A, w.auditId)).ok);
  const brokenReader = new Proxy(w.reader, {
    get: (target, key) => (key === 'getIntegrity' || key === 'listVersions' ? async () => Promise.reject(new Error('EIO simulado nas evidências')) : Reflect.get(target, key)),
  });
  const decisions = decisionsOver({ ...w, reader: brokenReader }, { ledger: ledgerFor(w, { guard: null }), knownHeads: witnessOver(w, e) });
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: decisions });
  assert.equal((await preview.evaluate(OP_A, w.auditId).catch(() => ({ ok: false }))).ok, false, 'controle: a prévia (evidências) não lê');
  const service = makeService(e, preview, { ledger: decisions.resultsLedger as ResultsLedgerPort });
  const list = await service.list(OP_B, w.auditId);
  assert.ok(list.ok, show(list));
  assert.deepEqual([list.value.confirmation, list.value.results.length, list.value.results[0]?.stale, list.value.results[0]?.decisionsChanged, list.value.currentInputSha256], ['LEDGER', 1, null, null, null]);
  const get = await service.get(OP_B, w.auditId, 1);
  assert.ok(get.ok && get.value.stale === null && get.value.confirmation === 'LEDGER', show(get));

  // livro ilegível (E/S na listagem da pasta do livro): disponibilidade, nunca "sem livro"
  const unreadable = faulty({
    async readdir(dir) {
      if (dir.startsWith(w.ledgerDir)) throw errno('EIO');
      return nodeFsOps.readdir(dir);
    },
  });
  const blind = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, fs: unreadable }), knownHeads: witnessOver(w, e) });
  const refused = failed(await makeService(e, previewOver({ evidenceDir: w.evidenceDir, raw: blind }), { ledger: blind.resultsLedger as ResultsLedgerPort }).list(OP_B, w.auditId));
  assert.deepEqual([refused.code, RESULTS_HTTP_STATUS[refused.code], refused.issues, 'pending' in refused], ['RESULTS_STORAGE_UNAVAILABLE', 503, ['livro: UNAVAILABLE'], false]);
});

test('a vista das consultas NUNCA vira "sem livro" quando o histórico de decisões não é lido: disponibilidade ⇒ 503, integridade ⇒ 409 (diferente de ledgerViewOf, que devolve NOT_REQUIRED)', async () => {
  const { w, e } = await protectedWorld();
  assert.ok((await finalizeAs(finalizerOver(w, e), OP_A, w.auditId)).ok);
  const decisionsIo = faulty({
    async readdir(dir) {
      if (dir.startsWith(w.decisionsDir)) throw errno('EIO');
      return nodeFsOps.readdir(dir);
    },
  });
  const unavailable = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: witnessOver(w, e), fs: decisionsIo });
  const read = await (unavailable.resultsLedger as ResultsLedgerPort).view({ auditId: w.auditId, nowIso: clock() });
  assert.ok(read.kind !== 'VIEW', `nunca uma vista (muito menos NOT_REQUIRED): ${show(read)}`);
  const refused = failed(await makeService(e, previewOver({ evidenceDir: w.evidenceDir, raw: unavailable }), { ledger: unavailable.resultsLedger as ResultsLedgerPort }).list(OP_B, w.auditId));
  assert.ok(['RESULTS_STORAGE_UNAVAILABLE', 'RESULT_INTEGRITY'].includes(refused.code), show(refused));
  // integridade das decisões (arquivo de decisão reescrito): 409
  const entry = path.join(w.decisionsDir, w.auditId, 'd0001.json');
  fs.chmodSync(entry, 0o644);
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace('"recordedBy"', '"recordedBy" '));
  const tampered = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: witnessOver(w, e) });
  const integrity = await (tampered.resultsLedger as ResultsLedgerPort).view({ auditId: w.auditId, nowIso: clock() });
  assert.equal(integrity.kind, 'INTEGRITY', show(integrity));
  const listed = failed(await makeService(e, previewOver({ evidenceDir: w.evidenceDir, raw: tampered }), { ledger: tampered.resultsLedger as ResultsLedgerPort }).list(OP_B, w.auditId));
  assert.equal(listed.code, 'RESULT_INTEGRITY');
});

/* ------------------------------------------------------------------ RL-39 / M-R34: disponibilidade × integridade, razão a razão */

const view = (over: Partial<LedgerView>): LedgerView => ({
  state: 'HISTORY_UNRESOLVED',
  reason: null,
  head: null,
  decisionHead: null,
  confirmedDecisions: 0,
  openOperation: null,
  recoverable: false,
  receiptReissuable: false,
  externalGuard: 'NOT_CONFIGURED',
  ...over,
});
const OK_RUNS = { state: 'OK' as const, reason: null, confirmed: [], open: null, receiptReissuable: false };
/** Porta de leitura FALSA (só `view`): o serviço de resultados decide sozinho o que a vista permite. Os passos de escrita nunca são chamados por `list`/`get`. */
const portSaying = (read: ResultsLedgerRead | (() => Promise<ResultsLedgerRead>)): ResultsLedgerPort => {
  const never = async (): Promise<never> => {
    throw new Error('as consultas não gravam');
  };
  return { view: typeof read === 'function' ? read : async () => read, context: never, intent: never, gate: never, confirmed: never, conclude: never };
};

test('RL-39 / M-R34: cada razão de DISPONIBILIDADE ⇒ 503 RESULTS_STORAGE_UNAVAILABLE e cada razão de INTEGRIDADE ⇒ 409 RESULT_INTEGRITY, com `livro: <razão>` e nenhum dado; razão de decisão com runs resolvido segue consultável', async () => {
  const e = resultsEnv();
  const evaluation = buildEvaluation();
  const auditId = evaluation.payload.auditId;
  const cases: Array<[string, ResultsLedgerRead, 'RESULTS_STORAGE_UNAVAILABLE' | 'RESULT_INTEGRITY' | 'OK', string | null]> = [
    ...(['NOT_CONFIGURED', 'UNAVAILABLE', 'DURABILITY_UNKNOWN', 'GUARD_UNAVAILABLE', 'RESULTS_EVIDENCE_UNAVAILABLE'] as const).map((reason): [string, ResultsLedgerRead, 'RESULTS_STORAGE_UNAVAILABLE', string] => [reason, { kind: 'VIEW', view: view({ reason }) }, 'RESULTS_STORAGE_UNAVAILABLE', `livro: ${reason}`]),
    ...(['UNTRUSTED', 'KEY_REVOKED', 'KEY_EXPIRED', 'KEY_UNKNOWN', 'LEDGER_REMOVED_WITNESSED', 'RESULT_LEDGER_MISMATCH', 'GUARD_MISMATCH', 'UNLEDGERED_RESULT', 'RESULT_DIVERGES', 'RESULT_PUBLISHED_AFTER_ABORT'] as const).map((reason): [string, ResultsLedgerRead, 'RESULT_INTEGRITY', string] => [reason, { kind: 'VIEW', view: view({ reason }) }, 'RESULT_INTEGRITY', `livro: ${reason}`]),
    ...(['RESULT_REGRESSED', 'RESULT_RECEIPT_REMOVED'] as const).map((reason): [string, ResultsLedgerRead, 'RESULT_INTEGRITY', string] => [`runs.${reason}`, { kind: 'VIEW', view: view({ state: 'PROTECTED', runs: { ...OK_RUNS, state: 'UNRESOLVED', reason, receiptReissuable: reason === 'RESULT_RECEIPT_REMOVED' } }) }, 'RESULT_INTEGRITY', `livro: ${reason}`]),
    ['razão de decisão SEM runs (falha fechada)', { kind: 'VIEW', view: view({ reason: 'HISTORY_REGRESSED' }) }, 'RESULT_INTEGRITY', 'livro: HISTORY_REGRESSED'],
    ['HISTORY_UNRESOLVED sem razão', { kind: 'VIEW', view: view({ reason: null }) }, 'RESULT_INTEGRITY', 'livro: UNRESOLVED'],
    ['razão de decisão que não admite consulta (LIMIT_REACHED) mesmo com runs', { kind: 'VIEW', view: view({ reason: 'LIMIT_REACHED', runs: OK_RUNS }) }, 'RESULT_INTEGRITY', 'livro: LIMIT_REACHED'],
    ['PROTECTED sem runs', { kind: 'VIEW', view: view({ state: 'PROTECTED' }) }, 'RESULT_INTEGRITY', 'livro: UNRESOLVED'],
    ['LEGACY com outra razão', { kind: 'VIEW', view: view({ state: 'LEGACY_READ_ONLY', reason: 'UNAVAILABLE' }) }, 'RESULTS_STORAGE_UNAVAILABLE', 'livro: UNAVAILABLE'],
    ['NOT_REQUIRED vindo da porta (só existe sem ela)', { kind: 'VIEW', view: view({ state: 'NOT_REQUIRED' }) }, 'RESULTS_STORAGE_UNAVAILABLE', 'livro: NOT_REQUIRED'],
    ['decisões ilegíveis', { kind: 'UNAVAILABLE', issues: ['decisões: DECISIONS_STORAGE_UNAVAILABLE'] }, 'RESULTS_STORAGE_UNAVAILABLE', 'decisões: DECISIONS_STORAGE_UNAVAILABLE'],
    ['decisões sem integridade', { kind: 'INTEGRITY', issues: ['decisões: DECISIONS_INTEGRITY'] }, 'RESULT_INTEGRITY', 'decisões: DECISIONS_INTEGRITY'],
    ...(['HISTORY_REGRESSED', 'HISTORY_DIVERGES', 'RECEIPT_REMOVED', 'UNLEDGERED_ENTRY', 'UNLEDGERED_PENDING', 'PUBLISHED_AFTER_ABORT', 'LEDGER_BEHIND', 'BEHIND_UNVERIFIABLE'] as const).map((reason): [string, ResultsLedgerRead, 'OK', null] => [`decisão ${reason} com runs OK`, { kind: 'VIEW', view: view({ reason, runs: OK_RUNS }) }, 'OK', null]),
  ];
  for (const [label, read, code, issue] of cases) {
    const service = makeService(e, new FakeEvaluator(evaluation), { ledger: portSaying(read) });
    for (const result of [await service.list(OP_B, auditId), await service.get(OP_B, auditId, 1)]) {
      if (code === 'OK') {
        assert.ok(result.ok || (result as ResultsFailure).code === 'RESULT_NOT_FOUND', `${label}: consultável ${show(result)}`);
        if (result.ok && 'results' in result.value) assert.deepEqual([result.value.confirmation, result.value.results], ['LEDGER', []], label);
        continue;
      }
      const refusal = failed(result);
      assert.deepEqual([refusal.code, RESULTS_HTTP_STATUS[refusal.code]], [code, code === 'RESULT_INTEGRITY' ? 409 : 503], `${label}: ${show(refusal)}`);
      assert.ok(refusal.issues.includes(issue as string), `${label}: a causa no issue (${show(refusal.issues)})`);
      assert.deepEqual([refusal.pending, refusal.head, refusal.blockers], [undefined, undefined, undefined], `${label}: nenhum dado`);
    }
  }
  // exceção da porta nunca vira "sem livro"
  const thrown = failed(await makeService(e, new FakeEvaluator(evaluation), { ledger: portSaying(async () => Promise.reject(new Error('falha simulada'))) }).list(OP_B, auditId));
  assert.deepEqual([thrown.code, thrown.issues], ['RESULTS_STORAGE_UNAVAILABLE', ['livro: UNAVAILABLE']]);
});

test('RL-39 (volume): fsync falho do livro numa auditoria ⇒ 503 nas consultas de OUTRA auditoria do mesmo volume do livro (DURABILITY_UNKNOWN), até o reinício', async () => {
  const { w, e } = await protectedWorld();
  assert.ok((await finalizeAs(finalizerOver(w, e), OP_A, w.auditId)).ok);
  const other = 'auditoria-outra-0777';
  const control = failed(await finalizerOver(w, e).results.list(OP_B, other));
  assert.equal(control.code, 'AUDIT_NOT_FOUND', 'controle: a outra auditoria (vazia, sem evidência) é 404 com o livro saudável');
  const brokenFsync = faulty({
    async syncDirectory(dir) {
      if (dir === w.ledgerDir) throw errno('EIO');
      return nodeFsOps.syncDirectory(dir);
    },
  });
  const failing = decisionsOver(w, { ledger: ledgerFor(w, { guard: null, fs: brokenFsync }), knownHeads: witnessOver(w, e) });
  const write = await failing.create(ANA, w.auditId, { record: rec.naModel(), expectedHead: (await must(failing.list(ANA, w.auditId, clock()))).head }, clock());
  assert.ok(!write.ok, show(write));
  try {
    for (const auditId of [w.auditId, other]) {
      for (const read of [await finalizerOver(w, e).results.list(OP_B, auditId), await finalizerOver(w, e).results.get(OP_B, auditId, 1)]) {
        const refusal = failed(read);
        assert.deepEqual([refusal.code, refusal.issues], ['RESULTS_STORAGE_UNAVAILABLE', ['livro: DURABILITY_UNKNOWN']], `${auditId}: ${show(refusal)}`);
      }
    }
  } finally {
    clearStorageFatal(w.ledgerDir); // "reinício"
  }
});

/* ------------------------------------------------------------------ RL-31: troca G↔X entre as leituras (MAJOR-1) */

/** Outro resultado X VÁLIDO e coerente no lugar de G (mesmo número, encadeado ao anterior), com o recibo de X. */
function forgeX(g: ScoreRun): { run: string; receipt: string; sha256: string } {
  const { contentSha256: _hash, ...body } = g as unknown as Record<string, unknown>;
  void _hash;
  const x = seal({ ...body, finalizedAt: g.finalizedAt.replace(/\.\d{3}Z$/, '.999Z') }) as unknown as ScoreRun;
  const receipt = seal({ schemaVersion: 1, kind: 'LINK_AUDIT_SCORE_RUN_ANCHOR', auditId: g.auditId, seq: g.seq, headSha256: x.contentSha256, anchoredAt: g.finalizedAt, prevAnchorSha256: null });
  return { run: serialize(x), receipt: serialize(receipt), sha256: x.contentSha256 };
}
/**
 * FsOps de R0 (só o serviço de resultados): nas primeiras `times` leituras, `sNNNN`/`aNNNN` são os de X — o par COERENTE (a leitura confere os recibos antes dos resultados,
 * então a rodada é decidida na leitura do recibo e o resultado segue a mesma escolha); a testemunha do livro (outro FsOps) vê G.
 */
function swapping(e: ResultsEnv, auditId: string, seq: number, x: { run: string; receipt: string }, times: number): { readonly fs: FsOps; readonly swaps: () => number } {
  let rounds = 0;
  let swapped = false;
  const runFile = runPath(e, seq, auditId);
  const receiptFile = receiptPath(e, seq, auditId);
  return {
    swaps: () => Math.min(rounds, times),
    fs: {
      ...nodeFsOps,
      async readFile(target, maxBytes) {
        if (target === receiptFile) {
          rounds += 1;
          swapped = rounds <= times;
          if (swapped) return x.receipt;
        }
        if (target === runFile && swapped) return x.run;
        return nodeFsOps.readFile(target, maxBytes);
      },
    },
  };
}

test('RL-31 (G↔X persistente): R0 vê X e a vista vê G ⇒ list, get e o reenvio idêntico nunca devolvem X; relê até 3 vezes e termina em RESULT_INTEGRITY; nada é gravado', async () => {
  const { w, e } = await protectedWorld();
  assert.ok((await finalizeAs(finalizerOver(w, e), OP_A, w.auditId)).ok);
  const [g] = (await runsOf(e, w.auditId)).runs;
  const x = forgeX(g as ScoreRun);
  const before = { ledger: hashTree(w.ledgerDir), results: hashTree(e.base), anchors: hashTree(e.anchors) };
  const swap = swapping(e, w.auditId, 1, x, Number.POSITIVE_INFINITY);
  const f = finalizerOver(w, e, { resultsFs: swap.fs });
  const list = failed(await f.results.list(OP_B, w.auditId));
  assert.equal(list.code, 'RESULT_INTEGRITY');
  assert.ok(list.issues.some((issue) => /não são os que o livro de cabeças confirma/.test(issue)), show(list));
  assert.equal(swap.swaps(), 3, 'R0 e a vista relidas até 3 vezes antes de acusar');
  const get = failed(await f.results.get(OP_B, w.auditId, 1));
  assert.equal(get.code, 'RESULT_INTEGRITY');
  const replay = await f.results.finalize(OP_A, w.auditId, { expectedHead: (g as ScoreRun).decisions.head, expectedInputSha256: (g as ScoreRun).inputSha256 });
  assert.ok(!replay.ok && replay.code === 'RESULT_INTEGRITY', `reenvio idêntico: ${show(replay)}`);
  assert.ok(!JSON.stringify([list, get, replay]).includes(x.sha256), 'o hash de X nunca sai');
  assert.deepEqual({ ledger: hashTree(w.ledgerDir), results: hashTree(e.base), anchors: hashTree(e.anchors) }, before, 'nada gravado');
});

test('RL-31 (G↔X transitório) e M-R19/M-R22: uma troca só na primeira leitura é resolvida pela releitura e devolve G; a conferência é no hash do PRÓPRIO objeto (o número sozinho não basta)', async () => {
  const { w, e } = await protectedWorld();
  assert.ok((await finalizeAs(finalizerOver(w, e), OP_A, w.auditId)).ok);
  const [g] = (await runsOf(e, w.auditId)).runs;
  const x = forgeX(g as ScoreRun);
  const once = swapping(e, w.auditId, 1, x, 1);
  const list = await finalizerOver(w, e, { resultsFs: once.fs }).results.list(OP_B, w.auditId);
  assert.ok(list.ok, show(list));
  assert.deepEqual([once.swaps(), list.value.results.map((r) => r.contentSha256), list.value.head?.sha256], [1, [(g as ScoreRun).contentSha256], (g as ScoreRun).contentSha256]);
  const twice = swapping(e, w.auditId, 1, x, 2);
  const get = await finalizerOver(w, e, { resultsFs: twice.fs }).results.get(OP_B, w.auditId, 1);
  assert.ok(get.ok && (get.value.run as { hashes: { contentSha256: string } }).hashes.contentSha256 === (g as ScoreRun).contentSha256, show(get));
});

test('RL-31 (X como pendente efetiva, fase C de G): a conclusão do autor é recusada (RESULT_INTEGRITY), nenhum RUN_CONFIRMED; a consulta não devolve X', async () => {
  const { w, e, body, run } = await openRunWorld('C');
  const x = forgeX(run);
  const swap = swapping(e, w.auditId, 1, x, Number.POSITIVE_INFINITY);
  const before = (await ledgerRecords(w)).length;
  const f = finalizerOver(w, e, { resultsFs: swap.fs });
  const concluded = await f.results.finalize(OP_A, w.auditId, body);
  assert.ok(!concluded.ok && concluded.code === 'RESULT_INTEGRITY', show(concluded));
  assert.equal((await ledgerRecords(w)).length, before, 'nenhum RUN_CONFIRMED');
  const list = failed(await f.results.list(OP_B, w.auditId));
  assert.equal(list.code, 'RESULT_INTEGRITY');
  assert.ok(!JSON.stringify([concluded, list]).includes(x.sha256));
  // controle: sem a troca, o autor conclui
  const healthy = await finalizerOver(w, e).results.finalize(OP_A, w.auditId, body);
  assert.ok(healthy.ok && healthy.value.recoveredPending, show(healthy));
});

/* ------------------------------------------------------------------ RL-35: R0 sem sk, vista em B */

/** FsOps de R0 que ESCONDE `sNNNN` na primeira listagem da pasta de resultados da auditoria (R0 lido antes da publicação; a vista, depois). */
function hidingFirst(e: ResultsEnv, auditId: string, name: string): { readonly fs: FsOps; readonly hidden: () => number } {
  let hidden = 0;
  const dir = path.join(e.base, auditId);
  return {
    hidden: () => hidden,
    fs: {
      ...nodeFsOps,
      async readdir(target) {
        const names = await nodeFsOps.readdir(target);
        if (target === dir && hidden === 0) {
          hidden += 1;
          return names.filter((n) => n !== name);
        }
        return names;
      },
    },
  };
}

test('RL-35: R0 lido sem s0001 e a vista já em B ⇒ a consulta relê e devolve a pendente (get ⇒ RESULT_PENDING_UNCONFIRMED, nunca 404)', async () => {
  const { w, e, run } = await openRunWorld('B');
  const forList = hidingFirst(e, w.auditId, 's0001.json');
  const list = await finalizerOver(w, e, { resultsFs: forList.fs }).results.list(OP_B, w.auditId);
  assert.ok(list.ok, show(list));
  assert.deepEqual([forList.hidden(), list.value.results, list.value.pending?.seq, list.value.pending?.receipt, list.value.pending?.contentSha256], [1, [], 1, 'MISSING', run.contentSha256]);
  const forGet = hidingFirst(e, w.auditId, 's0001.json');
  const get = failed(await finalizerOver(w, e, { resultsFs: forGet.fs }).results.get(OP_B, w.auditId, 1));
  assert.deepEqual([forGet.hidden(), get.code, get.pending?.seq, get.pending?.receipt], [1, 'RESULT_PENDING_UNCONFIRMED', 1, 'MISSING']);
});

test('RL-35 (finalização): R0 sem s0001 e a vista em B ⇒ recomeça do passo 0, nunca grava s0001 de novo nem trata a pendente como ausente; o autor conclui UMA vez, outro operador não', async () => {
  const { w, e, body, run } = await openRunWorld('B');
  const bytes = fs.readFileSync(runPath(e, 1, w.auditId), 'utf8');
  const other = hidingFirst(e, w.auditId, 's0001.json');
  const refused = await finalizerOver(w, e, { resultsFs: other.fs }).results.finalize(OP_B, w.auditId, body);
  assert.ok(!refused.ok && refused.code === 'RESULT_PENDING_UNCONFIRMED' && refused.pending?.seq === 1, show(refused));
  const mine = hidingFirst(e, w.auditId, 's0001.json');
  const done = await finalizerOver(w, e, { resultsFs: mine.fs }).results.finalize(OP_A, w.auditId, body);
  assert.ok(done.ok && done.value.recoveredPending && done.value.head.sha256 === run.contentSha256, show(done));
  assert.equal(mine.hidden(), 1);
  assert.equal(fs.readFileSync(runPath(e, 1, w.auditId), 'utf8'), bytes, 's0001 nunca foi regravado');
  assert.deepEqual((await ledgerRecords(w)).map((r) => r.event), ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT', 'RUN_CONFIRMED'], 'exatamente um RUN_CONFIRMED');
  assert.deepEqual((await runsOf(e, w.auditId)).all.map((r) => r.seq), [1], 'nenhum s0002');
});

test('fase C pelo livro na finalização: RUN_CONFIRMED que falha responde RESULT_ANCHOR_PENDING COM a pendente (receipt PRESENT, R1.5); a pendente de B continua MISSING', async () => {
  const c = await openRunWorld('C');
  const view = await finalizerOver(c.w, c.e).results.list(OP_B, c.w.auditId);
  assert.ok(view.ok && view.value.pending?.receipt === 'PRESENT', show(view));
  // reenvio de OUTRO operador na fase C: a recusa leva a pendente com o recibo presente
  const other = await finalizerOver(c.w, c.e).results.finalize(OP_B, c.w.auditId, c.body);
  assert.ok(!other.ok && other.code === 'RESULT_PENDING_UNCONFIRMED' && other.pending?.receipt === 'PRESENT', show(other));
  const b = await openRunWorld('B');
  const otherB = await finalizerOver(b.w, b.e).results.finalize(OP_B, b.w.auditId, b.body);
  assert.ok(!otherB.ok && otherB.code === 'RESULT_PENDING_UNCONFIRMED' && otherB.pending?.receipt === 'MISSING', show(otherB));
});

/* ------------------------------------------------------------------ casos de borda da conferência (acrescentados na campanha de mutações) */

test('fase A aberta: a consulta mostra só os confirmados, sem pendente; R0 com o número da fase A (que a vista não vê) ⇒ relê e termina em RESULT_INTEGRITY', async () => {
  const { w, e } = await protectedWorld();
  assert.ok((await finalizeAs(finalizerOver(w, e), OP_A, w.auditId)).ok);
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.naModel() }, clock()));
  const [first] = (await runsOf(e, w.auditId)).runs;
  await appendLedger(w, LEDGER_AUTH_A, runIntentMaker({ runSha256: 'c'.repeat(64), author: 'ana@empresa.com' }));
  const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
  assert.deepEqual([view.ledger.state, view.ledger.runs?.open?.phase, view.ledger.runs?.open?.runSeq], ['PROTECTED', 'A', 2]);
  const list = await finalizerOver(w, e).results.list(OP_B, w.auditId);
  assert.ok(list.ok, show(list));
  assert.deepEqual([list.value.results.map((r) => r.contentSha256), list.value.pending, list.value.confirmation], [[(first as ScoreRun).contentSha256], null, 'LEDGER']);
  // R0 vê um s0002 (com recibo) que a vista (fase A, lugar vazio) não vê: nunca devolvido
  const { contentSha256: _hash, ...body } = first as unknown as Record<string, unknown>;
  void _hash;
  const ghost = seal({ ...body, seq: 2, prevSha256: (first as ScoreRun).contentSha256, finalizedAt: (first as ScoreRun).finalizedAt.replace(/\.\d{3}Z$/, '.998Z') }) as unknown as ScoreRun;
  const firstReceipt = JSON.parse(fs.readFileSync(receiptPath(e, 1, w.auditId), 'utf8')) as { contentSha256: string };
  const ghostReceipt = seal({ schemaVersion: 1, kind: 'LINK_AUDIT_SCORE_RUN_ANCHOR', auditId: w.auditId, seq: 2, headSha256: ghost.contentSha256, anchoredAt: ghost.finalizedAt, prevAnchorSha256: firstReceipt.contentSha256 });
  const ghostFs: FsOps = {
    ...nodeFsOps,
    async readdir(target) {
      const names = await nodeFsOps.readdir(target);
      if (target === path.join(e.base, w.auditId)) return [...names, 's0002.json'];
      if (target === path.join(e.anchors, w.auditId)) return [...names, 'a0002.json'];
      return names;
    },
    async readFile(target, maxBytes) {
      if (target === runPath(e, 2, w.auditId)) return serialize(ghost);
      if (target === receiptPath(e, 2, w.auditId)) return serialize(ghostReceipt);
      return nodeFsOps.readFile(target, maxBytes);
    },
    async lstat(target) {
      if (target === runPath(e, 2, w.auditId) || target === receiptPath(e, 2, w.auditId)) return nodeFsOps.lstat(runPath(e, 1, w.auditId));
      return nodeFsOps.lstat(target);
    },
  };
  const refused = failed(await finalizerOver(w, e, { resultsFs: ghostFs }).results.list(OP_B, w.auditId));
  assert.equal(refused.code, 'RESULT_INTEGRITY', show(refused));
  assert.ok(!JSON.stringify(refused).includes(ghost.contentSha256));
});

test('fase B na vista e R0 com um recibo que a vista não vê (recibo só para R0) ⇒ relê; persistente ⇒ RESULT_INTEGRITY — "PRESENT" só quando R0 e a vista concordam com a fase C', async () => {
  const { w, e, run } = await openRunWorld('B');
  const receipt = seal({ schemaVersion: 1, kind: 'LINK_AUDIT_SCORE_RUN_ANCHOR', auditId: w.auditId, seq: 1, headSha256: run.contentSha256, anchoredAt: run.finalizedAt, prevAnchorSha256: null });
  const anchorDir = path.join(e.anchors, w.auditId);
  const onlyForR0: FsOps = {
    ...nodeFsOps,
    async readdir(target) {
      const names: string[] = await nodeFsOps.readdir(target).catch((error: NodeJS.ErrnoException): string[] | Promise<never> => (target === anchorDir && error.code === 'ENOENT' ? [] : Promise.reject(error)));
      return target === anchorDir && !names.includes('a0001.json') ? [...names, 'a0001.json'] : names;
    },
    async readFile(target, maxBytes) {
      return target === receiptPath(e, 1, w.auditId) ? serialize(receipt) : nodeFsOps.readFile(target, maxBytes);
    },
    async lstat(target) {
      if (target === anchorDir || target === receiptPath(e, 1, w.auditId)) return nodeFsOps.lstat(target === anchorDir ? e.anchors : runPath(e, 1, w.auditId));
      return nodeFsOps.lstat(target);
    },
  };
  const refused = failed(await finalizerOver(w, e, { resultsFs: onlyForR0 }).results.list(OP_B, w.auditId));
  assert.equal(refused.code, 'RESULT_INTEGRITY', show(refused));
});

test('vista LEGACY ou ENROLLMENT_PENDING com um resultado v2 em R0 (leituras que não concordam) ⇒ relê e termina em RESULT_INTEGRITY, nunca RECEIPT_ONLY', async () => {
  const { w, e } = await protectedWorld();
  assert.ok((await finalizeAs(finalizerOver(w, e), OP_A, w.auditId)).ok);
  const evaluation = buildEvaluation({ auditId: w.auditId });
  for (const state of ['LEGACY_READ_ONLY', 'ENROLLMENT_PENDING'] as const) {
    let calls = 0;
    const port = portSaying(async () => {
      calls += 1;
      return { kind: 'VIEW', view: view({ state, reason: state === 'LEGACY_READ_ONLY' ? 'LEDGER_ABSENT_WITH_HISTORY' : null }) };
    });
    const refused = failed(await makeService(e, new FakeEvaluator(evaluation), { ledger: port }).list(OP_B, w.auditId));
    assert.deepEqual([refused.code, calls], ['RESULT_INTEGRITY', 3], `${state}: ${show(refused)}`);
  }
});

test('a vista das consultas confere a configuração das decisões: pastas sobrepostas ⇒ UNAVAILABLE (503), nunca uma vista', async () => {
  const { w, e } = await protectedWorld();
  const overlapped = decisionsOver({ ...w, evidenceDir: w.decisionsDir }, { ledger: ledgerFor(w, { guard: null }), knownHeads: witnessOver(w, e) });
  const read = await (overlapped.resultsLedger as ResultsLedgerPort).view({ auditId: w.auditId, nowIso: clock() });
  assert.equal(read.kind, 'UNAVAILABLE', show(read));
});

test('passo 11 que falha (fase C pelo livro): RESULT_ANCHOR_PENDING com a pendente, receipt PRESENT (o recibo já é durável; ainda NÃO é confirmação)', async () => {
  const { w, e } = await protectedWorld();
  const owner = finalizerOver(w, e, { ledger: { fs: failingLink(path.join(w.ledgerDir, w.auditId, 'l000005.json')) } });
  const first = await finalizeAs(owner, OP_A, w.auditId);
  assert.ok(!first.ok && first.code === 'RESULT_ANCHOR_PENDING', show(first));
  assert.deepEqual([first.pending?.seq, first.pending?.receipt, first.pending?.blocksFinalization], [1, 'PRESENT', true]);
});
