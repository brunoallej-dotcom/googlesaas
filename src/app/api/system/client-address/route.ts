import { NextResponse } from 'next/server';
import { resolveClientAddress } from '@/lib/auth/guard';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';

/**
 * GET /api/system/client-address: mostra ao OPERADOR autenticado o IP que o app enxerga para a requisição dele e de
 * onde vem (verificação pós-deploy da confiança em X-Forwarded-For atrás do Traefik). Só devolve dados da própria
 * requisição: nenhum segredo e nenhum dado de terceiros. `X-Real-IP` é informado como ignorado.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;
  const client = resolveClientAddress(request.headers);
  return NextResponse.json(
    {
      address: client.address,
      source: client.source,
      forwardedHops: client.hops,
      shared: client.shared,
      xRealIpPresentButIgnored: request.headers.has('x-real-ip'),
      forwardedProto: request.headers.get('x-forwarded-proto') ?? null,
      host: request.headers.get('host') ?? null,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
