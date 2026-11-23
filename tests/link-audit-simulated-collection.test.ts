import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../src/lib/link-audit/canonical';
import { buildReportFromCapture } from '../src/lib/link-audit/collector/capture-report';
import { checkStorage, readCapture, writeCapture } from '../src/lib/link-audit-evidence/store';
import { captureSchema } from '../src/lib/link-audit-evidence/types';
import { inputFor, T_NOW } from './helpers/link-audit-collect-fixtures';
import { AUDIT, bodyText, captureInput, COLLECTED_AT, identity, registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';

/*
 * W5.2b (spec §5.7): coleta SIMULADA para o ensaio da W5 em homologação. Dados 100% SINTÉTICOS; nenhuma rede, nenhum arquivo de
 * ambiente, pastas temporárias. Uma evidência simulada NUNCA passa por real: a marca é gravada, relida e coberta pelo hash.
 */
registerCleanup();

const captureFile = (base: string, n = 1): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(base, AUDIT, `c000${n}.capture.json`), 'utf8')) as Record<string, unknown>;

test('marca (2b): a captura simulada grava provider SIMULATED e simulated:true, relidos pelo leitor, e a marca está DENTRO do contentSha256', async () => {
  const base = tmpDir('lasim-');
  const written = await writeCapture(base, { ...captureInput(), simulated: true });
  assert.ok(written.ok, written.ok ? '' : written.issues.join(' '));
  const raw = captureFile(base);
  assert.equal(raw.provider, 'SIMULATED');
  assert.equal(raw.simulated, true);
  const reread = await readCapture(base, AUDIT, 1);
  assert.ok(reread.ok);
  assert.equal(reread.value.provider, 'SIMULATED');
  assert.equal(reread.value.simulated, true);
  // o hash cobre a marca: tirá-la (ou trocar o provedor) e recalcular dá OUTRO contentSha256 (o que o --collector-hash e o manifesto fixam)
  const { contentSha256, simulated, ...rest } = raw;
  assert.equal(sha256Hex(canonicalJson({ ...rest, simulated })), contentSha256);
  assert.notEqual(sha256Hex(canonicalJson({ ...rest, provider: 'serper-maps' })), contentSha256, 'sem a marca o hash muda');
  assert.notEqual(sha256Hex(canonicalJson({ ...rest, simulated, provider: 'serper-maps' })), contentSha256);
});

test('marca (2b): a captura real continua EXATAMENTE como antes (provider serper-maps, sem o campo simulated)', async () => {
  const base = tmpDir('lasim-');
  const written = await writeCapture(base, captureInput());
  assert.ok(written.ok);
  const raw = captureFile(base);
  assert.equal(raw.provider, 'serper-maps');
  assert.ok(!('simulated' in raw));
});

test('marca (2b): o esquema exige provider SIMULATED e simulated:true JUNTOS; um sem o outro, ou simulated:false, é inválido', async () => {
  const base = tmpDir('lasim-');
  assert.ok((await writeCapture(base, { ...captureInput(), simulated: true })).ok);
  const raw = captureFile(base);
  assert.ok(captureSchema.safeParse(raw).success);
  const { simulated: _drop, ...noFlag } = raw;
  void _drop;
  assert.equal(captureSchema.safeParse(noFlag).success, false, 'provider SIMULATED sem simulated');
  assert.equal(captureSchema.safeParse({ ...raw, provider: 'serper-maps' }).success, false, 'simulated sem provider SIMULATED');
  assert.equal(captureSchema.safeParse({ ...raw, simulated: false }).success, false, 'simulated:false não existe');
  assert.equal(captureSchema.safeParse({ ...raw, provider: 'outro' }).success, false);
});

test('marca (2b): captura simulada e captura real NÃO se misturam na mesma auditoria: o pré-voo recusa nos dois sentidos e a gravação recusa a simulada numa auditoria real', async () => {
  const realFirst = tmpDir('lasim-');
  assert.ok((await writeCapture(realFirst, captureInput())).ok);
  const mixed = await writeCapture(realFirst, { ...captureInput({ body: bodyText({ fixtureIndex: 2 }) }), simulated: true });
  assert.ok(!mixed.ok);
  assert.equal(mixed.code, 'INVALID');
  assert.match(mixed.issues.join(' '), /simulad/i);
  assert.ok(!fs.existsSync(path.join(realFirst, AUDIT, 'c0002.capture.json')), 'nada gravado');
  const preflightSimulated = await checkStorage(realFirst, { auditId: AUDIT, simulated: true });
  assert.ok(!preflightSimulated.ok && preflightSimulated.code === 'STORAGE_NOT_READY');
  assert.ok((await checkStorage(realFirst, { auditId: AUDIT })).ok, 'coleta real numa auditoria real segue');

  const simulatedFirst = tmpDir('lasim-');
  assert.ok((await writeCapture(simulatedFirst, { ...captureInput(), simulated: true })).ok);
  const preflightReal = await checkStorage(simulatedFirst, { auditId: AUDIT });
  assert.ok(!preflightReal.ok && preflightReal.code === 'STORAGE_NOT_READY', 'a coleta real (paga) é recusada ANTES de pagar numa auditoria simulada');
  assert.match(preflightReal.issues.join(' '), /SIMULADA/);
  assert.ok((await checkStorage(simulatedFirst, { auditId: AUDIT, simulated: true })).ok, 'nova captura simulada numa auditoria simulada segue');
  // depois de pago, a resposta real NUNCA é descartada (mesma regra do armazenamento): a gravação não a recusa; a auditoria continua marcada
  const paid = await writeCapture(simulatedFirst, captureInput({ body: bodyText({ fixtureIndex: 3 }) }));
  assert.ok(paid.ok, 'resposta paga preservada mesmo numa corrida com o pré-voo');
});

test('marca (2b): o relatório da captura simulada leva source.provider SIMULATED, source.simulated:true e a limitação explícita; o real não muda', async () => {
  const text = bodyText();
  const common = { rawBody: text, body: { name: 'c0001.capture.json', sha256: 'a'.repeat(64), bytes: Buffer.byteLength(text) }, otherFiles: [], httpStatus: 200, httpAttempts: 1, collectedAt: COLLECTED_AT, input: inputFor(identity()), site: null, generatedAt: T_NOW };
  const simulated = await buildReportFromCapture({ ...common, simulated: true });
  assert.ok(simulated.ok);
  assert.equal(simulated.report.source.provider, 'SIMULATED');
  assert.equal(simulated.report.source.simulated, true);
  assert.match(simulated.report.source.description, /SIMULADA — ensaio/);
  assert.ok(simulated.report.limitations.some((line) => /SIMULADA — ensaio/.test(line) && /nenhuma consulta/i.test(line)));
  const real = await buildReportFromCapture(common);
  assert.ok(real.ok);
  assert.equal(real.report.source.provider, 'serper-maps');
  assert.ok(!('simulated' in real.report.source));
  assert.ok(!real.report.limitations.some((line) => /SIMULADA/.test(line)));
});
