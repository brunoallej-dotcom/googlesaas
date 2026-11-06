import type { NextResponse } from 'next/server';
import { readJsonBody } from '../../body';
import { failureResponse, invalidParams, isAuditId, reply, serverClock, successStatus, withDecisions } from '../shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/link-audit/decisions/{auditId} — decisões vigentes, histórico completo e a projeção `operatorRecords` (contrato da 6A).
 * A cadeia de hashes é verificada em toda leitura; se qualquer arquivo não conferir, NENHUM dado é devolvido (409).
 */
export async function GET(request: Request, context: { params: Promise<{ auditId: string }> }): Promise<NextResponse> {
  const { auditId } = await context.params;
  const url = new URL(request.url);
  return withDecisions(request, 'read', async ({ service, actor }) => {
    if (!isAuditId(auditId) || [...url.searchParams].length > 0) return invalidParams();
    const result = await service.list(actor, auditId, serverClock);
    return result.ok ? reply(result.value) : failureResponse(result);
  });
}

/**
 * POST /api/link-audit/decisions/{auditId} — registra uma decisão humana: `{ record, supersedes? }`.
 * Autor = operador da sessão; data = relógio do servidor; pontuação enviada pelo cliente é recusada; `expectedHead` é obrigatório.
 * 201 = decisão nova e CONFIRMADA (arquivo + recibo); 200 = reenvio de um pedido já aplicado; 503 `ANCHOR_PENDING` = gravada,
 * mas NÃO confirmada (reenvie o mesmo pedido).
 */
export async function POST(request: Request, context: { params: Promise<{ auditId: string }> }): Promise<NextResponse> {
  const { auditId } = await context.params;
  const url = new URL(request.url);
  return withDecisions(request, 'write', async ({ service, actor }) => {
    if (!isAuditId(auditId) || [...url.searchParams].length > 0) return invalidParams();
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const result = await service.create(actor, auditId, body.value, serverClock);
    return result.ok ? reply(result.value, successStatus(result.value)) : failureResponse(result);
  });
}
