import { NextResponse } from 'next/server';
import { invalidIdResponse, isUuid } from '@/lib/api-limits';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { apiFailure } from '@/lib/errors';
import { getSupabaseAdmin, gmnRepository } from '@/lib/supabase';
import { regeneratePdfFromDatabase } from '@/lib/pdf/regenerate';
import { resolvePdfWithFallbacks } from '@/lib/pdf/download-chain';
import { privateBucketName } from '@/lib/pdf/private-store';
import type { DiagrammerOutput } from '@/types/gmn';

/**
 * GET /api/audit/[id]/pdf
 * ÚNICO caminho de download dos PDFs novos (exige operador autenticado).
 */
export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> }
): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;
  const { id } = await context.params;
  if (!isUuid(id)) return invalidIdResponse();
  try {
    const state = await gmnRepository.getAuditState(id);
    const diagrammer = state?.diagrammer as DiagrammerOutput | undefined;
    const result = await resolvePdfWithFallbacks(id, diagrammer, {
      supabase: getSupabaseAdmin(),
      bucket: privateBucketName(),
      regenerate: regeneratePdfFromDatabase,
    });
    if (result.status === 404) {
      return NextResponse.json({ error: result.error, code: 'NOT_FOUND' }, { status: 404 });
    }
    return new NextResponse(result.body, { status: 200, headers: { ...result.headers, 'X-GMN-PDF-Source': result.source } });
  } catch (error: unknown) {
    return apiFailure(error, { route: 'GET /api/audit/[id]/pdf', auditId: id });
  }
}
