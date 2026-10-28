import type { FrontierLead, ReputationMetrics } from '@/types/gmn';
import { StructuredLogger } from '@/lib/logger';
import {
  analyzeReviewSample,
  deriveServiceTerms,
  fetchSerperReviews,
  readSerperReviewsConfig,
  type ReviewsFetcher,
  type SerperReviewsConfig,
} from '@/lib/serper-reviews';

/**
 * ============================================================================
 * AGENTE 1: REPUTAÇÃO
 * Nota e total de avaliações vêm da listagem pública (lead). Ritmo de avaliações em 30 dias,
 * taxa de resposta do proprietário e termos de serviço só são calculados com avaliações REAIS,
 * datadas, vindas de um provedor habilitado (Serper Reviews, desligado por padrão).
 *
 * Sem essa fonte, os indicadores ficam `null` com o motivo registrado: nada é simulado, estimado
 * a partir de totais históricos, nem preenchido com valores de aparência real.
 * ============================================================================
 */
export class ReputationAgent {
  private readonly logger = new StructuredLogger('REPUTATION');

  public async analyze(
    lead: FrontierLead,
    auditId: string,
    deps: { readonly config?: SerperReviewsConfig; readonly fetcher?: ReviewsFetcher; readonly now?: () => Date } = {}
  ): Promise<ReputationMetrics> {
    const now = deps.now ?? (() => new Date());
    this.logger.info('Iniciando coleta de reputação', {
      auditId,
      placeId: lead.placeId,
      businessName: lead.businessName,
    });

    const config = deps.config ?? readSerperReviewsConfig();
    const outcome = await fetchSerperReviews(
      { featureId: lead.featureId, placeId: lead.placeId, cid: lead.cid },
      config,
      deps.fetcher,
      now
    );

    let availability: NonNullable<ReputationMetrics['reviewsAvailability']>;
    let interactionsLast30Days: number | null = null;
    let ownerResponseRatePercent: number | null = null;

    if (outcome.state === 'FETCHED') {
      const analysis = analyzeReviewSample({
        reviews: outcome.reviews,
        profileTotalReviews: lead.totalReviews > 0 ? lead.totalReviews : (outcome.totalReported ?? null),
        exhausted: outcome.exhausted,
        serviceTerms: deriveServiceTerms(lead.primaryCategory),
      });
      // Só publica o número de 30 dias quando a janela está inteiramente coberta.
      interactionsLast30Days = analysis.windowCovered ? analysis.countLast30Days : null;
      ownerResponseRatePercent = analysis.ownerResponseRatePercent;
      availability = {
        state: 'FETCHED',
        provider: 'Serper.dev (Google Reviews)',
        reason: outcome.warnings.length > 0 ? outcome.warnings.join(' ') : null,
        collectedAt: outcome.fetchedAt,
        analysis,
      };
    } else {
      availability = {
        state: 'UNAVAILABLE',
        provider: outcome.state === 'FAILED' ? 'Serper.dev (Google Reviews)' : null,
        reason: outcome.reason,
        collectedAt: now().toISOString(),
        analysis: null,
      };
      if (outcome.state === 'FAILED') {
        this.logger.warn('Coleta de avaliações falhou; indicadores ficam indisponíveis', {
          auditId,
          reason: outcome.reason,
          httpStatus: outcome.httpStatus,
          pagesFetched: outcome.pagesFetched,
        });
      }
    }

    const result: ReputationMetrics = {
      placeId: lead.placeId,
      averageRating: lead.rating,
      totalReviews: lead.totalReviews,
      starDistribution: null, // a distribuição por estrelas não é coletada e nunca é estimada
      ownerResponseRatePercent,
      averageOwnerResponseHours: null,
      interactionsLast30Days,
      ownerRepliesLast30Days: null,
      monthlyVelocityTarget: 12,
      velocityStatus:
        interactionsLast30Days === null
          ? 'NOT_VERIFIED'
          : interactionsLast30Days >= 8
            ? 'ACCELERATING'
            : interactionsLast30Days >= 3
              ? 'STAGNANT'
              : 'CRITICAL_DORMANT',
      // Textos e nomes de clientes não são armazenados: só os indicadores calculados.
      recentReviewsSample: [],
      extractedAt: now().toISOString(),
      reviewsAvailability: availability,
    };

    this.logger.info('Coleta de reputação concluída', {
      auditId,
      placeId: lead.placeId,
      reviewsState: availability.state,
      interactionsLast30Days,
      ownerResponseRatePercent,
    });

    return result;
  }
}

export const reputationAgent = new ReputationAgent();
