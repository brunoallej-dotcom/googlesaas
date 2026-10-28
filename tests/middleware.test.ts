import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { middleware } from '../src/middleware';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';

const SECRET = 'service-role-key-de-teste-0123456789';
const set = (): void => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  process.env.GMN_OPERATOR_EMAILS = 'ana@empresa.com';
  delete process.env.GMN_AUTH_DISABLED;
};
const call = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  middleware(new NextRequest(`http://app.local${path}`, { method, headers: { host: 'app.local', ...headers } }));

test('sem sessão: API e /audits/* respondem 401; páginas redirecionam para /login', async () => {
  set();
  for (const path of ['/api/prospect', '/api/audit/859b4021-404e-40fc-acba-da21e1fd4746/pdf', '/api/audit/completed', '/audits/empresa-859b4021.pdf']) {
    const response = await call(path);
    assert.equal(response.status, 401, path);
  }
  const page = await call('/');
  assert.equal(page.status, 307);
  assert.match(page.headers.get('location') ?? '', /\/login$/);
});

test('rotas de login ficam abertas; com sessão válida tudo passa', async () => {
  set();
  assert.notEqual((await call('/login')).status, 401);
  assert.equal((await call('/api/auth/login', {}, 'POST')).headers.get('x-middleware-next'), '1');
  const token = await createSessionToken('ana@empresa.com', SECRET);
  const response = await call('/audits/empresa-859b4021.pdf', { cookie: `${SESSION_COOKIE}=${token}` });
  assert.equal(response.headers.get('x-middleware-next'), '1');
});

test('sem configuração de autenticação ninguém entra (503)', async () => {
  delete process.env.GMN_OPERATOR_EMAILS;
  const response = await call('/api/audit/completed');
  assert.equal(response.status, 503);
  set();
});

test('/dev/* não existe em produção', async () => {
  set();
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    assert.equal((await call('/dev/battlefield-preview')).status, 404);
  } finally {
    env.NODE_ENV = previous;
  }
});

test('rotas de API recusam requisições sem sessão mesmo se o middleware for contornado', async () => {
  set();
  const { GET: pdf } = await import('../src/app/api/audit/[id]/pdf/route');
  const { GET: status } = await import('../src/app/api/audit/[id]/status/route');
  const { GET: completed } = await import('../src/app/api/audit/completed/route');
  const { POST: prospect } = await import('../src/app/api/prospect/route');
  const { POST: enqueue } = await import('../src/app/api/audit/enqueue/route');
  const id = '859b4021-404e-40fc-acba-da21e1fd4746';
  const ctx = { params: Promise.resolve({ id }) };
  const get = (path: string) => new Request(`http://app.local${path}`, { headers: { host: 'app.local' } });
  const post = (path: string) => new Request(`http://app.local${path}`, { method: 'POST', headers: { host: 'app.local' }, body: '{}' });
  assert.equal((await pdf(get(`/api/audit/${id}/pdf`), ctx)).status, 401);
  assert.equal((await status(get(`/api/audit/${id}/status`), ctx)).status, 401);
  assert.equal((await completed(get('/api/audit/completed?keyword=ab&placeIds=x'))).status, 401);
  assert.equal((await prospect(post('/api/prospect'))).status, 401);
  assert.equal((await enqueue(post('/api/audit/enqueue'))).status, 401);
});

test('com sessão, IDs que não são UUID são recusados (400) antes de qualquer leitura', async () => {
  set();
  const { GET: pdf } = await import('../src/app/api/audit/[id]/pdf/route');
  const token = await createSessionToken('ana@empresa.com', SECRET);
  const request = new Request('http://app.local/api/audit/x/pdf', { headers: { host: 'app.local', cookie: `${SESSION_COOKIE}=${token}` } });
  const response = await pdf(request, { params: Promise.resolve({ id: '../../etc/passwd' }) });
  assert.equal(response.status, 400);
});

test('login: só entra quem está na lista E tem senha válida; resposta idêntica para os dois erros; cookie seguro', async () => {
  set();
  const { POST: login } = await import('../src/app/api/auth/login/route');
  const { loginDependencies } = await import('../src/lib/auth/login-deps');
  const calls: string[] = [];
  loginDependencies.verify = async (email, password) => {
    calls.push(email);
    return password === 'senha-correta';
  };
  const send = (email: string, password: string, address = '10.0.0.1') =>
    login(new Request('http://app.local/api/auth/login', { method: 'POST', headers: { host: 'app.local', 'content-type': 'application/json', 'x-forwarded-for': address }, body: JSON.stringify({ email, password }) }));

  const outsider = await send('intruso@x.com', 'senha-correta');
  const wrong = await send('ana@empresa.com', 'errada');
  assert.equal(outsider.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await outsider.json(), await wrong.json());
  assert.deepEqual(calls, ['ana@empresa.com'], 'e-mail fora da lista nem chega ao Supabase');

  const ok = await send('ANA@empresa.com', 'senha-correta', '10.0.0.2');
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie') ?? '';
  assert.match(cookie, /gmn_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  // o cookie emitido é aceito pelo middleware
  const token = decodeURIComponent(/gmn_session=([^;]+)/.exec(cookie)?.[1] ?? '');
  assert.equal((await call('/api/audit/completed', { cookie: `${SESSION_COOKIE}=${token}` })).headers.get('x-middleware-next'), '1');

  // limite de tentativas por conta/endereço
  let last = 0;
  for (let i = 0; i < 7; i++) last = (await send('ana@empresa.com', 'errada', '10.0.0.9')).status;
  assert.equal(last, 429);
});

test('login: sem autenticação configurada responde 503 e logout limpa o cookie', async () => {
  set();
  const { POST: login } = await import('../src/app/api/auth/login/route');
  const { POST: logout } = await import('../src/app/api/auth/logout/route');
  delete process.env.GMN_OPERATOR_EMAILS;
  const closed = await login(new Request('http://app.local/api/auth/login', { method: 'POST', headers: { host: 'app.local' }, body: '{}' }));
  assert.equal(closed.status, 503);
  set();
  const out = await logout(new Request('http://app.local/api/auth/logout', { method: 'POST', headers: { host: 'app.local' } }));
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
});

test('cabeçalhos: Referrer-Policy precisa enviar a origem (o OpenStreetMap bloqueia tiles sem Referer)', async () => {
  const config = (await import('../next.config')).default;
  const rules = await config.headers!();
  const policy = rules.flatMap((rule) => rule.headers).find((header) => header.key === 'Referrer-Policy');
  assert.equal(policy?.value, 'strict-origin-when-cross-origin');
  assert.notEqual(policy?.value, 'no-referrer');
});

test('cookie de sessão com "%" malformado: 401 (nunca erro 500), na rota e no middleware', async () => {
  set();
  const bad = `${SESSION_COOKIE}=%E0%A4%A`;
  const page = await call('/', { cookie: bad });
  assert.equal(page.status, 307);
  assert.match(page.headers.get('location') ?? '', /\/login/);
  assert.equal((await call('/api/audit/completed', { cookie: bad })).status, 401);
  const { GET: completed } = await import('../src/app/api/audit/completed/route');
  const response = await completed(new Request('http://app.local/api/audit/completed?keyword=ab&placeIds=x', { headers: { host: 'app.local', cookie: bad } }));
  assert.equal(response.status, 401);
  // outros cookies ao lado continuam sendo lidos normalmente
  const token = await createSessionToken('ana@empresa.com', SECRET);
  assert.equal((await call('/api/audit/completed', { cookie: `outro=%ZZ; ${SESSION_COOKIE}=${token}` })).headers.get('x-middleware-next'), '1');
});

test('deploy: em produção só /dev e /dev/* são ocultados (um caminho como /devices segue o fluxo normal de autenticação)', async () => {
  set();
  const env = process.env as Record<string, string | undefined>;
  const previous = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    assert.equal((await call('/dev')).status, 404);
    assert.equal((await call('/dev/battlefield-preview')).status, 404);
    const other = await call('/devices');
    assert.notEqual(other.status, 404, '/devices não é a rota de desenvolvimento');
  } finally {
    env.NODE_ENV = previous;
  }
});

test('deploy: /api/system/client-address exige sessão e mostra o IP real (último salto), ignorando X-Real-IP forjado', async () => {
  set();
  const { GET } = await import('../src/app/api/system/client-address/route');
  const anonymous = await GET(new Request('http://app.local/api/system/client-address', { headers: { host: 'app.local' } }));
  assert.equal(anonymous.status, 401);
  assert.equal((await call('/api/system/client-address')).status, 401, 'o middleware também fecha a rota');

  const token = await createSessionToken('ana@empresa.com', SECRET);
  const response = await GET(
    new Request('http://app.local/api/system/client-address', {
      headers: { host: 'app.local', cookie: `${SESSION_COOKIE}=${token}`, 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'x-forwarded-proto': 'https' },
    })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { address: '203.0.113.9', source: 'x-forwarded-for:last-hop', forwardedHops: 2, shared: false, xRealIpPresentButIgnored: true, forwardedProto: 'https', host: 'app.local' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('deploy: limite de login por endereço só vale para IP público; IP privado (NAT) usa balde global maior', async () => {
  set();
  const { POST: login } = await import('../src/app/api/auth/login/route');
  const { loginDependencies } = await import('../src/lib/auth/login-deps');
  loginDependencies.verify = async () => false;
  const send = (email: string, headers: Record<string, string>) =>
    login(new Request('http://app.local/api/auth/login', { method: 'POST', headers: { host: 'app.local', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ email, password: 'x' }) }));
  // IP público: o 21º e-mail diferente do mesmo IP é limitado (20 por endereço)
  let status = 0;
  for (let i = 0; i < 22; i++) status = (await send(`alvo${i}@x.com`, { 'x-forwarded-for': '203.0.113.77' })).status;
  assert.equal(status, 429);
  // IP forjado em X-Real-IP e no 1º salto não ajuda a escapar
  assert.equal((await send('alvo99@x.com', { 'x-forwarded-for': '9.9.9.9, 203.0.113.77', 'x-real-ip': '8.8.8.8' })).status, 429);
  // IP privado: 30 e-mails diferentes não são bloqueados pelo balde por endereço (balde global é 100)
  let privateStatus = 0;
  for (let i = 0; i < 30; i++) privateStatus = (await send(`priv${i}@x.com`, { 'x-forwarded-for': '10.0.0.2' })).status;
  assert.equal(privateStatus, 401);
});
