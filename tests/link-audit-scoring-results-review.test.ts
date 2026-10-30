import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sha256Hex } from '../src/lib/link-audit/canonical';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { seal, serialize } from '../src/lib/link-audit-storage';
import type { ResultsFailure } from '../src/lib/link-audit-scoring-runs';
import { readRunLog } from '../src/lib/link-audit-scoring-runs/results-store';
import { MAX_RUNS, RUN_ANCHOR_KIND, RUN_FILE_KIND, RUN_SCHEMA_VERSION } from '../src/lib/link-audit-scoring-runs/results-types';
import { hashTree, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { bodyOf, buildEvaluation, FakeEvaluator, makeService, OP_A, OP_B, receiptPath, resultsEnv, RES_AUDIT, runPath, tickClock, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * Onda 6C, I4 — revisão final: recuperação da pendente depois de o mundo andar, idempotência com 500 registros no nível do SERVIÇO,
 * obsolescência (stale × decisionsChanged × stateChangedAfterFinalization) e os mutantes de leitura concorrente que só um disco
 * intercalado consegue exercitar. Dados fictícios.
 */
registerCleanup();

const refused = (r: { ok: boolean }): ResultsFailure => {
  assert.equal(r.ok, false, 'devia ter sido recusado');
  return r as ResultsFailure;
};
/* ------------------------------------------------------------------------------------------------ A. recuperação da pendente */
test('pendente: o autor reconstrói o pedido SÓ com o que a resposta expõe, mesmo depois de o mundo andar; outro operador nunca a confirma; o resultado volta marcado como histórico', async () => {
  let failReceipts = true;
  const ops = faulty({
    async writeExclusive(target, data, mode) {
      if (failReceipts && target.includes('lad-ra-')) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const e = resultsEnv();
  const original = buildEvaluation({ kind: 'PONTUADO', variant: 'v1', headSeed: 'h1' });
  const evaluator = new FakeEvaluator(original);
  const svc = makeService(e, evaluator, { fs: ops });
  const first = refused(await svc.finalize(OP_B, RES_AUDIT, bodyOf(original)));
  assert.equal(first.code, 'RESULT_ANCHOR_PENDING');
  const pending = first.pending!;
  assert.deepEqual([pending.isMine, pending.inputSha256, pending.decisionsHead], [true, original.inputSha256, original.decisions.head]);

  // o mundo ANDOU: nova decisão confirmada, nova entrada
  const moved = buildEvaluation({ kind: 'PONTUADO', variant: 'v2', headSeed: 'h2' });
  evaluator.current = moved;
  failReceipts = false;
  const requestFromPending = { expectedHead: pending.decisionsHead, expectedInputSha256: pending.inputSha256 };

  // outro operador, mesmo com o pedido exato reconstruído, NÃO confirma a pendente alheia
  const stranger = refused(await svc.finalize(OP_A, RES_AUDIT, requestFromPending));
  assert.equal(stranger.code, 'RESULT_PENDING_UNCONFIRMED');
  assert.equal(stranger.pending?.isMine, false);
  assert.ok(!JSON.stringify(stranger).includes('bia@empresa.com'));
  // e a visão ATUAL (do mundo que andou) também não passa por cima da pendente
  assert.equal(refused(await svc.finalize(OP_B, RES_AUDIT, bodyOf(moved))).code, 'RESULT_PENDING_UNCONFIRMED');
  assert.ok(!fs.existsSync(receiptPath(e, 1)));
  const listed = await svc.list(OP_A, RES_AUDIT);
  assert.ok(listed.ok && listed.value.results.length === 0 && listed.value.pending?.isMine === false, 'a pendente não é resultado e não é "minha" para outro');

  // o autor conclui com o pedido reconstruído; o resultado é apresentado como HISTÓRICO (o mundo já mudou)
  const done = await svc.finalize(OP_B, RES_AUDIT, requestFromPending);
  assert.ok(done.ok, JSON.stringify(done));
  assert.deepEqual([done.value.replayed, done.value.recoveredPending, done.value.stateChangedAfterFinalization, done.value.head.seq], [true, true, true, 1]);
  const after = await svc.list(OP_B, RES_AUDIT);
  assert.ok(after.ok);
  assert.deepEqual([after.value.results[0]?.stale, after.value.results[0]?.decisionsChanged, after.value.pending], [true, true, null]);
  const detail = await svc.get(OP_B, RES_AUDIT, 1);
  assert.ok(detail.ok && detail.value.stale === true && detail.value.decisionsChanged === true);
  assert.equal(fs.readdirSync(path.join(e.base, RES_AUDIT)).length, 1, 'nada duplicado');
});

test('reenvio de um resultado CONFIRMADO depois que o mundo mudou: continua 200, sem gravar, mas é sinalizado como mudado (nunca apresentado como atual); sem avaliação possível ⇒ null', async () => {
  const e = resultsEnv();
  const ev = buildEvaluation({ kind: 'PONTUADO', headSeed: 'h1' });
  const evaluator = new FakeEvaluator(ev);
  const svc = makeService(e, evaluator);
  const created = await svc.finalize(OP_B, RES_AUDIT, bodyOf(ev));
  assert.ok(created.ok && created.value.recoveredPending === false && created.value.stateChangedAfterFinalization === false);
  const before = [hashTree(e.base), hashTree(e.anchors)];
  const same = await svc.finalize(OP_A, RES_AUDIT, bodyOf(ev));
  assert.ok(same.ok && same.value.replayed && same.value.stateChangedAfterFinalization === false && same.value.recoveredPending === false);
  evaluator.current = buildEvaluation({ kind: 'PONTUADO', headSeed: 'h2' }); // só o head das decisões mudou (mesma entrada do motor)
  const headMoved = await svc.finalize(OP_A, RES_AUDIT, bodyOf(ev));
  assert.ok(headMoved.ok && headMoved.value.replayed && headMoved.value.stateChangedAfterFinalization === true);
  const listed = await svc.list(OP_A, RES_AUDIT);
  assert.ok(listed.ok);
  assert.deepEqual([listed.value.results[0]?.stale, listed.value.results[0]?.decisionsChanged], [false, true], 'indicadores SEPARADOS: a entrada é a mesma, as decisões não');
  evaluator.current = buildEvaluation({ kind: 'PONTUADO', variant: 'v9', headSeed: 'h1' }); // só a entrada mudou
  const inputMoved = await svc.list(OP_A, RES_AUDIT);
  assert.ok(inputMoved.ok && inputMoved.value.results[0]?.stale === true && inputMoved.value.results[0]?.decisionsChanged === false);
  evaluator.current = { ok: false, code: 'EVIDENCE_INTEGRITY', issues: [] } as never;
  const blind = await svc.finalize(OP_A, RES_AUDIT, bodyOf(ev));
  assert.ok(blind.ok && blind.value.replayed && blind.value.stateChangedAfterFinalization === null);
  const blindList = await svc.list(OP_A, RES_AUDIT);
  assert.ok(blindList.ok && blindList.value.results[0]?.stale === null && blindList.value.results[0]?.decisionsChanged === null);
  assert.deepEqual([hashTree(e.base), hashTree(e.anchors)], before, 'reenvios e consultas nunca gravam');
});

/* ------------------------------------------------------------------------------------------------ B. idempotência com 500 registros */
function fillTo(e: ResultsEnv, count: number, basis?: ReadonlyArray<Record<string, unknown>>): void {
  const dir = path.join(e.base, RES_AUDIT);
  const adir = path.join(e.anchors, RES_AUDIT);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(adir, { recursive: true });
  const at = '2026-10-30T11:00:00.000Z';
  const h = sha256Hex('filler');
  let prev: string | null = null;
  let prevAnchor: string | null = null;
  for (let seq = 1; seq <= count; seq++) {
    const run = seal({
      schemaVersion: RUN_SCHEMA_VERSION, kind: RUN_FILE_KIND, auditId: RES_AUDIT, seq, finalizedAt: at, finalizedBy: 'ana@empresa.com', outcome: 'INCONCLUSIVO', scored: null,
      inconclusive: { reasonCode: 'COBERTURA_INSUFICIENTE', failedGates: [], coveragePercent: 1, minimumCoveragePercent: 40 }, scoringAuditId: RES_AUDIT,
      auditIdAlias: { applied: false, rule: 'IDENTITY', reason: null, sourceAuditId: RES_AUDIT }, decisions: { head: null, count: 0, appliedIds: [], applied: [] }, layout: 'VERSIONED',
      evidenceBasis: basis ?? [{ ref: 'capture:c0099', kind: 'CAPTURE', observedAt: at, contentSha256: h, bodySha256: null, legacy: false, superseded: false }], profileSource: null, referenceDate: '2026-10-30',
      referenceDateSource: { ref: 'capture:c0099', observedAt: at, rule: 'LATEST_VERIFIED_EVIDENCE_DAY' }, websiteDerivation: null, mapperVersion: 'm', methodologyVersion: 'x', scoreModelVersion: 's',
      rulerFingerprint: h, input: {}, result: {}, inputSha256: h, resultSha256: h, prevSha256: prev,
    }) as { contentSha256: string };
    const receipt = seal({ schemaVersion: RUN_SCHEMA_VERSION, kind: RUN_ANCHOR_KIND, auditId: RES_AUDIT, seq, headSha256: run.contentSha256, anchoredAt: at, prevAnchorSha256: prevAnchor }) as { contentSha256: string };
    const n = String(seq).padStart(4, '0');
    fs.writeFileSync(path.join(dir, `s${n}.json`), serialize(run as never), { mode: 0o444 });
    fs.writeFileSync(path.join(adir, `a${n}.json`), serialize(receipt as never), { mode: 0o444 });
    prev = run.contentSha256;
    prevAnchor = receipt.contentSha256;
  }
}

test(`com ${MAX_RUNS} registros: o reenvio idêntico do último continua 200 (sem criar, sem sobrescrever, também sob concorrência); estado novo ⇒ RESULTS_LIMIT_REACHED`, async () => {
  const e = resultsEnv();
  const ev = buildEvaluation({ kind: 'PONTUADO', variant: 'limite', headSeed: 'h1' });
  fillTo(e, MAX_RUNS - 1, (ev as unknown as { mapped: { traceability: { evidences: Array<Record<string, unknown>> } } }).mapped.traceability.evidences); // enchimento coerente com as evidências reais
  const evaluator = new FakeEvaluator(ev);
  const a = makeService(e, evaluator);
  const b = makeService(e, new FakeEvaluator(ev), { clock: tickClock(300) });
  const last = await a.finalize(OP_B, RES_AUDIT, bodyOf(ev));
  assert.ok(last.ok && last.value.head.seq === MAX_RUNS, JSON.stringify(last));
  const before = [hashTree(e.base), hashTree(e.anchors)];

  const results = await Promise.all([a.finalize(OP_B, RES_AUDIT, bodyOf(ev)), b.finalize(OP_A, RES_AUDIT, bodyOf(ev)), a.finalize(OP_B, RES_AUDIT, bodyOf(ev))]);
  for (const r of results) assert.ok(r.ok && r.value.replayed && r.value.head.seq === MAX_RUNS && r.value.recoveredPending === false, JSON.stringify(r));
  assert.deepEqual([hashTree(e.base), hashTree(e.anchors)], before, 'nenhum byte mudou');
  assert.equal(fs.readdirSync(path.join(e.base, RES_AUDIT)).length, MAX_RUNS);

  const next = buildEvaluation({ kind: 'PONTUADO', variant: 'limite-2', headSeed: 'h2' });
  evaluator.current = next;
  const over = refused(await a.finalize(OP_B, RES_AUDIT, bodyOf(next)));
  assert.equal(over.code, 'RESULTS_LIMIT_REACHED');
  assert.deepEqual([hashTree(e.base), hashTree(e.anchors)], before);
  assert.equal(fs.existsSync(runPath(e, MAX_RUNS + 1)), false);
});

/* ------------------------------------------------------------------------------------------------ mutantes de leitura concorrente (S13/S16) */
function plantOne(e: ResultsEnv): void {
  const dir = path.join(e.base, RES_AUDIT);
  const adir = path.join(e.anchors, RES_AUDIT);
  const names = fs.readdirSync(dir).filter((n) => /^s\d{4}\.json$/.test(n)).sort();
  const last = JSON.parse(fs.readFileSync(path.join(dir, names[names.length - 1]!), 'utf8')) as Record<string, any>;
  const seq = names.length + 1;
  const { contentSha256: _drop, ...body } = last;
  void _drop;
  const run = seal({ ...body, seq, prevSha256: last.contentSha256, finalizedAt: '2026-10-30T13:00:00.000Z', finalizedBy: 'bia@empresa.com' }) as { contentSha256: string };
  const receipts = fs.readdirSync(adir).filter((n) => /^a\d{4}\.json$/.test(n)).sort();
  const previous = receipts.length ? (JSON.parse(fs.readFileSync(path.join(adir, receipts[receipts.length - 1]!), 'utf8')) as { contentSha256: string }).contentSha256 : null;
  const receipt = seal({ schemaVersion: RUN_SCHEMA_VERSION, kind: RUN_ANCHOR_KIND, auditId: RES_AUDIT, seq, headSha256: run.contentSha256, anchoredAt: '2026-10-30T13:00:00.000Z', prevAnchorSha256: previous });
  const n = String(seq).padStart(4, '0');
  fs.writeFileSync(path.join(dir, `s${n}.json`), serialize(run as never), { mode: 0o444 });
  fs.writeFileSync(path.join(adir, `a${n}.json`), serialize(receipt as never), { mode: 0o444 });
}
/** Um escritor concorrente aparece logo DEPOIS da primeira listagem de recibos; conta as listagens da pasta de resultados (= passadas de leitura). */
function interleaved(e: ResultsEnv, pairs: number): { ops: FsOps; resultListings: () => number } {
  let planted = false;
  let resultListings = 0;
  const ops: FsOps = {
    ...nodeFsOps,
    async readdir(dir: string) {
      const listing = await nodeFsOps.readdir(dir);
      if (dir.startsWith(e.base)) resultListings++;
      if (!planted && dir.startsWith(e.anchors) && listing.some((n) => /^a\d{4}\.json$/.test(n))) {
        planted = true;
        for (let i = 0; i < pairs; i++) plantOne(e);
      }
      return listing;
    },
  };
  return { ops, resultListings: () => resultListings };
}
async function seeded(): Promise<ResultsEnv> {
  const e = resultsEnv();
  fillTo(e, 1);
  return e;
}

test('leitura concorrente: com UM escritor no meio da leitura, resultados são lidos DEPOIS dos recibos ⇒ vira pendente, numa só passada (sem falso TRUNCATED)', async () => {
  const e = await seeded();
  const { ops, resultListings } = interleaved(e, 1);
  const r = await readRunLog(e.base, RES_AUDIT, { anchorDir: e.anchors, fs: ops });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.value.runs.length, r.value.pending?.seq, resultListings()], [1, 2, 1]);
});

test('leitura concorrente: com DOIS escritores no meio da leitura a primeira passada falha entre pastas e a releitura única a resolve; a falha real continua falha', async () => {
  const e = await seeded();
  const { ops, resultListings } = interleaved(e, 2);
  const r = await readRunLog(e.base, RES_AUDIT, { anchorDir: e.anchors, fs: ops });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.value.runs.length, r.value.pending, resultListings()], [3, null, 2]);
  // uma inconsistência REAL persiste na segunda passada e é denunciada
  const broken = await seeded();
  plantOne(broken);
  fs.chmodSync(path.join(broken.base, RES_AUDIT), 0o755);
  fs.unlinkSync(runPath(broken, 2));
  const again = await readRunLog(broken.base, RES_AUDIT, { anchorDir: broken.anchors });
  assert.ok(!again.ok && again.code === 'TRUNCATED');
});

/* ------------------------------------------------------------------------------------------------ segunda revisão independente (M1, M2, M5, M6) */
import { world, rec, clock } from './helpers/link-audit-decisions-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';

test('M1: decisão PENDENTE depois do resultado marca o resultado como mudado em reenvio, list e get (mesmo sem mudar head nem entrada); entrada de hoje recusada ⇒ stale', async () => {
  let failReceipts = false;
  const ops = faulty({
    async writeExclusive(target, data, mode) {
      if (failReceipts && target.includes('lad-anc-')) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const w = await world({ fs: ops });
  const e = resultsEnv();
  const preview = previewOver(w);
  const svc = makeService(e, preview);
  const seen = await preview.preview(OP_B, w.auditId);
  assert.ok(seen.ok);
  const body = { expectedHead: seen.value.finalization.expectedHead, expectedInputSha256: seen.value.finalization.expectedInputSha256 as string };
  assert.ok((await svc.finalize(OP_B, w.auditId, body)).ok);
  const quiet = await svc.list(OP_B, w.auditId);
  assert.ok(quiet.ok && quiet.value.results[0]?.stale === false && quiet.value.results[0]?.decisionsChanged === false);

  failReceipts = true;
  const pendingDecision = await w.service.create(OP_B, w.auditId, { record: rec.nameEquivalence('Outra Padaria Ltda', 'Outra Padaria') }, clock);
  assert.ok(!pendingDecision.ok && pendingDecision.code === 'ANCHOR_PENDING');
  const listed = await svc.list(OP_B, w.auditId);
  assert.ok(listed.ok && listed.value.results[0]?.decisionsChanged === true, 'decisão pendente = o resultado não é apresentado como atual');
  const detail = await svc.get(OP_B, w.auditId, 1);
  assert.ok(detail.ok && detail.value.decisionsChanged === true);
  const replay = await svc.finalize(OP_B, w.auditId, body);
  assert.ok(replay.ok && replay.value.replayed && replay.value.stateChangedAfterFinalization === true);

  const refusedNow = new FakeEvaluator(buildEvaluation({ kind: 'PONTUADO' }));
  const solo = makeService(resultsEnv(), refusedNow);
  const first = await solo.finalize(OP_B, RES_AUDIT, bodyOf(buildEvaluation({ kind: 'PONTUADO' })));
  assert.ok(first.ok);
  const noInput = buildEvaluation({ kind: 'PONTUADO' });
  (noInput as { inputSha256: string | null }).inputSha256 = null; // a entrada de hoje foi recusada
  refusedNow.current = noInput;
  const again = await solo.list(OP_B, RES_AUDIT);
  assert.ok(again.ok && again.value.results[0]?.stale === true);
});

test('M2: concluir uma pendente exige as MESMAS evidências hoje; evidência trocada, removida ou avaliação impossível ⇒ o recibo NÃO é dado', async () => {
  for (const [name, next, code] of [
    ['hash trocado', (): Parameters<typeof makeService>[1] => new FakeEvaluator(buildEvaluation({ kind: 'PONTUADO', evidenceSalt: 'trocada' })), 'EVIDENCE_HASH_CHANGED'],
    ['avaliação impossível', (): Parameters<typeof makeService>[1] => new FakeEvaluator({ ok: false, code: 'EVIDENCE_INTEGRITY', issues: [] } as never), 'EVIDENCE_INTEGRITY'],
  ] as const) {
    let failReceipts = true;
    const ops = faulty({
      async writeExclusive(target, data, mode) {
        if (failReceipts && target.includes('lad-ra-')) throw errno('ENOSPC');
        return nodeFsOps.writeExclusive(target, data, mode);
      },
    });
    const e = resultsEnv();
    const original = buildEvaluation({ kind: 'PONTUADO' });
    const first = makeService(e, new FakeEvaluator(original), { fs: ops });
    const pending = refused(await first.finalize(OP_B, RES_AUDIT, bodyOf(original))).pending!;
    failReceipts = false;
    const changed = makeService(e, next(), { fs: ops });
    const r = refused(await changed.finalize(OP_B, RES_AUDIT, { expectedHead: pending.decisionsHead, expectedInputSha256: pending.inputSha256 }));
    assert.equal(r.code, code, name);
    assert.ok(!fs.existsSync(receiptPath(e, 1)), `${name}: sem recibo`);
    // com as evidências de volta ao normal, o autor conclui
    const ok = await makeService(e, new FakeEvaluator(original), { fs: ops }).finalize(OP_B, RES_AUDIT, { expectedHead: pending.decisionsHead, expectedInputSha256: pending.inputSha256 });
    assert.ok(ok.ok && ok.value.recoveredPending, name);
  }
  // evidência REMOVIDA
  let failReceipts = true;
  const ops = faulty({
    async writeExclusive(target, data, mode) {
      if (failReceipts && target.includes('lad-ra-')) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const e = resultsEnv();
  const original = buildEvaluation({ kind: 'PONTUADO' });
  const pending = refused(await makeService(e, new FakeEvaluator(original), { fs: ops }).finalize(OP_B, RES_AUDIT, bodyOf(original))).pending!;
  failReceipts = false;
  const trimmed = buildEvaluation({ kind: 'PONTUADO' });
  const trace = (trimmed as unknown as { mapped: { traceability: { evidences: unknown[] } } }).mapped.traceability;
  trace.evidences = trace.evidences.slice(0, -1);
  const r = refused(await makeService(e, new FakeEvaluator(trimmed), { fs: ops }).finalize(OP_B, RES_AUDIT, { expectedHead: pending.decisionsHead, expectedInputSha256: pending.inputSha256 }));
  assert.equal(r.code, 'EVIDENCE_HASH_CHANGED');
  assert.ok(r.issues.some((issue) => issue.startsWith('ausente:')));
});

test('M6: um novo resultado cujas evidências OMITEM uma já usada antes (cauda removida) é recusado', async () => {
  const e = resultsEnv();
  const first = buildEvaluation({ kind: 'PONTUADO', variant: 'v1', headSeed: 'h1' });
  const evaluator = new FakeEvaluator(first);
  const svc = makeService(e, evaluator);
  assert.ok((await svc.finalize(OP_B, RES_AUDIT, bodyOf(first))).ok);
  const next = buildEvaluation({ kind: 'PONTUADO', variant: 'v2', headSeed: 'h2' });
  const trace = (next as unknown as { mapped: { traceability: { evidences: unknown[] } } }).mapped.traceability;
  trace.evidences = trace.evidences.slice(1);
  evaluator.current = next;
  const r = refused(await svc.finalize(OP_B, RES_AUDIT, bodyOf(next)));
  assert.equal(r.code, 'EVIDENCE_HASH_CHANGED');
  assert.ok(r.issues.every((issue) => /^ausente: /.test(issue)));
});

test('M5: exceção na releitura informativa DEPOIS do recibo não transforma o sucesso durável em erro', async () => {
  const e = resultsEnv();
  const ev = buildEvaluation({ kind: 'PONTUADO' });
  const evaluator = new FakeEvaluator(ev);
  evaluator.onFingerprint = (n) => {
    if (n === 2) throw new Error('/mnt/segredo falhou');
  };
  const r = await makeService(e, evaluator).finalize(OP_B, RES_AUDIT, bodyOf(ev));
  assert.ok(r.ok && !r.value.replayed && r.value.stateChangedAfterFinalization === true, JSON.stringify(r));
  assert.ok(fs.existsSync(receiptPath(e, 1)));
  const quiet = new FakeEvaluator(ev);
  const svc = makeService(e, quiet);
  quiet.onEvaluate = () => {
    throw new Error('x');
  };
  const replay = await svc.finalize(OP_A, RES_AUDIT, bodyOf(ev));
  assert.ok(replay.ok && replay.value.replayed && replay.value.stateChangedAfterFinalization === null);
});

test('M4: o cache de verificação não deixa um registro verificado "explicar" outro adulterado com selo e recibo refeitos (mesmo seq, auditId e hashes de entrada/resultado)', async () => {
  const e = resultsEnv();
  const first = buildEvaluation({ kind: 'PONTUADO', variant: 'a', headSeed: 'h1' });
  const evaluator = new FakeEvaluator(first);
  const svc = makeService(e, evaluator);
  assert.ok((await svc.finalize(OP_B, RES_AUDIT, bodyOf(first))).ok);
  const second = buildEvaluation({ kind: 'INCONCLUSIVO', variant: 'b', headSeed: 'h2' });
  evaluator.current = second;
  assert.ok((await svc.finalize(OP_B, RES_AUDIT, bodyOf(second))).ok);
  assert.ok((await svc.list(OP_B, RES_AUDIT)).ok && (await svc.get(OP_B, RES_AUDIT, 2)).ok, 'caches primados');
  const { contentSha256, ...rest } = JSON.parse(fs.readFileSync(runPath(e, 2), 'utf8')) as Record<string, any>;
  void contentSha256;
  const forged = seal({ ...rest, outcome: 'PONTUADO', scored: { level: 'PROVISORIO' }, inconclusive: null }) as { contentSha256: string };
  fs.chmodSync(runPath(e, 2), 0o644);
  fs.writeFileSync(runPath(e, 2), serialize(forged as never));
  const { contentSha256: oldSeal, ...receipt } = JSON.parse(fs.readFileSync(receiptPath(e, 2), 'utf8')) as Record<string, any>;
  void oldSeal;
  fs.chmodSync(receiptPath(e, 2), 0o644);
  fs.writeFileSync(receiptPath(e, 2), serialize(seal({ ...receipt, headSha256: forged.contentSha256 }) as never));
  assert.equal(refused(await svc.list(OP_B, RES_AUDIT)).code, 'RESULT_INTEGRITY');
  assert.equal(refused(await svc.get(OP_B, RES_AUDIT, 2)).code, 'RESULT_INTEGRITY');
  assert.equal(refused(await svc.finalize(OP_A, RES_AUDIT, bodyOf(second))).code, 'RESULT_INTEGRITY');
});
