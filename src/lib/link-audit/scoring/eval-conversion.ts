import type { ScoringContext } from './context';
import { countBounds, nvFromResolution, scoreAsc } from './eval-common';
import { absence, notVerified, scored, withNotes } from './results';
import { CATEGORICAL, RULES, TIERS } from './ruler';
import type { SubcriterionResult } from './types';

export function evalX1(ctx: ScoringContext): SubcriterionResult {
  const resolved = ctx.resolve('website');
  if (resolved.status !== 'OK') return nvFromResolution('X1', resolved);
  if (typeof resolved.value === 'string' && resolved.value.trim() !== '') {
    return scored('X1', CATEGORICAL.X1_PRESENT, 'website informado', 'Website configurado no perfil', resolved.basis, 'PRESENT');
  }
  if (resolved.complete) return absence('X1', 'ABSENCE_PROVEN_NATIVE', 'Campo "website" lido por inteiro e vazio.', resolved.basis);
  return notVerified('X1', 'FIELD_NOT_EXPOSED_OR_INCOMPLETE', 'Campo "website" lido de forma incompleta.', resolved.basis);
}

export function evalX3(ctx: ScoringContext): SubcriterionResult {
  const resolved = ctx.resolve('actions');
  if (resolved.status !== 'OK') return nvFromResolution('X3', resolved);
  const bounds = countBounds(resolved.value.kinds.length, resolved.complete, RULES.maxSiteChannelKinds);
  return scoreAsc('X3', TIERS.X3, bounds.lo, bounds.hi, resolved.basis, 'Canais de contato/ação no perfil (o website não conta)');
}

const UTM_CAVEAT = 'Ausência de UTM nesta URL não comprova ausência de rastreamento em geral (pode haver auto-tagging, GA4, GTM, redirecionadores ou rastreamento de chamadas).';

/** X5: analisa APENAS a URL de destino do website configurada no perfil (nunca o link do Maps colado pelo operador). */
export function evalX5(ctx: ScoringContext): SubcriterionResult {
  const resolved = ctx.resolve('website');
  if (resolved.status !== 'OK') return nvFromResolution('X5', resolved);
  const raw = typeof resolved.value === 'string' ? resolved.value.trim() : '';
  if (raw === '') return notVerified('X5', 'BASIS_MISSING', 'Não há URL de website configurada e lida.', resolved.basis);
  if (!resolved.complete) return notVerified('X5', 'FIELD_NOT_EXPOSED_OR_INCOMPLETE', 'A URL do website foi lida de forma incompleta (pode estar truncada).', resolved.basis);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return notVerified('X5', 'WEBSITE_URL_UNPARSABLE', 'A URL do website configurada não pôde ser interpretada.', resolved.basis);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return notVerified('X5', 'WEBSITE_URL_UNPARSABLE', 'A URL do website configurada não é http(s).', resolved.basis);
  }
  const present = new Set<string>();
  for (const [key, value] of url.searchParams) {
    const name = key.toLowerCase();
    if (name.startsWith('utm_') && value.trim() !== '') present.add(name);
  }
  // só os NOMES dos parâmetros entram no resultado (valores e a URL nunca são repetidos)
  const KNOWN = ['utm_campaign', 'utm_content', 'utm_id', 'utm_medium', 'utm_source', 'utm_term'];
  const names = [...present].filter((name) => KNOWN.includes(name)).sort();
  const basis = withNotes(resolved.basis, UTM_CAVEAT);
  if (present.has('utm_source') && present.has('utm_medium')) {
    return scored('X5', CATEGORICAL.X5.BOTH, 'UTM completo', `A URL de destino do website do perfil tem UTM completo (${names.join(', ')})`, basis);
  }
  if (present.size > 0) {
    return scored('X5', CATEGORICAL.X5.SOME, 'UTM parcial', `A URL de destino do website do perfil tem UTM parcial (${names.join(', ')})`, basis);
  }
  return absence('X5', 'ABSENCE_PROVEN_URL', 'A URL de destino do website cadastrado no perfil não contém parâmetros UTM com valor preenchido (avaliação exclusiva do uso de UTM).', basis);
}
