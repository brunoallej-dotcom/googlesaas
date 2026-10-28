import fs from 'node:fs/promises';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PersistedPdf {
  /** Caminho local do arquivo (usado por GET /api/audit/[id]/pdf). */
  readonly localPath: string;
  /** Nome efetivamente gravado (pode ganhar sufixo -r2, -r3… para nunca sobrescrever um PDF existente). */
  readonly fileName: string;
  /** Sempre a rota autenticada da plataforma: nunca uma URL pública. */
  readonly downloadUrl: string;
  /** Cópia durável em bucket PRIVADO (opcional). */
  readonly uploaded: boolean;
  readonly uploadError: string | null;
}

export interface PersistDeps {
  readonly mkdir?: typeof fs.mkdir;
  readonly writeFile?: typeof fs.writeFile;
  /** Cliente do Supabase: só é usado se `bucket` (privado) for informado. */
  readonly supabase?: SupabaseClient | null;
  /** Bucket PRIVADO opcional (`SUPABASE_PRIVATE_AUDIT_BUCKET`). Sem ele, nada é enviado ao Supabase. */
  readonly bucket?: string | null;
}

/** Pasta privada dos PDFs novos: fora de `public/`, portanto nunca servida diretamente pelo Next. */
export function defaultPdfDirectory(cwd: string = process.cwd()): string {
  return path.join(cwd, '.data', 'audits');
}

export function buildPdfFileName(businessName: string, auditId: string): string {
  const slug = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `auditoria-gmn-${slug}-${auditId.slice(0, 8)}.pdf`;
}

function versionedName(fileName: string, revision: number): string {
  if (revision <= 1) return fileName;
  const ext = path.extname(fileName);
  return `${fileName.slice(0, fileName.length - ext.length)}-r${revision}${ext}`;
}

/**
 * Grava o PDF em pasta privada, SEM sobrescrever nada: se o nome já existe, grava a próxima
 * revisão (-r2, -r3…). Falha ao gravar interrompe (erro claro). Se `bucket` privado for informado,
 * guarda também uma cópia durável (sem `upsert`); uma falha no envio mantém o arquivo local e
 * devolve o motivo. O link de download é sempre a rota autenticada.
 */
export async function persistReportPdf(
  params: {
    readonly auditId: string;
    readonly pdfFileName: string;
    readonly buffer: Buffer;
    readonly outputDir?: string;
  },
  deps: PersistDeps = {}
): Promise<PersistedPdf> {
  const mkdir = deps.mkdir ?? fs.mkdir;
  const writeFile = deps.writeFile ?? fs.writeFile;
  const outputDir = params.outputDir ?? defaultPdfDirectory();

  let fileName = params.pdfFileName;
  let localPath = path.join(outputDir, fileName);
  try {
    await mkdir(outputDir, { recursive: true });
    for (let revision = 1; ; revision++) {
      fileName = versionedName(params.pdfFileName, revision);
      localPath = path.join(outputDir, fileName);
      try {
        await writeFile(localPath, params.buffer, { flag: 'wx' });
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || revision >= 999) throw error;
      }
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Falha ao gravar o PDF em ${localPath}: ${reason}`);
  }

  const downloadUrl = `/api/audit/${params.auditId}/pdf`;
  const supabase = deps.supabase ?? null;
  const bucket = deps.bucket?.trim();
  if (!supabase || !bucket) return { localPath, fileName, downloadUrl, uploaded: false, uploadError: null };

  const { error } = await supabase.storage.from(bucket).upload(`audits/${params.auditId}/${fileName}`, params.buffer, {
    contentType: 'application/pdf',
    upsert: false,
  });
  if (error) return { localPath, fileName, downloadUrl, uploaded: false, uploadError: error.message };
  return { localPath, fileName, downloadUrl, uploaded: true, uploadError: null };
}
