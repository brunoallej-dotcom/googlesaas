import { NextResponse } from 'next/server';
import { z } from 'zod';
import { crossOriginViolation, resolveClientAddress, isOperatorAllowed, parseOperatorAllowlist, sessionSecretFrom, shouldUseSecureCookie } from '@/lib/auth/guard';
import { loginDependencies } from '@/lib/auth/login-deps';
import { buildSessionCookie, createSessionToken } from '@/lib/auth/session';
import { StructuredLogger } from '@/lib/logger';
import { SlidingWindowLimiter } from '@/lib/rate-limit';

const Schema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});

// 5 tentativas por e-mail+origem, 20 por origem e 15 por e-mail da lista (qualquer origem), a cada 15 minutos.
const perAccount = new SlidingWindowLimiter(5, 15 * 60_000);
const perAddress = new SlidingWindowLimiter(20, 15 * 60_000);
const perEmail = new SlidingWindowLimiter(15, 15 * 60_000);
// IP privado/`local` (ex.: NAT do ingress do Swarm): não identifica um cliente; usa um balde GLOBAL maior (limita o uso do Supabase).
const perSharedAddress = new SlidingWindowLimiter(100, 15 * 60_000);
const logger = new StructuredLogger('SYSTEM');

const INVALID = (): NextResponse =>
  NextResponse.json({ error: 'E-mail ou senha inválidos.', code: 'INVALID_CREDENTIALS' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: Request): Promise<NextResponse> {
  if (crossOriginViolation(request)) {
    return NextResponse.json({ error: 'Origem da requisição não permitida.', code: 'CROSS_ORIGIN' }, { status: 403 });
  }
  const env = process.env;
  if (!sessionSecretFrom(env) || parseOperatorAllowlist(env).length === 0) {
    return NextResponse.json(
      { error: 'Acesso fechado: a autenticação não está configurada.', code: 'AUTH_NOT_CONFIGURED' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return INVALID();
  const { email, password } = parsed.data;

  const client = resolveClientAddress(request.headers);
  const address = client.address;
  const byAddress = client.shared ? perSharedAddress.consume('shared') : perAddress.consume(address);
  const byAccount = perAccount.consume(`${address}|${email}`);
  // limite por e-mail sem IP: só para e-mails da lista (não deixa um atacante encher o limitador com e-mails inventados)
  const byEmail = isOperatorAllowed(email, env) ? perEmail.consume(email) : { allowed: true, retryAfterSeconds: 0 };
  if (!byAddress.allowed || !byAccount.allowed || !byEmail.allowed) {
    const retry = Math.max(byAddress.retryAfterSeconds, byAccount.retryAfterSeconds, byEmail.retryAfterSeconds);
    return NextResponse.json(
      { error: 'Muitas tentativas. Aguarde antes de tentar novamente.', code: 'RATE_LIMITED' },
      { status: 429, headers: { 'Retry-After': String(retry), 'Cache-Control': 'no-store' } }
    );
  }

  // E-mail fora da lista: nem chega ao Supabase e a resposta é idêntica a uma senha errada.
  const allowed = isOperatorAllowed(email, env);
  const valid = allowed && (await loginDependencies.verify(email, password, env));
  if (!valid) {
    logger.warn('Tentativa de login recusada', { stage: 'auth', status: 'DENIED', allowlisted: allowed });
    return INVALID();
  }

  perAccount.reset(`${address}|${email}`);
  const token = await createSessionToken(email, sessionSecretFrom(env));
  const secure = shouldUseSecureCookie(request, env);
  logger.info('Operador autenticado', { stage: 'auth', status: 'OK' });
  const response = NextResponse.json({ ok: true }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  response.headers.append('Set-Cookie', buildSessionCookie(token, secure));
  return response;
}
