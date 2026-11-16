import assert from 'node:assert/strict';
import test from 'node:test';
import { SUBCRITERION_STATES } from '../src/lib/link-audit/scoring/types';
import type { CriterionStatus, SubcriterionState } from '../src/lib/link-audit/scoring/types';
import { obtainedPointsOfCriterion, obtainedPointsOfSubcriterion } from '../src/lib/link-audit-scoring-runs/outcome';

/* "Ausência nunca vira zero" (spec 6C §19.2 item 4): pontos obtidos só existem para o que o motor AVALIOU. Cobre TODOS os estados do motor. */
const CRITERION_STATUSES: readonly CriterionStatus[] = ['EVALUATED', 'PARTIAL', 'NOT_VERIFIED', 'NOT_APPLICABLE'];
const FILLER_HALF_POINTS = 0; // o motor grava 0 como preenchimento interno quando não avaliou
const SUB_EXPECTED: Record<SubcriterionState, 'number' | 'null'> = { SCORED: 'number', ABSENCE_PROVEN: 'number', NOT_VERIFIED: 'null', NOT_APPLICABLE: 'null', SAMPLE_INSUFFICIENT: 'null' };
const CRIT_EXPECTED: Record<CriterionStatus, 'number' | 'null'> = { EVALUATED: 'number', PARTIAL: 'number', NOT_VERIFIED: 'null', NOT_APPLICABLE: 'null' };

test('a tabela de estados do teste cobre exatamente os estados do motor', () => {
  assert.deepEqual([...SUBCRITERION_STATES].sort(), Object.keys(SUB_EXPECTED).sort());
  assert.deepEqual([...CRITERION_STATUSES].sort(), Object.keys(CRIT_EXPECTED).sort());
});

for (const state of SUBCRITERION_STATES) {
  test(`subcritério ${state}: ${SUB_EXPECTED[state] === 'number' ? 'mantém o número do motor' : 'devolve null (nunca 0)'}`, () => {
    assert.equal(obtainedPointsOfSubcriterion({ state, obtainedHalfPoints: 5 }), SUB_EXPECTED[state] === 'number' ? 5 : null);
    assert.equal(obtainedPointsOfSubcriterion({ state, obtainedHalfPoints: FILLER_HALF_POINTS }), SUB_EXPECTED[state] === 'number' ? 0 : null);
  });
}

for (const status of CRITERION_STATUSES) {
  test(`critério ${status}: ${CRIT_EXPECTED[status] === 'number' ? 'mantém o número do motor' : 'devolve null (nunca 0)'}`, () => {
    assert.equal(obtainedPointsOfCriterion({ status, obtainedHalfPoints: 7 }), CRIT_EXPECTED[status] === 'number' ? 7 : null);
    assert.equal(obtainedPointsOfCriterion({ status, obtainedHalfPoints: FILLER_HALF_POINTS }), CRIT_EXPECTED[status] === 'number' ? 0 : null);
  });
}

test('ABSENCE_PROVEN com 0 comprovado continua 0 (avaliado), não null', () => {
  assert.equal(obtainedPointsOfSubcriterion({ state: 'ABSENCE_PROVEN', obtainedHalfPoints: 0 }), 0);
});
