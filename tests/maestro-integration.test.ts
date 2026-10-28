import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { maestroOrchestrator } from '../src/agents/maestro-orchestrator';
import { vitrineAgent } from '../src/agents/vitrine-agent';
import { assertNoSimulatedDataOutsideDemo, findSimulatedCollections } from '../src/lib/evidence/guards';
import { gmnRepository } from '../src/lib/supabase';
import { buildReportModel } from '../src/lib/pdf/report-model';
import { reportSourceFromAuditState } from '../src/lib/pdf/report-source';
import { buildReportFixture, buildReportFixtureLead } from '../src/dev/report-fixture';
import { legacyReputation, legacyVitrine } from '../src/dev/legacy-fixture';
import type { BullMQAuditJobPayload } from '../src/types/gmn';

/*
 * Integração do novo relatório com o fluxo do Maestro (o Worker BullMQ só chama este mesmo método).
 * Tudo é simulado em memória: nenhuma chamada externa, nenhum Supabase/Redis, nenhum arquivo em
 * `public/audits`. As respostas do Serper são HIPOTÉTICAS (fixtures de teste).
 */

const ENV_KEYS = [
  'SERPER_API_KEY', 'SERPER_MAPS_URL', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD', 'GMN_DEMO_MODE', 'GMN_REVIEWS_PROVIDER',
  'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'GMN_PDF_BASEMAP', 'GMN_PDF_OUTPUT_DIR', 'BATTLEFIELD_POINT_RETRIES', 'BATTLEFIELD_CONCURRENCY',
] as const;
const saved = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
const originalLog = console.log;
let outputDir = '';
let externalCalls: string[] = [];

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-maestro-'));
  process.env.GMN_PDF_OUTPUT_DIR = outputDir;
  process.env.BATTLEFIELD_POINT_RETRIES = '1';
  externalCalls = [];
  console.log = () => undefined;
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

const LEAD = buildReportFixtureLead({ placeId: 'ChIJ_MAESTRO_TESTE', websiteStatus: 'MISSING', websiteUrl: null, featureId: '0x1:0x2', cid: '555' });

function payload(auditId: string): BullMQAuditJobPayload {
  return { auditId, lead: LEAD, targetKeyword: 'dentista', interestCenter: LEAD.coordinates, gridZoom: '15z', gridStepMeters: 500 };
}

/** Serper hipotético: a empresa aparece em #5 e um concorrente real lidera cada ponto. */
function mockSerper(): void {
  process.env.SERPER_API_KEY = 'chave-de-teste-serper-1234';
  globalThis.fetch = async (input) => {
    const url = String(input);
    externalCalls.push(url);
    if (!url.startsWith('https://google.serper.dev/maps')) throw new Error(`Chamada externa inesperada: ${url}`);
    return new Response(
      JSON.stringify({
        places: [
          { position: 1, placeId: 'ChIJ_CONCORRENTE', title: 'Concorrente Teste', type: LEAD.primaryCategory, rating: 4.7, ratingCount: 210, website: 'https://exemplo.invalid' },
          { position: 5, placeId: LEAD.placeId, cid: LEAD.cid, title: LEAD.businessName },
        ],
      }),
      { status: 200 }
    );
  };
}

const publicAudits = path.join(process.cwd(), 'public', 'audits');
const listPublic = async (): Promise<string[]> => (await fs.readdir(publicAudits).catch(() => [])).sort();

test('Maestro: pipeline completo com a Fase 4, sem rede, sem Supabase e sem tocar em public/audits', async () => {
  mockSerper();
  const before = await listPublic();
  const progress: number[] = [];
  const auditId = '00000000-0000-4000-8000-0000000000c1';

  const dossier = await maestroOrchestrator.runAuditPipeline(payload(auditId), async (percent) => {
    progress.push(percent);
  });

  assert.equal(dossier.status, 'COMPLETED');
  assert.deepEqual(progress, [15, 55, 72, 92, 100]);
  // Única chamada externa: as 49 buscas do Serper Maps
  assert.equal(externalCalls.length, 49);
  assert.ok(externalCalls.every((url) => url.startsWith('https://google.serper.dev/maps')));

  // Ficha do Juiz com evidência e pontuação da Fase 4, sem simulação
  assert.equal(dossier.judge.scoreMethod, 'PHASE4_SCORED_WEIGHT');
  assert.equal(dossier.judge.evidenceBundle?.schemaVersion, 1);
  assert.equal(dossier.judge.evidenceBundle?.demo, false);
  assert.ok(dossier.judge.evidenceBundle?.evidence.every((e) => e.status !== 'SIMULATED'));
  assert.equal(dossier.judge.checklist21Items.length, 21);
  assert.equal(dossier.judge.scoreSummary?.totalWeight, 102);
  assert.equal(dossier.reputation.interactionsLast30Days, null);
  assert.equal(dossier.vitrine.totalPhotosCount, null);
  assert.equal(dossier.battlefield.dataOrigin, 'COLLECTED');
  assert.equal(dossier.battlefield.validPointsCount, 49);

  // Estrategista e Revisor continuam fechando o ciclo
  assert.equal(dossier.reviewerLogs.at(-1)?.approved, true, JSON.stringify(dossier.reviewerLogs.at(-1)?.discrepancies));
  assert.ok(dossier.strategist.tacticalWaves.every((w) => w.actions.every((a) => a.classification)));

  // PDF gravado só na pasta de teste; nada novo em public/audits
  assert.ok(dossier.diagrammer.pageCount >= 8);
  assert.equal(dossier.diagrammer.pdfStoragePath.startsWith(outputDir), true);
  const pdf = await fs.readFile(dossier.diagrammer.pdfStoragePath);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual(await listPublic(), before, 'public/audits não pode mudar');
  assert.ok((dossier.diagrammer.evidenceCoverage?.totalCriteria ?? 0) === 21);
});

test('Maestro: o estado persistido volta íntegro (ida e volta JSON) e alimenta o relatório sem recoletar', async () => {
  mockSerper();
  const auditId = '00000000-0000-4000-8000-0000000000c2';
  const dossier = await maestroOrchestrator.runAuditPipeline(payload(auditId));
  externalCalls = [];

  const state = (await gmnRepository.getAuditState(auditId)) as Record<string, unknown>;
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.progressPercent, 100);
  // Simula o que o Supabase faz com as colunas JSONB
  const fromDatabase = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  const result = reportSourceFromAuditState(fromDatabase, LEAD);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.source.judge.scoreSummary?.recalculatedScore, dossier.judge.scoreSummary?.recalculatedScore);
    assert.deepEqual(result.source.judge.evidenceBundle, dossier.judge.evidenceBundle);
    const model = buildReportModel({ source: result.source, generatedAt: '2026-10-16T12:00:00.000Z', regenerated: true });
    assert.equal(model.meta.testFixture, false);
    assert.equal(model.coverage.totalCriteria, 21);
    assert.deepEqual(model.judge.scoreLines.map((l) => l.key), ['RECALCULATED', 'VERIFIED_PERFORMANCE']);
    assert.ok(model.quality.every((c) => c.passed), model.quality.filter((c) => !c.passed).map((c) => c.id).join(','));
  }
  assert.equal(externalCalls.length, 0, 'ler e gerar o relatório não faz nenhuma consulta externa');
});

test('Maestro: reprocessar o mesmo auditId regrava o mesmo estado, sem duplicar nem alterar a identidade', async () => {
  mockSerper();
  const auditId = '00000000-0000-4000-8000-0000000000c3';
  const first = await maestroOrchestrator.runAuditPipeline(payload(auditId));
  const second = await maestroOrchestrator.runAuditPipeline(payload(auditId));
  assert.equal(second.auditId, first.auditId);
  const state = (await gmnRepository.getAuditState(auditId)) as Record<string, unknown>;
  assert.equal(state.auditId, auditId);
  assert.equal(state.status, 'COMPLETED');
});

test('Maestro: dado simulado fora do modo demonstração interrompe a auditoria (fail-closed)', async () => {
  mockSerper();
  const originalAnalyze = vitrineAgent.analyze.bind(vitrineAgent);
  vitrineAgent.analyze = async (lead) => legacyVitrine(lead);
  try {
    const auditId = '00000000-0000-4000-8000-0000000000c4';
    await assert.rejects(() => maestroOrchestrator.runAuditPipeline(payload(auditId)), /Dados simulados detectados fora do modo demonstração \(vitrine/);
    const state = (await gmnRepository.getAuditState(auditId)) as Record<string, unknown>;
    assert.equal(state.status, 'FAILED');
    assert.match(String(state.errorMessage), /nenhum dado simulado entre como evidência real/);
    assert.equal(state.judge, undefined, 'o Juiz nem chegou a rodar');
    assert.deepEqual(await fs.readdir(outputDir), [], 'nenhum PDF foi gerado');
  } finally {
    vitrineAgent.analyze = originalAnalyze;
  }
});

test('guarda: detecta simulação nas três coleções e libera somente com GMN_DEMO_MODE=true', async () => {
  const data = await buildReportFixture({ dataStyle: 'simulated' });
  const params = { placeId: data.lead.placeId, reputation: legacyReputation(data.lead), vitrine: legacyVitrine(data.lead), battlefield: data.battlefield };
  assert.deepEqual(findSimulatedCollections(params), ['reputação (avaliações)', 'vitrine (mídias e publicações)']);
  assert.throws(() => assertNoSimulatedDataOutsideDemo(params, {}), /Dados simulados detectados/);
  assert.doesNotThrow(() => assertNoSimulatedDataOutsideDemo(params, { GMN_DEMO_MODE: 'true' }));
  const demoBattlefield = { ...data.battlefield, dataOrigin: 'SIMULATED' as const };
  assert.deepEqual(findSimulatedCollections({ ...params, reputation: { ...data.reputation, recentReviewsSample: [] }, vitrine: { ...data.vitrine, mediaGallerySample: [] }, battlefield: demoBattlefield }), ['campo de batalha (posições e líderes)']);
  // Coleta real (Fase 4) não aciona a guarda
  const real = await buildReportFixture({ dataStyle: 'phase4' });
  assert.deepEqual(findSimulatedCollections({ placeId: real.lead.placeId, reputation: real.reputation, vitrine: real.vitrine, battlefield: real.battlefield }), []);
});

test('Maestro em modo demonstração: roda sem Serper, tudo identificado como simulado e o PDF leva o aviso', async () => {
  process.env.GMN_DEMO_MODE = 'true';
  const auditId = '00000000-0000-4000-8000-0000000000c5';
  globalThis.fetch = async (input) => {
    throw new Error(`Chamada externa inesperada em demonstração: ${String(input)}`);
  };
  const dossier = await maestroOrchestrator.runAuditPipeline(payload(auditId));
  assert.equal(dossier.battlefield.dataOrigin, 'SIMULATED');
  assert.equal(dossier.judge.evidenceBundle?.demo, true);
  assert.ok(dossier.judge.evidenceBundle?.evidence.every((e) => e.status !== 'SIMULATED'));
  assert.equal(dossier.status, 'COMPLETED');
  const state = (await gmnRepository.getAuditState(auditId)) as Record<string, unknown>;
  const result = reportSourceFromAuditState(JSON.parse(JSON.stringify(state)) as Record<string, unknown>, LEAD);
  assert.ok(result.ok);
  if (result.ok) {
    const model = buildReportModel({ source: result.source, generatedAt: '2026-10-16T12:00:00.000Z' });
    assert.equal(model.meta.demo, true);
    assert.equal(model.meta.testFixture, false);
  }
});

test('Maestro: retomada reaproveita Reputação, Vitrine e os 49 pontos persistidos, sem nova consulta ao Serper', async () => {
  mockSerper();
  const auditId = '00000000-0000-4000-8000-0000000000d1';
  const first = await maestroOrchestrator.runAuditPipeline(payload(auditId));
  assert.equal(externalCalls.length, 49);

  // Simula uma auditoria que parou depois da coleta: payloads gravados, mas estado "em andamento".
  await gmnRepository.updateAuditProgress(auditId, 'RUNNING_STRATEGIST', 72, 'STRATEGIST');
  externalCalls = [];
  const resumed = await maestroOrchestrator.runAuditPipeline({ ...payload(auditId), resume: true });

  assert.equal(externalCalls.length, 0, 'a retomada não pode repetir as 49 consultas pagas');
  assert.equal(resumed.battlefield.roundId, first.battlefield.roundId);
  assert.equal(resumed.battlefield.points.length, 49);
  assert.equal(resumed.status, 'COMPLETED');
});

test('Maestro: sem retomada explícita, a coleta é refeita normalmente (49 consultas)', async () => {
  mockSerper();
  await maestroOrchestrator.runAuditPipeline(payload('00000000-0000-4000-8000-0000000000d2'));
  assert.equal(externalCalls.length, 49);
});

test('PDF: se o arquivo sumir, é recomposto dos resultados persistidos, sem consultas externas e sem gravar nada', async () => {
  mockSerper();
  const auditId = '00000000-0000-4000-8000-0000000000d3';
  await maestroOrchestrator.runAuditPipeline(payload(auditId));
  externalCalls = [];

  const { regeneratePdfFromDatabase } = await import('../src/lib/pdf/regenerate');
  const original = { getAuditForReport: gmnRepository.getAuditForReport, getLeadById: gmnRepository.getLeadById, getCampaignSummary: gmnRepository.getCampaignSummary };
  const filesBefore = (await fs.readdir(outputDir)).sort();
  gmnRepository.getAuditForReport = async (id: string) => ({ state: (await gmnRepository.getAuditState(id)) as Record<string, unknown>, leadId: LEAD.id, createdAt: null, completedAt: null });
  gmnRepository.getLeadById = async () => LEAD;
  gmnRepository.getCampaignSummary = async () => null;
  try {
    const result = await regeneratePdfFromDatabase(auditId);
    assert.ok(result);
    assert.equal(result.body.subarray(0, 5).toString(), '%PDF-');
    assert.equal(result.headers['X-GMN-PDF-Regenerated'], 'true');
    assert.match(result.headers['Content-Disposition'] ?? '', /regenerado\.pdf"/);
    assert.equal(externalCalls.length, 0, 'recompor o PDF não pode consultar nada externo');
    assert.deepEqual((await fs.readdir(outputDir)).sort(), filesBefore, 'nada novo é gravado em disco');
  } finally {
    Object.assign(gmnRepository, original);
  }
});
