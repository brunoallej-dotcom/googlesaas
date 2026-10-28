import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyGridPoint,
  formatCoordinate,
  formatRankLabel,
  haversineMeters,
  isCoincident,
  isValidCoordinate,
  MAP_TILE_CONFIG,
  TIER_META,
} from '../src/lib/battlefield-map-utils';

test('classifica a posição pelas faixas de visualização', () => {
  assert.equal(classifyGridPoint('VALID', 1), 'GREEN_TOP3');
  assert.equal(classifyGridPoint('VALID', 3), 'GREEN_TOP3');
  assert.equal(classifyGridPoint('VALID', 4), 'YELLOW_TOP7');
  assert.equal(classifyGridPoint('VALID', 7), 'YELLOW_TOP7');
  assert.equal(classifyGridPoint('VALID', 8), 'RED_8_TO_20');
  assert.equal(classifyGridPoint('VALID', 20), 'RED_8_TO_20');
  assert.equal(classifyGridPoint('VALID', 21), 'INVISIBLE');
});

test('posição ausente: válido sem posição é "acima de 20"; sem leitura é cinza', () => {
  assert.equal(classifyGridPoint('VALID', null), 'INVISIBLE');
  assert.equal(classifyGridPoint('UNREADABLE', null), 'GRAY_UNREADABLE');
  // Sem leitura nunca vira outra faixa, mesmo que venha uma posição.
  assert.equal(classifyGridPoint('UNREADABLE', 2), 'GRAY_UNREADABLE');
});

test('rótulo do marcador: #n, >20 ou S/L', () => {
  assert.equal(formatRankLabel('YELLOW_TOP7', 6), '#6');
  assert.equal(formatRankLabel('INVISIBLE', null), '>20');
  assert.equal(formatRankLabel('GRAY_UNREADABLE', null), 'S/L');
});

test('valida coordenadas', () => {
  assert.equal(isValidCoordinate(-16.3281, -48.9534), true);
  assert.equal(isValidCoordinate(91, 0), false);
  assert.equal(isValidCoordinate(0, -181), false);
  assert.equal(isValidCoordinate(Number.NaN, 0), false);
  assert.equal(isValidCoordinate(undefined, 0), false);
  assert.equal(isValidCoordinate('1', 0), false);
});

test('haversine e coincidência de pontos', () => {
  const a = { latitude: -16.3281, longitude: -48.9534 };
  assert.equal(haversineMeters(a, a), 0);
  // ~0,0045° de latitude ≈ 500 m
  const b = { latitude: -16.3281 + 0.0045, longitude: -48.9534 };
  const d = haversineMeters(a, b);
  assert.ok(d > 480 && d < 520, `distância ${d}`);
  assert.equal(isCoincident(a, { latitude: a.latitude + 0.00005, longitude: a.longitude }), true);
  assert.equal(isCoincident(a, b), false);
});

test('formata coordenadas com 6 casas', () => {
  assert.equal(formatCoordinate(-16.3281), '-16.328100');
});

test('toda faixa tem cor própria e o mapa-base cita o OSM com atribuição', () => {
  const colors = Object.values(TIER_META).map((meta) => meta.color);
  assert.equal(new Set(colors).size, colors.length);
  assert.match(MAP_TILE_CONFIG.attribution, /OpenStreetMap/);
  assert.match(MAP_TILE_CONFIG.url, /\{z\}\/\{x\}\/\{y\}/);
});
