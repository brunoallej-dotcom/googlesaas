import type { NextResponse } from 'next/server';
import { invalidParams, isAuditId, reply, resultsFailureResponse, withResults } from '../../../shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/link-audit/scoring/{auditId}/results/{seq} — UM resultado confirmado e verificado, em projeção pública (sem a entrada do
 * motor, sem e-mails nem justificativas das decisões, sem pontos suprimidos em INCONCLUSIVO). Falha de integridade ⇒ 409 sem dados.
 */
export async function GET(request: Request, context: { params: Promise<{ auditId: string; seq: string }> }): Promise<NextResponse> {
  const { auditId, seq } = await context.params;
  const url = new URL(request.url);
  return withResults(request, 'read', async ({ service, actor }) => {
    if (!isAuditId(auditId) || !/^[1-9]\d{0,3}$/.test(seq) || [...url.searchParams].length > 0) return invalidParams();
    const result = await service.get(actor, auditId, Number(seq));
    return result.ok ? reply(result.value) : resultsFailureResponse(result);
  });
}
