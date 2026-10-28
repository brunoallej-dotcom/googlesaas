import type {
  BattlefieldMetrics,
  FrontierLead,
  JudgeCategoryKey,
  JudgeCategoryScore,
  JudgeChecklistItem,
  JudgeTechnicalSheet,
  ReputationMetrics,
  RivalsMetrics,
  VitrineMetrics,
} from '@/types/gmn';
import { StructuredLogger } from '@/lib/logger';
import { assessAllCriteria, CRITERIA_META } from '@/lib/evidence/criteria';
import { EVIDENCE_SCHEMA_VERSION, isDemoMode, toPersistableEvidence } from '@/lib/evidence/types';
import type { ProviderFailure } from '@/lib/evidence/types';
import { computeJudgeScores } from '@/lib/judge-scoring';
import type { SiteCheckResult } from '@/lib/site-check';

const CATEGORY_LABELS: Record<JudgeCategoryKey, string> = {
  IDENTITY_AND_NAP: '1. Identidade, NAP & Conformidade',
  CATEGORIZATION_AND_SERVICES: '2. Categorização, Serviços & Atributos',
  REPUTATION_AND_CONVERSION: '3. Reputação, Velocidade & Conversão',
  VITRINE_AND_CONTENT: '4. Vitrine Visual & Google Posts',
  GEOGRAPHIC_AUTHORITY: '5. Autoridade Geográfica (Grade 49 Pontos)',
};

const SAB_KEYWORDS_DETECTION: readonly RegExp[] = [
  /domiciliar/i,
  /in-loco/i,
  /m[oó]vel/i,
  /delivery/i,
  /24h/i,
  /desentupidora/i,
  /chaveiro/i,
  /guincho/i,
  /marido de aluguel/i,
  /dedetiza[cç][aã]o/i,
  /assist[eê]ncia t[eé]cnica/i,
  /climatiza[cç][aã]o/i,
  /eletricista/i,
  /encanador/i,
];

/**
 * ============================================================================
 * AGENTE 5: JUIZ (CHECKLIST DE 21 ITENS COM REGRA DE EXCEÇÃO DE ENDEREÇO OCULTO)
 * Avalia os 21 critérios técnicos de posicionamento local e monta a Ficha Técnica.
 *
 * Fase 4: cada critério sai com uma EVIDÊNCIA (status, fonte, data, limitações). A pontuação
 * continua seguindo a metodologia original, mas só quando há dado observado: critério sem
 * evidência fica sem pontuação (nem aprovado nem reprovado) e não entra no desempenho verificado.
 *
 * Regra de Exceção (SAB): quando o negócio parece atender no local do cliente e a listagem não traz
 * endereço, o item de endereço não penaliza; a condição é INFERIDA e fica registrada como parcial.
 * ============================================================================
 */
export class JudgeAgent {
  private readonly logger = new StructuredLogger('JUDGE');

  public evaluate(params: {
    readonly auditId: string;
    readonly lead: FrontierLead;
    readonly reputation: ReputationMetrics;
    readonly vitrine: VitrineMetrics;
    readonly battlefield: BattlefieldMetrics;
    readonly rivals: RivalsMetrics;
    /** Verificação técnica do site (Fase 4); ausente em reprocessamentos sem nova coleta. */
    readonly siteCheck?: SiteCheckResult | null;
    readonly providerFailures?: readonly ProviderFailure[];
    /** Somente fixtures de teste: as evidências saem identificadas como sintéticas. */
    readonly syntheticTestData?: boolean;
  }): JudgeTechnicalSheet {
    const { lead, reputation, vitrine, battlefield, rivals } = params;

    const inferredSabFromNameOrCategory = SAB_KEYWORDS_DETECTION.some(
      (rx) => rx.test(lead.businessName) || rx.test(lead.primaryCategory)
    );
    const isServiceAreaBusiness = lead.isServiceAreaBusiness || inferredSabFromNameOrCategory;
    const isAddressHidden = lead.isAddressHidden;
    const addressExceptionRuleTriggered = isServiceAreaBusiness && isAddressHidden;

    this.logger.info('Iniciando julgamento técnico de 21 itens (Agente Juiz)', {
      auditId: params.auditId,
      placeId: lead.placeId,
      isServiceAreaBusiness,
      isAddressHidden,
      addressExceptionRuleTriggered,
    });

    const outcomes = assessAllCriteria({
      lead,
      reputation,
      vitrine,
      battlefield,
      rivals,
      siteCheck: params.siteCheck ?? null,
      isAddressHidden,
      addressExceptionRuleTriggered,
      ...(params.syntheticTestData ? { syntheticTestData: true } : {}),
    });

    const checklist21Items: JudgeChecklistItem[] = CRITERIA_META.map((meta) => {
      const outcome = outcomes.find((entry) => entry.itemNumber === meta.itemNumber);
      if (!outcome) throw new Error(`Critério ${meta.itemNumber} sem avaliação.`);
      return {
        itemNumber: meta.itemNumber,
        code: meta.code,
        category: meta.category,
        title: meta.title,
        status: outcome.status,
        scoreAwarded: outcome.score,
        maxWeight: meta.maxWeight,
        isContextExceptionApplied: meta.itemNumber === 3 && addressExceptionRuleTriggered,
        evidenceObserved: outcome.observed,
        technicalRecommendation: outcome.recommendation,
        evidence: outcome.evidence,
      };
    });

    const scoreSummary = computeJudgeScores(
      checklist21Items.map((item) => ({
        itemNumber: item.itemNumber,
        maxWeight: item.maxWeight,
        scoreAwarded: item.scoreAwarded,
        evidenceStatus: item.evidence?.status ?? 'NOT_VERIFIED',
      }))
    );

    const categories: JudgeCategoryKey[] = [
      'IDENTITY_AND_NAP',
      'CATEGORIZATION_AND_SERVICES',
      'REPUTATION_AND_CONVERSION',
      'VITRINE_AND_CONTENT',
      'GEOGRAPHIC_AUTHORITY',
    ];

    const categoryScores: JudgeCategoryScore[] = categories.map((cat) => {
      const itemsInCat = checklist21Items.filter((item) => item.category === cat);
      const scored = itemsInCat.filter((item) => item.scoreAwarded !== null);
      const scoredWeight = scored.reduce((sum, item) => sum + item.maxWeight, 0);
      const earned = scored.reduce(
        (sum, item) => sum + ((item.scoreAwarded as number) / 100) * item.maxWeight,
        0
      );
      return {
        category: cat,
        categoryLabel: CATEGORY_LABELS[cat],
        scorePercent: scoredWeight > 0 ? Number(((earned / scoredWeight) * 100).toFixed(1)) : null,
        passedItemsCount: itemsInCat.filter(
          (item) => item.status === 'PASS' || item.status === 'EXEMPT_BY_CONTEXT_RULE'
        ).length,
        totalItemsCount: itemsInCat.length,
      };
    });

    // Pontuação pela metodologia original, preservada para compatibilidade com o histórico.
    // Compatibilidade: `overallScore` guarda a pontuação RECALCULADA (Fase 4); `scoreMethod` o identifica.
    const overallScore = scoreSummary.recalculatedScore ?? 0;

    // A classificação de saúde só usa a pontuação histórica quando a evidência sustenta mais da
    // metade do peso; do contrário, o rótulo diria mais do que os dados comprovam.
    const healthClassification: JudgeTechnicalSheet['healthClassification'] =
      scoreSummary.verifiedCoveragePercent < 50 || scoreSummary.recalculatedScore === null
        ? 'INSUFFICIENT_EVIDENCE'
        : overallScore >= 82
          ? 'ELITE'
          : overallScore >= 64
            ? 'COMPETITIVE'
            : overallScore >= 45
              ? 'VULNERABLE'
              : 'CRITICAL_INVISIBLE';

    const topRival = rivals.topDominators[0];

    const sheet: JudgeTechnicalSheet = {
      placeId: lead.placeId,
      overallScore,
      healthClassification,
      businessModelContext: {
        isServiceAreaBusiness,
        isAddressHidden,
        addressExceptionRuleTriggered,
        contextJustification: addressExceptionRuleTriggered
          ? `Regra de Exceção de Endereço Oculto (SAB) aplicada por inferência: a listagem não traz endereço${inferredSabFromNameOrCategory ? ' e o nome ou a categoria sugerem atendimento no local do cliente' : ' e a coleta trata esses perfis como atendimento no local do cliente'}. Não é uma confirmação; conferir no painel do perfil.`
          : isAddressHidden
            ? 'A coleta não trouxe endereço público. Isso não prova que ele esteja oculto no perfil; conferir no painel.'
            : 'A listagem traz endereço público.',
      },
      categoryScores,
      checklist21Items,
      rawFactsRegistry: {
        rating: reputation.averageRating,
        totalReviews: reputation.totalReviews,
        ownerResponseRatePercent: reputation.ownerResponseRatePercent,
        interactionsLast30Days: reputation.interactionsLast30Days,
        totalPhotosCount: vitrine.totalPhotosCount,
        customerPhotosCount: vitrine.customerPhotosCount,
        totalVideosCount: vitrine.totalVideosCount,
        daysSinceLastMedia: vitrine.daysSinceLastMedia,
        daysSinceLastPost: vitrine.daysSinceLastPost,
        validGridPoints: battlefield.validPointsCount,
        unreadableGridPoints: battlefield.unreadablePointsCount,
        averageGridPosition: battlefield.averagePosition,
        top3Percentage: battlefield.top3Percentage,
        top7Percentage: battlefield.top7Percentage,
        invisibilityPercentage: battlefield.invisibilityPercentage,
        greenTop3Count: battlefield.greenTop3Count,
        topRivalName: topRival?.businessName ?? null,
        topRivalReviews: topRival?.totalReviews ?? null,
        topRivalPointsWon: topRival?.pointsWonAsNumberOne ?? 0,
        overallJudgeScore: overallScore,
      },
      evaluatedAt: new Date().toISOString(),
      scoreMethod: 'PHASE4_SCORED_WEIGHT',
      scoreSummary,
      evidenceBundle: {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        // Dados simulados nunca são persistidos como evidência real.
        evidence: toPersistableEvidence(outcomes.map((entry) => entry.evidence)),
        providerFailures: params.providerFailures ?? [],
        demo: isDemoMode(),
        ...(params.syntheticTestData ? { testFixture: true } : {}),
      },
    };

    this.logger.info('Ficha Técnica do Juiz consolidada com 21 itens', {
      auditId: params.auditId,
      recalculatedScore: scoreSummary.recalculatedScore,
      denominatorWeight: scoreSummary.denominatorWeight,
      verifiedPerformance: scoreSummary.verifiedPerformance,
      verifiedCoveragePercent: scoreSummary.verifiedCoveragePercent,
      healthClassification,
      addressExceptionRuleTriggered,
    });

    return sheet;
  }
}

export const judgeAgent = new JudgeAgent();
