import { haversineMeters } from '@/lib/battlefield-map-utils';

/**
 * Compatibilidade entre rodadas do Campo de Batalha.
 *
 * Só se compara uma rodada com outra quando ambas medem a mesma coisa: mesma empresa e palavra-chave
 * (garantidas na consulta), mesmo centro, zoom e passo da grade, cobertura de leituras comparável e
 * dados reais. Qualquer diferença vira uma limitação explícita; nunca se inventa evolução.
 */
export const CENTER_TOLERANCE_METERS = 50;
export const MIN_COMPARABLE_VALID_POINTS = 40;

export interface RoundSnapshot {
  readonly roundId: string;
  readonly executedAt: string;
  readonly greenTop3Count: number;
  readonly averagePosition: number;
  readonly centerLat: number | null;
  readonly centerLng: number | null;
  readonly zoomLevel: string | null;
  readonly stepMeters: number | null;
  readonly validPointsCount: number | null;
  /** `true` quando a rodada contém líderes do fallback simulado. */
  readonly simulated: boolean;
}

export interface CurrentRoundParams {
  readonly executedAt: string;
  readonly centerLat: number;
  readonly centerLng: number;
  readonly zoomLevel: string;
  readonly stepMeters: number;
  readonly validPointsCount: number;
}

export type Compatibility = { readonly compatible: true } | { readonly compatible: false; readonly reason: string };

export function evaluateRoundCompatibility(previous: RoundSnapshot, current: CurrentRoundParams): Compatibility {
  if (previous.simulated) return { compatible: false, reason: 'A rodada anterior usou dados simulados.' };
  if (Date.parse(previous.executedAt) >= Date.parse(current.executedAt)) {
    return { compatible: false, reason: 'A rodada anterior não é anterior à atual.' };
  }
  if (previous.centerLat === null || previous.centerLng === null || previous.zoomLevel === null || previous.stepMeters === null) {
    return { compatible: false, reason: 'A rodada anterior não registrou os parâmetros da grade (centro, zoom ou passo).' };
  }
  const distance = haversineMeters(
    { latitude: previous.centerLat, longitude: previous.centerLng },
    { latitude: current.centerLat, longitude: current.centerLng }
  );
  if (distance > CENTER_TOLERANCE_METERS) {
    return { compatible: false, reason: `O centro da grade mudou (${Math.round(distance)} m de diferença).` };
  }
  if (previous.zoomLevel !== current.zoomLevel) {
    return { compatible: false, reason: `O zoom da consulta mudou (${previous.zoomLevel} → ${current.zoomLevel}).` };
  }
  if (previous.stepMeters !== current.stepMeters) {
    return { compatible: false, reason: `O espaçamento da grade mudou (${previous.stepMeters} m → ${current.stepMeters} m).` };
  }
  if ((previous.validPointsCount ?? 0) < MIN_COMPARABLE_VALID_POINTS || current.validPointsCount < MIN_COMPARABLE_VALID_POINTS) {
    return { compatible: false, reason: `Cobertura de leituras insuficiente para comparar (mínimo de ${MIN_COMPARABLE_VALID_POINTS} pontos válidos em cada rodada).` };
  }
  return { compatible: true };
}

export interface CompatibleSelection {
  readonly round: RoundSnapshot | null;
  /** Motivo pelo qual existe histórico, mas ele não foi usado. `null` quando não há histórico. */
  readonly incompatibleReason: string | null;
}

/** Escolhe a rodada anterior compatível mais recente (candidatas em ordem do mais recente). */
export function selectCompatibleRound(candidates: readonly RoundSnapshot[], current: CurrentRoundParams): CompatibleSelection {
  if (candidates.length === 0) return { round: null, incompatibleReason: null };
  let firstReason: string | null = null;
  for (const candidate of candidates) {
    const result = evaluateRoundCompatibility(candidate, current);
    if (result.compatible) return { round: candidate, incompatibleReason: null };
    firstReason ??= result.reason;
  }
  return { round: null, incompatibleReason: firstReason };
}
