/*
 * P9.3a — as portas do receptor de deploy. O núcleo (`grammar`, `host-vars`, `upload`, `deploy`, …) só fala com o mundo por elas, então tudo é
 * testável sem Docker, sem ssh e sem relógio real. O adaptador de produção é `node-adapters.ts`: disco do Node, `execFile` com argv fixo e SEM
 * shell (só `docker`, `tar`, `gzip` e o script de pastas do wrapper), relógio, trava por arquivo exclusivo e o stdin do processo.
 */

export interface FileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
}

/** Arquivo aberto para escrita exclusiva (`O_CREAT | O_EXCL | O_NOFOLLOW`). */
export interface ExclusiveFile {
  write(chunk: Uint8Array): Promise<void>;
  /** `fchmod` explícito (o `umask` do processo não decide o modo final). */
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ReceiverFs {
  /** `lstat` (sem seguir link); `null` se não existe. */
  lstat(path: string): Promise<FileStat | null>;
  /** Lê um arquivo regular inteiro, recusando (lança) acima de `maxBytes`. */
  readFileCapped(path: string, maxBytes: number): Promise<Uint8Array>;
  /** SHA-256 em fluxo de um arquivo regular, com o tamanho lido. */
  sha256File(path: string): Promise<{ readonly sha256: string; readonly size: number }>;
  readdir(path: string): Promise<readonly string[]>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, mode: number): Promise<void>;
  /** `rmdir` de uma pasta vazia. */
  removeDirectory(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  realpath(path: string): Promise<string>;
  /** Bytes livres para usuário comum no sistema de arquivos de `path` (`statfs`: `bavail × bsize`). */
  availableBytes(path: string): Promise<number>;
  createExclusive(path: string, mode: number): Promise<ExclusiveFile>;
  /** `fsync` da pasta (o `rename` só é durável depois dele). */
  syncDirectory(path: string): Promise<void>;
}

/** Os únicos programas que o receptor chama; o script de pastas é o caminho fixo do wrapper. */
export type ReceiverProgram = 'docker' | 'tar' | 'gzip' | { readonly script: string };

export interface RunRequest {
  readonly program: ReceiverProgram;
  readonly args: readonly string[];
  /** O ambiente COMPLETO do filho (nada é herdado além disto). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Teto do stdout capturado; acima dele o filho é encerrado e o resultado marca `overflow`. */
  readonly maxOutputBytes: number;
}

export interface RunResult {
  /** `null` se o filho não terminou normalmente (sinal, prazo, teto da saída, programa ausente). */
  readonly exitCode: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
  readonly overflow: boolean;
}

export interface ProcessRunner {
  run(request: RunRequest): Promise<RunResult>;
}

export interface Clock {
  /** Milissegundos monotônicos (prazos). */
  monotonicMs(): number;
  /** Hora de parede ISO 8601 (só para o log local). */
  isoNow(): string;
  sleep(ms: number): Promise<void>;
}

/** Trava exclusiva por ambiente: a função de liberação, ou `null` se outra execução a tem (`E_LOCKED`). */
export interface LockPort {
  tryAcquire(path: string): Promise<(() => Promise<void>) | null>;
}

export type InputEvent = { readonly kind: 'data'; readonly chunk: Uint8Array } | { readonly kind: 'end' } | { readonly kind: 'idle' };

/** O stdin, pedaço a pedaço, com prazo SEM dados por pedido. */
export interface ByteSource {
  next(idleMs: number): Promise<InputEvent>;
}

/** Log local (`--log`, `0600`): uma linha JSON por evento. Nunca valor do arquivo de variáveis, nunca a saída pública. */
export interface ReceiverLog {
  write(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
}

export interface ReceiverDeps {
  readonly fs: ReceiverFs;
  readonly runner: ProcessRunner;
  readonly clock: Clock;
  readonly lock: LockPort;
  readonly stdin: ByteSource;
  readonly log: ReceiverLog;
  /** O `PATH` fixo do wrapper, repassado aos filhos. */
  readonly childPath: string;
  /** Sufixo aleatório para temporários (hex). */
  randomSuffix(): string;
}
