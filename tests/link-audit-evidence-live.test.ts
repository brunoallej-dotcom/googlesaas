import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCli, type CliDeps } from '../scripts/link-audit-collect';
import { identifiersFingerprint, type ConsumptionAuthorization } from '../src/lib/link-audit/collector/budget';
import { runLinkAuditCollection } from '../src/lib/link-audit-runtime/run';
import { createFileUsedStore, createMemoryUsedStore } from '../src/lib/link-audit-runtime/used-authorizations';
import { clearStorageFatal, verifyAudit } from '../src/lib/link-audit-evidence/store';
import { createEvidenceReader } from '../src/lib/link-audit-evidence/reader';
import { CID, FAKE_KEY, FID, LINK, NAMED, PLACE, clock, siteFake } from './helpers/link-audit-collect-fixtures';
import { bodyText, errno, faulty, registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';

registerCleanup();

const AUDIT_ID = 'auth-teste-0001';
const AUTH: ConsumptionAuthorization = {
  authorizationId: AUDIT_ID, snapshotId: 'snap-exemplo-0001', identifiersFingerprint: identifiersFingerprint({ cid: CID, featureId: FID }),
  maxMapsCalls: 1, maxSiteHttpRequests: 8, expiresAt: '2026-10-21T13:00:00.000Z', costAcknowledged: true, operator: 'ana@empresa.com',
};
const pages = { '/': { status: 403, body: '' }, '/robots.txt': { body: '' } };
const capture = (hooks: { onCapture: (info: never) => Promise<void> }, text = bodyText()) =>
  hooks.onCapture({ url: 'https://google.serper.dev/maps', requestBody: { q: 'Padaria Exemplo Cidade Exemplo GO', gl: 'br', hl: 'pt-br', page: 1 }, httpStatus: 200, bodyText: text, attempts: 1, failure: null, capturedAt: '2026-10-21T12:10:00.000Z' } as never);

function setup(evidence: unknown, extra: { onSite?: () => void } = {}) {
  const store = createMemoryUsedStore();
  const calls = { created: 0, searches: 0, order: [] as string[] };
  const site = siteFake(pages);
  return {
    store, calls,
    deps: {
      now: clock, liveEnabled: true, usedStore: store, evidence,
      createLiveProviders: (hooks: { onCapture: (info: never) => Promise<void> }) => {
        calls.created += 1;
        return {
          maps: { search: async () => { calls.searches += 1; calls.order.push('maps'); await capture(hooks); calls.order.push('maps-persistido'); return { state: 'OK' as const, value: [PLACE], fetchedAt: '2026-10-21T12:10:00.000Z' }; } },
          site: { check: async (url: string) => { calls.order.push('site'); extra.onSite?.(); return site.check(url); } },
        };
      },
    },
  };
}

test('LIVE sem armazenamento configurado ou com pasta proibida: bloqueado ANTES de consumir a autorização e sem criar provedores', async () => {
  const project = tmpDir('laproj-');
  for (const evidence of [undefined, { baseDir: path.join(project, 'public', 'ev'), projectRoot: project }, { baseDir: '' }]) {
    const s = setup(evidence);
    const r = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH }, s.deps as never);
    assert.ok(!r.ok && r.code === 'STORAGE_NOT_READY', JSON.stringify(evidence));
    assert.equal(s.calls.created, 0);
    assert.equal(s.store.isUsed(AUDIT_ID), false, 'a autorização NÃO foi consumida');
  }
  assert.ok(!fs.existsSync(path.join(project, 'public')));
});

test('LIVE com id de autorização que não serve de identificador de auditoria: bloqueado antes de gastar', async () => {
  const s = setup({ baseDir: tmpDir() });
  const r = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: { ...AUTH, authorizationId: 'AB_cd-1' } }, s.deps as never);
  assert.ok(!r.ok);
  assert.equal(s.calls.searches, 0);
});

test('LIVE com armazenamento pronto: a resposta paga é gravada ANTES do site; captura, site e relatório ficam publicados e o relatório devolvido é o armazenado', async () => {
  const base = tmpDir();
  const captureFile = path.join(base, AUDIT_ID, 'c0001.capture.json');
  let existedAtSiteTime = false;
  const s = setup({ baseDir: base }, { onSite: () => { existedAtSiteTime = fs.existsSync(captureFile); } });
  const r = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH }, s.deps as never);
  assert.ok(r.ok && r.kind === 'REPORT');
  assert.equal(existedAtSiteTime, true, 'a captura já estava em disco quando o site foi consultado');
  assert.deepEqual(s.calls.order, ['maps', 'maps-persistido', 'site']);
  const p = r.persisted;
  assert.ok(p && p.errors.length === 0 && p.captureNumber === 1 && p.revision === 1);
  assert.ok(fs.existsSync(path.join(base, AUDIT_ID, 'c0001.site.json')) && fs.existsSync(path.join(base, AUDIT_ID, 'c0001.report-r0001.json')));
  const stored = JSON.parse(fs.readFileSync(path.join(base, AUDIT_ID, 'c0001.report-r0001.json'), 'utf8')) as { report: { kind: string; identifiers: { confirmed: Array<{ type: string }> }; data: { site: { accessClass: string } } } };
  assert.deepEqual(JSON.parse(JSON.stringify(p.storedReport)), stored.report, 'o relatório devolvido é exatamente o armazenado');
  assert.equal(stored.report.kind, 'COLLECTION_REPORT_FROM_CAPTURE');
  assert.ok(stored.report.identifiers.confirmed.some((c) => c.type === 'cid'));
  assert.equal(stored.report.data.site.accessClass, 'HTTP_403');
  const v = await verifyAudit(base, AUDIT_ID);
  assert.ok(v.ok && v.value.state === 'COMPLETE');
  const raw = JSON.parse(fs.readFileSync(captureFile, 'utf8')) as { response: { bodyText: string; httpStatus: number }; input: { identity: { confirmation?: { confirmedBy: string } } } };
  assert.equal(raw.response.httpStatus, 200);
  assert.equal(raw.response.bodyText, bodyText(), 'resposta original preservada');
  assert.equal(raw.input.identity.confirmation?.confirmedBy, 'ana@empresa.com', 'confirmação do operador preservada');
  // o leitor da futura interface enxerga a auditoria, sem o corpo bruto
  const reader = createEvidenceReader({ baseDir: base, authorize: (a) => a.email === 'ana@empresa.com' });
  const view = await reader.getAudit({ email: 'ana@empresa.com' }, AUDIT_ID);
  assert.equal(view?.state, 'COMPLETE');
  assert.ok(!JSON.stringify(view).includes('internalNote'));
});

test('falha ao gravar a resposta paga é EXPLÍCITA (nunca silenciosa) e o armazenamento fatal bloqueia o resto', async () => {
  const base = tmpDir();
  let writes = 0;
  const brokenAfterPreflight = faulty({
    writeExclusive: async (...args) => {
      writes += 1;
      if (writes > 1) throw errno('EIO', 'falha de disco'); // 1ª = sonda do pré-voo; depois, falha
      return (await import('../src/lib/link-audit/snapshot-store')).nodeFsOps.writeExclusive(...args);
    },
  });
  const s = setup({ baseDir: base, fs: brokenAfterPreflight });
  const r = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH }, s.deps as never);
  assert.ok(r.ok && r.kind === 'REPORT');
  assert.ok(r.persisted && r.persisted.errors.some((e) => /resposta paga NÃO foi persistida \(STORAGE_FATAL\)/.test(e)), JSON.stringify(r.persisted?.errors));
  assert.equal(r.persisted?.captureNumber, null);
  assert.equal(r.persisted?.storedReport, null);
  const afterFailure = writes;
  assert.ok(afterFailure <= 3, 'poucas tentativas de escrita e nenhuma depois do erro fatal');
  clearStorageFatal(base);
});

test('CLI LIVE: exige --evidence-dir, imprime o relatório armazenado e sai com código 5 se a resposta paga não foi persistida', async () => {
  const usedDir = tmpDir();
  const mk = (evidenceFs?: ReturnType<typeof faulty>) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      out: (l) => out.push(l), err: (l) => err.push(l), now: clock, loadEnv: () => undefined,
      getEnv: () => ({ SERPER_API_KEY: FAKE_KEY, GMN_LINK_AUDIT_LIVE: 'on', GMN_LINK_AUDIT_MAX_MAPS_CALLS: '1', GMN_LINK_AUDIT_AUTH_ID: AUDIT_ID }),
      usedStore: () => createFileUsedStore(usedDir),
      createLiveProviders: (_c, hooks) => ({
        maps: { search: async () => { await hooks.onCapture({ url: 'https://google.serper.dev/maps', requestBody: { q: 'x' }, httpStatus: 200, bodyText: bodyText(), attempts: 1, failure: null, capturedAt: '2026-10-21T12:10:00.000Z' }); return { state: 'OK' as const, value: [PLACE], fetchedAt: '2026-10-21T12:10:00.000Z' }; } },
        site: siteFake(pages),
      }),
      ...(evidenceFs ? { evidenceOptions: { fs: evidenceFs } } : {}),
    };
    return { deps, out, err };
  };
  const BASE = ['--link', LINK, '--operator', 'ana@empresa.com', '--name', 'Padaria Exemplo', '--city', 'Cidade Exemplo', '--uf', 'go'];
  const LIVE = ['--live', '--authorization-id', AUDIT_ID, '--max-maps-calls', '1', '--ack-cost'];
  const none = mk();
  assert.equal(await runCli([...BASE, ...LIVE], none.deps), 3);
  assert.match(none.err.join(' '), /falta --evidence-dir/);
  assert.deepEqual(fs.readdirSync(usedDir), [], 'nada foi consumido');

  const ev = tmpDir();
  const ok = mk();
  assert.equal(await runCli([...BASE, ...LIVE, '--evidence-dir', ev], ok.deps), 0);
  assert.match(ok.out.join('\n'), /EVIDÊNCIAS: auditoria auth-teste-0001 · captura 1 · relatório r1/);
  assert.match(ok.out.join('\n'), /não é backup independente; o hash não é assinatura/);
  assert.ok(fs.existsSync(path.join(ev, AUDIT_ID, 'c0001.capture.json')));

  // armazenamento que falha depois do pré-voo: autorização consumida, mas o erro é gritante e o código é 5
  fs.rmSync(path.join(usedDir, `${AUDIT_ID}.json`));
  const ev2 = tmpDir();
  let writes = 0;
  const failing = faulty({ writeExclusive: async (...args) => { writes += 1; if (writes > 1) throw errno('ENOSPC', 'sem espaço'); return (await import('../src/lib/link-audit/snapshot-store')).nodeFsOps.writeExclusive(...args); } });
  const bad = mk(failing);
  assert.equal(await runCli([...BASE, ...LIVE, '--evidence-dir', ev2], bad.deps), 5);
  assert.match(bad.err.join('\n'), /ATENÇÃO: A resposta paga NÃO foi persistida/);
});

test('revisão 5A: segredo no link bloqueia ANTES de pagar; o link é gravado saneado; --evidence-dir em public/ é recusado de qualquer pasta', async () => {
  const base = tmpDir();
  const dirty = { ...NAMED(), link: { originalLink: `${LINK}&token=abcd1234efgh`, resolved: null } };
  const s = setup({ baseDir: base });
  const r = await runLinkAuditCollection({ mode: 'LIVE', input: dirty, authorization: AUTH }, s.deps as never);
  assert.ok(!r.ok);
  assert.equal(s.calls.searches, 0);
  assert.equal(s.store.isUsed(AUDIT_ID), false, 'a autorização não foi consumida');

  const input = NAMED();
  const withParams = { ...input, link: { originalLink: `${LINK}&ved=1t:2428&ictx=111`, resolved: null }, identity: { ...input.identity, originalLink: `${LINK}&ved=1t:2428&ictx=111` } };
  const s2 = setup({ baseDir: base });
  const ok = await runLinkAuditCollection({ mode: 'LIVE', input: withParams, authorization: AUTH }, s2.deps as never);
  assert.ok(ok.ok && ok.kind === 'REPORT');
  const stored = fs.readFileSync(path.join(base, AUDIT_ID, 'c0001.capture.json'), 'utf8');
  assert.ok(!/ved=|ictx=/.test(stored), 'parâmetros de rastreio do link não são gravados');
});

test('revisão 5A: resposta sem corpo utilizável (HTTP 500): captura preservada, AVISO claro e saída 4; --evidence-dir proibido é recusado com código 3 de qualquer pasta', async () => {
  const base = tmpDir();
  const store = createMemoryUsedStore();
  const failing = {
    now: clock, liveEnabled: true, usedStore: store, evidence: { baseDir: base },
    createLiveProviders: (hooks: { onCapture: (info: never) => Promise<void> }) => ({
      maps: { search: async () => { await hooks.onCapture({ url: 'https://google.serper.dev/maps', requestBody: { q: 'x' }, httpStatus: 500, bodyText: null, attempts: 1, failure: null, capturedAt: '2026-10-21T12:10:00.000Z' } as never); return { state: 'FAILED' as const, reason: 'Serper /maps respondeu HTTP 500' }; } },
    }),
  };
  const r = await runLinkAuditCollection({ mode: 'LIVE', input: NAMED(), authorization: AUTH }, failing as never);
  assert.ok(r.ok && r.kind === 'REPORT' && r.persisted);
  assert.equal(r.persisted.captureNumber, 1);
  assert.equal(r.persisted.storedReport, null);
  assert.deepEqual(r.persisted.errors, []);
  assert.match(r.persisted.warnings.join(' '), /Relatório não gerado.*captura original está preservada/);

  const used = tmpDir();
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    out: (l) => out.push(l), err: (l) => err.push(l), now: clock, loadEnv: () => undefined,
    getEnv: () => ({ SERPER_API_KEY: FAKE_KEY, GMN_LINK_AUDIT_LIVE: 'on', GMN_LINK_AUDIT_MAX_MAPS_CALLS: '1', GMN_LINK_AUDIT_AUTH_ID: AUDIT_ID }),
    usedStore: () => createFileUsedStore(used),
    createLiveProviders: (_c, hooks) => ({ maps: { search: async () => { await hooks.onCapture({ url: 'https://google.serper.dev/maps', requestBody: { q: 'x' }, httpStatus: 500, bodyText: null, attempts: 1, failure: null, capturedAt: '2026-10-21T12:10:00.000Z' }); return { state: 'FAILED' as const, reason: 'HTTP 500' }; } } }),
  };
  const BASE = ['--link', LINK, '--operator', 'ana@empresa.com', '--name', 'Padaria Exemplo', '--city', 'Cidade Exemplo', '--uf', 'go'];
  const LIVE = ['--live', '--authorization-id', AUDIT_ID, '--max-maps-calls', '1', '--ack-cost'];
  assert.equal(await runCli([...BASE, ...LIVE, '--evidence-dir', tmpDir()], deps), 4);
  assert.match(err.join('\n'), /AVISO: Relatório não gerado/);

  // pasta proibida do PROJETO (raiz fixa do projeto, independente do diretório atual)
  const forbidden = path.join(__dirname, '..', 'public', 'zz-evidencias-teste');
  const used2 = tmpDir();
  const deps2: CliDeps = { ...deps, usedStore: () => createFileUsedStore(used2) };
  assert.equal(await runCli([...BASE, ...LIVE, '--evidence-dir', forbidden], deps2), 3);
  assert.ok(!fs.existsSync(forbidden), 'nada foi criado em public/');
  assert.deepEqual(fs.readdirSync(used2), [], 'a autorização não foi consumida');
});
