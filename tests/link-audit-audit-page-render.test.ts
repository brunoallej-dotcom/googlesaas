import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import './helpers/stub-lucide';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompanyPanel } from '../src/components/link-audit/audit-page/company-panel';
import { CriteriaMatrix } from '../src/components/link-audit/audit-page/criteria-matrix';
import { DecisionsPanel, type DecisionsPanelProps } from '../src/components/link-audit/audit-page/decisions-panel';
import { FinalizationPanel } from '../src/components/link-audit/audit-page/finalization-panel';
import { INCONCLUSIVE_HEADLINE } from '../src/components/link-audit/audit-page/labels';
import { ResultPanel } from '../src/components/link-audit/audit-page/result-panel';
import { ResultsPanel } from '../src/components/link-audit/audit-page/results-panel';
import { BlockersPanel, MissingPanel, TraceabilityPanel } from '../src/components/link-audit/audit-page/side-panels';
import { CLOSED_FORM, CLOSED_REVOKE, initialPageState, pageReducer, type PageState } from '../src/components/link-audit/audit-page/state';
import { deriveHeadline, deriveRegistry } from '../src/components/link-audit/audit-page/status';
import { StatusStrip } from '../src/components/link-audit/audit-page/status-strip';
import { SectionStatus } from '../src/components/link-audit/audit-page/ui-bits';
import { AuditDetailScreen } from '../src/components/link-audit/audit-page/audit-detail-screen';
import AuditPage from '../src/app/auditoria-por-link/[auditId]/page';
import { AUDIT, decisionDto, decisionsFixture, detailResponse, head, pendingRun, previewFixture, resultsFixture, runDetail, runSummary, scoredPreview } from './helpers/link-audit-audit-page-fixtures';

/* Onda 6C, I5 — renderização estática (sem navegador): textos honestos, estados, acessibilidade e saneamento. */
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const render = (element: React.ReactElement): string => renderToStaticMarkup(element);
const noop = (): void => undefined;

function stateWith(over: { preview?: ReturnType<typeof previewFixture>; decisions?: ReturnType<typeof decisionsFixture>; results?: ReturnType<typeof resultsFixture> } = {}): PageState {
  let s = initialPageState(AUDIT);
  s = pageReducer(s, { type: 'SECTION_OK', section: 'preview', data: over.preview ?? previewFixture() });
  s = pageReducer(s, { type: 'SECTION_OK', section: 'decisions', data: over.decisions ?? decisionsFixture() });
  return pageReducer(s, { type: 'SECTION_OK', section: 'results', data: over.results ?? resultsFixture() });
}

/* ------------------------------------------------------------------------------------------------ resultado */
test('INCONCLUSIVO: frase aprovada, cobertura × mínimo e NENHUM número de nota, selo, classificação ou cor de sucesso', () => {
  const html = render(createElement(ResultPanel, { outcome: previewFixture().outcomePreview, result: previewFixture().result, criteria: previewFixture().criteria }));
  const t = text(html);
  assert.ok(t.includes(INCONCLUSIVE_HEADLINE));
  assert.match(t, /Cobertura verificada 11% · mínimo exigido 40%/);
  assert.match(html, /role="img" aria-label="Cobertura verificada 11 por cento de um mínimo de 40 por cento"/);
  const rest = t.replace(INCONCLUSIVE_HEADLINE, '');
  assert.ok(!/índice|selo|pontos obtidos|\/100|classificação|nota geral|Publicável|Provisório/i.test(rest), rest);
  assert.ok(!/gmn-success|text-green|bg-green/.test(html), 'sem cores de sucesso');
  assert.match(html, /border-dashed/);
});

test('PONTUADO sem índice na API cai no registro técnico (falha segura); com índice, mostra exatamente os campos da API e não recalcula', () => {
  const noIndex = { ...scoredPreview(), result: { ...scoredPreview().result, index: null } };
  const t0 = text(render(createElement(ResultPanel, { outcome: noIndex.outcomePreview, result: noIndex.result, criteria: noIndex.criteria })));
  assert.ok(t0.includes(INCONCLUSIVE_HEADLINE));
  const scored = scoredPreview();
  const html = render(createElement(ResultPanel, { outcome: scored.outcomePreview, result: scored.result, criteria: scored.criteria }));
  const t = text(html);
  assert.match(t, /Prévia pontuada \(ainda não registrada\)/);
  assert.match(t, /PROVISÓRIO/);
  assert.match(t, /71\.50/);
  assert.match(t, /Em desenvolvimento/);
  assert.match(t, /Média/);
  assert.match(t, /a página não recalcula índice nem pontos/);
  // as linhas por critério são o campo da API convertido de meio-ponto em ponto (5 = 10 meios-pontos), sem somar nada
  assert.match(t, /Dados essenciais e consistência NAP 5 de 15/);
  assert.ok(!t.includes('72'), 'o inteiro "shown" do índice não é exibido no lugar do valor com duas casas');
  const record = text(render(createElement(ResultPanel, { outcome: scored.outcomePreview, result: scored.result, criteria: [], context: 'record' })));
  assert.match(record, /Resultado pontuado confirmado/);
  assert.equal(text(render(createElement(ResultPanel, { outcome: null, result: null, criteria: [] }))).includes('Nada foi calculado'), true);
});

/* ------------------------------------------------------------------------------------------------ matriz */
test('matriz: tabela acessível no desktop + cartões no celular; ação só para C2/S4 disponíveis; "Não verificado" explicado; pontos só se a API os entrega', () => {
  const props = { preview: previewFixture(), canAct: true, onRegister: noop };
  const html = render(createElement(CriteriaMatrix, props));
  assert.match(html, /<caption class="sr-only">Subcritérios de Dados essenciais e consistência NAP<\/caption>/);
  assert.match(html, /<th scope="col"/);
  assert.match(html, /<th scope="row"/);
  assert.match(html, /class="space-y-2 px-3 pb-3 md:hidden"/);
  assert.match(html, /hidden overflow-x-auto px-4 pb-3 md:block/);
  const t = text(html);
  assert.match(t, /“Não verificado” não é zero/);
  assert.match(t, /Automático/);
  assert.match(t, /Bloqueado/);
  assert.match(t, /Decisão humana/);
  assert.match(t, /Aguardando decisão do operador/);
  assert.match(t, /potencial de cobertura: \+3 pts \(não comprovado\)/);
  assert.ok(!/<th scope="col" class="py-1.5 pr-3 font-medium">Pontos/.test(html), 'sem coluna de pontos numa prévia inconclusiva');
  assert.equal((html.match(/Registrar decisão para C2/g) ?? []).length, 2, 'tabela + cartão');
  assert.ok(!/Registrar decisão para N1/.test(html));
  const disabled = render(createElement(CriteriaMatrix, { ...props, canAct: false }));
  assert.match(disabled, /disabled=""[^>]*aria-label="Registrar decisão para C2/);
  const scored = render(createElement(CriteriaMatrix, { ...props, preview: scoredPreview() }));
  assert.match(scored, /Pontos<\/th>/);
  assert.match(text(scored), /2 de 3/);
  const unavailable = render(createElement(CriteriaMatrix, { ...props, preview: previewFixture({ decisionOptions: [{ type: 'JUDGEMENT', subcriterionId: 'C2', code: null, available: false, reasonCode: 'BASIS_MISSING' }] }) }));
  assert.match(text(unavailable), /Decisão indisponível/);
  assert.ok(!/Registrar decisão para C2/.test(unavailable));
});

/* ------------------------------------------------------------------------------------------------ decisões */
function decisionsProps(over: Partial<DecisionsPanelProps> = {}): DecisionsPanelProps {
  return {
    decisions: decisionsFixture(), preview: previewFixture(), form: CLOSED_FORM, revoke: CLOSED_REVOKE, canWrite: true,
    onOpenForm: noop, onCloseForm: noop, onFormField: noop, onSubmitForm: noop, onResendForm: noop, onOpenRevoke: noop, onCloseRevoke: noop, onRevokeField: noop, onSubmitRevoke: noop, onResendRevoke: noop, onResendListed: noop, ...over,
  };
}
test('decisões: vazio honesto; vigente com autor/data, justificativa recolhida como TEXTO; retida explicada; só os tipos aprovados são oferecidos', () => {
  const empty = text(render(createElement(DecisionsPanel, decisionsProps())));
  assert.match(empty, /Nenhuma decisão humana vigente/);
  assert.match(empty, /Juízo sobre a categoria principal \(C2\)/);
  assert.match(empty, /Marcar S4 como não aplicável/);
  assert.ok(!/SITE_SCOPE|IMAGES_CONFIRMATION|NAME_EQUIVALENCE/.test(empty), 'tipos fora do contrato aprovado não são oferecidos');
  const dto = decisionDto({ record: { kind: 'JUDGEMENT', subcriterionId: 'C2', value: 'COMPATIBLE', justification: '<img src=x onerror=alert(1)> conferido‮' }, recordedBy: '<b>ana</b>@empresa.com' });
  const html = render(createElement(DecisionsPanel, decisionsProps({
    decisions: decisionsFixture({ head: head(1), decisions: [dto], allDecisions: [dto], history: [{ seq: 1, action: 'RECORD', decisionId: 'op-0001', revokes: null, reason: null, recordedAt: dto.recordedAt, recordedBy: dto.recordedBy }] }),
    preview: previewFixture({ decisions: { head: head(1), count: 1, pending: null, finalizable: true, applied: [], held: [{ decisionId: 'op-0001', code: 'DECISION_CATEGORY_MISMATCH' }] } }),
  })));
  assert.ok(!/<img|<b>|onerror=alert/.test(html.replace(/&lt;[^&]*&gt;/g, '')), 'nada vindo dos dados vira tag');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!/‮/.test(html));
  assert.match(text(html), /Retida: registrada antes da captura atual da categoria/);
  assert.match(html, /<summary[^>]*>Justificativa do operador<\/summary>/);
  assert.match(html, /aria-label="Revogar a decisão op-0001"/);
});

test('decisões: pendente em alerta (não vale, só o autor), formulário com rótulos e erros ligados; rascunho em conflito avisa que foi mantido', () => {
  const pending = decisionsFixture({ pending: { confirmed: false, seq: 2, action: 'REVOKE', decisionId: null, revokes: 'op-0001', supersedes: null, reason: 'motivo', record: null, recordedAt: '2026-10-30T10:00:00.000Z', recordedBy: 'ana@empresa.com' } });
  const p = render(createElement(DecisionsPanel, decisionsProps({ decisions: pending })));
  assert.match(p, /role="alert"/);
  assert.match(text(p), /SEM recibo: ela ainda não vale/);
  assert.match(text(p), /a decisão revogada ainda aparece como vigente/);
  assert.match(text(p), /Somente o autor pode concluí-la/);
  assert.match(p, /Reenviar o mesmo pedido/);
  const form = { ...CLOSED_FORM, optionKey: 'C2' as const, phase: 'conflict' as const, value: 'PARTIAL', justification: 'Rascunho que deve ser mantido para revisão.', message: 'O histórico mudou.', fieldErrors: ['A justificativa exige pelo menos 20 caracteres.'] };
  const f = render(createElement(DecisionsPanel, decisionsProps({ form })));
  assert.match(f, /<label for="decisao-valor"/);
  assert.match(f, /<label for="decisao-justificativa"/);
  assert.match(f, /id="decisao-justificativa"[^>]*aria-describedby="decisao-erros"/);
  assert.match(f, /<ul id="decisao-erros" role="alert"/);
  assert.match(text(f), /Seu rascunho foi mantido/);
  assert.match(f, /Rascunho que deve ser mantido para revisão\./);
  const resend = render(createElement(DecisionsPanel, decisionsProps({ form: { ...form, phase: 'pending', message: 'Gravada, sem recibo.' } })));
  assert.match(resend, /Reenviar o mesmo pedido/);
  assert.ok(!/Registrar decisão<\/button>/.test(resend.split('Cancelar')[0] ?? ''), 'pendente: só o reenvio exato');
  const busy = render(createElement(DecisionsPanel, decisionsProps({ form: { ...form, phase: 'submitting', message: null, fieldErrors: [] } })));
  assert.match(busy, /disabled=""/);
  assert.match(text(busy), /Registrando…/);
});

/* ------------------------------------------------------------------------------------------------ finalização */
function finalizationHtml(state: PageState): string {
  return render(createElement(FinalizationPanel, { state, onOpen: noop, onCancel: noop, onAck: noop, onConfirm: noop, onRetry: noop, onCompletePending: noop, onReloadPreview: noop }));
}
test('finalização: botão habilitado só com permissão da API; motivo do bloqueio sempre visível e ligado por aria-describedby', () => {
  const ok = finalizationHtml(stateWith());
  assert.doesNotMatch(ok, /<button[^>]*disabled=""[^>]*aria-describedby="finalizar-motivo"/);
  assert.match(text(ok), /A API declarou que esta prévia pode ser registrada/);
  assert.match(text(ok), /definitivo e imutável/);
  assert.match(text(ok), /o registro não terá nota/);
  const blocked = finalizationHtml(stateWith({ preview: previewFixture({ finalization: { allowed: false, expectedHead: null, expectedInputSha256: 'a'.repeat(64) } }) }));
  assert.match(blocked, /<button[^>]*disabled=""[^>]*aria-describedby="finalizar-motivo"/);
  assert.match(text(blocked), /A API não permite finalizar/);
  assert.match(blocked, /id="finalizar-motivo"/);
});

test('finalização: confirmação explícita (caixa de aceite), pedido da prévia exibida, sucesso só depois; pendência e conflito nunca parecem sucesso', () => {
  const request = { expectedHead: head(3, 'c'), expectedInputSha256: 'd'.repeat(64) };
  const confirming = finalizationHtml(pageReducer(stateWith(), { type: 'FINALIZE_SET', flow: { phase: 'confirming', request, outcome: 'INCONCLUSIVO', acknowledged: false } }));
  assert.match(confirming, /<dialog[^>]*aria-labelledby="confirmar-titulo"[^>]*aria-describedby="confirmar-descricao"/);
  const t = text(confirming);
  assert.ok(t.includes(INCONCLUSIVE_HEADLINE));
  assert.match(t, /Este registro não terá nota/);
  assert.match(t, /#3/);
  assert.match(t, /dddddddd…dddd/);
  assert.match(confirming, /type="checkbox"/);
  assert.match(confirming, /<button[^>]*disabled=""[^>]*>Confirmar e registrar<\/button>/);
  const acked = finalizationHtml(pageReducer(stateWith(), { type: 'FINALIZE_SET', flow: { phase: 'confirming', request, outcome: 'INCONCLUSIVO', acknowledged: true } }));
  assert.doesNotMatch(acked, /<button[^>]*disabled=""[^>]*>Confirmar e registrar<\/button>/);

  const pendingFlow = text(finalizationHtml(pageReducer(stateWith(), { type: 'FINALIZE_SET', flow: { phase: 'anchor_pending', request, message: 'O recibo NÃO foi confirmado.' } })));
  assert.match(pendingFlow, /Confirmação NÃO concluída/);
  assert.match(pendingFlow, /O resultado ainda não vale/);
  assert.ok(!/Confirmado e verificado|gravado com recibo/.test(pendingFlow), 'pendência nunca usa linguagem de sucesso');
  const conflict = text(finalizationHtml(pageReducer(stateWith(), { type: 'FINALIZE_SET', flow: { phase: 'conflict', code: 'HEAD_MISMATCH', message: 'O histórico mudou.', blockers: [] } })));
  assert.match(conflict, /Nada foi gravado: a situação mudou/);
  assert.match(conflict, /prévia anterior foi invalidada/);
  const sending = text(finalizationHtml(pageReducer(stateWith(), { type: 'FINALIZE_SET', flow: { phase: 'submitting', request, recovery: false } })));
  assert.match(sending, /aguarde a confirmação do servidor/);
  const done = text(finalizationHtml(pageReducer(stateWith(), { type: 'FINALIZE_SET', flow: { phase: 'done', seq: 2, replayed: false, recovered: false, changedAfter: true, verified: true } })));
  assert.match(done, /Confirmado e verificado/);
  assert.match(done, /trate-o como histórico/);
  const unverified = text(finalizationHtml(pageReducer(stateWith(), { type: 'FINALIZE_SET', flow: { phase: 'done', seq: 2, replayed: false, recovered: false, changedAfter: false, verified: false } })));
  assert.match(unverified, /Confirmado — verificação pendente/);
});

test('finalização: pendente PRÓPRIA oferece concluir; de outro operador, não; e o botão de registrar não conta com ela', () => {
  const mine = stateWith({ results: resultsFixture({ pending: pendingRun({ seq: 4 }) }) });
  const html = finalizationHtml(mine);
  assert.match(text(html), /s0004 gravado e NÃO confirmado/);
  assert.match(html, /Concluir a confirmação/);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-describedby="finalizar-motivo"/);
  const other = finalizationHtml(stateWith({ results: resultsFixture({ pending: pendingRun({ isMine: false }) }) }));
  assert.ok(!/Concluir a confirmação/.test(other));
  assert.match(text(other), /Somente o autor pode concluí-lo/);
});

/* ------------------------------------------------------------------------------------------------ resultados e obsolescência */
test('resultados: confirmado × pendente × histórico × substituído são visualmente distintos; a pendente nunca entra na lista de resultados', () => {
  const list = resultsFixture({ results: [runSummary({ seq: 1, superseded: true, stale: null, decisionsChanged: null }), runSummary({ seq: 2, stale: true, decisionsChanged: false })], pending: pendingRun({ seq: 3 }) });
  const html = render(createElement(ResultsPanel, { results: list, detail: { seq: null, phase: 'idle', data: null, message: null }, changedAfter: null, onSelect: noop }));
  const t = text(html);
  assert.match(t, /s0002 · Inconclusivo · mais recente/);
  assert.match(t, /Histórico/);
  assert.match(t, /Entrada mudou \(stale\)/);
  assert.match(t, /Substituído/);
  assert.match(t, /Pendente — não vale/);
  assert.match(t, /s0003 · Inconclusivo/);
  assert.equal((html.match(/Ver detalhe verificado/g) ?? []).length, 2, 'só os 2 confirmados têm detalhe');
  const sep = html.indexOf('Pendente — não vale');
  assert.ok(sep < html.indexOf('s0002 ·'), 'a pendente aparece em bloco próprio, antes da lista');
  const current = text(render(createElement(ResultsPanel, { results: resultsFixture({ results: [runSummary()] }), detail: { seq: null, phase: 'idle', data: null, message: null }, changedAfter: null, onSelect: noop })));
  assert.ok(!/Histórico|stale|Decisões mudaram/.test(current));
  const after = text(render(createElement(ResultsPanel, { results: resultsFixture({ results: [runSummary()] }), detail: { seq: null, phase: 'idle', data: null, message: null }, changedAfter: true, onSelect: noop })));
  assert.match(after, /Histórico/);
  const decisions = text(render(createElement(ResultsPanel, { results: resultsFixture({ results: [runSummary({ decisionsChanged: true })] }), detail: { seq: null, phase: 'idle', data: null, message: null }, changedAfter: null, onSelect: noop })));
  assert.match(decisions, /Decisões mudaram/);
  const empty = text(render(createElement(ResultsPanel, { results: resultsFixture(), detail: { seq: null, phase: 'idle', data: null, message: null }, changedAfter: null, onSelect: noop })));
  assert.match(empty, /Nenhum resultado registrado/);
});

test('detalhe de um registro: aviso de histórico, registro técnico sem nota, hashes copiáveis; integridade e erro não mostram dados', () => {
  const list = resultsFixture({ results: [runSummary({ stale: true })] });
  const detail = { seq: 1, phase: 'ready' as const, data: detailResponse({ stale: true }), message: null };
  const html = render(createElement(ResultsPanel, { results: list, detail, changedAfter: null, onSelect: noop }));
  const t = text(html);
  assert.match(t, /Registro histórico/);
  assert.match(t, /pode não representar a situação atual/);
  assert.ok(t.includes(INCONCLUSIVE_HEADLINE));
  assert.match(t, /Registro técnico: guarda a constatação/);
  assert.match(html, /aria-label="Copiar hash do resultado completo"/);
  assert.match(html, /aria-expanded="true"/);
  const integrity = render(createElement(ResultsPanel, { results: list, detail: { seq: 1, phase: 'integrity', data: null, message: null }, changedAfter: null, onSelect: noop }));
  assert.match(text(integrity), /Falha de integridade: nenhum dado é exibido/);
  assert.ok(!/Registro técnico/.test(integrity));
  const scored = render(createElement(ResultsPanel, { results: resultsFixture({ results: [runSummary({ outcome: 'PONTUADO', level: 'PROVISORIO' })] }), detail: { seq: 1, phase: 'ready', data: detailResponse({ run: runDetail({ outcome: 'PONTUADO', level: 'PROVISORIO', inconclusive: null, result: { index: { decimal2: '80.25', classificationLabel: 'Forte' }, confidence: { levelLabel: 'Alta' }, totals: { coveragePercent: 70 }, publication: { gates: [] } } }) }), message: null }, changedAfter: null, onSelect: noop }));
  assert.match(text(scored), /Resultado pontuado confirmado/);
  assert.match(text(scored), /80\.25/);
});

/* ------------------------------------------------------------------------------------------------ faixa de estado e seções */
test('faixa de estado: região viva educada, cobertura legível por leitor de tela, selo "Histórico" com texto, aviso do fluxo', () => {
  const state = stateWith({ results: resultsFixture({ results: [runSummary({ decisionsChanged: true })] }) });
  const html = render(createElement(StatusStrip, { headline: deriveHeadline(state), registry: deriveRegistry(state, null), notice: { tone: 'warning', text: 'Aviso do fluxo.' } }));
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /md:sticky md:top-2/, 'fixa só a partir de md: no celular ela não cobre o conteúdo ao focar');
  assert.doesNotMatch(html, / sticky /);
  assert.match(html, /role="img" aria-label="Cobertura verificada 11 por cento; mínimo exigido 40 por cento"/);
  assert.match(text(html), /HISTÓRICO: pode não representar a situação atual/);
  assert.match(text(html), /Aviso do fluxo\./);
  assert.ok(text(html).includes(INCONCLUSIVE_HEADLINE));
});

test('seções: carregando (status), erro (alerta + tentar de novo), indisponível, acesso negado (sem tentar de novo) e integridade (SEM dados)', () => {
  const show = (phase: Parameters<typeof SectionStatus>[0]['phase'], message: string | null = 'Mensagem.', hasData = false) => render(createElement(SectionStatus, { phase, hasData, message, code: 'COD', onRetry: noop, what: 'a prévia' }));
  assert.match(show('loading'), /role="status"[^>]*aria-live="polite"/);
  assert.match(text(show('loading')), /Carregando a prévia…/);
  assert.match(text(show('loading', null, true)), /Atualizando a prévia…/);
  assert.match(show('error'), /role="alert"/);
  assert.match(text(show('error')), /Tentar novamente/);
  assert.match(text(show('unavailable')), /A prévia indisponível|Prévia indisponível|a prévia indisponível|indisponível/i);
  const denied = show('denied');
  assert.match(text(denied), /Acesso negado/);
  assert.ok(!/Tentar novamente/.test(denied));
  const integrity = show('integrity');
  assert.match(integrity, /role="alert"/);
  assert.match(text(integrity), /nenhum dado é exibido/);
  assert.equal(show('ready'), '');
});

test('empresa, rastreabilidade, bloqueios e o que falta: texto escapado, campos do contrato público, nada sigiloso', () => {
  const evidence = { company: { name: '<script>alert(1)</script> Padaria', city: '<img src=x>', stateCode: 'GO' }, identifiers: { confirmed: [{ type: 'cid', value: '123456789' }] }, source: { label: 'Serper' }, collectedAt: '2026-10-22T12:54:48.079Z' } as never;
  const html = render(createElement(CompanyPanel, { evidence, preview: previewFixture() }));
  assert.ok(!/<script|<img/.test(html));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Padaria/);
  assert.match(text(html), /CID confirmado 123456789/);
  assert.match(text(html), /Integridade das evidências OK/);
  assert.match(text(html), /Serper \(intermediário\)/);
  assert.match(html, /aria-label="Copiar hash de capture:c0001 completo"/);
  const trace = text(render(createElement(TraceabilityPanel, { preview: previewFixture() })));
  assert.match(trace, /Identificador usado pelo motor auditoria-ui-0001/);
  assert.match(trace, /Head das decisões confirmadas sem decisões/);
  assert.ok(!/https?:\/\/|rawSha256|justificativa|\/mnt|\/tmp/i.test(trace));
  assert.match(text(render(createElement(BlockersPanel, { blockers: [] }))), /Nenhum bloqueio aberto/);
  const blockers = text(render(createElement(BlockersPanel, { blockers: [{ code: 'DECISION_PENDING', severity: 'BLOCKING', message: 'Há <b>decisão</b> pendente.', reasonCode: null, decisionIds: ['op-0002'], subcriterionIds: ['C2'] }] })));
  assert.match(blockers, /Bloqueia · Há <b>decisão<\/b> pendente\./);
  assert.match(blockers, /Decisões: op-0002\./);
  assert.match(text(render(createElement(MissingPanel, { missing: previewFixture().missing }))), /\+41 pts.*Potencial de cobertura, ainda não comprovado: não é nota nem promessa/);
});

/* ------------------------------------------------------------------------------------------------ tela, rota e segurança estática */
test('tela completa no estado inicial: carregando, um único h1 (do shell), regiões nomeadas e nenhum dado inventado', () => {
  const html = render(createElement(AuditDetailScreen, { auditId: AUDIT }));
  assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1);
  assert.match(html, /<aside aria-label="Finalização, bloqueios e pendências"/);
  assert.match(html, /<nav aria-label="Navegação da auditoria"/);
  assert.match(text(html), /Carregando a auditoria…/);
  assert.match(text(html), /Resultado da prévia/);
  assert.match(text(html), /Critérios Lumos/);
  assert.match(text(html), /Resultados finalizados/);
  assert.ok(!/definitivo e imutável.*Confirmado/.test(text(html)));
  assert.ok(!/<button[^>]*>Registrar resultado…<\/button>/.test(html.replace(/<button[^>]*disabled=""/g, '<DISABLED')), 'sem dados o botão de finalizar está desabilitado');
});

test('rota: id inválido ⇒ 404 (notFound) sem renderizar; id válido renderiza a tela com o id', async () => {
  for (const bad of ['curto', '../etc', 'A'.repeat(10), 'a'.repeat(65), 'com espaço', '']) {
    await assert.rejects(() => AuditPage({ params: Promise.resolve({ auditId: bad }) }), (error: unknown) => /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test(String((error as { digest?: string }).digest ?? error)), bad);
  }
  const element = await AuditPage({ params: Promise.resolve({ auditId: AUDIT }) });
  assert.equal((element.props as { auditId: string }).auditId, AUDIT);
});

test('segurança estática do diretório da página: nada de HTML bruto, avaliação dinâmica, armazenamento do navegador, rede além do cliente e módulos de servidor', () => {
  const dir = path.join(__dirname, '..', 'src', 'components', 'link-audit', 'audit-page');
  const files = fs.readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name));
  assert.ok(files.length >= 15);
  for (const name of files) {
    const code = fs.readFileSync(path.join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    assert.ok(!/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|localStorage|sessionStorage|indexedDB|document\.cookie/.test(code), `${name}: construção insegura`);
    assert.ok(!/from 'node:|from "node:|process\.env|from '@\/lib\/(link-audit-scoring-runs|link-audit-decisions|link-audit-storage)|scoreAudit|computeIndex|aggregate\(/.test(code), `${name}: módulo de servidor ou cálculo de pontuação`);
    if (name !== 'api.ts' && name !== 'audit-detail-screen.tsx') assert.ok(!/\bfetch\s*\(/.test(code), `${name}: rede fora do cliente`);
  }
  // o navegador não soma nem multiplica pontos: nenhuma redução/soma sobre campos de pontos
  const source = files.map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
  assert.ok(!/reduce\([^)]*(HalfPoints|obtained)/.test(source));
  assert.ok(!/obtainedHalfPoints\s*[+*]|[+*]\s*[\w.]*obtainedHalfPoints|evaluatedHalfPoints\s*[+*]/.test(source));
  void detailResponse;
});

/* ------------------------------------------------------------------------------------------------ 429, foco e Escape */
test('429: aviso próprio (não é sucesso nem pendência de recibo), reenvio desabilitado até o prazo, texto do tempo informado ou estimado', () => {
  const request = { expectedHead: null, expectedInputSha256: 'a'.repeat(64) };
  const wait = text(finalizationHtml(pageReducer(stateWith(), { type: 'FINALIZE_SET', flow: { phase: 'rate_limited', request, until: Date.now() + 90_000, seconds: 60, fromHeader: true } })));
  assert.match(wait, /Limite de requisições atingido\./);
  assert.match(wait, /Nada foi gravado por esta tentativa: não é um resultado confirmado nem uma pendência de recibo/);
  assert.match(wait, /O servidor pediu para aguardar 60 s/);
  assert.match(wait, /Nada é reenviado automaticamente/);
  assert.match(wait, /Reenviar o mesmo pedido \(disponível em cerca de \d+ s\)/);
  assert.ok(!/Confirmado|gravado com recibo|NÃO concluída/.test(wait));
  const html = finalizationHtml(pageReducer(stateWith(), { type: 'FINALIZE_SET', flow: { phase: 'rate_limited', request, until: Date.now() + 90_000, seconds: 60, fromHeader: false } }));
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^<]*Reenviar o mesmo pedido \(disponível/);
  assert.match(text(html), /O servidor não informou o tempo; por prudência, aguarde 60 s/);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-describedby="finalizar-motivo"/, 'registrar de novo também fica bloqueado durante o prazo');
  const expired = finalizationHtml(pageReducer(stateWith(), { type: 'FINALIZE_SET', flow: { phase: 'rate_limited', request, until: Date.now() - 1, seconds: 60, fromHeader: true } }));
  assert.doesNotMatch(expired, /<button[^>]*disabled=""[^>]*>[^<]*Reenviar o mesmo pedido/);
  assert.match(text(expired), /Reenviar o mesmo pedido/);
});

test('foco: o desfecho do fluxo tem região focalizável por programa; o formulário não rouba foco no SSR; Escape fecha formulário e revogação', () => {
  const html = finalizationHtml(stateWith());
  assert.match(html, /<div tabindex="-1" class="rounded-xl focus:outline-none focus-visible:ring-2/);
  const form = { ...CLOSED_FORM, optionKey: 'S4' as const, phase: 'editing' as const };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'link-audit', 'audit-page', 'decisions-panel.tsx'), 'utf8');
  assert.match(source, /event\.key === 'Escape' && !busy/);
  assert.match(source, /\(isC2 \? selectRef\.current : textRef\.current\)\?\.focus\(\)/);
  assert.match(source, /reasonRef\.current\?\.focus\(\)/);
  assert.match(render(createElement(DecisionsPanel, decisionsProps({ form }))), /id="decisao-justificativa"/);
});

test('foco: restoreFocus devolve o foco a quem iniciou a interação se ele ainda existe e está utilizável; senão ao título da seção; nunca lança', async () => {
  const { restoreFocus } = await import('../src/components/link-audit/audit-page/ui-bits');
  const focused: string[] = [];
  const el = (name: string, over: Record<string, unknown> = {}) => ({ isConnected: true, matches: () => false, getClientRects: () => [1], focus: () => focused.push(name), ...over }) as unknown as HTMLElement;
  const summary = el('summary');
  const holder = { querySelector: () => summary, focus: () => focused.push('holder') };
  const realDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { getElementById: (id: string) => (id === 'secao' ? holder : null) };
  try {
    restoreFocus(el('opener'), 'secao');
    restoreFocus(el('desconectado', { isConnected: false }), 'secao');
    restoreFocus(el('desabilitado', { matches: () => true }), 'secao');
    restoreFocus(el('oculto', { getClientRects: () => [] }), 'secao');
    restoreFocus(null, 'secao');
    restoreFocus(null, 'inexistente');
    restoreFocus(el('sem-fallback', { isConnected: false }));
    assert.deepEqual(focused, ['opener', 'summary', 'summary', 'summary', 'summary']);
  } finally {
    (globalThis as { document?: unknown }).document = realDocument;
  }
});
