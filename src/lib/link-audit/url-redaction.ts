import { REDACTED, redactSecrets } from '../redact';

/**
 * Saneamento de URLs e de mensagens de erro da Auditoria por Link (Fase 6, Onda 4A).
 *
 * Regra: de uma URL só sobra o que é necessário para identificar o perfil. Credenciais, fragmento e
 * qualquer parâmetro de consulta fora da lista abaixo (tokens, chaves, utm etc.) NUNCA saem daqui: nem
 * para a tela, nem para a identidade, nem para evidências, snapshots, logs ou mensagens de erro.
 * Os identificadores da empresa (cid, ftid, place_id…) são preservados exatamente.
 */

const MAX_TEXT = 2048;

const CID_VALUE = /^\d{1,20}$/;
const FEATURE_ID_VALUE = /^0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16}$/i;
const PLACE_ID_VALUE = /^[A-Za-z0-9_-]{20,255}$/;

/**
 * Parâmetros que carregam identificadores do perfil (o parser da Onda 1 lê exatamente estes). Só sobrevive
 * o parâmetro cujo VALOR tem a forma do identificador: um token colado dentro de `cid=` não passa.
 */
function keepParameter(name: string, value: string): boolean {
  if (name === 'cid') return CID_VALUE.test(value);
  if (name === 'ftid') return FEATURE_ID_VALUE.test(value);
  if (name === 'place_id' || name === 'query_place_id') return PLACE_ID_VALUE.test(value);
  if (name === 'q') return value.toLowerCase().startsWith('place_id:') && PLACE_ID_VALUE.test(value.slice('place_id:'.length));
  return false;
}

/** Mascara credenciais em qualquer forma aceita pelo parser WHATWG (`https://u:p@`, `https:u:p@`, `https:///u:p@`). */
function maskUserinfo(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/*)[^/\s?#]*@/i, '$1***@');
}

/** Texto que parece um link (uma só "palavra", com `/` ou `.`): consulta e fragmento são cortados. */
function looksLikeLink(value: string): boolean {
  return !/\s/.test(value) && /[/.]/.test(value);
}

/** Texto solto: consulta de link sem esquema cortada e pares nome=valor fora dos identificadores redigidos. */
function scrubFreeText(text: string): string {
  const withoutQueries = text
    .replace(/\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s?#]*)?)(?:\?|%3[Ff])[^\s]*/gi, '$1')
    .replace(/%3[Ff][^\s]*/g, '');
  return withoutQueries.replace(/([A-Za-z0-9_.-]{1,40})=([^\s&#]+)/g, (pair, name: string, value: string) =>
    keepParameter(name, value) ? pair : `${name}=${REDACTED}`,
  );
}

/** Redige segredos em texto vindo de fontes externas (nomes, endereços, motivos de falha). */
export function redactFreeText(text: string): string {
  return redactSecrets(scrubFreeText(text));
}

/**
 * Forma segura de exibir/guardar um link. Se for uma URL válida: protocolo, host, caminho e somente os
 * parâmetros de identificador. Se não for (texto livre ou URL quebrada): credenciais mascaradas, consulta
 * e fragmento removidos (quando parece link) e padrões de segredo redigidos. Idempotente.
 */
export function sanitizeUrl(raw: string): string {
  const trimmed = raw.trim();
  let rebuilt: string | null = null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const kept = new URLSearchParams();
      for (const [name, value] of url.searchParams) {
        if (keepParameter(name, value)) kept.append(name, value);
      }
      const query = kept.toString();
      // Sem credenciais: `host` não inclui usuário/senha; fragmento nunca é copiado.
      rebuilt = `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ''}`;
    }
  } catch {
    rebuilt = null;
  }
  if (rebuilt !== null) return redactSecrets(rebuilt).slice(0, MAX_TEXT);

  let text = maskUserinfo(trimmed);
  // Esquemas que não são http(s) (javascript:, data:, file:…): o conteúdo pode carregar qualquer coisa e não é exibido.
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\/\/)/i.exec(text)?.[1];
  if (scheme && !/^https?$/i.test(scheme) && !/\s/.test(text)) return `${scheme.toLowerCase()}:[conteúdo omitido]`;
  if (looksLikeLink(text)) text = text.replace(/[?#].*$/s, '');
  return redactFreeText(text).slice(0, MAX_TEXT);
}

/**
 * `true` se a URL já está na forma segura para ser guardada como fonte: sem credenciais, sem fragmento e
 * sem parâmetros de consulta fora da lista de identificadores. Não reescreve nada.
 */
export function isSanitizedUrl(raw: string): boolean {
  if (raw.includes('#') || redactSecrets(raw) !== raw) return false;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    for (const [name, value] of url.searchParams) {
      if (!keepParameter(name, value)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>`]+/gi;

/** Aplica `sanitizeUrl` a cada URL dentro de um texto e redige chaves/tokens soltos. */
export function redactUrlsInText(text: string): string {
  const withUrls = text.replace(URL_IN_TEXT, (match) => {
    const trailing = /[.,;:!?)\]}]+$/.exec(match)?.[0] ?? '';
    const core = trailing ? match.slice(0, -trailing.length) : match;
    return `${sanitizeUrl(core)}${trailing}`;
  });
  return redactFreeText(withUrls);
}

/**
 * Motivo de falha seguro para registrar ou devolver: só classe do erro, código e mensagem já saneada
 * (URLs reduzidas, segredos redigidos) e truncada. Nunca o corpo de resposta nem cabeçalhos.
 */
export function safeFailureReason(error: unknown, maxLength = 300): string {
  let name = 'Erro';
  let message = '';
  if (error instanceof Error) {
    name = error.name || 'Erro';
    const code = (error as NodeJS.ErrnoException).code;
    message = `${typeof code === 'string' ? `${code}: ` : ''}${error.message}`;
  } else {
    message = typeof error === 'string' ? error : 'falha desconhecida';
  }
  return redactUrlsInText(`${name}: ${message}`).slice(0, maxLength);
}

const SENSITIVE_KEY = /(pass(word|wd)?|senha|secret|token|api[-_]?key|apikey|authorization|cookie|credential|session|private[-_]?key|access[-_]?key)/i;
const MAX_OUTPUT_DEPTH = 16;

/**
 * Sanitiza um valor ANTES de serializá-lo: a redação age em cada texto, nunca sobre o JSON pronto (os
 * padrões de segredo consomem aspas e vírgulas e destruiriam a estrutura). Link já saneado passa intacto;
 * texto livre passa por `redactUrlsInText`; chaves sensíveis têm o valor trocado; listas não são truncadas.
 */
export function sanitizeForOutput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (isSanitizedUrl(value)) return value;
    // Valor que é UM link inteiro: forma saneada (mantém só os identificadores). Texto com links dentro: redação de texto.
    return /^https?:\/\/\S+$/i.test(value.trim()) ? sanitizeUrl(value) : redactUrlsInText(value);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth >= MAX_OUTPUT_DEPTH) return '[profundidade excedida]';
  if (Array.isArray(value)) return value.map((entry) => sanitizeForOutput(entry, depth + 1) ?? null);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const clean = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeForOutput(entry, depth + 1);
    // defineProperty: uma chave "__proto__" vira propriedade comum, nunca altera o protótipo
    if (clean !== undefined) Object.defineProperty(out, key, { value: clean, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** JSON sempre válido e sem segredos: sanitiza os valores e só então serializa. */
export function toSafeJson(value: unknown, space = 2): string {
  return JSON.stringify(sanitizeForOutput(value), null, space) ?? 'null';
}

