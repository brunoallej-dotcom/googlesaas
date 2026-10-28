import type { ScoringContext } from './context';
import { parseDay } from './dates';
import type { ScoredDate } from './input';
import { countBounds, nvFromResolution, scoreAge, scoreAsc } from './eval-common';
import { estimatedBasis } from './eval-reputation';
import { absence, combineBasis, notVerified, scored } from './results';
import { CATEGORICAL, RULES, TIERS } from './ruler';
import type { SubcriterionResult } from './types';

export function evalV1(ctx: ScoringContext): SubcriterionResult {
  const resolved = ctx.resolve('logoCover');
  if (resolved.status !== 'OK') return nvFromResolution('V1', resolved);
  const present = (resolved.value.logo ? 1 : 0) + (resolved.value.cover ? 1 : 0);
  const bounds = countBounds(present, resolved.complete, 2);
  return scoreAsc('V1', TIERS.V1, bounds.lo, bounds.hi, resolved.basis, 'Logo e capa do perfil');
}

function mediaCount(ctx: ScoringContext, id: 'V2' | 'V3', key: 'photos' | 'videos', what: string): SubcriterionResult {
  const resolved = ctx.resolve(key);
  if (resolved.status !== 'OK') return nvFromResolution(id, resolved);
  const bounds = countBounds(resolved.value, resolved.complete);
  return scoreAsc(id, TIERS[id], bounds.lo, bounds.hi, resolved.basis, what);
}
export const evalV2 = (ctx: ScoringContext): SubcriterionResult => mediaCount(ctx, 'V2', 'photos', 'Fotos no perfil');
export const evalV3 = (ctx: ScoringContext): SubcriterionResult => mediaCount(ctx, 'V3', 'videos', 'Vídeos no perfil');

export function evalV4(ctx: ScoringContext): SubcriterionResult {
  const photos = ctx.resolve('photos');
  const videos = ctx.resolve('videos');
  if (photos.status === 'OK' && videos.status === 'OK' && photos.complete && videos.complete && photos.value === 0 && videos.value === 0) {
    return absence('V4', 'ABSENCE_DERIVED', 'Sem fotos nem vídeos no perfil (leitura completa): não há mídia a datar.', combineBasis(photos.basis, videos.basis));
  }
  const resolved = ctx.resolve('latestMedia');
  if (resolved.status !== 'OK') return nvFromResolution('V4', resolved);
  if (resolved.value === null) return notVerified('V4', 'DATE_NOT_AVAILABLE', 'A data da mídia mais recente não foi lida.', resolved.basis);
  const bounds = ctx.ageBounds(resolved.value);
  // leitura incompleta: pode haver mídia mais nova que a vista
  const lo = resolved.complete ? bounds.lo : 0;
  return scoreAge('V4', TIERS.V4, lo, bounds.hi, estimatedBasis(resolved.basis, resolved.value.kind === 'RELATIVE'), 'Recência da mídia nativa');
}

/* ---------------------------------------------------------------- publicações */

type PostItem = { readonly date: ScoredDate | null; readonly expiresOn?: string | undefined };
type PostClass = 'VIGENT' | 'NOT_VIGENT' | 'UNKNOWN';

function classify(ctx: ScoringContext, item: PostItem): PostClass {
  if (item.expiresOn !== undefined) {
    const expires = parseDay(item.expiresOn);
    if (expires !== null && expires < ctx.refDay) return 'NOT_VIGENT';
  }
  if (!item.date) return 'UNKNOWN';
  const bounds = ctx.ageBounds(item.date);
  if (bounds.lo > RULES.postVigentMaxDays) return 'NOT_VIGENT';
  if (bounds.hi <= RULES.postVigentMaxDays) return 'VIGENT';
  return 'UNKNOWN';
}

function postsInfo(ctx: ScoringContext) {
  const resolved = ctx.resolve('posts');
  if (resolved.status !== 'OK') return { ok: false, fail: resolved } as const;
  const usesEstimate = resolved.value.items.some((item) => item.date?.kind === 'RELATIVE');
  return { ok: true, basis: estimatedBasis(resolved.basis, usesEstimate), items: resolved.value.items, exposed: resolved.value.exposed, complete: resolved.complete } as const;
}

export function evalA1(ctx: ScoringContext): SubcriterionResult {
  const info = postsInfo(ctx);
  if (!info.ok) return nvFromResolution('A1', info.fail);
  if (!info.exposed) return notVerified('A1', 'FIELD_NOT_EXPOSED_OR_INCOMPLETE', 'A lista de publicações não é exposta pela fonte.', info.basis);
  const classes = info.items.map((item) => classify(ctx, item));
  if (classes.includes('VIGENT')) return scored('A1', CATEGORICAL.A1.VIGENT, 'ao menos uma publicação vigente', 'Há publicação vigente (≤ 180 dias e não expirada)', info.basis);
  if (classes.includes('UNKNOWN')) return notVerified('A1', 'INDECISIVE_RANGE', 'Há publicações cuja vigência não se decide pelas datas disponíveis.', info.basis);
  if (!info.complete) return notVerified('A1', 'FIELD_NOT_EXPOSED_OR_INCOMPLETE', 'Lista de publicações lida de forma incompleta: pode haver publicação vigente não vista.', info.basis);
  if (info.items.length > 0) {
    return scored('A1', CATEGORICAL.A1.EXISTING_NONE_VIGENT, 'existem publicações, nenhuma vigente', 'Publicações existem, mas todas antigas (> 180 dias) ou expiradas', info.basis);
  }
  return absence('A1', 'ABSENCE_PROVEN_NATIVE', 'Lista nativa de publicações lida por inteiro e vazia.', info.basis);
}

export function evalA2(ctx: ScoringContext): SubcriterionResult {
  const info = postsInfo(ctx);
  if (!info.ok) return nvFromResolution('A2', info.fail);
  if (!info.exposed) return notVerified('A2', 'FIELD_NOT_EXPOSED_OR_INCOMPLETE', 'A lista de publicações não é exposta pela fonte.', info.basis);
  if (info.items.length === 0) {
    return info.complete
      ? absence('A2', 'ABSENCE_DERIVED', 'Lista de publicações vazia (leitura completa): não há publicação a datar.', info.basis)
      : notVerified('A2', 'FIELD_NOT_EXPOSED_OR_INCOMPLETE', 'Lista de publicações vazia, mas lida de forma incompleta.', info.basis);
  }
  const intervals = info.items.map((item) => (item.date ? ctx.ageBounds(item.date) : { lo: 0, hi: null as number | null }));
  const finiteHi = intervals.map((interval) => interval.hi).filter((hi): hi is number => hi !== null);
  const lo = info.complete ? Math.min(...intervals.map((interval) => interval.lo)) : 0;
  const hi = finiteHi.length === 0 ? null : Math.min(...finiteHi);
  return scoreAge('A2', TIERS.A2, lo, hi, info.basis, 'Recência da última publicação');
}

export function evalA3(ctx: ScoringContext): SubcriterionResult {
  const info = postsInfo(ctx);
  if (!info.ok) return nvFromResolution('A3', info.fail);
  if (!info.exposed) return notVerified('A3', 'FIELD_NOT_EXPOSED_OR_INCOMPLETE', 'A lista de publicações não é exposta pela fonte.', info.basis);
  let certain = 0;
  let possible = 0;
  for (const item of info.items) {
    if (!item.date) {
      possible += 1;
      continue;
    }
    const bounds = ctx.ageBounds(item.date);
    if (bounds.hi <= RULES.postsWindowDays) certain += 1;
    if (bounds.lo <= RULES.postsWindowDays) possible += 1;
  }
  return scoreAsc('A3', TIERS.A3, certain, info.complete ? possible : null, info.basis, 'Publicações nos últimos 90 dias');
}
