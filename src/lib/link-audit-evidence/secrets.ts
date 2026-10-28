import { redactSecrets } from '../redact';

/*
 * Varredura de segredos antes de gravar evidências (Onda 5A). Duas intensidades:
 *  - estrita (corpo bruto do provedor, que é a evidência original e pode ter textos/URLs legítimos): só chave de
 *    API, cabeçalhos de autenticação e cookies;
 *  - ampla (tudo o que o NOSSO código produz): também os padrões de `redactSecrets` (tokens, JWT, sk-…).
 */
export const AUTH_PATTERNS = /x-api-key|set-cookie|["']?\b(?:authorization|cookie|api[-_]?key|apikey)\b["']?\s*[:=]|bearer\s+[a-z0-9._~+/=-]{8,}/i;

export type SecretScanMode = 'STRICT' | 'BROAD';

/** `true` se o texto parece conter segredo. `apiKey` (se conhecida) é procurada pelo valor literal. */
export function containsSecret(text: string, mode: SecretScanMode, apiKey?: string): boolean {
  if (AUTH_PATTERNS.test(text)) return true;
  if (apiKey && apiKey.trim().length > 10 && text.includes(apiKey.trim())) return true;
  return mode === 'BROAD' && redactSecrets(text, {}) !== text;
}
