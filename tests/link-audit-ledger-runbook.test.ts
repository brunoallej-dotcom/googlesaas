import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/stub-lucide';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as route from '../src/app/api/link-audit/decisions/[auditId]/ledger/route';
import { GET as listRoute, POST as createRoute } from '../src/app/api/link-audit/decisions/[auditId]/route';
import { LedgerPanel } from '../src/components/link-audit/audit-page/pending-panels';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';
import { ANA, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { applyLedgerEnv, decisionsOver, ledgerEvents, ledgerFor, ledgerRecords, LEDGER_KEY_A, LEDGER_KEY_B, NO_RESULTS, routeWorld, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';
import { resultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R7-03 — O RUNBOOK (`onda6c-runbook-chaves.md` §7, ROTAÇÃO PLANEJADA) executado EXATAMENTE como está escrito, pelas ROTAS reais e em pastas temporárias isoladas:
 *   (1)(2) troca a configuração (chave nova atual, antiga aposentada); (3) `POST …/decisions/{auditId}/ledger {"action":"RECOVER"}` em cada auditoria — NÃO existe botão para isso
 *   quando só a rotação está pendente (o botão "Recuperar" é de operação PARADA); o operador confere `ledger.keyCoverage.covered`; (4) só então remove a antiga.
 * Também prova o que o runbook diz que NÃO funciona (remover a antiga sem o passo 3) e a fase B (decisão publicada sem recibo) no meio da rotação. Nenhuma permissão administrativa
 * é simulada: RECOVER é a mesma ação de operador que sempre existiu (verificável e idempotente).
 */
registerCleanup();
const SECRET = 'service-role-key-de-teste-0123456789';
const env = process.env as Record<string, string | undefined>;
let seq = 0;
const operator = async (): Promise<string> => `${SESSION_COOKIE}=${await createSessionToken(`ledger${seq++}@empresa.com`, SECRET)}`;
const ctx = (auditId: string) => ({ params: Promise.resolve({ auditId }) });
const url = (auditId: string, suffix = ''): string => `http://app.local/api/link-audit/decisions/${auditId}${suffix}`;
const post = (target: string, cookie: string, body: unknown) => new Request(target, { method: 'POST', headers: { host: 'app.local', cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const json = async (r: Response): Promise<Record<string, any>> => (await r.json()) as Record<string, any>;
const day = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

function setEnv(w: LedgerWorld, ledger: { current: string; retired?: string }): void {
  const results = resultsEnv();
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = Array.from({ length: 50 }, (_, i) => `ledger${i}@empresa.com`).join(',');
  delete env.GMN_AUTH_DISABLED;
  env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
  env.GMN_LINK_AUDIT_EVIDENCE_DIR = w.evidenceDir;
  env.GMN_LINK_AUDIT_DECISIONS_DIR = w.decisionsDir;
  env.GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR = w.anchorDir;
  env.GMN_LINK_AUDIT_RESULTS_DIR = results.base;
  env.GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR = results.anchors;
  applyLedgerEnv(env, w, ledger.current);
  if (ledger.retired) env.GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS = ledger.retired;
}
const kids = async (w: LedgerWorld): Promise<string[]> => (await ledgerRecords(w)).map((r) => `${r.event}:${r.origin.kid.slice(-1)}`);
const recover = (w: LedgerWorld, cookie: string) => route.POST(post(url(w.auditId, '/ledger'), cookie, { action: 'RECOVER' }), ctx(w.auditId));
const view = async (w: LedgerWorld, cookie: string) => json(await listRoute(new Request(url(w.auditId), { headers: { host: 'app.local', cookie } }), ctx(w.auditId)));

async function protectedWithOneDecision(): Promise<{ w: LedgerWorld; cookie: string }> {
  const w = await routeWorld();
  setEnv(w, { current: LEDGER_KEY_A });
  const cookie = await operator();
  const head = (await view(w, cookie)).head;
  const created = await createRoute(post(url(w.auditId), cookie, { record: rec.c2(), expectedHead: head }), ctx(w.auditId));
  assert.ok([200, 201].includes(created.status), JSON.stringify(await json(created)).slice(0, 200));
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CONFIRMED:a']);
  return { w, cookie };
}

test('RUNBOOK §7 passo a passo pelas rotas: a rotação aparece como NÃO coberta, a tela NÃO tem botão, o RECOVER pela API grava UM CHECKPOINT da chave nova, repetir não grava nada e só então a chave antiga pode sair', async () => {
  const { w, cookie } = await protectedWithOneDecision();
  // (1)(2) a configuração muda: chave nova atual, antiga aposentada com validade
  setEnv(w, { current: LEDGER_KEY_B, retired: `${LEDGER_KEY_A}:${day(30)}` });
  const before = await view(w, cookie);
  assert.deepEqual([before.ledger.state, before.ledger.keyCoverage.covered, before.ledger.keyCoverage.otherKeyRecords], ['PROTECTED', false, 3], 'o operador enxerga a rotação sem cobertura (campo ledger.keyCoverage.covered)');
  assert.equal(before.ledger.recoverable, false, 'não há operação parada: o botão "Recuperar" da tela NÃO aparece');
  const markup = renderToStaticMarkup(createElement(LedgerPanel, { ledger: before.ledger, canAct: true, onAction: () => undefined }));
  assert.ok(!/<button/.test(markup), 'a tela não oferece botão algum para a rotação (o runbook não pode mandar clicar)');
  assert.match(markup, /RECOVER/, 'a tela diz o que fazer: executar a recuperação (RECOVER) da auditoria');

  // (3) POST …/ledger {"action":"RECOVER"}
  const first = await recover(w, cookie);
  assert.equal(first.status, 200, JSON.stringify(await json(first)).slice(0, 200));
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CONFIRMED:a', 'CHECKPOINT:b'], 'UM CHECKPOINT assinado pela chave NOVA');
  const covered = await view(w, cookie);
  assert.equal(covered.ledger.keyCoverage.covered, true, 'o operador confere o resultado no mesmo campo');
  const events = await ledgerEvents(w);
  assert.equal((await recover(w, cookie)).status, 200);
  assert.deepEqual(await ledgerEvents(w), events, 'repetir é idempotente: nenhum registro novo');

  // (4) a antiga sai da configuração (depois de TODAS as auditorias cobertas): a auditoria segue protegida
  setEnv(w, { current: LEDGER_KEY_B });
  const after = await view(w, cookie);
  assert.deepEqual([after.ledger.state, after.decisions.length], ['PROTECTED', 1]);
});

test('RUNBOOK: pular o passo 3 e remover a chave antiga deixa a auditoria NÃO resolvida (KEY_UNKNOWN) — é por isso que o passo 3 não é opcional', async () => {
  const { w, cookie } = await protectedWithOneDecision();
  setEnv(w, { current: LEDGER_KEY_B }); // a antiga some SEM o CHECKPOINT da nova
  const body = await view(w, cookie);
  assert.deepEqual([body.ledger.state, body.ledger.reason], ['HISTORY_UNRESOLVED', 'KEY_UNKNOWN']);
  assert.deepEqual(body.decisions, [], 'nenhuma decisão é considerada vigente');
});

test('RUNBOOK com operação aberta na FASE B (decisão publicada, recibo ainda não): o RECOVER da rotação funciona pela rota, grava o CHECKPOINT e NÃO conclui nem apaga a pendência — o autor conclui depois com a chave nova', async () => {
  const w = await routeWorld();
  setEnv(w, { current: LEDGER_KEY_A });
  const cookie = await operator();
  const noReceipts = faulty({ async writeExclusive(target, data, mode) { if (target.startsWith(w.anchorDir)) throw errno('ENOSPC'); return nodeFsOps.writeExclusive(target, data, mode); } });
  const flaky = decisionsOver(w, { ledger: ledgerFor(w, { guard: null }), knownHeads: NO_RESULTS, fs: noReceipts });
  const pending = await flaky.create(ANA, w.auditId, { record: rec.c2(), expectedHead: null }, () => new Date().toISOString());
  assert.ok(!pending.ok && pending.code === 'ANCHOR_PENDING');
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a']);

  setEnv(w, { current: LEDGER_KEY_B, retired: `${LEDGER_KEY_A}:${day(30)}` });
  const mid = await view(w, cookie);
  assert.deepEqual([mid.ledger.openOperation.phase, mid.ledger.keyCoverage.covered], ['B', false]);
  const done = await recover(w, cookie);
  assert.equal(done.status, 200, JSON.stringify(await json(done)).slice(0, 200));
  assert.deepEqual(await kids(w), ['GENESIS:a', 'INTENT:a', 'CHECKPOINT:b'], 'o CHECKPOINT entra com a operação aberta; a pendência é PRESERVADA (nada concluído em nome do autor)');
  assert.equal((await view(w, cookie)).ledger.keyCoverage.covered, true);
  assert.equal((await view(w, cookie)).ledger.openOperation.phase, 'B');
});
