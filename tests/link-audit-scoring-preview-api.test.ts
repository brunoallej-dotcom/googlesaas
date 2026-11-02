import { proveEvidenceForRoutes } from './helpers/link-audit-evidence-provenance-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import * as routeModule from '../src/app/api/link-audit/scoring/[auditId]/route';
import { GET as previewRoute } from '../src/app/api/link-audit/scoring/[auditId]/route';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';
import { middleware } from '../src/middleware';
import { anchorPath, hashTree, must, rec, registerCleanup, world, type World } from './helpers/link-audit-decisions-fixtures';
import { clock } from './helpers/link-audit-decisions-fixtures';
import { bodyText, writeFull } from './helpers/link-audit-evidence-fixtures';
import { OTHER_ORIGIN_KEY, TEST_ORIGIN, TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';
import { makeService, resultsEnv } from './helpers/link-audit-results-fixtures';
import { createDecisionService, WITNESS_NOT_REQUIRED } from '../src/lib/link-audit-decisions';
import { previewOver } from './helpers/link-audit-preview-fixtures';

/* Onda 6C, I3 — a ROTA GET da prévia, com sessão assinada por segredo fictício e pastas temporárias. Nada de rede, Redis ou Supabase. */
registerCleanup();

const SECRET = 'service-role-key-de-teste-0123456789';
const env = process.env as Record<string, string | undefined>;
let operatorSeq = 0;
const operatorList = (): string => ['ana@empresa.com', ...Array.from({ length: 400 }, (_, i) => `pv${i}@empresa.com`)].join(',');
const nextOperator = (): string => `pv${operatorSeq++}@empresa.com`;
const cookie = async (email: string): Promise<string> => `${SESSION_COOKIE}=${await createSessionToken(email, SECRET)}`;

/** Pastas da TESTEMUNHA (resultados e recibos dos resultados): obrigatórias; sem elas o histórico é NÃO RESOLVIDO (falha fechada). */
let witnessDirs = resultsEnv();

function setEnv(w: Pick<World, 'evidenceDir' | 'decisionsDir' | 'anchorDir'> | null, over: { decisions?: string | undefined; evidence?: string | undefined; anchors?: string | undefined; results?: string | undefined; resultAnchors?: string | undefined } = {}): void {
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
}

const req = (url: string, init: { cookie?: string | null; method?: string; headers?: Record<string, string> } = {}): Request => {
  const headers: Record<string, string> = { host: 'app.local', ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  return new Request(`http://app.local${url}`, { method: init.method ?? 'GET', headers });
};
const ctx = (auditId: string) => ({ params: Promise.resolve({ auditId }) });
const url = (auditId: string, query = ''): string => `/api/link-audit/scoring/${auditId}${query}`;
const json = async (r: Response): Promise<Record<string, any>> => (await r.json()) as Record<string, any>;

async function setup(over: Parameters<typeof world>[0] = {}): Promise<{ w: World; ana: string; auditId: string }> {
  const w = await world(over);
  await proveEvidenceForRoutes(env, w);
  witnessDirs = resultsEnv();
  setEnv(w);
  return { w, ana: await cookie(nextOperator()), auditId: w.auditId };
}
const all = (w: World) => [hashTree(w.evidenceDir), hashTree(w.decisionsDir), hashTree(w.anchorDir)];

test('a rota exporta SOMENTE GET (nenhum POST/PUT/PATCH/DELETE): a prévia não aceita nenhum dado do cliente', () => {
  assert.deepEqual(Object.keys(routeModule).sort(), ['GET', 'dynamic']);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'api', 'link-audit', 'scoring', '[auditId]', 'route.ts'), 'utf8');
  assert.ok(!/request\.json|request\.formData|request\.text|request\.body|readJsonBody|searchParams\.get/.test(source), 'a rota nunca lê corpo nem parâmetros');
});

test('sem sessão ⇒ 401 sem dados (inclusive com auditId inválido: a autenticação vem ANTES da validação); o middleware também barra', async () => {
  const { w, auditId } = await setup();
  const before = all(w);
  for (const id of [auditId, 'curto', '../etc']) {
    const r = await previewRoute(req(url(id)), ctx(id));
    assert.equal(r.status, 401, id);
    assert.ok(!JSON.stringify(await json(r)).includes('definitive'));
  }
  const viaMiddleware = await middleware(new NextRequest(`http://app.local${url(auditId)}`, { headers: { host: 'app.local' } }));
  assert.equal(viaMiddleware.status, 401);
  assert.deepEqual(all(w), before);
});

test('sessão inválida, operador fora da lista e autenticação não configurada são recusados sem dados', async () => {
  const { w, auditId } = await setup();
  const bad = await previewRoute(req(url(auditId), { cookie: `${SESSION_COOKIE}=lixo.assinatura` }), ctx(auditId));
  assert.ok([401, 403].includes(bad.status));
  const outsider = await previewRoute(req(url(auditId), { cookie: await cookie('intruso@x.com') }), ctx(auditId));
  assert.ok([401, 403].includes(outsider.status), `operador não autorizado: ${outsider.status}`);
  assert.ok(!JSON.stringify(await json(outsider)).includes('criteria'));
  env.SUPABASE_SERVICE_ROLE_KEY = '';
  const noAuth = await previewRoute(req(url(auditId), { cookie: await cookie(nextOperator()) }), ctx(auditId));
  assert.ok([401, 403, 503].includes(noAuth.status));
  setEnv(w);
});

test('operador autenticado: 200, prévia nunca definitiva, cabeçalhos privados, sem cache; nada é gravado em nenhuma pasta', async () => {
  const { w, ana, auditId } = await setup();
  const before = all(w);
  const r = await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  assert.match(r.headers.get('cache-control') ?? '', /private/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('vary'), 'Cookie');
  const body = await json(r);
  assert.equal(body.definitive, false);
  assert.equal(body.auditId, auditId);
  assert.equal(body.outcomePreview.outcome, 'INCONCLUSIVO');
  assert.equal(body.result.index, null);
  assert.equal(body.finalization.allowed, true, 'cobertura insuficiente não impede registrar o resultado técnico');
  assert.deepEqual(all(w), before);
});

test('auditId inválido (depois de autenticar) e QUALQUER parâmetro de consulta ⇒ 400, inclusive tentativas de enviar pontuação, entrada do motor, caminho, autor ou data', async () => {
  const { w, ana, auditId } = await setup();
  const before = all(w);
  for (const id of ['', 'curto', 'ABC_DEF_GHI', '../etc/passwd', 'a'.repeat(65), 'com espaço', '%2e%2e%2fx']) {
    const r = await previewRoute(req(url(encodeURIComponent(id)), { cookie: ana }), ctx(id));
    assert.equal(r.status, 400, id);
    assert.equal((await json(r)).code, 'INVALID_PARAMS');
  }
  for (const query of ['?score=100', '?points=80', '?index=99', '?coverage=100', '?classification=STRONG', '?input={"a":1}', '?scoringInput=x', '?referenceDate=2030-01-01', '?path=/etc', '?author=x@y.z', '?expectedHead=1', '?a']) {
    const r = await previewRoute(req(url(auditId, query), { cookie: ana }), ctx(auditId));
    assert.equal(r.status, 400, query);
    const body = await json(r);
    assert.equal(body.code, 'INVALID_PARAMS');
    assert.ok(!('result' in body) && !('definitive' in body));
  }
  assert.deepEqual(all(w), before);
});

test('auditoria inexistente ⇒ 404; evidência adulterada ⇒ 409 SEM dados; decisões adulteradas ⇒ 409 sem dados', async () => {
  const { w, ana, auditId } = await setup();
  const missing = await previewRoute(req(url('auditoria-que-nao-existe'), { cookie: ana }), ctx('auditoria-que-nao-existe'));
  assert.equal(missing.status, 404);
  await must(w.service.create({ email: 'ana@empresa.com' }, auditId, { record: rec.c2() }, clock()));
  const decisionFile = path.join(w.decisionsDir, auditId, 'd0001.json');
  fs.chmodSync(decisionFile, 0o644);
  fs.writeFileSync(decisionFile, fs.readFileSync(decisionFile, 'utf8').replace('COMPATIBLE', 'INCOMPATIBLE'));
  const decisions = await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId));
  assert.equal(decisions.status, 409);
  const decisionsBody = await json(decisions);
  assert.ok(['DECISIONS_INTEGRITY', 'ANCHOR_INTEGRITY', 'ANCHOR_MISMATCH'].includes(decisionsBody.code), decisionsBody.code);
  assert.ok(!('result' in decisionsBody) && !('criteria' in decisionsBody));
  const fresh = await setup();
  const capture = path.join(fresh.w.evidenceDir, fresh.auditId, 'c0001.capture.json');
  fs.chmodSync(capture, 0o644);
  fs.writeFileSync(capture, fs.readFileSync(capture, 'utf8').replace('Padaria Exemplo (fictícia)', 'Outra Empresa'));
  const evidence = await previewRoute(req(url(fresh.auditId), { cookie: fresh.ana }), ctx(fresh.auditId));
  assert.equal(evidence.status, 409);
  const evidenceBody = await json(evidence);
  assert.equal(evidenceBody.code, 'EVIDENCE_INTEGRITY');
  assert.ok(!JSON.stringify(evidenceBody).includes('Outra Empresa') && !('result' in evidenceBody));
});

test('decisão pendente: 200 com estado DECISAO_PENDENTE, bloqueio ligado ao op-NNNN e finalization.allowed=false', async () => {
  const { w, ana, auditId } = await setup();
  await must(w.service.create({ email: 'ana@empresa.com' }, auditId, { record: rec.c2() }, clock()));
  fs.rmSync(anchorPath(w, 1), { force: true });
  const body = await json(await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId)));
  assert.equal(body.state, 'DECISAO_PENDENTE');
  assert.deepEqual(body.blockers.map((b: any) => [b.code, b.severity, b.decisionIds]), [['DECISION_PENDING', 'BLOCKING', ['op-0001']]]);
  assert.equal(body.finalization.allowed, false);
  assert.equal(body.decisions.finalizable, false);
});

test('configuração ausente ou insegura ⇒ 503 com código fixo, sem caminho nem detalhe', async () => {
  const { w, ana, auditId } = await setup();
  const cases: Array<[Parameters<typeof setEnv>[1], string]> = [
    [{ evidence: undefined }, 'EVIDENCE_NOT_CONFIGURED'],
    [{ decisions: undefined }, 'DECISIONS_NOT_CONFIGURED'],
    [{ anchors: undefined }, 'ANCHOR_NOT_CONFIGURED'],
    [{ evidence: 'relativo/evidencias' }, 'EVIDENCE_NOT_CONFIGURED'],
  ];
  for (const [over, code] of cases) {
    setEnv(w, over);
    const r = await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId));
    assert.equal(r.status, 503);
    const body = await json(r);
    assert.equal(body.code, code);
    assert.ok(!JSON.stringify(body).includes('/tmp') && !JSON.stringify(body).includes(w.evidenceDir));
  }
  setEnv(w, { evidence: path.join(w.evidenceDir, 'nao-existe') });
  const unreachable = await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId));
  assert.ok([503, 404, 409, 500].includes(unreachable.status) && !JSON.stringify(await json(unreachable)).includes(w.evidenceDir));
  setEnv(w);
});

test('limite de requisições por operador: a 21ª em um minuto é 429 com Retry-After; outro operador não é afetado', async () => {
  const { ana, auditId } = await setup();
  let last: Response | null = null;
  for (let i = 0; i < 20; i += 1) {
    last = await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId));
    assert.equal(last.status, 200, `requisição ${i + 1}`);
  }
  const limited = await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await json(limited)).code, 'RATE_LIMITED');
  const other = await previewRoute(req(url(auditId), { cookie: await cookie(nextOperator()) }), ctx(auditId));
  assert.equal(other.status, 200);
  void last;
});

test('resposta sem dados sensíveis (corpo bruto, URL com segredos, caminhos do disco, autor, justificativas), com UTM comprovado', async () => {
  const { w, ana, auditId } = await setup({ seed: false });
  await writeFull(w.evidenceDir, { auditId, body: bodyText({ website: 'https://www.padaria-exemplo.example/loja/SEGREDO8;jsessionid=SEGREDO9?utm_source=ORIGEM-S&utm_medium=MEIO-M&sid=SEGREDO12#frag-SEGREDO' }) });
  await must(w.service.create({ email: 'ana@empresa.com' }, auditId, { record: rec.c2() }, clock()));
  const text = JSON.stringify(await json(await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId))));
  for (const leak of ['SEGREDO', 'ORIGEM-S', 'MEIO-M', 'jsessionid', 'frag-', 'loja/', 'SENTINELA', 'ana@empresa.com', 'Conferido no painel', w.evidenceDir, w.decisionsDir, w.anchorDir, '/tmp/', '/mnt/', 'operatorEmail', 'rawSha256', 'token=']) {
    assert.ok(!text.includes(leak), `vazou "${leak}"`);
  }
});

test('determinismo na rota: duas chamadas com os mesmos dados devolvem exatamente o mesmo corpo', async () => {
  const { w, ana, auditId } = await setup();
  await must(w.service.create({ email: 'ana@empresa.com' }, auditId, { record: rec.c2() }, clock()));
  const a = await (await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId))).text();
  const b = await (await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId))).text();
  assert.equal(a, b);
});

test('REVISÃO #2 na rota: justificativa livre do operador (N/A de S4 aplicado) e "(X de Y pontos)" nunca saem na resposta HTTP', async () => {
  const { w, ana, auditId } = await setup();
  await must(w.service.create({ email: 'ana@empresa.com' }, auditId, { record: { ...rec.naModel(), justification: 'SENTINELA-JUSTIFICATIVA-HTTP texto livre do operador' } }, clock()));
  await must(w.service.create({ email: 'ana@empresa.com' }, auditId, { record: rec.c2() }, clock()));
  const text = await (await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId))).text();
  assert.ok(!text.includes('SENTINELA') && !text.includes('texto livre do operador'));
  assert.ok(!/\d+(?:[.,]\d+)? de \d+(?:[.,]\d+)? pontos?/.test(text));
  assert.ok(!/obtainedHalfPoints/.test(text));
});

test('resposta de falha: mensagem fixa, no máximo 10 detalhes de 300 caracteres, Retry-After em READ_INCONSISTENT e nada de head nem pendente', async () => {
  const { failureResponse } = await import('../src/app/api/link-audit/scoring/shared');
  const r = failureResponse({ ok: false, code: 'READ_INCONSISTENT', issues: Array.from({ length: 25 }, () => 'x'.repeat(900)), head: { seq: 1, sha256: 'a'.repeat(64) } });
  assert.equal(r.status, 409);
  assert.equal(r.headers.get('retry-after'), '2');
  const body = await json(r);
  assert.equal(body.issues.length, 10);
  assert.ok(body.issues.every((issue: string) => issue.length === 300));
  assert.ok(!('head' in body) && !('pending' in body));
  assert.equal((await json(failureResponse({ ok: false, code: 'EVIDENCE_INTEGRITY', issues: [] }))).code, 'EVIDENCE_INTEGRITY');
});

test('INFO-1 pela rota da prévia: sem a TESTEMUNHA configurada (ou ilegível) a prévia NÃO é finalizável, não aplica decisão alguma e diz o motivo; nada é gravado', async () => {
  const { w, ana, auditId } = await setup();
  await must(w.service.create({ email: 'ana@empresa.com' }, auditId, { record: rec.c2() }, clock()));
  const good = { results: witnessDirs.base, resultAnchors: witnessDirs.anchors };
  const ok = await json(await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId)));
  assert.equal(ok.decisions.witness.status, 'UNWITNESSED');
  const cases: Array<[string, Parameters<typeof setEnv>[1], string]> = [
    ['pasta de resultados ausente', { results: undefined }, 'NOT_CONFIGURED'],
    ['pasta de recibos ausente', { resultAnchors: undefined }, 'NOT_CONFIGURED'],
    ['resultados e recibos na mesma pasta', { resultAnchors: good.results }, 'NOT_CONFIGURED'],
    ['resultados na mesma pasta das decisões', { results: w.decisionsDir }, 'NOT_CONFIGURED'],
    ['resultados na mesma pasta das evidências', { results: w.evidenceDir }, 'NOT_CONFIGURED'],
    ['recibos dos resultados na mesma pasta dos recibos das decisões', { resultAnchors: w.anchorDir }, 'NOT_CONFIGURED'],
    ['pasta de resultados inexistente', { results: path.join(good.results, 'nao-existe') }, 'UNAVAILABLE'],
  ];
  for (const [label, over, expected] of cases) {
    setEnv(w, over);
    const before = all(w);
    const response = await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId));
    assert.equal(response.status, 200, label);
    const body = await json(response);
    assert.equal(body.decisions.witness.status, expected, label);
    assert.equal(body.finalization.allowed, false, label);
    assert.deepEqual(body.decisions.applied, [], `${label}: nenhuma decisão aplicada`);
    assert.ok(body.blockers.some((b: any) => b.code === 'DECISIONS_HISTORY_UNRESOLVED' && b.severity === 'BLOCKING' && b.reasonCode === expected), `${label}: bloqueio com o estado certo`);
    assert.deepEqual(all(w), before, `${label}: nada gravado`);
    assert.ok(!JSON.stringify(body).includes(good.results), `${label}: sem caminhos`);
  }
});

test('FIAÇÃO da rota da prévia: a chave de origem configurada chega ao provedor da testemunha (pendente comprovado ⇒ HISTORY_REGRESSED; chave antiga revogada ⇒ indício ⇒ UNTRUSTED); a prévia bloqueia nos dois casos', async () => {
  const { w, ana, auditId } = await setup();
  const author = { email: 'ana@empresa.com' };
  await must(w.service.create(author, auditId, { record: rec.c2() }, clock()));
  await must(w.service.revoke(author, auditId, { revokes: 'op-0001', reason: 'Revogada porque o juízo estava errado e foi refeito.' }, clock()));
  const decisions = createDecisionService({ knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: w.decisionsDir, anchorDir: w.anchorDir, evidence: w.reader, evidenceBaseDir: w.evidenceDir });
  const preview = previewOver({ evidenceDir: w.evidenceDir, raw: decisions });
  const evaluated = await preview.evaluate(author, auditId);
  assert.ok(evaluated.ok);
  assert.ok((await makeService(witnessDirs, preview).finalize(author, auditId, { expectedHead: evaluated.value.decisions.head, expectedInputSha256: evaluated.value.inputSha256 as string })).ok);
  fs.rmSync(path.join(witnessDirs.anchors, auditId, 'a0001.json'));
  fs.rmSync(anchorPath(w, 2));
  const quarantineDir = path.join(w.decisionsDir, '..', `quarentena-fiacao-${auditId}`);
  fs.mkdirSync(quarantineDir, { recursive: true });
  fs.renameSync(path.join(w.decisionsDir, auditId, 'd0002.json'), path.join(quarantineDir, 'd0002.json'));
  const read = async () => json(await previewRoute(req(url(auditId), { cookie: ana }), ctx(auditId)));
  const configured = await read();
  assert.deepEqual([configured.decisions.witness.status, configured.finalization.allowed, configured.decisions.applied], ['HISTORY_REGRESSED', false, []]);
  env.GMN_LINK_AUDIT_ORIGIN_KEY = OTHER_ORIGIN_KEY;
  env.GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS = 'ok-test-a';
  try {
    const rotated = await read();
    assert.deepEqual([rotated.decisions.witness.status, rotated.finalization.allowed, rotated.decisions.applied], ['UNTRUSTED', false, []]);
    assert.ok(rotated.blockers.some((b: any) => b.code === 'DECISIONS_HISTORY_UNRESOLVED' && b.reasonCode === 'UNTRUSTED'));
  } finally {
    env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
    delete env.GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS;
  }
});
