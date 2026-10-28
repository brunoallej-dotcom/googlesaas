import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateRoundCompatibility,
  selectCompatibleRound,
  type CurrentRoundParams,
  type RoundSnapshot,
} from '../src/lib/history-compat';
import { battlefieldAgent } from '../src/agents/battlefield-agent';

const CURRENT: CurrentRoundParams = {
  executedAt: '2026-10-16T12:00:00.000Z',
  centerLat: -16.3281,
  centerLng: -48.9534,
  zoomLevel: '15z',
  stepMeters: 500,
  validPointsCount: 49,
};

const round = (overrides: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  roundId: 'r1',
  executedAt: '2026-09-10T12:00:00.000Z',
  greenTop3Count: 3,
  averagePosition: 18.2,
  centerLat: -16.3281,
  centerLng: -48.9534,
  zoomLevel: '15z',
  stepMeters: 500,
  validPointsCount: 49,
  simulated: false,
  ...overrides,
});

test('rodada com a mesma grade, cobertura e dados reais é compatível', () => {
  assert.deepEqual(evaluateRoundCompatibility(round(), CURRENT), { compatible: true });
});

test('mudanças no centro, no zoom ou no passo tornam a rodada incompatível, com o motivo', () => {
  const far = evaluateRoundCompatibility(round({ centerLat: -16.35 }), CURRENT);
  assert.equal(far.compatible, false);
  assert.match(far.compatible ? '' : far.reason, /centro da grade mudou/);
  const zoom = evaluateRoundCompatibility(round({ zoomLevel: '14z' }), CURRENT);
  assert.match(zoom.compatible ? '' : zoom.reason, /zoom/);
  const step = evaluateRoundCompatibility(round({ stepMeters: 1000 }), CURRENT);
  assert.match(step.compatible ? '' : step.reason, /espaçamento/);
});

test('centro com pequena diferença (até 50 m) ainda é a mesma grade', () => {
  assert.equal(evaluateRoundCompatibility(round({ centerLat: -16.32825 }), CURRENT).compatible, true);
});

test('rodada antiga sem parâmetros registrados não é comparada (nada é presumido)', () => {
  const legacy = evaluateRoundCompatibility(round({ centerLat: null, centerLng: null, zoomLevel: null, stepMeters: null }), CURRENT);
  assert.equal(legacy.compatible, false);
  assert.match(legacy.compatible ? '' : legacy.reason, /não registrou os parâmetros/);
});

test('cobertura de leituras insuficiente em qualquer rodada impede a comparação', () => {
  const previous = evaluateRoundCompatibility(round({ validPointsCount: 30 }), CURRENT);
  assert.equal(previous.compatible, false);
  assert.match(previous.compatible ? '' : previous.reason, /Cobertura de leituras insuficiente/);
  assert.equal(evaluateRoundCompatibility(round(), { ...CURRENT, validPointsCount: 20 }).compatible, false);
});

test('rodada simulada ou posterior à atual nunca serve de base', () => {
  assert.equal(evaluateRoundCompatibility(round({ simulated: true }), CURRENT).compatible, false);
  assert.equal(evaluateRoundCompatibility(round({ executedAt: '2026-11-01T00:00:00.000Z' }), CURRENT).compatible, false);
});

test('seleção: usa a rodada compatível mais recente; sem compatível, informa por que; sem histórico, nada', () => {
  const incompatibleNewest = round({ roundId: 'novo', executedAt: '2026-10-01T00:00:00.000Z', zoomLevel: '13z' });
  const compatibleOlder = round({ roundId: 'antigo' });
  assert.equal(selectCompatibleRound([incompatibleNewest, compatibleOlder], CURRENT).round?.roundId, 'antigo');

  const none = selectCompatibleRound([incompatibleNewest], CURRENT);
  assert.equal(none.round, null);
  assert.match(none.incompatibleReason ?? '', /zoom/);

  assert.deepEqual(selectCompatibleRound([], CURRENT), { round: null, incompatibleReason: null });
});

test('evolução: rodada incompatível não gera deltas inventados e o texto explica a limitação', () => {
  const evolution = battlefieldAgent.computeHistoricalEvolution(null, 4, 18, 'O zoom da consulta mudou (14z → 15z).');
  assert.equal(evolution.hasPreviousRound, false);
  assert.equal(evolution.greenPointsDelta, null);
  assert.equal(evolution.averagePositionDelta, null);
  assert.equal(evolution.previousAveragePosition, null);
  assert.match(evolution.evolutionSummaryText, /não é comparável/);
  assert.match(evolution.evolutionSummaryText, /zoom/);

  const first = battlefieldAgent.computeHistoricalEvolution(null, 4, 18);
  assert.match(first.evolutionSummaryText, /primeira medição/);
});
