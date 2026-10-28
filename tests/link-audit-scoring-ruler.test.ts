import assert from 'node:assert/strict';
import test from 'node:test';
import { EVIDENCE_ORIGINS, EVIDENCE_STATUSES } from '../src/lib/link-audit/evidence';
import { CRITERIA, METHODOLOGY_VERSION as METHODOLOGY } from '../src/lib/link-audit/methodology';
import {
  METHODOLOGY_VERSION,
  NA_RULES,
  RULER_FINGERPRINT,
  RULES,
  SCORE_MODEL_VERSION,
  SCORE_MODELS,
  SUBCRITERIA,
  SUBCRITERION_IDS,
  TIERS,
} from '../src/lib/link-audit/scoring';
import { SCORING_EVIDENCE_STATUSES, SCORING_ORIGINS } from '../src/lib/link-audit/scoring/input';
import { frac } from '../src/lib/link-audit/scoring/math';
import { resolveAge, resolveAsc } from '../src/lib/link-audit/scoring/tiers';
import type { AgeTier, AscTier } from '../src/lib/link-audit/scoring/ruler';

/** Impressão digital da régua `regua-d3b-r2`. Se mudar sem NOVA scoreModelVersion, o teste falha de propósito. */
export const PINNED_RULER_FINGERPRINT = '957f88fd2928b0f0bb99c2689adb400eeb15b64c504bc72a26c1df40b22b387d';

test('os nove critérios e os pesos de methodology.ts são preservados e somam 100', () => {
  assert.deepEqual(
    CRITERIA.map((criterion) => [criterion.id, criterion.maxWeight]),
    [['NAP', 15], ['CATEGORIES', 10], ['SERVICES', 12], ['REVIEWS', 18], ['REVIEW_REPLIES', 8], ['VISUALS', 10], ['POSTS_ACTIVITY', 8], ['CONVERSION', 10], ['LOCAL_AUTHORITY', 9]],
  );
  assert.equal(CRITERIA.reduce((sum, criterion) => sum + criterion.maxWeight, 0), 100);
});

test('a soma dos subcritérios de cada critério é exatamente o peso (e o total é 100)', () => {
  let total = 0;
  for (const criterion of CRITERIA) {
    const sum = SUBCRITERIA.filter((def) => def.criterionId === criterion.id).reduce((acc, def) => acc + def.maxHalfPoints, 0);
    assert.equal(sum, criterion.maxWeight * 2, `${criterion.id}: ${sum / 2} ≠ ${criterion.maxWeight}`);
    total += sum;
  }
  assert.equal(total, 200);
  assert.equal(SUBCRITERIA.length, 35);
  assert.deepEqual(SUBCRITERIA.map((def) => def.id), [...SUBCRITERION_IDS]);
});

test('matriz homologada (D3B): máximos de cada subcritério', () => {
  const expected: Record<string, number> = {
    N1: 3, N2: 3, N3: 3, N4: 2, N5: 4, C1: 3, C2: 4, C3: 3, S1: 2, S2: 3, S3: 2, S4: 2, S5: 3, R1: 6, R2: 6, R3: 6, P1: 4, P2: 2, P3: 2,
    V1: 2, V2: 3, V3: 1, V4: 2, V5: 2, A1: 3, A2: 3, A3: 2, X1: 2, X2: 1, X3: 2, X4: 3, X5: 2, L1: 3, L2: 3, L3: 3,
  };
  for (const def of SUBCRITERIA) assert.equal(def.maxHalfPoints / 2, expected[def.id], def.id);
});

test('versionamento: methodologyVersion e scoreModelVersion são registrados separadamente', () => {
  assert.equal(METHODOLOGY_VERSION, 'lumos-reconstruida-v1');
  assert.equal(METHODOLOGY_VERSION, METHODOLOGY);
  assert.equal(SCORE_MODEL_VERSION, 'regua-d3b-r2');
  assert.notEqual(METHODOLOGY_VERSION, SCORE_MODEL_VERSION);
});

test('a régua tem impressão digital fixa e o modelo está registrado e congelado', () => {
  assert.match(RULER_FINGERPRINT, /^[a-f0-9]{64}$/);
  assert.equal(RULER_FINGERPRINT, PINNED_RULER_FINGERPRINT, 'mudar a régua exige NOVA scoreModelVersion (e novo modelo registrado)');
  const model = SCORE_MODELS[SCORE_MODEL_VERSION];
  assert.ok(model);
  assert.equal(model?.fingerprint, RULER_FINGERPRINT);
  assert.ok(Object.isFrozen(SCORE_MODELS));
  assert.ok(Object.isFrozen(model));
});

test('as origens e os status de evidência do motor coincidem com os do modelo de evidência existente', () => {
  assert.deepEqual([...SCORING_ORIGINS], [...EVIDENCE_ORIGINS]);
  assert.deepEqual([...SCORING_EVIDENCE_STATUSES], [...EVIDENCE_STATUSES]);
});

/* ---- Oráculos independentes (escritos a partir da D3B, não da tabela do código) ---- */
const oracle = {
  R1: (cents: number) => (cents >= 480 ? 12 : cents >= 450 ? 10 : cents >= 420 ? 8 : cents >= 400 ? 6 : cents >= 350 ? 4 : cents >= 300 ? 2 : 0),
  R2: (n: number) => (n >= 100 ? 12 : n >= 50 ? 10 : n >= 25 ? 8 : n >= 10 ? 6 : n >= 5 ? 4 : n >= 1 ? 2 : 0),
  R3: (d: number) => (d <= 30 ? 12 : d <= 90 ? 8 : d <= 180 ? 4 : d <= 365 ? 2 : 0),
  S1: (n: number) => (n >= 250 ? 4 : n >= 1 ? 2 : 0),
  S2: (n: number) => (n >= 5 ? 6 : n >= 3 ? 4 : n >= 1 ? 2 : 0),
  S3: (n: number) => (n >= 3 ? 4 : n >= 1 ? 2 : 0),
  S5: (n: number) => (n >= 5 ? 6 : n >= 1 ? 3 : 0),
  V1: (n: number) => (n >= 2 ? 4 : n >= 1 ? 2 : 0),
  V2: (n: number) => (n >= 20 ? 6 : n >= 10 ? 4 : n >= 5 ? 2 : n >= 1 ? 1 : 0),
  V3: (n: number) => (n >= 1 ? 2 : 0),
  V4: (d: number) => (d <= 90 ? 4 : d <= 365 ? 2 : 0),
  V5: (n: number) => (n >= 2 ? 4 : n >= 1 ? 2 : 0),
  A2: (d: number) => (d <= 30 ? 6 : d <= 60 ? 4 : d <= 90 ? 2 : 0),
  A3: (n: number) => (n >= 4 ? 4 : n >= 2 ? 2 : 0),
  X3: (n: number) => (n >= 3 ? 4 : n === 2 ? 3 : n === 1 ? 2 : 0),
  X4: (n: number) => (n >= 3 ? 6 : n === 2 ? 4 : n === 1 ? 2 : 0),
  N4: (n: number) => (n >= 7 ? 4 : n >= 1 ? 2 : 0),
  N5: (d: number) => (d === 0 ? 8 : d === 1 ? 5 : d === 2 ? 2 : 0),
  L3: (n: number) => (n >= 2 ? 6 : n === 1 ? 3 : 0),
  P2: (days2: number) => (days2 <= 14 ? 4 : days2 <= 60 ? 2 : 0), // dias × 2 (meia-dia)
};

function sweepAsc(name: keyof typeof TIERS, values: Iterable<number>, expected: (value: number) => number): void {
  const table = TIERS[name] as readonly AscTier[];
  let previous = -1;
  for (const value of values) {
    const tier = resolveAsc(table, frac(value));
    assert.equal(tier.halfPoints, expected(value), `${name}(${value})`);
    assert.ok(tier.halfPoints >= previous, `${name} deve ser monotônica`);
    previous = tier.halfPoints;
  }
}
function sweepAge(name: keyof typeof TIERS, values: Iterable<number>, expected: (value: number) => number): void {
  const table = TIERS[name] as readonly AgeTier[];
  let previous = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const tier = resolveAge(table, frac(value));
    assert.equal(tier.halfPoints, expected(value), `${name}(${value})`);
    assert.ok(tier.halfPoints <= previous, `${name} deve ser monotônica`);
    previous = tier.halfPoints;
  }
}
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('faixas: cada valor cai em exatamente uma faixa e todas conferem com o oráculo independente', () => {
  sweepAsc('R1', range(0, 500), oracle.R1);
  sweepAsc('R2', range(0, 1000), oracle.R2);
  sweepAsc('S1', range(0, 1000), oracle.S1);
  sweepAsc('S2', range(0, 60), oracle.S2);
  sweepAsc('S3', range(0, 60), oracle.S3);
  sweepAsc('S4', range(0, 60), oracle.S3);
  sweepAsc('S5', range(0, 60), oracle.S5);
  sweepAsc('V1', range(0, 2), oracle.V1);
  sweepAsc('V2', range(0, 200), oracle.V2);
  sweepAsc('V3', range(0, 20), oracle.V3);
  sweepAsc('V5', range(0, 3), oracle.V5);
  sweepAsc('A3', range(0, 60), oracle.A3);
  sweepAsc('X3', range(0, 4), oracle.X3);
  sweepAsc('X4', range(0, 3), oracle.X4);
  sweepAsc('N4', range(0, 7), oracle.N4);
  sweepAsc('L3', range(0, 4), oracle.L3);
  sweepAge('R3', range(0, 2000), oracle.R3);
  sweepAge('V4', range(0, 2000), oracle.V4);
  sweepAge('A2', range(0, 1000), oracle.A2);
  sweepAge('N5', range(0, 8), oracle.N5);
});

test('P1 (taxa de resposta): todas as frações a/b com b ≤ 60 conferem com o oráculo', () => {
  const oracleP1 = (a: number, b: number): number => (10 * a >= 9 * b ? 8 : 10 * a >= 7 * b ? 6 : 2 * a >= b ? 4 : a > 0 ? 2 : 0);
  for (let b = 1; b <= 60; b++) {
    for (let a = 0; a <= b; a++) assert.equal(resolveAsc(TIERS.P1, frac(a, b)).halfPoints, oracleP1(a, b), `${a}/${b}`);
  }
});

test('P2 (tempo de resposta): medianas em meio-dia conferem com o oráculo', () => {
  for (let halfDays = 0; halfDays <= 200; halfDays++) {
    assert.equal(resolveAge(TIERS.P2, frac(halfDays, 2)).halfPoints, oracle.P2(halfDays), `${halfDays / 2} dias`);
  }
});

test('regras numéricas homologadas (D3B-15 final e cobertura final)', () => {
  assert.equal(RULES.minCoveragePercent, 40);
  assert.equal(RULES.publishedFromCoveragePercent, 65);
  assert.equal(RULES.minCriteria, 3);
  assert.equal(RULES.minCriterionEvaluatedPoints, 3);
  assert.equal(RULES.minReviewsForRating, 5);
  assert.equal(RULES.minEligibleCompetitors, 3);
  assert.equal(RULES.competitorMinReviews, 5);
});

test('N/A: lista fechada; causas provadas pelos fatos são derivadas, as demais exigem o operador', () => {
  assert.deepEqual(Object.keys(NA_RULES).sort(), ['BUSINESS_MODEL', 'FEATURE_UNAVAILABLE', 'NO_ADDITIONAL_NEEDED', 'NO_REPLIES_PROVEN', 'NO_REVIEWS_PROVEN', 'NO_WEBSITE_PROVEN']);
  assert.deepEqual(Object.entries(NA_RULES).filter(([, rule]) => rule.derived).map(([code]) => code).sort(), ['NO_REPLIES_PROVEN', 'NO_REVIEWS_PROVEN', 'NO_WEBSITE_PROVEN']);
});
