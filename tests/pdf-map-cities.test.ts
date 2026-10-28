import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildReportFixture } from '../src/dev/report-fixture';
import { resolveBasemap, LocalDirectoryProvider, noBasemapProvider, OpenFreeMapProvider, OPENFREEMAP_ATTRIBUTION } from '../src/lib/pdf/map/basemap';
import type { BasemapResolution } from '../src/lib/pdf/map/basemap';
import { buildMapView } from '../src/lib/pdf/map/map-render';
import { lonLatToWorld } from '../src/lib/pdf/map/projection';
import { buildReportModel } from '../src/lib/pdf/report-model';
import { renderReportPdf } from '../src/lib/pdf/report-renderer';

/*
 * O mapa do PDF precisa funcionar para estabelecimentos de QUALQUER cidade, não só para os tiles de
 * demonstração. Todas as fixtures abaixo são dados sintéticos de teste; os tiles de Anápolis e de
 * Goiânia são arquivos reais do OpenFreeMap baixados uma única vez (ver tests/fixtures/tiles/ATTRIBUTION.md).
 */

const TILES_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'tiles');
const GENERATED_AT = '2026-10-16T12:00:00.000Z';
const RECT = { x: 40, y: 0, width: 515.28, height: 400 };

/** Centro escolhido no meio de um tile z14 de Goiânia, para a janela do mapa cobrir 3x2 tiles baixados. */
const GOIANIA = { city: 'Goiânia', state: 'GO', latitude: -16.69934, longitude: -49.251709 };

const OTHER_CITIES = [
  { city: 'Manaus', state: 'AM', latitude: -3.119, longitude: -60.0217 },
  { city: 'Fortaleza', state: 'CE', latitude: -3.7319, longitude: -38.5267 },
  { city: 'Brasília', state: 'DF', latitude: -15.7975, longitude: -47.8919 },
  { city: 'Curitiba', state: 'PR', latitude: -25.4284, longitude: -49.2733 },
  { city: 'Porto Alegre', state: 'RS', latitude: -30.0346, longitude: -51.2177 },
  { city: 'Rio Branco', state: 'AC', latitude: -9.9754, longitude: -67.8249 },
] as const;

const NO_MAP: BasemapResolution = { provider: noBasemapProvider, status: 'NONE', notice: 'Mapa-base (ruas e bairros) não incluído nesta emissão.' };

const joinedText = (buffer: Buffer): string =>
  [...buffer.toString('latin1').matchAll(/BT([\s\S]*?)ET/g)]
    .flatMap((block) => [...(block[1] ?? '').matchAll(/\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g)].map((m) => (m[1] ?? m[2] ?? '')))
    .join(' ');

async function model(location: (typeof OTHER_CITIES)[number] | typeof GOIANIA) {
  const source = await buildReportFixture({ dataStyle: 'phase4', location });
  return buildReportModel({ source, generatedAt: GENERATED_AT });
}

test('qualquer cidade sem mapa-base: pontos reais dentro do mapa, escala coerente e PDF gerado', async () => {
  for (const city of OTHER_CITIES) {
    const m = await model(city);
    const view = buildMapView(m.territory.map, RECT);
    assert.ok(Number.isFinite(view.metersPerPt()) && view.metersPerPt() > 0, city.city);
    for (const marker of m.territory.map.markers) {
      const pt = view.toPt(lonLatToWorld(marker));
      assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y), `${city.city}: coordenada finita`);
      assert.ok(pt.x >= RECT.x && pt.x <= RECT.x + RECT.width && pt.y >= RECT.y && pt.y <= RECT.y + RECT.height, `${city.city}: ponto ${marker.pointNumber} dentro do mapa`);
    }
    // Pontos vizinhos (500 m) ficam a 500 m na escala do mapa, em qualquer latitude (tolerância de 3%)
    const [a, b] = [m.territory.map.markers[24], m.territory.map.markers[25]];
    assert.ok(a && b);
    const pa = view.toPt(lonLatToWorld(a));
    const pb = view.toPt(lonLatToWorld(b));
    const meters = Math.hypot(pb.x - pa.x, pb.y - pa.y) * view.metersPerPt();
    assert.ok(Math.abs(meters - 500) / 500 < 0.03, `${city.city}: ${meters.toFixed(1)} m entre pontos vizinhos`);

    const rendered = await renderReportPdf(m, { fonts: 'standard', compress: false, basemap: NO_MAP });
    const text = joinedText(rendered.buffer);
    assert.equal(rendered.map?.basemap, 'OMITTED', city.city);
    assert.equal(rendered.basemapStatus, 'NONE');
    assert.ok(rendered.pageCount >= 8, city.city);
    assert.doesNotMatch(text, /NaN|undefined/, city.city);
  }
});

test('Goiânia com tiles reais de Goiânia: ruas e bairros desenhados e atribuição impressa', async () => {
  const resolution = await resolveBasemap({ GMN_PDF_BASEMAP: 'local-dir', GMN_PDF_TILES_DIR: TILES_DIR });
  const m = await model(GOIANIA);
  const rendered = await renderReportPdf(m, { fonts: 'standard', compress: false, basemap: resolution });
  assert.equal(rendered.basemapStatus, 'ENABLED');
  assert.equal(rendered.map?.basemap, 'INCLUDED');
  assert.equal(rendered.map?.tilesUsed, 6, 'janela 3x2 tiles de Goiânia');
  // A densidade de nomes depende dos dados do OpenStreetMap em cada cidade: exige-se que haja ruas e ao menos um nome de lugar.
  assert.ok((rendered.map?.placeLabels ?? 0) >= 1, 'nomes de lugares');
  assert.ok((rendered.map?.roadLabels ?? 0) >= 10, 'nomes de ruas');
  assert.ok(joinedText(rendered.buffer).length > 0);
  assert.equal(resolution.provider.attribution, OPENFREEMAP_ATTRIBUTION);
});

test('os tiles de uma cidade não "vazam" para outra: sem tile na área, o PDF sai sem mapa-base e com aviso', async () => {
  const resolution = await resolveBasemap({ GMN_PDF_BASEMAP: 'local-dir', GMN_PDF_TILES_DIR: TILES_DIR });
  for (const city of OTHER_CITIES) {
    const m = await model(city);
    const rendered = await renderReportPdf(m, { fonts: 'standard', compress: false, basemap: resolution });
    assert.equal(rendered.basemapStatus, 'FAILED', city.city);
    assert.equal(rendered.map?.basemap, 'OMITTED');
    assert.match(rendered.mapNotice ?? '', /Mapa-base indisponível/);
    assert.ok(rendered.pageCount >= 8);
  }
});

test('a mesma pasta atende Anápolis e Goiânia; cada cidade usa só os seus tiles', async () => {
  const anapolis = await buildReportFixture({ dataStyle: 'phase4' });
  const resolution = await resolveBasemap({ GMN_PDF_BASEMAP: 'local-dir', GMN_PDF_TILES_DIR: TILES_DIR });
  const [a, g] = await Promise.all([
    renderReportPdf(buildReportModel({ source: anapolis, generatedAt: GENERATED_AT }), { fonts: 'standard', compress: false, basemap: resolution }),
    model(GOIANIA).then((m) => renderReportPdf(m, { fonts: 'standard', compress: false, basemap: resolution })),
  ]);
  assert.equal(a.map?.basemap, 'INCLUDED');
  assert.equal(g.map?.basemap, 'INCLUDED');
});

test('OpenFreeMap (rede simulada): o pipeline serve qualquer cidade, respeitando UA, teto de tiles e cache', async () => {
  // Resposta HIPÓTESE: o servidor "devolve" um tile real para QUALQUER z/x/y pedido. O conteúdo geográfico
  // não corresponde à cidade (é só para provar que nada depende dos tiles locais); nenhuma rede real é usada.
  const tileBytes = await fs.readFile(path.join(TILES_DIR, '14', '5950', '8962.pbf'));
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-tiles-'));
  const requests: { url: string; userAgent: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, userAgent: new Headers(init?.headers).get('User-Agent') });
    if (url === 'https://tiles.openfreemap.org/planet') {
      return new Response(JSON.stringify({ tiles: ['https://tiles.openfreemap.org/planet/20261001_000000_pt/{z}/{x}/{y}.pbf'] }), { status: 200 });
    }
    return new Response(tileBytes, { status: 200 });
  };
  // Um provedor por relatório (como em produção: o teto de tiles vale por documento); o cache em disco é compartilhado.
  const newResolution = (): BasemapResolution => ({
    provider: new OpenFreeMapProvider({ fetchImpl, cacheDir: cache, userAgent: 'GMN-Teste/1.0' }),
    status: 'ENABLED',
    notice: null,
  });

  for (const city of [OTHER_CITIES[3], OTHER_CITIES[4]]) {
    const resolution = newResolution();
    const m = await model(city);
    const before = requests.length;
    const rendered = await renderReportPdf(m, { fonts: 'standard', compress: false, basemap: resolution });
    assert.equal(rendered.map?.basemap, 'INCLUDED', city.city);
    assert.ok((rendered.map?.tilesUsed ?? 99) <= 16);
    assert.ok(requests.length > before);
  }
  assert.ok(requests.every((r) => r.url.startsWith('https://tiles.openfreemap.org/')), 'só o host permitido');
  assert.ok(requests.every((r) => r.userAgent === 'GMN-Teste/1.0'), 'User-Agent próprio em todas as requisições');
  // Cache: gerar de novo o mesmo relatório não busca nenhum tile novo
  const m = await model(OTHER_CITIES[3]);
  const before = requests.length;
  await renderReportPdf(m, { fonts: 'standard', compress: false, basemap: newResolution() });
  assert.equal(requests.filter((r) => r.url.endsWith('.pbf')).length, requests.slice(0, before).filter((r) => r.url.endsWith('.pbf')).length, 'tiles em cache: nenhuma nova requisição de tile');
});

test('falha de rede em outra cidade nunca derruba o PDF', async () => {
  const provider = new OpenFreeMapProvider({ fetchImpl: async () => { throw new Error('rede indisponível'); } });
  const m = await model(OTHER_CITIES[0]);
  const rendered = await renderReportPdf(m, { fonts: 'standard', compress: false, basemap: { provider, status: 'ENABLED', notice: null } });
  assert.equal(rendered.basemapStatus, 'FAILED');
  assert.ok(rendered.pageCount >= 8);
});

test('comportamento padrão de produção: sem variáveis do mapa, todo PDF sai sem mapa-base (nunca com tiles de demonstração)', async () => {
  const resolution = await resolveBasemap({});
  assert.equal(resolution.status, 'NONE');
  assert.ok(!(resolution.provider instanceof LocalDirectoryProvider));
  assert.equal(resolution.provider.kind, 'none');
});
