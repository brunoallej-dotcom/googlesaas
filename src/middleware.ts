import { NextResponse, type NextRequest } from 'next/server';
import { authorizeRequest } from '@/lib/auth/guard';

/**
 * Porteiro de TODA a plataforma (páginas, API e `/audits/*`). Nada é público exceto a página de
 * login e as rotas de login/logout. As rotas de API chamam `requireOperator` de novo (defesa em
 * profundidade). Falha fechada: sem autenticação configurada, ninguém entra.
 *
 * ATENÇÃO sobre `/audits/*`: bloquear a URL NÃO protege os arquivos antigos que continuam fisicamente
 * em `public/audits/` nem as cópias do bucket público do Supabase; é mitigação parcial até a
 * migração autorizada (ver docs/phase5/security-review.md).
 */
const PUBLIC_PATHS = new Set(['/login', '/api/auth/login', '/api/auth/logout']);

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Ferramentas de desenvolvimento nunca existem em produção.
  if ((pathname === '/dev' || pathname.startsWith('/dev/')) && process.env.NODE_ENV === 'production') {
    return new NextResponse('Not Found', { status: 404 });
  }
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const decision = await authorizeRequest(request);
  if (decision.ok) return NextResponse.next();

  if (pathname.startsWith('/api/') || pathname.startsWith('/audits/')) {
    return NextResponse.json(
      { error: decision.message, code: decision.code },
      { status: decision.status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const login = new URL('/login', request.url);
  if (pathname !== '/') login.searchParams.set('next', pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // Tudo, exceto os arquivos internos do Next e o favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
