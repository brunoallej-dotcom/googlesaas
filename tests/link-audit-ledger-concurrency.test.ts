import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { replayLedger } from '../src/lib/link-audit-ledger';
import { ANA, BIA, must, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { decisionsOver, ledgerEvents, ledgerFor, ledgerRecords, ledgerWorld, NO_RESULTS, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';

/*
 * CONCORRÊNCIA REAL ENTRE PROCESSOS (não só mutex em memória): vários processos Node distintos escrevem ao mesmo tempo na MESMA auditoria, cada um com seu
 * subcritério. A exclusão mútua vem do `link()` exclusivo do INTENT no livro e da entrada de decisão. Prova: nenhuma atualização perdida, nenhuma posição
 * duplicada, cadeia do livro e das decisões íntegras, e nenhuma operação abortada à toa.
 */
registerCleanup();
const ROOT = path.resolve(__dirname, '..');
const REGISTER = path.join(ROOT, 'tests', 'register-typescript.cjs');
const CHILD = path.join(ROOT, 'tests', 'helpers', 'ledger-child.ts');

function child(w: LedgerWorld, config: Record<string, unknown>): Promise<{ status: number | null; line: Record<string, unknown> | null; stderr: string }> {
  const payload = { decisionsDir: w.decisionsDir, anchorDir: w.anchorDir, evidenceDir: w.evidenceDir, ledgerDir: w.ledgerDir, auditId: w.auditId, actor: 'ana@empresa.com', ...config };
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--require', REGISTER, CHILD], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LEDGER_CHILD: JSON.stringify(payload) } as unknown as NodeJS.ProcessEnv });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk) => (out += chunk));
    proc.stderr.on('data', (chunk) => (err += chunk));
    const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
    proc.on('close', (status) => {
      clearTimeout(timer);
      const last = out.trim().split('\n').pop() ?? '';
      resolve({ status, line: last.startsWith('{') ? (JSON.parse(last) as Record<string, unknown>) : null, stderr: err });
    });
  });
}

test('5 PROCESSOS escrevem ao mesmo tempo na mesma auditoria (criar + revogar, 3 rodadas cada): nada se perde, nada se duplica, livro e decisões íntegros e coerentes', async () => {
  const w = await ledgerWorld();
  const workers = [0, 1, 2, 3, 4];
  const results = await Promise.all(workers.map((worker) => child(w, { task: 'workload', worker, rounds: 3, actor: worker % 2 === 0 ? 'ana@empresa.com' : 'bia@empresa.com' })));
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 0, `trabalhador ${index}: ${result.stderr.slice(0, 300)}`);
    assert.deepEqual(result.line?.fatal, [], `trabalhador ${index}: ${JSON.stringify(result.line)}`);
    assert.equal(result.line?.writes, 6, `trabalhador ${index} concluiu todas as escritas`);
  }
  const service = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS });
  const view = await must(service.list(ANA, w.auditId));
  assert.deepEqual([view.ledger.state, view.ledger.reason, view.ledger.confirmedDecisions, view.history.length, view.decisions.length, view.finalizable], ['PROTECTED', null, 30, 30, 0, true]);
  assert.deepEqual(view.history.map((entry) => entry.seq), Array.from({ length: 30 }, (_, i) => i + 1), 'posições contíguas, sem lacuna nem repetição');
  const creations = view.history.filter((entry) => entry.action === 'RECORD');
  assert.equal(new Set(creations.map((entry) => entry.decisionId)).size, 15, 'ids únicos');
  assert.equal(view.allDecisions.filter((d) => d.status === 'REVOKED').length, 15);
  // o livro: GENESIS + 30 × (INTENT, CONFIRMED), encadeado, sem ABORTED (ninguém foi abortado à toa)
  const events = await ledgerEvents(w);
  assert.equal(events.length, 61);
  assert.deepEqual([events.filter((e) => e === 'INTENT').length, events.filter((e) => e === 'CONFIRMED').length, events.filter((e) => e === 'ABORTED').length], [30, 30, 0]);
  assert.equal(replayLedger(await ledgerRecords(w), w.auditId).ok, true);
  // cada INTENT está imediatamente fechado pelo CONFIRMED do mesmo opId (uma operação por vez, mesmo entre processos)
  const records = await ledgerRecords(w);
  for (let i = 1; i < records.length; i += 2) {
    assert.equal(records[i]?.event, 'INTENT');
    assert.equal(records[i + 1]?.event, 'CONFIRMED');
    assert.equal(records[i + 1]?.op?.opId, records[i]?.op?.opId);
  }
  const retries = results.reduce((sum, result) => sum + Number(result.line?.retries ?? 0), 0);
  assert.ok(retries >= 0);
  // falsos alarmes TRANSITÓRIOS de leitura sob carga (livro lido antes das decisões): contados e nunca fatais; o estado FINAL acima é íntegro
  console.log(`[concorrência] corridas de leitura retentadas: ${results.reduce((sum, result) => sum + Number(result.line?.races ?? 0), 0)}`);
});

test('várias INSCRIÇÕES simultâneas da mesma auditoria vazia: exatamente UM GENESIS (os demais processos são recusados, nunca duplicam)', async () => {
  const w = await ledgerWorld({ enroll: false });
  const results = await Promise.all([0, 1, 2, 3].map(() => child(w, { task: 'enroll' })));
  assert.ok(results.every((result) => result.status === 0 && result.line !== null));
  assert.equal(results.filter((result) => result.line?.ok === true).length, 1, 'um vencedor');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS']);
  assert.equal((await must(decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS }).list(BIA, w.auditId))).ledger.state, 'PROTECTED');
});
