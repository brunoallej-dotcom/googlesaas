import { spawn } from 'node:child_process';
import path from 'node:path';
import type { LedgerSource } from '../../src/lib/link-audit-decisions';
import { createResultsKnownHeads } from '../../src/lib/link-audit-scoring-runs';
import type { ScoreRun } from '../../src/lib/link-audit-scoring-runs/results-types';
import { readRunLog } from '../../src/lib/link-audit-scoring-runs/results-store';
import { ANA, clock, must, rec } from './link-audit-decisions-fixtures';
import { TEST_ORIGIN } from './link-audit-origin-fixtures';
import { previewOver } from './link-audit-preview-fixtures';
import { makeService, OP_A, resultsEnv, type ResultsEnv } from './link-audit-results-fixtures';
import { decisionsOver, ledgerFor, ledgerWorld, type LedgerWorld } from './link-audit-ledger-fixtures';

/*
 * Cenários LIVRO × RESULTADOS compartilhados pelos testes de desacordo (M29) e de recuperação: auditoria protegida, resultado v2 selado que CITA a cabeça do livro,
 * serviços sobre as mesmas pastas (a testemunha dos resultados é a REAL) e um filho (processo à parte) que enxerga os mesmos resultados.
 */
export const witnessOver = (w: LedgerWorld, e: ResultsEnv) => createResultsKnownHeads({ baseDir: e.base, anchorDir: e.anchors, otherDirs: [w.decisionsDir, w.anchorDir, w.evidenceDir, w.ledgerDir], origin: TEST_ORIGIN });
export const servicesOver = (w: LedgerWorld, e: ResultsEnv, over: { ledger?: LedgerSource } = {}) => decisionsOver(w, { ledger: over.ledger ?? ledgerFor(w, { guard: null }), knownHeads: witnessOver(w, e) });

/** Finaliza (sela) um resultado v2 sobre o estado atual da auditoria e devolve o registro selado. */
export async function sealResult(w: LedgerWorld, e: ResultsEnv): Promise<ScoreRun> {
  const decisions = servicesOver(w, e);
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: decisions });
  const evaluated = await preview.evaluate(OP_A, w.auditId);
  if (!evaluated.ok) throw new Error(`prévia: ${JSON.stringify(evaluated).slice(0, 200)}`);
  const done = await makeService(e, preview).finalize(OP_A, w.auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string });
  if (!done.ok) throw new Error(`finalização: ${JSON.stringify(done).slice(0, 240)}`);
  const read = await readRunLog(e.base, w.auditId, { anchorDir: e.anchors });
  if (!read.ok) throw new Error('resultados ilegíveis');
  return read.value.runs[read.value.runs.length - 1] as ScoreRun;
}

/** Auditoria protegida com UMA decisão e um resultado v2 selado sobre ela (o resultado cita a cabeça do livro = o `CONFIRMED`). */
export async function sealedWorld(): Promise<{ w: LedgerWorld; e: ResultsEnv; run: ScoreRun }> {
  const w = await ledgerWorld();
  const e = resultsEnv();
  await must(w.protectedService.create(ANA, w.auditId, { record: rec.c2() }, clock()));
  return { w, e, run: await sealResult(w, e) };
}

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTER = path.join(ROOT, 'tests', 'register-typescript.cjs');
const CHILD = path.join(ROOT, 'tests', 'helpers', 'ledger-child.ts');
/** Roda UM processo Node à parte (concorrência de verdade) sobre as pastas do mundo, vendo também os resultados. */
export function runChild(w: LedgerWorld, e: ResultsEnv | null, config: Record<string, unknown>): Promise<{ status: number | null; line: Record<string, unknown> | null; stderr: string }> {
  const payload = { decisionsDir: w.decisionsDir, anchorDir: w.anchorDir, evidenceDir: w.evidenceDir, ledgerDir: w.ledgerDir, auditId: w.auditId, actor: 'ana@empresa.com', ...(e ? { resultsDir: e.base, resultsAnchorDir: e.anchors } : {}), ...config };
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['--require', REGISTER, CHILD], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LEDGER_CHILD: JSON.stringify(payload) } as unknown as NodeJS.ProcessEnv });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk) => (out += chunk));
    proc.stderr.on('data', (chunk) => (err += chunk));
    const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
    proc.on('close', (status) => {
      clearTimeout(timer);
      // a ÚLTIMA linha JSON (módulos de fixtures que registram hooks do `node:test` acrescentam um resumo TAP depois da resposta do filho)
      const last = [...out.trim().split('\n')].reverse().find((line) => line.startsWith('{')) ?? '';
      resolve({ status, line: last.startsWith('{') ? (JSON.parse(last) as Record<string, unknown>) : null, stderr: err });
    });
  });
}
