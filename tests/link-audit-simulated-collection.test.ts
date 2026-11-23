import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import test, { mock } from 'node:test';
import { runCli as runCollectorCli } from '../scripts/link-audit-collect';
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
import { collectSimulated, HOMOLOGATION_ENV, SIM_AUDIT_ID, simArgs, simHarness } from './helpers/link-audit-simulated-fixtures';

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

/* ------------------------------------------------------------------ CLI de coleta: trava, opções, saída e zero rede (2a, 3) */

test('CLI (2a): sem a trava de homologação o --simulated é RECUSADO (código 3) antes de qualquer pasta; NODE_ENV=production sem a trava também; só o valor exato "1" liga', async () => {
  for (const env of [{}, { NODE_ENV: 'production' }, { GMN_LINK_AUDIT_HOMOLOGATION: 'true' }, { GMN_LINK_AUDIT_HOMOLOGATION: '0' }, { GMN_LINK_AUDIT_HOMOLOGATION: ' 1' }, { GMN_LINK_AUDIT_HOMOLOGATION: 'on', NODE_ENV: 'production' }]) {
    const evidence = path.join(tmpDir('lasim-cli-'), 'evidencias');
    const h = simHarness(env);
    const code = await runCollectorCli(simArgs(evidence), h.deps);
    assert.equal(code, 3, JSON.stringify(env));
    assert.match(h.err.join('\n'), /GMN_LINK_AUDIT_HOMOLOGATION=1/);
    if (env.NODE_ENV === 'production') assert.match(h.err.join('\n'), /NODE_ENV=production/);
    assert.ok(!fs.existsSync(evidence), 'nenhuma pasta criada');
    assert.deepEqual(h.forbidden, { loadEnv: 0, usedStore: 0, createLiveProviders: 0 });
  }
});

test('CLI (2a): a trava vale SÓ do ambiente do comando: o modo SIMULATED nunca carrega o arquivo de ambiente (que poderia trazê-la)', async () => {
  const evidence = path.join(tmpDir('lasim-cli-'), 'evidencias');
  const env: Record<string, string | undefined> = {};
  const h = simHarness(env);
  const deps = { ...h.deps, loadEnv: () => { h.forbidden.loadEnv += 1; env.GMN_LINK_AUDIT_HOMOLOGATION = '1'; } };
  assert.equal(await runCollectorCli(simArgs(evidence), deps), 3);
  assert.equal(h.forbidden.loadEnv, 0);
  assert.ok(!fs.existsSync(evidence));
});

test('CLI (2a, 2d): --simulated não aceita --live nem as opções do LIVE, nem --link/--name/--city/--uf (dados fixos e sintéticos); exige --audit, --operator e --evidence-dir', async () => {
  const evidence = tmpDir('lasim-cli-');
  const cases: string[][] = [
    ['--live'], ['--ack-cost'], ['--authorization-id', 'auth-teste-0001'], ['--max-maps-calls', '1'], ['--expires-in-minutes', '5'],
    ['--link', SIMULATED_LINK], ['--name', 'Empresa de Ensaio'], ['--city', 'Cidade de Ensaio'], ['--uf', 'ZZ'],
  ];
  for (const extra of cases) {
    const h = simHarness(HOMOLOGATION_ENV);
    assert.equal(await runCollectorCli(simArgs(evidence, extra), h.deps), 1, extra.join(' '));
    assert.match(h.err.join('\n'), new RegExp(extra[0] as string));
  }
  for (const drop of ['--audit', '--operator', '--evidence-dir']) {
    const args = simArgs(evidence);
    const at = args.indexOf(drop);
    args.splice(at, 2);
    const h = simHarness(HOMOLOGATION_ENV);
    assert.equal(await runCollectorCli(args, h.deps), 1, drop);
  }
  const h = simHarness(HOMOLOGATION_ENV);
  assert.equal(await runCollectorCli(simArgs(evidence, [], 'X'), h.deps), 1, 'auditId inválido');
  assert.deepEqual(fs.readdirSync(evidence), [], 'nada gravado');
});

test('CLI (S-02): com a trava, --json imprime UM objeto com a marca e o source.capture.sha256 IGUAL ao contentSha256 relido da captura marcada; nada real é usado', async () => {
  const evidence = tmpDir('lasim-cli-');
  const { report, collectorHash, harness } = await collectSimulated(evidence);
  assert.deepEqual(harness.forbidden, { loadEnv: 0, usedStore: 0, createLiveProviders: 0 });
  assert.equal(report.source.simulated, true);
  assert.equal(report.source.provider, 'SIMULATED');
  assert.match(collectorHash, /^[0-9a-f]{64}$/);
  const capture = await readCapture(evidence, SIM_AUDIT_ID, 1);
  assert.ok(capture.ok);
  assert.equal(capture.value.simulated, true);
  assert.equal(collectorHash, capture.value.contentSha256);
  assert.equal((capture.value.input.identity as { name?: string }).name, 'Empresa de Ensaio');
  assert.deepEqual(fs.readdirSync(path.join(evidence, SIM_AUDIT_ID)).sort(), ['c0001.capture.json', 'c0001.report-r0001.json']);
});

test('CLI: a saída legível diz "SIMULADA — ensaio" e que nenhuma consulta foi feita', async () => {
  const evidence = tmpDir('lasim-cli-');
  const h = simHarness(HOMOLOGATION_ENV);
  assert.equal(await runCollectorCli(simArgs(evidence), h.deps), 0, h.err.join('\n'));
  const text = h.out.join('\n');
  assert.match(text, /SIMULADA — ensaio/);
  assert.match(text, /nenhuma consulta/i);
  assert.match(text, /RELATÓRIO \(SIMULATED\) — tráfego externo: não/);
  assert.match(text, /Chamadas: enviadas 0/);
});

test('zero rede (3): a coleta simulada completa (CLI → runtime → gravação) com fetch, DNS, net e http(s) trocados por armadilhas, sem acioná-las', async () => {
  const trap = (name: string) => () => {
    throw new Error(`rede proibida: ${name}`);
  };
  const guards = [
    mock.method(globalThis, 'fetch', trap('fetch')),
    mock.method(dns, 'lookup', trap('dns.lookup') as never),
    mock.method(dns.promises, 'lookup', trap('dns.promises.lookup') as never),
    mock.method(net, 'connect', trap('net.connect') as never),
    mock.method(net.Socket.prototype, 'connect', trap('net.Socket#connect') as never),
    mock.method(http, 'request', trap('http.request') as never),
    mock.method(https, 'request', trap('https.request') as never),
  ];
  try {
    const evidence = tmpDir('lasim-net-');
    const { report } = await collectSimulated(evidence);
    assert.equal(report.source.simulated, true);
    for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
  } finally {
    for (const guard of guards) guard.mock.restore();
  }
});

/* ------------------------------------------------------------------ revisão do PR #62, item 2: origem SIMULADA no relatório */

const SERPER_ORIGIN = /via Serper|Serper \/maps|pelo Serper|viaSerper/i;
/** Todos os textos (e o campo viaSerper) do relatório, com o caminho, para achar qualquer "obtido via Serper". */
function textsOf(value: unknown, at = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[at, value]];
  if (typeof value === 'boolean' && at.endsWith('.viaSerper')) return value ? [[at, 'viaSerper=true']] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => textsOf(item, `${at}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => textsOf(item, `${at}.${key}`));
  return [];
}

test('origem (PR #62, item 2): o relatório SIMULADO diz que a fonte é o gerador sintético — data.googleMaps.source SIMULATED, viaSerper:false e NENHUM texto "obtido via Serper"', async () => {
  const evidence = tmpDir('lasim-orig-');
  const { report } = await collectSimulated(evidence);
  const full = report as unknown as { data: { googleMaps: { source: string } | null }; verified: Array<{ viaSerper: boolean; originNote: string | null }>; source: { description: string } };
  assert.equal(full.data.googleMaps?.source, 'SIMULATED');
  assert.ok(full.verified.length > 0 && full.verified.every((item) => item.viaSerper === false && /SIMULADA — ensaio/.test(item.originNote ?? '')));
  const serper = textsOf(report).filter(([at, text]) => at !== '.source.description' && SERPER_ORIGIN.test(text));
  assert.deepEqual(serper, [], 'nenhum texto do relatório simulado atribui o dado ao Serper');
  // controle: o relatório real continua atribuindo ao Serper (intermediário), como antes
  const text = bodyText();
  const real = await buildReportFromCapture({ rawBody: text, body: { name: 'c0001.capture.json', sha256: 'a'.repeat(64), bytes: Buffer.byteLength(text) }, otherFiles: [], httpStatus: 200, httpAttempts: 1, collectedAt: COLLECTED_AT, input: inputFor(identity()), site: null, generatedAt: T_NOW });
  assert.ok(real.ok);
  assert.equal(real.report.data.googleMaps?.source, 'serper-maps');
  assert.ok(real.report.verified.some((item) => item.viaSerper));
});
