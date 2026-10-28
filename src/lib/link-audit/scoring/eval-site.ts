import type { ScoringContext } from './context';
import { nvFromResolution, scoreAsc } from './eval-common';
import { absence, notVerified, scored, withNotes, type Basis } from './results';
import { CATEGORICAL, RULES, TIERS, VALIDATED_DETECTORS } from './ruler';
import type { SubcriterionId, SubcriterionResult } from './types';

type Determination = { readonly method: 'VALIDATED_DETECTOR'; readonly detectorId: string } | { readonly method: 'OPERATOR_CONFIRMED'; readonly operatorRecordId: string };

const OWN_SOURCES = ['OFFICIAL_SITE', 'OFFICIAL_SOCIAL'] as const;

/** Texto obrigatório do relatório: o que foi efetivamente lido (nunca "o site inteiro"). */
function scopeNote(ctx: ScoringContext, sid: SubcriterionId): string {
  const scope = ctx.input.site?.scope;
  if (!scope) return 'Nenhum site lido.';
  const pages = scope.pagesRead.length;
  const suff = ctx.siteScopeSufficient(sid);
  return suff.sufficient
    ? `Escopo documentado (${scope.kind}, ${pages} páginas lidas) com atestado do operador (${suff.attestationId}): vale no escopo documentado, não além dele.`
    : `Observado em ${pages} página(s) lida(s) (escopo ${scope.kind}); não representa o domínio inteiro.`;
}

function checkDetermination(id: 'S5' | 'X4', determination: Determination): { ok: true; recordIds: string[] } | { ok: false; result: SubcriterionResult } {
  if (determination.method === 'VALIDATED_DETECTOR') {
    if (!VALIDATED_DETECTORS.includes(determination.detectorId)) {
      return { ok: false, result: notVerified(id, 'DETERMINATION_NOT_VALIDATED', `O detector "${determination.detectorId}" não está na lista de detectores validados (na Onda 6A só vale a confirmação do operador).`) };
    }
    return { ok: true, recordIds: [] };
  }
  return { ok: true, recordIds: [determination.operatorRecordId] };
}

/** Site/rede próprios: S5 e X4 (contagens sujeitas ao escopo lido). */
function siteCount(ctx: ScoringContext, id: 'S5' | 'X4', what: string): SubcriterionResult {
  const site = ctx.input.site;
  if (!site || site.scope.kind === 'NONE') {
    return notVerified(id, 'SITE_NOT_READ', 'O site não foi lido (nenhuma página obtida): nada a observar.');
  }
  const fact = id === 'S5' ? site.offers : site.journey;
  if (!fact) return notVerified(id, 'NO_OBSERVATION', 'Nenhuma observação deste subcritério no escopo lido.');
  const grounded = ctx.ground(fact.evidenceIds, id === 'S5' ? OWN_SOURCES : ['OFFICIAL_SITE']);
  if (!grounded.ok) return notVerified(id, grounded.reasonCode, grounded.reason);
  const determination = checkDetermination(id, fact.determination);
  if (!determination.ok) return determination.result;
  const suff = ctx.siteScopeSufficient(id);
  const lo = id === 'S5' ? (site.offers?.distinctNamedOffers ?? 0) : (site.journey?.elements.length ?? 0);
  const cap = id === 'S5' ? null : RULES.maxJourneyElements;
  const hi = suff.sufficient ? lo : cap;
  const recordIds = [...determination.recordIds, ...(suff.attestationId ? [suff.attestationId] : [])];
  const reviewed = suff.sufficient && site.scope.kind === 'DOCUMENTED_FULL_REVIEW';
  const basis: Basis = withNotes({ ...grounded.basis, grade: reviewed ? 'SECONDARY' : grounded.basis.grade, operatorRecordIds: recordIds.sort() }, scopeNote(ctx, id));
  const outcome = scoreAsc(id, TIERS[id], lo, hi, basis, what, 'ABSENCE_PROVEN_SCOPE');
  if (outcome.state === 'NOT_VERIFIED' && !suff.sufficient) {
    return notVerified(id, 'SITE_SCOPE_LIMITED', `${what}: com leitura limitada do site, só a faixa máxima se comprova pelo que foi observado; ausência e faixa intermediária ficam Não verificadas (nunca zero por ausência global).`, basis);
  }
  return outcome;
}

export const evalS5 = (ctx: ScoringContext): SubcriterionResult => siteCount(ctx, 'S5', 'Oferta pública em fonte própria');
export const evalX4 = (ctx: ScoringContext): SubcriterionResult => siteCount(ctx, 'X4', 'Jornada no site');

export function evalV5(ctx: ScoringContext): SubcriterionResult {
  const record = ctx.records('IMAGES_CONFIRMATION')[0];
  if (!record) return notVerified('V5', 'OPERATOR_CONFIRMATION_REQUIRED', 'A presença visual em fonte própria exige confirmação registrada do operador de que as imagens são reais e do negócio.');
  const grounded = record.evidenceIds.length > 0 ? ctx.ground(record.evidenceIds, OWN_SOURCES) : null;
  if (grounded && !grounded.ok) return notVerified('V5', grounded.reasonCode, grounded.reason);
  const lo = record.imageTypes.length;
  const suff = ctx.siteScopeSufficient('V5');
  const hi = suff.sufficient ? lo : RULES.maxImageTypes;
  if (!grounded || !grounded.ok) return notVerified('V5', 'BASIS_MISSING', 'A confirmação de imagens não cita a evidência (páginas/imagens revisadas): sem evidência não há ponto.');
  const reviewed = suff.sufficient && ctx.input.site?.scope.kind === 'DOCUMENTED_FULL_REVIEW';
  const basis: Basis = withNotes({ ...grounded.basis, grade: reviewed ? 'SECONDARY' : grounded.basis.grade, operatorRecordIds: [record.id, ...(suff.attestationId ? [suff.attestationId] : [])].sort() }, scopeNote(ctx, 'V5'));
  const outcome = scoreAsc('V5', TIERS.V5, lo, hi, basis, 'Presença visual em fonte própria', 'ABSENCE_PROVEN_SCOPE');
  if (outcome.state === 'NOT_VERIFIED' && !suff.sufficient) {
    return notVerified('V5', 'SITE_SCOPE_LIMITED', 'Presença visual: com leitura limitada, só ≥ 2 tipos de imagem real se comprovam; 0 ou 1 tipo ficam Não verificados (nunca zero por ausência global).', basis);
  }
  return outcome;
}

export function evalX2(ctx: ScoringContext): SubcriterionResult {
  const website = ctx.resolve('website');
  if (website.status !== 'OK') return nvFromResolution('X2', website);
  if (typeof website.value !== 'string' || website.value.trim() === '') {
    return notVerified('X2', 'BASIS_MISSING', 'Não há website configurado e lido: nada a acessar.', website.basis);
  }
  const access = ctx.input.site?.accessibility;
  if (!access) return notVerified('X2', 'SITE_NOT_READ', 'A URL configurada não foi acessada.', website.basis);
  const grounded = ctx.ground(access.evidenceIds, ['OFFICIAL_SITE']);
  if (!grounded.ok) return notVerified('X2', grounded.reasonCode, grounded.reason, website.basis);
  const basis = withNotes(grounded.basis, 'O resultado é um fato sobre a URL configurada, não sobre o domínio inteiro.');
  if (access.outcome === 'OK') return scored('X2', CATEGORICAL.X2_OK, 'respondeu 2xx/3xx', `A URL configurada respondeu ${access.status ?? ''}`.trim(), basis, 'PRESENT');
  const status = access.status ?? 0;
  if (access.outcome === 'HTTP_ERROR' && access.persistent === true && (status === 404 || status === 410 || status >= 500)) {
    return absence('X2', 'ABSENCE_PROVEN_URL', `A URL configurada respondeu ${status} de forma persistente.`, basis);
  }
  return notVerified('X2', 'SITE_NOT_READ', 'Bloqueio, desafio, tempo esgotado ou erro não persistente (401/403/429/timeout): acesso Não verificado, nunca zero.', basis);
}
