import nodePath from 'node:path';
import { parseSealReceiverArgs, type SealReceiverConfig } from './args';
import { errorOutcome, okOutcome, SealReceiverError, type SealReceiverOutcome } from './codes';
import { parseSealCommand, type PutCommand } from './grammar';
import type { PermissionFacts, SealReceiverDeps } from './ports';
import { runPut } from './put';

/*
 * P9.3b — o receptor de manifestos de ponta a ponta (spec §5.7, §5.8): o ÚNICO comando da chave de manifestos. Ordem:
 *  1. ambiente do processo = só `PATH` e `SSH_ORIGINAL_COMMAND` (o wrapper roda `env -i`); parâmetros fixos do wrapper: defeito ⇒ `E_INTERNAL`;
 *  2. log local aberto (`--log`, `0600`); sem ele ⇒ `E_INTERNAL`;
 *  3. o modelo de permissões do Node LIGADO, sem processo filho nem worker, sem grant global de disco e sem escrita concedida sobre a lista
 *     instalada (RC-09: a chave de manifestos nunca troca a lista); senão `E_INTERNAL` (wrapper fora do modelo);
 *  4. gramática fechada (`E_COMMAND`, nada lido do stdin, nada criado);
 *  5. trava de DEFESA do ambiente (`--lock`, `E_LOCKED`; a de verdade é a do kernel, no wrapper);
 *  6. o `put`. Qualquer erro inesperado ⇒ `E_INTERNAL`.
 * Sai sempre com EXATAMENTE uma linha pública (stdout `OK …` ou stderr `ERRO …`); nunca lança.
 */

const ALLOWED_ENV: ReadonlySet<string> = new Set(['PATH', 'SSH_ORIGINAL_COMMAND']);

export interface SealReceiverInvocation {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** O modelo de permissões do processo (`process.permission`); `null` = desligado. */
  readonly permission: PermissionFacts | null;
}

/** Monta as portas para os parâmetros do wrapper (o log depende de `--log`). Pode lançar: vira `E_INTERNAL`. */
export type SealDepsFactory = (config: SealReceiverConfig) => SealReceiverDeps;

const definedKeys = (env: Readonly<Record<string, string | undefined>>): string[] => Object.keys(env).filter((key) => env[key] !== undefined);

/** O ambiente do wrapper: só `PATH` (diretórios absolutos) e `SSH_ORIGINAL_COMMAND`. */
function environmentIsClean(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.PATH;
  if (value === undefined || value === '' || definedKeys(env).some((key) => !ALLOWED_ENV.has(key))) return false;
  return value.split(':').every((entry) => nodePath.posix.isAbsolute(entry));
}

/** Passo 3: o receptor só roda confinado pelo modelo de permissões, como a linha do wrapper (§5.7). Devolve o motivo da recusa, ou `null`. */
export function confinementDefect(permission: PermissionFacts | null, config: SealReceiverConfig): string | null {
  if (permission === null) return 'permission model off';
  if (permission.has('child') || permission.has('worker')) return 'child process or worker allowed';
  if (permission.has('fs.read') || permission.has('fs.write')) return 'global file system grant (only the paths of the wrapper line)';
  if (permission.has('fs.write', config.trustList)) return 'installed trust list writable';
  if (!permission.has('fs.write', config.sealsRoot) || !permission.has('fs.read', config.trustList)) return 'seals root or trust list not granted';
  return null;
}

function errorFields(error: unknown): Record<string, string | null> {
  if (error instanceof SealReceiverError) return { code: error.code, detail: error.detail, note: error.logNote };
  const errno = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : null;
  return { code: 'E_INTERNAL', detail: null, note: `unexpected ${error instanceof Error ? error.name : typeof error}${errno ? ` ${errno}` : ''}` };
}

async function underLock(command: PutCommand, config: SealReceiverConfig, deps: SealReceiverDeps): Promise<string> {
  const release = await deps.lock.tryAcquire(config.lockFile);
  if (release === null) throw new SealReceiverError('E_LOCKED', null, 'the defense lock file exists (another run, or a run killed before releasing it)');
  try {
    return await runPut(command, config, deps);
  } finally {
    await release().catch(() => deps.log.write('lock.release_failed'));
  }
}

/** Uma execução do receptor. Nunca lança; o chamador escreve a linha e sai com `exitCode`. */
export async function runSealReceiver(invocation: SealReceiverInvocation, createDeps: SealDepsFactory): Promise<SealReceiverOutcome> {
  const config = parseSealReceiverArgs(invocation.argv);
  if (!environmentIsClean(invocation.env) || config === null) return errorOutcome('E_INTERNAL');
  let deps: SealReceiverDeps;
  try {
    deps = createDeps(config);
  } catch {
    return errorOutcome('E_INTERNAL');
  }
  const defect = confinementDefect(invocation.permission, config);
  if (defect !== null) {
    deps.log.write('result', { code: 'E_INTERNAL', detail: null, note: defect });
    return errorOutcome('E_INTERNAL');
  }
  const raw = invocation.env.SSH_ORIGINAL_COMMAND;
  const command = parseSealCommand(raw);
  deps.log.write('request', { env: config.env, verb: command?.verb ?? null, commandBytes: raw === undefined ? null : Buffer.byteLength(raw, 'utf8'), command: command === null ? null : (raw as string) });
  if (command === null) {
    deps.log.write('result', { code: 'E_COMMAND', detail: null, note: 'command outside the grammar' });
    return errorOutcome('E_COMMAND');
  }
  try {
    const line = await underLock(command, config, deps);
    deps.log.write('result', { code: 'OK', line });
    return okOutcome(line);
  } catch (error) {
    deps.log.write('result', errorFields(error));
    return error instanceof SealReceiverError ? errorOutcome(error.code, error.detail) : errorOutcome('E_INTERNAL');
  }
}
