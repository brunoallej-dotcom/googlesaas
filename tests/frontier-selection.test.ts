import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectUniqueFrontierListings } from '../src/agents/frontier-selection';

type Place = { place_id: string; rank_absolute: number; cid?: string };
const lead = (rank: number, placeId = `place-${rank}`, cid?: string): Place => ({
  rank_absolute: rank,
  place_id: placeId,
  ...(cid ? { cid } : {}),
});

test('captura 10 IDs únicos em ordem de ranking, preferindo a fronteira', () => {
  const all = Array.from({ length: 40 }, (_, index) => lead(index + 1));
  const chosen = selectUniqueFrontierListings(all);
  assert.deepEqual(chosen.map((item) => item.rank_absolute), [15,16,17,18,19,20,21,22,23,24]);
});

test('descarta duplicados do lote e repõe com os próximos rankings', () => {
  const all = Array.from({ length: 40 }, (_, index) => lead(index + 1));
  all[20] = lead(21, 'place-19');
  all[21] = lead(22, 'place-20');
  const chosen = selectUniqueFrontierListings(all);
  assert.equal(chosen.length, 10);
  assert.deepEqual(chosen.map((item) => item.rank_absolute), [15,16,17,18,19,20,23,24,25,26]);
  assert.equal(new Set(chosen.map((item) => item.place_id)).size, 10);
});

test('não aceita resultados repetidos de posições do topo na página 2', () => {
  const all = Array.from({ length: 20 }, (_, index) => lead(index + 1));
  all.push(...Array.from({length: 20}, (_, index) => lead(index + 21, `place-${index + 1}`)));
  const chosen = selectUniqueFrontierListings(all);
  assert.deepEqual(chosen.map((item) => item.rank_absolute), [15,16,17,18,19,20]);
});

test('trata CID igual como mesmo estabelecimento e ignora IDs ausentes', () => {
  const all = [
    lead(15, 'same-a', 'cid-1'),
    lead(16, 'same-b', 'cid-1'),
    lead(17, '  '),
    lead(18, 'other', 'cid-2'),
  ];
  const chosen = selectUniqueFrontierListings(all);
  assert.deepEqual(chosen.map((item) => item.rank_absolute), [15,18]);
});

test('rejeita uma quantidade de leads inválida', () => {
  assert.throws(() => selectUniqueFrontierListings([], 0), RangeError);
});
