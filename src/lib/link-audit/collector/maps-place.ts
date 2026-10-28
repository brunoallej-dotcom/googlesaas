import { buildExpectedIdentity, deriveCidFromFeatureId, normalizeCid, placeEntityCid, type CidOrigin } from '../identifiers';
import type { MapsIdentifiers } from '../maps-link';
import { redactFreeText } from '../url-redaction';

/*
 * Leitor defensivo de itens do Serper /maps e casamento por identificador. Só confia no que tem o tipo
 * esperado; campos desconhecidos são ignorados. O casamento usa EXCLUSIVAMENTE identificadores: um nome
 * parecido nunca identifica a empresa.
 */

export interface MapsPlace {
  readonly title: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly category: string | null;
  readonly secondaryCategories: readonly string[];
  readonly rating: number | null;
  readonly ratingCount: number | null;
  readonly openingHours: readonly (readonly [string, string])[];
  readonly identifiers: MapsIdentifiers;
  /** O provedor mandou cid/fid/placeId presente mas inválido (descartado): o resultado não é confiável para confirmar identidade. */
  readonly identifierInvalid: boolean;
}

const FEATURE_ID = /^0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16}$/i;
const PLACE_ID = /^[A-Za-z0-9_-]{20,255}$/;
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Texto de fonte externa: sem controle/bidi, sem segredos reconhecíveis, espaços normalizados e tamanho limitado. */
export function cleanText(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = redactFreeText(value.replace(CONTROL_OR_BIDI, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).trim();
  return cleaned.length > 0 ? cleaned : null;
}

const own = (item: Record<string, unknown>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(item, key) ? item[key] : undefined;

function identifierText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

export function parseMapsPlace(raw: unknown): MapsPlace | null {
  const item = record(raw);
  if (!item) return null;

  const cidRaw = identifierText(own(item, 'cid'));
  const fidRaw = identifierText(own(item, 'fid')) ?? identifierText(own(item, 'featureId'));
  const placeRaw = identifierText(own(item, 'placeId'));
  const identifiers: MapsIdentifiers = {
    ...(cidRaw && ((canon) => canon.ok)(normalizeCid(cidRaw)) ? { cid: (normalizeCid(cidRaw) as { cid: string }).cid } : {}),
    ...(fidRaw && FEATURE_ID.test(fidRaw) ? { featureId: fidRaw.toLowerCase() } : {}),
    ...(placeRaw && PLACE_ID.test(placeRaw) ? { placeId: placeRaw } : {}),
  };

  const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '';
  const identifierInvalid =
    (present(own(item, 'cid')) && identifiers.cid === undefined) ||
    ((present(own(item, 'fid')) || present(own(item, 'featureId'))) && identifiers.featureId === undefined) ||
    (present(own(item, 'placeId')) && identifiers.placeId === undefined);

  const ratingRaw = own(item, 'rating');
  const countRaw = own(item, 'ratingCount');
  const rating = typeof ratingRaw === 'number' && Number.isFinite(ratingRaw) && ratingRaw >= 0 && ratingRaw <= 5 ? ratingRaw : null;
  const ratingCount = typeof countRaw === 'number' && Number.isInteger(countRaw) && countRaw >= 0 ? countRaw : null;

  const typesRaw = own(item, 'types');
  const types = Array.isArray(typesRaw) ? typesRaw.map((entry) => cleanText(entry, 120)).filter((entry): entry is string => entry !== null) : [];
  const category = cleanText(own(item, 'type'), 120);

  const hoursRecord = record(own(item, 'openingHours'));
  const openingHours: Array<readonly [string, string]> = [];
  if (hoursRecord) {
    for (const [day, value] of Object.entries(hoursRecord).slice(0, 14)) {
      const dayText = cleanText(day, 30);
      const valueText = cleanText(value, 60);
      if (dayText && valueText) openingHours.push([dayText, valueText]);
    }
  }

  return {
    title: cleanText(own(item, 'title'), 200),
    address: cleanText(own(item, 'address'), 300),
    phone: cleanText(own(item, 'phoneNumber'), 40),
    website: ((site) => (typeof site === 'string' && site.trim().length > 0 && site.length <= 2048 ? site.trim() : null))(own(item, 'website')),
    category,
    secondaryCategories: types.filter((entry) => entry !== category).slice(0, 10),
    rating,
    ratingCount,
    openingHours,
    identifiers,
    identifierInvalid,
  };
}

export function parseMapsPlaces(raw: readonly unknown[]): { readonly places: readonly MapsPlace[]; readonly ignored: number } {
  const places: MapsPlace[] = [];
  for (const entry of raw.slice(0, 100)) {
    const place = parseMapsPlace(entry);
    if (place) places.push(place);
  }
  return { places, ignored: raw.length - places.length };
}

export type MatchResult =
  | { readonly state: 'MATCHED'; readonly place: MapsPlace; readonly basis: MatchBasis }
  | { readonly state: 'NOT_LOCATED' }
  | { readonly state: 'AMBIGUOUS'; readonly reason: string };

/** Por qual identificador o perfil foi aceito (nunca por nome). */
export interface MatchBasis {
  readonly provenCid: string | null;
  readonly cid: boolean;
  readonly placeId: boolean;
  /** CID esperado: veio do link ou foi derivado do FID? */
  readonly expectedCidOrigin: CidOrigin | null;
  /** CID do resultado: informado, derivado do `fid` dele ou ambos. */
  readonly resultCidSource: 'cid' | 'fid' | 'cid+fid' | null;
}

/**
 * Casa pelo(s) identificador(es) confirmado(s) pelo operador. A chave de entidade é o CID (BigInt): o do link
 * (ou derivado do FID dele) contra o `cid` do resultado e/ou o derivado do `fid` DELE. Prefixos diferentes do
 * FID são equivalentes quando o CID é o mesmo. O `placeId` só casa por igualdade exata (nunca é derivado).
 * Candidato = pelo menos um identificador igual. Um candidato com identificador DIFERENTE em outro campo, ou um
 * resultado cujos próprios identificadores se contradizem, é contraditório; dois negócios distintos casando
 * tornam o resultado ambíguo: nesses casos nada é escolhido. Nome nunca confirma.
 */
export function matchPlace(places: readonly MapsPlace[], wanted: MapsIdentifiers): MatchResult {
  const expected = buildExpectedIdentity(wanted);
  if (expected.conflict) return { state: 'AMBIGUOUS', reason: `Identidade esperada inconsistente: ${expected.conflict}.` };
  const wantedCid = expected.cid?.value;
  const candidates: Array<{ place: MapsPlace; key: string; basis: MatchBasis }> = [];

  for (const place of places) {
    const entity = placeEntityCid(place.identifiers);
    const placeIdEqual = expected.placeId !== undefined && place.identifiers.placeId === expected.placeId;
    const placeIdDiffers = expected.placeId !== undefined && place.identifiers.placeId !== undefined && place.identifiers.placeId !== expected.placeId;

    if (place.identifierInvalid && ((entity.state === 'OK' && wantedCid !== undefined && entity.cid === wantedCid) || placeIdEqual)) {
      return { state: 'AMBIGUOUS', reason: 'Um resultado traz um identificador inválido ao lado de outro que casa: o perfil não pôde ser escolhido.' };
    }
    if (entity.state === 'CONTRADICTORY') {
      // Só importa se o resultado parece ser a empresa procurada por algum dos seus identificadores.
      const explicit = place.identifiers.cid !== undefined ? normalizeCid(place.identifiers.cid) : null;
      const derived = place.identifiers.featureId !== undefined ? deriveCidFromFeatureId(place.identifiers.featureId) : null;
      const touches =
        placeIdEqual ||
        (wantedCid !== undefined && ((explicit?.ok === true && explicit.cid === wantedCid) || (derived?.ok === true && derived.cid === wantedCid)));
      if (touches) return { state: 'AMBIGUOUS', reason: 'Um resultado tem identificadores que se contradizem entre si: o perfil não pôde ser escolhido.' };
      continue;
    }

    const cidEqual = entity.state === 'OK' && wantedCid !== undefined && entity.cid === wantedCid;
    const cidDiffers = entity.state === 'OK' && wantedCid !== undefined && entity.cid !== wantedCid;
    if (!cidEqual && !placeIdEqual) continue;
    if (cidDiffers || placeIdDiffers) {
      return { state: 'AMBIGUOUS', reason: 'Um resultado casa por um identificador e contradiz outro: o perfil não pôde ser escolhido.' };
    }
    candidates.push({
      place,
      key: entity.state === 'OK' ? entity.cid : (place.identifiers.placeId ?? ''),
      basis: {
        provenCid: cidEqual && entity.state === 'OK' ? entity.cid : null,
        cid: cidEqual,
        placeId: placeIdEqual,
        expectedCidOrigin: expected.cid?.origin ?? null,
        resultCidSource: entity.state === 'OK' ? entity.source : null,
      },
    });
  }
  if (candidates.length === 0) return { state: 'NOT_LOCATED' };

  const distinct = new Set(candidates.map((candidate) => candidate.key));
  if (distinct.size > 1) {
    return { state: 'AMBIGUOUS', reason: 'Mais de um negócio distinto casa com os identificadores: nenhum foi escolhido.' };
  }
  const first = candidates[0] as (typeof candidates)[number];
  return { state: 'MATCHED', place: first.place, basis: first.basis };
}

/** O resultado tem algum identificador do mesmo tipo do esperado (CID, direto ou pelo `fid`, ou placeId)? */
export function hasComparableIdentifier(place: MapsPlace, wanted: MapsIdentifiers): boolean {
  const expected = buildExpectedIdentity(wanted);
  const entity = placeEntityCid(place.identifiers);
  return (expected.cid !== undefined && entity.state !== 'NONE') || (expected.placeId !== undefined && place.identifiers.placeId !== undefined);
}
