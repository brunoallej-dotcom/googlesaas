/**
 * ============================================================================
 * FIXTURES DE TESTE DO RELATÓRIO. NÃO SÃO RESULTADOS DE AUDITORIA.
 * Executam os agentes reais em modo offline (sem credenciais de API), para que os dados tenham
 * exatamente o formato (e os marcadores de simulação) que a plataforma grava no banco.
 * ============================================================================
 */
import type { FrontierLead, VitrineMetrics } from '@/types/gmn';
import { judgeAgent } from '@/agents/judge-agent';
import { reputationAgent } from '@/agents/reputation-agent';
import { rivalsAgent } from '@/agents/rivals-agent';
import { strategistAgent } from '@/agents/strategist-agent';
import { vitrineAgent } from '@/agents/vitrine-agent';
import { checkWebsite, type SiteCheckResult, type SiteTransport } from '@/lib/site-check';
import type { ReviewsFetcher } from '@/lib/serper-reviews';
import type { ReportSourceData } from '@/lib/pdf/report-types';
import { buildFixtureBattlefield, buildFixtureLead } from './battlefield-fixture';
import { legacyJudge, legacyReputation, legacyStrategist, legacyVitrine } from './legacy-fixture';

export interface ReportFixtureOptions {
  /**
   * - `simulated` (padrão): formato anterior à Fase 4 (avaliações e vitrine simuladas, Juiz sem evidência).
   * - `phase4`: saída real dos agentes da Fase 4 em modo offline (sem fontes: tudo indisponível).
   * - `phase4-live`: Fase 4 com fontes simuladas por fixtures de teste (avaliações datadas, vitrine e site).
   */
  readonly dataStyle?: 'simulated' | 'phase4' | 'phase4-live';
  readonly territory?: 'full' | 'partial' | 'unreadable';
  readonly lead?: Partial<FrontierLead>;
  /** Cidade da fixture (padrão: ponto de teste em Anápolis/GO). Os dados continuam sintéticos. */
  readonly location?: { readonly city: string; readonly state: string; readonly latitude: number; readonly longitude: number };
}

export const REPORT_FIXTURE_AUDIT_ID = '00000000-0000-4000-8000-0000000000a1';

export function buildReportFixtureLead(overrides: Partial<FrontierLead> = {}): FrontierLead {
  return {
    ...buildFixtureLead(),
    businessName: 'EMPRESA DE TESTE (fixture)',
    addressRaw: 'Rua de Teste, 100 - Centro, Cidade Teste - GO, 75000-000, Brasil',
    phoneRaw: '+55 62 90000-0000',
    phoneE164: '+5562900000000',
    whatsappStatus: 'LIKELY_MOBILE_WHATSAPP',
    websiteStatus: 'OWN_DOMAIN',
    websiteUrl: 'https://www.exemplo-teste.com.br/',
    featureId: '0xfixture:0xfixture',
    rating: 4.9,
    totalReviews: 39,
    secondaryCategories: [],
    attributesCount: 1,
    servicesListedCount: 2,
    claimedByOwner: true,
    businessHoursConfigured: true,
    ...overrides,
  };
}

const fixtureCache = new Map<string, Promise<ReportSourceData>>();

/** Resultados em cache por opções: as fixtures são somente leitura. */
export function buildReportFixture(options: ReportFixtureOptions = {}): Promise<ReportSourceData> {
  const key = JSON.stringify(options);
  let cached = fixtureCache.get(key);
  if (!cached) {
    cached = buildReportFixtureUncached(options);
    fixtureCache.set(key, cached);
  }
  return cached;
}

/** Resposta HIPOTÉTICA do Serper Reviews (formato não confirmado em documentação oficial). */
export function fixtureReviewsFetcher(now: Date = new Date()): ReviewsFetcher {
  const reviews = Array.from({ length: 24 }, (_, index) => {
    const ageDays = index * 3 + 1; // de 1 a 70 dias: cobre a janela de 30 dias
    return {
      rating: 5,
      snippet: index % 2 === 0 ? 'Ótimo atendimento na categoria de teste.' : 'Serviço rápido e educado.',
      isoDate: new Date(now.getTime() - ageDays * 86_400_000).toISOString(),
      ...(index % 4 === 0 ? { response: { snippet: 'Obrigado pela avaliação! (fixture)' } } : { response: null }),
    };
  });
  return async () => ({ ok: true, status: 200, json: async () => ({ reviews, nextPageToken: null }) });
}

/** Site de teste com dados estruturados LocalBusiness coerentes com o endereço da listagem. */
export function fixtureSiteTransport(): SiteTransport {
  const html = `<!doctype html><html><head><title>Empresa de Teste</title>
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Dentist',
    name: 'EMPRESA DE TESTE',
    telephone: '+55 62 90000-0000',
    address: { '@type': 'PostalAddress', streetAddress: 'Rua de Teste, 100', addressLocality: 'Cidade Teste', addressRegion: 'GO', postalCode: '75000-000' },
    geo: { latitude: -16.3, longitude: -48.9 },
  })}</script></head><body><a href="https://wa.me/5562900000000">WhatsApp</a></body></html>`;
  return async ({ url }) =>
    url.pathname === '/robots.txt'
      ? { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' }
      : { statusCode: 200, headers: { 'content-type': 'text/html' }, body: html };
}

export async function fixtureSiteCheck(): Promise<SiteCheckResult> {
  return checkWebsite('https://www.exemplo-teste.com.br/', {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: fixtureSiteTransport(),
    now: () => new Date('2026-01-01T09:30:00.000Z'),
  });
}

async function buildReportFixtureUncached(options: ReportFixtureOptions): Promise<ReportSourceData> {
  const where = options.location;
  const lead = buildReportFixtureLead({
    ...(where
      ? {
          coordinates: { latitude: where.latitude, longitude: where.longitude },
          addressRaw: `Rua de Teste, 100 - Centro, ${where.city} - ${where.state}, 75000-000, Brasil`,
        }
      : {}),
    ...options.lead,
  });
  const battlefield = buildFixtureBattlefield(options.territory ?? 'full', where ? { latitude: where.latitude, longitude: where.longitude } : undefined);
  const style = options.dataStyle ?? 'simulated';

  // Garante o caminho offline dos agentes, mesmo se o ambiente tiver credenciais.
  const saved = {
    login: process.env.DATAFORSEO_LOGIN,
    password: process.env.DATAFORSEO_PASSWORD,
    reviews: process.env.GMN_REVIEWS_PROVIDER,
    demo: process.env.GMN_DEMO_MODE,
  };
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
  delete process.env.GMN_REVIEWS_PROVIDER;
  delete process.env.GMN_DEMO_MODE;
  // Os agentes registram logs JSON em cada execução; ficam em silêncio só durante a montagem.
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    if (style === 'simulated') {
      const reputation = legacyReputation(lead);
      const vitrine = legacyVitrine(lead);
      const rivals = await rivalsAgent.analyze({ auditId: REPORT_FIXTURE_AUDIT_ID, lead, battlefield, reputation, vitrine });
      const judge = legacyJudge({ lead, reputation, vitrine, battlefield, rivals });
      const strategist = legacyStrategist(lead, judge, battlefield);
      return { auditId: REPORT_FIXTURE_AUDIT_ID, lead, reputation, vitrine, battlefield, rivals, judge, strategist, testFixture: true };
    }

    const live = style === 'phase4-live';
    const reputation = await reputationAgent.analyze(
      lead,
      REPORT_FIXTURE_AUDIT_ID,
      live
        ? {
            config: { enabled: true, apiKey: 'fixture-key-not-real', url: 'https://example.invalid/reviews', maxPages: 1 },
            fetcher: fixtureReviewsFetcher(),
          }
        : {}
    );
    let vitrine: VitrineMetrics = await vitrineAgent.analyze(lead, REPORT_FIXTURE_AUDIT_ID);
    if (live) {
      vitrine = {
        ...vitrine,
        totalPhotosCount: 52,
        ownerPhotosCount: null,
        customerPhotosCount: null,
        totalVideosCount: 3,
        lastMediaUploadedAt: '2025-12-28T00:00:00.000Z',
        daysSinceLastMedia: 4,
        lastPostPublishedAt: '2025-12-30T00:00:00.000Z',
        daysSinceLastPost: 2,
        totalActivePostsLast90Days: 6,
        availability: {
          state: 'FETCHED',
          provider: 'Fonte de teste (fixture)',
          reason: null,
          collectedAt: '2026-01-01T09:00:00.000Z',
          fieldsProvided: ['totalPhotosCount', 'totalVideosCount', 'lastMediaUploadedAt', 'lastPostPublishedAt'],
        },
      };
    }

    const siteCheck = live ? await fixtureSiteCheck() : null;
    const rivals = await rivalsAgent.analyze({ auditId: REPORT_FIXTURE_AUDIT_ID, lead, battlefield, reputation, vitrine });
    const judge = judgeAgent.evaluate({
      auditId: REPORT_FIXTURE_AUDIT_ID,
      lead,
      reputation,
      vitrine,
      battlefield,
      rivals,
      siteCheck,
      syntheticTestData: true,
    });
    const strategist = await strategistAgent.synthesizeStrategy({
      auditId: REPORT_FIXTURE_AUDIT_ID,
      lead,
      reputation,
      vitrine,
      battlefield,
      rivals,
      judge,
      revisionAttempt: 1,
    });

    return { auditId: REPORT_FIXTURE_AUDIT_ID, lead, reputation, vitrine, battlefield, rivals, judge, strategist, testFixture: true };
  } finally {
    console.log = originalLog;
    for (const [name, value] of [
      ['DATAFORSEO_LOGIN', saved.login],
      ['DATAFORSEO_PASSWORD', saved.password],
      ['GMN_REVIEWS_PROVIDER', saved.reviews],
      ['GMN_DEMO_MODE', saved.demo],
    ] as const) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}
