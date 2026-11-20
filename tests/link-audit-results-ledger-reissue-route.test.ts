import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { POST as finalizeRoute } from '../src/app/api/link-audit/scoring/[auditId]/finalize/route';
import * as resultsModule from '../src/app/api/link-audit/scoring/[auditId]/results/route';
import { GET as listRoute, POST as resultsActionRoute } from '../src/app/api/link-audit/scoring/[auditId]/results/route';
import { GET as previewRoute } from '../src/app/api/link-audit/scoring/[auditId]/route';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';
import { middleware } from '../src/middleware';
import { hashTree, registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { proveEvidenceForRoutes } from './helpers/link-audit-evidence-provenance-fixtures';
import { applyLedgerEnv, routeWorld, type LedgerWorld } from './helpers/link-audit-ledger-fixtures';
import { OTHER_ORIGIN_KEY, TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';

/*
 * R1.6 pela ROTA (spec do livro §16.17.5 e D-12: `POST /api/link-audit/scoring/{auditId}/results` com corpo estrito `{ "action": "REISSUE_RECEIPT" }`, "mesma autenticação, lista
 * de operadores e limitador da finalização"; D-R1-2: 200 `{ action, ledger }`). RL-33 de ponta a ponta: o resultado é confirmado pelo livro com a chave de origem da época; depois a
 * chave é rotacionada e a aposentada VENCE, o autor sai da lista de operadores e o recibo é removido; OUTRO operador reemite pela rota sem depender da chave de origem (também sem
 * chave nenhuma configurada) nem do autor. Sessão assinada por segredo fictício, pastas temporárias, nenhuma rede.
 */
registerCleanup();

const SECRET = 'service-role-key-de-teste-0123456789';
const env = process.env as Record<string, string | undefined>;
const AUTHOR = 'autora@empresa.com';
const OPERATORS = ['bia@empresa.com', 'carla@empresa.com', 'davi@empresa.com', 'elis@empresa.com'];
const cookie = async (email: string): Promise<string> => `${SESSION_COOKIE}=${await createSessionToken(email, SECRET)}`;
const ctx = (auditId: string) => ({ params: Promise.resolve({ auditId }) });
const base = (auditId: string): string => `/api/link-audit/scoring/${auditId}`;
const REMEDY = /Qualquer operador pode reemiti-lo pela ação 'Reemitir recibo do resultado'/;

function req(url: string, init: { method?: string; cookie?: string; body?: unknown; raw?: string; type?: string } = {}): Request {
  const headers: Record<string, string> = { host: 'app.local' };
  if (init.cookie) headers.cookie = init.cookie;
  const hasBody = init.body !== undefined || init.raw !== undefined;
  if (hasBody) headers['content-type'] = init.type ?? 'application/json';
  return new Request(`http://app.local${url}`, { method: init.method ?? 'GET', headers, ...(hasBody ? { body: init.raw ?? JSON.stringify(init.body) } : {}) });
}
const json = async (r: Response): Promise<Record<string, any>> => (await r.json()) as Record<string, any>;

function setEnv(w: LedgerWorld, dirs: { results: string; anchors: string }, operators: readonly string[]): void {
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = operators.join(',');
  delete env.GMN_AUTH_DISABLED;
  env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
  delete env.GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS;
  delete env.GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS;
  env.GMN_LINK_AUDIT_EVIDENCE_DIR = w.evidenceDir;
  env.GMN_LINK_AUDIT_DECISIONS_DIR = w.decisionsDir;
  env.GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR = w.anchorDir;
  env.GMN_LINK_AUDIT_RESULTS_DIR = dirs.results;
  env.GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR = dirs.anchors;
  applyLedgerEnv(env, w);
}

test('a rota de resultados exporta GET (consultas) e POST (a ação própria de reemissão, D-12) — e nada mais', () => {
  assert.deepEqual(Object.keys(resultsModule).sort(), ['GET', 'POST', 'dynamic']);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'api', 'link-audit', 'scoring', '[auditId]', 'results', 'route.ts'), 'utf8');
  assert.ok(!/from 'node:|fetch\(|process\./.test(source), 'rota sem disco, rede nem ambiente próprios');
});

test('RL-33 pela rota: chave de origem rotacionada e aposentada VENCIDA, autora fora da lista de operadores, recibo removido ⇒ outro operador reemite (200 { action, ledger }); sem chave de origem nenhuma também', async () => {
  const w = await routeWorld();
  await proveEvidenceForRoutes(env, w);
  const dirs = { results: tmpDir('lad-r16-rs-'), anchors: tmpDir('lad-r16-ra-') };
  setEnv(w, dirs, [AUTHOR, ...OPERATORS]);
  const author = await cookie(AUTHOR);
  // a autora finaliza pelo livro (RUN_INTENT, resultado, recibo, RUN_CONFIRMED)
  const seen = await json(await previewRoute(req(base(w.auditId), { cookie: author }), ctx(w.auditId)));
  const created = await finalizeRoute(req(`${base(w.auditId)}/finalize`, { method: 'POST', cookie: author, body: { expectedHead: seen.finalization.expectedHead, expectedInputSha256: seen.finalization.expectedInputSha256 } }), ctx(w.auditId));
  assert.equal(created.status, 201, JSON.stringify(await json(created.clone())).slice(0, 200));
  const receipt = path.join(dirs.anchors, w.auditId, 'a0001.json');
  const original = JSON.parse(fs.readFileSync(receipt, 'utf8')) as { headSha256: string };
  fs.rmSync(receipt);

  // rotação: a chave da época vira aposentada e já venceu; a autora sai da lista de operadores
  env.GMN_LINK_AUDIT_ORIGIN_KEY = OTHER_ORIGIN_KEY;
  env.GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS = `${TEST_ORIGIN_KEY}:2020-01-01`;
  env.GMN_OPERATOR_EMAILS = OPERATORS.join(',');
  const bia = await cookie('bia@empresa.com');
  const refusedList = await listRoute(req(`${base(w.auditId)}/results`, { cookie: bia }), ctx(w.auditId));
  assert.equal(refusedList.status, 409);
  const refusedBody = await json(refusedList);
  assert.equal(refusedBody.code, 'RESULT_INTEGRITY');
  assert.ok((refusedBody.issues as string[]).some((issue) => REMEDY.test(issue)), `texto de remédio na consulta: ${JSON.stringify(refusedBody).slice(0, 300)}`);
  const ledgerBefore = hashTree(env.GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR as string);

  const asAuthor = await resultsActionRoute(req(`${base(w.auditId)}/results`, { method: 'POST', cookie: author, body: { action: 'REISSUE_RECEIPT' } }), ctx(w.auditId));
  assert.ok([401, 403].includes(asAuthor.status), `a autora não é mais operadora: ${asAuthor.status}`);
  assert.equal(fs.existsSync(receipt), false, 'nada reemitido por quem não é operador');

  const done = await resultsActionRoute(req(`${base(w.auditId)}/results`, { method: 'POST', cookie: bia, body: { action: 'REISSUE_RECEIPT' } }), ctx(w.auditId));
  const body = await json(done);
  assert.equal(done.status, 200, JSON.stringify(body).slice(0, 300));
  assert.deepEqual([body.action, body.ledger?.state, body.ledger?.runs?.state, body.ledger?.runs?.receiptReissuable], ['REISSUE_RECEIPT', 'PROTECTED', 'OK', false]);
  assert.match(done.headers.get('cache-control') ?? '', /no-store/);
  assert.equal((JSON.parse(fs.readFileSync(receipt, 'utf8')) as { headSha256: string }).headSha256, original.headSha256, 'recibo de MESMO headSha256');
  assert.deepEqual(hashTree(env.GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR as string), ledgerBefore, 'nenhum registro no livro');
  const listed = await listRoute(req(`${base(w.auditId)}/results`, { cookie: await cookie('carla@empresa.com') }), ctx(w.auditId));
  assert.equal(listed.status, 200);
  assert.equal((await json(listed)).confirmation, 'LEDGER');

  // de novo, agora SEM chave de origem nenhuma e com o armazenamento de EVIDÊNCIAS ilegível: a finalização exigiria os dois (503); a reemissão não depende de nenhum
  fs.rmSync(receipt);
  delete env.GMN_LINK_AUDIT_ORIGIN_KEY;
  delete env.GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS;
  const aside = `${w.evidenceDir}-fora`;
  fs.renameSync(w.evidenceDir, aside);
  try {
    const noKey = await resultsActionRoute(req(`${base(w.auditId)}/results`, { method: 'POST', cookie: await cookie('davi@empresa.com'), body: { action: 'REISSUE_RECEIPT' } }), ctx(w.auditId));
    assert.equal(noKey.status, 200, JSON.stringify(await json(noKey.clone())).slice(0, 300));
    assert.equal((JSON.parse(fs.readFileSync(receipt, 'utf8')) as { headSha256: string }).headSha256, original.headSha256);
  } finally {
    fs.renameSync(aside, w.evidenceDir);
  }
});

test('limitador da FINALIZAÇÃO também na reemissão (6/min por operador): a 7ª tentativa do mesmo operador ⇒ 429 com Retry-After, sem tocar o disco', async () => {
  const w = await routeWorld();
  await proveEvidenceForRoutes(env, w);
  const dirs = { results: tmpDir('lad-r16c-rs-'), anchors: tmpDir('lad-r16c-ra-') };
  setEnv(w, dirs, OPERATORS);
  const who = await cookie('carla@empresa.com');
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 7; attempt += 1) statuses.push((await resultsActionRoute(req(`${base(w.auditId)}/results`, { method: 'POST', cookie: who, body: { action: 'REISSUE_RECEIPT' } }), ctx(w.auditId))).status);
  assert.deepEqual(statuses, [409, 409, 409, 409, 409, 409, 429], 'nada a reemitir (409) até o limite; depois 429');
  assert.deepEqual([hashTree(dirs.results), hashTree(dirs.anchors)], [{}, {}]);
});

test('corpo da ação ESTRITO pela rota (tipo, JSON, campos a mais, outra ação, parâmetros de consulta) e sem sessão ⇒ recusa sem gravar nada; o middleware também barra', async () => {
  const w = await routeWorld();
  await proveEvidenceForRoutes(env, w);
  const dirs = { results: tmpDir('lad-r16b-rs-'), anchors: tmpDir('lad-r16b-ra-') };
  setEnv(w, dirs, OPERATORS);
  const before = [hashTree(dirs.results), hashTree(dirs.anchors), hashTree(env.GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR as string)];
  const who = await cookie('elis@empresa.com');
  const post = (init: Parameters<typeof req>[1], url = `${base(w.auditId)}/results`) => resultsActionRoute(req(url, { method: 'POST', ...init }), ctx(w.auditId));
  const cases: ReadonlyArray<readonly [string, Promise<Response>, number, string | null]> = [
    ['sem sessão', post({ body: { action: 'REISSUE_RECEIPT' } }), 401, null],
    ['tipo errado', post({ cookie: who, raw: '{"action":"REISSUE_RECEIPT"}', type: 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['JSON malformado', post({ cookie: who, raw: '{"action":' }), 400, null],
    ['campo a mais', post({ cookie: who, body: { action: 'REISSUE_RECEIPT', expectedHead: null } }), 400, 'FORBIDDEN_FIELDS'],
    ['outra ação', post({ cookie: who, body: { action: 'RECOVER' } }), 400, 'INVALID_BODY'],
    ['parâmetro de consulta', post({ cookie: who, body: { action: 'REISSUE_RECEIPT' } }, `${base(w.auditId)}/results?x=1`), 400, 'INVALID_PARAMS'],
    ['nada a reemitir (sem resultado)', post({ cookie: who, body: { action: 'REISSUE_RECEIPT' } }), 409, 'LEDGER_ACTION_INVALID'],
  ];
  for (const [label, pending, status, code] of cases) {
    const r = await pending;
    assert.equal(r.status, status, label);
    if (code) assert.equal((await json(r)).code, code, label);
  }
  const viaMiddleware = await middleware(new NextRequest(`http://app.local${base(w.auditId)}/results`, { method: 'POST', headers: { host: 'app.local' } }));
  assert.equal(viaMiddleware.status, 401, 'middleware');
  assert.deepEqual([hashTree(dirs.results), hashTree(dirs.anchors), hashTree(env.GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR as string)], before, 'nada gravado');
});
