import type { SiteCheckOutcome } from './site-access';
import { assessSiteAccess } from './site-access';
import type { Evidence } from '../evidence';
import type { MapsIdentifiers } from '../maps-link';
import type { CriterionId } from '../methodology';
import { assertSafeUrlShape } from '../../url-safety';
import { isSanitizedUrl, redactUrlsInText, sanitizeUrl } from '../url-redaction';
import { MAPS_ORIGIN_LIMITATION } from './capabilities';
import { cleanText, type MapsPlace } from './maps-place';

/*
 * Adaptadores PUROS: transformam o que as fontes devolvem em evidências. Regras:
 *  - nada de site, Instagram ou outra fonte externa vira confirmação de recurso nativo do Google;
 *  - campo ausente ou não entregue pela fonte => NOT_VERIFIED com limitação (nunca NOT_FOUND, nunca zero);
 *  - toda URL de fonte passa por `sanitizeUrl`; textos de fontes externas são limpos de controle/bidi.
 */

export interface AdapterContext {
  /** Link do perfil no Google Maps, montado a partir dos identificadores CONFIRMADOS pelo operador. */
  readonly profileUrl: string;
  /** Momento da consulta (ISO). */
  readonly consultedAt: string;
}

type Draft = Omit<Evidence, 'consultedAt'> & { consultedAt?: string };

/** Motivo/limitação vindo de fora: limpo, sem segredos e dentro do limite de 2000 caracteres do esquema. */
export function capText(value: string, max = 1500): string {
  return cleanText(redactUrlsInText(value), max) ?? 'motivo indisponível';
}

const list = <T>(value: readonly T[] | null | undefined): readonly T[] => (Array.isArray(value) ? value : []);

function finish(draft: Draft, ctx: AdapterContext): Evidence {
  const { consultedAt, ...rest } = draft;
  return { ...rest, consultedAt: consultedAt ?? ctx.consultedAt } as Evidence;
}

/** Link do perfil derivado dos identificadores do operador (nunca do que a fonte devolveu). */
export function profileUrlFrom(ids: MapsIdentifiers): string | null {
  if (ids.cid) return `https://www.google.com/maps?cid=${ids.cid}`;
  if (ids.featureId) return `https://www.google.com/maps?ftid=${ids.featureId}`;
  if (ids.placeId) return `https://www.google.com/maps/place/?q=place_id:${ids.placeId}`;
  return null;
}

export function formatRating(value: number): string {
  return String(value).replace('.', ',');
}

/** Telefone comparável: só dígitos, sem o código do país 55. Nenhum outro "ajuste" é feito. */
export function comparablePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 12 && digits.startsWith('55') ? digits.slice(2) : digits;
}

// ---------------------------------------------------------------------------------------------------
// Serper /maps
// ---------------------------------------------------------------------------------------------------

interface MapsFieldSpec {
  readonly id: string;
  readonly attribute: string;
  readonly criterionId: CriterionId;
  readonly label: string;
  readonly missing: string;
  readonly value: (place: MapsPlace) => string | null;
}

const MAPS_FIELDS: readonly MapsFieldSpec[] = [
  { id: 'maps-name', attribute: 'profile_name', criterionId: 'NAP', label: 'Nome exibido no perfil', missing: 'nome', value: (p) => p.title },
  { id: 'maps-address', attribute: 'profile_address', criterionId: 'NAP', label: 'Endereço exibido no perfil', missing: 'endereço', value: (p) => p.address },
  { id: 'maps-phone', attribute: 'profile_phone', criterionId: 'NAP', label: 'Telefone exibido no perfil', missing: 'telefone', value: (p) => p.phone },
  {
    id: 'maps-hours',
    attribute: 'profile_opening_hours',
    criterionId: 'NAP',
    label: 'Horários exibidos no perfil',
    missing: 'horários',
    value: (p) => (p.openingHours.length > 0 ? p.openingHours.map(([day, hours]) => `${day}: ${hours}`).join('; ') : null),
  },
  {
    id: 'maps-category',
    attribute: 'google_categories',
    criterionId: 'CATEGORIES',
    label: 'Categoria principal exibida no perfil',
    missing: 'categoria principal',
    value: (p) => p.category,
  },
  {
    id: 'maps-rating',
    attribute: 'google_reviews',
    criterionId: 'REVIEWS',
    label: 'Nota média exibida no perfil',
    missing: 'nota média',
    value: (p) => (p.rating === null ? null : formatRating(p.rating)),
  },
  {
    id: 'maps-review-count',
    attribute: 'google_reviews',
    criterionId: 'REVIEWS',
    label: 'Quantidade de avaliações exibida no perfil',
    missing: 'quantidade de avaliações',
    value: (p) => (p.ratingCount === null ? null : String(p.ratingCount)),
  },
];

/**
 * Evidências dos campos que o Serper /maps entrega. `place` nulo = perfil não localizado/ambíguo/não
 * consultado: todos os campos ficam NOT_VERIFIED com o motivo.
 */
export function mapsEvidences(place: MapsPlace | null, ctx: AdapterContext, fetchedAt: string | null, unavailableReason: string): Evidence[] {
  const evidences: Evidence[] = [];
  for (const spec of MAPS_FIELDS) {
    const value = place ? spec.value(place) : null;
    if (place && value !== null) {
      evidences.push(
        finish(
          {
            id: spec.id,
            attribute: spec.attribute,
            criterionId: spec.criterionId,
            claim: `${spec.label}: ${value}`,
            status: 'VERIFIED',
            origin: 'GOOGLE_NATIVE',
            sourceUrl: ctx.profileUrl,
            consultedAt: fetchedAt ?? ctx.consultedAt,
            limitation: MAPS_ORIGIN_LIMITATION,
          },
          ctx,
        ),
      );
    } else {
      evidences.push(
        finish(
          {
            id: spec.id,
            attribute: spec.attribute,
            criterionId: spec.criterionId,
            claim: `${spec.label}: não verificado.`,
            status: 'NOT_VERIFIED',
            origin: 'GOOGLE_NATIVE',
            sourceUrl: ctx.profileUrl,
            consultedAt: fetchedAt ?? ctx.consultedAt,
            limitation: place ? `A fonte não informou ${spec.missing} nesta consulta (não é prova de que o campo não existe no perfil).` : capText(unavailableReason),
          },
          ctx,
        ),
      );
    }
  }
  // Só a categoria principal é tratada como comprovada; a lista de categorias adicionais nunca é afirmada completa.
  const extras = place?.secondaryCategories ?? [];
  evidences.push(
    finish(
      {
        id: 'maps-secondary-categories',
        attribute: 'google_categories',
        criterionId: 'CATEGORIES',
        claim: extras.length > 0 ? `Categorias adicionais informadas pela fonte (completude não comprovada): ${extras.join(', ')}` : 'Categorias adicionais: não verificado.',
        status: 'NOT_VERIFIED',
        origin: 'GOOGLE_NATIVE',
        sourceUrl: ctx.profileUrl,
        consultedAt: fetchedAt ?? ctx.consultedAt,
        limitation: place
          ? 'A fonte não comprova a lista completa de categorias adicionais do perfil.'
          : capText(unavailableReason),
      },
      ctx,
    ),
  );
  return evidences;
}

interface UnavailableSpec {
  readonly id: string;
  readonly attribute: string;
  readonly criterionId: CriterionId;
  readonly label: string;
}

const UNAVAILABLE_FIELDS: readonly UnavailableSpec[] = [
  { id: 'unavailable-review-recency', attribute: 'google_reviews', criterionId: 'REVIEWS', label: 'Recência e contexto das avaliações' },
  { id: 'unavailable-review-replies', attribute: 'google_review_replies', criterionId: 'REVIEW_REPLIES', label: 'Respostas do dono às avaliações' },
  { id: 'unavailable-posts', attribute: 'google_posts', criterionId: 'POSTS_ACTIVITY', label: 'Google Posts e atividade nativa' },
  { id: 'unavailable-photos', attribute: 'google_profile_photos', criterionId: 'VISUALS', label: 'Fotos do perfil' },
  { id: 'unavailable-videos', attribute: 'google_profile_videos', criterionId: 'VISUALS', label: 'Vídeos do perfil' },
  { id: 'unavailable-services', attribute: 'google_services', criterionId: 'SERVICES', label: 'Serviços cadastrados no Google' },
  { id: 'unavailable-attributes', attribute: 'google_attributes', criterionId: 'SERVICES', label: 'Atributos do perfil' },
  { id: 'unavailable-products', attribute: 'google_products', criterionId: 'SERVICES', label: 'Produtos nativos do perfil' },
];

/** Estados possíveis da coleta de avaliações datadas (endpoint cujo formato ainda não foi confirmado). */
export type ReviewsNote =
  | { readonly kind: 'NOT_RUN'; readonly reason: string }
  | { readonly kind: 'RECEIVED_UNCONFIRMED_FORMAT'; readonly pages: number }
  | { readonly kind: 'FAILED'; readonly reason: string };

function reviewsLimitation(note: ReviewsNote): string {
  switch (note.kind) {
    case 'NOT_RUN':
      return `Coleta de avaliações datadas não executada: ${capText(note.reason, 600)}`;
    case 'FAILED':
      return `Coleta de avaliações datadas falhou: ${capText(note.reason, 600)}`;
    case 'RECEIVED_UNCONFIRMED_FORMAT':
      return `A resposta do endpoint de avaliações (${note.pages} página(s)) foi recebida, mas o formato ainda NÃO foi confirmado; nenhum valor dela foi usado como evidência.`;
  }
}

/**
 * Campos que a fonte consultada não disponibiliza (ou cujo formato não foi confirmado): sempre
 * NOT_VERIFIED. Para avaliações datadas e respostas, o motivo depende do que ocorreu com o /reviews.
 */
export function unavailableEvidences(ctx: AdapterContext, reviews: ReviewsNote): Evidence[] {
  return UNAVAILABLE_FIELDS.map((spec) => {
    const reviewDependent = spec.id === 'unavailable-review-recency' || spec.id === 'unavailable-review-replies';
    return finish(
      {
        id: spec.id,
        attribute: spec.attribute,
        criterionId: spec.criterionId,
        claim: `${spec.label}: não verificado.`,
        status: 'NOT_VERIFIED',
        origin: 'GOOGLE_NATIVE',
        sourceUrl: ctx.profileUrl,
        limitation: reviewDependent ? reviewsLimitation(reviews) : 'A fonte consultada (Serper /maps) não disponibiliza este dado; o perfil nativo não foi aberto diretamente.',
      },
      ctx,
    );
  });
}

// ---------------------------------------------------------------------------------------------------
// Site e presença externa
// ---------------------------------------------------------------------------------------------------

const SOCIAL_OR_AGGREGATOR_DOMAINS: readonly string[] = [
  'instagram.com', 'facebook.com', 'fb.com', 'linkedin.com', 'tiktok.com', 'youtube.com', 'x.com', 'twitter.com',
  'wa.me', 'wa.link', 'api.whatsapp.com', 'linktr.ee', 'beacons.ai',
];

export type WebsiteKind = 'NONE' | 'INVALID' | 'SOCIAL_OR_AGGREGATOR' | 'OWN';

export function websiteKindOf(raw: string | null): { readonly kind: WebsiteKind; readonly url: string | null; readonly host: string | null } {
  if (!raw) return { kind: 'NONE', url: null, host: null };
  try {
    const { hostname } = assertSafeUrlShape(raw);
    const url = sanitizeUrl(raw);
    const social = SOCIAL_OR_AGGREGATOR_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    return { kind: social ? 'SOCIAL_OR_AGGREGATOR' : 'OWN', url, host: hostname };
  } catch {
    return { kind: 'INVALID', url: null, host: null };
  }
}

/** Evidências sobre o site informado no perfil (campo do perfil + o que foi observado no próprio site). */
export function websiteEvidences(
  website: ReturnType<typeof websiteKindOf>,
  ctx: AdapterContext,
  fetchedAt: string | null,
): Evidence[] {
  const consultedAt = fetchedAt ?? ctx.consultedAt;
  if (website.kind === 'NONE') {
    return [
      finish(
        {
          id: 'maps-website',
          attribute: 'profile_website',
          criterionId: 'CONVERSION',
          claim: 'Site informado no perfil: não verificado.',
          status: 'NOT_VERIFIED',
          origin: 'GOOGLE_NATIVE',
          sourceUrl: ctx.profileUrl,
          consultedAt,
          limitation: 'A fonte não informou site nesta consulta (não é prova de que o perfil não tem site).',
        },
        ctx,
      ),
    ];
  }
  if (website.kind === 'INVALID') {
    return [
      finish(
        {
          id: 'maps-website',
          attribute: 'profile_website',
          criterionId: 'CONVERSION',
          claim: 'Site informado no perfil: valor inválido ou inseguro, descartado.',
          status: 'NOT_VERIFIED',
          origin: 'GOOGLE_NATIVE',
          sourceUrl: ctx.profileUrl,
          consultedAt,
          limitation: 'O endereço informado pela fonte não é um link http(s) público válido.',
        },
        ctx,
      ),
    ];
  }
  const social = website.kind === 'SOCIAL_OR_AGGREGATOR';
  const evidences: Evidence[] = [
    finish(
      {
        id: 'maps-website',
        attribute: 'profile_website',
        criterionId: 'CONVERSION',
        claim: `Site informado no perfil: ${(website.url ?? '').slice(0, 1500)}${social ? ' (rede social ou agregador, não é um site próprio)' : ''}`,
        status: 'VERIFIED',
        origin: 'GOOGLE_NATIVE',
        sourceUrl: ctx.profileUrl,
        consultedAt,
        limitation: MAPS_ORIGIN_LIMITATION,
      },
      ctx,
    ),
  ];
  if (social && website.url && isSanitizedUrl(website.url)) {
    evidences.push(
      finish(
        {
          id: 'external-presence',
          attribute: 'external_social_presence',
          criterionId: 'LOCAL_AUTHORITY',
          claim: `Presença digital externa: o perfil aponta para ${website.host}; o conteúdo dessa página não foi coletado.`,
          status: 'NOT_VERIFIED',
          origin: 'OFFICIAL_SOCIAL',
          sourceUrl: website.url,
          consultedAt,
          limitation: 'Nenhuma rede social foi visitada nesta etapa.',
          nativeContext: 'O endereço informado é de rede social ou agregador; isso não prova Google Posts, fotos ou serviços cadastrados no Google.',
        },
        ctx,
      ),
    );
  }
  return evidences;
}

/** Perfil não localizado: o campo "site" também fica NOT_VERIFIED, com o motivo. */
export function unlocatedWebsiteEvidence(ctx: AdapterContext, reason: string): Evidence {
  return finish(
    {
      id: 'maps-website',
      attribute: 'profile_website',
      criterionId: 'CONVERSION',
      claim: 'Site informado no perfil: não verificado.',
      status: 'NOT_VERIFIED',
      origin: 'GOOGLE_NATIVE',
      sourceUrl: ctx.profileUrl,
      limitation: reason,
    },
    ctx,
  );
}

export function noExternalPresenceEvidence(ctx: AdapterContext, reason: string): Evidence {
  return finish(
    {
      id: 'external-presence',
      attribute: 'external_social_presence',
      criterionId: 'LOCAL_AUTHORITY',
      claim: 'Presença digital externa e autoridade local: não verificado.',
      status: 'NOT_VERIFIED',
      origin: 'OFFICIAL_SOCIAL',
      limitation: reason,
    },
    ctx,
  );
}

/** Observações feitas no PRÓPRIO site (origem OFFICIAL_SITE). Nunca comprovam recursos nativos do Google. */
export function siteEvidences(result: SiteCheckOutcome, profilePhone: string | null, ctx: AdapterContext): Evidence[] {
  const siteLimitation = 'Observação do site oficial; não comprova recursos cadastrados no Google.';
  const safeSource = (...candidates: (string | null)[]): string | undefined => {
    for (const candidate of candidates) {
      if (!candidate) continue;
      const clean = sanitizeUrl(candidate);
      try {
        assertSafeUrlShape(clean);
        if (isSanitizedUrl(clean)) return clean;
      } catch {
        // tenta o próximo candidato
      }
    }
    return undefined;
  };
  const source = safeSource(result.finalUrl, result.requestedUrl);
  const consultedAt = result.checkedAt;

  if (result.status !== 'OK' || !source) {
    const assessment = assessSiteAccess(result);
    const reason = result.failureReason ? capText(result.failureReason, 800) : `status ${result.status}`;
    return [
      finish(
        {
          id: 'site-reachable',
          attribute: 'site_reachable',
          criterionId: 'CONVERSION',
          claim: 'Site oficial: não foi possível verificar.',
          status: 'NOT_VERIFIED',
          origin: 'OFFICIAL_SITE',
          ...(source ? { sourceUrl: source } : {}),
          consultedAt,
          limitation: `Verificação técnica do site não concluída (${assessment.class}): ${assessment.note} [detalhe técnico: ${reason}]`.slice(0, 1900),
        },
        ctx,
      ),
    ];
  }

  const evidences: Evidence[] = [
    finish(
      {
        id: 'site-reachable',
        attribute: 'site_reachable',
        criterionId: 'CONVERSION',
        claim: `O site respondeu com HTTP ${result.httpStatus ?? '?'} após ${list(result.redirects).length} redirecionamento(s).`,
        status: 'VERIFIED',
        origin: 'OFFICIAL_SITE',
        sourceUrl: source,
        consultedAt,
        limitation: siteLimitation,
      },
      ctx,
    ),
    finish(
      {
        id: 'site-contact-channels',
        attribute: 'site_contact_channels',
        criterionId: 'CONVERSION',
        claim: `Links na página inicial: ${list(result.telLinks).length} de telefone, ${list(result.whatsappLinks).length} de WhatsApp e ${list(result.emailLinks).length} de e-mail.`,
        status: 'VERIFIED',
        origin: 'OFFICIAL_SITE',
        sourceUrl: source,
        consultedAt,
        limitation: siteLimitation,
      },
      ctx,
    ),
  ];
  if (result.noindex !== null) {
    evidences.push(
      finish(
        {
          id: 'site-indexing',
          attribute: 'site_indexing_directives',
          criterionId: 'CONVERSION',
          claim: `Diretiva noindex: ${result.noindex ? 'presente' : 'ausente'}; robots.txt para a raiz: ${result.robotsTxt}.`,
          status: 'VERIFIED',
          origin: 'OFFICIAL_SITE',
          sourceUrl: source,
          consultedAt,
          limitation: `${siteLimitation} Não prova que a página está indexada.`,
        },
        ctx,
      ),
    );
  }
  if (result.localBusiness && list(result.localBusiness.types).length > 0) {
    const types = list(result.localBusiness.types).map((type) => cleanText(type, 60)).filter((type): type is string => type !== null).slice(0, 8);
    if (types.length > 0) {
      evidences.push(
        finish(
          {
            id: 'site-declared-types',
            attribute: 'site_declared_business_types',
            criterionId: 'SERVICES',
            claim: `O site declara os tipos schema.org: ${types.join(', ')}.`,
            status: 'VERIFIED',
            origin: 'OFFICIAL_SITE',
            sourceUrl: source,
            consultedAt,
            limitation: 'Tipos declarados pelo site; não são os serviços cadastrados no Google.',
          },
          ctx,
        ),
      );
    }
  }

  const sitePhones = [
    ...list(result.telLinks),
    ...(result.localBusiness?.telephone ? [result.localBusiness.telephone] : []),
  ]
    .map(comparablePhone)
    .filter((digits) => digits.length >= 8);
  if (profilePhone && sitePhones.length > 0) {
    const wanted = comparablePhone(profilePhone);
    const same = sitePhones.includes(wanted);
    evidences.push(
      finish(
        {
          id: 'phone-consistency',
          attribute: 'phone_consistency',
          criterionId: 'NAP',
          claim: same
            ? 'O telefone exibido no perfil coincide com um telefone publicado no site.'
            : 'O telefone exibido no perfil NÃO coincide com os telefones publicados no site.',
          // Divergência é um achado a conferir, não uma confirmação: o critério NAP não fica "verificado" com ela.
          status: same ? 'VERIFIED' : 'NOT_VERIFIED',
          origin: 'OFFICIAL_SITE',
          sourceUrl: source,
          consultedAt,
          limitation: same
            ? 'Comparação só de dígitos (sem código 55); considera apenas telefones presentes na página inicial.'
            : 'Divergência observada entre o telefone do perfil e os do site (comparação só de dígitos, sem código 55): requer conferência do operador.',
        },
        ctx,
      ),
    );
  } else {
    evidences.push(
      finish(
        {
          id: 'phone-consistency',
          attribute: 'phone_consistency',
          criterionId: 'NAP',
          claim: 'Coerência de telefone entre perfil e site: não verificada.',
          status: 'NOT_VERIFIED',
          origin: 'OFFICIAL_SITE',
          sourceUrl: source,
          consultedAt,
          limitation: profilePhone ? 'O site não publicou telefone na página inicial.' : 'O perfil não informou telefone nesta consulta.',
        },
        ctx,
      ),
    );
  }
  return evidences;
}
