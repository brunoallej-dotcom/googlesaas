import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';

/*
 * P1 W4.6 — LEITURAS do runtime do `sign` e do `close-key` (confirmação da revisão da W4.5, critério ii; spec §5.5.1 item 6):
 *  - o bloco ORIGINAL do exec, `/proc/self/cmdline` (argv) e `/proc/self/environ` (ambiente). Uma pré-carga (`NODE_OPTIONS=--require …`) roda antes
 *    do comando e pode limpar `process.env` e `process.execArgv`, mas não muda esse bloco: a barreira do runtime (`sign-args.ts`) o confere. Aqui só
 *    os BYTES são lidos; quem os interpreta tira só as opções do node ANTES do script e só os NOMES das variáveis (nenhum valor é decodificado);
 *  - os bytes do próprio ARTEFATO ÚNICO em execução, para o `artifactSha256` do recibo (passo 16). O hash esperado NÃO é embutido no artefato (seria
 *    autorreferência): a estação e o CI o comparam com o versionado em `docs/phase6-auditoria-link/p1-sign-artifact.sha256`.
 * Só LEITURA, por UM descritor aberto sem seguir link no último componente e sem travar em FIFO, com teto. Sob `node --permission`, cada caminho
 * precisa de `--allow-fs-read` (o runbook fixa a linha); sem ele a leitura falha e quem chama recusa (falha fechada).
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

/** SHA-256 (hex minúsculo) dos bytes do arquivo do artefato em execução. Falha de leitura ⇒ lança (quem chama recusa, sem repassar o erro). */
export async function artifactDigest(file: string): Promise<string> {
  const bytes = await readBounded(file, MAX_ARTIFACT_BYTES);
  if (bytes.length === 0) throw readFailure('EEMPTY', 'artefato vazio');
  return createHash('sha256').update(bytes).digest('hex');
}
