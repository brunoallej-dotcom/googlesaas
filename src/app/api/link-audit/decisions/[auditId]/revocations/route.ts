import type { NextResponse } from 'next/server';
import { readJsonBody } from '../../../body';
import { failureResponse, invalidParams, isAuditId, reply, serverClock, successStatus, withDecisions } from '../../shared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/link-audit/decisions/{auditId}/revocations — revoga uma decisão vigente: `{ revokes, reason }`.
 * Cria uma NOVA entrada no histórico; a decisão original nunca é alterada nem removida.
 */
export async function POST(request: Request, context: { params: Promise<{ auditId: string }> }): Promise<NextResponse> {
  const { auditId } = await context.params;
  const url = new URL(request.url);
  return withDecisions(request, 'write', async ({ service, actor }) => {
    if (!isAuditId(auditId) || [...url.searchParams].length > 0) return invalidParams();
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const result = await service.revoke(actor, auditId, body.value, serverClock);
    return result.ok ? reply(result.value, successStatus(result.value)) : failureResponse(result);
  });
}
