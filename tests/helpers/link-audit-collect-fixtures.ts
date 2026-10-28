import { confirmIdentity, type CompanyIdentity } from '../../src/lib/link-audit/audit';
import type { CollectionInput, MapsProvider, MapsSearchRequest, ProviderOutcome, SiteProvider } from '../../src/lib/link-audit/collector/types';
import { parseGoogleMapsLink } from '../../src/lib/link-audit/maps-link';
import { checkWebsite, type SiteTransport } from '../../src/lib/site-check';

/* Dados 100% FICTÍCIOS. Provedores falsos: nenhuma chamada de rede, DNS ou disco. */
export const FID = '0x935ef1a2b3c4d5e6:0x1234567890abcdef';
export const FID_OTHER = '0x935ef1a2b3c4d5e6:0x00000000000000ff';
// CID = decimal da 2ª metade do FID (0x1234567890abcdef); ambos > 2^53.
export const CID = '1311768467294899695';
export const CID_OTHER = '5555555555555555555';
export const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
export const LINK = `https://www.google.com/maps/place/Padaria+Exemplo/@-16.6869,-49.2648,17z/data=!1s${FID}?cid=${CID}`;
export const T_CONFIRMED = '2026-10-21T11:00:00.000Z';
export const T_FETCH = '2026-10-21T12:10:00.000Z';
export const T_SITE = '2026-10-21T12:20:00.000Z';
export const T_NOW = '2026-10-21T12:30:00.000Z';
export const FAKE_KEY = 'serper-chave-ficticia-0123456789abcdef';

export const PLACE = {
  title: 'Padaria Exemplo (fictícia)',
  address: 'Rua Fictícia, 100 - Cidade Exemplo - GO',
  phoneNumber: '(62) 99999-0000',
  website: 'https://www.padaria-exemplo.example/?igsh=SEGREDO-IG',
  type: 'Padaria',
  types: ['Padaria', 'Confeitaria'],
  rating: 4.8,
  ratingCount: 86,
  openingHours: { segunda: '08:00–18:00' },
  cid: CID,
  fid: FID,
  placeId: PLACE_ID,
};

export const SITE_HTML = `<!doctype html><html><head><title>Padaria Exemplo</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Padaria Exemplo","telephone":"+55 62 99999-0000"}</script>
</head><body><a href="tel:+5562999990000">Ligue</a> <a href="https://wa.me/5562999990000">WhatsApp</a></body></html>`;

export function identityFor(link: string, extra: Partial<CompanyIdentity> = {}): CompanyIdentity {
  const confirmed = confirmIdentity(parseGoogleMapsLink(link), { confirmedBy: 'ana@empresa.com', confirmedAt: T_CONFIRMED });
  if (!confirmed.ok) throw new Error(`fixture inválida: ${confirmed.issues.join(' ')}`);
  return { ...confirmed.value, ...extra };
}

export function inputFor(identity: CompanyIdentity, snapshotId = 'snap-exemplo-0001'): CollectionInput {
  return { snapshotId, link: { originalLink: identity.originalLink, resolved: null }, identity };
}

export const NAMED = (): CollectionInput => inputFor(identityFor(LINK, { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' }));

export function mapsFake(response: (() => ProviderOutcome<readonly unknown[]>) | readonly unknown[], seen: MapsSearchRequest[] = []): MapsProvider {
  return {
    async search(request) {
      seen.push(request);
      if (typeof response === 'function') return response();
      return { state: 'OK', value: response, fetchedAt: T_FETCH };
    },
  };
}

export const publicResolver = async () => [{ address: '93.184.216.34', family: 4 as const }];

export function siteFake(pages: Record<string, { status?: number; body: string }>, seen: string[] = []): SiteProvider {
  const transport: SiteTransport = async ({ url }) => {
    const page = pages[url.pathname] ?? { status: 404, body: '' };
    return { statusCode: page.status ?? 200, headers: { 'content-type': 'text/html' }, body: page.body };
  };
  return {
    async check(url) {
      seen.push(url);
      return checkWebsite(url, { resolver: publicResolver, transport, now: () => new Date(T_SITE) });
    },
  };
}

export const clock = (): Date => new Date(T_NOW);
