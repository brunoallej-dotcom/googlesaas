import { buildReportFromCapture } from '../src/lib/link-audit/collector/capture-report';
import { writeCapture, writeReport } from '../src/lib/link-audit-evidence/store';
import { identityFor, inputFor, LINK, T_NOW } from './helpers/link-audit-collect-fixtures';
import { bodyText, captureInput } from './helpers/link-audit-evidence-fixtures';
import { evidenceKeys, proveEvidenceForRoutes } from './helpers/link-audit-evidence-provenance-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import * as finalizeModule from '../src/app/api/link-audit/scoring/[auditId]/finalize/route';
import { POST as finalizeRoute } from '../src/app/api/link-audit/scoring/[auditId]/finalize/route';
import * as listModule from '../src/app/api/link-audit/scoring/[auditId]/results/route';
import { GET as listRoute } from '../src/app/api/link-audit/scoring/[auditId]/results/route';
import * as detailModule from '../src/app/api/link-audit/scoring/[auditId]/results/[seq]/route';
import { GET as detailRoute } from '../src/app/api/link-audit/scoring/[auditId]/results/[seq]/route';
import { GET as previewRoute } from '../src/app/api/link-audit/scoring/[auditId]/route';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { middleware } from '../src/middleware';
import { hashTree, registerCleanup, tmpDir, world, type World } from './helpers/link-audit-decisions-fixtures';
import { TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';

/*
 * Onda 6C, I4 — as ROTAS de finalização e consulta, com sessão assinada por segredo fictício e pastas temporárias. Prévia REAL sobre
 * evidências reais (INCONCLUSIVO); PONTUADO só existe nos testes do serviço (avaliador injetado). Nada de rede, Redis ou Supabase.
 */
registerCleanup();

const SECRET = 'service-role-key-de-teste-0123456789';
const env = process.env as Record<string, string | undefined>;
let operatorSeq = 0;
const operatorList = (): string => ['ana@empresa.com', ...Array.from({ length: 400 }, (_, i) => `rs${i}@empresa.com`)].join(',');
const nextOperator = (): string => `rs${operatorSeq++}@empresa.com`;
const cookie = async (email: string): Promise<string> => `${SESSION_COOKIE}=${await createSessionToken(email, SECRET)}`;

interface Dirs {
  readonly results: string;
  readonly resultAnchors: string;
}
interface Over {
  readonly results?: string | undefined;
  readonly resultAnchors?: string | undefined;
}
function setEnv(w: Pick<World, 'evidenceDir' | 'decisionsDir' | 'anchorDir'>, dirs: Dirs | null, over: Over = {}): void {
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = operatorList();
  delete env.GMN_AUTH_DISABLED;
  env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
  const set = (name: string, value: string | undefined): void => {
    if (value === undefined) delete env[name];
    else env[name] = value;
  };
  set('GMN_LINK_AUDIT_EVIDENCE_DIR', w.evidenceDir);
  set('GMN_LINK_AUDIT_DECISIONS_DIR', w.decisionsDir);
  set('GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR', w.anchorDir);
  set('GMN_LINK_AUDIT_RESULTS_DIR', 'results' in over ? over.results : dirs?.results);
  set('GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR', 'resultAnchors' in over ? over.resultAnchors : dirs?.resultAnchors);
}

interface Init {
  readonly method?: string;
  readonly cookie?: string | null;
  readonly body?: unknown;
  readonly raw?: string;
  readonly headers?: Record<string, string>;
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
const ctxSeq = (auditId: string, seq: string) => ({ params: Promise.resolve({ auditId, seq }) });
/** Cada requisição de teste usa um operador novo (os limitadores são por operador e em memória); o teste do limitador usa o mesmo de propósito. */
const fresh = async (): Promise<string> => cookie(nextOperator());
const base = (auditId: string): string => `/api/link-audit/scoring/${auditId}`;
const json = async (r: Response): Promise<Record<string, any>> => (await r.json()) as Record<string, any>;

interface Ctx {
  readonly w: World;
  readonly dirs: Dirs;
  readonly ana: string;
  readonly auditId: string;
}
async function setup(): Promise<Ctx> {
  const w = await world();
  await proveEvidenceForRoutes(env, w);
  const dirs = { results: tmpDir('lad-api-rs-'), resultAnchors: tmpDir('lad-api-ra-') };
  setEnv(w, dirs);
  return { w, dirs, ana: await cookie(nextOperator()), auditId: w.auditId };
}
const all = (c: Ctx) => [hashTree(c.w.evidenceDir), hashTree(c.w.decisionsDir), hashTree(c.w.anchorDir)];
const mine = (c: Ctx) => [hashTree(c.dirs.results), hashTree(c.dirs.resultAnchors)];

const preview = async (c: Ctx, who?: string): Promise<{ expectedHead: unknown; expectedInputSha256: string }> => {
  const r = await previewRoute(req(base(c.auditId), { cookie: who ?? (await fresh()) }), ctx(c.auditId));
  assert.equal(r.status, 200);
  const body = await json(r);
  return { expectedHead: body.finalization.expectedHead, expectedInputSha256: body.finalization.expectedInputSha256 };
};
const post = async (c: Ctx, body: unknown, who?: string, init: Init = {}) => finalizeRoute(req(`${base(c.auditId)}/finalize`, { method: 'POST', cookie: who ?? (await fresh()), body, ...init }), ctx(c.auditId));
const list = async (c: Ctx, who?: string) => listRoute(req(`${base(c.auditId)}/results`, { cookie: who ?? (await fresh()) }), ctx(c.auditId));
const detail = async (c: Ctx, seq: string, who?: string) => detailRoute(req(`${base(c.auditId)}/results/${seq}`, { cookie: who ?? (await fresh()) }), ctxSeq(c.auditId, seq));

/* ------------------------------------------------------------------------------------------------ contrato das rotas */
test('as rotas exportam SOMENTE os verbos previstos (POST na finalização; GET nas consultas) e nenhuma lê parâmetros de consulta', () => {
  assert.deepEqual(Object.keys(finalizeModule).sort(), ['POST', 'dynamic']);
  assert.deepEqual(Object.keys(listModule).sort(), ['GET', 'dynamic']);
  assert.deepEqual(Object.keys(detailModule).sort(), ['GET', 'dynamic']);
  const dir = path.join(__dirname, '..', 'src', 'app', 'api', 'link-audit', 'scoring', '[auditId]');
  for (const file of ['finalize/route.ts', 'results/route.ts', 'results/[seq]/route.ts']) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!/searchParams\.get|request\.formData|request\.text|request\.body/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), file);
    assert.ok(!/from 'node:|from "node:|fetch\(|process\./.test(source), `${file}: rota sem disco, rede nem ambiente próprios`);
  }
});

/* ------------------------------------------------------------------------------------------------ autenticação e autorização */
test('sem sessão ⇒ 401 sem dados nas TRÊS rotas (a autenticação vem antes da validação); o middleware também barra', async () => {
  const c = await setup();
  const before = [...all(c), ...mine(c)];
  for (const id of [c.auditId, 'curto', '../etc']) {
    const responses = [
      await finalizeRoute(req(`${base(id)}/finalize`, { method: 'POST', body: { expectedHead: null, expectedInputSha256: 'a'.repeat(64) } }), ctx(id)),
      await listRoute(req(`${base(id)}/results`), ctx(id)),
      await detailRoute(req(`${base(id)}/results/1`), ctxSeq(id, '1')),
    ];
    for (const r of responses) {
      assert.equal(r.status, 401, id);
      assert.ok(!/definitive|outcome|results/.test(JSON.stringify(await json(r))));
    }
  }
  for (const [method, suffix] of [['POST', '/finalize'], ['GET', '/results'], ['GET', '/results/1']] as const) {
    const viaMiddleware = await middleware(new NextRequest(`http://app.local${base(c.auditId)}${suffix}`, { method, headers: { host: 'app.local' } }));
    assert.equal(viaMiddleware.status, 401, `${method} ${suffix}`);
  }
  assert.deepEqual([...all(c), ...mine(c)], before);
});

test('sessão inválida, operador fora da lista e autenticação não configurada são recusados sem gravar nada', async () => {
  const c = await setup();
  const body = { expectedHead: null, expectedInputSha256: 'a'.repeat(64) };
  const bad = await post(c, body, `${SESSION_COOKIE}=lixo.assinatura`);
  assert.ok([401, 403].includes(bad.status));
  const outsider = await post(c, body, await cookie('intruso@x.com'));
  assert.ok([401, 403].includes(outsider.status), `operador não autorizado: ${outsider.status}`);
  assert.ok(!JSON.stringify(await json(outsider)).includes('definitive'));
  env.SUPABASE_SERVICE_ROLE_KEY = '';
  const noAuth = await post(c, body, await cookie(nextOperator()));
  assert.ok([401, 403, 503].includes(noAuth.status));
  setEnv(c.w, c.dirs);
  assert.deepEqual(mine(c), [{}, {}]);
});

test('proteção contra origem cruzada na finalização (sessão válida, Origin/Sec-Fetch-Site de outro site): 403 e nada gravado; mesma origem passa', async () => {
  const c = await setup();
  const body = await preview(c);
  const crossSite: Array<Record<string, string>> = [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }];
  for (const headers of crossSite) {
    const r = await post(c, body, c.ana, { headers });
    assert.equal(r.status, 403);
    assert.equal((await json(r)).code, 'CROSS_ORIGIN');
  }
  assert.deepEqual(mine(c), [{}, {}]);
  const same = await post(c, body, c.ana, { headers: { origin: 'http://app.local' } });
  assert.equal(same.status, 201);
});

/* ------------------------------------------------------------------------------------------------ fluxo completo */
test('fluxo: prévia → finalização (201, INCONCLUSIVO) → reenvio (200 replayed) → listagem → detalhe; evidências e decisões jamais são tocadas', async () => {
  const c = await setup();
  const evidenceAndDecisions = all(c);
  const seen = await preview(c);
  assert.ok(seen.expectedInputSha256);

  const created = await post(c, seen);
  assert.equal(created.status, 201);
  assert.match(created.headers.get('cache-control') ?? '', /no-store/);
  assert.match(created.headers.get('cache-control') ?? '', /private/);
  assert.equal(created.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(created.headers.get('vary'), 'Cookie');
  const body = await json(created);
  assert.deepEqual([body.definitive, body.replayed, body.anchored, body.head.seq, body.stateChangedAfterFinalization], [true, false, true, 1, false]);
  assert.equal(body.run.outcome, 'INCONCLUSIVO');
  assert.equal(body.run.result.index, null);
  assert.equal(body.run.hashes.inputSha256, seen.expectedInputSha256);

  const again = await post(c, seen, await cookie(nextOperator()));
  assert.equal(again.status, 200);
  const replay = await json(again);
  assert.deepEqual([replay.replayed, replay.head.seq, replay.stateChangedAfterFinalization, replay.recoveredPending], [true, 1, false, false]);
  assert.equal(fs.readdirSync(path.join(c.dirs.results, c.auditId)).length, 1);

  const listed = await list(c);
  assert.equal(listed.status, 200);
  const lb = await json(listed);
  assert.deepEqual([lb.definitive, lb.results.length, lb.results[0].seq, lb.results[0].stale, lb.results[0].superseded, lb.pending, lb.integrity.status], [true, 1, 1, false, false, null, 'OK']);
  const one = await detail(c, '1');
  assert.equal(one.status, 200);
  assert.deepEqual((await json(one)).run, body.run);
  assert.deepEqual(all(c), evidenceAndDecisions, 'a finalização não altera evidências nem decisões');
});

test('a resposta pública não vaza entrada do motor, URLs, hashes brutos, caminhos nem justificativas', async () => {
  const c = await setup();
  const seen = await preview(c);
  const texts = [await (await post(c, seen)).text(), await (await list(c)).text(), await (await detail(c, '1')).text()];
  for (const text of texts) {
    assert.ok(!/"input"|rawSha256|utm_source=|https?:\/\/|\/tmp\/|\/mnt\/|lad-api|GMN_LINK_AUDIT|Conferido no painel/.test(text), text.slice(0, 300));
  }
});

/* ------------------------------------------------------------------------------------------------ validação */
test('auditId inválido (depois de autenticar), parâmetros de consulta e seq inválido ⇒ 400; seq inexistente ⇒ 404', async () => {
  const c = await setup();
  const before = mine(c);
  for (const id of ['', 'curto', 'ABC_DEF_GHI', '../etc/passwd', 'a'.repeat(65), 'com espaço']) {
    const rf = await finalizeRoute(req(`${base(encodeURIComponent(id))}/finalize`, { method: 'POST', cookie: await fresh(), body: {} }), ctx(id));
    const rl = await listRoute(req(`${base(encodeURIComponent(id))}/results`, { cookie: await fresh() }), ctx(id));
    assert.deepEqual([rf.status, rl.status], [400, 400], id);
    assert.equal((await json(rf)).code, 'INVALID_PARAMS');
  }
  for (const query of ['?x=1', '?score=100', '?path=/etc', '?referenceDate=2026-01-01']) {
    assert.equal((await finalizeRoute(req(`${base(c.auditId)}/finalize${query}`, { method: 'POST', cookie: await fresh(), body: {} }), ctx(c.auditId))).status, 400, query);
    assert.equal((await listRoute(req(`${base(c.auditId)}/results${query}`, { cookie: await fresh() }), ctx(c.auditId))).status, 400, query);
    assert.equal((await detailRoute(req(`${base(c.auditId)}/results/1${query}`, { cookie: await fresh() }), ctxSeq(c.auditId, '1'))).status, 400, query);
  }
  const valid = await preview(c);
  const withQuery = await finalizeRoute(req(`${base(c.auditId)}/finalize?x=1`, { method: 'POST', cookie: await fresh(), body: valid }), ctx(c.auditId));
  assert.equal(withQuery.status, 400, 'corpo válido + parâmetro de consulta ainda é recusado');
  assert.deepEqual(mine(c), before);
  for (const seq of ['0', '00001', '01', 'abc', '-1', '1.5', '12345', '1e2', ' 1', '%20']) assert.equal((await detail(c, seq)).status, 400, seq);
  assert.equal((await detail(c, '5')).status, 404);
  assert.equal((await json(await detail(c, '5'))).code, 'RESULT_NOT_FOUND');
  assert.deepEqual(mine(c), before);
});

test('corpo: JSON malformado, tipo errado, grande demais ⇒ 4xx; campos de pontuação/entrada/autor/data ⇒ 400 FORBIDDEN_FIELDS; nada gravado', async () => {
  const c = await setup();
  const good = await preview(c);
  const bad = [
    await finalizeRoute(req(`${base(c.auditId)}/finalize`, { method: 'POST', cookie: await fresh(), raw: '{nao-json' }), ctx(c.auditId)),
    await finalizeRoute(req(`${base(c.auditId)}/finalize`, { method: 'POST', cookie: await fresh(), raw: JSON.stringify(good), headers: { 'content-type': 'text/plain' } }), ctx(c.auditId)),
    await finalizeRoute(req(`${base(c.auditId)}/finalize`, { method: 'POST', cookie: await fresh(), raw: JSON.stringify({ ...good, pad: 'x'.repeat(20_000) }) }), ctx(c.auditId)),
  ];
  assert.deepEqual(bad.map((r) => r.status), [400, 415, 413]);
  for (const extra of ['score', 'index', 'input', 'result', 'referenceDate', 'finalizedBy', 'finalizedAt', 'inputSha256', 'obtainedHalfPoints']) {
    const r = await post(c, { ...good, [extra]: 1 });
    assert.equal(r.status, 400, extra);
    assert.equal((await json(r)).code, 'FORBIDDEN_FIELDS');
  }
  for (const wrong of [{}, { expectedHead: null }, { ...good, expectedInputSha256: 'xyz' }, { ...good, expectedHead: 'x' }]) assert.equal((await post(c, wrong)).status, 400);
  assert.deepEqual(mine(c), [{}, {}]);
});

test('visão desatualizada ⇒ 409 (HEAD_MISMATCH com o head atual; INPUT_CHANGED); nada gravado', async () => {
  const c = await setup();
  const good = await preview(c);
  const wrongInput = await post(c, { ...good, expectedInputSha256: 'b'.repeat(64) });
  assert.equal(wrongInput.status, 409);
  assert.equal((await json(wrongInput)).code, 'INPUT_CHANGED');
  const wrongHead = await post(c, { ...good, expectedHead: { seq: 3, sha256: 'c'.repeat(64) } });
  assert.equal(wrongHead.status, 409);
  const wb = await json(wrongHead);
  assert.ok(['HEAD_MISMATCH', 'HISTORY_REGRESSED'].includes(wb.code));
  assert.ok('head' in wb);
  assert.deepEqual(mine(c), [{}, {}]);
});

/* ------------------------------------------------------------------------------------------------ configuração: 503 sem efeitos colaterais */
test('sem as pastas de resultados a PRÉVIA continua funcionando; finalização e consultas respondem 503 com código próprio', async () => {
  const c = await setup();
  const seen = await preview(c);
  for (const [name, over, code] of [
    ['sem pasta de resultados', { results: undefined }, 'RESULTS_NOT_CONFIGURED'],
    ['sem pasta de recibos', { resultAnchors: undefined }, 'RESULT_ANCHOR_NOT_CONFIGURED'],
  ] as const) {
    setEnv(c.w, c.dirs, over);
    const rf = await post(c, seen);
    assert.equal(rf.status, 503, name);
    assert.equal((await json(rf)).code, code, name);
    assert.equal((await list(c)).status, 503, name);
    assert.equal((await detail(c, '1')).status, 503, name);
    assert.equal((await previewRoute(req(base(c.auditId), { cookie: await fresh() }), ctx(c.auditId))).status, 200, `${name}: a prévia não depende dos resultados`);
  }
  assert.deepEqual(mine(c), [{}, {}]);
});

test('configuração insegura (relativa, igual, aninhada, igual à de decisões/evidências, inexistente) ⇒ 503 e nada gravado', async () => {
  const c = await setup();
  const seen = await preview(c);
  const cases: Array<[string, Over]> = [
    ['relativa', { results: 'relativo/resultados' }],
    ['iguais', { resultAnchors: c.dirs.results }],
    ['recibos dentro dos resultados', { resultAnchors: path.join(c.dirs.results, 'recibos') }],
    ['resultados = decisões', { results: c.w.decisionsDir }],
    ['recibos = evidências', { resultAnchors: c.w.evidenceDir }],
    ['resultados = recibos das decisões', { results: c.w.anchorDir }],
    ['inexistente', { results: path.join(c.dirs.results, 'nao-existe') }],
  ];
  for (const [name, over] of cases) {
    fs.mkdirSync(path.join(c.dirs.results, 'recibos'), { recursive: true });
    setEnv(c.w, c.dirs, over);
    const r = await post(c, seen);
    assert.equal(r.status, 503, name);
    assert.ok(['RESULTS_MISCONFIGURED', 'RESULTS_NOT_CONFIGURED', 'RESULTS_STORAGE_UNAVAILABLE', 'RESULT_ANCHOR_STORAGE_UNAVAILABLE'].includes((await json(r)).code), name);
  }
  setEnv(c.w, c.dirs);
  assert.deepEqual(fs.readdirSync(c.dirs.resultAnchors), []);
  assert.deepEqual(hashTree(c.w.decisionsDir), c.w.decisionsDir ? hashTree(c.w.decisionsDir) : {}, 'a pasta das decisões não recebeu nada');
  assert.ok(!fs.existsSync(path.join(c.w.decisionsDir, c.auditId)) || fs.readdirSync(path.join(c.w.decisionsDir, c.auditId)).length === 0);
});

/* ------------------------------------------------------------------------------------------------ integridade na consulta */
test('resultado adulterado no disco ⇒ 409 RESULT_INTEGRITY sem nenhum dado, na listagem e no detalhe; recibo à frente ⇒ RESULT_TRUNCATED', async () => {
  const c = await setup();
  const seen = await preview(c);
  assert.equal((await post(c, seen)).status, 201);
  const file = path.join(c.dirs.results, c.auditId, 's0001.json');
  const original = fs.readFileSync(file, 'utf8');
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, original.replace('"outcome": "INCONCLUSIVO"', '"outcome": "PONTUADO"'));
  for (const r of [await list(c), await detail(c, '1')]) {
    assert.equal(r.status, 409);
    const body = await json(r);
    assert.equal(body.code, 'RESULT_INTEGRITY');
    assert.deepEqual(Object.keys(body).sort(), ['code', 'error', ...(body.issues ? ['issues'] : [])].sort());
    assert.ok(!/definitive|outcome|inputSha256|result"/.test(JSON.stringify(body)));
  }
  const reject = await post(c, seen);
  assert.equal(reject.status, 409, 'com o histórico inconsistente nada novo é gravado');
  fs.writeFileSync(file, original);
  fs.chmodSync(path.join(c.dirs.results, c.auditId), 0o755);
  fs.unlinkSync(file);
  const truncated = await list(c);
  assert.equal(truncated.status, 409);
  assert.equal((await json(truncated)).code, 'RESULT_TRUNCATED');
});

test('consultas de uma auditoria sem resultados: lista vazia (200); inexistente ⇒ 404', async () => {
  const c = await setup();
  const empty = await list(c);
  assert.equal(empty.status, 200);
  const body = await json(empty);
  assert.deepEqual([body.results, body.head, body.pending], [[], null, null]);
  const ghost = 'auditoria-inexistente-9999';
  const missing = await listRoute(req(`${base(ghost)}/results`, { cookie: await fresh() }), ctx(ghost));
  assert.equal(missing.status, 404);
  assert.deepEqual(mine(c), [{}, {}]);
});

test('resposta de falha: bloqueios e head atual vão no corpo; Retry-After nas pendentes; no máximo 10 detalhes de 300 caracteres', async () => {
  const { resultsFailureResponse } = await import('../src/app/api/link-audit/scoring/shared');
  const blockers = [{ code: 'DECISION_PENDING', severity: 'BLOCKING', message: 'm', reasonCode: null, decisionIds: ['op-1'], subcriterionIds: [] }];
  const r = resultsFailureResponse({ ok: false, code: 'NOT_FINALIZABLE', issues: [], blockers: blockers as never, head: { seq: 2, sha256: 'a'.repeat(64) } });
  const body = await json(r);
  assert.equal(r.status, 409);
  assert.deepEqual([body.blockers, body.head.seq], [blockers, 2]);
  for (const code of ['RESULT_ANCHOR_PENDING', 'RESULT_PENDING_UNCONFIRMED'] as const) {
    const p = resultsFailureResponse({ ok: false, code, issues: [] });
    assert.ok(Number(p.headers.get('retry-after')) > 0, code);
  }
  assert.equal(resultsFailureResponse({ ok: false, code: 'INPUT_CHANGED', issues: [] }).headers.get('retry-after'), null);
  const many = await json(resultsFailureResponse({ ok: false, code: 'RESULT_INTEGRITY', issues: Array.from({ length: 30 }, () => 'x'.repeat(900)) }));
  assert.equal(many.issues.length, 10);
  assert.ok(many.issues.every((i: string) => i.length === 300));
});

test('exceção inesperada num handler ⇒ 500 genérico sem mensagem nem caminho; acesso negado do leitor ⇒ 403', async () => {
  const c = await setup();
  const { withResults } = await import('../src/app/api/link-audit/scoring/shared');
  const { EvidenceAccessError } = await import('../src/lib/link-audit-evidence/reader');
  const boom = await withResults(req(`${base(c.auditId)}/results`, { cookie: await fresh() }), 'read', async () => {
    throw new Error('falha em /mnt/segredo/arquivo-interno.json');
  });
  assert.equal(boom.status, 500);
  const text = await boom.text();
  assert.ok(!/segredo|arquivo-interno|falha em/.test(text), text);
  const denied = await withResults(req(`${base(c.auditId)}/results`, { cookie: await fresh() }), 'read', async () => {
    throw new EvidenceAccessError();
  });
  assert.equal(denied.status, 403);
});

/* ------------------------------------------------------------------------------------------------ limites de taxa */
test('limitador da finalização (6/min por operador): a 7ª tentativa ⇒ 429 com Retry-After, sem tocar o disco; consultas têm limite próprio', async () => {
  const c = await setup();
  const body = { expectedHead: null, expectedInputSha256: 'd'.repeat(64) };
  const statuses: number[] = [];
  let last: Response | null = null;
  for (let i = 0; i < 7; i++) {
    last = await post(c, body, c.ana);
    statuses.push(last.status);
  }
  assert.deepEqual(statuses.slice(0, 6).every((s) => s !== 429), true, JSON.stringify(statuses));
  assert.equal(statuses[6], 429);
  assert.ok(Number(last?.headers.get('retry-after')) > 0);
  assert.equal((await json(last as Response)).code, 'RATE_LIMITED');
  assert.equal((await list(c, c.ana)).status, 200, 'a leitura não consome o limite da escrita');
  const reader = await cookie(nextOperator());
  let limited = 0;
  for (let i = 0; i < 32; i++) if ((await list(c, reader)).status === 429) limited++;
  assert.equal(limited, 2);
});

test('MAJOR-1 pela API (resultados): resultado pendente com AUTOR FALSIFICADO e sem etiqueta não é concluído pelo "autor" (409 RESULT_PENDING_ORIGIN_UNPROVEN); nenhum recibo; a lista não afirma autoria nem desfecho', async () => {
  const c = await setup();
  const body = await preview(c);
  assert.equal((await post(c, body)).status, 201, 'um resultado legítimo existe');
  // quem só escreve na pasta de resultados: troca o autor, remove a etiqueta, refaz o selo SHA-256 e apaga o recibo
  const file = path.join(c.dirs.results, c.auditId, 's0001.json');
  const run = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete run.contentSha256;
  delete run.origin;
  run.finalizedBy = 'ana@empresa.com';
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, serialize(seal(run)));
  fs.rmSync(path.join(c.dirs.resultAnchors, c.auditId), { recursive: true, force: true });
  const ana = await cookie('ana@empresa.com');
  const listed = await json(await list(c, ana));
  assert.deepEqual([listed.results.length, listed.pending.origin, listed.pending.originDetail, listed.pending.isMine, listed.pending.outcome, listed.pending.coveragePercent], [0, 'UNPROVEN', 'MISSING', false, null, null]);
  assert.ok(!JSON.stringify(listed).includes('ana@empresa.com') || listed.results.length === 0, 'o autor citado no arquivo não é afirmado');
  const receiptsBefore = hashTree(c.dirs.resultAnchors);
  const attempt = await post(c, body, ana); // o "autor" nomeado reenvia o pedido que a interface monta
  const failure = await json(attempt);
  assert.deepEqual([attempt.status, failure.code, failure.pending.origin], [409, 'RESULT_PENDING_ORIGIN_UNPROVEN', 'UNPROVEN']);
  assert.match(attempt.headers.get('cache-control') ?? '', /no-store/);
  assert.deepEqual(hashTree(c.dirs.resultAnchors), receiptsBefore, 'nenhum recibo foi gravado');
  assert.equal((await detail(c, '1', ana)).status, 409, 'o detalhe não é entregue');
});

test('MAJOR-1 pela API (resultados): sem chave de origem (ausente ou fraca) a FINALIZAÇÃO responde 503 ORIGIN_KEY_NOT_CONFIGURED sem gravar nada; a prévia e as consultas continuam', async () => {
  const c = await setup();
  const body = await preview(c);
  const before = [...all(c), ...mine(c)];
  for (const value of [undefined, 'curta']) {
    if (value === undefined) delete env.GMN_LINK_AUDIT_ORIGIN_KEY;
    else env.GMN_LINK_AUDIT_ORIGIN_KEY = value;
    const r = await post(c, body);
    const failure = await json(r);
    assert.deepEqual([r.status, failure.code], [503, 'ORIGIN_KEY_NOT_CONFIGURED'], String(value));
    assert.ok(!JSON.stringify(failure).includes(TEST_ORIGIN_KEY));
    assert.equal((await list(c)).status, 200, 'a consulta não depende da chave');
    assert.equal((await previewRoute(req(base(c.auditId), { cookie: await fresh() }), ctx(c.auditId))).status, 200, 'a prévia também não');
  }
  assert.deepEqual([...all(c), ...mine(c)], before, 'nada foi gravado');
  env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
  assert.equal((await post(c, body)).status, 201, 'com a chave, a finalização volta');
});

test('PROVA DE COLETA pela API: sem manifesto/chave de confiança a prévia é consultável e rotulada, mas a finalização responde 409 NOT_FINALIZABLE e NADA é gravado', async () => {
  const c = await setup();
  for (const [label, mutate] of [
    ['sem a pasta de manifestos', () => void delete env.GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR],
    ['sem a chave pública de confiança', () => void delete env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS],
    ['com a chave pública de OUTRA pessoa (não assinou estes manifestos)', () => void (env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS = evidenceKeys().trustKeys)],
    ['com a chave de confiança malformada', () => void (env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS = 'isto-nao-e-uma-chave')],
  ] as const) {
    const saved = { dir: env.GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR, keys: env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS };
    mutate();
    const before = [...all(c), ...mine(c)];
    const seen = await previewRoute(req(base(c.auditId), { cookie: await fresh() }), ctx(c.auditId));
    assert.equal(seen.status, 200, label);
    const body = await json(seen);
    assert.equal(body.evidence.provenance.status, 'UNAUTHENTICATED', label);
    assert.equal(body.finalization.allowed, false, label);
    assert.ok(body.blockers.some((b: any) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' && b.severity === 'BLOCKING'), label);
    const attempt = await post(c, { expectedHead: body.finalization.expectedHead, expectedInputSha256: body.finalization.expectedInputSha256 ?? 'a'.repeat(64) });
    assert.equal(attempt.status, 409, label);
    const failure = await json(attempt);
    assert.ok(['NOT_FINALIZABLE', 'INPUT_CHANGED'].includes(failure.code), `${label}: ${failure.code}`);
    assert.deepEqual([...all(c), ...mine(c)], before, `${label}: nada foi gravado`);
    // sem vazamento: o corpo não cita caminhos, chaves nem a pasta de manifestos
    assert.ok(!JSON.stringify([body, failure]).includes(String(saved.dir)) && !JSON.stringify([body, failure]).includes(String(saved.keys).split(':')[1] ?? 'ø'), label);
    if (saved.dir !== undefined) env.GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR = saved.dir;
    if (saved.keys !== undefined) env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS = saved.keys;
  }
  // restaurada a configuração, a mesma auditoria é finalizável (a prova era a única coisa que faltava)
  const seen = await preview(c);
  assert.equal((await post(c, seen)).status, 201);
});

test('PROVA DE COLETA pela API: captura forjada SÓ na pasta de evidências, depois de a coleta legítima ser atestada, não é finalizável (409) e nada é gravado', async () => {
  const c = await setup();
  const first = await preview(c);
  assert.ok(first.expectedInputSha256);
  // o invasor escreve uma captura nova pelo pipeline (integridade OK) — o manifesto da coleta legítima não a cobre
  const cap = await writeCapture(c.w.evidenceDir, captureInput({ auditId: c.auditId, body: bodyText({ title: 'Padaria FORJADA' }), collectedAt: '2026-10-22T13:30:00.000Z' }));
  assert.ok(cap.ok);
  const built = await buildReportFromCapture({
    rawBody: bodyText({ title: 'Padaria FORJADA' }), body: { name: 'c0002.capture.json', sha256: cap.value.contentSha256, bytes: 10 }, otherFiles: [], httpStatus: 200, httpAttempts: 1, collectedAt: '2026-10-22T13:30:00.000Z',
    input: inputFor(identityFor(LINK, { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' }), 'snap-exemplo-0001'), site: null, siteOutcome: null, generatedAt: T_NOW,
  } as never);
  if (built.ok) await writeReport(c.w.evidenceDir, c.auditId, cap.value.captureNumber, JSON.parse(JSON.stringify(built.report)) as Record<string, unknown>, T_NOW);
  const before = [...all(c), ...mine(c)];
  const seen = await previewRoute(req(base(c.auditId), { cookie: await fresh() }), ctx(c.auditId));
  const body = await json(seen);
  assert.equal(seen.status, 200);
  assert.equal(body.evidence.provenance.status, 'UNAUTHENTICATED');
  const attempt = await post(c, { expectedHead: body.finalization.expectedHead, expectedInputSha256: body.finalization.expectedInputSha256 ?? first.expectedInputSha256 });
  assert.equal(attempt.status, 409);
  assert.deepEqual([...all(c), ...mine(c)], before, 'nada gravado');
});
