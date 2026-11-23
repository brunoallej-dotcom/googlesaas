import type { BytesFsOps } from '../link-audit/fs-ops';

/*
 * P9.3b — as portas do receptor de manifestos. O núcleo (`grammar`, `input`, `trust`, `candidate`, `layout`, `verify`, `write`, `put`) só fala com o
 * mundo por elas, então tudo é testável sem ssh e sem relógio real, com falhas injetadas no disco. O adaptador de produção é `node-adapters.ts`: o
 * disco do Node (a porta `BytesFsOps` da Fase 6, com a escrita exclusiva em modo explícito), a trava de defesa, o log local, o relógio e o stdin.
 * Sem processo filho: o receptor de manifestos nunca chama outro programa.
 */

export type InputEvent = { readonly kind: 'data'; readonly chunk: Uint8Array } | { readonly kind: 'end' } | { readonly kind: 'idle' };

/** O stdin, pedaço a pedaço, com prazo SEM dados por pedido. */
export interface ByteSource {
  next(idleMs: number): Promise<InputEvent>;
}

export interface Clock {
  /** Milissegundos monotônicos (o prazo do stdin). */
  monotonicMs(): number;
  /** Hora de parede ISO 8601 (só para o log local). */
  isoNow(): string;
}

/** Trava de DEFESA por ambiente (a de verdade é a do kernel, `flock -n` no wrapper): a liberação, ou `null` se o arquivo já existe (`E_LOCKED`). */
export interface LockPort {
  tryAcquire(path: string): Promise<(() => Promise<void>) | null>;
}

/** Log local (`--log`, `0600`): uma linha JSON por evento. Nunca conteúdo de arquivo, nunca a saída pública além do código. */
export interface ReceiverLog {
  write(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
}

/**
 * O modelo de permissões do Node em que o receptor roda (`process.permission`, Node 22 com `--permission`). `null` = modelo desligado (wrapper
 * sem `--permission`), que o receptor recusa (`E_INTERNAL`).
 */
export interface PermissionFacts {
  has(scope: 'fs.read' | 'fs.write' | 'child' | 'worker', reference?: string): boolean;
}

export interface SealReceiverDeps {
  /**
   * Disco: a pasta de manifestos (leitura, criação de subpasta, temporário exclusivo, `link()`, remoção do próprio temporário, fsync) e a leitura
   * da lista instalada. `writeExclusive` grava o MODO pedido de forma explícita (o `umask 027` do receptor não decide o `0444` do manifesto).
   */
  readonly fs: BytesFsOps;
  readonly stdin: ByteSource;
  readonly clock: Clock;
  readonly lock: LockPort;
  readonly log: ReceiverLog;
  /** Sufixo aleatório do temporário (32 hex). */
  tempSuffix(): string;
}
