import { sha256Hex } from '../link-audit/canonical';

/*
 * Derivação da URL mínima do website do perfil (Onda 6C, D6C-3, regra `lumos-url-derive-v1`). PURO: sem rede, disco,
 * ambiente nem relógio. O website bruto vem do corpo íntegro do provedor e pode trazer segredos na query, nas credenciais
 * e até no CAMINHO (tokens, `;jsessionid=`, chaves). O bruto NUNCA sai daqui: sai a URL derivada, que mantém
 *   scheme://host[:porta]/
 * e, da query, SOMENTE os parâmetros `utm_*` conhecidos com valor não vazio, com o valor trocado por `x`. Credenciais,
 * CAMINHO, fragmento e todos os outros parâmetros são descartados (endurecimento da spec §9.6: o caminho não é usado por
 * X1 nem por X5 e pode carregar segredo). O SHA-256 do bruto (após `trim`) permite conferir depois
 * contra a captura, sem guardar a URL.
 *
 * A leitura de UTM espelha a do motor (só a query; nomes sem diferenciar caixa; valor vazio ou só de espaços não conta).
 * `level` conta QUALQUER `utm_*` com valor (como o motor), mas `names` e a URL derivada só trazem os seis nomes conhecidos.
 * Para esses seis, o X5 da derivada é igual ao do bruto (provado com o motor nos testes). `NOT_OBSERVED` NÃO é ausência
 * comprovada: o Serper pode normalizar a URL (§9.6).
 */
export const URL_DERIVATION_RULE = 'lumos-url-derive-v1' as const;
export const MAX_WEBSITE_LENGTH = 2048;

const KNOWN_UTM = ['utm_campaign', 'utm_content', 'utm_id', 'utm_medium', 'utm_source', 'utm_term'] as const;

export type UtmLevel = 'COMPLETE' | 'PARTIAL' | 'NOT_OBSERVED';
export type UnparsableReason = 'EMPTY' | 'TOO_LONG' | 'MALFORMED' | 'NOT_HTTP' | 'NO_HOST';

export type WebsiteDerivation =
  | {
      readonly state: 'DERIVED';
      readonly rule: typeof URL_DERIVATION_RULE;
      readonly rawSha256: string;
      readonly derived: string;
      /** Nomes (minúsculos, ordenados) dos `utm_*` conhecidos presentes COM valor; os valores nunca são guardados. */
      readonly utm: { readonly level: UtmLevel; readonly names: readonly string[] };
    }
  | {
      readonly state: 'UNPARSABLE';
      readonly rule: typeof URL_DERIVATION_RULE;
      readonly rawSha256: string;
      readonly reason: UnparsableReason;
      readonly derived: null;
      readonly utm: null;
    };

function unparsable(rawSha256: string, reason: UnparsableReason): WebsiteDerivation {
  return { state: 'UNPARSABLE', rule: URL_DERIVATION_RULE, rawSha256, reason, derived: null, utm: null };
}

export function deriveWebsite(raw: string): WebsiteDerivation {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const rawSha256 = sha256Hex(text);
  if (text === '') return unparsable(rawSha256, 'EMPTY');
  if (text.length > MAX_WEBSITE_LENGTH) return unparsable(rawSha256, 'TOO_LONG');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return unparsable(rawSha256, 'MALFORMED');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return unparsable(rawSha256, 'NOT_HTTP');
  if (url.hostname === '') return unparsable(rawSha256, 'NO_HOST');

  const present = new Set<string>();
  for (const [key, value] of url.searchParams) {
    const name = key.toLowerCase();
    if (name.startsWith('utm_') && value.trim() !== '') present.add(name);
  }
  const names = KNOWN_UTM.filter((name) => present.has(name));
  const level: UtmLevel = present.has('utm_source') && present.has('utm_medium') ? 'COMPLETE' : present.size > 0 ? 'PARTIAL' : 'NOT_OBSERVED';
  const query = names.length > 0 ? `?${names.map((name) => `${name}=x`).join('&')}` : '';
  return { state: 'DERIVED', rule: URL_DERIVATION_RULE, rawSha256, derived: `${url.protocol}//${url.host}/${query}`, utm: { level, names } };
}
