import http from 'node:http';
import https from 'node:https';
import {
  assertSafeUrlShape,
  resolvePublicAddress,
  systemResolver,
  UnsafeUrlError,
  type HostResolver,
  type ResolvedAddress,
} from './url-safety';

/**
 * Verificação técnica do site informado na listagem pública (sem API paga).
 *
 * Comprova apenas o que é observável por uma requisição pública: resposta HTTP, redirecionamentos,
 * diretivas de indexação (meta robots, X-Robots-Tag e robots.txt), dados estruturados
 * `LocalBusiness` (JSON-LD) e links públicos de contato. NÃO comprova que a página está indexada
 * no Google: isso exige o Search Console do proprietário.
 */
export const SITE_CHECK_USER_AGENT = 'GMN-Intelligence-Audit/1.0 (+verificacao-tecnica-de-site)';
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 8000;

export type SiteCheckStatus = 'OK' | 'HTTP_ERROR' | 'UNREACHABLE' | 'BLOCKED' | 'NOT_HTML' | 'SKIPPED';
export type RobotsTxtVerdict = 'ALLOWED' | 'DISALLOWED' | 'UNKNOWN';

export interface StructuredAddress {
  readonly streetAddress: string | null;
  readonly locality: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
}

export interface LocalBusinessData {
  readonly types: readonly string[];
  readonly name: string | null;
  readonly telephone: string | null;
  readonly address: StructuredAddress | null;
  readonly hasGeo: boolean;
}

export interface SiteCheckResult {
  readonly requestedUrl: string | null;
  readonly finalUrl: string | null;
  readonly status: SiteCheckStatus;
  readonly httpStatus: number | null;
  readonly redirects: readonly string[];
  readonly checkedAt: string;
  readonly title: string | null;
  /** `true` quando há noindex (meta ou X-Robots-Tag); `null` se a página não foi lida. */
  readonly noindex: boolean | null;
  readonly robotsTxt: RobotsTxtVerdict;
  readonly localBusiness: LocalBusinessData | null;
  readonly telLinks: readonly string[];
  readonly whatsappLinks: readonly string[];
  readonly emailLinks: readonly string[];
  readonly failureReason: string | null;
}

export interface TransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: string;
}

export type SiteTransport = (request: {
  readonly url: URL;
  readonly address: ResolvedAddress;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}) => Promise<TransportResponse>;

/** Transporte real: conecta SOMENTE ao endereço já validado; o nome do host segue para SNI/Host. */
export const nodeTransport: SiteTransport = ({ url, address, maxBytes, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'User-Agent': SITE_CHECK_USER_AGENT,
          Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
        },
        // O endereço já validado é o único usado. Versões recentes do Node pedem `all: true` (lista).
        lookup: (_host, options, callback) => {
          if (options && (options as { all?: boolean }).all) {
            (callback as unknown as (err: Error | null, addresses: { address: string; family: number }[]) => void)(null, [
              { address: address.address, family: address.family },
            ]);
          } else {
            (callback as (err: Error | null, address: string, family: number) => void)(null, address.address, address.family);
          }
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const finish = (): void =>
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        response.on('end', finish);
        response.on('close', finish);
        response.on('error', reject);
      }
    );
    // Prazo total da requisição (o `timeout` do socket só mede inatividade: um servidor que envia
    // um byte por vez seguraria a auditoria indefinidamente).
    const deadline = setTimeout(() => request.destroy(new Error('Prazo total da requisição excedido.')), timeoutMs * 2);
    request.on('close', () => clearTimeout(deadline));
    request.on('timeout', () => request.destroy(new Error('Tempo limite excedido.')));
    request.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    request.end();
  });

export interface SiteCheckDeps {
  readonly resolver?: HostResolver;
  readonly transport?: SiteTransport;
  readonly now?: () => Date;
  /** Prazo total da verificação (página, redirecionamentos e robots.txt). Padrão: 20 s. */
  readonly totalTimeoutMs?: number;
}

const header = (headers: TransportResponse['headers'], name: string): string => {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : (value as string | undefined) ?? '';
};

interface FetchedPage {
  readonly response: TransportResponse;
  readonly finalUrl: URL;
  readonly redirects: readonly string[];
}

/** Segue até 3 redirecionamentos, revalidando URL e DNS a cada salto. */
async function fetchWithSafeRedirects(
  startUrl: string,
  deps: Required<Pick<SiteCheckDeps, 'resolver' | 'transport'>>
): Promise<FetchedPage> {
  let current = assertSafeUrlShape(startUrl).url;
  const redirects: string[] = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = assertSafeUrlShape(current.toString());
    const address = await resolvePublicAddress(safe.hostname, deps.resolver);
    const response = await deps.transport({
      url: safe.url,
      address,
      maxBytes: MAX_BODY_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const location = header(response.headers, 'location');
    if (response.statusCode >= 300 && response.statusCode < 400 && location) {
      if (hop === MAX_REDIRECTS) throw new UnsafeUrlError('Redirecionamentos em excesso.');
      const next = new URL(location, safe.url);
      redirects.push(next.toString());
      current = next;
      continue;
    }
    return { response, finalUrl: safe.url, redirects };
  }
  throw new UnsafeUrlError('Redirecionamentos em excesso.');
}

const decodeEntities = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] ? decodeEntities(match[1]).replace(/\s+/g, ' ') : '';
  return title ? title.slice(0, 160) : null;
}

function metaRobotsHasNoindex(html: string): boolean {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /name\s*=\s*["']?(robots|googlebot)["']?/i.test(tag);
    if (name && /content\s*=\s*["'][^"']*noindex/i.test(tag)) return true;
  }
  return false;
}

const LOCAL_BUSINESS_TYPES = new Set([
  'LocalBusiness', 'Dentist', 'MedicalBusiness', 'MedicalClinic', 'Physician', 'Hospital', 'Pharmacy',
  'HealthAndBeautyBusiness', 'BeautySalon', 'HairSalon', 'DaySpa', 'HealthClub', 'NailSalon', 'TattooParlor',
  'ProfessionalService', 'LegalService', 'Attorney', 'Notary', 'AccountingService', 'RealEstateAgent',
  'Store', 'AutoRepair', 'AutomotiveBusiness', 'AutoDealer', 'FoodEstablishment', 'Restaurant', 'Bakery',
  'BarOrPub', 'CafeOrCoffeeShop', 'FastFoodRestaurant', 'Hotel', 'LodgingBusiness', 'HomeAndConstructionBusiness',
  'Electrician', 'Plumber', 'Locksmith', 'MovingCompany', 'RoofingContractor', 'GeneralContractor',
  'HVACBusiness', 'HousePainter', 'SportsActivityLocation', 'EntertainmentBusiness', 'FinancialService',
  'InsuranceAgency', 'TravelAgency', 'VeterinaryCare', 'AnimalShelter', 'ChildCare', 'EducationalOrganization',
  'Optician', 'Physiotherapy', 'MedicalClinic', 'Organization',
]);
// "Organization" sozinho NÃO conta como LocalBusiness: removido abaixo para evitar falso positivo.
LOCAL_BUSINESS_TYPES.delete('Organization');

type Json = unknown;

function* walkNodes(node: Json): Generator<Record<string, Json>> {
  if (Array.isArray(node)) {
    for (const entry of node) yield* walkNodes(entry);
  } else if (node && typeof node === 'object') {
    const record = node as Record<string, Json>;
    yield record;
    if (record['@graph']) yield* walkNodes(record['@graph']);
  }
}

const asText = (value: Json): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null);

function parseAddress(value: Json): StructuredAddress | null {
  const record = Array.isArray(value) ? value[0] : value;
  if (!record || typeof record !== 'object') return null;
  const a = record as Record<string, Json>;
  const address: StructuredAddress = {
    streetAddress: asText(a.streetAddress),
    locality: asText(a.addressLocality),
    region: asText(a.addressRegion),
    postalCode: asText(a.postalCode),
  };
  return Object.values(address).some(Boolean) ? address : null;
}

export function extractLocalBusiness(html: string): LocalBusinessData | null {
  const blocks = html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    let parsed: Json;
    try {
      parsed = JSON.parse(inner);
    } catch {
      continue;
    }
    for (const node of walkNodes(parsed)) {
      const rawTypes = node['@type'];
      const types = (Array.isArray(rawTypes) ? rawTypes : [rawTypes]).filter((t): t is string => typeof t === 'string');
      const matched = types.filter((type) => LOCAL_BUSINESS_TYPES.has(type.replace(/^https?:\/\/schema\.org\//, '')));
      if (matched.length === 0) continue;
      const geo = node.geo as Record<string, Json> | undefined;
      return {
        types: matched.slice(0, 4),
        name: asText(node.name),
        telephone: asText(node.telephone),
        address: parseAddress(node.address),
        hasGeo: Boolean(geo && geo.latitude !== undefined && geo.longitude !== undefined),
      };
    }
  }
  return null;
}

function extractLinks(html: string): { tel: string[]; whatsapp: string[]; email: string[] } {
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => decodeEntities(m[1] ?? ''));
  const unique = (list: string[]): string[] => [...new Set(list)].slice(0, 5);
  return {
    tel: unique(hrefs.filter((h) => /^tel:/i.test(h)).map((h) => h.slice(4).trim())),
    whatsapp: unique(
      hrefs
        .filter((h) => /^https?:\/\/(wa\.me|api\.whatsapp\.com|wa\.link|web\.whatsapp\.com)\b/i.test(h))
        .map((h) => h.slice(0, 160))
    ),
    email: unique(hrefs.filter((h) => /^mailto:/i.test(h)).map((h) => h.slice(7).split('?')[0] ?? '')),
  };
}

/** Interpreta robots.txt para o caminho raiz, para os grupos "*" e "googlebot". */
export function robotsVerdictForRoot(robotsTxt: string): RobotsTxtVerdict {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: { agents: string[]; rules: { allow: boolean; path: string }[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const field = (match[1] as string).toLowerCase();
    const value = (match[2] as string).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'disallow' || field === 'allow') && current) {
      current.rules.push({ allow: field === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const pick = (agent: string) => groups.filter((group) => group.agents.includes(agent));
  const applicable = pick('googlebot').length > 0 ? pick('googlebot') : pick('*');
  if (applicable.length === 0) return 'ALLOWED';
  const rules = applicable.flatMap((group) => group.rules);
  const rootRules = rules.filter((rule) => rule.path === '/' || rule.path === '/*');
  const disallowsRoot = rootRules.some((rule) => !rule.allow);
  const allowsRoot = rules.some((rule) => rule.allow && (rule.path === '/' || rule.path === '/*'));
  return disallowsRoot && !allowsRoot ? 'DISALLOWED' : 'ALLOWED';
}

function emptyResult(requestedUrl: string | null, status: SiteCheckStatus, reason: string | null, checkedAt: string): SiteCheckResult {
  return {
    requestedUrl,
    finalUrl: null,
    status,
    httpStatus: null,
    redirects: [],
    checkedAt,
    title: null,
    noindex: null,
    robotsTxt: 'UNKNOWN',
    localBusiness: null,
    telLinks: [],
    whatsappLinks: [],
    emailLinks: [],
    failureReason: reason,
  };
}

export async function checkWebsite(rawUrl: string | null | undefined, deps: SiteCheckDeps = {}): Promise<SiteCheckResult> {
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  if (!rawUrl || !rawUrl.trim()) return emptyResult(null, 'SKIPPED', 'Nenhum site informado na listagem.', checkedAt);

  // A verificação nunca atrasa a auditoria além do prazo total, qualquer que seja o comportamento do site.
  const budget = deps.totalTimeoutMs ?? 20_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<SiteCheckResult>((resolve) => {
    timer = setTimeout(
      () => resolve(emptyResult(rawUrl.trim(), 'UNREACHABLE', 'Prazo total da verificação do site excedido.', checkedAt)),
      budget
    );
  });
  try {
    return await Promise.race([runSiteCheck(rawUrl, deps, checkedAt), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runSiteCheck(rawUrl: string, deps: SiteCheckDeps, checkedAt: string): Promise<SiteCheckResult> {
  const resolver = deps.resolver ?? systemResolver;
  const transport = deps.transport ?? nodeTransport;
  const normalized = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;

  try {
    const page = await fetchWithSafeRedirects(normalized, { resolver, transport });
    const { response, finalUrl, redirects } = page;
    const base = { requestedUrl: normalized, finalUrl: finalUrl.toString(), redirects, checkedAt, httpStatus: response.statusCode };

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return { ...emptyResult(normalized, 'HTTP_ERROR', `O site respondeu HTTP ${response.statusCode}.`, checkedAt), ...base };
    }
    const contentType = header(response.headers, 'content-type').toLowerCase();
    if (contentType && !contentType.includes('html') && !contentType.includes('xml')) {
      return { ...emptyResult(normalized, 'NOT_HTML', 'A resposta não é uma página HTML.', checkedAt), ...base };
    }

    const html = response.body;
    const xRobots = header(response.headers, 'x-robots-tag').toLowerCase();
    const noindex = xRobots.includes('noindex') || metaRobotsHasNoindex(html);
    const links = extractLinks(html);

    let robotsTxt: RobotsTxtVerdict = 'UNKNOWN';
    try {
      const robotsUrl = new URL('/robots.txt', finalUrl).toString();
      const robots = await fetchWithSafeRedirects(robotsUrl, { resolver, transport });
      if (robots.response.statusCode >= 200 && robots.response.statusCode < 300) {
        robotsTxt = robotsVerdictForRoot(robots.response.body);
      } else if (robots.response.statusCode === 404) {
        robotsTxt = 'ALLOWED'; // sem robots.txt, nada é bloqueado
      }
    } catch {
      robotsTxt = 'UNKNOWN';
    }

    return {
      ...base,
      status: 'OK',
      title: extractTitle(html),
      noindex,
      robotsTxt,
      localBusiness: extractLocalBusiness(html),
      telLinks: links.tel,
      whatsappLinks: links.whatsapp,
      emailLinks: links.email,
      failureReason: null,
    };
  } catch (error: unknown) {
    if (error instanceof UnsafeUrlError) {
      return emptyResult(normalized, 'BLOCKED', `Consulta bloqueada por segurança: ${error.message}`, checkedAt);
    }
    return emptyResult(normalized, 'UNREACHABLE', error instanceof Error ? error.message : 'Falha de conexão.', checkedAt);
  }
}
