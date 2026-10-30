import assert from 'node:assert/strict';
import test from 'node:test';
import * as flow from '../src/components/link-audit/audit-page/controller';
import { deriveRegistry } from '../src/components/link-audit/audit-page/status';
import { finalizeEligibility, initialPageState, pageReducer, type PageState } from '../src/components/link-audit/audit-page/state';
import { AUDIT, decisionDto, decisionsFixture, detailResponse, fail, FakeApi, finalizeSuccess, H, harness, head, ok, pendingRun, previewFixture, resultsFixture, runDetail, runSummary } from './helpers/link-audit-audit-page-fixtures';

/* Onda 6C, I5 — fluxos operacionais com API falsa: carregamento independente, finalização, conflitos, pendência e decisões. */
const BODY = { expectedHead: null, expectedInputSha256: H('2') };
async function loaded(api = new FakeApi()) {
  const h = harness(api);
  await flow.loadAll(h.ctx);
  return { api, ...h };
}
const phaseOf = (state: PageState): string => state.finalize.phase;

test('carregamento: quatro leituras independentes, em paralelo, uma vez cada; a falha de uma não derruba as outras', async () => {
  const api = new FakeApi();
  api.q.evidence = [ok({ kind: 'EVIDENCE_COLLECTION' } as never)];
  api.q.decisions = [fail('DECISIONS_STORAGE_UNAVAILABLE', 503)];
  const h = harness(api);
  await flow.loadAll(h.ctx);
  assert.deepEqual(['evidence', 'preview', 'decisions', 'results'].map((name) => api.count(name)), [1, 1, 1, 1]);
  const s = h.state();
  assert.deepEqual([s.evidence.phase, s.preview.phase, s.decisions.phase, s.results.phase], ['ready', 'ready', 'unavailable', 'ready']);
  assert.ok(s.preview.data && s.results.data);
});

test('carregamento: integridade apaga os dados da seção; 401 marca sessão expirada; 403 vira acesso negado; rede/limite viram erro com texto', async () => {
  const api = new FakeApi();
  api.q.preview = [fail('EVIDENCE_INTEGRITY', 409)];
  api.q.results = [{ kind: 'unauthorized' }];
  api.q.decisions = [{ kind: 'forbidden', message: 'Acesso negado.' }];
  api.q.evidence = [{ kind: 'rate_limited', retryAfterSeconds: 12, fromHeader: true }];
  const h = harness(api);
  await flow.loadAll(h.ctx);
  const s = h.state();
  assert.deepEqual([s.preview.phase, s.preview.data, s.decisions.phase, s.unauthorized, s.evidence.phase], ['integrity', null, 'denied', true, 'error']);
  assert.match(s.evidence.message ?? '', /Aguarde 12 s/);
});

test('carregamento: resposta antiga que chega DEPOIS de uma recarga mais nova é descartada', async () => {
  const api = new FakeApi();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  api.q.preview = [async () => (await gate, ok(previewFixture({ state: 'SEM_EVIDENCIA' }))), ok(previewFixture())];
  const h = harness(api);
  const slow = flow.loadSection(h.ctx, 'preview');
  await flow.loadSection(h.ctx, 'preview'); // mais nova termina primeiro
  assert.equal(h.state().preview.data?.state, 'CALCULADO_FINALIZAVEL');
  release();
  await slow;
  assert.equal(h.state().preview.data?.state, 'CALCULADO_FINALIZAVEL', 'a antiga não sobrescreve');
});

/* ------------------------------------------------------------------------------------------------ finalização */
test('finalizar: exige confirmação explícita e o aceite; o pedido é o da prévia EXIBIDA; sucesso só depois de reler e verificar', async () => {
  const { api, ctx, state } = await loaded();
  flow.openFinalize(ctx);
  assert.equal(phaseOf(state()), 'confirming');
  assert.equal(api.count('finalize'), 0, 'abrir a confirmação não envia nada');
  await flow.confirmFinalize(ctx);
  assert.equal(api.count('finalize'), 0, 'sem o aceite marcado nada é enviado');
  ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  api.q.results = [ok(resultsFixture({ results: [runSummary()], head: head(1, '4') }))];
  await flow.confirmFinalize(ctx);
  assert.deepEqual(api.calls.find((call) => call.name === 'finalize')?.args, [BODY]);
  const s = state();
  assert.deepEqual(s.finalize, { phase: 'done', seq: 1, replayed: false, recovered: false, changedAfter: false, verified: true });
  assert.equal(s.notice?.tone, 'success');
  assert.equal(s.detail.seq, 1, 'o resultado verificado foi relido e aberto');
  assert.equal(s.results.data?.results.length, 1);
});

test('finalizar: o estado NUNCA passa por "done" antes da resposta do servidor (sem sucesso antecipado)', async () => {
  const api = new FakeApi();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  api.q.finalize = [async () => (await gate, ok(finalizeSuccess(), 201))];
  const h = await loaded(api);
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  const pending = flow.confirmFinalize(h.ctx);
  await Promise.resolve();
  assert.equal(phaseOf(h.state()), 'submitting');
  assert.equal(h.state().notice, null);
  release();
  await pending;
  assert.equal(phaseOf(h.state()), 'done');
  const phases = h.actions.filter((a) => a.type === 'FINALIZE_SET').map((a) => (a as { flow: { phase: string } }).flow.phase);
  assert.deepEqual(phases, ['confirming', 'submitting', 'verifying', 'done']);
});

test('finalizar: confirmado pelo servidor mas a releitura falha ⇒ "confirmado — verificação pendente", nunca "verificado"', async () => {
  const h = await loaded();
  h.api.q.results = [fail('RESULT_INTEGRITY', 409)];
  h.api.q.detail = [fail('RESULT_INTEGRITY', 409)];
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(h.ctx);
  const s = h.state();
  assert.equal(s.finalize.phase, 'done');
  assert.equal((s.finalize as { verified: boolean }).verified, false);
  assert.equal(s.results.phase, 'integrity');
  assert.equal(s.results.data, null);
  assert.equal(s.notice?.tone, 'warning');
});

test('finalizar: a prévia que mudou com a confirmação aberta cancela o envio (o pedido capturado não é reaproveitado)', async () => {
  const h = await loaded();
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  h.api.q.preview = [ok(previewFixture({ finalization: { allowed: true, expectedHead: null, expectedInputSha256: H('7') } }))];
  await flow.loadSection(h.ctx, 'preview');
  await flow.confirmFinalize(h.ctx);
  assert.equal(h.api.count('finalize'), 0);
  assert.equal(phaseOf(h.state()), 'idle');
  assert.match(h.state().notice?.text ?? '', /prévia mudou/);
});

test('finalizar: não abre sem elegibilidade (bloqueio, pendência, prévia invalidada) e explica o motivo', async () => {
  const h = await loaded();
  h.ctx.dispatch({ type: 'PREVIEW_INVALIDATE', reason: 'mudou' });
  flow.openFinalize(h.ctx);
  assert.equal(phaseOf(h.state()), 'idle');
  assert.match(h.state().notice?.text ?? '', /invalidada/);
  const blocked = await loaded(Object.assign(new FakeApi(), {}));
  blocked.api.q.preview = [ok(previewFixture({ finalization: { allowed: false, expectedHead: null, expectedInputSha256: H('2') } }))];
  await flow.loadSection(blocked.ctx, 'preview');
  flow.openFinalize(blocked.ctx);
  assert.equal(phaseOf(blocked.state()), 'idle');
  assert.equal(blocked.api.count('finalize'), 0);
});

test('finalizar: 409 de mudança (histórico, entrada, evidência) INVALIDA a prévia, fecha a confirmação, recarrega e exige nova confirmação', async () => {
  for (const code of ['HEAD_MISMATCH', 'HISTORY_REGRESSED', 'INPUT_CHANGED', 'EVIDENCE_HASH_CHANGED', 'WEBSITE_DERIVATION_MISMATCH', 'NOT_FINALIZABLE']) {
    const h = await loaded();
    h.api.q.finalize = [fail(code, 409, { blockers: code === 'NOT_FINALIZABLE' ? [{ code: 'DECISION_PENDING', severity: 'BLOCKING', message: 'pendente', reasonCode: null, decisionIds: ['op-0002'], subcriterionIds: [] }] : [] })];
    flow.openFinalize(h.ctx);
    h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
    const before = [h.api.count('preview'), h.api.count('decisions'), h.api.count('results')];
    await flow.confirmFinalize(h.ctx);
    const s = h.state();
    assert.equal(s.finalize.phase, 'conflict', code);
    assert.equal(h.actions.some((a) => a.type === 'PREVIEW_INVALIDATE'), true, code);
    assert.deepEqual([h.api.count('preview') - before[0]!, h.api.count('decisions') - before[1]!, h.api.count('results') - before[2]!], [1, 1, 1], `${code}: nova consulta`);
    assert.equal(s.preview.invalidated, null, 'a prévia NOVA substituiu a invalidada');
    assert.equal(h.api.count('finalize'), 1, 'não reenvia sozinho');
    if (code === 'NOT_FINALIZABLE') assert.equal((s.finalize as unknown as { blockers: unknown[] }).blockers.length, 1);
    flow.openFinalize(h.ctx); // com a prévia nova pode-se abrir de novo; o pedido anterior não foi reaproveitado
    assert.equal(phaseOf(h.state()), 'confirming');
    assert.equal((h.state().finalize as { acknowledged: boolean }).acknowledged, false, 'o aceite anterior não vale para a nova prévia');
  }
});

test('finalizar: RESULT_ANCHOR_PENDING NÃO é sucesso; mostra a pendência e só reenvia o MESMO pedido original', async () => {
  const h = await loaded();
  h.api.q.finalize = [fail('RESULT_ANCHOR_PENDING', 503), ok(finalizeSuccess({ replayed: true, recoveredPending: true }), 200)];
  h.api.q.results = [ok(resultsFixture({ pending: pendingRun() })), ok(resultsFixture({ results: [runSummary()] }))];
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(h.ctx);
  assert.equal(h.state().finalize.phase, 'anchor_pending');
  assert.equal(h.state().notice, null, 'nenhuma mensagem de sucesso');
  assert.equal(h.state().results.data?.pending?.seq, 1, 'a pendente aparece no histórico, à parte');
  // mesmo que a prévia mude agora, o reenvio usa o pedido ORIGINAL
  h.api.q.preview = [ok(previewFixture({ finalization: { allowed: true, expectedHead: head(9, 'e'), expectedInputSha256: H('8') } }))];
  await flow.loadSection(h.ctx, 'preview');
  await flow.retryFinalize(h.ctx);
  const sent = h.api.calls.filter((c) => c.name === 'finalize').map((c) => c.args[0]);
  assert.deepEqual(sent, [BODY, BODY]);
  assert.deepEqual(h.state().finalize, { phase: 'done', seq: 1, replayed: true, recovered: true, changedAfter: false, verified: true });
});

test('finalizar: após o recibo falhar, "Concluir" a partir do histórico reconstrói o pedido SÓ do que a API expõe e só para pendente PRÓPRIA', async () => {
  const mine = await loaded();
  mine.api.q.results = [ok(resultsFixture({ pending: pendingRun({ inputSha256: H('5'), decisionsHead: head(3, 'c') }) })), ok(resultsFixture({ results: [runSummary()] }))];
  await flow.loadSection(mine.ctx, 'results');
  await flow.completePendingRun(mine.ctx);
  assert.deepEqual(mine.api.calls.find((c) => c.name === 'finalize')?.args[0], { expectedHead: head(3, 'c'), expectedInputSha256: H('5') });
  const other = await loaded();
  other.api.q.results = [ok(resultsFixture({ pending: pendingRun({ isMine: false }) }))];
  await flow.loadSection(other.ctx, 'results');
  await flow.completePendingRun(other.ctx);
  assert.equal(other.api.count('finalize'), 0, 'pendente de outro operador nunca é reenviada');
});

test('finalizar: RESULT_PENDING_UNCONFIRMED recarrega o histórico; se a pendente é minha oferece concluir, se não explica que só o autor conclui', async () => {
  const mine = await loaded();
  mine.api.q.finalize = [fail('RESULT_PENDING_UNCONFIRMED', 409)];
  mine.api.q.results = [ok(resultsFixture({ pending: pendingRun() }))];
  flow.openFinalize(mine.ctx);
  mine.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(mine.ctx);
  assert.equal(mine.state().finalize.phase, 'anchor_pending');
  const other = await loaded();
  other.api.q.finalize = [fail('RESULT_PENDING_UNCONFIRMED', 409)];
  other.api.q.results = [ok(resultsFixture({ pending: pendingRun({ isMine: false }) }))];
  flow.openFinalize(other.ctx);
  other.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(other.ctx);
  const f = other.state().finalize;
  assert.ok(f.phase === 'error' && f.request === null && /somente o autor/.test(f.message));
});

test('finalizar: rede e resposta inesperada deixam o desfecho INCERTO e mantêm o pedido para reenvio seguro; acesso negado não', async () => {
  for (const [out, keepsRequest] of [[{ kind: 'network' }, true], [{ kind: 'malformed' }, true], [{ kind: 'forbidden', message: 'Origem não permitida.' }, false]] as const) {
    const h = await loaded();
    h.api.q.finalize = [out as never, ok(finalizeSuccess(), 201)];
    flow.openFinalize(h.ctx);
    h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
    await flow.confirmFinalize(h.ctx);
    const f = h.state().finalize;
    assert.ok(f.phase === 'error', out.kind);
    assert.equal(f.request !== null, keepsRequest, out.kind);
    assert.equal(h.state().notice, null);
    if (keepsRequest) {
      await flow.retryFinalize(h.ctx);
      assert.deepEqual(h.api.calls.filter((c) => c.name === 'finalize').map((c) => c.args[0]), [BODY, BODY], out.kind);
      assert.equal(h.state().finalize.phase, 'done');
    }
  }
});

test('finalizar: falha de integridade do histórico de resultados bloqueia a seção e não reenvia; 401 marca a sessão', async () => {
  const h = await loaded();
  h.api.q.finalize = [fail('RESULT_INTEGRITY', 409)];
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(h.ctx);
  assert.equal(h.state().results.phase, 'integrity');
  assert.equal(h.state().results.data, null);
  const after = h.state().finalize;
  assert.ok(after.phase === 'error' && after.request === null);
  const expired = await loaded();
  expired.api.q.finalize = [{ kind: 'unauthorized' }];
  flow.openFinalize(expired.ctx);
  expired.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(expired.ctx);
  assert.equal(expired.state().unauthorized, true);
});

test('finalizar: stateChangedAfterFinalization=true vira aviso de resultado HISTÓRICO, não sucesso limpo', async () => {
  const h = await loaded();
  h.api.q.finalize = [ok(finalizeSuccess({ stateChangedAfterFinalization: true }), 201)];
  h.api.q.results = [ok(resultsFixture({ results: [runSummary()] }))];
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(h.ctx);
  assert.equal(h.state().notice?.tone, 'warning');
  assert.match(h.state().notice?.text ?? '', /HISTÓRICO/);
});

test('taxa: carregar =4 leituras; finalizar com sucesso = 1 envio + 2 leituras de verificação + 1 prévia (nada de polling)', async () => {
  const h = await loaded();
  const before = h.api.calls.length;
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(h.ctx);
  const names = h.api.calls.slice(before).map((c) => c.name).sort();
  assert.deepEqual(names, ['finalize', 'preview', 'resultDetail', 'results']);
});

/* ------------------------------------------------------------------------------------------------ decisões */
async function withForm(optionKey: 'C2' | 'S4', value = 'COMPATIBLE', justification = 'Conferido no painel e no site pelo operador responsável.', api = new FakeApi()) {
  const h = await loaded(api);
  flow.openForm(h.ctx, optionKey);
  h.ctx.dispatch({ type: 'FORM_FIELD', patch: { value: optionKey === 'C2' ? value : '', justification } });
  return h;
}

test('decisão: o corpo tem só o registro do formulário, supersedes (se houver vigente) e o expectedHead da lista EXIBIDA', async () => {
  const h = await withForm('C2');
  h.api.q.decisions = [ok(decisionsFixture({ head: head(1, 'a'), decisions: [decisionDto()], allDecisions: [decisionDto()] }))];
  await flow.loadSection(h.ctx, 'decisions');
  await flow.submitForm(h.ctx);
  const body = (h.api.calls.find((c) => c.name === 'decide')?.args[0] as { kind: string; body: Record<string, unknown> }).body;
  assert.deepEqual(body, { record: { kind: 'JUDGEMENT', subcriterionId: 'C2', value: 'COMPATIBLE', justification: 'Conferido no painel e no site pelo operador responsável.' }, supersedes: 'op-0001', expectedHead: head(1, 'a') });
  assert.deepEqual(Object.keys(body).sort(), ['expectedHead', 'record', 'supersedes']);
  const s = await withForm('S4');
  await flow.submitForm(s.ctx);
  const sBody = (s.api.calls.find((c) => c.name === 'decide')?.args[0] as { body: Record<string, unknown> }).body;
  assert.deepEqual(sBody.record, { kind: 'NOT_APPLICABLE', subcriterionIds: ['S4'], code: 'BUSINESS_MODEL', justification: 'Conferido no painel e no site pelo operador responsável.' });
  assert.ok(!('supersedes' in sBody));
});

test('decisão: validação local (justificativa curta, juízo ausente, opção indisponível, decisão pendente) não envia nada', async () => {
  const short = await withForm('C2', 'COMPATIBLE', 'curta');
  await flow.submitForm(short.ctx);
  assert.deepEqual([short.api.count('decide'), short.state().form.phase], [0, 'editing']);
  assert.match(short.state().form.fieldErrors.join(' '), /20 caracteres/);
  const noValue = await withForm('C2', '');
  await flow.submitForm(noValue.ctx);
  assert.match(noValue.state().form.fieldErrors.join(' '), /Escolha o juízo/);
  const unavailable = await withForm('C2');
  unavailable.api.q.preview = [ok(previewFixture({ decisionOptions: [{ type: 'JUDGEMENT', subcriterionId: 'C2', code: null, available: false, reasonCode: 'BASIS_MISSING' }] }))];
  await flow.loadSection(unavailable.ctx, 'preview');
  await flow.submitForm(unavailable.ctx);
  assert.match(unavailable.state().form.fieldErrors.join(' '), /não está disponível/);
  const pending = await withForm('C2');
  pending.api.q.decisions = [ok(decisionsFixture({ pending: { confirmed: false, seq: 2, action: 'RECORD', decisionId: 'op-0002', revokes: null, supersedes: null, reason: null, record: { kind: 'JUDGEMENT' }, recordedAt: '2026-10-30T10:00:00.000Z', recordedBy: 'a@b.com' } }))];
  await flow.loadSection(pending.ctx, 'decisions');
  await flow.submitForm(pending.ctx);
  assert.match(pending.state().form.fieldErrors.join(' '), /decisão pendente/);
  for (const h of [short, noValue, unavailable, pending]) assert.equal(h.api.count('decide'), 0);
});

test('decisão: sucesso fecha o formulário, avisa, e recarrega só decisões e prévia', async () => {
  const h = await withForm('C2');
  const before = h.api.calls.length;
  await flow.submitForm(h.ctx);
  assert.equal(h.state().form.phase, 'closed');
  assert.equal(h.state().notice?.tone, 'success');
  assert.deepEqual(h.api.calls.slice(before).map((c) => c.name).sort(), ['decide', 'decisions', 'preview', 'results']);
});

test('decisão: conflito de histórico MANTÉM o rascunho, invalida a prévia, recarrega e não reenvia sozinho', async () => {
  for (const code of ['HEAD_MISMATCH', 'HISTORY_REGRESSED', 'SUPERSEDE_REQUIRED', 'PENDING_UNCONFIRMED']) {
    const h = await withForm('C2');
    h.api.q.decide = [fail(code, 409)];
    await flow.submitForm(h.ctx);
    const s = h.state();
    assert.equal(s.form.phase, 'conflict', code);
    assert.deepEqual([s.form.value, s.form.justification.length > 20], ['COMPATIBLE', true], 'rascunho mantido');
    assert.equal(h.api.count('decide'), 1);
    assert.ok(h.actions.some((a) => a.type === 'PREVIEW_INVALIDATE'));
    assert.equal(h.api.count('decisions'), 2, 'lista recarregada');
  }
});

test('decisão: ANCHOR_PENDING ou rede ⇒ pendente; o reenvio manda o pedido EXATO (mesmo expectedHead), mesmo que a lista tenha mudado', async () => {
  for (const first of [fail('ANCHOR_PENDING', 503), { kind: 'network' as const }]) {
    const h = await withForm('C2');
    h.api.q.decide = [first as never, ok({ anchored: true, replayed: true })];
    await flow.submitForm(h.ctx);
    assert.equal(h.state().form.phase, 'pending');
    h.api.q.decisions = [ok(decisionsFixture({ head: head(7, 'f') }))];
    await flow.loadSection(h.ctx, 'decisions');
    await flow.resendForm(h.ctx);
    const sent = h.api.calls.filter((c) => c.name === 'decide').map((c) => JSON.stringify(c.args[0]));
    assert.equal(sent[0], sent[1], 'o mesmo corpo, byte a byte');
    assert.equal(h.state().form.phase, 'closed');
  }
});

test('decisão: erros de contrato/validação mostram a mensagem e os detalhes saneados; integridade bloqueia a seção', async () => {
  const h = await withForm('C2');
  h.api.q.decide = [fail('CONTRACT_REJECTED', 400, { issues: ['campo x inválido‮'] })];
  await flow.submitForm(h.ctx);
  assert.equal(h.state().form.phase, 'error');
  assert.match(h.state().form.message ?? '', /campo x inválido/);
  assert.ok(!/‮/.test(h.state().form.message ?? ''));
  const i = await withForm('C2');
  i.api.q.decide = [fail('DECISIONS_INTEGRITY', 409)];
  await flow.submitForm(i.ctx);
  assert.equal(i.state().decisions.phase, 'integrity');
  assert.equal(i.state().decisions.data, null);
});

test('decisão registrada na própria tela torna o último resultado HISTÓRICO sem refresh manual (a lista de resultados é relida)', async () => {
  const h = await loaded();
  h.api.q.results = [ok(resultsFixture({ results: [runSummary()] })), ok(resultsFixture({ results: [runSummary({ decisionsChanged: true })] }))];
  await flow.loadSection(h.ctx, 'results');
  assert.match(deriveRegistry(h.state(), null)?.text ?? '', /coerente com o estado atual/);
  flow.openForm(h.ctx, 'S4');
  h.ctx.dispatch({ type: 'FORM_FIELD', patch: { justification: 'Modelo de negócio sem o subcritério S4, conferido pelo operador.' } });
  await flow.submitForm(h.ctx);
  assert.equal(deriveRegistry(h.state(), null)?.historical, true);
});

test('leitura de resultados iniciada DURANTE o envio (ainda em voo) não sobrescreve a lista nova depois da verificação (token)', async () => {
  const h = await loaded();
  let releaseFinalize!: () => void;
  let releaseRead!: () => void;
  const gateF = new Promise<void>((resolve) => (releaseFinalize = resolve));
  const gateR = new Promise<void>((resolve) => (releaseRead = resolve));
  h.api.q.finalize = [async () => (await gateF, ok(finalizeSuccess(), 201))];
  h.api.q.results = [async () => (await gateR, ok(resultsFixture())), ok(resultsFixture({ results: [runSummary()] }))];
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  const sending = flow.confirmFinalize(h.ctx);
  await Promise.resolve();
  const slow = flow.loadSection(h.ctx, 'results'); // leitura antiga (sem o novo registro), ainda em voo
  releaseFinalize();
  await sending;
  assert.equal(h.state().results.data?.results.length, 1);
  releaseRead();
  await slow;
  assert.equal(h.state().results.data?.results.length, 1, 'a leitura antiga foi descartada');
});

test('integridade vinda de um POST é atribuída pelo CÓDIGO: decisões/âncoras ⇒ decisões e prévia; evidências ⇒ evidências e prévia; resultados ⇒ resultados', async () => {
  for (const [code, expected] of [['DECISIONS_INTEGRITY', ['decisions', 'preview']], ['ANCHOR_MISMATCH', ['decisions', 'preview']], ['EVIDENCE_INTEGRITY', ['evidence', 'preview']], ['RESULT_TRUNCATED', ['results']]] as const) {
    const h = await loaded();
    h.api.q.finalize = [fail(code, 409)];
    flow.openFinalize(h.ctx);
    h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
    await flow.confirmFinalize(h.ctx);
    const s = h.state();
    const broken = (['evidence', 'preview', 'decisions', 'results'] as const).filter((name) => s[name].phase === 'integrity');
    assert.deepEqual(broken.sort(), [...expected].sort(), code);
    assert.ok(broken.every((name) => s[name].data === null), `${code}: sem dados`);
  }
});

test('erro inesperado na finalização relê os resultados (pode ter deixado uma pendência); EVIDENCE_REFERENCE_NOT_FOUND invalida a prévia', async () => {
  const a = await loaded();
  a.api.q.finalize = [fail('INTERNAL_ERROR', 500)];
  const before = a.api.count('results');
  flow.openFinalize(a.ctx);
  a.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(a.ctx);
  assert.equal(a.api.count('results') - before, 1);
  const b = await withForm('C2');
  b.api.q.decide = [fail('EVIDENCE_REFERENCE_NOT_FOUND', 409)];
  await flow.submitForm(b.ctx);
  assert.equal(b.state().form.phase, 'conflict');
  assert.ok(b.actions.some((x) => x.type === 'PREVIEW_INVALIDATE'));
});

test('formulário e revogação em "pendente" não aceitam edição (o reenvio é do pedido original)', async () => {
  const h = await withForm('C2');
  h.api.q.decide = [fail('ANCHOR_PENDING', 503)];
  await flow.submitForm(h.ctx);
  const before = h.state().form.justification;
  h.ctx.dispatch({ type: 'FORM_FIELD', patch: { justification: 'texto diferente do pedido original que ficou pendente' } });
  assert.equal(h.state().form.justification, before);
});

test('revogação: exige motivo ≥ 20, envia {revokes, reason, expectedHead}; conflito mantém o motivo; pendente reenvia o mesmo pedido', async () => {
  const h = await loaded();
  h.api.q.decisions = [ok(decisionsFixture({ head: head(1, 'a'), decisions: [decisionDto()], allDecisions: [decisionDto()] }))];
  await flow.loadSection(h.ctx, 'decisions');
  h.ctx.dispatch({ type: 'REVOKE_OPEN', decisionId: 'op-0001' });
  h.ctx.dispatch({ type: 'REVOKE_FIELD', reason: 'curto' });
  await flow.submitRevoke(h.ctx);
  assert.equal(h.api.count('decide'), 0);
  assert.match(h.state().revoke.message ?? '', /20 caracteres/);
  h.ctx.dispatch({ type: 'REVOKE_FIELD', reason: 'Informação conferida e incorreta; decisão desfeita.' });
  h.api.q.decide = [fail('HEAD_MISMATCH', 409), fail('ANCHOR_PENDING', 503), ok({ anchored: true, replayed: false })];
  await flow.submitRevoke(h.ctx);
  assert.equal(h.state().revoke.phase, 'conflict');
  assert.equal(h.state().revoke.reason, 'Informação conferida e incorreta; decisão desfeita.');
  await flow.submitRevoke(h.ctx);
  assert.equal(h.state().revoke.phase, 'pending');
  await flow.resendRevoke(h.ctx);
  assert.equal(h.state().revoke.phase, 'closed');
  const bodies = h.api.calls.filter((c) => c.name === 'decide').map((c) => (c.args[0] as { body: unknown }).body);
  assert.deepEqual(bodies[0], { revokes: 'op-0001', reason: 'Informação conferida e incorreta; decisão desfeita.', expectedHead: head(1, 'a') });
  assert.equal(JSON.stringify(bodies[1]), JSON.stringify(bodies[2]));
});

test('decisão pendente vinda do histórico: o reenvio reconstrói o pedido original (registro/revogação) com o head confirmado', async () => {
  const create = await loaded();
  create.api.q.decisions = [ok(decisionsFixture({ head: head(2, 'b'), pending: { confirmed: false, seq: 3, action: 'RECORD', decisionId: 'op-0003', revokes: null, supersedes: 'op-0001', reason: null, record: { kind: 'JUDGEMENT', subcriterionId: 'C2', value: 'PARTIAL', justification: 'x'.repeat(30) }, recordedAt: '2026-10-30T10:00:00.000Z', recordedBy: 'a@b.com' } }))];
  await flow.loadSection(create.ctx, 'decisions');
  await flow.resendListedPending(create.ctx);
  assert.deepEqual((create.api.calls.find((c) => c.name === 'decide')?.args[0] as { kind: string; body: unknown }), { kind: 'CREATE', body: { record: { kind: 'JUDGEMENT', subcriterionId: 'C2', value: 'PARTIAL', justification: 'x'.repeat(30) }, supersedes: 'op-0001', expectedHead: head(2, 'b') } });
  const revoke = await loaded();
  revoke.api.q.decisions = [ok(decisionsFixture({ head: head(2, 'b'), pending: { confirmed: false, seq: 3, action: 'REVOKE', decisionId: null, revokes: 'op-0001', supersedes: null, reason: 'Motivo da revogação com mais de vinte caracteres.', record: null, recordedAt: '2026-10-30T10:00:00.000Z', recordedBy: 'a@b.com' } }))];
  await flow.loadSection(revoke.ctx, 'decisions');
  await flow.resendListedPending(revoke.ctx);
  assert.deepEqual((revoke.api.calls.find((c) => c.name === 'decide')?.args[0] as { kind: string; body: unknown }), { kind: 'REVOKE', body: { revokes: 'op-0001', reason: 'Motivo da revogação com mais de vinte caracteres.', expectedHead: head(2, 'b') } });
  const lost = await loaded();
  lost.api.q.decisions = [ok(decisionsFixture({ pending: { confirmed: false, seq: 3, action: 'RECORD', decisionId: 'op-0003', revokes: null, supersedes: null, reason: null, record: null, recordedAt: '2026-10-30T10:00:00.000Z', recordedBy: 'a@b.com' } }))];
  await flow.loadSection(lost.ctx, 'decisions');
  await flow.resendListedPending(lost.ctx);
  assert.equal(lost.api.count('decide'), 0, 'sem o registro original nada é inventado');
});

test('resultado: abrir o detalhe lê e verifica; falha de integridade do detalhe bloqueia a seção de resultados', async () => {
  const h = await loaded();
  await flow.selectResult(h.ctx, 1);
  assert.deepEqual([h.state().detail.phase, h.state().detail.data?.run.seq], ['ready', 1]);
  await flow.selectResult(h.ctx, null);
  assert.equal(h.state().detail.phase, 'idle');
  h.api.q.detail = [fail('RESULT_INTEGRITY', 409)];
  await flow.selectResult(h.ctx, 1);
  assert.equal(h.state().detail.phase, 'integrity');
  assert.equal(h.state().results.phase, 'integrity');
  void runDetail;
  void detailResponse;
  void initialPageState;
  void pageReducer;
  void AUDIT;
});

/* ------------------------------------------------------------------------------------------------ 429 na finalização */
function clocked(h: Awaited<ReturnType<typeof loaded>>, start = 1_000_000): { advance: (ms: number) => void } {
  let now = start;
  (h.ctx as { now?: () => number }).now = () => now;
  return { advance: (ms) => void (now += ms) };
}
const limited = (seconds: number, fromHeader = true) => ({ kind: 'rate_limited' as const, retryAfterSeconds: seconds, fromHeader });

test('429: fase própria (não é erro, pendência nem sucesso); o pedido ORIGINAL é preservado; nada é reenviado sozinho; sem aviso de sucesso', async () => {
  const h = await loaded();
  const clock = clocked(h);
  h.api.q.finalize = [limited(42) as never, ok(finalizeSuccess(), 201)];
  const callsBefore = h.api.calls.length;
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(h.ctx);
  const f = h.state().finalize;
  assert.deepEqual(f, { phase: 'rate_limited', request: BODY, until: 1_000_000 + 42_000, seconds: 42, fromHeader: true });
  assert.equal(h.state().notice, null, 'nenhuma mensagem de sucesso');
  assert.equal(h.api.count('finalize'), 1, 'um único envio: nada é reenviado automaticamente');
  assert.deepEqual(h.api.calls.slice(callsBefore).map((c) => c.name), ['finalize'], 'nem recarrega nada: o limitador responde antes de processar');
  assert.equal(h.state().results.data?.pending ?? null, null, 'não é pendência de recibo');
  assert.ok(!['anchor_pending', 'done', 'error', 'conflict'].includes(f.phase));
  void clock;
});

test('429: durante o prazo NENHUM novo envio (nem reenvio nem nova confirmação); depois do prazo só o reenvio MANUAL do MESMO pedido', async () => {
  const h = await loaded();
  const clock = clocked(h);
  h.api.q.finalize = [limited(30) as never, ok(finalizeSuccess(), 201)];
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(h.ctx);
  // dentro do prazo
  clock.advance(10_000);
  await flow.retryFinalize(h.ctx);
  assert.equal(h.api.count('finalize'), 1, 'reenvio bloqueado');
  assert.match(h.state().notice?.text ?? '', /Aguarde o fim do limite/);
  assert.equal(h.state().finalize.phase, 'rate_limited');
  assert.ok(!finalizeEligibility(h.state(), 1_000_000 + 10_000).allowed);
  assert.match(finalizeEligibility(h.state(), 1_000_000 + 10_000).reason ?? '', /Limite de requisições atingido: aguarde cerca de 20 s/);
  flow.openFinalize(h.ctx);
  assert.equal(h.state().finalize.phase, 'rate_limited', 'também não abre nova confirmação');
  // exatamente no vencimento ainda não; depois, sim
  clock.advance(19_999);
  await flow.retryFinalize(h.ctx);
  assert.equal(h.api.count('finalize'), 1);
  clock.advance(1);
  await flow.retryFinalize(h.ctx);
  assert.equal(h.api.count('finalize'), 2);
  assert.deepEqual(h.api.calls.filter((c) => c.name === 'finalize').map((c) => c.args[0]), [BODY, BODY], 'o MESMO corpo, byte a byte');
  assert.equal(h.state().finalize.phase, 'done');
});

test('429: segundo 429 reinicia a espera com o novo prazo; cabeçalho ausente usa o padrão de 60 s e avisa que é estimado', async () => {
  const h = await loaded();
  const clock = clocked(h);
  h.api.q.finalize = [limited(5) as never, limited(60, false) as never, ok(finalizeSuccess(), 201)];
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(h.ctx);
  clock.advance(5_000);
  await flow.retryFinalize(h.ctx);
  const f = h.state().finalize;
  assert.ok(f.phase === 'rate_limited' && f.seconds === 60 && f.fromHeader === false && f.until === 1_005_000 + 60_000);
  assert.equal(h.api.count('finalize'), 2);
  clock.advance(59_999);
  await flow.retryFinalize(h.ctx);
  assert.equal(h.api.count('finalize'), 2);
  clock.advance(1);
  await flow.retryFinalize(h.ctx);
  assert.equal(h.api.count('finalize'), 3);
  assert.equal(h.state().finalize.phase, 'done');
});

test('429 numa decisão: o rascunho é mantido e nada é reenviado sozinho; leituras com 429 viram erro de seção com o tempo', async () => {
  const h = await withForm('C2');
  h.api.q.decide = [limited(20) as never];
  await flow.submitForm(h.ctx);
  assert.equal(h.state().form.phase, 'error');
  assert.match(h.state().form.message ?? '', /Aguarde 20 s/);
  assert.equal(h.api.count('decide'), 1);
  assert.equal(h.state().form.value, 'COMPATIBLE');
  const r = await loaded();
  r.api.q.preview = [limited(15) as never];
  await flow.loadSection(r.ctx, 'preview');
  assert.equal(r.state().preview.phase, 'error');
  assert.match(r.state().preview.message ?? '', /Aguarde 15 s/);
});

/* ------------------------------------------------------------------------------------------------ segunda revisão: guarda única, recuperação e verificação cruzada */
test('429: "Concluir a confirmação" (pendente própria) TAMBÉM não envia durante o prazo (guarda única em submitFinalize)', async () => {
  const h = await loaded();
  const clock = clocked(h);
  h.api.q.results = [ok(resultsFixture({ pending: pendingRun() }))];
  await flow.loadSection(h.ctx, 'results');
  h.api.q.finalize = [limited(30) as never, ok(finalizeSuccess({ replayed: true, recoveredPending: true }), 200)];
  await flow.completePendingRun(h.ctx); // 1º envio ⇒ 429
  assert.equal(h.state().finalize.phase, 'rate_limited');
  clock.advance(5_000);
  await flow.completePendingRun(h.ctx);
  assert.equal(h.api.count('finalize'), 1, 'bloqueado dentro do prazo');
  assert.match(h.state().notice?.text ?? '', /Aguarde o fim do limite/);
  clock.advance(25_000);
  await flow.completePendingRun(h.ctx);
  assert.equal(h.api.count('finalize'), 2);
});

test('envio simultâneo: com um envio em andamento nenhuma outra rota envia (guarda única)', async () => {
  const h = await loaded();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.api.q.finalize = [async () => (await gate, ok(finalizeSuccess(), 201))];
  h.api.q.results = [ok(resultsFixture({ pending: pendingRun() })), ok(resultsFixture({ results: [runSummary()] }))];
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  const first = flow.confirmFinalize(h.ctx);
  await Promise.resolve();
  h.ctx.dispatch({ type: 'SECTION_OK', section: 'results', data: resultsFixture({ pending: pendingRun() }) });
  await flow.completePendingRun(h.ctx);
  await flow.retryFinalize(h.ctx);
  assert.equal(h.api.count('finalize'), 1);
  release();
  await first;
  assert.equal(h.state().finalize.phase, 'done');
});

test('429 numa RECUPERAÇÃO relê os resultados (uma tentativa anterior pode ter deixado pendência); numa primeira tentativa não relê', async () => {
  const h = await loaded();
  clocked(h);
  h.api.q.finalize = [fail('RESULT_ANCHOR_PENDING', 503), limited(10) as never];
  h.api.q.results = [ok(resultsFixture({ pending: pendingRun() }))];
  flow.openFinalize(h.ctx);
  h.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(h.ctx);
  const before = h.api.count('results');
  await flow.retryFinalize(h.ctx);
  assert.equal(h.state().finalize.phase, 'rate_limited');
  assert.equal(h.api.count('results') - before, 1);
});

test('verificado só se o registro confirmado corresponde ao PEDIDO enviado e o detalhe relido tem o mesmo hash', async () => {
  const wrongInput = await loaded();
  wrongInput.api.q.finalize = [ok(finalizeSuccess({ run: runDetail({ hashes: { inputSha256: H('9'), resultSha256: H('3'), contentSha256: H('4'), prevSha256: null } }) }), 201)];
  wrongInput.api.q.results = [ok(resultsFixture({ results: [runSummary()] }))];
  flow.openFinalize(wrongInput.ctx);
  wrongInput.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(wrongInput.ctx);
  assert.equal((wrongInput.state().finalize as { verified: boolean }).verified, false, 'entrada diferente da pedida');
  const wrongDetail = await loaded();
  wrongDetail.api.q.results = [ok(resultsFixture({ results: [runSummary()] }))];
  wrongDetail.api.q.detail = [ok(detailResponse({ run: runDetail({ hashes: { inputSha256: H('2'), resultSha256: H('3'), contentSha256: H('8'), prevSha256: null } }) }))];
  flow.openFinalize(wrongDetail.ctx);
  wrongDetail.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(wrongDetail.ctx);
  assert.equal((wrongDetail.state().finalize as { verified: boolean }).verified, false, 'detalhe com hash diferente do confirmado');
});
