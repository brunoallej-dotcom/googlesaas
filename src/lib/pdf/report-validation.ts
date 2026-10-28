import type { BattlefieldMapModel } from '@/lib/battlefield-map-adapter';
import type { CriterionAssessment } from './report-evidence';
import type { ScoreBreakdown } from './report-metrics';
import type { PlanWave } from './report-plan';
import { containsPromise } from './report-plan';

export interface QualityCheck {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string | null;
}

export interface ValidationInput {
  readonly model: BattlefieldMapModel;
  readonly score: ScoreBreakdown;
  readonly criteria: readonly CriterionAssessment[];
  readonly plan: readonly PlanWave[];
  /** Todo o texto livre que o relatório vai imprimir (diagnóstico, evidências, plano, achados). */
  readonly texts: readonly string[];
  readonly rating: number;
  readonly leaderReviews: number | null;
  readonly myReviews: number;
}

const FORBIDDEN_TERMS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /score global/i, label: '"Score Global"' },
  { pattern: /\bgarant(?:ia|imos|ido|ida|idos|idas|e|em)\b/i, label: 'promessa de garantia' },
  { pattern: /\d+\s*%\s*(a|-|–)\s*\d+\s*%/i, label: 'faixa percentual prometida' },
];

function finiteNumbers(values: readonly (number | null)[]): boolean {
  return values.every((value) => value === null || Number.isFinite(value));
}

/**
 * Invariantes verificados antes de gerar o PDF. Falhas não derrubam o relatório: aparecem em
 * "Controles de qualidade" e no log, para nenhuma inconsistência passar despercebida.
 */
export function runQualityChecks(input: ValidationInput): readonly QualityCheck[] {
  const { model, score, criteria, plan, texts, rating, leaderReviews, myReviews } = input;
  const checks: QualityCheck[] = [];
  const add = (id: string, label: string, passed: boolean, detail: string | null = null): void => {
    checks.push({ id, label, passed, detail: passed ? null : detail });
  };

  const tierTotal =
    model.counts.top3 + model.counts.top4to7 + model.counts.rank8to20 + model.counts.above20;
  add(
    'grid-counts',
    'As contagens por faixa somam as leituras válidas',
    !model.hasData || tierTotal === model.coverage.valid,
    `faixas somam ${tierTotal}, leituras válidas ${model.coverage.valid}`
  );
  add(
    'grid-coverage',
    'Pontos coletados = válidos + sem leitura',
    !model.hasData || model.coverage.collected === model.coverage.valid + model.coverage.unreadable,
    `coletados ${model.coverage.collected}, válidos ${model.coverage.valid}, sem leitura ${model.coverage.unreadable}`
  );
  add(
    'numbers-finite',
    'Nenhum indicador numérico inválido (NaN ou infinito)',
    finiteNumbers([
      model.averagePosition,
      model.percentages.top3,
      model.percentages.top7,
      model.percentages.above20,
      score.officialScore,
      score.verified.performance,
      ...(score.range ? [score.range.min, score.range.max] : []),
      score.partial.performance,
    ])
  );
  add(
    'official-score',
    'A pontuação recomposta confere com a ficha do Juiz',
    score.officialMatchesAgent,
    `recomposto ${score.officialScore}, agente ${score.agentOfficialScore}`
  );
  add(
    'weights',
    'Os pesos dos 21 critérios somam o peso total do Juiz',
    score.verified.weight + score.partial.weight + score.notVerified.weight + score.simulated.weight === score.totalWeight
  );

  const unprovenWithClaims = criteria.filter(
    (item) => (item.evidenceClass === 'NOT_VERIFIED' || item.evidenceClass === 'SIMULATED') && (item.evidence !== null || item.displayStatus === 'APPROVED' || item.displayStatus === 'CRITICAL' || item.displayStatus === 'PARTIAL')
  );
  add(
    'no-unproven-verdicts',
    'Critérios sem comprovação não aparecem como aprovados, parciais ou críticos (os parcialmente verificados aparecem à parte)',
    unprovenWithClaims.length === 0,
    unprovenWithClaims.map((item) => item.code).join(', ')
  );

  const banned = texts.flatMap((text) =>
    FORBIDDEN_TERMS.filter((term) => term.pattern.test(text)).map((term) => term.label)
  );
  add('no-forbidden-terms', 'Nenhuma promessa de resultado ou termo proibido nos textos', banned.length === 0, [...new Set(banned)].join(', '));

  const promises = plan.flatMap((wave) => wave.actions).filter((action) => containsPromise(`${action.objective} ${action.justification}`));
  add('plan-no-promises', 'O plano não promete percentuais nem resultado garantido', promises.length === 0, promises.map((a) => a.code).join(', '));

  const contradictions: string[] = [];
  const allText = texts.join(' ');
  if (rating >= 4.6 && /(elevar|aumentar)[^.]*\b4[,.]7\b/i.test(allText)) {
    contradictions.push('recomenda elevar uma nota já alta');
  }
  if (leaderReviews !== null && myReviews >= leaderReviews && /faltam\s+avalia/i.test(allText)) {
    contradictions.push('afirma falta de avaliações apesar de superar o líder');
  }
  add('no-contradictions', 'As recomendações são coerentes com os dados', contradictions.length === 0, contradictions.join('; '));

  return checks;
}
