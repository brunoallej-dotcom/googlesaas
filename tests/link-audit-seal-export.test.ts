import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { candidatePackageSchema, CHECK_IDS, computePackageSha256, evidenceToProveFromBasis, isPackageHashConsistent, type CandidatePackage } from '../src/lib/link-audit-attestation';
import { buildCandidatePackage, exportRefusalFor, type CandidateInput } from '../src/lib/link-audit-attestation/export';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { legacyReplica, readBasis } from './helpers/link-audit-mapper-real-basis';
import { at, checkStatus, exportArgs, HOUR, jsonOf, makeAudit, newOut, NOW, readJsonFile, runCli, T_COLLECT, type FixtureAudit } from './helpers/link-audit-seal-export-fixtures';

/* Dados 100% FICTÍCIOS. P1 W2 — `export` (pacote candidato, somente leitura): verificações mecânicas, janela, recusas e formato. */
registerCleanup();

const MECHANICAL = ['INTEGRITY_LOCAL', 'COLLECTOR_HASH_MATCHES', 'COLLECTION_GAP_WITHIN_LIMIT', 'HTTP_2XX_AND_COLLECTED_AT', 'REPORT_REPRODUCES'] as const;
const NON_MECHANICAL = ['AUTHORIZATION_CONSUMED', 'PROVIDER_PANEL_CREDITS', 'URL_QUERY_COHERENCE'] as const;

async function exportOk(audit: FixtureAudit, extra: readonly string[] = [], now: Date = NOW): Promise<{ pkg: CandidatePackage; out: string }> {
  const out = newOut();
  const run = await runCli(exportArgs(audit, extra, out), now);
  assert.equal(run.code, 0, `${run.stderr}\n${run.stdout}`);
  const pkg = readJsonFile<CandidatePackage>(out);
  assert.ok(candidatePackageSchema.safeParse(pkg).success, 'o pacote passa no esquema estrito da W1');
  assert.ok(isPackageHashConsistent(pkg), 'packageSha256 confere com o corpo');
  return { pkg, out };
}

async function exportRefused(argv: readonly string[], code: string, now: Date = NOW): Promise<void> {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const run = await runCli([...argv, '--json'], now);
  assert.equal(run.code, code === 'USAGE' ? 1 : 3, run.stdout);
  const result = jsonOf(run);
  assert.equal(result.ok, false);
  assert.equal(result.code, code, String(result.message));
  assert.deepEqual(Object.keys(result).sort(), ['code', 'message', 'ok']);
  if (out !== undefined) assert.equal(fs.existsSync(out), false, 'recusa ⇒ nenhum arquivo --out criado');
}

/* -------------------------------------------------------------------- IA-17: uma verificação mecânica por teste */

test('IA-17 INTEGRITY_LOCAL: leitura READY ⇒ PASS; arquivo alterado ou coleta incompleta ⇒ EXPORT_INTEGRITY_NOT_OK (nunca "exporta para conferir")', async () => {
  const audit = await makeAudit();
  assert.equal(checkStatus((await exportOk(audit)).pkg, 'INTEGRITY_LOCAL'), 'PASS');

  const tampered = await makeAudit();
  const file = path.join(tampered.dir, 'c0001.capture.json');
  fs.chmodSync(file, 0o644); // o armazenamento sela o arquivo em somente leitura
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"attempts": 1', '"attempts": 2'));
  await exportRefused(exportArgs(tampered), 'EXPORT_INTEGRITY_NOT_OK');

  const incomplete = await makeAudit([{ report: false }]);
  await exportRefused(exportArgs(incomplete), 'EXPORT_INTEGRITY_NOT_OK');
});

test('IA-17 COLLECTOR_HASH_MATCHES: igual ⇒ PASS; divergente ou para captura inexistente ⇒ EXPORT_COLLECTOR_HASH_MISMATCH (IA-19)', async () => {
  const audit = await makeAudit();
  assert.equal(checkStatus((await exportOk(audit)).pkg, 'COLLECTOR_HASH_MATCHES'), 'PASS');
  const base = ['export', '--evidence-dir', audit.base, '--audit', audit.auditId, '--max-gap-hours', '24', '--out', newOut()];
  await exportRefused([...base, '--collector-hash', `c0001=${'f'.repeat(64)}`], 'EXPORT_COLLECTOR_HASH_MISMATCH');
  await exportRefused([...base, '--collector-hash', `c0001=${audit.captures[0]?.contentSha256}`, '--collector-hash', `c0002=${'a'.repeat(64)}`], 'EXPORT_COLLECTOR_HASH_MISMATCH');
});

test('IA-19 (2): captura nova sem --collector-hash ⇒ EXPORT_COLLECTOR_HASH_REQUIRED (não há opção que dispense), também quando falta só uma de duas', async () => {
  const audit = await makeAudit([{}, { collectedAt: at(T_COLLECT, HOUR).toISOString() }]);
  const base = ['export', '--evidence-dir', audit.base, '--audit', audit.auditId, '--max-gap-hours', '24', '--out', newOut()];
  await exportRefused(base, 'EXPORT_COLLECTOR_HASH_REQUIRED');
  await exportRefused([...base, '--collector-hash', `c0001=${audit.captures[0]?.contentSha256}`], 'EXPORT_COLLECTOR_HASH_REQUIRED');
  const both = await exportOk(audit, [], at(T_COLLECT, 3 * HOUR));
  assert.equal(checkStatus(both.pkg, 'COLLECTOR_HASH_MATCHES'), 'PASS');
});

test('IA-17 COLLECTION_GAP_WITHIN_LIMIT: dentro do limite ⇒ PASS; acima com --gap-justification ⇒ PASS e a justificativa entra no pacote (IA-20)', async () => {
  const audit = await makeAudit();
  const within = await exportOk(audit);
  assert.equal(checkStatus(within.pkg, 'COLLECTION_GAP_WITHIN_LIMIT'), 'PASS');
  assert.deepEqual(within.pkg.gap, { maxHours: 24, observedHours: 2, justification: null });
  const late = at(T_COLLECT, 30 * HOUR);
  const justified = await exportOk(audit, ['--gap-justification', 'Conferente indisponível no fim de semana.'], late);
  assert.equal(checkStatus(justified.pkg, 'COLLECTION_GAP_WITHIN_LIMIT'), 'PASS');
  assert.deepEqual(justified.pkg.gap, { maxHours: 24, observedHours: 30, justification: 'Conferente indisponível no fim de semana.' });
});

test('IA-17 HTTP_2XX_AND_COLLECTED_AT: todas as capturas 2xx com collectedAt ⇒ PASS; captura com HTTP 500 ou sem status ⇒ FAIL (pacote sai, o sign recusará)', async () => {
  const ok = await makeAudit([{}, { collectedAt: at(T_COLLECT, HOUR).toISOString() }]);
  assert.equal(checkStatus((await exportOk(ok, [], at(T_COLLECT, 3 * HOUR))).pkg, 'HTTP_2XX_AND_COLLECTED_AT'), 'PASS');
  for (const status of [500, null]) {
    const bad = await makeAudit([{}, { collectedAt: at(T_COLLECT, HOUR).toISOString(), status }]);
    const { pkg } = await exportOk(bad, [], at(T_COLLECT, 3 * HOUR));
    assert.equal(checkStatus(pkg, 'HTTP_2XX_AND_COLLECTED_AT'), 'FAIL', `status ${String(status)}`);
    assert.equal(pkg.attestable, true, 'FAIL desta verificação não é recusa do export (spec §5.3.1); o sign recusa (IA-01 d)');
  }
});

test('IA-17 REPORT_REPRODUCES: sempre NOT_EXECUTED (viabilidade não confirmada; conferência humana, contrato §4.1.5); os três não mecanizáveis também', async () => {
  const { pkg } = await exportOk(await makeAudit());
  assert.equal(checkStatus(pkg, 'REPORT_REPRODUCES'), 'NOT_EXECUTED');
  for (const id of NON_MECHANICAL) assert.equal(checkStatus(pkg, id), 'NOT_EXECUTED', id);
  assert.deepEqual(pkg.checks.map((c) => c.id), [...CHECK_IDS], 'as 8 verificações, cada uma uma vez, na ordem da spec');
});

/* -------------------------------------------------------------------- IA-20: janela entre coleta e exportação */

test('IA-20: acima de --max-gap-hours sem justificativa ⇒ EXPORT_GAP_EXCEEDED; sem --max-gap-hours para captura nova ⇒ uso (1)', async () => {
  const audit = await makeAudit();
  await exportRefused(exportArgs(audit), 'EXPORT_GAP_EXCEEDED', at(T_COLLECT, 25 * HOUR));
  const withoutMax = exportArgs(audit).filter((_, i, all) => all[i] !== '--max-gap-hours' && all[i - 1] !== '--max-gap-hours');
  await exportRefused(withoutMax, 'USAGE');
  for (const value of ['0', '-1', '1.5', 'abc', '24h', '8761', '']) {
    const args = exportArgs(audit).map((token, i, all) => (all[i - 1] === '--max-gap-hours' ? value : token));
    await exportRefused(args, 'USAGE');
  }
});

test('IA-20: o intervalo (limite, horas observadas, justificativa) entra no pacote E no hash', async () => {
  const audit = await makeAudit();
  const a = await exportOk(audit);
  const b = await exportOk(audit, [], NOW);
  assert.equal(a.pkg.packageSha256, b.pkg.packageSha256);
  const widerOut = newOut();
  const widerRun = await runCli(exportArgs(audit, [], widerOut).map((token, i, all) => (all[i - 1] === '--max-gap-hours' ? '48' : token)), NOW);
  assert.equal(widerRun.code, 0, widerRun.stderr);
  const wider = readJsonFile<CandidatePackage>(widerOut);
  assert.equal(wider.gap?.maxHours, 48);
  assert.notEqual(wider.packageSha256, a.pkg.packageSha256, 'maxHours muda o hash');
  const justified = await exportOk(audit, ['--gap-justification', 'Registro da conferência.']);
  assert.notEqual(justified.pkg.packageSha256, a.pkg.packageSha256, 'a justificativa muda o hash');
  const later = await exportOk(audit, [], at(T_COLLECT, 5 * HOUR));
  assert.equal(later.pkg.gap?.observedHours, 5);
  assert.notEqual(later.pkg.packageSha256, a.pkg.packageSha256, 'as horas observadas mudam o hash');
});

test('decisão W2 (observedHours): arredondado PARA CIMA à hora, dentro do hash; reproduzível dentro da mesma hora; nunca subestima o intervalo', async () => {
  const audit = await makeAudit();
  const exact = await exportOk(audit, [], at(T_COLLECT, 2 * HOUR));
  const sameBucket = await exportOk(audit, [], at(T_COLLECT, HOUR + 1));
  const sameBucketLater = await exportOk(audit, [], at(T_COLLECT, 2 * HOUR - 1));
  assert.equal(exact.pkg.gap?.observedHours, 2);
  assert.equal(sameBucket.pkg.gap?.observedHours, 2, '1 h + 1 ms ⇒ 2 h');
  assert.equal(sameBucket.pkg.packageSha256, sameBucketLater.pkg.packageSha256, 'duas exportações na mesma hora ⇒ mesmo packageSha256 (generatedAt fica fora do hash)');
  assert.equal(sameBucket.pkg.packageSha256, exact.pkg.packageSha256);
  const atLimit = await exportOk(audit, [], at(T_COLLECT, 24 * HOUR));
  assert.equal(atLimit.pkg.gap?.observedHours, 24);
  assert.equal(checkStatus(atLimit.pkg, 'COLLECTION_GAP_WITHIN_LIMIT'), 'PASS');
  await exportRefused(exportArgs(audit), 'EXPORT_GAP_EXCEEDED', at(T_COLLECT, 24 * HOUR + 1));
  const zero = await exportOk(audit, [], at(T_COLLECT, 0));
  assert.equal(zero.pkg.gap?.observedHours, 0);
});

test('janela: coleta com data POSTERIOR ao relógio da estação ⇒ EXPORT_CLOCK_REGRESSION, mesmo com justificativa', async () => {
  const audit = await makeAudit();
  await exportRefused(exportArgs(audit), 'EXPORT_CLOCK_REGRESSION', at(T_COLLECT, -1));
  await exportRefused(exportArgs(audit, ['--gap-justification', 'Relógio atrasado.']), 'EXPORT_CLOCK_REGRESSION', at(T_COLLECT, -HOUR));
});

/* -------------------------------------------------------------------- herdado da revisão da W1 */

test('herdado W1 (a): datas do pacote normalizadas com toISOString (o leitor aceita 0 ou 6 casas; o pacote tem exatamente 3 e Z)', async () => {
  const audit = await makeAudit([{ collectedAt: '2026-10-22T12:54:48Z' }, { collectedAt: '2026-10-22T13:10:05.123456Z' }]);
  const { pkg } = await exportOk(audit, [], at('2026-10-22T13:10:05.123Z', HOUR));
  assert.equal(pkg.summary.firstCollectedAt, '2026-10-22T12:54:48.000Z');
  assert.equal(pkg.summary.lastCollectedAt, '2026-10-22T13:10:05.123Z');
  assert.match(pkg.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(checkStatus(pkg, 'HTTP_2XX_AND_COLLECTED_AT'), 'PASS', 'o collectedAt cru das duas leituras confere');
});

test('herdado W1 (b): pacote LEGADO tem as 8 verificações (mecânicas em NOT_EXECUTED), attestable false, gap null; não exige --collector-hash nem --max-gap-hours', async () => {
  const { base } = await legacyReplica();
  const out = newOut();
  const run = await runCli(['export', '--evidence-dir', base, '--audit', 'auditoria-teste-0001', '--out', out]);
  assert.equal(run.code, 0, run.stderr);
  const pkg = readJsonFile<CandidatePackage>(out);
  assert.ok(candidatePackageSchema.safeParse(pkg).success);
  assert.ok(isPackageHashConsistent(pkg));
  assert.equal(pkg.layout, 'LEGACY');
  assert.equal(pkg.attestable, false);
  assert.equal(pkg.summary.containsLegacy, true);
  assert.equal(pkg.gap, null);
  assert.deepEqual(pkg.checks, CHECK_IDS.map((id) => ({ id, status: 'NOT_EXECUTED' })));
  assert.ok(pkg.entries.every((e) => e.legacy));
  assert.deepEqual(pkg.entries.map((e) => e.ref), ['capture:c0001', 'legacy-status:c0001', 'report:c0001-r0001', 'report:c0001-r0002']);
  assert.match(run.stdout, /NÃO ATESTÁVEL/);
  // valor do coletor para captura legada = "valor sem captura (não legada)" ⇒ recusa
  await exportRefused(['export', '--evidence-dir', base, '--audit', 'auditoria-teste-0001', '--collector-hash', `c0001=${pkg.entries[0]?.contentSha256}`, '--out', newOut()], 'EXPORT_COLLECTOR_HASH_MISMATCH');
});

function attestableBody(over: Partial<Record<(typeof MECHANICAL)[number], 'PASS' | 'FAIL' | 'NOT_EXECUTED'>> = {}): CandidatePackage {
  const checks = CHECK_IDS.map((id) => ({ id, status: (over as Record<string, 'PASS' | 'FAIL' | 'NOT_EXECUTED'>)[id] ?? (['INTEGRITY_LOCAL', 'COLLECTOR_HASH_MATCHES', 'COLLECTION_GAP_WITHIN_LIMIT'].includes(id) ? 'PASS' : 'NOT_EXECUTED') }));
  const body = {
    schemaVersion: 1 as const, kind: 'LINK_AUDIT_P1_CANDIDATE' as const, auditId: 'auditoria-teste-0001', layout: 'VERSIONED' as const, attestable: true,
    summary: { company: { name: null, city: null, stateCode: null }, firstCollectedAt: T_COLLECT, lastCollectedAt: T_COLLECT, captures: 1, reportRevisions: 0, artifacts: 0, containsLegacy: false },
    integrity: { status: 'OK' as const, algorithm: 'SHA-256' as const, checkedFiles: 1 }, checks, gap: { maxHours: 24, observedHours: 1, justification: null },
    entries: [{ ref: 'capture:c0001', contentSha256: 'a'.repeat(64), legacy: false }],
  };
  return { ...body, delta: null, packageSha256: computePackageSha256(body), generatedAt: NOW.toISOString() };
}

test('herdado W1 (c): pacote attestable com INTEGRITY_LOCAL ou COLLECTOR_HASH_MATCHES em FAIL é recusado pelo export (o esquema sozinho NÃO recusa)', () => {
  const integrityFail = attestableBody({ INTEGRITY_LOCAL: 'FAIL' });
  const collectorFail = attestableBody({ COLLECTOR_HASH_MATCHES: 'FAIL' });
  assert.ok(candidatePackageSchema.safeParse(integrityFail).success && candidatePackageSchema.safeParse(collectorFail).success, 'o esquema aceita (por isso a guarda existe)');
  assert.equal(exportRefusalFor(integrityFail)?.code, 'EXPORT_INTEGRITY_NOT_OK');
  assert.equal(exportRefusalFor(collectorFail)?.code, 'EXPORT_COLLECTOR_HASH_MISMATCH');
  assert.equal(exportRefusalFor(attestableBody({ COLLECTOR_HASH_MATCHES: 'NOT_EXECUTED' }))?.code, 'EXPORT_COLLECTOR_HASH_REQUIRED');
  assert.equal(exportRefusalFor(attestableBody({ COLLECTION_GAP_WITHIN_LIMIT: 'FAIL' }))?.code, 'EXPORT_GAP_EXCEEDED');
  assert.equal(exportRefusalFor(attestableBody({ HTTP_2XX_AND_COLLECTED_AT: 'FAIL' })), null, 'FAIL de HTTP não é recusa do export');
  assert.equal(exportRefusalFor(attestableBody()), null);
  assert.equal(exportRefusalFor({ ...attestableBody({ INTEGRITY_LOCAL: 'NOT_EXECUTED', COLLECTOR_HASH_MATCHES: 'NOT_EXECUTED' }), attestable: false }), null, 'legado (não atestável) só descreve');
});

/* -------------------------------------------------------------------- o pacote e a montagem pura */

test('pacote: entradas = função única basis → EvidenceToProve (ordenadas), resumo com a empresa informada pelo operador, contagens e integridade', async () => {
  const audit = await makeAudit([{}, { collectedAt: at(T_COLLECT, HOUR).toISOString(), report: true }]);
  const { pkg, out } = await exportOk(audit, [], at(T_COLLECT, 2 * HOUR));
  const basis = await readBasis(audit.base, audit.auditId);
  const expected = evidenceToProveFromBasis(basis).sort((x, y) => (x.ref < y.ref ? -1 : 1));
  assert.deepEqual(pkg.entries, expected);
  assert.deepEqual(pkg.summary, { company: { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' }, firstCollectedAt: T_COLLECT, lastCollectedAt: at(T_COLLECT, HOUR).toISOString(), captures: 2, reportRevisions: 2, artifacts: 0, containsLegacy: false });
  assert.deepEqual(pkg.integrity, { status: 'OK', algorithm: 'SHA-256', checkedFiles: 4 });
  assert.equal(pkg.generatedAt, at(T_COLLECT, 2 * HOUR).toISOString());
  assert.equal(pkg.delta, null);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600, 'o pacote (tem nome/cidade/UF) nasce com 0600');
  assert.equal(fs.readFileSync(out, 'utf8'), `${JSON.stringify(pkg, null, 2)}\n`);
});

test('IA-10 (determinismo, via export): mesmos arquivos, argumentos e instante ⇒ arquivo idêntico byte a byte', async () => {
  const audit = await makeAudit();
  const a = await exportOk(audit);
  const b = await exportOk(audit);
  assert.equal(fs.readFileSync(a.out, 'utf8'), fs.readFileSync(b.out, 'utf8'));
});

test('EXPORT_TOO_MANY_ENTRIES: mais de 2000 entradas ⇒ recusa (montagem pura, sem gravar 2001 arquivos)', () => {
  const evidences = Array.from({ length: 2001 }, (_, i) => ({ ref: `capture:c${String(i + 1).padStart(4, '0')}`, kind: 'CAPTURE' as const, capture: i + 1, observedAt: T_COLLECT, contentSha256: 'a'.repeat(64), legacy: false }));
  const input: CandidateInput = { auditId: 'auditoria-teste-0001', basis: { layout: 'VERSIONED', evidences }, captureFacts: null, company: null, collectorHashes: new Map(evidences.map((e) => [e.capture, e.contentSha256])), maxGapHours: 24, gapJustification: null, now: NOW };
  const result = buildCandidatePackage(input);
  assert.ok(!result.ok && result.code === 'EXPORT_TOO_MANY_ENTRIES');
  const kept = evidences.slice(0, 2000);
  const fits = buildCandidatePackage({ ...input, basis: { layout: 'VERSIONED', evidences: kept }, collectorHashes: new Map(kept.map((e) => [e.capture, e.contentSha256])) });
  assert.ok(fits.ok, 'exatamente 2000 cabem');
  assert.equal(checkStatus(fits.package, 'HTTP_2XX_AND_COLLECTED_AT'), 'NOT_EXECUTED', 'sem as versões do leitor, a verificação HTTP não é executada');
});

test('montagem pura: leituras divergentes entre os dois leitores (captura a mais/menos ou collectedAt diferente) ⇒ EXPORT_INTEGRITY_NOT_OK', () => {
  const evidences = [{ ref: 'capture:c0001', kind: 'CAPTURE' as const, capture: 1, observedAt: T_COLLECT, contentSha256: 'a'.repeat(64), legacy: false }];
  const input: CandidateInput = { auditId: 'auditoria-teste-0001', basis: { layout: 'VERSIONED', evidences }, captureFacts: [{ capture: 1, collectedAt: T_COLLECT, httpStatus: 200 }], company: { name: 'Padaria\u0007', city: 'x'.repeat(201), stateCode: 'go' }, collectorHashes: new Map([[1, 'a'.repeat(64)]]), maxGapHours: 24, gapJustification: null, now: NOW };
  const ok = buildCandidatePackage(input);
  assert.ok(ok.ok);
  assert.deepEqual(ok.package.summary.company, { name: null, city: null, stateCode: null }, 'valor fora de forma vira null (NOT_VERIFIED), nunca é corrigido');
  for (const captureFacts of [[], [{ capture: 1, collectedAt: '2026-10-22T12:54:49.079Z', httpStatus: 200 }], [{ capture: 1, collectedAt: T_COLLECT, httpStatus: 200 }, { capture: 2, collectedAt: T_COLLECT, httpStatus: 200 }]]) {
    const result = buildCandidatePackage({ ...input, captureFacts });
    assert.ok(!result.ok && result.code === 'EXPORT_INTEGRITY_NOT_OK', JSON.stringify(captureFacts));
  }
  const badDate = buildCandidatePackage({ ...input, basis: { layout: 'VERSIONED', evidences: [{ ...evidences[0]!, observedAt: '2026-99-99T99:99:99Z' }] } });
  assert.ok(!badDate.ok && badDate.code === 'EXPORT_INTEGRITY_NOT_OK');
});

/* -------------------------------------------------------------------- delta informativo (--seals-dir) */

test('--seals-dir: delta informativo FORA do hash (novas/alteradas/ausentes contra o último manifesto); pasta ilegível ⇒ delta null', async () => {
  const audit = await makeAudit([{}, { collectedAt: at(T_COLLECT, HOUR).toISOString(), report: true }]);
  const now = at(T_COLLECT, 2 * HOUR);
  const plain = await exportOk(audit, [], now);
  const seals = tmpDir('lase-seals-');
  const runWith = async (sealsDir: string) => {
    const run = await runCli(exportArgs(audit, ['--seals-dir', sealsDir, '--json'], newOut()), now);
    assert.equal(run.code, 0, run.stdout);
    return jsonOf(run) as { packageSha256: string; delta: unknown; deltaStatus: string };
  };
  const none = await runWith(seals);
  assert.equal(none.deltaStatus, 'NO_SEALS');
  assert.deepEqual(none.delta, { added: plain.pkg.entries.map((e) => e.ref), changed: [], missing: [] });
  assert.equal(none.packageSha256, plain.pkg.packageSha256, 'o delta não entra no hash');

  const [first, second] = plain.pkg.entries;
  fs.mkdirSync(path.join(seals, audit.auditId));
  const seal = { schemaVersion: 1, kind: 'LINK_AUDIT_EVIDENCE_SEAL', auditId: audit.auditId, seq: 2, sealedAt: T_COLLECT, keyId: 'ek-202611-a', signature: 'A'.repeat(86), entries: [{ ref: first!.ref, contentSha256: first!.contentSha256 }, { ref: second!.ref, contentSha256: 'b'.repeat(64) }, { ref: 'report:c0009-r0001', contentSha256: 'c'.repeat(64) }] };
  fs.writeFileSync(path.join(seals, audit.auditId, 'seal-0001.json'), '{}');
  fs.writeFileSync(path.join(seals, audit.auditId, 'seal-0002.json'), JSON.stringify(seal));
  const computed = await runWith(seals);
  assert.equal(computed.deltaStatus, 'COMPUTED');
  assert.deepEqual(computed.delta, { added: plain.pkg.entries.slice(2).map((e) => e.ref), changed: [second!.ref], missing: ['report:c0009-r0001'] });
  assert.equal(computed.packageSha256, plain.pkg.packageSha256);

  fs.writeFileSync(path.join(seals, audit.auditId, 'seal-0003.json'), '{"lixo": true}');
  const unreadable = await runWith(seals);
  assert.equal(unreadable.deltaStatus, 'UNREADABLE');
  assert.equal(unreadable.delta, null);
  const missingDir = await runWith(path.join(seals, 'nao-existe'));
  assert.equal(missingDir.deltaStatus, 'UNREADABLE', 'pasta de manifestos inexistente não é "nenhum manifesto" (provável erro de digitação)');
});

/* -------------------------------------------------------------------- recusas de localização */

test('EXPORT_NOT_FOUND: auditoria inexistente ou pasta de evidências inexistente; pasta proibida (área do projeto) ⇒ uso', async () => {
  const audit = await makeAudit();
  await exportRefused(exportArgs({ ...audit, auditId: 'auditoria-outra-0002' }), 'EXPORT_NOT_FOUND');
  await exportRefused(exportArgs({ ...audit, base: path.join(audit.base, 'nao-existe') }), 'EXPORT_NOT_FOUND');
  const project = tmpDir('lase-proj-');
  fs.mkdirSync(path.join(project, 'src'));
  const run = await runCli([...exportArgs({ ...audit, base: path.join(project, 'src') }), '--json'], NOW, { projectRoot: project });
  assert.equal(run.code, 1);
  assert.equal(jsonOf(run).code, 'USAGE');
});

/* -------------------------------------------------------------------- analisador estrito de argumentos */

test('argumentos: flag desconhecida, repetida ou sem valor ⇒ USAGE (código 1); a ÚNICA repetível é --collector-hash', async () => {
  const audit = await makeAudit();
  const good = exportArgs(audit);
  const cases: Array<[string, string[]]> = [
    ['sem subcomando', []],
    ['subcomando desconhecido', ['exportar', ...good.slice(1)]],
    ['flag desconhecida', [...good, '--force']],
    ['forma --x=y', [...good.slice(0, 1), `--audit=${audit.auditId}`, ...good.slice(1)]],
    ['--audit repetido', [...good, '--audit', audit.auditId]],
    ['--json repetido', [...good, '--json', '--json']],
    ['--show-summary repetido', [...good, '--show-summary', '--show-summary']],
    ['--out repetido', [...good, '--out', newOut()]],
    ['--max-gap-hours repetido', [...good, '--max-gap-hours', '24']],
    ['valor ausente no fim', [...good, '--seals-dir']],
    ['valor que é outra flag', ['export', '--evidence-dir', '--audit', audit.auditId]],
    ['argumento solto', [...good, 'solto']],
    ['falta --audit', good.filter((_, i, all) => all[i] !== '--audit' && all[i - 1] !== '--audit')],
    ['falta --evidence-dir', good.filter((_, i, all) => all[i] !== '--evidence-dir' && all[i - 1] !== '--evidence-dir')],
    ['auditId inválido', good.map((t, i, all) => (all[i - 1] === '--audit' ? 'CURTO' : t))],
    ['--collector-hash sem =', [...good, '--collector-hash', 'c0002']],
    ['--collector-hash maiúsculo', [...good, '--collector-hash', `c0002=${'A'.repeat(64)}`]],
    ['--collector-hash c0000', [...good, '--collector-hash', `c0000=${'a'.repeat(64)}`]],
    ['--collector-hash repetido para a mesma captura', [...good, '--collector-hash', `c0001=${'a'.repeat(64)}`]],
    ['--gap-justification sem --max-gap-hours', good.filter((_, i, all) => all[i] !== '--max-gap-hours' && all[i - 1] !== '--max-gap-hours').concat(['--gap-justification', 'motivo'])],
    ['--gap-justification com e-mail', [...good, '--gap-justification', 'falar com ana@empresa.com']],
    ['--gap-justification com telefone', [...good, '--gap-justification', 'ligar 62 99999-0000']],
    ['--gap-justification longa', [...good, '--gap-justification', 'x'.repeat(281)]],
    ['sem --out e sem --show-summary', good.filter((_, i, all) => all[i] !== '--out' && all[i - 1] !== '--out')],
    ['--out vazio', good.map((t, i, all) => (all[i - 1] === '--out' ? '' : t))],
  ];
  for (const [label, argv] of cases) {
    const run = await runCli([...argv, ...(argv.includes('--json') ? [] : ['--json'])]);
    assert.equal(run.code, 1, `${label}: ${run.stdout}`);
    assert.equal(jsonOf(run).code, 'USAGE', label);
    assert.ok(!/ana@empresa|99999/.test(run.stdout + run.stderr), `${label}: valor da opção nunca é ecoado`);
  }
  const human = await runCli([...good, '--force']);
  assert.equal(human.code, 1);
  assert.equal(human.stdout, '', 'erro de uso vai para stderr');
  assert.match(human.stderr, /Uso: npm run link-audit:seal -- export/);
});

test('subcomando sign (onda W4) ainda não existe: responde erro de uso, sem ler nada', async () => {
  for (const json of [false, true]) {
    const run = await runCli(['sign', '--audit', 'auditoria-teste-0001', '--package', '/nao/existe.json', ...(json ? ['--json'] : [])]);
    assert.equal(run.code, 1);
    assert.match(json ? String(jsonOf(run).message) : run.stderr, /W4/);
  }
});

/* -------------------------------------------------------------------- saída estável (humana e --json) */

test('--json: um único objeto com forma estável; com --show-summary inclui a empresa; sem --out (só com --show-summary) inclui o pacote', async () => {
  const audit = await makeAudit();
  const run = await runCli(exportArgs(audit, ['--json']));
  assert.equal(run.code, 0);
  const result = jsonOf(run);
  assert.deepEqual(Object.keys(result), ['ok', 'code', 'auditId', 'layout', 'attestable', 'packageSha256', 'counts', 'integrity', 'checks', 'gap', 'delta', 'deltaStatus', 'output']);
  assert.equal(result.ok, true);
  assert.equal(result.code, null);
  assert.deepEqual(result.counts, { captures: 1, reportRevisions: 1, artifacts: 0, entries: 2 });
  assert.deepEqual(result.gap, { maxHours: 24, observedHours: 2, justified: false });
  assert.equal(result.deltaStatus, 'NOT_REQUESTED');
  assert.equal(result.output, 'FILE');

  const summary = jsonOf(await runCli(exportArgs(audit, ['--json', '--show-summary'])));
  assert.deepEqual(summary.company, { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' });
  const stdoutRun = await runCli(exportArgs(audit, ['--json', '--show-summary'], null));
  assert.equal(stdoutRun.code, 0);
  const inline = jsonOf(stdoutRun);
  assert.equal(inline.output, 'STDOUT');
  const pkg = inline.package as CandidatePackage;
  assert.ok(candidatePackageSchema.safeParse(pkg).success && isPackageHashConsistent(pkg));
  assert.equal(pkg.packageSha256, result.packageSha256);
});

test('saída humana: auditId, contagens, camada, "Integridade local: OK", verificações, "Pacote: <hash>" e o aviso fixo; sem --out o pacote vai para a saída padrão (bytes iguais aos do --out)', async () => {
  const audit = await makeAudit();
  const out = newOut();
  const run = await runCli(exportArgs(audit, [], out));
  assert.equal(run.code, 0);
  const pkg = readJsonFile<CandidatePackage>(out);
  for (const expected of [`Auditoria: ${audit.auditId}`, 'Camada: VERSIONED', 'Integridade local: OK', `Pacote: ${pkg.packageSha256}`, 'Hash não é assinatura; a conferência de procedência (contrato §4) ainda é necessária.', 'Capturas: 1', 'HTTP_2XX_AND_COLLECTED_AT: PASS', 'REPORT_REPRODUCES: NOT_EXECUTED', 'Não cobertos']) {
    assert.ok(run.stdout.includes(expected), `falta "${expected}"`);
  }
  assert.equal(run.stderr, '');
  const toStdout = await runCli(exportArgs(audit, ['--show-summary'], null));
  assert.equal(toStdout.code, 0);
  assert.equal(`${toStdout.stdout}\n`, fs.readFileSync(out, 'utf8'), 'stdout = exatamente o pacote (redirecionável)');
  assert.match(toStdout.stderr, /Pacote: [0-9a-f]{64}/, 'o resumo humano vai para stderr quando o pacote ocupa a saída padrão');
});
