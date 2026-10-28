import assert from 'node:assert/strict';
import test from 'node:test';
import { battlefieldAgent } from '../src/agents/battlefield-agent';

const previous = {
  roundId: '11111111-1111-4111-8111-111111111111',
  executedAt: '2026-09-10T12:00:00.000Z',
  greenTop3Count: 3,
  averagePosition: 18.4,
};

test('sem rodada anterior real: nenhum valor histórico é inventado', () => {
  const evolution = battlefieldAgent.computeHistoricalEvolution(null, 4, 16.6);

  assert.equal(evolution.hasPreviousRound, false);
  assert.equal(evolution.previousRoundId, null);
  assert.equal(evolution.previousExecutedAt, null);
  assert.equal(evolution.previousGreenTop3Count, null);
  assert.equal(evolution.greenPointsDelta, null);
  assert.equal(evolution.previousAveragePosition, null);
  assert.equal(evolution.averagePositionDelta, null);
});

test('sem rodada anterior: preserva os valores atuais medidos', () => {
  const evolution = battlefieldAgent.computeHistoricalEvolution(null, 4, 16.6);
  assert.equal(evolution.currentGreenTop3Count, 4);
  assert.equal(evolution.currentAveragePosition, 16.6);
});

test('sem rodada anterior: o texto assume ser a primeira medição e não cita números nem "baseline"', () => {
  const { evolutionSummaryText } = battlefieldAgent.computeHistoricalEvolution(null, 4, 16.6);
  assert.match(evolutionSummaryText, /primeira medição/i);
  assert.doesNotMatch(evolutionSummaryText, /\d/);
  assert.doesNotMatch(evolutionSummaryText, /baseline/i);
  assert.doesNotMatch(evolutionSummaryText, /mensal anterior/i);
});

test('sem rodada anterior: o resultado não depende do relógio (nada de "30 dias atrás")', () => {
  const a = battlefieldAgent.computeHistoricalEvolution(null, 0, 21);
  const b = battlefieldAgent.computeHistoricalEvolution(null, 0, 21);
  assert.deepEqual(a, b);
  assert.equal(a.previousExecutedAt, null);
});

test('com rodada anterior real: calcula as diferenças e mantém o vínculo', () => {
  const evolution = battlefieldAgent.computeHistoricalEvolution(previous, 8, 15.1);

  assert.equal(evolution.hasPreviousRound, true);
  assert.equal(evolution.previousRoundId, previous.roundId);
  assert.equal(evolution.previousExecutedAt, previous.executedAt);
  assert.equal(evolution.previousGreenTop3Count, 3);
  assert.equal(evolution.greenPointsDelta, 5);
  assert.equal(evolution.previousAveragePosition, 18.4);
  assert.equal(evolution.averagePositionDelta, -3.3);
  assert.match(evolution.evolutionSummaryText, /de 3 para 8 pontos verdes/);
  assert.match(evolution.evolutionSummaryText, /\+5 pontos/);
});

test('com rodada anterior real: piora e estabilidade são refletidas sem arredondar para melhor', () => {
  const worse = battlefieldAgent.computeHistoricalEvolution(previous, 1, 19.9);
  assert.equal(worse.greenPointsDelta, -2);
  assert.equal(worse.averagePositionDelta, 1.5);
  assert.match(worse.evolutionSummaryText, /\(-2 pontos\)/);

  const same = battlefieldAgent.computeHistoricalEvolution(previous, 3, 18.4);
  assert.equal(same.greenPointsDelta, 0);
  assert.equal(same.averagePositionDelta, 0);
});
