/**
 * Sessão de operador: cookie assinado (HMAC-SHA-256) com Web Crypto, que funciona no middleware
 * (Edge) e no Node. Não há segredo novo: a chave é derivada da `SUPABASE_SERVICE_ROLE_KEY`, que só
 * existe no servidor. Girar essa chave encerra todas as sessões (aceitável numa ferramenta interna).
 */
export const SESSION_COOKIE = 'gmn_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_VERSION = 1;
const KEY_CONTEXT = 'gmn-session-v1:';

export interface SessionPayload {
  /** E-mail do operador (minúsculas). */
  readonly e: string;
  readonly iat: number;
  readonly exp: number;
  readonly v: number;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`${KEY_CONTEXT}${secret}`));
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSessionToken(
  email: string,
  secret: string,
  now: number = Date.now(),
  ttlMs: number = SESSION_TTL_MS
): Promise<string> {
  if (!secret) throw new Error('Segredo de sessão ausente.');
  const payload: SessionPayload = { e: email.trim().toLowerCase(), iat: now, exp: now + ttlMs, v: SESSION_VERSION };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await deriveKey(secret), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Devolve a sessão se a assinatura, a versão e a validade estiverem corretas; senão `null`. */
export async function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  now: number = Date.now()
): Promise<SessionPayload | null> {
  if (!token || !secret || token.length > 2048) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const signatureBytes = fromBase64Url(signature);
  const bodyBytes = fromBase64Url(body);
  if (!signatureBytes || !bodyBytes) return null;

  // `verify` compara em tempo constante.
  const valid = await crypto.subtle.verify('HMAC', await deriveKey(secret), signatureBytes as Uint8Array<ArrayBuffer>, encoder.encode(body));
  if (!valid) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(bodyBytes)) as Partial<SessionPayload>;
    if (
      payload.v !== SESSION_VERSION ||
      typeof payload.e !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      payload.exp <= now ||
      payload.iat > now + 60_000
    ) {
      return null;
    }
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined; // valor com "%" malformado: tratado como "sem cookie" (401), nunca como erro 500
      }
    }
  }
  return undefined;
}

export function buildSessionCookie(token: string, secure: boolean, maxAgeSeconds = SESSION_TTL_MS / 1000): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function buildClearedSessionCookie(secure: boolean): string {
  return buildSessionCookie('', secure, 0);
}
