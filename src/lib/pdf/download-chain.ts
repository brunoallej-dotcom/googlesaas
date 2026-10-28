import type { SupabaseClient } from '@supabase/supabase-js';
import type { DiagrammerOutput } from '@/types/gmn';
import { downloadPrivatePdf } from './private-store';
import { resolvePdfDownload, safeDownloadName } from './serve';

export type PdfSource = 'local' | 'private-bucket' | 'regenerated';

export type ChainResult =
  | { readonly status: 200; readonly source: PdfSource; readonly body: Buffer<ArrayBuffer>; readonly headers: Record<string, string> }
  | { readonly status: 404; readonly error: string };

export interface ChainDeps {
  readonly supabase: SupabaseClient | null;
  readonly bucket: string | null;
  readonly roots?: readonly string[];
  readonly regenerate: (auditId: string) => Promise<{ body: Buffer<ArrayBuffer>; headers: Record<string, string> } | null>;
}

/**
 * Ordem de leitura de um PDF: (1) arquivo local privado (ou histórico em `public/audits`, só
 * leitura); (2) cópia no bucket PRIVADO; (3) recomposição a partir do banco, sem consulta externa.
 * Nunca usa URL pública.
 */
export async function resolvePdfWithFallbacks(
  auditId: string,
  diagrammer: DiagrammerOutput | undefined,
  deps: ChainDeps
): Promise<ChainResult> {
  const local = await resolvePdfDownload(diagrammer, undefined, deps.roots);
  if (local.status === 200) return { ...local, source: 'local' };
  if (!diagrammer?.pdfStoragePath) return local;

  const storedName = diagrammer.pdfStoragePath.split(/[\\/]/).pop() ?? '';
  for (const name of new Set([storedName, diagrammer.pdfFileName ?? ''])) {
    if (!name) continue;
    const body = await downloadPrivatePdf(deps.supabase, deps.bucket, auditId, name).catch(() => null);
    if (body) {
      return {
        status: 200,
        source: 'private-bucket',
        body,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${safeDownloadName(diagrammer.pdfFileName ?? name)}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      };
    }
  }

  const regenerated = await deps.regenerate(auditId);
  if (regenerated) return { status: 200, source: 'regenerated', body: regenerated.body, headers: regenerated.headers };
  return local;
}
