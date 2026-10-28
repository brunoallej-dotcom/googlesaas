import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { decodeVectorTile } from '../src/lib/pdf/map/mvt';
import {
  chooseZoom,
  fitView,
  lonLatToWorld,
  niceScaleLength,
  tilePointToWorld,
  tilesCovering,
} from '../src/lib/pdf/map/projection';

/* --- codificador protobuf mínimo, só para fabricar tiles sintéticos de teste --- */
const varint = (value: number): number[] => {
  const out: number[] = [];
  let n = value;
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
};
const tag = (field: number, wire: number): number[] => varint(field * 8 + wire);
const lenField = (field: number, bytes: number[]): number[] => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const strField = (field: number, text: string): number[] => lenField(field, [...Buffer.from(text, 'utf8')]);
const zig = (n: number): number => (n >= 0 ? n * 2 : -n * 2 - 1);

const feature = (type: number, tags: number[], geometry: number[]): number[] =>
  lenField(2, [
    ...(tags.length ? lenField(2, tags.flatMap(varint)) : []),
    ...tag(3, 0), ...varint(type),
    ...lenField(4, geometry.flatMap(varint)),
  ]);

function buildTile(): Uint8Array {
  const polygon = feature(3, [0, 0], [9, zig(10), zig(10), 26, zig(100), zig(0), zig(0), zig(100), zig(-100), zig(0), 15]);
  const line = feature(2, [1, 1], [9, zig(5), zig(5), 18, zig(50), zig(0), zig(0), zig(60)]);
  const point = feature(1, [], [9, zig(200), zig(300)]);
  const stringValue = lenField(4, strField(1, 'primary'));
  const intValue = lenField(4, [...tag(4, 0), ...varint(7)]);
  const layer = [
    ...strField(1, 'transportation'),
    ...polygon,
    ...line,
    ...point,
    ...strField(3, 'class'),
    ...strField(3, 'rank'),
    ...stringValue,
    ...intValue,
    ...tag(5, 0), ...varint(4096),
  ];
  return Uint8Array.from(lenField(3, layer));
}

test('decodifica camada, propriedades e os três tipos de geometria', () => {
  const tile = decodeVectorTile(buildTile());
  const layer = tile.transportation;
  assert.ok(layer);
  assert.equal(layer.extent, 4096);
  assert.equal(layer.features.length, 3);

  const [polygon, line, point] = layer.features;
  assert.equal(polygon?.type, 3);
  assert.deepEqual(polygon?.properties, { class: 'primary' });
  // Anel fechado: MoveTo + 3 LineTo + ClosePath volta ao primeiro ponto.
  assert.deepEqual(polygon?.geometry[0], [[10, 10], [110, 10], [110, 110], [10, 110], [10, 10]]);

  assert.equal(line?.type, 2);
  assert.deepEqual(line?.properties, { rank: 7 });
  assert.deepEqual(line?.geometry[0], [[5, 5], [55, 5], [55, 65]]);

  assert.equal(point?.type, 1);
  assert.deepEqual(point?.geometry, [[[200, 300]]]);
});

test('aceita tile comprimido com gzip', () => {
  const plain = decodeVectorTile(buildTile());
  const zipped = decodeVectorTile(gzipSync(Buffer.from(buildTile())));
  assert.deepEqual(zipped, plain);
});

test('tile vazio ou truncado: vazio não quebra, truncado lança erro claro', () => {
  assert.deepEqual(decodeVectorTile(new Uint8Array()), {});
  const bytes = buildTile();
  assert.throws(() => decodeVectorTile(bytes.subarray(0, bytes.length - 5)), /MVT/);
});

/* ------------------------------- projeção -------------------------------- */

test('Web Mercator: origem, simetria e limites', () => {
  const origin = lonLatToWorld({ longitude: 0, latitude: 0 });
  assert.ok(Math.abs(origin.x - 0.5) < 1e-12 && Math.abs(origin.y - 0.5) < 1e-12);
  assert.ok(lonLatToWorld({ longitude: -180, latitude: 0 }).x === 0);
  const north = lonLatToWorld({ longitude: 0, latitude: 60 });
  const south = lonLatToWorld({ longitude: 0, latitude: -60 });
  assert.ok(Math.abs(north.y + south.y - 1) < 1e-12);
  assert.ok(Number.isFinite(lonLatToWorld({ longitude: 0, latitude: 90 }).y));
});

test('fitView: o centro dos pontos cai no centro do retângulo e tudo cabe com margem', () => {
  const coords = [
    { longitude: -48.97, latitude: -16.34 },
    { longitude: -48.94, latitude: -16.31 },
  ];
  const rect = { x: 40, y: 100, width: 500, height: 400 };
  const view = fitView(coords, rect, 20);
  const center = view.toPt(view.centerWorld);
  assert.ok(Math.abs(center.x - 290) < 1e-6 && Math.abs(center.y - 300) < 1e-6);
  for (const c of coords) {
    const p = view.toPt(lonLatToWorld(c));
    assert.ok(p.x >= rect.x + 20 - 1e-6 && p.x <= rect.x + rect.width - 20 + 1e-6);
    assert.ok(p.y >= rect.y + 20 - 1e-6 && p.y <= rect.y + rect.height - 20 + 1e-6);
  }
  assert.throws(() => fitView([], rect, 10), /Sem coordenadas/);
});

test('escala: ~500 m entre pontos vizinhos resulta em metros por ponto coerente', () => {
  const coords = [
    { longitude: -48.9650, latitude: -16.3360 },
    { longitude: -48.9420, latitude: -16.3100 },
  ];
  const view = fitView(coords, { x: 0, y: 0, width: 500, height: 400 }, 10);
  const mpp = view.metersPerPt();
  assert.ok(mpp > 2 && mpp < 20, `metros por pt ${mpp}`);
  const bar = niceScaleLength(mpp, 70);
  assert.ok([50, 100, 200, 250, 500, 1000, 2000, 5000].includes(bar.meters));
  assert.ok(Math.abs(bar.pt - bar.meters / mpp) < 1e-9);
});

test('tiles cobrindo a área e conversão de coordenadas de tile', () => {
  const world = lonLatToWorld({ longitude: -48.9563, latitude: -16.3222 });
  const visible = { x0: world.x - 0.0001, x1: world.x + 0.0001, y0: world.y - 0.0001, y1: world.y + 0.0001 };
  const tiles = tilesCovering(visible, 14);
  const expectedX = Math.floor(((-48.9563 + 180) / 360) * 2 ** 14);
  assert.ok(tiles.some((t) => t.x === expectedX));
  assert.ok(tiles.every((t) => t.z === 14));

  const t = tiles[0];
  assert.ok(t);
  const w = tilePointToWorld(t, 0, 0, 4096);
  assert.equal(w.x, t.x / 2 ** 14);
  assert.equal(w.y, t.y / 2 ** 14);
});

test('chooseZoom: nunca ultrapassa o teto de tiles por relatório', () => {
  const world = lonLatToWorld({ longitude: -48.9563, latitude: -16.3222 });
  // Área grande (várias dezenas de tiles em z14) precisa reduzir o zoom para respeitar o teto.
  const big = { x0: world.x - 0.01, x1: world.x + 0.01, y0: world.y - 0.01, y1: world.y + 0.01 };
  const chosen = chooseZoom(big, 14, 16);
  assert.ok(chosen.tiles.length <= 16);
  assert.ok(chosen.zoom < 14);
  // Uma grade real (cerca de 4 km de lado, ~0,0001 do mundo) cabe no zoom máximo com poucos tiles.
  const grid = { x0: world.x - 0.00005, x1: world.x + 0.00005, y0: world.y - 0.00005, y1: world.y + 0.00005 };
  const chosenGrid = chooseZoom(grid, 14, 16);
  assert.equal(chosenGrid.zoom, 14);
  assert.ok(chosenGrid.tiles.length <= 9);
});
