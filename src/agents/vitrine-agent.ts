import type {
  FrontierLead,
  GooglePostMetadata,
  MediaItemMetadata,
  VitrineMetrics,
} from '@/types/gmn';
import { StructuredLogger } from '@/lib/logger';
import { isDemoMode } from '@/lib/evidence/types';

const UNAVAILABLE_REASON =
  'Nenhuma fonte contratada informa fotos, vídeos nem publicações: o Serper Maps não expõe esses dados e eles só existem no painel do proprietário. Informação não verificada.';

/**
 * ============================================================================
 * AGENTE 2: VITRINE
 * Fotos, vídeos, datas de mídia e publicações (Google Posts).
 *
 * Fase 4: nenhuma fonte pública configurada fornece esses dados para um perfil arbitrário. O Serper
 * Maps não os expõe e as demais informações só existem no painel do proprietário (Business Profile
 * API, com OAuth). Por isso o agente devolve apenas o que uma fonte real informou; todo o resto fica
 * `null` ("não verificado"). Os dados fictícios antigos existem somente com GMN_DEMO_MODE=true.
 * ============================================================================
 */
export class VitrineAgent {
  private readonly logger = new StructuredLogger('VITRINE');

  public async analyze(lead: FrontierLead, auditId: string): Promise<VitrineMetrics> {
    this.logger.info('Iniciando coleta de Vitrine (fotos, vídeos, mídia e posts)', {
      auditId,
      placeId: lead.placeId,
    });

    const now = new Date().toISOString();
    // Decisão de infraestrutura (16/10/2026): sem DataForSEO nem Business Profile API e sem novos
    // serviços pagos. O Serper Maps não informa fotos, vídeos nem publicações; portanto estes dados
    // ficam NÃO VERIFICADOS, sem simulação, até existir uma fonte autorizada.
    const provider = { reason: UNAVAILABLE_REASON } as const;

    if (isDemoMode()) {
      this.logger.warn('MODO DEMONSTRAÇÃO: Vitrine SIMULADA, não representa o perfil real', { auditId });
      return this.buildDemoVitrine(lead, now);
    }

    this.logger.info('Vitrine indisponível: nenhuma fonte real forneceu os dados', {
      auditId,
      placeId: lead.placeId,
      reason: provider.reason,
    });

    return {
      placeId: lead.placeId,
      totalPhotosCount: null,
      ownerPhotosCount: null,
      customerPhotosCount: null,
      totalVideosCount: null,
      hasCoverPhoto: null,
      hasLogoPhoto: null,
      lastMediaUploadedAt: null,
      daysSinceLastMedia: null,
      lastPostPublishedAt: null,
      daysSinceLastPost: null,
      totalActivePostsLast90Days: null,
      latestPost: null,
      mediaGallerySample: [],
      extractedAt: now,
      availability: {
        state: 'UNAVAILABLE',
        provider: null,
        reason: provider.reason,
        collectedAt: now,
        fieldsProvided: [],
      },
    };
  }

  private buildDemoVitrine(lead: FrontierLead, now: string): VitrineMetrics {
    const demo = this.buildDeterministicVitrinePayload(lead);
    const photos = demo.mediaGallery.filter((m) => m.mediaType === 'PHOTO');
    const sorted = [...demo.mediaGallery].sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    );
    const newest = sorted[0] ?? null;
    return {
      placeId: lead.placeId,
      totalPhotosCount: photos.length,
      ownerPhotosCount: photos.filter((m) => m.source === 'OWNER').length,
      customerPhotosCount: photos.filter((m) => m.source === 'CUSTOMER').length,
      totalVideosCount: demo.mediaGallery.filter((m) => m.mediaType === 'VIDEO').length,
      hasCoverPhoto: demo.mediaGallery.some((m) => m.categoryTag === 'COVER'),
      hasLogoPhoto: demo.mediaGallery.some((m) => m.categoryTag === 'LOGO'),
      lastMediaUploadedAt: newest?.uploadedAt ?? null,
      daysSinceLastMedia: newest
        ? Math.max(0, Math.floor((Date.now() - new Date(newest.uploadedAt).getTime()) / 86_400_000))
        : null,
      lastPostPublishedAt: demo.latestPost?.publishedAt ?? null,
      daysSinceLastPost: demo.latestPost?.daysSincePublished ?? null,
      totalActivePostsLast90Days: demo.totalActivePostsLast90Days,
      latestPost: demo.latestPost,
      mediaGallerySample: sorted.slice(0, 8),
      extractedAt: now,
      availability: {
        state: 'FETCHED',
        provider: 'DEMONSTRAÇÃO (dados simulados)',
        reason: 'GMN_DEMO_MODE=true: dados fictícios identificados como simulados.',
        collectedAt: now,
        fieldsProvided: [],
      },
    };
  }

  /** Somente modo demonstração e fixtures de teste: gera mídias FICTÍCIAS (ids `med_<placeId>_`). */
  public buildDeterministicVitrinePayload(lead: FrontierLead): {
    mediaGallery: readonly MediaItemMetadata[];
    latestPost: GooglePostMetadata | null;
    totalActivePostsLast90Days: number;
  } {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    const mediaGallery: MediaItemMetadata[] = [
      {
        mediaId: `med_${lead.placeId}_cover`,
        url: `https://lh3.googleusercontent.com/p/${lead.placeId}_cover_w1200`,
        mediaType: 'PHOTO',
        source: 'OWNER',
        categoryTag: 'COVER',
        uploadedAt: new Date(now - 46 * dayMs).toISOString(),
        resolutionWidth: 1200,
        resolutionHeight: 900,
      },
      {
        mediaId: `med_${lead.placeId}_logo`,
        url: `https://lh3.googleusercontent.com/p/${lead.placeId}_logo_w500`,
        mediaType: 'PHOTO',
        source: 'OWNER',
        categoryTag: 'LOGO',
        uploadedAt: new Date(now - 120 * dayMs).toISOString(),
        resolutionWidth: 500,
        resolutionHeight: 500,
      },
      {
        mediaId: `med_${lead.placeId}_owner_1`,
        url: `https://lh3.googleusercontent.com/p/${lead.placeId}_int_01`,
        mediaType: 'PHOTO',
        source: 'OWNER',
        categoryTag: 'INTERIOR',
        uploadedAt: new Date(now - 52 * dayMs).toISOString(),
        resolutionWidth: 1600,
        resolutionHeight: 1200,
      },
      {
        mediaId: `med_${lead.placeId}_owner_2`,
        url: `https://lh3.googleusercontent.com/p/${lead.placeId}_team_01`,
        mediaType: 'PHOTO',
        source: 'OWNER',
        categoryTag: 'TEAM',
        uploadedAt: new Date(now - 68 * dayMs).toISOString(),
        resolutionWidth: 1600,
        resolutionHeight: 1200,
      },
      {
        mediaId: `med_${lead.placeId}_owner_3`,
        url: `https://lh3.googleusercontent.com/p/${lead.placeId}_prod_01`,
        mediaType: 'PHOTO',
        source: 'OWNER',
        categoryTag: 'PRODUCT',
        uploadedAt: new Date(now - 84 * dayMs).toISOString(),
        resolutionWidth: 1280,
        resolutionHeight: 960,
      },
      {
        mediaId: `med_${lead.placeId}_cust_1`,
        url: `https://lh3.googleusercontent.com/p/${lead.placeId}_cust_01`,
        mediaType: 'PHOTO',
        source: 'CUSTOMER',
        categoryTag: 'GENERAL',
        uploadedAt: new Date(now - 39 * dayMs).toISOString(),
        resolutionWidth: 1080,
        resolutionHeight: 1920,
      },
      {
        mediaId: `med_${lead.placeId}_cust_2`,
        url: `https://lh3.googleusercontent.com/p/${lead.placeId}_cust_02`,
        mediaType: 'PHOTO',
        source: 'CUSTOMER',
        categoryTag: 'EXTERIOR',
        uploadedAt: new Date(now - 61 * dayMs).toISOString(),
        resolutionWidth: 1080,
        resolutionHeight: 1350,
      },
      {
        mediaId: `med_${lead.placeId}_cust_3`,
        url: `https://lh3.googleusercontent.com/p/${lead.placeId}_cust_03`,
        mediaType: 'PHOTO',
        source: 'CUSTOMER',
        categoryTag: 'PRODUCT',
        uploadedAt: new Date(now - 95 * dayMs).toISOString(),
        resolutionWidth: 1440,
        resolutionHeight: 1080,
      },
      {
        mediaId: `med_${lead.placeId}_video_1`,
        url: `https://lh3.googleusercontent.com/p/${lead.placeId}_vid_01.mp4`,
        mediaType: 'VIDEO',
        source: 'OWNER',
        categoryTag: 'INTERIOR',
        uploadedAt: new Date(now - 74 * dayMs).toISOString(),
        resolutionWidth: 1920,
        resolutionHeight: 1080,
      },
    ];

    const latestPostDaysAgo = 54;
    const latestPost: GooglePostMetadata = {
      postId: `post_${lead.placeId}_latest`,
      postType: 'UPDATE',
      summaryText: `Agende seu atendimento especializado em ${lead.primaryCategory} com condições exclusivas nesta semana.`,
      mediaUrl: `https://lh3.googleusercontent.com/p/${lead.placeId}_post_cover`,
      callToActionType: 'CALL',
      publishedAt: new Date(now - latestPostDaysAgo * dayMs).toISOString(),
      daysSincePublished: latestPostDaysAgo,
    };

    return {
      mediaGallery,
      latestPost,
      totalActivePostsLast90Days: 1,
    };
  }
}

export const vitrineAgent = new VitrineAgent();
