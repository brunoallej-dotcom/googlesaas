import type {
  BattlefieldMetrics,
  FrontierLead,
  ReputationMetrics,
  RivalsMetrics,
  TerritoryDominatorProfile,
  VitrineMetrics,
} from '@/types/gmn';
import { StructuredLogger } from '@/lib/logger';

interface AggregatedLeaderCounter {
  readonly placeId: string;
  readonly businessName: string;
  readonly primaryCategory: string;
  rating: number | null;
  totalReviews: number | null;
  readonly hasWebsite: boolean;
  pointsWon: number;
}

/**
 * ============================================================================
 * AGENTE 4: RIVAIS
 * Compara o perfil auditado diretamente com os verdadeiros dominadores do
 * território identificados no Campo de Batalha (#1 de cada ponto válido da grade),
 * evitando distorções de categorias genéricas.
 * ============================================================================
 */
export class RivalsAgent {
  private readonly logger = new StructuredLogger('RIVALS');

  public async analyze(params: {
    readonly auditId: string;
    readonly lead: FrontierLead;
    readonly battlefield: BattlefieldMetrics;
    readonly reputation: ReputationMetrics;
    readonly vitrine: VitrineMetrics;
  }): Promise<RivalsMetrics> {
    this.logger.info('Iniciando consolidação dos dominadores reais do território', {
      auditId: params.auditId,
      placeId: params.lead.placeId,
      validGridPoints: params.battlefield.validPointsCount,
    });

    const leaderMap = new Map<string, AggregatedLeaderCounter>();

    for (const point of params.battlefield.points) {
      if (point.readStatus !== 'VALID' || !point.pointLeader) {
        continue;
      }

      const leader = point.pointLeader;
      if (leader.placeId === params.lead.placeId) {
        continue;
      }

      const existing = leaderMap.get(leader.placeId);
      if (existing) {
        existing.pointsWon += 1;
        // Mantém o primeiro valor real informado; nunca preenche com padrão.
        existing.rating ??= leader.rating;
        existing.totalReviews ??= leader.totalReviews;
      } else {
        leaderMap.set(leader.placeId, {
          placeId: leader.placeId,
          businessName: leader.businessName,
          primaryCategory: leader.primaryCategory,
          rating: leader.rating,
          totalReviews: leader.totalReviews,
          hasWebsite: leader.hasWebsite,
          pointsWon: 1,
        });
      }
    }

    const sortedLeaders = Array.from(leaderMap.values()).sort(
      (a, b) => b.pointsWon - a.pointsWon || (b.totalReviews ?? 0) - (a.totalReviews ?? 0)
    );

    const safeValidPoints = Math.max(1, params.battlefield.validPointsCount);

    const ownReviews = params.reputation.totalReviews;
    const ownRating = params.reputation.averageRating;

    // Somente dados observados: pontos liderados, nota e avaliações da listagem pública do líder.
    // Fotos, ritmo de avaliações e taxa de resposta dos rivais não têm fonte e ficam nulos.
    const topDominators: TerritoryDominatorProfile[] = sortedLeaders
      .slice(0, 3)
      .map((item, idx): TerritoryDominatorProfile => {
        const rankPosition = (idx + 1) as 1 | 2 | 3;
        const dominanceSharePercent = Number(
          ((item.pointsWon / safeValidPoints) * 100).toFixed(1)
        );
        const reviewsGap = item.totalReviews !== null ? item.totalReviews - ownReviews : null;
        const ratingGap = item.rating !== null ? Number((item.rating - ownRating).toFixed(2)) : null;

        return {
          rankPosition,
          placeId: item.placeId,
          businessName: item.businessName,
          primaryCategory: item.primaryCategory,
          pointsWonAsNumberOne: item.pointsWon,
          dominanceSharePercent,
          rating: item.rating,
          totalReviews: item.totalReviews,
          estimatedReviewsLast30Days: null,
          ownerResponseRatePercent: null,
          totalPhotosCount: null,
          hasOwnWebsite: item.hasWebsite,
          gapAnalysisVsTarget: {
            reviewsGap,
            ratingGap,
            photosGap: null,
            primaryAdvantageSummary:
              reviewsGap !== null && reviewsGap > 0
                ? `Lidera ${item.pointsWon} pontos da grade; tem ${reviewsGap} avaliações a mais que a empresa auditada (dado da listagem pública).`
                : `Lidera ${item.pointsWon} pontos da grade.`,
          },
        };
      });

    const topLeader = topDominators[0];
    const leaderReviewsText =
      topLeader?.totalReviews !== null && topLeader?.totalReviews !== undefined
        ? ` com ${topLeader.totalReviews} avaliações contra ${ownReviews} do perfil auditado`
        : '';
    const competitiveGapHeadline = topLeader
      ? `O líder territorial "${topLeader.businessName}" lidera ${topLeader.pointsWonAsNumberOne} dos ${params.battlefield.validPointsCount} pontos válidos (${topLeader.dominanceSharePercent}% da grade)${leaderReviewsText}.`
      : `Nenhum concorrente líder foi identificado nos pontos com leitura válida.`;

    const result: RivalsMetrics = {
      placeId: params.lead.placeId,
      totalUniqueLeadersIdentified: sortedLeaders.length,
      genericDirectoriesFilteredCount: 0,
      topDominators,
      competitiveGapHeadline,
      extractedAt: new Date().toISOString(),
    };

    this.logger.info('Análise comparativa de Rivais concluída', {
      auditId: params.auditId,
      topRival: topLeader?.businessName ?? 'N/A',
      topRivalPointsWon: topLeader?.pointsWonAsNumberOne ?? 0,
    });

    return result;
  }
}

export const rivalsAgent = new RivalsAgent();
