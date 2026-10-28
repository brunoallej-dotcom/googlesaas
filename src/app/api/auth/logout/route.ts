import { NextResponse } from 'next/server';
import { crossOriginViolation, shouldUseSecureCookie } from '@/lib/auth/guard';
import { buildClearedSessionCookie } from '@/lib/auth/session';

export async function POST(request: Request): Promise<NextResponse> {
  if (crossOriginViolation(request)) {
    return NextResponse.json({ error: 'Origem da requisição não permitida.', code: 'CROSS_ORIGIN' }, { status: 403 });
  }
  const secure = shouldUseSecureCookie(request);
  const response = NextResponse.json({ ok: true }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  response.headers.append('Set-Cookie', buildClearedSessionCookie(secure));
  return response;
}
