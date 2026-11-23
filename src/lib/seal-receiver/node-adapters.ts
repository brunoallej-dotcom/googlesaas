import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { BytesFsOps } from '../link-audit/fs-ops';
import { nodeFsOps } from '../link-audit/node-fs-ops';
import type { SealReceiverConfig } from './args';
import type { ByteSource, Clock, InputEvent, LockPort, PermissionFacts, ReceiverLog, SealReceiverDeps } from './ports';

/*
 * P9.3b — os adaptadores de PRODUÇÃO das portas do receptor de manifestos (o único arquivo do módulo que toca disco, relógio, stdin e o processo).
 * O disco é o adaptador padrão da Fase 6 (`nodeFsOps`: leitura sem seguir link, sem travar em FIFO, tipo e tamanho no descritor, teto), com UMA troca:
 * a escrita exclusiva grava o modo pedido de forma EXPLÍCITA (`chmod` do temporário recém-criado, antes do `fsync`), porque o receptor roda com
 * `umask 027` e o manifesto tem de nascer `0444`. É `chmod` pelo caminho porque o modelo de permissões do Node desliga o `fchmod`; o temporário
 * acabou de ser criado com `O_EXCL` numa pasta em que só o usuário do receptor escreve. Sem processo filho, sem rede.
 */

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_APPEND } = fs.constants;
const LOCK_MAX_BYTES = 64;
const GROUP_OTHER_BITS = 0o077;
const TEMP_SUFFIX_BYTES = 16;
const REQUEST_ID_BYTES = 4;
/** O `umask` do receptor (spec §5.7): pastas novas `2750` com o setgid herdado da raiz; os arquivos têm modo explícito. */
export const RECEIVER_UMASK = 0o027;

const errnoOf = (error: unknown): string | undefined => (typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined);

/** Erro tipado do adaptador (a mensagem não leva caminho). */
class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

/** Criação exclusiva (`wx` = `O_CREAT | O_EXCL`, que não segue link), escrita, modo explícito, `fsync` e fechamento. */
async function writeExclusiveWithMode(target: string, data: string, mode = 0o600): Promise<void> {
  const handle = await fsp.open(target, 'wx', mode);
  try {
    await handle.writeFile(data, 'utf8');
    await fsp.chmod(target, mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** O disco do receptor: o adaptador padrão da Fase 6, com a escrita exclusiva em modo explícito. */
export const sealReceiverFs: BytesFsOps = { ...nodeFsOps, writeExclusive: writeExclusiveWithMode };

export const nodeClock: Clock = {
  monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  isoNow: () => new Date().toISOString(),
};

async function lockOwner(path: string): Promise<number | null> {
  try {
    const text = Buffer.from(await nodeFsOps.readFileBytes(path, LOCK_MAX_BYTES)).toString('ascii');
    const match = /^([1-9][0-9]{0,9})\n$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function createLock(path: string): Promise<boolean> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  } catch (error) {
    if (errnoOf(error) === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`, 'ascii');
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Trava de DEFESA do lado do Node (a de verdade é a do kernel, `flock -n` no wrapper, como no receptor de deploy): arquivo exclusivo com o pid.
 * Arquivo já existente ⇒ ocupada (`E_LOCKED`), sem retomada: o receptor nunca apaga uma trava que não é dele. A liberação só apaga o arquivo que
 * ainda tem o próprio pid. Um arquivo que sobrou de um receptor morto por `SIGKILL` é apagado à mão pelo responsável, depois de conferir a trava do
 * kernel (runbook H-04). Sem `fsync`: a trava vale só enquanto o processo vive.
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
 * vêm antes (gramática, trava) não leem nada. Erro no stdin conta como prazo vencido (`E_INPUT_TRUNCATED`).
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
      // o log é o próprio destino dos erros: uma escrita que falha (disco cheio) não muda a gravação nem a saída pública
      try {
        fs.writeSync(fd, `${JSON.stringify({ t: clock.isoNow(), req: request, event, ...fields })}\n`);
      } catch {
        return;
      }
    },
  };
}

/** O modelo de permissões do processo (`process.permission`, Node com `--permission`), ou `null` se desligado. */
export function processPermission(): PermissionFacts | null {
  const permission = (process as { permission?: { has(scope: string, reference?: string): boolean } }).permission;
  if (permission === undefined || typeof permission.has !== 'function') return null;
  return { has: (scope, reference) => (reference === undefined ? permission.has(scope) : permission.has(scope, reference)) };
}

/** As portas de produção para os parâmetros do wrapper. */
export function createNodeSealDeps(config: SealReceiverConfig): SealReceiverDeps {
  return {
    fs: sealReceiverFs,
    stdin: streamByteSource(() => process.stdin as Readable),
    clock: nodeClock,
    lock: nodeLock,
    log: openReceiverLog(config.logFile, nodeClock),
    tempSuffix: () => randomBytes(TEMP_SUFFIX_BYTES).toString('hex'),
  };
}
