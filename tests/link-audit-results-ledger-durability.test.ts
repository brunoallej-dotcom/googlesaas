import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { clearStorageFatal } from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { RESULTS_MESSAGE } from '../src/lib/link-audit-scoring-runs/results';
import { BIA, clock, must, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { ledgerRecords, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { servicesOver } from './helpers/link-audit-ledger-results-fixtures';
import { AGED_OTHERS, bodyNow, everyResultHasIntent, finalizerOver, footprintOf, protectedWorld, runsOf } from './helpers/link-audit-results-ledger-finalize-fixtures';
import { OP_A, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R1.3 — DURABILIDADE da finalização pelo livro (D-15, R7-04, RL-20, M-R17). Em auditoria protegida o fsync das pastas de resultados e de recibos deixa de ser melhor-esforço:
 *  - passo 5: as RAÍZES (pais dos nomes das pastas da auditoria) antes do RUN_INTENT; passo 6/11: a publicação do livro (já estrita); passo 8: a pasta de resultados da auditoria
 *    depois de `sk`; passo 10: a pasta de recibos da auditoria depois de `ak`;
 *  - falha (EIO/EINVAL/ENOTSUP) ⇒ NUNCA sucesso: RESULT_DURABILITY_UNKNOWN, as bases travam (escritas recusadas até reiniciar), a mensagem nunca diz "Nada foi gravado" nem cita
 *    caminho; depois do reinício o MESMO pedido conclui sem duplicar (antes do RUN_INTENT, na fase A já vencida, em B/C pela conclusão do autor — R1.4; na R1.3 a operação ficava
 *    aberta e este teste fixava isso — e depois do RUN_CONFIRMED).
 * Falhas injetadas por `FsOps` (nenhum disco real quebrado); "reinício" = `clearStorageFatal()` + serviços novos.
 */
registerCleanup();
test.afterEach(() => clearStorageFatal());

const show = (value: unknown): string => JSON.stringify(value).slice(0, 280);
const BASE = ['GENESIS', 'INTENT', 'CONFIRMED'];
const failure = (code: string): Error => Object.assign(new Error(`fsync simulado (${code})`), { code });

/** FsOps cujo fsync do diretório `dir` falha (opcionalmente só depois que `whenExists` existe nele: exatamente a sincronização que tornaria aquele arquivo durável). */
function failingSync(dir: string, code: string, whenExists?: string): FsOps {
  return {
    ...nodeFsOps,
    async syncDirectory(target) {
      if (target === dir && (whenExists === undefined || fs.existsSync(path.join(target, whenExists)))) throw failure(code);
      return nodeFsOps.syncDirectory(target);
    },
  };
}

interface Case {
  readonly label: string;
  readonly code: string;
  readonly over: (w: LedgerWorld, e: ResultsEnv) => Parameters<typeof finalizerOver>[2];
  /** Eventos do livro e arquivos publicados depois da falha. */
  readonly events: readonly string[];
  readonly run: boolean;
  readonly receipt: boolean;
  /** O que o MESMO pedido faz depois do reinício (`RECOVERS`: conclui a pendente B/C pelo autor, R1.4). */
  readonly afterRestart: 'CONCLUDES' | 'REPLAYED' | 'RECOVERS';
}
const CASES: readonly Case[] = [
  { label: 'passo 5: raiz de resultados (EIO)', code: 'EIO', over: (_w, e) => ({ resultsFs: failingSync(e.base, 'EIO') }), events: BASE, run: false, receipt: false, afterRestart: 'CONCLUDES' },
  { label: 'passo 5: raiz de recibos (ENOTSUP)', code: 'ENOTSUP', over: (_w, e) => ({ resultsFs: failingSync(e.anchors, 'ENOTSUP') }), events: BASE, run: false, receipt: false, afterRestart: 'CONCLUDES' },
  { label: 'passo 6: pasta do livro ao publicar o RUN_INTENT (EINVAL)', code: 'EINVAL', over: (w) => ({ ledger: { fs: failingSync(path.join(w.ledgerDir, w.auditId), 'EINVAL', 'l000004.json') } }), events: [...BASE, 'RUN_INTENT'], run: false, receipt: false, afterRestart: 'CONCLUDES' },
  { label: 'passo 8: pasta de resultados da auditoria (EIO)', code: 'EIO', over: (w, e) => ({ resultsFs: failingSync(path.join(e.base, w.auditId), 'EIO', 's0001.json') }), events: [...BASE, 'RUN_INTENT'], run: true, receipt: false, afterRestart: 'RECOVERS' },
  { label: 'passo 10: pasta de recibos da auditoria (ENOTSUP)', code: 'ENOTSUP', over: (w, e) => ({ resultsFs: failingSync(path.join(e.anchors, w.auditId), 'ENOTSUP', 'a0001.json') }), events: [...BASE, 'RUN_INTENT'], run: true, receipt: true, afterRestart: 'RECOVERS' },
  { label: 'passo 11: pasta do livro ao publicar o RUN_CONFIRMED (EIO)', code: 'EIO', over: (w) => ({ ledger: { fs: failingSync(path.join(w.ledgerDir, w.auditId), 'EIO', 'l000005.json') } }), events: [...BASE, 'RUN_INTENT', 'RUN_CONFIRMED'], run: true, receipt: true, afterRestart: 'REPLAYED' },
];

for (const item of CASES) {
  test(`RL-20 / M-R17: fsync falho no ${item.label} ⇒ nunca sucesso, RESULT_DURABILITY_UNKNOWN, base trava, sem "Nada foi gravado" nem caminho; depois do reinício o mesmo pedido ${item.afterRestart === 'RECOVERS' ? 'conclui a pendente pelo autor (R1.4)' : 'conclui sem duplicar'}`, async () => {
    const { w, e } = await protectedWorld();
    const f = finalizerOver(w, e, item.over(w, e));
    const body = await bodyNow(f, OP_A, w.auditId);
    const done = await f.results.finalize(OP_A, w.auditId, body);
    assert.ok(!done.ok && done.code === 'RESULT_DURABILITY_UNKNOWN', show(done));
    assert.ok(!/Nada foi gravado/i.test(RESULTS_MESSAGE[done.code]), 'a mensagem nunca diz que nada foi gravado');
    for (const issue of done.issues) assert.ok(!/[\\/]/.test(issue.replace(/n\/v/gi, '')), `sem caminho no texto: ${issue}`);
    assert.deepEqual((await ledgerRecords(w)).map((r) => r.event), item.events, 'livro');
    assert.deepEqual([fs.existsSync(path.join(e.base, w.auditId, 's0001.json')), fs.existsSync(path.join(e.anchors, w.auditId, 'a0001.json'))], [item.run, item.receipt], 'resultado e recibo');
    const { all } = await runsOf(e, w.auditId);
    assert.ok(everyResultHasIntent(await ledgerRecords(w), all), 'nenhum resultado sem RUN_INTENT');

    // a base travou: a próxima tentativa NESTE processo (disco "saudável" de novo) também não é sucesso e não grava nada
    const before = await footprintOf(w, e);
    const again = await finalizerOver(w, e).results.finalize(OP_A, w.auditId, body);
    assert.ok(!again.ok, `depois de um fsync falho nada é presumido até reiniciar: ${show(again)}`);
    assert.deepEqual(await footprintOf(w, e), before, 'nada gravado com a base travada');

    // reinício
    clearStorageFatal();
    const restarted = await finalizerOver(w, e, { ledger: AGED_OTHERS }).results.finalize(OP_A, w.auditId, body);
    assert.ok(restarted.ok, show(restarted));
    assert.equal(restarted.value.replayed, item.afterRestart !== 'CONCLUDES');
    assert.equal(restarted.value.recoveredPending, item.afterRestart === 'RECOVERS');
    const records = await ledgerRecords(w);
    const expected = item.events.length === 4 && item.afterRestart === 'CONCLUDES' ? [...BASE, 'RUN_INTENT', 'RUN_ABORTED', 'RUN_INTENT', 'RUN_CONFIRMED'] : [...BASE, 'RUN_INTENT', 'RUN_CONFIRMED'];
    assert.deepEqual(records.map((r) => r.event), expected);
    const after = await runsOf(e, w.auditId);
    assert.deepEqual([after.all.length, after.runs.length], [1, 1], 'exatamente um resultado');
    const view = await must(servicesOver(w, e).list(BIA, w.auditId, clock()));
    assert.deepEqual([view.ledger.state, view.ledger.runs?.open, view.ledger.runs?.confirmed.length], ['PROTECTED', null, 1]);
  });
}

test('D-15 / M-R17 (ordem dos fsyncs): as raízes de resultados e de recibos são sincronizadas ANTES do RUN_INTENT; a pasta de resultados da auditoria depois de s0001 e antes do recibo; a de recibos depois de a0001 e antes do RUN_CONFIRMED', async () => {
  const { w, e } = await protectedWorld();
  const log: string[] = [];
  const traced: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      await nodeFsOps.link(from, to);
      log.push(`link ${to}`);
    },
    async syncDirectory(dir) {
      await nodeFsOps.syncDirectory(dir);
      log.push(`sync ${dir}`);
    },
  };
  const f = finalizerOver(w, e, { ledger: { fs: traced }, resultsFs: traced });
  const done = await f.results.finalize(OP_A, w.auditId, await bodyNow(f, OP_A, w.auditId));
  assert.ok(done.ok, show(done));
  const index = (line: string): number => log.indexOf(line);
  const last = (line: string): number => log.lastIndexOf(line);
  const runIntent = index(`link ${path.join(w.ledgerDir, w.auditId, 'l000004.json')}`);
  const runConfirmed = index(`link ${path.join(w.ledgerDir, w.auditId, 'l000005.json')}`);
  const run = index(`link ${path.join(e.base, w.auditId, 's0001.json')}`);
  const receipt = index(`link ${path.join(e.anchors, w.auditId, 'a0001.json')}`);
  assert.ok([runIntent, runConfirmed, run, receipt].every((i) => i >= 0), show(log));
  const rootsBefore = (dir: string): boolean => log.slice(0, runIntent).includes(`sync ${dir}`);
  assert.ok(rootsBefore(e.base) && rootsBefore(e.anchors), `passo 5: as raízes antes do RUN_INTENT: ${show(log)}`);
  const runDirSyncs = log.map((line, i) => (line === `sync ${path.join(e.base, w.auditId)}` ? i : -1)).filter((i) => i > run);
  assert.ok(runDirSyncs.some((i) => i < receipt), `passo 8: a pasta de resultados da auditoria depois de s0001 e antes do recibo: ${show(log)}`);
  const anchorDirSyncs = log.map((line, i) => (line === `sync ${path.join(e.anchors, w.auditId)}` ? i : -1)).filter((i) => i > receipt);
  assert.ok(anchorDirSyncs.some((i) => i < runConfirmed), `passo 10: a pasta de recibos da auditoria depois de a0001 e antes do RUN_CONFIRMED: ${show(log)}`);
  assert.ok(last(`sync ${path.join(w.ledgerDir, w.auditId)}`) > runConfirmed, 'o RUN_CONFIRMED é publicado de forma estrita (pasta do livro sincronizada depois dele)');
});

test('sem a porta (dependência ausente) o fsync das pastas de resultados continua melhor-esforço, como antes da R1.3 (P-4): a mesma falha do passo 8 não vira erro', async () => {
  const { w, e } = await protectedWorld();
  const f = finalizerOver(w, e, { port: false, resultsFs: failingSync(path.join(e.base, w.auditId), 'EIO', 's0001.json') });
  const done = await f.results.finalize(OP_A, w.auditId, await bodyNow(f, OP_A, w.auditId));
  assert.ok(done.ok, show(done));
  assert.deepEqual((await ledgerRecords(w)).map((r) => r.event), BASE);
});
