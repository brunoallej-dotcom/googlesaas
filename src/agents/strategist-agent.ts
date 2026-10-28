import type {
  BattlefieldMetrics,
  FrontierLead,
  JudgeTechnicalSheet,
  MathematicalDiscrepancy,
  ReputationMetrics,
  RivalsMetrics,
  StrategistOutput,
  TacticalWaveAction,
  TacticalWavePlan,
  TacticalWavePriority,
  VitrineMetrics,
} from '@/types/gmn';
import { StructuredLogger } from '@/lib/logger';
import { describeCoverage } from '@/lib/judge-scoring';
import {
  buildRecommendations,
  RECOMMENDATION_DISCLAIMER,
  WAVE_META,
  type EvidenceRecommendation,
} from '@/lib/recommendations';

/**
 * ============================================================================
 * AGENTE 6: ESTRATEGISTA
 * Sintetiza a Ficha Técnica do Juiz em diagnóstico e plano tático P0–P3.
 *
 * Fase 4: as recomendações NASCEM das evidências do Juiz. Cada ação informa o problema, a
 * evidência, o critério de origem, a prioridade, o prazo, o indicador e o grau de confiança, e é
 * classificada como ação comprovada, hipótese a validar ou não aplicável. Nenhum texto promete
 * posição, vendas ou ganho percentual, e nenhum número indisponível é citado como se existisse.
 * ============================================================================
 */
export class StrategistAgent {
  private readonly logger = new StructuredLogger('STRATEGIST');

  public async synthesizeStrategy(params: {
    readonly auditId: string;
    readonly lead: FrontierLead;
    readonly reputation: ReputationMetrics;
    readonly vitrine: VitrineMetrics;
    readonly battlefield: BattlefieldMetrics;
    readonly rivals: RivalsMetrics;
    readonly judge: JudgeTechnicalSheet;
    readonly revisionAttempt: number;
    readonly previousDiscrepancies?: readonly MathematicalDiscrepancy[];
  }): Promise<StrategistOutput> {
    const { lead, judge, battlefield, rivals, revisionAttempt, previousDiscrepancies } = params;
    const raw = judge.rawFactsRegistry;
    const summary = judge.scoreSummary;

    this.logger.info('Gerando plano estratégico a partir das evidências', {
      auditId: params.auditId,
      placeId: lead.placeId,
      revisionAttempt,
      discrepanciesCount: previousDiscrepancies?.length ?? 0,
    });

    const coverageText = summary
      ? describeCoverage(summary, judge.checklist21Items.length)
      : 'cobertura de evidências não calculada';

    const verifiedText =
      summary && summary.verifiedPerformance !== null
        ? `O desempenho nos critérios verificados é ${summary.verifiedPerformance}%.`
        : 'Nenhum critério pôde ser comprovado com pontuação.';

    const ownReviewsText =
      lead.provenance?.totalReviews === 'UNKNOWN' || raw.totalReviews === 0
        ? 'sem avaliações públicas coletadas (total registrado: 0)'
        : `${raw.totalReviews} avaliações públicas`;

    const executiveSummary =
      `A auditoria técnica da "${lead.businessName}" resultou em pontuação recalculada do Juiz de ${raw.overallJudgeScore}/100, média ponderada apenas dos critérios com pontuação (${summary ? `${summary.scoredWeightPercent}% do peso total` : 'denominador não informado'}); não é o Score Juiz histórico das auditorias anteriores. ` +
      `a cobertura de evidências é: ${coverageText}. ${verifiedText} ` +
      `A empresa está na fronteira do Google Meu Negócio (#${lead.frontierRank}, ${lead.frontierPage}ª página) e tem ${ownReviewsText}. ` +
      `${judge.businessModelContext.contextJustification}`;

    const gridPart =
      battlefield.validPointsCount > 0
        ? `${raw.validGridPoints} pontos obtiveram leitura válida e ${raw.unreadableGridPoints} ficaram sem leitura (fora das médias). ` +
          `O índice de posição é ${raw.averageGridPosition} (média limitada em que pontos fora do Top 20 valem 21; não é a posição real nesses pontos)` +
          `${battlefield.knownPositionAverage != null ? `, e a média das posições efetivamente conhecidas é ${battlefield.knownPositionAverage}` : ''}. ` +
          `A empresa aparece no Top 3 em ${raw.greenTop3Count} pontos (${raw.top3Percentage}% dos válidos), no Top 7 em ${raw.top7Percentage}% e fora do Top 20 em ${raw.invisibilityPercentage}%.`
        : `Nenhum ponto obteve leitura válida; o índice de posição (${raw.averageGridPosition}) não representa uma medição.`;

    const leaderPart = raw.topRivalName
      ? ` O líder territorial "${raw.topRivalName}" lidera ${raw.topRivalPointsWon} pontos${raw.topRivalReviews !== null ? ` e tem ${raw.topRivalReviews} avaliações na listagem pública` : ''}.`
      : ' Nenhum concorrente líder foi identificado nos pontos com leitura válida.';

    const diagnosticNarrative =
      `Na análise georreferenciada do Campo de Batalha (matriz 7x7 de 49 coordenadas com a palavra-chave "${battlefield.pureKeyword}"), ${gridPart}${leaderPart}`;

    const recSet = buildRecommendations({ lead, judge, battlefield, rivals });

    const territoryOpportunityNarrative =
      `${battlefield.historicalEvolution.evolutionSummaryText} ` +
      `${recSet.recommendations.filter((r) => r.classification === 'PROVEN_ACTION').length} recomendações têm evidência verificada e ` +
      `${recSet.recommendations.filter((r) => r.classification === 'HYPOTHESIS').length} dependem de validação. ${RECOMMENDATION_DISCLAIMER}`;

    const toAction = (rec: EvidenceRecommendation): TacticalWaveAction => ({
      actionCode: rec.code,
      title: rec.title,
      technicalInstruction: rec.action,
      expectedImpact: rec.objective,
      effortLevel: rec.effort,
      classification: rec.classification,
      problem: rec.problem,
      evidenceSummary: rec.evidenceSummary,
      justification: rec.justification,
      evidenceCriteria: rec.evidenceCriteria,
      priority: rec.priority,
      timeframe: rec.timeframe,
      indicator: rec.indicator,
      confidence: rec.confidence,
    });

    const wave = (key: TacticalWavePriority): TacticalWavePlan => ({
      wave: key,
      waveTitle: WAVE_META[key].title,
      timeframeLabel: WAVE_META[key].timeframe,
      objective: WAVE_META[key].objective,
      actions: recSet.recommendations.filter((rec) => rec.wave === key).map(toAction),
    });

    this.logger.info('Plano estratégico gerado', {
      auditId: params.auditId,
      recommendations: recSet.recommendations.length,
      provenActions: recSet.recommendations.filter((r) => r.classification === 'PROVEN_ACTION').length,
    });

    return {
      placeId: lead.placeId,
      revisionAttempt,
      executiveSummary,
      diagnosticNarrative,
      territoryOpportunityNarrative,
      citedMetricsSnapshot: {
        rating: raw.rating,
        totalReviews: raw.totalReviews,
        ownerResponseRatePercent: raw.ownerResponseRatePercent,
        interactionsLast30Days: raw.interactionsLast30Days,
        totalPhotosCount: raw.totalPhotosCount,
        averageGridPosition: raw.averageGridPosition,
        top3Percentage: raw.top3Percentage,
        top7Percentage: raw.top7Percentage,
        invisibilityPercentage: raw.invisibilityPercentage,
        overallJudgeScore: raw.overallJudgeScore,
      },
      tacticalWaves: [wave('P0'), wave('P1'), wave('P2'), wave('P3')],
      maintainNotes: recSet.maintain,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const strategistAgent = new StrategistAgent();
