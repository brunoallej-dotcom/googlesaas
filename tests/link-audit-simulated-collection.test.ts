import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../src/lib/link-audit/canonical';
import { buildReportFromCapture } from '../src/lib/link-audit/collector/capture-report';
import { checkStorage, readCapture, writeCapture } from '../src/lib/link-audit-evidence/store';
import { captureSchema } from '../src/lib/link-audit-evidence/types';
import { parseGoogleMapsLink } from '../src/lib/link-audit/maps-link';
import { runLinkAuditCollection } from '../src/lib/link-audit-runtime/run';
import {
  createSimulatedMapsProvider,
  isSyntheticIdentity,
  SIMULATED_CID,
  SIMULATED_COMPANY,
  SIMULATED_FID,
  SIMULATED_LINK,
  SIMULATED_REQUEST_URL,
  simulatedCollectionInput,
  simulatedMapsBody,
} from '../src/lib/link-audit-runtime/simulated-provider';
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

/* ------------------------------------------------------------------ runtime: gerador sintético e gravação marcada (2a, 2d) */

const SIM_AUDIT = 'ensaio-w5-teste-01';
const simClock = (): Date => new Date('2026-11-22T10:00:00.000Z');
const simInput = () => simulatedCollectionInput({ operator: 'operador-ensaio@exemplo.invalid', confirmedAt: simClock().toISOString(), snapshotId: 'ensaio-snap-0001' });

test('dados sintéticos (2d): link, identificadores e empresa do ensaio são FIXOS e obviamente fictícios; o corpo gerado só traz isso', () => {
  assert.equal(SIMULATED_COMPANY.name, 'Empresa de Ensaio');
  assert.equal(SIMULATED_COMPANY.city, 'Cidade de Ensaio');
  assert.equal(SIMULATED_COMPANY.stateCode, 'ZZ', 'UF inexistente');
  const parsed = parseGoogleMapsLink(SIMULATED_LINK);
  assert.ok(parsed.status === 'IDENTIFIED');
  assert.deepEqual(parsed.identifiers, { cid: SIMULATED_CID, featureId: SIMULATED_FID });
  assert.match(SIMULATED_CID, /^\d{1,9}$/, 'CID curto demais para ser de um perfil real (os reais têm 17 a 20 dígitos)');
  assert.match(SIMULATED_FID, /^0x0:/, 'prefixo zero');
  const body = JSON.parse(simulatedMapsBody('Empresa de Ensaio Cidade de Ensaio ZZ')) as { places: Array<Record<string, unknown>>; simulated: unknown; credits: unknown };
  assert.equal(body.simulated, true);
  assert.equal(body.credits, 0);
  assert.equal(body.places.length, 1);
  const place = body.places[0] as Record<string, unknown>;
  assert.equal(place.title, 'Empresa de Ensaio');
  assert.equal(place.cid, SIMULATED_CID);
  assert.equal(place.fid, SIMULATED_FID);
  for (const field of ['phoneNumber', 'website', 'rating', 'ratingCount', 'placeId', 'thumbnailUrl']) assert.ok(!(field in place), `sem ${field}`);
  const input = simInput();
  assert.equal(input.identity.name, 'Empresa de Ensaio');
  assert.ok(isSyntheticIdentity(input.identity));
  assert.equal(isSyntheticIdentity({ ...input.identity, name: 'Outra Empresa' }), false);
  assert.equal(isSyntheticIdentity({ ...input.identity, identifiers: { cid: '1311768467294899695' } }), false);
});

test('runtime (2a): SIMULATED com gravação de evidência SEM homologation:true ⇒ HOMOLOGATION_REQUIRED antes de qualquer pasta', async () => {
  const base = path.join(tmpDir('lasim-rt-'), 'evidencias');
  for (const homologation of [undefined, false]) {
    const outcome = await runLinkAuditCollection({ mode: 'SIMULATED', input: simInput(), auditId: SIM_AUDIT }, { now: simClock, evidence: { baseDir: base }, ...(homologation === undefined ? {} : { homologation }) });
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, 'HOMOLOGATION_REQUIRED');
    assert.ok(!fs.existsSync(base), 'nenhuma pasta criada');
  }
});

test('runtime (2a, 2d): com a trava, grava c0001 e r0001 MARCADAS pelo gerador sintético, sem nenhuma chamada enviada; provedor injetado ou identidade não sintética ⇒ recusa', async () => {
  const base = tmpDir('lasim-rt-');
  const outcome = await runLinkAuditCollection({ mode: 'SIMULATED', input: simInput(), auditId: SIM_AUDIT }, { now: simClock, evidence: { baseDir: base }, homologation: true });
  assert.ok(outcome.ok && outcome.kind === 'REPORT', outcome.ok ? '' : `${outcome.code}: ${outcome.reason}`);
  assert.equal(outcome.report.mode, 'SIMULATED');
  assert.equal(outcome.report.externalTraffic, false);
  assert.equal(outcome.report.calls.sent, 0);
  const persisted = outcome.persisted;
  assert.ok(persisted && persisted.errors.length === 0 && persisted.captureNumber === 1 && persisted.revision === 1);
  assert.equal(persisted.storedReport?.source.simulated, true);
  assert.equal(persisted.storedReport?.source.provider, 'SIMULATED');
  const capture = await readCapture(base, SIM_AUDIT, 1);
  assert.ok(capture.ok);
  assert.equal(capture.value.simulated, true);
  assert.equal(capture.value.provider, 'SIMULATED');
  assert.equal(capture.value.request.url, SIMULATED_REQUEST_URL);
  assert.equal(capture.value.response.attempts, 0, 'nenhuma tentativa HTTP');
  assert.equal(persisted.storedReport?.source.capture.sha256, capture.value.contentSha256, 'o hash que o --json imprime é o da captura marcada');
  assert.equal(persisted.storedReport?.located, 'MATCHED');

  const injected = await runLinkAuditCollection({ mode: 'SIMULATED', input: simInput(), auditId: 'ensaio-w5-teste-02' }, { now: simClock, evidence: { baseDir: base }, homologation: true, providers: { maps: { search: async () => ({ state: 'OK', value: [], fetchedAt: simClock().toISOString() }) } } });
  assert.ok(!injected.ok && injected.code === 'INVALID_REQUEST');
  const realIdentity = simInput();
  const notSynthetic = await runLinkAuditCollection({ mode: 'SIMULATED', input: { ...realIdentity, identity: { ...realIdentity.identity, name: 'Outra Empresa' } }, auditId: 'ensaio-w5-teste-03' }, { now: simClock, evidence: { baseDir: base }, homologation: true });
  assert.ok(!notSynthetic.ok && notSynthetic.code === 'INVALID_REQUEST');
  const badId = await runLinkAuditCollection({ mode: 'SIMULATED', input: simInput(), auditId: 'X' }, { now: simClock, evidence: { baseDir: base }, homologation: true });
  assert.ok(!badId.ok && badId.code === 'STORAGE_NOT_READY');
  assert.deepEqual(fs.readdirSync(base).sort(), [SIM_AUDIT], 'nada gravado pelas recusas');
});

test('runtime: SIMULATED SEM gravação (fixtures em memória) continua como antes e não exige a trava', async () => {
  const outcome = await runLinkAuditCollection({ mode: 'SIMULATED', input: simInput() }, { now: simClock, providers: { maps: createSimulatedMapsProvider({ now: simClock }) } });
  assert.ok(outcome.ok && outcome.kind === 'REPORT');
  assert.equal(outcome.persisted, undefined);
});
