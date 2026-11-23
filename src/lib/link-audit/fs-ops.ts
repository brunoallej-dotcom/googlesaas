/**
 * PORTA de disco do módulo (P1 W4.6, spec §5.5.1 item 7): só os TIPOS das operações de arquivo e o `errorCode`, sem nenhum import. Saiu do
 * `snapshot-store.ts` (que a reexporta) para que quem só precisa da porta, como o verificador v2 e o artefato único do `sign`, não carregue o resto
 * do armazenamento (e, por ele, `evidence → url-safety`, com `node:dns`/`node:net`). O adaptador de disco padrão está em `node-fs-ops.ts`.
 */

export interface FileInfo {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
  readonly mtimeMs: number;
  /** Bits de modo e dono (o `Stats` do Node os traz); opcionais para os `FsOps` de teste. Ausentes ⇒ quem confere permissões não pode garantir. */
  readonly mode?: number;
  readonly uid?: number;
}

/** Operações de disco usadas pelo armazenamento. Injetável para simular quedas nos testes. */
export interface FsOps {
  mkdir(dir: string): Promise<void>;
  lstat(target: string): Promise<FileInfo>;
  readdir(dir: string): Promise<string[]>;
  realpath(target: string): Promise<string>;
  /** Lê sem seguir symlink, confere que é arquivo comum e recusa mais de `maxBytes`. */
  readFile(target: string, maxBytes: number): Promise<string>;
  /** Cria o arquivo de forma exclusiva (flag `wx`; modo padrão 0o600), grava, faz fsync e fecha. */
  writeExclusive(target: string, data: string, mode?: number): Promise<void>;
  link(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
  chmod(target: string, mode: number): Promise<void>;
  syncDirectory(dir: string): Promise<void>;
}

/**
 * `FsOps` com a leitura dos BYTES exatos (mesmas garantias de `readFile`, sem decodificar UTF-8). Para quem calcula hash sobre o arquivo como está no
 * disco (o `sign` do P1: dossiê que pode ser binário). Interface à parte para não exigir o método dos `FsOps` que já existem.
 */
export interface BytesFsOps extends FsOps {
  readFileBytes(target: string, maxBytes: number): Promise<Uint8Array>;
}

/** O código de um erro de sistema (`ENOENT`, `EACCES`…), ou `DESCONHECIDO`. Nunca a mensagem (pode trazer caminho). */
export function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'DESCONHECIDO';
}
