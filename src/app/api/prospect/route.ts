import { NextResponse } from 'next/server';
import { z } from 'zod';
import { headProspectorAgent } from '@/agents/head-prospector';
import { limitProspect } from '@/lib/api-limits';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { apiFailure } from '@/lib/errors';

const ProspectRequestSchema = z.object({
  city: z.string().min(2, 'Informe o nome da cidade'),
  stateCode: z.string().min(2).max(3).default('GO'),
  nicheKeyword: z.string().min(2, 'Informe o nicho de busca'),
  centerCoordinates: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
});

/**
 * POST /api/prospect
 * Aciona o Head Agent para capturar exatamente 10 leads quentes de fronteira
 * (últimos da 1ª página e primeiros da 2ª página do GMN), filtrando Nome,
 * Status de WhatsApp e Presença de Site Próprio.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;
  try {
    const rawBody: unknown = await request.json().catch(() => null);
    const parsed = ProspectRequestSchema.safeParse(rawBody);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Parâmetros de prospecção inválidos',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const limited = limitProspect(access.operator);
    if (limited) return limited;

    const result = await headProspectorAgent.executeProspecting(parsed.data);
    return NextResponse.json(result, { status: 200 });
  } catch (error: unknown) {
    return apiFailure(error, { route: 'POST /api/prospect' });
  }
}
