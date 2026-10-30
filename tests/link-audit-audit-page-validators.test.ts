import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { httpApi } from '../src/components/link-audit/audit-page/api';
import { isDecisionsPayload, isEvidencePayload, isFinalizePayload, isPreviewPayload, isResultsPayload, isRunDetailPayload } from '../src/components/link-audit/audit-page/validators';
import { AUDIT, decisionDto, decisionsFixture, detailResponse, finalizeSuccess, H, head, pendingRun, previewFixture, resultsFixture, runDetail, runSummary, scoredPreview } from './helpers/link-audit-audit-page-fixtures';

/* Onda 6C, I6 — validação ESTRUTURAL aninhada, falha fechada. Nada de metodologia: só formas, enums, identidade e coerências do contrato. */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const clone = <T,>(value: T): T => structuredClone(value);
type M<T> = readonly [name: string, mutate: (value: T) => void];
function reject<T>(base: () => T, guard: (value: unknown) => boolean, mutations: ReadonlyArray<M<T>>): void {
  assert.ok(guard(base()), 'o ponto de partida é válido');
  for (const [name, mutate] of mutations) {
    const value = base();
    mutate(value);
    assert.equal(guard(value), false, `deveria recusar: ${name}`);
  }
}
const any = (v: unknown): Record<string, any> => v as Record<string, any>;

test('prévia: campos aninhados fora do formato, enums desconhecidos e identidade errada são recusados', () => {
  reject(() => clone(previewFixture()), (v) => isPreviewPayload(v, AUDIT), [
    ['auditId diferente do pedido', (v) => void (any(v).auditId = 'auditoria-outra-0009')],
    ['state desconhecido', (v) => void (any(v).state = 'QUALQUER')],
    ['definitive true', (v) => void (any(v).definitive = true)],
    ['company.located não booleano', (v) => void (any(v).company.located = 'sim')],
    ['integrity.status ausente', (v) => void delete any(v).evidence.integrity.status],
    ['base com hash curto', (v) => void (any(v).evidence.bases[0].contentSha256 = 'abc')],
    ['base sem legacy', (v) => void delete any(v).evidence.bases[0].legacy],
    ['decisions.head malformado', (v) => void (any(v).decisions.head = { seq: 0, sha256: H('a') })],
    ['decisions.count negativo', (v) => void (any(v).decisions.count = -1)],
    ['decisions.pending sem action', (v) => void (any(v).decisions.pending = { seq: 1, decisionId: 'op-0001', revokes: null })],
    ['decisions.held com item inválido', (v) => void (any(v).decisions.held = [{ decisionId: 1 }])],
    ['opção de decisão sem disponibilidade', (v) => void delete any(v).decisionOptions[0].available],
    ['critério sem subcritérios', (v) => void (any(v).criteria[0].subcriteria = 'x')],
    ['subcritério com potential inválido', (v) => void (any(v).criteria[0].subcriteria[0].potential = { halfPoints: 'x' })],
    ['subcritério com pontos não numéricos', (v) => void (any(v).criteria[0].subcriteria[0].obtainedHalfPoints = 'muito')],
    ['bloqueio com severidade desconhecida', (v) => void (any(v).blockers = [{ code: 'X', severity: 'TALVEZ', message: 'm', reasonCode: null, decisionIds: [], subcriterionIds: [] }])],
    ['bloqueio sem mensagem', (v) => void (any(v).blockers = [{ code: 'X', severity: 'BLOCKING', reasonCode: null, decisionIds: [], subcriterionIds: [] }])],
    ['outcome desconhecido', (v) => void (any(v).outcomePreview.outcome = 'TALVEZ')],
    ['cobertura acima de 100', (v) => void (any(v).outcomePreview.coveragePercent = 140)],
    ['cobertura NaN', (v) => void (any(v).outcomePreview.coveragePercent = Number.NaN)],
    ['inconclusivo com nível', (v) => void (any(v).outcomePreview.level = 'PROVISORIO')],
    ['inconclusivo com ÍNDICE (nunca exibir nota em inconclusivo)', (v) => void (any(v).result.index = { decimal2: '50.00', classificationLabel: 'x' })],
    ['inconclusivo com confiança', (v) => void (any(v).result.confidence = { levelLabel: 'Alta' })],
    ['portão sem texto', (v) => void (any(v).result.publication.gates = [{ id: 'X', passed: true }])],
    ['limitação inválida', (v) => void (any(v).result.limitations = [{ code: 1 }])],
    ['calculado sem outcomePreview', (v) => void (any(v).outcomePreview = null)],
    ['calculado sem resultado', (v) => void (any(v).result = null)],
    ['missing inválido', (v) => void (any(v).missing = [{ family: 'X' }])],
    ['finalization.allowed não booleano', (v) => void (any(v).finalization.allowed = 'true')],
    ['expectedInputSha256 malformado', (v) => void (any(v).finalization.expectedInputSha256 = 'xyz')],
    ['expectedHead malformado', (v) => void (any(v).finalization.expectedHead = { seq: 1 })],
  ]);
});

test('prévia: critérios com status NULL (sem resultado do motor) são válidos; decisionOptions de tipo novo não derruba a tela', () => {
  const sem = clone(previewFixture({ state: 'SEM_EVIDENCIA', outcomePreview: null, result: null, finalization: { allowed: false, expectedHead: null, expectedInputSha256: null } }));
  any(sem).criteria.forEach((c: Record<string, unknown>) => void (c.status = null));
  assert.ok(isPreviewPayload(sem, AUDIT));
  const novo = clone(previewFixture());
  any(novo).decisionOptions[0].type = 'TIPO_FUTURO';
  assert.ok(isPreviewPayload(novo, AUDIT), 'só exibição: não derruba');
  const stateless = clone(previewFixture());
  any(stateless).criteria[0].status = 5;
  assert.equal(isPreviewPayload(stateless, AUDIT), false);
});

test('prévia: "pode finalizar" só vale com TUDO coerente (estado, bloqueios, pendência, integridade, head) — senão a resposta inteira é recusada', () => {
  const ok = (): ReturnType<typeof previewFixture> => clone(previewFixture());
  assert.ok(isPreviewPayload(ok(), AUDIT));
  reject(ok, (v) => isPreviewPayload(v, AUDIT), [
    ['allowed com estado não finalizável', (v) => void (any(v).state = 'CALCULADO_NAO_FINALIZAVEL')],
    ['allowed com decisão pendente', (v) => void (any(v).decisions.pending = { seq: 1, action: 'RECORD', decisionId: 'op-0001', revokes: null })],
    ['allowed com finalizable:false', (v) => void (any(v).decisions.finalizable = false)],
    ['allowed com bloqueio BLOCKING', (v) => void (any(v).blockers = [{ code: 'X', severity: 'BLOCKING', message: 'm', reasonCode: null, decisionIds: [], subcriterionIds: [] }])],
    ['allowed sem hash de entrada', (v) => void (any(v).finalization.expectedInputSha256 = null)],
    ['allowed com integridade ≠ OK', (v) => void (any(v).evidence.integrity.status = 'MISMATCH')],
    ['allowed com decisão retida (held) mesmo sem bloqueio', (v) => void (any(v).decisions.held = [{ decisionId: 'op-0001', code: 'DECISION_NOT_SUPPORTED' }])],
    ['allowed com head diferente do da lista', (v) => void (any(v).finalization.expectedHead = head(3, 'c'))],
    ['allowed sem outcome', (v) => void ((any(v).outcomePreview = null), (any(v).state = 'SEM_EVIDENCIA'))],
  ]);
  const withWarning = ok();
  any(withWarning).blockers = [{ code: 'W', severity: 'WARNING', message: 'aviso', reasonCode: null, decisionIds: [], subcriterionIds: [] }];
  assert.ok(isPreviewPayload(withWarning, AUDIT), 'aviso (WARNING) não impede');
  const notAllowed = ok();
  any(notAllowed).finalization.allowed = false;
  any(notAllowed).blockers = [{ code: 'X', severity: 'BLOCKING', message: 'm', reasonCode: null, decisionIds: ['op-0001'], subcriterionIds: [] }];
  assert.ok(isPreviewPayload(notAllowed, AUDIT), 'bloqueado e não permitido é uma resposta legítima');
});

test('prévia pontuada: exige índice com duas casas; PONTUADO sem índice ou sem nível é recusado', () => {
  reject(() => clone(scoredPreview()), (v) => isPreviewPayload(v, AUDIT), [
    ['PONTUADO sem índice', (v) => void (any(v).result.index = null)],
    ['índice sem decimal2', (v) => void (any(v).result.index = { shown: 72 })],
    ['decimal2 fora do formato', (v) => void (any(v).result.index = { decimal2: '71,5' })],
    ['PONTUADO sem nível', (v) => void (any(v).outcomePreview.level = null)],
    ['nível desconhecido', (v) => void (any(v).outcomePreview.level = 'OURO')],
  ]);
});

test('decisões: forma de cada item, status, pendente e coerência (pendente ⇒ não finalizável; "vigentes" só ativas)', () => {
  const base = (): ReturnType<typeof decisionsFixture> => clone(decisionsFixture({ head: head(1), decisions: [decisionDto()], allDecisions: [decisionDto()], history: [{ seq: 1, action: 'RECORD', decisionId: 'op-0001', revokes: null, reason: null, recordedAt: '2026-10-23T10:00:00.000Z', recordedBy: 'ana@empresa.com' }] }));
  reject(base, (v) => isDecisionsPayload(v, AUDIT), [
    ['auditId diferente', (v) => void (any(v).auditId = 'auditoria-outra-0009')],
    ['head malformado', (v) => void (any(v).head = { seq: 1, sha256: 'x' })],
    ['finalizable ausente', (v) => void delete any(v).finalizable],
    ['decisão com id fora do padrão', (v) => void (any(v).decisions[0].decisionId = 'dec-1')],
    ['decisão com status desconhecido', (v) => void (any(v).decisions[0].status = 'ZUMBI')],
    ['decisão vigente com status REVOGADA', (v) => void (any(v).decisions[0].status = 'REVOKED')],
    ['decisão sem registro', (v) => void (any(v).decisions[0].record = null)],
    ['decisão sem recordedBy', (v) => void delete any(v).decisions[0].recordedBy],
    ['histórico com ação inválida', (v) => void (any(v).history[0].action = 'APAGAR')],
    ['pendente confirmada', (v) => void ((any(v).pending = { confirmed: true, seq: 2, action: 'RECORD', decisionId: 'op-0002', revokes: null, supersedes: null, reason: null, record: {}, recordedAt: 'x', recordedBy: 'y' }), (any(v).finalizable = false))],
    ['pendente com finalizable:true', (v) => void (any(v).pending = { confirmed: false, seq: 2, action: 'RECORD', decisionId: 'op-0002', revokes: null, supersedes: null, reason: null, record: {}, recordedAt: 'x', recordedBy: 'y' })],
    ['pendente com ação inválida', (v) => void ((any(v).pending = { confirmed: false, seq: 2, action: 'X', decisionId: null, revokes: null, supersedes: null, reason: null, record: null, recordedAt: 'x', recordedBy: 'y' }), (any(v).finalizable = false))],
  ]);
});

test('resultados: numeração contínua, só o último é mais recente, head = último, pendente = próximo número; hashes e enums válidos', () => {
  const two = (): ReturnType<typeof resultsFixture> => clone(resultsFixture({ results: [runSummary({ seq: 1, superseded: true, stale: null, decisionsChanged: null, contentSha256: H('5') }), runSummary({ seq: 2, contentSha256: H('6') })] }));
  reject(two, (v) => isResultsPayload(v, AUDIT), [
    ['auditId diferente', (v) => void (any(v).auditId = 'auditoria-outra-0009')],
    ['definitive false', (v) => void (any(v).definitive = false)],
    ['numeração com lacuna', (v) => void (any(v).results[1].seq = 3)],
    ['numeração começando em 2', (v) => void ((any(v).results[0].seq = 2), (any(v).results[1].seq = 3))],
    ['dois "mais recentes"', (v) => void (any(v).results[0].superseded = false)],
    ['último marcado como substituído', (v) => void (any(v).results[1].superseded = true)],
    ['stale em resultado antigo', (v) => void (any(v).results[0].stale = false)],
    ['head vazio com resultados', (v) => void (any(v).head = null)],
    ['head de outro registro', (v) => void (any(v).head = head(2, 'f'))],
    ['head com seq errado', (v) => void (any(v).head = { seq: 1, sha256: H('6') })],
    ['pendente com número errado', (v) => void (any(v).pending = pendingRun({ seq: 5 }))],
    ['pendente sem isMine', (v) => void ((any(v).pending = pendingRun({ seq: 3 })), delete any(v).pending.isMine)],
    ['pendente com hash curto', (v) => void (any(v).pending = pendingRun({ seq: 3, inputSha256: 'x' }))],
    ['outcome desconhecido', (v) => void (any(v).results[1].outcome = 'TALVEZ')],
    ['PONTUADO sem nível', (v) => void (any(v).results[1].outcome = 'PONTUADO')],
    ['INCONCLUSIVO com nível', (v) => void (any(v).results[1].level = 'PUBLICAVEL')],
    ['hash do registro inválido', (v) => void (any(v).results[1].contentSha256 = 'x')],
    ['cobertura inválida', (v) => void (any(v).results[1].coveragePercent = 250)],
    ['stale não booleano', (v) => void (any(v).results[1].stale = 'sim')],
    ['currentInputSha256 inválido', (v) => void (any(v).currentInputSha256 = 'x')],
  ]);
  assert.ok(isResultsPayload(clone(resultsFixture({ pending: pendingRun({ seq: 1 }) })), AUDIT), 'só pendente (seq 1) é legítimo');
  assert.ok(!isResultsPayload(clone(resultsFixture({ pending: pendingRun({ seq: 2 }) })), AUDIT), 'pendente sem resultado anterior tem de ser a 1');
});

test('detalhe de resultado: coerência do desfecho (inconclusivo sem índice e com motivo; pontuado com índice e nível), hashes e número pedido', () => {
  const base = (): ReturnType<typeof detailResponse> => clone(detailResponse());
  assert.ok(isRunDetailPayload(base(), AUDIT, 1));
  reject(base, (v) => isRunDetailPayload(v, AUDIT, 1), [
    ['número diferente do pedido', (v) => void (any(v).run.seq = 2)],
    ['auditId diferente', (v) => void (any(v).run.auditId = 'auditoria-outra-0009')],
    ['superseded ausente', (v) => void delete any(v).superseded],
    ['stale inválido', (v) => void (any(v).stale = 'x')],
    ['INCONCLUSIVO sem motivo', (v) => void (any(v).run.inconclusive = null)],
    ['INCONCLUSIVO com nível', (v) => void (any(v).run.level = 'PROVISORIO')],
    ['INCONCLUSIVO com índice', (v) => void (any(v).run.result.index = { decimal2: '10.00' })],
    ['cobertura do motivo inválida', (v) => void (any(v).run.inconclusive.coveragePercent = -3)],
    ['hash do registro inválido', (v) => void (any(v).run.hashes.contentSha256 = 'x')],
    ['impressão digital da régua inválida', (v) => void (any(v).run.versions.rulerFingerprint = 'x')],
    ['resultado ausente', (v) => void (any(v).run.result = null)],
    ['evidência com hash inválido', (v) => void (any(v).run.evidence.bases = [{ ref: 'capture:c0001', kind: 'CAPTURE', observedAt: 'x', contentSha256: 'x' }])],
    ['decisões sem appliedIds', (v) => void delete any(v).run.decisions.appliedIds],
  ]);
  const scored = (): ReturnType<typeof detailResponse> => clone(detailResponse({ run: runDetail({ outcome: 'PONTUADO', level: 'PROVISORIO', inconclusive: null, result: { index: { decimal2: '80.25', classificationLabel: 'Forte' }, confidence: { levelLabel: 'Alta' }, totals: { coveragePercent: 70 }, publication: { gates: [] } } }) }));
  reject(scored, (v) => isRunDetailPayload(v, AUDIT, 1), [
    ['PONTUADO sem índice', (v) => void (any(v).run.result.index = null)],
    ['PONTUADO com motivo de inconclusivo', (v) => void (any(v).run.inconclusive = { reasonCode: 'X', failedGates: [], coveragePercent: 1, minimumCoveragePercent: 40 })],
    ['PONTUADO sem nível', (v) => void (any(v).run.level = null)],
  ]);
});

test('finalização: o head devolvido tem de ser o do próprio registro confirmado; hashes e identidade válidos', () => {
  const base = (): ReturnType<typeof finalizeSuccess> => clone(finalizeSuccess());
  reject(base, (v) => isFinalizePayload(v, AUDIT), [
    ['head de outro registro', (v) => void (any(v).head = head(1, 'f'))],
    ['head com seq diferente', (v) => void (any(v).head = { seq: 2, sha256: H('4') })],
    ['anchored false', (v) => void (any(v).anchored = false)],
    ['definitive false', (v) => void (any(v).definitive = false)],
    ['replayed ausente', (v) => void delete any(v).replayed],
    ['recoveredPending ausente', (v) => void delete any(v).recoveredPending],
    ['stateChanged inválido', (v) => void (any(v).stateChangedAfterFinalization = 'x')],
    ['registro de outra auditoria', (v) => void (any(v).run.auditId = 'auditoria-outra-0009')],
    ['registro sem hash de conteúdo', (v) => void delete any(v).run.hashes.contentSha256],
  ]);
});

test('evidência: identidade, empresa, identificadores e integridade', () => {
  const base = (): Record<string, unknown> => ({ kind: 'EVIDENCE_COLLECTION', auditId: AUDIT, company: { name: 'Padaria', city: 'Cidade', stateCode: 'GO' }, identifiers: { confirmed: [{ type: 'cid', value: '123' }] }, integrity: { status: 'OK' }, source: { label: 'Serper' }, collectedAt: '2026-10-22T12:00:00.000Z' });
  reject(base, (v) => isEvidencePayload(v, AUDIT), [
    ['outro tipo', (v) => void (any(v).kind = 'OUTRO')],
    ['auditId diferente', (v) => void (any(v).auditId = 'auditoria-outra-0009')],
    ['empresa inválida', (v) => void (any(v).company = null)],
    ['identificadores inválidos', (v) => void (any(v).identifiers = { confirmed: [{ type: 1 }] })],
    ['sem integridade', (v) => void delete any(v).integrity],
    ['sem fonte', (v) => void delete any(v).source],
  ]);
});

test('cliente HTTP: resposta 2xx incompatível ⇒ "malformed" (falha fechada), inclusive identidade de OUTRA auditoria; nunca "ok"', async () => {
  const send = (body: unknown): void => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  };
  send({ ...previewFixture(), auditId: 'auditoria-outra-0009' });
  assert.deepEqual(await httpApi.preview(AUDIT), { kind: 'malformed' });
  send({ ...previewFixture(), blockers: [{ code: 'X' }] });
  assert.deepEqual(await httpApi.preview(AUDIT), { kind: 'malformed' });
  send({ ...previewFixture(), state: 'CALCULADO_NAO_FINALIZAVEL' }); // allowed:true + estado não finalizável
  assert.deepEqual(await httpApi.preview(AUDIT), { kind: 'malformed' });
  send(previewFixture());
  assert.equal((await httpApi.preview(AUDIT)).kind, 'ok');
  send(resultsFixture({ results: [runSummary({ seq: 2 })] }));
  assert.deepEqual(await httpApi.results(AUDIT), { kind: 'malformed' });
  send(detailResponse({ run: runDetail({ seq: 7 }) }));
  assert.deepEqual(await httpApi.resultDetail(AUDIT, 1), { kind: 'malformed' }, 'pediu o 1 e veio o 7');
  send(finalizeSuccess({ head: head(1, 'f') }));
  assert.deepEqual(await httpApi.finalize(AUDIT, { expectedHead: null, expectedInputSha256: H('2') }), { kind: 'malformed' });
  send({ anchored: true, replayed: false, head: head(1) });
  assert.equal((await httpApi.decide(AUDIT, { kind: 'CREATE', body: { record: {}, expectedHead: null } })).kind, 'ok');
  send({ anchored: true });
  assert.deepEqual(await httpApi.decide(AUDIT, { kind: 'CREATE', body: { record: {}, expectedHead: null } }), { kind: 'malformed' });
});
