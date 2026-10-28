import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeUrlShape, isPublicIpAddress, resolvePublicAddress, UnsafeUrlError } from '../src/lib/url-safety';
import { checkWebsite, extractLocalBusiness, robotsVerdictForRoot, type SiteTransport } from '../src/lib/site-check';

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 as const }];

test('endereços internos, de nuvem e reservados não são públicos', () => {
  for (const ip of [
    '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1',
    '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:0001::', '2001:db8::1', 'ff02::1',
  ]) {
    assert.equal(isPublicIpAddress(ip), false, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicIpAddress(ip), true, ip);
  }
});

test('URLs inseguras são recusadas antes de qualquer conexão', () => {
  const blocked = [
    'http://localhost/', 'http://localhost:3000/', 'http://foo.localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/',
    // representações alternativas de 127.0.0.1
    'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://127.1/',
    'ftp://exemplo.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:senha@exemplo.com/', 'https://exemplo.com:8443/',
    'http://intranet/', 'http://servidor.local/', 'http://api.internal/', 'http://10.1.2.3/',
  ];
  for (const url of blocked) {
    assert.throws(() => assertSafeUrlShape(url), UnsafeUrlError, url);
  }
  assert.doesNotThrow(() => assertSafeUrlShape('https://www.exemplo.com.br/contato'));
  assert.doesNotThrow(() => assertSafeUrlShape('http://exemplo.com:80/'));
});

test('DNS: qualquer resposta não pública invalida o host (inclusive respostas mistas)', async () => {
  await assert.rejects(() => resolvePublicAddress('a.exemplo.com', async () => [{ address: '10.0.0.1', family: 4 }]), UnsafeUrlError);
  await assert.rejects(
    () => resolvePublicAddress('b.exemplo.com', async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]),
    UnsafeUrlError
  );
  await assert.rejects(() => resolvePublicAddress('c.exemplo.com', async () => []), UnsafeUrlError);
  await assert.rejects(() => resolvePublicAddress('d.exemplo.com', async () => { throw new Error('NXDOMAIN'); }), UnsafeUrlError);
  const ok = await resolvePublicAddress('e.exemplo.com', publicResolver);
  assert.equal(ok.address, '93.184.216.34');
});

const html = (body: string, head = ''): string => `<!doctype html><html><head><title>Teste</title>${head}</head><body>${body}</body></html>`;
const textTransport = (pages: Record<string, { status?: number; headers?: Record<string, string>; body: string }>): SiteTransport => async ({ url }) => {
  const page = pages[url.pathname] ?? { status: 404, body: '' };
  return { statusCode: page.status ?? 200, headers: { 'content-type': 'text/html', ...(page.headers ?? {}) }, body: page.body };
};

test('verificação do site: o IP validado é o único usado na conexão (anti DNS rebinding)', async () => {
  const seen: string[] = [];
  const result = await checkWebsite('https://exemplo.com.br/', {
    resolver: publicResolver,
    transport: async ({ url, address }) => {
      seen.push(`${url.hostname}->${address.address}`);
      return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: html('') };
    },
  });
  assert.equal(result.status, 'OK');
  assert.ok(seen.length >= 1 && seen.every((entry) => entry.endsWith('->93.184.216.34')));
});

test('verificação do site: a resolução é refeita a cada salto e o rebinding para IP interno é bloqueado', async () => {
  let calls = 0;
  const result = await checkWebsite('https://exemplo.com.br/', {
    // 1ª resolução: pública; 2ª (depois do redirecionamento): interna
    resolver: async () => (calls++ === 0 ? [{ address: '93.184.216.34', family: 4 as const }] : [{ address: '10.0.0.9', family: 4 as const }]),
    transport: async ({ url }) =>
      url.hostname === 'exemplo.com.br' && url.pathname === '/'
        ? { statusCode: 302, headers: { location: 'https://outro.exemplo.com.br/' }, body: '' }
        : { statusCode: 200, headers: { 'content-type': 'text/html' }, body: html('') },
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.failureReason ?? '', /não público/);
});

test('verificação do site: redirecionamento para endereço interno ou de metadados é bloqueado', async () => {
  for (const target of ['http://169.254.169.254/latest/meta-data/', 'http://localhost/admin', 'http://[::1]/', 'file:///etc/passwd']) {
    const result = await checkWebsite('https://exemplo.com.br/', {
      resolver: publicResolver,
      transport: async () => ({ statusCode: 301, headers: { location: target }, body: '' }),
    });
    assert.equal(result.status, 'BLOCKED', target);
  }
});

test('verificação do site: no máximo 3 redirecionamentos', async () => {
  const result = await checkWebsite('https://exemplo.com.br/', {
    resolver: publicResolver,
    transport: async ({ url }) => ({ statusCode: 302, headers: { location: `${url.origin}/p${Math.random().toString(36).slice(2, 6)}` }, body: '' }),
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.failureReason ?? '', /Redirecionamentos em excesso/);
});

test('verificação do site: HTTP de erro, resposta não HTML e falha de conexão são classificadas, não inventadas', async () => {
  const http404 = await checkWebsite('https://exemplo.com.br/', { resolver: publicResolver, transport: textTransport({ '/': { status: 404, body: 'x' } }) });
  assert.equal(http404.status, 'HTTP_ERROR');
  assert.equal(http404.httpStatus, 404);
  const pdf = await checkWebsite('https://exemplo.com.br/', {
    resolver: publicResolver,
    transport: async () => ({ statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: '%PDF' }),
  });
  assert.equal(pdf.status, 'NOT_HTML');
  const down = await checkWebsite('https://exemplo.com.br/', { resolver: publicResolver, transport: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down.status, 'UNREACHABLE');
  assert.equal(down.localBusiness, null);
  const none = await checkWebsite(null);
  assert.equal(none.status, 'SKIPPED');
});

test('verificação do site: schema ausente, noindex, robots.txt e contatos públicos', async () => {
  const plain = await checkWebsite('https://exemplo.com.br/', { resolver: publicResolver, transport: textTransport({ '/': { body: html('<p>Olá</p>') } }) });
  assert.equal(plain.status, 'OK');
  assert.equal(plain.localBusiness, null);
  assert.equal(plain.noindex, false);
  assert.equal(plain.robotsTxt, 'ALLOWED');

  const noindex = await checkWebsite('https://exemplo.com.br/', {
    resolver: publicResolver,
    transport: textTransport({ '/': { body: html('', '<meta name="robots" content="noindex, nofollow">') } }),
  });
  assert.equal(noindex.noindex, true);

  const header = await checkWebsite('https://exemplo.com.br/', {
    resolver: publicResolver,
    transport: textTransport({ '/': { body: html(''), headers: { 'x-robots-tag': 'noindex' } } }),
  });
  assert.equal(header.noindex, true);

  const blocked = await checkWebsite('https://exemplo.com.br/', {
    resolver: publicResolver,
    transport: textTransport({ '/': { body: html('') }, '/robots.txt': { body: 'User-agent: *\nDisallow: /\n' } }),
  });
  assert.equal(blocked.robotsTxt, 'DISALLOWED');

  const contacts = await checkWebsite('https://exemplo.com.br/', {
    resolver: publicResolver,
    transport: textTransport({ '/': { body: html('<a href="tel:+556233334444">ligar</a><a href="https://wa.me/5562999990000">zap</a><a href="mailto:a@b.com">e</a>') } }),
  });
  assert.deepEqual(contacts.telLinks, ['+556233334444']);
  assert.equal(contacts.whatsappLinks.length, 1);
  assert.deepEqual(contacts.emailLinks, ['a@b.com']);
});

test('dados estruturados: reconhece LocalBusiness e subtipos, inclusive em @graph; Organization não basta', () => {
  const ld = (data: unknown): string => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
  assert.deepEqual(extractLocalBusiness(ld({ '@type': 'Dentist', name: 'X', address: { streetAddress: 'Rua A, 1', postalCode: '75000-000' } }))?.types, ['Dentist']);
  assert.equal(extractLocalBusiness(ld({ '@graph': [{ '@type': 'WebSite' }, { '@type': ['Organization', 'LocalBusiness'], name: 'Y' }] }))?.name, 'Y');
  assert.equal(extractLocalBusiness(ld({ '@type': 'Organization', name: 'Z' })), null);
  assert.equal(extractLocalBusiness('<script type="application/ld+json">{quebrado</script>'), null);
  assert.equal(extractLocalBusiness('<p>sem json-ld</p>'), null);
});

test('robots.txt: bloqueio só quando o caminho raiz é proibido para os robôs gerais ou o Googlebot', () => {
  assert.equal(robotsVerdictForRoot('User-agent: *\nDisallow: /'), 'DISALLOWED');
  assert.equal(robotsVerdictForRoot('User-agent: *\nDisallow: /admin'), 'ALLOWED');
  assert.equal(robotsVerdictForRoot('User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /'), 'ALLOWED');
  assert.equal(robotsVerdictForRoot('User-agent: Googlebot\nDisallow: /'), 'DISALLOWED');
  assert.equal(robotsVerdictForRoot(''), 'ALLOWED');
});

test('transporte real: conecta somente ao endereço fixado (ignora o DNS), limita o corpo e identifica o robô', async () => {
  const http = await import('node:http');
  const { nodeTransport, SITE_CHECK_USER_AGENT } = await import('../src/lib/site-check');
  let seenHost = '';
  let seenAgent = '';
  const server = http.createServer((req, res) => {
    seenHost = String(req.headers.host);
    seenAgent = String(req.headers['user-agent']);
    res.setHeader('content-type', 'text/html');
    res.end('x'.repeat(2000));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    // O nome "alvo.test" não resolve em DNS algum: a conexão só funciona porque o IP foi fixado.
    const response = await nodeTransport({
      url: new URL(`http://alvo.test:${port}/pagina`),
      address: { address: '127.0.0.1', family: 4 },
      maxBytes: 500,
      timeoutMs: 3000,
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.length <= 500, `corpo limitado: ${response.body.length}`);
    assert.equal(seenHost, `alvo.test:${port}`);
    assert.equal(seenAgent, SITE_CHECK_USER_AGENT);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('transporte real: servidor que envia um byte por vez não segura a verificação indefinidamente', async () => {
  const http = await import('node:http');
  const { nodeTransport } = await import('../src/lib/site-check');
  const timers: NodeJS.Timeout[] = [];
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.write('x');
    timers.push(setInterval(() => res.write('x'), 40));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const started = Date.now();
  try {
    const outcome = await nodeTransport({ url: new URL(`http://lento.test:${port}/`), address: { address: '127.0.0.1', family: 4 }, maxBytes: 1_000_000, timeoutMs: 150 }).then(
      () => 'resolvido',
      (error: Error) => error.message
    );
    // Pode resolver com o corpo parcial (conexão encerrada) ou rejeitar; o essencial é terminar no prazo.
    assert.ok(Date.now() - started < 1500, `demorou ${Date.now() - started} ms (${outcome})`);
  } finally {
    timers.forEach(clearInterval);
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('verificação do site: prazo total garantido mesmo se o transporte nunca responder', async () => {
  const started = Date.now();
  const result = await checkWebsite('https://exemplo.com.br/', {
    resolver: publicResolver,
    transport: () => new Promise(() => undefined),
    totalTimeoutMs: 120,
  });
  assert.equal(result.status, 'UNREACHABLE');
  assert.match(result.failureReason ?? '', /Prazo total/);
  assert.ok(Date.now() - started < 1500);
});
