import { NextResponse } from 'next/server';
import { invalidIdResponse, isUuid } from '@/lib/api-limits';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { apiFailure } from '@/lib/errors';
import { gmnRepository } from '@/lib/supabase';

/** GET /api/campaigns/[id]: reabre uma campanha salva com os leads (somente leitura, sem Serper). */
export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> }
): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;
  const { id } = await context.params;
  if (!isUuid(id)) return invalidIdResponse();
  try {
    const campaign = await gmnRepository.getCampaignWithLeads(id);
    if (!campaign) return NextResponse.json({ error: 'Campanha não localizada.', code: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json(campaign, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error: unknown) {
    return apiFailure(error, { route: 'GET /api/campaigns/[id]' });
  }
}
