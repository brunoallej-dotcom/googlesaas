import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_BODY_BYTES, readJsonBody } from '../src/app/api/link-audit/body';
import { POST as parseRoute } from '../src/app/api/link-audit/parse/route';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';

/* Corpos FICTÍCIOS. Prova de que o limite é aplicado ENQUANTO se lê, não depois de carregar tudo. */
const env = process.env as Record<string, string | undefined>;
const SECRET = 'service-role-key-de-teste-0123456789';

interface Probe {
  readonly stream: ReadableStream<Uint8Array>;
  readonly state: { pulled: number; cancelled: boolean };
}

/** Fluxo de `chunks` pedaços de `chunkBytes` bytes, que conta quantos pedaços foram realmente puxados. */
function probe(chunks: number, chunkBytes: number, fill = 0x20): Probe {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= chunks) return controller.close();
        state.pulled += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(fill));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

function request(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  const init = {
    method: 'POST',
    headers: { host: 'app.local', 'content-type': 'application/json', ...headers },
    body,
    ...(body !== null && typeof body !== 'string' ? { duplex: 'half' } : {}),
  } as RequestInit;
  return new Request('http://app.local/api/link-audit/parse', init);
}

const statusOf = async (result: Awaited<ReturnType<typeof readJsonBody>>): Promise<number> => (result.ok ? 200 : result.response.status);

test('fluxo grande demais: 413 e o corpo NÃO é lido até o fim (o fluxo é cancelado)', async () => {
  const { stream, state } = probe(1000, 1024); // 1 MB prometido
  const result = await readJsonBody(request(stream));
  assert.equal(await statusOf(result), 413);
  assert.equal(state.cancelled, true, 'o fluxo foi cancelado');
  assert.ok(state.pulled <= 18, `foram puxados ${state.pulled} pedaços de 1 KB; o limite é 16 KB`);
});

test('Content-Length mentindo (menor que o corpo real) não contorna o limite', async () => {
  const { stream, state } = probe(200, 1024);
  const result = await readJsonBody(request(stream, { 'content-length': '10' }));
  assert.equal(await statusOf(result), 413);
  assert.ok(state.pulled <= 18);
});

test('Content-Length declarado acima do limite recusa antes de ler qualquer byte', async () => {
  const { stream, state } = probe(1, 10);
  const result = await readJsonBody(request(stream, { 'content-length': String(MAX_BODY_BYTES + 1) }));
  assert.equal(await statusOf(result), 413);
  assert.equal(state.pulled, 0);
});

test('limite exato: 16 384 bytes passam; 16 385 não (com JSON válido)', async () => {
  const json = '{"link":"x"}';
  const exact = json + ' '.repeat(MAX_BODY_BYTES - json.length);
  assert.equal(Buffer.byteLength(exact), MAX_BODY_BYTES);
  const ok = await readJsonBody(request(exact));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.value, { link: 'x' });
  assert.equal(await statusOf(await readJsonBody(request(`${exact} `))), 413);
  // o mesmo por fluxo
  const { stream } = probe(16, 1024);
  assert.equal(await statusOf(await readJsonBody(request(stream))), 400, 'exatamente 16 KB de espaços lê tudo e falha só no JSON');
});

test('multibyte conta em bytes, não em caracteres', async () => {
  const filler = 'ã'.repeat(8100); // 16 200 bytes
  assert.ok(Buffer.byteLength(filler) < MAX_BODY_BYTES);
  assert.equal((await readJsonBody(request(JSON.stringify({ link: filler })))).ok, true);
  const tooBig = 'ã'.repeat(8300); // 16 600 bytes, mas só 8 300 caracteres
  assert.equal(await statusOf(await readJsonBody(request(JSON.stringify({ link: tooBig })))), 413);
});

test('corpo vazio, ausente, JSON inválido, tipo errado e fluxo quebrado têm respostas seguras', async () => {
  assert.equal(await statusOf(await readJsonBody(request(''))), 400, 'vazio');
  assert.equal(await statusOf(await readJsonBody(request(null))), 400, 'sem corpo');
  assert.equal(await statusOf(await readJsonBody(request('{não é json'))), 400);
  assert.equal(await statusOf(await readJsonBody(request('{}', { 'content-type': 'text/plain' }))), 415);
  assert.equal(await statusOf(await readJsonBody(request('{}', { 'content-type': 'text/plain; x=application/json' }))), 415);
  assert.equal(await statusOf(await readJsonBody(request('{}', { 'content-type': 'application/json; charset=utf-8' }))), 200);
  const broken = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error('segredo-interno token=SEGREDO-TOKEN-9'));
    },
  });
  const result = await readJsonBody(request(broken));
  assert.equal(await statusOf(result), 400);
  assert.ok(!result.ok);
  assert.doesNotMatch(await result.response.text(), /segredo-interno|SEGREDO/);
});

test('a rota recusa o corpo gigante com 413 sem processar nada e sem ler tudo', async () => {
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = 'ana@empresa.com';
  const cookie = `${SESSION_COOKIE}=${await createSessionToken('ana@empresa.com', SECRET)}`;
  const { stream, state } = probe(5000, 1024);
  const response = await parseRoute(request(stream, { cookie }));
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'Corpo da requisição grande demais.', code: 'BODY_TOO_LARGE' });
  assert.ok(state.pulled <= 18, `puxados: ${state.pulled}`);
  assert.equal(state.cancelled, true);
});

test('sem sessão a rota nem lê o corpo (401 antes de qualquer leitura)', async () => {
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = 'ana@empresa.com';
  const { stream, state } = probe(100, 1024);
  const response = await parseRoute(request(stream));
  assert.equal(response.status, 401);
  assert.equal(state.pulled, 0);
});

test('fluxo lento (gota a gota): o prazo de leitura vira 408 e o fluxo é cancelado', async () => {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(' '));
          resolve();
        }, 40);
      });
    },
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  });
  const started = Date.now();
  const result = await readJsonBody(request(slow), MAX_BODY_BYTES, 120);
  assert.equal(await statusOf(result), 408);
  assert.ok(!result.ok);
  assert.deepEqual(await result.response.json(), { error: 'Tempo esgotado ao ler o corpo da requisição.', code: 'REQUEST_TIMEOUT' });
  assert.equal(cancelled, true);
  assert.ok(Date.now() - started < 1500);
});
