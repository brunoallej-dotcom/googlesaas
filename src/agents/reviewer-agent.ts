import type {
  JudgeTechnicalSheet,
  MathematicalDiscrepancy,
  ReviewerAuditResult,
  StrategistOutput,
} from '@/types/gmn';
import { StructuredLogger } from '@/lib/logger';

/**
 * ============================================================================
 * AGENTE 7: REVISOR (AUDITORIA MATEMÁTICA ESTRITA CONTRA A FICHA BRUTA)
 * Audita matematicamente cada número e métrica presente no snapshot e no texto
 * gerado pelo Estrategista contra o `rawFactsRegistry` da Ficha Técnica do Juiz.
 * Se houver divergência, reprova (`approved: false`) e retorna instruções exatas
 * de correção para que o Maestro acione automaticamente o Estrategista novamente.
 * ============================================================================
 */
export class ReviewerAgent {
  private readonly logger = new StructuredLogger('REVIEWER');

  public auditMathematically(params: {
    readonly auditId: string;
    readonly judgeSheet: JudgeTechnicalSheet;
    readonly strategistOutput: StrategistOutput;
    readonly iterationNumber: number;
  }): ReviewerAuditResult {
    const { judgeSheet, strategistOutput, iterationNumber } = params;
    const raw = judgeSheet.rawFactsRegistry;
    const cited = strategistOutput.citedMetricsSnapshot;
    const discrepancies: MathematicalDiscrepancy[] = [];

    // Valores indisponíveis (`null`) são válidos: o Estrategista deve citá-los como indisponíveis,
    // nunca como número. Divergência = um lado tem número e o outro não, ou os números diferem.
    const numericPairs: ReadonlyArray<{
      readonly field: string;
      readonly expected: number | null;
      readonly actual: number | null;
    }> = [
      { field: 'rating', expected: raw.rating, actual: cited.rating },
      { field: 'totalReviews', expected: raw.totalReviews, actual: cited.totalReviews },
      { field: 'ownerResponseRatePercent', expected: raw.ownerResponseRatePercent, actual: cited.ownerResponseRatePercent },
      { field: 'interactionsLast30Days', expected: raw.interactionsLast30Days, actual: cited.interactionsLast30Days },
      { field: 'totalPhotosCount', expected: raw.totalPhotosCount, actual: cited.totalPhotosCount },
      { field: 'averageGridPosition', expected: raw.averageGridPosition, actual: cited.averageGridPosition },
      { field: 'top3Percentage', expected: raw.top3Percentage, actual: cited.top3Percentage },
      { field: 'top7Percentage', expected: raw.top7Percentage, actual: cited.top7Percentage },
      { field: 'invisibilityPercentage', expected: raw.invisibilityPercentage, actual: cited.invisibilityPercentage },
      { field: 'overallJudgeScore', expected: raw.overallJudgeScore, actual: cited.overallJudgeScore },
    ];

    for (const check of numericPairs) {
      const differs =
        check.expected === null || check.actual === null
          ? check.expected !== check.actual
          : Math.abs(check.expected - check.actual) > 0.01;
      if (differs) {
        discrepancies.push({
          metricField: check.field,
          expectedRawValue: check.expected ?? -1,
          foundInStrategistOutput: check.actual ?? -1,
          locationContext: 'CITED_SNAPSHOT',
          correctionDirective:
            check.expected === null
              ? `O campo ${check.field} está indisponível na Ficha Técnica: citar como indisponível (null), nunca como número.`
              : `Substituir valor divergente ${check.actual ?? 'indisponível'} pelo valor exato da Ficha Técnica (${check.expected}) no campo ${check.field}.`,
        });
      }
    }

    // Validação textual cruzada no Resumo Executivo e Diagnóstico
    const fullText = [
      strategistOutput.executiveSummary,
      strategistOutput.diagnosticNarrative,
      strategistOutput.territoryOpportunityNarrative,
    ].join(' ');

    if (!fullText.includes(String(raw.totalReviews))) {
      discrepancies.push({
        metricField: 'totalReviews_in_text',
        expectedRawValue: raw.totalReviews,
        foundInStrategistOutput: -1,
        locationContext: 'EXECUTIVE_TEXT',
        correctionDirective: `O texto executivo deve citar explicitamente o total exato de ${raw.totalReviews} avaliações.`,
      });
    }

    if (!fullText.includes(String(raw.averageGridPosition))) {
      discrepancies.push({
        metricField: 'averageGridPosition_in_text',
        expectedRawValue: raw.averageGridPosition,
        foundInStrategistOutput: -1,
        locationContext: 'DIAGNOSTIC_TEXT',
        correctionDirective: `O diagnóstico deve citar a posição média exata de ${raw.averageGridPosition} calculada sobre os ${raw.validGridPoints} pontos válidos.`,
      });
    }

    if (fullText.includes('Err')) {
      discrepancies.push({
        metricField: 'forbidden_err_token',
        expectedRawValue: 0,
        foundInStrategistOutput: 1,
        locationContext: 'DIAGNOSTIC_TEXT',
        correctionDirective:
          'Remover imediatamente qualquer menção a "Err"; pontos sem leitura devem ser referenciados exclusivamente como "sem leitura" (cinza).',
      });
    }

    if (/score global/i.test(fullText)) {
      discrepancies.push({
        metricField: 'forbidden_global_score_label',
        expectedRawValue: 0,
        foundInStrategistOutput: 1,
        locationContext: 'EXECUTIVE_TEXT',
        correctionDirective:
          'Remover "Score Global": o indicador deve ser chamado de pontuação recalculada do Juiz (ou Score Juiz histórico, quando armazenado), com a cobertura de evidências ao lado.',
      });
    }

    if (/\bgarant(?:ia|imos|ido|ida|idos|idas|e|em)\b|\+\s?\d+\s?%/i.test(fullText)) {
      discrepancies.push({
        metricField: 'forbidden_result_promise',
        expectedRawValue: 0,
        foundInStrategistOutput: 1,
        locationContext: 'EXECUTIVE_TEXT',
        correctionDirective: 'Remover promessas de resultado, de posição ou de ganho percentual dos textos estratégicos.',
      });
    }

    const approved = discrepancies.length === 0;

    this.logger.info('Auditoria matemática do Agente Revisor finalizada', {
      auditId: params.auditId,
      iterationNumber,
      approved,
      discrepanciesFound: discrepancies.length,
    });

    return {
      approved,
      iterationNumber,
      totalChecksPerformed: numericPairs.length + 5,
      discrepancies,
      auditTimestamp: new Date().toISOString(),
    };
  }
}

export const reviewerAgent = new ReviewerAgent();
