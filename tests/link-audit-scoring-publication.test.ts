import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregate, classify, computeIndex, computeNaSensitivity } from '../src/lib/link-audit/scoring/aggregate';
import { computeConfidence } from '../src/lib/link-audit/scoring/confidence';
import { formatDay, parseDay, parseDayFromIso, relativeAgeBounds } from '../src/lib/link-audit/scoring/dates';
import { cmpFrac, formatHalfPoints, formatHundredths, frac, gcd, medianOfFracs, medianOfInts, reduceFrac, roundHalfUpDiv } from '../src/lib/link-audit/scoring/math';
import { buildPublication } from '../src/lib/link-audit/scoring/publication';
import { CRITERIA } from '../src/lib/link-audit/methodology';
import type { CriterionResult, SubcriterionResult, Totals } from '../src/lib/link-audit/scoring';
import type { Mutable } from './helpers/link-audit-fixtures';
import { clone, obs, record, richInput, run, scoreAudit, sub } from './helpers/link-audit-scoring-fixtures';

/* ---------------------------------------------------------------- aritmética exata */
test('math: frações, medianas, arredondamento meio-para-cima e formatação só com inteiros', () => {
  assert.equal(cmpFrac(frac(1, 3), frac(2, 6)), 0);
  assert.equal(cmpFrac(frac(1, 2), frac(2, 3)), -1);
  assert.equal(cmpFrac(frac(3, 2), frac(1, 1)), 1);
  assert.throws(() => frac(1, 0), RangeError);
  assert.throws(() => frac(0.5, 1), RangeError);
  assert.throws(() => cmpFrac(frac(Number.MAX_SAFE_INTEGER), frac(1, Number.MAX_SAFE_INTEGER)), RangeError, 'produto fora dos inteiros seguros é recusado');
  assert.deepEqual(medianOfInts([5, 1, 3]), frac(3));
  assert.deepEqual(medianOfInts([4, 1, 3, 2]), frac(5, 2));
  assert.deepEqual(medianOfFracs([frac(1, 2), frac(3, 2)]), frac(1));
  assert.throws(() => medianOfInts([]), RangeError);
  assert.equal(roundHalfUpDiv(149, 2), 75); // 74,5 -> 75
  assert.equal(roundHalfUpDiv(1, 2), 1);
  assert.equal(roundHalfUpDiv(0, 5), 0);
  assert.equal(roundHalfUpDiv(8, 5), 2);
  assert.throws(() => roundHalfUpDiv(1, 0), RangeError);
  assert.throws(() => roundHalfUpDiv(-1, 3), RangeError);
  assert.equal(gcd(12, 18), 6);
  assert.deepEqual(reduceFrac(frac(200, 400)), frac(1, 2));
  assert.equal(formatHundredths(8385), '83.85');
  assert.equal(formatHundredths(5), '0.05');
  assert.equal(formatHalfPoints(23), '11.5');
  assert.equal(formatHalfPoints(24), '12');
});

test('dates: dias civis puros (bissexto, limites, ida e volta) e datas relativas', () => {
  assert.equal(parseDay('1970-01-01'), 0);
  assert.equal(parseDay('2026-10-22'), 20748);
  assert.equal(parseDay('2024-02-29') !== null, true);
  for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '26-10-22', '2026-10-2', '', '2026/10/22', '1899-12-31', '2201-01-01']) assert.equal(parseDay(bad), null, bad);
  assert.equal(parseDayFromIso('2026-10-22T10:00:00-03:00'), parseDay('2026-10-22'));
  assert.equal(parseDayFromIso('2026-10-22T23:59:59.999Z'), parseDay('2026-10-22'));
  assert.equal(parseDayFromIso('2026-10-22T10:00:00'), null, 'sem offset não vale');
  for (let day = 20000; day < 22000; day += 37) assert.equal(parseDay(formatDay(day)), day);
  assert.equal(parseDay('2026-10-22')! - parseDay('2026-10-02')!, 20);
  assert.deepEqual(relativeAgeBounds(0, 'DAY'), { lo: 0, hi: 0 });
  assert.deepEqual(relativeAgeBounds(2, 'WEEK'), { lo: 14, hi: 20 });
  assert.deepEqual(relativeAgeBounds(3, 'MONTH'), { lo: 90, hi: 119 });
  assert.deepEqual(relativeAgeBounds(1, 'YEAR'), { lo: 365, hi: 729 });
});

/* ---------------------------------------------------------------- índice, arredondamento, classes */
const totals = (obtainedHalf: number, evaluatedHalf: number, over: Partial<Totals> = {}): Totals => ({
  obtainedHalfPoints: obtainedHalf,
  evaluatedHalfPoints: evaluatedHalf,
  coveragePercent: evaluatedHalf / 2,
  notApplicableHalfPoints: 0,
  sampleInsufficientHalfPoints: 0,
  notVerifiedHalfPoints: 200 - evaluatedHalf,
  eligibleCoverage: { n: evaluatedHalf, d: 200 },
  criteriaWithMinPoints: ['NAP', 'REVIEWS', 'CATEGORIES'],
  criteriaWithAnyPoints: ['NAP', 'REVIEWS', 'CATEGORIES'],
  ...over,
});

test('índice: arredondamento meio-para-cima e classificação sobre o inteiro exibido', () => {
  const cases: ReadonlyArray<readonly [number, number, number, string, string]> = [
    // obtidos (meios-pontos), avaliados (meios-pontos), exibido, decimal2, classe
    [77, 200, 39, '38.50', 'CRITICAL'], // 38,5 -> 39
    [79, 200, 40, '39.50', 'WEAK'], // 39,5 -> 40
    [118, 200, 59, '59.00', 'WEAK'],
    [119, 200, 60, '59.50', 'DEVELOPING'], // 59,5 -> 60
    [148, 200, 74, '74.00', 'DEVELOPING'],
    [149, 200, 75, '74.50', 'STRONG'], // 74,5 -> 75
    [178, 200, 89, '89.00', 'STRONG'],
    [179, 200, 90, '89.50', 'LOCAL_REFERENCE'], // 89,5 -> 90
    [200, 200, 100, '100.00', 'LOCAL_REFERENCE'],
    [199, 200, 100, '99.50', 'LOCAL_REFERENCE'], // 99,5 -> 100
    [101, 170, 59, '59.41', 'WEAK'], // 50,5/85
    [84, 114, 74, '73.68', 'DEVELOPING'], // 42/57
    [109, 130, 84, '83.85', 'STRONG'], // 54,5/65 do manual
    [0, 80, 0, '0.00', 'CRITICAL'], // índice zero comprovado
    [23, 36, 64, '63.89', 'DEVELOPING'], // 11,5/18
  ];
  for (const [o, e, shown, decimal, cls] of cases) {
    const index = computeIndex(totals(o, e));
    assert.ok(index, `${o}/${e}`);
    assert.equal(index?.shown, shown, `${o}/${e} exibido`);
    assert.equal(index?.decimal2, decimal, `${o}/${e} decimal`);
    assert.equal(index?.classification, cls, `${o}/${e} classe`);
  }
  assert.equal(computeIndex(totals(109, 130))?.classificationLabel, 'Forte');
  assert.deepEqual(computeIndex(totals(109, 130))?.exact, { num: 1090, den: 13 }, 'fração exata reduzida: 83,846…');
});

test('classes: fronteiras 0–39 Crítico · 40–59 Fraco · 60–74 Em desenvolvimento · 75–89 Forte · 90–100 Referência local', () => {
  const expected: Array<[number, string]> = [[0, 'CRITICAL'], [39, 'CRITICAL'], [40, 'WEAK'], [59, 'WEAK'], [60, 'DEVELOPING'], [74, 'DEVELOPING'], [75, 'STRONG'], [89, 'STRONG'], [90, 'LOCAL_REFERENCE'], [100, 'LOCAL_REFERENCE']];
  for (const [shown, cls] of expected) assert.equal(classify(shown), cls, String(shown));
  for (let shown = 0; shown <= 100; shown++) assert.ok(['CRITICAL', 'WEAK', 'DEVELOPING', 'STRONG', 'LOCAL_REFERENCE'].includes(classify(shown)));
});

test('base zero: denominador zero => sem índice (nunca 0) e sem sensibilidade', () => {
  assert.equal(computeIndex(totals(0, 0)), null);
  assert.equal(computeNaSensitivity(totals(0, 0, { notApplicableHalfPoints: 10 })), null);
  assert.equal(computeNaSensitivity(totals(10, 20)), null, 'sem N/A não há sensibilidade');
  assert.deepEqual(computeNaSensitivity(totals(10, 20, { notApplicableHalfPoints: 20 })), { shown: 25, decimal2: '25.00' });
});

/* ---------------------------------------------------------------- publicação */
test('publicação: gates e estados com totais sintéticos (cobertura, critérios com ≥ 3 pontos, NAP ou Avaliações)', () => {
  const status = (t: Totals) => buildPublication(t, true).status;
  assert.equal(status(totals(0, 0)), 'NO_DATA');
  assert.equal(status(totals(60, 78)), 'INSUFFICIENT'); // 39 %
  assert.equal(status(totals(60, 80)), 'PROVISIONAL'); // 40 %
  assert.equal(status(totals(60, 128)), 'PROVISIONAL'); // 64 %
  assert.equal(status(totals(60, 130)), 'PUBLISHED'); // 65 %
  assert.equal(status(totals(60, 178)), 'PUBLISHED'); // 89 %
  assert.equal(status(totals(60, 180)), 'PUBLISHED'); // 90 %
  // dois critérios com ≥ 3 pontos não bastam, mesmo com cobertura alta
  assert.equal(status(totals(60, 150, { criteriaWithMinPoints: ['NAP', 'REVIEWS'] })), 'INSUFFICIENT');
  assert.equal(buildPublication(totals(60, 150, { criteriaWithMinPoints: ['NAP', 'REVIEWS'] }), true).gates.find((g) => g.id === 'CRITERIA_MIN')?.passed, false);
  // três critérios, mas sem NAP nem Avaliações
  const noNap = totals(60, 150, { criteriaWithMinPoints: ['SERVICES', 'VISUALS', 'POSTS_ACTIVITY'] });
  assert.equal(status(noNap), 'INSUFFICIENT');
  assert.equal(buildPublication(noNap, true).gates.find((g) => g.id === 'NAP_OR_REVIEWS')?.passed, false);
  // NAP basta (sem Avaliações) e Avaliações basta (sem NAP)
  assert.equal(status(totals(60, 150, { criteriaWithMinPoints: ['NAP', 'SERVICES', 'VISUALS'] })), 'PUBLISHED');
  assert.equal(status(totals(60, 150, { criteriaWithMinPoints: ['REVIEWS', 'SERVICES', 'VISUALS'] })), 'PUBLISHED');
  // integridade falha => indisponível
  assert.equal(buildPublication(totals(60, 150), false).status, 'INSUFFICIENT');
  assert.match(buildPublication(totals(60, 70), true).statusText, /Índice indisponível/);
  assert.match(buildPublication(totals(60, 100), true).statusText, /provisório.*não é um relatório definitivo/);
  assert.match(buildPublication(totals(60, 150), true).statusText, /publicável.*cobertura, confiança e limitações/);
});

// Cada "unidade" restaura do perfil completo um conjunto independente de fatos, com pontos conhecidos.
interface Unit {
  readonly name: string;
  readonly points: number;
  readonly add: (draft: Mutable, rich: Mutable) => void;
}
const copyP = (key: string) => (draft: Mutable, rich: Mutable) => { draft.profile[key] = rich.profile[key]; };
const keepRecord = (draft: Mutable, rich: Mutable, id: string) => { draft.operatorRecords.push(rich.operatorRecords.find((r: Mutable) => r.id === id)); };
const siteBase = (draft: Mutable, rich: Mutable) => {
  if (!draft.site) draft.site = { scope: rich.site.scope };
};
const UNITS: readonly Unit[] = [
  { name: 'description', points: 2, add: copyP('description') },
  { name: 'services', points: 3, add: copyP('services') },
  { name: 'attributes', points: 2, add: copyP('attributes') },
  { name: 'products', points: 2, add: copyP('products') },
  { name: 'logoCover', points: 2, add: copyP('logoCover') },
  { name: 'photos', points: 3, add: copyP('photos') },
  { name: 'videos', points: 1, add: copyP('videos') },
  { name: 'latestMedia', points: 2, add: copyP('latestMedia') },
  { name: 'actions', points: 2, add: copyP('actions') },
  { name: 'latestReviewDate', points: 6, add: copyP('latestReviewDate') },
  { name: 'additional+C3', points: 3, add: (d, r) => { copyP('additionalCategories')(d, r); keepRecord(d, r, 'op-c3'); } },
  { name: 'C2', points: 4, add: (d, r) => keepRecord(d, r, 'op-c2') },
  { name: 'posts', points: 8, add: copyP('posts') },
  { name: 'replies+P3', points: 8, add: (d, r) => { copyP('replies')(d, r); keepRecord(d, r, 'op-p3'); } },
  { name: 'competitors', points: 6, add: (d, r) => { d.competitors = r.competitors; } },
  { name: 'authority', points: 3, add: (d, r) => { d.authority = r.authority; } },
  { name: 'offers', points: 3, add: (d, r) => { siteBase(d, r); d.site.offers = r.site.offers; } },
  { name: 'journey', points: 3, add: (d, r) => { siteBase(d, r); d.site.journey = r.site.journey; } },
  { name: 'accessibility', points: 1, add: (d, r) => { siteBase(d, r); d.site.accessibility = r.site.accessibility; } },
  { name: 'nap', points: 4, add: (d, r) => { d.nap = r.nap; } },
  { name: 'images', points: 2, add: (d, r) => keepRecord(d, r, 'op-img') },
];
const CORE_POINTS = 30; // NAP 11 (N1–N4), R1+R2 12, X1+X5 4, C1 3

function coverageInput(selection: readonly Unit[]): Mutable {
  const rich = richInput();
  const draft: Mutable = { schemaVersion: 1, auditId: 'audit-cobertura-01', referenceDate: rich.referenceDate, evidences: rich.evidences, operatorRecords: [], profile: {} };
  for (const key of ['name', 'address', 'phone', 'hours', 'website', 'primaryCategory', 'reviews']) draft.profile[key] = rich.profile[key];
  for (const unit of selection) unit.add(draft, rich);
  if (draft.site) {
    const needsObs = draft.site.offers || draft.site.journey;
    if (needsObs) keepRecord(draft, rich, 'op-obs');
    keepRecord(draft, rich, 'op-scope');
  }
  return draft;
}

function subsetWithSum(target: number): Unit[] {
  const reachable = new Map<number, Unit[]>([[0, []]]);
  for (const unit of UNITS) {
    for (const [sum, chosen] of [...reachable.entries()]) {
      if (sum + unit.points <= target && !reachable.has(sum + unit.points)) reachable.set(sum + unit.points, [...chosen, unit]);
    }
  }
  const found = reachable.get(target);
  assert.ok(found, `não há combinação de unidades com ${target} pontos`);
  return found;
}

test('cobertura exata nas fronteiras 39 %, 40 %, 64 %, 65 %, 89 % e 90 % (motor completo)', () => {
  const expected: ReadonlyArray<readonly [number, string]> = [[39, 'INSUFFICIENT'], [40, 'PROVISIONAL'], [64, 'PROVISIONAL'], [65, 'PUBLISHED'], [89, 'PUBLISHED'], [90, 'PUBLISHED']];
  for (const [target, status] of expected) {
    const outcome = scoreAudit(coverageInput(subsetWithSum(target - CORE_POINTS)));
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join(' | '));
    if (!outcome.ok) continue;
    const r = outcome.result;
    assert.equal(r.totals.coveragePercent, target, `cobertura ${target}`);
    assert.equal(r.publication.status, status, `estado em ${target} %`);
    if (status === 'INSUFFICIENT') {
      assert.equal(r.index, null, 'abaixo de 40 % o índice é indisponível');
      assert.equal(r.confidence, null);
      const gates = Object.fromEntries(r.publication.gates.map((g) => [g.id, g.passed]));
      assert.deepEqual(gates, { EVALUATED_DATA: true, COVERAGE_MIN: false, CRITERIA_MIN: true, NAP_OR_REVIEWS: true, INTEGRITY: true });
    } else {
      assert.ok(r.index, 'índice presente');
      assert.equal(r.index?.shown, 100, 'tudo o que foi avaliado está no máximo');
      assert.ok(r.confidence);
      assert.ok(r.notices.some((n) => n.includes(`cobertura de ${target}%`)), 'o estado informa a cobertura');
      assert.match(r.publication.statusText, status === 'PROVISIONAL' ? /provisório/ : /publicável/);
    }
  }
});

test('confiança nas bordas 89 % e 90 %: só 90 % com tudo em ordem chega a Alta', () => {
  const without = (...names: string[]) => (d: Mutable) => {
    for (const name of names) {
      if (name === 'replies') { delete d.profile.replies; d.operatorRecords = d.operatorRecords.filter((r: Mutable) => r.id !== 'op-p3'); }
      if (name === 'latestMedia') delete d.profile.latestMedia;
      if (name === 'accessibility') delete d.site.accessibility;
    }
  };
  const ninety = run(without('replies', 'latestMedia')); // 100 − 8 − 2
  assert.equal(ninety.totals.coveragePercent, 90);
  assert.equal(ninety.confidence?.level, 'HIGH');
  const eightyNine = run(without('replies', 'latestMedia', 'accessibility')); // 89
  assert.equal(eightyNine.totals.coveragePercent, 89);
  assert.equal(eightyNine.confidence?.level, 'MEDIUM');
  assert.deepEqual(eightyNine.confidence?.limitingFactors, ['COVERAGE']);
});

test('índice zero: perfil novo e vazio, com 7 critérios avaliados, é provisório, 0 e Crítico (não indisponível)', () => {
  const empty = (): Mutable => ({
    schemaVersion: 1,
    auditId: 'audit-perfil-novo',
    referenceDate: '2026-10-22',
    evidences: [{ id: 'n1', origin: 'GOOGLE_NATIVE', capture: 'STORED_CAPTURE', status: 'VERIFIED', observedAt: '2026-10-20T10:00:00-03:00', contentSha256: 'a'.repeat(64) }],
    profile: {
      name: [obs(null)],
      address: [obs({ raw: 'Sem endereço público', parsed: { none: true } })],
      phone: [obs(null)],
      hours: [obs({ kind: 'STRUCTURED', days: [] })],
      website: [obs(null)],
      primaryCategory: [obs(null)],
      additionalCategories: [obs([])],
      description: [obs({ lengthChars: 0 })],
      services: [obs(0)],
      attributes: [obs(0)],
      products: [obs(0)],
      logoCover: [obs({ logo: false, cover: false })],
      photos: [obs(0)],
      videos: [obs(0)],
      reviews: [obs({ ratingShown: null, reviewCount: 0 })],
      posts: [obs({ exposed: true, items: [] })],
      actions: [obs({ kinds: [] })],
    },
    operatorRecords: [record('JUDGEMENT', 'op-c3', { subcriterionId: 'C3', value: 'MISSING_NEEDED' })],
  });
  const outcome = scoreAudit(empty());
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join(' | '));
  if (!outcome.ok) return;
  const r = outcome.result;
  assert.equal(r.totals.obtainedHalfPoints, 0);
  assert.equal(r.totals.coveragePercent, 52);
  assert.equal(r.totals.criteriaWithMinPoints.length, 7);
  assert.equal(r.publication.status, 'PROVISIONAL');
  assert.equal(r.index?.shown, 0, 'zero comprovado com cobertura suficiente é um índice 0 válido');
  assert.equal(r.index?.classification, 'CRITICAL');
  assert.equal(r.confidence?.level, 'LOW');
  assert.ok(r.totals.notApplicableHalfPoints > 0);
  assert.ok(r.naSensitivity);

  // três critérios avaliados, todos em zero comprovado: cobertura baixa => indisponível (não é índice 0)
  const three = empty();
  for (const key of ['reviews', 'posts', 'actions', 'website', 'primaryCategory', 'additionalCategories']) delete three.profile[key];
  three.operatorRecords = [];
  const small = scoreAudit(three);
  assert.ok(small.ok);
  if (!small.ok) return;
  assert.equal(small.result.totals.obtainedHalfPoints, 0);
  assert.deepEqual(small.result.totals.criteriaWithMinPoints, ['NAP', 'SERVICES', 'VISUALS'], 'três critérios em zero comprovado (28 pontos)');
  assert.equal(small.result.totals.coveragePercent, 28);
  assert.equal(small.result.index, null);
  assert.equal(small.result.publication.status, 'INSUFFICIENT');
});

test('três critérios com apenas 1–2 pontos avaliados NÃO satisfazem o mínimo de critérios', () => {
  const draft = clone(richInput());
  draft.profile = {
    hours: [obs({ kind: 'STRUCTURED', days: [{ day: 1, closed: false, intervals: [['08:00', '12:00']] }] })], // N4: 2 pontos avaliados
    description: [obs({ lengthChars: 400 })], // S1: 2 pontos avaliados
    logoCover: [obs({ logo: true, cover: true })], // V1: 2 pontos avaliados
  };
  delete draft.site;
  delete draft.nap;
  delete draft.competitors;
  delete draft.authority;
  draft.operatorRecords = [];
  const r = scoreAudit(draft);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.result.totals.criteriaWithAnyPoints.length, 3, 'há 3 critérios com algum ponto');
  assert.deepEqual(r.result.totals.criteriaWithMinPoints, [], 'nenhum deles tem ≥ 3 pontos avaliados');
  assert.equal(r.result.publication.status, 'INSUFFICIENT');
  assert.equal(r.result.publication.gates.find((g) => g.id === 'CRITERIA_MIN')?.passed, false);
  assert.equal(r.result.index, null);
  // o mesmo vale mesmo com cobertura alta: critérios com 1–2 pontos nunca contam
  assert.equal(buildPublication(totals(60, 150, { criteriaWithMinPoints: [] }), true).status, 'INSUFFICIENT');
});

test('sem NAP nem Avaliações (cobertura ≥ 40 %) o índice fica indisponível', () => {
  const r = run((d) => {
    for (const key of ['name', 'address', 'phone', 'hours', 'reviews', 'latestReviewDate', 'replies']) delete d.profile[key];
    d.operatorRecords = d.operatorRecords.filter((rec: Mutable) => rec.id !== 'op-p3');
  });
  assert.ok(r.totals.coveragePercent >= 40, `cobertura ${r.totals.coveragePercent}`);
  assert.ok(r.totals.criteriaWithMinPoints.length >= 3);
  assert.ok(!r.totals.criteriaWithMinPoints.includes('NAP') && !r.totals.criteriaWithMinPoints.includes('REVIEWS'));
  assert.equal(r.publication.status, 'INSUFFICIENT');
  assert.equal(r.publication.gates.find((g) => g.id === 'NAP_OR_REVIEWS')?.passed, false);
  assert.equal(r.index, null);
});

/* ---------------------------------------------------------------- confiança: seis fatores, bordas exatas */
function mkSub(id: string, evaluatedHalf: number, grade: 'PRIMARY' | 'SECONDARY', age: number, state: 'SCORED' | 'NOT_APPLICABLE' = 'SCORED'): SubcriterionResult {
  return { id, criterionId: 'NAP', maxHalfPoints: evaluatedHalf, state, obtainedHalfPoints: 0, evaluatedHalfPoints: state === 'SCORED' ? evaluatedHalf : 0, tier: null, reasonCode: 'TIER_MATCHED', reason: '', evidenceIds: ['e'], operatorRecordIds: [], grade, maxEvidenceAgeDays: age, notes: [] } as unknown as SubcriterionResult;
}
interface Spec {
  readonly evaluatedHalf?: number;
  readonly counted?: number;
  readonly secondaryHalf?: number;
  readonly agedHalf?: number;
  readonly conflicts?: number;
  readonly naHalf?: number;
}
function confidenceOf(spec: Spec) {
  const evaluatedHalf = spec.evaluatedHalf ?? 200;
  const secondary = spec.secondaryHalf ?? 0;
  const aged = spec.agedHalf ?? 0;
  const naHalf = spec.naHalf ?? 0;
  const subs = [
    mkSub('s1', evaluatedHalf - secondary - aged, 'PRIMARY', 0),
    mkSub('s2', aged, 'PRIMARY', 100),
    mkSub('s3', secondary, 'SECONDARY', 0),
    ...(naHalf > 0 ? [mkSub('s4', naHalf, 'PRIMARY', 0, 'NOT_APPLICABLE')] : []),
  ].filter((s) => s.maxHalfPoints > 0);
  const counted = spec.counted ?? 9;
  const criteria: CriterionResult[] = CRITERIA.map((c, i) => ({
    id: c.id, label: c.label, weight: c.maxWeight, status: i < counted ? 'EVALUATED' : 'NOT_VERIFIED',
    obtainedHalfPoints: 0,
    evaluatedHalfPoints: i < counted ? c.maxWeight * 2 : 0,
    notApplicableHalfPoints: 0, sampleInsufficientHalfPoints: 0, notVerifiedHalfPoints: 0, subcriteria: [],
  }));
  const t = totals(0, evaluatedHalf, { notApplicableHalfPoints: naHalf });
  const conflicts = Array.from({ length: spec.conflicts ?? 0 }, (_, i) => ({ field: `profile.f${i}`, subcriteria: [], observations: [] }));
  return computeConfidence(subs, criteria, t, conflicts as never);
}
const levelOf = (spec: Spec, factor: string): string | undefined => confidenceOf(spec).factors.find((f) => f.id === factor)?.level;

test('confiança — fator 1 (cobertura): 40–64 Baixa · 65–89 Média · ≥ 90 Alta', () => {
  for (const [cov, expected] of [[40, 'LOW'], [64, 'LOW'], [65, 'MEDIUM'], [89, 'MEDIUM'], [90, 'HIGH'], [100, 'HIGH']] as const) {
    assert.equal(levelOf({ evaluatedHalf: cov * 2 }, 'COVERAGE'), expected, `${cov} %`);
  }
});
test('confiança — fator 2 (amplitude): B ≤ 4 Baixa · 5–6 Média · ≥ 7 Alta', () => {
  for (const [counted, expected] of [[0, 'LOW'], [4, 'LOW'], [5, 'MEDIUM'], [6, 'MEDIUM'], [7, 'HIGH'], [9, 'HIGH']] as const) {
    assert.equal(levelOf({ counted }, 'BREADTH'), expected, `B=${counted}`);
  }
});
test('confiança — fator 3 (confiabilidade): < 60 % Baixa · 60–89,99 % Média · ≥ 90 % Alta (aritmética exata)', () => {
  for (const [secondary, expected] of [[0, 'HIGH'], [20, 'HIGH'], [21, 'MEDIUM'], [80, 'MEDIUM'], [81, 'LOW'], [200, 'LOW']] as const) {
    assert.equal(levelOf({ secondaryHalf: secondary }, 'RELIABILITY'), expected, `${secondary} de 200 secundários`);
  }
});
test('confiança — fator 4 (atualidade): ≤ 10 % Alta · ≤ 40 % Média · > 40 % Baixa', () => {
  for (const [aged, expected] of [[0, 'HIGH'], [20, 'HIGH'], [21, 'MEDIUM'], [80, 'MEDIUM'], [81, 'LOW']] as const) {
    assert.equal(levelOf({ agedHalf: aged }, 'FRESHNESS'), expected, `${aged} de 200 envelhecidos`);
  }
});
test('confiança — fator 5 (conflitos): 0 Alta · 1–2 Média · ≥ 3 Baixa', () => {
  for (const [k, expected] of [[0, 'HIGH'], [1, 'MEDIUM'], [2, 'MEDIUM'], [3, 'LOW'], [9, 'LOW']] as const) assert.equal(levelOf({ conflicts: k }, 'CONFLICTS'), expected, `K=${k}`);
});
test('confiança — fator 6 (peso N/A): ≤ 15 Alta · 16–30 Média · > 30 Baixa', () => {
  for (const [naHalf, expected] of [[0, 'HIGH'], [30, 'HIGH'], [31, 'MEDIUM'], [60, 'MEDIUM'], [61, 'LOW']] as const) assert.equal(levelOf({ naHalf, evaluatedHalf: 120 }, 'NA_WEIGHT'), expected, `${naHalf / 2} pontos`);
});

test('confiança: resultado = menor dos seis fatores, com fator limitante, justificativas fixas e rastreáveis; nunca Alta só por cobertura', () => {
  const ok = confidenceOf({});
  assert.equal(ok.level, 'HIGH');
  assert.equal(ok.levelLabel, 'Alta');
  assert.equal(ok.limitingFactors.length, 6);
  const lowReliability = confidenceOf({ secondaryHalf: 120 });
  assert.equal(lowReliability.level, 'LOW', '100 pontos avaliados, mas 60 % deles com evidência secundária');
  assert.deepEqual(lowReliability.limitingFactors, ['RELIABILITY']);
  assert.equal(confidenceOf({ conflicts: 1 }).level, 'MEDIUM');
  assert.deepEqual(confidenceOf({ conflicts: 1 }).limitingFactors, ['CONFLICTS']);
  assert.deepEqual(confidenceOf({ counted: 4 }).limitingFactors, ['BREADTH']);
  assert.deepEqual(confidenceOf({ naHalf: 80, evaluatedHalf: 120 }).limitingFactors.includes('NA_WEIGHT'), true);
  for (const factor of ok.factors) {
    assert.ok(factor.justification.length > 20, `${factor.id}: justificativa`);
    assert.ok(Array.isArray(factor.refs));
    assert.ok(Number.isInteger(factor.value.n) && Number.isInteger(factor.value.d));
  }
  assert.deepEqual(lowReliability.factors.find((f) => f.id === 'RELIABILITY')?.refs, ['s3'], 'a justificativa aponta os subcritérios responsáveis');
  assert.match(lowReliability.factors.find((f) => f.id === 'RELIABILITY')?.justification ?? '', /40\.00% dos pontos avaliados têm evidência primária/);
  assert.equal(JSON.stringify(confidenceOf({ secondaryHalf: 40 })), JSON.stringify(confidenceOf({ secondaryHalf: 40 })), 'determinístico');
});

test('confiança no motor: evidência secundária, envelhecida e peso N/A reduzem o nível', () => {
  assert.equal(run((d) => { d.evidences.forEach((e: Mutable) => { e.capture = 'OPERATOR_STATEMENT'; }); }).confidence?.level, 'LOW');
  const aged = run((d) => { d.evidences.forEach((e: Mutable) => { e.observedAt = '2026-07-20T10:00:00-03:00'; }); });
  assert.equal(aged.confidence?.factors.find((f) => f.id === 'FRESHNESS')?.level, 'LOW');
  assert.equal(aged.confidence?.level, 'LOW');
  const manyNa = run((d) => {
    d.profile.reviews = [obs({ ratingShown: null, reviewCount: 0 })];
    delete d.profile.replies; delete d.profile.latestReviewDate;
    d.operatorRecords = d.operatorRecords.filter((r: Mutable) => r.id !== 'op-p3');
  });
  assert.equal(manyNa.totals.notApplicableHalfPoints, 12 + 12 + 6 + 8 + 4 + 4);
  assert.equal(manyNa.confidence?.factors.find((f) => f.id === 'NA_WEIGHT')?.level, 'MEDIUM');
  assert.ok(manyNa.confidence?.factors.find((f) => f.id === 'NA_WEIGHT')?.refs.includes('R1'));
  // com N/A o peso elegível cai e a cobertura global NÃO sobe
  assert.ok(manyNa.totals.coveragePercent < 100);
});

test('aggregate: critérios e totais coerentes com os subcritérios', () => {
  const r = run();
  const again = aggregate(r.subcriteria);
  assert.deepEqual(again.totals, r.totals);
  assert.equal(r.criteria.find((c) => c.id === 'REVIEWS')?.evaluatedHalfPoints, 36);
  assert.equal(r.totals.criteriaWithMinPoints.length, 9);
  assert.equal(sub(r, 'N5').maxHalfPoints, 8);
});
