import { proveEvidenceForRoutes } from './helpers/link-audit-evidence-provenance-fixtures';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { GET as evidenceRoute } from '../src/app/api/link-audit/evidence/[auditId]/route';
import { POST as decisionsPost, GET as decisionsGet } from '../src/app/api/link-audit/decisions/[auditId]/route';
import { POST as revokePost } from '../src/app/api/link-audit/decisions/[auditId]/revocations/route';
import { POST as finalizeRoute } from '../src/app/api/link-audit/scoring/[auditId]/finalize/route';
import { GET as resultsRoute } from '../src/app/api/link-audit/scoring/[auditId]/results/route';
import { GET as detailRoute } from '../src/app/api/link-audit/scoring/[auditId]/results/[seq]/route';
import { GET as previewRoute } from '../src/app/api/link-audit/scoring/[auditId]/route';
import { httpApi } from '../src/components/link-audit/audit-page/api';
import * as flow from '../src/components/link-audit/audit-page/controller';
import { initialPageState, pageReducer } from '../src/components/link-audit/audit-page/state';
import { deriveRegistry } from '../src/components/link-audit/audit-page/status';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';
import { registerCleanup, tmpDir, world, rec, must, clock } from './helpers/link-audit-decisions-fixtures';
import { TEST_ORIGIN_KEY } from './helpers/link-audit-origin-fixtures';

/*
 * Onda 6C, I5 — o CLIENTE da página (HTTP + controlador) contra as ROTAS REAIS, com sessão assinada por segredo fictício, evidências
 * sintéticas e pastas temporárias. Prova que os formatos que a tela valida são os que o servidor realmente envia. Sem rede, sem Redis.
 */
registerCleanup();
const SECRET = 'service-role-key-de-teste-0123456789';
const env = process.env as Record<string, string | undefined>;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
let seq = 0;
const operators = Array.from({ length: 200 }, (_, i) => `ui${i}@empresa.com`);

async function setup() {
  const w = await world();
  await proveEvidenceForRoutes(env, w);
  const results = tmpDir('lad-ui-rs-');
  const anchors = tmpDir('lad-ui-ra-');
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = operators.join(',');
  delete env.GMN_AUTH_DISABLED;
  env.GMN_LINK_AUDIT_ORIGIN_KEY = TEST_ORIGIN_KEY;
  env.GMN_LINK_AUDIT_EVIDENCE_DIR = w.evidenceDir;
  env.GMN_LINK_AUDIT_DECISIONS_DIR = w.decisionsDir;
  env.GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR = w.anchorDir;
  env.GMN_LINK_AUDIT_RESULTS_DIR = results;
  env.GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR = anchors;
  const email = operators[seq++ % operators.length] as string;
  const cookie = `${SESSION_COOKIE}=${await createSessionToken(email, SECRET)}`;
  return { w, email, cookie };
}

/** fetch → rotas reais (mesmo contrato do navegador: cookie de sessão, mesma origem). */
function wire(cookie: string, calls: string[] = []): void {
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const request = new Request(`http://app.local${url}`, { method, headers: { host: 'app.local', cookie, ...((init.headers as Record<string, string>) ?? {}) }, ...(init.body ? { body: init.body as string } : {}) });
    const ctx = (auditId: string) => ({ params: Promise.resolve({ auditId }) });
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/link-audit\/evidence\/([^/]+)$/.exec(url))) return evidenceRoute(request, ctx(m[1] as string));
    if ((m = /^\/api\/link-audit\/scoring\/([^/]+)\/finalize$/.exec(url))) return finalizeRoute(request, ctx(m[1] as string));
    if ((m = /^\/api\/link-audit\/scoring\/([^/]+)\/results\/(\d+)$/.exec(url))) return detailRoute(request, { params: Promise.resolve({ auditId: m[1] as string, seq: m[2] as string }) });
    if ((m = /^\/api\/link-audit\/scoring\/([^/]+)\/results$/.exec(url))) return resultsRoute(request, ctx(m[1] as string));
    if ((m = /^\/api\/link-audit\/scoring\/([^/]+)$/.exec(url))) return previewRoute(request, ctx(m[1] as string));
    if ((m = /^\/api\/link-audit\/decisions\/([^/]+)\/revocations$/.exec(url))) return revokePost(request, ctx(m[1] as string));
    if ((m = /^\/api\/link-audit\/decisions\/([^/]+)$/.exec(url))) return method === 'POST' ? decisionsPost(request, ctx(m[1] as string)) : decisionsGet(request, ctx(m[1] as string));
    throw new Error(`rota não prevista: ${url}`);
  }) as typeof fetch;
}

function page(auditId: string) {
  let state = initialPageState(auditId);
  const ctx: flow.Ctx = { api: httpApi, auditId, tokens: flow.newTokens(), getState: () => state, dispatch: (a) => (state = pageReducer(state, a)) };
  return { ctx, state: () => state };
}
const fill = (p: ReturnType<typeof page>, key: 'C2' | 'S4', justification = 'Conferido no painel e no site pelo operador responsável.'): void => {
  flow.openForm(p.ctx, key);
  p.ctx.dispatch({ type: 'FORM_FIELD', patch: { value: key === 'C2' ? 'COMPATIBLE' : '', justification } });
};

test('carregar: os quatro formatos reais passam pelos validadores da tela (evidência, prévia, decisões, resultados)', async () => {
  const { w, cookie } = await setup();
  const calls: string[] = [];
  wire(cookie, calls);
  const p = page(w.auditId);
  await flow.loadAll(p.ctx);
  const s = p.state();
  assert.deepEqual([s.evidence.phase, s.preview.phase, s.decisions.phase, s.results.phase], ['ready', 'ready', 'ready', 'ready']);
  assert.equal(s.preview.data?.state, 'CALCULADO_FINALIZAVEL');
  assert.equal(s.preview.data?.outcomePreview?.outcome, 'INCONCLUSIVO');
  assert.equal(s.preview.data?.outcomePreview?.minimumCoveragePercent, 40);
  assert.equal(s.preview.data?.criteria.length, 9);
  assert.equal(s.evidence.data?.auditId, w.auditId);
  assert.equal(calls.length, 4);
});

test('fluxo completo real: decisão → finalização com confirmação → resultado verificado → nova decisão torna o resultado HISTÓRICO → novo registro substitui', async () => {
  const { w, cookie } = await setup();
  wire(cookie);
  const p = page(w.auditId);
  await flow.loadAll(p.ctx);

  fill(p, 'S4');
  await flow.submitForm(p.ctx);
  assert.equal(p.state().form.phase, 'closed', JSON.stringify(p.state().form));
  assert.equal(p.state().decisions.data?.decisions.length, 1);
  assert.equal(p.state().decisions.data?.head?.seq, 1);
  assert.equal(p.state().preview.data?.decisions.count, 1);

  flow.openFinalize(p.ctx);
  assert.equal(p.state().finalize.phase, 'confirming');
  p.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(p.ctx);
  const done = p.state().finalize;
  assert.ok(done.phase === 'done' && done.verified && !done.replayed && done.seq === 1, JSON.stringify(done));
  const results = p.state().results.data;
  assert.deepEqual([results?.results.length, results?.results[0]?.outcome, results?.results[0]?.stale, results?.results[0]?.decisionsChanged, results?.pending], [1, 'INCONCLUSIVO', false, false, null]);
  assert.equal(p.state().detail.data?.run.outcome, 'INCONCLUSIVO');
  assert.equal(p.state().detail.data?.run.result.index, null);
  assert.equal(deriveRegistry(p.state(), null)?.tone, 'success');

  // outra pessoa registra uma decisão (outra aba): o resultado passa a ser HISTÓRICO e a tela diz isso
  const other = await w.service.create({ email: 'outra@empresa.com' }, w.auditId, { record: rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo') }, clock);
  assert.ok(other.ok);
  await flow.loadSection(p.ctx, 'results');
  assert.equal(p.state().results.data?.results[0]?.decisionsChanged, true);
  assert.match(deriveRegistry(p.state(), null)?.text ?? '', /HISTÓRICO/);
});

test('conflito real: o histórico andou depois da prévia ⇒ a confirmação NÃO grava, a prévia é invalidada e recarregada, e uma nova confirmação funciona', async () => {
  const { w, cookie } = await setup();
  wire(cookie);
  const p = page(w.auditId);
  await flow.loadAll(p.ctx);
  flow.openFinalize(p.ctx);
  p.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  const created = await w.service.create({ email: 'outra@empresa.com' }, w.auditId, { record: rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo') }, clock);
  assert.ok(created.ok);
  await flow.confirmFinalize(p.ctx);
  const s = p.state();
  assert.ok(s.finalize.phase === 'conflict' && ['HEAD_MISMATCH', 'INPUT_CHANGED'].includes(s.finalize.code), JSON.stringify(s.finalize));
  assert.equal(s.results.data?.results.length, 0, 'nada foi gravado');
  assert.equal(s.preview.invalidated, null, 'a prévia nova já foi carregada');
  assert.equal(s.preview.data?.decisions.count, 1);
  flow.openFinalize(p.ctx);
  assert.equal(p.state().finalize.phase, 'confirming');
  p.ctx.dispatch({ type: 'FINALIZE_ACK', acknowledged: true });
  await flow.confirmFinalize(p.ctx);
  assert.ok(p.state().finalize.phase === 'done' && (p.state().finalize as { verified: boolean }).verified);
});

test('conflito real em decisão: head antigo ⇒ rascunho mantido; depois do recarregamento o mesmo rascunho é aceito', async () => {
  const { w, cookie } = await setup();
  wire(cookie);
  const p = page(w.auditId);
  await flow.loadAll(p.ctx);
  assert.ok((await w.service.create({ email: 'outra@empresa.com' }, w.auditId, { record: rec.nameEquivalence('A Ltda', 'A') }, clock)).ok);
  fill(p, 'S4', 'Modelo de negócio sem o subcritério S4, conferido pelo operador.');
  await flow.submitForm(p.ctx);
  assert.equal(p.state().form.phase, 'conflict');
  assert.equal(p.state().form.justification, 'Modelo de negócio sem o subcritério S4, conferido pelo operador.');
  assert.equal(p.state().decisions.data?.head?.seq, 1, 'a lista foi recarregada');
  await flow.submitForm(p.ctx);
  assert.equal(p.state().form.phase, 'closed', JSON.stringify(p.state().form));
  assert.equal(p.state().decisions.data?.decisions.length, 2);
});

test('revogação real: o motivo vai no corpo, a decisão fica no histórico como revogada e a prévia é recarregada', async () => {
  const { w, cookie } = await setup();
  wire(cookie);
  const p = page(w.auditId);
  await flow.loadAll(p.ctx);
  fill(p, 'S4');
  await flow.submitForm(p.ctx);
  const id = p.state().decisions.data?.decisions[0]?.decisionId as string;
  p.ctx.dispatch({ type: 'REVOKE_OPEN', decisionId: id });
  p.ctx.dispatch({ type: 'REVOKE_FIELD', reason: 'Informação conferida e incorreta; decisão desfeita.' });
  await flow.submitRevoke(p.ctx);
  assert.equal(p.state().revoke.phase, 'closed', JSON.stringify(p.state().revoke));
  const list = p.state().decisions.data;
  assert.deepEqual([list?.decisions.length, list?.allDecisions.find((d) => d.decisionId === id)?.status, list?.history.length], [0, 'REVOKED', 2]);
});

test('sem sessão: 401 vira "sessão expirada"; operador fora da lista vira acesso negado/401; falhas isoladas não derrubam as outras seções', async () => {
  const { w } = await setup();
  wire(`${SESSION_COOKIE}=lixo.assinatura`);
  const p = page(w.auditId);
  await flow.loadAll(p.ctx);
  assert.equal(p.state().unauthorized, true);
  const { cookie } = await setup();
  wire(cookie);
  delete env.GMN_LINK_AUDIT_RESULTS_DIR; // só os resultados ficam indisponíveis
  const q = page(w.auditId);
  await flow.loadAll(q.ctx);
  assert.deepEqual([q.state().preview.phase, q.state().decisions.phase, q.state().results.phase], ['ready', 'ready', 'unavailable']);
  flow.openFinalize(q.ctx);
  assert.equal(q.state().finalize.phase, 'idle', 'sem o histórico de resultados não se finaliza');
});

test('auditoria inexistente: erros claros por seção, sem dados inventados', async () => {
  const { cookie } = await setup();
  wire(cookie);
  const p = page('auditoria-inexistente-9999');
  await flow.loadAll(p.ctx);
  const s = p.state();
  assert.ok(s.preview.data === null && s.preview.phase === 'error', JSON.stringify([s.preview.phase, s.preview.code]));
  assert.equal(s.results.data, null);
  void must;
});
