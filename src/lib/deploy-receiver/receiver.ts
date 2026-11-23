import nodePath from 'node:path';
import { parseReceiverArgs, type ReceiverConfig } from './args';
import { errorOutcome, okOutcome, ReceiverError, type ReceiverOutcome } from './codes';
import { runDeploy } from './deploy';
import { parseReceiverCommand, type ReceiverCommand } from './grammar';
import type { ReceiverDeps } from './ports';
import { requireStateDir } from './staging';
import { runUpload } from './upload';

/*
 * P9.3a — o receptor de deploy de ponta a ponta (spec §5.6, §5.8): o ÚNICO comando da chave de deploy. Ordem:
 *  1. ambiente do processo = só `PATH` e `SSH_ORIGINAL_COMMAND` (o wrapper roda `env -i`); parâmetros fixos do wrapper (`--env`, …): defeito ⇒
 *     `E_INTERNAL` (instalação);
 *  2. log local aberto (`--log`, `0600`); sem ele ⇒ `E_INTERNAL`;
 *  3. gramática fechada (`E_COMMAND`, nada lido do stdin);
 *  4. pasta de estado e trava EXCLUSIVA do ambiente (`<estado>/deploy.lock`, `E_LOCKED`), para `upload` e `deploy`: um `upload` nunca apaga o
 *     pacote de um `deploy` em andamento;
 *  5. o verbo. Qualquer erro inesperado ⇒ `E_INTERNAL`.
 * Sai sempre com EXATAMENTE uma linha pública (stdout `OK …` ou stderr `ERRO …`); nunca lança.
 */

export const LOCK_FILE = 'deploy.lock';
const ALLOWED_ENV: ReadonlySet<string> = new Set(['PATH', 'SSH_ORIGINAL_COMMAND']);

export interface ReceiverInvocation {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Monta as portas para os parâmetros do wrapper (o log depende de `--log`). Pode lançar: vira `E_INTERNAL`. */
export type DepsFactory = (config: ReceiverConfig, childPath: string) => ReceiverDeps;

const definedKeys = (env: Readonly<Record<string, string | undefined>>): string[] => Object.keys(env).filter((key) => env[key] !== undefined);

/** `PATH` do wrapper: diretórios absolutos separados por `:`. */
function childPathOf(env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env.PATH;
  if (value === undefined || value === '' || definedKeys(env).some((key) => !ALLOWED_ENV.has(key))) return null;
  return value.split(':').every((entry) => nodePath.posix.isAbsolute(entry)) ? value : null;
}

function errorFields(error: unknown): Record<string, string | null> {
  if (error instanceof ReceiverError) return { code: error.code, detail: error.detail, note: error.logNote };
  const errno = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : null;
  return { code: 'E_INTERNAL', detail: null, note: `unexpected ${error instanceof Error ? error.name : typeof error}${errno ? ` ${errno}` : ''}` };
}

async function dispatch(command: ReceiverCommand, config: ReceiverConfig, deps: ReceiverDeps): Promise<string> {
  return command.verb === 'upload' ? runUpload(command, config, deps) : runDeploy(command, config, deps);
}

async function underLock(command: ReceiverCommand, config: ReceiverConfig, deps: ReceiverDeps): Promise<string> {
  await requireStateDir(config.stateDir, deps.fs);
  const release = await deps.lock.tryAcquire(nodePath.join(config.stateDir, LOCK_FILE));
  if (release === null) throw new ReceiverError('E_LOCKED', null, 'another run holds the environment lock');
  try {
    return await dispatch(command, config, deps);
  } finally {
    await release().catch(() => deps.log.write('lock.release_failed'));
  }
}

/** Uma execução do receptor. Nunca lança; o chamador escreve a linha e sai com `exitCode`. */
export async function runDeployReceiver(invocation: ReceiverInvocation, createDeps: DepsFactory): Promise<ReceiverOutcome> {
  const childPath = childPathOf(invocation.env);
  const config = parseReceiverArgs(invocation.argv);
  if (childPath === null || config === null) return errorOutcome('E_INTERNAL');
  let deps: ReceiverDeps;
  try {
    deps = createDeps(config, childPath);
  } catch {
    return errorOutcome('E_INTERNAL');
  }
  const raw = invocation.env.SSH_ORIGINAL_COMMAND;
  const command = parseReceiverCommand(raw, config.env);
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
    const fields = errorFields(error);
    deps.log.write('result', fields);
    return error instanceof ReceiverError ? errorOutcome(error.code, error.detail) : errorOutcome('E_INTERNAL');
  }
}
