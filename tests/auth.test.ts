import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { authorizeRequest, clientAddressFrom, devBypassActive, isLoopbackHost, isSharedAddress, parseOperatorAllowlist, resolveClientAddress, shouldUseSecureCookie } from '../src/lib/auth/guard';
import { safeNextPath } from '../src/lib/auth/safe-next';
import { buildSessionCookie, createSessionToken, readCookie, SESSION_COOKIE, verifySessionToken } from '../src/lib/auth/session';
import { redactSecrets, redactValue } from '../src/lib/redact';
import { SlidingWindowLimiter } from '../src/lib/rate-limit';
import { classifyError, GmnError } from '../src/lib/errors';
import { isUuid } from '../src/lib/api-limits';

const SECRET = 'service-role-key-de-teste-0123456789';
const ENV = { SUPABASE_SERVICE_ROLE_KEY: SECRET, GMN_OPERATOR_EMAILS: 'Ana@Empresa.com; bruno@empresa.com', NODE_ENV: 'production' };

const req = (headers: Record<string, string> = {}, method = 'GET') =>
  new Request('http://app.local/api/x', { method, headers: { host: 'app.local', ...headers } });

test('sessão: assinatura válida, adulteração, expiração e segredo errado', async () => {
  const now = 1_000_000;
  const token = await createSessionToken('Ana@Empresa.com', SECRET, now);
  assert.equal((await verifySessionToken(token, SECRET, now + 1000))?.e, 'ana@empresa.com');
  assert.equal(await verifySessionToken(token, 'outro-segredo', now + 1000), null);
  assert.equal(await verifySessionToken(token, SECRET, now + 13 * 3600_000), null);
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ e: 'intruso@x.com', iat: now, exp: now + 99999999, v: 1 })).toString('base64url');
  assert.equal(await verifySessionToken(`${forged}.${sig}`, SECRET, now), null);
  assert.equal(await verifySessionToken(`${body}.`, SECRET, now), null);
  assert.equal(await verifySessionToken('lixo', SECRET, now), null);
  assert.equal(await verifySessionToken(`${token}.x`, SECRET, now), null);
  assert.equal(await verifySessionToken(null, SECRET, now), null);
});

test('guarda: sem cookie, cookie inválido, operador fora da lista e operador válido', async () => {
  const none = await authorizeRequest(req(), ENV);
  assert.equal(none.ok, false);
  assert.equal(!none.ok && none.status, 401);

  const bad = await authorizeRequest(req({ cookie: `${SESSION_COOKIE}=abc.def` }), ENV);
  assert.equal(!bad.ok && bad.code, 'INVALID_SESSION');

  const outsider = await createSessionToken('intruso@x.com', SECRET);
  const denied = await authorizeRequest(req({ cookie: `${SESSION_COOKIE}=${outsider}` }), ENV);
  assert.equal(!denied.ok && denied.status, 403);

  const good = await createSessionToken('ana@empresa.com', SECRET);
  const ok = await authorizeRequest(req({ cookie: `${SESSION_COOKIE}=${good}` }), ENV);
  assert.equal(ok.ok && ok.operator, 'ana@empresa.com');

  // remover o e-mail da lista revoga a sessão já emitida
  const revoked = await authorizeRequest(req({ cookie: `${SESSION_COOKIE}=${good}` }), { ...ENV, GMN_OPERATOR_EMAILS: 'bruno@empresa.com' });
  assert.equal(!revoked.ok && revoked.status, 403);
});

test('guarda falha fechada sem segredo ou sem lista, mesmo com cookie', async () => {
  const token = await createSessionToken('ana@empresa.com', SECRET);
  const headers = { cookie: `${SESSION_COOKIE}=${token}` };
  const noList = await authorizeRequest(req(headers), { SUPABASE_SERVICE_ROLE_KEY: SECRET, NODE_ENV: 'production' });
  assert.equal(!noList.ok && noList.code, 'AUTH_NOT_CONFIGURED');
  const noSecret = await authorizeRequest(req(headers), { GMN_OPERATOR_EMAILS: 'ana@empresa.com', NODE_ENV: 'production' });
  assert.equal(!noSecret.ok && noSecret.status, 503);
});

test('bypass de desenvolvimento só com flag + development + loopback', async () => {
  const flag = { GMN_AUTH_DISABLED: 'true', NODE_ENV: 'development' };
  assert.equal(devBypassActive(flag, 'localhost:3000'), true);
  assert.equal(devBypassActive(flag, '127.0.0.1:3000'), true);
  assert.equal(devBypassActive(flag, '[::1]:3000'), true);
  assert.equal(devBypassActive(flag, 'app.empresa.com'), false);
  assert.equal(devBypassActive(flag, '192.168.0.10:3000'), false);
  assert.equal(devBypassActive({ ...flag, NODE_ENV: 'production' }, 'localhost'), false);
  assert.equal(devBypassActive({ NODE_ENV: 'development' }, 'localhost'), false);
  assert.equal(isLoopbackHost('localhost.evil.com'), false);
  assert.equal(isLoopbackHost(null), false);
  const viaBypass = await authorizeRequest(req({ host: 'localhost:3000' }), flag);
  assert.equal(viaBypass.ok && viaBypass.via, 'DEV_BYPASS');
  const exposed = await authorizeRequest(req({ host: 'servidor.empresa.com' }), flag);
  assert.equal(exposed.ok, false);
});

test('POST de outra origem é recusado mesmo com sessão válida', async () => {
  const token = await createSessionToken('ana@empresa.com', SECRET);
  const cookie = `${SESSION_COOKIE}=${token}`;
  const cross = await authorizeRequest(req({ cookie, origin: 'https://evil.example' }, 'POST'), ENV);
  assert.equal(!cross.ok && cross.code, 'CROSS_ORIGIN');
  const crossSite = await authorizeRequest(req({ cookie, 'sec-fetch-site': 'cross-site' }, 'POST'), ENV);
  assert.equal(crossSite.ok, false);
  const same = await authorizeRequest(req({ cookie, origin: 'http://app.local' }, 'POST'), ENV);
  assert.equal(same.ok, true);
});

test('lista de operadores e cookie', () => {
  assert.deepEqual(parseOperatorAllowlist(ENV), ['ana@empresa.com', 'bruno@empresa.com']);
  assert.deepEqual(parseOperatorAllowlist({ GMN_OPERATOR_EMAILS: 'invalido, , @x' }), []);
  const cookie = buildSessionCookie('tok', true);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(buildSessionCookie('tok', false), /Secure/);
  assert.equal(readCookie('a=1; gmn_session=xyz; b=2', 'gmn_session'), 'xyz');
});

test('redação de segredos em texto e metadados', () => {
  const env = { SERPER_API_KEY: 'serper-chave-secreta-123', REDIS_URL: 'rediss://default:SenhaRedis99@host.upstash.io:6379' };
  const text = redactSecrets('falha com serper-chave-secreta-123 em rediss://default:SenhaRedis99@host.upstash.io:6379 Bearer abcdefghijklmnop', env);
  assert.doesNotMatch(text, /serper-chave|SenhaRedis99|abcdefghijklmnop/);
  const meta = redactValue({ apiKey: 'x', nested: { password: 'p', ok: 'visível', url: 'https://u:segredo123@h.com/' } }, env) as Record<string, any>;
  assert.equal(meta.apiKey, '[REDACTED]');
  assert.equal(meta.nested.password, '[REDACTED]');
  assert.equal(meta.nested.ok, 'visível');
  assert.doesNotMatch(meta.nested.url, /segredo123/);
});

test('erros: mensagens públicas genéricas, sem vazar o detalhe', () => {
  const redis = classifyError(new Error('connect ECONNREFUSED 10.0.0.3:6379 senha=abc'));
  assert.equal(redis.status, 503);
  assert.doesNotMatch(redis.publicMessage, /10\.0\.0\.3|abc/);
  const unknown = classifyError(new Error('stack secreto interno'));
  assert.equal(unknown.status, 500);
  assert.doesNotMatch(unknown.publicMessage, /secreto/);
  assert.equal(classifyError(new GmnError('X', 409, 'conflito')).category, 'CONFLICT');
});

test('limitador e validação de UUID', () => {
  const limiter = new SlidingWindowLimiter(2, 1000);
  assert.equal(limiter.consume('a', 0).allowed, true);
  assert.equal(limiter.consume('a', 10).allowed, true);
  const blocked = limiter.consume('a', 20);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.equal(limiter.consume('b', 20).allowed, true);
  assert.equal(limiter.consume('a', 1500).allowed, true);
  assert.equal(isUuid('859b4021-404e-40fc-acba-da21e1fd4746'), true);
  assert.equal(isUuid('../../etc/passwd'), false);
  assert.equal(isUuid('123'), false);
});

/* ---------------------------------------------------------------- endurecimento para o deploy (Hostinger) */

test('deploy: o IP do cliente é SÓ o último salto de X-Forwarded-For; X-Real-IP e itens anteriores (do cliente) nunca contam', () => {
  const h = (init: Record<string, string>): Headers => new Headers(init);
  assert.equal(clientAddressFrom(h({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 203.0.113.9' })), '203.0.113.9', 'último salto = o que o proxy acrescentou');
  assert.equal(clientAddressFrom(h({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9', 'X-Real-IP forjado é ignorado');
  assert.equal(clientAddressFrom(h({ 'x-real-ip': '1.2.3.4' })), 'local', 'sem X-Forwarded-For, X-Real-IP sozinho não vale (acesso sem proxy)');
  assert.equal(clientAddressFrom(h({})), 'local');
  for (const bad of ['x'.repeat(500), '<script>', "1.2.3.4'; drop", 'a b c']) assert.equal(clientAddressFrom(h({ 'x-forwarded-for': `203.0.113.1, ${bad}` })), 'local', `valor inválido: ${bad.slice(0, 12)}`);
  const info = resolveClientAddress(h({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }));
  assert.deepEqual(info, { address: '203.0.113.9', source: 'x-forwarded-for:last-hop', hops: 2, shared: false });
  assert.deepEqual(resolveClientAddress(h({})), { address: 'local', source: 'none', hops: 0, shared: true });
});

test('deploy: IPs privados/loopback/local são "compartilhados" (NAT do ingress); IPs públicos não', () => {
  for (const shared of ['local', '10.0.0.2', '10.255.1.1', '127.0.0.1', '172.16.0.5', '172.31.9.9', '192.168.1.10', '169.254.1.1', '100.64.0.1', '100.127.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.7']) {
    assert.equal(isSharedAddress(shared), true, shared);
  }
  for (const pub of ['203.0.113.9', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '192.169.0.1', '2001:db8::1', '::ffff:8.8.8.8']) {
    assert.equal(isSharedAddress(pub), false, pub);
  }
});

test('deploy: cookie Secure em produção, mesmo sem x-forwarded-proto', () => {
  const plain = new Request('http://app.interno/api/auth/login', { method: 'POST' });
  assert.equal(shouldUseSecureCookie(plain, { NODE_ENV: 'production' }), true);
  assert.equal(shouldUseSecureCookie(plain, { NODE_ENV: 'development' }), false);
  assert.equal(shouldUseSecureCookie(new Request('http://app.interno/x', { headers: { 'x-forwarded-proto': 'https' } }), { NODE_ENV: 'development' }), true);
});

test('deploy: redirecionamento após o login só para caminhos internos', () => {
  assert.equal(safeNextPath('/auditoria-por-link'), '/auditoria-por-link');
  assert.equal(safeNextPath('/auditoria-por-link?x=1'), '/auditoria-por-link?x=1');
  for (const bad of [null, '', 'https://evil.com', '//evil.com', '/\\evil.com', '/\\\\evil.com', '/\tevil', '/%0d%0a', 'javascript:alert(1)', '///x', '/\u0000x']) {
    const result = safeNextPath(bad);
    assert.ok(result === '/' || (result.startsWith('/') && !result.startsWith('//') && !result.includes('\\')), `${String(bad)} -> ${result}`);
  }
  assert.equal(safeNextPath('/\\evil.com'), '/');
  assert.equal(safeNextPath('//evil.com'), '/');
});

test('deploy: o limitador tem teto rígido de chaves (IPs forjados não crescem a memória)', () => {
  const limiter = new SlidingWindowLimiter(5, 60_000, 100);
  for (let i = 0; i < 1000; i++) limiter.consume(`ip-${i}`, 1_000 + i);
  const size = (limiter as unknown as { hits: Map<string, number[]> }).hits.size;
  assert.ok(size <= 100, `tamanho ${size}`);
  assert.equal(limiter.consume('ip-999', 2_000).allowed, true, 'chave recente continua sendo contada');
});

test('deploy: o bypass de desenvolvimento é desligado no build de produção (NODE_ENV literal)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'auth', 'guard.ts'), 'utf8');
  assert.match(src, /const BUILT_FOR_PRODUCTION = process\.env\.NODE_ENV === 'production';/);
  assert.match(src, /if \(BUILT_FOR_PRODUCTION\) return false;/);
});
