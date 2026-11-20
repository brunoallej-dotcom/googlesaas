import type { NextResponse } from 'next/server';
import { readJsonBody } from '../../../body';
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

/**
 * POST /api/link-audit/scoring/{auditId}/results — ação PRÓPRIA de reemissão do recibo de um resultado JÁ CONFIRMADO pelo livro de cabeças (spec do livro §16.17.5, D-12).
 * Corpo estrito `{ "action": "REISSUE_RECEIPT" }`; qualquer operador (mesma autenticação, lista de operadores e limitador da finalização). Nunca finaliza nada nem depende da
 * prévia, das evidências ou da chave de origem. 200 `{ action, ledger }` (vista do livro atualizada, D-R1-2); 409 `LEDGER_ACTION_INVALID` = não há recibo a reemitir (nada gravado).
 */
export async function POST(request: Request, context: { params: Promise<{ auditId: string }> }): Promise<NextResponse> {
  const { auditId } = await context.params;
  const url = new URL(request.url);
  return withResults(request, 'reissue', async ({ service, actor }) => {
    if (!isAuditId(auditId) || [...url.searchParams].length > 0) return invalidParams();
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const result = await service.reissueReceipt(actor, auditId, body.value);
    return result.ok ? reply(result.value) : resultsFailureResponse(result);
  });
}
