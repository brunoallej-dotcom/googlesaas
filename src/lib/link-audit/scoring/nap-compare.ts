import type { HoursValue } from './input';

/**
 * Comparação determinística de NAP entre o perfil e outras fontes (subcritério N5). Só declara DIVERGÊNCIA quando a
 * diferença é inequívoca; qualquer dúvida é AMBÍGUO (o campo deixa de ser comparável e não conta como divergência).
 */

export type FieldComparison = 'MATCH' | 'DIVERGENT' | 'AMBIGUOUS';

const strip = (value: string): string => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function normalizeName(value: string): string {
  return strip(value).replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function nameEquivalenceKey(a: string, b: string): string {
  const [x, y] = [normalizeName(a), normalizeName(b)].sort();
  return `${x ?? ''}|${y ?? ''}`;
}

export function compareName(a: string, b: string, equivalences: ReadonlySet<string>): FieldComparison {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (x === '' || y === '') return 'AMBIGUOUS';
  if (x === y) return 'MATCH';
  return equivalences.has(nameEquivalenceKey(a, b)) ? 'MATCH' : 'DIVERGENT';
}

function phoneDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
}

export function comparePhone(a: string, b: string): FieldComparison {
  const x = phoneDigits(a);
  const y = phoneDigits(b);
  if (x.length < 8 || y.length < 8) return 'AMBIGUOUS';
  if (x === y) return 'MATCH';
  // um número sem DDD é sufixo do outro: não dá para afirmar divergência
  if (x.endsWith(y) || y.endsWith(x)) return 'AMBIGUOUS';
  return 'DIVERGENT';
}

const TYPE_WORDS = new Set(['rua', 'avenida', 'rodovia', 'alameda', 'travessa', 'praca', 'estrada', 'largo', 'via', 'beco', 'viela', 'loteamento', 'jardim', 'vila', 'conjunto', 'residencial']);
const STOP_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
const ABBREVIATIONS: Readonly<Record<string, string>> = { r: 'rua', av: 'avenida', avda: 'avenida', rod: 'rodovia', al: 'alameda', tv: 'travessa', trav: 'travessa', pc: 'praca', pca: 'praca', estr: 'estrada', est: 'estrada' };

function addressParts(raw: string): { ceps: Set<string>; numbers: Set<string>; words: Set<string> } {
  const text = strip(raw);
  const ceps = new Set([...text.matchAll(/\b(\d{5})-?(\d{3})\b/g)].map((match) => `${match[1] ?? ''}${match[2] ?? ''}`));
  const tokens = text
    .replace(/\b\d{5}-?\d{3}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => ABBREVIATIONS[token] ?? token);
  return {
    ceps,
    numbers: new Set(tokens.filter((token) => /^\d{1,6}$/.test(token))),
    words: new Set(tokens.filter((token) => /^[a-z]{3,}$/.test(token) && !TYPE_WORDS.has(token) && !STOP_WORDS.has(token))),
  };
}

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => [...a].some((item) => b.has(item));
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((item) => b.has(item));

export function compareAddress(a: string, b: string): FieldComparison {
  const x = addressParts(a);
  const y = addressParts(b);
  if (x.ceps.size > 0 && y.ceps.size > 0 && !intersects(x.ceps, y.ceps)) return 'DIVERGENT';
  if (x.numbers.size > 0 && y.numbers.size > 0 && !intersects(x.numbers, y.numbers)) return 'DIVERGENT';
  if (x.words.size > 0 && y.words.size > 0 && !intersects(x.words, y.words)) return 'DIVERGENT';
  const cepsCompatible = x.ceps.size === 0 || y.ceps.size === 0 || sameSet(x.ceps, y.ceps);
  if (cepsCompatible && sameSet(x.numbers, y.numbers) && sameSet(x.words, y.words)) return 'MATCH';
  return 'AMBIGUOUS';
}

function hoursKey(value: Extract<HoursValue, { kind: 'STRUCTURED' }>): Map<number, string> {
  const map = new Map<number, string>();
  for (const day of value.days) {
    map.set(day.day, day.closed ? 'C' : day.intervals.map((interval) => `${interval[0]}-${interval[1]}`).sort().join(','));
  }
  return map;
}

export function compareHours(a: HoursValue, b: HoursValue): FieldComparison {
  if (a.kind !== 'STRUCTURED' || b.kind !== 'STRUCTURED') return 'AMBIGUOUS';
  if (a.alwaysOpen === true || b.alwaysOpen === true) return a.alwaysOpen === b.alwaysOpen ? 'MATCH' : 'AMBIGUOUS';
  const x = hoursKey(a);
  const y = hoursKey(b);
  let shared = 0;
  for (const [day, key] of x) {
    const other = y.get(day);
    if (other === undefined) continue;
    shared += 1;
    if (other !== key) return 'DIVERGENT';
  }
  if (shared === 0) return 'AMBIGUOUS';
  return x.size === y.size && shared === x.size ? 'MATCH' : 'AMBIGUOUS';
}
