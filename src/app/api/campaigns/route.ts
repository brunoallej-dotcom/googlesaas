import { NextResponse } from 'next/server';
import { isErrorResponse, requireOperator } from '@/lib/auth/require-operator';
import { apiFailure } from '@/lib/errors';
import { gmnRepository } from '@/lib/supabase';

/** GET /api/campaigns: campanhas salvas (somente leitura, sem Serper). */
export async function GET(request: Request): Promise<NextResponse> {
  const access = await requireOperator(request);
  if (isErrorResponse(access)) return access;
  try {
    const campaigns = await gmnRepository.listRecentCampaigns(20);
    return NextResponse.json({ campaigns }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error: unknown) {
    return apiFailure(error, { route: 'GET /api/campaigns' });
  }
}
