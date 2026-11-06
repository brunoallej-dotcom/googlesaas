import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as ledgerRouteModule from '../src/app/api/link-audit/decisions/[auditId]/ledger/route';
import { GET as listRoute, POST as createRoute } from '../src/app/api/link-audit/decisions/[auditId]/route';
import { POST as ledgerRoute } from '../src/app/api/link-audit/decisions/[auditId]/ledger/route';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';
import { middleware } from '../src/middleware';
import { hashTree, rec, registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { applyLedgerEnv, ledgerEvents, LEDGER_KEY_A, routeWorld, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';
import { resultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * API do LIVRO (Q1/Q3/Q5): inscrição explícita, recuperação, operações administrativas BLOQUEADAS (403, sem autorização fictícia), escrita sem livro
 * configurado (503, nada gravado), chave do livro igual à de origem, respostas sem caminhos nem material de chave.
 */
registerCleanup();
const SECRET = 'service-role-key-de-teste-0123456789';
const env = process.env as Record<string, string | undefined>;
let operatorSeq = 0;
const operator = async (): Promise<string> => `${SESSION_COOKIE}=${await createSessionToken(`ledger${operatorSeq++}@empresa.com`, SECRET)}`;

/** `ledgerKey: null` = variável da chave AUSENTE (`undefined` acionaria o valor padrão). */
function setEnv(w: LedgerWorld, results = resultsEnv(), ledgerKey: string | null = LEDGER_KEY_A, withLedger = true): void {
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = Array.from({ length: 50 }, (_, i) => `ledger${i}@empresa.com`).join(',');
  delete env.GMN_AUTH_DISABLED;
  env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
  env.GMN_LINK_AUDIT_EVIDENCE_DIR = w.evidenceDir;
  env.GMN_LINK_AUDIT_DECISIONS_DIR = w.decisionsDir;
  env.GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR = w.anchorDir;
  env.GMN_LINK_AUDIT_RESULTS_DIR = results.base;
  env.GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR = results.anchors;
  applyLedgerEnv(env, withLedger ? w : null, ledgerKey ?? LEDGER_KEY_A);
  if (ledgerKey === null) delete env.GMN_LINK_AUDIT_LEDGER_KEY;
}
const ctx = (auditId: string) => ({ params: Promise.resolve({ auditId }) });
const url = (auditId: string, suffix = ''): string => `/api/link-audit/decisions/${auditId}${suffix}`;
function req(target: string, init: { method?: string; cookie?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { host: 'app.local', ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  const hasBody = init.body !== undefined || init.raw !== undefined;
  if (hasBody) headers['content-type'] = 'application/json';
  return new Request(`http://app.local${target}`, { method: init.method ?? 'GET', headers, ...(hasBody ? { body: init.raw ?? JSON.stringify(init.body) } : {}) });
}
const json = async (r: Response): Promise<Record<string, any>> => (await r.json()) as Record<string, any>;
const ledgerPost = (auditId: string, body: unknown, cookie: string | null, extra: { headers?: Record<string, string>; raw?: string; query?: string } = {}) =>
  ledgerRoute(req(url(auditId, '/ledger') + (extra.query ?? ''), { method: 'POST', cookie, body, ...extra }), ctx(auditId));
const list = async (auditId: string, cookie: string) => json(await listRoute(req(url(auditId), { cookie }), ctx(auditId)));
const record = async (auditId: string, cookie: string, expectedHead: unknown, body: Record<string, unknown> = { record: rec.c2() }) =>
  createRoute(req(url(auditId), { method: 'POST', cookie, body: { ...body, expectedHead } }), ctx(auditId));

test('sem sessão ou sem permissão: 401/403 e nada muda; origem cruzada ⇒ 403 CROSS_ORIGIN; o middleware cobre a rota', async () => {
  const w = await routeWorld({ enroll: false });
  setEnv(w);
  const before = hashTree(w.ledgerDir);
  assert.equal((await ledgerPost(w.auditId, { action: 'ENROLL' }, null)).status, 401);
  const bad = `${SESSION_COOKIE}=${await createSessionToken('intruso@fora.com', SECRET)}`;
  assert.equal((await ledgerPost(w.auditId, { action: 'ENROLL' }, bad)).status, 403);
  const ana = await operator();
  for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }] as Array<Record<string, string>>) {
    const r = await ledgerPost(w.auditId, { action: 'ENROLL' }, ana, { headers });
    assert.equal(r.status, 403);
    assert.equal((await json(r)).code, 'CROSS_ORIGIN');
  }
  assert.deepEqual(hashTree(w.ledgerDir), before, 'nada foi gravado');
  const through = await middleware(new (await import('next/server')).NextRequest(`http://app.local${url(w.auditId, '/ledger')}`, { method: 'POST' }));
  assert.equal(through.status, 401, 'o middleware recusa sem sessão antes de chegar à rota');
});

test('inscrição EXPLÍCITA: antes dela a escrita é recusada (409 LEDGER_ENROLLMENT_REQUIRED, nada gravado); ENROLL → 200 PROTECTED; escrever funciona; repetir ENROLL não reinscreve', async () => {
  const w = await routeWorld({ enroll: false });
  setEnv(w);
  const ana = await operator();
  const view = await list(w.auditId, ana);
  assert.deepEqual([view.ledger.state, view.finalizable, view.decisions], ['ENROLLMENT_PENDING', false, []]);
  const refused = await record(w.auditId, ana, null);
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'LEDGER_ENROLLMENT_REQUIRED');
  assert.ok(!fs.existsSync(path.join(w.decisionsDir, w.auditId)), 'nenhuma decisão foi gravada');
  assert.ok(!fs.existsSync(path.join(w.ledgerDir, w.auditId)), 'o livro não nasceu sozinho');
  const enrolled = await ledgerPost(w.auditId, { action: 'ENROLL' }, ana);
  assert.equal(enrolled.status, 200);
  const body = await json(enrolled);
  assert.deepEqual([body.action, body.ledger.state, body.ledger.reason, body.ledger.externalGuard], ['ENROLL', 'PROTECTED', null, 'NOT_CONFIGURED']);
  assert.equal((await record(w.auditId, ana, null)).status, 201);
  const again = await ledgerPost(w.auditId, { action: 'ENROLL' }, ana);
  assert.ok(again.status >= 400, 'não se reinscreve uma auditoria já protegida');
  assert.deepEqual(await ledgerEvents(w), ['GENESIS', 'INTENT', 'CONFIRMED']);
});

test('ADOPT, RESTORE_ACK e QUARANTINE_ACK: 403 ADMIN_APPROVAL_UNAVAILABLE em QUALQUER estado — sem autorização fictícia, o livro não muda', async () => {
  const w = await routeWorld({ enroll: false });
  setEnv(w);
  const ana = await operator();
  const states: Array<() => Promise<void>> = [
    async () => undefined, // a inscrever
    async () => void (await ledgerPost(w.auditId, { action: 'ENROLL' }, ana)), // protegida
    async () => fs.rmSync(path.join(w.ledgerDir, w.auditId), { recursive: true }), // livro sumido (legada/não resolvida)
  ];
  for (const [index, prepare] of states.entries()) {
    await prepare();
    const before = [hashTree(w.ledgerDir), hashTree(w.decisionsDir), hashTree(w.anchorDir)];
    for (const action of ['ADOPT', 'RESTORE_ACK', 'QUARANTINE_ACK']) {
      const r = await ledgerPost(w.auditId, { action }, ana);
      assert.equal(r.status, 403, `${index}/${action}`);
      const body = await json(r);
      assert.equal(body.code, 'ADMIN_APPROVAL_UNAVAILABLE');
      assert.ok(!JSON.stringify(body).includes(w.ledgerDir));
    }
    assert.deepEqual([hashTree(w.ledgerDir), hashTree(w.decisionsDir), hashTree(w.anchorDir)], before, `estado ${index}: nada mudou`);
  }
});

test('RECOVER sem nada a recuperar: 200, não grava decisão e não muda o livro; corpo inválido/ação desconhecida/parâmetros ⇒ 400 sem efeito; auditoria inexistente ⇒ 404', async () => {
  const w = await routeWorld();
  setEnv(w);
  const ana = await operator();
  const before = hashTree(w.ledgerDir);
  const ok = await ledgerPost(w.auditId, { action: 'RECOVER' }, ana);
  assert.equal(ok.status, 200);
  const okBody = await json(ok);
  assert.deepEqual([okBody.action, okBody.ledger.state], ['RECOVER', 'PROTECTED']);
  assert.deepEqual(hashTree(w.ledgerDir), before);
  for (const [label, response] of [
    ['ação desconhecida', await ledgerPost(w.auditId, { action: 'APAGAR' }, ana)],
    ['campo extra', await ledgerPost(w.auditId, { action: 'ENROLL', force: true }, ana)],
    ['JSON inválido', await ledgerPost(w.auditId, undefined, ana, { raw: '{' })],
    ['consulta', await ledgerPost(w.auditId, { action: 'RECOVER' }, ana, { query: '?force=1' })],
    ['auditId inválido', await ledgerPost('../fora', { action: 'RECOVER' }, ana)],
  ] as const) assert.equal(response.status, 400, label);
  assert.equal((await ledgerPost(w.auditId, undefined, ana)).status, 415, 'sem corpo JSON (sem content-type): mesmo contrato das outras rotas');
  assert.equal((await ledgerPost('auditoria-inexistente-01', { action: 'ENROLL' }, ana)).status, 404);
  assert.deepEqual(hashTree(w.ledgerDir), before, 'nenhuma recusa gravou');
});

test('SEM LIVRO CONFIGURADO (pasta ou chave ausente): leitura NÃO resolvida (NOT_CONFIGURED), escrita 503 LEDGER_NOT_CONFIGURED, inscrição 503 — nada é gravado em lugar algum', async () => {
  const w = await routeWorld({ enroll: false });
  const ana = await operator();
  for (const [label, setup] of [
    ['sem pasta e sem chave', () => setEnv(w, resultsEnv(), null, false)],
    ['pasta sem chave', () => setEnv(w, resultsEnv(), null, true)],
    ['chave fraca', () => setEnv(w, resultsEnv(), 'curta', true)],
  ] as const) {
    setup();
    const view = await list(w.auditId, ana);
    assert.deepEqual([view.ledger.state, view.ledger.reason, view.finalizable, view.decisions], ['HISTORY_UNRESOLVED', 'NOT_CONFIGURED', false, []], label);
    const write = await record(w.auditId, ana, null);
    assert.equal(write.status, 503, label);
    assert.equal((await json(write)).code, 'LEDGER_NOT_CONFIGURED', label);
    assert.equal((await ledgerPost(w.auditId, { action: 'ENROLL' }, ana)).status, 503, label);
    assert.ok(!fs.existsSync(path.join(w.decisionsDir, w.auditId)) && !fs.existsSync(path.join(w.ledgerDir, w.auditId)) && !fs.existsSync(path.join(w.anchorDir, w.auditId)), `${label}: nada gravado`);
  }
});

test('a chave do livro IGUAL à de origem é recusada (domínios separados não bastam: o material tem de ser distinto) — o livro fica NOT_CONFIGURED e nada é gravado', async () => {
  const w = await routeWorld({ enroll: false });
  setEnv(w, resultsEnv(), TEST_ORIGIN_KEY);
  const ana = await operator();
  const view = await list(w.auditId, ana);
  assert.deepEqual([view.ledger.state, view.ledger.reason], ['HISTORY_UNRESOLVED', 'NOT_CONFIGURED']);
  assert.equal((await record(w.auditId, ana, null)).status, 503);
  assert.ok(!fs.existsSync(path.join(w.ledgerDir, w.auditId)));
});

test('pasta do livro dentro ou igual a outra pasta (decisões, recibos, evidências, resultados): o livro fica não resolvido e nada é gravado', async () => {
  const w = await routeWorld({ enroll: false });
  const results = resultsEnv();
  const ana = await operator();
  for (const [label, dir] of [['igual às decisões', w.decisionsDir], ['igual aos recibos', w.anchorDir], ['dentro das evidências', path.join(w.evidenceDir, 'livro')], ['igual aos resultados', results.base]] as const) {
    fs.mkdirSync(dir, { recursive: true });
    setEnv(w, results);
    env.GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR = dir;
    const view = await list(w.auditId, ana);
    assert.equal(view.ledger.state, 'HISTORY_UNRESOLVED', label);
    assert.ok([409, 503].includes((await record(w.auditId, ana, null)).status), label);
    assert.ok(!fs.readdirSync(dir).some((name) => name === w.auditId && fs.readdirSync(path.join(dir, name)).some((file) => /^l\d{6}\.json$/.test(file))), `${label}: o livro não foi escrito na pasta compartilhada`);
  }
});

test('as respostas da rota do livro nunca trazem caminhos do disco, chaves, nomes de arquivo ou mensagens internas — nem nos erros', async () => {
  const w = await routeWorld({ enroll: false });
  setEnv(w);
  const ana = await operator();
  const texts: string[] = [];
  for (const action of ['ENROLL', 'RECOVER', 'ADOPT', 'RESTORE_ACK']) texts.push(JSON.stringify(await json(await ledgerPost(w.auditId, { action }, ana))));
  texts.push(JSON.stringify(await list(w.auditId, ana)));
  setEnv(w, resultsEnv(), null, true);
  texts.push(JSON.stringify(await json(await ledgerPost(w.auditId, { action: 'ENROLL' }, ana))));
  for (const text of texts) {
    for (const leak of [w.ledgerDir, w.decisionsDir, w.anchorDir, w.evidenceDir, LEDGER_KEY_A, TEST_ORIGIN_KEY, 'l000001.json', '/tmp/', 'ENOENT', 'EACCES', 'at Object']) assert.ok(!text.includes(leak), `vazou "${leak}"`);
  }
});

test('somente POST é exportado pela rota do livro (nenhuma exportação de leitura, alteração ou exclusão)', () => {
  assert.deepEqual(Object.keys(ledgerRouteModule).filter((key) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(key)), ['POST']);
});
