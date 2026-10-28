import { createHash } from 'node:crypto';

/**
 * Serialização canônica (determinística) e SHA-256 para os snapshots da Auditoria por Link.
 *
 * - Chaves ordenadas recursivamente, sem espaços, strings e chaves em NFC.
 * - Propriedade `undefined` é omitida (como no JSON); arrays preservam a ordem.
 * - Valores sem representação JSON inequívoca são recusados em vez de convertidos em silêncio.
 */

export const CANONICALIZATION_ID = 'gmn-canonical-json-v1' as const;
const MAX_DEPTH = 64;

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

function fail(path: string, reason: string): never {
  throw new CanonicalizationError(`${path || '(raiz)'}: ${reason}`);
}

function serialize(value: unknown, path: string, depth: number, stack: Set<object>): string {
  if (depth > MAX_DEPTH) fail(path, `profundidade acima de ${MAX_DEPTH}`);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) fail(path, 'número não finito (NaN ou Infinity)');
      return JSON.stringify(value);
    case 'undefined':
      return fail(path, 'valor undefined fora de uma propriedade de objeto');
    case 'bigint':
    case 'function':
    case 'symbol':
      return fail(path, `tipo ${typeof value} não tem representação canônica`);
    default:
      break;
  }

  const object = value as object;
  if (stack.has(object)) fail(path, 'referência circular');
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      const parts: string[] = [];
      for (let index = 0; index < object.length; index++) {
        if (!(index in object)) fail(`${path}[${index}]`, 'array esparso');
        parts.push(serialize(object[index], `${path}[${index}]`, depth + 1, stack));
      }
      return `[${parts.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) fail(path, 'somente objetos simples são aceitos');
    if (Object.getOwnPropertySymbols(object).length > 0) fail(path, 'chaves do tipo symbol não são aceitas');

    const entries: Array<readonly [string, unknown]> = [];
    const seen = new Set<string>();
    for (const key of Object.keys(object)) {
      const normalizedKey = key.normalize('NFC');
      if (seen.has(normalizedKey)) fail(`${path}.${key}`, 'chave duplicada após normalização NFC');
      seen.add(normalizedKey);
      const child = (object as Record<string, unknown>)[key];
      if (child !== undefined) entries.push([normalizedKey, child]);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${serialize(child, `${path}.${key}`, depth + 1, stack)}`)
      .join(',')}}`;
  } finally {
    stack.delete(object);
  }
}

/** JSON canônico: o mesmo conteúdo sempre produz exatamente o mesmo texto. */
export function canonicalJson(value: unknown): string {
  return serialize(value, '', 0, new Set());
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
