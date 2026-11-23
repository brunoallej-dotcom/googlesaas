import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import './helpers/stub-lucide';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SIMULATED_BADGE } from '../src/components/link-audit/evidence-labels';
import type { Phase } from '../src/components/link-audit/evidence-state';
import { StoredAuditDetail } from '../src/components/link-audit/stored-audit-detail';
import { StoredAuditList } from '../src/components/link-audit/stored-audit-list';
import { createEvidenceReader, toAuditDetailDto, toListItem } from '../src/lib/link-audit-evidence';
import { SIMULATED_LABEL, SIMULATED_SOURCE_LABEL } from '../src/lib/link-audit-evidence/simulated';
import { createScoringPreviewService } from '../src/lib/link-audit-scoring-runs';
import { evidenceKeys, sealAuditV2ForTests, TRUSTING_EVIDENCE_POLICY } from './helpers/link-audit-evidence-provenance-fixtures';
import { evidenceToProveFromBasis } from '../src/lib/link-audit-evidence/evidence-to-prove';
import { evidenceProvenanceFromConfig } from '../src/lib/link-audit-evidence/provenance';
import { fakeList } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_A, resultsEnv, treeOf } from './helpers/link-audit-results-fixtures';
import { canonicalJson, sha256Hex } from '../src/lib/link-audit/canonical';
import { nodeFsOps } from '../src/lib/link-audit/snapshot-store';
import { createScoringBasisReader } from '../src/lib/link-audit-evidence/scoring-basis';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { at, HOUR, jsonOf, makeAudit, newOut, readJsonFile, runCli as runSeal, exportArgs } from './helpers/link-audit-seal-export-fixtures';
import { collectSimulated, SIM_AUDIT_ID, SIM_NOW } from './helpers/link-audit-simulated-fixtures';

/*
 * W5.2b (spec do P1 §5.7): os consumidores da captura SIMULADA. `export` e finalização recusam sem a trava de homologação; leitor e
 * interface rotulam "SIMULADA — ensaio". Dados 100% SINTÉTICOS, pastas temporárias, nenhuma rede, nenhum arquivo de ambiente.
 */
registerCleanup();

const LOCK = { GMN_LINK_AUDIT_HOMOLOGATION: '1' } as const;
const textOf = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const EXPORT_NOW = at(SIM_NOW, 2 * HOUR);
const simExport = (evidence: string, hash: string, extra: readonly string[] = []): string[] => ['export', '--evidence-dir', evidence, '--audit', SIM_AUDIT_ID, '--collector-hash', `c0001=${hash}`, '--max-gap-hours', '24', ...extra];

/* ------------------------------------------------------------------ base de pontuação e export (2b, 2c) */

test('base (2b): a base de pontuação marca simulated:true na captura simulada E no relatório dela; a real não tem o campo', async () => {
  const evidence = tmpDir('lasim-g-');
  await collectSimulated(evidence);
  const reader = createScoringBasisReader({ baseDir: evidence, authorize: () => true });
  const outcome = await reader.readScoringBasis({ email: 'leitor@exemplo.invalid' }, SIM_AUDIT_ID);
  assert.equal(outcome.status, 'READY');
  assert.ok(outcome.status === 'READY');
  assert.deepEqual(outcome.basis.evidences.map((e) => [e.ref, e.simulated]), [['capture:c0001', true], ['report:c0001-r0001', true]]);

  const real = await makeAudit();
  const realOutcome = await createScoringBasisReader({ baseDir: real.base, authorize: () => true }).readScoringBasis({ email: 'leitor@exemplo.invalid' }, real.auditId);
  assert.ok(realOutcome.status === 'READY');
  assert.ok(realOutcome.basis.evidences.every((e) => !('simulated' in e)));
});

test('export (2c): captura simulada SEM --simulated ⇒ EXPORT_SIMULATED_CAPTURE (código 3), mesmo com a trava no ambiente; nada gravado', async () => {
  const evidence = tmpDir('lasim-g-');
  const { collectorHash } = await collectSimulated(evidence);
  for (const env of [{}, LOCK]) {
    const out = newOut();
    const run = await runSeal([...simExport(evidence, collectorHash, ['--out', out, '--json'])], EXPORT_NOW, { getEnv: () => env });
    assert.equal(run.code, 3, run.stdout);
    assert.equal(jsonOf(run).code, 'EXPORT_SIMULATED_CAPTURE');
    assert.ok(!fs.existsSync(out), 'nada gravado');
  }
});

test('export (2c): --simulated SEM a trava de homologação ⇒ EXPORT_SIMULATED_CAPTURE antes de ler a pasta (NODE_ENV=production ou valor diferente de "1" também)', async () => {
  const evidence = tmpDir('lasim-g-');
  const { collectorHash } = await collectSimulated(evidence);
  for (const env of [{}, { NODE_ENV: 'production' }, { GMN_LINK_AUDIT_HOMOLOGATION: 'true' }]) {
    const out = newOut();
    const run = await runSeal(simExport(evidence, collectorHash, ['--simulated', '--out', out, '--json']), EXPORT_NOW, { getEnv: () => env });
    assert.equal(run.code, 3);
    assert.equal(jsonOf(run).code, 'EXPORT_SIMULATED_CAPTURE');
    assert.match(String(jsonOf(run).message), /GMN_LINK_AUDIT_HOMOLOGATION=1/);
    assert.ok(!fs.existsSync(out));
  }
});

test('export (2c): com --simulated E a trava, o pacote sai (formato do pacote inalterado) com a entrada da captura MARCADA, e a saída avisa "SIMULADA — ensaio"', async () => {
  const evidence = tmpDir('lasim-g-');
  const { collectorHash } = await collectSimulated(evidence);
  const out = newOut();
  const human = await runSeal(simExport(evidence, collectorHash, ['--simulated', '--out', out]), EXPORT_NOW, { getEnv: () => LOCK });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /SIMULADA — ensaio/);
  const pkg = readJsonFile<Record<string, unknown> & { entries: Array<{ ref: string; contentSha256: string }> }>(out);
  assert.equal(pkg.entries.find((e) => e.ref === 'capture:c0001')?.contentSha256, collectorHash);
  assert.deepEqual(Object.keys(pkg).sort(), ['attestable', 'auditId', 'checks', 'delta', 'entries', 'gap', 'generatedAt', 'integrity', 'kind', 'layout', 'packageSha256', 'schemaVersion', 'summary'], 'nenhum campo novo no pacote');
  assert.equal((pkg.summary as { company: { name: string } }).company.name, 'Empresa de Ensaio');
  const json = await runSeal(simExport(evidence, collectorHash, ['--simulated', '--out', newOut(), '--json']), EXPORT_NOW, { getEnv: () => LOCK });
  assert.equal(json.code, 0);
  assert.equal(jsonOf(json).simulated, true);
});

test('export (2c): --simulated com a trava numa auditoria REAL ⇒ EXPORT_SIMULATED_CAPTURE (a opção afirma que a captura é simulada); sem a opção, a real exporta como antes', async () => {
  const audit = await makeAudit();
  const refused = await runSeal(exportArgs(audit, ['--simulated', '--json']), undefined, { getEnv: () => LOCK });
  assert.equal(refused.code, 3);
  assert.equal(jsonOf(refused).code, 'EXPORT_SIMULATED_CAPTURE');
  const ok = await runSeal(exportArgs(audit, ['--json']), undefined, { getEnv: () => LOCK });
  assert.equal(ok.code, 0, ok.stdout);
  assert.ok(!('simulated' in jsonOf(ok)), 'a forma estável do --json real não muda');
});

test('hash (2b): tirar a marca da captura e "consertar" todos os hashes (captura e vínculo do relatório) não engana o export: o hash registrado do coletor cobre a marca', async () => {
  const evidence = tmpDir('lasim-g-');
  const { collectorHash } = await collectSimulated(evidence);
  const dir = path.join(evidence, SIM_AUDIT_ID);
  const reseal = (file: string, edit: (value: Record<string, unknown>) => Record<string, unknown>): string => {
    const target = path.join(dir, file);
    const { contentSha256: _old, ...rest } = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
    void _old;
    const body = edit(rest);
    const contentSha256 = sha256Hex(canonicalJson(body));
    fs.chmodSync(target, 0o644);
    fs.writeFileSync(target, `${JSON.stringify({ ...body, contentSha256 }, null, 2)}\n`);
    return contentSha256;
  };
  const forged = reseal('c0001.capture.json', ({ simulated: _s, ...rest }) => {
    void _s;
    return { ...rest, provider: 'serper-maps' };
  });
  reseal('c0001.report-r0001.json', (rest) => ({ ...rest, captureSha256: forged }));
  assert.notEqual(forged, collectorHash);
  const run = await runSeal(simExport(evidence, collectorHash, ['--out', newOut(), '--json']), EXPORT_NOW, { getEnv: () => ({}) });
  assert.equal(run.code, 3);
  assert.equal(jsonOf(run).code, 'EXPORT_COLLECTOR_HASH_MISMATCH', 'a falsificação aparece como hash do coletor divergente');
});

test('export (2c): o único acesso ao ambiente do processo é a variável da trava, em simulated.ts; o CLI do P1 e os módulos do export continuam sem olhar o ambiente', () => {
  const root = path.join(__dirname, '..');
  const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const simulated = read('src/lib/link-audit-evidence/simulated.ts');
  assert.deepEqual([...simulated.matchAll(/process\.env(\[[^\]]+\]|\.\w+)?/g)].map((m) => m[0]), ['process.env[HOMOLOGATION_LOCK_ENV]'], 'só a variável da trava');
  assert.ok(!/loadEnvConfig|dotenv|@next\/env|readFile/.test(simulated), 'nunca arquivo de ambiente');
  for (const file of ['scripts/link-audit-seal.ts', 'src/lib/link-audit-attestation/export.ts', 'src/lib/link-audit-attestation/export-run.ts']) assert.ok(!/process\.env/.test(read(file)), file);
});

/* ------------------------------------------------------------------ leitor e interface: "SIMULADA — ensaio" (2c) */

test('leitor e interface (2c): a coleta simulada aparece como "SIMULADA — ensaio" na lista e no detalhe (leitor → apresentação → componentes); a real não', async () => {
  const evidence = tmpDir('lasim-ui-');
  await collectSimulated(evidence);
  const actor = { email: 'leitor@exemplo.invalid' };
  const reader = createEvidenceReader({ baseDir: evidence, authorize: () => true });
  const [summary] = await reader.listAudits(actor);
  assert.ok(summary);
  assert.equal(summary.simulated, true);
  const view = await reader.getAudit(actor, SIM_AUDIT_ID);
  assert.ok(view);
  assert.equal(view.simulated, true);
  assert.equal(view.source.provider, SIMULATED_SOURCE_LABEL);

  const item = toListItem(summary);
  const detail = toAuditDetailDto(view);
  assert.equal(item.simulated, true);
  assert.equal(item.sourceLabel, SIMULATED_SOURCE_LABEL);
  assert.equal(detail.source.simulated, true);
  assert.equal(detail.source.label, SIMULATED_SOURCE_LABEL);
  assert.ok(detail.limitations.some((line) => /SIMULADA — ensaio/.test(line)), 'a limitação gravada no relatório chega à tela');

  const noop = (): void => undefined;
  const listHtml = textOf(renderToStaticMarkup(createElement(StoredAuditList, { phase: 'ready' as Phase, items: [item], total: 1, message: null, query: '', selectedId: null, onQueryChange: noop, onSelect: noop, onRetry: noop })));
  const detailHtml = textOf(renderToStaticMarkup(createElement(StoredAuditDetail, { detail, loading: false, onSelectRevision: noop })));
  for (const html of [listHtml, detailHtml]) {
    assert.match(html, /SIMULADA — ensaio/);
    assert.match(html, /nenhuma consulta foi feita/);
  }
  assert.match(detailHtml, /nunca é evidência real/);

  const real = await makeAudit();
  const realReader = createEvidenceReader({ baseDir: real.base, authorize: () => true });
  const [realSummary] = await realReader.listAudits(actor);
  const realView = await realReader.getAudit(actor, real.auditId);
  assert.ok(realSummary && realView);
  assert.ok(!('simulated' in realSummary) && !('simulated' in realView));
  const realItem = toListItem(realSummary);
  const realDetail = toAuditDetailDto(realView);
  assert.ok(!('simulated' in realItem) && !('simulated' in realDetail.source));
  assert.notEqual(realItem.sourceLabel, SIMULATED_SOURCE_LABEL);
  const realHtml = textOf(renderToStaticMarkup(createElement(StoredAuditDetail, { detail: realDetail, loading: false, onSelectRevision: noop })));
  assert.doesNotMatch(realHtml, /SIMULADA/);
});

test('interface: o selo da tela é o mesmo rótulo do servidor (uma fonte só para "SIMULADA — ensaio")', () => {
  assert.equal(SIMULATED_BADGE, SIMULATED_LABEL);
  assert.ok(SIMULATED_SOURCE_LABEL.startsWith(SIMULATED_LABEL));
});

/* ------------------------------------------------------------------ prévia e finalização (2c) e configuração de produção */

function simulatedPreview(evidence: string, homologation: boolean | undefined) {
  return createScoringPreviewService({
    basisReader: createScoringBasisReader({ baseDir: evidence, authorize: () => true }),
    decisions: { list: async () => ({ ok: true as const, value: fakeList(SIM_AUDIT_ID, [], { head: null }) }) },
    clock: () => '2026-11-22T12:00:00.000Z',
    evidenceProvenance: TRUSTING_EVIDENCE_POLICY, // isola a trava da captura simulada: a prova de coleta (camada 1) tem testes próprios
    ...(homologation === undefined ? {} : { homologation }),
  });
}

test('prévia e finalização (2c): SEM a trava no servidor, base simulada ⇒ bloqueio SIMULATED_EVIDENCE (BLOCKING), nada finalizável, e a finalização responde NOT_FINALIZABLE sem gravar nada', async () => {
  const evidence = tmpDir('lasim-pv-');
  await collectSimulated(evidence);
  for (const homologation of [undefined, false]) {
    const preview = simulatedPreview(evidence, homologation);
    const ev = await preview.evaluate(OP_A, SIM_AUDIT_ID);
    assert.ok(ev.ok, JSON.stringify(ev).slice(0, 300));
    const blocker = ev.value.payload.blockers.find((b) => b.code === 'SIMULATED_EVIDENCE');
    assert.equal(blocker?.severity, 'BLOCKING');
    assert.match(blocker?.message ?? '', /SIMULADA — ensaio/);
    assert.equal(ev.value.payload.finalization.allowed, false);
    const e = resultsEnv();
    const done = await makeService(e, preview).finalize(OP_A, SIM_AUDIT_ID, { expectedHead: null, expectedInputSha256: ev.value.inputSha256 as string });
    assert.ok(!done.ok);
    assert.equal(done.code, 'NOT_FINALIZABLE');
    assert.ok(done.blockers?.some((b) => b.code === 'SIMULATED_EVIDENCE' && b.severity === 'BLOCKING'));
    const tree = treeOf(e);
    assert.deepEqual([...(tree.runs ?? []), ...(tree.anchors ?? [])].filter((name) => name.endsWith('.json')), [], 'nenhum resultado nem recibo gravado');
  }
});

test('prévia e finalização (2c): COM a trava no servidor (homologação), o mesmo bloqueio vira WARNING ("SIMULADA — ensaio" continua visível) e o S-13 finaliza', async () => {
  const evidence = tmpDir('lasim-pv-');
  await collectSimulated(evidence);
  const preview = simulatedPreview(evidence, true);
  const ev = await preview.evaluate(OP_A, SIM_AUDIT_ID);
  assert.ok(ev.ok);
  const blocker = ev.value.payload.blockers.find((b) => b.code === 'SIMULATED_EVIDENCE');
  assert.equal(blocker?.severity, 'WARNING');
  assert.equal(ev.value.payload.finalization.allowed, true, JSON.stringify(ev.value.payload.blockers));
  const e = resultsEnv();
  const done = await makeService(e, preview).finalize(OP_A, SIM_AUDIT_ID, { expectedHead: null, expectedInputSha256: ev.value.inputSha256 as string });
  assert.ok(done.ok, JSON.stringify(done).slice(0, 400));
  assert.deepEqual((treeOf(e).runs ?? []).filter((name) => name.endsWith('.json')).map((name) => path.basename(name)), ['s0001.json']);
});

test('prévia (2c): base REAL não ganha bloqueio nenhum, com ou sem a trava', async () => {
  const real = await makeAudit();
  for (const homologation of [false, true]) {
    const preview = createScoringPreviewService({
      basisReader: createScoringBasisReader({ baseDir: real.base, authorize: () => true }),
      decisions: { list: async () => ({ ok: true as const, value: fakeList(real.auditId, [], { head: null }) }) },
      clock: () => '2026-11-22T12:00:00.000Z',
      evidenceProvenance: TRUSTING_EVIDENCE_POLICY,
      homologation,
    });
    const ev = await preview.evaluate(OP_A, real.auditId);
    assert.ok(ev.ok);
    assert.ok(!ev.value.payload.blockers.some((b) => b.code === 'SIMULATED_EVIDENCE'));
  }
});

test('servidor (2c): as rotas montam a prévia com a trava lida SÓ de GMN_LINK_AUDIT_HOMOLOGATION; a stack de PRODUÇÃO não declara a variável', () => {
  const root = path.join(__dirname, '..');
  const shared = fs.readFileSync(path.join(root, 'src/app/api/link-audit/scoring/shared.ts'), 'utf8');
  assert.match(shared, /createScoringPreviewService\(\{[^}]*homologation: homologationLockFromProcess\(\)/);
  const stack = fs.readFileSync(path.join(root, 'deploy/hostinger/stack.yml'), 'utf8');
  assert.ok(!stack.includes('GMN_LINK_AUDIT_HOMOLOGATION'), 'produção nunca liga a trava de homologação');
  for (const file of ['deploy/hostinger/Dockerfile', 'deploy/hostinger/docker-entrypoint.sh']) assert.ok(!fs.readFileSync(path.join(root, file), 'utf8').includes('GMN_LINK_AUDIT_HOMOLOGATION'), file);
});

test('conclusão (2c): pendente gravada na homologação sobre evidência simulada NÃO recebe recibo sem a trava; com a trava, o autor conclui', async () => {
  const evidence = tmpDir('lasim-pd-');
  await collectSimulated(evidence);
  const homologated = simulatedPreview(evidence, true);
  const ev = await homologated.evaluate(OP_A, SIM_AUDIT_ID);
  assert.ok(ev.ok);
  const body = { expectedHead: null, expectedInputSha256: ev.value.inputSha256 as string };
  const e = resultsEnv();
  const failingAnchors = makeService(e, homologated, {
    fs: {
      ...nodeFsOps,
      async writeExclusive(target: string, data: string, mode?: number) {
        if (target.startsWith(e.anchors)) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        return nodeFsOps.writeExclusive(target, data, mode);
      },
    } as never,
  });
  const pending = await failingAnchors.finalize(OP_A, SIM_AUDIT_ID, body);
  assert.ok(!pending.ok && pending.code === 'RESULT_ANCHOR_PENDING', JSON.stringify(pending).slice(0, 200));
  const receipt = path.join(e.anchors, SIM_AUDIT_ID, 'a0001.json');

  const refused = await makeService(e, simulatedPreview(evidence, false)).finalize(OP_A, SIM_AUDIT_ID, body);
  assert.ok(!refused.ok && refused.code === 'NOT_FINALIZABLE', JSON.stringify(refused).slice(0, 300));
  assert.ok(refused.blockers?.some((b) => b.code === 'SIMULATED_EVIDENCE' && b.severity === 'BLOCKING'));
  assert.equal(fs.existsSync(receipt), false, 'nenhum recibo fora da homologação');

  const concluded = await makeService(e, homologated).finalize(OP_A, SIM_AUDIT_ID, body);
  assert.ok(concluded.ok && concluded.value.recoveredPending, JSON.stringify(concluded).slice(0, 300));
  assert.equal(fs.existsSync(receipt), true);
});

/* ------------------------------------------------------------------ camada 1 (defesa principal, já existente): a lista de chaves de produção */

test('camada 1: o manifesto do ensaio, assinado pela chave DESCARTÁVEL, autentica na lista da homologação e é UNAUTHENTICATED (SEAL_INVALID) na lista de produção, que só tem a chave real', async () => {
  const evidence = tmpDir('lasim-k-');
  await collectSimulated(evidence);
  const sealsDir = tmpDir('lasim-seals-');
  const disposable = evidenceKeys('ek-ensaio-w5');
  const real = evidenceKeys('ek-real-0001');
  await sealAuditV2ForTests({ evidenceDir: evidence, auditId: SIM_AUDIT_ID, sealsDir, keys: disposable });
  const basis = await createScoringBasisReader({ baseDir: evidence, authorize: () => true }).readScoringBasis({ email: 'leitor@exemplo.invalid' }, SIM_AUDIT_ID);
  assert.ok(basis.status === 'READY');
  const evidences = evidenceToProveFromBasis(basis.basis);
  const verdict = (trustKeys: string) => evidenceProvenanceFromConfig({ sealsDir, trustKeys, otherDirs: [evidence], acceptedVersions: [2] }).classify(SIM_AUDIT_ID, evidences);
  assert.equal((await verdict(disposable.trustKeys)).status, 'AUTHENTICATED', 'homologação: a lista tem a chave do ensaio');
  assert.deepEqual(await verdict(real.trustKeys), { status: 'UNAUTHENTICATED', reason: 'SEAL_INVALID' }, 'produção: a chave do ensaio não está na lista');
});
