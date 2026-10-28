import { readCookie, SESSION_COOKIE, verifySessionToken } from './session';

/**
 * Decisão de acesso, sem dependências de Node (roda no middleware Edge e nas rotas).
 * Falha FECHADA: sem segredo configurado ninguém entra, exceto no bypass de desenvolvimento
 * (`GMN_AUTH_DISABLED=true`, só com `NODE_ENV=development` e somente para o próprio computador).
 */
export type AuthEnv = Readonly<Record<string, string | undefined>>;

export type AccessDecision =
  | { readonly ok: true; readonly operator: string; readonly via: 'SESSION' | 'DEV_BYPASS' }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 503;
      readonly code: 'NO_SESSION' | 'INVALID_SESSION' | 'NOT_ALLOWED' | 'AUTH_NOT_CONFIGURED' | 'CROSS_ORIGIN';
      readonly message: string;
    };

/** Segredo de assinatura: derivado de uma chave que já existe só no servidor. */
export function sessionSecretFrom(env: AuthEnv): string {
  return env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
}

export function parseOperatorAllowlist(env: AuthEnv): readonly string[] {
  return (env.GMN_OPERATOR_EMAILS ?? '')
    .split(/[,;\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry));
}

export function isOperatorAllowed(email: string, env: AuthEnv): boolean {
  return parseOperatorAllowlist(env).includes(email.trim().toLowerCase());
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? '';
  return LOOPBACK_HOSTS.has(name);
}

/**
 * `process.env.NODE_ENV` LITERAL: o Next substitui o valor em tempo de build, então um build de produção nunca
 * tem o bypass (nem se o servidor receber `NODE_ENV=development` e `GMN_AUTH_DISABLED=true` por engano).
 */
const BUILT_FOR_PRODUCTION = process.env.NODE_ENV === 'production';

export function devBypassActive(env: AuthEnv, hostHeader: string | null | undefined): boolean {
  if (BUILT_FOR_PRODUCTION) return false;
  return env.GMN_AUTH_DISABLED === 'true' && env.NODE_ENV === 'development' && isLoopbackHost(hostHeader);
}

/** Cookie `Secure` sempre em produção; fora dela, quando a requisição chega por https. */
export function shouldUseSecureCookie(request: Request, env: AuthEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || BUILT_FOR_PRODUCTION || new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
}

export interface ClientAddress {
  /** IP usado pelos limitadores; `local` quando não há proxy ou o valor é inválido. */
  readonly address: string;
  readonly source: 'x-forwarded-for:last-hop' | 'none';
  /** Quantidade de itens em X-Forwarded-For (diagnóstico). */
  readonly hops: number;
  /** IP privado/loopback/`local`: vários clientes podem estar atrás dele (ex.: NAT do ingress do Swarm). */
  readonly shared: boolean;
}

const ADDRESS_PATTERN = /^[0-9a-f:.]{2,45}$/i;

/** Faixas que NÃO identificam um cliente individual na internet. */
export function isSharedAddress(address: string): boolean {
  const lower = address.trim().toLowerCase();
  if (lower === 'local' || lower === '::1' || lower === '::') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped?.[1] ?? lower);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

/**
 * IP do cliente atrás do Traefik: SOMENTE o ÚLTIMO salto de `X-Forwarded-For`, isto é, o que o proxy acrescentou (o IP
 * do par que se conectou a ele). Itens anteriores e `X-Real-IP` podem ser enviados pelo cliente e NUNCA são usados:
 * o limite de login não pode ser contornado girando cabeçalhos.
 */
export function resolveClientAddress(headers: Headers): ClientAddress {
  const hops = (headers.get('x-forwarded-for') ?? '').split(',').map((hop) => hop.trim()).filter(Boolean);
  const last = hops[hops.length - 1];
  if (last && ADDRESS_PATTERN.test(last)) {
    return { address: last.toLowerCase(), source: 'x-forwarded-for:last-hop', hops: hops.length, shared: isSharedAddress(last) };
  }
  return { address: 'local', source: 'none', hops: hops.length, shared: true };
}

export function clientAddressFrom(headers: Headers): string {
  return resolveClientAddress(headers).address;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Bloqueia requisições de outro site (defesa adicional ao SameSite=Strict). */
export function crossOriginViolation(request: Request): boolean {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return false;
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      const host = request.headers.get('host') ?? new URL(request.url).host;
      return new URL(origin).host !== host;
    } catch {
      return true;
    }
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  return fetchSite === 'cross-site';
}

export async function authorizeRequest(
  request: Request,
  env: AuthEnv = process.env,
  now: number = Date.now()
): Promise<AccessDecision> {
  const host = request.headers.get('host');
  if (devBypassActive(env, host)) return { ok: true, operator: 'dev@localhost', via: 'DEV_BYPASS' };

  if (crossOriginViolation(request)) {
    return { ok: false, status: 403, code: 'CROSS_ORIGIN', message: 'Origem da requisição não permitida.' };
  }

  const secret = sessionSecretFrom(env);
  if (!secret || parseOperatorAllowlist(env).length === 0) {
    return {
      ok: false,
      status: 503,
      code: 'AUTH_NOT_CONFIGURED',
      message: 'Acesso fechado: a autenticação não está configurada (veja docs/phase5/security-review.md).',
    };
  }

  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) return { ok: false, status: 401, code: 'NO_SESSION', message: 'Autenticação necessária.' };

  const session = await verifySessionToken(token, secret, now);
  if (!session) return { ok: false, status: 401, code: 'INVALID_SESSION', message: 'Sessão inválida ou expirada.' };

  // A lista é reavaliada a cada requisição: remover um e-mail revoga o acesso imediatamente.
  if (!isOperatorAllowed(session.e, env)) {
    return { ok: false, status: 403, code: 'NOT_ALLOWED', message: 'Operador não autorizado.' };
  }
  return { ok: true, operator: session.e, via: 'SESSION' };
}
