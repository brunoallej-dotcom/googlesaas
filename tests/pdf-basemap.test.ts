import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BasemapBudgetError,
  BasemapNetworkError,
  LocalDirectoryProvider,
  NO_BASEMAP_NOTICE,
  OPENFREEMAP_ATTRIBUTION,
  OpenFreeMapProvider,
  resolveBasemap,
} from '../src/lib/pdf/map/basemap';

const TILEJSON = JSON.stringify({ tiles: ['https://tiles.openfreemap.org/planet/20261011_080001_pt/{z}/{x}/{y}.pbf'] });

interface Call {
  readonly url: string;
  readonly userAgent: string;
}

function fakeFetch(options: { tileStatus?: number; delayMs?: number; tilejson?: string } = {}) {
  const calls: Call[] = [];
  let active = 0;
  let maxActive = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({ url, userAgent: headers?.['User-Agent'] ?? '' });
    if (url.endsWith('/planet')) return new Response(options.tilejson ?? TILEJSON, { status: 200 });
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
    active -= 1;
    return new Response(new Uint8Array([1, 2, 3]), { status: options.tileStatus ?? 200 });
  }) as typeof fetch;
  return { impl, calls, maxActive: () => maxActive };
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gmn-basemap-test-'));
}

/* --------------------------- portão de autorização --------------------------- */

test('padrão: sem mapa-base, sem rede e com o aviso exigido', async () => {
  const resolution = await resolveBasemap({});
  assert.equal(resolution.status, 'NONE');
  assert.equal(resolution.provider.kind, 'none');
  assert.equal(resolution.notice, NO_BASEMAP_NOTICE);
  assert.equal(await resolution.provider.getTile({ z: 14, x: 1, y: 1 }), null);
});

test('openfreemap sem autorização registrada: recusa e cai no modo sem mapa-base (nenhuma requisição)', async () => {
  const net = fakeFetch();
  for (const ref of [undefined, '', '   ', 'x']) {
    const resolution = await resolveBasemap(
      { GMN_PDF_BASEMAP: 'openfreemap', GMN_PDF_BASEMAP_AUTH_REF: ref },
      { fetchImpl: net.impl }
    );
    assert.equal(resolution.status, 'NOT_AUTHORIZED', String(ref));
    assert.equal(resolution.provider.kind, 'none');
    assert.match(resolution.notice ?? '', /exige autorização registrada/);
  }
  assert.equal(net.calls.length, 0);
});

test('openfreemap com autorização registrada: habilita, sem consultar a rede ao criar', async () => {
  const net = fakeFetch();
  const resolution = await resolveBasemap(
    { GMN_PDF_BASEMAP: 'openfreemap', GMN_PDF_BASEMAP_AUTH_REF: 'email-2026-10-20' },
    { fetchImpl: net.impl }
  );
  assert.equal(resolution.status, 'ENABLED');
  assert.equal(resolution.provider.id, 'openfreemap');
  assert.equal(resolution.provider.attribution, OPENFREEMAP_ATTRIBUTION);
  assert.equal(net.calls.length, 0);
});

test('pasta local: exige diretório existente; senão fica sem mapa-base com aviso', async () => {
  const missing = await resolveBasemap({ GMN_PDF_BASEMAP: 'local-dir', GMN_PDF_TILES_DIR: '/caminho/que/nao/existe' });
  assert.equal(missing.status, 'MISCONFIGURED');
  assert.equal(missing.provider.kind, 'none');
  const dir = await tempDir();
  const ok = await resolveBasemap({ GMN_PDF_BASEMAP: 'local-dir', GMN_PDF_TILES_DIR: dir });
  assert.equal(ok.status, 'ENABLED');
  assert.equal(ok.provider.id, 'local-dir');
  assert.equal(ok.provider.attribution, OPENFREEMAP_ATTRIBUTION);
});

/* ------------------------------ pasta local ------------------------------ */

test('pasta local: lê z/x/y.pbf, tile ausente é nulo e coordenadas inválidas são recusadas', async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, '14', '5963'), { recursive: true });
  await fs.writeFile(path.join(dir, '14', '5963', '8791.pbf'), Buffer.from([9, 8, 7]));
  const provider = new LocalDirectoryProvider(dir, 'attr');
  assert.deepEqual([...(await provider.getTile({ z: 14, x: 5963, y: 8791 }))!], [9, 8, 7]);
  assert.equal(await provider.getTile({ z: 14, x: 5963, y: 8792 }), null);
  await assert.rejects(() => provider.getTile({ z: 14, x: -1, y: 0 }), /Tile inválido/);
  await assert.rejects(() => provider.getTile({ z: 15, x: 0, y: 0 }), /Tile inválido/);
  await assert.rejects(() => provider.getTile({ z: 14, x: 1.5, y: 0 }), /Tile inválido/);
});

/* ----------------------------- OpenFreeMap (rede) ----------------------------- */

test('openfreemap: User-Agent próprio em todas as requisições e URL versionada do TileJSON', async () => {
  const net = fakeFetch();
  const provider = new OpenFreeMapProvider({ fetchImpl: net.impl, userAgent: 'GMN-teste/1.0' });
  const bytes = await provider.getTile({ z: 14, x: 5963, y: 8791 });
  assert.deepEqual([...bytes!], [1, 2, 3]);
  assert.ok(net.calls.length >= 2);
  assert.ok(net.calls.every((c) => c.userAgent === 'GMN-teste/1.0'));
  assert.equal(net.calls[1]?.url, 'https://tiles.openfreemap.org/planet/20261011_080001_pt/14/5963/8791.pbf');
});

test('openfreemap: no máximo 4 requisições paralelas', async () => {
  const net = fakeFetch({ delayMs: 15 });
  const provider = new OpenFreeMapProvider({ fetchImpl: net.impl, maxTilesPerReport: 16 });
  await Promise.all(Array.from({ length: 12 }, (_, i) => provider.getTile({ z: 14, x: 100 + i, y: 200 })));
  assert.ok(net.maxActive() <= 4, `paralelismo máximo ${net.maxActive()}`);
  assert.ok(net.maxActive() >= 2);
});

test('openfreemap: teto de tiles por relatório (defesa em profundidade)', async () => {
  const net = fakeFetch();
  const provider = new OpenFreeMapProvider({ fetchImpl: net.impl, maxTilesPerReport: 3 });
  for (let i = 0; i < 3; i++) await provider.getTile({ z: 14, x: 10 + i, y: 10 });
  await assert.rejects(() => provider.getTile({ z: 14, x: 99, y: 10 }), BasemapBudgetError);
  assert.equal(net.calls.filter((c) => !c.url.endsWith('/planet')).length, 3);
});

test('openfreemap: cache em disco evita nova requisição do mesmo tile', async () => {
  const net = fakeFetch();
  const cacheDir = await tempDir();
  const first = new OpenFreeMapProvider({ fetchImpl: net.impl, cacheDir });
  await first.getTile({ z: 14, x: 7, y: 8 });
  const second = new OpenFreeMapProvider({ fetchImpl: net.impl, cacheDir });
  const again = await second.getTile({ z: 14, x: 7, y: 8 });
  assert.deepEqual([...again!], [1, 2, 3]);
  assert.equal(net.calls.filter((c) => c.url.endsWith('/7/8.pbf')).length, 1);
});

test('openfreemap: host fora do permitido no TileJSON é rejeitado antes de qualquer tile', async () => {
  const evil = JSON.stringify({ tiles: ['https://evil.example.com/planet/x/{z}/{x}/{y}.pbf'] });
  const net = fakeFetch({ tilejson: evil });
  const provider = new OpenFreeMapProvider({ fetchImpl: net.impl });
  await assert.rejects(() => provider.getTile({ z: 14, x: 1, y: 1 }), /Host de tiles não permitido/);
  assert.equal(net.calls.filter((c) => !c.url.endsWith('/planet')).length, 0);

  const http = JSON.stringify({ tiles: ['http://tiles.openfreemap.org/planet/x/{z}/{x}/{y}.pbf'] });
  const provider2 = new OpenFreeMapProvider({ fetchImpl: fakeFetch({ tilejson: http }).impl });
  await assert.rejects(() => provider2.getTile({ z: 14, x: 1, y: 1 }), BasemapNetworkError);
});

test('openfreemap: 404 vira tile ausente; erro HTTP vira falha explícita', async () => {
  const missing = new OpenFreeMapProvider({ fetchImpl: fakeFetch({ tileStatus: 404 }).impl });
  assert.equal(await missing.getTile({ z: 14, x: 1, y: 1 }), null);
  const failing = new OpenFreeMapProvider({ fetchImpl: fakeFetch({ tileStatus: 503 }).impl });
  await assert.rejects(() => failing.getTile({ z: 14, x: 2, y: 2 }), /HTTP 503/);
});
