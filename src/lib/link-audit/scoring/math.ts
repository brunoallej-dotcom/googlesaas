/**
 * Aritmética exata do motor de pontuação: só inteiros seguros e frações. Nenhum ponto flutuante participa de uma
 * decisão (faixa, cobertura, índice, arredondamento, confiança).
 */

export interface Frac {
  readonly n: number;
  readonly d: number;
}

export function frac(n: number, d = 1): Frac {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d <= 0) throw new RangeError('fração inválida');
  return { n, d };
}

export function cmpFrac(a: Frac, b: Frac): number {
  const left = a.n * b.d;
  const right = b.n * a.d;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new RangeError('comparação fora dos inteiros seguros');
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Mediana exata de inteiros: valor central, ou a média dos dois centrais (n par) como fração. */
export function medianOfInts(values: readonly number[]): Frac {
  if (values.length === 0) throw new RangeError('mediana de lista vazia');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return frac(sorted[mid] ?? 0);
  return frac((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0), 2);
}

/** Mediana exata de frações (para dias com média de dois centrais). */
export function medianOfFracs(values: readonly Frac[]): Frac {
  if (values.length === 0) throw new RangeError('mediana de lista vazia');
  const sorted = [...values].sort(cmpFrac);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) throw new RangeError('mediana indefinida');
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  if (lower === undefined) throw new RangeError('mediana indefinida');
  return reduceFrac(frac(lower.n * upper.d + upper.n * lower.d, 2 * lower.d * upper.d));
}

/** round_half_up(numerador / denominador) para numerador >= 0 e denominador > 0, só com inteiros. */
export function roundHalfUpDiv(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 0 || denominator <= 0) {
    throw new RangeError('divisão inválida');
  }
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0 ? 1 : x;
}

export function reduceFrac(value: Frac): Frac {
  const g = gcd(value.n, value.d);
  return frac(value.n / g, value.d / g);
}

/** 8385 -> "83.85" (centésimos inteiros, sem ponto flutuante). */
export function formatHundredths(hundredths: number): string {
  const whole = Math.floor(hundredths / 100);
  const rest = hundredths % 100;
  return `${whole}.${String(rest).padStart(2, '0')}`;
}

/** Meios-pontos inteiros -> texto em pontos ("11.5"). */
export function formatHalfPoints(half: number): string {
  return half % 2 === 0 ? String(half / 2) : `${Math.floor(half / 2)}.5`;
}
