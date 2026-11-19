import { CONFIRM_PREFIX_LENGTH, type ConfirmationFacts } from './sign-core';

/*
 * P1 W4.4 — o TERMINAL do `sign` (spec §5.5 passos 11 e 12; §5.5.1 item 8; §8 K1; IA-04, IA-15, IA-23; RS-11). Lê UMA linha digitada pelo
 * custodiante com o eco DESLIGADO (modo bruto do TTY herdado), sem nunca mostrar o que foi digitado. Usado para a confirmação dos 12 caracteres
 * (passo 11) e para a frase da chave (passo 12). Regras:
 *  - stdin que não é TTY, sem `setRawMode` ou cujo modo bruto não liga ⇒ recusa ANTES de ler qualquer byte (nada seria lido com eco);
 *  - o modo bruto é ligado uma vez por sessão, ANTES de cada tela ser mostrada (revisão da W4.4), e fica ligado entre a confirmação e a frase (o
 *    que o custodiante digitar adiantado também não ecoa); é restaurado ao modo de antes em `close()`, que quem usa chama em `finally`;
 *  - Enter (CR, LF ou CRLF) termina; Backspace apaga um caractere (UTF-8 inteiro); Ctrl-U apaga a linha; Ctrl-C, Ctrl-D, fim de entrada, erro do
 *    terminal, outra tecla de controle (setas, Esc) ou texto acima do limite ⇒ recusa tipada, sem o que foi digitado;
 *  - os buffers do que foi digitado são zerados depois do uso (quem recebe a linha zera a sua cópia). Limite declarado: o Node pode manter cópias
 *    internas (fluxo do terminal, cadeia de texto da confirmação) que este código não alcança.
 * Sem imports de disco, rede ou ambiente: o terminal é injetado (`process.stdin` em produção; um falso nos testes).
 */

/** O `process.stdin` de um TTY, no que este arquivo usa (injetável nos testes). */
export interface SignTerminal {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end' | 'error', listener: () => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'end' | 'error', listener: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** Por que a linha não foi obtida (nunca carrega o que foi digitado). */
export type TerminalFailure = 'NO_TTY' | 'INTERRUPTED' | 'ENDED' | 'TOO_LONG' | 'CONTROL_KEY' | 'TERMINAL_ERROR' | 'CLOSED';

export class TerminalInputError extends Error {
  readonly reason: TerminalFailure;
  constructor(reason: TerminalFailure) {
    super(`entrada do terminal não obtida (${reason})`);
    this.name = 'TerminalInputError';
    this.reason = reason;
  }
}

export interface HiddenInput {
  /**
   * Desliga o eco JÁ (modo bruto), antes de mostrar uma tela: o que o custodiante digitar assim que a tela aparece não ecoa. Lança
   * `TerminalInputError` (`NO_TTY`) se o terminal não aceita. Idempotente na sessão.
   */
  hideEcho(): void;
  /** Uma linha digitada SEM eco, sem o fim de linha. Quem recebe zera o buffer depois de usar. */
  readLine(maxBytes: number): Promise<Buffer>;
  /** Restaura o modo do terminal (eco) se esta sessão o mudou e zera o que sobrou digitado. Idempotente; chamar em `finally`. */
  close(): void;
}

/** Limite da confirmação (12 caracteres esperados; folga para o custodiante errar sem que a linha seja cortada). */
export const MAX_CONFIRMATION_BYTES = 64;
/** Limite da frase da chave (frase longa digitada, D11). */
export const MAX_PASSPHRASE_BYTES = 1024;

const CR = 0x0d;
const LF = 0x0a;
const CTRL_C = 0x03;
const CTRL_D = 0x04;
const BACKSPACE = 0x08;
const CTRL_U = 0x15;
const DELETE = 0x7f;
const FIRST_PRINTABLE = 0x20;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION = 0x80;
const EMPTY = Buffer.alloc(0);

/** Apaga o último caractere (com todos os bytes de continuação UTF-8) e zera o que saiu. Devolve o novo comprimento. */
function dropLastChar(line: Buffer, length: number): number {
  if (length === 0) return 0;
  let end = length - 1;
  while (end > 0 && ((line[end] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION) end -= 1;
  line.fill(0, end, length);
  return end;
}

/** Estado de UMA leitura: os bytes já digitados da linha atual (buffer próprio, zerado no fim). */
interface LineState {
  readonly line: Buffer;
  length: number;
}
type Step = { readonly done: false } | { readonly done: true; readonly line: Buffer; readonly rest: Buffer } | { readonly done: true; readonly error: TerminalInputError; readonly rest: Buffer };

/** Consome bytes digitados até o fim da linha (ou uma recusa). O que vier depois do Enter volta como `rest` (digitação adiantada). */
function consume(state: LineState, bytes: Buffer): Step {
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] as number;
    if (byte === CR || byte === LF) {
      const skip = byte === CR && bytes[index + 1] === LF ? 2 : 1;
      return { done: true, line: Buffer.from(state.line.subarray(0, state.length)), rest: Buffer.from(bytes.subarray(index + skip)) };
    }
    if (byte === CTRL_C || byte === CTRL_D) return { done: true, error: new TerminalInputError('INTERRUPTED'), rest: EMPTY };
    if (byte === DELETE || byte === BACKSPACE) {
      state.length = dropLastChar(state.line, state.length);
      continue;
    }
    if (byte === CTRL_U) {
      state.line.fill(0, 0, state.length);
      state.length = 0;
      continue;
    }
    if (byte < FIRST_PRINTABLE) return { done: true, error: new TerminalInputError('CONTROL_KEY'), rest: EMPTY };
    if (state.length >= state.line.length) return { done: true, error: new TerminalInputError('TOO_LONG'), rest: EMPTY };
    state.line[state.length] = byte;
    state.length += 1;
  }
  return { done: false };
}

/**
 * Sessão de leitura sem eco sobre o terminal herdado. O modo bruto é ligado na primeira leitura (se o terminal não aceitar, nada é lido) e
 * restaurado em `close()`.
 */
export function openHiddenInput(terminal: SignTerminal): HiddenInput {
  let changed = false;
  let wasRaw = false;
  let closed = false;
  let pending: Buffer = EMPTY;

  const restore = (): void => {
    if (!changed) return;
    changed = false;
    terminal.setRawMode?.(wasRaw);
  };
  const ensureRaw = (): void => {
    if (closed) throw new TerminalInputError('CLOSED');
    if (changed) return;
    if (terminal.isTTY !== true || typeof terminal.setRawMode !== 'function') throw new TerminalInputError('NO_TTY');
    wasRaw = terminal.isRaw === true;
    changed = true;
    terminal.setRawMode(true);
    if (terminal.isRaw !== true) {
      restore(); // o eco não desligou: nada pode ser lido
      throw new TerminalInputError('NO_TTY');
    }
  };
  const takePending = (): Buffer => {
    const taken = pending;
    pending = EMPTY;
    return taken;
  };

  return {
    hideEcho: ensureRaw,
    async readLine(maxBytes) {
      ensureRaw();
      const state: LineState = { line: Buffer.alloc(maxBytes), length: 0 };
      try {
        return await readUntilLine(terminal, state, takePending(), (rest) => {
          if (rest.length > 0) {
            const before = pending;
            pending = Buffer.concat([before, rest]);
            before.fill(0);
          }
          rest.fill(0);
        });
      } finally {
        state.line.fill(0);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      pending.fill(0);
      pending = EMPTY;
      restore();
    },
  };
}

/**
 * Lê do terminal (já em modo bruto) até o fim da linha, começando pelo que já estava digitado (`first`). O que chegar depois do Enter, inclusive
 * num evento atrasado, vai para `keep` (próxima leitura da sessão). Ouvintes removidos e fluxo pausado no fim, em qualquer caso.
 */
function readUntilLine(terminal: SignTerminal, state: LineState, first: Buffer, keep: (rest: Buffer) => void): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (step: Step): void => {
      if (!step.done) return;
      settled = true;
      terminal.removeListener('data', onData);
      terminal.removeListener('end', onEnd);
      terminal.removeListener('error', onError);
      terminal.pause();
      keep(step.rest);
      if ('error' in step) reject(step.error);
      else resolve(step.line);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      try {
        if (settled) keep(Buffer.from(bytes));
        else finish(consume(state, bytes));
      } finally {
        bytes.fill(0);
      }
    };
    const onEnd = (): void => finish({ done: true, error: new TerminalInputError('ENDED'), rest: EMPTY });
    const onError = (): void => finish({ done: true, error: new TerminalInputError('TERMINAL_ERROR'), rest: EMPTY });
    const initial = consume(state, first);
    first.fill(0);
    if (initial.done) {
      settled = true;
      keep(initial.rest);
      if ('error' in initial) reject(initial.error);
      else resolve(initial.line);
      return;
    }
    terminal.on('data', onData);
    terminal.on('end', onEnd);
    terminal.on('error', onError);
    terminal.resume();
  });
}

/**
 * Porta `confirm` do núcleo (passo 11, IA-23): mostra só `auditId`, `seq` e o número de entradas e pede os 12 primeiros caracteres de
 * `packageSha256` CONFORME O DOSSIÊ (lidos fora desta tela). Nunca mostra o hash nem parte dele, nem ecoa o que foi digitado. Devolve o texto sem
 * o fim de linha; o núcleo compara exatamente. Sem TTY ou entrada interrompida, a promessa rejeita (o núcleo converte em recusa).
 */
export function terminalConfirm(input: HiddenInput, say: (line: string) => void): (facts: ConfirmationFacts) => Promise<string> {
  return async (facts) => {
    input.hideEcho(); // revisão da W4.4: o eco sai ANTES da tela (sob carga, uma digitação rápida chegou antes do modo bruto e ecoou)
    say(`Confirmação humana (passo 11): auditoria ${facts.auditId}, manifesto seq ${facts.seq}, ${facts.entries} entradas a atestar.`);
    say(`Digite os ${CONFIRM_PREFIX_LENGTH} primeiros caracteres de packageSha256 conforme o DOSSIÊ de aprovação (a digitação não aparece na tela) e tecle Enter:`);
    const typed = await input.readLine(MAX_CONFIRMATION_BYTES);
    try {
      return typed.toString('utf8');
    } finally {
      typed.fill(0);
    }
  };
}

/** Pedido da frase da chave (passo 12): só o `--key-id` (público). Devolve os BYTES digitados; quem recebe os zera depois de abrir a chave. */
export function terminalPassphrase(input: HiddenInput, say: (line: string) => void): (keyId: string) => Promise<Buffer> {
  return async (keyId) => {
    input.hideEcho();
    say(`Frase-senha da chave ${keyId} (passo 12; a digitação não aparece na tela), e Enter:`);
    return input.readLine(MAX_PASSPHRASE_BYTES);
  };
}
