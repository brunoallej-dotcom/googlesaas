import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { syncLedgerDirectory } from '../src/lib/link-audit-ledger';
import { RESULTS_HTTP_STATUS, RESULTS_MESSAGE } from '../src/lib/link-audit-scoring-runs/results';
import type { ScoreRun } from '../src/lib/link-audit-scoring-runs/results-types';
import { clearStorageFatal, seal, serialize } from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { ANA, clock, must, rec, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { ledgerRecords, ledgerWorld, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { buildEvaluation, FakeEvaluator, makeService, OP_A, OP_B, receiptPath, resultsEnv, runPath, type ResultsEnv } from './helpers/link-audit-results-fixtures';
import { bodyNow, everythingOf, finalizerOver, protectedWorld, runsOf, type FinalizerOver } from './helpers/link-audit-results-ledger-finalize-fixtures';

/*
 * R1.6 — PASSO 11b: REENVIO IDEMPOTENTE DE RESULTADO JÁ CONFIRMADO PELO LIVRO (spec do livro §16.17.3, 11b; RL-28; M-R17). O 200 `replayed` só sai depois de 1b (o objeto devolvido
 * é o do `RUN_CONFIRMED`); nada é gravado, mas — espelho de R7-04 (4) e (6) — as pastas da auditoria em resultados e em recibos, os diretórios-pai das duas e o livro (`LedgerPort.sync`,
 * com a raiz) são sincronizados ESTRITAMENTE ANTES do 200: um resultado que existe não prova que sobreviveria a uma queda (o fsync dele pode ter falhado antes de um reinício).
 * Falha ⇒ `RESULT_DURABILITY_UNKNOWN` (nunca 200), as bases travam; depois do reinício o MESMO pedido responde 200 sem duplicar nada. Falhas injetadas por `FsOps`; "reinício" =
 * `clearStorageFatal()` + serviços novos. Pastas temporárias, chaves de TESTE, e-mails fictícios, nenhuma rede.
 */
registerCleanup();
test.afterEach(() => clearStorageFatal());

const show = (value: unknown): string => JSON.stringify(value).slice(0, 300);

/** Auditoria protegida com UM resultado confirmado pelo livro e o pedido IDÊNTICO a ele. */
async function confirmed(): Promise<{ w: LedgerWorld; e: ResultsEnv; body: Awaited<ReturnType<typeof bodyNow>> }> {
  const { w, e } = await protectedWorld();
  const f = finalizerOver(w, e);
  const body = await bodyNow(f, OP_A, w.auditId);
  const done = await f.results.finalize(OP_A, w.auditId, body);
  assert.ok(done.ok && !done.value.replayed, show(done));
  return { w, e, body };
}
const dirsOf = (w: LedgerWorld, e: ResultsEnv) => ({
  results: path.join(e.base, w.auditId),
  anchors: path.join(e.anchors, w.auditId),
  resultsRoot: e.base,
  anchorsRoot: e.anchors,
  ledger: path.join(w.ledgerDir, w.auditId),
  ledgerRoot: w.ledgerDir,
});

test('RL-28 / M-R17 (11b): o reenvio idêntico de resultado confirmado (do autor ou de outro operador) responde 200 replayed, não grava nada e sincroniza ANTES as duas pastas da auditoria, as duas raízes e o livro (pasta e raiz)', async () => {
  const { w, e, body } = await confirmed();
  for (const actor of [OP_A, OP_B]) {
    const synced: string[] = [];
    const spy = (inner: FsOps): FsOps => ({ ...inner, async syncDirectory(target) { synced.push(target); return inner.syncDirectory(target); } });
    const before = await everythingOf(w, e);
    const replay = await finalizerOver(w, e, { resultsFs: spy(nodeFsOps), ledger: { fs: spy(nodeFsOps) } }).results.finalize(actor, w.auditId, body);
    assert.ok(replay.ok && replay.value.replayed && !replay.value.recoveredPending, `${actor.email}: ${show(replay)}`);
    assert.deepEqual(await everythingOf(w, e), before, `${actor.email}: nada gravado`);
    for (const [label, dir] of Object.entries(dirsOf(w, e))) assert.ok(synced.includes(dir), `${actor.email}: sincronizou ${label}: ${show(synced.map((d) => path.relative(path.dirname(e.base), d)))}`);
  }
});

const fsyncFailure = (code: string): Error => Object.assign(new Error(`fsync simulado (${code})`), { code });
function failingSync(dir: string, code: string): FsOps {
  return {
    ...nodeFsOps,
    async syncDirectory(target) {
      if (target === dir) throw fsyncFailure(code);
      return nodeFsOps.syncDirectory(target);
    },
  };
}

const TARGETS: ReadonlyArray<readonly [keyof ReturnType<typeof dirsOf>, string]> = [
  ['results', 'EIO'],
  ['anchors', 'ENOTSUP'],
  ['resultsRoot', 'EINVAL'],
  ['anchorsRoot', 'EIO'],
  ['ledger', 'EIO'],
  ['ledgerRoot', 'ENOTSUP'],
];
for (const [target, code] of TARGETS) {
  test(`RL-28 / RL-20 (11b): fsync falho em ${target} (${code}) ⇒ nunca 200, RESULT_DURABILITY_UNKNOWN sem "Nada foi gravado" nem caminho, base trava; depois do reinício o MESMO pedido responde 200 replayed sem duplicar`, async () => {
    const { w, e, body } = await confirmed();
    const dir = dirsOf(w, e)[target];
    const over: FinalizerOver = target.startsWith('ledger') ? { ledger: { fs: failingSync(dir, code) } } : { resultsFs: failingSync(dir, code) };
    const before = await everythingOf(w, e);
    const replay = await finalizerOver(w, e, over).results.finalize(OP_A, w.auditId, body);
    assert.ok(!replay.ok && replay.code === 'RESULT_DURABILITY_UNKNOWN', show(replay));
    assert.ok(!/Nada foi gravado/i.test(RESULTS_MESSAGE[replay.code]));
    for (const issue of replay.issues) assert.ok(!/[\\/]/.test(issue), `sem caminho: ${issue}`);
    assert.deepEqual(await everythingOf(w, e), before, 'nada gravado');
    // a base travou: neste processo, o mesmo pedido com o disco "saudável" também não é sucesso
    const again = await finalizerOver(w, e).results.finalize(OP_A, w.auditId, body);
    assert.ok(!again.ok, `depois de um fsync falho nada é presumido até reiniciar: ${show(again)}`);
    clearStorageFatal();
    const restarted = await finalizerOver(w, e).results.finalize(OP_A, w.auditId, body);
    assert.ok(restarted.ok && restarted.value.replayed, `depois do reinício: ${show(restarted)}`);
    assert.deepEqual((await ledgerRecords(w)).map((r) => r.event), ['GENESIS', 'INTENT', 'CONFIRMED', 'RUN_INTENT', 'RUN_CONFIRMED'], 'um resultado só, sem duplicar');
    assert.deepEqual(fs.readdirSync(path.join(e.base, w.auditId)).filter((name) => /^s\d{4}\.json$/.test(name)), ['s0001.json']);
  });
}

/* ============================================================================ revisão da R1.6 (`junin-01`, BLOQUEADOR 2): o 11b relê e autentica o estado ATUAL antes do 200 */

const show2 = (value: unknown): string => JSON.stringify(value).slice(0, 360);
/** Outro resultado VÁLIDO no lugar de G (mesmo número, sem chave) e, se pedido, o recibo coerente com ele. */
function forgeX(g: ScoreRun): { run: string; receipt: string } {
  const { contentSha256: _hash, ...body } = g as unknown as Record<string, unknown>;
  void _hash;
  const x = seal({ ...body, finalizedAt: g.finalizedAt.replace(/\.\d{3}Z$/, '.999Z') }) as unknown as ScoreRun;
  return { run: serialize(x), receipt: serialize(seal({ schemaVersion: 1, kind: 'LINK_AUDIT_SCORE_RUN_ANCHOR', auditId: g.auditId, seq: g.seq, headSha256: x.contentSha256, anchoredAt: g.finalizedAt, prevAnchorSha256: null })) };
}
/** FsOps dos RESULTADOS que executa `tamper` uma vez, no primeiro fsync da pasta de resultados da auditoria: exatamente entre a validação inicial (1b) e o sync do 11b. */
function tamperAtReplaySync(e: ResultsEnv, auditId: string, tamper: () => void): FsOps {
  let done = false;
  return {
    ...nodeFsOps,
    async syncDirectory(target) {
      if (!done && target === path.join(e.base, auditId)) {
        done = true;
        tamper();
      }
      return nodeFsOps.syncDirectory(target);
    },
  };
}
const writable = (file: string, data: string): void => {
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, data);
};

test('revisão da R1.6 (BLOQUEADOR 2): RUN_CONFIRMED removido do livro entre a validação inicial e o sync do 11b ⇒ nunca 200; o livro relido não confirma mais o resultado (409 RESULT_INTEGRITY)', async () => {
  const { w, e, body } = await confirmed();
  const tail = path.join(w.ledgerDir, w.auditId, 'l000005.json');
  assert.equal((await ledgerRecords(w))[4]?.event, 'RUN_CONFIRMED');
  const replay = await finalizerOver(w, e, { resultsFs: tamperAtReplaySync(e, w.auditId, () => fs.rmSync(tail)) }).results.finalize(OP_A, w.auditId, body);
  assert.ok(!replay.ok, show2(replay));
  assert.deepEqual([replay.code, RESULTS_HTTP_STATUS[replay.code]], ['RESULT_INTEGRITY', 409], show2(replay));
});

test('revisão da R1.6 (BLOQUEADOR 2): sNNNN trocado no mesmo intervalo (com e sem recibo coerente) ⇒ nunca 200; o resultado relido não é o confirmado (409)', async () => {
  for (const coherent of [false, true]) {
    const { w, e, body } = await confirmed();
    const g = (await runsOf(e, w.auditId)).runs[0] as ScoreRun;
    const x = forgeX(g);
    const tamper = (): void => {
      writable(runPath(e, 1, w.auditId), x.run);
      if (coherent) writable(receiptPath(e, 1, w.auditId), x.receipt);
    };
    const replay = await finalizerOver(w, e, { resultsFs: tamperAtReplaySync(e, w.auditId, tamper) }).results.finalize(OP_A, w.auditId, body);
    assert.ok(!replay.ok, `recibo coerente=${coherent}: ${show2(replay)}`);
    assert.equal(RESULTS_HTTP_STATUS[replay.code], 409, `recibo coerente=${coherent}: ${show2(replay)}`);
    assert.ok(['RESULT_INTEGRITY', 'RESULT_ANCHOR_MISMATCH'].includes(replay.code), show2(replay));
    // o armazenamento relê o resultado ANTES do livro (16.17.8): a divergência sai como a do arquivo, não como a da vista
    if (coherent) assert.ok(replay.issues.some((issue) => /resultado relido depois da sincronização/.test(issue)), show2(replay));
  }
});

test('revisão da R1.6 (BLOQUEADOR 2): pasta do livro da auditoria removida no mesmo intervalo ⇒ nunca 200 (o sync estrito do livro exige a pasta; 409 RESULT_INTEGRITY: o livro sumiu com resultado confirmado)', async () => {
  const { w, e, body } = await confirmed();
  const replay = await finalizerOver(w, e, { resultsFs: tamperAtReplaySync(e, w.auditId, () => fs.rmSync(path.join(w.ledgerDir, w.auditId), { recursive: true })) }).results.finalize(OP_A, w.auditId, body);
  assert.ok(!replay.ok, show2(replay));
  assert.deepEqual([replay.code, RESULTS_HTTP_STATUS[replay.code]], ['RESULT_INTEGRITY', 409], show2(replay));
});

test('revisão da R1.6 (BLOQUEADOR 2): sync ESTRITO do livro só para quem pede (11b e reemissão) — pasta da auditoria ausente, insegura ou ilegível ⇒ recusa; o padrão dos demais chamadores (RECOVER, adoção de fechos, barreira) continua como antes', async () => {
  const root = tmpDir('lad-r16-led-');
  const auditId = 'auditoria-sync-0001';
  assert.deepEqual(await syncLedgerDirectory(root, auditId), { ok: true }, 'padrão: pasta ausente ⇒ nada a sincronizar (inalterado)');
  const absent = await syncLedgerDirectory(root, auditId, { requireExisting: true });
  assert.deepEqual([absent.ok, absent.ok ? null : absent.code], [false, 'ABSENT']);
  fs.writeFileSync(path.join(root, auditId), 'não sou pasta');
  const unsafe = await syncLedgerDirectory(root, auditId, { requireExisting: true });
  assert.deepEqual([unsafe.ok, unsafe.ok ? null : unsafe.code], [false, 'UNSAFE_PATH']);
  assert.deepEqual(await syncLedgerDirectory(root, auditId), { ok: true }, 'padrão inalterado (o leitor recusa a forma hostil por conta própria)');
  fs.rmSync(path.join(root, auditId));
  const unreadable = await syncLedgerDirectory(root, auditId, { requireExisting: true, fs: { ...nodeFsOps, async lstat() { throw Object.assign(new Error('E/S simulada'), { code: 'EIO' }); } } });
  assert.deepEqual([unreadable.ok, unreadable.ok ? null : unreadable.code], [false, 'UNREADABLE']);
  fs.mkdirSync(path.join(root, auditId));
  assert.deepEqual(await syncLedgerDirectory(root, auditId, { requireExisting: true }), { ok: true }, 'pasta presente: sincroniza');
});

test('revisão da R1.6 (BLOQUEADOR 2): a porta dos RESULTADOS sincroniza o livro no modo estrito — pasta do livro removida ⇒ recusa com LEDGER_REMOVED_WITNESSED (a do livro das decisões continua no padrão)', async () => {
  const { w, e } = await confirmed();
  const f = finalizerOver(w, e);
  const port = f.decisions.resultsLedger as NonNullable<typeof f.decisions.resultsLedger>;
  assert.deepEqual(await port.sync({ auditId: w.auditId }), { ok: true });
  fs.rmSync(path.join(w.ledgerDir, w.auditId), { recursive: true });
  const refused = await port.sync({ auditId: w.auditId });
  assert.ok(!refused.ok && refused.refusal.code === 'LEDGER_UNAVAILABLE' && refused.refusal.reason === 'LEDGER_REMOVED_WITNESSED', show2(refused));
  assert.deepEqual(await f.ledger.sync(w.auditId), { ok: true }, 'LedgerPort.sync sem o modo estrito: inalterado');
});

test('revisão da R1.6 (BLOQUEADOR 2): fora de PROTECTED o reenvio idêntico não responde 200 — no legado (livro ausente) o resultado v1 não tem RUN_CONFIRMED que o confirme', async () => {
  const w = await ledgerWorld();
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  fs.rmSync(path.join(w.ledgerDir, w.auditId), { recursive: true });
  const evaluation = buildEvaluation({ auditId: w.auditId });
  const body = { expectedHead: evaluation.decisions.head, expectedInputSha256: evaluation.inputSha256 as string };
  assert.ok((await makeService(e, new FakeEvaluator(evaluation)).finalize(OP_A, w.auditId, body)).ok, 'v1 plantado sem o livro');
  const replay = await makeService(e, new FakeEvaluator(evaluation), { ledger: finalizerOver(w, e).decisions.resultsLedger as NonNullable<ReturnType<typeof finalizerOver>['decisions']['resultsLedger']> }).finalize(OP_A, w.auditId, body);
  assert.ok(!replay.ok && replay.code === 'LEDGER_LEGACY_READ_ONLY', show2(replay));
});

test('revisão da R1.6 (MENOR): o texto de RESULT_DURABILITY_UNKNOWN serve à finalização, ao reenvio e à reemissão — não afirma que "nenhum resultado foi confirmado" (no reenvio e na reemissão ele já é confirmado pelo livro)', () => {
  const text = RESULTS_MESSAGE.RESULT_DURABILITY_UNKNOWN;
  assert.doesNotMatch(text, /nenhum resultado foi confirmado/i);
  assert.doesNotMatch(text, /Nada foi gravado/i);
  assert.match(text, /NÃO é sucesso/);
  assert.match(text, /esta tentativa/i);
  assert.match(text, /reiniciar/);
});
