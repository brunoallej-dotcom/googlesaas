import { NextResponse } from 'next/server';
import { authorizeRequest } from './guard';

export interface OperatorContext {
  readonly operator: string;
}

/**
 * Guarda de rota (defesa em profundidade além do middleware): devolve a resposta de erro quando o
 * acesso não é permitido, ou o operador autenticado. Mensagens genéricas, sem detalhes internos.
 */
export async function requireOperator(request: Request): Promise<NextResponse | OperatorContext> {
  const decision = await authorizeRequest(request);
  if (decision.ok) return { operator: decision.operator };
  return NextResponse.json(
    { error: decision.message, code: decision.code },
    { status: decision.status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export function isErrorResponse(value: NextResponse | OperatorContext): value is NextResponse {
  return value instanceof NextResponse;
}
