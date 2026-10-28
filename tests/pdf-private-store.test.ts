import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolvePdfWithFallbacks } from '../src/lib/pdf/download-chain';
import { downloadPrivatePdf, privateBucketName, privateObjectKey, uploadPrivatePdf } from '../src/lib/pdf/private-store';
import { allowedPdfRoots, pdfReadCandidates } from '../src/lib/pdf/serve';
import type { DiagrammerOutput } from '../src/types/gmn';

const ID = '859b4021-404e-40fc-acba-da21e1fd4746';
const NAME = 'auditoria-gmn-teste-859b4021.pdf';
const PDF = Buffer.from('%PDF-1.4 conteúdo de teste');
const diagrammer = (stored: string): DiagrammerOutput => ({
  auditId: ID, pdfFileName: NAME, pdfStoragePath: stored, pdfDownloadUrl: '', pageCount: 1, fileSizeBytes: PDF.length, generatedAt: '2026-10-16T00:00:00Z',
});

/** Supabase falso em memória (somente o que o armazenamento privado usa). */
function fakeSupabase(objects: Map<string, Buffer>) {
  const calls: string[] = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        download: async (key: string) => {
          calls.push(`download:${bucket}:${key}`);
          const body = objects.get(`${bucket}/${key}`);
          return body ? { data: new Blob([new Uint8Array(body)]), error: null } : { data: null, error: { message: 'Object not found' } };
        },
        upload: async (key: string, body: Buffer, options: { upsert?: boolean }) => {
          calls.push(`upload:${bucket}:${key}:upsert=${options.upsert}`);
          if (objects.has(`${bucket}/${key}`) && !options.upsert) return { error: { message: 'The resource already exists' } };
          objects.set(`${bucket}/${key}`, body);
          return { error: null };
        },
      }),
    },
  };
  return { client: client as never, calls };
}

test('armazenamento privado: chave validada, upload sem sobrescrever e download só de PDF', async () => {
  assert.equal(privateObjectKey(ID, NAME), `audits/${ID}/${NAME}`);
  assert.throws(() => privateObjectKey('../x', NAME));
  assert.throws(() => privateObjectKey(ID, '../segredo.pdf'));
  assert.throws(() => privateObjectKey(ID, 'a.txt'));
  assert.equal(privateBucketName({}), null);
  assert.equal(privateBucketName({ SUPABASE_PRIVATE_AUDIT_BUCKET: ' priv ' }), 'priv');

  const objects = new Map<string, Buffer>();
  const { client, calls } = fakeSupabase(objects);
  assert.equal(await uploadPrivatePdf(client, 'priv', ID, NAME, PDF), 'uploaded');
  assert.equal(await uploadPrivatePdf(client, 'priv', ID, NAME, Buffer.from('%PDF-outro')), 'exists');
  assert.deepEqual(objects.get(`priv/audits/${ID}/${NAME}`), PDF, 'o objeto existente não foi sobrescrito');
  assert.ok(calls.every((call) => call.endsWith('upsert=false') || call.startsWith('download')));

  assert.deepEqual(await downloadPrivatePdf(client, 'priv', ID, NAME), PDF);
  assert.equal(await downloadPrivatePdf(client, 'priv', ID, 'nao-existe.pdf'), null);
  assert.equal(await downloadPrivatePdf(client, null, ID, NAME), null, 'sem bucket privado configurado nada é consultado');
  assert.equal(await downloadPrivatePdf(client, 'priv', 'id-ruim', NAME), null);
  objects.set(`priv/audits/${ID}/lixo.pdf`, Buffer.from('<html>não é pdf</html>'));
  assert.equal(await downloadPrivatePdf(client, 'priv', ID, 'lixo.pdf'), null, 'conteúdo que não é PDF é recusado');
});

test('leitura: a pasta privada vem antes de public/audits (cópia migrada passa a ser a servida)', async () => {
  const roots = allowedPdfRoots('/app', {});
  assert.deepEqual(roots, ['/app/.data/audits', '/app/public/audits']);
  assert.deepEqual(allowedPdfRoots('/app', { GMN_PDF_OUTPUT_DIR: '/dados/pdfs' })[0], '/dados/pdfs');
  assert.deepEqual(pdfReadCandidates('D:\\proj\\public\\audits\\a.pdf', roots), ['/app/.data/audits/a.pdf', '/app/public/audits/a.pdf']);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-chain-'));
  const priv = path.join(dir, 'privada');
  const pub = path.join(dir, 'publica');
  await fs.mkdir(priv); await fs.mkdir(pub);
  await fs.writeFile(path.join(pub, NAME), Buffer.from('%PDF-publico'));
  await fs.writeFile(path.join(priv, NAME), Buffer.from('%PDF-privado'));
  const result = await resolvePdfWithFallbacks(ID, diagrammer(`D:\\x\\public\\audits\\${NAME}`), { supabase: null, bucket: null, roots: [priv, pub], regenerate: async () => null });
  assert.equal(result.status === 200 && result.source, 'local');
  assert.equal(result.status === 200 && result.body.toString(), '%PDF-privado');
});

test('cadeia de leitura: local → bucket privado → recomposição → 404, sem nunca usar URL pública', async () => {
  const roots = [path.join(os.tmpdir(), 'gmn-pasta-vazia-inexistente')];
  const objects = new Map<string, Buffer>([[`priv/audits/${ID}/${NAME}`, PDF]]);
  const { client } = fakeSupabase(objects);
  let regenerated = 0;
  const regenerate = async () => { regenerated++; return { body: Buffer.from('%PDF-recomposto') as Buffer<ArrayBuffer>, headers: { 'X-GMN-PDF-Regenerated': 'true' } }; };

  const fromBucket = await resolvePdfWithFallbacks(ID, diagrammer(`/x/${NAME}`), { supabase: client, bucket: 'priv', roots, regenerate });
  assert.equal(fromBucket.status === 200 && fromBucket.source, 'private-bucket');
  assert.equal(regenerated, 0, 'a cópia do bucket tem prioridade sobre recompor');

  const rebuilt = await resolvePdfWithFallbacks(ID, diagrammer(`/x/${NAME}`), { supabase: client, bucket: null, roots, regenerate });
  assert.equal(rebuilt.status === 200 && rebuilt.source, 'regenerated');
  assert.equal(regenerated, 1);

  const missing = await resolvePdfWithFallbacks(ID, diagrammer(`/x/${NAME}`), { supabase: null, bucket: null, roots, regenerate: async () => null });
  assert.equal(missing.status, 404);
  const unfinished = await resolvePdfWithFallbacks(ID, undefined, { supabase: client, bucket: 'priv', roots, regenerate });
  assert.equal(unfinished.status, 404);
  assert.equal(regenerated, 1, 'auditoria sem PDF finalizado não dispara recomposição');
});
