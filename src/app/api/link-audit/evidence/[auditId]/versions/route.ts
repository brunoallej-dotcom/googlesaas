import type { NextResponse } from 'next/server';
import { invalidParams, isAuditId, notFound, readQuery, reply, withEvidence } from '../../shared';

export const dynamic = 'force-dynamic';

/** GET /api/link-audit/evidence/{auditId}/versions — histórico de capturas e revisões do relatório. */
export async function GET(request: Request, context: { params: Promise<{ auditId: string }> }): Promise<NextResponse> {
  const { auditId } = await context.params;
  const url = new URL(request.url);
  return withEvidence(request, async ({ reader, actor }) => {
    if (!isAuditId(auditId) || !readQuery(url, [])) return invalidParams();
    const versions = await reader.listVersions(actor, auditId).catch(() => null);
    if (versions && versions.length > 0) return reply({ auditId, versions });
    // Sem histórico a exibir: distingue "inexistente" de "integridade que não confere".
    const state = await reader.getIntegrity(actor, auditId).catch(() => null);
    if (state && state.integrity.status === 'MISMATCH') {
      return reply({ error: 'A integridade desta coleta não pôde ser confirmada; os dados não são exibidos.', code: 'INTEGRITY_FAILED' }, 409);
    }
    return notFound();
  });
}
