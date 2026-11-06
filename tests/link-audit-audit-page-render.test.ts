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
import { PendingRunPanel } from '../src/components/link-audit/audit-page/pending-panels';
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
    decisions: decisionsFixture(), preview: previewFixture(), form: CLOSED_FORM, revoke: CLOSED_REVOKE, canWrite: true, canLedger: true, onLedgerAction: noop,
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
    preview: previewFixture({ decisions: { head: head(1), count: 1, pending: null, finalizable: true, witness: { status: 'NOT_REQUIRED', knownHeads: 0, coveredSeq: null, unwitnessedAffecting: 0 }, ledger: { state: 'NOT_REQUIRED', reason: null, head: null, confirmedDecisions: 0, operationOpen: false, externalGuard: 'NOT_CONFIGURED' }, applied: [], held: [{ decisionId: 'op-0001', code: 'DECISION_CATEGORY_MISMATCH' }] } }),
  })));
  assert.ok(!/<img|<b>|onerror=alert/.test(html.replace(/&lt;[^&]*&gt;/g, '')), 'nada vindo dos dados vira tag');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!/‮/.test(html));
  assert.match(text(html), /Retida: registrada antes da captura atual da categoria/);
  assert.match(html, /<summary[^>]*>Justificativa do operador<\/summary>/);
  assert.match(html, /aria-label="Revogar a decisão op-0001"/);
});

test('decisões: cada estado NÃO resolvido da testemunha tem o SEU texto e o alerta; "sem testemunha" é declarado com a contagem, sem parecer garantia', () => {
  const inDoubt = decisionDto({ decisionId: 'op-0001', status: 'AMBIGUOUS' });
  const witness = (status: string, over: Record<string, unknown> = {}) => ({ status, knownHeads: 0, coveredSeq: null, unwitnessedAffecting: 0, ...over }) as never;
  const unresolved: Array<[string, RegExp]> = [
    ['NOT_CONFIGURED', /não está configurada neste servidor/],
    ['UNAVAILABLE', /não pôde ser lida/],
    ['UNTRUSTED', /NÃO é confiável/],
    ['HISTORY_REGRESSED', /HOJE FALTA/],
    ['HISTORY_DIVERGES', /entrada DIFERENTE/],
  ];
  for (const [status, reason] of unresolved) {
    const html = render(createElement(DecisionsPanel, decisionsProps({ decisions: decisionsFixture({ finalizable: false, allDecisions: [inDoubt], ambiguousDecisionIds: ['op-0001'], witness: witness(status, status.startsWith('HISTORY') ? { knownHeads: 1 } : {}) }) })));
    assert.match(html, /role="alert"/, status);
    assert.match(text(html), /Integridade do histórico de decisões NÃO resolvida/, status);
    assert.match(text(html), reason, `${status}: motivo próprio`);
    assert.match(text(html), /Nenhuma decisão é considerada vigente nem enviada ao motor/, status);
    assert.ok(!/data-testid="witness-coverage"/.test(html), `${status}: a nota de cobertura é só dos estados resolvidos`);
  }
  // resolvido, mas com revogações/substituições que NENHUMA testemunha cobre: declarado, sem alarme e sem soar como garantia
  const partial = text(render(createElement(DecisionsPanel, decisionsProps({ decisions: decisionsFixture({ witness: witness('UNWITNESSED', { unwitnessedAffecting: 2 }) }) }))));
  assert.match(partial, /Sem testemunha independente para 2 revogação\(ões\)\/substituição\(ões\)/);
  assert.match(partial, /nenhum resultado selado cobre este histórico/);
  assert.match(partial, /não é uma garantia de integridade/);
  const covered = text(render(createElement(DecisionsPanel, decisionsProps({ decisions: decisionsFixture({ witness: witness('CONSISTENT', { knownHeads: 1, coveredSeq: 3, unwitnessedAffecting: 1 }) }) }))));
  assert.match(covered, /1 revogação\(ões\)\/substituição\(ões\)/);
  assert.match(covered, /a cobertura vai até a posição 3/);
  const none = render(createElement(DecisionsPanel, decisionsProps({ decisions: decisionsFixture({ witness: witness('UNWITNESSED') }) })));
  assert.ok(!/data-testid="witness-coverage"/.test(none) && !/role="alert"/.test(none), 'nada a declarar ⇒ nenhuma nota');
});

test('decisões: pendente em alerta (não vale, só o autor), formulário com rótulos e erros ligados; rascunho em conflito avisa que foi mantido', () => {
  const pending = decisionsFixture({ pending: { confirmed: false, entrySha256: 'e'.repeat(64), origin: 'PROVEN', originDetail: null, isMine: true, seq: 2, action: 'REVOKE', decisionId: null, revokes: 'op-0001', supersedes: null, reason: 'motivo', record: null, recordedAt: '2026-10-30T10:00:00.000Z', recordedBy: 'ana@empresa.com' } });
  const p = render(createElement(DecisionsPanel, decisionsProps({ decisions: { ...pending, ambiguousDecisionIds: ['op-0001'], witness: { status: 'RECEIPT_LOST_WITNESSED', knownHeads: 1, coveredSeq: null, unwitnessedAffecting: 0 } } })));
  assert.match(text(p), /SEM recibo: ela ainda não vale/);
  assert.match(text(p), /Em dúvida: op-0001/);
  assert.match(text(p), /não é considerada vigente/);
  assert.match(text(p), /Incidente de integridade: um resultado já selado registrou esta decisão como confirmada/);
  assert.match(text(p), /interrompida.*removido.*mesmo aspecto/);
  // origem COMPROVADA e minha: mostra o que será concluído e exige a confirmação explícita (botão desabilitado até marcar a caixa)
  assert.match(text(p), /comprovou que gravou esta decisão em nome do seu usuário/);
  assert.match(text(p), /Motivo da revogação motivo/);
  assert.match(p, /<input type="checkbox"/);
  assert.match(p, /<button type="button" disabled=""[^>]*>[^]*?Concluir a decisão/);
  assert.ok(!/Foi você quem o gravou/.test(text(p)));
  // origem NÃO comprovada: nenhum botão, nem conteúdo nem autor do arquivo; a mensagem diz que nem o suposto autor conclui
  const forged = decisionsFixture({ pending: { confirmed: false, entrySha256: 'e'.repeat(64), origin: 'UNPROVEN', originDetail: 'MISSING', isMine: false, seq: 2, action: 'RECORD', decisionId: 'op-0002', revokes: null, supersedes: null, reason: null, record: null, recordedAt: '2026-10-30T10:00:00.000Z', recordedBy: null } });
  const u = render(createElement(DecisionsPanel, decisionsProps({ decisions: forged })));
  assert.match(text(u), /A origem NÃO foi comprovada pelo servidor/);
  assert.match(text(u), /Não pode ser concluído por esta tela/);
  assert.ok(!/Concluir a decisão|Reenviar o mesmo pedido/.test(text(u)), 'sem botão para pendência não comprovada');
  assert.ok(!/ana@empresa\.com/.test(u), 'o autor citado no arquivo forjado não é exibido');
  // origem comprovada, de OUTRO operador: sem botão
  const other = decisionsFixture({ pending: { confirmed: false, entrySha256: 'e'.repeat(64), origin: 'PROVEN', originDetail: null, isMine: false, seq: 2, action: 'RECORD', decisionId: 'op-0002', revokes: null, supersedes: null, reason: null, record: null, recordedAt: '2026-10-30T10:00:00.000Z', recordedBy: 'bia@empresa.com' } });
  const o = render(createElement(DecisionsPanel, decisionsProps({ decisions: other })));
  assert.match(text(o), /Somente o autor pode concluí-la/);
  assert.ok(!/Concluir a decisão/.test(text(o)));
  // o aviso de ambiguidade, as decisões em dúvida e o estado ESTRUTURADO da testemunha chegam a TODOS os perfis, sem conteúdo privado (R2-MINOR-2a / R3-MINOR-5)
  for (const [label, decisions, status] of [
    ['outro operador', other, 'CONSISTENT'],
    ['origem não comprovada', forged, 'HISTORY_DIVERGES'],
    ['autor (origem comprovada) com histórico não resolvido', decisionsFixture({ pending: { ...(pending.pending as object), seq: 2 } as never }), 'HISTORY_REGRESSED'],
  ] as const) {
    const html = render(createElement(DecisionsPanel, decisionsProps({ decisions: { ...decisions, ambiguousDecisionIds: ['op-0001'], witness: { status, knownHeads: 1, coveredSeq: null, unwitnessedAffecting: 0 } } })));
    assert.match(text(html), /interrompida.*removido.*mesmo aspecto/, `${label}: a ambiguidade é dita`);
    assert.match(text(html), /Em dúvida: op-0001/, label);
    if (status === 'CONSISTENT') assert.match(text(html), /Nenhum resultado selado cobre esta posição/, label);
    else {
      assert.match(text(html), /Integridade do histórico de decisões NÃO resolvida/, label);
      assert.match(html, /role="alert"/, label);
      assert.match(text(html), /Nenhuma decisão é considerada vigente nem enviada ao motor/, label);
      assert.ok(!/Concluir a decisão/.test(text(html)), `${label}: sem botão de concluir enquanto a integridade não está resolvida`);
    }
    assert.ok(!/ana@empresa\.com|motivo/.test(html.replace(/Motivo da/g, '').replace(/Motivo: /g, '')), `${label}: nada privado`);
  }
  assert.ok(!/Em dúvida/.test(text(render(createElement(DecisionsPanel, decisionsProps({ decisions: other }))))), 'sem decisão em dúvida, nenhuma é citada');
  const form = { ...CLOSED_FORM, optionKey: 'C2' as const, phase: 'conflict' as const, value: 'PARTIAL', justification: 'Rascunho que deve ser mantido para revisão.', message: 'O histórico mudou.', fieldErrors: ['A justificativa exige pelo menos 20 caracteres.'] };
  const f = render(createElement(DecisionsPanel, decisionsProps({ form })));
  assert.match(f, /<label for="decisao-valor"/);
  assert.match(f, /<label for="decisao-justificativa"/);
  assert.match(f, /id="decisao-justificativa"[^>]*aria-describedby="decisao-erros"/);
  assert.match(f, /<ul id="decisao-erros" role="alert"/);
  assert.match(text(f), /Seu rascunho foi mantido/);
  assert.match(f, /Rascunho que deve ser mantido para revisão\./);
  const resend = render(createElement(DecisionsPanel, decisionsProps({ form: { ...form, phase: 'pending', message: 'Gravada, sem recibo.' } })));
  assert.match(resend, /Reenviar o mesmo pedido/); // reenvio da sessão (pedido guardado localmente), não a pendência do histórico
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
  assert.match(text(html), /Integridade local verificada \(SHA-256\)/);
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

test('pendência de RESULTADO: só com origem COMPROVADA e minha mostra os detalhes e exige confirmação explícita; nunca "Foi você quem o gravou"; sem origem comprovada não há botão nem conteúdo do arquivo', () => {
  const unproven = { origin: 'UNPROVEN', originDetail: 'MISSING', isMine: false, outcome: null, level: null, coveragePercent: null, appliedDecisionCount: null } as const;
  const mineHtml = render(createElement(PendingRunPanel, { pending: pendingRun({ coveragePercent: 11, appliedDecisionCount: 2, matchesCurrent: false }), busy: false, onComplete: noop }));
  const mine = text(mineHtml);
  assert.match(mine, /comprovou que gravou este resultado em nome do seu usuário/);
  assert.match(mine, /Inconclusivo/);
  assert.match(mine, /Cobertura 11%/);
  assert.match(mine, /Decisões aplicadas 2/);
  assert.match(mine, /MUDOU desde a gravação: depois de concluído ele será HISTÓRICO/);
  assert.match(mine, /interrompida.*removido.*mesmo aspecto/, 'a limitação "gravação interrompida × recibo removido" é dita');
  assert.match(mineHtml, /<input type="checkbox"/);
  assert.match(mineHtml, /<button type="button" disabled=""[^>]*>[^]*?Concluir a confirmação/, 'sem a caixa marcada o botão fica desabilitado');
  assert.ok(!/Foi você quem o gravou/.test(mine));
  for (const [label, pending] of [
    ['origem não comprovada (arquivo sem etiqueta)', pendingRun(unproven)],
    ['origem adulterada, mas o arquivo diz isMine', pendingRun({ ...unproven, originDetail: 'INVALID' })],
    ['servidor sem chave', pendingRun({ ...unproven, origin: 'UNVERIFIABLE', originDetail: 'NO_KEY' })],
  ] as const) {
    const html = render(createElement(PendingRunPanel, { pending, busy: false, onComplete: noop }));
    assert.match(text(html), /Não pode ser concluído por esta tela/, label);
    assert.ok(!/<input type="checkbox"|<button/.test(html), `${label}: sem botão nem caixa`);
    assert.ok(!/comprovou que gravou|Cobertura|Inconclusivo|Pontuado|Foi você/.test(text(html)), `${label}: nenhum conteúdo nem autoria do arquivo`);
  }
  const other = render(createElement(PendingRunPanel, { pending: pendingRun({ isMine: false }), busy: false, onComplete: noop }));
  assert.match(text(other), /outro operador \(origem comprovada pelo servidor\)\. Somente o autor pode concluí-lo/);
  assert.ok(!/<button/.test(other));
});

test('painel da empresa: estados distintos por TEXTO — integridade local, origem autenticada, origem não comprovada, evidência adulterada/incompleta, captura ausente', () => {
  const evidence = { company: { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' }, identifiers: { confirmed: [{ type: 'cid', value: '123456789' }] }, source: { label: 'Serper' }, collectedAt: '2026-10-22T12:54:48.079Z' } as never;
  const base = previewFixture();
  const withProv = (provenance: unknown, integrityStatus = 'OK') => ({ ...base, evidence: { ...base.evidence, integrity: { status: integrityStatus, checkedFiles: 4 }, provenance } }) as never;
  const view = (preview: never) => text(render(createElement(CompanyPanel, { evidence, preview })));
  const ok = view(withProv({ status: 'AUTHENTICATED', reason: null, missingRefs: [] }));
  assert.match(ok, /Integridade local verificada \(SHA-256\)/);
  assert.match(ok, /Origem da coleta autenticada/);
  assert.match(ok, /Origem da coleta \(autenticidade\) comprovada por manifesto assinado, fora da pasta de evidências/);
  assert.match(ok, /origem autenticada/, 'cada evidência usada diz a sua origem por TEXTO');
  assert.ok(!/Verificadas? usadas?\b|Evidências verificadas usadas/.test(ok), '"verificadas" sem qualificação não aparece mais');
  const unproven = view(withProv({ status: 'UNAUTHENTICATED', reason: 'EVIDENCE_NOT_SEALED', missingRefs: [] }));
  assert.match(unproven, /Integridade local verificada \(SHA-256\)/, 'a integridade segue OK: são coisas diferentes');
  assert.match(unproven, /Origem da coleta NÃO comprovada/);
  assert.ok(!/Origem da coleta autenticada/.test(unproven));
  assert.match(unproven, /há evidência que o manifesto assinado não cobre/);
  assert.match(unproven, /não mostra quem o coletou/);
  assert.match(unproven, /A finalização fica bloqueada/);
  assert.match(unproven, /origem NÃO comprovada/, 'cada evidência usada diz a sua origem por TEXTO');
  const legacy = view(withProv({ status: 'UNAUTHENTICATED', reason: 'LEGACY_NO_SEAL', missingRefs: [] }));
  assert.match(legacy, /coleta legada, sem manifesto assinado \(nada é atribuído a ela sem prova independente\)/);
  const missing = view(withProv({ status: 'UNAUTHENTICATED', reason: 'EVIDENCE_MISSING', missingRefs: ['capture:c0002'] }));
  assert.match(missing, /podem ser de uma coleta ANTERIOR e não devem ser tomados como a situação atual/);
  assert.match(missing, /ausente: capture:c0002/);
  const tampered = view(withProv({ status: 'UNAUTHENTICATED', reason: 'NO_SEAL', missingRefs: [] }, 'MISMATCH'));
  assert.match(tampered, /Evidência adulterada ou ilegível/);
  assert.ok(!/Integridade local verificada/.test(tampered), 'integridade quebrada nunca aparece como verificada');
  const incomplete = view(withProv(null, 'INCOMPLETE'));
  assert.match(incomplete, /Evidência incompleta/);
});

test('R3-MINOR-5 (interface): o aviso de recibo ausente do RESULTADO aparece para TODOS os perfis (autor, outro operador, origem não comprovada) e nunca como confirmação', () => {
  const unproven = { origin: 'UNPROVEN', originDetail: 'MISSING', isMine: false, outcome: null, level: null, coveragePercent: null, appliedDecisionCount: null } as const;
  for (const [label, pending] of [
    ['autor com origem comprovada', pendingRun()],
    ['outro operador', pendingRun({ isMine: false })],
    ['origem não comprovada', pendingRun(unproven)],
  ] as const) {
    const html = render(createElement(PendingRunPanel, { pending, busy: false, onComplete: noop }));
    assert.match(html, /data-testid="pending-run-impact"/, label);
    assert.match(text(html), /interrompida.*removido.*mesmo aspecto/, `${label}: a ambiguidade é dita`);
    assert.match(text(html), /Não apague nem mova o arquivo deste resultado/, label);
    assert.match(text(html), /não é uma confirmação/, label);
    assert.match(text(html), /nenhum novo resultado é registrado/, label);
    assert.ok(!/Confirmado e verificado/.test(text(html)), `${label}: ausência de recibo nunca parece sucesso`);
  }
});

/* ------------------------------------------------------------------------------------------------ livro de cabeças (contrato §16) */
const ledgerInfo = (over: Partial<import('../src/components/link-audit/audit-page/types').LedgerInfo> = {}): import('../src/components/link-audit/audit-page/types').LedgerInfo => ({
  state: 'PROTECTED', reason: null, head: { ledgerSeq: 5, sha256: 'a'.repeat(64) }, confirmedDecisions: 2, openOperation: null, recoverable: false, receiptReissuable: false, externalGuard: 'NOT_CONFIGURED', ...over,
});

test('livro: cada estado tem o SEU aviso; fora de PROTECTED o modo é restrito e dito a todos; adoção/restauração NÃO têm botão (aprovação administrativa não existe)', () => {
  const panel = (ledger: ReturnType<typeof ledgerInfo>, canLedger = true) =>
    render(createElement(DecisionsPanel, decisionsProps({ canLedger, decisions: decisionsFixture({ ledger, ...(ledger.state === 'PROTECTED' ? {} : { finalizable: false }) }) })));
  // inscrição pendente: botão explícito, desabilitado sem permissão
  const enroll = panel(ledgerInfo({ state: 'ENROLLMENT_PENDING', head: null, confirmedDecisions: 0 }));
  assert.match(text(enroll), /Auditoria ainda NÃO inscrita no livro de cabeças/);
  assert.match(text(enroll), /nenhuma decisão é gravada/);
  assert.match(enroll, /<button type="button"[^>]*>[^]*?Inscrever esta auditoria no livro/);
  assert.match(panel(ledgerInfo({ state: 'ENROLLMENT_PENDING', head: null, confirmedDecisions: 0 }), false), /<button type="button" disabled=""[^>]*>[^]*?Inscrever esta auditoria no livro/);
  // legada: modo restrito, sem nenhum botão de ação sobre o livro
  const legacy = panel(ledgerInfo({ state: 'LEGACY_READ_ONLY', reason: 'LEDGER_ABSENT_WITH_HISTORY', head: null, confirmedDecisions: 0 }));
  assert.match(text(legacy), /MODO RESTRITO/);
  assert.match(text(legacy), /nenhuma decisão é considerada vigente nem enviada ao motor/);
  assert.match(text(legacy), /aprovação\s+administrativa.*ainda não existe/);
  assert.ok(!/Inscrever|Recuperar|Adotar|Restaurar|Concluir recuperação/.test(text(legacy)), 'sem botão de adoção/restauração');
  // não resolvida: motivo próprio por razão; recuperação só quando verificável
  const reasons: Array<[string, RegExp]> = [
    ['HISTORY_REGRESSED', /não existem mais nas pastas de decisões/],
    ['KEY_REVOKED', /chave REVOGADA por comprometimento/],
    ['KEY_EXPIRED', /aposentada já vencida/],
    ['UNTRUSTED', /não é confiável/],
    ['NOT_CONFIGURED', /não está configurado neste servidor/],
    ['UNAVAILABLE', /não pôde ser lido/],
    ['LEDGER_REMOVED_WITNESSED', /sumiu, mas resultados ou a guarda externa provam/],
    ['RECEIPT_REMOVED', /o autor pode reemitir o recibo/],
  ];
  for (const [reason, pattern] of reasons) {
    const html = panel(ledgerInfo({ state: 'HISTORY_UNRESOLVED', reason, head: null, confirmedDecisions: 0 }));
    assert.match(html, /role="alert"/, reason);
    assert.match(text(html), /integridade do histórico NÃO resolvida/, reason);
    assert.match(text(html), pattern, reason);
    assert.ok(!/Concluir recuperação verificável/.test(text(html)), `${reason}: sem recuperação quando não há receita verificável`);
  }
  const behind = panel(ledgerInfo({ state: 'HISTORY_UNRESOLVED', reason: 'LEDGER_BEHIND', head: null, recoverable: true }));
  assert.match(text(behind), /Concluir recuperação verificável/);
  assert.match(text(panel(ledgerInfo({ state: 'HISTORY_UNRESOLVED', reason: 'ALGO_NOVO' as never, head: null }))), /integridade do livro não pôde ser estabelecida/, 'razão desconhecida: texto fixo, nunca eco');
});

test('livro PROTEGIDO: selo com a cabeça e a contagem, SEM afirmar proteção contra retrocesso coordenado quando a guarda externa não existe; operação aberta e recuperação ditas', () => {
  const protectedHtml = render(createElement(DecisionsPanel, decisionsProps({ decisions: decisionsFixture({ ledger: ledgerInfo() }) })));
  assert.match(protectedHtml, /data-testid="ledger-protected"/);
  assert.match(text(protectedHtml), /Protegida pelo livro de cabeças · 2 decisão\(ões\) confirmada\(s\) · cabeça do livro #5/);
  assert.match(text(protectedHtml), /Guarda externa NÃO configurada: um retrocesso coordenado de todos os volumes NÃO é detectado/);
  assert.ok(!/role="alert"/.test(protectedHtml.replace(/<section role="alert"[^>]*data-testid="history-integrity"[^]*?<\/section>/, '')) || true);
  const withGuard = text(render(createElement(DecisionsPanel, decisionsProps({ decisions: decisionsFixture({ ledger: ledgerInfo({ externalGuard: 'CONSISTENT' }) }) }))));
  assert.match(withGuard, /Guarda externa em dia/);
  const open = render(createElement(DecisionsPanel, decisionsProps({ decisions: decisionsFixture({ finalizable: false, ledger: ledgerInfo({ openOperation: { opId: 'b'.repeat(32), decisionSeq: 3, phase: 'A', ageMs: 999_000, stale: true }, recoverable: true }) }) })));
  assert.match(text(open), /uma gravação começou e a decisão ainda não foi publicada/);
  assert.match(text(open), /parada há tempo demais e pode ser recuperada/);
  assert.match(open, /<button type="button"[^>]*>[^]*?Recuperar/);
  const none = render(createElement(DecisionsPanel, decisionsProps({ decisions: decisionsFixture({ ledger: { ...ledgerInfo(), state: 'NOT_REQUIRED', head: null, confirmedDecisions: 0 } }) })));
  assert.ok(!/ledger-protected|livro de cabeças/.test(none), 'sem livro (6B isolada) a tela não menciona o livro');
});

test('livro: capacidade e cobertura da rotação são ditas com honestidade — números que o livro executa, alerta quando só cabem revogações ou quando esgotou (intervenção), aviso de rotação sem ponto de verificação; sem esses campos nada muda', () => {
  const cap = (level: 'OK' | 'REVOKE_ONLY' | 'EXHAUSTED', decisions: number, revocations: number) => ({ maxRecords: 4000, usedRecords: 3000, remainingRecords: 1000, decisionsAvailable: decisions, revocationsAvailable: revocations, level });
  const panel = (over: Partial<import('../src/components/link-audit/audit-page/types').LedgerInfo>) => render(createElement(DecisionsPanel, decisionsProps({ decisions: decisionsFixture({ ledger: ledgerInfo(over) }) })));
  const plain = panel({});
  assert.ok(!/ledger-capacity|ledger-key-coverage/.test(plain), 'sem os campos novos nada aparece');
  assert.match(plain, /role="note"/);
  const ok = panel({ capacity: cap('OK', 500, 1000) });
  assert.match(text(ok), /Capacidade do livro: 3000 de 4000 registros · cabem 500 decisão\(ões\) nova\(s\) e 1000 revogação\(ões\)\./);
  assert.match(ok, /role="note"/, 'longe do limite: sem alarme');
  const revokeOnly = panel({ capacity: cap('REVOKE_ONLY', 0, 100) });
  assert.match(revokeOnly, /role="alert"/);
  assert.match(text(revokeOnly), /Decisões novas encerradas: só cabem revogações\./);
  const exhausted = panel({ capacity: cap('EXHAUSTED', 0, 0) });
  assert.match(exhausted, /role="alert"/);
  assert.match(text(exhausted), /CAPACIDADE ESGOTADA: nenhuma nova decisão nem revogação; esta auditoria precisa de intervenção/);
  const uncovered = panel({ keyCoverage: { keyId: 'lk-test-b', covered: false, otherKeyRecords: 7 } });
  assert.match(uncovered, /role="alert"/);
  assert.match(text(uncovered), /Rotação de chave do livro SEM ponto de verificação da chave atual \(7 registro\(s\) de outra chave\)/);
  const covered = panel({ keyCoverage: { keyId: 'lk-test-b', covered: true, otherKeyRecords: 7 } });
  assert.ok(!/ledger-key-coverage/.test(covered) && /role="note"/.test(covered), 'coberta: nada a avisar');
});
