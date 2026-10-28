import assert from 'node:assert/strict';
import test from 'node:test';
import { toBattlefieldMapModel } from '../src/lib/battlefield-map-adapter';
import { assessCriteria } from '../src/lib/pdf/report-evidence';
import { analyzeTerritory, buildRivalRows, computeScoreBreakdown } from '../src/lib/pdf/report-metrics';
import { buildReportFixture } from '../src/dev/report-fixture';

async function setup(options?: Parameters<typeof buildReportFixture>[0]) {
  const data = await buildReportFixture(options);
  const model = toBattlefieldMapModel({ battlefield: data.battlefield, lead: data.lead, auditId: data.auditId });
  const criteria = assessCriteria(data, model);
  const score = computeScoreBreakdown(criteria, data.judge.overallScore);
  return { data, model, criteria, score };
}

test('os pesos vêm do Juiz (soma 102) e nenhum critério é perdido', async () => {
  const { data, score } = await setup();
  const expected = data.judge.checklist21Items.reduce((sum, item) => sum + item.maxWeight, 0);
  assert.equal(score.totalWeight, expected);
  assert.equal(score.totalWeight, 102);
  assert.equal(score.totalCriteria, 21);
  assert.equal(score.groups.reduce((sum, group) => sum + group.criteria.length, 0), 21);
});

test('a fórmula oficial é preservada: recomposição igual ao Score Juiz do agente', async () => {
  const { data, score } = await setup();
  assert.equal(score.officialMatchesAgent, true);
  assert.equal(score.officialScore, data.judge.overallScore);
});

test('a fórmula é ponderada, não uma média simples das pontuações', async () => {
  const { data, score } = await setup();
  const items = data.judge.checklist21Items;
  const simpleMean = Number((items.reduce((s, i) => s + (i.scoreAwarded ?? 0), 0) / items.length).toFixed(1));
  assert.notEqual(simpleMean, score.officialScore);
  const weighted = Number(
    ((items.reduce((s, i) => s + ((i.scoreAwarded ?? 0) / 100) * i.maxWeight, 0) / score.totalWeight) * 100).toFixed(1)
  );
  assert.equal(weighted, score.officialScore);
});

test('cobertura (auditoria anterior): 5 de 21 critérios comprovados, 2 em parte, 25,5% do peso', async () => {
  const { score } = await setup();
  assert.equal(score.verified.count, 5);
  assert.equal(score.verified.weight, 26);
  assert.equal(score.verified.weightPercent, 25.5);
  assert.equal(score.partial.count, 2);
  assert.equal(score.partial.weight, 12);
  assert.equal(score.partial.weightPercent, 11.8);
  assert.equal(score.simulated.count, 6);
  assert.equal(score.notVerified.count, 8);
  assert.equal(
    score.verified.count + score.partial.count + score.simulated.count + score.notVerified.count,
    score.totalCriteria
  );
  assert.equal(
    score.verified.weight + score.partial.weight + score.simulated.weight + score.notVerified.weight,
    score.totalWeight
  );
});

test('parcialmente verificado fica à parte: não entra no desempenho verificado nem na cobertura verificada', async () => {
  const { criteria, score } = await setup();
  const without = computeScoreBreakdown(criteria.filter((c) => c.evidenceClass !== 'PARTIAL'), score.agentOfficialScore);
  assert.equal(without.verified.performance, score.verified.performance);
  assert.equal(without.verified.count, score.verified.count);
  const asVerified = computeScoreBreakdown(
    criteria.map((c) => (c.evidenceClass === 'PARTIAL' ? { ...c, evidenceClass: 'VERIFIED' as const } : c)),
    score.agentOfficialScore
  );
  assert.ok(asVerified.verified.weightPercent > score.verified.weightPercent);
});

test('critério sem pontuação (null) fica fora do numerador e do denominador do score histórico', async () => {
  const { criteria, score } = await setup();
  const cut = criteria.map((c) => (c.itemNumber === 1 ? { ...c, agentScore: null } : c));
  const result = computeScoreBreakdown(cut, score.agentOfficialScore);
  assert.equal(result.allCriteriaScored, false);
  assert.equal(result.range, null);
  const scored = cut.filter((c) => c.agentScore !== null);
  const weight = scored.reduce((s, c) => s + c.weight, 0);
  const earned = scored.reduce((s, c) => s + ((c.agentScore ?? 0) / 100) * c.weight, 0);
  assert.equal(result.officialScore, Number(((earned / weight) * 100).toFixed(1)));
});

test('desempenho nos critérios verificados usa a mesma fórmula, restrita aos comprovados', async () => {
  const { data, criteria, score } = await setup();
  const proven = criteria.filter((c) => c.evidenceClass === 'VERIFIED');
  const byCode = new Map(data.judge.checklist21Items.map((i) => [i.code, i]));
  let earned = 0;
  let weight = 0;
  for (const c of proven) {
    const item = byCode.get(c.code);
    assert.ok(item);
    earned += ((item.scoreAwarded ?? 0) / 100) * item.maxWeight;
    weight += item.maxWeight;
  }
  assert.equal(score.verified.performance, Number(((earned / weight) * 100).toFixed(1)));
});

test('faixa possível: mínimo com os não comprovados em 0% e máximo com todos em 100%', async () => {
  const { criteria, score } = await setup();
  const provenEarned = criteria
    .filter((c) => c.evidenceClass === 'VERIFIED')
    .reduce((sum, c) => sum + ((c.agentScore ?? 0) / 100) * c.weight, 0);
  assert.equal(score.range!.min, Number(((provenEarned / 102) * 100).toFixed(1)));
  assert.equal(score.range!.max, Number((((provenEarned + 76) / 102) * 100).toFixed(1)));
  assert.ok(score.range!.min <= score.officialScore && score.officialScore <= score.range!.max);
});

test('sem nenhum critério comprovado o desempenho verificado é indisponível (null), não 0%', async () => {
  const { criteria } = await setup();
  const none = criteria.map((c) => ({ ...c, evidenceClass: 'NOT_VERIFIED' as const }));
  const score = computeScoreBreakdown(none, 50);
  assert.equal(score.verified.count, 0);
  assert.equal(score.verified.performance, null);
  assert.equal(score.range!.min, 0);
  assert.equal(score.range!.max, 100);
});

test('os seis grupos de apresentação cobrem os 21 critérios reais', async () => {
  const { score } = await setup();
  assert.deepEqual(
    score.groups.map((g) => [g.key, g.criteria.length]),
    [
      ['IDENTITY', 4],
      ['CONVERSION', 2],
      ['CATEGORIES', 3],
      ['REPUTATION', 5],
      ['MEDIA', 4],
      ['GEO', 3],
    ]
  );
});

test('território: presença e setores calculados sem atribuir nomes de bairros', async () => {
  const { model } = await setup();
  const analysis = analyzeTerritory(model);
  assert.equal(analysis.sectors.length, 5);
  const north = analysis.sectors.find((s) => s.key === 'NORTH');
  assert.equal(north?.points, 21);
  assert.equal(analysis.companyPointLabel, '#2');
  const text = analysis.findings.join(' ');
  assert.match(text, /não foram atribuídos nomes de bairros/);
  assert.doesNotMatch(text, /Bairro [A-Z]/);
});

test('território sem leituras válidas informa a ausência em vez de inventar achados', async () => {
  const { data } = await setup();
  const empty = toBattlefieldMapModel({ battlefield: { ...data.battlefield, points: [] }, lead: data.lead });
  const analysis = analyzeTerritory(empty);
  assert.deepEqual(analysis.findings, ['Não há leituras válidas do território nesta auditoria.']);
});

test('rivais: valores padrão (4,8 e 140) não viram nota nem avaliações', async () => {
  const { data } = await setup();
  const rivals = {
    ...data.rivals,
    topDominators: data.rivals.topDominators.map((r, i) =>
      i === 0 ? { ...r, rating: 4.8, totalReviews: 140 } : r
    ),
  };
  const rows = buildRivalRows(rivals);
  assert.equal(rows[0]?.ratingVerified, false);
  assert.equal(rows[0]?.rating, null);
  assert.equal(rows[0]?.totalReviews, null);
  assert.equal(rows[1]?.ratingVerified, true);
  assert.ok(rows.every((r) => !('photos' in r) && !('responseRate' in r)));
});
