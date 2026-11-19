import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runSealCli, type SealCliDeps } from '../../scripts/link-audit-seal';
import { buildReportFromCapture } from '../../src/lib/link-audit/collector/capture-report';
import { writeCapture, writeReport } from '../../src/lib/link-audit-evidence/store';
import { inputFor, T_NOW } from './link-audit-collect-fixtures';
import { AUDIT, bodyText, captureInput, COLLECTED_AT, identity, tmpDir } from './link-audit-evidence-fixtures';

/* Dados 100% FICTÍCIOS, em pastas temporárias. P1 W2: fixtures do `export` (pacote candidato). */
export const T_COLLECT = COLLECTED_AT; // 2026-10-22T12:54:48.079Z
export const HOUR = 3_600_000;
export const at = (iso: string, plusMs = 0): Date => new Date(Date.parse(iso) + plusMs);
/** Duas horas depois da coleta padrão: dentro de qualquer janela razoável. */
export const NOW = at(T_COLLECT, 2 * HOUR);

export interface CaptureSpec {
  readonly collectedAt?: string;
  readonly status?: number | null;
  /** Relatório gravado para a captura (padrão: só para a primeira). */
  readonly report?: boolean;
}

export interface FixtureAudit {
  readonly base: string;
  readonly auditId: string;
  readonly dir: string;
  readonly captures: ReadonlyArray<{ readonly n: number; readonly contentSha256: string }>;
}

/** Pasta versionada com as capturas pedidas (o mesmo armazenamento de produção). Cada captura tem um corpo distinto (sem deduplicação). */
export async function makeAudit(specs: readonly CaptureSpec[] = [{}], opts: { readonly base?: string; readonly auditId?: string } = {}): Promise<FixtureAudit> {
  const base = opts.base ?? tmpDir('lase-');
  const auditId = opts.auditId ?? AUDIT;
  const captures: Array<{ n: number; contentSha256: string }> = [];
  for (const [index, spec] of specs.entries()) {
    const text = bodyText({ fixtureIndex: index });
    const collectedAt = spec.collectedAt ?? T_COLLECT;
    const status = spec.status === undefined ? 200 : spec.status;
    const input = captureInput({ auditId, body: text, collectedAt, response: { httpStatus: status, attempts: 1, bodyText: text, failure: status !== null && status >= 200 && status <= 299 ? null : 'falha de teste' } });
    const capture = await writeCapture(base, input);
    if (!capture.ok || capture.value.duplicate) throw new Error(`fixture: captura ${index + 1} não gravada`);
    captures.push({ n: capture.value.captureNumber, contentSha256: capture.value.contentSha256 });
    if (spec.report ?? index === 0) {
      const built = await buildReportFromCapture({
        rawBody: text, body: { name: `c${String(capture.value.captureNumber).padStart(4, '0')}.capture.json`, sha256: capture.value.contentSha256, bytes: Buffer.byteLength(text) }, otherFiles: [],
        httpStatus: status ?? 0, httpAttempts: 1, collectedAt, input: inputFor(identity(), 'snap-exemplo-0001'), site: null, generatedAt: T_NOW,
      });
      if (!built.ok) throw new Error(`fixture: relatório ${index + 1}: ${built.reason}`);
      const report = await writeReport(base, auditId, capture.value.captureNumber, JSON.parse(JSON.stringify(built.report)) as Record<string, unknown>, T_NOW);
      if (!report.ok) throw new Error(`fixture: relatório ${index + 1} não gravado`);
    }
  }
  return { base, auditId, dir: path.join(base, auditId), captures };
}

export const hashArgs = (audit: FixtureAudit): string[] => audit.captures.flatMap((c) => ['--collector-hash', `c${String(c.n).padStart(4, '0')}=${c.contentSha256}`]);
export const newOut = (): string => path.join(tmpDir('lase-out-'), 'pacote.json');

/** Argumentos completos de um `export` bem-sucedido (pode-se acrescentar/sobrescrever o resto). */
export const exportArgs = (audit: FixtureAudit, extra: readonly string[] = [], out: string | null = newOut()): string[] => [
  'export', '--evidence-dir', audit.base, '--audit', audit.auditId, ...hashArgs(audit), '--max-gap-hours', '24', ...(out === null ? [] : ['--out', out]), ...extra,
];

export interface CliRun {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCli(argv: readonly string[], now: Date = NOW, deps: SealCliDeps = {}): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSealCli(argv, (line) => out.push(line), (line) => err.push(line), () => new Date(now.getTime()), deps);
  return { code, out, err, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** O único objeto JSON da saída padrão (`--json`). */
export const jsonOf = (run: CliRun): Record<string, unknown> => {
  assert1(run.out.length === 1, `--json deve imprimir exatamente uma linha (veio ${run.out.length})`);
  return JSON.parse(run.out[0] ?? '') as Record<string, unknown>;
};
const assert1 = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

export const readJsonFile = <T = Record<string, unknown>>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
export const checkStatus = (pkg: { checks: ReadonlyArray<{ id: string; status: string }> }, id: string): string | undefined => pkg.checks.find((c) => c.id === id)?.status;

/** Estado COMPLETO da árvore (caminho, tipo, modo, tamanho, mtime e SHA-256 do conteúdo): prova que nada foi escrito. */
export function treeHash(dir: string): string {
  const lines: string[] = [];
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const info = fs.lstatSync(full);
      const content = info.isFile() ? createHash('sha256').update(fs.readFileSync(full)).digest('hex') : info.isSymbolicLink() ? `->${fs.readlinkSync(full)}` : '';
      lines.push(`${path.relative(dir, full)}|${info.mode}|${info.size}|${info.mtimeMs}|${content}`);
      if (info.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Árvore em somente leitura (arquivos 0444, pastas 0555); devolve a função que restaura (para a limpeza conseguir apagar). */
export function makeReadOnly(dir: string): () => void {
  const dirs: string[] = [];
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const info = fs.lstatSync(full);
      if (info.isDirectory()) walk(full);
      else if (info.isFile()) fs.chmodSync(full, 0o444);
    }
    dirs.push(current);
  };
  walk(dir);
  for (const current of dirs) fs.chmodSync(current, 0o555);
  return () => {
    for (const current of [...dirs].reverse()) fs.chmodSync(current, 0o755);
  };
}
