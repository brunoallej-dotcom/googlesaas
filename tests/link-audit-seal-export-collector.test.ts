import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli as runCollectorCli, type CliDeps } from '../scripts/link-audit-collect';
import { createFileUsedStore } from '../src/lib/link-audit-runtime/used-authorizations';
import { readCapture } from '../src/lib/link-audit-evidence/store';
import { clock, FAKE_KEY, LINK, PLACE, siteFake } from './helpers/link-audit-collect-fixtures';
import { bodyText, registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { at, HOUR, jsonOf, newOut, readJsonFile, runCli } from './helpers/link-audit-seal-export-fixtures';

/*
 * Dados 100% FICTÍCIOS; provedores falsos injetados (nenhuma chamada de rede). P1 W2 — IA-19 (RS-05, D6): o hash que o operador registra
 * em canal separado é o `source.capture.sha256` que o coletor imprime em `--json` (sem mudar o coletor), e o `export` o confronta.
 */
registerCleanup();

const AUDIT_ID = 'auth-teste-0001';
const CAPTURED_AT = '2026-10-21T12:10:00.000Z';
const BASE_ARGS = ['--link', LINK, '--operator', 'ana@empresa.com', '--name', 'Padaria Exemplo', '--city', 'Cidade Exemplo', '--uf', 'go'];
const LIVE_ARGS = ['--live', '--authorization-id', AUDIT_ID, '--max-maps-calls', '1', '--ack-cost'];
const pages = { '/': { status: 403, body: '' }, '/robots.txt': { body: '' } };

/** Uma coleta LIVE completa com `deps.out` injetado e provedores falsos; devolve as linhas impressas e a pasta de evidências. */
async function collect(json: boolean): Promise<{ code: number; out: string[]; err: string[]; evidenceDir: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const evidenceDir = tmpDir('lase-collect-');
  const deps: CliDeps = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: clock,
    loadEnv: () => undefined,
    getEnv: () => ({ SERPER_API_KEY: FAKE_KEY, GMN_LINK_AUDIT_LIVE: 'on', GMN_LINK_AUDIT_MAX_MAPS_CALLS: '1', GMN_LINK_AUDIT_AUTH_ID: AUDIT_ID }),
    usedStore: () => createFileUsedStore(tmpDir('lase-used-')),
    createLiveProviders: (_config, hooks) => ({
      maps: {
        search: async () => {
          await hooks.onCapture({ url: 'https://google.serper.dev/maps', requestBody: { q: 'x' }, httpStatus: 200, bodyText: bodyText(), attempts: 1, failure: null, capturedAt: CAPTURED_AT });
          return { state: 'OK' as const, value: [PLACE], fetchedAt: CAPTURED_AT };
        },
      },
      site: siteFake(pages),
    }),
  };
  const code = await runCollectorCli([...BASE_ARGS, ...LIVE_ARGS, '--evidence-dir', evidenceDir, ...(json ? ['--json'] : [])], deps);
  return { code, out, err, evidenceDir };
}

test('IA-19 (1): o coletor em --json imprime source.capture.sha256 (64 hex) IGUAL ao contentSha256 relido da captura; o modo legível NÃO o imprime', async () => {
  const json = await collect(true);
  assert.equal(json.code, 0, json.err.join('\n'));
  assert.equal(json.out.length, 1, 'com --json a saída é UM único JSON');
  const report = JSON.parse(json.out[0] ?? '') as { source: { capture: { sha256: string; name: string } } };
  const printed = report.source.capture.sha256;
  assert.match(printed, /^[0-9a-f]{64}$/);
  const reread = await readCapture(json.evidenceDir, AUDIT_ID, 1);
  assert.ok(reread.ok);
  assert.equal(printed, reread.value.contentSha256, 'o hash impresso é o contentSha256 de capture:c0001');
  assert.equal(report.source.capture.name, 'c0001.capture.json');

  const human = await collect(false);
  assert.equal(human.code, 0, human.err.join('\n'));
  const humanReread = await readCapture(human.evidenceDir, AUDIT_ID, 1);
  assert.ok(humanReread.ok);
  const text = [...human.out, ...human.err].join('\n');
  assert.ok(!text.includes(humanReread.value.contentSha256), 'o modo legível não mostra o hash da captura: por isso o procedimento exige --json');
  assert.ok(!/[0-9a-f]{64}/.test(text), 'nenhum hash de 64 hex na saída legível');
});

test('IA-19 (2): o hash impresso pelo coletor em --json é exatamente o que o export aceita; ausente ⇒ EXPORT_COLLECTOR_HASH_REQUIRED; outro ⇒ EXPORT_COLLECTOR_HASH_MISMATCH', async () => {
  const collected = await collect(true);
  assert.equal(collected.code, 0);
  const printed = (JSON.parse(collected.out[0] ?? '') as { source: { capture: { sha256: string } } }).source.capture.sha256;
  const now = at(CAPTURED_AT, 3 * HOUR);
  const base = ['export', '--evidence-dir', collected.evidenceDir, '--audit', AUDIT_ID, '--max-gap-hours', '24'];

  const out = newOut();
  const ok = await runCli([...base, '--collector-hash', `c0001=${printed}`, '--out', out], now);
  assert.equal(ok.code, 0, ok.stderr);
  const pkg = readJsonFile<{ entries: Array<{ ref: string; contentSha256: string }>; checks: Array<{ id: string; status: string }> }>(out);
  assert.equal(pkg.entries.find((e) => e.ref === 'capture:c0001')?.contentSha256, printed);
  assert.equal(pkg.checks.find((c) => c.id === 'COLLECTOR_HASH_MATCHES')?.status, 'PASS');

  const missing = await runCli([...base, '--out', newOut(), '--json'], now);
  assert.equal(missing.code, 3);
  assert.equal(jsonOf(missing).code, 'EXPORT_COLLECTOR_HASH_REQUIRED');
  const other = await runCli([...base, '--collector-hash', `c0001=${printed.replace(/^./, (c) => (c === '0' ? '1' : '0'))}`, '--out', newOut(), '--json'], now);
  assert.equal(other.code, 3);
  assert.equal(jsonOf(other).code, 'EXPORT_COLLECTOR_HASH_MISMATCH');
});
