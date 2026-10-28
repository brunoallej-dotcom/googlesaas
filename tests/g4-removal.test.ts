import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runBackup, sha256, type AuditPointerRow, type DatabasePort, type StoragePort, buildInventory } from '../src/lib/pdf/migration';
import { executePublicRemoval, parseExternalHashes, planPublicRemoval, verifyExternalBackup, type ExternalHash } from '../src/lib/pdf/public-removal';

const A = '4323da26-b73c-417e-9306-f4330d335bcd';
const B = '859b4021-404e-40fc-acba-da21e1fd4746';
const NAME_A = 'auditoria-gmn-a-4323da26.pdf';
const NAME_B = 'auditoria-gmn-b-859b4021.pdf';
const PDF_A = Buffer.from('%PDF-a');
const PDF_B = Buffer.from('%PDF-b-oficial');
const OLD_B = Buffer.from('%PDF-b-antigo');

function storage(buckets: Record<string, Record<string, Buffer>>): StoragePort & { calls: string[] } {
  const calls: string[] = [];
  const data = new Map(Object.entries(buckets).map(([name, objects]) => [name, new Map(Object.entries(objects))]));
  return {
    calls,
    listObjects: async (bucket) => [...(data.get(bucket)?.keys() ?? [])].map((key) => ({ key, size: null })),
    download: async (bucket, key) => data.get(bucket)?.get(key) ?? null,
    upload: async () => { calls.push('upload'); return 'uploaded'; },
    getBucket: async (bucket) => (data.has(bucket) ? { public: bucket === 'antigo' } : null),
    createPrivateBucket: async () => { calls.push('create'); },
    setBucketPublic: async () => { calls.push('setpublic'); },
    headPublic: async () => 400,
  };
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-g4-'));
  const publicDir = path.join(root, 'public-audits');
  const privateDir = path.join(root, 'private');
  const backupDir = path.join(root, 'backup');
  await fs.mkdir(publicDir); await fs.mkdir(privateDir); await fs.mkdir(backupDir);
  for (const [name, bytes] of [[NAME_A, PDF_A], [NAME_B, PDF_B]] as const) {
    await fs.writeFile(path.join(publicDir, name), bytes);
    await fs.writeFile(path.join(privateDir, name), bytes);
  }
  const st = storage({
    antigo: { [`audits/${A}/${NAME_A}`]: PDF_A, [`audits/${B}/${NAME_B}`]: OLD_B },
    privado: { [`audits/${A}/${NAME_A}`]: PDF_A, [`audits/${B}/${NAME_B}`]: PDF_B },
  });
  const rows: AuditPointerRow[] = [
    { id: A, pdf_storage_path: `x/${NAME_A}`, pdf_download_url: '/api/audit/a/pdf', diagrammer_payload: { pdfFileName: NAME_A } },
    { id: B, pdf_storage_path: `x/${NAME_B}`, pdf_download_url: '/api/audit/b/pdf', diagrammer_payload: { pdfFileName: NAME_B } },
  ];
  const database: DatabasePort = { listAuditsWithPdf: async () => rows, updatePointers: async () => { throw new Error('o G4 nunca escreve no banco'); } };
  const inventory = await buildInventory({ storage: st, database, sourceBucket: 'antigo', publicDir });
  const manifest = await runBackup({ storage: st, database, inventory, backupDir });
  const external: ExternalHash[] = manifest.files.map((f) => ({ sha256: f.sha256, size: f.size, relativePath: f.backupPath }));
  return { root, publicDir, privateDir, backupDir, st, manifest, external };
}

const plan = (s: Awaited<ReturnType<typeof setup>>, overrides: Partial<Parameters<typeof planPublicRemoval>[0]> = {}) =>
  planPublicRemoval({ manifest: s.manifest, backupDir: s.backupDir, publicDir: s.publicDir, privateDir: s.privateDir, storage: s.st, privateBucket: 'privado', externalHashes: s.external, ...overrides });

test('plano: só os arquivos do manifesto, confirmados em 5 fontes; inventário exato e arquivos fora do manifesto intocados', async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.publicDir, 'outro-arquivo-nao-listado.pdf'), 'x');
  const result = await plan(s);
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.deepEqual(result.targets.map((t) => t.fileName).sort(), [NAME_A, NAME_B].sort());
  assert.deepEqual(result.untouched, ['outro-arquivo-nao-listado.pdf']);
  const b = result.targets.find((t) => t.fileName === NAME_B)!;
  assert.equal(b.sha256, sha256(PDF_B));
  assert.deepEqual(b.confirmedIn, ['public/audits', 'manifesto', '.data/audits', 'bucket privado privado', 'backup local', 'backup externo']);
});

test('remoção: apaga SÓ os alvos, um por vez; mantém pasta, backups, .data/audits, outros arquivos e objetos dos buckets', async () => {
  const s = await setup();
  await fs.writeFile(path.join(s.publicDir, 'outro-arquivo-nao-listado.pdf'), 'x');
  const order: string[] = [];
  const logged: string[] = [];
  const result = await executePublicRemoval(await plan(s), {
    unlink: async (file) => { order.push(path.basename(file)); await fs.unlink(file); },
    beforeStart: async (p) => { logged.push(`log com ${p.targets.length} alvo(s)`); assert.equal((await fs.readdir(s.publicDir)).length, 3, 'o inventário é gravado ANTES de excluir'); },
  });
  assert.deepEqual([result.failed, result.removed.length], [null, 2]);
  assert.equal(order.length, 2);
  assert.deepEqual(await fs.readdir(s.publicDir), ['outro-arquivo-nao-listado.pdf']);
  assert.deepEqual((await fs.readdir(s.privateDir)).sort(), [NAME_A, NAME_B].sort());
  assert.equal((await fs.readFile(path.join(s.privateDir, NAME_B))).toString(), PDF_B.toString());
  assert.equal((await fs.readFile(path.join(s.backupDir, 'public-audits', NAME_B))).toString(), PDF_B.toString());
  assert.deepEqual(s.st.calls, [], 'nenhum upload, criação ou mudança de visibilidade');
  assert.ok(logged.length === 1);
  // execução repetida: nada a fazer, sem erro
  const again = await plan(s);
  assert.deepEqual(again.alreadyRemoved.sort(), [NAME_A, NAME_B].sort());
  assert.deepEqual(again.targets, []);
});

test('pré-condições: qualquer falha reprova o plano e nada é removido', async () => {
  // SHA diferente no público
  let s = await setup();
  await fs.writeFile(path.join(s.publicDir, NAME_B), 'adulterado');
  let p = await plan(s);
  assert.equal(p.ok, false);
  assert.match(p.problems.join(' '), /difere do manifesto/);
  await assert.rejects(() => executePublicRemoval(p), /reprovado/);
  assert.equal((await fs.readdir(s.publicDir)).length, 2);

  // cópia ausente em .data/audits
  s = await setup();
  await fs.rm(path.join(s.privateDir, NAME_A));
  assert.match((await plan(s)).problems.join(' '), /cópia ausente em \.data\/audits/);

  // objeto ausente no bucket privado
  s = await setup();
  assert.match((await plan(s, { privateBucket: 'inexistente' })).problems.join(' '), /cópia ausente em bucket privado/);

  // backup local adulterado
  s = await setup();
  await fs.writeFile(path.join(s.backupDir, 'public-audits', NAME_A), 'x');
  assert.match((await plan(s)).problems.join(' '), /backup local/);

  // cópia externa incompleta / com hash diferente / vazia
  s = await setup();
  assert.match((await plan(s, { externalHashes: s.external.slice(1) })).problems.join(' '), /cópia externa sem o arquivo/);
  assert.match((await plan(s, { externalHashes: s.external.map((h, i) => (i === 0 ? { ...h, sha256: 'a'.repeat(64) } : h)) })).problems.join(' '), /cópia externa diferente do manifesto/);
  assert.match((await plan(s, { externalHashes: [] })).problems.join(' '), /nenhum hash da cópia externa/);
});

test('segurança do caminho: nome fora do padrão e link simbólico são recusados', async () => {
  const s = await setup();
  const evil = structuredClone(s.manifest) as unknown as { inventory: { items: { fileName: string }[] } };
  evil.inventory.items[0]!.fileName = '../../etc/passwd';
  assert.match((await plan(s, { manifest: evil as never })).problems.join(' '), /fora do padrão seguro/);

  await fs.rm(path.join(s.publicDir, NAME_A));
  await fs.symlink(path.join(s.privateDir, NAME_A), path.join(s.publicDir, NAME_A));
  const link = await plan(s);
  assert.match(link.problems.join(' '), /não é um arquivo regular/);
  assert.ok((await fs.lstat(path.join(s.privateDir, NAME_A))).isFile(), 'o destino do link não foi tocado');
});

test('execução: para na primeira falha e não apaga se o conteúdo mudou depois do plano', async () => {
  const s = await setup();
  const p = await plan(s);
  await fs.writeFile(path.join(s.publicDir, p.targets[0]!.fileName), 'mudou depois do plano');
  const result = await executePublicRemoval(p);
  assert.match(result.failed ?? '', /o conteúdo mudou depois do plano/);
  assert.deepEqual(result.removed, []);
  assert.equal((await fs.readdir(s.publicDir)).length, 2, 'nada foi removido');

  const s2 = await setup();
  const p2 = await plan(s2);
  const result2 = await executePublicRemoval(p2, { unlink: async () => { throw new Error('EBUSY'); } });
  assert.match(result2.failed ?? '', /EBUSY/);
  assert.equal(result2.removed.length, 0);
});

test('hashes da cópia externa: leitura do formato e verificação contra o manifesto', async () => {
  const s = await setup();
  const text = s.external.map((h) => `${h.sha256} ${h.size} ${h.relativePath.replace(/\//g, '\\')}`).join('\r\n') + '\r\nlinha inválida\r\n';
  const parsed = parseExternalHashes(text);
  assert.equal(parsed.length, s.external.length);
  assert.deepEqual(verifyExternalBackup(s.manifest, parsed), { ok: true, problems: [] });
});
