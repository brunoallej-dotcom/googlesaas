import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSerperMapsUrl,
  buildSerperMapsBody,
  createSerperMapsProvider,
  type SerperTransport,
  type SerperTransportInit,
} from '../src/lib/link-audit-runtime/serper-maps-provider';
import { FAKE_KEY, PLACE, T_NOW, clock } from './helpers/link-audit-collect-fixtures';

interface Call {
  url: string;
  init: SerperTransportInit;
}

function transportReturning(body: string | (() => Promise<string>), status = 200, calls: Call[] = []): SerperTransport {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, readText: typeof body === 'function' ? body : async () => body };
  };
}

const REQUEST = { query: 'Padaria Exemplo Cidade Exemplo GO', viewport: { latitude: -16.6869, longitude: -49.2648, zoom: 17 } };

test('uma única requisição, com os campos e cabeçalhos esperados', async () => {
  const calls: Call[] = [];
  const provider = createSerperMapsProvider({ apiKey: FAKE_KEY, transport: transportReturning(JSON.stringify({ places: [PLACE] }), 200, calls), now: clock });
  const outcome = await provider.search(REQUEST);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://google.serper.dev/maps');
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(calls[0]?.init.redirect, 'error', 'a chave nunca acompanha um redirecionamento');
  assert.equal(calls[0]?.init.headers['X-API-KEY'], FAKE_KEY);
  assert.deepEqual(JSON.parse(calls[0]?.init.body ?? ''), { q: REQUEST.query, ll: '@-16.6869,-49.2648,17z', gl: 'br', hl: 'pt-br', page: 1 });
  assert.equal(outcome.state, 'OK');
  assert.equal(outcome.state === 'OK' && outcome.fetchedAt, T_NOW);
  assert.equal(outcome.state === 'OK' && outcome.value.length, 1);
});

test('sem viewport não há "ll"; zoom ausente usa o padrão', () => {
  assert.deepEqual(buildSerperMapsBody({ query: 'x y', viewport: null }), { q: 'x y', gl: 'br', hl: 'pt-br', page: 1 });
  assert.equal((buildSerperMapsBody({ query: 'x', viewport: { latitude: 1, longitude: 2, zoom: null as unknown as number } }) as { ll: string }).ll, '@1,2,14z');
});

test('sem repetição: erro HTTP, corpo inválido e falha de rede geram UMA chamada cada', async () => {
  for (const make of [
    (calls: Call[]) => transportReturning('{}', 429, calls),
    (calls: Call[]) => transportReturning('{}', 500, calls),
    (calls: Call[]) => transportReturning('não é json', 200, calls),
    (calls: Call[]): SerperTransport => async (url, init) => { calls.push({ url, init }); throw new Error('ECONNRESET'); },
  ]) {
    const calls: Call[] = [];
    const outcome = await createSerperMapsProvider({ apiKey: FAKE_KEY, transport: make(calls) }).search(REQUEST);
    assert.equal(outcome.state, 'FAILED');
    assert.equal(calls.length, 1, 'nenhuma nova tentativa');
  }
});

test('HTTP não-2xx revela só o código, nunca o corpo; resposta sem "places" é falha', async () => {
  const body = async () => { throw new Error('o corpo não deveria ser lido'); };
  const http = await createSerperMapsProvider({ apiKey: FAKE_KEY, transport: transportReturning(body, 403) }).search(REQUEST);
  assert.deepEqual(http, { state: 'FAILED', reason: 'Serper /maps respondeu HTTP 403' });
  const shape = await createSerperMapsProvider({ apiKey: FAKE_KEY, transport: transportReturning('{"outro":1}') }).search(REQUEST);
  assert.equal(shape.state, 'FAILED');
  const array = await createSerperMapsProvider({ apiKey: FAKE_KEY, transport: transportReturning('[1,2]') }).search(REQUEST);
  assert.equal(array.state, 'FAILED');
});

test('resposta acima do teto de bytes é falha (leitura do transporte lança)', async () => {
  const outcome = await createSerperMapsProvider({
    apiKey: FAKE_KEY,
    transport: transportReturning(async () => { throw new Error('resposta acima do tamanho máximo'); }),
  }).search(REQUEST);
  assert.equal(outcome.state, 'FAILED');
});

test('tempo esgotado: o sinal é abortado e o resultado é falha, sem expor a chave', async () => {
  const hang: SerperTransport = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(`abortado com ${FAKE_KEY}`))));
  const outcome = await createSerperMapsProvider({ apiKey: FAKE_KEY, transport: hang, timeoutMs: 20 }).search(REQUEST);
  assert.equal(outcome.state, 'FAILED');
  assert.ok(!JSON.stringify(outcome).includes(FAKE_KEY));
  assert.match(JSON.stringify(outcome), /tempo limite/);
});

test('a chave nunca aparece em mensagens de erro, mesmo quando o transporte a devolve', async () => {
  const leak: SerperTransport = async () => { throw new Error(`falha em https://x.example/?k=${FAKE_KEY} chave ${FAKE_KEY}`); };
  const outcome = await createSerperMapsProvider({ apiKey: FAKE_KEY, transport: leak }).search(REQUEST);
  assert.equal(outcome.state, 'FAILED');
  assert.ok(!JSON.stringify(outcome).includes(FAKE_KEY));
});

test('a URL do Serper é validada ANTES de qualquer envio: só https://*.serper.dev/maps', async () => {
  for (const bad of [
    'http://google.serper.dev/maps',
    'https://google.serper.dev/reviews',
    'https://google.serper.dev/maps?x=1',
    'https://google.serper.dev:8443/maps',
    'https://user:pw@google.serper.dev/maps',
    'https://serper.dev.evil.example/maps',
    'https://evilserper.dev/maps',
    'https://api.example.com/maps',
    'https://127.0.0.1/maps',
    'ftp://google.serper.dev/maps',
    'not a url',
  ]) {
    assert.throws(() => assertSerperMapsUrl(bad), Error, bad);
    let called = 0;
    assert.throws(() => createSerperMapsProvider({ apiKey: FAKE_KEY, url: bad, transport: async () => { called += 1; return { ok: true, status: 200, readText: async () => '{}' }; } }), Error, bad);
    assert.equal(called, 0);
  }
  assert.ok(assertSerperMapsUrl('https://google.serper.dev/maps'));
  assert.ok(assertSerperMapsUrl('https://serper.dev/maps'));
});

test('chave ausente ou curta é recusada na criação', () => {
  for (const key of ['', '  ', 'curta']) assert.throws(() => createSerperMapsProvider({ apiKey: key }));
});

test('revisão 5A: o gancho onCapture recebe status, corpo e falhas (nunca cabeçalhos/chave) e seus erros não alteram o resultado', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const provider = createSerperMapsProvider({
    apiKey: FAKE_KEY, now: clock, transport: transportReturning(JSON.stringify({ places: [PLACE], credits: 3 })),
    onCapture: (info) => { seen.push(info as unknown as Record<string, unknown>); },
  });
  const ok = await provider.search(REQUEST);
  assert.equal(ok.state, 'OK');
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0]?.httpStatus, seen[0]?.attempts, seen[0]?.failure], [200, 1, null]);
  assert.equal(JSON.parse(seen[0]?.bodyText as string).credits, 3);
  assert.deepEqual(seen[0]?.requestBody, { q: REQUEST.query, ll: '@-16.6869,-49.2648,17z', gl: 'br', hl: 'pt-br', page: 1 });
  assert.ok(!JSON.stringify(seen).includes(FAKE_KEY) && !/x-api-key/i.test(JSON.stringify(seen)));

  const http: Array<Record<string, unknown>> = [];
  await createSerperMapsProvider({ apiKey: FAKE_KEY, transport: transportReturning('{}', 500), onCapture: (i) => { http.push(i as unknown as Record<string, unknown>); } }).search(REQUEST);
  assert.deepEqual([http[0]?.httpStatus, http[0]?.bodyText], [500, null]);

  const net: Array<Record<string, unknown>> = [];
  const failing: SerperTransport = async () => { throw new Error(`ECONNRESET ${FAKE_KEY}`); };
  await createSerperMapsProvider({ apiKey: FAKE_KEY, transport: failing, onCapture: (i) => { net.push(i as unknown as Record<string, unknown>); } }).search(REQUEST);
  assert.equal(net[0]?.httpStatus, null);
  assert.ok(!JSON.stringify(net).includes(FAKE_KEY), 'a chave nunca chega ao gancho');

  const swallowed = await createSerperMapsProvider({ apiKey: FAKE_KEY, transport: transportReturning(JSON.stringify({ places: [] })), onCapture: () => { throw new Error('disco cheio'); } }).search(REQUEST);
  assert.equal(swallowed.state, 'OK', 'erro do gancho não destrói o resultado');
});
