import type { NextResponse } from 'next/server';
import { readJsonBody } from '../../../body';
import { invalidParams, isAuditId, reply, resultsFailureResponse, withResults } from '../../shared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/link-audit/scoring/{auditId}/finalize — grava o resultado IMUTÁVEL da auditoria (Onda 6C, I4). Corpo estrito
 * `{ expectedHead, expectedInputSha256 }` (a visão que o operador viu na prévia); qualquer outro campo ⇒ 400. Autor e hora vêm da
 * sessão e do servidor; pontuação, entrada do motor, `referenceDate` ou hashes enviados pelo cliente nunca são aceitos.
 * 201 = resultado novo CONFIRMADO (arquivo + recibo); 200 = reenvio idêntico (nada novo gravado); 409 = recusa (nada gravado);
 * 503 `RESULT_ANCHOR_PENDING` = gravado, mas NÃO confirmado (reenvie o mesmo pedido). INCONCLUSIVO (index:null) é um resultado válido.
 */
export async function POST(request: Request, context: { params: Promise<{ auditId: string }> }): Promise<NextResponse> {
  const { auditId } = await context.params;
  const url = new URL(request.url);
  return withResults(request, 'write', async ({ service, actor }) => {
    if (!isAuditId(auditId) || [...url.searchParams].length > 0) return invalidParams();
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const result = await service.finalize(actor, auditId, body.value);
    return result.ok ? reply(result.value, result.value.replayed ? 200 : 201) : resultsFailureResponse(result);
  });
}
