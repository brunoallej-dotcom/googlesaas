import assert from 'node:assert/strict';
import test from 'node:test';
import { computeJudgeScores, describeCoverage, type ScorableItem } from '../src/lib/judge-scoring';
import type { EvidenceStatus } from '../src/lib/evidence/types';
import { buildReportFixture } from '../src/dev/report-fixture';

const WEIGHTS = [6, 5, 6, 5, 6, 6, 4, 5, 3, 5, 6, 6, 5, 4, 4, 3, 4, 4, 6, 4, 5];

function items(statuses: readonly EvidenceStatus[], scores: readonly (number | null)[]): ScorableItem[] {
  return WEIGHTS.map((weight, index) => ({
    itemNumber: index + 1,
    maxWeight: weight,
    scoreAwarded: scores[index] ?? null,
    evidenceStatus: statuses[index] ?? 'NOT_VERIFIED',
  }));
}

/** Fórmula original do Agente Juiz, reproduzida literalmente. */
function originalFormula(list: readonly ScorableItem[]): number {
  const earned = list.reduce((sum, item) => sum + ((item.scoreAwarded ?? 0) / 100) * item.maxWeight, 0);
  const max = Math.max(1, list.reduce((sum, item) => sum + item.maxWeight, 0));
  return Number(((earned / max) * 100).toFixed(1));
}

test('os 21 pesos históricos somam 102', () => {
  assert.equal(WEIGHTS.length, 21);
  assert.equal(WEIGHTS.reduce((a, b) => a + b, 0), 102);
});

test('com todos os critérios pontuados, o score histórico é idêntico à fórmula original', () => {
  const scores = [100, 65, 100, 75, 100, 100, 55, 20, 85, 100, 45, 55, 10, 60, 20, 50, 50, 10, 15, 20, 10];
  const list = items(Array(21).fill('VERIFIED'), scores);
  const summary = computeJudgeScores(list);
  assert.equal(summary.recalculatedScore, originalFormula(list));
  assert.equal(summary.scoredWeightPercent, 100);
  assert.equal(summary.fullyVerified, true);
  // Não é uma média simples
  assert.notEqual(summary.recalculatedScore, Number((scores.reduce((a, b) => a + b, 0) / 21).toFixed(1)));
});

test('o score histórico é preservado mesmo quando a evidência é fraca; só o selo de "totalmente verificado" muda', () => {
  const scores = Array(21).fill(80);
  const verified = computeJudgeScores(items(Array(21).fill('VERIFIED'), scores));
  const weak = computeJudgeScores(items(Array(21).fill('NOT_VERIFIED'), scores));
  assert.equal(verified.recalculatedScore, weak.recalculatedScore);
  assert.equal(verified.fullyVerified, true);
  assert.equal(weak.fullyVerified, false);
});

test('desempenho verificado: mesma fórmula, restrita aos critérios VERIFIED', () => {
  const statuses: EvidenceStatus[] = Array(21).fill('NOT_VERIFIED');
  statuses[9] = 'VERIFIED'; // 10 (peso 5)
  statuses[18] = 'VERIFIED'; // 19 (peso 6)
  const scores: (number | null)[] = Array(21).fill(null);
  scores[9] = 100;
  scores[18] = 50;
  const summary = computeJudgeScores(items(statuses, scores));
  assert.equal(summary.verifiedPerformance, Number((((1 * 5 + 0.5 * 6) / 11) * 100).toFixed(1)));
  assert.equal(summary.buckets.VERIFIED.weight, 11);
  assert.equal(summary.verifiedCoveragePercent, Number(((11 / 102) * 100).toFixed(1)));
});

test('critério sem pontuação (null) não é zero nem 100: fica fora do numerador e do denominador', () => {
  const base = items(Array(21).fill('VERIFIED'), Array(21).fill(100));
  const withNull = base.map((item) => (item.itemNumber === 1 ? { ...item, scoreAwarded: null } : item));
  const withZero = base.map((item) => (item.itemNumber === 1 ? { ...item, scoreAwarded: 0 } : item));
  const a = computeJudgeScores(withNull);
  const b = computeJudgeScores(withZero);
  assert.equal(a.recalculatedScore, 100, 'ausência não vira reprovação');
  assert.ok((b.recalculatedScore ?? 0) < 100);
  assert.equal(a.scoredWeightPercent, Number((((102 - 6) / 102) * 100).toFixed(1)));
});

test('parcialmente verificado é calculado À PARTE e nunca soma à cobertura verificada', () => {
  const statuses: EvidenceStatus[] = Array(21).fill('NOT_VERIFIED');
  statuses[0] = 'VERIFIED'; // peso 6
  statuses[2] = 'PARTIALLY_VERIFIED'; // peso 6
  statuses[3] = 'PARTIALLY_VERIFIED'; // peso 5
  const scores: (number | null)[] = Array(21).fill(null);
  scores[0] = 100;
  scores[2] = 40;
  scores[3] = 75;
  const summary = computeJudgeScores(items(statuses, scores));
  assert.equal(summary.verifiedPerformance, 100, 'o parcial não altera o desempenho verificado');
  assert.equal(summary.partialPerformance, Number((((0.4 * 6 + 0.75 * 5) / 11) * 100).toFixed(1)));
  assert.equal(summary.buckets.VERIFIED.count, 1);
  assert.equal(summary.buckets.PARTIALLY_VERIFIED.count, 2);
  assert.equal(summary.verifiedCoveragePercent, Number(((6 / 102) * 100).toFixed(1)));
  assert.equal(summary.partialCoveragePercent, Number(((11 / 102) * 100).toFixed(1)));
});

test('cobertura ponderada: contagens e pesos de todas as classes fecham o total', () => {
  const statuses: EvidenceStatus[] = ['VERIFIED', 'PARTIALLY_VERIFIED', 'NOT_VERIFIED', 'SIMULATED', ...Array<EvidenceStatus>(17).fill('NOT_VERIFIED')];
  const summary = computeJudgeScores(items(statuses, Array(21).fill(50)));
  const { VERIFIED, PARTIALLY_VERIFIED, NOT_VERIFIED, SIMULATED } = summary.buckets;
  assert.equal(VERIFIED.count + PARTIALLY_VERIFIED.count + NOT_VERIFIED.count + SIMULATED.count, 21);
  assert.equal(VERIFIED.weight + PARTIALLY_VERIFIED.weight + NOT_VERIFIED.weight + SIMULATED.weight, 102);
  const percents = VERIFIED.weightPercent + PARTIALLY_VERIFIED.weightPercent + NOT_VERIFIED.weightPercent + SIMULATED.weightPercent;
  assert.ok(Math.abs(percents - 100) < 0.2);
});

test('sem nenhum critério verificado: desempenho verificado é null (nunca 0%) e a cobertura pode ficar abaixo de 37%', () => {
  const summary = computeJudgeScores(items(Array(21).fill('NOT_VERIFIED'), Array(21).fill(null)));
  assert.equal(summary.verifiedPerformance, null);
  assert.equal(summary.recalculatedScore, null);
  assert.equal(summary.verifiedCoveragePercent, 0);
  assert.match(describeCoverage(summary, 21), /0 de 21 critérios verificados · 0% do peso/);
});

test('a ficha do Juiz da Fase 4 grava o resumo coerente com os itens', async () => {
  const data = await buildReportFixture({ dataStyle: 'phase4' });
  const sheet = data.judge;
  assert.ok(sheet.scoreSummary);
  const recomputed = computeJudgeScores(
    sheet.checklist21Items.map((item) => ({
      itemNumber: item.itemNumber,
      maxWeight: item.maxWeight,
      scoreAwarded: item.scoreAwarded,
      evidenceStatus: item.evidence?.status ?? 'NOT_VERIFIED',
    }))
  );
  assert.deepEqual(sheet.scoreSummary, recomputed);
  assert.equal(sheet.overallScore, recomputed.recalculatedScore ?? 0);
  assert.equal(sheet.rawFactsRegistry.overallJudgeScore, sheet.overallScore);
  assert.equal(sheet.checklist21Items.length, 21);
  assert.equal(sheet.checklist21Items.reduce((sum, item) => sum + item.maxWeight, 0), 102);
});

test('classificação de saúde: com menos de 50% do peso verificado vira "evidência insuficiente"', async () => {
  const offline = await buildReportFixture({ dataStyle: 'phase4' });
  assert.equal(offline.judge.healthClassification, 'INSUFFICIENT_EVIDENCE');
  const live = await buildReportFixture({ dataStyle: 'phase4-live' });
  assert.notEqual(live.judge.healthClassification, 'INSUFFICIENT_EVIDENCE');
});
