import fsPromises from 'node:fs/promises';
import type { BytesFsOps } from './fs-ops';

/**
 * Adaptador de disco PADRÃO da porta `FsOps` (P1 W4.6: saiu, sem mudança, do `snapshot-store.ts`, que o reexporta). Único arquivo do módulo que
 * importa `node:fs/promises`; não importa mais nada além da porta (o artefato único do `sign` o usa sem o resto do armazenamento).
 */

/**
 * Leitura de um arquivo de DADOS (evidências, decisões, resultados, recibos). Quem escreve numa pasta de dados pode deixar ali um arquivo
 * ESPECIAL com nome válido (FIFO, dispositivo, soquete): `open()` bloqueante de um FIFO nunca retorna, prende uma thread do pool de I/O do
 * libuv (4 por padrão) e, com poucos deles, TODO o I/O de arquivo do processo web para (e o processo nem encerra). Por isso:
 *  - `O_NONBLOCK`: o `open()` de um FIFO retorna na hora (em arquivo comum não tem efeito) e o tipo é conferido a seguir;
 *  - `O_NOFOLLOW`: sem seguir link simbólico;
 *  - o tipo e o tamanho são conferidos no DESCRITOR já aberto (`fstat`), nunca por um `lstat` anterior (que seria uma corrida);
 *  - a leitura é LIMITADA ao tamanho declarado + 1 byte (um arquivo que cresce depois do `fstat` também é recusado);
 *  - qualquer tipo inesperado falha FECHADO (ENOTFILE/ETOOBIG), sem ler nada.
 */
async function readRegularFile(target: string, maxBytes: number): Promise<Buffer> {
  const { constants } = fsPromises;
  const handle = await fsPromises.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Object.assign(new Error('não é um arquivo comum'), { code: 'ENOTFILE' });
    if (info.size > maxBytes) throw Object.assign(new Error(`excede ${maxBytes} bytes`), { code: 'ETOOBIG' });
    // `size + 1`: um byte a mais que o declarado denuncia um arquivo que CRESCEU depois do fstat (adulteração ou corrida): falha fechada
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > info.size) throw Object.assign(new Error('o arquivo mudou durante a leitura'), { code: 'ECHANGED' });
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export const nodeFsOps: BytesFsOps = {
  async mkdir(dir) {
    await fsPromises.mkdir(dir, { recursive: true });
  },
  lstat: (target) => fsPromises.lstat(target),
  readdir: (dir) => fsPromises.readdir(dir),
  realpath: (target) => fsPromises.realpath(target),
  /** Texto UTF-8 de `readRegularFile` (ver acima: sem seguir link, sem travar em FIFO, tipo e tamanho no descritor, limite). */
  readFile: async (target, maxBytes) => (await readRegularFile(target, maxBytes)).toString('utf8'),
  /** Os mesmos bytes, sem decodificar. */
  readFileBytes: (target, maxBytes) => readRegularFile(target, maxBytes),
  async writeExclusive(target, data, mode = 0o600) {
    const handle = await fsPromises.open(target, 'wx', mode);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  link: (from, to) => fsPromises.link(from, to),
  unlink: (target) => fsPromises.unlink(target),
  chmod: (target, mode) => fsPromises.chmod(target, mode),
  async syncDirectory(dir) {
    const handle = await fsPromises.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};
