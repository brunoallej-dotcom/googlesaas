import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { forgedToken, TABLES } from '../src/lib/rls-probe';
import {
  createGetOnlyFetch,
  formatReadOnlyReport,
  parseBaseUrl,
  ReadOnlyViolationError,
  runReadOnlyCli,
  runReadOnlyProbe,
  summarizeReadOnly,
  validateProbeArgs,
} from '../src/lib/rls-probe-readonly';

/*
 * Spec: docs/specs/g5-homologacao-funcional.md. O modo somente leitura NUNCA envia escrita, nem chama função,
 * Auth ou Storage, e o relatório só tem status, códigos e contagens.
 */
const BASE = 'https://lab-ref.supabase.co';
const ANON = 'ANON-KEY-SENTINEL-0123456789';
const SERVICE = 'SERVICE-KEY-SENTINEL-0123456789';
const PII = 'PII-SENTINEL-linha-vazada';
const DETAIL = 'SECRET-DETAIL-SENTINEL';
const ROOT = path.join(__dirname, '..');

type AnonMode = 'blocked' | 'filtered' | 'leak' | 'expired' | 'leak-no-range' | 'star-range';
interface FakeOptions {
  readonly anon: AnonMode;
  readonly serviceLost?: boolean;
  readonly emptyTables?: boolean;
  readonly networkError?: boolean;
}
interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

function fakeFetch(options: FakeOptions): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? 'GET', url: String(input), body: init?.body ?? null, headers });
    const bearer = headers.Authorization ?? '';
    const json = (body: unknown, status: number, extra: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: extra });
    // a mensagem do erro de rede inclui a credencial de propósito: o relatório não pode repeti-la
    if (options.networkError) throw new Error(`ERRO-DE-REDE-SENTINEL com ${bearer}`);
    if (bearer.includes('assinatura-falsa')) return json({ code: 'PGRST301', message: 'JWSError JWSInvalidSignature' }, 401);
    if (bearer === `Bearer ${SERVICE}`) {
      if (options.serviceLost) return json({ code: '42501', message: 'permission denied for table gmn_leads' }, 403);
      return options.emptyTables ? json([], 200, { 'content-range': '*/0' }) : json([{ id: 'linha-real' }], 206, { 'content-range': '0-0/7' });
    }
    if (options.anon === 'expired') return json({ code: 'PGRST303', message: 'JWT expired' }, 401);
    if (options.anon === 'leak-no-range') return json([{ id: PII }], 200);
    if (options.anon === 'star-range') return json([], 200, { 'content-range': '0-0/*' });
    if (options.anon === 'blocked') return json({ code: '42501', message: 'permission denied for table gmn_leads', details: DETAIL }, 401);
    if (options.anon === 'filtered') return json([], 200, { 'content-range': '*/0' });
    return json([{ id: PII }], 206, { 'content-range': '0-0/7' });
  }) as typeof fetch;
  return { impl, calls };
}

const config = (fetchImpl: typeof fetch) => ({ baseUrl: BASE, anonKey: ANON, serviceKey: SERVICE, fetchImpl });
const URL_SHAPE = new RegExp(`^${BASE.replace(/\./g, '\\.')}/rest/v1/(${TABLES.join('|')})\\?select=id&limit=1$`);
const SCENARIOS: ReadonlyArray<readonly [string, FakeOptions]> = [
  ['bloqueado', { anon: 'blocked' }],
  ['filtrado pelo RLS', { anon: 'filtered' }],
  ['vazamento', { anon: 'leak' }],
  ['service_role perdida', { anon: 'blocked', serviceLost: true }],
  ['tabelas vazias', { anon: 'filtered', emptyTables: true }],
  ['falha de rede', { anon: 'blocked', networkError: true }],
  ['JWT expirado', { anon: 'expired' }],
  ['vazamento sem Content-Range', { anon: 'leak-no-range' }],
];

test('em TODOS os cenários, as 15 requisições são GET, sem corpo, na URL exata de uma das 5 tabelas', async () => {
  for (const [name, options] of SCENARIOS) {
    const { impl, calls } = fakeFetch(options);
    await runReadOnlyProbe(config(impl));
    assert.equal(calls.length, TABLES.length * 3, `${name}: 5 tabelas × (service_role, anon, forjado)`);
    for (const call of calls) {
      assert.equal(call.method, 'GET', `${name}: ${call.method}`);
      assert.equal(call.body, null, `${name}: sem corpo`);
      assert.match(call.url, URL_SHAPE, `${name}: URL`);
      assert.deepEqual(Object.keys(call.headers).map((key) => key.toLowerCase()).sort(), ['apikey', 'authorization', 'prefer'], `${name}: cabeçalhos`);
      assert.equal(call.headers.Prefer, 'count=exact');
    }
    assert.equal(new Set(calls.map((c) => c.url)).size, TABLES.length, `${name}: só as 5 tabelas`);
  }
});

test('veredito: bloqueio por privilégio, filtro por RLS, vazio inconclusivo e exposição são coisas diferentes', async () => {
  const blocked = await runReadOnlyProbe(config(fakeFetch({ anon: 'blocked' }).impl));
  const anon = blocked.filter((r) => r.role === 'anon');
  assert.ok(anon.length === TABLES.length && anon.every((r) => r.verdict === 'BLOCKED_BY_PRIVILEGE' && r.status === 401 && r.code === '42501' && !r.singleBarrier && r.visibleRows === null));
  assert.ok(blocked.filter((r) => r.role === 'forged').every((r) => r.verdict === 'BLOCKED_BY_PRIVILEGE' && r.code === 'PGRST301'));
  assert.ok(blocked.filter((r) => r.role === 'service_role').every((r) => r.verdict === 'SERVICE_ACCESS_OK' && r.realRows === 7));
  assert.equal(summarizeReadOnly(blocked).exitCode, 0);

  const filtered = summarizeReadOnly(await runReadOnlyProbe(config(fakeFetch({ anon: 'filtered' }).impl)));
  assert.deepEqual([filtered.exposed, filtered.singleBarrier, filtered.exitCode], [0, TABLES.length, 0], 'só o anon tem privilégio e o RLS barra (o forjado é recusado com 401): aviso, não falha');

  const empty = await runReadOnlyProbe(config(fakeFetch({ anon: 'filtered', emptyTables: true }).impl));
  assert.ok(empty.filter((r) => r.role === 'anon').every((r) => r.verdict === 'INCONCLUSIVE_EMPTY' && r.visibleRows === 0 && r.realRows === 0));
  assert.equal(summarizeReadOnly(empty).exitCode, 3, 'vazio não prova segurança');

  const leak = await runReadOnlyProbe(config(fakeFetch({ anon: 'leak' }).impl));
  assert.ok(leak.filter((r) => r.role === 'anon').every((r) => r.verdict === 'EXPOSED' && r.visibleRows === 7));
  assert.equal(summarizeReadOnly(leak).exitCode, 1);

  const lost = summarizeReadOnly(await runReadOnlyProbe(config(fakeFetch({ anon: 'blocked', serviceLost: true }).impl)));
  assert.deepEqual([lost.serviceLost, lost.exitCode], [TABLES.length, 1]);

  const network = await runReadOnlyProbe(config(fakeFetch({ anon: 'blocked', networkError: true }).impl));
  assert.ok(network.every((r) => r.status === 0 && r.code === 'NETWORK_ERROR'));
  assert.ok(network.filter((r) => r.role !== 'service_role').every((r) => r.verdict === 'UNEXPECTED'));
  assert.equal(summarizeReadOnly(network).exitCode, 1);
});

test('o fetch protegido LANÇA, sem chamar o fetch real, para qualquer coisa que não seja a leitura fixa', async () => {
  let reached = 0;
  const inner = (async () => {
    reached += 1;
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  const guarded = createGetOnlyFetch(BASE, inner);
  const good = `${BASE}/rest/v1/gmn_leads?select=id&limit=1`;
  const headers = { apikey: ANON, Authorization: `Bearer ${ANON}`, Prefer: 'count=exact' };

  const forbidden: ReadonlyArray<readonly [string, string | URL | Request, RequestInit | undefined]> = [
    ['POST', good, { method: 'POST', headers }],
    ['PATCH', good, { method: 'PATCH', headers }],
    ['PUT', good, { method: 'PUT', headers }],
    ['DELETE', good, { method: 'DELETE', headers }],
    ['HEAD', good, { method: 'HEAD', headers }],
    ['corpo em GET', good, { headers, body: '{}' }],
    ['chamada de função', `${BASE}/rest/v1/rpc/trigger_set_updated_at`, { headers }],
    ['login', `${BASE}/auth/v1/token?grant_type=password`, { headers }],
    ['Storage', `${BASE}/storage/v1/bucket`, { headers }],
    ['tabela fora da lista', `${BASE}/rest/v1/gmn_outra?select=id&limit=1`, { headers }],
    ['consulta diferente', `${BASE}/rest/v1/gmn_leads?select=*&limit=1`, { headers }],
    ['caminho extra', `${BASE}/rest/v1/gmn_leads/extra?select=id&limit=1`, { headers }],
    ['dois pontos de interrogação', `${BASE}/rest/v1/gmn_leads?select=id&limit=1?x=1`, { headers }],
    ['outro host', 'https://outro.example/rest/v1/gmn_leads?select=id&limit=1', { headers }],
    ['entrada Request', new Request(good), { headers }],
    ['entrada URL', new URL(good), { headers }],
    ['Prefer de escrita', good, { headers: { ...headers, Prefer: 'return=representation' } }],
    ['cabeçalho desconhecido', good, { headers: { ...headers, 'x-http-method-override': 'DELETE' } }],
    ['Headers em vez de objeto', good, { headers: new Headers(headers) }],
    ['cabeçalhos em lista', good, { headers: [['apikey', ANON]] }],
    ['opção desconhecida', good, { headers, cache: 'no-store' }],
    ['redirecionamento seguido', good, { headers, redirect: 'follow' }],
    ['redirecionamento manual', good, { headers, redirect: 'manual' }],
    ['método em minúsculas', good, { headers, method: 'get' }],
    ['fragmento', `${good}#x`, { headers }],
    ['subida de diretório', `${BASE}/rest/v1/../v1/gmn_leads?select=id&limit=1`, { headers }],
    ['percent-encoding no nome', `${BASE}/rest/v1/gmn_%6ceads?select=id&limit=1`, { headers }],
    ['barra dupla', `${BASE}/rest/v1//gmn_leads?select=id&limit=1`, { headers }],
    ['sem consulta', `${BASE}/rest/v1/gmn_leads`, { headers }],
  ];
  for (const [name, input, init] of forbidden) {
    await assert.rejects(guarded(input, init), (error: unknown) => error instanceof ReadOnlyViolationError, name);
  }
  assert.equal(reached, 0, 'o fetch real nunca foi chamado');
  assert.equal((await guarded(good, { headers })).status, 200);
  assert.equal((await guarded(good, { headers, redirect: 'error' })).status, 200, 'redirect "error" (recusar redirecionamento) é permitido');
  assert.equal(reached, 2, 'só a leitura fixa passa');
});

test('o probe manda sempre redirect "error" (um redirecionamento não é seguido) e só chaves permitidas', async () => {
  const seen: RequestInit[] = [];
  const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(init ?? {});
    return new Response('[]', { status: 200, headers: { 'content-range': '*/0' } });
  }) as typeof fetch;
  await runReadOnlyProbe(config(impl));
  assert.equal(seen.length, 15);
  for (const init of seen) {
    assert.equal(init.redirect, 'error');
    assert.deepEqual(Object.keys(init).sort(), ['headers', 'redirect', 'signal']);
  }
});

test('validateProbeArgs: opção desconhecida, erro de digitação e o npm engolindo a opção NUNCA caem no modo completo (que escreve)', () => {
  assert.equal(validateProbeArgs([], {}), null);
  assert.equal(validateProbeArgs(['--read-only'], {}), null);
  assert.equal(validateProbeArgs(['--read-only', '--expect-hardened'], {}), null);
  assert.equal(validateProbeArgs(['--authenticated'], {}), null);
  for (const typo of ['--readonly', '--read_only', '--ReadOnly', '--read-only=true', '--help']) assert.match(String(validateProbeArgs([typo], {})), /Opção desconhecida/, typo);
  assert.match(String(validateProbeArgs([], { npm_config_read_only: 'true' })), /engoliu a opção --read-only.*-- --read-only/);
  assert.match(String(validateProbeArgs([], { npm_config_expect_hardened: 'true' })), /engoliu a opção --expect-hardened/);
  assert.equal(validateProbeArgs(['--read-only'], { npm_config_read_only: 'true' }), null, 'com o "--" correto a opção chega ao script');
  assert.match(String(validateProbeArgs(['--expect-hardened'], {})), /só existe junto com --read-only/);
});

test('parseBaseUrl: só https (ou loopback), sem credenciais, caminho, consulta nem fragmento; devolve a origem', () => {
  assert.equal(parseBaseUrl('https://lab-ref.supabase.co'), 'https://lab-ref.supabase.co');
  assert.equal(parseBaseUrl('  https://lab-ref.supabase.co/  '), 'https://lab-ref.supabase.co');
  assert.equal(parseBaseUrl('http://localhost:54321'), 'http://localhost:54321');
  for (const bad of ['http://lab-ref.supabase.co', 'https://u:p@lab-ref.supabase.co', 'https://h/?a=b', 'https://h/#x', 'https://h/caminho', 'https://h//', 'ftp://h', 'isto-nao-e-url', '']) assert.equal(parseBaseUrl(bad), null, bad);
});

test('anon: 401/403 só conta como "sem privilégio" com o código 42501; JWT expirado e afins são inesperados (nunca falsa garantia)', async () => {
  const expired = await runReadOnlyProbe(config(fakeFetch({ anon: 'expired' }).impl));
  assert.ok(expired.filter((r) => r.role === 'anon').every((r) => r.status === 401 && r.code === 'PGRST303' && r.verdict === 'UNEXPECTED'));
  assert.equal(summarizeReadOnly(expired).exitCode, 1);
  const blocked = await runReadOnlyProbe(config(fakeFetch({ anon: 'blocked' }).impl));
  assert.ok(blocked.filter((r) => r.role === 'anon').every((r) => r.verdict === 'BLOCKED_BY_PRIVILEGE' && r.code === '42501'));
});

test('contagem sem Content-Range ou com total "*": usa o tamanho do corpo só para contar (exposição é detectada)', async () => {
  const noRange = await runReadOnlyProbe(config(fakeFetch({ anon: 'leak-no-range' }).impl));
  assert.ok(noRange.filter((r) => r.role === 'anon').every((r) => r.verdict === 'EXPOSED' && r.visibleRows === 1));
  const star = await runReadOnlyProbe(config(fakeFetch({ anon: 'star-range' }).impl));
  assert.ok(star.filter((r) => r.role === 'anon').every((r) => r.verdict === 'FILTERED_BY_RLS' && r.visibleRows === 0));
});

const ENV = { NEXT_PUBLIC_SUPABASE_URL: BASE, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE };

async function runCli(env: Record<string, string | undefined>, argv: string[], options: FakeOptions) {
  const { impl, calls } = fakeFetch(options);
  const out: string[] = [];
  const code = await runReadOnlyCli({ env, argv, write: (line) => out.push(line), fetchImpl: impl });
  return { code, calls, text: out.join('\n') };
}

test('CLI: --authenticated com --read-only e configuração inválida são erro de uso (2) SEM nenhuma requisição', async () => {
  const withLogin = await runCli({ ...ENV, GMN_PROBE_PASSWORD: 'SENHA-SENTINEL' }, ['--read-only', '--authenticated'], { anon: 'blocked' });
  assert.deepEqual([withLogin.code, withLogin.calls.length], [2, 0]);
  assert.doesNotMatch(withLogin.text, /SENHA-SENTINEL/);

  const missing = await runCli({ NEXT_PUBLIC_SUPABASE_URL: BASE }, ['--read-only'], { anon: 'blocked' });
  assert.deepEqual([missing.code, missing.calls.length], [2, 0]);
  assert.match(missing.text, /NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY/);

  for (const badUrl of ['isto-nao-e-url', 'http://remoto.example', 'https://USUARIO-SENTINEL:SENHA-SENTINEL@lab-ref.supabase.co', 'https://lab-ref.supabase.co/SEGREDO-NO-CAMINHO', 'https://lab-ref.supabase.co/?chave=CHAVE-SENTINEL']) {
    const invalid = await runCli({ ...ENV, NEXT_PUBLIC_SUPABASE_URL: badUrl }, ['--read-only'], { anon: 'blocked' });
    assert.deepEqual([invalid.code, invalid.calls.length], [2, 0], badUrl);
    assert.doesNotMatch(invalid.text, /isto-nao-e-url|remoto\.example|USUARIO-SENTINEL|SENHA-SENTINEL|SEGREDO-NO-CAMINHO|CHAVE-SENTINEL/, 'a URL inválida não é repetida na saída');
  }

  const typo = await runCli(ENV, ['--readonly'], { anon: 'blocked' });
  assert.deepEqual([typo.code, typo.calls.length], [2, 0], 'opção desconhecida: nenhuma requisição');
  const swallowed = await runCli({ ...ENV, npm_config_read_only: 'true' }, [], { anon: 'blocked' });
  assert.deepEqual([swallowed.code, swallowed.calls.length], [2, 0], 'npm engoliu --read-only: nenhuma requisição');
});

test('CLI: --expect-hardened (critério do G5) reprova "só o RLS barra"; sem ele é só um aviso', async () => {
  const baseline = await runCli(ENV, ['--read-only'], { anon: 'filtered' });
  assert.equal(baseline.code, 0);
  assert.match(baseline.text, /Aviso: o papel tem privilégio e só o RLS barra/);
  const strict = await runCli(ENV, ['--read-only', '--expect-hardened'], { anon: 'filtered' });
  assert.equal(strict.code, 1);
  assert.match(strict.text, /FALHA \(--expect-hardened\)/);
  const hardened = await runCli(ENV, ['--read-only', '--expect-hardened'], { anon: 'blocked' });
  assert.equal(hardened.code, 0);
  assert.match(hardened.text, /Nenhuma exposição encontrada/);
  const expired = await runCli(ENV, ['--read-only', '--expect-hardened'], { anon: 'expired' });
  assert.equal(expired.code, 1, 'JWT expirado não vira "G5 efetivo"');
  assert.ok([baseline, strict, hardened, expired].every((run) => run.calls.length === 15 && run.calls.every((c) => c.method === 'GET')));
});

test('CLI: códigos de saída 0, 1 e 3; só GET; ignora bucket e senha do probe completo; mostra só o host do alvo', async () => {
  const expected: ReadonlyArray<readonly [FakeOptions, number]> = [
    [{ anon: 'blocked' }, 0],
    [{ anon: 'filtered' }, 0],
    [{ anon: 'leak' }, 1],
    [{ anon: 'blocked', serviceLost: true }, 1],
    [{ anon: 'filtered', emptyTables: true }, 3],
  ];
  for (const [options, code] of expected) {
    const run = await runCli({ ...ENV, SUPABASE_AUDIT_BUCKET: 'bucket-que-nao-deve-ser-tocado', GMN_PROBE_PASSWORD: 'x', GMN_OPERATOR_EMAILS: 'op@example.invalid' }, ['--read-only'], options);
    assert.equal(run.code, code, JSON.stringify(options));
    assert.equal(run.calls.length, 15);
    assert.ok(run.calls.every((c) => c.method === 'GET' && c.body === null && URL_SHAPE.test(c.url)));
    assert.match(run.text, /alvo \(host\): lab-ref\.supabase\.co/);
    assert.doesNotMatch(run.text, /bucket-que-nao-deve-ser-tocado|op@example\.invalid/);
  }
});

test('o relatório NUNCA contém chave, JWT, token, linha vazada nem mensagem de erro, nem quando a rede falha com a credencial na mensagem', async () => {
  const sensitive = [ANON, SERVICE, forgedToken(), 'assinatura-falsa', 'eyJ', PII, DETAIL, 'permission denied', 'JWSError', 'linha-real', 'ERRO-DE-REDE-SENTINEL', 'JWT expired'];
  for (const [name, options] of SCENARIOS) {
    const run = await runCli(ENV, ['--read-only'], options);
    for (const secret of sensitive) assert.ok(!run.text.includes(secret), `${name}: o relatório vazou "${secret}"`);
    const lines = formatReadOnlyReport(await runReadOnlyProbe(config(fakeFetch(options).impl))).join('\n');
    for (const secret of sensitive) assert.ok(!lines.includes(secret), `${name}: o formato vazou "${secret}"`);
  }
  const blocked = await runCli(ENV, ['--read-only'], { anon: 'blocked' });
  assert.match(blocked.text, /BLOCKED_BY_PRIVILEGE\s+anon\s+GET gmn_leads\s+HTTP 401 código=42501  visíveis=n\/d reais=7/);
});

const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('estático: o módulo não contém método de escrita, função remota, Auth nem Storage e só importa o probe base', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'rls-probe-readonly.ts'), 'utf8'));
  assert.doesNotMatch(code, /\b(PATCH|DELETE|POST|PUT)\b/i);
  assert.doesNotMatch(code, /\brpc\b|\bstorage\b|auth\/v1|admin\/users/i);
  assert.doesNotMatch(code, /\bbody\s*:/, 'nenhuma requisição leva corpo');
  assert.doesNotMatch(code, /\bmethod\s*:/, 'o método nunca é definido (GET é o padrão)');
  const imports = [...code.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./rls-probe', './rls-probe'], 'só o probe base (tipos e funções puras)');
  assert.match(code, /createGetOnlyFetch\(baseUrl, config\.fetchImpl \?\? fetch\)/, 'o runReadOnlyProbe usa o fetch protegido');
  assert.doesNotMatch(code, /\bfetch\(/, 'nenhuma chamada direta a fetch: toda a rede passa pelo fetch protegido');
  assert.equal(code.match(/\binner\(/g)?.length, 1, 'o fetch real só é chamado de dentro do fetch protegido');
});

test('estático: no script, o ramo --read-only vem ANTES de qualquer fetch, senha ou leitura do probe completo, e sai sem continuar', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'rls-probe.ts'), 'utf8');
  const branch = script.indexOf("process.argv.includes('--read-only')");
  assert.ok(branch > 0, 'o ramo existe');
  const validation = script.indexOf('validateProbeArgs(process.argv.slice(2), process.env)');
  assert.ok(validation > 0 && validation < branch, 'os argumentos são validados antes de tudo, inclusive antes do ramo');
  assert.match(script, /process\.exit\(2\);\n {2}\}\n {2}\/\/ O modo somente leitura/, 'argumento inválido encerra com 2 antes do modo completo');
  for (const later of ['await askHidden(', 'await fetch(', "import('@/lib/rls-probe')", 'GMN_PROBE_PASSWORD', 'SUPABASE_AUDIT_BUCKET']) {
    assert.ok(script.indexOf(later) > branch, `${later} vem depois do ramo`);
  }
  assert.match(script, /process\.exit\(await runReadOnlyCli\(/, 'o ramo termina o processo');
});
