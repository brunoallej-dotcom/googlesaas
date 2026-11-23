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
import { canonicalJson, sha256Hex } from '../src/lib/link-audit/canonical';
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
