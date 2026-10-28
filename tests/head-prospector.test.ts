import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { HeadProspectorAgent } from '../src/agents/head-prospector';

type SerperPlace = { placeId?: string; cid?: string; title: string; latitude: number; longitude: number };
const place = (index: number): SerperPlace => ({
  placeId: `real-google-place-${index}`,
  cid: `cid-${index}`,
  title: `Clínica de Estética ${index}`,
  latitude: -16.33,
  longitude: -48.95,
});
const page1 = Array.from({ length: 20 }, (_, index) => place(index + 1));
const originalFetch = globalThis.fetch;
const originalSerper = process.env.SERPER_API_KEY;
const originalDemo = process.env.GMN_DEMO_MODE;
const originalServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
const originalDataforseo = process.env.DATAFORSEO_LOGIN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSerper === undefined) delete process.env.SERPER_API_KEY;
  else process.env.SERPER_API_KEY = originalSerper;
  if (originalDemo === undefined) delete process.env.GMN_DEMO_MODE;
  else process.env.GMN_DEMO_MODE = originalDemo;
  if (originalServiceRole === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRole;
  if (originalDataforseo === undefined) delete process.env.DATAFORSEO_LOGIN;
  else process.env.DATAFORSEO_LOGIN = originalDataforseo;
});

function mockSerper(page2: SerperPlace[]): void {
  process.env.SERPER_API_KEY = 'test-key-for-serper-dev';
  delete process.env.GMN_DEMO_MODE;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.DATAFORSEO_LOGIN;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { page: number };
    return new Response(JSON.stringify({ places: body.page === 1 ? page1 : page2 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

test('Head Agent substitui repetidos na segunda página e persiste 10 distintos em memória', async () => {
  mockSerper([
    place(19), place(4), place(20), ...Array.from({ length: 17 }, (_, index) => place(index + 21)),
  ]);
  const result = await new HeadProspectorAgent().executeProspecting({
    city: 'Anápolis', stateCode: 'GO', nicheKeyword: 'Clínica de Estética',
  });
  assert.equal(result.leads.length, 10);
  assert.equal(new Set(result.leads.map((item) => item.placeId)).size, 10);
  assert.ok(result.leads.every((item) => item.placeId !== 'real-google-place-4'));
  assert.deepEqual(result.leads.map((item) => item.frontierRank), [15,16,17,18,19,20,24,25,26,27]);
});

test('Head Agent falha claramente quando Serper repete a primeira página inteira', async () => {
  mockSerper(page1);
  await assert.rejects(
    new HeadProspectorAgent().executeProspecting({
      city: 'Anápolis', stateCode: 'GO', nicheKeyword: 'Clínica de Estética',
    }),
    /somente 6 estabelecimentos únicos.*Nenhum lead foi salvo/
  );
});

test('não cria 10 empresas fictícias quando não há provedor configurado', async () => {
  delete process.env.SERPER_API_KEY;
  delete process.env.GMN_DEMO_MODE;
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  await assert.rejects(
    new HeadProspectorAgent().executeProspecting({
      city: 'Anápolis', stateCode: 'GO', nicheKeyword: 'Clínica de Estética',
    }),
    /Não foi possível obter resultados reais/
  );
});

test('dados de demonstração só são usados se GMN_DEMO_MODE=true', async () => {
  delete process.env.SERPER_API_KEY;
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.GMN_DEMO_MODE = 'true';
  const result = await new HeadProspectorAgent().executeProspecting({
    city: 'Anápolis', stateCode: 'GO', nicheKeyword: 'Clínica de Estética',
  });
  assert.equal(result.leads.length, 10);
  assert.ok(result.leads.every((item) => item.placeId.startsWith('ChIJ_GMN_FRONTIER_')));
});
