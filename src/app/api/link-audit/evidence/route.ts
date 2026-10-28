import type { NextResponse } from 'next/server';
import { toListItem } from '@/lib/link-audit-evidence';
import { invalidParams, listWindow, readQuery, reply, withEvidence } from './shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/link-audit/evidence?limit=&offset= — lista as auditorias armazenadas (somente leitura).
 * Sem corpo bruto, sem caminhos, sem chaves. Paginação limitada (máx. 50).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  return withEvidence(request, async ({ reader, actor }) => {
    // Só depois de autenticado (sem sessão: 401, nunca 400 com trabalho de validação gratuito).
    const query = readQuery(url, ['limit', 'offset']);
    const window = query ? listWindow(query) : null;
    if (!window) return invalidParams();
    const all = await reader.listAudits(actor);
    const page = all.slice(window.offset, window.offset + window.limit).map(toListItem);
    return reply({ audits: page, total: all.length, limit: window.limit, offset: window.offset });
  });
}
