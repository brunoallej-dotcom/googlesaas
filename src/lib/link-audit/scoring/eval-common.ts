import { frac, type Frac } from './math';
import { absence, notVerified, scored } from './results';
import type { Basis } from './results';
import type { AgeTier, AscTier } from './ruler';
import { resolveAgeInterval, resolveAscInterval } from './tiers';
import type { Resolved } from './context';
import type { SubcriterionId, SubcriterionResult } from './types';

/** Resolução sem valor -> Não verificado (conflito, fundamento inválido ou nenhuma observação). */
export function nvFromResolution(id: SubcriterionId, resolved: Exclude<Resolved<unknown>, { status: 'OK' }>): SubcriterionResult {
  if (resolved.status === 'CONFLICT') {
    return notVerified(id, 'CONFLICT_OPEN', 'Fontes nativas contraditórias na mesma data para este campo (conflito aberto).');
  }
  if (resolved.fail) return notVerified(id, resolved.fail.reasonCode, resolved.fail.reason);
  return notVerified(id, 'NO_OBSERVATION', 'Nenhuma observação para este campo.');
}

/** Contagem/valor "quanto maior, melhor" conhecido como [lo, hi] (hi = null é ∞). */
export function scoreAsc(
  id: SubcriterionId,
  table: readonly AscTier[],
  lo: number,
  hi: number | null,
  basis: Basis,
  what: string,
  absenceCode: 'ABSENCE_PROVEN_NATIVE' | 'ABSENCE_PROVEN_SCOPE' | 'ABSENCE_PROVEN_PROTOCOL' = 'ABSENCE_PROVEN_NATIVE',
): SubcriterionResult {
  const tier = resolveAscInterval(table, frac(lo), hi === null ? null : frac(hi));
  if (!tier) {
    const bound = hi === null ? `pelo menos ${lo}` : `entre ${lo} e ${hi}`;
    return notVerified(id, 'INDECISIVE_RANGE', `${what}: leitura incompleta (${bound}); a faixa não se decide só com o que foi lido.`, basis);
  }
  if (lo === 0 && hi === 0 && tier.halfPoints === 0) return absence(id, absenceCode, `${what}: nenhum.`, basis);
  return scored(id, tier.halfPoints, tier.label, `${what}: ${tier.label}`, basis);
}

/** Idade/valor "quanto menor, melhor" conhecido como [lo, hi] (hi = null é ∞). */
export function scoreAge(id: SubcriterionId, table: readonly AgeTier[], lo: number, hi: number | null, basis: Basis, what: string): SubcriterionResult {
  const tier = resolveAgeInterval(table, frac(lo), hi === null ? null : frac(hi));
  if (!tier) {
    return notVerified(id, 'INDECISIVE_RANGE', `${what}: limites de idade (${lo} a ${hi === null ? '∞' : hi} dias) caem em faixas diferentes.`, basis);
  }
  return scored(id, tier.halfPoints, tier.label, `${what}: ${tier.label}`, basis);
}

/** Intervalo de uma contagem: exata quando a leitura é completa; senão, limite inferior (teto opcional). */
export function countBounds(count: number, complete: boolean, cap: number | null = null): { lo: number; hi: number | null } {
  return { lo: count, hi: complete ? count : cap };
}

/** Idade/valor "quanto menor, melhor" com limites fracionários (ex.: mediana de dias). */
export function scoreAgeFrac(id: SubcriterionId, table: readonly AgeTier[], value: Frac, basis: Basis, what: string): SubcriterionResult {
  const tier = resolveAgeInterval(table, value, value);
  if (!tier) return notVerified(id, 'INDECISIVE_RANGE', `${what}: valor indecisivo.`, basis);
  return scored(id, tier.halfPoints, tier.label, `${what}: ${tier.label}`, basis);
}
