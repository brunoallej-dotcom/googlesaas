import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { battlefieldAgent } from '../src/agents/battlefield-agent';
import { HeadProspectorAgent } from '../src/agents/head-prospector';
import { judgeAgent } from '../src/agents/judge-agent';
import { reputationAgent } from '../src/agents/reputation-agent';
import { rivalsAgent } from '../src/agents/rivals-agent';
import { vitrineAgent } from '../src/agents/vitrine-agent';
import { gmnRepository } from '../src/lib/supabase';
import { resolveEvidenceCoverage } from '../src/lib/evidence/coverage';
import { buildReportFixture, buildReportFixtureLead, fixtureReviewsFetcher } from '../src/dev/report-fixture';
import { legacyJudge, legacyReputation, legacyVitrine } from '../src/dev/legacy-fixture';
import { buildFixtureBattlefield } from '../src/dev/battlefield-fixture';

const ENV_KEYS = ['SERPER_API_KEY', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD', 'GMN_DEMO_MODE', 'GMN_REVIEWS_PROVIDER', 'SUPABASE_SERVICE_ROLE_KEY', 'BATTLEFIELD_POINT_RETRIES', 'BATTLEFIELD_CONCURRENCY'] as const;
const saved = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
const originalLog = console.log;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.BATTLEFIELD_POINT_RETRIES = '1';
  console.log = () => undefined; // os agentes registram logs JSON
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  console.log = originalLog;
});

const LEAD = buildReportFixtureLead({ placeId: 'ChIJ_LEAD_TESTE', cid: '111', featureId: '0x1:0x2' });
const failFetch = (): typeof fetch => async () => {
  throw new Error('NENHUMA chamada externa era esperada neste teste');
};

/* ------------------------------ Reputação ------------------------------ */

test('reputação sem fonte: indicadores indisponíveis, sem avaliações, autores ou distribuição inventados', async () => {
  globalThis.fetch = failFetch();
  const result = await reputationAgent.analyze(LEAD, 'a1');
  assert.equal(result.interactionsLast30Days, null);
  assert.equal(result.ownerResponseRatePercent, null);
  assert.equal(result.ownerRepliesLast30Days, null);
  assert.equal(result.averageOwnerResponseHours, null);
  assert.equal(result.starDistribution, null);
  assert.equal(result.velocityStatus, 'NOT_VERIFIED');
  assert.deepEqual(result.recentReviewsSample, []);
  assert.equal(result.reviewsAvailability?.state, 'UNAVAILABLE');
  assert.match(result.reviewsAvailability?.reason ?? '', /desligada/);
  // nota e total vêm do lead (coletados), não de estimativas
  assert.equal(result.averageRating, LEAD.rating);
  assert.equal(result.totalReviews, LEAD.totalReviews);
});

test('o número de avaliações em 30 dias NUNCA é inferido do total histórico', async () => {
  globalThis.fetch = failFetch();
  const many = await reputationAgent.analyze({ ...LEAD, totalReviews: 5000 }, 'a2');
  const few = await reputationAgent.analyze({ ...LEAD, totalReviews: 3 }, 'a2');
  assert.equal(many.interactionsLast30Days, null);
  assert.equal(few.interactionsLast30Days, null);
});

test('reputação com fonte habilitada (fixture): indicadores calculados e amostra parcial identificada', async () => {
  const result = await reputationAgent.analyze(
    LEAD,
    'a3',
    { config: { enabled: true, apiKey: 'fixture-key-not-real', url: 'https://example.invalid', maxPages: 1 }, fetcher: fixtureReviewsFetcher() }
  );
  const availability = result.reviewsAvailability;
  assert.equal(availability?.state, 'FETCHED');
  assert.equal(availability?.analysis?.sampleSize, 24);
  assert.equal(availability?.analysis?.sampleIsComplete, false, '24 de 39 não é o total do perfil');
  assert.ok(result.interactionsLast30Days !== null && result.interactionsLast30Days > 0);
  assert.equal(result.ownerResponseRatePercent, 25);
  assert.deepEqual(result.recentReviewsSample, [], 'textos e nomes de clientes não são armazenados');
});

test('falha do provedor de avaliações: registrada, sem derrubar a auditoria e sem número inventado', async () => {
  const result = await reputationAgent.analyze(LEAD, 'a4', {
    config: { enabled: true, apiKey: 'fixture-key-not-real', url: 'https://example.invalid', maxPages: 1 },
    fetcher: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(result.reviewsAvailability?.state, 'UNAVAILABLE');
  assert.equal(result.reviewsAvailability?.provider, 'Serper.dev (Google Reviews)');
  assert.match(result.reviewsAvailability?.reason ?? '', /HTTP 503/);
  assert.equal(result.interactionsLast30Days, null);
  assert.equal(result.ownerResponseRatePercent, null);
});

/* -------------------------------- Vitrine -------------------------------- */

test('vitrine sem fonte: nenhum contador, data ou publicação é produzido', async () => {
  globalThis.fetch = failFetch();
  const result = await vitrineAgent.analyze(LEAD, 'b1');
  for (const field of ['totalPhotosCount', 'ownerPhotosCount', 'customerPhotosCount', 'totalVideosCount', 'hasCoverPhoto', 'hasLogoPhoto', 'lastMediaUploadedAt', 'daysSinceLastMedia', 'lastPostPublishedAt', 'daysSinceLastPost', 'totalActivePostsLast90Days', 'latestPost'] as const) {
    assert.equal(result[field], null, field);
  }
  assert.deepEqual(result.mediaGallerySample, []);
  assert.equal(result.availability?.state, 'UNAVAILABLE');
  assert.deepEqual(result.availability?.fieldsProvided, []);
  assert.match(result.availability?.reason ?? '', /painel do proprietário/);
});

test('vitrine: nenhuma chamada externa é feita, mesmo com credenciais de outros provedores no ambiente', async () => {
  process.env.DATAFORSEO_LOGIN = 'usuario-real@exemplo.com';
  process.env.DATAFORSEO_PASSWORD = 'senha-de-teste';
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  };
  const result = await vitrineAgent.analyze(LEAD, 'b2');
  assert.equal(calls, 0, 'o DataForSEO não é mais usado');
  assert.equal(result.availability?.state, 'UNAVAILABLE');
  assert.equal(result.availability?.provider, null);
  assert.equal(result.totalPhotosCount, null);
  assert.match(result.availability?.reason ?? '', /Nenhuma fonte contratada/);
});

test('modo demonstração é explícito: só com GMN_DEMO_MODE=true e identificado como simulado', async () => {
  process.env.GMN_DEMO_MODE = 'true';
  const demo = await vitrineAgent.analyze(LEAD, 'b4');
  assert.match(demo.availability?.provider ?? '', /DEMONSTRAÇÃO/);
  assert.ok(demo.mediaGallerySample.every((m) => m.mediaId.startsWith(`med_${LEAD.placeId}_`)), 'marcadores de dado simulado');
  delete process.env.GMN_DEMO_MODE;
  const real = await vitrineAgent.analyze(LEAD, 'b5');
  assert.equal(real.totalPhotosCount, null);
});

test('uma falha de coleta nunca vira a ativação automática do modo demonstração', async () => {
  globalThis.fetch = async () => { throw new Error('rede indisponível'); };
  const result = await vitrineAgent.analyze(LEAD, 'b6');
  assert.equal(result.mediaGallerySample.length, 0);
  assert.equal(result.availability?.state, 'UNAVAILABLE');
});

/* ------------------------------- Battlefield ------------------------------ */

test('Battlefield sem provedor: 49 pontos SEM LEITURA, falha registrada e nenhuma posição inventada', async () => {
  globalThis.fetch = failFetch();
  const result = await battlefieldAgent.executeBattlefieldGrid({ auditId: 'c1', lead: LEAD, rawKeyword: 'dentista', city: 'Anápolis' });
  assert.equal(result.points.length, 49);
  assert.ok(result.points.every((p) => p.readStatus === 'UNREADABLE' && p.targetRank === null && p.pointLeader === null));
  assert.equal(result.validPointsCount, 0);
  assert.equal(result.unreadablePointsCount, 49);
  assert.equal(result.rankIndexAverage, null);
  assert.equal(result.knownPositionAverage, null);
  assert.equal(result.dataOrigin, 'COLLECTED');
  assert.equal(result.providerFailures?.length, 1);
  assert.match(result.providerFailures?.[0]?.reason ?? '', /Nenhum provedor/);
  assert.ok(!result.points.some((p) => p.pointLeader?.placeId.startsWith('ChIJ_RIVAL_DOMINATOR_')));
});

test('Battlefield em modo demonstração: resultado identificado como SIMULADO', async () => {
  process.env.GMN_DEMO_MODE = 'true';
  const result = await battlefieldAgent.executeBattlefieldGrid({ auditId: 'c2', lead: LEAD, rawKeyword: 'dentista', city: 'Anápolis' });
  assert.equal(result.dataOrigin, 'SIMULATED');
  assert.equal(result.historicalEvolution.hasPreviousRound, false);
  assert.ok(result.points.some((p) => p.pointLeader?.placeId.startsWith('ChIJ_RIVAL_DOMINATOR_')));
});

test('Battlefield: falhas parciais preservam as leituras válidas e marcam só os pontos afetados', async () => {
  process.env.SERPER_API_KEY = 'chave-de-teste-serper-1234';
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls % 7 === 0) return new Response('erro', { status: 500 });
    return new Response(
      JSON.stringify({ places: [
        { position: 1, placeId: 'OUTRA', title: 'Concorrente Real', type: 'Dentista', rating: 4.7, ratingCount: 210, website: 'https://x.com' },
        { position: 2, placeId: LEAD.placeId, title: LEAD.businessName },
      ] }),
      { status: 200 }
    );
  };
  const result = await battlefieldAgent.executeBattlefieldGrid({ auditId: 'c3', lead: LEAD, rawKeyword: 'dentista', city: 'Anápolis' });
  assert.equal(result.points.length, 49);
  assert.equal(result.unreadablePointsCount, 7);
  assert.equal(result.validPointsCount, 42);
  assert.ok(result.points.filter((p) => p.readStatus === 'VALID').every((p) => p.targetRank === 2));
  assert.equal(result.rankIndexAverage, 2);
  assert.equal(result.providerFailures?.length, 1, 'falhas iguais são agrupadas');
  assert.match(result.providerFailures?.[0]?.reason ?? '', /HTTP 500.*7 pontos/);
  assert.equal(result.dataOrigin, 'COLLECTED');
});

test('Battlefield: líder sem nota ou avaliações vem com null, nunca com o padrão 4,8 / 140', async () => {
  process.env.SERPER_API_KEY = 'chave-de-teste-serper-1234';
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ places: [{ position: 1, placeId: 'LIDER_SEM_DADOS', title: 'Líder' }, { position: 2, placeId: LEAD.placeId }] }), { status: 200 });
  const result = await battlefieldAgent.executeBattlefieldGrid({ auditId: 'c4', lead: LEAD, rawKeyword: 'dentista', city: 'Anápolis' });
  const leaders = result.points.map((p) => p.pointLeader).filter((l) => l !== null);
  assert.ok(leaders.length > 0);
  assert.ok(leaders.every((l) => l?.rating === null && l?.totalReviews === null));
  const rivals = await rivalsAgent.analyze({
    auditId: 'c4', lead: LEAD, battlefield: result,
    reputation: await reputationAgent.analyze(LEAD, 'c4'), vitrine: await vitrineAgent.analyze(LEAD, 'c4'),
  });
  const top = rivals.topDominators[0];
  assert.equal(top?.rating, null);
  assert.equal(top?.totalReviews, null);
  assert.equal(top?.gapAnalysisVsTarget.reviewsGap, null);
  assert.equal(top?.estimatedReviewsLast30Days, null);
  assert.equal(top?.ownerResponseRatePercent, null);
  assert.equal(top?.totalPhotosCount, null);
});

/* --------------------------------- Rivais --------------------------------- */

test('rivais: nenhuma métrica estimada (fotos, avaliações em 30 dias, taxa de resposta)', async () => {
  const data = await buildReportFixture({ dataStyle: 'phase4' });
  for (const rival of data.rivals.topDominators) {
    assert.equal(rival.estimatedReviewsLast30Days, null);
    assert.equal(rival.ownerResponseRatePercent, null);
    assert.equal(rival.totalPhotosCount, null);
    assert.equal(rival.gapAnalysisVsTarget.photosGap, null);
  }
  assert.ok(data.rivals.topDominators[0]?.pointsWonAsNumberOne ?? 0 > 0);
});

/* ------------------------------ Head Prospector --------------------------- */

test('prospecção: reivindicação, atributos, serviços, nota e avaliações ausentes não são inventados', async () => {
  process.env.SERPER_API_KEY = 'chave-de-teste-serper-1234';
  const places = Array.from({ length: 20 }, (_, i) => ({ placeId: `real-${i + 1}`, cid: `c${i + 1}`, title: `Empresa ${i + 1}`, latitude: -16.33, longitude: -48.95 }));
  globalThis.fetch = async (_url, init) => {
    const { page } = JSON.parse(String(init?.body)) as { page: number };
    const extra = Array.from({ length: 20 }, (_, i) => ({ placeId: `real-${i + 21}`, cid: `c${i + 21}`, title: `Empresa ${i + 21}`, latitude: -16.33, longitude: -48.95, rating: 4.2, ratingCount: 31 }));
    return new Response(JSON.stringify({ places: page === 1 ? places : extra }), { status: 200 });
  };
  const result = await new HeadProspectorAgent().executeProspecting({ city: 'Anápolis', stateCode: 'GO', nicheKeyword: 'Dentista' });
  const noData = result.leads.find((l) => l.frontierRank === 15);
  assert.ok(noData);
  assert.equal(noData.rating, 0);
  assert.equal(noData.totalReviews, 0);
  assert.equal(noData.claimedByOwner, false);
  assert.equal(noData.provenance?.claimedByOwner, 'UNKNOWN');
  assert.equal(noData.provenance?.rating, 'UNKNOWN');
  assert.equal(noData.servicesListedCount, 0);
  assert.equal(noData.attributesCount, 0);
  const withData = result.leads.find((l) => l.frontierRank === 21);
  assert.equal(withData?.rating, 4.2);
  assert.equal(withData?.provenance?.rating, 'COLLECTED');
  assert.equal(withData?.provenance?.totalReviews, 'COLLECTED');
});

/* ----------------------------------- Juiz ---------------------------------- */

test('reprocessar o Juiz com as mesmas entradas dá o mesmo resultado (sem duplicar nem divergir)', async () => {
  const data = await buildReportFixture({ dataStyle: 'phase4-live' });
  const args = { auditId: 'd1', lead: data.lead, reputation: data.reputation, vitrine: data.vitrine, battlefield: data.battlefield, rivals: data.rivals };
  const a = judgeAgent.evaluate(args);
  const b = judgeAgent.evaluate(args);
  assert.deepEqual({ ...a, evaluatedAt: '' }, { ...b, evaluatedAt: '' });
});

test('o Juiz registra as falhas de provedor junto das evidências e marca a ficha como não demonstração', async () => {
  const data = await buildReportFixture({ dataStyle: 'phase4' });
  const failure = { provider: 'Serper.dev (Google Maps)', operation: 'busca territorial', reason: 'HTTP 500', at: '2026-10-16T00:00:00.000Z' };
  const sheet = judgeAgent.evaluate({ auditId: 'd2', lead: data.lead, reputation: data.reputation, vitrine: data.vitrine, battlefield: data.battlefield, rivals: data.rivals, providerFailures: [failure] });
  assert.deepEqual(sheet.evidenceBundle?.providerFailures, [failure]);
  assert.equal(sheet.evidenceBundle?.demo, false);
  assert.equal(sheet.evidenceBundle?.schemaVersion, 1);
});

test('dados simulados nunca são persistidos como evidência real', async () => {
  const data = await buildReportFixture({ dataStyle: 'phase4' });
  const sheet = judgeAgent.evaluate({
    auditId: 'd3', lead: data.lead,
    reputation: legacyReputation(data.lead), vitrine: legacyVitrine(data.lead),
    battlefield: data.battlefield, rivals: data.rivals,
  });
  assert.ok(sheet.evidenceBundle?.evidence.every((e) => e.status !== 'SIMULATED'));
  const marked = sheet.checklist21Items.filter((i) => i.evidence?.status === 'SIMULATED');
  assert.equal(marked.length, 7, 'critérios 12 a 18 ficam marcados como simulados');
  assert.ok(marked.every((i) => i.scoreAwarded === null && i.evidence?.value === null));
});

/* ----------------------- Persistência e compatibilidade ---------------------- */

test('gravar e ler: evidências e resumo de pontuação sobrevivem ao ciclo de persistência', async () => {
  const data = await buildReportFixture({ dataStyle: 'phase4-live' });
  const auditId = '00000000-0000-4000-8000-0000000000b1';
  await gmnRepository.updateAuditProgress(auditId, 'RUNNING_STRATEGIST', 72, 'JUDGE', { judge: data.judge });
  const state = await gmnRepository.getAuditState(auditId);
  assert.ok(state);
  const read = JSON.parse(JSON.stringify(state.judge)) as typeof data.judge;
  assert.deepEqual(read.scoreSummary, data.judge.scoreSummary);
  assert.deepEqual(read.evidenceBundle, data.judge.evidenceBundle);
  assert.equal(read.checklist21Items[4]?.evidence?.status, data.judge.checklist21Items[4]?.evidence?.status);
});

test('compatibilidade histórica: ficha anterior à Fase 4 é lida, preservada e reavaliada sem promover critérios', async () => {
  const data = await buildReportFixture({ dataStyle: 'simulated' });
  const auditId = '00000000-0000-4000-8000-0000000000b2';
  await gmnRepository.updateAuditProgress(auditId, 'COMPLETED', 100, 'MAESTRO', { judge: data.judge });
  const stored = (await gmnRepository.getAuditState(auditId))?.judge as typeof data.judge;
  assert.equal(stored.overallScore, data.judge.overallScore, 'o score histórico gravado não é recalculado nem sobrescrito');
  assert.equal(stored.scoreSummary, undefined);
  assert.equal(stored.checklist21Items.every((i) => i.evidence === undefined), true);

  const coverage = resolveEvidenceCoverage({ lead: data.lead, reputation: data.reputation, vitrine: data.vitrine, battlefield: data.battlefield, rivals: data.rivals, judge: stored });
  assert.equal(coverage?.buckets.VERIFIED.count, 5);
  assert.equal(coverage?.buckets.PARTIALLY_VERIFIED.count, 2);
  assert.equal(coverage?.buckets.SIMULATED.count, 6);
  assert.equal(coverage?.buckets.NOT_VERIFIED.count, 8);
  assert.equal(coverage?.recalculatedScore, stored.overallScore, 'mesma fórmula: o histórico é idêntico');
});

test('a ficha histórica gerada pelo formato antigo continua com 21 itens e a fórmula original', async () => {
  const data = await buildReportFixture({ dataStyle: 'simulated' });
  const legacy = legacyJudge({ lead: data.lead, reputation: data.reputation, vitrine: data.vitrine, battlefield: buildFixtureBattlefield('full'), rivals: data.rivals });
  assert.equal(legacy.checklist21Items.length, 21);
  assert.equal(legacy.checklist21Items.reduce((s, i) => s + i.maxWeight, 0), 102);
  assert.ok(legacy.checklist21Items.every((i) => typeof i.scoreAwarded === 'number'));
});
