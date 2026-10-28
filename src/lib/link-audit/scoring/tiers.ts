import { cmpFrac, frac, type Frac } from './math';
import type { AgeTier, AscTier } from './ruler';

/**
 * Faixas por INTERVALO: um valor conhecido só como [lo, hi] (contagem truncada, texto de data relativa, escopo de site
 * limitado) pontua apenas se os dois extremos caem na MESMA faixa. É a regra do limite inferior (D3B-11): numa lista
 * possivelmente truncada, hi = ∞, e só a faixa máxima contém ∞.
 */

function ascIndex(table: readonly AscTier[], value: Frac): number {
  for (let index = 0; index < table.length; index++) {
    const tier = table[index];
    if (!tier) continue;
    const c = cmpFrac(value, tier.min);
    if (tier.exclusive ? c > 0 : c >= 0) return index;
  }
  throw new Error('tabela de faixas sem faixa final');
}

function ageIndex(table: readonly AgeTier[], value: Frac): number {
  for (let index = 0; index < table.length; index++) {
    const tier = table[index];
    if (!tier) continue;
    if (tier.maxAge === null || cmpFrac(value, tier.maxAge) <= 0) return index;
  }
  throw new Error('tabela de faixas por idade sem faixa final');
}

/** `hi = null` representa +∞. Retorna a faixa única ou `null` se o intervalo é indecisivo. */
export function resolveAscInterval(table: readonly AscTier[], lo: Frac, hi: Frac | null): AscTier | null {
  const low = ascIndex(table, lo);
  const high = hi === null ? 0 : ascIndex(table, hi);
  return low === high ? (table[low] ?? null) : null;
}

/** Idade (menor é melhor) em [lo, hi]; `hi = null` é +∞. */
export function resolveAgeInterval(table: readonly AgeTier[], lo: Frac, hi: Frac | null): AgeTier | null {
  const best = ageIndex(table, lo);
  const worst = hi === null ? table.length - 1 : ageIndex(table, hi);
  return best === worst ? (table[best] ?? null) : null;
}

export function resolveAsc(table: readonly AscTier[], value: Frac): AscTier {
  const tier = table[ascIndex(table, value)];
  if (!tier) throw new Error('faixa inexistente');
  return tier;
}

export const int = (value: number): Frac => frac(value);

export function resolveAge(table: readonly AgeTier[], value: Frac): AgeTier {
  const tier = table[ageIndex(table, value)];
  if (!tier) throw new Error('faixa inexistente');
  return tier;
}
