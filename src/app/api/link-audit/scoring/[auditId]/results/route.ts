import type { NextResponse } from 'next/server';
import { invalidParams, isAuditId, reply, resultsFailureResponse, withResults } from '../../shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/link-audit/scoring/{auditId}/results — resultados CONFIRMADOS (verificados por inteiro: selo, bytes canônicos, encadeamento,
 * recibos e reprodução pelo motor), a pendente à parte e se o mais recente está DESATUALIZADO. Qualquer falha de integridade ⇒ 409 sem dados.
 */
export async function GET(request: Request, context: { params: Promise<{ auditId: string }> }): Promise<NextResponse> {
  const { auditId } = await context.params;
  const url = new URL(request.url);
  return withResults(request, 'read', async ({ service, actor }) => {
    if (!isAuditId(auditId) || [...url.searchParams].length > 0) return invalidParams();
    const result = await service.list(actor, auditId);
    return result.ok ? reply(result.value) : resultsFailureResponse(result);
  });
}
