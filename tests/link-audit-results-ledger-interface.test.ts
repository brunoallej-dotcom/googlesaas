import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/stub-lucide';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LedgerPanel, PendingRunPanel } from '../src/components/link-audit/audit-page/pending-panels';
import { ResultsPanel } from '../src/components/link-audit/audit-page/results-panel';
import { initialPageState } from '../src/components/link-audit/audit-page/state';
import type { LedgerInfo } from '../src/components/link-audit/audit-page/types';
import { isDecisionsPayload, isLedgerActionPayload, isResultsPayload, isRunDetailPayload } from '../src/components/link-audit/audit-page/validators';
import { AUDIT, decisionsFixture, detailResponse, H, pendingRun, resultsFixture, runSummary } from './helpers/link-audit-audit-page-fixtures';

/*
 * R1.5 — INTERFACE das leituras pelo livro (spec §16.17.9; D-18, D-23; pendência D-R1-6): os validadores da tela recusam por inteiro (falha fechada) o que o contrato novo não
 * permite — `confirmation` obrigatório na lista e no detalhe, `receipt` MISSING|PRESENT na pendente (PRESENT nunca com RECEIPT_ONLY), `runs` e `decisionHead` da vista do livro
 * coerentes (kid de origem só como id público, só em B/C) — e a tela diz o que cada estado significa: "confirmado pelo livro" × "confirmado só por recibo, sem prova do livro",
 * pendente com recibo e sem a confirmação do livro, razões novas e o resultado em andamento com o kid de origem.
 */
const clone = <T,>(value: T): T => structuredClone(value);
const any = (v: unknown): Record<string, any> => v as Record<string, any>;
function reject<T>(base: () => T, guard: (value: unknown) => boolean, mutations: ReadonlyArray<readonly [string, (value: T) => void]>): void {
  assert.ok(guard(base()), 'o ponto de partida é válido');
  for (const [name, mutate] of mutations) {
    const value = base();
    mutate(value);
    assert.equal(guard(value), false, `deveria recusar: ${name}`);
  }
}
const render = (element: React.ReactElement): string => renderToStaticMarkup(element);
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/* ------------------------------------------------------------------ validadores */

test('lista de resultados: confirmation obrigatório (LEDGER | RECEIPT_ONLY); pendente com receipt MISSING ou PRESENT; PRESENT nunca com RECEIPT_ONLY', () => {
  const one = () => clone(resultsFixture({ results: [runSummary()] }));
  assert.ok(isResultsPayload(one(), AUDIT));
  assert.ok(isResultsPayload(clone(resultsFixture({ results: [runSummary()], confirmation: 'RECEIPT_ONLY' })), AUDIT), 'legado / sem livro');
  assert.ok(isResultsPayload(clone(resultsFixture({ pending: pendingRun({ receipt: 'PRESENT' }) })), AUDIT), 'fase C do livro');
  reject(one, (v) => isResultsPayload(v, AUDIT), [
    ['sem confirmation', (v) => void delete any(v).confirmation],
    ['confirmation desconhecida', (v) => void (any(v).confirmation = 'LIVRO')],
    ['confirmation nula', (v) => void (any(v).confirmation = null)],
  ]);
  reject(() => clone(resultsFixture({ pending: pendingRun({ receipt: 'PRESENT' }) })), (v) => isResultsPayload(v, AUDIT), [
    ['receipt desconhecido', (v) => void (any(v).pending.receipt = 'TALVEZ')],
    ['PRESENT com RECEIPT_ONLY (sem livro, recibo = confirmação: nunca há pendente com recibo)', (v) => void (any(v).confirmation = 'RECEIPT_ONLY')],
  ]);
});

test('detalhe de resultado: confirmation obrigatório e só LEDGER | RECEIPT_ONLY', () => {
  const base = () => clone(detailResponse());
  assert.ok(isRunDetailPayload(base(), AUDIT, 1));
  assert.ok(isRunDetailPayload(clone(detailResponse({ confirmation: 'RECEIPT_ONLY' })), AUDIT, 1));
  reject(base, (v) => isRunDetailPayload(v, AUDIT, 1), [
    ['sem confirmation', (v) => void delete any(v).confirmation],
    ['confirmation desconhecida', (v) => void (any(v).confirmation = 'OK')],
  ]);
});

const protectedLedger = (over: Partial<LedgerInfo> = {}): LedgerInfo => ({
  state: 'PROTECTED',
  reason: null,
  head: { ledgerSeq: 5, sha256: H('5') },
  decisionHead: { ledgerSeq: 3, sha256: H('3') },
  confirmedDecisions: 1,
  openOperation: null,
  recoverable: false,
  receiptReissuable: false,
  externalGuard: 'NOT_CONFIGURED',
  runs: { state: 'OK', reason: null, confirmed: [{ runSeq: 1, runSha256: H('a') }], open: { runOpId: 'b'.repeat(32), runSeq: 2, runSha256: H('b'), phase: 'C', ageMs: 1000, stale: false, recoverable: true, originKid: 'ok-test-a' }, receiptReissuable: false },
  ...over,
});

test('vista do livro na tela: runs e decisionHead coerentes (kid de origem só como id público e só em B/C; razões de resultado no lugar certo); qualquer incoerência recusa a resposta inteira', () => {
  const decisions = (ledger: LedgerInfo) => clone(decisionsFixture({ head: { seq: 1, sha256: H('d') }, ledger }));
  assert.ok(isDecisionsPayload(decisions(protectedLedger()), AUDIT));
  assert.ok(isDecisionsPayload(decisions(protectedLedger({ runs: undefined, decisionHead: undefined })), AUDIT), 'campos novos ausentes continuam válidos (vista sem livro lido)');
  assert.ok(isDecisionsPayload(decisions(protectedLedger({ runs: { state: 'UNRESOLVED', reason: 'RESULT_RECEIPT_REMOVED', confirmed: [{ runSeq: 1, runSha256: H('a') }], open: null, receiptReissuable: true } })), AUDIT));
  assert.ok(isDecisionsPayload(clone(decisionsFixture({ finalizable: false, ledger: { ...protectedLedger(), state: 'HISTORY_UNRESOLVED', reason: 'UNLEDGERED_RESULT', runs: undefined } })), AUDIT), 'contradição de resultado: sem runs');
  reject(() => decisions(protectedLedger()), (v) => isDecisionsPayload(v, AUDIT), [
    ['kid de origem fora do formato de id', (v) => void (any(v).ledger.runs.open.originKid = 'Chave Com Espaço')],
    ['kid de origem que parece material de chave', (v) => void (any(v).ledger.runs.open.originKid = 'a'.repeat(64))],
    ['kid de origem na fase A', (v) => void (any(v).ledger.runs.open.phase = 'A')],
    ['fase desconhecida', (v) => void (any(v).ledger.runs.open.phase = 'D')],
    ['runOpId malformado', (v) => void (any(v).ledger.runs.open.runOpId = 'xyz')],
    ['operação aberta que não é a próxima', (v) => void (any(v).ledger.runs.open.runSeq = 5)],
    ['confirmados fora de ordem', (v) => void (any(v).ledger.runs.confirmed = [{ runSeq: 2, runSha256: H('a') }])],
    ['hash de confirmado curto', (v) => void (any(v).ledger.runs.confirmed[0].runSha256 = 'abc')],
    ['estado OK com razão', (v) => void (any(v).ledger.runs.reason = 'RESULT_REGRESSED')],
    ['UNRESOLVED sem razão', (v) => void (any(v).ledger.runs.state = 'UNRESOLVED')],
    ['razão de resultado que congela tudo dentro de runs', (v) => void ((any(v).ledger.runs.state = 'UNRESOLVED'), (any(v).ledger.runs.reason = 'UNLEDGERED_RESULT'))],
    ['reemissão anunciada sem recibo removido', (v) => void (any(v).ledger.runs.receiptReissuable = true)],
    ['receita anunciada com runs não resolvido', (v) => void ((any(v).ledger.runs.state = 'UNRESOLVED'), (any(v).ledger.runs.reason = 'RESULT_REGRESSED'))],
    ['decisionHead à frente da cabeça do livro', (v) => void (any(v).ledger.decisionHead = { ledgerSeq: 9, sha256: H('9') })],
    ['decisionHead malformado', (v) => void (any(v).ledger.decisionHead = { ledgerSeq: 0, sha256: H('9') })],
    ['PROTECTED com decisionHead nulo', (v) => void (any(v).ledger.decisionHead = null)],
  ]);
  // runs só existe com o livro lido e autenticado: nunca no legado, na inscrição pendente ou sem livro
  for (const state of ['NOT_REQUIRED', 'LEGACY_READ_ONLY', 'ENROLLMENT_PENDING'] as const) {
    const ledger = { ...protectedLedger(), state, reason: state === 'LEGACY_READ_ONLY' ? 'LEDGER_ABSENT_WITH_HISTORY' : null, head: null, decisionHead: null, confirmedDecisions: 0 };
    const finalizable = state === 'NOT_REQUIRED'; // fora de PROTECTED/NOT_REQUIRED nada é finalizável (contrato da 6B)
    assert.equal(isDecisionsPayload(clone(decisionsFixture({ finalizable, ledger })), AUDIT), false, `${state} com runs`);
    assert.equal(isDecisionsPayload(clone(decisionsFixture({ finalizable, ledger: { ...ledger, runs: undefined } })), AUDIT), true, `${state} sem runs`);
  }
  // as três contradições de resultado congelam tudo: nunca convivem com runs
  for (const reason of ['UNLEDGERED_RESULT', 'RESULT_DIVERGES', 'RESULT_PUBLISHED_AFTER_ABORT']) {
    assert.equal(isDecisionsPayload(clone(decisionsFixture({ finalizable: false, ledger: { ...protectedLedger(), state: 'HISTORY_UNRESOLVED', reason, runs: { state: 'OK', reason: null, confirmed: [], open: null, receiptReissuable: false } } })), AUDIT), false, reason);
  }
  assert.ok(isLedgerActionPayload({ action: 'RECOVER', ledger: protectedLedger() }), 'a resposta das ações do livro usa a mesma vista');
});

/* ------------------------------------------------------------------ textos da tela */

test('painel de resultados: "Confirmado pelo livro" com LEDGER; com RECEIPT_ONLY, "confirmado só por recibo, sem prova do livro" (nunca o selo de confirmado pelo livro)', () => {
  const props = { detail: initialPageState(AUDIT).detail, changedAfter: null, onSelect: () => undefined };
  const ledger = text(render(createElement(ResultsPanel, { ...props, results: resultsFixture({ results: [runSummary()] }) })));
  assert.match(ledger, /Confirmado pelo livro/);
  assert.doesNotMatch(ledger, /só por recibo/);
  const receipt = text(render(createElement(ResultsPanel, { ...props, results: resultsFixture({ results: [runSummary()], confirmation: 'RECEIPT_ONLY' }) })));
  assert.match(receipt, /só por recibo/);
  assert.match(receipt, /sem prova do livro/);
  assert.doesNotMatch(receipt, /Confirmado pelo livro/);
});

test('pendente com recibo PRESENTE (fase C do livro): a tela não diz "sem recibo", diz que falta a confirmação do livro e que isso NÃO é confirmação; MISSING continua "sem recibo"', () => {
  const props = { detail: initialPageState(AUDIT).detail, changedAfter: null, onSelect: () => undefined };
  const present = text(render(createElement(ResultsPanel, { ...props, results: resultsFixture({ pending: pendingRun({ receipt: 'PRESENT' }) }) })));
  assert.match(present, /livro de cabeças/);
  assert.doesNotMatch(present, /sem recibo/i);
  const missing = text(render(createElement(ResultsPanel, { ...props, results: resultsFixture({ pending: pendingRun() }) })));
  assert.match(missing, /sem recibo/i);
  const panelPresent = text(render(createElement(PendingRunPanel, { pending: pendingRun({ receipt: 'PRESENT' }), busy: false, onComplete: () => undefined })));
  assert.match(panelPresent, /recibo existe/i);
  assert.match(panelPresent, /livro de cabeças/);
  assert.match(panelPresent, /não é uma confirmação/);
  assert.doesNotMatch(panelPresent, /Falta apenas o recibo/);
  const panelMissing = text(render(createElement(PendingRunPanel, { pending: pendingRun(), busy: false, onComplete: () => undefined })));
  assert.match(panelMissing, /sem recibo/i);
});

test('painel do livro: as três razões novas têm texto próprio; o resultado em andamento (B/C) diz a fase e o kid PÚBLICO da chave de origem; runs não resolvido é dito', () => {
  for (const [reason, pattern] of [
    ['UNLEDGERED_RESULT', /resultado .*nunca registrou/],
    ['RESULT_DIVERGES', /resultado difere/],
    ['RESULT_PUBLISHED_AFTER_ABORT', /publicado depois .*abortada/],
  ] as const) {
    const html = text(render(createElement(LedgerPanel, { ledger: { ...protectedLedger(), state: 'HISTORY_UNRESOLVED', reason, runs: undefined }, canAct: true, onAction: () => undefined })));
    assert.match(html, pattern, reason);
    assert.doesNotMatch(html, /a integridade do livro não pôde ser estabelecida/, `${reason}: não cai no texto genérico`);
  }
  const open = text(render(createElement(LedgerPanel, { ledger: protectedLedger(), canAct: true, onAction: () => undefined })));
  assert.match(open, /s0002/);
  assert.match(open, /ok-test-a/, 'o kid de origem (id público) aparece para o portão do runbook');
  assert.match(open, /só o autor/);
  const removed = text(render(createElement(LedgerPanel, { ledger: protectedLedger({ runs: { state: 'UNRESOLVED', reason: 'RESULT_RECEIPT_REMOVED', confirmed: [{ runSeq: 1, runSha256: H('a') }], open: null, receiptReissuable: true } }), canAct: true, onAction: () => undefined })));
  assert.match(removed, /recibo de um resultado já confirmado/);
  const regressed = text(render(createElement(LedgerPanel, { ledger: protectedLedger({ runs: { state: 'UNRESOLVED', reason: 'RESULT_REGRESSED', confirmed: [{ runSeq: 1, runSha256: H('a') }], open: null, receiptReissuable: false } }), canAct: true, onAction: () => undefined })));
  assert.match(regressed, /não está mais na pasta de resultados/);
});
