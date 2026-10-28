import { NextResponse } from 'next/server';
import { SlidingWindowLimiter } from './rate-limit';

/** Limites por operador para as rotas que gastam créditos (configuráveis por ambiente). */
function intFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const prospectLimiter = new SlidingWindowLimiter(intFromEnv('GMN_RATE_PROSPECT_PER_HOUR', 20), 60 * 60_000);
const enqueueLimiter = new SlidingWindowLimiter(intFromEnv('GMN_RATE_ENQUEUE_PER_HOUR', 30), 60 * 60_000);

export function limitProspect(operator: string): NextResponse | null {
  return toResponse(prospectLimiter.consume(operator));
}

export function limitEnqueue(operator: string): NextResponse | null {
  return toResponse(enqueueLimiter.consume(operator));
}

function toResponse(result: { allowed: boolean; retryAfterSeconds: number }): NextResponse | null {
  if (result.allowed) return null;
  return NextResponse.json(
    { error: 'Limite de operações atingido. Aguarde antes de tentar novamente.', code: 'RATE_LIMITED' },
    { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds), 'Cache-Control': 'no-store' } }
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

export function invalidIdResponse(): NextResponse {
  return NextResponse.json({ error: 'Identificador de auditoria inválido.', code: 'INVALID_ID' }, { status: 400 });
}
