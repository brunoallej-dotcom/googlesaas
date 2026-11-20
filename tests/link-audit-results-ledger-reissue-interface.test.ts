import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import './helpers/stub-lucide';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { httpApi } from '../src/components/link-audit/audit-page/api';
import * as flow from '../src/components/link-audit/audit-page/controller';
import { LedgerPanel } from '../src/components/link-audit/audit-page/pending-panels';
import type { LedgerInfo, LedgerRunsInfo } from '../src/components/link-audit/audit-page/types';
import { isLedgerActionPayload } from '../src/components/link-audit/audit-page/validators';
import { AUDIT, fail, FakeApi, H, harness, ok } from './helpers/link-audit-audit-page-fixtures';

/*
 * R1.6 — a TELA da reemissão do recibo de resultado (spec do livro §16.17.5: "A tela mostra o botão 'Reemitir recibo do resultado' no painel do livro quando
 * `ledger.runs.receiptReissuable` (a vista do livro continua legível)"; D-R1-2: a resposta é `{ action: 'REISSUE_RECEIPT', ledger }` e `LedgerActionResult.action` passa a
 * `'ENROLL' | 'RECOVER' | 'REISSUE_RECEIPT'`, com o validador estrito). O botão aparece também com o livro `HISTORY_UNRESOLVED` por razão de DECISÃO (a reemissão vale nesse
 * estado) e nunca sem o recibo removido; a ação vai para `POST /api/link-audit/scoring/{auditId}/results` com o corpo exato; depois dela a tela recarrega decisões, prévia e
 * resultados (nunca confia no que mudou).
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const removedRuns: LedgerRunsInfo = { state: 'UNRESOLVED', reason: 'RESULT_RECEIPT_REMOVED', confirmed: [{ runSeq: 1, runSha256: H('a') }], open: null, receiptReissuable: true };
const okRuns: LedgerRunsInfo = { state: 'OK', reason: null, confirmed: [{ runSeq: 1, runSha256: H('a') }], open: null, receiptReissuable: false };
const ledgerWith = (over: Partial<LedgerInfo> = {}): LedgerInfo => ({
  state: 'PROTECTED',
  reason: null,
  head: { ledgerSeq: 5, sha256: H('5') },
  decisionHead: { ledgerSeq: 3, sha256: H('3') },
  confirmedDecisions: 1,
  openOperation: null,
  recoverable: false,
  receiptReissuable: false,
  externalGuard: 'NOT_CONFIGURED',
  runs: removedRuns,
  ...over,
});
const text = (element: ReactElement): string => renderToStaticMarkup(element).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const BUTTON = /Reemitir recibo do resultado/;

/** Os botões que o painel devolve (a árvore do componente, sem DOM): texto e `onClick`/`disabled`. */
function buttonsOf(node: ReactNode): Array<{ label: string; onClick: () => void; disabled: boolean }> {
  const found: Array<{ label: string; onClick: () => void; disabled: boolean }> = [];
  const visit = (value: ReactNode): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isValidElement(value)) return;
    // componentes internos do painel (funções puras, sem estado): expandidos como o React os renderizaria
    if (typeof value.type === 'function') return visit((value.type as (props: unknown) => ReactNode)(value.props));
    const props = value.props as { children?: ReactNode; onClick?: () => void; disabled?: boolean };
    if (value.type === 'button') found.push({ label: renderToStaticMarkup(createElement('span', null, props.children)).replace(/<[^>]+>/g, ''), onClick: props.onClick ?? (() => undefined), disabled: props.disabled === true });
    visit(props.children);
  };
  visit(node);
  return found;
}

test('validador D-R1-2: `{ action: "REISSUE_RECEIPT", ledger }` com a vista estrita é aceito; ação desconhecida ou vista incoerente, recusadas', () => {
  assert.ok(isLedgerActionPayload({ action: 'REISSUE_RECEIPT', ledger: ledgerWith({ runs: okRuns }) }), 'a resposta da reemissão');
  assert.ok(isLedgerActionPayload({ action: 'RECOVER', ledger: ledgerWith({ runs: okRuns }) }), 'as ações de antes continuam');
  assert.equal(isLedgerActionPayload({ action: 'REISSUE', ledger: ledgerWith({ runs: okRuns }) }), false, 'ação desconhecida');
  assert.equal(isLedgerActionPayload({ action: 'REISSUE_RECEIPT', ledger: ledgerWith({ runs: { ...okRuns, receiptReissuable: true } }) }), false, 'reemissão anunciada sem o recibo removido');
  assert.equal(isLedgerActionPayload({ action: 'REISSUE_RECEIPT', ledger: { ...ledgerWith(), state: 'PROTECTED', receiptReissuable: true } }), false, 'receiptReissuable de topo em PROTECTED (é só de decisão)');
  assert.equal(isLedgerActionPayload({ action: 'REISSUE_RECEIPT' }), false, 'sem a vista');
  // revisão da R1.6 (`junin-01`, BLOQUEADOR 1): a resposta de reemissão só é aceita com a família de resultados RESOLVIDA (o servidor só responde 200 assim)
  assert.equal(isLedgerActionPayload({ action: 'REISSUE_RECEIPT', ledger: ledgerWith() }), false, 'reemissão com runs ainda não resolvido');
  assert.equal(isLedgerActionPayload({ action: 'REISSUE_RECEIPT', ledger: ledgerWith({ runs: undefined }) }), false, 'reemissão sem runs');
  assert.ok(isLedgerActionPayload({ action: 'RECOVER', ledger: ledgerWith() }), 'as outras ações continuam aceitando runs não resolvido (é o estado que elas mostram)');
});

test('painel do livro: o botão "Reemitir recibo do resultado" aparece SÓ com runs.receiptReissuable (PROTECTED e HISTORY_UNRESOLVED por razão de decisão), chama a ação REISSUE_RECEIPT e respeita canAct', () => {
  const calls: string[] = [];
  const onAction = (action: string): void => void calls.push(action);
  for (const [label, ledger] of [
    ['PROTECTED', ledgerWith()],
    ['HISTORY_UNRESOLVED por razão de decisão', ledgerWith({ state: 'HISTORY_UNRESOLVED', reason: 'RECEIPT_REMOVED', receiptReissuable: true })],
  ] as const) {
    const html = text(createElement(LedgerPanel, { ledger, canAct: true, onAction }));
    assert.match(html, BUTTON, `${label}: botão presente`);
    assert.match(html, /qualquer operador/i, `${label}: o texto diz quem pode reemitir`);
    const button = buttonsOf(LedgerPanel({ ledger, canAct: true, onAction })).find((b) => BUTTON.test(b.label));
    assert.ok(button && !button.disabled, `${label}: botão habilitado`);
    button.onClick();
    assert.equal(calls[calls.length - 1], 'REISSUE_RECEIPT', `${label}: chama a ação própria`);
    const disabled = buttonsOf(LedgerPanel({ ledger, canAct: false, onAction })).find((b) => BUTTON.test(b.label));
    assert.ok(disabled?.disabled, `${label}: desabilitado sem permissão de agir`);
  }
  for (const [label, runs] of [
    ['runs OK', okRuns],
    ['RESULT_REGRESSED (sem receita)', { ...okRuns, state: 'UNRESOLVED', reason: 'RESULT_REGRESSED' } as LedgerRunsInfo],
    ['sem runs', undefined],
  ] as const) {
    assert.doesNotMatch(text(createElement(LedgerPanel, { ledger: ledgerWith({ runs }), canAct: true, onAction })), BUTTON, label);
  }
});

test('controlador: REISSUE_RECEIPT chama a API, avisa, e recarrega decisões, prévia e RESULTADOS; a recusa LEDGER_ACTION_INVALID é aviso, a de durabilidade é erro', async () => {
  const api = new FakeApi();
  api.ledgerQueue = [ok({ action: 'REISSUE_RECEIPT', ledger: ledgerWith({ runs: okRuns }) })];
  const h = harness(api);
  await flow.runLedgerAction(h.ctx, 'REISSUE_RECEIPT');
  assert.deepEqual(api.calls.filter((call) => call.name === 'ledger').map((call) => call.args), [['REISSUE_RECEIPT']]);
  assert.ok(api.count('decisions') >= 1 && api.count('preview') >= 1 && api.count('results') >= 1, 'recarrega decisões, prévia e resultados');
  assert.equal(h.state().notice?.tone, 'success');
  assert.match(h.state().notice?.text ?? '', /recibo/i);
  api.ledgerQueue = [fail('LEDGER_ACTION_INVALID', 409)];
  await flow.runLedgerAction(h.ctx, 'REISSUE_RECEIPT');
  assert.equal(h.state().notice?.tone, 'warning', 'nada a reemitir (outro operador já reemitiu): aviso, não erro');
  api.ledgerQueue = [fail('RESULT_DURABILITY_UNKNOWN', 503)];
  await flow.runLedgerAction(h.ctx, 'REISSUE_RECEIPT');
  assert.equal(h.state().notice?.tone, 'danger');
});

test('cliente HTTP: REISSUE_RECEIPT vai para POST /api/link-audit/scoring/{auditId}/results com o corpo EXATO; a resposta precisa ser a da MESMA ação', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const reply = (body: unknown) =>
    (globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
  reply({ action: 'REISSUE_RECEIPT', ledger: ledgerWith({ runs: okRuns }) });
  const out = await httpApi.ledger(AUDIT, 'REISSUE_RECEIPT');
  assert.equal(out.kind, 'ok');
  assert.deepEqual([seen[0]?.url, seen[0]?.init.method, seen[0]?.init.body], [`/api/link-audit/scoring/${AUDIT}/results`, 'POST', JSON.stringify({ action: 'REISSUE_RECEIPT' })]);
  reply({ action: 'RECOVER', ledger: ledgerWith({ runs: okRuns }) });
  assert.equal((await httpApi.ledger(AUDIT, 'REISSUE_RECEIPT')).kind, 'malformed', 'resposta de outra ação não é aceita');
  reply({ action: 'RECOVER', ledger: ledgerWith({ runs: okRuns }) });
  await httpApi.ledger(AUDIT, 'RECOVER');
  assert.equal(seen[seen.length - 1]?.url, `/api/link-audit/decisions/${AUDIT}/ledger`, 'inscrever/recuperar continuam no livro das decisões');
});
