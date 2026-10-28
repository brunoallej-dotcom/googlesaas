/**
 * Redação de segredos para logs e mensagens. Nunca registrar chaves, tokens, senhas nem URLs com
 * credenciais. Duas camadas: valores LITERAIS das variáveis sensíveis do ambiente e padrões gerais.
 */
const SENSITIVE_ENV_NAMES = [
  'SERPER_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'LLM_API_KEY',
  'DATAFORSEO_PASSWORD',
  'DATAFORSEO_LOGIN',
  'REDIS_URL',
] as const;

export const REDACTED = '[REDACTED]';

const PATTERNS: readonly [RegExp, string][] = [
  // Credenciais embutidas em URLs: redis://user:senha@host, https://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Cabeçalhos e parâmetros comuns
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\b(api[-_]?key|apikey|x-api-key|token|access[-_]?token|refresh[-_]?token|password|passwd|senha|secret)(["']?\s*[:=]\s*["']?)[^\s"',;&]{3,}/gi, `$1$2${REDACTED}`],
  // JWTs (três segmentos base64url) e chaves no estilo sk-...
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
];

function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  const values: string[] = [];
  for (const name of SENSITIVE_ENV_NAMES) {
    const value = env[name]?.trim();
    if (value && value.length >= 8 && !/^(your-|cole-)/i.test(value)) values.push(value);
    // Senha dentro de REDIS_URL
    if (name === 'REDIS_URL' && value) {
      try {
        const password = new URL(value).password;
        if (password.length >= 4) values.push(decodeURIComponent(password));
      } catch {
        /* URL inválida: nada a extrair */
      }
    }
  }
  return values;
}

export function redactSecrets(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  let out = text;
  for (const value of secretValues(env)) out = out.split(value).join(REDACTED);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

const SENSITIVE_KEY = /^(pass(word|wd)?|senha|secret|.*token|api[-_]?key|apikey|authorization|cookie|set-cookie|credentials?)$/i;

/** Redige recursivamente um objeto de metadados (limite de profundidade e de tamanho). */
export function redactValue(
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
  depth = 0
): unknown {
  if (typeof value === 'string') return redactSecrets(value.length > 2000 ? `${value.slice(0, 2000)}…` : value, env);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[profundidade excedida]';
  if (value instanceof Error) return redactSecrets(value.message, env);
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactValue(entry, env, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, env, depth + 1);
  }
  return out;
}
