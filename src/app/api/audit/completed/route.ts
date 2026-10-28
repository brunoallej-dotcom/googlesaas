import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { apiFailure } from '@/lib/errors';
import { gmnRepository } from '@/lib/supabase';

const QuerySchema = z.object({
  keyword: z.string().trim().min(2).max(180),
  placeIds: z
    .string()
    .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
    .pipe(z.array(z.string().max(128)).min(1).max(25)),
});

/**
 * GET /api/audit/completed?keyword=...&placeIds=a,b,c
 * Somente leitura: devolve a auditoria concluída mais recente de cada empresa para a
 * palavra-chave informada, permitindo reabrir resultados salvos sem executar nada de novo.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;
  const { searchParams } = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    keyword: searchParams.get('keyword') ?? '',
    placeIds: searchParams.get('placeIds') ?? '',
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Parâmetros inválidos', code: 'INVALID_PARAMS' },
      { status: 400 }
    );
  }

  try {
    const audits = await gmnRepository.getLatestCompletedAudits(
      parsed.data.placeIds,
      parsed.data.keyword
    );
    return NextResponse.json({ audits }, { status: 200 });
  } catch (error: unknown) {
    return apiFailure(error, { route: 'GET /api/audit/completed' });
  }
}
