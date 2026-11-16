// Tests for .github/scripts/npm-audit-gate.mjs. Runs the real script against
// fabricated fixtures in a temp dir: no npm, no network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

const GATE = resolve(process.cwd(), '.github/scripts/npm-audit-gate.mjs');
const TODAY = '2026-11-16';
const created: string[] = [];

type Json = Record<string, unknown>;

const lock = (): Json => ({ packages: { '': {}, 'node_modules/foo': { version: '1.2.3' } } });
const vuln = (extra: Json = {}): Json => ({
  name: 'foo',
  severity: 'high',
  via: [{ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }],
  nodes: ['node_modules/foo'],
  ...extra,
});
const audit = (vulns: Json = { foo: vuln() }, high = 1): Json => ({
  vulnerabilities: vulns,
  metadata: { vulnerabilities: { high, critical: 0 } },
});
const exception = (extra: Json = {}): Json => ({
  name: 'foo',
  version: '1.2.3',
  max_severity: 'high',
  reason: 'test reason',
  reference: 'docs/test.md',
  review_by: '2026-12-01',
  ...extra,
});

function run(auditDoc: unknown, exceptions: unknown[] | unknown = [], lockDoc: unknown = lock()) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  created.push(dir);
  const write = (name: string, v: unknown) => writeFileSync(join(dir, name), JSON.stringify(v));
  write('audit.json', auditDoc);
  write('exc.json', { exceptions });
  write('lock.json', lockDoc);
  const r = spawnSync(
    process.execPath,
    [GATE, join(dir, 'audit.json'), join(dir, 'exc.json'), join(dir, 'lock.json'), TODAY],
    { encoding: 'utf8' },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

after(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

describe('npm-audit-gate', () => {
  it('should pass when there are no vulnerabilities', () => {
    assert.equal(run(audit({}, 0)).code, 0);
  });

  it('should pass a high advisory covered by a valid exception', () => {
    const r = run(audit(), [exception()]);
    assert.equal(r.code, 0, r.out);
  });

  it('should fail a high advisory without exception', () => {
    const r = run(audit(), []);
    assert.equal(r.code, 1);
    assert.match(r.out, /SEM exceção/);
  });

  it('should fail when vulnerabilities is an array', () => {
    const r = run({ vulnerabilities: [], metadata: { vulnerabilities: { high: 0, critical: 0 } } });
    assert.equal(r.code, 1);
    assert.match(r.out, /não é um objeto/);
  });

  it('should fail when the audit document is not an object', () => {
    assert.equal(run([]).code, 1);
    assert.equal(run(null).code, 1);
  });

  it('should fail when metadata is missing or malformed', () => {
    assert.equal(run({ vulnerabilities: {} }).code, 1);
    assert.equal(run({ vulnerabilities: {}, metadata: { vulnerabilities: { high: 'x', critical: 0 } } }).code, 1);
  });

  it('should fail when metadata declares more high/critical than analyzed', () => {
    const r = run({ vulnerabilities: {}, metadata: { vulnerabilities: { high: 2, critical: 0 } } });
    assert.equal(r.code, 1);
    assert.match(r.out, /metadata declara 2 high/);
  });

  it('should fail on invalid review_by values', () => {
    for (const review_by of ['amanhã', '9999', '2026-02-30', '2026-13-01', '2026/12/01']) {
      const r = run(audit(), [exception({ review_by })]);
      assert.equal(r.code, 1, review_by);
      assert.match(r.out, /não é data AAAA-MM-DD válida/);
    }
  });

  it('should fail on an expired review_by', () => {
    const r = run(audit(), [exception({ review_by: '2026-11-15' })]);
    assert.equal(r.code, 1);
    assert.match(r.out, /EXPIRADA/);
  });

  it('should fail when review_by is more than 90 days ahead and accept exactly 90', () => {
    const far = run(audit(), [exception({ review_by: '2027-02-15' })]);
    assert.equal(far.code, 1);
    assert.match(far.out, /passa de 90 dias/);
    assert.equal(run(audit(), [exception({ review_by: '2027-02-14' })]).code, 0);
  });

  it('should fail with a clear message when an exception is null or not an object', () => {
    for (const bad of [null, 'foo', 3, []]) {
      const r = run(audit({}, 0), [bad]);
      assert.equal(r.code, 1);
      assert.match(r.out, /deve ser um objeto/);
      assert.doesNotMatch(r.out, /TypeError/);
    }
  });

  it('should fail when exceptions is not a list', () => {
    assert.equal(run(audit({}, 0), { a: 1 }).code, 1);
  });

  it('should fail when a node is not in the lockfile even if another node is covered', () => {
    const v = vuln({ nodes: ['node_modules/foo', 'node_modules/x/node_modules/foo'] });
    const r = run(audit({ foo: v }), [exception()]);
    assert.equal(r.code, 1);
    assert.match(r.out, /ausente do lockfile/);
  });

  it('should fail when the advisory has no nodes', () => {
    assert.equal(run(audit({ foo: vuln({ nodes: [] }) }), [exception()]).code, 1);
  });

  it('should fail on unknown severity', () => {
    assert.equal(run(audit({ foo: vuln({ severity: 'HIGH' }) }, 0), [exception()]).code, 1);
  });

  it('should fail when the installed version differs from the exception', () => {
    assert.equal(run(audit(), [exception({ version: '1.2.4' })]).code, 1);
  });

  it('should fail when severity exceeds max_severity', () => {
    const a = audit({ foo: vuln({ severity: 'critical' }) }, 0);
    (a.metadata as Json).vulnerabilities = { high: 0, critical: 1 };
    assert.equal(run(a, [exception()]).code, 1);
  });

  it('should limit an exception with "advisory" to that advisory', () => {
    const ok = run(audit(), [exception({ advisory: 'GHSA-aaaa-bbbb-cccc' })]);
    assert.equal(ok.code, 0, ok.out);
    assert.equal(run(audit(), [exception({ advisory: 'GHSA-zzzz-zzzz-zzzz' })]).code, 1);
    const two = vuln({
      via: [
        { url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' },
        { url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff' },
      ],
    });
    assert.equal(run(audit({ foo: two }), [exception({ advisory: 'GHSA-aaaa-bbbb-cccc' })]).code, 1);
  });

  it('should not block moderate advisories', () => {
    const r = run(audit({ foo: vuln({ severity: 'moderate' }) }, 0), []);
    assert.equal(r.code, 0, r.out);
  });
});
