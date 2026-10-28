import type { SiteCheckOutcome } from './site-access';
import { assessSiteAccess } from './site-access';
import { comparablePhone } from './adapters';
import { cleanText, type MapsPlace } from './maps-place';
import type { Divergence, ProfileSummary, SiteObservation } from './types';
import { sanitizeUrl } from '../url-redaction';

/*
 * Resumos estruturados do que cada fonte devolveu e divergências entre fontes (Onda 4B). Puro.
 * Os dados do perfil (Serper /maps) e os do site ficam SEPARADOS; nada aqui promove dado do site a dado nativo.
 */

const list = <T>(value: readonly T[] | null | undefined): readonly T[] => (Array.isArray(value) ? value : []);

export function profileSummary(place: MapsPlace): ProfileSummary {
  return {
    name: place.title,
    address: place.address,
    phone: place.phone,
    website: place.website ? sanitizeUrl(place.website) : null,
    category: place.category,
    secondaryCategories: place.secondaryCategories,
    rating: place.rating,
    ratingCount: place.ratingCount,
    openingHours: place.openingHours,
  };
}

export function siteObservation(result: SiteCheckOutcome): SiteObservation {
  const assessment = assessSiteAccess(result);
  return {
    requestedUrl: result.requestedUrl ? sanitizeUrl(result.requestedUrl) : null,
    finalUrl: result.finalUrl ? sanitizeUrl(result.finalUrl) : null,
    status: String(result.status),
    httpStatus: typeof result.httpStatus === 'number' ? result.httpStatus : null,
    redirects: list(result.redirects).length,
    checkedAt: result.checkedAt,
    noindex: typeof result.noindex === 'boolean' ? result.noindex : null,
    robotsTxt: String(result.robotsTxt),
    accessClass: assessment.class,
    accessNote: assessment.note,
    httpRequests: result.access ? result.access.requests : null,
    authChallenge: result.access ? result.access.authChallenge : null,
    telLinks: list(result.telLinks).length,
    whatsappLinks: list(result.whatsappLinks).length,
    emailLinks: list(result.emailLinks).length,
    declaredName: cleanText(result.localBusiness?.name, 200),
    declaredTelephone: cleanText(result.localBusiness?.telephone, 40),
    declaredTypes: list(result.localBusiness?.types).map((type) => cleanText(type, 60)).filter((type): type is string => type !== null).slice(0, 8),
  };
}

const plain = (value: string): string =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Diferenças ENTRE as fontes (telefone, nome, domínio). Divergência não é erro nem nota: é um achado a conferir. */
export function divergences(profile: ProfileSummary | null, site: SiteObservation | null, siteTelLinks: readonly string[]): Divergence[] {
  if (!profile || !site || site.status !== 'OK') return [];
  const found: Divergence[] = [];

  const sitePhones = [...siteTelLinks, ...(site.declaredTelephone ? [site.declaredTelephone] : [])]
    .map((phone) => cleanText(phone, 40))
    .filter((phone): phone is string => phone !== null && comparablePhone(phone).length >= 8);
  if (profile.phone && sitePhones.length > 0) {
    const wanted = comparablePhone(profile.phone);
    if (!sitePhones.map(comparablePhone).includes(wanted)) {
      found.push({
        field: 'telefone',
        googleMaps: profile.phone,
        site: sitePhones.slice(0, 3).join(', ').slice(0, 200),
        note: 'Os telefones divergem (comparação só de dígitos, sem o código 55); requer conferência do operador.',
      });
    }
  }

  if (profile.name && site.declaredName) {
    const a = plain(profile.name);
    const b = plain(site.declaredName);
    if (a.length >= 3 && b.length >= 3 && !a.includes(b) && !b.includes(a)) {
      found.push({
        field: 'nome',
        googleMaps: profile.name,
        site: site.declaredName,
        note: 'O nome do perfil e o nome declarado no site não coincidem nem se contêm; pode ser nome fantasia × razão social.',
      });
    }
  }

  const profileHost = hostOf(profile.website);
  const finalHost = hostOf(site.finalUrl);
  if (profileHost && finalHost && profileHost !== finalHost) {
    found.push({
      field: 'dominio',
      googleMaps: profileHost,
      site: finalHost,
      note: 'O site informado no perfil terminou em outro domínio depois dos redirecionamentos (pode ser um redirecionamento legítimo).',
    });
  }
  return found;
}
