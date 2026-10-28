import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { MbtilesProvider, OSM_MBTILES_ATTRIBUTION, resolveBasemap } from '../src/lib/pdf/map/basemap';

const TILE = path.join(process.cwd(), 'tests', 'fixtures', 'tiles', '14', '5949', '8962.pbf');

async function makeMbtiles(options: { gzip?: boolean; metadata?: boolean } = {}): Promise<{ file: string; raw: Buffer }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-mbtiles-'));
  const file = path.join(dir, 'teste.mbtiles');
  const raw = await fs.readFile(TILE);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);');
  if (options.metadata) db.prepare("INSERT INTO metadata VALUES ('attribution', ?)").run('<a href="x">© OpenStreetMap contributors</a> © OpenMapTiles');
  // MBTiles usa TMS: a linha XYZ y=8962 em z=14 é 2^14 - 1 - 8962
  db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)').run(14, 5949, 2 ** 14 - 1 - 8962, options.gzip ? zlib.gzipSync(raw) : raw);
  db.close();
  return { file, raw };
}

test('MBTiles: lê o tile pela convenção TMS, descompacta gzip e devolve nulo para tile ausente', async () => {
  for (const gzip of [false, true]) {
    const { file, raw } = await makeMbtiles({ gzip });
    const provider = await MbtilesProvider.open(file);
    try {
      assert.deepEqual(Buffer.from((await provider.getTile({ z: 14, x: 5949, y: 8962 })) as Uint8Array), raw);
      assert.equal(await provider.getTile({ z: 14, x: 5949, y: 8963 }), null);
      assert.equal(provider.attribution, OSM_MBTILES_ATTRIBUTION);
    } finally {
      provider.close();
    }
  }
});

test('MBTiles: atribuição vem do arquivo (sem HTML), coordenadas inválidas são recusadas e arquivo inválido falha', async () => {
  const { file } = await makeMbtiles({ metadata: true });
  const provider = await MbtilesProvider.open(file);
  try {
    assert.equal(provider.attribution, '© OpenStreetMap contributors © OpenMapTiles');
    await assert.rejects(() => provider.getTile({ z: 14, x: -1, y: 0 }), /Tile inválido/);
    await assert.rejects(() => provider.getTile({ z: 30, x: 0, y: 0 }), /Tile inválido/);
  } finally {
    provider.close();
  }
  const bad = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-mbtiles-')), 'ruim.mbtiles');
  const db = new DatabaseSync(bad);
  db.exec('CREATE TABLE outra (a INTEGER)');
  db.close();
  await assert.rejects(() => MbtilesProvider.open(bad), /MBTiles inválido/);
});

test('seleção pelo ambiente: mbtiles ativo, arquivo ausente cai para contingência sem mapa-base (nunca inventa ruas)', async () => {
  const { file } = await makeMbtiles();
  const ok = await resolveBasemap({ GMN_PDF_BASEMAP: 'mbtiles', GMN_PDF_MBTILES_PATH: file });
  assert.equal(ok.status, 'ENABLED');
  assert.equal(ok.provider.id, 'mbtiles');
  (ok.provider as MbtilesProvider).close();

  for (const env of [{ GMN_PDF_BASEMAP: 'mbtiles' }, { GMN_PDF_BASEMAP: 'mbtiles', GMN_PDF_MBTILES_PATH: '/nao/existe.mbtiles' }]) {
    const bad = await resolveBasemap(env);
    assert.equal(bad.status, 'MISCONFIGURED');
    assert.equal(bad.provider.id, 'none');
    assert.ok(bad.notice);
  }
});
