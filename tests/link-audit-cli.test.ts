import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli, type CliDeps } from '../scripts/link-audit-collect';
import { createFileUsedStore } from '../src/lib/link-audit-runtime/used-authorizations';
import { FAKE_KEY, LINK, PLACE, SITE_HTML, clock, siteFake } from './helpers/link-audit-collect-fixtures';

function harness(env: Record<string, string> = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lal-cli-'))) {
  const out: string[] = [];
  const err: string[] = [];
  const counters = { loadEnv: 0, providers: 0, searches: 0 };
  const deps: CliDeps = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: clock,
    loadEnv: () => { counters.loadEnv += 1; },
    getEnv: () => env,
    usedStore: () => createFileUsedStore(dir),
    createLiveProviders: (_config, hooks) => {
      counters.providers += 1;
      return {
        maps: {
          search: async () => {
            counters.searches += 1;
            await hooks.onCapture({ url: 'https://google.serper.dev/maps', requestBody: { q: 'x', gl: 'br', hl: 'pt-br', page: 1 }, httpStatus: 200, bodyText: JSON.stringify({ places: [PLACE], credits: 3 }), attempts: 1, failure: null, capturedAt: '2026-10-21T12:10:00.000Z' });
            return { state: 'OK' as const, value: [PLACE], fetchedAt: '2026-10-21T12:10:00.000Z' };
          },
        },
        site: siteFake({ '/': { body: SITE_HTML }, '/robots.txt': { body: '' } }),
      };
    },
  };
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'lal-ev-'));
  return { deps, out, err, counters, dir, evidence, clean: () => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(evidence, { recursive: true, force: true }); } };
}

const BASE = ['--link', LINK, '--operator', 'ana@empresa.com', '--name', 'Padaria Exemplo', '--city', 'Cidade Exemplo', '--uf', 'go'];
const LIVE_FLAGS = ['--live', '--authorization-id', 'auth-teste-0001', '--max-maps-calls', '1', '--ack-cost'];
const LIVE_ENV = { SERPER_API_KEY: FAKE_KEY, GMN_LINK_AUDIT_LIVE: 'on', GMN_LINK_AUDIT_MAX_MAPS_CALLS: '1', GMN_LINK_AUDIT_AUTH_ID: 'auth-teste-0001' };

test('DRY_RUN é o padrão: plano e custo, sem ler o ambiente, sem provedores e sem tráfego', async () => {
  const h = harness();
  try {
    const code = await runCli(BASE, h.deps);
    assert.equal(code, 0);
    assert.deepEqual(h.counters, { loadEnv: 0, providers: 0, searches: 0 });
    const text = h.out.join('\n');
    assert.match(text, /DRY_RUN\) — nenhuma chamada foi feita/);
    assert.match(text, /serper-maps: até 1/);
    assert.match(text, /serper-reviews: até 0/);
    assert.match(text, /ESTIMATIVA NÃO CONFIRMADA/);
    assert.match(text, /Custo estimado: US\$ 0,0009 a 0,003/);
    assert.equal(fs.readdirSync(h.dir).length, 0, 'nada é gravado');
  } finally { h.clean(); }
});

test('DRY_RUN em JSON mostra externalTraffic:false e não contém tokens do link', async () => {
  const h = harness();
  try {
    const code = await runCli([...BASE.slice(0, 2).map((x, i) => (i === 1 ? `${LINK}&token=SEGREDO123#frag` : x)), ...BASE.slice(2), '--json'], h.deps);
    assert.equal(code, 0);
    const plan = JSON.parse(h.out.join('\n'));
    assert.equal(plan.externalTraffic, false);
    assert.equal(plan.mode, 'DRY_RUN');
    assert.ok(!h.out.join('\n').includes('SEGREDO123'));
  } finally { h.clean(); }
});

test('uso incorreto: argumentos ausentes, opção desconhecida, e-mail inválido, link sem identificador', async () => {
  const cases: [string[], number][] = [
    [[], 1],
    [['--link', LINK], 1],
    [['--link', LINK, '--operator', 'sem-arroba'], 1],
    [[...BASE, '--foo'], 1],
    [[...BASE, 'solto'], 1],
    [['--link', 'https://maps.app.goo.gl/abc123', '--operator', 'ana@empresa.com'], 2],
    [['--link', 'https://www.google.com/maps/search/padaria', '--operator', 'ana@empresa.com'], 2],
    [[...BASE, '--uf', 'GOIAS'], 2],
  ];
  for (const [argv, expected] of cases) {
    const h = harness();
    try {
      assert.equal(await runCli(argv, h.deps), expected, argv.join(' ').slice(0, 60));
      assert.deepEqual(h.counters, { loadEnv: 0, providers: 0, searches: 0 });
    } finally { h.clean(); }
  }
});

test('LIVE incompleto é recusado antes de ler o ambiente', async () => {
  for (const flags of [['--live'], ['--live', '--authorization-id', 'auth-teste-0001'], ['--live', '--authorization-id', 'auth-teste-0001', '--max-maps-calls', '1'], ['--live', '--authorization-id', 'auth-teste-0001', '--max-maps-calls', '2', '--ack-cost'], ['--live', '--authorization-id', 'auth-teste-0001', '--max-maps-calls', '0', '--ack-cost']]) {
    const h = harness(LIVE_ENV);
    try {
      assert.equal(await runCli([...BASE, ...flags], h.deps), 3, flags.join(' '));
      assert.deepEqual(h.counters, { loadEnv: 0, providers: 0, searches: 0 }, 'nem o ambiente foi carregado');
    } finally { h.clean(); }
  }
});

test('LIVE com ambiente incompleto ou divergente é recusado antes de criar provedores', async () => {
  for (const env of [
    {},
    { ...LIVE_ENV, GMN_LINK_AUDIT_LIVE: 'off' },
    { ...LIVE_ENV, GMN_LINK_AUDIT_AUTH_ID: 'auth-outro-9999' },
    { ...LIVE_ENV, GMN_LINK_AUDIT_MAX_MAPS_CALLS: '0' },
    { ...LIVE_ENV, SERPER_API_KEY: '' },
    { ...LIVE_ENV, SERPER_MAPS_URL: 'https://evil.example.com/maps' },
    { ...LIVE_ENV, SERPER_MAPS_URL: 'http://google.serper.dev/maps' },
  ]) {
    const h = harness(env);
    try {
      assert.equal(await runCli([...BASE, ...LIVE_FLAGS, '--evidence-dir', h.evidence], h.deps), 3, JSON.stringify(Object.keys(env)));
      assert.equal(h.counters.providers, 0);
      assert.equal(h.counters.searches, 0);
      assert.equal(h.counters.loadEnv, 1);
      assert.ok(!h.err.concat(h.out).join('\n').includes(FAKE_KEY), 'a chave não aparece');
      assert.equal(fs.readdirSync(h.dir).length, 0, 'sem marcador quando recusado');
    } finally { h.clean(); }
  }
});

test('LIVE completo (com provedores falsos): 1 chamada, marcador criado, repetição recusada', async () => {
  const h = harness(LIVE_ENV);
  try {
    assert.equal(await runCli([...BASE, ...LIVE_FLAGS, '--evidence-dir', h.evidence], h.deps), 0);
    assert.deepEqual(h.counters, { loadEnv: 1, providers: 1, searches: 1 });
    assert.deepEqual(fs.readdirSync(h.dir), ['auth-teste-0001.json']);
    const text = h.out.join('\n');
    assert.match(text, /RELATÓRIO \(LIVE\) — tráfego externo: SIM/);
    assert.ok(!text.includes(FAKE_KEY));
    const again = harness(LIVE_ENV, h.dir);
    assert.equal(await runCli([...BASE, ...LIVE_FLAGS, '--evidence-dir', again.evidence], again.deps), 3);
    assert.equal(again.counters.searches, 0, 'a segunda execução não chamou nada');
    assert.match(again.err.join('\n'), /ALREADY_USED|já foi usada/);
  } finally { h.clean(); }
});

test('--help imprime o uso e sai com 0 sem tocar em nada', async () => {
  const h = harness();
  try {
    assert.equal(await runCli(['--help'], h.deps), 0);
    assert.match(h.out.join('\n'), /Padrão: DRY_RUN/);
    assert.deepEqual(h.counters, { loadEnv: 0, providers: 0, searches: 0 });
  } finally { h.clean(); }
});

test('as travas GMN_LINK_AUDIT_* que só aparecem depois de carregar o .env.local são ignoradas', async () => {
  const fileEnv: Record<string, string> = {};
  const h = harness(fileEnv);
  const deps: CliDeps = { ...h.deps, getEnv: () => fileEnv, loadEnv: () => { Object.assign(fileEnv, LIVE_ENV); } };
  try {
    assert.equal(await runCli([...BASE, ...LIVE_FLAGS, '--evidence-dir', h.evidence], deps), 3);
    assert.equal(h.counters.providers, 0);
    assert.equal(fs.readdirSync(h.dir).length, 0);
    assert.match(h.err.join('\n'), /GMN_LINK_AUDIT_LIVE/);
  } finally { h.clean(); }
});

test('--json produz JSON sempre válido: link com data=!…, cabeçalho da chave e relatório LIVE completos, sem vazamentos', async () => {
  const dry = harness();
  try {
    assert.equal(await runCli([...BASE, '--json'], dry.deps), 0);
    const plan = JSON.parse(dry.out.join('\n')) as { request: { headers: Record<string, string> }; expectedIdentity: { cid: string } };
    assert.equal(plan.request.headers['X-API-KEY'], '[REDACTED]', 'a chave nunca é exibida e o JSON continua válido');
    assert.equal(plan.request.headers['Content-Type'], 'application/json');
    assert.equal(plan.expectedIdentity.cid, '1311768467294899695');
  } finally { dry.clean(); }

  const live = harness(LIVE_ENV);
  try {
    assert.equal(await runCli([...BASE, ...LIVE_FLAGS, '--evidence-dir', live.evidence, '--json'], live.deps), 0);
    const text = live.out.join('\n');
    const reportStart = text.indexOf('{\n  "schemaVersion"');
    assert.ok(reportStart >= 0);
    const report = JSON.parse(text.slice(reportStart)) as { identity: { originalLink: string }; identifiers: { confirmed: Array<{ type: string }> }; kind: string; externalCallsMadeByThisReport: number };
    assert.equal(report.kind, 'COLLECTION_REPORT_FROM_CAPTURE', 'a saída é o relatório ARMAZENADO');
    assert.equal(report.externalCallsMadeByThisReport, 0);
    assert.match(report.identity.originalLink, /\/data=!1s0x935ef1a2b3c4d5e6:0x1234567890abcdef/, 'o segmento data=!… do link é preservado');
    assert.ok(report.identifiers.confirmed.some((entry) => entry.type === 'cid'));
    assert.ok(!text.includes(FAKE_KEY));
  } finally { live.clean(); }
});

test('revisão 4D: --live --json imprime UM único JSON válido (o plano em texto não é misturado)', async () => {
  const live = harness(LIVE_ENV);
  try {
    assert.equal(await runCli([...BASE, ...LIVE_FLAGS, '--evidence-dir', live.evidence, '--json'], live.deps), 0);
    const parsed = JSON.parse(live.out.join('\n')) as { kind: string; methodologyVersion: string; calls: { serperMaps: { attempts: number } } };
    assert.equal(parsed.kind, 'COLLECTION_REPORT_FROM_CAPTURE');
    assert.equal(parsed.methodologyVersion, 'lumos-reconstruida-v1');
    assert.equal(parsed.calls.serperMaps.attempts, 1);
    assert.match(live.out.join('\n').split('\n')[0] ?? '', /^\{/);
  } finally { live.clean(); }
});
