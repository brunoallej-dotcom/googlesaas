import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/stub-lucide';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { AuditPanel } from '../src/components/dashboard/audit-panel';
import { TopFilters } from '../src/components/dashboard/top-filters';
import type { AuditJobTracker } from '../src/components/dashboard/types';
import { buildReportFixtureLead } from '../src/dev/report-fixture';
import { gmnRepository } from '../src/lib/supabase';
import { configurationPresence, overallStatus } from '../src/lib/system-health';
import type { ProspectingOutput } from '../src/types/gmn';

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const LEAD = buildReportFixtureLead();
const base: AuditJobTracker = { auditId: 'a1', leadId: LEAD.id, status: 'RUNNING_EXTRACTION', progressPercent: 15, currentAgent: 'BATTLEFIELD' };
const render = (tracker: AuditJobTracker): string =>
  text(renderToStaticMarkup(createElement(AuditPanel, { tracker, lead: LEAD, onRetry: () => undefined, onResume: () => undefined })));

test('UI: estados Aguardando, Em execução, Concluída e Falhou usam os rótulos do servidor', () => {
  assert.match(render({ ...base, status: 'QUEUED', phase: 'WAITING' }), /Status: Aguardando/);
  assert.match(render({ ...base, phase: 'RUNNING' }), /Status: Em execução/);
  assert.match(render({ ...base, status: 'COMPLETED', progressPercent: 100, phase: 'COMPLETED' }), /Status: Concluída/);
  assert.doesNotMatch(render({ ...base, status: 'FAILED', phase: 'FAILED', errorMessage: 'Invalid URL', resumable: false }), /Retomar/);
  const failed = render({ ...base, status: 'FAILED', phase: 'FAILED', errorMessage: 'Falha X', resumable: true });
  assert.match(failed, /A auditoria falhou/);
  assert.match(failed, /Falha X/);
  assert.match(failed, /Retomar \(reaproveita dados já gravados\)/);
});

test('UI: Interrompida mostra o motivo, orienta o Worker e explica que a retomada não repete consultas pagas', () => {
  const html = render({ ...base, phase: 'INTERRUPTED', phaseReason: 'O Worker de auditorias não está ativo.', workerAlive: false, resumable: true });
  const withoutData = render({ ...base, phase: 'INTERRUPTED', resumable: false });
  assert.doesNotMatch(withoutData, /Retomar auditoria/);
  assert.match(withoutData, /não há o que retomar/);
  assert.match(withoutData, /49 consultas/);
  assert.match(html, /Status: Interrompida/);
  assert.match(html, /Auditoria interrompida/);
  assert.match(html, /O Worker de auditorias não está ativo/);
  assert.match(html, /npm run worker/);
  assert.match(html, /não repete as consultas pagas já feitas/);
  assert.match(html, /Retomar auditoria/);
});

test('UI: resultado salvo é identificado como histórico recuperado, com a data original da coleta', () => {
  const html = render({ ...base, status: 'COMPLETED', progressPercent: 100, phase: 'COMPLETED', recovered: true, createdAt: '2026-09-01T12:00:00Z' });
  assert.match(html, /Status: Resultado histórico recuperado/);
  assert.match(html, /Nenhuma consulta foi feita agora/);
  assert.match(html, /coletada em/);
});

test('UI: seletor de campanhas salvas só aparece com campanhas e deixa claro que não tem custo', () => {
  const props = { city: 'A', stateCode: 'GO', nicheKeyword: 'x', isProspecting: false, onCityChange: () => undefined, onStateCodeChange: () => undefined, onNicheKeywordChange: () => undefined, onSubmit: () => undefined };
  assert.doesNotMatch(text(renderToStaticMarkup(createElement(TopFilters, props))), /Campanhas salvas/);
  const html = text(renderToStaticMarkup(createElement(TopFilters, {
    ...props,
    savedCampaigns: [{ id: 'c1', city: 'Anápolis', stateCode: 'GO', nicheKeyword: 'Dentista', totalCaptured: 10, createdAt: '2026-09-01T12:00:00Z' }],
    onOpenSavedCampaign: () => undefined,
  })));
  assert.match(html, /Campanhas salvas/);
  assert.match(html, /sem custo/);
  assert.match(html, /Anápolis\/GO · Dentista/);
});

test('persistência: campanha salva é listada e reaberta com os mesmos 10 leads, sem consulta externa', async () => {
  const leads = Array.from({ length: 10 }, (_, i) =>
    buildReportFixtureLead({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, placeId: `ChIJ_P5_${i}`, campaignId: '00000000-0000-4000-8000-0000000000aa', frontierRank: 11 + i })
  );
  const output: ProspectingOutput = {
    campaignId: '00000000-0000-4000-8000-0000000000aa', city: 'Anápolis', stateCode: 'GO', nicheKeyword: 'Dentista',
    centerCoordinates: { latitude: -16.32, longitude: -48.95 }, leads, executedAt: '2026-09-01T12:00:00.000Z',
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('nenhuma chamada externa é permitida'); }) as typeof fetch;
  const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    await gmnRepository.saveProspectingCampaign(output);
    const list = await gmnRepository.listRecentCampaigns();
    assert.ok(list.some((c) => c.id === output.campaignId && c.totalCaptured === 10));
    const reopened = await gmnRepository.getCampaignWithLeads(output.campaignId);
    assert.deepEqual(reopened?.leads.map((l) => l.placeId), leads.map((l) => l.placeId));
    assert.equal(reopened?.executedAt, output.executedAt);
    assert.equal(await gmnRepository.getCampaignWithLeads('00000000-0000-4000-8000-0000000000ab'), null);
  } finally {
    globalThis.fetch = previousFetch;
    if (savedUrl !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  }
});

test('saúde: presença de configuração nunca expõe valores e o estado geral considera o pior componente', () => {
  const env = { SERPER_API_KEY: 'segredo-serper-123456', SUPABASE_SERVICE_ROLE_KEY: 'segredo-service', NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', REDIS_URL: 'rediss://u:senha@h' };
  const presence = configurationPresence(env);
  assert.equal(presence.serper, true);
  assert.equal(presence.supabase, true);
  assert.equal(presence.operatorAllowlist, false);
  assert.doesNotMatch(JSON.stringify(presence), /segredo|senha|supabase\.co/);
  assert.equal(overallStatus(['OK', 'OK', 'OK']), 'OK');
  assert.equal(overallStatus(['OK', 'DOWN', 'OK']), 'DOWN');
  assert.equal(overallStatus(['OK', 'UNKNOWN', 'OK']), 'DEGRADED');
});
