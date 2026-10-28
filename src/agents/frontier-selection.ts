/**
 * Seleciona estabelecimentos reais e distintos, mantendo a prioridade da fronteira
 * do Google Maps (posições 15-28). Somente se necessário, continua até a posição
 * 40 para substituir resultados repetidos ou sem identificador confiável.
 */
export function selectUniqueFrontierListings<
  T extends { readonly place_id: string; readonly cid?: string; readonly rank_absolute: number },
>(listings: readonly T[], desiredCount = 10): T[] {
  if (!Number.isInteger(desiredCount) || desiredCount < 1) {
    throw new RangeError('desiredCount precisa ser um inteiro positivo');
  }

  const candidates = listings
    .filter(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.place_id === 'string' &&
        item.place_id.trim().length > 0 &&
        Number.isInteger(item.rank_absolute) &&
        item.rank_absolute >= 1 &&
        item.rank_absolute <= 40
    )
    .sort((a, b) => a.rank_absolute - b.rank_absolute);

  const seenPlaceIds = new Set<string>();
  const seenCids = new Set<string>();
  const selected: T[] = [];

  for (const listing of candidates) {
    const placeId = listing.place_id.trim();
    const cid = listing.cid?.trim();

    if (seenPlaceIds.has(placeId) || (cid && seenCids.has(cid))) {
      continue;
    }

    // Um resultado repetido na segunda página não pode ser tratado como
    // empresa de fronteira quando já apareceu entre os primeiros 14 lugares.
    seenPlaceIds.add(placeId);
    if (cid) seenCids.add(cid);
    if (listing.rank_absolute < 15) continue;

    selected.push(listing);
    if (selected.length === desiredCount) {
      break;
    }
  }

  return selected;
}
