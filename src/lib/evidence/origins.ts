import type { BattlefieldMetrics, FrontierLead, ReputationMetrics, VitrineMetrics } from '@/types/gmn';

/**
 * Reconhecimento de dados simulados ou com valor padrão em resultados persistidos.
 *
 * Auditorias anteriores à Fase 4 (e o modo demonstração) deixaram marcadores nos payloads. A
 * detecção é a rede de segurança para NUNCA tratar esses dados como evidência real, mesmo quando
 * um relatório ou um reprocessamento os lê de novo. Auditorias novas carregam a origem explícita.
 */
export type DataOrigin = 'COLLECTED' | 'SIMULATED' | 'NOT_VERIFIED';

/** Autores fictícios do fallback do agente de Reputação (`reputation-agent.ts`). */
const FALLBACK_REVIEW_AUTHORS: ReadonlySet<string> = new Set([
  'Carlos Eduardo M.',
  'Fernanda Peixoto',
  'Marcos Vinícius S.',
  'Juliana Borges',
  'Roberto Alencar',
  'Patrícia Gomes',
  'Henrique Teixeira',
  'Camila Rocha',
  'André Luiz F.',
  'Luciana Martins',
]);

/** Prefixo dos ids de líderes do fallback do Battlefield (`battlefield-agent.ts`). */
const FALLBACK_LEADER_PREFIX = 'ChIJ_RIVAL_DOMINATOR_';

export function detectReputationOrigin(reputation: ReputationMetrics, placeId: string): DataOrigin {
  const sample = Array.isArray(reputation?.recentReviewsSample) ? reputation.recentReviewsSample : [];
  if (sample.length === 0) return 'NOT_VERIFIED';
  const prefix = `rev_${placeId}_`;
  const allFallbackIds = sample.every(
    (review) => typeof review.reviewId === 'string' && review.reviewId.startsWith(prefix)
  );
  const knownFakeAuthor = sample.some((review) => FALLBACK_REVIEW_AUTHORS.has(review.authorName));
  return allFallbackIds || knownFakeAuthor ? 'SIMULATED' : 'COLLECTED';
}

export function detectVitrineOrigin(vitrine: VitrineMetrics, placeId: string): DataOrigin {
  const sample = Array.isArray(vitrine?.mediaGallerySample) ? vitrine.mediaGallerySample : [];
  if (sample.length === 0) return 'NOT_VERIFIED';
  const prefix = `med_${placeId}_`;
  return sample.some((media) => typeof media.mediaId === 'string' && media.mediaId.startsWith(prefix))
    ? 'SIMULATED'
    : 'COLLECTED';
}

export function detectBattlefieldOrigin(battlefield: BattlefieldMetrics): DataOrigin {
  const points = Array.isArray(battlefield?.points) ? battlefield.points : [];
  if (points.length === 0) return 'NOT_VERIFIED';
  const simulated = points.some((point) => point.pointLeader?.placeId?.startsWith(FALLBACK_LEADER_PREFIX));
  return simulated ? 'SIMULATED' : 'COLLECTED';
}

/** Nota/avaliações iguais aos valores padrão dos prospectores indicam dado ausente na coleta. */
export function leadRatingIsDefault(lead: FrontierLead): boolean {
  return (
    (lead.rating === 4.5 && lead.totalReviews === 15) || (lead.rating === 4.4 && lead.totalReviews === 18)
  );
}

/**
 * Valores ausentes (`null`) ou iguais ao valor padrão histórico (nota 4,8 com 140 avaliações, que o
 * Battlefield usava quando o líder não trazia dados) não servem de evidência.
 */
export function leaderValuesAreDefault(rating: number | null, totalReviews: number | null): boolean {
  return rating === null || totalReviews === null || (rating === 4.8 && totalReviews === 140);
}
