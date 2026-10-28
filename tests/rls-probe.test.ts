import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRead, classifyWrite, forgedToken, runRlsProbe, summarize, TABLES } from '../src/lib/rls-probe';

test('classificação: vazio NÃO é prova de segurança; separa "sem privilégio" de "só o RLS barra"', () => {
  assert.equal(classifyRead(401, 0, 10).verdict, 'BLOCKED_BY_PRIVILEGE');
  assert.equal(classifyRead(403, 0, 10).verdict, 'BLOCKED_BY_PRIVILEGE');
  assert.deepEqual(classifyRead(200, 0, 10), { verdict: 'FILTERED_BY_RLS', singleBarrier: true });
  assert.equal(classifyRead(200, 3, 10).verdict, 'EXPOSED');
  assert.equal(classifyRead(200, 0, 0).verdict, 'UNEXPECTED', 'tabela realmente vazia não permite concluir nada');
  assert.deepEqual(classifyWrite(204, 0), { verdict: 'FILTERED_BY_RLS', singleBarrier: true });
  assert.equal(classifyWrite(200, 1).verdict, 'EXPOSED');
  assert.equal(classifyWrite(403, 0).verdict, 'BLOCKED_BY_PRIVILEGE');
});

/** Supabase falso: anon tem privilégio mas o RLS filtra; token forjado é recusado; bucket público. */
function fakeFetch(options: { rlsLeaks?: boolean; privilegesRevoked?: boolean; bucketPublic?: boolean; serviceLost?: boolean }) {
  const calls: { method: string; url: string }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = headers.Authorization ?? '';
    const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: extra });
    if (bearer.includes('assinatura-falsa')) return json({ message: 'Invalid JWT' }, 401);
    const service = bearer === 'Bearer SERVICE';
    if (url.includes('/rest/v1/rpc/')) return json({}, 404);
    if (url.includes('/rest/v1/')) {
      if (service && options.serviceLost && method !== 'GET') return json({ code: '42501' }, 403);
      if (service) return json([{ id: 'x' }], 206, { 'content-range': '0-0/10' });
      if (options.privilegesRevoked) return json({ code: '42501' }, 401);
      if (method === 'GET') return json(options.rlsLeaks ? [{ id: 'vazou' }] : [], 200, { 'content-range': '*/0' });
      return json([], 200);
    }
    if (url.includes('/storage/v1/object/public/')) return new Response(null, { status: options.bucketPublic ? 200 : 400 });
    if (url.includes('/storage/v1/object/authenticated/')) return new Response(null, { status: options.bucketPublic ? 200 : 400 });
    if (url.includes('/storage/v1/')) return json([], 200);
    if (url.includes('/auth/v1/admin/')) return json({ message: 'not admin' }, 403);
    return json({}, 404);
  }) as typeof fetch;
  return { impl, calls };
}

const base = { baseUrl: 'https://x.supabase.co', anonKey: 'ANON', serviceKey: 'SERVICE', bucket: 'b', knownObjectKey: 'audits/1/a.pdf' };

test('sonda: sem vazamento, mas com privilégios presentes ⇒ "só RLS como barreira" (defesa em profundidade ausente)', async () => {
  const { impl, calls } = fakeFetch({});
  const results = await runRlsProbe({ ...base, fetchImpl: impl });
  const summary = summarize(results);
  assert.equal(summary.ok, true);
  assert.equal(summary.exposed.length, 0);
  assert.equal(summary.singleBarrier.length, TABLES.length * 3, 'select/update/delete em cada tabela');
  // nunca usa filtro que possa afetar linhas reais
  for (const call of calls.filter((c) => c.method === 'PATCH' || c.method === 'DELETE')) assert.match(call.url, /id=eq\.00000000-0000-0000-0000-000000000000$/);
  assert.ok(results.filter((r) => r.role === 'forged').every((r) => r.verdict !== 'EXPOSED'));
});

test('sonda: detecta vazamento de linhas e bucket público; após revogar privilégios fica tudo BLOQUEADO', async () => {
  const leak = summarize(await runRlsProbe({ ...base, fetchImpl: fakeFetch({ rlsLeaks: true, bucketPublic: true }).impl }));
  assert.equal(leak.ok, false);
  assert.ok(leak.exposed.some((r) => r.operation === 'SELECT'));
  assert.ok(leak.exposed.some((r) => r.resource.startsWith('storage/b/')), 'bucket público é reportado como exposição');

  const hardened = await runRlsProbe({ ...base, fetchImpl: fakeFetch({ privilegesRevoked: true }).impl });
  const summary = summarize(hardened);
  assert.equal(summary.ok, true);
  assert.equal(summary.singleBarrier.length, 0);
  assert.ok(hardened.filter((r) => r.role === 'anon' && r.resource === 'gmn_audits').every((r) => r.verdict === 'BLOCKED_BY_PRIVILEGE'));
});

test('sonda com operador autenticado inclui o papel authenticated; JWT forjado é uma assinatura inválida', async () => {
  const results = await runRlsProbe({ ...base, userToken: 'USER', fetchImpl: fakeFetch({}).impl });
  assert.ok(results.some((r) => r.role === 'authenticated'));
  const [header, payload, signature] = forgedToken().split('.');
  assert.equal(JSON.parse(Buffer.from(payload!, 'base64url').toString()).role, 'service_role');
  assert.equal(signature, 'assinatura-falsa');
  assert.ok(header);
});

test('sonda: a service_role precisa manter acesso; perda (403 nas escritas) é sinalizada e reprova', async () => {
  const healthy = await runRlsProbe({ ...base, fetchImpl: fakeFetch({}).impl });
  const service = healthy.filter((r) => r.role === 'service_role');
  assert.equal(service.length, TABLES.length * 3);
  assert.ok(service.every((r) => r.verdict === 'SERVICE_ACCESS_OK'));
  assert.deepEqual(summarize(healthy).serviceLost, []);

  const broken = summarize(await runRlsProbe({ ...base, fetchImpl: fakeFetch({ serviceLost: true }).impl }));
  assert.equal(broken.serviceLost.length, TABLES.length * 2, 'UPDATE e DELETE de cada tabela');
  assert.equal(broken.ok, false);
});
