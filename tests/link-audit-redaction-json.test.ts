import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeForOutput, toSafeJson } from '../src/lib/link-audit/url-redaction';

const KEY = 'serper-chave-ficticia-0123456789abcdef';
const LINK = 'https://www.google.com/maps/place/TUVAPLAST+COMERCIO/data=!4m2!3m1!1s0x0:0x3a3245f75b61e57e';

function withEnvKey<T>(fn: () => T): T {
  const previous = process.env.SERPER_API_KEY;
  process.env.SERPER_API_KEY = KEY;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = previous;
  }
}

test('o JSON continua válido com URLs, aspas, quebras de linha, Unicode e caracteres de controle', () => {
  const value = {
    link: LINK,
    texto: 'Linha 1\nLinha "2" \\ barra \t tab — açúcar ✓ 日本 ‮ bidi \u0000 nulo',
    lista: ['https://a.example/x?token=SEGREDO123&q=1#frag', 'sem url', 3, true, null],
    aninhado: { motivo: 'Falha em https://u:senha@host.example/p?api_key=ABC123 depois de 3 tentativas.' },
  };
  const json = toSafeJson(value);
  const parsed = JSON.parse(json) as typeof value;
  assert.equal(parsed.lista.length, 5);
  assert.equal(parsed.lista[3], true);
  assert.equal(parsed.lista[4], null);
  assert.ok(!json.includes('SEGREDO123') && !json.includes('ABC123') && !json.includes('senha@'));
});

test('link já saneado passa intacto (o segmento data=!… do Maps não é destruído)', () => {
  const out = JSON.parse(toSafeJson({ originalLink: LINK, effectiveLink: `${LINK}?cid=4193491131727734142` })) as Record<string, string>;
  assert.equal(out.originalLink, LINK);
  assert.equal(out.effectiveLink, `${LINK}?cid=4193491131727734142`);
});

test('URLs com tokens, fragmento e credenciais são reduzidas ANTES de serializar', () => {
  const dirty = 'https://admin:hunter2@www.exemplo.com/p?utm=1&token=ABCDEF&cid=4193491131727734142#segredo';
  const out = JSON.parse(toSafeJson({ u: dirty })) as { u: string };
  assert.ok(!/hunter2|ABCDEF|segredo|utm=1|admin/.test(out.u), out.u);
  assert.ok(out.u.includes('cid=4193491131727734142'), 'o identificador é preservado');
});

test('chaves sensíveis têm o valor trocado e o valor literal do ambiente nunca vaza', () => {
  const json = withEnvKey(() =>
    toSafeJson({
      headers: { 'X-API-KEY': KEY, 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, cookie: 'sid=1' },
      mensagem: `falha usando ${KEY} no destino`,
      config: { apiKey: KEY, token: 'abc', password: 'p' },
    }),
  );
  const parsed = JSON.parse(json) as { headers: Record<string, string>; mensagem: string };
  assert.ok(!json.includes(KEY));
  assert.equal(parsed.headers['X-API-KEY'], '[REDACTED]');
  assert.equal(parsed.headers.Authorization, '[REDACTED]');
  assert.equal(parsed.headers['Content-Type'], 'application/json');
  assert.ok(!/sid=1/.test(json));
  assert.match(parsed.mensagem, /\[REDACTED\]/);
});

test('o marcador "<não exibida>" não é mutilado e padrões de segredo em texto livre são redigidos com JSON válido', () => {
  const json = toSafeJson({ nota: '<não exibida>', texto: 'enviado com api_key=ABC1234 e token: XYZ98765, ok', jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop' });
  const parsed = JSON.parse(json) as { nota: string; texto: string; jwt: string };
  assert.equal(parsed.nota, '<não exibida>');
  assert.ok(!/ABC1234|XYZ98765/.test(parsed.texto));
  assert.equal(parsed.jwt, '[REDACTED]');
});

test('tipos especiais: bigint vira texto, NaN/Infinity viram null, undefined some, listas longas não são truncadas, __proto__ é inofensivo', () => {
  const longList = Array.from({ length: 120 }, (_, i) => `item ${i}`);
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"normal":1}') as unknown;
  const out = JSON.parse(toSafeJson({ big: 4193491131727734142n, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, nada: undefined, longList, hostile })) as Record<string, unknown>;
  assert.equal(out.big, '4193491131727734142');
  assert.equal(out.nan, null);
  assert.equal(out.inf, null);
  assert.ok(!('nada' in out));
  assert.equal((out.longList as string[]).length, 120);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined, 'o protótipo global não foi poluído');
  assert.equal((out.hostile as { normal: number }).normal, 1);
});

test('idempotente e a profundidade é limitada (sem estouro de pilha)', () => {
  const once = sanitizeForOutput({ a: 'https://x.example/p?token=1', b: ['q'] });
  assert.deepEqual(sanitizeForOutput(once), once);
  let deep: unknown = 'fim';
  for (let i = 0; i < 40; i++) deep = { n: deep };
  assert.doesNotThrow(() => JSON.parse(toSafeJson(deep)));
});

test('revisão 4D: variações de nomes de chave sensíveis têm o valor trocado', () => {
  const keys = ['serper_api_key', 'x-goog-api-key', 'client_secret', 'apiSecret', 'proxy-authorization', 'sessionId', 'cookies', 'private_key', 'access_key', 'refresh_token', 'db_password', 'credentials'];
  const out = JSON.parse(toSafeJson(Object.fromEntries(keys.map((k) => [k, 'valor-opaco-qualquer'])))) as Record<string, string>;
  for (const k of keys) assert.equal(out[k], '[REDACTED]', k);
  assert.equal((JSON.parse(toSafeJson({ nome: 'Padaria', cidade: 'X' })) as Record<string, string>).nome, 'Padaria');
});
