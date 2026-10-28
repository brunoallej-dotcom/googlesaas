import type { ScoringContext } from './context';
import { parseDay } from './dates';
import { countBounds, nvFromResolution, scoreAge, scoreAgeFrac, scoreAsc } from './eval-common';
import { frac, medianOfInts } from './math';
import { ratingToCents } from './input';
import { absence, notVerified, sampleInsufficient, scored, type Basis } from './results';
import { CATEGORICAL, RULES, TIERS } from './ruler';
import { resolveAsc } from './tiers';
import type { SubcriterionResult } from './types';

/** Data relativa estimada rebaixa o grau da evidência para secundário. */
export function estimatedBasis(basis: Basis, estimated: boolean): Basis {
  if (!estimated) return basis;
  return { ...basis, grade: basis.grade === 'NONE' ? 'NONE' : 'SECONDARY', notes: [...new Set([...basis.notes, 'Data relativa estimada: faixa só vale se os dois limites caem na mesma faixa.'])] };
}

export function evalR1(ctx: ScoringContext): SubcriterionResult {
  const resolved = ctx.resolve('reviews');
  if (resolved.status !== 'OK') return nvFromResolution('R1', resolved);
  const { ratingShown, reviewCount } = resolved.value;
  if (reviewCount < RULES.minReviewsForRating) {
    if (!resolved.complete) {
      return notVerified('R1', 'INDECISIVE_RANGE', `Quantidade de avaliações lida de forma incompleta (pelo menos ${reviewCount}); a elegibilidade da nota não se decide.`, resolved.basis);
    }
    const shown = ratingShown === null ? 'sem nota' : `nota exibida ${ratingShown}`;
    return sampleInsufficient(
      'R1',
      'REVIEWS_BELOW_MIN_SAMPLE',
      `Dado verificado: ${shown} com ${reviewCount} avaliação(ões); a nota só pontua com pelo menos ${RULES.minReviewsForRating} avaliações.`,
      { ...resolved.basis, notes: [`nota exibida: ${ratingShown ?? 'indisponível'}; avaliações: ${reviewCount}`] },
    );
  }
  if (ratingShown === null) return notVerified('R1', 'RATING_NOT_READ', 'A nota exibida não foi lida.', resolved.basis);
  const tier = resolveAsc(TIERS.R1, frac(ratingToCents(ratingShown)));
  return scored('R1', tier.halfPoints, tier.label, `Nota exibida ${ratingShown} com ${reviewCount} avaliações: ${tier.label}`, resolved.basis);
}

export function evalR2(ctx: ScoringContext): SubcriterionResult {
  const resolved = ctx.resolve('reviews');
  if (resolved.status !== 'OK') return nvFromResolution('R2', resolved);
  const bounds = countBounds(resolved.value.reviewCount, resolved.complete);
  return scoreAsc('R2', TIERS.R2, bounds.lo, bounds.hi, resolved.basis, 'Volume de avaliações');
}

export function evalR3(ctx: ScoringContext): SubcriterionResult {
  const resolved = ctx.resolve('latestReviewDate');
  if (resolved.status !== 'OK') return nvFromResolution('R3', resolved);
  if (resolved.value === null) return notVerified('R3', 'DATE_NOT_AVAILABLE', 'A data da avaliação mais recente não foi lida.', resolved.basis);
  const bounds = ctx.ageBounds(resolved.value);
  // leitura incompleta: pode haver avaliação mais nova que a vista
  const lo = resolved.complete ? bounds.lo : 0;
  return scoreAge('R3', TIERS.R3, lo, bounds.hi, estimatedBasis(resolved.basis, resolved.value.kind === 'RELATIVE'), 'Recência da avaliação mais recente');
}

interface RepliesView {
  readonly basis: Basis;
  readonly exposed: boolean;
  readonly sufficient: boolean;
  readonly read: number;
  readonly replied: number;
  readonly pairs: ReadonlyArray<{ readonly reviewDate: string; readonly replyDate: string }>;
}

/** Amostra suficiente (D3B): >= 10 avaliações lidas, ou todas elas; sempre com o campo de resposta exposto. */
export function repliesView(ctx: ScoringContext): RepliesView | Exclude<ReturnType<ScoringContext['resolve']>, { status: 'OK' }> {
  const resolved = ctx.resolve('replies');
  if (resolved.status !== 'OK') return resolved;
  const value = resolved.value;
  return {
    basis: resolved.basis,
    exposed: value.ownerReplyFieldExposed,
    sufficient: value.ownerReplyFieldExposed && value.reviewsRead >= 1 && (value.reviewsRead >= RULES.repliesMinSample || value.allReviewsRead),
    read: value.reviewsRead,
    replied: value.repliedCount,
    pairs: value.pairs,
  };
}

function isView(value: ReturnType<typeof repliesView>): value is RepliesView {
  return 'basis' in value;
}

export function evalP1(ctx: ScoringContext): SubcriterionResult {
  const view = repliesView(ctx);
  if (!isView(view)) return nvFromResolution('P1', view);
  if (!view.exposed) return notVerified('P1', 'REPLY_FIELD_NOT_EXPOSED', 'O campo de resposta do proprietário não é exposto pela fonte: não é possível afirmar que não há respostas.', view.basis);
  if (!view.sufficient) return notVerified('P1', 'SAMPLE_TOO_SMALL', `Apenas ${view.read} avaliações lidas (mínimo ${RULES.repliesMinSample}, ou todas).`, view.basis);
  if (view.replied === 0) return absence('P1', 'ABSENCE_PROVEN_NATIVE', `Nenhuma das ${view.read} avaliações lidas tem resposta do proprietário (campo exposto).`, view.basis);
  const tier = resolveAsc(TIERS.P1, frac(view.replied, view.read));
  return scored('P1', tier.halfPoints, tier.label, `${view.replied} de ${view.read} avaliações lidas respondidas: ${tier.label}`, view.basis);
}

export function evalP2(ctx: ScoringContext): SubcriterionResult {
  const view = repliesView(ctx);
  if (!isView(view)) return nvFromResolution('P2', view);
  if (!view.exposed) return notVerified('P2', 'REPLY_FIELD_NOT_EXPOSED', 'O campo de resposta do proprietário não é exposto pela fonte.', view.basis);
  if (!view.sufficient) return notVerified('P2', 'SAMPLE_TOO_SMALL', `Apenas ${view.read} avaliações lidas (mínimo ${RULES.repliesMinSample}, ou todas).`, view.basis);
  if (view.replied === 0) return absence('P2', 'ABSENCE_DERIVED', 'Não há respostas: o tempo de resposta não existe.', view.basis);
  if (view.pairs.length < RULES.repliesMinPairs) {
    return notVerified('P2', 'DATE_NOT_AVAILABLE', `Só ${view.pairs.length} par(es) com data de avaliação e de resposta (mínimo ${RULES.repliesMinPairs}).`, view.basis);
  }
  const days = view.pairs.map((pair) => (parseDay(pair.replyDate) ?? 0) - (parseDay(pair.reviewDate) ?? 0));
  return scoreAgeFrac('P2', TIERS.P2, medianOfInts(days), view.basis, `Mediana do tempo de resposta (${view.pairs.length} pares)`);
}

export function evalP3(ctx: ScoringContext): SubcriterionResult {
  const view = repliesView(ctx);
  if (!isView(view)) return nvFromResolution('P3', view);
  if (!view.exposed) return notVerified('P3', 'REPLY_FIELD_NOT_EXPOSED', 'O campo de resposta do proprietário não é exposto pela fonte.', view.basis);
  if (view.replied === 0) return notVerified('P3', 'SAMPLE_TOO_SMALL', 'Sem respostas comprovadas nesta leitura.', view.basis);
  const judgement = ctx.judgement('P3');
  if (!judgement) return notVerified('P3', 'OPERATOR_CONFIRMATION_REQUIRED', 'A qualidade das respostas exige revisão humana registrada (sem IA).', view.basis);
  const reviewed = judgement.sampleSize ?? 0;
  if (reviewed > view.replied) {
    ctx.reject(`juízo ${judgement.id}: respostas revisadas (${reviewed}) maiores que as respostas existentes (${view.replied})`);
    return notVerified('P3', 'BASIS_MISSING', 'Revisão inconsistente com as respostas existentes.', view.basis);
  }
  if (reviewed < Math.min(RULES.p3MinReviewed, view.replied)) {
    return notVerified('P3', 'SAMPLE_TOO_SMALL', `Revisão humana de ${reviewed} resposta(s); mínimo ${Math.min(RULES.p3MinReviewed, view.replied)}.`, view.basis);
  }
  const key = judgement.value as keyof typeof CATEGORICAL.P3;
  const labels = { SPECIFIC: 'específicas/humanas', GENERIC_OR_MIXED: 'genéricas ou mistas', INAPPROPRIATE: 'inadequadas' } as const;
  return scored('P3', CATEGORICAL.P3[key], labels[key], `Qualidade das respostas segundo revisão humana (${judgement.id}): ${labels[key]}`, { ...view.basis, operatorRecordIds: [judgement.id] });
}
