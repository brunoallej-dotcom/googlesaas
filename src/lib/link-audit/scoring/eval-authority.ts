import type { ScoringContext } from './context';
import { nvFromResolution, scoreAsc } from './eval-common';
import { frac, medianOfInts, type Frac } from './math';
import { ratingToCents } from './input';
import { absence, combineBasis, notVerified, sampleInsufficient, scored, withNotes, type Basis } from './results';
import { RULES, TIERS, type AscTier } from './ruler';
import { resolveAsc } from './tiers';
import type { SubcriterionResult } from './types';

interface EligibleCompetitor {
  readonly id: string;
  readonly cents: number;
  readonly count: number;
  readonly basis: Basis;
}

/** Concorrente elegível: equivalência documentada, >= 2 elementos verificáveis, nota/volume lidos no Google e >= 5 avaliações. */
function eligibleCompetitors(ctx: ScoringContext): EligibleCompetitor[] {
  const eligible: EligibleCompetitor[] = [];
  for (const competitor of ctx.input.competitors ?? []) {
    if (competitor.verifiableElements < RULES.competitorMinVerifiableElements) continue;
    if (competitor.rating === null || competitor.reviewCount < RULES.competitorMinReviews) continue;
    const grounded = ctx.ground(competitor.evidenceIds, ['GOOGLE_NATIVE']);
    if (!grounded.ok) continue;
    eligible.push({ id: competitor.id, cents: ratingToCents(competitor.rating), count: competitor.reviewCount, basis: grounded.basis });
  }
  return eligible;
}

function tableFor(thresholds: readonly [Frac, Frac, Frac], labels: readonly [string, string, string, string]): readonly AscTier[] {
  return [
    { label: labels[0], halfPoints: 6, min: thresholds[0] },
    { label: labels[1], halfPoints: 4, min: thresholds[1] },
    { label: labels[2], halfPoints: 2, min: thresholds[2] },
    { label: labels[3], halfPoints: 0, min: frac(0) },
  ];
}

export function evalL1(ctx: ScoringContext): SubcriterionResult {
  const reviews = ctx.resolve('reviews');
  if (reviews.status !== 'OK') return nvFromResolution('L1', reviews);
  const { ratingShown, reviewCount } = reviews.value;
  if (reviewCount < RULES.minReviewsForRating) {
    if (!reviews.complete) return notVerified('L1', 'INDECISIVE_RANGE', 'Quantidade de avaliações lida de forma incompleta; a elegibilidade da nota não se decide.', reviews.basis);
    return sampleInsufficient('L1', 'REVIEWS_BELOW_MIN_SAMPLE', `A empresa tem ${reviewCount} avaliação(ões), abaixo do mínimo de ${RULES.minReviewsForRating} para comparar notas.`, reviews.basis);
  }
  if (ratingShown === null) return notVerified('L1', 'RATING_NOT_READ', 'A nota exibida não foi lida.', reviews.basis);
  const sample = eligibleCompetitors(ctx);
  if (sample.length < RULES.minEligibleCompetitors) {
    return sampleInsufficient('L1', 'COMPETITOR_SAMPLE_BELOW_MIN', `Apenas ${sample.length} concorrente(s) elegível(is); mínimo ${RULES.minEligibleCompetitors}.`, combineBasis(reviews.basis, ...sample.map((item) => item.basis)));
  }
  const cents = sample.map((item) => item.cents);
  const max = Math.max(...cents);
  const min = Math.min(...cents);
  const table = tableFor([frac(max), medianOfInts(cents), frac(min)], ['nota igual ou acima do maior da amostra', 'entre a mediana e o maior', 'entre o menor e a mediana', 'abaixo do menor da amostra']);
  const tier = resolveAsc(table, frac(ratingToCents(ratingShown)));
  const basis = withNotes(combineBasis(reviews.basis, ...sample.map((item) => item.basis)), `Amostra elegível: ${sample.length} concorrente(s) (${sample.map((item) => item.id).sort().join(', ')}).`);
  return scored('L1', tier.halfPoints, tier.label, `Nota ${ratingShown} frente a ${sample.length} concorrentes: ${tier.label}`, basis);
}

export function evalL2(ctx: ScoringContext): SubcriterionResult {
  const reviews = ctx.resolve('reviews');
  if (reviews.status !== 'OK') return nvFromResolution('L2', reviews);
  const sample = eligibleCompetitors(ctx);
  if (sample.length < RULES.minEligibleCompetitors) {
    return sampleInsufficient('L2', 'COMPETITOR_SAMPLE_BELOW_MIN', `Apenas ${sample.length} concorrente(s) elegível(is); mínimo ${RULES.minEligibleCompetitors}.`, combineBasis(reviews.basis, ...sample.map((item) => item.basis)));
  }
  const counts = sample.map((item) => item.count);
  const median = medianOfInts(counts); // sempre > 0: só entram concorrentes com >= 5 avaliações
  const half = frac(median.n, median.d * 2);
  const table = tableFor([frac(Math.max(...counts)), median, half], ['volume igual ou acima do maior da amostra', 'entre a mediana e o maior', 'entre metade da mediana e a mediana', 'abaixo de metade da mediana']);
  const x = reviews.value.reviewCount;
  const basis = withNotes(combineBasis(reviews.basis, ...sample.map((item) => item.basis)), `Amostra elegível: ${sample.length} concorrente(s) (${sample.map((item) => item.id).sort().join(', ')}).`);
  // leitura incompleta do volume: só se decide quando o limite inferior já alcança a faixa máxima
  const loTier = resolveAsc(table, frac(x));
  if (!reviews.complete && loTier !== table[0]) {
    return notVerified('L2', 'INDECISIVE_RANGE', 'Volume de avaliações lido de forma incompleta; a faixa não se decide só com o limite inferior.', basis);
  }
  if (x === 0) return absence('L2', 'ABSENCE_PROVEN_NATIVE', 'A empresa não tem avaliações; frente à amostra, 0 ponto.', basis);
  return scored('L2', loTier.halfPoints, loTier.label, `${x} avaliações frente a ${sample.length} concorrentes: ${loTier.label}`, basis);
}

const CLASS_ORIGINS = {
  OFFICIAL_SITE: ['OFFICIAL_SITE'],
  SOCIAL: ['OFFICIAL_SOCIAL'],
  OFFICIAL_REGISTRY: ['INSTITUTIONAL'],
  INDEPENDENT_THIRD_PARTY: ['THIRD_PARTY'],
} as const;
const ANY_EXTERNAL = ['OFFICIAL_SITE', 'OFFICIAL_SOCIAL', 'THIRD_PARTY', 'INSTITUTIONAL'] as const;

export function evalL3(ctx: ScoringContext): SubcriterionResult {
  const authority = ctx.input.authority;
  if (!authority) return notVerified('L3', 'NO_OBSERVATION', 'Nenhuma busca de prova externa de autoridade foi registrada.');
  const corroborated = new Set<string>();
  const bases: Basis[] = [];
  for (const finding of authority.findings) {
    if (!finding.corroborated) continue;
    const grounded = ctx.ground(finding.evidenceIds, CLASS_ORIGINS[finding.class]);
    if (!grounded.ok) continue;
    corroborated.add(finding.class);
    bases.push(grounded.basis);
  }
  const searched = authority.protocol?.searched ?? [];
  const protocolBases: Basis[] = [];
  let protocolOk = new Set(searched.map((entry) => entry.class)).size === RULES.authorityClasses;
  for (const entry of searched) {
    const grounded = ctx.ground(entry.evidenceIds, ANY_EXTERNAL);
    if (!grounded.ok) protocolOk = false;
    else protocolBases.push(grounded.basis);
  }
  const lo = corroborated.size;
  const hi = protocolOk ? lo : RULES.authorityClasses;
  const basis = withNotes(combineBasis(...bases, ...(protocolOk ? protocolBases : [])), protocolOk ? 'Protocolo de busca documentado nas quatro classes (vale no escopo buscado).' : 'Sem protocolo de busca completo nas quatro classes: 0 ou 1 tipo não se comprova.');
  const outcome = scoreAsc('L3', TIERS.L3, lo, hi, basis, 'Prova externa de autoridade', 'ABSENCE_PROVEN_PROTOCOL');
  if (outcome.state === 'NOT_VERIFIED' && !protocolOk) {
    return notVerified('L3', 'PROTOCOL_INCOMPLETE', 'Sem protocolo de busca documentado nas quatro classes, só ≥ 2 tipos corroborados se comprovam; 0 ou 1 ficam Não verificados.', basis);
  }
  return outcome;
}
