import type { MapsIdentifiers } from './maps-link';

/*
 * Identificadores do Google Maps: conversão offline entre FID e CID (Onda 4C). Módulo PURO.
 *
 * O FID tem a forma `0x<prefixo>:0x<sufixo>`. O sufixo, lido como inteiro de 64 bits sem sinal, é o CID
 * (decimal). O prefixo muda com o tempo e pode ser `0x0` em links sem localização; por isso ele NUNCA entra
 * na comparação. Toda aritmética usa BigInt: os CIDs passam de 2^53 e `Number` perderia dígitos.
 *
 * O CID obtido do FID é DERIVADO: não foi devolvido por nenhuma API e é sempre rotulado assim. O Place ID
 * (`ChIJ…`) não tem relação matemática com FID/CID e nunca é derivado.
 */

export const MAX_UINT64 = (1n << 64n) - 1n;
const FEATURE_ID = /^0x([0-9a-f]{1,16}):0x([0-9a-f]{1,16})$/;
const DECIMAL = /^[0-9]{1,20}$/;

export type CidResult = { readonly ok: true; readonly cid: string } | { readonly ok: false; readonly reason: string };

/** CID decimal canônico (sem zeros à esquerda; 1 ≤ valor ≤ 2^64−1). Só dígitos: sem sinal, ponto, espaço ou notação científica. */
export function normalizeCid(value: unknown): CidResult {
  if (typeof value !== 'string') return { ok: false, reason: 'o CID deve ser texto (número perderia precisão)' };
  if (!DECIMAL.test(value)) return { ok: false, reason: 'o CID deve ter de 1 a 20 dígitos decimais, sem sinal, espaço ou ponto' };
  const parsed = BigInt(value);
  if (parsed === 0n) return { ok: false, reason: 'o CID não pode ser zero' };
  if (parsed > MAX_UINT64) return { ok: false, reason: 'o CID excede 64 bits' };
  return { ok: true, cid: parsed.toString(10) };
}

export interface FeatureIdParts {
  /** Original, em minúsculas e inalterado. */
  readonly featureId: string;
  readonly prefixHex: string;
  readonly suffixHex: string;
}

export function featureIdParts(value: unknown): FeatureIdParts | null {
  if (typeof value !== 'string') return null;
  const lowered = value.toLowerCase();
  const match = FEATURE_ID.exec(lowered);
  if (!match) return null;
  return { featureId: lowered, prefixHex: match[1] as string, suffixHex: match[2] as string };
}

export interface DerivedCid {
  readonly ok: true;
  readonly cid: string;
  readonly origin: 'DERIVED_FROM_FID';
  readonly derivedFrom: 'featureId';
  readonly method: 'hex-suffix-to-decimal-bigint';
  /** O FID de que veio, sem alteração. */
  readonly featureId: string;
}

export function deriveCidFromFeatureId(value: unknown): DerivedCid | { readonly ok: false; readonly reason: string } {
  const parts = featureIdParts(value);
  if (!parts) return { ok: false, reason: 'o FID deve ter a forma 0x<hex>:0x<hex> (até 16 dígitos hexadecimais em cada parte)' };
  const parsed = BigInt(`0x${parts.suffixHex}`);
  if (parsed === 0n) return { ok: false, reason: 'a segunda parte do FID é zero: não há CID' };
  if (parsed > MAX_UINT64) return { ok: false, reason: 'a segunda parte do FID excede 64 bits' };
  return { ok: true, cid: parsed.toString(10), origin: 'DERIVED_FROM_FID', derivedFrom: 'featureId', method: 'hex-suffix-to-decimal-bigint', featureId: parts.featureId };
}

export type CidOrigin = 'LINK' | 'DERIVED_FROM_FID';

export interface ExpectedIdentity {
  /** CID esperado (decimal canônico) e de onde ele vem. */
  readonly cid?: { readonly value: string; readonly origin: CidOrigin };
  readonly placeId?: string;
  readonly featureId?: string;
  /** Link com `cid` e `fid` que não se correspondem: a coleta deve ser recusada. */
  readonly conflict?: string;
}

/** Identidade esperada a partir do que o link trouxe. Não altera nem substitui os identificadores originais. */
export function buildExpectedIdentity(identifiers: MapsIdentifiers): ExpectedIdentity {
  const explicit = identifiers.cid !== undefined ? normalizeCid(identifiers.cid) : null;
  const derived = identifiers.featureId !== undefined ? deriveCidFromFeatureId(identifiers.featureId) : null;
  if (explicit && !explicit.ok) return { conflict: `cid do link inválido: ${explicit.reason}` };
  if (identifiers.featureId !== undefined && derived && !derived.ok) return { conflict: `fid do link inválido: ${derived.reason}` };
  if (explicit?.ok && derived?.ok && explicit.cid !== derived.cid) {
    return { conflict: 'o cid e o fid do link não correspondem à mesma empresa' };
  }
  const cid = explicit?.ok
    ? { value: explicit.cid, origin: 'LINK' as const }
    : derived?.ok
      ? { value: derived.cid, origin: 'DERIVED_FROM_FID' as const }
      : undefined;
  return {
    ...(cid ? { cid } : {}),
    ...(identifiers.placeId !== undefined ? { placeId: identifiers.placeId } : {}),
    ...(identifiers.featureId !== undefined ? { featureId: identifiers.featureId.toLowerCase() } : {}),
  };
}

export type PlaceCid =
  | { readonly state: 'NONE' }
  | { readonly state: 'CONTRADICTORY'; readonly reason: string }
  | { readonly state: 'OK'; readonly cid: string; readonly source: 'cid' | 'fid' | 'cid+fid' };

/** CID de um resultado do provedor: o `cid` informado e/ou o derivado do `fid` DELE; se ambos existem, têm de concordar. */
export function placeEntityCid(identifiers: MapsIdentifiers): PlaceCid {
  const explicit = identifiers.cid !== undefined ? normalizeCid(identifiers.cid) : null;
  const derived = identifiers.featureId !== undefined ? deriveCidFromFeatureId(identifiers.featureId) : null;
  if (explicit && !explicit.ok) return { state: 'CONTRADICTORY', reason: 'cid do resultado inválido' };
  if (derived && !derived.ok) return { state: 'CONTRADICTORY', reason: 'fid do resultado inválido' };
  if (explicit?.ok && derived?.ok) {
    return explicit.cid === derived.cid
      ? { state: 'OK', cid: explicit.cid, source: 'cid+fid' }
      : { state: 'CONTRADICTORY', reason: 'o cid e o fid do próprio resultado não correspondem' };
  }
  if (explicit?.ok) return { state: 'OK', cid: explicit.cid, source: 'cid' };
  if (derived?.ok) return { state: 'OK', cid: derived.cid, source: 'fid' };
  return { state: 'NONE' };
}
