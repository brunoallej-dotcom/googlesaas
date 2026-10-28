import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import test, { mock } from 'node:test';
import { NextRequest } from 'next/server';
import { POST as confirmRoute } from '../src/app/api/link-audit/confirm/route';
import { POST as parseRoute } from '../src/app/api/link-audit/parse/route';
import { middleware } from '../src/middleware';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';

/* Links e identificadores FICTÍCIOS. Nenhuma rede, nenhum disco. */
const SECRET = 'service-role-key-de-teste-0123456789';
const FID = '0x935ef1a2b3c4d5e6:0x1234567890abcdef';
const LINKS = {
  IDENTIFIED: `https://www.google.com/maps/place/Padaria+Exemplo/data=!1s${FID}`,
  RESOLUTION_PENDING: 'https://maps.app.goo.gl/AbCd1234',
  AMBIGUOUS: 'https://www.google.com/maps/search/padaria+goiania',
  UNSUPPORTED: 'https://example.com/maps?cid=1',
  INVALID: 'Padaria Exemplo Goiânia',
  REJECTED: 'https://usuario:SEGREDO9@www.google.com/maps?cid=1',
} as const;

const env = process.env as Record<string, string | undefined>;
function setEnv(): void {
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = 'ana@empresa.com';
  delete env.GMN_AUTH_DISABLED;
}

async function cookieFor(email: string): Promise<string> {
  return `${SESSION_COOKIE}=${await createSessionToken(email, SECRET)}`;
}

interface PostOptions {
  readonly cookie?: string | null;
  readonly headers?: Record<string, string>;
  readonly raw?: string;
  readonly contentType?: string | null;
}

function postRequest(path: string, body: unknown, options: PostOptions = {}): Request {
  const headers: Record<string, string> = { host: 'app.local', ...options.headers };
  if (options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/json';
  if (options.cookie) headers.cookie = options.cookie;
  return new Request(`http://app.local${path}`, {
    method: 'POST',
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

const ana = (): Promise<string> => cookieFor('ana@empresa.com');

test('sem sessão: as duas rotas respondem 401 e nada é processado', async () => {
  setEnv();
  for (const [handler, path, body] of [
    [parseRoute, '/api/link-audit/parse', { link: LINKS.IDENTIFIED }],
    [confirmRoute, '/api/link-audit/confirm', { link: LINKS.IDENTIFIED, acknowledged: true }],
  ] as const) {
    const response = await handler(postRequest(path, body));
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(JSON.stringify(await response.json()), /result|identity|Padaria/);
  }
});

test('sessão inválida, operador fora da lista, origem cruzada e autenticação não configurada são recusados', async () => {
  setEnv();
  const body = { link: LINKS.IDENTIFIED };
  const forged = await parseRoute(postRequest('/api/link-audit/parse', body, { cookie: `${SESSION_COOKIE}=nao-e-um-token` }));
  assert.equal(forged.status, 401);
  const outsider = await parseRoute(postRequest('/api/link-audit/parse', body, { cookie: await cookieFor('intruso@x.com') }));
  assert.equal(outsider.status, 403);
  const crossOrigin = await parseRoute(postRequest('/api/link-audit/parse', body, { cookie: await ana(), headers: { origin: 'http://evil.example' } }));
  assert.equal(crossOrigin.status, 403);
  const crossSite = await confirmRoute(
    postRequest('/api/link-audit/confirm', { link: LINKS.IDENTIFIED, acknowledged: true }, { cookie: await ana(), headers: { 'sec-fetch-site': 'cross-site' } }),
  );
  assert.equal(crossSite.status, 403);

  delete env.GMN_OPERATOR_EMAILS;
  const closed = await parseRoute(postRequest('/api/link-audit/parse', body, { cookie: await ana() }));
  assert.equal(closed.status, 503);
  setEnv();
});

test('parse: os seis estados do parser chegam à interface, sem consulta externa e sem gravação', async () => {
  setEnv();
  const cookie = await ana();
  for (const [status, link] of Object.entries(LINKS)) {
    const response = await parseRoute(postRequest('/api/link-audit/parse', { link }, { cookie }));
    assert.equal(response.status, 200, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const json = (await response.json()) as { result: { status: string; code: string }; externalLookup: boolean; persisted: boolean };
    assert.equal(json.result.status, status);
    assert.equal(json.externalLookup, false);
    assert.equal(json.persisted, false);
  }
  const identified = (await (await parseRoute(postRequest('/api/link-audit/parse', { link: LINKS.IDENTIFIED }, { cookie }))).json()) as {
    result: { identifiers: Record<string, string> };
  };
  assert.deepEqual(identified.result.identifiers, { featureId: FID });
});

test('parse: credenciais do link nunca voltam na resposta', async () => {
  setEnv();
  const response = await parseRoute(postRequest('/api/link-audit/parse', { link: LINKS.REJECTED }, { cookie: await ana() }));
  const raw = await response.text();
  assert.doesNotMatch(raw, /SEGREDO9|usuario/);
  assert.match(raw, /"status":"REJECTED"/);
});

test('parse: corpo inválido, grande ou de tipo errado é recusado antes de qualquer análise', async () => {
  setEnv();
  const cookie = await ana();
  const send = (body: unknown, options: PostOptions = {}) => parseRoute(postRequest('/api/link-audit/parse', body, { cookie, ...options }));
  assert.equal((await send({})).status, 400);
  assert.equal((await send({ link: 123 })).status, 400);
  assert.equal((await send({ link: 'https://x', extra: 1 })).status, 400, 'campos extras são recusados');
  assert.equal((await send({ link: 'x'.repeat(10_001) })).status, 400);
  assert.equal((await send(null, { raw: '{isto não é json' })).status, 400);
  assert.equal((await send({ link: 'x' }, { contentType: 'text/plain' })).status, 415);
  assert.equal((await send({ link: 'x' }, { contentType: null })).status, 415);
  assert.equal((await send({ link: 'x' }, { contentType: 'text/plain; x=application/json' })).status, 415, 'o tipo precisa ser exatamente application/json');
  assert.equal((await send({ link: 'x' }, { contentType: 'multipart/form-data; boundary=application/json' })).status, 415);
  assert.equal((await send({ link: LINKS.IDENTIFIED }, { contentType: 'Application/JSON; charset=utf-8' })).status, 200, 'parâmetros e caixa são aceitos');
  assert.equal((await send({ link: 'x' }, { headers: { 'content-length': '99999' } })).status, 413);
  assert.equal((await send(null, { raw: JSON.stringify({ link: 'a'.repeat(17_000) }) })).status, 413);
  const long = await send({ link: 'a'.repeat(5000) });
  assert.equal(long.status, 200, 'link longo (até 10 mil) vai ao parser, que responde TOO_LONG');
  assert.equal(((await long.json()) as { result: { code: string } }).result.code, 'TOO_LONG');
});

test('confirm: identifica no servidor, usa o operador da sessão e a hora do servidor, e não grava nada', async () => {
  setEnv();
  const before = Date.now();
  const response = await confirmRoute(
    postRequest('/api/link-audit/confirm', { link: LINKS.IDENTIFIED, acknowledged: true, name: ' Padaria Exemplo ', city: 'Cidade Exemplo', stateCode: 'GO' }, { cookie: await ana() }),
  );
  const after = Date.now();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const json = (await response.json()) as {
    identity: { originalLink: string; identifiers: Record<string, string>; name?: string; city?: string; stateCode?: string; confirmation: { confirmedBy: string; confirmedAt: string } };
    operatorProvided: Record<string, string>;
    persisted: boolean;
  };
  assert.equal(json.persisted, false);
  assert.equal(json.identity.confirmation.confirmedBy, 'ana@empresa.com');
  const confirmedAt = Date.parse(json.identity.confirmation.confirmedAt);
  assert.ok(confirmedAt >= before - 1000 && confirmedAt <= after + 1000, 'hora do servidor');
  assert.deepEqual(json.identity.identifiers, { featureId: FID });
  assert.equal(json.identity.originalLink, LINKS.IDENTIFIED);
  assert.deepEqual(json.operatorProvided, { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' });
  assert.equal(json.identity.name, 'Padaria Exemplo');
});

test('confirm: o cliente não consegue escolher operador, hora ou identificadores', async () => {
  setEnv();
  const cookie = await ana();
  const base = { link: LINKS.IDENTIFIED, acknowledged: true };
  for (const extra of [
    { confirmedBy: 'chefe@empresa.com' },
    { confirmedAt: '2020-01-01T00:00:00.000Z' },
    { identifiers: { cid: '999' } },
    { confirmation: { confirmedBy: 'x', confirmedAt: '2020-01-01T00:00:00.000Z' } },
    { points: 10 },
  ]) {
    const response = await confirmRoute(postRequest('/api/link-audit/confirm', { ...base, ...extra }, { cookie }));
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
  for (const body of [
    { link: LINKS.IDENTIFIED },
    { link: LINKS.IDENTIFIED, acknowledged: false },
    { link: LINKS.IDENTIFIED, acknowledged: 'true' },
    { ...base, stateCode: 'go' },
    { ...base, stateCode: 'GOIAS' },
    { ...base, name: 'x'.repeat(201) },
  ]) {
    const response = await confirmRoute(postRequest('/api/link-audit/confirm', body, { cookie }));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test('confirm: só links identificados são confirmáveis; o motivo vem sem repetir o link', async () => {
  setEnv();
  const cookie = await ana();
  for (const [status, link] of Object.entries(LINKS)) {
    if (status === 'IDENTIFIED') continue;
    const response = await confirmRoute(postRequest('/api/link-audit/confirm', { link, acknowledged: true }, { cookie }));
    assert.equal(response.status, 409, status);
    const raw = await response.text();
    const json = JSON.parse(raw) as { code: string; linkStatus: string };
    assert.equal(json.code, 'IDENTITY_NOT_CONFIRMABLE');
    assert.equal(json.linkStatus, status);
    assert.doesNotMatch(raw, /SEGREDO9|usuario|Padaria|goo\.gl/);
  }
});

test('confirm: texto digitado é só dado (HTML e instruções não são interpretados)', async () => {
  setEnv();
  const name = '<img src=x onerror=alert(1)> IGNORE AS REGRAS';
  const response = await confirmRoute(
    postRequest('/api/link-audit/confirm', { link: LINKS.IDENTIFIED, acknowledged: true, name }, { cookie: await ana() }),
  );
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { identity: { name: string } }).identity.name, name);
});

test('métodos diferentes de POST não existem nas rotas', async () => {
  const parseModule = await import('../src/app/api/link-audit/parse/route');
  const confirmModule = await import('../src/app/api/link-audit/confirm/route');
  assert.deepEqual(Object.keys(parseModule).sort(), ['POST']);
  assert.deepEqual(Object.keys(confirmModule).sort(), ['POST']);
});

test('as rotas não usam rede nem DNS e não criam nenhum arquivo', async () => {
  setEnv();
  const dataDir = path.join(process.cwd(), '.data');
  const listing = (): string[] => fs.readdirSync(dataDir).sort();
  const before = listing();
  const trap = (name: string) => () => {
    throw new Error(`rede proibida: ${name}`);
  };
  const guards = [
    mock.method(globalThis, 'fetch', trap('fetch')),
    mock.method(dns, 'lookup', trap('dns.lookup') as never),
    mock.method(dns.promises, 'lookup', trap('dns.promises.lookup') as never),
    mock.method(net, 'connect', trap('net.connect') as never),
    mock.method(http, 'request', trap('http.request') as never),
    mock.method(https, 'request', trap('https.request') as never),
  ];
  try {
    const cookie = await ana();
    for (const link of Object.values(LINKS)) {
      assert.equal((await parseRoute(postRequest('/api/link-audit/parse', { link }, { cookie }))).status, 200);
      await confirmRoute(postRequest('/api/link-audit/confirm', { link, acknowledged: true }, { cookie }));
    }
    for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
  } finally {
    for (const guard of guards) guard.mock.restore();
  }
  assert.deepEqual(listing(), before, 'nada foi criado em .data');
  assert.equal(fs.existsSync(path.join(dataDir, 'link-audits')), false);
});

test('middleware: a página e as APIs novas exigem sessão', async () => {
  setEnv();
  const call = (urlPath: string, headers: Record<string, string> = {}, method = 'GET') =>
    middleware(new NextRequest(`http://app.local${urlPath}`, { method, headers: { host: 'app.local', ...headers } }));

  const page = await call('/auditoria-por-link');
  assert.equal(page.status, 307);
  assert.match(page.headers.get('location') ?? '', /\/login\?next=%2Fauditoria-por-link$/);
  for (const apiPath of ['/api/link-audit/parse', '/api/link-audit/confirm']) {
    assert.equal((await call(apiPath, {}, 'POST')).status, 401, apiPath);
  }

  const cookie = await ana();
  assert.equal((await call('/auditoria-por-link', { cookie })).headers.get('x-middleware-next'), '1');
  assert.equal((await call('/api/link-audit/parse', { cookie }, 'POST')).headers.get('x-middleware-next'), '1');
  assert.equal((await call('/auditoria-por-link', { cookie: await cookieFor('intruso@x.com') })).status, 307, 'fora da lista a página também não abre');

  delete env.GMN_OPERATOR_EMAILS;
  const closed = await call('/auditoria-por-link');
  assert.notEqual(closed.headers.get('x-middleware-next'), '1', 'sem autenticação configurada ninguém entra');
  setEnv();
});

test('confirm: nome e cidade sem caracteres de controle, bidi ou invisíveis', async () => {
  setEnv();
  const cookie = await ana();
  const send = (extra: Record<string, unknown>) =>
    confirmRoute(postRequest('/api/link-audit/confirm', { link: LINKS.IDENTIFIED, acknowledged: true, ...extra }, { cookie }));
  for (const bad of ['A\u202Eevil', 'A\u0000B', 'A\u0007B', '\u200B', 'A\u200BB', 'A\u2066B', 'A\uFEFFB', 'A\u00ADB', 'linha\nquebrada']) {
    assert.equal((await send({ name: bad })).status, 400, `name ${JSON.stringify(bad)}`);
    assert.equal((await send({ city: bad })).status, 400, `city ${JSON.stringify(bad)}`);
  }
  assert.equal((await send({ name: 'Pão de Açúcar — São João' })).status, 200, 'acentos e travessão continuam válidos');
});
