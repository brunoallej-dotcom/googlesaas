import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/stub-lucide';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { EvidenceCoverage } from '../src/components/dashboard/evidence-coverage';
import { TerritorySummary } from '../src/components/dashboard/territory-summary';
import { AuditPanel } from '../src/components/dashboard/audit-panel';
import type { AuditJobTracker } from '../src/components/dashboard/types';
import { toBattlefieldMapModel } from '../src/lib/battlefield-map-adapter';
import { buildReportFixture } from '../src/dev/report-fixture';

async function tracker(style: 'simulated' | 'phase4' | 'phase4-live') {
  const data = await buildReportFixture({ dataStyle: style });
  const value: AuditJobTracker = {
    auditId: data.auditId, leadId: data.lead.id, status: 'COMPLETED', progressPercent: 100, currentAgent: 'MAESTRO',
    reputation: data.reputation, vitrine: data.vitrine, battlefield: data.battlefield, rivals: data.rivals, judge: data.judge, strategist: data.strategist,
  };
  return { data, tracker: value, model: toBattlefieldMapModel({ battlefield: data.battlefield, lead: data.lead }) };
}

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('dashboard: cobertura de evidências mostra verificados, parciais, não verificados e simulados com pesos', async () => {
  const { data, tracker: t } = await tracker('phase4');
  const html = renderToStaticMarkup(createElement(EvidenceCoverage, { tracker: t, lead: data.lead }));
  const content = text(html);
  assert.match(content, /Cobertura de evidências/);
  assert.match(content, /6 de 21 critérios · 31,4% do peso/);
  for (const label of ['Verificados', 'Parcialmente verificados', 'Não verificados', 'Simulados']) assert.match(content, new RegExp(label));
  assert.match(content, /Desempenho nos critérios verificados/);
  assert.match(content, /Última coleta territorial/);
  assert.match(content, /dependem de informação pendente de validação/);
  assert.match(html, /role="img"/);
});

test('dashboard: nativa da Fase 4 mostra "Pontuação do Juiz (Fase 4)", nunca "Score Juiz histórico"; índice de posição identificado', async () => {
  const { data, tracker: t, model } = await tracker('phase4');
  const html = renderToStaticMarkup(createElement(TerritorySummary, { campaign: null, lead: data.lead, tracker: t, model }));
  const content = text(html);
  assert.match(content, /Pontuação do Juiz \(Fase 4\)/);
  assert.doesNotMatch(content, /Score Juiz histórico/i);
  assert.match(html, /Não é comparável ao Score Juiz histórico das auditorias anteriores/, 'a explicação fica no título (tooltip) do cartão');
  assert.match(content, /6 de 21 critérios verificados · 31% do peso|6 de 21 critérios verificados · 31,4% do peso/);
  assert.match(content, /Índice de posição/i);
  assert.match(content, /média no Top 20/);
  assert.doesNotMatch(content, /Posição Média/i);
  assert.doesNotMatch(content, /score global/i);
  const coverage = text(renderToStaticMarkup(createElement(EvidenceCoverage, { tracker: t, lead: data.lead })));
  assert.match(coverage, /Pontuação recalculada \(denominador: \d+(,\d)?% do peso\)/);
  assert.doesNotMatch(coverage, /Score Juiz histórico armazenado/);
});

test('dashboard: auditoria anterior à Fase 4 mostra o Score Juiz histórico ARMAZENADO e a cobertura (reavaliação conservadora, sem alterar o gravado)', async () => {
  const { data, tracker: t, model } = await tracker('simulated');
  const summaryHtml = text(renderToStaticMarkup(createElement(TerritorySummary, { campaign: null, lead: data.lead, tracker: t, model })));
  assert.match(summaryHtml, /Score Juiz histórico/);
  assert.doesNotMatch(summaryHtml, /Pontuação do Juiz \(Fase 4\)/);
  const content = text(renderToStaticMarkup(createElement(EvidenceCoverage, { tracker: t, lead: data.lead })));
  assert.match(content, /5 de 21 critérios · 25,5% do peso/);
  assert.match(content, /Simulados\s*6/);
  assert.match(content, /Score Juiz histórico armazenado \(21 critérios, denominador 102\)/);
  assert.match(content, new RegExp(`${String(data.judge.overallScore).replace('.', ',')}%`));
  const panel = text(renderToStaticMarkup(createElement(AuditPanel, { tracker: t, lead: data.lead, onRetry: () => undefined, onResume: () => undefined })));
  assert.match(panel, /Score Juiz histórico \(armazenado, 21 itens\)/);
  assert.match(panel, new RegExp(`${data.judge.overallScore}%`));
});

test('dashboard: com fontes de teste a cobertura sobe e o painel não quebra com categorias sem pontuação', async () => {
  const { data, tracker: t } = await tracker('phase4');
  const nullCategory = { ...t, judge: t.judge && { ...t.judge, categoryScores: t.judge.categoryScores.map((c, i) => (i === 3 ? { ...c, scorePercent: null } : c)) } };
  const panel = text(renderToStaticMarkup(createElement(AuditPanel, { tracker: nullCategory, lead: data.lead, onRetry: () => undefined, onResume: () => undefined })));
  assert.match(panel, /sem pontuação/);
  const live = await tracker('phase4-live');
  const content = text(renderToStaticMarkup(createElement(EvidenceCoverage, { tracker: live.tracker, lead: live.data.lead })));
  assert.match(content, /12 de 21 critérios · 57,8% do peso/);
});

test('dashboard: falhas de coleta registradas aparecem como aviso, sem esconder os dados válidos', async () => {
  const { data, tracker: t } = await tracker('phase4');
  const judge = t.judge && { ...t.judge, evidenceBundle: { schemaVersion: 1, evidence: [], demo: false, providerFailures: [{ provider: 'Serper.dev (Google Maps)', operation: 'x', reason: 'HTTP 500', at: '2026-10-16T00:00:00.000Z' }] } };
  const content = text(renderToStaticMarkup(createElement(EvidenceCoverage, { tracker: { ...t, judge }, lead: data.lead })));
  assert.match(content, /1 falha de coleta registrada/);
  assert.match(content, /dados válidos foram preservados/);
});

test('dashboard: sem auditoria não renderiza o bloco de cobertura', async () => {
  const { data, tracker: t } = await tracker('phase4');
  assert.equal(renderToStaticMarkup(createElement(EvidenceCoverage, { tracker: { ...t, judge: undefined }, lead: data.lead })), '');
});
