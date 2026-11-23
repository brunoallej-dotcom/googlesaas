import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { ReceiverConfig } from './args';
import type { ByteSource, Clock, ExclusiveFile, FileStat, InputEvent, LockPort, ProcessRunner, ReceiverDeps, ReceiverFs, ReceiverLog, RunRequest, RunResult } from './ports';

/*
 * P9.3a — os adaptadores de PRODUÇÃO das portas do receptor de deploy (o único arquivo do módulo que toca disco, processo filho, relógio e
 * stdin). Processos: `execFile` com argv fixo e `shell: false`, ambiente COMPLETO dado pelo chamador (nada herdado), prazo com `SIGKILL` e teto
 * de saída. Arquivos novos sempre com `O_EXCL | O_NOFOLLOW`.
 */

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_APPEND, O_DIRECTORY } = fs.constants;
const LOCK_MAX_BYTES = 64;
const GROUP_OTHER_BITS = 0o077;
const RANDOM_SUFFIX_BYTES = 8;
const REQUEST_ID_BYTES = 4;

const errnoOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined);

const toStat = (info: fs.Stats): FileStat => ({ isFile: info.isFile(), isDirectory: info.isDirectory(), isSymbolicLink: info.isSymbolicLink(), size: info.size });

/** Erro tipado do adaptador (a mensagem não leva caminho). */
class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

async function readCapped(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await fsp.open(path, O_RDONLY | O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new AdapterError('file not regular or above the cap');
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new AdapterError('file above the cap');
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

async function sha256Of(path: string): Promise<{ readonly sha256: string; readonly size: number }> {
  const handle = await fsp.open(path, O_RDONLY | O_NOFOLLOW);
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      size += bytes.byteLength;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), size };
}

async function openExclusive(path: string, mode: number): Promise<ExclusiveFile> {
  const handle = await fsp.open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode);
  return {
    async write(chunk) {
      let offset = 0;
      while (offset < chunk.byteLength) offset += (await handle.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
    },
    chmod: (newMode) => handle.chmod(newMode),
    sync: () => handle.sync(),
    close: () => handle.close(),
  };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await fsp.open(path, O_RDONLY | O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const nodeReceiverFs: ReceiverFs = {
  async lstat(path) {
    try {
      return toStat(await fsp.lstat(path));
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return null;
      throw error;
    }
  },
  readFileCapped: readCapped,
  sha256File: sha256Of,
  readdir: (path) => fsp.readdir(path),
  unlink: (path) => fsp.unlink(path),
  mkdir: async (path, mode) => {
    await fsp.mkdir(path, { mode });
  },
  rename: (from, to) => fsp.rename(from, to),
  realpath: (path) => fsp.realpath(path),
  async availableBytes(path) {
    const info = await fsp.statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  },
  createExclusive: openExclusive,
  syncDirectory,
};

const programFile = (request: RunRequest): string => (typeof request.program === 'string' ? request.program : request.program.script);

/** O ambiente do filho é EXATAMENTE o dado (o tipo do Next exige `NODE_ENV` em `ProcessEnv`; o filho não o recebe). */
const childEnvironment = (env: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({ ...env }) as NodeJS.ProcessEnv;

/** `execFile` sem shell; o `PATH` de busca é o do ambiente dado (`options.env.PATH`). */
export const nodeProcessRunner: ProcessRunner = {
  run(request) {
    return new Promise<RunResult>((resolve) => {
      const file = programFile(request);
      const args = [...request.args];
      const options = { env: childEnvironment(request.env), shell: false, timeout: request.timeoutMs, killSignal: 'SIGKILL' as const, maxBuffer: request.maxOutputBytes, encoding: 'buffer' as const, windowsHide: true };
      const onExit = (error: Error | null, stdout: Buffer, stderr: Buffer): void => {
        const overflow = errnoOf(error) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        const killed = error !== null && 'killed' in error && error.killed === true;
        const code: unknown = error === null ? 0 : (error as { code?: unknown }).code;
        const exitCode = error === null ? 0 : typeof code === 'number' && !killed ? code : null;
        resolve({ exitCode, stdout, stderr, timedOut: killed && !overflow, overflow });
      };
      // o programa é um nome da lista fechada (docker, tar, gzip) ou o script fixo do wrapper; argv fixo e shell: false
      const child = execFile(file, args, options, onExit); // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- programa de lista fechada, sem shell, argv montado pelo receptor
      child.stdin?.end();
    });
  },
};

export const nodeClock: Clock = {
  monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  isoNow: () => new Date().toISOString(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function lockOwner(path: string): Promise<number | null> {
  try {
    const text = Buffer.from(await readCapped(path, LOCK_MAX_BYTES)).toString('ascii');
    const match = /^([1-9][0-9]{0,9})\n$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function createLock(path: string): Promise<boolean> {
  try {
    const file = await openExclusive(path, 0o600);
    try {
      await file.write(Buffer.from(`${process.pid}\n`, 'ascii'));
      await file.sync();
    } finally {
      await file.close();
    }
    return true;
  } catch (error) {
    if (errnoOf(error) === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Trava de DEFESA do lado do Node (a trava de verdade é a do kernel, `flock -n` no wrapper, revisão do PR #70): arquivo exclusivo com o pid.
 * Arquivo já existente ⇒ ocupada (`E_LOCKED`), sem retomada por nome: o receptor nunca apaga uma trava que não é dele. A liberação só apaga
 * o arquivo que ainda tem o próprio pid. Um arquivo que sobrou de um receptor morto por `SIGKILL` é apagado à mão pelo responsável (runbook).
 */
export const nodeLock: LockPort = {
  async tryAcquire(path) {
    if (!(await createLock(path))) return null;
    return async () => {
      if ((await lockOwner(path)) === process.pid) await fsp.unlink(path);
    };
  },
};

type Readable = NodeJS.ReadableStream & { read(): Buffer | string | null };

/**
 * O stdin pedaço a pedaço (modo pausado, `read()`), com prazo sem dados por pedido. Os ouvintes só são ligados no primeiro `next()`: recusas que
 * vêm antes (gramática, trava, passos 1 e 2) não leem nada. Erro no stdin conta como prazo vencido (`E_INPUT_TRUNCATED`).
 */
export function streamByteSource(getStream: () => Readable): ByteSource {
  let stream: Readable | null = null;
  let ended = false;
  let failed = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const pending = wake;
    wake = null;
    pending?.();
  };
  const attach = (): Readable => {
    if (stream !== null) return stream;
    const current = getStream();
    current.on('readable', notify);
    current.on('end', () => {
      ended = true;
      notify();
    });
    current.on('error', () => {
      failed = true;
      notify();
    });
    stream = current;
    return current;
  };
  return {
    async next(idleMs): Promise<InputEvent> {
      const source = attach();
      for (;;) {
        if (failed) return { kind: 'idle' };
        const chunk = source.read();
        if (chunk !== null) return { kind: 'data', chunk: typeof chunk === 'string' ? Buffer.from(chunk) : chunk };
        if (ended) return { kind: 'end' };
        const timedOut = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve(true);
          }, idleMs);
          wake = () => {
            clearTimeout(timer);
            resolve(false);
          };
        });
        if (timedOut) return { kind: 'idle' };
      }
    },
  };
}

/** Log local: arquivo regular sem permissão para grupo e outros (`0600`), aberto para acréscimo sem seguir link. Uma linha JSON por evento. */
export function openReceiverLog(file: string, clock: Clock): ReceiverLog {
  const fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
  const info = fs.fstatSync(fd);
  if (!info.isFile() || (info.mode & GROUP_OTHER_BITS) !== 0) {
    fs.closeSync(fd);
    throw new AdapterError('log file is not a private regular file');
  }
  const request = `${process.pid}-${randomBytes(REQUEST_ID_BYTES).toString('hex')}`;
  return {
    write(event, fields = {}) {
      // o log é o próprio destino dos erros: uma escrita que falha (disco cheio) não interrompe o deploy nem muda a saída pública
      try {
        fs.writeSync(fd, `${JSON.stringify({ t: clock.isoNow(), req: request, event, ...fields })}\n`);
      } catch {
        return;
      }
    },
  };
}

/** As portas de produção para os parâmetros do wrapper. */
export function createNodeDeps(config: ReceiverConfig, childPath: string): ReceiverDeps {
  return {
    fs: nodeReceiverFs,
    runner: nodeProcessRunner,
    clock: nodeClock,
    lock: nodeLock,
    stdin: streamByteSource(() => process.stdin as Readable),
    log: openReceiverLog(config.logFile, nodeClock),
    childPath,
    randomSuffix: () => randomBytes(RANDOM_SUFFIX_BYTES).toString('hex'),
  };
}
