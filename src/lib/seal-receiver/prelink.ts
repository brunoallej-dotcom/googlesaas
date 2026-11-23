import type { BytesFsOps } from '../link-audit/fs-ops';
import type { SealTarget } from './grammar';
import { layoutUnchanged, type LayoutPin } from './layout';
import { currentTrustListSha256, type InstalledTrustList } from './trust';
import type { PreLinkRefusal } from './write';

/*
 * P9.3b, revisão do PR #72 (itens 1, 2 e 7) — a conferência logo ANTES do `link()`, com o temporário já gravado e sincronizado:
 *  1. a lista INSTALADA, relida pelas mesmas regras, tem o MESMO sha256 lido no começo do `put` (qualquer troca, inclusive a revogação da chave
 *     que assinou o candidato, recusa: `E_TRUST_LIST_MISMATCH`, nada gravado). O servidor ainda reverifica na leitura (RC-07);
 *  2. a raiz e a subpasta são as MESMAS pastas (dispositivo e inode) fotografadas antes da verificação v2 (uma restauração no meio ⇒
 *     `E_UNSAFE_PATH`, nada gravado; a restauração também segura a trava do kernel, plano de backup);
 *  3. `fsync` da RAIZ: a entrada da subpasta fica durável mesmo quando ela já existia de uma tentativa anterior cujo `fsync` da raiz falhou.
 * Puro (disco pela porta).
 */

export interface PreLinkContext {
  readonly fs: BytesFsOps;
  readonly root: string;
  readonly target: SealTarget;
  readonly trustFile: string;
  readonly trust: InstalledTrustList;
  readonly pin: LayoutPin;
}

/** `null` = siga para o `link()`; senão o motivo fixo da recusa. */
export async function preLinkRefusal(context: PreLinkContext): Promise<PreLinkRefusal | null> {
  const { fs, root, target } = context;
  if ((await currentTrustListSha256(context.trustFile, fs)) !== context.trust.sha256) return 'trust-list-changed';
  if (!(await layoutUnchanged(fs, root, target, context.pin))) return 'layout-changed';
  try {
    await fs.syncDirectory(root);
  } catch {
    return 'root-sync-failed';
  }
  return null;
}
