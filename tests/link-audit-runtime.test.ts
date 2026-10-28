import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { identifiersFingerprint, type ConsumptionAuthorization } from '../src/lib/link-audit/collector/budget';
import type { CollectorProviders } from '../src/lib/link-audit/collector/types';
import { readRuntimeConfig, describeRuntimeConfig } from '../src/lib/link-audit-runtime/config';
import { runLinkAuditCollection } from '../src/lib/link-audit-runtime/run';
import { createFileUsedStore, createMemoryUsedStore } from '../src/lib/link-audit-runtime/used-authorizations';
import { CID, FAKE_KEY, FID, LINK, NAMED, PLACE, SITE_HTML, T_NOW, clock, mapsFake, siteFake } from './helpers/link-audit-collect-fixtures';

const trap = (): CollectorProviders => ({
  maps: { search: async () => { throw new Error('PROVEDOR ACIONADO'); } },
  site: { check: async () => { throw new Error('PROVEDOR ACIONADO'); } },
});

const AUTH: ConsumptionAuthorization = {
  authorizationId: 'auth-teste-0001',
  snapshotId: 'snap-exemplo-0001',
  identifiersFingerprint: identifiersFingerprint({ cid: CID, featureId: FID }),
  maxMapsCalls: 1,
  maxSiteHttpRequests: 8,
  expiresAt: '2026-10-21T13:00:00.000Z',
  costAcknowledged: true,
  operator: 'ana@empresa.com',
};

const pages = { '/': { body: SITE_HTML }, '/robots.txt': { body: 'User-agent: *\nAllow: /' } };

test('DRY_RUN é o padrão: devolve plano e custo, não cria nem aciona provedores, não expõe dado de empresa', async () => {
  const outcome = await runLinkAuditCollection({ input: NAMED() }, { now: clock, providers: trap(), createLiveProviders: () => { throw new Error('fábrica acionada'); } });
  assert.ok(outcome.ok && outcome.kind === 'PLAN');
  assert.equal(outcome.plan.externalTraffic, false);
  assert.equal(outcome.plan.mode, 'DRY_RUN');
  assert.deepEqual(outcome.plan.calls.map((c) => [c.provider, c.maxCalls]), [['serper-maps', 1], ['serper-reviews', 0], ['site-check', 1]]);
  assert.equal(outcome.plan.cost.confirmed, false);
  assert.equal(outcome.plan.search.query, 'Padaria Exemplo Cidade Exemplo GO');
  assert.ok(!('evidences' in outcome.plan) && !('profile' in outcome.plan));
});

test('coleta sem identidade confirmada é recusada em qualquer modo', async () => {
  const input = NAMED();
  const unconfirmed = { ...input, identity: { ...input.identity, confirmation: undefined } } as typeof input;
  for (const mode of ['DRY_RUN', 'SIMULATED', 'LIVE'] as const) {
    const outcome = await runLinkAuditCollection({ mode, input: unconfirmed, authorization: AUTH }, { now: clock, providers: trap(), liveEnabled: true });
    assert.ok(!outcome.ok && outcome.code === 'IDENTITY_NOT_CONFIRMED', mode);
  }
});

test('SIMULATED: relatório completo, dados separados por fonte, nenhuma pontuação, zero tráfego externo', async () => {
  const outcome = await runLinkAuditCollection(
    { mode: 'SIMULATED', input: NAMED() },
    { now: clock, providers: { maps: mapsFake([PLACE]), site: siteFake(pages) } },
  );
  assert.ok(outcome.ok && outcome.kind === 'REPORT');
  const report = outcome.report;
  assert.equal(report.mode, 'SIMULATED');
  assert.equal(report.externalTraffic, false);
  assert.equal(report.scoring, 'NOT_AVAILABLE_PENDING_D3');
  assert.equal(report.located, 'MATCHED');
  assert.deepEqual(report.provenIdentifiers, { cid: CID, featureId: FID });
  assert.equal(report.found.googleMaps?.source, 'serper-maps');
  assert.equal(report.found.googleMaps?.queriedAt, '2026-10-21T12:10:00.000Z');
  assert.match(report.found.googleMaps?.originNote ?? '', /não é a API oficial do Google Business Profile/);
  assert.equal(report.found.site?.source, 'site-check');
  assert.ok(!JSON.stringify(report.found.googleMaps).includes('SEGREDO-IG'), 'parâmetros de rastreio do site saem saneados');
  assert.equal(report.calls.simulated, 2);
  assert.equal(report.calls.sent, 0);
  assert.ok(report.evidences.length > 0);
  assert.ok(report.unverified.length > 0, 'o que não foi comprovado é listado como não verificado');
  assert.ok(report.cost.confirmed === false);
  const text = JSON.stringify(report);
  assert.ok(!/"(?:score|points|pontos|nota|index|indice|classification|confidence)"\s*:/i.test(text), 'sem pontos, índice, classificação ou confiança');
  assert.ok(!/não existe|inexistente|ausente do google/i.test(text), 'ausência nunca é afirmada');
});

test('SIMULATED: divergência de telefone, nome e domínio entre perfil e site', async () => {
  const differentSite = `<html><head><script type="application/ld+json">{"@type":"LocalBusiness","name":"Outro Nome Qualquer","telephone":"+55 11 3333-4444"}</script></head><body><a href="tel:+551133334444">x</a></body></html>`;
  const outcome = await runLinkAuditCollection(
    { mode: 'SIMULATED', input: NAMED() },
    { now: clock, providers: { maps: mapsFake([PLACE]), site: siteFake({ '/': { body: differentSite }, '/robots.txt': { body: '' } }) } },
  );
  assert.ok(outcome.ok && outcome.kind === 'REPORT');
  assert.deepEqual(outcome.report.divergences.map((d) => d.field).sort(), ['nome', 'telefone']);
});

test('SIMULATED sem provedores é recusado; modo inválido também', async () => {
  const none = await runLinkAuditCollection({ mode: 'SIMULATED', input: NAMED() }, { now: clock });
  assert.ok(!none.ok && none.code === 'NO_PROVIDERS');
  const bad = await runLinkAuditCollection({ mode: 'XYZ' as never, input: NAMED() }, { now: clock });
  assert.ok(!bad.ok && bad.code === 'INVALID_REQUEST');
});

test('perfil devolvido com identificador de outra empresa NÃO é aceito, mesmo com nome idêntico', async () => {
  const lookalike = { ...PLACE, cid: '5555555555555555555', fid: '0x1:0x2', placeId: undefined };
  const outcome = await runLinkAuditCollection({ mode: 'SIMULATED', input: NAMED() }, { now: clock, providers: { maps: mapsFake([lookalike]), site: siteFake(pages) } });
  assert.ok(outcome.ok && outcome.kind === 'REPORT');
  assert.equal(outcome.report.located, 'NOT_LOCATED');
  assert.equal(outcome.report.found.googleMaps, null);
  assert.deepEqual(outcome.report.provenIdentifiers, {});
});

test('resultados sem identificador comparável com o link: limitação explícita, nada aceito por nome', async () => {
  const semId = { title: 'Padaria Exemplo (fictícia)', address: 'Rua Fictícia, 100', phoneNumber: '(62) 99999-0000' };
  const outcome = await runLinkAuditCollection({ mode: 'SIMULATED', input: NAMED() }, { now: clock, providers: { maps: mapsFake([semId]), site: siteFake(pages) } });
  assert.ok(outcome.ok && outcome.kind === 'REPORT');
  assert.equal(outcome.report.located, 'NOT_LOCATED');
  assert.match(outcome.report.limitations.join(' '), /não pôde ser confirmado|identificador do mesmo tipo/);
});

test('falha do provedor consome o orçamento e não é repetida', async () => {
  let calls = 0;
  const maps = mapsFake(() => { calls += 1; return { state: 'FAILED', reason: 'Serper /maps respondeu HTTP 500' }; });
  const outcome = await runLinkAuditCollection({ mode: 'SIMULATED', input: NAMED(), budget: { maps: 3, reviews: 0, site: 1 } }, { now: clock, providers: { maps, site: siteFake(pages) } });
  assert.equal(calls, 1, 'uma única tentativa mesmo com orçamento 3');
  assert.ok(outcome.ok && outcome.kind === 'REPORT');
  assert.match(outcome.report.limitations.join(' '), /HTTP 500/);
});

// ---------------------------------------------------------------------------------------------- LIVE

const evidenceDirs: string[] = [];
const newEvidenceDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lal-ev-'));
  evidenceDirs.push(dir);
  return dir;
};
after(() => evidenceDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const capture = (hooks: { onCapture: (info: never) => Promise<void> } | undefined) =>
  hooks?.onCapture({ url: 'https://google.serper.dev/maps', requestBody: { q: 'x', gl: 'br', hl: 'pt-br', page: 1 }, httpStatus: 200, bodyText: JSON.stringify({ places: [PLACE], credits: 3 }), attempts: 1, failure: null, capturedAt: '2026-10-21T12:10:00.000Z' } as never);

function liveDeps(overrides: Record<string, unknown> = {}) {
  const store = createMemoryUsedStore();
  let created = 0;
  let searches = 0;
  const providers: CollectorProviders = {
    maps: { search: async () => { searches += 1; await capture(currentHooks); return { state: 'OK', value: [PLACE], fetchedAt: '2026-10-21T12:10:00.000Z' }; } },
    site: siteFake(pages),
    reviews: { getReviews: async () => { throw new Error('/reviews NUNCA deve ser chamado'); } },
  };
  let currentHooks: { onCapture: (info: never) => Promise<void> } | undefined;
  return {
    store,
    count: () => ({ created, searches }),
    deps: { now: clock, liveEnabled: true, usedStore: store, evidence: { baseDir: newEvidenceDir() }, createLiveProviders: (hooks?: { onCapture: (info: never) => Promise<void> }) => { created += 1; currentHooks = hooks; return providers; }, ...overrides },
  };
}

test('LIVE sem a trava de ambiente, sem autorização ou sem ciência do custo: recusa ANTES de criar provedores', async () => {
  for (const [authorization, deps, code] of [
    [AUTH, { liveEnabled: false }, 'LIVE_DISABLED'],
    [undefined, {}, 'NO_AUTHORIZATION'],
    [{ ...AUTH, costAcknowledged: false }, {}, 'COST_NOT_ACKNOWLEDGED'],
    [{ ...AUTH, expiresAt: '2026-10-21T12:00:00.000Z' }, {}, 'EXPIRED'],
    [{ ...AUTH, snapshotId: 'outra-auditoria-9' }, {}, 'WRONG_AUDIT'],
    [{ ...AUTH, identifiersFingerprint: identifiersFingerprint({ cid: '1' }) }, {}, 'WRONG_COMPANY'],
    [{ ...AUTH, maxMapsCalls: 0 }, {}, 'LIMIT_ABOVE_AUTHORIZED'],
  ] as const) {
    const ctx = liveDeps(deps);
    const outcome = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization }, ctx.deps as never);
    assert.ok(!outcome.ok && outcome.code === code, `${code}: ${JSON.stringify(outcome).slice(0, 120)}`);
    assert.deepEqual(ctx.count(), { created: 0, searches: 0 }, code);
    assert.equal(ctx.store.isUsed(AUTH.authorizationId), false, 'a autorização não foi consumida por uma recusa');
  }
});

test('LIVE sem armazenamento de uso ou sem fábrica de provedores: recusa', async () => {
  const noStore = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH }, { now: clock, liveEnabled: true, createLiveProviders: () => ({}) });
  assert.ok(!noStore.ok);
  const noFactory = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH }, { now: clock, liveEnabled: true, usedStore: createMemoryUsedStore() });
  assert.ok(!noFactory.ok && noFactory.code === 'NO_PROVIDERS');
});

test('LIVE pedindo /reviews ou mais de uma chamada é recusado', async () => {
  const ctx = liveDeps();
  const reviews = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH, budget: { maps: 1, reviews: 1, site: 1 } }, ctx.deps as never);
  assert.ok(!reviews.ok);
  const many = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH, budget: { maps: 2, reviews: 0, site: 1 } }, ctx.deps as never);
  assert.ok(!many.ok && many.code === 'LIMIT_ABOVE_AUTHORIZED');
  assert.deepEqual(ctx.count(), { created: 0, searches: 0 });
});

test('LIVE válido: marca a autorização ANTES de chamar, faz 1 chamada ao /maps, nenhuma ao /reviews; reutilizar é recusado', async () => {
  const ctx = liveDeps();
  const order: string[] = [];
  const store = {
    isUsed: (id: string) => ctx.store.isUsed(id),
    companyUsedSince: (f: string, since: string) => ctx.store.companyUsedSince(f, since),
    markUsed: (record: Parameters<typeof ctx.store.markUsed>[0]) => { order.push('marcou'); return ctx.store.markUsed(record); },
  };
  const deps = {
    ...ctx.deps,
    usedStore: store,
    createLiveProviders: (hooks: { onCapture: (info: never) => Promise<void> }) => ({
      maps: { search: async () => { order.push('chamou'); await capture(hooks); return { state: 'OK' as const, value: [PLACE], fetchedAt: '2026-10-21T12:10:00.000Z' }; } },
      site: siteFake(pages),
      reviews: { getReviews: async () => { throw new Error('/reviews NUNCA'); } },
    }),
  };
  const first = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH }, deps as never);
  assert.ok(first.ok && first.kind === 'REPORT');
  assert.deepEqual(order, ['marcou', 'chamou']);
  assert.equal(first.report.mode, 'LIVE');
  assert.equal(first.report.externalTraffic, true);
  assert.equal(first.report.calls.byProvider['serper-maps'].sent, 1);
  assert.equal(first.report.calls.byProvider['serper-reviews'].sent, 0);
  const second = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH }, deps as never);
  assert.ok(!second.ok && second.code === 'ALREADY_USED');
  assert.equal(order.filter((x) => x === 'chamou').length, 1, 'nenhuma segunda chamada');
});

test('LIVE: falha de gravação do marcador impede a chamada (falha fechada)', async () => {
  let searched = 0;
  const outcome = await runLinkAuditCollection(
    { mode: 'LIVE', input: NAMED(), authorization: AUTH },
    {
      now: clock,
      liveEnabled: true,
      evidence: { baseDir: newEvidenceDir() },
      usedStore: { isUsed: () => false, companyUsedSince: () => false, markUsed: () => ({ ok: false, reason: 'disco cheio' }) },
      createLiveProviders: () => ({ maps: { search: async () => { searched += 1; return { state: 'FAILED', reason: 'x' }; } } }),
    },
  );
  assert.ok(!outcome.ok);
  assert.equal(searched, 0);
});

test('LIVE: duas execuções concorrentes com a mesma autorização fazem no máximo uma chamada', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lal-'));
  try {
    const store = createFileUsedStore(dir);
    let searched = 0;
    const deps = {
      now: clock,
      liveEnabled: true,
      usedStore: store,
      evidence: { baseDir: newEvidenceDir() },
      createLiveProviders: (hooks: { onCapture: (info: never) => Promise<void> }) => ({ maps: { search: async () => { searched += 1; await capture(hooks); return { state: 'OK' as const, value: [PLACE], fetchedAt: T_NOW }; } } }),
    };
    const results = await Promise.all([
      runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH }, deps as never),
      runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH }, deps as never),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(searched, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------- marcadores e config

test('marcador de autorização usada: criação exclusiva, só id seguro, sem dado da empresa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lal-'));
  try {
    const store = createFileUsedStore(dir);
    const record = { authorizationId: 'auth-teste-0001', operator: 'ana@empresa.com', snapshotId: 's', maxMapsCalls: 1, markedAt: T_NOW };
    assert.equal(store.isUsed('auth-teste-0001'), false);
    assert.deepEqual(store.markUsed(record), { ok: true });
    assert.equal(store.isUsed('auth-teste-0001'), true);
    const again = store.markUsed(record);
    assert.ok(!again.ok);
    const content = fs.readFileSync(path.join(dir, 'auth-teste-0001.json'), 'utf8');
    assert.ok(!content.includes(LINK) && !content.includes(CID));
    for (const bad of ['../x', 'a/b', '', 'curto', 'x'.repeat(80)]) {
      assert.equal(store.isUsed(bad), true, `id inválido nunca vale: ${bad}`);
      assert.ok(!store.markUsed({ ...record, authorizationId: bad }).ok);
    }
    assert.deepEqual(fs.readdirSync(dir), ['auth-teste-0001.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config: lê o ambiente recebido, nunca expõe a chave e ignora valores inválidos', () => {
  const on = readRuntimeConfig({ SERPER_API_KEY: FAKE_KEY, GMN_LINK_AUDIT_LIVE: 'on', GMN_LINK_AUDIT_MAX_MAPS_CALLS: '1', GMN_LINK_AUDIT_AUTH_ID: 'auth-teste-0001' });
  assert.equal(on.apiKey, FAKE_KEY);
  assert.deepEqual(on.live, { enabled: true, maxMapsCalls: 1, authorizationId: 'auth-teste-0001' });
  assert.ok(!JSON.stringify(describeRuntimeConfig(on)).includes(FAKE_KEY));
  const off = readRuntimeConfig({});
  assert.deepEqual(off.live, { enabled: false, maxMapsCalls: 0, authorizationId: null });
  assert.equal(off.apiKey, null);
  for (const bad of ['2', '-1', '1.5', 'abc', '']) assert.equal(readRuntimeConfig({ GMN_LINK_AUDIT_MAX_MAPS_CALLS: bad }).live.maxMapsCalls, 0, bad);
  assert.equal(readRuntimeConfig({ GMN_LINK_AUDIT_LIVE: 'true' }).live.enabled, false, 'só "on" liga');
  assert.equal(readRuntimeConfig({ GMN_LINK_AUDIT_AUTH_ID: '../x' }).live.authorizationId, null);
  assert.equal(readRuntimeConfig({ SERPER_API_KEY: 'cole-sua-api-key-aqui' }).apiKey, null);
});

test('LIVE: nova autorização (id diferente) para a MESMA empresa dentro de 24 h é recusada', async () => {
  const ctx = liveDeps();
  const first = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH }, ctx.deps as never);
  assert.ok(first.ok);
  const second = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: { ...AUTH, authorizationId: 'auth-teste-0002' } }, ctx.deps as never);
  assert.ok(!second.ok && second.code === 'ALREADY_USED');
  assert.equal(ctx.count().searches, 1);
});

test('SIMULATED recusa provedores marcados como reais (tráfego pago não pode ser disfarçado de simulação)', async () => {
  const real = { ...mapsFake([PLACE]), live: true as const };
  const outcome = await runLinkAuditCollection({ mode: 'SIMULATED', input: NAMED() }, { now: clock, providers: { maps: real } });
  assert.ok(!outcome.ok && outcome.code === 'INVALID_REQUEST');
});

test('telefone vazio (<a href="tel:">) no site não gera divergência falsa', async () => {
  const vazio = '<html><body><a href="tel:">x</a></body></html>';
  const outcome = await runLinkAuditCollection({ mode: 'SIMULATED', input: NAMED() }, { now: clock, providers: { maps: mapsFake([PLACE]), site: siteFake({ '/': { body: vazio }, '/robots.txt': { body: '' } }) } });
  assert.ok(outcome.ok && outcome.kind === 'REPORT');
  assert.deepEqual(outcome.report.divergences.filter((d) => d.field === 'telefone'), []);
});
