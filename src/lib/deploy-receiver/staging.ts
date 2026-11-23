import nodePath from 'node:path';
import { ReceiverError } from './codes';
import type { ReceiverDeps, ReceiverFs } from './ports';

/*
 * P9.3a — a pasta de recebimento `<estado>/incoming` (`0700`, spec §5.10) e os nomes dos pacotes. Só arquivos com os nomes do PRÓPRIO receptor
 * são apagados (pacotes temporários, nunca dado histórico); qualquer outra coisa na pasta fica como está. Puro (disco pela porta).
 */

export const INCOMING_DIR = 'incoming';
const INCOMING_MODE = 0o700;
const OWN_BUNDLE_FILE = /^(?:bundle-[0-9a-f]{40}\.tar\.gz|\.bundle-[0-9a-f]{40}\.partial-[0-9a-f]{8,64})$/;

export const bundleFileName = (sha40: string): string => `bundle-${sha40}.tar.gz`;
export const partialFileName = (sha40: string, suffix: string): string => `.bundle-${sha40}.partial-${suffix}`;

/** A pasta de estado do wrapper tem de existir e ser diretório real (criada pelo responsável, `0711`); senão `E_INTERNAL`. */
export async function requireStateDir(stateDir: string, fs: ReceiverFs): Promise<void> {
  const info = await fs.lstat(stateDir);
  if (info === null || !info.isDirectory || info.isSymbolicLink) throw new ReceiverError('E_INTERNAL', null, 'state dir missing or not a real directory');
}

/** `<estado>/incoming`, criada `0700` se ausente; link ou arquivo no lugar ⇒ `E_INTERNAL`. */
export async function ensureIncomingDir(stateDir: string, fs: ReceiverFs): Promise<string> {
  const incoming = nodePath.join(stateDir, INCOMING_DIR);
  const info = await fs.lstat(incoming);
  if (info === null) {
    await fs.mkdir(incoming, INCOMING_MODE);
    await fs.syncDirectory(stateDir);
    return incoming;
  }
  if (!info.isDirectory || info.isSymbolicLink) throw new ReceiverError('E_INTERNAL', null, 'incoming dir is not a real directory');
  return incoming;
}

/** Apaga os pacotes e temporários antigos do próprio receptor (arquivos regulares com o nome dele); o resto da pasta não é tocado. */
export async function removeOwnBundles(incoming: string, deps: Pick<ReceiverDeps, 'fs' | 'log'>): Promise<void> {
  for (const name of await deps.fs.readdir(incoming)) {
    if (!OWN_BUNDLE_FILE.test(name)) continue;
    const file = nodePath.join(incoming, name);
    const info = await deps.fs.lstat(file);
    if (info === null || !info.isFile || info.isSymbolicLink) continue;
    await deps.fs.unlink(file);
    deps.log.write('staging.removed', { name });
  }
}
