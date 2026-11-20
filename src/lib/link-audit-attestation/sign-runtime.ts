import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { descriptorPath, readAll, type KeyFileOps } from './sign-key';
import { isProtectedDir } from './sign-receipts';

/*
 * P1 W4.6 — LEITURAS do runtime do `sign` e do `close-key` (confirmação da revisão da W4.5, critério ii; spec §5.5.1 item 6):
 *  - o bloco ORIGINAL do exec, `/proc/self/cmdline` (argv) e `/proc/self/environ` (ambiente). Uma pré-carga (`NODE_OPTIONS=--require …`) roda antes
 *    do comando e pode limpar `process.env` e `process.execArgv`, mas não muda esse bloco: a barreira do runtime (`sign-args.ts`) o confere. Aqui só
 *    os BYTES são lidos; quem os interpreta tira só as opções do node ANTES do script e só os NOMES das variáveis (nenhum valor é decodificado);
 *  - os bytes do próprio ARTEFATO ÚNICO em execução, para o `artifactSha256` do recibo (passo 16). O hash esperado NÃO é embutido no artefato (seria
 *    autorreferência): a estação e o CI o comparam com o versionado em `docs/phase6-auditoria-link/p1-sign-artifact.sha256`. Revisão independente da
 *    W4.6: o arquivo é aberto UMA vez (`O_NOFOLLOW`) pelas rotinas de custódia da chave, conferido no descritor (comum, sem escrita para ninguém, do
 *    usuário ou do root), na pasta pela regra da W4.5 (sem escrita para grupo e outros, salvo sticky), e o hash sai desse descritor. O hash é uma
 *    ANOTAÇÃO do próprio processo, não prova: o controle é o `sha256sum -c` da linha do runbook, antes da execução, sobre o arquivo sob custódia.
 * Só LEITURA, por UM descritor aberto sem seguir link no último componente e sem travar em FIFO, com teto. Sob `node --permission`, cada caminho
 * precisa de `--allow-fs-read` (o runbook fixa a linha); sem ele a leitura falha e quem chama recusa (falha fechada).
 *  - a SONDAGEM antecipada de fsync (decisão do manager na W4.6): desde o Node 24.22.0 o modelo de permissões bloqueia `fsync`/`fdatasync`
 *    (nodejs/node#65431), e a gravação à prova de queda do `sign` (§5.5.1 item 4) precisa dele no arquivo e na pasta. A sonda abre a raiz de
 *    `--seals-dir` só para leitura e sincroniza ESSE descritor, com a mesma operação da gravação (`FileHandle.sync()`); nada é gravado.
 */

/** Teto do bloco original: argv + ambiente cabem em ARG_MAX (2 MiB por padrão no Linux); acima disso, recusa. */
export const MAX_EXEC_BLOCK_BYTES = 4 * 1024 * 1024;
/** Teto do artefato (o pacote tem centenas de KiB). */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

const readFailure = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/**
 * Lê `target` inteiro por um descritor (`O_RDONLY|O_NOFOLLOW|O_NONBLOCK`) até o fim, com teto. Os arquivos de `/proc` declaram tamanho 0 no `fstat`,
 * então a leitura vai até o fim do arquivo; num arquivo comum de tamanho declarado, ler outra quantidade (mudou durante a leitura) é falha.
 */
async function readBounded(target: string, maxBytes: number): Promise<Uint8Array> {
  const { constants } = fsPromises;
  const handle = await fsPromises.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw readFailure('ENOTFILE', 'não é um arquivo comum');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw readFailure('ETOOBIG', `excede ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (info.size > 0 && total !== info.size) throw readFailure('ECHANGED', 'o arquivo mudou durante a leitura');
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

/** O bloco original do exec, pelo `/proc` do próprio processo (Linux; em outro sistema a leitura falha e a barreira recusa). */
export const nodeExecBlock = {
  cmdline: (): Promise<Uint8Array> => readBounded('/proc/self/cmdline', MAX_EXEC_BLOCK_BYTES),
  environ: (): Promise<Uint8Array> => readBounded('/proc/self/environ', MAX_EXEC_BLOCK_BYTES),
};

/** `blocked`: o modelo de permissões nega fsync; `ok`: fsync funcionou; `unprobed`: a pasta não abriu ou outro erro (o fluxo normal decide). */
export type FsyncProbeResult = 'ok' | 'blocked' | 'unprobed';
/** O código que o modelo de permissões do Node usa para uma API negada (inclusive "fsync API is disabled when Permission Model is enabled"). */
const PERMISSION_DENIED = 'ERR_ACCESS_DENIED';
const codeOf = (error: unknown): unknown => (typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined);

/**
 * Sonda de fsync na pasta `dir` (a raiz de `--seals-dir`): abre só para leitura (`O_RDONLY|O_DIRECTORY`) e sincroniza o descritor. Só a negação do
 * modelo de permissões NO SYNC é `blocked`; a abertura que falha (pasta inexistente, arquivo, sem grant) é `unprobed`, porque o fluxo normal já recusa
 * esses casos com o motivo certo. Nunca lança e nunca grava.
 */
export async function nodeFsyncProbe(dir: string): Promise<FsyncProbeResult> {
  const { constants } = fsPromises;
  let probe: Awaited<ReturnType<typeof fsPromises.open>>;
  try {
    probe = await fsPromises.open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch {
    return 'unprobed';
  }
  try {
    await probe.sync();
    return 'ok';
  } catch (error) {
    return codeOf(error) === PERMISSION_DENIED ? 'blocked' : 'unprobed';
  } finally {
    // fechar um descritor só de leitura que falha não muda o que a sonda já provou (nem grava nada)
    await probe.close().catch(() => undefined);
  }
}

const NO_WRITE_BITS = 0o222;
const ROOT_UID = 0;
export type ArtifactDigest = { readonly ok: true; readonly sha256: string } | { readonly ok: false; readonly reason: 'UNREADABLE' | 'UNSAFE' };
const UNSAFE: ArtifactDigest = { ok: false, reason: 'UNSAFE' };
const UNREADABLE: ArtifactDigest = { ok: false, reason: 'UNREADABLE' };

/**
 * SHA-256 do artefato pelo DESCRITOR, sob custódia (revisão independente da W4.6): abre UMA vez (`KeyFileOps.openKeyFile`: `O_NOFOLLOW`, sem travar
 * em FIFO), confere no `fstat` (arquivo comum, nenhum bit de escrita, dono = `uid` ou root, tamanho até o teto), resolve o caminho real do descritor
 * (`/proc/self/fd`), confere a pasta dele (`isProtectedDir`), lê tudo pelo MESMO descritor e confere que o caminho do descritor não mudou. Link,
 * permissão, dono, pasta, caminho apagado ou trocado ⇒ `UNSAFE`; falha de leitura ⇒ `UNREADABLE`. As pastas acima da pasta do artefato ficam com o
 * runbook (sob `--permission` elas estão fora dos grants, que a W4.6 limita). Nunca lança.
 */
export async function artifactDigestUnderCustody(file: string, deps: { readonly fs: KeyFileOps; readonly uid: number | undefined }): Promise<ArtifactDigest> {
  let opened: Awaited<ReturnType<KeyFileOps['openKeyFile']>>;
  try {
    opened = await deps.fs.openKeyFile(file);
  } catch (error) {
    return codeOf(error) === 'ELOOP' ? UNSAFE : UNREADABLE;
  }
  try {
    const info = await opened.stat();
    if (!info.isFile() || (info.mode & NO_WRITE_BITS) !== 0 || deps.uid === undefined || (info.uid !== deps.uid && info.uid !== ROOT_UID)) return UNSAFE;
    if (info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) return UNREADABLE;
    const real = await descriptorPath(opened);
    if (real === null || !isProtectedDir(await deps.fs.lstat(path.dirname(real)))) return UNSAFE;
    // `size + 1`: um byte a mais denuncia crescimento depois do fstat
    const buffer = Buffer.alloc(info.size + 1);
    const length = await readAll(opened, buffer);
    if (length !== info.size) return UNREADABLE;
    if ((await descriptorPath(opened)) !== real) return UNSAFE;
    return { ok: true, sha256: createHash('sha256').update(buffer.subarray(0, length)).digest('hex') };
  } catch {
    return UNSAFE;
  } finally {
    // fechar o descritor só de leitura que falha não muda o resultado já conferido
    await opened.close().catch(() => undefined);
  }
}
