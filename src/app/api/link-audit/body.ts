import { NextResponse } from 'next/server';

/** Cabeçalhos das rotas da Auditoria por Link: nada é guardado em cache. */
export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const MAX_BODY_BYTES = 16_384;
export const READ_TIMEOUT_MS = 10_000;

export type BodyResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly response: NextResponse };

function refuse(status: number, code: string, error: string): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error, code }, { status, headers: NO_STORE }) };
}

type LimitedText = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: 'TOO_LARGE' | 'UNREADABLE' | 'TIMEOUT' };

/**
 * Lê o corpo em fluxo e PARA no limite: ao passar de `maxBytes` o fluxo é cancelado e o restante nunca é
 * carregado na memória (nem de um corpo "chunked" sem Content-Length).
 */
async function readLimitedText(request: Request, maxBytes: number, timeoutMs: number): Promise<LimitedText> {
  const stream = request.body;
  if (!stream) return { ok: true, text: '' };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs);
  });
  try {
    for (;;) {
      const step = await Promise.race([reader.read(), deadline]);
      if (step === 'TIMEOUT') {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'TIMEOUT' };
      }
      const { done, value } = step;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'TOO_LARGE' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'UNREADABLE' };
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

/** Lê o corpo JSON com limite efetivo de tamanho. O conteúdo nunca é registrado em log. */
export async function readJsonBody(request: Request, maxBytes: number = MAX_BODY_BYTES, timeoutMs: number = READ_TIMEOUT_MS): Promise<BodyResult> {
  // Só o tipo exato (parâmetros como charset são aceitos); "text/plain; x=application/json" não é JSON.
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    return refuse(415, 'UNSUPPORTED_MEDIA_TYPE', 'Envie o corpo como JSON.');
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return refuse(413, 'BODY_TOO_LARGE', 'Corpo da requisição grande demais.');

  const read = await readLimitedText(request, maxBytes, timeoutMs);
  if (!read.ok) {
    if (read.reason === 'TOO_LARGE') return refuse(413, 'BODY_TOO_LARGE', 'Corpo da requisição grande demais.');
    if (read.reason === 'TIMEOUT') return refuse(408, 'REQUEST_TIMEOUT', 'Tempo esgotado ao ler o corpo da requisição.');
    return refuse(400, 'INVALID_BODY', 'Não foi possível ler o corpo da requisição.');
  }
  try {
    return { ok: true, value: JSON.parse(read.text) as unknown };
  } catch {
    return refuse(400, 'INVALID_JSON', 'JSON inválido.');
  }
}

export function invalidBody(): NextResponse {
  return NextResponse.json({ error: 'Parâmetros inválidos', code: 'INVALID_PARAMS' }, { status: 400, headers: NO_STORE });
}

/** Resposta genérica para falhas inesperadas: sem mensagem interna, sem pilha, sem o link. */
export function internalFailure(): NextResponse {
  return NextResponse.json({ error: 'Não foi possível concluir a operação.', code: 'INTERNAL_ERROR' }, { status: 500, headers: NO_STORE });
}
