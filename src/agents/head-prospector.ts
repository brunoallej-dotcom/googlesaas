import { randomUUID } from 'crypto';
import type {
  FrontierLead,
  ProspectingInput,
  ProspectingOutput,
  WebsitePresenceStatus,
  WhatsAppPresenceStatus,
} from '@/types/gmn';
import { executeWithRetry } from '@/lib/resilience';
import { resolveBrazilMunicipality } from '@/lib/brazil-municipality';
import { StructuredLogger } from '@/lib/logger';
import { gmnRepository } from '@/lib/supabase';
import { selectUniqueFrontierListings } from './frontier-selection';
import { brazilianPhoneE164, isLikelyBrazilianMobile, safePublicWhatsAppUrl } from '@/lib/whatsapp-contact';

interface RawMapsListingItem {
  readonly place_id: string;
  readonly cid?: string;
  readonly feature_id?: string;
  readonly title: string;
  readonly category?: string;
  readonly additional_categories?: readonly string[];
  readonly rank_absolute: number;
  readonly rating?: {
    readonly value?: number;
    readonly votes_count?: number;
  };
  readonly phone?: string;
  readonly url?: string;
  readonly address?: string;
  readonly is_Addr_hidden?: boolean;
  readonly service_area_business?: boolean;
  readonly latitude: number;
  readonly longitude: number;
  readonly is_claimed?: boolean;
  readonly work_hours?: Record<string, unknown>;
  readonly attributes?: Record<string, unknown>;
  readonly services_count?: number;
  readonly snippet?: string;
}

interface SerperMapsPlaceItem {
  readonly position?: number;
  readonly title?: string;
  readonly address?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly rating?: number;
  readonly ratingCount?: number;
  readonly type?: string;
  readonly types?: readonly string[];
  readonly website?: string;
  readonly phoneNumber?: string;
  readonly openingHours?: Record<string, unknown>;
  readonly cid?: string;
  readonly fid?: string;
  readonly placeId?: string;
}

const SOCIAL_OR_AGGREGATOR_DOMAINS: readonly string[] = [
  'instagram.com',
  'facebook.com',
  'fb.com',
  'linktr.ee',
  'wa.me',
  'wa.link',
  'api.whatsapp.com',
  'doctoralia.com.br',
  'ifood.com.br',
  'getninjas.com.br',
  'solutudo.com.br',
  'guiamais.com.br',
  'apontador.com.br',
  'youtube.com',
  'tiktok.com',
];

/**
 * ============================================================================
 * MÓDULO 1: HEAD AGENT DE PROSPECÇÃO DE FRONTEIRA (SERPER.DEV + DATAFORSEO)
 * Captura exatamente 10 leads quentes localizados na fronteira:
 * - Últimos da 1ª página do GMN (posições 16 a 20)
 * - Primeiros da 2ª página do GMN (posições 21 a 25)
 * Extrai e filtra rigorosamente Nome, Status de WhatsApp e Presença de Site Próprio.
 * ============================================================================
 */
export class HeadProspectorAgent {
  private readonly logger = new StructuredLogger('HEAD_PROSPECTOR');

  public async executeProspecting(input: ProspectingInput): Promise<ProspectingOutput> {
    const campaignId = randomUUID();
    const location = resolveBrazilMunicipality(input.city, input.stateCode || 'GO');
    const cleanCity = location.city;
    const cleanStateCode = location.stateCode;
    const cleanNiche = input.nicheKeyword.trim();
    const centerCoordinates = {
      latitude: location.latitude,
      longitude: location.longitude,
    };

    if (
      input.centerCoordinates &&
      (Math.abs(input.centerCoordinates.latitude - centerCoordinates.latitude) > 0.02 ||
        Math.abs(input.centerCoordinates.longitude - centerCoordinates.longitude) > 0.02)
    ) {
      throw new Error('Coordenadas incompatíveis com a cidade e UF selecionadas.');
    }

    this.logger.info('Iniciando varredura de fronteira GMN (Head Agent)', {
      campaignId,
      city: cleanCity,
      nicheKeyword: cleanNiche,
      centerCoordinates,
    });

    const rawListings = await this.fetchFrontierListingsWithRetry(
      cleanCity,
      cleanStateCode,
      cleanNiche,
      centerCoordinates,
      campaignId
    );

    const frontierCandidates = selectUniqueFrontierListings(rawListings);

    if (frontierCandidates.length < 10) {
      throw new Error(
        `A busca encontrou somente ${frontierCandidates.length} estabelecimentos únicos com ` +
          'identificador válido entre as posições 15 e 40 do Google Maps. ' +
          'Nenhum lead foi salvo. Verifique a paginação e os dados devolvidos pela Serper/DataForSEO.'
      );
    }

    if (frontierCandidates.some((item) => item.rank_absolute > 28)) {
      this.logger.warn('Fronteira estendida após descartar estabelecimentos repetidos', {
        campaignId,
        lastSelectedRank: frontierCandidates[frontierCandidates.length - 1]?.rank_absolute,
      });
    }

    const leads: FrontierLead[] = frontierCandidates.map((item, idx) => {
      const frontierRank = item.rank_absolute ?? 16 + idx;
      const frontierPage: 1 | 2 = frontierRank <= 20 ? 1 : 2;
      const whatsappAnalysis = this.analyzeWhatsAppStatus(item.phone, item.url);
      const websiteAnalysis = this.analyzeWebsiteStatus(item.url);

      return {
        id: randomUUID(),
        campaignId,
        placeId: item.place_id,
        cid: item.cid ?? null,
        featureId: item.feature_id ?? null,
        businessName: item.title.trim(),
        primaryCategory: item.category ?? cleanNiche,
        secondaryCategories: item.additional_categories ?? [],
        frontierRank,
        frontierPage,
        // Sem valor na coleta, nota e avaliações ficam em 0 e são marcadas como desconhecidas
        // (`provenance`): o sistema não inventa mais notas ou totais padrão.
        rating: Number((item.rating?.value ?? 0).toFixed(2)),
        totalReviews: item.rating?.votes_count ?? 0,
        phoneRaw: item.phone ?? null,
        phoneE164: whatsappAnalysis.phoneE164,
        whatsappStatus: whatsappAnalysis.status,
        whatsappUrl: whatsappAnalysis.whatsappUrl,
        websiteStatus: websiteAnalysis.status,
        websiteUrl: websiteAnalysis.cleanUrl,
        addressRaw: item.address ?? null,
        isAddressHidden: Boolean(item.is_Addr_hidden),
        isServiceAreaBusiness: Boolean(item.service_area_business),
        coordinates: {
          latitude: item.latitude,
          longitude: item.longitude,
        },
        claimedByOwner: item.is_claimed ?? false,
        businessHoursConfigured: Boolean(item.work_hours),
        attributesCount: item.attributes ? Object.keys(item.attributes).length : 0,
        servicesListedCount: item.services_count ?? 0,
        descriptionText: item.snippet ?? null,
        createdAt: new Date().toISOString(),
        provenance: {
          claimedByOwner: typeof item.is_claimed === 'boolean' ? 'COLLECTED' : 'UNKNOWN',
          rating: typeof item.rating?.value === 'number' ? 'COLLECTED' : 'UNKNOWN',
          totalReviews: typeof item.rating?.votes_count === 'number' ? 'COLLECTED' : 'UNKNOWN',
          attributesCount: item.attributes ? 'COLLECTED' : 'UNKNOWN',
          servicesListedCount: typeof item.services_count === 'number' ? 'COLLECTED' : 'UNKNOWN',
          businessHoursConfigured: item.work_hours ? 'COLLECTED' : 'UNKNOWN',
        },
      };
    });

    const output: ProspectingOutput = {
      campaignId,
      city: cleanCity,
      stateCode: cleanStateCode,
      nicheKeyword: cleanNiche,
      centerCoordinates,
      leads,
      executedAt: new Date().toISOString(),
    };

    await gmnRepository.saveProspectingCampaign(output);

    this.logger.info('Prospecção de fronteira concluída com 10 leads distintos', {
      campaignId,
      totalLeads: leads.length,
    });

    return output;
  }

  public analyzeWhatsAppStatus(
    phoneRaw?: string,
    urlRaw?: string
  ): {
    status: WhatsAppPresenceStatus;
    phoneE164: string | null;
    whatsappUrl: string | null;
  } {
    const phoneE164 = brazilianPhoneE164(phoneRaw);
    const publicWhatsappUrl = safePublicWhatsAppUrl(urlRaw);

    // "VERIFIED_WHATSAPP" é o valor histórico do banco: ele indica que a
    // ficha fornece um link público, NÃO que o número tem conta ativa validada.
    if (publicWhatsappUrl) {
      return {
        status: 'VERIFIED_WHATSAPP',
        phoneE164,
        whatsappUrl: publicWhatsappUrl,
      };
    }

    if (isLikelyBrazilianMobile(phoneE164)) {
      return {
        status: 'LIKELY_MOBILE_WHATSAPP',
        phoneE164,
        whatsappUrl: `https://wa.me/${phoneE164?.slice(1)}`,
      };
    }

    return {
      status: phoneE164 ? 'LANDLINE_ONLY' : 'MISSING',
      phoneE164,
      whatsappUrl: null,
    };
  }

  public analyzeWebsiteStatus(urlRaw?: string): {
    status: WebsitePresenceStatus;
    cleanUrl: string | null;
  } {
    if (!urlRaw || urlRaw.trim().length === 0) {
      return {
        status: 'MISSING',
        cleanUrl: null,
      };
    }

    try {
      const parsed = new URL(urlRaw.startsWith('http') ? urlRaw : `https://${urlRaw}`);
      const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');

      const isSocialOrAggregator = SOCIAL_OR_AGGREGATOR_DOMAINS.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
      );

      if (isSocialOrAggregator) {
        return {
          status: 'SOCIAL_LINK_ONLY',
          cleanUrl: parsed.toString(),
        };
      }

      return {
        status: 'OWN_DOMAIN',
        cleanUrl: parsed.toString(),
      };
    } catch {
      return {
        status: 'MISSING',
        cleanUrl: null,
      };
    }
  }

  private async fetchFrontierListingsWithRetry(
    city: string,
    stateCode: string,
    nicheKeyword: string,
    center: { latitude: number; longitude: number },
    campaignId: string
  ): Promise<readonly RawMapsListingItem[]> {
    const serperApiKey = process.env.SERPER_API_KEY;
    const serperUrl = process.env.SERPER_MAPS_URL ?? 'https://google.serper.dev/maps';

    let incompleteProviderResult: readonly RawMapsListingItem[] | null = null;

    // 1. Provedor Primário: Serper.dev Google Maps API
    if (
      serperApiKey &&
      serperApiKey.trim().length > 10 &&
      !serperApiKey.includes('cole-sua-api-key')
    ) {
      const serperRetry = await executeWithRetry(
        async () => {
          const llParam = `@${center.latitude},${center.longitude},14z`;
          // Busca Página 1 (posições 1..20) e Página 2 (posições 21..40) em paralelo para capturar a fronteira exata
          const [resPage1, resPage2] = await Promise.all([
            fetch(serperUrl, {
              method: 'POST',
              headers: {
                'X-API-KEY': serperApiKey.trim(),
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                q: `${nicheKeyword} ${city} ${stateCode}`,
                ll: llParam,
                gl: 'br',
                hl: 'pt-br',
                page: 1,
              }),
            }),
            fetch(serperUrl, {
              method: 'POST',
              headers: {
                'X-API-KEY': serperApiKey.trim(),
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                q: `${nicheKeyword} ${city} ${stateCode}`,
                ll: llParam,
                gl: 'br',
                hl: 'pt-br',
                page: 2,
              }),
            }),
          ]);

          if (!resPage1.ok) {
            throw new Error(`Serper.dev Maps Page 1 HTTP ${resPage1.status}`);
          }

          const dataPage1 = (await resPage1.json()) as { places?: SerperMapsPlaceItem[] };
          const dataPage2 = resPage2.ok
            ? ((await resPage2.json()) as { places?: SerperMapsPlaceItem[] })
            : { places: [] };

          const placesP1 = dataPage1.places ?? [];
          const placesP2 = dataPage2.places ?? [];

          const combined: RawMapsListingItem[] = [
            ...placesP1.map((p, i) => this.mapSerperPlaceToListing(p, i + 1, center, nicheKeyword)),
            ...placesP2.map((p, i) =>
              this.mapSerperPlaceToListing(p, 21 + i, center, nicheKeyword)
            ),
          ];

          if (combined.length === 0) {
            throw new Error('Serper.dev retornou lista vazia de places');
          }

          return combined;
        },
        {
          maxAttempts: 3,
          baseDelayMs: 500,
          maxDelayMs: 3000,
          timeoutMs: 12000,
          operationName: 'SerperDev_Frontier_Prospection',
          agent: 'HEAD_PROSPECTOR',
          correlationId: campaignId,
        }
      );

      if (serperRetry.success && serperRetry.data) {
        const uniqueCount = selectUniqueFrontierListings(serperRetry.data).length;
        if (uniqueCount === 10) return serperRetry.data;

        incompleteProviderResult = serperRetry.data;
        this.logger.warn('Serper retornou menos de 10 estabelecimentos distintos; tentando outro provedor', {
          campaignId,
          uniqueCount,
        });
      }
    }

    // 2. Provedor Secundário: DataForSEO Maps API (caso configurado)
    const login = process.env.DATAFORSEO_LOGIN;
    const password = process.env.DATAFORSEO_PASSWORD;
    const baseUrl = process.env.DATAFORSEO_BASE_URL ?? 'https://api.dataforseo.com/v3';

    if (login && password && !login.includes('your-dataforseo-login')) {
      const retryResult = await executeWithRetry(
        async () => {
          const authHeader = Buffer.from(`${login}:${password}`).toString('base64');
          const response = await fetch(`${baseUrl}/serp/google/maps/live/advanced`, {
            method: 'POST',
            headers: {
              Authorization: `Basic ${authHeader}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify([
              {
                keyword: `${nicheKeyword} ${city} ${stateCode}`,
                location_coordinate: `${center.latitude},${center.longitude},14z`,
                language_code: 'pt-BR',
                depth: 35,
              },
            ]),
          });

          if (!response.ok) {
            throw new Error(`DataForSEO HTTP ${response.status}`);
          }

          const json = (await response.json()) as {
            tasks?: Array<{
              result?: Array<{
                items?: RawMapsListingItem[];
              }>;
            }>;
          };

          const items = json.tasks?.[0]?.result?.[0]?.items ?? [];
          if (items.length === 0) {
            throw new Error('DataForSEO retornou lista vazia para a busca de fronteira');
          }
          return items;
        },
        {
          maxAttempts: 3,
          baseDelayMs: 600,
          maxDelayMs: 4000,
          timeoutMs: 12000,
          operationName: 'DataForSEO_Frontier_Prospection',
          agent: 'HEAD_PROSPECTOR',
          correlationId: campaignId,
        }
      );

      if (retryResult.success && retryResult.data) {
        const uniqueCount = selectUniqueFrontierListings(retryResult.data).length;
        if (uniqueCount === 10) return retryResult.data;

        if (
          incompleteProviderResult === null ||
          uniqueCount > selectUniqueFrontierListings(incompleteProviderResult).length
        ) {
          incompleteProviderResult = retryResult.data;
        }
        this.logger.warn('DataForSEO retornou menos de 10 estabelecimentos distintos', {
          campaignId,
          uniqueCount,
        });
      }
    }

    // Nunca retornar empresas simuladas como se fossem leads reais.
    if (process.env.GMN_DEMO_MODE === 'true') {
      this.logger.warn('MODO DEMONSTRAÇÃO: resultados simulados, NÃO são empresas reais', {
        campaignId,
      });
      return this.buildDeterministicFrontierListings(city, nicheKeyword, center);
    }

    if (incompleteProviderResult) return incompleteProviderResult;

    throw new Error(
      'Não foi possível obter resultados reais do Google Maps. ' +
        'Confira SERPER_API_KEY, conectividade e os logs do servidor; ' +
        'configure GMN_DEMO_MODE=true apenas para demonstrações com dados fictícios.'
    );
  }

  private mapSerperPlaceToListing(
    place: SerperMapsPlaceItem,
    absoluteRank: number,
    center: { latitude: number; longitude: number },
    fallbackCategory: string
  ): RawMapsListingItem {
    const hasNoStreetAddress = !place.address || place.address.trim().length < 5;
    return {
      // Sem identidade verificável, o lead é descartado na seleção, não inventado.
      place_id: place.placeId?.trim() || place.cid?.trim() || '',
      cid: place.cid,
      feature_id: place.fid,
      title: place.title ?? `Empresa #${absoluteRank}`,
      category: place.type ?? fallbackCategory,
      additional_categories: place.types ? place.types.slice(1) : [],
      rank_absolute: absoluteRank,
      rating:
        typeof place.rating === 'number' || typeof place.ratingCount === 'number'
          ? { value: place.rating, votes_count: place.ratingCount }
          : undefined,
      phone: place.phoneNumber,
      url: place.website,
      address: place.address,
      is_Addr_hidden: hasNoStreetAddress,
      service_area_business: hasNoStreetAddress,
      latitude: place.latitude ?? center.latitude,
      longitude: place.longitude ?? center.longitude,
      // O Serper não informa reivindicação, atributos nem serviços: ficam ausentes (não verificados).
      work_hours: place.openingHours,
      snippet: `${place.title ?? ''} - ${place.type ?? fallbackCategory}`,
    };
  }

  private buildDeterministicFrontierListings(
    city: string,
    niche: string,
    center: { latitude: number; longitude: number }
  ): readonly RawMapsListingItem[] {
    const templates: Array<{
      suffix: string;
      rank: number;
      rating: number;
      reviews: number;
      phone: string | undefined;
      url: string | undefined;
      hiddenAddress: boolean;
      sab: boolean;
      latOffset: number;
      lngOffset: number;
    }> = [
      {
        suffix: 'Prime Center',
        rank: 16,
        rating: 4.6,
        reviews: 34,
        phone: '(62) 99214-8810',
        url: undefined,
        hiddenAddress: false,
        sab: false,
        latOffset: 0.0042,
        lngOffset: -0.0031,
      },
      {
        suffix: 'Especializada & Atendimento Domiciliar',
        rank: 17,
        rating: 4.8,
        reviews: 29,
        phone: '(62) 99401-2290',
        url: 'https://wa.me/5562994012290',
        hiddenAddress: true,
        sab: true,
        latOffset: -0.0055,
        lngOffset: 0.0048,
      },
      {
        suffix: 'Unidade Centro Sul',
        rank: 18,
        rating: 4.3,
        reviews: 41,
        phone: '(62) 3311-4090',
        url: 'https://www.instagram.com/centro_sul_oficial',
        hiddenAddress: false,
        sab: false,
        latOffset: 0.0029,
        lngOffset: 0.0061,
      },
      {
        suffix: 'Integrada Premium',
        rank: 19,
        rating: 4.5,
        reviews: 22,
        phone: '(62) 98119-3344',
        url: 'https://integradapremium.com.br',
        hiddenAddress: false,
        sab: false,
        latOffset: -0.0038,
        lngOffset: -0.0044,
      },
      {
        suffix: 'Soluções Rápidas 24h (Móvel)',
        rank: 20,
        rating: 4.7,
        reviews: 19,
        phone: '(62) 99612-7701',
        url: undefined,
        hiddenAddress: true,
        sab: true,
        latOffset: 0.0071,
        lngOffset: -0.0022,
      },
      {
        suffix: 'Conceito & Excelência',
        rank: 21,
        rating: 4.2,
        reviews: 15,
        phone: '(62) 98455-1029',
        url: 'https://linktr.ee/conceitoexcelencia',
        hiddenAddress: false,
        sab: false,
        latOffset: -0.0064,
        lngOffset: 0.0035,
      },
      {
        suffix: 'Master Jundiaí',
        rank: 22,
        rating: 4.4,
        reviews: 27,
        phone: '(62) 3324-9981',
        url: 'https://masterjundiai.com.br',
        hiddenAddress: false,
        sab: false,
        latOffset: 0.0051,
        lngOffset: 0.0052,
      },
      {
        suffix: 'Avançada & Diagnósticos',
        rank: 23,
        rating: 4.1,
        reviews: 12,
        phone: undefined,
        url: undefined,
        hiddenAddress: false,
        sab: false,
        latOffset: -0.0021,
        lngOffset: -0.0069,
      },
      {
        suffix: 'Express Atendimento In-Loco',
        rank: 24,
        rating: 4.9,
        reviews: 31,
        phone: '(62) 99188-6540',
        url: 'https://expressinloco.com.br',
        hiddenAddress: true,
        sab: true,
        latOffset: 0.0066,
        lngOffset: 0.0019,
      },
      {
        suffix: 'Vila Santana Tradicional',
        rank: 25,
        rating: 4.3,
        reviews: 24,
        phone: '(62) 99302-5118',
        url: 'https://wa.me/5562993025118',
        hiddenAddress: false,
        sab: false,
        latOffset: -0.0049,
        lngOffset: -0.0051,
      },
    ];

    return templates.map((tpl, index) => {
      const slug = `${city}_${niche}_${tpl.rank}`.toLowerCase().replace(/[^a-z0-9]/g, '_');
      return {
        place_id: `ChIJ_GMN_FRONTIER_${slug}_${index + 1}`,
        cid: (104928374619283000n + BigInt(index)).toString(),
        feature_id: `0x935ea4_${index + 1}`,
        title: `${niche} ${tpl.suffix} - ${city}`,
        category: niche,
        additional_categories: [`Especialista em ${niche}`, 'Atendimento Regional'],
        rank_absolute: tpl.rank,
        rating: {
          value: tpl.rating,
          votes_count: tpl.reviews,
        },
        phone: tpl.phone,
        url: tpl.url,
        address: tpl.hiddenAddress
          ? `Atendimento móvel em ${city} - Endereço Oculto (SAB)`
          : `Av. Comercial nº ${110 + index * 45}, Centro, ${city}`,
        is_Addr_hidden: tpl.hiddenAddress,
        service_area_business: tpl.sab,
        latitude: Number((center.latitude + tpl.latOffset).toFixed(6)),
        longitude: Number((center.longitude + tpl.lngOffset).toFixed(6)),
        is_claimed: index !== 7,
        work_hours: index !== 8 ? { monday: '08:00-18:00' } : undefined,
        attributes: { acessibilidade: true, pagamento_pix: true },
        services_count: index % 2 === 0 ? 6 : 2,
        snippet: `Referência em ${niche} na região de ${city}, focada em qualidade e agilidade.`,
      };
    });
  }
}

export const headProspectorAgent = new HeadProspectorAgent();
