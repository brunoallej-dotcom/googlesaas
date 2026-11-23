import { createHash } from 'node:crypto';
import { SealReceiverError } from './codes';
import type { ByteSource, Clock } from './ports';

/*
 * P9.3b — passo 1 do `put` (spec §5.7): o stdin até o teto + 1 byte, com prazo de 30 s, e o SHA-256 em fluxo. O primeiro byte além do teto recusa na
 * hora, sem ler o resto (`E_INPUT_TOO_LARGE`). Prazo vencido, erro no stdin ou fim sem nenhum byte ⇒ `E_INPUT_TRUNCATED` (um manifesto nunca é
 * vazio). O prazo vale para o stdin INTEIRO, não só para cada espera: quem gotejar bytes não segura a trava do ambiente além dele. O relógio é
 * conferido de novo DEPOIS de cada espera (dados ou fim): um evento que chega depois do prazo nunca é aceito (revisão do PR #72, item 10). Puro
 * (stdin e relógio pelas portas).
 */

/** Prazo do stdin inteiro (cobre também o tempo sem dados entre pedaços). */
export const STDIN_DEADLINE_MS = 30_000;

export interface ReceivedInput {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/** Lê o stdin até o fim, recusando acima de `maxBytes` ou depois do prazo. Devolve os bytes e o SHA-256 deles. */
export async function readCandidateInput(source: ByteSource, clock: Clock, maxBytes: number): Promise<ReceivedInput> {
  const deadline = clock.monotonicMs() + STDIN_DEADLINE_MS;
  const hash = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const remaining = deadline - clock.monotonicMs();
    if (remaining <= 0) throw new SealReceiverError('E_INPUT_TRUNCATED', null, `stdin deadline after ${total} bytes`);
    const event = await source.next(remaining);
    if (event.kind === 'idle') throw new SealReceiverError('E_INPUT_TRUNCATED', null, `stdin idle or failed after ${total} bytes`);
    if (clock.monotonicMs() > deadline) throw new SealReceiverError('E_INPUT_TRUNCATED', null, `stdin event after the deadline (${total} bytes)`);
    if (event.kind === 'end') break;
    total += event.chunk.byteLength;
    if (total > maxBytes) throw new SealReceiverError('E_INPUT_TOO_LARGE', null, `stdin above ${maxBytes} bytes`);
    hash.update(event.chunk);
    chunks.push(event.chunk);
  }
  if (total === 0) throw new SealReceiverError('E_INPUT_TRUNCATED', null, 'stdin ended without bytes');
  return { bytes: Buffer.concat(chunks, total), sha256: hash.digest('hex') };
}
