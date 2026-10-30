import type { NextResponse } from 'next/server';
import { failureResponse, invalidParams, isAuditId, reply, withScoring } from '../shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/link-audit/scoring/{auditId} — PRÉVIA da pontuação Lumos (nunca definitiva). O servidor lê a base verificada e as decisões
 * CONFIRMADAS, monta a entrada só pelo mapeador, executa o motor e devolve cobertura, critérios, limitações e bloqueios. Não grava,
 * não gera recibo e não aceita nenhum dado do cliente além do `auditId` (qualquer parâmetro de consulta é recusado).
 * Cobertura insuficiente é o desfecho INCONCLUSIVO (`index:null`), não um erro; bloqueio, decisão pendente e falha de integridade
 * são coisas distintas. Evidência ou decisões que não passam na verificação ⇒ 409 SEM dados.
 */
export async function GET(request: Request, context: { params: Promise<{ auditId: string }> }): Promise<NextResponse> {
  const { auditId } = await context.params;
  const url = new URL(request.url);
  return withScoring(request, async ({ service, actor }) => {
    if (!isAuditId(auditId) || [...url.searchParams].length > 0) return invalidParams();
    const result = await service.preview(actor, auditId);
    return result.ok ? reply(result.value) : failureResponse(result);
  });
}
