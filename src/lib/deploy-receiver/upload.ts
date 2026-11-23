import { createHash } from 'node:crypto';
import nodePath from 'node:path';
import type { ReceiverConfig } from './args';
import { ReceiverError } from './codes';
import type { UploadCommand } from './grammar';
import { streamExact } from './input';
import type { ExclusiveFile, ReceiverDeps } from './ports';
import { bundleFileName, ensureIncomingDir, partialFileName, removeOwnBundles } from './staging';

/*
 * P9.3a — `upload <sha40> <bundle-sha256> <bytes>` (spec §5.6): apaga os pacotes antigos da própria pasta de recebimento, lê o stdin com teto
 * e prazo de 120 s sem dados para um arquivo NOVO exclusivo (`O_EXCL`, `0600`), calculando o SHA-256 em fluxo. Bytes a mais ⇒
 * `E_INPUT_TOO_LARGE`; a menos ou prazo vencido ⇒ `E_INPUT_TRUNCATED`; hash diferente ⇒ `E_HASH_MISMATCH`. Em qualquer falha o arquivo parcial é
 * apagado. Só o pacote completo e conferido ganha o nome final (`rename` + `fsync` da pasta). Sucesso: `OK UPLOADED <sha40> <bundle-sha256>`.
 */

export const UPLOAD_IDLE_MS = 120_000;
const BUNDLE_MODE = 0o600;

async function discardPartial(file: ExclusiveFile, partial: string, deps: Pick<ReceiverDeps, 'fs' | 'log'>): Promise<void> {
  await file.close().catch(() => undefined);
  await deps.fs.unlink(partial).catch(() => deps.log.write('upload.partial_unlink_failed'));
}

/** Recebe o pacote; devolve a linha pública de sucesso. Lança `ReceiverError` com o código fixo. */
export async function runUpload(command: UploadCommand, config: ReceiverConfig, deps: ReceiverDeps): Promise<string> {
  const incoming = await ensureIncomingDir(config.stateDir, deps.fs);
  await removeOwnBundles(incoming, deps);
  const partial = nodePath.join(incoming, partialFileName(command.sha40, deps.randomSuffix()));
  const file = await deps.fs.createExclusive(partial, BUNDLE_MODE);
  const hash = createHash('sha256');
  try {
    await streamExact(deps.stdin, command.bytes, UPLOAD_IDLE_MS, async (chunk) => {
      hash.update(chunk);
      await file.write(chunk);
    });
    await file.sync();
    await file.close();
  } catch (error) {
    await discardPartial(file, partial, deps);
    throw error instanceof ReceiverError ? error : new ReceiverError('E_INTERNAL', null, 'upload write failed');
  }
  const sha256 = hash.digest('hex');
  if (sha256 !== command.bundleSha256) {
    await deps.fs.unlink(partial).catch(() => deps.log.write('upload.partial_unlink_failed'));
    throw new ReceiverError('E_HASH_MISMATCH', null, 'bundle sha256 differs from the declared one');
  }
  await deps.fs.rename(partial, nodePath.join(incoming, bundleFileName(command.sha40)));
  await deps.fs.syncDirectory(incoming);
  deps.log.write('upload.staged', { sha40: command.sha40, bundleSha256: sha256, bytes: command.bytes });
  return `OK UPLOADED ${command.sha40} ${sha256}`;
}
