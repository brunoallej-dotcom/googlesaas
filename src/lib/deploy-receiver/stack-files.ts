import { createHash } from 'node:crypto';
import nodePath from 'node:path';
import type { ReceiverConfig } from './args';
import { ReceiverError } from './codes';
import type { DeployCommand } from './grammar';
import type { ReceiverDeps, ReceiverFs } from './ports';

/*
 * P9.3a (revisão do PR #70) — a stack e a sobreposição que o receptor confere e usa são os MESMOS bytes:
 *  - passo 2: cada arquivo é lido UMA vez (arquivo regular, com teto) e o sha256 é calculado sobre esses bytes;
 *  - passos 10 e 11: o `docker stack config`/`deploy` recebe CÓPIAS privadas desses bytes, numa pasta `0700` do estado (`.stack-<aleatório>`,
 *    arquivos `0600`), apagada no fim; uma troca do arquivo instalado depois do passo 2 não muda o que é implantado;
 *  - do texto conferido saem os nomes interpolados (`${NOME…}`/`$NOME`: o único ambiente que o filho `docker` recebe do arquivo do host) e as
 *    origens de bind efetivas (`source:` depois da interpolação), cujo caminho real a homologação confere sob `--data-prefix`.
 * Puro (disco pela porta).
 */

export const MAX_STACK_FILE_BYTES = 1024 * 1024;
const PRIVATE_DIR_PREFIX = '.stack-';
const PRIVATE_DIR = /^\.stack-[0-9a-f]{8,64}$/;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
export const STACK_COPY_NAMES = ['stack.yml', 'stack-hml.yml'] as const;

export interface VerifiedStackFile {
  readonly name: (typeof STACK_COPY_NAMES)[number];
  readonly bytes: Uint8Array;
}

export interface VerifiedStack {
  readonly files: readonly VerifiedStackFile[];
  /** O texto dos arquivos conferidos (stack e sobreposição), para os nomes interpolados e as origens de bind. */
  readonly text: string;
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function readRegular(file: string, fs: ReceiverFs): Promise<Uint8Array | null> {
  try {
    const info = await fs.lstat(file);
    if (info === null || !info.isFile || info.isSymbolicLink) return null;
    return await fs.readFileCapped(file, MAX_STACK_FILE_BYTES);
  } catch {
    return null;
  }
}

/** Passo 2: lê stack (e sobreposição) uma vez e confere o sha256 dos bytes lidos; diferente, ausente, link ou ilegível ⇒ `E_STACK_FILE_MISMATCH`. */
export async function readVerifiedStack(command: DeployCommand, config: ReceiverConfig, deps: Pick<ReceiverDeps, 'fs' | 'log'>): Promise<VerifiedStack> {
  const wanted: Array<readonly [VerifiedStackFile['name'], string, string | null]> = [['stack.yml', config.stackFile, command.stackSha256]];
  if (config.overlayFile !== null) wanted.push(['stack-hml.yml', config.overlayFile, command.overlaySha256]);
  const files: VerifiedStackFile[] = [];
  for (const [name, file, expected] of wanted) {
    const bytes = await readRegular(file, deps.fs);
    if (bytes === null || sha256Hex(bytes) !== expected) throw new ReceiverError('E_STACK_FILE_MISMATCH', null, `${name} differs from the commit (or is unreadable)`);
    files.push({ name, bytes });
  }
  return { files, text: files.map((file) => Buffer.from(file.bytes).toString('utf8')).join('\n') };
}

const VARIABLE = /\$(\$|\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g;

/** Os nomes que o texto da stack interpola (`${NOME}`, `${NOME:-…}`, `$NOME`); `$$` é o escape do compose e não conta. */
export function interpolatedNames(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(VARIABLE)) {
    const name = match[2] ?? match[3];
    if (match[1] !== '$' && name !== undefined) names.add(name);
  }
  return names;
}

const BRACED = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}/g;

/** Interpolação do compose sobre um valor (`${N}`, `${N:-d}`, `${N-d}`, `${N:?m}`, `${N?m}`, `$N`, `$$`); `null` se um `?` não se resolve. */
export function interpolate(value: string, vars: ReadonlyMap<string, string>): string | null {
  let unresolved = false;
  const braced = value.replace(BRACED, (_whole, name: string, operator: string | undefined, operand: string | undefined) => {
    const current = vars.get(name);
    const empty = current === undefined || current === '';
    if (operator === ':-') return empty ? (operand ?? '') : (current as string);
    if (operator === '-') return current === undefined ? (operand ?? '') : current;
    if ((operator === ':?' && empty) || (operator === '?' && current === undefined)) unresolved = true;
    return current ?? '';
  });
  if (unresolved) return null;
  return braced.replace(/\$(\$|[A-Za-z_][A-Za-z0-9_]*)/g, (_whole, rest: string) => (rest === '$' ? '$' : (vars.get(rest) ?? '')));
}

const SOURCE_LINE = /^\s*(?:-\s+)?source:\s*(.+?)\s*$/;
const unquote = (value: string): string => (/^(["']).*\1$/.test(value) ? value.slice(1, -1) : value);

/**
 * As origens de bind efetivas: todo `source:` do texto conferido que, interpolado com o arquivo do host, é um caminho absoluto (os `source:` dos
 * secrets são nomes e ficam de fora). Um `source:` com variável obrigatória sem valor ⇒ `null` no lugar do caminho (falha fechada de quem chama).
 */
export function bindSources(text: string, vars: ReadonlyMap<string, string>): Array<string | null> {
  const sources: Array<string | null> = [];
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const match = SOURCE_LINE.exec(line);
    if (!match) continue;
    const raw = unquote(match[1] as string);
    const resolved = interpolate(raw, vars);
    if (resolved === null) sources.push(null);
    else if (nodePath.posix.isAbsolute(resolved)) sources.push(nodePath.posix.normalize(resolved));
  }
  return [...new Set(sources)];
}

export interface PrivateStackCopies {
  /** Os `-c` na ordem: a stack e, em homologação, a sobreposição. */
  readonly paths: readonly string[];
  remove(): Promise<void>;
}

/** Apaga pastas de cópias privadas que sobraram de um receptor morto (só as do próprio nome, só os dois arquivos conhecidos). */
export async function removeStaleStackCopies(stateDir: string, deps: Pick<ReceiverDeps, 'fs' | 'log'>): Promise<void> {
  for (const name of await deps.fs.readdir(stateDir)) {
    if (!PRIVATE_DIR.test(name)) continue;
    const dir = nodePath.join(stateDir, name);
    const info = await deps.fs.lstat(dir);
    if (info === null || !info.isDirectory || info.isSymbolicLink) continue;
    for (const file of STACK_COPY_NAMES) await deps.fs.unlink(nodePath.join(dir, file)).catch(() => undefined);
    await deps.fs.removeDirectory(dir).catch(() => deps.log.write('stack.stale_copy_not_removed', { name }));
  }
}

/** Passos 10 e 11: as cópias privadas dos bytes conferidos (`<estado>/.stack-<aleatório>/`, `0700`, arquivos `0600`). */
export async function writePrivateCopies(stack: VerifiedStack, stateDir: string, deps: Pick<ReceiverDeps, 'fs' | 'log' | 'randomSuffix'>): Promise<PrivateStackCopies> {
  const dir = nodePath.join(stateDir, `${PRIVATE_DIR_PREFIX}${deps.randomSuffix()}`);
  await deps.fs.mkdir(dir, PRIVATE_DIR_MODE);
  const written: string[] = [];
  const remove = async (): Promise<void> => {
    for (const file of written) await deps.fs.unlink(file).catch(() => deps.log.write('stack.copy_not_removed'));
    await deps.fs.removeDirectory(dir).catch(() => deps.log.write('stack.copy_dir_not_removed'));
  };
  try {
    for (const file of stack.files) {
      const target = nodePath.join(dir, file.name);
      const handle = await deps.fs.createExclusive(target, PRIVATE_FILE_MODE);
      written.push(target);
      try {
        await handle.write(file.bytes);
        await handle.chmod(PRIVATE_FILE_MODE);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } catch {
    await remove();
    throw new ReceiverError('E_INTERNAL', null, 'private stack copies failed');
  }
  return { paths: written, remove };
}
