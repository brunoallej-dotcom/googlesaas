import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { MAX_PDF_BYTES, PdfReadRejectedError, readRegularPdf, resolvePdfDownload } from '../src/lib/pdf/serve';
import type { DiagrammerOutput } from '../src/types/gmn';

const PDF_BYTES = Buffer.from('%PDF-1.4\n%fake\n%%EOF\n');
const HANG_GUARD_MS = 3000;

function diagrammerFor(file: string): DiagrammerOutput {
  return {
    auditId: 'fifo-test',
    pdfFileName: 'a.pdf',
    pdfStoragePath: file,
    pdfDownloadUrl: '',
    pageCount: 1,
    fileSizeBytes: PDF_BYTES.length,
    generatedAt: '2026-11-07T12:00:00.000Z',
  };
}

/** Falha o teste (em vez de travar a suíte) se a operação não terminar: é exatamente o sintoma do FIFO. */
async function withinGuard<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: a leitura travou (FIFO sem escritor?)`)), HANG_GUARD_MS);
    timer.unref();
  });
  try {
    return await Promise.race([operation, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const createdRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gmn-pdf-special-'));
  createdRoots.push(root);
  return root;
}

// FIFOs e links simbólicos criados aqui não podem sobrar em /tmp.
after(async () => {
  await Promise.all(createdRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

const SUPPORTS_FIFO = process.platform !== 'win32';

test('FIFO com nome .pdf na pasta permitida: 404 sem travar (regressão do bloqueio em fs.readFile)', { skip: !SUPPORTS_FIFO }, async () => {
  const root = await makeRoot();
  const fifo = path.join(root, 'a.pdf');
  execFileSync('mkfifo', [fifo]);
  const result = await withinGuard(resolvePdfDownload(diagrammerFor(fifo), undefined, [root]), 'FIFO');
  assert.deepEqual(result, { status: 404, error: 'Arquivo PDF não encontrado no armazenamento local.' });
});

test('FIFO repetido várias vezes: nenhuma requisição fica presa (não esgota o pool de threads)', { skip: !SUPPORTS_FIFO }, async () => {
  const root = await makeRoot();
  const fifo = path.join(root, 'a.pdf');
  execFileSync('mkfifo', [fifo]);
  // Acima do tamanho padrão do pool do libuv (4): se cada leitura prendesse uma thread, a 5ª nunca terminaria.
  const results = await withinGuard(Promise.all(Array.from({ length: 12 }, () => resolvePdfDownload(diagrammerFor(fifo), undefined, [root]))), 'FIFO x12');
  assert.ok(results.every((result) => result.status === 404));
  // O servidor segue atendendo um PDF legítimo na mesma pasta.
  const good = path.join(root, 'b.pdf');
  await fs.writeFile(good, PDF_BYTES);
  const served = await withinGuard(resolvePdfDownload({ ...diagrammerFor(good), pdfFileName: 'b.pdf' }, undefined, [root]), 'PDF legítimo');
  assert.equal(served.status, 200);
});

test('readRegularPdf recusa FIFO com o código PDF_NOT_REGULAR_FILE, sem ler nada', { skip: !SUPPORTS_FIFO }, async () => {
  const root = await makeRoot();
  const fifo = path.join(root, 'x.pdf');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(
    withinGuard(readRegularPdf(fifo), 'readRegularPdf FIFO'),
    (error: unknown) => error instanceof PdfReadRejectedError && error.code === 'PDF_NOT_REGULAR_FILE'
  );
});

test('link simbólico final (inclusive para FIFO) não é seguido: 404', { skip: !SUPPORTS_FIFO }, async () => {
  const root = await makeRoot();
  const outside = await makeRoot();
  const secret = path.join(outside, 'segredo.pdf');
  await fs.writeFile(secret, PDF_BYTES);
  const fifo = path.join(outside, 'fila.pdf');
  execFileSync('mkfifo', [fifo]);
  await fs.symlink(secret, path.join(root, 'link-arquivo.pdf'));
  await fs.symlink(fifo, path.join(root, 'link-fifo.pdf'));
  for (const name of ['link-arquivo.pdf', 'link-fifo.pdf']) {
    const result = await withinGuard(resolvePdfDownload({ ...diagrammerFor(path.join(root, name)), pdfFileName: name }, undefined, [root]), name);
    assert.equal(result.status, 404, name);
  }
});

test('diretório com nome .pdf: 404, não é lido como arquivo', async () => {
  const root = await makeRoot();
  const dir = path.join(root, 'pasta.pdf');
  await fs.mkdir(dir);
  const result = await withinGuard(resolvePdfDownload({ ...diagrammerFor(dir), pdfFileName: 'pasta.pdf' }, undefined, [root]), 'diretório');
  assert.equal(result.status, 404);
});

test('PDF regular continua servido com os bytes exatos', async () => {
  const root = await makeRoot();
  const file = path.join(root, 'ok.pdf');
  await fs.writeFile(file, PDF_BYTES);
  const result = await resolvePdfDownload({ ...diagrammerFor(file), pdfFileName: 'ok.pdf' }, undefined, [root]);
  assert.equal(result.status, 200);
  if (result.status === 200) assert.deepEqual(result.body, PDF_BYTES);
});

test('arquivo acima do teto de tamanho é recusado antes da leitura (PDF_TOO_LARGE)', async () => {
  const root = await makeRoot();
  const file = path.join(root, 'grande.pdf');
  await fs.writeFile(file, Buffer.alloc(2048, 1));
  await assert.rejects(readRegularPdf(file, 1024), (error: unknown) => error instanceof PdfReadRejectedError && error.code === 'PDF_TOO_LARGE');
  assert.equal((await readRegularPdf(file, 2048)).length, 2048, 'no limite exato ainda é aceito');
  assert.ok(MAX_PDF_BYTES >= 1024 * 1024, 'o teto padrão comporta PDFs reais');
  const result = await resolvePdfDownload({ ...diagrammerFor(file), pdfFileName: 'grande.pdf' }, async (target) => readRegularPdf(target, 1024), [root]);
  assert.equal(result.status, 404);
});

test('recusas deixam rastro estruturado sem o caminho: arquivo especial, symlink e arquivo grande', { skip: !SUPPORTS_FIFO }, async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const root = await makeRoot();
  const fifo = path.join(root, 'fila.pdf');
  execFileSync('mkfifo', [fifo]);
  const real = path.join(root, 'real.pdf');
  await fs.writeFile(real, PDF_BYTES);
  const link = path.join(root, 'link.pdf');
  await fs.symlink(real, link);
  const big = path.join(root, 'grande.pdf');
  await fs.writeFile(big, Buffer.alloc(2048, 1));
  await resolvePdfDownload({ ...diagrammerFor(fifo), pdfFileName: 'fila.pdf' }, undefined, [root]);
  await resolvePdfDownload({ ...diagrammerFor(link), pdfFileName: 'link.pdf' }, undefined, [root]);
  await resolvePdfDownload({ ...diagrammerFor(big), pdfFileName: 'grande.pdf' }, async (target) => readRegularPdf(target, 1024), [root]);
  const lines = warn.mock.calls.map((call) => String(call.arguments[0]));
  for (const code of ['PDF_NOT_REGULAR_FILE', 'PDF_SYMLINK_REFUSED', 'PDF_TOO_LARGE']) {
    assert.ok(lines.some((line) => line.includes(code)), `esperava o registro ${code}`);
  }
  assert.ok(lines.every((line) => !line.includes(root)), 'o caminho do arquivo não pode ir para o log');
  for (const name of ['fila.pdf', 'link.pdf', 'grande.pdf', 'real.pdf']) {
    assert.ok(lines.every((line) => !line.includes(name)), `nem o nome do arquivo (${name}) pode ir para o log`);
  }
});

test('leitura curta (arquivo que encolheu depois do stat) é recusada com PDF_SHORT_READ, nunca servida truncada', async (t) => {
  const root = await makeRoot();
  const file = path.join(root, 'curto.pdf');
  await fs.writeFile(file, PDF_BYTES);
  const probe = await fs.open(file, 'r');
  const handlePrototype = Object.getPrototypeOf(probe) as Record<string, (...args: never[]) => unknown>;
  await probe.close();
  // O restante do arquivo "sumiu": o descritor responde 0 bytes no meio da leitura.
  t.mock.method(handlePrototype, 'read', async (buffer: Buffer) => ({ bytesRead: 0, buffer }));
  await assert.rejects(readRegularPdf(file), (error: unknown) => error instanceof PdfReadRejectedError && error.code === 'PDF_SHORT_READ');
  t.mock.method(console, 'warn', () => undefined);
  const result = await resolvePdfDownload({ ...diagrammerFor(file), pdfFileName: 'curto.pdf' }, undefined, [root]);
  assert.equal(result.status, 404, 'o servidor responde 404, não 200 com PDF truncado');
});

test('arquivo inexistente continua 404 com a mensagem original', async () => {
  const root = await makeRoot();
  const result = await resolvePdfDownload(diagrammerFor(path.join(root, 'nao-existe.pdf')), undefined, [root]);
  assert.deepEqual(result, { status: 404, error: 'Arquivo PDF não encontrado no armazenamento local.' });
});
