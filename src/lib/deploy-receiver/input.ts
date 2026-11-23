import { ReceiverError } from './codes';
import type { ByteSource } from './ports';

/*
 * P9.3a — leitura do stdin com teto e prazo SEM dados (spec §5.6): bytes a mais ⇒ `E_INPUT_TOO_LARGE` (no primeiro byte a mais, sem ler o
 * resto); fim antes do esperado ou prazo vencido ⇒ `E_INPUT_TRUNCATED`. Puro (o stdin vem pela porta).
 */

/** Lê até o fim, recusando acima de `maxBytes` (a lista de confiança do `deploy`, até 8 KiB). */
export async function readAllCapped(source: ByteSource, maxBytes: number, idleMs: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const event = await source.next(idleMs);
    if (event.kind === 'idle') throw new ReceiverError('E_INPUT_TRUNCATED', null, 'stdin idle timeout');
    if (event.kind === 'end') break;
    total += event.chunk.byteLength;
    if (total > maxBytes) throw new ReceiverError('E_INPUT_TOO_LARGE', null, `stdin above ${maxBytes} bytes`);
    chunks.push(event.chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Entrega a `sink` exatamente `expectedBytes` bytes do stdin e exige o fim logo depois (o pacote do `upload`). O primeiro byte além do declarado
 * recusa na hora; o fim antes, ou `idleMs` sem dados, também.
 */
export async function streamExact(source: ByteSource, expectedBytes: number, idleMs: number, sink: (chunk: Uint8Array) => Promise<void>): Promise<void> {
  let total = 0;
  for (;;) {
    const event = await source.next(idleMs);
    if (event.kind === 'idle') throw new ReceiverError('E_INPUT_TRUNCATED', null, `stdin idle timeout after ${total} bytes`);
    if (event.kind === 'end') break;
    total += event.chunk.byteLength;
    if (total > expectedBytes) throw new ReceiverError('E_INPUT_TOO_LARGE', null, 'stdin above the declared size');
    await sink(event.chunk);
  }
  if (total < expectedBytes) throw new ReceiverError('E_INPUT_TRUNCATED', null, `stdin ended after ${total} of ${expectedBytes} bytes`);
}
