import type { NextResponse } from 'next/server';
import { readJsonBody } from '../../../body';
import { failureResponse, invalidParams, isAuditId, reply, serverClock, withDecisions } from '../../shared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/link-audit/decisions/{auditId}/ledger — ações sobre o LIVRO DE CABEÇAS: `{ action }`.
 *  - `ENROLL`: inscreve uma auditoria VAZIA (explícito; nunca implícito);
 *  - `RECOVER`: aplica a recuperação verificável (aborta operação vencida; conclui o CONFIRMED que faltou); não grava decisão;
 *  - `ADOPT` / `RESTORE_ACK` / `QUARANTINE_ACK`: CONCEDEM confiança e exigem aprovação administrativa que ainda não existe ⇒ 403 `ADMIN_APPROVAL_UNAVAILABLE`.
 * Autor = operador da sessão; hora = relógio do servidor.
 */
export async function POST(request: Request, context: { params: Promise<{ auditId: string }> }): Promise<NextResponse> {
  const { auditId } = await context.params;
  const url = new URL(request.url);
  return withDecisions(request, 'write', async ({ service, actor }) => {
    if (!isAuditId(auditId) || [...url.searchParams].length > 0) return invalidParams();
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const result = await service.ledgerAction(actor, auditId, body.value, serverClock);
    return result.ok ? reply(result.value) : failureResponse(result);
  });
}
