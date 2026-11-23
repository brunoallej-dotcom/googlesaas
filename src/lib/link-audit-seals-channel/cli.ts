import nodePath from 'node:path';
import { z } from 'zod';
import { errorCode, type BytesFsOps } from '../link-audit/fs-ops';
import { parseNameStatus, parseTreeModes } from './changes';
import { runSealsCheck, type SealsCheckReport } from './check';
import { refusal } from './codes';
import { CHANNEL_ENVIRONMENTS, TRUST_LIST_FILE, type ChannelEnvironment } from './paths';
import { firstRefusalCode, summaryLines } from './summary';
import { MAX_TRUST_LIST_BYTES } from './trust-list';
import type { BaseTrustList } from './trust-rules';

/*
 * P9.2 — o comando `npm run link-audit:seals-check -- --changes <arquivo> --modes <arquivo> --base-trust <pasta> --repo <raiz>` (spec §5.4).
 * Entrada validada por zod (estrito) na fronteira; disco só pela porta `BytesFsOps` que o script entrega (`nodeFsOps`). Não chama git nem rede.
 * Saída: o resumo público em Markdown no stdout (o job o acrescenta a `$GITHUB_STEP_SUMMARY`) e, na recusa, UMA linha `ERRO <CÓDIGO>` no
 * stderr. Nunca conteúdo de arquivo, caminho de disco ou valor recebido.
 *
 * Códigos de saída: 0 nada recusado (ou nada sob `link-audit-seals/`); 1 recusa (S-01 a S-13, código da primeira); 2 uso ou entrada
 * ilegível (`SEALS_USAGE`, `SEALS_INPUT_INVALID`); 3 falha inesperada (`SEALS_INTERNAL`). Tudo diferente de 0 deixa o job vermelho.
 */

export const SEALS_CHECK_EXIT = { OK: 0, REFUSED: 1, USAGE: 2, UNEXPECTED: 3 } as const;
/** A lista de mudanças: acima disso, a mudança tem arquivos demais (S-05), sem ler o resto. */
export const MAX_CHANGES_BYTES = 8 * 1024 * 1024;
/** Os modos da árvore inteira sob `link-audit-seals/` (cresce com o histórico de manifestos). */
export const MAX_MODES_BYTES = 64 * 1024 * 1024;
export const USAGE_LINES = ['Uso: npm run link-audit:seals-check -- --changes <arquivo> --modes <arquivo> --base-trust <pasta> --repo <raiz>'] as const;
const MAX_ARG_LENGTH = 4096;

type Line = (line: string) => void;
export interface SealsCheckCliDeps {
  readonly fs: BytesFsOps;
}

const pathArg = z
  .string()
  .min(1)
  .max(MAX_ARG_LENGTH)
  .refine((value) => !value.includes('\0') && !value.startsWith('--'));
const argsSchema = z.object({ changes: pathArg, modes: pathArg, baseTrust: pathArg, repo: pathArg }).strict();
type SealsCheckArgs = z.infer<typeof argsSchema>;
const FLAGS: Readonly<Record<string, keyof SealsCheckArgs>> = { '--changes': 'changes', '--modes': 'modes', '--base-trust': 'baseTrust', '--repo': 'repo' };

/** `--flag valor` para as quatro opções, cada uma exatamente uma vez; qualquer outra coisa ⇒ `null`. */
export function parseSealsCheckArgs(argv: readonly string[]): SealsCheckArgs | null {
  if (argv.length % 2 !== 0) return null;
  const collected: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = FLAGS[argv[index] ?? ''];
    if (key === undefined || key in collected) return null;
    collected[key] = argv[index + 1] as string;
  }
  const parsed = argsSchema.safeParse(collected);
  return parsed.success ? parsed.data : null;
}

class InputError extends Error {
  constructor() {
    super('entrada do seals-check ilegível');
    this.name = 'InputError';
  }
}

async function readInput(fs: BytesFsOps, file: string, cap: number): Promise<Uint8Array | 'TOO_LARGE'> {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new InputError();
    if (info.size > cap) return 'TOO_LARGE';
    return await fs.readFileBytes(file, cap);
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (errorCode(error) === 'ETOOBIG') return 'TOO_LARGE';
    throw new InputError();
  }
}

/** A lista do commit-base de um ambiente: `<base-trust>/<amb>/trust-keys.txt`. Ausente = primeira introdução; defeito = ilegível. */
async function readBaseTrust(fs: BytesFsOps, dir: string, env: ChannelEnvironment): Promise<BaseTrustList> {
  const file = nodePath.join(dir, env, TRUST_LIST_FILE);
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TRUST_LIST_BYTES) return { kind: 'unreadable' };
    return { kind: 'bytes', bytes: await fs.readFileBytes(file, MAX_TRUST_LIST_BYTES) };
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' };
  }
}

async function repoRootOf(fs: BytesFsOps, repo: string): Promise<string> {
  try {
    const real = await fs.realpath(nodePath.resolve(repo));
    if (!(await fs.lstat(real)).isDirectory()) throw new InputError();
    return real;
  } catch {
    throw new InputError();
  }
}

const TOO_MANY_CHANGES: SealsCheckReport = { touched: true, refusals: [refusal('S-05', 'SEALS_TOO_MANY')], manifests: [], closures: [], trustLists: [], chains: [] };

async function buildReport(args: SealsCheckArgs, fs: BytesFsOps): Promise<SealsCheckReport> {
  const repoRoot = await repoRootOf(fs, args.repo);
  const changesRaw = await readInput(fs, args.changes, MAX_CHANGES_BYTES);
  if (changesRaw === 'TOO_LARGE') return TOO_MANY_CHANGES;
  const changes = parseNameStatus(changesRaw);
  const modesRaw = await readInput(fs, args.modes, MAX_MODES_BYTES);
  const modes = modesRaw === 'TOO_LARGE' ? null : parseTreeModes(modesRaw);
  if (!changes.ok || modes === null) throw new InputError();
  const baseTrust = {} as Record<ChannelEnvironment, BaseTrustList>;
  for (const env of CHANNEL_ENVIRONMENTS) baseTrust[env] = await readBaseTrust(fs, args.baseTrust, env);
  return runSealsCheck({ repoRoot, changes: changes.entries, modes, baseTrust }, { fs });
}

/** O comando inteiro: devolve o código de saída. Nunca lança. */
export async function runSealsCheckCli(argv: readonly string[], out: Line, err: Line, deps: SealsCheckCliDeps): Promise<number> {
  const args = parseSealsCheckArgs(argv);
  if (args === null) {
    USAGE_LINES.forEach(err);
    err('ERRO SEALS_USAGE');
    return SEALS_CHECK_EXIT.USAGE;
  }
  let report: SealsCheckReport;
  try {
    report = await buildReport(args, deps.fs);
  } catch (error) {
    err(error instanceof InputError ? 'ERRO SEALS_INPUT_INVALID' : 'ERRO SEALS_INTERNAL');
    return error instanceof InputError ? SEALS_CHECK_EXIT.USAGE : SEALS_CHECK_EXIT.UNEXPECTED;
  }
  summaryLines(report).forEach(out);
  const first = firstRefusalCode(report);
  if (first === null) return SEALS_CHECK_EXIT.OK;
  err(`ERRO ${first}`);
  return SEALS_CHECK_EXIT.REFUSED;
}
