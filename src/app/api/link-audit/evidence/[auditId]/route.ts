import type { NextResponse } from 'next/server';
import { toAuditDetailDto } from '@/lib/link-audit-evidence';
import { invalidParams, isAuditId, notFound, readQuery, reply, withEvidence } from '../shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/link-audit/evidence/{auditId}?capture=&revision= — detalhes de uma auditoria armazenada.
 * A integridade (SHA-256) é verificada antes de montar a visão; arquivo que não confere não é exibido.
 */
export async function GET(request: Request, context: { params: Promise<{ auditId: string }> }): Promise<NextResponse> {
  const { auditId } = await context.params;
  const url = new URL(request.url);
  return withEvidence(request, async ({ reader, actor }) => {
    const query = readQuery(url, ['capture', 'revision']);
    if (!isAuditId(auditId) || !query || (query.capture !== undefined && query.capture < 1) || (query.revision !== undefined && query.revision < 1)) return invalidParams();
    const view = await reader.getAudit(actor, auditId, { ...(query.capture !== undefined ? { capture: query.capture } : {}), ...(query.revision !== undefined ? { revision: query.revision } : {}) });
    if (view) return reply({ audit: toAuditDetailDto(view) });
    const state = await reader.getIntegrity(actor, auditId);
    if (!state) return notFound();
    if (state.integrity.status === 'OK' || state.integrity.status === 'INCOMPLETE') {
      return state.state === 'INCOMPLETE'
        ? reply({ error: 'Esta coleta está incompleta (não há relatório): não há o que exibir.', code: 'AUDIT_INCOMPLETE' }, 409)
        : notFound(); // revisão/captura inexistente
    }
    return reply({ error: 'A integridade desta coleta não pôde ser confirmada; os dados não são exibidos.', code: 'INTEGRITY_FAILED', integrity: { status: state.integrity.status, algorithm: state.integrity.algorithm, note: state.integrity.note } }, 409);
  });
}
