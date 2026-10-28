import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiagrammerOutput } from '@/types/gmn';
import { defaultPdfDirectory } from './persist';

export type PdfDownload =
  | { readonly status: 200; readonly body: Buffer<ArrayBuffer>; readonly headers: Record<string, string> }
  | { readonly status: 404; readonly error: string };

/**
 * Pastas das quais o servidor aceita ler PDFs: a pasta privada atual, `GMN_PDF_OUTPUT_DIR` e
 * `public/audits` (somente LEITURA de PDFs históricos já existentes; nada novo é gravado ali).
 */
export function allowedPdfRoots(cwd: string = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  // Ordem de preferência: pasta configurada, depois a pasta PRIVADA padrão, e por último `public/audits`
  // (somente leitura de históricos, ainda expostos até a migração autorizada).
  const roots = [defaultPdfDirectory(cwd), path.join(cwd, 'public', 'audits')];
  const custom = env.GMN_PDF_OUTPUT_DIR?.trim();
  if (custom) roots.unshift(path.resolve(custom));
  return roots.map((root) => path.resolve(root));
}

/** Verdadeiro só se `file` é um `.pdf` dentro de uma das pastas permitidas (sem `..`, sem sair por links textuais). */
export function isPathInsideRoots(file: string, roots: readonly string[]): boolean {
  if (typeof file !== 'string' || file.includes('\0') || path.extname(file).toLowerCase() !== '.pdf') return false;
  const resolved = path.resolve(file);
  return roots.some((root) => resolved.startsWith(root + path.sep));
}

/**
 * Candidatos de leitura para o caminho gravado. Caminhos de outro sistema (ex.: `D:\\...\\a.pdf`
 * gravado no Windows) são resolvidos SÓ pelo nome do arquivo, dentro das pastas permitidas: nada
 * fora delas é lido e nenhum arquivo é movido.
 */
export function pdfReadCandidates(stored: string, roots: readonly string[]): string[] {
  const candidates: string[] = [];
  // Pelo nome do arquivo, na ordem das pastas (a privada vem antes de `public/audits`): uma cópia
  // migrada para a pasta privada passa a ser a servida, sem alterar nenhuma linha do banco.
  const base = stored.split(/[\\/]/).pop() ?? '';
  if (/^[A-Za-z0-9._-]+\.pdf$/i.test(base) && base !== '.pdf') {
    for (const root of roots) candidates.push(path.join(root, base));
  }
  if (isPathInsideRoots(stored, roots) && !candidates.includes(path.resolve(stored))) candidates.push(path.resolve(stored));
  return candidates;
}

/** Nome seguro para o cabeçalho Content-Disposition (sem aspas, quebras de linha ou barras). */
export function safeDownloadName(name: string | undefined): string {
  const cleaned = (name ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 120);
  return cleaned.toLowerCase().endsWith('.pdf') && cleaned.length > 4 ? cleaned : 'auditoria-gmn.pdf';
}

/**
 * Resolve o download do PDF de uma auditoria. 404 se o PDF não foi finalizado, se o caminho gravado
 * está fora das pastas permitidas ou se o arquivo não existe (o chamador pode então regenerar).
 */
export async function resolvePdfDownload(
  diagrammer: DiagrammerOutput | undefined,
  readFile: (path: string) => Promise<Buffer<ArrayBuffer>> = fs.readFile,
  roots: readonly string[] = allowedPdfRoots()
): Promise<PdfDownload> {
  if (!diagrammer?.pdfStoragePath) {
    return { status: 404, error: 'O PDF desta auditoria ainda não foi finalizado pelo Diagramador.' };
  }
  const candidates = pdfReadCandidates(diagrammer.pdfStoragePath, roots);
  for (const candidate of candidates) {
    let body: Buffer<ArrayBuffer>;
    try {
      body = await readFile(candidate);
    } catch {
      continue;
    }
    return {
      status: 200,
      body,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${safeDownloadName(diagrammer.pdfFileName)}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    };
  }
  return { status: 404, error: 'Arquivo PDF não encontrado no armazenamento local.' };
}
