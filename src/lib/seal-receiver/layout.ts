import nodePath from 'node:path';
import { errorCode, type BytesFsOps } from '../link-audit/fs-ops';
import { rootIsReal, subDirState } from '../link-audit-attestation/exclusive-write';
import { SealReceiverError } from './codes';
import type { SealTarget } from './grammar';

/*
 * P9.3b — passos 4 e 5 do `put` (spec §5.7), sem seguir link:
 *  4. a raiz é caminho absoluto, diretório e o próprio caminho real; a subpasta (`aud-…` ou `_closures`), se existe, é diretório real e não link
 *     (as regras `rootIsReal`/`subDirState` da criação exclusiva compartilhada com o `sign`); senão `E_UNSAFE_PATH`;
 *  5. o destino já existe (`lstat`): arquivo regular com bytes IDÊNTICOS ⇒ `ALREADY_PRESENT` (idempotente, sem nova verificação); outros bytes ⇒
 *     `E_EXISTS_DIFFERENT` (nada é tocado); outro tipo (link, pasta, FIFO, …) ⇒ `E_UNSAFE_PATH`. O destino é lido por um descritor só (sem seguir
 *     link, sem travar em FIFO), com o teto do candidato: maior que ele já é "outros bytes".
 */

/** Passo 4. */
export async function requireSafeLayout(fs: BytesFsOps, root: string, target: SealTarget): Promise<void> {
  if (!(await rootIsReal(fs, root))) throw new SealReceiverError('E_UNSAFE_PATH', null, 'seals root is not its own real directory');
  if ((await subDirState(fs, root, target.dirName)) === 'unsafe') throw new SealReceiverError('E_UNSAFE_PATH', null, 'subfolder is not a real directory');
}

export const destinationOf = (root: string, target: SealTarget): string => nodePath.join(root, target.dirName, target.fileName);

/** Dispositivo e inode de uma pasta. */
export interface DirIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** A raiz e a subpasta (ou `null`, se ainda não existe) como estavam ANTES da verificação (revisão do PR #72, item 2). */
export interface LayoutPin {
  readonly root: DirIdentity;
  readonly sub: DirIdentity | null;
}

/** A identidade de uma pasta comum (lstat, sem link); `absent` (ENOENT) ou `null` (outra coisa, ou sem dispositivo/inode para provar). */
async function dirIdentity(fs: BytesFsOps, dir: string): Promise<DirIdentity | 'absent' | null> {
  try {
    const info = await fs.lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory() || typeof info.dev !== 'number' || typeof info.ino !== 'number') return null;
    return { dev: info.dev, ino: info.ino };
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'absent' : null;
  }
}

const sameIdentity = (a: DirIdentity | 'absent' | null, b: DirIdentity): boolean => a !== null && a !== 'absent' && a.dev === b.dev && a.ino === b.ino;

/** Fotografa a raiz e a subpasta logo antes da verificação v2 (passo 6). Raiz ou subpasta que não é pasta comum ⇒ `E_UNSAFE_PATH`. */
export async function pinLayout(fs: BytesFsOps, root: string, target: SealTarget): Promise<LayoutPin> {
  const rootId = await dirIdentity(fs, root);
  const subId = await dirIdentity(fs, nodePath.join(root, target.dirName));
  if (rootId === null || rootId === 'absent' || subId === null) throw new SealReceiverError('E_UNSAFE_PATH', null, 'root or subfolder cannot be pinned (not a real directory)');
  return { root: rootId, sub: subId === 'absent' ? null : subId };
}

/**
 * Logo antes do `link()`: a raiz é a MESMA pasta (dispositivo e inode) e a subpasta também; se ela não existia na fotografia (auditoria nova), agora
 * é a que a gravação acabou de criar, pasta comum dentro da raiz. Uma restauração ou troca no meio do `put` ⇒ `false` (`E_UNSAFE_PATH`).
 */
export async function layoutUnchanged(fs: BytesFsOps, root: string, target: SealTarget, pin: LayoutPin): Promise<boolean> {
  if (!sameIdentity(await dirIdentity(fs, root), pin.root)) return false;
  const sub = await dirIdentity(fs, nodePath.join(root, target.dirName));
  return pin.sub === null ? sub !== null && sub !== 'absent' : sameIdentity(sub, pin.sub);
}

const READ_TOO_LARGE: ReadonlySet<string> = new Set(['ETOOBIG', 'ECHANGED']);
const NOT_REGULAR: ReadonlySet<string> = new Set(['ELOOP', 'ENOTFILE', 'EISDIR', 'ENXIO']);

async function existingBytes(fs: BytesFsOps, file: string, cap: number): Promise<Uint8Array | 'too-large'> {
  try {
    return await fs.readFileBytes(file, cap);
  } catch (error) {
    const code = errorCode(error);
    if (READ_TOO_LARGE.has(code)) return 'too-large';
    if (NOT_REGULAR.has(code)) throw new SealReceiverError('E_UNSAFE_PATH', null, `destination changed type (${code})`);
    throw new SealReceiverError('E_INTERNAL', null, `destination unreadable (${code})`);
  }
}

/** Passo 5: `absent` (siga para a verificação), `identical` (`ALREADY_PRESENT`); outros bytes ou outro tipo recusam. */
export async function existingDestination(fs: BytesFsOps, root: string, target: SealTarget, candidate: Uint8Array, cap: number): Promise<'absent' | 'identical'> {
  const file = destinationOf(root, target);
  try {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new SealReceiverError('E_UNSAFE_PATH', null, 'destination is not a regular file');
  } catch (error) {
    if (error instanceof SealReceiverError) throw error;
    const code = errorCode(error);
    if (code === 'ENOENT') return 'absent';
    throw new SealReceiverError(code === 'ENOTDIR' ? 'E_UNSAFE_PATH' : 'E_INTERNAL', null, `destination lstat failed (${code})`);
  }
  const bytes = await existingBytes(fs, file, cap);
  if (bytes !== 'too-large' && Buffer.from(bytes).equals(Buffer.from(candidate))) return 'identical';
  throw new SealReceiverError('E_EXISTS_DIFFERENT', null, 'destination exists with other bytes');
}
