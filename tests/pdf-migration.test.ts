import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyCopy, applyPointers, assertPermanentRouteUrl, planPointerChanges, buildInventory, closePublicBucket, planCopy, rollback, runBackup, sha256, verifyCopies,
  type AuditPointerRow, type DatabasePort, type StoragePort,
} from '../src/lib/pdf/migration';

const A = '4323da26-b73c-417e-9306-f4330d335bcd'; // mesmo conteúdo local e no bucket
const B = '859b4021-404e-40fc-acba-da21e1fd4746'; // versões diferentes
const NAME_A = 'auditoria-gmn-a-4323da26.pdf';
const NAME_B = 'auditoria-gmn-b-859b4021.pdf';
const SAME = Buffer.from('%PDF-igual');
const OFFICIAL_B = Buffer.from('%PDF-oficial-com-mapa');
const OLD_B = Buffer.from('%PDF-versao-antiga-3p');

function fakeStorage(initial: Record<string, Record<string, Buffer>>, publicBuckets: Set<string>) {
  const buckets = new Map(Object.entries(initial).map(([name, objects]) => [name, new Map(Object.entries(objects))]));
  const log: string[] = [];
  const port: StoragePort = {
    listObjects: async (bucket) => [...(buckets.get(bucket)?.entries() ?? [])].map(([key, body]) => ({ key, size: body.byteLength })),
    download: async (bucket, key) => buckets.get(bucket)?.get(key) ?? null,
    upload: async (bucket, key, body) => {
      log.push(`upload ${bucket}/${key}`);
      const store = buckets.get(bucket);
      if (!store) return { error: 'Bucket not found' };
      if (store.has(key)) return 'exists';
      store.set(key, body);
      return 'uploaded';
    },
    getBucket: async (bucket) => (buckets.has(bucket) ? { public: publicBuckets.has(bucket) } : null),
    createPrivateBucket: async (bucket) => { log.push(`create-private ${bucket}`); buckets.set(bucket, new Map()); },
    setBucketPublic: async (bucket, isPublic) => { log.push(`set-public ${bucket}=${isPublic}`); if (isPublic) publicBuckets.add(bucket); else publicBuckets.delete(bucket); },
    headPublic: async (bucket, key) => (publicBuckets.has(bucket) && buckets.get(bucket)?.has(key) ? 200 : 400),
  };
  return { port, buckets, log, publicBuckets };
}

function fakeDatabase(rows: AuditPointerRow[], options: { failOnCall?: number } = {}) {
  const updates: string[] = [];
  let calls = 0;
  const port: DatabasePort = {
    listAuditsWithPdf: async () => rows.map((r) => structuredClone(r)),
    updatePointers: async (id, values, expected) => {
      calls++;
      if (options.failOnCall === calls) throw new Error('falha simulada do banco');
      const row = rows.find((r) => r.id === id);
      // UPDATE condicional (compare-and-set): sem linha ou valores diferentes do esperado, nada é alterado
      if (!row || (expected && (row.pdf_download_url !== expected.pdf_download_url || row.pdf_storage_path !== expected.pdf_storage_path))) return false;
      updates.push(id);
      Object.assign(row, { pdf_storage_path: values.pdf_storage_path, pdf_download_url: values.pdf_download_url, diagrammer_payload: values.diagrammer_payload });
      return true;
    },
  };
  return { port, rows, updates };
}

async function scenario() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-mig-'));
  const publicDir = path.join(root, 'public-audits');
  const privateDir = path.join(root, 'private');
  const backupDir = path.join(root, 'backup');
  await fs.mkdir(publicDir); await fs.mkdir(backupDir);
  await fs.writeFile(path.join(publicDir, NAME_A), SAME);
  await fs.writeFile(path.join(publicDir, NAME_B), OFFICIAL_B);
  const storage = fakeStorage({ 'gmn-audit-pdfs': { [`audits/${A}/${NAME_A}`]: SAME, [`audits/${B}/${NAME_B}`]: OLD_B } }, new Set(['gmn-audit-pdfs']));
  const database = fakeDatabase([
    { id: A, pdf_storage_path: `D:\\proj\\public\\audits\\${NAME_A}`, pdf_download_url: `https://x.supabase.co/storage/v1/object/public/gmn-audit-pdfs/audits/${A}/${NAME_A}`, diagrammer_payload: { pdfFileName: NAME_A, pdfDownloadUrl: 'https://old/a', pdfStoragePath: `D:\\proj\\public\\audits\\${NAME_A}`, pageCount: 3 } },
    { id: B, pdf_storage_path: `D:\\proj\\public\\audits\\${NAME_B}`, pdf_download_url: `https://x.supabase.co/storage/v1/object/public/gmn-audit-pdfs/audits/${B}/${NAME_B}`, diagrammer_payload: { pdfFileName: NAME_B, pdfDownloadUrl: 'https://old/b', pdfStoragePath: `D:\\proj\\public\\audits\\${NAME_B}`, pageCount: 3 } },
  ]);
  const inventory = await buildInventory({ storage: storage.port, database: database.port, sourceBucket: 'gmn-audit-pdfs', publicDir, now: new Date('2026-10-16T12:00:00Z') });
  return { root, publicDir, privateDir, backupDir, storage, database, inventory };
}

test('inventário: acha exposição pública, compara hashes e aponta a versão divergente', async () => {
  const { inventory } = await scenario();
  assert.equal(inventory.sourceBucketPublic, true);
  assert.deepEqual(inventory.summary, { audits: 2, localFiles: 2, bucketObjects: 2, publiclyReachable: 2, divergent: 1, totalBytes: SAME.length * 2 + OFFICIAL_B.length + OLD_B.length });
  const a = inventory.items.find((i) => i.auditId === A)!;
  const b = inventory.items.find((i) => i.auditId === B)!;
  assert.equal(a.sameContent, true);
  assert.equal(b.sameContent, false);
  assert.equal(b.local?.sha256, sha256(OFFICIAL_B));
  assert.equal(b.bucket?.sha256, sha256(OLD_B));
  assert.equal(b.bucket?.publicHttpStatus, 200);
});

test('inventário e backup NÃO escrevem em produção; backup guarda hashes e o snapshot do banco', async () => {
  const { storage, database, inventory, backupDir, publicDir } = await scenario();
  const manifest = await runBackup({ storage: storage.port, database: database.port, inventory, backupDir });
  assert.deepEqual(storage.log, [], 'nenhum upload/criação/alteração no Storage');
  assert.deepEqual(database.updates, [], 'nenhuma escrita no banco');
  assert.equal(manifest.files.length, 4);
  assert.deepEqual(await fs.readFile(path.join(backupDir, 'public-audits', NAME_B)), OFFICIAL_B);
  assert.deepEqual(await fs.readFile(path.join(backupDir, 'bucket', `audits/${B}/${NAME_B}`)), OLD_B);
  assert.equal(manifest.databaseSnapshot.length, 2);
  assert.deepEqual(await fs.readFile(path.join(publicDir, NAME_B)), OFFICIAL_B, 'originais intactos');
  // o backup nunca sobrescreve um backup anterior
  await assert.rejects(() => runBackup({ storage: storage.port, database: database.port, inventory, backupDir }));
});

test('plano de cópia: preserva a versão antiga do bucket à parte quando difere da oficial', async () => {
  const { inventory } = await scenario();
  const operations = planCopy(inventory, 'privado', '/app/.data/audits');
  assert.deepEqual(operations.filter((o) => o.auditId === A).map((o) => o.kind), ['official-to-private-dir', 'official-to-private-bucket']);
  const forB = operations.filter((o) => o.auditId === B);
  assert.equal(forB.length, 3);
  assert.ok(forB.some((o) => o.kind === 'older-bucket-version-to-private-bucket' && o.target.endsWith(`/versao-anterior-do-bucket/${NAME_B}`)));
});

test('cópia: cria bucket privado, nunca sobrescreve, é idempotente e conferida por SHA-256', async () => {
  const { storage, inventory, backupDir, privateDir, database } = await scenario();
  const manifest = await runBackup({ storage: storage.port, database: database.port, inventory, backupDir });
  const first = await applyCopy({ storage: storage.port, inventory, manifest, privateBucket: 'privado', privateDir });
  assert.deepEqual([first.uploaded, first.existing, first.failures], [3, 0, []]);
  assert.ok(storage.log.includes('create-private privado'));
  assert.equal(storage.publicBuckets.has('privado'), false);
  assert.deepEqual(storage.buckets.get('privado')!.get(`audits/${B}/${NAME_B}`), OFFICIAL_B);
  assert.deepEqual(storage.buckets.get('privado')!.get(`audits/${B}/versao-anterior-do-bucket/${NAME_B}`), OLD_B);
  assert.deepEqual(await fs.readFile(path.join(privateDir, NAME_B)), OFFICIAL_B);
  assert.deepEqual((await verifyCopies({ storage: storage.port, inventory, privateBucket: 'privado', privateDir })).problems, []);

  const again = await applyCopy({ storage: storage.port, inventory, manifest, privateBucket: 'privado', privateDir });
  assert.deepEqual([again.uploaded, again.existing], [0, 3], 'segunda execução não duplica nem sobrescreve');
  assert.equal(storage.log.filter((l) => l.startsWith('upload')).length, 6);

  // bucket de destino público ou igual ao de origem é recusado
  await assert.rejects(() => applyCopy({ storage: storage.port, inventory, manifest, privateBucket: 'gmn-audit-pdfs', privateDir }), /não pode ser o bucket público de origem/);
  storage.buckets.set('outro-publico', new Map());
  storage.publicBuckets.add('outro-publico');
  await assert.rejects(() => applyCopy({ storage: storage.port, inventory, manifest, privateBucket: 'outro-publico', privateDir }), /PÚBLICO/);
});

test('fechar o bucket público: só muda a visibilidade, os links antigos falham e nada é apagado; rollback reabre', async () => {
  const { storage, inventory, backupDir, privateDir, database } = await scenario();
  const manifest = await runBackup({ storage: storage.port, database: database.port, inventory, backupDir });
  await applyCopy({ storage: storage.port, inventory, manifest, privateBucket: 'privado', privateDir });
  const before = storage.buckets.get('gmn-audit-pdfs')!.size;

  await closePublicBucket({ storage: storage.port, manifest, bucket: 'gmn-audit-pdfs' });
  assert.equal(await storage.port.headPublic('gmn-audit-pdfs', `audits/${A}/${NAME_A}`), 400, 'link antigo deixou de funcionar');
  assert.equal(storage.buckets.get('gmn-audit-pdfs')!.size, before, 'nenhum objeto foi apagado');

  // rollback de ponteiros NÃO reabre bucket; só o escopo buckets reabre
  assert.deepEqual((await rollback({ storage: storage.port, database: database.port, manifest, scope: 'pointers' })).bucketsReopened, []);
  assert.equal(await storage.port.headPublic('gmn-audit-pdfs', `audits/${A}/${NAME_A}`), 400, 'rollback de ponteiros não reabriu o bucket');
  const undone = await rollback({ storage: storage.port, database: database.port, manifest, scope: 'buckets' });
  assert.deepEqual(undone.bucketsReopened, ['gmn-audit-pdfs']);
  assert.equal(await storage.port.headPublic('gmn-audit-pdfs', `audits/${A}/${NAME_A}`), 200);
  assert.ok(!storage.log.some((l) => /delete|remove/i.test(l)));
});

test('ponteiros: atualiza só os campos de PDF para a rota autenticada e o rollback restaura os valores originais', async () => {
  const { storage, inventory, backupDir, privateDir, database } = await scenario();
  const original = structuredClone(database.rows);
  const manifest = await runBackup({ storage: storage.port, database: database.port, inventory, backupDir });
  assert.equal(await applyPointers({ database: database.port, manifest, privateDir }), 2);
  const row = database.rows.find((r) => r.id === B)!;
  assert.equal(row.pdf_download_url, `/api/audit/${B}/pdf`);
  assert.equal(row.pdf_storage_path, path.join(privateDir, NAME_B));
  assert.equal(row.diagrammer_payload?.pageCount, 3, 'demais campos do payload preservados');
  assert.doesNotMatch(String(row.diagrammer_payload?.pdfDownloadUrl), /supabase|old/);

  const result = await rollback({ storage: storage.port, database: database.port, manifest, scope: 'pointers' });
  assert.equal(result.pointersRestored, 2);
  assert.deepEqual(database.rows, original);
});

/* ------------------------- G1: pré-condições e verificações ------------------------- */
import {
  compareInventoryToManifest, loadAppliedState, preflightCopy, saveAppliedState, verifyBackup,
} from '../src/lib/pdf/migration';
import { diffSnapshots, takeMigrationSnapshot } from '../src/lib/pdf/migration-snapshot';
import { checkAnonymousDenied, checkBucketConfig } from '../src/lib/pdf/private-verify';

async function withBackup() {
  const s = await scenario();
  const manifest = await runBackup({ storage: s.storage.port, database: s.database.port, inventory: s.inventory, backupDir: s.backupDir });
  return { ...s, manifest };
}

test('verify-backup: confere hashes na pasta local e numa CÓPIA EXTERNA; detecta alteração, falta e arquivo extra', async () => {
  const { backupDir, root } = await withBackup();
  const ok = await verifyBackup(backupDir);
  assert.deepEqual([ok.ok, ok.checked, ok.problems], [true, 4, []]);

  // cópia externa idêntica (simula outro disco)
  const external = path.join(root, 'disco-externo');
  await fs.cp(backupDir, external, { recursive: true });
  assert.equal((await verifyBackup(external)).ok, true);

  // um byte alterado na cópia externa é detectado
  const target = path.join(external, 'public-audits', NAME_B);
  await fs.writeFile(target, Buffer.from('%PDF-adulterado'));
  const tampered = await verifyBackup(external);
  assert.equal(tampered.ok, false);
  assert.match(tampered.problems.join(' '), /conteúdo diferente do manifesto/);

  // arquivo ausente e arquivo extra
  await fs.rm(path.join(external, 'public-audits', NAME_A));
  await fs.writeFile(path.join(external, 'sobrando.txt'), 'x');
  const incomplete = await verifyBackup(external);
  assert.match(incomplete.problems.join(' '), /arquivo ausente/);
  assert.deepEqual(incomplete.extraFiles, ['sobrando.txt']);
  assert.equal((await verifyBackup(path.join(root, 'nao-existe'))).ok, false);
});

test('deriva do inventário: qualquer mudança desde o backup é detectada e impede a cópia', async () => {
  const { storage, database, inventory, manifest, publicDir, backupDir } = await withBackup();
  assert.deepEqual(compareInventoryToManifest(inventory, manifest), { ok: true, differences: [] });

  const pre = await preflightCopy({ storage: storage.port, database: database.port, backupDir, sourceBucket: 'gmn-audit-pdfs', privateBucket: 'privado', publicDir });
  assert.deepEqual([pre.ok, pre.problems], [true, []]);

  // 1) um PDF oficial mudou depois do backup
  await fs.writeFile(path.join(publicDir, NAME_B), Buffer.from('%PDF-mudou-depois'));
  const drift = await preflightCopy({ storage: storage.port, database: database.port, backupDir, sourceBucket: 'gmn-audit-pdfs', privateBucket: 'privado', publicDir });
  assert.equal(drift.ok, false);
  assert.match(drift.problems.join(' '), /SHA-256 de public\/audits mudou/);
  await fs.writeFile(path.join(publicDir, NAME_B), OFFICIAL_B);

  // 2) a visibilidade do bucket mudou
  storage.publicBuckets.delete('gmn-audit-pdfs');
  assert.match((await preflightCopy({ storage: storage.port, database: database.port, backupDir, sourceBucket: 'gmn-audit-pdfs', privateBucket: 'privado', publicDir })).problems.join(' '), /visibilidade do bucket mudou/);
  storage.publicBuckets.add('gmn-audit-pdfs');

  // 3) destino igual à origem ou público
  assert.match((await preflightCopy({ storage: storage.port, database: database.port, backupDir, sourceBucket: 'gmn-audit-pdfs', privateBucket: 'gmn-audit-pdfs', publicDir })).problems.join(' '), /não pode ser o bucket de origem/);
  storage.buckets.set('destino-publico', new Map());
  storage.publicBuckets.add('destino-publico');
  assert.match((await preflightCopy({ storage: storage.port, database: database.port, backupDir, sourceBucket: 'gmn-audit-pdfs', privateBucket: 'destino-publico', publicDir })).problems.join(' '), /PÚBLICO/);

  // 4) backup adulterado impede
  await fs.writeFile(path.join(backupDir, 'public-audits', NAME_A), Buffer.from('x'));
  assert.equal((await preflightCopy({ storage: storage.port, database: database.port, backupDir, sourceBucket: 'gmn-audit-pdfs', privateBucket: 'privado', publicDir })).ok, false);
});

test('o manifesto do backup é imutável: o estado aplicado vai para applied.json', async () => {
  const { storage, inventory, manifest, backupDir, privateDir } = await withBackup();
  const before = await fs.readFile(path.join(backupDir, 'manifest.json'));
  await applyCopy({ storage: storage.port, inventory, manifest, privateBucket: 'privado', privateDir });
  await saveAppliedState(backupDir, manifest.applied);
  assert.deepEqual(await fs.readFile(path.join(backupDir, 'manifest.json')), before, 'manifest.json intacto');
  const applied = await loadAppliedState(backupDir);
  assert.equal(applied.copied.length, 3);
  assert.deepEqual(applied.pointersUpdated, []);
  assert.deepEqual(applied.closedBuckets, []);
  assert.equal((await verifyBackup(backupDir)).ok, true, 'applied.json não conta como arquivo extra nem quebra a verificação');
});

test('verifyCopies exige também a versão anterior preservada do bucket', async () => {
  const { storage, inventory, manifest, privateDir } = await withBackup();
  await applyCopy({ storage: storage.port, inventory, manifest, privateBucket: 'privado', privateDir });
  assert.equal((await verifyCopies({ storage: storage.port, inventory, privateBucket: 'privado', privateDir })).ok, true);
  storage.buckets.get('privado')!.delete(`audits/${B}/versao-anterior-do-bucket/${NAME_B}`);
  const result = await verifyCopies({ storage: storage.port, inventory, privateBucket: 'privado', privateDir });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /versão anterior do bucket ausente/);
});

test('foto antes/depois: só o bucket privado e a pasta privada podem mudar; banco, public/audits, bucket antigo e .env.local não', async () => {
  const { storage, inventory, manifest, privateDir, publicDir, root } = await withBackup();
  const envFile = path.join(root, '.env.local');
  await fs.writeFile(envFile, 'A=1');
  const rows = [{ id: '1', updated_at: 'x' }];
  const snap = (privateBucket?: string) => takeMigrationSnapshot({ readTable: async () => rows, storage: storage.port, sourceBucket: 'gmn-audit-pdfs', publicDir, privateDir, envFile, ...(privateBucket ? { privateBucket } : {}) });
  const before = await snap();
  await applyCopy({ storage: storage.port, inventory, manifest, privateBucket: 'privado', privateDir });
  const after = await snap('privado');
  const ok = diffSnapshots(before, after, ['private-bucket/', 'private-dir/']);
  assert.deepEqual(ok.unexpected, []);
  assert.ok(ok.added.some((k) => k.startsWith('private-bucket/privado/audits/')));
  assert.ok(ok.added.some((k) => k.startsWith('private-dir/')));

  // mudanças indevidas são pegas: linha do banco, bucket antigo e .env.local
  rows[0]!.updated_at = 'y';
  storage.buckets.get('gmn-audit-pdfs')!.set(`audits/${A}/${NAME_A}`, Buffer.from('%PDF-outro'));
  await fs.writeFile(envFile, 'A=2');
  const bad = diffSnapshots(before, await snap('privado'), ['private-bucket/', 'private-dir/']);
  assert.ok(bad.unexpected.includes('env/.env.local'));
  assert.ok(bad.unexpected.includes('db/gmn_audits'));
  assert.ok(bad.unexpected.includes(`bucket-source/gmn-audit-pdfs/audits/${A}/${NAME_A}`));
});

test('acesso ao bucket novo: configuração privada e negação a anônimo, anon e token forjado', async () => {
  const { storage } = await withBackup();
  storage.buckets.set('privado', new Map());
  const config = await checkBucketConfig(storage.port, 'privado');
  assert.equal(config.find((c) => c.check.startsWith('bucket privado'))?.passed, true);
  assert.equal(config.find((c) => c.check.startsWith('somente application/pdf'))?.passed, false, 'o fake não define tipos: a verificação reprova');
  assert.equal((await checkBucketConfig(storage.port, 'inexistente'))[0]?.passed, false);

  const denied = (leak: boolean) => (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/object/list/')) return new Response(JSON.stringify(leak ? [{ name: 'x' }] : []), { status: 200 });
    if (url.endsWith('/storage/v1/bucket')) return new Response(JSON.stringify([]), { status: 200 });
    if (init?.method === 'HEAD') return new Response(null, { status: leak ? 200 : 400 });
    return new Response('{}', { status: 400 });
  }) as typeof fetch;
  const keys = [`audits/${A}/${NAME_A}`];
  const safe = await checkAnonymousDenied({ baseUrl: 'https://x.supabase.co', anonKey: 'ANON', bucket: 'privado', keys, fetchImpl: denied(false) });
  assert.ok(safe.every((c) => c.passed), JSON.stringify(safe.filter((c) => !c.passed)));
  const leaking = await checkAnonymousDenied({ baseUrl: 'https://x.supabase.co', anonKey: 'ANON', bucket: 'privado', keys, fetchImpl: denied(true) });
  assert.ok(leaking.filter((c) => !c.passed).length >= 4, 'vazamento por qualquer via reprova');
});

/* ------------------------------- G3: ponteiros do banco ------------------------------- */
import { checkAllowedChanges, diffRows, dumpRows, type RowsDump } from '../src/lib/pdf/migration-rows';

test('G3: só a rota relativa protegida é aceita como referência permanente (nunca URL pública ou assinada)', () => {
  assert.doesNotThrow(() => assertPermanentRouteUrl(B, `/api/audit/${B}/pdf`));
  for (const bad of [
    `https://x.supabase.co/storage/v1/object/public/gmn-audit-pdfs-private/audits/${B}/a.pdf`,
    `https://x.supabase.co/storage/v1/object/sign/privado/audits/${B}/a.pdf?token=abc`,
    `/api/audit/${B}/pdf?token=abc`,
    `/api/audit/${A}/pdf`, // id de outra auditoria
    `//evil.example/api/audit/${B}/pdf`,
    '',
  ]) assert.throws(() => assertPermanentRouteUrl(B, bad), /Referência recusada/, bad);
});

test('G3: valores novos preservam a versão oficial da 859b e as demais chaves do payload; nada aponta para a versão antiga', async () => {
  const { database, privateDir } = await scenario();
  const changes = planPointerChanges(await database.port.listAuditsWithPdf(), privateDir);
  const b = changes.find((c) => c.auditId === B)!;
  assert.equal(b.after.pdf_storage_path, path.join(privateDir, NAME_B), 'aponta o arquivo oficial na pasta privada');
  assert.doesNotMatch(b.after.pdf_storage_path, /versao-anterior/);
  assert.equal(b.after.pdf_download_url, `/api/audit/${B}/pdf`);
  assert.deepEqual(Object.keys(b.after.diagrammer_payload!).sort(), Object.keys(b.before.diagrammer_payload!).sort());
  for (const key of Object.keys(b.before.diagrammer_payload!)) {
    if (key === 'pdfDownloadUrl' || key === 'pdfStoragePath') continue;
    assert.deepEqual(b.after.diagrammer_payload![key], b.before.diagrammer_payload![key], key);
  }
});

test('G3: o UPDATE é condicional; linha que mudou desde o backup aborta SEM escrever nada', async () => {
  const { storage, inventory, backupDir, privateDir, database } = await scenario();
  const manifest = await runBackup({ storage: storage.port, database: database.port, inventory, backupDir });
  (database.rows.find((r) => r.id === B) as { pdf_download_url: string | null }).pdf_download_url = 'https://outro-valor/alguem-mudou';
  await assert.rejects(() => applyPointers({ database: database.port, manifest, privateDir }), /mudou desde o backup; nada foi escrito/);
  assert.deepEqual(database.updates, [], 'nenhuma escrita');
  assert.equal(database.rows.find((r) => r.id === A)!.pdf_download_url?.startsWith('https://'), true, 'a outra linha também ficou intacta');
});

test('G3: falha na 2ª linha restaura automaticamente a 1ª (compensação) e relata', async () => {
  const { storage, inventory, backupDir, privateDir } = await scenario();
  const fresh = fakeDatabase([
    { id: A, pdf_storage_path: `D:\\proj\\public\\audits\\${NAME_A}`, pdf_download_url: 'https://x/a', diagrammer_payload: { pdfFileName: NAME_A, pdfDownloadUrl: 'https://x/a', pdfStoragePath: 'p', pageCount: 3 } },
    { id: B, pdf_storage_path: `D:\\proj\\public\\audits\\${NAME_B}`, pdf_download_url: 'https://x/b', diagrammer_payload: { pdfFileName: NAME_B, pdfDownloadUrl: 'https://x/b', pdfStoragePath: 'p', pageCount: 3 } },
  ], { failOnCall: 2 });
  const original = structuredClone(fresh.rows);
  const manifest = await runBackup({ storage: storage.port, database: fresh.port, inventory, backupDir });
  await assert.rejects(() => applyPointers({ database: fresh.port, manifest, privateDir }), /G3 revertido automaticamente \(1 linha\(s\) restauradas\)/);
  assert.deepEqual(fresh.rows, original, 'banco volta exatamente ao estado original');
  assert.deepEqual(manifest.applied.pointersUpdated, []);
});

test('G3: execução repetida é idempotente (linhas já no valor final são puladas)', async () => {
  const { storage, inventory, backupDir, privateDir, database } = await scenario();
  const manifest = await runBackup({ storage: storage.port, database: database.port, inventory, backupDir });
  assert.equal(await applyPointers({ database: database.port, manifest, privateDir }), 2);
  assert.equal(await applyPointers({ database: database.port, manifest, privateDir }), 0);
});

const dump = (audits: Record<string, Record<string, unknown>>, others: Record<string, Record<string, Record<string, unknown>>> = {}): RowsDump => ({ takenAt: 't', tables: { gmn_audits: audits, gmn_leads: { l1: { id: 'l1', business_name: 'X' } }, ...others } });

test('comparação campo a campo: aceita só as colunas/linhas previstas e acusa qualquer outra mudança', async () => {
  type Rows = Record<string, Record<string, unknown>>;
  const base: Rows = { [A]: { id: A, status: 'COMPLETED', pdf_download_url: 'old', pdf_storage_path: 'p', updated_at: '1', diagrammer_payload: { pageCount: 3, pdfDownloadUrl: 'old', pdfStoragePath: 'p' }, judge_payload: { overallScore: 65.1 } }, [B]: { id: B, status: 'COMPLETED', pdf_download_url: 'old', pdf_storage_path: 'p', updated_at: '1', diagrammer_payload: { pageCount: 3, pdfDownloadUrl: 'old', pdfStoragePath: 'p' }, judge_payload: {} }, other: { id: 'other', status: 'FAILED', pdf_download_url: null } };
  const before = dump(base);
  const good: Rows = structuredClone(base);
  for (const id of [A, B]) Object.assign(good[id]!, { pdf_download_url: `/api/audit/${id}/pdf`, pdf_storage_path: 'q', updated_at: '2', diagrammer_payload: { pageCount: 3, pdfDownloadUrl: `/api/audit/${id}/pdf`, pdfStoragePath: 'q' } });
  const ok = checkAllowedChanges(diffRows(before, dump(good)), [A, B], ['pdf_download_url', 'pdf_storage_path', 'diagrammer_payload', 'updated_at'], ['pdfDownloadUrl', 'pdfStoragePath']);
  assert.deepEqual(ok, { ok: true, violations: [] });

  const run = (mutate: (rows: Rows) => void, others?: Record<string, Record<string, Record<string, unknown>>>) => {
    const copy = structuredClone(good); mutate(copy);
    return checkAllowedChanges(diffRows(before, dump(copy, others)), [A, B], ['pdf_download_url', 'pdf_storage_path', 'diagrammer_payload', 'updated_at'], ['pdfDownloadUrl', 'pdfStoragePath']).violations.join(' | ');
  };
  assert.match(run((r) => { r[A]!.judge_payload = { overallScore: 1 }; }), /coluna fora do escopo: gmn_audits\/.*judge_payload/);
  assert.match(run((r) => { (r[A]!.diagrammer_payload as Record<string, unknown>).pageCount = 12; }), /chave do payload fora do escopo.*pageCount/);
  assert.match(run((r) => { r.other!.pdf_download_url = '/x'; }), /linha alterada fora do escopo: gmn_audits\/other/);
  assert.match(run(() => undefined, { gmn_leads: { l1: { id: 'l1', business_name: 'ALTERADO' } } }), /gmn_leads\/l1/);
  assert.match(run((r) => { r['novo'] = { id: 'novo' }; }), /linha nova/);
  assert.match(run((r) => { delete (r as Record<string, unknown>)[B]; }), /linha removida/);
  assert.match(run((r) => { r[B]!.pdf_download_url = 'old'; r[B]!.pdf_storage_path = 'p'; r[B]!.updated_at = '1'; r[B]!.diagrammer_payload = { pageCount: 3, pdfDownloadUrl: 'old', pdfStoragePath: 'p' }; }), /linha prevista não foi alterada/);
  const dumped = await dumpRows(async (t) => (t === 'gmn_audits' ? [{ id: 'z', a: 1 }] : []));
  assert.deepEqual(Object.keys(dumped.tables).sort(), ['gmn_audits', 'gmn_battlefield_points', 'gmn_battlefield_rounds', 'gmn_leads', 'prospecting_campaigns']);
});
