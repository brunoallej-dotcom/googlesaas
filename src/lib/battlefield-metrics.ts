/**
 * Métricas territoriais do Campo de Batalha: uma única implementação, usada pelo agente,
 * pelo adaptador do mapa, pelo dashboard e pelo PDF.
 *
 * Convenção histórica preservada: pontos acima do Top 20 entram na média com o valor 21.
 * Isso é um ÍNDICE limitado, não a posição real. As posições efetivamente lidas (1 a 20)
 * têm média própria, e cada indicador informa o denominador usado.
 */
export const TOP20_LIMIT = 20;
export const OUTSIDE_TOP20_INDEX = 21;
export const GRID_POINTS = 49;

export interface RankedPoint {
  readonly readStatus: 'VALID' | 'UNREADABLE';
  readonly targetRank: number | null;
}

export interface TerritoryRankMetrics {
  /** Pontos da grade informados (esperado 49). */
  readonly totalPoints: number;
  /** Denominador de todos os percentuais: pontos com leitura válida. */
  readonly validPoints: number;
  /** Sem leitura: fora de qualquer média (diferente de "fora do Top 20"). */
  readonly unreadablePoints: number;
  /** Posição conhecida (1 a 20). */
  readonly knownPositionPoints: number;
  /** Lidos com sucesso, mas a empresa não apareceu entre as 20 primeiras. */
  readonly outsideTop20Points: number;
  readonly top3Points: number;
  readonly top7Points: number;
  readonly top20Points: number;
  /** Média limitada: posições 1 a 20 e 21 para "fora do Top 20". `null` sem leitura válida. */
  readonly rankIndexAverage: number | null;
  /** Média apenas das posições efetivamente conhecidas. `null` se nenhuma. */
  readonly knownPositionAverage: number | null;
  readonly top3Percent: number | null;
  readonly top7Percent: number | null;
  readonly top20Percent: number | null;
  readonly outsideTop20Percent: number | null;
  readonly gridComplete: boolean;
}

const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : null;

const isKnownRank = (rank: number | null): rank is number =>
  typeof rank === 'number' && Number.isFinite(rank) && rank >= 1 && rank <= TOP20_LIMIT;

export function computeTerritoryRankMetrics(points: readonly RankedPoint[]): TerritoryRankMetrics {
  const valid = points.filter((point) => point.readStatus === 'VALID');
  const unreadable = points.length - valid.length;
  const known = valid.filter((point) => isKnownRank(point.targetRank));
  const knownRanks = known.map((point) => point.targetRank as number);

  const top3 = knownRanks.filter((rank) => rank <= 3).length;
  const top7 = knownRanks.filter((rank) => rank <= 7).length;
  const outside = valid.length - known.length;

  const indexSum = knownRanks.reduce((sum, rank) => sum + rank, 0) + outside * OUTSIDE_TOP20_INDEX;
  const knownSum = knownRanks.reduce((sum, rank) => sum + rank, 0);

  return {
    totalPoints: points.length,
    validPoints: valid.length,
    unreadablePoints: unreadable,
    knownPositionPoints: known.length,
    outsideTop20Points: outside,
    top3Points: top3,
    top7Points: top7,
    top20Points: known.length,
    rankIndexAverage: valid.length > 0 ? Number((indexSum / valid.length).toFixed(2)) : null,
    knownPositionAverage: known.length > 0 ? Number((knownSum / known.length).toFixed(2)) : null,
    top3Percent: pct(top3, valid.length),
    top7Percent: pct(top7, valid.length),
    top20Percent: pct(known.length, valid.length),
    outsideTop20Percent: pct(outside, valid.length),
    gridComplete: points.length === GRID_POINTS && unreadable === 0,
  };
}

export const RANK_INDEX_LABEL = 'Índice de posição (fora do Top 20 = 21)';
export const RANK_INDEX_HINT =
  'Média limitada: posições 1 a 20 e o valor 21 para pontos em que a empresa não aparece entre as 20 primeiras. Não é a posição real nesses pontos.';
export const KNOWN_POSITION_LABEL = 'Posição média nos pontos do Top 20';
