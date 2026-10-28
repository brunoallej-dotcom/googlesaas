import assert from 'node:assert/strict';
import test from 'node:test';
import type { SiteTransport } from '../src/lib/site-check';
import { createLimitedSiteTransport, createSiteProvider, SITE_MAX_HTTP_REQUESTS } from '../src/lib/link-audit-runtime/site-provider';
import { SITE_HTML, T_SITE, publicResolver } from './helpers/link-audit-collect-fixtures';

const URL_OK = 'https://www.padaria-exemplo.example/';
const html = (body: string, status = 200, headers: Record<string, string> = { 'content-type': 'text/html' }) => ({ statusCode: status, headers, body });

function provider(handler: (url: URL, seen: string[]) => ReturnType<typeof html>, seen: string[] = [], resolver = publicResolver) {
  const transport: SiteTransport = async ({ url }) => {
    seen.push(url.toString());
    return handler(url, seen);
  };
  return createSiteProvider({ transport, resolver, now: () => new Date(T_SITE) });
}

test('coleta normal: lê o HTML, não executa nada e separa o que viu', async () => {
  const seen: string[] = [];
  const p = provider((url) => (url.pathname === '/robots.txt' ? html('User-agent: *\nAllow: /', 200, { 'content-type': 'text/plain' }) : html(SITE_HTML)), seen);
  const result = await p.check(URL_OK);
  assert.equal(result.status, 'OK');
  assert.ok(result.telLinks.length >= 1);
  assert.ok(p.lastRequestCount() >= 1 && p.lastRequestCount() <= SITE_MAX_HTTP_REQUESTS);
});

test('script do site nunca é executado (marcador no <script> é só texto)', async () => {
  (globalThis as { __marcador?: number }).__marcador = 0;
  const page = `<html><head><script>globalThis.__marcador = 1</script></head><body>oi</body></html>`;
  await provider(() => html(page)).check(URL_OK);
  assert.equal((globalThis as { __marcador?: number }).__marcador, 0);
});

test('teto de 8 requisições: a 9ª é recusada pelo transporte limitador', async () => {
  let inner = 0;
  const limited = createLimitedSiteTransport(async () => { inner += 1; return html('ok'); });
  const req = (path: string) => ({ url: new URL(`https://www.padaria-exemplo.example${path}`) }) as Parameters<SiteTransport>[0];
  for (let i = 0; i < SITE_MAX_HTTP_REQUESTS; i++) await limited.transport(req(`/p${i}`));
  await assert.rejects(() => limited.transport(req('/p9')), /Limite de 8/);
  assert.equal(inner, 8);
  assert.equal(limited.count(), 8);
});

test('caminhos de login e área autenticada não são coletados', async () => {
  for (const path of ['/login', '/wp-login.php', '/wp-admin/', '/admin', '/minha-conta', '/account/settings', '/auth/callback', '/signin', '/checkout', '/oauth2/authorize', '/saml/sso', '/idp/profile', '/ServiceLogin']) {
    const limited = createLimitedSiteTransport(async () => html('ok'));
    await assert.rejects(() => limited.transport({ url: new URL(`https://a.example${path}`) } as Parameters<SiteTransport>[0]), /login|autenticada/i, path);
  }
  const ok = createLimitedSiteTransport(async () => html('ok'));
  assert.equal((await ok.transport({ url: new URL('https://a.example/contato') } as Parameters<SiteTransport>[0])).statusCode, 200);
});

test('401, 403 e WWW-Authenticate: o código real é preservado e nada além da página inicial é lido (sem rotular como segurança)', async () => {
  const r401 = await provider(() => html('', 401)).check(URL_OK);
  assert.equal(r401.status, 'HTTP_ERROR');
  assert.equal(r401.httpStatus, 401);
  assert.equal(r401.access?.authChallenge, false);
  const r401c = await provider(() => html('', 401, { 'www-authenticate': 'Basic realm="x"' })).check(URL_OK);
  assert.equal(r401c.httpStatus, 401);
  assert.equal(r401c.access?.authChallenge, true);
  const r403 = await provider(() => html('', 403)).check(URL_OK);
  assert.equal(r403.status, 'HTTP_ERROR');
  assert.equal(r403.httpStatus, 403);
  assert.equal(r403.localBusiness, null, 'nenhum conteúdo foi lido de uma resposta de erro');
  const ok200 = await provider(() => html('<html><body>oi</body></html>', 200, { 'content-type': 'text/html', 'www-authenticate': 'Basic' })).check(URL_OK);
  assert.equal(ok200.status, 'OK', 'um 200 é uma página lida, mesmo com o cabeçalho');
  assert.equal(ok200.access?.authChallenge, true);
});

test('redirecionamento para /login é bloqueado', async () => {
  const seen: string[] = [];
  const result = await provider((url) => (url.pathname === '/' ? html('', 302, { location: '/login' }) : html('painel')), seen).check(URL_OK);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.access?.loginPathBlocked, true);
  assert.ok(!seen.some((u) => u.includes('/login')), 'a página de login nunca foi requisitada');
});

test('SSRF: endereços privados, localhost e metadados são bloqueados, inclusive depois de redirecionamento', async () => {
  for (const target of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/', 'http://[::1]/', 'file:///etc/passwd']) {
    const seen: string[] = [];
    const result = await provider(() => html(SITE_HTML), seen).check(target);
    assert.notEqual(result.status, 'OK', target);
    assert.equal(seen.length, 0, `${target}: nenhuma requisição saiu`);
  }
  const seen: string[] = [];
  const hop = await provider((url) => (url.hostname === 'www.padaria-exemplo.example' ? html('', 302, { location: 'http://169.254.169.254/x' }) : html('segredo')), seen).check(URL_OK);
  assert.notEqual(hop.status, 'OK');
  assert.ok(!seen.some((u) => u.includes('169.254')), 'o salto para o IP interno nunca foi requisitado');
});

test('DNS que devolve IP interno é bloqueado (rebinding): nenhuma requisição', async () => {
  const seen: string[] = [];
  const result = await provider(() => html(SITE_HTML), seen, async () => [{ address: '10.1.2.3', family: 4 as const }]).check(URL_OK);
  assert.notEqual(result.status, 'OK');
  assert.equal(seen.length, 0);
});

test('página gigante é cortada sem estourar', async () => {
  const big = `<html><body>${'a'.repeat(5_000_000)}</body></html>`;
  const result = await provider(() => html(big)).check(URL_OK);
  assert.equal(typeof result.status, 'string', 'terminou com um resultado, sem lançar nem travar');
});

test('host de login/SSO (login.*, sso.*, accounts.*) não é coletado', async () => {
  for (const host of ['login.microsoftonline.com', 'accounts.google.com', 'sso.exemplo.com']) {
    const limited = createLimitedSiteTransport(async () => html('ok'));
    await assert.rejects(() => limited.transport({ url: new URL(`https://${host}/`) } as Parameters<SiteTransport>[0]), /login|autenticada/i, host);
  }
});

test('revisão 4D: o desafio de autenticação conta só na resposta mais recente (um salto anterior não faz o 401 final virar "exige autenticação")', async () => {
  const hop = await provider((url) => (url.pathname === '/' ? html('', 302, { location: '/home', 'www-authenticate': 'Basic' }) : html('', 401))).check(URL_OK);
  assert.equal(hop.httpStatus, 401);
  assert.equal(hop.access?.authChallenge, false);
  const real = await provider(() => html('', 401, { 'www-authenticate': 'Basic realm="x"' })).check(URL_OK);
  assert.equal(real.access?.authChallenge, true);
});
