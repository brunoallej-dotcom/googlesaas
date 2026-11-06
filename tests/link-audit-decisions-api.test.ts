import { applyLedgerEnv, routeWorld } from './helpers/link-audit-ledger-fixtures';
import { LEDGER_NOT_REQUIRED } from '../src/lib/link-audit-decisions/ledger-port';
import { WITNESS_NOT_REQUIRED } from '../src/lib/link-audit-decisions/witness';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import * as decisionsModule from '../src/app/api/link-audit/decisions/[auditId]/route';
import * as revocationsModule from '../src/app/api/link-audit/decisions/[auditId]/revocations/route';
import { GET as listRoute, POST as createRoute } from '../src/app/api/link-audit/decisions/[auditId]/route';
import { POST as revokeRoute } from '../src/app/api/link-audit/decisions/[auditId]/revocations/route';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';
import { middleware } from '../src/middleware';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { DECISION_FILE_KIND, DECISION_SCHEMA_VERSION } from '../src/lib/link-audit-decisions/types';
import { errno } from './helpers/link-audit-evidence-fixtures';
import { entryPath, hashTree, rec, registerCleanup, tmpDir, type World } from './helpers/link-audit-decisions-fixtures';
import { OTHER_ORIGIN_KEY, TEST_ORIGIN, TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';
import { createDecisionService } from '../src/lib/link-audit-decisions';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, resultsEnv } from './helpers/link-audit-results-fixtures';

registerCleanup();

const SECRET = 'service-role-key-de-teste-0123456789';
const REASON = 'Informação conferida e incorreta; decisão desfeita.';
const env = process.env as Record<string, string | undefined>;

let operatorSeq = 0;
const operatorList = (): string => ['ana@empresa.com', ...Array.from({ length: 400 }, (_, i) => `op${i}@empresa.com`)].join(',');
const nextOperator = (): string => `op${operatorSeq++}@empresa.com`;
const cookie = async (email: string): Promise<string> => `${SESSION_COOKIE}=${await createSessionToken(email, SECRET)}`;

/** Pastas da TESTEMUNHA (resultados e recibos dos resultados): obrigatórias; sem elas o histórico é NÃO RESOLVIDO (falha fechada). */
let witnessDirs = resultsEnv();

function setEnv(w: (Pick<World, 'evidenceDir' | 'decisionsDir' | 'anchorDir'> & { readonly ledgerDir?: string }) | null, over: { decisions?: string | undefined; evidence?: string | undefined; anchors?: string | undefined; results?: string | undefined; resultAnchors?: string | undefined } = {}): void {
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = operatorList();
  delete env.GMN_AUTH_DISABLED;
  env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
  const set = (name: string, value: string | undefined): void => {
    if (value === undefined) delete env[name];
    else env[name] = value;
  };
  set('GMN_LINK_AUDIT_EVIDENCE_DIR', 'evidence' in over ? over.evidence : w?.evidenceDir);
  set('GMN_LINK_AUDIT_DECISIONS_DIR', 'decisions' in over ? over.decisions : w?.decisionsDir);
  set('GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR', 'anchors' in over ? over.anchors : w?.anchorDir);
  set('GMN_LINK_AUDIT_RESULTS_DIR', 'results' in over ? over.results : witnessDirs.base);
  set('GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR', 'resultAnchors' in over ? over.resultAnchors : witnessDirs.anchors);
  applyLedgerEnv(env, w?.ledgerDir ? { ledgerDir: w.ledgerDir } : null);
}

interface Init {
  readonly method?: string;
  readonly cookie?: string | null;
  readonly body?: unknown;
  readonly raw?: string;
  readonly headers?: Record<string, string>;
  /** Não preencher o `expectedHead` automaticamente. */
  readonly noHead?: boolean;
}
function req(url: string, init: Init = {}): Request {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { host: 'app.local', ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  const hasBody = init.body !== undefined || init.raw !== undefined;
  if (hasBody && !('content-type' in headers)) headers['content-type'] = 'application/json';
  return new Request(`http://app.local${url}`, { method, headers, ...(hasBody ? { body: init.raw ?? JSON.stringify(init.body) } : {}) });
}
const ctx = (auditId: string) => ({ params: Promise.resolve({ auditId }) });
const url = (auditId: string, suffix = ''): string => `/api/link-audit/decisions/${auditId}${suffix}`;

/** O head que o "navegador" viu por último (vem das respostas); cada teste começa sem ver nada (histórico vazio). */
let lastHead: unknown = null;
async function setup(): Promise<{ w: World; ana: string; auditId: string }> {
  const w = await routeWorld();
  witnessDirs = resultsEnv();
  setEnv(w);
  lastHead = null;
  return { w, ana: await cookie(nextOperator()), auditId: w.auditId };
}
const track = async (response: Response): Promise<Response> => {
  try {
    const body = (await response.clone().json()) as { head?: unknown };
    if (body && 'head' in body) lastHead = body.head;
  } catch {
    /* corpo não JSON */
  }
  return response;
};
const withHead = (body: unknown, extra: Init): unknown =>
  extra.noHead || typeof body !== 'object' || body === null || Array.isArray(body) || 'expectedHead' in body ? body : { ...body, expectedHead: lastHead };
const post = async (auditId: string, body: unknown, ana: string, extra: Init = {}) => track(await createRoute(req(url(auditId), { method: 'POST', cookie: ana, body: withHead(body, extra), ...extra }), ctx(auditId)));
const get = async (auditId: string, ana: string) => track(await listRoute(req(url(auditId), { cookie: ana }), ctx(auditId)));
const revoke = async (auditId: string, body: unknown, ana: string, extra: Init = {}) =>
  track(await revokeRoute(req(url(auditId, '/revocations'), { method: 'POST', cookie: ana, body: withHead(body, extra), ...extra }), ctx(auditId)));
const json = async (r: Response): Promise<Record<string, any>> => (await r.json()) as Record<string, any>;

test('sem sessão: as três rotas respondem 401, sem dados e sem cache; nada é gravado', async () => {
  const { w, auditId } = await setup();
  for (const [call, label] of [
    [() => listRoute(req(url(auditId)), ctx(auditId)), 'GET'],
    [() => createRoute(req(url(auditId), { method: 'POST', body: { record: rec.c2() } }), ctx(auditId)), 'POST'],
    [() => revokeRoute(req(url(auditId, '/revocations'), { method: 'POST', body: { revokes: 'op-0001', reason: REASON } }), ctx(auditId)), 'revogação'],
  ] as const) {
    const r = await call();
    assert.equal(r.status, 401, label);
    assert.match(r.headers.get('cache-control') ?? '', /no-store/);
    assert.ok(!/Padaria|decisions|auditoria-teste/i.test(JSON.stringify(await r.json())), `${label}: nada vaza sem sessão`);
  }
  assert.deepEqual(fs.readdirSync(w.decisionsDir), []);
});

test('sessão inválida, operador fora da lista e autenticação não configurada são recusados', async () => {
  const { w, auditId } = await setup();
  const bad = await listRoute(req(url(auditId), { cookie: `${SESSION_COOKIE}=lixo.assinatura` }), ctx(auditId));
  assert.ok([401, 403].includes(bad.status));
  const outsider = await createRoute(req(url(auditId), { method: 'POST', cookie: await cookie('intruso@x.com'), body: { record: rec.c2() } }), ctx(auditId));
  assert.ok([401, 403].includes(outsider.status));
  env.SUPABASE_SERVICE_ROLE_KEY = '';
  const noAuth = await listRoute(req(url(auditId), { cookie: await cookie(nextOperator()) }), ctx(auditId));
  assert.ok([401, 403, 503].includes(noAuth.status));
  setEnv(w);
  assert.deepEqual(fs.readdirSync(w.decisionsDir), []);
});

test('o middleware protege também as novas rotas: sem sessão, API responde 401 (nunca chega à rota)', async () => {
  const { auditId } = await setup();
  for (const [method, suffix] of [['GET', ''], ['POST', ''], ['POST', '/revocations']] as const) {
    const response = await middleware(new NextRequest(`http://app.local${url(auditId, suffix)}`, { method, headers: { host: 'app.local' } }));
    assert.equal(response.status, 401, `${method} ${suffix}`);
  }
});

test('proteção contra origem cruzada nos POST (sessão válida, mas Origin/Sec-Fetch-Site de outro site): 403 e nada gravado', async () => {
  const { w, ana, auditId } = await setup();
  const crossSite: Array<Record<string, string>> = [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }];
  for (const headers of crossSite) {
    const c = await post(auditId, { record: rec.c2() }, ana, { headers });
    const r = await revoke(auditId, { revokes: 'op-0001', reason: REASON }, ana, { headers });
    assert.deepEqual([c.status, r.status], [403, 403]);
    assert.equal((await json(c)).code, 'CROSS_ORIGIN');
  }
  assert.ok(!fs.existsSync(path.join(w.decisionsDir, auditId)));
  const same = await post(auditId, { record: rec.c2() }, ana, { headers: { origin: 'http://app.local' } });
  assert.equal(same.status, 201); // mesma origem: permitido
});

test('GET vazio: 200 sem decisões, head nulo, cabeçalhos privados e sem cache', async () => {
  const { ana, auditId } = await setup();
  const r = await get(auditId, ana);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('vary') ?? '', /Cookie/);
  const body = await json(r);
  assert.deepEqual([body.decisions, body.history, body.head, body.operatorRecords, body.auditId], [[], [], null, [], auditId]);
  assert.equal(body.limits.maxEffectiveRecords, 200);
});

test('fluxo completo pela API: criar (201), ler, substituir, revogar — autor da SESSÃO, hora do servidor, histórico preservado', async () => {
  const { w, ana, auditId } = await setup();
  const operator = `op${operatorSeq - 1}@empresa.com`;
  const before = Date.now();
  const created = await post(auditId, { record: rec.c2('PARTIAL') }, ana);
  assert.equal(created.status, 201);
  const c = await json(created);
  assert.deepEqual([c.decision.decisionId, c.decision.recordedBy, c.decision.status, c.head.seq, c.effectiveCount], ['op-0001', operator, 'ACTIVE', 1, 1]);
  assert.ok(Date.parse(c.decision.recordedAt) >= before - 1000 && Date.parse(c.decision.recordedAt) <= Date.now() + 1000, 'a hora é a do servidor');

  const conflict = await post(auditId, { record: rec.c2('COMPATIBLE') }, ana);
  assert.equal(conflict.status, 409);
  assert.equal((await json(conflict)).code, 'SUPERSEDE_REQUIRED');

  const replaced = await post(auditId, { record: rec.c2('COMPATIBLE'), supersedes: 'op-0001' }, ana);
  assert.equal(replaced.status, 201);
  assert.equal((await json(replaced)).decision.supersedes, 'op-0001');

  const revoked = await revoke(auditId, { revokes: 'op-0002', reason: REASON }, ana);
  assert.equal(revoked.status, 201);
  const rv = await json(revoked);
  assert.deepEqual([rv.revocation.action, rv.revoked.status, rv.effectiveCount, rv.head.seq], ['REVOKE', 'REVOKED', 0, 3]);

  const twice = await revoke(auditId, { revokes: 'op-0002', reason: REASON }, ana);
  assert.equal(twice.status, 409);
  assert.equal((await json(twice)).code, 'DECISION_NOT_ACTIVE');

  const listed = await json(await get(auditId, ana));
  assert.deepEqual(listed.decisions, []);
  assert.deepEqual(listed.allDecisions.map((d: any) => [d.decisionId, d.status]), [['op-0001', 'SUPERSEDED'], ['op-0002', 'REVOKED']]);
  assert.deepEqual(listed.history.map((h: any) => [h.seq, h.action]), [[1, 'RECORD'], [2, 'RECORD'], [3, 'REVOKE']]);
  assert.deepEqual(fs.readdirSync(path.join(w.decisionsDir, auditId)).sort(), ['d0001.json', 'd0002.json', 'd0003.json']);
});

test('400: auditId inválido, parâmetros de consulta, JSON inválido, corpo inválido, pontuação do cliente, referência e contrato', async () => {
  const { w, ana, auditId } = await setup();
  assert.equal((await get('ABC', ana)).status, 400);
  assert.equal((await get('../../etc/passwd', ana)).status, 400);
  assert.equal((await listRoute(req(`${url(auditId)}?limit=5`, { cookie: ana }), ctx(auditId))).status, 400);
  assert.equal((await createRoute(req(`${url(auditId)}?x=1`, { method: 'POST', cookie: ana, body: { record: rec.c2() } }), ctx(auditId))).status, 400);

  const notJson = await post(auditId, undefined, ana, { raw: '{isso não é json' });
  assert.deepEqual([notJson.status, (await json(notJson)).code], [400, 'INVALID_JSON']);

  const cases: Array<[unknown, string]> = [
    [{}, 'INVALID_BODY'],
    [{ record: { ...rec.c2(), id: 'op-0001' } }, 'INVALID_BODY'],
    [{ record: rec.c2(), recordedBy: 'x@y.com' }, 'INVALID_BODY'],
    [{ record: { ...rec.c2(), justification: 'curta' } }, 'INVALID_BODY'],
    [{ record: rec.c2(), points: 5 }, 'FORBIDDEN_FIELDS'],
    [{ record: { ...rec.c2(), obtainedHalfPoints: 8 } }, 'FORBIDDEN_FIELDS'],
    [{ record: rec.naFeature(['site:c0001']) }, 'INVALID_EVIDENCE_REFERENCE'],
    [{ record: rec.c2('TALVEZ') }, 'CONTRACT_REJECTED'],
  ];
  for (const [body, code] of cases) {
    const r = await post(auditId, body, ana);
    assert.equal(r.status, 400, code);
    assert.equal((await json(r)).code, code);
  }
  const badRevoke = await revoke(auditId, { revokes: 'op-0001', reason: 'curto' }, ana);
  assert.deepEqual([badRevoke.status, (await json(badRevoke)).code], [400, 'INVALID_BODY']);
  assert.ok(!fs.existsSync(path.join(w.decisionsDir, auditId)) || fs.readdirSync(path.join(w.decisionsDir, auditId)).length === 0);
});

test('404: auditoria e decisão inexistentes', async () => {
  const { ana, auditId } = await setup();
  const unknownAudit = 'auditoria-inexistente-9';
  for (const r of [await get(unknownAudit, ana), await post(unknownAudit, { record: rec.c2() }, ana), await revoke(unknownAudit, { revokes: 'op-0001', reason: REASON }, ana)]) {
    assert.equal(r.status, 404);
    assert.equal((await json(r)).code, 'AUDIT_NOT_FOUND');
  }
  const noDecision = await revoke(auditId, { revokes: 'op-0042', reason: REASON }, ana);
  assert.deepEqual([noDecision.status, (await json(noDecision)).code], [404, 'DECISION_NOT_FOUND']);
});

test('409: evidência inexistente, evidências ou histórico de decisões adulterados', async () => {
  const { w, ana, auditId } = await setup();
  const missing = await post(auditId, { record: rec.naFeature(['capture:c0009']) }, ana);
  assert.deepEqual([missing.status, (await json(missing)).code], [409, 'EVIDENCE_REFERENCE_NOT_FOUND']);

  assert.equal((await post(auditId, { record: rec.c2() }, ana)).status, 201);
  assert.equal((await post(auditId, { record: rec.c3() }, ana)).status, 201);
  fs.chmodSync(entryPath(w, 2), 0o644);
  fs.writeFileSync(entryPath(w, 2), fs.readFileSync(entryPath(w, 2), 'utf8').replace('ana', 'ona').replace('op', 'xx'));
  for (const r of [await get(auditId, ana), await post(auditId, { record: rec.p3() }, ana), await revoke(auditId, { revokes: 'op-0001', reason: REASON }, ana)]) {
    assert.equal(r.status, 409);
    const body = await json(r);
    assert.equal(body.code, 'DECISIONS_INTEGRITY');
    assert.ok(!('decisions' in body) && !('operatorRecords' in body) && !('history' in body), 'nenhum dado em histórico adulterado');
  }

  const other = await setup();
  const capture = path.join(other.w.evidenceDir, other.auditId, 'c0001.capture.json');
  fs.chmodSync(capture, 0o644);
  fs.writeFileSync(capture, fs.readFileSync(capture, 'utf8').replace('Padaria', 'Adulterada'));
  const tampered = await post(other.auditId, { record: rec.c2() }, other.ana);
  assert.deepEqual([tampered.status, (await json(tampered)).code], [409, 'EVIDENCE_INTEGRITY']);
});

test('413 e 415: corpo grande demais e tipo de conteúdo que não seja application/json', async () => {
  const { w, ana, auditId } = await setup();
  const big = await post(auditId, undefined, ana, { raw: JSON.stringify({ record: { ...rec.c2(), justification: 'x'.repeat(40_000) } }) });
  assert.equal(big.status, 413);
  const declared = await post(auditId, undefined, ana, { raw: '{}', headers: { 'content-length': '999999' } });
  assert.equal(declared.status, 413);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'text/plain; x=application/json', 'multipart/form-data']) {
    const r = await post(auditId, undefined, ana, { raw: JSON.stringify({ record: rec.c2() }), headers: { 'content-type': type } });
    assert.equal(r.status, 415, type);
    const rr = await revoke(auditId, undefined, ana, { raw: JSON.stringify({ revokes: 'op-0001', reason: REASON }), headers: { 'content-type': type } });
    assert.equal(rr.status, 415, `revogação ${type}`);
  }
  const charset = await post(auditId, { record: rec.c2() }, ana, { headers: { 'content-type': 'application/json; charset=utf-8' } });
  assert.equal(charset.status, 201);
  assert.equal(fs.readdirSync(path.join(w.decisionsDir, auditId)).length, 1);
});

test('429: limite por operador (escrita 20/min, leitura 30/min), com Retry-After; outro operador não é afetado', async () => {
  const { ana, auditId } = await setup();
  for (let i = 0; i < 20; i++) assert.equal((await post(auditId, {}, ana)).status, 400, `POST ${i + 1}`);
  const limited = await post(auditId, {}, ana);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await json(limited)).code, 'RATE_LIMITED');
  assert.equal((await revoke(auditId, {}, ana)).status, 429); // revogação divide o limite de escrita
  assert.equal((await get(auditId, ana)).status, 200); // leitura tem limite próprio
  const other = await cookie(nextOperator());
  assert.equal((await post(auditId, {}, other)).status, 400);

  const reader = await cookie(nextOperator());
  for (let i = 0; i < 30; i++) assert.equal((await get(auditId, reader)).status, 200, `GET ${i + 1}`);
  assert.equal((await get(auditId, reader)).status, 429);
});

test('503: armazenamento de decisões ou de evidências ausente, relativo, inexistente, inseguro ou igual ao de evidências', async () => {
  const { w, ana, auditId } = await setup();
  const attempt = async (over: Parameters<typeof setEnv>[1]): Promise<[number, string]> => {
    setEnv(w, over);
    const r = await get(auditId, await cookie(nextOperator()));
    return [r.status, (await json(r)).code];
  };
  assert.deepEqual(await attempt({ decisions: undefined }), [503, 'DECISIONS_NOT_CONFIGURED']);
  assert.deepEqual(await attempt({ decisions: 'relativo/pasta' }), [503, 'DECISIONS_NOT_CONFIGURED']);
  assert.deepEqual(await attempt({ decisions: '   ' }), [503, 'DECISIONS_NOT_CONFIGURED']);
  assert.deepEqual(await attempt({ anchors: undefined }), [503, 'ANCHOR_NOT_CONFIGURED']);
  assert.deepEqual(await attempt({ anchors: 'relativo/ancoras' }), [503, 'ANCHOR_NOT_CONFIGURED']);
  assert.deepEqual(await attempt({ anchors: path.join(tmpDir('lad-x-'), 'nao-existe') }), [503, 'ANCHOR_STORAGE_UNAVAILABLE']);
  assert.deepEqual(await attempt({ anchors: w.decisionsDir }), [503, 'DECISIONS_MISCONFIGURED']);
  assert.deepEqual(await attempt({ anchors: w.evidenceDir }), [503, 'DECISIONS_MISCONFIGURED']);
  assert.deepEqual(await attempt({ evidence: undefined }), [503, 'EVIDENCE_NOT_CONFIGURED']);
  assert.deepEqual(await attempt({ evidence: path.join(tmpDir('lad-x-'), 'nao-existe') }), [503, 'EVIDENCE_STORAGE_UNAVAILABLE']);
  assert.deepEqual(await attempt({ decisions: path.join(tmpDir('lad-x-'), 'nao-existe') }), [503, 'DECISIONS_STORAGE_UNAVAILABLE']);
  assert.deepEqual(await attempt({ decisions: w.evidenceDir }), [503, 'DECISIONS_MISCONFIGURED']);
  assert.deepEqual(await attempt({ decisions: path.join(process.cwd(), 'public') }), [503, 'DECISIONS_MISCONFIGURED']);
  // a pasta da auditoria existe mas é um arquivo comum: indisponível, nada é escrito
  setEnv(w);
  fs.writeFileSync(path.join(w.decisionsDir, auditId), 'não sou uma pasta');
  const write = await post(auditId, { record: rec.c2() }, await cookie(nextOperator()));
  assert.equal(write.status, 503);
  const still = fs.readFileSync(path.join(w.decisionsDir, auditId), 'utf8');
  assert.equal(still, 'não sou uma pasta');
  assert.ok(ana);
});

test('as respostas nunca trazem caminhos do disco, credenciais, nomes de arquivo ou mensagens internas — nem nos erros', async () => {
  const { w, ana, auditId } = await setup();
  const responses: Response[] = [
    await get(auditId, ana),
    await post(auditId, { record: rec.c2() }, ana),
    await post(auditId, { record: rec.c2('PARTIAL') }, ana),
    await post(auditId, { record: rec.naFeature(['capture:c0009']) }, ana),
    await revoke(auditId, { revokes: 'op-0001', reason: REASON }, ana),
    await revoke(auditId, { revokes: 'op-0001', reason: REASON }, ana),
    await get('auditoria-inexistente-9', ana),
    await get(auditId, ana),
  ];
  setEnv(w, { decisions: path.join(tmpDir('lad-x-'), 'nao-existe') });
  responses.push(await get(auditId, ana));
  const text = (await Promise.all(responses.map(async (r) => JSON.stringify(await r.json())))).join('\n');
  for (const secret of [w.evidenceDir, w.decisionsDir, SECRET, '/tmp/', '/home/', '/mnt/', 'node_modules', 'ENOENT', 'EACCES', 'at Object', 'stack']) assert.ok(!text.includes(secret), `vazou: ${secret}`);
  assert.ok(!/d000\d\.json|\.tmp-/.test(text), 'nenhum nome de arquivo de armazenamento');
});

test('somente os métodos previstos são exportados (GET/POST; revogação só POST); nenhuma exportação de alteração ou exclusão', () => {
  const allowed = (module: object): string[] => Object.keys(module).sort();
  assert.deepEqual(allowed(decisionsModule), ['GET', 'POST', 'dynamic']);
  assert.deepEqual(allowed(revocationsModule), ['POST', 'dynamic']);
});

test('as evidências originais não são tocadas por nenhuma rota', async () => {
  const { w, ana, auditId } = await setup();
  const before = hashTree(w.evidenceDir);
  await post(auditId, { record: rec.c2() }, ana);
  await post(auditId, { record: rec.naFeature() }, ana);
  await revoke(auditId, { revokes: 'op-0002', reason: REASON }, ana);
  await get(auditId, ana);
  assert.deepEqual(hashTree(w.evidenceDir), before);
});

test('expectedHead pela API: ausente ⇒ 400; visão velha ⇒ 409 HEAD_MISMATCH com o head atual; escritas válidas devolvem o head e o recibo (anchored)', async () => {
  const { w, ana, auditId } = await setup();
  const missing = await post(auditId, { record: rec.c2() }, ana, { noHead: true });
  assert.deepEqual([missing.status, (await json(missing)).code], [400, 'INVALID_BODY']);
  const missingRevoke = await revoke(auditId, { revokes: 'op-0001', reason: REASON }, ana, { noHead: true });
  assert.deepEqual([missingRevoke.status, (await json(missingRevoke)).code], [400, 'INVALID_BODY']);

  const first = await json(await post(auditId, { record: rec.c2() }, ana));
  assert.deepEqual([first.head.seq, first.anchored, first.anchors], [1, true, { count: 1, lastSeq: 1, unanchored: 0 }]);
  const seenFirst = lastHead;
  const second = await json(await post(auditId, { record: rec.c3() }, ana));
  assert.equal(second.head.seq, 2);

  const stale = await post(auditId, { record: rec.p3(), expectedHead: seenFirst }, ana, { noHead: true });
  assert.equal(stale.status, 409);
  const staleBody = await json(stale);
  assert.deepEqual([staleBody.code, staleBody.head.seq, staleBody.head.sha256], ['HEAD_MISMATCH', 2, second.head.sha256]);
  const regressed = await post(auditId, { record: rec.p3(), expectedHead: { seq: 9, sha256: 'a'.repeat(64) } }, ana, { noHead: true });
  assert.deepEqual([regressed.status, (await json(regressed)).code], [409, 'HISTORY_REGRESSED']);
  assert.equal(fs.readdirSync(path.join(w.decisionsDir, auditId)).length, 2);

  const listed = await json(await get(auditId, ana));
  assert.deepEqual([listed.anchors, listed.limits.reservedForRevocations, listed.integrity.ignoredFiles], [{ count: 2, lastSeq: 2, unanchored: 0 }, 100, 0]);
});

test('B1 pela API: decisões apagadas no fim ⇒ 409 DECISIONS_TRUNCATED (GET e POST), sem dados; âncora ausente/trocada ⇒ 503/409', async () => {
  const { w, ana, auditId } = await setup();
  await post(auditId, { record: rec.c2() }, ana);
  await post(auditId, { record: rec.c3() }, ana);
  fs.rmSync(entryPath(w, 2));
  for (const r of [await get(auditId, ana), await post(auditId, { record: rec.p3() }, ana), await revoke(auditId, { revokes: 'op-0001', reason: REASON }, ana)]) {
    assert.equal(r.status, 409);
    const body = await json(r);
    assert.equal(body.code, 'DECISIONS_TRUNCATED');
    assert.ok(!('decisions' in body) && !('operatorRecords' in body) && !('history' in body));
  }
  assert.ok(!JSON.stringify(await json(await get(auditId, ana))).includes(w.decisionsDir));
});

/** Faz o recibo `aNNNN.json` falhar (volume de âncoras sem espaço) enquanto `run` executa; o disco volta ao normal ao final. */
async function withAnchorWritesFailing<T>(seq: number, run: () => Promise<T>): Promise<T> {
  const original = nodeFsOps.writeExclusive;
  nodeFsOps.writeExclusive = async (target, data, mode) => {
    if (path.basename(target).startsWith(`.tmp-a${String(seq).padStart(4, '0')}`)) throw errno('ENOSPC', `sem espaço em ${target}`);
    return original(target, data, mode);
  };
  try {
    return await run();
  } finally {
    nodeFsOps.writeExclusive = original;
  }
}

test('Emenda 1 pela API: recibo que falha ⇒ 503 ANCHOR_PENDING (nunca 2xx) com o head confirmado; GET mostra a pendente fora das vigentes; só o reenvio idêntico a confirma (200), sem duplicar', async () => {
  const { w, ana, auditId } = await setup();
  const first = await json(await post(auditId, { record: rec.c2() }, ana));
  assert.equal(first.head.seq, 1);
  const seen = first.head;

  const pending = await withAnchorWritesFailing(2, () => post(auditId, { record: rec.c3() }, ana));
  const pendingBody = await json(pending);
  assert.equal(pending.status, 503);
  assert.equal(pending.headers.get('retry-after'), '5');
  assert.match(pending.headers.get('cache-control') ?? '', /no-store/);
  assert.deepEqual([pendingBody.code, pendingBody.head, pendingBody.pending.seq, pendingBody.pending.confirmed, pendingBody.pending.decisionId], ['ANCHOR_PENDING', seen, 2, false, 'op-0002']);
  assert.ok(!('decision' in pendingBody) && !('anchored' in pendingBody), 'nenhum campo de sucesso numa pendente');
  assert.ok(!JSON.stringify(pendingBody).includes(w.anchorDir) && !JSON.stringify(pendingBody).includes('sem espaço'), 'nada do disco vaza');

  const listed = await json(await get(auditId, ana)); // a pendente existe no disco, mas NÃO vale
  assert.deepEqual([listed.head, listed.pending.seq, listed.pending.confirmed, listed.history.length, listed.decisions.map((d: any) => d.decisionId), listed.operatorRecords.map((r: any) => r.id), listed.anchors.unanchored], [seen, 2, false, 1, ['op-0001'], ['op-0001'], 1]);

  const operatorB = await cookie(nextOperator());
  const foreign = await post(auditId, { record: rec.p3(), expectedHead: seen }, operatorB, { noHead: true }); // outro operador não conclui a pendente alheia
  assert.deepEqual([foreign.status, (await json(foreign)).code], [409, 'PENDING_UNCONFIRMED']);
  const different = await post(auditId, { record: rec.p3(), expectedHead: seen }, ana, { noHead: true }); // nem o autor com OUTRO pedido
  assert.deepEqual([different.status, (await json(different)).code], [409, 'PENDING_UNCONFIRMED']);
  assert.equal(fs.readdirSync(path.join(w.anchorDir, auditId)).length, 1); // nenhum recibo foi fabricado por esses pedidos

  const resent = await post(auditId, { record: rec.c3(), expectedHead: seen }, ana, { noHead: true });
  const resentBody = await json(resent);
  assert.equal(resent.status, 200); // reenvio: já aplicado, agora confirmado
  assert.deepEqual([resentBody.replayed, resentBody.anchored, resentBody.decision.decisionId, resentBody.head.seq, resentBody.anchors], [true, true, 'op-0002', 2, { count: 2, lastSeq: 2, unanchored: 0 }]);
  const again = await post(auditId, { record: rec.c3(), expectedHead: seen }, ana, { noHead: true });
  assert.deepEqual([again.status, (await json(again)).replayed], [200, true]);
  assert.equal(fs.readdirSync(path.join(w.decisionsDir, auditId)).length, 2);

  const next = await post(auditId, { record: rec.p3() }, ana); // e o histórico segue normalmente
  const nextBody = await json(next);
  assert.deepEqual([next.status, nextBody.replayed, nextBody.head.seq], [201, false, 3]);
  const done = await json(await get(auditId, ana));
  assert.deepEqual([done.pending, done.anchors], [null, { count: 3, lastSeq: 3, unanchored: 0 }]);
});

test('Emenda 1 pela API: reenvio de uma REVOGAÇÃO pendente — a decisão fica EM DÚVIDA (não vigente) até o recibo; depois do reenvio fica revogada, uma vez só', async () => {
  const { w, ana, auditId } = await setup();
  const created = await json(await post(auditId, { record: rec.c2() }, ana));
  const seen = created.head;
  const body = { revokes: 'op-0001', reason: REASON, expectedHead: seen };
  const pending = await withAnchorWritesFailing(2, () => revoke(auditId, body, ana, { noHead: true }));
  assert.deepEqual([pending.status, (await json(pending)).code], [503, 'ANCHOR_PENDING']);
  const during = await json(await get(auditId, ana));
  assert.deepEqual([during.decisions.map((d: any) => d.decisionId), during.operatorRecords.length, during.pending.action, during.pending.revokes, during.ambiguousDecisionIds, during.allDecisions[0].status], [[], 0, 'REVOKE', 'op-0001', ['op-0001'], 'AMBIGUOUS']); // nem vigente, nem revogada com certeza
  const resent = await revoke(auditId, body, ana, { noHead: true });
  const resentBody = await json(resent);
  assert.deepEqual([resent.status, resentBody.replayed, resentBody.effectiveCount, resentBody.revoked.status], [200, true, 0, 'REVOKED']);
  const after = await json(await get(auditId, ana));
  assert.deepEqual([after.decisions.length, after.operatorRecords.length, after.history.length, after.pending], [0, 0, 2, null]);
  assert.equal(fs.readdirSync(path.join(w.decisionsDir, auditId)).length, 2);
});

test('MAJOR-1 pela API: pendente FORJADA em nome do operador não é concluída (recusada: sem INTENT no livro e origem não comprovada), não expõe autor nem conteúdo e não grava recibo', async () => {
  const { w, ana, auditId } = await setup();
  const versions = await w.reader.listVersions({ email: 'ana@empresa.com' }, auditId);
  const latest = versions.filter((v) => v.capture !== null).sort((a, b) => (b.capture as number) - (a.capture as number))[0]!;
  const record = { kind: 'JUDGEMENT', subcriterionId: 'C2', value: 'COMPATIBLE', justification: 'Texto forjado por quem só escreve na pasta de decisões.' };
  fs.mkdirSync(path.join(w.decisionsDir, auditId), { recursive: true });
  const forged = seal({ schemaVersion: DECISION_SCHEMA_VERSION, kind: DECISION_FILE_KIND, auditId, action: 'RECORD', recordedAt: '2026-10-21T11:00:00.000Z', recordedBy: 'ana@empresa.com', decisionId: 'op-0001', record, supersedes: null, basis: { capture: latest.capture, report: null, collectedAt: latest.collectedAt }, seq: 1, prevSha256: null });
  fs.writeFileSync(entryPath(w, 1), serialize(forged), { mode: 0o444 });
  // a sessão é de QUALQUER operador autorizado (a "ana" do arquivo é só o que o arquivo afirma)
  const listed = await json(await get(auditId, ana));
  assert.deepEqual([listed.pending.origin, listed.pending.originDetail, listed.pending.isMine, listed.pending.record, listed.pending.recordedBy, listed.finalizable, listed.decisions.length], ['UNPROVEN', 'MISSING', false, null, null, false, 0]);
  assert.ok(!JSON.stringify(listed).includes('Texto forjado') && !JSON.stringify(listed).includes('ana@empresa.com'), 'conteúdo e autor do arquivo forjado não saem pela API');
  const anchorsBefore = hashTree(w.anchorDir);
  // O ATAQUE: a própria ANA (sessão de ana@empresa.com, o autor que o arquivo forjado cita) reenvia a operação do arquivo
  const theNamedAuthor = await cookie('ana@empresa.com');
  const attempt = await post(auditId, { record }, theNamedAuthor); // `expectedHead` = o head que a leitura acima devolveu (null)
  const body = await json(attempt);
  // Com o LIVRO a recusa vem ANTES e é mais forte: a pendente não tem INTENT no livro (foi publicada fora dele), logo o histórico é NÃO resolvido; a prova de origem (PENDING_ORIGIN_UNPROVEN) continua sendo a segunda barreira (testes do serviço).
  assert.deepEqual([attempt.status, body.code], [409, 'DECISIONS_HISTORY_UNRESOLVED']);
  assert.ok((body.issues as string[]).includes('livro: UNLEDGERED_PENDING'), JSON.stringify(body.issues));
  assert.match(attempt.headers.get('cache-control') ?? '', /no-store/);
  assert.deepEqual(hashTree(w.anchorDir), anchorsBefore, 'nenhum recibo');
  const after = await json(await get(auditId, ana));
  assert.deepEqual([after.decisions.length, after.operatorRecords.length, after.finalizable], [0, 0, false]);
});

test('MAJOR-1 pela API: sem chave de origem (ausente ou fraca) as ESCRITAS respondem 503 ORIGIN_KEY_NOT_CONFIGURED sem gravar nada; a LEITURA continua (origem "não verificável")', async () => {
  const { w, ana, auditId } = await setup();
  const ok = await post(auditId, { record: rec.c2() }, ana);
  assert.equal(ok.status, 201, 'com a chave, a escrita funciona');
  const decisionsBefore = hashTree(w.decisionsDir);
  const anchorsBefore = hashTree(w.anchorDir);
  for (const value of [undefined, 'curta', '   ']) {
    if (value === undefined) delete env.GMN_LINK_AUDIT_ORIGIN_KEY;
    else env.GMN_LINK_AUDIT_ORIGIN_KEY = value;
    const created = await post(auditId, { record: rec.c3() }, ana);
    const revoked = await revoke(auditId, { revokes: 'op-0001', reason: REASON }, ana);
    for (const response of [created, revoked]) {
      const body = await json(response);
      assert.deepEqual([response.status, body.code], [503, 'ORIGIN_KEY_NOT_CONFIGURED'], String(value));
      assert.ok(!JSON.stringify(body).includes(TEST_ORIGIN_KEY));
    }
    const read = await get(auditId, ana);
    assert.equal(read.status, 200, 'a leitura não depende da chave');
  }
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir)], [decisionsBefore, anchorsBefore], 'nada foi gravado');
  env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
  assert.equal((await post(auditId, { record: rec.c3() }, ana)).status, 201, 'a chave voltou: a escrita volta');
});

test('R3-MINOR-2 / R3-MINOR-5 pela API: com a TESTEMUNHA (resultado selado em outras pastas), operadores DIFERENTES do autor veem o estado estruturado; a quarentena da pendente não reativa a revogada e as escritas são recusadas', async () => {
  const { w, ana, auditId } = await setup();
  assert.equal((await post(auditId, { record: rec.c2() }, ana)).status, 201);
  assert.equal((await revoke(auditId, { revokes: 'op-0001', reason: REASON }, ana)).status, 201);
  // um resultado SELADO sobre esse histórico (em outras pastas) registra o head das decisões (seq 2)
  const rEnv = resultsEnv();
  const decisions = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: w.decisionsDir, anchorDir: w.anchorDir, evidence: w.reader, evidenceBaseDir: w.evidenceDir });
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: decisions });
  const evaluated = await preview.evaluate({ email: 'ana@empresa.com' }, auditId);
  assert.ok(evaluated.ok);
  assert.ok((await makeService(rEnv, preview).finalize({ email: 'ana@empresa.com' }, auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string })).ok);
  env.GMN_LINK_AUDIT_RESULTS_DIR = rEnv.base;
  env.GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR = rEnv.anchors;
  const other = await cookie(nextOperator());
  const third = await cookie(nextOperator());
  const baseline = await json(await get(auditId, other));
  assert.deepEqual([baseline.witness, baseline.finalizable, baseline.pending], [{ status: 'CONSISTENT', knownHeads: 1, coveredSeq: 2, unwitnessedAffecting: 0 }, true, null]);

  fs.rmSync(path.join(w.anchorDir, auditId, 'a0002.json')); // o recibo da REVOGAÇÃO some
  for (const who of [other, third]) {
    const view = await json(await get(auditId, who)); // operadores que NÃO são o autor
    assert.deepEqual([view.witness.status, view.decisions, view.operatorRecords, view.ambiguousDecisionIds, view.finalizable], ['RECEIPT_LOST_WITNESSED', [], [], ['op-0001'], false]);
    assert.equal(view.pending.reason, null, 'o motivo privado não vaza');
    assert.equal(view.pending.record, null);
  }
  // a quarentena manual da pendente (o §15 item 3 antigo) NÃO reativa a revogada
  const quarantineDir = path.join(w.decisionsDir, '..', `quarentena-${auditId}`);
  fs.mkdirSync(quarantineDir, { recursive: true });
  fs.renameSync(path.join(w.decisionsDir, auditId, 'd0002.json'), path.join(quarantineDir, 'd0002.json'));
  const regressed = await json(await get(auditId, other));
  assert.deepEqual([regressed.witness.status, regressed.decisions, regressed.operatorRecords, regressed.finalizable], ['HISTORY_REGRESSED', [], [], false]);
  assert.deepEqual(regressed.allDecisions.map((d: any) => [d.decisionId, d.status]), [['op-0001', 'AMBIGUOUS']]);
  const before = [hashTree(w.decisionsDir), hashTree(w.anchorDir)];
  const write = await post(auditId, { record: rec.c2(), expectedHead: regressed.head }, other, { noHead: true }); // pedido VÁLIDO: a recusa tem de ser pela integridade, não pelo corpo
  const body = await json(write);
  assert.deepEqual([write.status, body.code], [409, 'DECISIONS_HISTORY_UNRESOLVED']);
  assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir)], before, 'nada gravado');
  assert.ok(!JSON.stringify(body).includes(w.decisionsDir) && !JSON.stringify(body).includes(rEnv.base), 'sem caminhos');
});

test('INFO-1 pela API: dependência da TESTEMUNHA ausente, insegura ou ilegível NÃO é "sem inconsistência": decisão vigente bloqueada, escritas recusadas, consulta informativa mantida e nada gravado', async () => {
  const { w, ana, auditId } = await setup();
  assert.equal((await post(auditId, { record: rec.c2() }, ana)).status, 201);
  const live = await json(await get(auditId, ana));
  assert.deepEqual([live.witness, live.decisions.length, live.finalizable], [{ status: 'UNWITNESSED', knownHeads: 0, coveredSeq: null, unwitnessedAffecting: 0 }, 1, true], 'com a configuração válida e sem resultados a testemunha ainda não existe (declarado)');
  const good = { results: witnessDirs.base, resultAnchors: witnessDirs.anchors };
  const cases: Array<[string, Parameters<typeof setEnv>[1], string]> = [
    ['pasta de resultados AUSENTE', { results: undefined }, 'NOT_CONFIGURED'],
    ['pasta de recibos dos resultados AUSENTE', { resultAnchors: undefined }, 'NOT_CONFIGURED'],
    ['as duas ausentes', { results: undefined, resultAnchors: undefined }, 'NOT_CONFIGURED'],
    ['caminho relativo (inseguro)', { results: 'resultados' }, 'NOT_CONFIGURED'],
    ['resultados e recibos na MESMA pasta', { resultAnchors: good.results }, 'NOT_CONFIGURED'],
    ['resultados DENTRO da pasta de decisões', { results: path.join(w.decisionsDir, 'resultados') }, 'NOT_CONFIGURED'],
    ['resultados na MESMA pasta das decisões', { results: w.decisionsDir }, 'NOT_CONFIGURED'],
    ['resultados na MESMA pasta das evidências', { results: w.evidenceDir }, 'NOT_CONFIGURED'],
    ['recibos dos resultados na MESMA pasta dos recibos das decisões', { resultAnchors: w.anchorDir }, 'NOT_CONFIGURED'],
    ['pasta de resultados INEXISTENTE', { results: path.join(good.results, 'nao-existe') }, 'UNAVAILABLE'],
    ['pasta de recibos INEXISTENTE', { resultAnchors: path.join(good.resultAnchors, 'nao-existe') }, 'UNAVAILABLE'],
  ];
  for (const [label, over, expected] of cases) {
    setEnv(w, over);
    const who = await cookie(nextOperator()); // um operador por caso: o limite de escritas por operador não mascara a recusa
    const view = await json(await get(auditId, who));
    assert.deepEqual([view.witness.status, view.decisions, view.operatorRecords, view.finalizable], [expected, [], [], false], label);
    assert.ok(view.allDecisions.every((d: any) => d.status !== 'ACTIVE'), `${label}: consulta informativa, sem nenhuma decisão "vigente"`);
    assert.deepEqual(view.allDecisions.map((d: any) => [d.decisionId, d.status]), [['op-0001', 'AMBIGUOUS']], `${label}: a decisão que seria vigente fica em dúvida`);
    const before = [hashTree(w.decisionsDir), hashTree(w.anchorDir)];
    const write = await post(auditId, { record: rec.c3(), expectedHead: view.head }, who, { noHead: true });
    const body = await json(write);
    assert.deepEqual([write.status, body.code], [409, 'DECISIONS_HISTORY_UNRESOLVED'], `${label}: escrita`);
    const undo = await revoke(auditId, { revokes: 'op-0001', reason: REASON, expectedHead: view.head }, who, { noHead: true });
    assert.deepEqual([undo.status, (await json(undo)).code], [409, 'DECISIONS_HISTORY_UNRESOLVED'], `${label}: revogação`);
    assert.deepEqual([hashTree(w.decisionsDir), hashTree(w.anchorDir)], before, `${label}: nada gravado`);
    assert.ok(!JSON.stringify(body).includes(w.decisionsDir) && !JSON.stringify(body).includes(good.results), `${label}: sem caminhos na resposta`);
  }
  setEnv(w); // a configuração volta ao normal: nada ficou travado em memória
  const back = await json(await get(auditId, ana));
  assert.deepEqual([back.witness.status, back.decisions.length, back.finalizable], ['UNWITNESSED', 1, true]);
  assert.equal((await post(auditId, { record: rec.c3() }, ana)).status, 201, 'e a escrita volta');
});

test('FIAÇÃO das rotas: a chave de origem configurada chega ao provedor da testemunha — pendente de resultado COMPROVADO é testemunha (HISTORY_REGRESSED); após a rotação com a antiga REVOGADA é só indício (UNTRUSTED); nos dois casos falha fechada', async () => {
  const { w, auditId } = await setup();
  const ana = 'ana@empresa.com';
  const anaCookie = await cookie(ana);
  assert.equal((await post(auditId, { record: rec.c2() }, anaCookie)).status, 201);
  assert.equal((await revoke(auditId, { revokes: 'op-0001', reason: REASON }, anaCookie)).status, 201);
  const decisions = createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: w.decisionsDir, anchorDir: w.anchorDir, evidence: w.reader, evidenceBaseDir: w.evidenceDir });
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: decisions });
  const evaluated = await preview.evaluate({ email: ana }, auditId);
  assert.ok(evaluated.ok);
  assert.ok((await makeService(witnessDirs, preview).finalize({ email: ana }, auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string })).ok);
  fs.rmSync(path.join(witnessDirs.anchors, auditId, 'a0001.json')); // o resultado vira pendente
  fs.rmSync(path.join(w.anchorDir, auditId, 'a0002.json')); // e o recibo da revogação some
  const quarantineDir = path.join(w.decisionsDir, '..', `quarentena-fiacao-${auditId}`);
  fs.mkdirSync(quarantineDir, { recursive: true });
  fs.renameSync(path.join(w.decisionsDir, auditId, 'd0002.json'), path.join(quarantineDir, 'd0002.json'));
  const other = await cookie(nextOperator());
  const configured = await json(await get(auditId, other));
  assert.deepEqual([configured.witness.status, configured.decisions, configured.finalizable], ['HISTORY_REGRESSED', [], false], 'chave em vigor: a pendente é TESTEMUNHA');
  env.GMN_LINK_AUDIT_ORIGIN_KEY = OTHER_ORIGIN_KEY;
  env.GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS = 'ok-test-a';
  try {
    const rotated = await json(await get(auditId, other));
    assert.deepEqual([rotated.witness.status, rotated.decisions, rotated.finalizable], ['UNTRUSTED', [], false], 'chave antiga revogada: a pendente é só INDÍCIO e contradiz o histórico');
    assert.ok(rotated.allDecisions.every((d: any) => d.status !== 'ACTIVE'));
  } finally {
    env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
    delete env.GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS;
  }
});
