import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEligibility, initialPageState, pageReducer, type PageState } from '../src/components/link-audit/audit-page/state';
import { deriveHeadline, deriveRegistry, runObsolescence } from '../src/components/link-audit/audit-page/status';
import { INCONCLUSIVE_HEADLINE } from '../src/components/link-audit/audit-page/labels';
import { AUDIT, decisionsFixture, head, pendingRun, previewFixture, resultsFixture, runSummary, scoredPreview } from './helpers/link-audit-audit-page-fixtures';

/* Onda 6C, I5 — reducer, elegibilidade para finalizar, estado da auditoria e obsolescência. Tudo puro. */
function ready(over: Partial<{ preview: ReturnType<typeof previewFixture>; decisions: ReturnType<typeof decisionsFixture>; results: ReturnType<typeof resultsFixture> }> = {}): PageState {
  let state = initialPageState(AUDIT);
  state = pageReducer(state, { type: 'SECTION_OK', section: 'preview', data: over.preview ?? previewFixture() });
  state = pageReducer(state, { type: 'SECTION_OK', section: 'decisions', data: over.decisions ?? decisionsFixture() });
  state = pageReducer(state, { type: 'SECTION_OK', section: 'results', data: over.results ?? resultsFixture() });
  return state;
}

test('reducer: cada seção carrega sozinha; falha de uma não toca as outras; recarga mantém os últimos dados bons', () => {
  let state = ready();
  state = pageReducer(state, { type: 'SECTION_START', section: 'decisions' });
  assert.equal(state.decisions.phase, 'loading');
  assert.ok(state.decisions.data, 'durante a recarga os dados anteriores continuam');
  assert.equal(state.preview.phase, 'ready');
  state = pageReducer(state, { type: 'SECTION_FAIL', section: 'decisions', phase: 'error', message: 'falhou', code: null });
  assert.deepEqual([state.decisions.phase, state.decisions.data !== null, state.preview.phase, state.results.phase], ['error', true, 'ready', 'ready']);
});

test('reducer: falha de INTEGRIDADE ou acesso negado apaga os dados da seção (nenhum dado é exibido)', () => {
  for (const phase of ['integrity', 'denied'] as const) {
    const state = pageReducer(ready(), { type: 'SECTION_FAIL', section: 'results', phase, message: 'm', code: 'RESULT_INTEGRITY' });
    assert.equal(state.results.data, null, phase);
    assert.equal(state.results.phase, phase);
  }
});

test('reducer: invalidar a prévia a bloqueia até uma nova leitura bem-sucedida', () => {
  let state = ready();
  assert.ok(finalizeEligibility(state).allowed);
  state = pageReducer(state, { type: 'PREVIEW_INVALIDATE', reason: 'o histórico mudou' });
  assert.equal(state.preview.invalidated, 'o histórico mudou');
  assert.ok(!finalizeEligibility(state).allowed);
  state = pageReducer(state, { type: 'SECTION_OK', section: 'preview', data: previewFixture() });
  assert.equal(state.preview.invalidated, null);
  assert.ok(finalizeEligibility(state).allowed);
});

test('reducer: detalhe de resultado ignora resposta de outro número (corrida de cliques)', () => {
  let state = pageReducer(ready(), { type: 'DETAIL_SELECT', seq: 2 });
  state = pageReducer(state, { type: 'DETAIL_OK', seq: 1, data: { stale: false, decisionsChanged: false, superseded: false, run: {} as never } });
  assert.deepEqual([state.detail.seq, state.detail.phase, state.detail.data], [2, 'loading', null]);
  state = pageReducer(state, { type: 'DETAIL_FAIL', seq: 1, phase: 'error', message: 'x' });
  assert.equal(state.detail.phase, 'loading');
});

test('reducer: formulário mantém o rascunho em conflito; campo editado limpa os erros; não edita durante o envio', () => {
  let state = pageReducer(ready(), { type: 'FORM_OPEN', optionKey: 'C2' });
  state = pageReducer(state, { type: 'FORM_FIELD', patch: { value: 'COMPATIBLE', justification: 'Texto de justificativa suficiente.' } });
  state = pageReducer(state, { type: 'FORM_SET', patch: { phase: 'conflict', message: 'mudou' } });
  assert.deepEqual([state.form.value, state.form.justification, state.form.phase], ['COMPATIBLE', 'Texto de justificativa suficiente.', 'conflict']);
  state = pageReducer(state, { type: 'FORM_SET', patch: { phase: 'submitting' } });
  const frozen = pageReducer(state, { type: 'FORM_FIELD', patch: { justification: 'outra' } });
  assert.equal(frozen.form.justification, 'Texto de justificativa suficiente.');
});

/* ------------------------------------------------------------------------------------------------ elegibilidade */
test('finalizar só é permitido com a API dizendo allowed:true na prévia exibida, sem pendências e com tudo no mesmo ponto do histórico', () => {
  assert.deepEqual(finalizeEligibility(ready()), { allowed: true, reason: null });
  const cases: Array<[string, PageState, RegExp]> = [
    ['API não permite', ready({ preview: previewFixture({ finalization: { allowed: false, expectedHead: null, expectedInputSha256: 'a'.repeat(64) } }) }), /API não permite/],
    ['sem entrada do motor', ready({ preview: previewFixture({ finalization: { allowed: true, expectedHead: null, expectedInputSha256: null } }) }), /entrada do motor/],
    ['bloqueio aberto mesmo com allowed', ready({ preview: previewFixture({ blockers: [{ code: 'X', severity: 'BLOCKING', message: 'm', reasonCode: null, decisionIds: [], subcriterionIds: [] }] }) }), /bloqueios/],
    ['decisão pendente na lista', ready({ decisions: decisionsFixture({ pending: { confirmed: false, seq: 1, action: 'RECORD', decisionId: 'op-0001', revokes: null, supersedes: null, reason: null, record: null, recordedAt: '2026-10-30T10:00:00.000Z', recordedBy: 'a@b.com' } }) }), /decisão pendente/],
    ['decisão pendente na prévia', ready({ preview: previewFixture({ decisions: { head: null, count: 0, pending: { seq: 1, action: 'RECORD', decisionId: 'op-0001', revokes: null }, finalizable: false, applied: [], held: [] } }) }), /decisão pendente/],
    ['resultado pendente', ready({ results: resultsFixture({ pending: pendingRun() }) }), /não confirmado/],
    ['head diferente entre prévia e lista', ready({ preview: previewFixture({ finalization: { allowed: true, expectedHead: head(3, 'c'), expectedInputSha256: 'a'.repeat(64) } }) }), /mesmo ponto/],
  ];
  for (const [name, state, reason] of cases) {
    const e = finalizeEligibility(state);
    assert.ok(!e.allowed && reason.test(e.reason ?? ''), `${name}: ${e.reason}`);
  }
  const loading = pageReducer(ready(), { type: 'SECTION_START', section: 'preview' });
  assert.ok(!finalizeEligibility(loading).allowed, 'prévia recarregando');
  const busy = pageReducer(ready(), { type: 'FINALIZE_SET', flow: { phase: 'submitting', request: { expectedHead: null, expectedInputSha256: 'a'.repeat(64) }, recovery: false } });
  assert.ok(!finalizeEligibility(busy).allowed, 'em andamento');
  const noDecisions = pageReducer(ready(), { type: 'SECTION_FAIL', section: 'decisions', phase: 'integrity', message: 'm', code: 'DECISIONS_INTEGRITY' });
  assert.ok(!finalizeEligibility(noDecisions).allowed);
  assert.ok(!finalizeEligibility(initialPageState(AUDIT)).allowed, 'nada carregado');
});

/* ------------------------------------------------------------------------------------------------ estado da auditoria */
test('estado: inconclusivo mostra a frase aprovada e a cobertura vs. o mínimo, sem índice', () => {
  const headline = deriveHeadline(ready());
  assert.equal(headline.kind, 'inconclusive');
  assert.equal(headline.title, INCONCLUSIVE_HEADLINE);
  assert.deepEqual(headline.coverage, { percent: 11, minimum: 40 });
  assert.equal(headline.tone, 'neutral');
});

test('estado: pontuado é "prévia", nunca definitivo; bloqueado, pendente, recusado e sem evidência têm estados próprios', () => {
  assert.match(deriveHeadline(ready({ preview: scoredPreview() })).title, /Prévia pontuada.*não um resultado definitivo/);
  const blocked = deriveHeadline(ready({ preview: previewFixture({ state: 'CALCULADO_NAO_FINALIZAVEL' }) }));
  assert.equal(blocked.kind, 'blocked');
  assert.equal(blocked.title, INCONCLUSIVE_HEADLINE);
  assert.match(deriveHeadline(ready({ preview: previewFixture({ state: 'DECISAO_PENDENTE', outcomePreview: null }) })).title, /Decisão pendente/);
  assert.equal(deriveHeadline(ready({ preview: previewFixture({ state: 'ENTRADA_RECUSADA', outcomePreview: null, result: null }) })).kind, 'refused');
  assert.equal(deriveHeadline(ready({ preview: previewFixture({ state: 'SEM_EVIDENCIA', outcomePreview: null, result: null }) })).kind, 'no_evidence');
  assert.equal(deriveHeadline(initialPageState(AUDIT)).kind, 'loading');
});

test('estado: erro de integridade em QUALQUER seção domina a faixa e nomeia a seção', () => {
  for (const [section, name] of [['evidence', /evidências/i], ['preview', /prévia/i], ['decisions', /decisões/i], ['results', /resultados/i]] as const) {
    const state = pageReducer(ready(), { type: 'SECTION_FAIL', section, phase: 'integrity', message: 'm', code: 'X' });
    const headline = deriveHeadline(state);
    assert.equal(headline.kind, 'integrity', section);
    assert.equal(headline.tone, 'danger');
    assert.match(headline.lines.join(' '), name);
  }
});

test('estado: prévia invalidada e recarga falha aparecem como aviso, sem esconder os dados antigos', () => {
  let state = pageReducer(ready(), { type: 'PREVIEW_INVALIDATE', reason: 'o histórico mudou.' });
  assert.match(deriveHeadline(state).lines.join(' '), /Prévia desatualizada: o histórico mudou/);
  state = pageReducer(ready(), { type: 'SECTION_FAIL', section: 'preview', phase: 'error', message: 'falha', code: null });
  assert.match(deriveHeadline(state).lines.join(' '), /dados abaixo podem estar velhos/);
  const noData = pageReducer(initialPageState(AUDIT), { type: 'SECTION_FAIL', section: 'preview', phase: 'unavailable', message: 'indisponível', code: null });
  assert.equal(deriveHeadline(noData).kind, 'unavailable');
});

/* ------------------------------------------------------------------------------------------------ obsolescência */
test('obsolescência: stale, decisionsChanged, substituído e stateChangedAfterFinalization são indicadores SEPARADOS; null = desconhecido', () => {
  assert.deepEqual(runObsolescence(runSummary()), { historical: false, unknown: false, reasons: [] });
  assert.match(runObsolescence(runSummary({ stale: true })).reasons.join(' '), /entrada do motor mudou/);
  assert.match(runObsolescence(runSummary({ decisionsChanged: true })).reasons.join(' '), /decisões mudaram/);
  assert.match(runObsolescence(runSummary({ superseded: true, stale: null, decisionsChanged: null })).reasons.join(' '), /substituída/);
  assert.match(runObsolescence(runSummary(), true).reasons.join(' '), /logo após a gravação/);
  const unknown = runObsolescence(runSummary({ stale: null, decisionsChanged: null }));
  assert.deepEqual([unknown.historical, unknown.unknown], [false, true]);
  const both = runObsolescence(runSummary({ stale: true, decisionsChanged: true }));
  assert.equal(both.reasons.length, 2);
});

test('registro: só se diz "coerente com o estado atual" quando os DOIS indicadores são conhecidos e falsos; senão é histórico ou desconhecido; pendente nunca é atual', () => {
  const line = (results: ReturnType<typeof resultsFixture>, changedAfter: boolean | null = null) => deriveRegistry(ready({ results }), changedAfter);
  assert.match(line(resultsFixture({ results: [runSummary()] }))?.text ?? '', /coerente com o estado atual/);
  assert.equal(line(resultsFixture({ results: [runSummary()] }))?.tone, 'success');
  for (const over of [{ stale: true }, { decisionsChanged: true }] as const) {
    const l = line(resultsFixture({ results: [runSummary(over)] }));
    assert.deepEqual([l?.historical, l?.tone], [true, 'warning']);
    assert.match(l?.text ?? '', /HISTÓRICO/);
  }
  assert.equal(line(resultsFixture({ results: [runSummary()] }), true)?.historical, true);
  const unknown = line(resultsFixture({ results: [runSummary({ stale: null, decisionsChanged: null })] }));
  assert.ok(!/coerente/.test(unknown?.text ?? '') && /não foi possível/.test(unknown?.text ?? ''));
  assert.match(line(resultsFixture({ pending: pendingRun() }))?.text ?? '', /NÃO confirmado/);
  assert.match(line(resultsFixture())?.text ?? '', /Nenhum resultado registrado/);
  assert.equal(deriveRegistry(pageReducer(ready(), { type: 'SECTION_FAIL', section: 'results', phase: 'integrity', message: 'm', code: 'X' }), null), null, 'integridade: nenhuma linha de registro');
});
