import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['pdfkit', 'bullmq', 'ioredis'],
  // Imagem Docker de produção (deploy/hostinger): saída standalone só quando pedida; o build local não muda.
  ...(process.env.GMN_BUILD_STANDALONE === '1' ? { output: 'standalone' as const } : {}),
  // O PDF lê as fontes de `process.cwd()/assets/fonts` (caminho dinâmico, que o rastreamento não enxerga).
  outputFileTracingIncludes: { '/api/audit/[id]/pdf': ['./assets/fonts/**/*'] },
  // Só afeta o dev: tira o indicador do Next de cima da sidebar.
  devIndicators: { position: 'bottom-right' },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // Não usar `no-referrer`: o OpenStreetMap bloqueia (tile 403) requisições sem Referer.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          // CSP em modo somente-relatório (não bloqueia nada): mede antes de impor. Next precisa de scripts/estilos inline.
          {
            key: 'Content-Security-Policy-Report-Only',
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.tile.openstreetmap.org; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
          },
        ],
      },
    ];
  },
  experimental: {
    // O middleware copia o corpo da requisição para a memória antes das rotas (padrão: até 10 MB). Todas as
    // rotas da API usam JSON pequeno; 64 KB cobre o maior caso e limita essa cópia (Fase 6, Onda 4B).
    middlewareClientMaxBodySize: '64kb',
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
};

export default nextConfig;
