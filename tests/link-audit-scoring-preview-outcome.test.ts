import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperatorRecord, ScoreResult } from '../src/lib/link-audit/scoring';
import { buildCriteria } from '../src/lib/link-audit-scoring-runs/preview';
import { attributeFailure, deriveOutcome, fromMapper, MAX_ATTRIBUTION_RUNS, previewBlocker, sortPreviewBlockers, toPublicView } from '../src/lib/link-audit-scoring-runs';
import { run, without } from './helpers/link-audit-scoring-fixtures';

/* Onda 6C, I3 — desfecho (§12.1), projeção pública (§12.2) e atribuição de falhas por experimento. Usa o motor REAL com a fixture rica da 6A. */
const synthetic = (status: string, failed: string[], coverage: number): ScoreResult =>
  ({ publication: { status, gates: ['EVALUATED_DATA', 'COVERAGE_MIN', 'CRITERIA_MIN', 'NAP_OR_REVIEWS', 'INTEGRITY'].map((id) => ({ id, passed: !failed.includes(id), text: id })) }, totals: { coveragePercent: coverage } }) as unknown as ScoreResult;
const hasObtained = (value: unknown): boolean => /obtainedHalfPoints/.test(JSON.stringify(value));

test('desfecho a partir dos 4 estados de publicação do motor (§12.1)', () => {
  assert.deepEqual(deriveOutcome(synthetic('PUBLISHED', [], 80)), { outcome: 'PONTUADO', level: 'PUBLICAVEL', reasonCode: null, failedGates: [], coveragePercent: 80, minimumCoveragePercent: 40 });
  assert.deepEqual([deriveOutcome(synthetic('PROVISIONAL', [], 50)).outcome, deriveOutcome(synthetic('PROVISIONAL', [], 50)).level], ['PONTUADO', 'PROVISORIO']);
  assert.deepEqual([deriveOutcome(synthetic('NO_DATA', ['EVALUATED_DATA', 'COVERAGE_MIN'], 0)).reasonCode, deriveOutcome(synthetic('NO_DATA', ['EVALUATED_DATA'], 0)).outcome], ['SEM_DADOS_AVALIADOS', 'INCONCLUSIVO']);
  assert.equal(deriveOutcome(synthetic('INSUFFICIENT', ['COVERAGE_MIN', 'CRITERIA_MIN'], 17)).reasonCode, 'COBERTURA_INSUFICIENTE');
  assert.equal(deriveOutcome(synthetic('INSUFFICIENT', ['CRITERIA_MIN', 'NAP_OR_REVIEWS'], 45)).reasonCode, 'CRITERIOS_INSUFICIENTES');
  assert.equal(deriveOutcome(synthetic('INSUFFICIENT', ['NAP_OR_REVIEWS'], 45)).reasonCode, 'SEM_NAP_OU_AVALIACOES');
  assert.deepEqual(deriveOutcome(synthetic('INSUFFICIENT', ['COVERAGE_MIN', 'NAP_OR_REVIEWS'], 17)).failedGates, ['COVERAGE_MIN', 'NAP_OR_REVIEWS']);
  for (const status of ['NO_DATA', 'INSUFFICIENT']) assert.equal(deriveOutcome(synthetic(status, ['COVERAGE_MIN'], 0)).level, null);
});

test('motor real: resultado publicável/provisório vira PONTUADO e mantém os pontos; sem dados ou cobertura baixa vira INCONCLUSIVO e perde todo ponto obtido', () => {
  const rich = run();
  const outcome = deriveOutcome(rich);
  assert.deepEqual([rich.publication.status, outcome.outcome, outcome.level], ['PUBLISHED', 'PONTUADO', 'PUBLICAVEL']);
  const view = toPublicView(rich, outcome) as Record<string, any>;
  assert.ok(view.index !== null && view.confidence !== null);
  assert.ok(hasObtained(view), 'PONTUADO exibe pontos');
  assert.equal(Object.hasOwn(view, 'displayData'), false, 'dados de exibição do motor nunca são repassados');

  const provisional = run(without('reviews', 'replies', 'posts', 'photos', 'videos', 'services', 'attributes', 'products', 'description', 'logoCover', 'latestMedia', 'latestReviewDate', 'actions'));
  const provisionalOutcome = deriveOutcome(provisional);
  assert.deepEqual([provisional.publication.status, provisional.totals.coveragePercent, provisionalOutcome.outcome, provisionalOutcome.level], ['PROVISIONAL', 41, 'PONTUADO', 'PROVISORIO']);
  assert.ok(hasObtained(toPublicView(provisional, provisionalOutcome)));
  // sempre que o desfecho for INCONCLUSIVO, qualquer que seja a causa, nada que pareça nota sai
  const none = run((draft) => { delete draft.profile; delete draft.operatorRecords; delete draft.site; delete draft.nap; delete draft.competitors; delete draft.authority; });
  const noneOutcome = deriveOutcome(none);
  assert.deepEqual([noneOutcome.outcome, noneOutcome.reasonCode], ['INCONCLUSIVO', 'SEM_DADOS_AVALIADOS']);
  const noneView = toPublicView(none, noneOutcome);
  assert.ok(!hasObtained(noneView));
});

test('a projeção não altera o resultado original (que continua verificável) e não repassa chaves de nota em INCONCLUSIVO', () => {
  const none = run((draft) => { delete draft.profile; delete draft.operatorRecords; delete draft.site; delete draft.nap; delete draft.competitors; delete draft.authority; });
  const before = JSON.stringify(none);
  const view = toPublicView(none, deriveOutcome(none)) as Record<string, any>;
  assert.equal(JSON.stringify(none), before);
  for (const key of ['index', 'confidence', 'naSensitivity']) assert.equal(view[key], null);
  assert.ok(typeof view.resultSha256 === 'string' && view.resultSha256 === none.resultSha256);
});

test('PONTUADO: pontos obtidos só existem (número) para subcritério/critério avaliado; NOT_VERIFIED, NOT_APPLICABLE e SAMPLE_INSUFFICIENT levam null, nunca 0 ("ausência nunca vira zero")', () => {
  const provisional = run(without('reviews', 'replies', 'posts', 'photos', 'videos', 'services', 'attributes', 'products', 'description', 'logoCover', 'latestMedia', 'latestReviewDate', 'actions'));
  const view = toPublicView(provisional, deriveOutcome(provisional)) as Record<string, any>;
  const subs = view.subcriteria as Array<Record<string, any>>;
  const states = new Set(subs.map((item) => item.state));
  assert.ok(states.has('NOT_VERIFIED') && (states.has('SCORED') || states.has('ABSENCE_PROVEN')), 'a fixture precisa misturar avaliado e não verificado');
  for (const item of subs) {
    const evaluated = item.state === 'SCORED' || item.state === 'ABSENCE_PROVEN';
    assert.ok(Object.hasOwn(item, 'obtainedHalfPoints'), `${item.id}: o campo existe em PONTUADO`);
    if (evaluated) assert.equal(typeof item.obtainedHalfPoints, 'number', `${item.id} avaliado ⇒ número`);
    else assert.equal(item.obtainedHalfPoints, null, `${item.id} (${item.state}) ⇒ null, nunca 0`);
  }
  for (const item of view.criteria as Array<Record<string, any>>) {
    if (item.status === 'EVALUATED' || item.status === 'PARTIAL') assert.equal(typeof item.obtainedHalfPoints, 'number');
    else assert.equal(item.obtainedHalfPoints, null, `${item.id} (${item.status}) ⇒ null`);
  }
});

test('prévia PONTUADA (matriz de critérios): obtainedHalfPoints é número no avaliado e null em NOT_VERIFIED; INCONCLUSIVO omite o campo', () => {
  const provisional = run(without('reviews', 'replies', 'posts', 'photos', 'videos', 'services', 'attributes', 'products', 'description', 'logoCover', 'latestMedia', 'latestReviewDate', 'actions'));
  const view = provisional.subcriteria.map((item) => ({ id: item.id, criterionId: item.criterionId, maxHalfPoints: item.maxHalfPoints, source: 'AUTOMATICO', reasonCode: null, factEmitted: true, evidenceRefs: [], decisionIds: [] }));
  const criteria = buildCriteria(view as never, provisional, deriveOutcome(provisional));
  const subs = criteria.flatMap((item) => item.subcriteria);
  assert.ok(subs.some((item) => item.state === 'NOT_VERIFIED') && subs.some((item) => item.state === 'SCORED'));
  for (const item of subs) {
    if (item.state === 'SCORED' || item.state === 'ABSENCE_PROVEN') assert.equal(typeof item.obtainedHalfPoints, 'number', item.id);
    else assert.equal(item.obtainedHalfPoints, null, `${item.id} ${item.state}`);
  }
  for (const item of criteria) {
    if (item.status === 'EVALUATED' || item.status === 'PARTIAL') assert.equal(typeof item.obtainedHalfPoints, 'number', item.id);
    else assert.equal(item.obtainedHalfPoints, null, `${item.id} ${item.status}`);
  }
  const none = run((draft) => { delete draft.profile; delete draft.operatorRecords; delete draft.site; delete draft.nap; delete draft.competitors; delete draft.authority; });
  assert.ok(!hasObtained(buildCriteria(view as never, none, deriveOutcome(none))));
});

/* ---------------------------------------------------------------- atribuição por experimento */
const rec = (id: string): OperatorRecord => ({ id }) as unknown as OperatorRecord;
const ids = (records: readonly OperatorRecord[]): string[] => records.map((r) => r.id);

test('atribuição: o culpado único é isolado; pares que só falham juntos aparecem juntos; culpados independentes são todos achados', () => {
  const pool = ['op-0001', 'op-0002', 'op-0003', 'op-0004', 'op-0005'].map(rec);
  assert.deepEqual(attributeFailure(pool, (s) => ids(s).includes('op-0003')), { ids: ['op-0003'], exact: true, independentOfDecisions: false });
  assert.deepEqual(attributeFailure(pool, (s) => ids(s).includes('op-0002') && ids(s).includes('op-0005')).ids, ['op-0002', 'op-0005']);
  assert.deepEqual(attributeFailure(pool, (s) => ids(s).includes('op-0001') || ids(s).includes('op-0004')).ids, ['op-0001', 'op-0004']);
  assert.deepEqual(attributeFailure(pool, (s) => ids(s).length > 0).ids, ['op-0001', 'op-0002', 'op-0003', 'op-0004', 'op-0005'], 'toda decisão sozinha falha ⇒ todas são culpadas');
});

test('atribuição: falha que persiste SEM decisões não é culpa delas; é determinística e não depende da ordem; respeita o orçamento de execuções', () => {
  const pool = ['op-0002', 'op-0001', 'op-0003'].map(rec);
  assert.deepEqual(attributeFailure(pool, () => true), { ids: [], exact: true, independentOfDecisions: true });
  const culprit = (s: readonly OperatorRecord[]) => ids(s).includes('op-0001') && ids(s).includes('op-0003');
  const forward = attributeFailure(pool, culprit);
  const backward = attributeFailure([...pool].reverse(), culprit);
  assert.deepEqual(forward, backward);
  const many = Array.from({ length: 300 }, (_, i) => rec(`op-${String(i + 1).padStart(4, '0')}`));
  let runs = 0;
  const single = attributeFailure(many, (s) => (runs++, ids(s).includes('op-0299')));
  assert.deepEqual(single, { ids: ['op-0299'], exact: true, independentOfDecisions: false });
  assert.ok(runs <= 40, `bisseção: um culpado em 300 custa ${runs} execuções (não 300)`);
  // 198 registros inocentes + 2 que só falham juntos (o caso do revisor): isolados com precisão, sem culpar inocentes
  const noise = Array.from({ length: 198 }, (_, i) => rec(`op-${String(i + 1).padStart(4, '0')}`));
  const pair = [...noise, rec('op-0199'), rec('op-0200')];
  runs = 0;
  const found = attributeFailure(pair, (s) => (runs++, ids(s).includes('op-0199') && ids(s).includes('op-0200')));
  assert.deepEqual(found, { ids: ['op-0199', 'op-0200'], exact: true, independentOfDecisions: false });
  assert.ok(runs <= MAX_ATTRIBUTION_RUNS, `execuções: ${runs}`);
  // todos culpados individualmente: estoura o orçamento, mas devolve CANDIDATOS (nunca omite culpado) e marca exact:false
  runs = 0;
  const everyone = attributeFailure(many, (s) => (runs++, s.length > 0));
  assert.ok(runs <= MAX_ATTRIBUTION_RUNS + 1, `execuções: ${runs}`);
  assert.equal(everyone.exact, false);
  assert.ok(many.every((record) => everyone.ids.includes(record.id)), 'candidatos ⊇ culpados quando o orçamento acaba');
});

test('bloqueios: ordem estável (BLOCKING primeiro), ids únicos e ordenados, mensagens fixas', () => {
  const a = previewBlocker('DECISION_PENDING', 'BLOCKING', { decisionIds: ['op-0002', 'op-0001', 'op-0002'] });
  const b = previewBlocker('NO_STORED_CAPTURE', 'BLOCKING');
  const c = fromMapper({ code: 'PROFILE_UNAVAILABLE', severity: 'WARNING', message: 'm', reasonCode: 'NOT_LOCATED', decisionIds: [], subcriterionIds: [] });
  const sorted = sortPreviewBlockers([c, a, b]);
  assert.deepEqual(sorted.map((x) => x.code), ['DECISION_PENDING', 'NO_STORED_CAPTURE', 'PROFILE_UNAVAILABLE']);
  assert.deepEqual(sortPreviewBlockers([b, c, a]), sorted);
  assert.deepEqual(a.decisionIds, ['op-0001', 'op-0002']);
  assert.ok(!/op-0001/.test(a.message));
});

test('INCONCLUSIVO: a razão "(X de Y pontos)" também é removida de subcritérios não pontuados e de limitações (amostra insuficiente)', () => {
  const base = run((draft) => { delete draft.profile; delete draft.operatorRecords; delete draft.site; delete draft.nap; delete draft.competitors; delete draft.authority; });
  const tampered = {
    ...base,
    subcriteria: base.subcriteria.map((s, i) => (i === 0 ? { ...s, state: 'SAMPLE_INSUFFICIENT', reason: 'Amostra pequena (3 de 4 pontos). Amostra insuficiente.' } : s)),
    limitations: [{ code: 'SAMPLE_INSUFFICIENT:N1', text: 'N1: Amostra pequena (3 de 4 pontos). Amostra insuficiente.' }, ...base.limitations],
  } as unknown as ScoreResult;
  const outcome = deriveOutcome(tampered);
  assert.equal(outcome.outcome, 'INCONCLUSIVO');
  const view = toPublicView(tampered, outcome);
  assert.ok(!/\d+(?:[.,]\d+)? de \d+(?:[.,]\d+)? pontos?/.test(JSON.stringify(view)));
  assert.match((view.subcriteria as any[])[0].reason, /^Amostra pequena\. Amostra insuficiente\.$/);
});
