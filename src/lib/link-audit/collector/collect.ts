import type { CriterionAssessment } from '../audit';
import { validateEvidence, type Evidence } from '../evidence';
import { parseGoogleMapsLink } from '../maps-link';
import { CRITERIA } from '../methodology';
import type { SnapshotDraft } from '../snapshot';
import { safeFailureReason } from '../url-redaction';
import {
  capText,
  mapsEvidences,
  noExternalPresenceEvidence,
  profileUrlFrom,
  siteEvidences,
  unavailableEvidences,
  unlocatedWebsiteEvidence,
  websiteEvidences,
  websiteKindOf,
  type AdapterContext,
  type ReviewsNote,
} from './adapters';
import { CallLedger, type Reservation } from './budget';
import { LOOKUP_STRATEGIES } from './capabilities';
import { hasComparableIdentifier, matchPlace, parseMapsPlaces, type MapsPlace } from './maps-place';
import { buildExpectedIdentity } from '../identifiers';
import { divergences as computeDivergences, profileSummary, siteObservation } from './summaries';
import type {
  CallBudget,
  CollectionInput,
  CollectionOptions,
  CollectionOutcome,
  CollectionResult,
  CollectorProviders,
  ConfirmedIdentifier,
  Divergence,
  IdentifierReport,
  IdentityBasis,
  LocateState,
  ProviderId,
  SiteObservation,
  Viewport,
} from './types';
import type { MapsIdentifiers } from '../maps-link';

/*
 * Motor de coleta da Auditoria por Link (Onda 4A). NÃO faz coleta real: os provedores são injetados e,
 * nesta onda, só existem simulados. O motor:
 *  - exige identidade confirmada e coerente com o link;
 *  - respeita um orçamento de chamadas que nunca é excedido e um prazo por chamada;
 *  - localiza o perfil só por identificador exato (nome nunca identifica);
 *  - transforma o que veio em evidências (VERIFIED / PARTIAL / NOT_VERIFIED; NOT_FOUND nunca é automático);
 *  - trata TUDO que vem do provedor como dado hostil: texto limpo e limitado, datas validadas, formatos conferidos;
 *  - define o status do critério por regra mecânica e conservadora, SEM pontuação nem "avaliação parcial".
 */

const MAX_BUDGET = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const VIEWPORT = /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:,(\d{1,2}(?:\.\d+)?)z)?/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function validBudget(budget: CallBudget): boolean {
  return (['maps', 'reviews', 'site'] as const).every((key) => Number.isInteger(budget[key]) && budget[key] >= 0 && budget[key] <= MAX_BUDGET);
}

export function extractViewport(link: string): Viewport | null {
  const match = VIEWPORT.exec(link);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude, zoom: match[3] ? Number(match[3]) : null };
}

/**
 * Status do critério (regra provisória, mecânica, sem pontos): VERIFIED só se há evidências e TODAS são
 * VERIFIED. Qualquer outra combinação é NOT_VERIFIED: a regra de avaliação parcial pertence à D3 e não
 * foi implementada.
 */
export function mechanicalCriterionStatus(evidences: readonly Evidence[]): 'VERIFIED' | 'NOT_VERIFIED' {
  return evidences.length > 0 && evidences.every((evidence) => evidence.status === 'VERIFIED') ? 'VERIFIED' : 'NOT_VERIFIED';
}

function latest(...isoDates: string[]): string {
  return isoDates.reduce((best, current) => (Date.parse(current) > Date.parse(best) ? current : best));
}

/** Data informada por um provedor: só vale se for ISO com fuso, e nunca depois de agora (não se forja o futuro). */
function observedAt(value: unknown, nowIso: string): string {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) return nowIso;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.parse(nowIso) ? value : nowIso;
}

const TIMED_OUT = Symbol('timed-out');

const NO_LEDGER: Reservation = { ok: true, index: -1 };

/** Reserva a chamada no razão (se houver) imediatamente antes de fazê-la. */
function reserve(ledger: CallLedger | undefined, provider: ProviderId): Reservation {
  return ledger ? ledger.reserve(provider) : NO_LEDGER;
}

/** Chamada a provedor com prazo: estourou ou lançou ⇒ falha com motivo saneado (nunca trava a coleta). */
async function guarded<T>(task: () => Promise<T>, timeoutMs: number): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    const value = await Promise.race([task(), timeout]);
    return value === TIMED_OUT ? { ok: false, reason: `tempo limite de ${timeoutMs} ms excedido` } : { ok: true, value };
  } catch (error) {
    return { ok: false, reason: safeFailureReason(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SearchPlan {
  readonly canSearch: boolean;
  /** Texto usado SÓ para trazer candidatos; o perfil só é aceito por identificador exato. */
  readonly query: string;
  readonly viewport: Viewport | null;
  readonly nameSource: 'OPERATOR' | 'LINK_LABEL' | 'NONE';
}

/** Como o perfil será procurado (usado pela coleta e pelo plano do DRY_RUN). */
export function planSearch(input: CollectionInput): SearchPlan {
  const effectiveLink = input.link.resolved?.url ?? input.link.originalLink;
  const parsed = parseGoogleMapsLink(effectiveLink);
  const label = parsed.status === 'IDENTIFIED' ? parsed.untrustedLabelHint : undefined;
  const name = input.identity.name ?? label;
  const query = [name, input.identity.city, input.identity.stateCode].filter((part): part is string => Boolean(part)).join(' ').slice(0, 200);
  return {
    canSearch: Boolean(name),
    query,
    viewport: extractViewport(effectiveLink),
    nameSource: input.identity.name ? 'OPERATOR' : label ? 'LINK_LABEL' : 'NONE',
  };
}

export async function collectEvidence(
  input: CollectionInput,
  providers: CollectorProviders,
  options: CollectionOptions,
): Promise<CollectionOutcome> {
  if (!validBudget(options.budget)) {
    return { ok: false, code: 'INVALID_BUDGET', issues: ['Cada orçamento deve ser um inteiro entre 0 e 10.'] };
  }
  const timeoutMs = Math.min(Math.max(1, Math.floor(options.providerTimeoutMs ?? DEFAULT_TIMEOUT_MS)), MAX_TIMEOUT_MS);
  const { identity } = input;
  if (!identity.confirmation) {
    return { ok: false, code: 'IDENTITY_NOT_CONFIRMED', issues: ['A coleta só começa depois que o operador confirma a identidade.'] };
  }
  const effectiveLink = input.link.resolved?.url ?? input.link.originalLink;
  const parsedLink = parseGoogleMapsLink(effectiveLink);
  const ids = identity.identifiers;
  const sameIdentifiers =
    parsedLink.status === 'IDENTIFIED' &&
    (['cid', 'placeId', 'featureId'] as const).every((key) => parsedLink.identifiers[key] === ids[key]);
  if (!sameIdentifiers || identity.originalLink !== input.link.originalLink) {
    return { ok: false, code: 'IDENTITY_MISMATCH', issues: ['A identidade confirmada não corresponde ao link informado.'] };
  }
  const profileUrl = profileUrlFrom(ids);
  if (!profileUrl) return { ok: false, code: 'IDENTITY_MISMATCH', issues: ['A identidade não tem identificador.'] };
  const expected = buildExpectedIdentity(ids);
  if (expected.conflict) return { ok: false, code: 'IDENTITY_MISMATCH', issues: [`Identificadores do link inconsistentes: ${expected.conflict}.`] };

  const startedAt = options.now().toISOString();
  const limitations: string[] = [];
  const usage = { maps: 0, reviews: 0, site: 0 };
  const evidences: Evidence[] = [];
  const baseCtx: AdapterContext = { profileUrl, consultedAt: startedAt };

  // ---- 1. localizar o perfil (somente por identificador exato) --------------------------------------
  let located: LocateState = 'NOT_ATTEMPTED';
  let place: MapsPlace | null = null;
  let mapsFetchedAt: string | null = null;
  let mapsReason = 'O perfil não foi consultado.';
  let matchedBy: IdentityBasis['matchedBy'] = null;
  let returnedIds: MapsIdentifiers | null = null;
  const confirmedIds: ConfirmedIdentifier[] = [];
  if (expected.cid?.origin === 'DERIVED_FROM_FID') {
    limitations.push(`O CID esperado (${expected.cid.value}) foi derivado do FID do link por conversão offline; não foi retornado por nenhuma API.`);
  }

  const strategy = LOOKUP_STRATEGIES.find((candidate) => candidate.enabled && candidate.confirmed);
  const search = planSearch(input);

  if (!providers.maps) {
    mapsReason = 'Nenhum provedor do Serper /maps está configurado.';
  } else if (options.budget.maps < 1) {
    mapsReason = 'Orçamento de chamadas ao Serper /maps igual a zero.';
  } else if (!strategy || !search.canSearch) {
    mapsReason = 'Sem nome informado e sem nome no link, não há como localizar o perfil; informe o nome da empresa.';
  } else {
    const reservation = reserve(options.ledger, 'serper-maps');
    if (!reservation.ok) {
      mapsReason = `Consulta ao Serper /maps não executada: ${reservation.reason}.`;
    } else {
      usage.maps += 1;
      const maps = providers.maps;
      const call = await guarded(() => maps.search({ query: search.query, viewport: search.viewport }), timeoutMs);
      if (!call.ok) {
        options.ledger?.settle(reservation, 'failed', capText(call.reason, 200));
        located = 'NOT_LOCATED';
        mapsReason = `Consulta ao Serper /maps indisponível: ${capText(call.reason, 600)}`;
      } else if (call.value.state !== 'OK') {
        options.ledger?.settle(reservation, 'failed', 'o provedor não devolveu dados');
        located = 'NOT_LOCATED';
        mapsReason = `Consulta ao Serper /maps indisponível: ${capText(String(call.value.reason ?? ''), 600)}`;
      } else {
        options.ledger?.settle(reservation, 'ok');
        mapsFetchedAt = observedAt(call.value.fetchedAt, options.now().toISOString());
        const rawPlaces: readonly unknown[] = Array.isArray(call.value.value) ? call.value.value : [];
        if (!Array.isArray(call.value.value)) limitations.push('A resposta do Serper /maps não veio como lista; foi ignorada.');
        const parsed = parseMapsPlaces(rawPlaces);
        if (parsed.ignored > 0) limitations.push(`${parsed.ignored} item(ns) do Serper /maps em formato inesperado ou além do limite de 100 foram ignorados.`);
        // O provedor só permite CONFIRMAR o perfil se devolver identificadores do mesmo tipo que o link trouxe.
        const anyComparable = parsed.places.some((candidate) => hasComparableIdentifier(candidate, ids));
        if (parsed.places.length > 0 && !anyComparable) {
          located = 'NOT_LOCATED';
          mapsReason = 'O Serper devolveu resultados, mas nenhum com identificador comparável com o do link (cid, fid ou placeId): o perfil não pôde ser confirmado e nada foi aceito por semelhança de nome.';
        } else {
          const match = matchPlace(parsed.places, ids);
          if (match.state === 'MATCHED') {
            located = 'MATCHED';
            place = match.place;
            matchedBy = { cid: match.basis.cid, placeId: match.basis.placeId, provenCid: match.basis.provenCid, resultCidSource: match.basis.resultCidSource };
            returnedIds = match.place.identifiers;
            const fields = match.basis.resultCidSource === 'cid' ? ['cid'] : match.basis.resultCidSource === 'fid' ? ['fid (2ª metade)'] : ['cid', 'fid (2ª metade)'];
            if (match.basis.cid && match.basis.provenCid && expected.cid) {
              confirmedIds.push({ type: 'cid', value: match.basis.provenCid, expectedOrigin: expected.cid.origin, providerFields: fields, result: 'EQUAL' });
            }
            if (match.basis.placeId && expected.placeId) {
              confirmedIds.push({ type: 'placeId', value: expected.placeId, expectedOrigin: 'LINK', providerFields: ['placeId'], result: 'EQUAL' });
            }
            if (ids.featureId !== undefined && match.place.identifiers.featureId === ids.featureId) {
              confirmedIds.push({ type: 'featureId', value: ids.featureId, expectedOrigin: 'LINK', providerFields: ['fid'], result: 'EQUAL' });
            }
            if (match.basis.resultCidSource === 'fid') {
              limitations.push('O CID do resultado do Serper foi derivado do fid dele por conversão offline; a API não devolveu o campo cid.');
            }
          } else if (match.state === 'AMBIGUOUS') {
            located = 'AMBIGUOUS';
            mapsReason = match.reason;
          } else {
            located = 'NOT_LOCATED';
            mapsReason = 'O perfil não apareceu entre os resultados da busca (não é prova de que ele não existe).';
          }
        }
      }
    }
  }
  if (!place) limitations.push(`Perfil não coletado: ${mapsReason}`);
  else limitations.push('Dados do perfil obtidos via Serper /maps (intermediário); o perfil não foi aberto diretamente no Google.');

  evidences.push(...mapsEvidences(place, baseCtx, mapsFetchedAt, mapsReason));

  // ---- 2. site informado no perfil ------------------------------------------------------------------
  let siteEvidence: Evidence[] = [];
  let siteSummary: SiteObservation | null = null;
  let siteTelLinks: readonly string[] = [];
  const website = websiteKindOf(place?.website ?? null);
  if (!place) evidences.push(unlocatedWebsiteEvidence(baseCtx, mapsReason));
  if (place) {
    evidences.push(...websiteEvidences(website, baseCtx, mapsFetchedAt));
    if (website.kind === 'OWN' && website.url) {
      const site = providers.site;
      if (!site) {
        limitations.push('Verificação do site não executada: nenhum provedor configurado.');
      } else if (options.budget.site < 1) {
        limitations.push('Verificação do site não executada: orçamento igual a zero.');
      } else {
        const reservation = reserve(options.ledger, 'site-check');
        if (!reservation.ok) {
          limitations.push(`Verificação do site não executada: ${reservation.reason}.`);
        } else {
          usage.site += 1;
          const siteUrl = website.url;
          const call = await guarded(() => site.check(siteUrl), timeoutMs);
          if (!call.ok) {
            options.ledger?.settle(reservation, 'failed', capText(call.reason, 200));
            limitations.push(`Verificação do site falhou: ${capText(call.reason, 600)}`);
          } else {
            options.ledger?.settle(reservation, 'ok');
            try {
              const result = { ...call.value, checkedAt: observedAt(call.value.checkedAt, options.now().toISOString()) };
              siteEvidence = siteEvidences(result, place.phone, baseCtx);
              siteSummary = siteObservation(result);
              siteTelLinks = Array.isArray(result.telLinks) ? result.telLinks : [];
            } catch {
              limitations.push('O resultado da verificação do site veio em formato inesperado e foi ignorado.');
            }
          }
        }
      }
    }
  }
  evidences.push(...siteEvidence);
  if (!evidences.some((evidence) => evidence.id === 'external-presence')) {
    evidences.push(noExternalPresenceEvidence(baseCtx, 'Presença digital externa e autoridade local não foram coletadas nesta etapa.'));
  }

  // ---- 3. avaliações datadas (endpoint com formato NÃO confirmado) ----------------------------------
  let reviewsNote: ReviewsNote;
  if (!providers.reviews) reviewsNote = { kind: 'NOT_RUN', reason: 'nenhum provedor configurado (endpoint desligado por padrão).' };
  else if (options.budget.reviews < 1) reviewsNote = { kind: 'NOT_RUN', reason: 'orçamento de páginas igual a zero.' };
  else if (!ids.featureId) reviewsNote = { kind: 'NOT_RUN', reason: 'o endpoint exige o identificador fid, ausente neste perfil.' };
  else {
    const reviews = providers.reviews;
    const featureId = ids.featureId;
    const reservation = reserve(options.ledger, 'serper-reviews');
    const call = !reservation.ok
      ? ({ ok: false, reason: reservation.reason } as const)
      : await guarded(
          () => reviews.getReviews({ featureId, placeId: ids.placeId ?? null, cid: ids.cid ?? null }, { maxPages: options.budget.reviews }),
          timeoutMs,
        );
    if (reservation.ok) options.ledger?.settle(reservation, call.ok ? 'ok' : 'failed');
    if (!call.ok) {
      if (!reservation.ok) {
        reviewsNote = { kind: 'NOT_RUN', reason: reservation.reason };
      } else {
        usage.reviews += 1; // a tentativa conta como, no mínimo, uma chamada
        reviewsNote = { kind: 'FAILED', reason: call.reason };
      }
    } else {
      const outcome = call.value;
      const pages = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);
      if (outcome.state === 'FETCHED') {
        usage.reviews += pages(outcome.pagesFetched);
        reviewsNote = { kind: 'RECEIVED_UNCONFIRMED_FORMAT', pages: pages(outcome.pagesFetched) };
      } else if (outcome.state === 'FAILED') {
        usage.reviews += pages(outcome.pagesFetched);
        reviewsNote = { kind: 'FAILED', reason: String(outcome.reason ?? '') };
      } else {
        reviewsNote = { kind: 'NOT_RUN', reason: String(outcome.reason ?? '') };
      }
      if (usage.reviews > options.budget.reviews) {
        limitations.push('Alerta: o provedor de avaliações usou mais páginas que o orçamento informado.');
      }
    }
  }
  evidences.push(...unavailableEvidences(baseCtx, reviewsNote));

  // ---- 4. validar cada evidência (rede de segurança) ------------------------------------------------
  const valid: Evidence[] = [];
  const seen = new Set<string>();
  for (const evidence of evidences) {
    const checked = validateEvidence(evidence);
    if (!checked.ok || seen.has(evidence.id)) {
      limitations.push(`Uma evidência (${evidence.id}) foi descartada por inconsistência interna.`);
      continue;
    }
    seen.add(evidence.id);
    valid.push(checked.value);
  }

  const criteria: CriterionAssessment[] = CRITERIA.map((criterion) => {
    const own = valid.filter((evidence) => evidence.criterionId === criterion.id);
    return { criterionId: criterion.id, status: mechanicalCriterionStatus(own), evidenceIds: own.map((evidence) => evidence.id) };
  });

  const collectedAt = latest(startedAt, options.now().toISOString(), ...valid.map((evidence) => evidence.consultedAt));
  const profile = place ? profileSummary(place) : null;
  // `provenIdentifiers` = identificadores efetivamente COMPARADOS com o retorno do provedor e confirmados
  // (o CID pode ser derivado do FID do link; isso fica registrado em `identifiers.confirmed[].expectedOrigin`).
  const provenIdentifiers: MapsIdentifiers = {
    ...(confirmedIds.find((entry) => entry.type === 'cid') ? { cid: (confirmedIds.find((entry) => entry.type === 'cid') as ConfirmedIdentifier).value } : {}),
    ...(confirmedIds.find((entry) => entry.type === 'featureId') ? { featureId: ids.featureId as string } : {}),
    ...(confirmedIds.find((entry) => entry.type === 'placeId') ? { placeId: ids.placeId as string } : {}),
  };
  const derivedCid = expected.cid?.origin === 'DERIVED_FROM_FID' ? expected.cid.value : undefined;
  const identifiers: IdentifierReport = {
    fromLink: { ...ids },
    derived: derivedCid ? { cid: { value: derivedCid, derivedFrom: 'featureId', method: 'hex-suffix-to-decimal-bigint' } } : {},
    returnedByProvider: returnedIds ? { ...returnedIds } : null,
    confirmed: confirmedIds,
  };
  const found: Divergence[] = computeDivergences(profile, siteSummary, siteTelLinks);
  const result: CollectionResult = {
    evidences: valid,
    criteria,
    limitations: [...new Set(limitations)].map((text) => text.slice(0, 1900)),
    usage,
    located,
    collectedAt,
    provenIdentifiers,
    identityBasis: { expectedCid: expected.cid ?? null, matchedBy },
    identifiers,
    profile,
    siteObservation: siteSummary,
    divergences: found,
    queriedAt: { maps: mapsFetchedAt, site: siteSummary?.checkedAt ?? null },
  };
  return { ok: true, result };
}

/** Monta o rascunho de snapshot (Onda 2) a partir do resultado. Não grava nada. */
export function toSnapshotDraft(input: CollectionInput, result: CollectionResult, frozenAt: string): SnapshotDraft {
  const confirmedAt = input.identity.confirmation?.confirmedAt ?? frozenAt;
  return {
    snapshotId: input.snapshotId,
    collectedAt: result.collectedAt,
    frozenAt: latest(frozenAt, result.collectedAt, confirmedAt),
    link: { originalLink: input.link.originalLink, resolved: input.link.resolved },
    identity: input.identity,
    evidences: [...result.evidences],
    criteria: [...result.criteria],
    limitations: [...result.limitations],
  };
}
