import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { RESULTS_MESSAGE } from '../src/lib/link-audit-scoring-runs/results';
import { clearStorageFatal } from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { ledgerRecords, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { OP_A, OP_B, type ResultsEnv } from './helpers/link-audit-results-fixtures';
import { bodyNow, everythingOf, finalizerOver, protectedWorld, type FinalizerOver } from './helpers/link-audit-results-ledger-finalize-fixtures';

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
