import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import './helpers/stub-lucide';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROVENANCE_STATE_LABELS } from '../src/components/link-audit/audit-page/labels';
import { ResultsPanel } from '../src/components/link-audit/audit-page/results-panel';
import { initialPageState, pageReducer, type PageState } from '../src/components/link-audit/audit-page/state';
import { deriveRegistry } from '../src/components/link-audit/audit-page/status';
import { isResultsPayload, isRunDetailPayload } from '../src/components/link-audit/audit-page/validators';
import type { ProvenanceRecheckOutcome, ProvenanceRecheckPort } from '../src/lib/link-audit-scoring-runs/results';
import type { ScoreRun } from '../src/lib/link-audit-scoring-runs/results-types';
import { AUDIT, detailResponse, resultsFixture, runSummary } from './helpers/link-audit-audit-page-fixtures';
import { registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { bodyOf, buildEvaluation, FakeEvaluator, makeService, OP_A, resultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R2.2 — INTERFACE do estado calculado da proveniência: `provenanceState` (`VERIFIED` | `RECHECK` | `NOT_RECORDED`) obrigatório em cada resumo da lista e no detalhe (validadores
 * estritos, falha fechada); "A reconferir" diz que é preciso revisão humana SEM dizer que o resultado é inválido e não se confunde com a confirmação pelo livro (`LEDGER` /
 * `RECEIPT_ONLY`) nem com falha de integridade; "Proveniência não registrada" para o legado; nada de ids de chave ou hashes da proveniência na tela. Contrato: os payloads REAIS do
 * serviço em cada estado passam pelos validadores.
 */
registerCleanup();

const clone = <T,>(value: T): T => structuredClone(value);
const any = (v: unknown): Record<string, any> => v as Record<string, any>;
const wire = <T,>(value: T): unknown => JSON.parse(JSON.stringify(value));
const render = (element: React.ReactElement): string => renderToStaticMarkup(element);
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const noop = (): void => undefined;
const IDLE = { seq: null, phase: 'idle' as const, data: null, message: null };
function reject<T>(base: () => T, guard: (value: unknown) => boolean, mutations: ReadonlyArray<readonly [string, (value: T) => void]>): void {
  assert.ok(guard(base()), 'o ponto de partida é válido');
  for (const [name, mutate] of mutations) {
    const value = base();
    mutate(value);
    assert.equal(guard(value), false, `deveria recusar: ${name}`);
  }
}

/* ------------------------------------------------------------------ validadores */

test('R2.2 validadores: provenanceState obrigatório em cada resumo (VERIFIED | RECHECK | NOT_RECORDED); fora disso a lista inteira é recusada', () => {
  for (const state of ['VERIFIED', 'RECHECK', 'NOT_RECORDED'] as const) assert.ok(isResultsPayload(clone(resultsFixture({ results: [runSummary({ provenanceState: state })] })), AUDIT), state);
  const two = () => clone(resultsFixture({ results: [runSummary({ seq: 1, superseded: true, stale: null, decisionsChanged: null, provenanceState: 'NOT_RECORDED' }), runSummary({ seq: 2, provenanceState: 'RECHECK' })] }));
  reject(two, (v) => isResultsPayload(v, AUDIT), [
    ['sem provenanceState', (v) => void delete any(v).results[1].provenanceState],
    ['sem provenanceState no substituído', (v) => void delete any(v).results[0].provenanceState],
    ['provenanceState nulo', (v) => void (any(v).results[1].provenanceState = null)],
    ['provenanceState desconhecido', (v) => void (any(v).results[1].provenanceState = 'AUTHENTICATED')],
    ['provenanceState minúsculo', (v) => void (any(v).results[1].provenanceState = 'recheck')],
    ['provenanceState booleano', (v) => void (any(v).results[1].provenanceState = true)],
  ]);
});

test('R2.2 validadores: provenanceState obrigatório no detalhe; o estado do detalhe é o do topo da resposta (não do registro)', () => {
  for (const state of ['VERIFIED', 'RECHECK', 'NOT_RECORDED'] as const) assert.ok(isRunDetailPayload(clone(detailResponse({ provenanceState: state })), AUDIT, 1), state);
  reject(() => clone(detailResponse({ provenanceState: 'RECHECK' })), (v) => isRunDetailPayload(v, AUDIT, 1), [
    ['sem provenanceState', (v) => void delete any(v).provenanceState],
    ['provenanceState nulo', (v) => void (any(v).provenanceState = null)],
    ['provenanceState desconhecido', (v) => void (any(v).provenanceState = 'REVOKED')],
    ['provenanceState só dentro do registro', (v) => {
      any(v).run.provenanceState = any(v).provenanceState;
      delete any(v).provenanceState;
    }],
  ]);
});

/* ------------------------------------------------------------------ tela */

test('R2.2 tela: "A reconferir" com aviso de revisão humana (sem dizer que o resultado é inválido); "Proveniência não registrada" no legado; VERIFIED sem marca; nada de ids ou hashes da proveniência', () => {
  assert.deepEqual(PROVENANCE_STATE_LABELS, { VERIFIED: 'Proveniência conferida', RECHECK: 'A reconferir', NOT_RECORDED: 'Proveniência não registrada' });
  const list = resultsFixture({ results: [runSummary({ seq: 1, superseded: true, stale: null, decisionsChanged: null, provenanceState: 'NOT_RECORDED' }), runSummary({ seq: 2, provenanceState: 'RECHECK' })] });
  const html = render(createElement(ResultsPanel, { results: list, detail: IDLE, changedAfter: null, onSelect: noop }));
  const t = text(html);
  assert.match(t, /A reconferir/);
  assert.match(t, /Proveniência não registrada/);
  assert.match(t, /revisão humana/);
  assert.ok(!/inválid|adulterad|falha de integridade/i.test(t), 'a marca não diz que o resultado é inválido nem que é falha de integridade');
  assert.match(t, /Confirmado pelo livro/, 'a confirmação pelo livro continua dita, separada da proveniência');
  assert.equal((html.match(/Ver detalhe verificado/g) ?? []).length, 2, 'o resultado marcado continua consultável');
  assert.ok(!/ek-|keyIds|headSeal/.test(html));
  // cada marca fica no próprio resultado: s0001 (legado) não é "a reconferir" e s0002 não é "não registrada"
  const items = html.split('<li ').slice(1);
  const s2 = text(items.find((item) => item.includes('s0002')) ?? '');
  const s1 = text(items.find((item) => item.includes('s0001')) ?? '');
  assert.match(s2, /A reconferir/);
  assert.ok(!/Proveniência não registrada/.test(s2));
  assert.match(s1, /Proveniência não registrada/);
  assert.ok(!/A reconferir/.test(s1));
  const verified = text(render(createElement(ResultsPanel, { results: resultsFixture({ results: [runSummary({ provenanceState: 'VERIFIED' })] }), detail: IDLE, changedAfter: null, onSelect: noop })));
  assert.ok(!/A reconferir|Proveniência não registrada|revisão humana/.test(verified), 'estado normal: sem marca');
});

test('R2.2 tela: o detalhe de um resultado "a reconferir" continua exibindo o registro, com o aviso; o legado diz que a proveniência não foi registrada', () => {
  const recheck = resultsFixture({ results: [runSummary({ provenanceState: 'RECHECK' })] });
  const detail = text(render(createElement(ResultsPanel, { results: recheck, detail: { seq: 1, phase: 'ready', data: detailResponse({ provenanceState: 'RECHECK' }), message: null }, changedAfter: null, onSelect: noop })));
  assert.match(detail, /A reconferir/);
  assert.match(detail, /revisão humana/);
  assert.match(detail, /Registro técnico: guarda a constatação/, 'o registro continua exibido');
  assert.ok(!/inválid|nenhum dado é exibido/i.test(detail));
  const legacy = resultsFixture({ results: [runSummary({ provenanceState: 'NOT_RECORDED' })] });
  const old = text(render(createElement(ResultsPanel, { results: legacy, detail: { seq: 1, phase: 'ready', data: detailResponse({ provenanceState: 'NOT_RECORDED' }), message: null }, changedAfter: null, onSelect: noop })));
  assert.match(old, /Proveniência não registrada/);
  assert.match(old, /antes do registro da proveniência/);
});

test('R2.2 faixa de estado: o último registro "a reconferir" não aparece como "coerente com o estado atual"', () => {
  const ready = (results: ReturnType<typeof resultsFixture>): PageState => pageReducer(initialPageState(AUDIT), { type: 'SECTION_OK', section: 'results', data: results });
  const recheck = deriveRegistry(ready(resultsFixture({ results: [runSummary({ provenanceState: 'RECHECK' })] })), null);
  assert.equal(recheck?.tone, 'warning');
  assert.match(recheck?.text ?? '', /A RECONFERIR/);
  assert.match(recheck?.text ?? '', /revisão humana/);
  assert.ok(!/coerente com o estado atual/.test(recheck?.text ?? ''));
  const verified = deriveRegistry(ready(resultsFixture({ results: [runSummary({ provenanceState: 'VERIFIED' })] })), null);
  assert.equal(verified?.tone, 'success');
  assert.match(verified?.text ?? '', /coerente com o estado atual/);
  // a marca vale também para o histórico (o mais recente está "a reconferir" E as decisões mudaram)
  const both = deriveRegistry(ready(resultsFixture({ results: [runSummary({ provenanceState: 'RECHECK', decisionsChanged: true })] })), null);
  assert.match(both?.text ?? '', /A RECONFERIR/);
});

/* ------------------------------------------------------------------ contrato com o serviço real */

test('R2.2 contrato: os payloads REAIS da lista e do detalhe passam pelos validadores nos três estados', async () => {
  const ev = buildEvaluation();
  const e = resultsEnv();
  assert.ok((await makeService(e, new FakeEvaluator(ev)).finalize(OP_A, 'auditoria-res-0001', bodyOf(ev))).ok);
  const run = JSON.parse(fs.readFileSync(path.join(e.base, 'auditoria-res-0001', 's0001.json'), 'utf8')) as ScoreRun;
  const fixed = (outcome: ProvenanceRecheckOutcome): ProvenanceRecheckPort => ({ recheck: async () => outcome });
  const authentic = fixed({ kind: 'CHECKED', revokedKeyIds: [], trust: { status: 'AUTHENTICATED', ...run.evidenceProvenance } });
  const revoked = fixed({ kind: 'CHECKED', revokedKeyIds: [...(run.evidenceProvenance?.keyIds ?? [])], trust: { status: 'AUTHENTICATED', ...run.evidenceProvenance } });
  for (const [port, expected] of [[authentic, 'VERIFIED'], [revoked, 'RECHECK']] as const) {
    const svc = makeService(e, new FakeEvaluator(ev), { provenanceRecheck: port });
    const listed = await svc.list(OP_A, 'auditoria-res-0001');
    const detail = await svc.get(OP_A, 'auditoria-res-0001', 1);
    assert.ok(listed.ok && detail.ok);
    assert.equal(listed.value.results[0]?.provenanceState, expected);
    assert.equal(detail.value.provenanceState, expected);
    assert.ok(isResultsPayload(wire(listed.value), 'auditoria-res-0001'), `lista ${expected}`);
    assert.ok(isRunDetailPayload(wire(detail.value), 'auditoria-res-0001', 1), `detalhe ${expected}`);
  }
  // legado (v1 sem o campo)
  const FIXTURES = path.join(__dirname, 'fixtures', 'link-audit-results-provenance');
  const legacyId = 'auditoria-legado-v1';
  const e2 = resultsEnv();
  for (const [kind, root] of [['results', e2.base], ['anchors', e2.anchors]] as const) {
    fs.mkdirSync(path.join(root, legacyId), { recursive: true });
    for (const name of fs.readdirSync(path.join(FIXTURES, kind, legacyId))) fs.copyFileSync(path.join(FIXTURES, kind, legacyId, name), path.join(root, legacyId, name));
  }
  const svc = makeService(e2, new FakeEvaluator(buildEvaluation({ auditId: legacyId })), { provenanceRecheck: authentic });
  const listed = await svc.list(OP_A, legacyId);
  const detail = await svc.get(OP_A, legacyId, 1);
  assert.ok(listed.ok && detail.ok);
  assert.equal(listed.value.results[0]?.provenanceState, 'NOT_RECORDED');
  assert.ok(isResultsPayload(wire(listed.value), legacyId), 'lista legada');
  assert.ok(isRunDetailPayload(wire(detail.value), legacyId, 1), 'detalhe legado');
});
