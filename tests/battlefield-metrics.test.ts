import assert from 'node:assert/strict';
import test from 'node:test';
import { computeTerritoryRankMetrics, type RankedPoint } from '../src/lib/battlefield-metrics';
import { toBattlefieldMapModel } from '../src/lib/battlefield-map-adapter';
import { buildFixtureBattlefield, buildFixtureLead } from '../src/dev/battlefield-fixture';

const valid = (rank: number | null): RankedPoint => ({ readStatus: 'VALID', targetRank: rank });
const none: RankedPoint = { readStatus: 'UNREADABLE', targetRank: null };
const grid = (ranks: readonly (number | null)[]): RankedPoint[] => ranks.map(valid);
const repeat = (rank: number | null, times: number): (number | null)[] => Array.from({ length: times }, () => rank);

test('empresa em #1 em todos os pontos: índice e média conhecida iguais a 1', () => {
  const m = computeTerritoryRankMetrics(grid(repeat(1, 49)));
  assert.equal(m.rankIndexAverage, 1);
  assert.equal(m.knownPositionAverage, 1);
  assert.equal(m.top3Percent, 100);
  assert.equal(m.top7Percent, 100);
  assert.equal(m.top20Percent, 100);
  assert.equal(m.outsideTop20Points, 0);
  assert.equal(m.gridComplete, true);
});

test('empresa em #7: entra no Top 7, não entra no Top 3', () => {
  const m = computeTerritoryRankMetrics(grid(repeat(7, 49)));
  assert.equal(m.top3Points, 0);
  assert.equal(m.top7Points, 49);
  assert.equal(m.top7Percent, 100);
  assert.equal(m.knownPositionAverage, 7);
});

test('empresa em #20: conta como posição conhecida (Top 20) e não como fora do Top 20', () => {
  const m = computeTerritoryRankMetrics(grid(repeat(20, 49)));
  assert.equal(m.knownPositionPoints, 49);
  assert.equal(m.outsideTop20Points, 0);
  assert.equal(m.rankIndexAverage, 20);
  assert.equal(m.top20Percent, 100);
});

test('empresa fora do Top 20: o índice usa 21, mas a posição real continua desconhecida', () => {
  const m = computeTerritoryRankMetrics(grid(repeat(null, 49)));
  assert.equal(m.rankIndexAverage, 21);
  assert.equal(m.knownPositionAverage, null, 'não existe posição conhecida para tirar média');
  assert.equal(m.outsideTop20Points, 49);
  assert.equal(m.outsideTop20Percent, 100);
  assert.equal(m.top20Percent, 0);
});

test('mistura: índice limitado e média das posições conhecidas são números diferentes', () => {
  // 5 pontos em #4 e 44 fora do Top 20 (formato da auditoria real analisada)
  const m = computeTerritoryRankMetrics(grid([...repeat(4, 5), ...repeat(null, 44)]));
  assert.equal(m.rankIndexAverage, Number(((5 * 4 + 44 * 21) / 49).toFixed(2)));
  assert.equal(m.knownPositionAverage, 4);
  assert.notEqual(m.rankIndexAverage, m.knownPositionAverage);
  assert.equal(m.knownPositionPoints, 5);
  assert.equal(m.outsideTop20Points, 44);
  assert.equal(m.top3Points, 0);
  assert.equal(m.top7Points, 5);
});

test('posição ausente (sem leitura) fica fora de todas as médias e de todos os denominadores', () => {
  const m = computeTerritoryRankMetrics([valid(2), valid(null), none, none]);
  assert.equal(m.validPoints, 2);
  assert.equal(m.unreadablePoints, 2);
  assert.equal(m.rankIndexAverage, (2 + 21) / 2);
  assert.equal(m.knownPositionAverage, 2);
  assert.equal(m.top3Percent, 50);
  assert.equal(m.outsideTop20Percent, 50);
  assert.equal(m.gridComplete, false);
});

test('sem nenhuma leitura válida: tudo é nulo (nada de 0 ou 21 inventados)', () => {
  const m = computeTerritoryRankMetrics([none, none, none]);
  assert.equal(m.validPoints, 0);
  assert.equal(m.rankIndexAverage, null);
  assert.equal(m.knownPositionAverage, null);
  assert.equal(m.top3Percent, null);
  assert.equal(m.top7Percent, null);
  assert.equal(m.outsideTop20Percent, null);
  const empty = computeTerritoryRankMetrics([]);
  assert.equal(empty.rankIndexAverage, null);
});

test('grade parcialmente processada (30 de 49): os denominadores são os pontos recebidos', () => {
  const m = computeTerritoryRankMetrics(grid([...repeat(2, 10), ...repeat(15, 10), ...repeat(null, 10)]));
  assert.equal(m.totalPoints, 30);
  assert.equal(m.validPoints, 30);
  assert.equal(m.gridComplete, false, 'faltam pontos esperados');
  assert.equal(m.top3Percent, Number(((10 / 30) * 100).toFixed(1)));
  assert.equal(m.top20Percent, Number(((20 / 30) * 100).toFixed(1)));
});

test('posições inválidas (0, negativas, fracionárias ou acima de 20) nunca viram posição conhecida', () => {
  const m = computeTerritoryRankMetrics(grid([0, -3, 21, 35, Number.NaN]));
  assert.equal(m.knownPositionPoints, 0);
  assert.equal(m.outsideTop20Points, 5);
});

test('grade completa com 49 leituras: percentuais somam 100% entre conhecidas e fora do Top 20', () => {
  const m = computeTerritoryRankMetrics(grid([...repeat(1, 4), ...repeat(5, 6), ...repeat(12, 15), ...repeat(null, 24)]));
  assert.equal(m.validPoints, 49);
  assert.equal((m.top20Percent ?? 0) + (m.outsideTop20Percent ?? 0) > 99.9, true);
  assert.equal(m.top3Points, 4);
  assert.equal(m.top7Points, 10);
  assert.equal(m.top20Points, 25);
});

test('o mapa (dashboard e PDF) usa a mesma metodologia: índice, média conhecida e denominadores iguais', () => {
  const battlefield = buildFixtureBattlefield('full');
  const model = toBattlefieldMapModel({ battlefield, lead: buildFixtureLead() });
  const metrics = computeTerritoryRankMetrics(battlefield.points);
  assert.equal(model.averagePosition, metrics.rankIndexAverage);
  assert.equal(model.knownPositionAverage, metrics.knownPositionAverage);
  assert.equal(model.knownPositionPoints, metrics.knownPositionPoints);
  assert.equal(model.counts.above20, metrics.outsideTop20Points);
  assert.equal(model.coverage.valid, metrics.validPoints);
});
