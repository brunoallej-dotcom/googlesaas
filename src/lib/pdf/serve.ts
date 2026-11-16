import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StructuredLogger } from '@/lib/logger';
import type { DiagrammerOutput } from '@/types/gmn';
import { defaultPdfDirectory } from './persist';

export type PdfDownload =
  | { readonly status: 200; readonly body: Buffer<ArrayBuffer>; readonly headers: Record<string, string> }
  | { readonly status: 404; readonly error: string };

/** Teto de tamanho de um PDF servido (os PDFs reais têm centenas de KB). */
export const MAX_PDF_BYTES = 64 * 1024 * 1024;

export type PdfReadRejectionCode = 'PDF_NOT_REGULAR_FILE' | 'PDF_TOO_LARGE' | 'PDF_SHORT_READ';

/** Arquivo recusado: não é arquivo regular (FIFO, dispositivo, diretório), excede o teto ou mudou de tamanho durante a leitura. */
export class PdfReadRejectedError extends Error {
  constructor(readonly code: PdfReadRejectionCode) {
    super(code);
    this.name = 'PdfReadRejectedError';
  }
}

/**
 * Lê um PDF SOMENTE se for arquivo regular. `fs.readFile` direto abre FIFOs sem `O_NONBLOCK`: um FIFO
 * colocado numa pasta de PDFs bloquearia uma thread do pool a cada requisição até esgotar o servidor.
 * Aqui o arquivo é aberto sem bloquear e sem seguir link simbólico final (`O_NONBLOCK`, `O_NOFOLLOW`),
 * o tipo e o tamanho são conferidos no descritor já aberto (sem corrida entre checar e abrir) e só então lido.
 */
export async function readRegularPdf(file: string, maxBytes: number = MAX_PDF_BYTES): Promise<Buffer<ArrayBuffer>> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(file, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new PdfReadRejectedError('PDF_NOT_REGULAR_FILE');
    if (info.size > maxBytes) throw new PdfReadRejectedError('PDF_TOO_LARGE');
    // Leitura limitada ao tamanho conferido no descritor: a memória nunca passa de `maxBytes`, mesmo que o
    // arquivo cresça depois do `stat` (ou seja um pseudo-arquivo que informa tamanho 0).
    const body = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(body, offset, info.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // Arquivo que encolheu durante a leitura: recusa em vez de servir um PDF truncado como 200.
    if (offset !== info.size) throw new PdfReadRejectedError('PDF_SHORT_READ');
    return body;
  } finally {
    await handle.close();
  }
}

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

/** Código de log de uma recusa deliberada (arquivo especial, grande, truncado ou symlink final); `undefined` para erros comuns (inexistente etc.). */
function rejectionCodeOf(error: unknown): PdfReadRejectionCode | 'PDF_SYMLINK_REFUSED' | undefined {
  if (error instanceof PdfReadRejectedError) return error.code;
  return (error as NodeJS.ErrnoException | null)?.code === 'ELOOP' ? 'PDF_SYMLINK_REFUSED' : undefined;
}

/**
 * Resolve o download do PDF de uma auditoria. 404 se o PDF não foi finalizado, se o caminho gravado
 * está fora das pastas permitidas ou se o arquivo não existe (o chamador pode então regenerar).
 */
export async function resolvePdfDownload(
  diagrammer: DiagrammerOutput | undefined,
  readFile: (path: string) => Promise<Buffer<ArrayBuffer>> = readRegularPdf,
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
    } catch (error) {
      const rejection = rejectionCodeOf(error);
      if (rejection) {
        // Sem o caminho no log (pode conter nome de empresa); só o motivo e a auditoria.
        new StructuredLogger('DIAGRAMMER', diagrammer.auditId).warn('Download de PDF recusado antes da leitura', {
          stage: 'pdf-download',
          errorCode: rejection,
        });
      }
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
