import { assertSafeUrlShape, UnsafeUrlError } from '../url-safety';
import { redactFreeText, sanitizeUrl } from './url-redaction';

/**
 * Parser OFFLINE de links do Google Maps / Perfil da Empresa (Fase 6, Onda 1).
 *
 * - Não faz nenhuma requisição, não resolve DNS e não segue redirecionamentos: links curtos viram
 *   `RESOLUTION_PENDING`.
 * - A identidade vem SOMENTE de identificadores (cid, placeId, featureId). Nome e coordenadas nunca
 *   identificam uma empresa: sem identificador o resultado é `AMBIGUOUS`.
 * - Só https e hosts de uma lista exata. Entradas perigosas são `REJECTED`; o texto do link é dado,
 *   nunca instrução.
 */

const MAX_INPUT_LENGTH = 2048;
const MAX_HINT_LENGTH = 120;

const FULL_HOSTS: ReadonlySet<string> = new Set([
  'google.com',
  'www.google.com',
  'maps.google.com',
  'google.com.br',
  'www.google.com.br',
  'maps.google.com.br',
]);
/** Hosts onde o caminho raiz `/` também é aceito (formato antigo `maps.google.com/?cid=…`). */
const MAPS_SUBDOMAINS: ReadonlySet<string> = new Set(['maps.google.com', 'maps.google.com.br']);
const SHORT_HOSTS: ReadonlySet<string> = new Set(['maps.app.goo.gl', 'goo.gl', 'g.page']);

/** Caminhos de /maps/ que não representam o perfil de uma empresa. */
const UNSUPPORTED_MAPS_SEGMENTS: ReadonlySet<string> = new Set([
  'dir',
  'embed',
  'd',
  'contrib',
  'api',
  'timeline',
  'vt',
  'preview',
]);

const CID_PATTERN = /^\d{1,20}$/;
const MAX_UINT64 = 18446744073709551615n;
const FEATURE_ID_PATTERN = /^0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16}$/i;
const PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{20,255}$/;
const DATA_SEGMENT_PATTERN = /!1s(0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16})(?![0-9a-f])/gi;
const COORDINATES_PATTERN = /@-?\d{1,3}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?/;

export interface MapsIdentifiers {
  readonly cid?: string;
  readonly placeId?: string;
  /** `fid`/featureId no formato `0x…:0x…`, em minúsculas. */
  readonly featureId?: string;
}

export type MapsSourceForm =
  | 'DATA_SEGMENT'
  | 'FTID_PARAM'
  | 'CID_PARAM'
  | 'PLACE_ID_PARAM'
  | 'QUERY_PLACE_ID_PARAM'
  | 'Q_PLACE_ID';

interface ParseBase {
  /** Entrada recebida em forma SANEADA: sem espaços nas pontas, credenciais, fragmento nem parâmetros fora dos identificadores; no máximo 2048 caracteres. */
  readonly originalInput: string;
}

export interface MapsLinkIdentified extends ParseBase {
  readonly status: 'IDENTIFIED';
  readonly code: 'IDENTIFIED';
  readonly canonicalHost: string;
  readonly identifiers: MapsIdentifiers;
  readonly sourceForms: readonly MapsSourceForm[];
  /**
   * Nome que aparece no link. NÃO confiável: serve só para o operador conferir, nunca como identidade.
   * Remove apenas `<`, `>` e controles; quem exibir deve escapar o texto (aspas e `&` permanecem).
   */
  readonly untrustedLabelHint?: string;
}

export interface MapsLinkResolutionPending extends ParseBase {
  readonly status: 'RESOLUTION_PENDING';
  readonly code: 'SHORT_LINK_REQUIRES_RESOLUTION';
  readonly shortHost: string;
}

export interface MapsLinkAmbiguous extends ParseBase {
  readonly status: 'AMBIGUOUS';
  readonly code: 'NAME_OR_SEARCH_ONLY' | 'COORDINATES_ONLY' | 'GENERIC_MAPS_LINK' | 'CONFLICTING_IDENTIFIERS';
  readonly canonicalHost: string;
  readonly untrustedLabelHint?: string;
}

export interface MapsLinkUnsupported extends ParseBase {
  readonly status: 'UNSUPPORTED';
  readonly code: 'UNSUPPORTED_HOST' | 'UNSUPPORTED_PATH' | 'UNSUPPORTED_SHORT_LINK_PATH';
}

export interface MapsLinkInvalid extends ParseBase {
  readonly status: 'INVALID';
  readonly code:
    | 'NOT_A_STRING'
    | 'EMPTY'
    | 'TOO_LONG'
    | 'WHITESPACE_OR_CONTROL'
    | 'MALFORMED_PERCENT_ENCODING'
    | 'MISSING_SCHEME'
    | 'NON_CANONICAL_URL'
    | 'UNPARSEABLE'
    | 'INVALID_IDENTIFIER_FORMAT';
}

export interface MapsLinkRejected extends ParseBase {
  readonly status: 'REJECTED';
  readonly code: 'BACKSLASH' | 'INSECURE_SCHEME' | 'UNSAFE_SCHEME' | 'UNSAFE_URL' | 'IP_LITERAL_HOST' | 'IDN_LOOKALIKE_HOST';
  readonly reason: string;
}

export type MapsLinkParseResult =
  | MapsLinkIdentified
  | MapsLinkResolutionPending
  | MapsLinkAmbiguous
  | MapsLinkUnsupported
  | MapsLinkInvalid
  | MapsLinkRejected;

/** `true` se o host (normalizado) é um dos hosts do Google Maps aceitos pelo parser. */
export function isGoogleMapsHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return FULL_HOSTS.has(host) || SHORT_HOSTS.has(host);
}

function preview(raw: unknown): string {
  // Forma saneada: sem credenciais, fragmento nem parâmetros fora da lista de identificadores.
  return typeof raw === 'string' ? sanitizeUrl(raw).slice(0, MAX_INPUT_LENGTH) : '';
}

function sanitizeHint(raw: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return undefined;
  }
  const cleaned = decoded
    .replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_HINT_LENGTH);
  const safe = redactFreeText(cleaned).trim();
  return safe.length > 0 ? safe : undefined;
}

function isValidCid(value: string): boolean {
  if (!CID_PATTERN.test(value)) return false;
  try {
    const numeric = BigInt(value);
    return numeric > 0n && numeric <= MAX_UINT64;
  } catch {
    return false;
  }
}

function isValidFeatureId(value: string): boolean {
  return FEATURE_ID_PATTERN.test(value) && !/^0x0+:0x0+$/i.test(value);
}

function isIpLiteral(hostname: string): boolean {
  return hostname.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

interface Collected {
  readonly cid: Set<string>;
  readonly placeId: Set<string>;
  readonly featureId: Set<string>;
  readonly forms: Set<MapsSourceForm>;
  invalidFormat: boolean;
}

function collectQueryIdentifiers(params: URLSearchParams, into: Collected): void {
  for (const value of params.getAll('cid')) {
    if (isValidCid(value)) {
      into.cid.add(value);
      into.forms.add('CID_PARAM');
    } else {
      into.invalidFormat = true;
    }
  }
  for (const value of params.getAll('ftid')) {
    if (isValidFeatureId(value)) {
      into.featureId.add(value.toLowerCase());
      into.forms.add('FTID_PARAM');
    } else {
      into.invalidFormat = true;
    }
  }
  const placeIdParams: ReadonlyArray<readonly [string, MapsSourceForm]> = [
    ['place_id', 'PLACE_ID_PARAM'],
    ['query_place_id', 'QUERY_PLACE_ID_PARAM'],
  ];
  for (const [name, form] of placeIdParams) {
    for (const value of params.getAll(name)) {
      if (PLACE_ID_PATTERN.test(value)) {
        into.placeId.add(value);
        into.forms.add(form);
      } else {
        into.invalidFormat = true;
      }
    }
  }
  for (const value of params.getAll('q')) {
    if (!value.toLowerCase().startsWith('place_id:')) continue;
    const id = value.slice('place_id:'.length);
    if (PLACE_ID_PATTERN.test(id)) {
      into.placeId.add(id);
      into.forms.add('Q_PLACE_ID');
    } else {
      into.invalidFormat = true;
    }
  }
}

function parseShortLink(hostname: string, pathname: string, originalInput: string): MapsLinkParseResult {
  const allowedPath =
    hostname === 'maps.app.goo.gl'
      ? /^\/[A-Za-z0-9_-]{4,64}\/?$/
      : hostname === 'goo.gl'
        ? /^\/maps\/[A-Za-z0-9_-]{4,64}\/?$/
        : /^\/(?:r\/)?[A-Za-z0-9_.-]{2,100}\/?$/; // g.page
  if (!allowedPath.test(pathname)) {
    return { status: 'UNSUPPORTED', code: 'UNSUPPORTED_SHORT_LINK_PATH', originalInput };
  }
  // Nada é acessado: o destino só pode ser conhecido seguindo o redirecionamento (outra etapa).
  return { status: 'RESOLUTION_PENDING', code: 'SHORT_LINK_REQUIRES_RESOLUTION', originalInput, shortHost: hostname };
}

export function parseGoogleMapsLink(input: unknown): MapsLinkParseResult {
  if (typeof input !== 'string') return { status: 'INVALID', code: 'NOT_A_STRING', originalInput: '' };

  const trimmed = input.trim();
  const originalInput = preview(trimmed);
  const invalid = (code: MapsLinkInvalid['code']): MapsLinkInvalid => ({ status: 'INVALID', code, originalInput });
  const rejected = (code: MapsLinkRejected['code'], reason: string): MapsLinkRejected => ({
    status: 'REJECTED',
    code,
    reason,
    originalInput,
  });

  if (trimmed.length === 0) return invalid('EMPTY');
  if (trimmed.length > MAX_INPUT_LENGTH) return invalid('TOO_LONG');
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return invalid('WHITESPACE_OR_CONTROL');
  // O parser WHATWG trata "\" como "/" em URLs https: a mesma string significaria dois destinos.
  if (trimmed.includes('\\')) return rejected('BACKSLASH', 'Barra invertida não é permitida em links.');
  if (/%(?![0-9a-f]{2})/i.test(trimmed)) return invalid('MALFORMED_PERCENT_ENCODING');

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!schemeMatch) return invalid('MISSING_SCHEME');
  const scheme = (schemeMatch[1] ?? '').toLowerCase();
  if (scheme === 'http') return rejected('INSECURE_SCHEME', 'Somente https é aceito.');
  if (scheme !== 'https') return rejected('UNSAFE_SCHEME', `Esquema "${scheme}" não é permitido.`);
  // Formas como "https:host" ou "https:///host" são aceitas pelo parser WHATWG, mas não são links canônicos.
  if (!/^https:\/\//i.test(trimmed)) return invalid('NON_CANONICAL_URL');
  // Caracteres invisíveis, de largura total ou não ASCII no host são normalizados em silêncio pelo parser.
  const authority = trimmed.slice('https://'.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority === '') return invalid('NON_CANONICAL_URL');
  if (/[^\x21-\x7e]/.test(authority)) {
    return rejected('IDN_LOOKALIKE_HOST', 'Host com caracteres não ASCII não é aceito.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return invalid('UNPARSEABLE');
  }

  let hostname: string;
  try {
    hostname = assertSafeUrlShape(trimmed).hostname;
  } catch (error) {
    if (error instanceof UnsafeUrlError) return rejected('UNSAFE_URL', error.message);
    throw error;
  }

  if (isIpLiteral(hostname)) return rejected('IP_LITERAL_HOST', 'Endereço IP não é aceito; use o link do Google Maps.');

  const isShort = SHORT_HOSTS.has(hostname);
  if (!FULL_HOSTS.has(hostname) && !isShort) {
    if (hostname.startsWith('xn--') || hostname.includes('.xn--')) {
      return rejected('IDN_LOOKALIKE_HOST', 'Domínio internacionalizado fora da lista permitida.');
    }
    return { status: 'UNSUPPORTED', code: 'UNSUPPORTED_HOST', originalInput };
  }

  if (isShort) return parseShortLink(hostname, parsed.pathname, originalInput);

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  const first = (segments[0] ?? '').toLowerCase();
  const second = (segments[1] ?? '').toLowerCase();
  const rootAllowed = MAPS_SUBDOMAINS.has(hostname) && segments.length === 0;
  if (first !== 'maps' && !rootAllowed) return { status: 'UNSUPPORTED', code: 'UNSUPPORTED_PATH', originalInput };
  if (first === 'maps' && UNSUPPORTED_MAPS_SEGMENTS.has(second)) {
    return { status: 'UNSUPPORTED', code: 'UNSUPPORTED_PATH', originalInput };
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    return invalid('MALFORMED_PERCENT_ENCODING');
  }

  const collected: Collected = {
    cid: new Set(),
    placeId: new Set(),
    featureId: new Set(),
    forms: new Set(),
    invalidFormat: false,
  };
  collectQueryIdentifiers(parsed.searchParams, collected);
  // O id do `data=` só vale em um segmento próprio do caminho, depois do trecho do nome do lugar
  // (campo controlado por quem montou o link).
  const firstDataIndex = second === 'place' || second === 'search' ? 3 : 2;
  segments.forEach((segment, index) => {
    if (index < firstDataIndex || !segment.toLowerCase().startsWith('data=')) return;
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      collected.invalidFormat = true;
      return;
    }
    for (const match of decodedSegment.matchAll(DATA_SEGMENT_PATTERN)) {
      const featureId = (match[1] ?? '').toLowerCase();
      if (isValidFeatureId(featureId)) {
        collected.featureId.add(featureId);
        collected.forms.add('DATA_SEGMENT');
      } else {
        collected.invalidFormat = true;
      }
    }
  });

  if (collected.invalidFormat) return invalid('INVALID_IDENTIFIER_FORMAT');

  const placeSegment = first === 'maps' && second === 'place' ? segments[2] : undefined;
  const labelHint = placeSegment && !placeSegment.startsWith('@') ? sanitizeHint(placeSegment) : undefined;
  const withHint = labelHint ? { untrustedLabelHint: labelHint } : {};

  if (collected.cid.size > 1 || collected.placeId.size > 1 || collected.featureId.size > 1) {
    return { status: 'AMBIGUOUS', code: 'CONFLICTING_IDENTIFIERS', originalInput, canonicalHost: hostname, ...withHint };
  }

  const [cid] = collected.cid;
  const [placeId] = collected.placeId;
  const [featureId] = collected.featureId;
  const identifiers: MapsIdentifiers = {
    ...(cid ? { cid } : {}),
    ...(placeId ? { placeId } : {}),
    ...(featureId ? { featureId } : {}),
  };

  if (Object.keys(identifiers).length > 0) {
    return {
      status: 'IDENTIFIED',
      code: 'IDENTIFIED',
      originalInput,
      canonicalHost: hostname,
      identifiers,
      sourceForms: [...collected.forms],
      ...withHint,
    };
  }

  const thirdSegment = segments[2];
  const hasNameOrSearch =
    (first === 'maps' &&
      (second === 'place' || second === 'search') &&
      thirdSegment !== undefined &&
      !thirdSegment.startsWith('@')) ||
    ['q', 'query', 'daddr', 'saddr'].some((key) => parsed.searchParams.has(key));
  const code: MapsLinkAmbiguous['code'] = hasNameOrSearch
    ? 'NAME_OR_SEARCH_ONLY'
    : COORDINATES_PATTERN.test(decodedPath)
      ? 'COORDINATES_ONLY'
      : 'GENERIC_MAPS_LINK';
  return { status: 'AMBIGUOUS', code, originalInput, canonicalHost: hostname, ...withHint };
}
