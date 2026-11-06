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
    ['pendente com finalizable:true', (v) => void (any(v).pending = { confirmed: false, entrySha256: 'e'.repeat(64), seq: 2, action: 'RECORD', decisionId: 'op-0002', revokes: null, supersedes: null, reason: null, record: {}, recordedAt: 'x', recordedBy: 'y' })],
    ['pendente com ação inválida', (v) => void ((any(v).pending = { confirmed: false, entrySha256: 'e'.repeat(64), seq: 2, action: 'X', decisionId: null, revokes: null, supersedes: null, reason: null, record: null, recordedAt: 'x', recordedBy: 'y' }), (any(v).finalizable = false))],
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

test('pendências: o contrato de ORIGEM é coerente (falha fechada): isMine/conteúdo/autor só com origem COMPROVADA', () => {
  const unproven = { origin: 'UNPROVEN', originDetail: 'MISSING', isMine: false, outcome: null, level: null, coveragePercent: null, appliedDecisionCount: null } as const;
  assert.ok(isResultsPayload(clone(resultsFixture({ pending: pendingRun(unproven) })), AUDIT), 'não comprovada, com tudo nulo, é legítima');
  reject(() => clone(resultsFixture({ pending: pendingRun() })), (v) => isResultsPayload(v, AUDIT), [
    ['origem desconhecida', (v) => void (any(v).pending.origin = 'TALVEZ')],
    ['origem comprovada com detalhe de falha', (v) => void (any(v).pending.originDetail = 'INVALID')],
    ['sem o campo de origem', (v) => void delete any(v).pending.origin],
    ['isMine não booleano', (v) => void (any(v).pending.isMine = 'sim')],
    ['matchesCurrent inválido', (v) => void (any(v).pending.matchesCurrent = 'talvez')],
    ['cobertura fora de 0–100', (v) => void (any(v).pending.coveragePercent = 150)],
  ]);
  reject(() => clone(resultsFixture({ pending: pendingRun(unproven) })), (v) => isResultsPayload(v, AUDIT), [
    ['isMine=true com origem NÃO comprovada (resposta forjada)', (v) => void (any(v).pending.isMine = true)],
    ['desfecho do arquivo exposto sem origem comprovada', (v) => void (any(v).pending.outcome = 'PONTUADO')],
    ['cobertura exposta sem origem comprovada', (v) => void (any(v).pending.coveragePercent = 80)],
    ['origem não comprovada sem o motivo', (v) => void (any(v).pending.originDetail = null)],
  ]);
  const decision = (over: Record<string, unknown>) => decisionsFixture({ pending: { confirmed: false, entrySha256: 'e'.repeat(64), origin: 'PROVEN', originDetail: null, isMine: true, seq: 1, action: 'RECORD', decisionId: 'op-0001', revokes: null, supersedes: null, reason: null, record: { kind: 'JUDGEMENT' }, recordedAt: '2026-10-30T10:00:00.000Z', recordedBy: 'a@b.com', ...over } as never, finalizable: false });
  assert.ok(isDecisionsPayload(clone(decision({})), AUDIT));
  assert.ok(isDecisionsPayload(clone(decision({ origin: 'UNPROVEN', originDetail: 'INVALID', isMine: false, record: null, recordedBy: null })), AUDIT));
  for (const [name, over] of [
    ['isMine com origem não comprovada', { origin: 'UNPROVEN', originDetail: 'INVALID', isMine: true, recordedBy: null }],
    ['autor exposto sem origem comprovada', { origin: 'UNPROVEN', originDetail: 'INVALID', isMine: false, record: null, recordedBy: 'ana@empresa.com' }],
    ['conteúdo exposto para quem não é o autor', { isMine: false, record: { kind: 'JUDGEMENT' } }],
    ['motivo exposto para quem não é o autor', { isMine: false, record: null, reason: 'texto' }],
    ['origem comprovada sem autor', { recordedBy: null }],
  ] as const) assert.equal(isDecisionsPayload(clone(decision(over as never)), AUDIT), false, name);
});

test('decisões EM DÚVIDA e testemunha estruturada: o contrato é coerente (falha fechada)', () => {
  const pendingRevoke = { confirmed: false, entrySha256: 'e'.repeat(64), origin: 'PROVEN', originDetail: null, isMine: false, seq: 2, action: 'REVOKE', decisionId: null, revokes: 'op-0001', supersedes: null, reason: null, record: null, recordedAt: '2026-10-30T10:00:00.000Z', recordedBy: 'a@b.com' } as never;
  const inDoubt = decisionDto({ decisionId: 'op-0001', status: 'AMBIGUOUS' });
  const ok = decisionsFixture({ pending: pendingRevoke, finalizable: false, allDecisions: [inDoubt], ambiguousDecisionIds: ['op-0001'] });
  assert.ok(isDecisionsPayload(clone(ok), AUDIT), 'a decisão em dúvida está só em allDecisions e é declarada em ambiguousDecisionIds');
  reject(() => clone(ok), (v) => isDecisionsPayload(v, AUDIT), [
    ['em dúvida listada como vigente', (v) => void (any(v).decisions = [{ ...any(v).allDecisions[0] }])],
    ['em dúvida sem declarar o id', (v) => void (any(v).ambiguousDecisionIds = [])],
    ['id declarado sem a decisão marcada', (v) => void (any(v).allDecisions[0].status = 'ACTIVE')],
    ['id malformado', (v) => void (any(v).ambiguousDecisionIds = ['op-1'])],
    ['campo ausente', (v) => void delete any(v).ambiguousDecisionIds],
    ['dúvida SEM pendente', (v) => void ((any(v).pending = null), (any(v).finalizable = true))],
  ]);
  // a TESTEMUNHA (estado estruturado do servidor): valores do contrato e coerências
  const w = (status: string, extra: Record<string, unknown> = {}) =>
    decisionsFixture({ witness: { status, knownHeads: ['NOT_CONFIGURED', 'NOT_REQUIRED', 'UNWITNESSED', 'UNAVAILABLE', 'UNTRUSTED'].includes(status) ? 0 : 1, coveredSeq: null, unwitnessedAffecting: 0 } as never, ...extra });
  assert.ok(isDecisionsPayload(clone(w('CONSISTENT')), AUDIT));
  assert.ok(isDecisionsPayload(clone(w('NOT_REQUIRED')), AUDIT));
  assert.ok(isDecisionsPayload(clone(w('UNWITNESSED')), AUDIT), 'sem testemunha ainda: declarado, não bloqueante');
  // NÃO RESOLVIDOS (todos falham fechado): zero vigentes, tudo em dúvida, não finalizável
  for (const status of ['NOT_CONFIGURED', 'UNAVAILABLE', 'UNTRUSTED', 'HISTORY_DIVERGES']) {
    assert.ok(isDecisionsPayload(clone(w(status, { finalizable: false, allDecisions: [inDoubt], ambiguousDecisionIds: ['op-0001'] })), AUDIT), status);
    reject(() => clone(w(status, { finalizable: false, allDecisions: [inDoubt], ambiguousDecisionIds: ['op-0001'] })), (v) => isDecisionsPayload(v, AUDIT), [[`${status} finalizável`, (v) => void (any(v).finalizable = true)]]);
  }
  assert.ok(isDecisionsPayload(clone(w('RECEIPT_LOST_WITNESSED', { pending: pendingRevoke, finalizable: false, allDecisions: [inDoubt], ambiguousDecisionIds: ['op-0001'] })), AUDIT));
  const active = decisionDto({ decisionId: 'op-0001', status: 'ACTIVE' });
  assert.ok(isDecisionsPayload(clone(w('HISTORY_REGRESSED', { finalizable: false, allDecisions: [inDoubt], ambiguousDecisionIds: ['op-0001'] })), AUDIT), 'não resolvida: zero vigentes, tudo em dúvida, não finalizável');
  reject(() => clone(w('HISTORY_REGRESSED', { finalizable: false, allDecisions: [inDoubt], ambiguousDecisionIds: ['op-0001'] })), (v) => isDecisionsPayload(v, AUDIT), [
    ['não resolvida e finalizável', (v) => void (any(v).finalizable = true)],
    ['não resolvida com decisão vigente', (v) => void ((any(v).decisions = [active]), (any(v).allDecisions = [active]), (any(v).ambiguousDecisionIds = []))],
    ['não resolvida com decisão ACTIVE em allDecisions', (v) => void ((any(v).allDecisions = [active]), (any(v).ambiguousDecisionIds = []))],
    ['status desconhecido', (v) => void (any(v).witness.status = 'TALVEZ')],
    ['campo ausente', (v) => void delete any(v).witness],
    ['knownHeads inválido', (v) => void (any(v).witness.knownHeads = -1)],
  ]);
  reject(() => clone(w('CONSISTENT')), (v) => isDecisionsPayload(v, AUDIT), [
    ['recibo perdido sem pendente', (v) => void (any(v).witness.status = 'RECEIPT_LOST_WITNESSED')],
    ['NOT_REQUIRED com cabeças', (v) => void ((any(v).witness.status = 'NOT_REQUIRED'), (any(v).witness.knownHeads = 2))],
    ['UNWITNESSED com cobertura', (v) => void ((any(v).witness.status = 'UNWITNESSED'), (any(v).witness.knownHeads = 0), (any(v).witness.coveredSeq = 2))],
    ['CONSISTENT sem nenhuma cabeça', (v) => void (any(v).witness.knownHeads = 0)],
    ['cobertura inválida', (v) => void (any(v).witness.coveredSeq = 0)],
    ['contagem sem testemunha negativa', (v) => void (any(v).witness.unwitnessedAffecting = -1)],
  ]);
  // R3-INFO-2: uma operação pendente que REVOGA X nunca deixa X como vigente
  reject(() => clone(ok), (v) => isDecisionsPayload(v, AUDIT), [
    ['pendente REVOKE de op-0001 com op-0001 ACTIVE em decisions', (v) => void ((any(v).decisions = [decisionDto({ decisionId: 'op-0001', status: 'ACTIVE' })]), (any(v).allDecisions = [decisionDto({ decisionId: 'op-0001', status: 'ACTIVE' })]), (any(v).ambiguousDecisionIds = []))],
  ]);
});

test('prévia: a AUTENTICIDADE da coleta é validada e finalizável exige coleta AUTÊNTICA (falha fechada)', () => {
  const base = clone(previewFixture());
  assert.ok(isPreviewPayload(clone(base), AUDIT), 'padrão da fixture: finalizável e autêntica');
  const unproven = (reason: string | null, status = 'UNAUTHENTICATED', missingRefs: string[] = []) => (v: unknown) => void (any(v).evidence.provenance = { status, reason, missingRefs });
  reject(() => clone(base), (v) => isPreviewPayload(v, AUDIT), [
    ['finalizável com coleta NÃO autêntica', unproven('NO_SEAL')],
    ['finalizável sem informação de autenticidade', (v) => void (any(v).evidence.provenance = null)],
    ['campo ausente', (v) => void delete any(v).evidence.provenance],
    ['motivo desconhecido', unproven('TALVEZ')],
    ['autêntica com motivo', unproven('NO_SEAL', 'AUTHENTICATED')],
    ['não autêntica sem motivo', unproven(null)],
    ['status desconhecido', unproven(null, 'MAYBE')],
    ['EVIDENCE_MISSING sem as referências ausentes', unproven('EVIDENCE_MISSING')],
    ['referências ausentes sem EVIDENCE_MISSING', unproven('NO_SEAL', 'UNAUTHENTICATED', ['capture:c0002'])],
    ['referência ausente malformada', unproven('EVIDENCE_MISSING', 'UNAUTHENTICATED', ['../etc/passwd'])],
    ['referências demais', unproven('EVIDENCE_MISSING', 'UNAUTHENTICATED', Array.from({ length: 6 }, (_, i) => `capture:c000${i}`))],
    ['autêntica com referências ausentes', unproven(null, 'AUTHENTICATED', ['capture:c0002'])],
  ]);
  // não finalizável + não autêntica é um estado legítimo (a prévia continua consultável, rotulada)
  const blocked = clone(base);
  any(blocked).state = 'CALCULADO_NAO_FINALIZAVEL';
  any(blocked).finalization = { allowed: false, expectedHead: null, expectedInputSha256: null, latest: null };
  any(blocked).evidence.provenance = { status: 'UNAUTHENTICATED', reason: 'PROOF_NOT_CONFIGURED', missingRefs: [] };
  any(blocked).blockers = [{ code: 'EVIDENCE_PROVENANCE_UNPROVEN', severity: 'BLOCKING', message: 'A origem da coleta NÃO foi comprovada.', reasonCode: 'PROOF_NOT_CONFIGURED', decisionIds: [], subcriterionIds: [] }];
  assert.ok(isPreviewPayload(blocked, AUDIT), JSON.stringify(blocked.finalization));
});

/* ------------------------------------------------------------------------------------------------ livro de cabeças: coerência do contrato */
test('livro: o validador exige coerência — fora de PROTECTED nada vigente/finalizável; PROTECTED sem razão e com cabeça; prévia só finaliza com livro protegido e sem operação aberta', () => {
  const ledger = (over: Record<string, unknown> = {}) => ({ state: 'PROTECTED', reason: null, head: { ledgerSeq: 3, sha256: 'a'.repeat(64) }, confirmedDecisions: 1, openOperation: null, recoverable: false, receiptReissuable: false, externalGuard: 'NOT_CONFIGURED', ...over });
  const withLedger = (over: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ ...JSON.parse(JSON.stringify(decisionsFixture())), ledger: ledger(over), ...extra });
  assert.ok(isDecisionsPayload(withLedger({}), AUDIT), 'protegida e coerente');
  const dto = JSON.parse(JSON.stringify(decisionDto({ decisionId: 'op-0001', status: 'ACTIVE' })));
  // não protegida ⇒ zero vigentes, nada ACTIVE, não finalizável
  for (const state of ['ENROLLMENT_PENDING', 'LEGACY_READ_ONLY'] as const) {
    assert.ok(isDecisionsPayload(withLedger({ state, head: null, confirmedDecisions: 0 }, { finalizable: false }), AUDIT), state);
    assert.ok(!isDecisionsPayload(withLedger({ state, head: null, confirmedDecisions: 0 }, { finalizable: true }), AUDIT), `${state}: finalizável é incoerente`);
    assert.ok(!isDecisionsPayload(withLedger({ state, head: null, confirmedDecisions: 0 }, { finalizable: false, decisions: [dto], allDecisions: [dto] }), AUDIT), `${state}: decisão vigente é incoerente`);
  }
  assert.ok(isDecisionsPayload(withLedger({ state: 'HISTORY_UNRESOLVED', reason: 'KEY_REVOKED', head: null }, { finalizable: false }), AUDIT));
  assert.ok(!isDecisionsPayload(withLedger({ state: 'HISTORY_UNRESOLVED', reason: null, head: null }, { finalizable: false }), AUDIT), 'não resolvida exige razão');
  assert.ok(!isDecisionsPayload(withLedger({ reason: 'KEY_REVOKED' }), AUDIT), 'protegida não tem razão de problema');
  assert.ok(!isDecisionsPayload(withLedger({ head: null }), AUDIT), 'protegida tem cabeça');
  assert.ok(!isDecisionsPayload(withLedger({ state: 'PROTECTED', receiptReissuable: true }), AUDIT), 'recibo reemitível não é estado protegido');
  assert.ok(!isDecisionsPayload(withLedger({ state: 'TALVEZ' }), AUDIT), 'estado desconhecido');
  assert.ok(!isDecisionsPayload(withLedger({ externalGuard: 'OK' }), AUDIT), 'estado da guarda desconhecido');
  assert.ok(!isDecisionsPayload({ ...JSON.parse(JSON.stringify(decisionsFixture())) , ledger: undefined }, AUDIT), 'campo ausente');
  assert.ok(isDecisionsPayload(withLedger({ openOperation: { opId: 'c'.repeat(32), decisionSeq: 2, phase: 'A', ageMs: 5, stale: false } }, { finalizable: false }), AUDIT));
  assert.ok(!isDecisionsPayload(withLedger({ openOperation: { opId: 'c'.repeat(32), decisionSeq: 2, phase: 'A', ageMs: 5, stale: false } }, { finalizable: true }), AUDIT), 'operação aberta ⇒ não finalizável');
  // prévia: "pode finalizar" só com livro protegido e sem operação aberta
  const preview = previewFixture();
  const finalizable = JSON.parse(JSON.stringify(preview));
  assert.ok(isPreviewPayload(finalizable, AUDIT));
  const protectedPreview = JSON.parse(JSON.stringify(preview));
  protectedPreview.decisions.ledger = { state: 'PROTECTED', reason: null, head: { ledgerSeq: 3, sha256: 'a'.repeat(64) }, confirmedDecisions: 1, operationOpen: false, externalGuard: 'NOT_CONFIGURED' };
  assert.ok(isPreviewPayload(protectedPreview, AUDIT));
  for (const bad of [{ state: 'ENROLLMENT_PENDING', reason: null, head: null, confirmedDecisions: 0, operationOpen: false, externalGuard: 'NOT_CONFIGURED' }, { state: 'HISTORY_UNRESOLVED', reason: 'UNTRUSTED', head: null, confirmedDecisions: 0, operationOpen: false, externalGuard: 'NOT_CONFIGURED' }, { ...protectedPreview.decisions.ledger, operationOpen: true }]) {
    const copy = JSON.parse(JSON.stringify(protectedPreview));
    copy.decisions.ledger = bad;
    assert.ok(!isPreviewPayload(copy, AUDIT), `prévia finalizável com livro ${JSON.stringify(bad).slice(0, 60)} é incoerente`);
  }
});

test('livro: capacidade e cobertura são validadas por COERÊNCIA (números inteiros que fecham, nível coerente com o que cabe); resposta incoerente é recusada por inteiro', () => {
  const base = () => JSON.parse(JSON.stringify(decisionsFixture()));
  const ledger = (extra: Record<string, unknown>) => ({ state: 'PROTECTED', reason: null, head: { ledgerSeq: 3, sha256: 'a'.repeat(64) }, confirmedDecisions: 1, openOperation: null, recoverable: false, receiptReissuable: false, externalGuard: 'NOT_CONFIGURED', ...extra });
  const cap = (over: Record<string, unknown>) => ({ maxRecords: 4000, usedRecords: 3000, remainingRecords: 1000, decisionsAvailable: 10, revocationsAvailable: 200, level: 'OK', ...over });
  const accepts = (extra: Record<string, unknown>) => isDecisionsPayload({ ...base(), ledger: ledger(extra) }, AUDIT);
  assert.ok(accepts({}), 'sem os campos novos');
  assert.ok(accepts({ capacity: cap({}) }));
  assert.ok(accepts({ capacity: cap({ level: 'REVOKE_ONLY', decisionsAvailable: 0, revocationsAvailable: 3 }) }));
  assert.ok(accepts({ capacity: cap({ level: 'EXHAUSTED', decisionsAvailable: 0, revocationsAvailable: 0 }) }));
  for (const [label, bad] of [
    ['usado + restante ≠ máximo', cap({ remainingRecords: 999 })],
    ['usado acima do máximo', cap({ usedRecords: 4001, remainingRecords: 0 })],
    ['nível OK sem nenhuma decisão a caber', cap({ decisionsAvailable: 0 })],
    ['REVOKE_ONLY ainda anunciando decisões', cap({ level: 'REVOKE_ONLY', decisionsAvailable: 2, revocationsAvailable: 3 })],
    ['REVOKE_ONLY sem nenhuma revogação', cap({ level: 'REVOKE_ONLY', decisionsAvailable: 0, revocationsAvailable: 0 })],
    ['EXHAUSTED anunciando revogações', cap({ level: 'EXHAUSTED', decisionsAvailable: 0, revocationsAvailable: 1 })],
    ['nível desconhecido', cap({ level: 'QUASE' })],
    ['número fracionário', cap({ decisionsAvailable: 1.5 })],
    ['não é objeto', 'cabe'],
  ] as const) assert.ok(!accepts({ capacity: bad }), `recusa: ${label}`);
  assert.ok(accepts({ keyCoverage: { keyId: 'lk-test-b', covered: true, otherKeyRecords: 0 } }));
  for (const bad of [{ keyId: 'Maiuscula', covered: true, otherKeyRecords: 0 }, { keyId: 'lk-test-b', covered: 'sim', otherKeyRecords: 0 }, { keyId: 'lk-test-b', covered: true, otherKeyRecords: -1 }, 'x']) assert.ok(!accepts({ keyCoverage: bad }), `recusa cobertura ${JSON.stringify(bad)}`);
});
