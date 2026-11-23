import type { BytesFsOps } from '../link-audit/fs-ops';
import { linkExclusive, type ExclusiveWriteOutcomes } from '../link-audit-attestation/exclusive-write';
import { SealReceiverError } from './codes';
import type { SealTarget } from './grammar';

/*
 * P9.3b — passo 7 do `put` (spec §5.7): a gravação pela MESMA criação exclusiva do `sign` (`linkExclusive`, extraída para
 * `exclusive-write.ts`): temporário `.<nome>.tmp-<32 hex>` (fora de `SEAL_FILE`), escrita, `fsync` do arquivo, `link()` exclusivo para o nome final,
 * remoção do temporário e `fsync` da pasta; pasta nova: `mkdir` e `fsync` da raiz; arquivo `0444`. Nunca o `publishExclusive` do armazenamento de
 * snapshots, que ignora a falha do `fsync` da pasta (CE-3). `EEXIST` no `link()` (corrida) ⇒ `conflict`, e quem chama volta ao passo 5. Falha antes
 * do `link()` ⇒ `E_WRITE_FAILED` (nada gravado); depois ⇒ `E_WRITE_UNCONFIRMED` (o arquivo existe e NUNCA é apagado pelo receptor).
 */

interface WriteRefusal {
  readonly ok: false;
  readonly kind: 'conflict' | 'bad-suffix' | 'unsafe' | 'failed' | 'unconfirmed';
  readonly tempLeft: boolean;
}

const refusal = (kind: WriteRefusal['kind'], tempLeft = false): WriteRefusal => ({ ok: false, kind, tempLeft });

const RECEIVER_OUTCOMES: ExclusiveWriteOutcomes<WriteRefusal> = {
  badSuffix: refusal('bad-suffix'),
  unsafeDir: refusal('unsafe'),
  writeFailed: (tempLeft) => refusal('failed', tempLeft),
};

export type WriteOutcome = { readonly outcome: 'written' } | { readonly outcome: 'conflict'; /** O temporário deste processo pode ter ficado. */ readonly tempLeft: boolean };

/** Grava `text` em `<raiz>/<subpasta>/<nome>`. `written`, ou `conflict` (o nome final já existia). As outras saídas lançam o código fixo. */
export async function writeExclusively(fs: BytesFsOps, root: string, target: SealTarget, text: string, tempSuffix: () => string): Promise<WriteOutcome> {
  const result = await linkExclusive(fs, { root, dirName: target.dirName, fileName: target.fileName, text, conflict: (tempLeft) => refusal('conflict', tempLeft), unconfirmed: refusal('unconfirmed') }, RECEIVER_OUTCOMES, tempSuffix);
  if (result.ok) return { outcome: 'written' };
  const tempNote = result.tempLeft ? ' (a temporary of this run may be left)' : '';
  switch (result.kind) {
    case 'conflict':
      return { outcome: 'conflict', tempLeft: result.tempLeft };
    case 'unsafe':
      throw new SealReceiverError('E_UNSAFE_PATH', null, 'root or subfolder changed before the write');
    case 'unconfirmed':
      throw new SealReceiverError('E_WRITE_UNCONFIRMED', null, 'file linked but the temporary removal or the directory fsync failed');
    case 'failed':
      throw new SealReceiverError('E_WRITE_FAILED', null, `write failed before link${tempNote}`);
    default:
      throw new SealReceiverError('E_INTERNAL', null, 'temporary suffix out of form');
  }
}
