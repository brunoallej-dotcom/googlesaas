import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generateReport, persistCapture } from '../scripts/link-audit-evidence';
import { createEvidenceReader, EvidenceAccessError, type EvidenceActor } from '../src/lib/link-audit-evidence/reader';
import { writeReport } from '../src/lib/link-audit-evidence/store';
import { AUDIT, registerCleanup, SENTINEL, tmpDir, writeFull } from './helpers/link-audit-evidence-fixtures';
import { clock, LINK } from './helpers/link-audit-collect-fixtures';

registerCleanup();

const OPERATOR: EvidenceActor = { email: 'ana@empresa.com' };
const allow = (actor: EvidenceActor): boolean => actor.email === 'ana@empresa.com';

test('sem autorização nada é lido: todos os métodos recusam (inclusive e-mail vazio e autorizador que falha)', async () => {
  const base = tmpDir();
  await writeFull(base);
  const reader = createEvidenceReader({ baseDir: base, authorize: allow });
  for (const actor of [{ email: 'intruso@x.com' }, { email: '' }, undefined as unknown as EvidenceActor, { email: 123 } as unknown as EvidenceActor]) {
    await assert.rejects(() => reader.listAudits(actor), EvidenceAccessError);
    await assert.rejects(() => reader.getAudit(actor, AUDIT), EvidenceAccessError);
    await assert.rejects(() => reader.listVersions(actor, AUDIT), EvidenceAccessError);
  }
  const throwing = createEvidenceReader({ baseDir: base, authorize: () => { throw new Error('banco fora do ar'); } });
  await assert.rejects(() => throwing.listAudits(OPERATOR), EvidenceAccessError, 'falha fechada');
  const rejecting = createEvidenceReader({ baseDir: base, authorize: async () => false });
  await assert.rejects(() => rejecting.getAudit(OPERATOR, AUDIT), EvidenceAccessError);
});

test('listagem e visão: empresa, data, CID confirmado, verificadas × não verificadas, limitações e origem', async () => {
  const base = tmpDir();
  await writeFull(base);
  const reader = createEvidenceReader({ baseDir: base, authorize: allow });
  const list = await reader.listAudits(OPERATOR);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0]?.company, { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' });
  assert.equal(list[0]?.confirmedCid, '1311768467294899695');
  assert.equal(list[0]?.collectedAt, '2026-10-22T12:54:48.079Z');
  assert.deepEqual([list[0]?.layout, list[0]?.state, list[0]?.captureCount, list[0]?.reportRevisions], ['VERSIONED', 'COMPLETE', 1, 1]);

  const view = await reader.getAudit(OPERATOR, AUDIT);
  assert.ok(view);
  assert.equal(view.source.officialGoogleApi, false);
  assert.match(view.source.provider, /Serper.*não é a API oficial/);
  assert.deepEqual([view.source.httpStatus, view.source.httpAttempts, view.source.creditsReportedByApi], [200, 1, 3]);
  assert.equal(view.methodologyVersion, 'lumos-reconstruida-v1');
  assert.equal(view.scoring, 'NOT_AVAILABLE_PENDING_D3');
  assert.ok(view.evidences.verified.length >= 8 && view.evidences.verified.every((e) => e.status === 'VERIFIED'));
  assert.ok(view.evidences.unverified.length > 0 && view.evidences.unverified.every((e) => e.status === 'NOT_VERIFIED' && e.limitation));
  assert.ok(view.limitations.some((l) => /Serper/.test(l)));
  assert.equal((view.data.site as { accessClass: string }).accessClass, 'HTTP_403');
  assert.ok((view.identifiers as { confirmed: unknown[] }).confirmed.length >= 1);
  assert.equal(view.integrity.status, 'OK');
  assert.match(view.integrity.note, /assinatura/i);
});

test('o corpo bruto do provedor NUNCA sai: nem texto, nem sentinela, nem hash do corpo, nem caminhos do disco', async () => {
  const base = tmpDir();
  await writeFull(base);
  const reader = createEvidenceReader({ baseDir: base, authorize: allow });
  const everything = JSON.stringify({ list: await reader.listAudits(OPERATOR), view: await reader.getAudit(OPERATOR, AUDIT), versions: await reader.listVersions(OPERATOR, AUDIT) });
  assert.ok(!everything.includes(SENTINEL), 'conteúdo do corpo bruto vazou');
  assert.ok(!/bodyText|"places"|thumbnailUrl|foto-opaca|searchParameters/.test(everything), 'estrutura do corpo bruto vazou');
  assert.ok(!everything.includes(base) && !everything.includes('.capture.json'), 'caminhos do disco vazaram');
  assert.ok(!/x-api-key|authorization|cookie/i.test(everything));
});

test('histórico: capturas e revisões do relatório, com a anterior marcada como superada', async () => {
  const base = tmpDir();
  const full = await writeFull(base);
  await writeReport(base, AUDIT, 1, { ...(JSON.parse(JSON.stringify(full.report)) as Record<string, unknown>), nota: 'revisão 2' }, '2026-10-22T15:00:00.000Z');
  const reader = createEvidenceReader({ baseDir: base, authorize: allow });
  const versions = await reader.listVersions(OPERATOR, AUDIT);
  assert.equal(versions.length, 1);
  assert.deepEqual(versions[0]?.reportRevisions.map((r) => [r.revision, r.superseded]), [[1, true], [2, false]]);
  const r1 = await reader.getAudit(OPERATOR, AUDIT, { revision: 1 });
  const latest = await reader.getAudit(OPERATOR, AUDIT);
  assert.equal(r1?.selected.revision, 1);
  assert.equal(latest?.selected.revision, 2);
  assert.equal(await reader.getAudit(OPERATOR, AUDIT, { revision: 9 }), null);
  assert.equal(await reader.getAudit(OPERATOR, 'nao-existe-0001'), null);
});

test('alteração em disco aparece na visão como integridade comprometida; auditId perigoso é recusado', async () => {
  const base = tmpDir();
  await writeFull(base);
  const reader = createEvidenceReader({ baseDir: base, authorize: allow });
  const file = path.join(base, AUDIT, 'c0001.report-r0001.json');
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Padaria Exemplo', 'Padaria Trocada'));
  const list = await reader.listAudits(OPERATOR);
  assert.equal(list[0]?.state, 'CORRUPT');
  assert.equal(list[0]?.integrity.status, 'MISMATCH');
  assert.equal(await reader.getAudit(OPERATOR, AUDIT), null, 'uma visão não é montada a partir de arquivo adulterado');
  await assert.rejects(() => reader.getAudit(OPERATOR, '../fora'), /inválido/i);
  await assert.rejects(() => reader.listVersions(OPERATOR, 'a/b'), /inválido/i);
});

test('base sem auditorias ou inexistente: lista vazia, sem erro', async () => {
  const reader = createEvidenceReader({ baseDir: path.join(tmpDir(), 'nada'), authorize: allow });
  assert.deepEqual(await reader.listAudits(OPERATOR), []);
});

test('layout LEGADO (pasta plana com MANIFEST + SHA256SUMS): somente leitura, com a revisão anterior superada', async () => {
  const base = tmpDir();
  const from = tmpDir('lafrom-');
  const body = JSON.stringify({ searchParameters: { q: 'x' }, places: [{ title: 'Padaria Exemplo', cid: '1311768467294899695', fid: '0x94aa11bb22cc33dd:0x1234567890abcdef', placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', rating: 4.9, ratingCount: 12 }], credits: 3 });
  const stdout = ['{ "identity": { "snapshotId": "audit-20261022000000", "confirmedAt": "2026-10-22T12:54:45.249Z" },', '  "found": { "googleMaps": { "queriedAt": "2026-10-22T12:54:48.079Z" } } }'].join('\n');
  for (const [name, content] of Object.entries({ 'serper-body.json': body, 'serper-status.json': '{"attempts":1,"status":200,"ok":true}', 'serper-attempts.json': '{"attempts":1,"at":"2026-10-22T12:54:45.404Z"}', 'summary.json': '{"exitCode":0,"serperAttempts":1,"siteHttpRequests":0}', 'run-stdout.txt': stdout, 'run-stderr.txt': '' })) fs.writeFileSync(path.join(from, name), content);
  const legacyDir = path.join(base, AUDIT);
  assert.ok(persistCapture({ from, to: legacyDir, now: clock }).ok);
  const first = await generateReport({ dir: legacyDir, link: LINK, operator: 'ana@empresa.com', name: 'Padaria Exemplo', now: clock });
  assert.ok(first.ok);
  fs.renameSync(path.join(legacyDir, 'report.json'), path.join(legacyDir, 'report.v1-superseded.json'));
  fs.renameSync(path.join(legacyDir, 'report.json.sha256'), path.join(legacyDir, 'report.v1-superseded.json.sha256'));
  assert.ok((await generateReport({ dir: legacyDir, link: LINK, operator: 'ana@empresa.com', name: 'Padaria Exemplo', now: clock })).ok);

  const hashesBefore = fs.readdirSync(legacyDir).sort().map((n) => `${n}:${fs.statSync(path.join(legacyDir, n)).size}:${fs.statSync(path.join(legacyDir, n)).mtimeMs}`);
  const reader = createEvidenceReader({ baseDir: base, authorize: allow });
  const list = await reader.listAudits(OPERATOR);
  assert.deepEqual([list[0]?.layout, list[0]?.state, list[0]?.confirmedCid], ['LEGACY', 'LEGACY', '1311768467294899695']);
  const view = await reader.getAudit(OPERATOR, AUDIT);
  assert.ok(view);
  assert.equal(view.layout, 'LEGACY');
  assert.equal(view.integrity.status, 'OK');
  assert.equal(view.methodologyVersion, 'lumos-reconstruida-v1');
  const versions = await reader.listVersions(OPERATOR, AUDIT);
  assert.deepEqual(versions[0]?.reportRevisions.map((r) => [r.revision, r.superseded]), [[1, true], [2, false]]);
  assert.ok(!JSON.stringify(view).includes('"places"'));
  assert.deepEqual(fs.readdirSync(legacyDir).sort().map((n) => `${n}:${fs.statSync(path.join(legacyDir, n)).size}:${fs.statSync(path.join(legacyDir, n)).mtimeMs}`), hashesBefore, 'a leitura não modificou nada');
});

test('revisão 5A: métodos funcionam desestruturados; índice público só exporta o leitor; pasta de auditoria symlink é recusada', async () => {
  const base = tmpDir();
  await writeFull(base);
  const { getAudit, listVersions, listAudits } = createEvidenceReader({ baseDir: base, authorize: allow });
  assert.ok(await getAudit(OPERATOR, AUDIT));
  assert.equal((await listVersions(OPERATOR, AUDIT)).length, 1);
  assert.equal((await listAudits(OPERATOR)).length, 1);
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'link-audit-evidence', 'index.ts'), 'utf8');
  assert.ok(!/from '\.\/(store|secrets)'/.test(index) && !/export\s+\*/.test(index), 'o índice não reexporta o armazenamento (que lê o corpo bruto) nem usa export *');
  assert.deepEqual([...index.matchAll(/export \{([^}]*)\} from '\.\/types'/g)].map((m) => m[1]?.trim()), ['AUDIT_ID_PATTERN'], 'de types.ts só a constante do identificador');
  assert.match(index, /createEvidenceReader/);
  fs.symlinkSync(path.join(base, AUDIT), path.join(base, 'alias-da-auditoria-1'));
  assert.equal(await createEvidenceReader({ baseDir: base, authorize: allow }).getAudit(OPERATOR, 'alias-da-auditoria-1'), null, 'symlink = não encontrada (nunca exceção que derrube a rota)');
  assert.deepEqual(await createEvidenceReader({ baseDir: base, authorize: allow }).listVersions(OPERATOR, 'alias-da-auditoria-1'), []);
  assert.equal((await createEvidenceReader({ baseDir: base, authorize: allow }).listAudits(OPERATOR)).some((a) => a.auditId === 'alias-da-auditoria-1'), false);
});

test('revisão 5A: relatório legado SEM hash declarado não conta como íntegro', async () => {
  const base = tmpDir();
  const from = tmpDir('lafrom-');
  for (const [name, content] of Object.entries({ 'serper-body.json': JSON.stringify({ places: [], credits: 3 }), 'serper-status.json': '{"attempts":1,"status":200,"ok":true}', 'serper-attempts.json': '{"attempts":1,"at":"2026-10-22T12:54:45.404Z"}', 'summary.json': '{"exitCode":0,"serperAttempts":1,"siteHttpRequests":0}', 'run-stdout.txt': '{ "identity": { "snapshotId": "audit-20261022000000", "confirmedAt": "2026-10-22T12:54:45.249Z" }, "found": { "googleMaps": { "queriedAt": "2026-10-22T12:54:48.079Z" } } }', 'run-stderr.txt': '' })) fs.writeFileSync(path.join(from, name), content);
  const dir = path.join(base, AUDIT);
  assert.ok(persistCapture({ from, to: dir, now: clock }).ok);
  assert.ok((await generateReport({ dir, link: LINK, operator: 'ana@empresa.com', name: 'Padaria Exemplo', now: clock })).ok);
  const reader = createEvidenceReader({ baseDir: base, authorize: allow });
  assert.equal((await reader.listAudits(OPERATOR))[0]?.integrity.status, 'OK');
  fs.rmSync(path.join(dir, 'report.json.sha256'));
  const after = (await reader.listAudits(OPERATOR))[0];
  assert.equal(after?.integrity.status, 'MISMATCH');
  assert.match(after?.integrity.issues.join(' ') ?? '', /não tem hash declarado/);
});
