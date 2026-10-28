import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { confirmIdentity, type CompanyIdentity } from '../src/lib/link-audit/audit';
import { collectEvidence, mechanicalCriterionStatus, toSnapshotDraft } from '../src/lib/link-audit/collector/collect';
import { comparablePhone, profileUrlFrom } from '../src/lib/link-audit/collector/adapters';
import { DEFAULT_CALL_BUDGET, FIELD_CAPABILITIES, LOOKUP_STRATEGIES, MAPS_ORIGIN_LIMITATION } from '../src/lib/link-audit/collector/capabilities';
import { matchPlace, parseMapsPlace, parseMapsPlaces } from '../src/lib/link-audit/collector/maps-place';
import type {
  CallBudget,
  CollectionInput,
  CollectionResult,
  CollectorProviders,
  MapsProvider,
  MapsSearchRequest,
  ProviderOutcome,
  ReviewsProvider,
  SiteProvider,
} from '../src/lib/link-audit/collector/types';
import { validateEvidence, type Evidence } from '../src/lib/link-audit/evidence';
import { parseGoogleMapsLink } from '../src/lib/link-audit/maps-link';
import { CRITERION_IDS } from '../src/lib/link-audit/methodology';
import { buildSnapshot, verifySnapshot } from '../src/lib/link-audit/snapshot';
import { isSanitizedUrl } from '../src/lib/link-audit/url-redaction';
import { validateLinkAudit } from '../src/lib/link-audit/validate';
import { checkWebsite, type SiteTransport } from '../src/lib/site-check';
import type { ReviewsFetchOutcome } from '../src/lib/serper-reviews';

/*
 * Todos os dados são FICTÍCIOS e os provedores são SIMULADOS. Nenhuma empresa real é consultada e
 * nenhuma chamada de rede, DNS ou disco é feita (armadilhas ativas durante o arquivo inteiro).
 */
const FID = '0x935ef1a2b3c4d5e6:0x1234567890abcdef';
const FID_OTHER = '0x935ef1a2b3c4d5e6:0x00000000000000ff';
// CID = decimal da 2ª metade do FID (0x1234567890abcdef); ambos > 2^53. CID_OTHER é outro CID válido de 64 bits.
const CID = '1311768467294899695';
const CID_OTHER = '5555555555555555555';
const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const LINK = `https://www.google.com/maps/place/Padaria+Exemplo/@-16.6869,-49.2648,17z/data=!1s${FID}?cid=${CID}`;
const T_CONFIRMED = '2026-10-20T11:00:00.000Z';
const T_FETCH = '2026-10-20T12:10:00.000Z';
const T_SITE = '2026-10-20T12:20:00.000Z';
const T_NOW = '2026-10-20T12:30:00.000Z';
const T_FROZEN = '2026-10-20T13:00:00.000Z';
const SECRETS = ['SEGREDO-TOKEN-9', 'SEGREDO-CHAVE', 'SEGREDO-IG'];

const trap = (name: string) => () => {
  throw new Error(`rede proibida: ${name}`);
};
const guards = [
  mock.method(globalThis, 'fetch', trap('fetch')),
  mock.method(dns, 'lookup', trap('dns.lookup') as never),
  mock.method(dns.promises, 'lookup', trap('dns.promises.lookup') as never),
  mock.method(net, 'connect', trap('net.connect') as never),
  mock.method(http, 'request', trap('http.request') as never),
  mock.method(https, 'request', trap('https.request') as never),
];
// `.data/` é ignorada pelo Git: numa cópia limpa ela não existe (ausente = lista vazia).
const listData = (): string[] => (fs.existsSync(path.join(process.cwd(), '.data')) ? fs.readdirSync(path.join(process.cwd(), '.data')).sort() : []);
const dataBefore = listData();
after(() => {
  for (const guard of guards) guard.mock.restore();
});

const PLACE = {
  title: 'Padaria Exemplo (fictícia)',
  address: 'Rua Fictícia, 100 - Cidade Exemplo - GO',
  phoneNumber: '(62) 99999-0000',
  website: 'https://www.padaria-exemplo.example/?igsh=SEGREDO-IG',
  type: 'Padaria',
  types: ['Padaria', 'Confeitaria'],
  rating: 4.8,
  ratingCount: 86,
  openingHours: { segunda: '08:00–18:00', terça: '08:00–18:00' },
  cid: CID,
  fid: FID,
  placeId: PLACE_ID,
};

function identityFor(link: string, extra: Partial<CompanyIdentity> = {}): CompanyIdentity {
  const confirmed = confirmIdentity(parseGoogleMapsLink(link), { confirmedBy: 'ana@empresa.com', confirmedAt: T_CONFIRMED });
  assert.ok(confirmed.ok);
  return { ...confirmed.value, ...extra };
}

function inputFor(identity: CompanyIdentity): CollectionInput {
  return { snapshotId: 'snap-exemplo-0001', link: { originalLink: identity.originalLink, resolved: null }, identity };
}

const NAMED = (): CollectionInput => inputFor(identityFor(LINK, { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' }));

function mapsProvider(response: (() => ProviderOutcome<readonly unknown[]>) | readonly unknown[], seen: MapsSearchRequest[] = []): MapsProvider {
  return {
    async search(request) {
      seen.push(request);
      if (typeof response === 'function') return response();
      return { state: 'OK', value: response, fetchedAt: T_FETCH };
    },
  };
}

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 as const }];
const SITE_HTML = `<!doctype html><html><head><title>Padaria Exemplo</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Padaria Exemplo","telephone":"+55 62 99999-0000"}</script>
</head><body><a href="tel:+5562999990000">Ligue</a> <a href="https://wa.me/5562999990000">WhatsApp</a></body></html>`;

function siteProvider(pages: Record<string, { status?: number; body: string }>, seen: string[] = []): SiteProvider {
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

const budget = (partial: Partial<CallBudget> = {}): CallBudget => ({ maps: 1, reviews: 0, site: 1, ...partial });
const clock = () => new Date(T_NOW);
const allResults: CollectionResult[] = [];

async function collect(input: CollectionInput, providers: CollectorProviders, b: CallBudget = budget()): Promise<CollectionResult> {
  const outcome = await collectEvidence(input, providers, { budget: b, now: clock });
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join('; '));
  allResults.push(outcome.result);
  return outcome.result;
}

const byId = (result: CollectionResult): Map<string, Evidence> => new Map(result.evidences.map((evidence) => [evidence.id, evidence]));

test('caso completo: perfil localizado por identificador, site próprio verificado, cada campo vira a evidência certa', async () => {
  const mapsCalls: MapsSearchRequest[] = [];
  const siteCalls: string[] = [];
  const result = await collect(NAMED(), {
    maps: mapsProvider([{ ...PLACE, title: 'Outro Nome', cid: CID_OTHER, fid: FID_OTHER, placeId: 'ChIJoutroPlaceIdAAAAAAAAA' }, PLACE], mapsCalls),
    site: siteProvider({ '/': { body: SITE_HTML } }, siteCalls),
  });
  const ev = byId(result);

  assert.equal(result.located, 'MATCHED');
  assert.deepEqual(result.usage, { maps: 1, reviews: 0, site: 1 });
  assert.equal(mapsCalls.length, 1);
  assert.equal(mapsCalls[0]?.query, 'Padaria Exemplo Cidade Exemplo GO');
  assert.deepEqual(mapsCalls[0]?.viewport, { latitude: -16.6869, longitude: -49.2648, zoom: 17 });
  assert.deepEqual(siteCalls, ['https://www.padaria-exemplo.example/'], 'o site é consultado SEM parâmetros de rastreio');

  const profileSource = `https://www.google.com/maps?cid=${CID}`;
  const expectations: Array<[string, string, string]> = [
    ['maps-name', 'NAP', 'Nome exibido no perfil: Padaria Exemplo (fictícia)'],
    ['maps-address', 'NAP', 'Endereço exibido no perfil: Rua Fictícia, 100 - Cidade Exemplo - GO'],
    ['maps-phone', 'NAP', 'Telefone exibido no perfil: (62) 99999-0000'],
    ['maps-hours', 'NAP', 'Horários exibidos no perfil: segunda: 08:00–18:00; terça: 08:00–18:00'],
    ['maps-category', 'CATEGORIES', 'Categoria principal exibida no perfil: Padaria'],
    ['maps-rating', 'REVIEWS', 'Nota média exibida no perfil: 4,8'],
    ['maps-review-count', 'REVIEWS', 'Quantidade de avaliações exibida no perfil: 86'],
  ];
  for (const [id, criterion, claim] of expectations) {
    const item = ev.get(id);
    assert.ok(item, id);
    assert.equal(item.status, 'VERIFIED', id);
    assert.equal(item.origin, 'GOOGLE_NATIVE', id);
    assert.equal(item.criterionId, criterion, id);
    assert.equal(item.claim, claim, id);
    assert.equal(item.sourceUrl, profileSource, id);
    assert.equal(item.limitation, MAPS_ORIGIN_LIMITATION, id);
    assert.equal(item.consultedAt, T_FETCH, id);
  }
  assert.match(ev.get('maps-website')?.claim ?? '', /https:\/\/www\.padaria-exemplo\.example\//);
  assert.doesNotMatch(ev.get('maps-website')?.claim ?? '', /SEGREDO-IG|igsh/);

  for (const id of ['site-reachable', 'site-contact-channels', 'site-indexing', 'site-declared-types', 'phone-consistency']) {
    const item = ev.get(id);
    assert.ok(item, id);
    assert.equal(item.origin, 'OFFICIAL_SITE', id);
    assert.equal(item.status, 'VERIFIED', id);
    assert.equal(item.consultedAt, T_SITE);
    assert.match(item.limitation ?? '', id === 'phone-consistency' ? /Comparação só de dígitos/ : /não comprova|Não prova|não são os serviços/i, `${id} avisa o limite`);
  }
  assert.match(ev.get('phone-consistency')?.claim ?? '', /coincide com um telefone publicado no site/);
  assert.match(ev.get('site-contact-channels')?.claim ?? '', /1 de telefone, 1 de WhatsApp e 0 de e-mail/);
  assert.match(ev.get('site-declared-types')?.claim ?? '', /LocalBusiness/);

  // Recursos nativos que a fonte não entrega: NOT_VERIFIED com motivo, nunca inventados.
  for (const [id, attribute] of [
    ['unavailable-posts', 'google_posts'], ['unavailable-photos', 'google_profile_photos'], ['unavailable-videos', 'google_profile_videos'],
    ['unavailable-services', 'google_services'], ['unavailable-attributes', 'google_attributes'], ['unavailable-products', 'google_products'],
    ['unavailable-review-replies', 'google_review_replies'], ['unavailable-review-recency', 'google_reviews'],
  ] as const) {
    const item = ev.get(id);
    assert.ok(item, id);
    assert.equal(item.attribute, attribute);
    assert.equal(item.status, 'NOT_VERIFIED', id);
    assert.ok((item.limitation ?? '').length > 20, id);
  }
  assert.match(ev.get('unavailable-review-replies')?.limitation ?? '', /nenhum provedor configurado/);

  assert.equal(result.collectedAt, T_NOW);
  assert.ok(result.limitations.some((text) => /Serper \/maps/.test(text) && /intermediário/.test(text)));
});

test('status dos critérios: regra mecânica e conservadora, sem pontos nem avaliação parcial', async () => {
  const result = await collect(NAMED(), { maps: mapsProvider([PLACE]), site: siteProvider({ '/': { body: SITE_HTML } }) });
  const status = Object.fromEntries(result.criteria.map((criterion) => [criterion.criterionId, criterion.status]));
  assert.deepEqual(status, {
    NAP: 'VERIFIED', CATEGORIES: 'NOT_VERIFIED', SERVICES: 'NOT_VERIFIED', REVIEWS: 'NOT_VERIFIED', REVIEW_REPLIES: 'NOT_VERIFIED',
    VISUALS: 'NOT_VERIFIED', POSTS_ACTIVITY: 'NOT_VERIFIED', CONVERSION: 'VERIFIED', LOCAL_AUTHORITY: 'NOT_VERIFIED',
  });
  assert.deepEqual(result.criteria.map((criterion) => criterion.criterionId), [...CRITERION_IDS]);
  // Categoria principal verificada, mas a lista de categorias adicionais nunca é afirmada completa.
  assert.equal(byId(result).get('maps-category')?.status, 'VERIFIED');
  assert.equal(byId(result).get('maps-secondary-categories')?.status, 'NOT_VERIFIED');
  assert.match(byId(result).get('maps-secondary-categories')?.claim ?? '', /completude não comprovada\): Confeitaria/);
  // Mistura de verificado e não verificado NÃO vira "parcial": a regra de parcial é da D3.
  assert.equal(mechanicalCriterionStatus(result.evidences.filter((e) => e.criterionId === 'REVIEWS')), 'NOT_VERIFIED');
  assert.equal(mechanicalCriterionStatus([]), 'NOT_VERIFIED');
  assert.equal(JSON.stringify(result).match(/"(points|score|index|coverage|classification|confidence)"/), null);
  for (const criterion of result.criteria) assert.ok(criterion.status !== 'PARTIAL' && criterion.status !== 'NOT_FOUND');
});

test('o resultado compõe com o contrato da auditoria e com o snapshot (sem gravar nada)', async () => {
  const input = NAMED();
  const result = await collect(input, { maps: mapsProvider([PLACE]), site: siteProvider({ '/': { body: SITE_HTML } }) });
  const audit = validateLinkAudit({
    schemaVersion: 1, methodologyVersion: 'lumos-reconstruida-v1', state: 'IDENTITY_CONFIRMED', identity: input.identity,
    evidences: result.evidences, criteria: result.criteria, limitations: result.limitations, indexStatus: 'PENDING_METHODOLOGY',
  });
  assert.equal(audit.ok, true, audit.issues.join('; '));

  const draft = toSnapshotDraft(input, result, T_FROZEN);
  assert.equal(draft.frozenAt, T_FROZEN);
  const snapshot = buildSnapshot(draft, { version: 1, previous: null });
  assert.ok(snapshot.ok, snapshot.ok ? '' : `${snapshot.code}: ${snapshot.issues.join('; ')}`);
  assert.ok(verifySnapshot(JSON.parse(JSON.stringify(snapshot.value))).ok);
  // frozenAt nunca fica antes da coleta nem da confirmação
  assert.equal(toSnapshotDraft(input, result, '2026-10-20T00:00:00.000Z').frozenAt, T_NOW);
});

test('casamento só por identificador exato: nome parecido com identificador diferente NUNCA casa', async () => {
  const lookalike = { ...PLACE, cid: CID_OTHER, fid: FID_OTHER, placeId: 'ChIJoutroPlaceIdAAAAAAAAA' };
  const result = await collect(NAMED(), { maps: mapsProvider([lookalike]), site: siteProvider({ '/': { body: SITE_HTML } }) });
  assert.equal(result.located, 'NOT_LOCATED');
  assert.equal(result.usage.site, 0, 'sem perfil localizado não há site a verificar');
  for (const id of ['maps-name', 'maps-address', 'maps-rating', 'maps-category', 'maps-website']) {
    const item = byId(result).get(id);
    assert.equal(item?.status, 'NOT_VERIFIED', id);
    assert.doesNotMatch(item?.claim ?? '', /Padaria Exemplo \(fictícia\)|4,8/, 'nenhum dado do outro negócio vaza');
  }
  assert.ok(result.limitations.some((text) => /não apareceu entre os resultados/.test(text)));
  assert.ok(!result.evidences.some((e) => e.status === 'VERIFIED' && e.origin === 'GOOGLE_NATIVE'));
});

test('identificadores ambíguos ou contraditórios: nada é escolhido', () => {
  const wanted = { cid: CID, featureId: FID };
  const placeA = parseMapsPlace({ ...PLACE })!;
  const placeB = parseMapsPlace({ ...PLACE, title: 'Cópia', cid: CID, fid: FID_OTHER })!;
  const placeC = parseMapsPlace({ title: 'Outro', cid: CID_OTHER, fid: FID })!;
  assert.equal(matchPlace([placeA], wanted).state, 'MATCHED');
  assert.equal(matchPlace([placeA, placeA], wanted).state, 'MATCHED', 'o mesmo negócio repetido não é ambíguo');
  assert.equal(matchPlace([placeB], wanted).state, 'AMBIGUOUS', 'casa por cid mas contradiz o fid');
  assert.equal(matchPlace([placeA, placeC], wanted).state, 'AMBIGUOUS');
  assert.equal(matchPlace([placeC], wanted).state, 'AMBIGUOUS', 'casa por fid mas contradiz o cid');
  assert.equal(matchPlace([], wanted).state, 'NOT_LOCATED');
  assert.equal(matchPlace([parseMapsPlace({ title: 'Padaria Exemplo (fictícia)' })!], wanted).state, 'NOT_LOCATED', 'só o nome igual não basta');
  // identidade só com fid (Onda 4C): o CID derivado do fid é a chave; resultado só com o cid correspondente também casa
  assert.equal(matchPlace([placeA], { featureId: FID }).state, 'MATCHED');
  assert.equal(matchPlace([parseMapsPlace({ ...PLACE, fid: undefined })!], { featureId: FID }).state, 'MATCHED');
  assert.equal(matchPlace([parseMapsPlace({ ...PLACE, fid: undefined, cid: undefined })!], { featureId: FID }).state, 'NOT_LOCATED', 'sem identificador comparável não casa');
});

test('resultado ambíguo na coleta: perfil não é escolhido e todos os campos ficam NOT_VERIFIED', async () => {
  const twin = { ...PLACE, cid: CID_OTHER, fid: FID, title: 'Gêmea' };
  const result = await collect(NAMED(), { maps: mapsProvider([PLACE, twin]), site: siteProvider({ '/': { body: SITE_HTML } }) });
  assert.equal(result.located, 'AMBIGUOUS');
  assert.ok(result.evidences.filter((e) => e.id.startsWith('maps-')).every((e) => e.status === 'NOT_VERIFIED'));
});

test('campos ausentes na resposta viram NOT_VERIFIED, nunca NOT_FOUND', async () => {
  const sparse = { cid: CID, fid: FID, title: 'Padaria Exemplo (fictícia)' };
  const result = await collect(NAMED(), { maps: mapsProvider([sparse]) });
  const ev = byId(result);
  assert.equal(ev.get('maps-name')?.status, 'VERIFIED');
  for (const id of ['maps-address', 'maps-phone', 'maps-hours', 'maps-category', 'maps-rating', 'maps-review-count', 'maps-website']) {
    assert.equal(ev.get(id)?.status, 'NOT_VERIFIED', id);
    assert.match(ev.get(id)?.limitation ?? '', /não é prova de que/, id);
  }
  assert.equal(result.usage.site, 0);
});

test('site que é rede social ou agregador: não é consultado e nunca vira evidência de recurso nativo', async () => {
  const siteCalls: string[] = [];
  const result = await collect(NAMED(), {
    maps: mapsProvider([{ ...PLACE, website: 'https://www.instagram.com/padaria_exemplo?igsh=SEGREDO-IG' }]),
    site: siteProvider({ '/': { body: SITE_HTML } }, siteCalls),
  });
  const ev = byId(result);
  assert.deepEqual(siteCalls, []);
  assert.equal(result.usage.site, 0);
  assert.match(ev.get('maps-website')?.claim ?? '', /instagram\.com\/padaria_exemplo.*rede social ou agregador/);
  const presence = ev.get('external-presence');
  assert.equal(presence?.status, 'NOT_VERIFIED');
  assert.equal(presence?.origin, 'OFFICIAL_SOCIAL');
  assert.equal(presence?.sourceUrl, 'https://www.instagram.com/padaria_exemplo');
  assert.match(presence?.nativeContext ?? '', /não prova Google Posts, fotos ou serviços/);
  assert.ok(!result.evidences.some((e) => e.origin === 'OFFICIAL_SITE'));
});

test('falhas do site viram NOT_VERIFIED e não vazam URL com token', async () => {
  const unreachable: SiteProvider = {
    async check() {
      throw Object.assign(new Error('connect ECONNREFUSED https://www.padaria-exemplo.example/?token=SEGREDO-TOKEN-9'), { code: 'ECONNREFUSED' });
    },
  };
  const thrown = await collect(NAMED(), { maps: mapsProvider([PLACE]), site: unreachable });
  assert.equal(thrown.usage.site, 1);
  assert.ok(thrown.limitations.some((text) => /Verificação do site falhou/.test(text)));
  assert.deepEqual(SECRETS.filter((secret) => JSON.stringify(thrown).includes(secret)), []);

  const http500 = await collect(NAMED(), { maps: mapsProvider([PLACE]), site: siteProvider({ '/': { status: 500, body: '' } }) });
  const reach = byId(http500).get('site-reachable');
  assert.equal(reach?.status, 'NOT_VERIFIED');
  assert.match(reach?.limitation ?? '', /HTTP_OTHER/);
  assert.match(reach?.limitation ?? '', /HTTP 500/);
  assert.doesNotMatch(reach?.limitation ?? '', /exige login|autenticad/i, 'um erro 500 nunca é descrito como login');
  assert.equal(http500.usage.site, 1);
});

test('compatibilidade real: SiteCheckResult produzido pelo checkWebsite verdadeiro é aceito sem alterá-lo', async () => {
  const real = await checkWebsite('https://www.padaria-exemplo.example/', {
    resolver: publicResolver,
    transport: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: SITE_HTML }),
    now: () => new Date(T_SITE),
  });
  assert.equal(real.status, 'OK');
  assert.deepEqual(real.telLinks.length, 1);
});

test('falha do Serper /maps: nenhum dado é inventado, o motivo é registrado sem segredos', async () => {
  const failing = await collect(NAMED(), {
    maps: mapsProvider(() => ({ state: 'FAILED', reason: 'HTTP 429 em https://google.serper.dev/maps?api_key=SEGREDO-CHAVE&token=SEGREDO-TOKEN-9' })),
  });
  assert.equal(failing.located, 'NOT_LOCATED');
  assert.equal(failing.usage.maps, 1);
  assert.deepEqual(SECRETS.filter((secret) => JSON.stringify(failing).includes(secret)), []);

  const throwing: MapsProvider = {
    async search() {
      throw new Error('falha com chave serper-chave-ficticia-0123456789 em https://google.serper.dev/maps?key=SEGREDO-CHAVE');
    },
  };
  const thrown = await collect(NAMED(), { maps: throwing });
  assert.equal(thrown.located, 'NOT_LOCATED');
  assert.deepEqual(SECRETS.filter((secret) => JSON.stringify(thrown).includes(secret)), []);
  assert.ok(thrown.evidences.filter((e) => e.id.startsWith('maps-')).every((e) => e.status === 'NOT_VERIFIED'));
});

test('orçamento de chamadas nunca é excedido e o uso é exato', async () => {
  const mapsCalls: MapsSearchRequest[] = [];
  const siteCalls: string[] = [];
  const zero = await collect(NAMED(), { maps: mapsProvider([PLACE], mapsCalls), site: siteProvider({ '/': { body: SITE_HTML } }, siteCalls) }, budget({ maps: 0, site: 0 }));
  assert.deepEqual(zero.usage, { maps: 0, reviews: 0, site: 0 });
  assert.equal(mapsCalls.length, 0);
  assert.equal(zero.located, 'NOT_ATTEMPTED');
  assert.ok(zero.limitations.some((text) => /Orçamento de chamadas ao Serper \/maps igual a zero/.test(text)));

  const noSite = await collect(NAMED(), { maps: mapsProvider([PLACE], mapsCalls), site: siteProvider({ '/': { body: SITE_HTML } }, siteCalls) }, budget({ site: 0 }));
  assert.deepEqual(noSite.usage, { maps: 1, reviews: 0, site: 0 });
  assert.equal(siteCalls.length, 0);

  const many = await collect(NAMED(), { maps: mapsProvider([{ ...PLACE, cid: CID_OTHER, fid: FID_OTHER }], mapsCalls) }, budget({ maps: 5 }));
  assert.equal(many.usage.maps, 1, 'não há segunda estratégia confirmada: nenhuma chamada extra, mesmo com orçamento sobrando');

  const outcome = await collectEvidence(NAMED(), {}, { budget: { maps: -1, reviews: 0, site: 0 }, now: clock });
  assert.ok(!outcome.ok && outcome.code === 'INVALID_BUDGET');
  assert.ok(!(await collectEvidence(NAMED(), {}, { budget: { maps: 1.5, reviews: 0, site: 0 }, now: clock })).ok);
  assert.ok(!(await collectEvidence(NAMED(), {}, { budget: { maps: 11, reviews: 0, site: 0 }, now: clock })).ok);
  assert.deepEqual(DEFAULT_CALL_BUDGET, { maps: 1, reviews: 0, site: 1 });
});

test('avaliações datadas: endpoint com formato NÃO confirmado nunca passa de NOT_VERIFIED', async () => {
  const calls: Array<{ featureId: string | null }> = [];
  const maxPagesSeen: number[] = [];
  const received: ReviewsFetchOutcome = {
    state: 'FETCHED', fetchedAt: T_FETCH, pagesFetched: 1, exhausted: true, totalReported: 86, warnings: [],
    reviews: [{ rating: 5, text: 'ótimo', ageDaysMin: 1, ageDaysMax: 2, dateBasis: 'ISO', hasOwnerReply: true, ownerReplyFieldPresent: true }],
  };
  const reviews: ReviewsProvider = {
    async getReviews(ids, options) {
      calls.push({ featureId: ids.featureId });
      maxPagesSeen.push(options.maxPages);
      return received;
    },
  };
  const result = await collect(NAMED(), { maps: mapsProvider([PLACE]), reviews }, budget({ reviews: 1, site: 0 }));
  const ev = byId(result);
  assert.deepEqual(calls, [{ featureId: FID }]);
  assert.deepEqual(maxPagesSeen, [1], 'o teto de páginas do provedor é o orçamento');
  assert.deepEqual(result.usage, { maps: 1, reviews: 1, site: 0 });
  for (const id of ['unavailable-review-replies', 'unavailable-review-recency']) {
    assert.equal(ev.get(id)?.status, 'NOT_VERIFIED', id);
    assert.match(ev.get(id)?.limitation ?? '', /formato ainda NÃO foi confirmado.*nenhum valor dela foi usado/s);
  }
  assert.ok(!result.evidences.some((e) => /ótimo/i.test(e.claim)), 'nada do conteúdo das avaliações vira evidência');

  const overspent = await collect(NAMED(), { maps: mapsProvider([PLACE]), reviews: { async getReviews() { return { ...received, pagesFetched: 3 }; } } }, budget({ reviews: 1, site: 0 }));
  assert.equal(overspent.usage.reviews, 3);
  assert.ok(overspent.limitations.some((text) => /usou mais páginas que o orçamento/.test(text)));

  const failed = await collect(NAMED(), { maps: mapsProvider([PLACE]), reviews: { async getReviews() { return { state: 'FAILED', reason: 'HTTP 500 em https://google.serper.dev/reviews?token=SEGREDO-TOKEN-9', pagesFetched: 1, reviews: [] }; } } }, budget({ reviews: 1, site: 0 }));
  assert.match(byId(failed).get('unavailable-review-replies')?.limitation ?? '', /falhou/);
  assert.deepEqual(SECRETS.filter((secret) => JSON.stringify(failed).includes(secret)), []);

  const noFid = await collect(inputFor(identityFor(`https://www.google.com/maps?cid=${CID}`, { name: 'Padaria Exemplo' })), { maps: mapsProvider([PLACE]), reviews }, budget({ reviews: 1, site: 0 }));
  assert.match(byId(noFid).get('unavailable-review-replies')?.limitation ?? '', /exige o identificador fid/);
  assert.equal(calls.length, 1, 'sem fid o endpoint não é chamado');

  const disabled = await collect(NAMED(), { maps: mapsProvider([PLACE]), reviews: { async getReviews() { return { state: 'DISABLED', reason: 'Coleta de avaliações datadas desligada.' }; } } }, budget({ reviews: 1, site: 0 }));
  assert.match(byId(disabled).get('unavailable-review-replies')?.limitation ?? '', /desligada/);
});

test('localização do perfil: nome do operador, dica do link, ou nenhuma chamada se não houver como buscar', async () => {
  const seen: MapsSearchRequest[] = [];
  // sem nome do operador: usa a dica (não verificada) do link
  const fromLabel = await collect(inputFor(identityFor(LINK)), { maps: mapsProvider([PLACE], seen) });
  assert.equal(seen[0]?.query, 'Padaria Exemplo');
  assert.equal(fromLabel.located, 'MATCHED');
  // o nome informado pelo operador tem prioridade sobre a dica do link
  await collect(inputFor(identityFor(LINK, { name: 'Nome do Operador' })), { maps: mapsProvider([PLACE], seen) });
  assert.equal(seen[1]?.query, 'Nome do Operador');
  // identificadores nunca viram texto de busca
  assert.ok(seen.every((request) => !request.query.includes(CID) && !request.query.includes('0x')));

  // sem nome e sem dica: nenhuma chamada, motivo claro
  const bare = await collect(inputFor(identityFor(`https://www.google.com/maps?cid=${CID}`)), { maps: mapsProvider([PLACE], seen) });
  assert.equal(seen.length, 2, 'nenhuma chamada foi feita');
  assert.equal(bare.located, 'NOT_ATTEMPTED');
  assert.deepEqual(bare.usage, { maps: 0, reviews: 0, site: 0 });
  assert.ok(bare.limitations.some((text) => /informe o nome da empresa/.test(text)));
});

test('identidade: só coleta com identidade confirmada e coerente com o link', async () => {
  const unconfirmed = identityFor(LINK);
  delete (unconfirmed as { confirmation?: unknown }).confirmation;
  const refused = await collectEvidence(inputFor(unconfirmed), { maps: mapsProvider([PLACE]) }, { budget: budget(), now: clock });
  assert.ok(!refused.ok && refused.code === 'IDENTITY_NOT_CONFIRMED');

  const other = identityFor(LINK, { identifiers: { cid: CID_OTHER, featureId: FID } });
  const mismatch = await collectEvidence(inputFor(other), { maps: mapsProvider([PLACE]) }, { budget: budget(), now: clock });
  assert.ok(!mismatch.ok && mismatch.code === 'IDENTITY_MISMATCH');

  const shortLink: CompanyIdentity = {
    originalLink: LINK,
    identifiers: { cid: CID },
    confirmation: { confirmedBy: 'ana@empresa.com', confirmedAt: T_CONFIRMED },
  };
  const noIds = await collectEvidence({ snapshotId: 'snap-exemplo-0001', link: { originalLink: 'https://maps.app.goo.gl/AbCd1234', resolved: null }, identity: { ...shortLink, originalLink: 'https://maps.app.goo.gl/AbCd1234' } }, {}, { budget: budget(), now: clock });
  assert.ok(!noIds.ok && noIds.code === 'IDENTITY_MISMATCH', 'link curto sem resolução nunca vira coleta');
});

test('link curto resolvido (contrato futuro): a coleta usa o link resolvido, que precisa bater com a identidade', async () => {
  const resolved = `https://www.google.com/maps/place/Padaria+Exemplo/data=!1s${FID}?cid=${CID}`;
  const identity = { ...identityFor(resolved, { name: 'Padaria Exemplo' }), originalLink: 'https://maps.app.goo.gl/AbCd1234' };
  const input: CollectionInput = {
    snapshotId: 'snap-exemplo-0001',
    link: { originalLink: 'https://maps.app.goo.gl/AbCd1234', resolved: { url: resolved, resolvedAt: '2026-10-20T10:00:00.000Z', method: 'REDIRECT_CHAIN' } },
    identity,
  };
  const result = await collect(input, { maps: mapsProvider([PLACE]) });
  assert.equal(result.located, 'MATCHED');
  const draft = toSnapshotDraft(input, result, T_FROZEN);
  const snapshot = buildSnapshot(draft, { version: 1, previous: null });
  assert.ok(snapshot.ok, snapshot.ok ? '' : snapshot.issues.join('; '));
});

test('leitor defensivo: valores hostis ou fora do formato são limpos ou descartados', () => {
  const hostile = parseMapsPlace({
    title: 'A‮evil\u0000​  Nome', address: 'x'.repeat(5000), phoneNumber: 12345, rating: 99, ratingCount: -4, type: 42,
    types: ['A', 7, null, 'Padaria'], cid: '12abc', fid: 'nao-e-fid', placeId: 'curto', website: 'x'.repeat(3000), openingHours: { a: 1, b: 'ok' },
  });
  assert.ok(hostile);
  assert.equal(hostile.title, 'A evil Nome');
  assert.equal(hostile.address?.length, 300);
  assert.equal(hostile.phone, null);
  assert.equal(hostile.rating, null);
  assert.equal(hostile.ratingCount, null);
  assert.equal(hostile.category, null);
  assert.equal(hostile.website, null);
  assert.deepEqual(hostile.identifiers, {});
  assert.deepEqual(hostile.openingHours, [['b', 'ok']]);
  const list = parseMapsPlaces([null, 1, 'x', [], {}, { cid: 5 }]);
  assert.equal(list.places.length, 2);
  assert.equal(list.ignored, 4);
  assert.deepEqual(list.places[1]?.identifiers, { cid: '5' });
  assert.equal(parseMapsPlaces(Array.from({ length: 500 }, () => ({ title: 'x' }))).places.length, 100);
});

test('utilidades: telefone comparável e link do perfil derivado só dos identificadores do operador', () => {
  assert.equal(comparablePhone('(62) 99999-0000'), '62999990000');
  assert.equal(comparablePhone('+55 62 99999-0000'), '62999990000');
  assert.notEqual(comparablePhone('(62) 99999-0001'), comparablePhone('(62) 99999-0000'));
  assert.equal(profileUrlFrom({ cid: CID, featureId: FID }), `https://www.google.com/maps?cid=${CID}`);
  assert.equal(profileUrlFrom({ featureId: FID }), `https://www.google.com/maps?ftid=${FID}`);
  assert.equal(profileUrlFrom({ placeId: PLACE_ID }), `https://www.google.com/maps/place/?q=place_id:${PLACE_ID}`);
  assert.equal(profileUrlFrom({}), null);
  for (const ids of [{ cid: CID }, { featureId: FID }, { placeId: PLACE_ID }]) {
    const url = profileUrlFrom(ids) ?? '';
    const parsed = parseGoogleMapsLink(url);
    assert.ok(parsed.status === 'IDENTIFIED' && JSON.stringify(parsed.identifiers) === JSON.stringify(ids), url);
  }
});

test('capacidades: estratégia por parâmetros não confirmada está desligada e nada não confirmado vira evidência', () => {
  assert.deepEqual(LOOKUP_STRATEGIES.filter((strategy) => strategy.enabled).map((strategy) => strategy.id), ['TEXT_SEARCH_THEN_MATCH']);
  assert.ok(LOOKUP_STRATEGIES.every((strategy) => !strategy.enabled || strategy.confirmed));
  const unconfirmed = FIELD_CAPABILITIES.filter((capability) => !capability.confirmed);
  assert.ok(unconfirmed.some((capability) => capability.source === 'serper-reviews'));
  assert.ok(unconfirmed.some((capability) => /Google Posts/.test(capability.field)));
});

test('divergência de telefone entre perfil e site não é "verificado": vira achado a conferir', async () => {
  const other = SITE_HTML.replace('tel:+5562999990000', 'tel:+5562988887777').replace('+55 62 99999-0000', '+55 62 98888-7777');
  const result = await collect(NAMED(), { maps: mapsProvider([PLACE]), site: siteProvider({ '/': { body: other } }) });
  const phone = byId(result).get('phone-consistency');
  assert.equal(phone?.status, 'NOT_VERIFIED');
  assert.match(phone?.claim ?? '', /NÃO coincide/);
  assert.match(phone?.limitation ?? '', /requer conferência do operador/);
  assert.equal(result.criteria.find((c) => c.criterionId === 'NAP')?.status, 'NOT_VERIFIED');
});

test('avaliações: o provedor recebe o teto de páginas; contagens inválidas ou excessivas são tratadas com honestidade', async () => {
  const seen: number[] = [];
  const make = (pagesFetched: number): ReviewsProvider => ({
    async getReviews(_ids, options) {
      seen.push(options.maxPages);
      return { state: 'FETCHED', fetchedAt: T_FETCH, pagesFetched, exhausted: true, totalReported: null, warnings: [], reviews: [] };
    },
  });
  const over = await collect(NAMED(), { maps: mapsProvider([PLACE]), reviews: make(1000) }, budget({ reviews: 2, site: 0 }));
  assert.equal(over.usage.reviews, 1000, 'o consumo relatado é o que o provedor declarou');
  assert.ok(over.limitations.some((text) => /usou mais páginas que o orçamento/.test(text)));
  for (const invalid of [-5, Number.NaN, 1.5, Infinity]) {
    const result = await collect(NAMED(), { maps: mapsProvider([PLACE]), reviews: make(invalid) }, budget({ reviews: 2, site: 0 }));
    assert.equal(result.usage.reviews, 0, `pagesFetched=${invalid} nunca produz contagem negativa ou NaN`);
  }
  assert.deepEqual(seen, [2, 2, 2, 2, 2]);
});

test('texto, datas e formatos vindos do provedor são tratados como dado hostil: nenhuma evidência some por causa deles', async () => {
  // motivo de falha gigante, com bidi e segredo
  const longReason = `${'x'.repeat(5000)}‮ token=SEGREDO-TOKEN-9`;
  const failed = await collect(NAMED(), { maps: mapsProvider(() => ({ state: 'FAILED', reason: longReason })) });
  assert.equal(failed.evidences.filter((e) => e.id.startsWith('maps-')).length, 9, 'as 9 evidências do perfil continuam presentes');
  assert.ok(failed.evidences.filter((e) => e.id.startsWith('maps-')).every((e) => (e.limitation ?? '').length <= 2000 && !/[‮]/.test(e.limitation ?? '')));
  assert.ok(!failed.limitations.some((text) => text.includes('descartada')));
  assert.deepEqual(SECRETS.filter((secret) => JSON.stringify(failed).includes(secret)), []);

  // datas inválidas ou do futuro viram "agora"
  for (const fetchedAt of ['not-a-date', '2030-01-01T00:00:00.000Z', '2026-10-20 12:10:00', '']) {
    const result = await collect(NAMED(), { maps: mapsProvider(() => ({ state: 'OK', value: [PLACE], fetchedAt })) });
    assert.equal(result.evidences.filter((e) => e.id.startsWith('maps-')).length, 9, fetchedAt);
    assert.ok(result.evidences.every((e) => Date.parse(e.consultedAt) <= Date.parse(T_NOW)), `consultedAt nunca no futuro (${fetchedAt})`);
    assert.equal(result.collectedAt, T_NOW);
  }
  const futureSite = await collect(NAMED(), {
    maps: mapsProvider([PLACE]),
    site: { async check() { return { ...(await siteProvider({ '/': { body: SITE_HTML } }).check('https://www.padaria-exemplo.example/')), checkedAt: '2031-01-01T00:00:00.000Z' }; } },
  });
  assert.ok(futureSite.evidences.every((e) => Date.parse(e.consultedAt) <= Date.parse(T_NOW)));

  // site gigante no perfil não derruba a evidência
  const hugeSite = await collect(NAMED(), { maps: mapsProvider([{ ...PLACE, website: `https://www.padaria-exemplo.example/${'a'.repeat(1900)}` }]), site: siteProvider({ '/': { body: SITE_HTML } }) });
  assert.equal(byId(hugeSite).get('maps-website')?.status, 'VERIFIED');
  assert.ok((byId(hugeSite).get('maps-website')?.claim ?? '').length <= 2000);
});

test('formatos inesperados dos provedores não derrubam a coleta (e o consumo continua contado)', async () => {
  for (const value of [{}, null, 'texto', 42]) {
    const result = await collect(NAMED(), { maps: mapsProvider(() => ({ state: 'OK', value: value as never, fetchedAt: T_FETCH })) });
    assert.equal(result.located, 'NOT_LOCATED');
    assert.equal(result.usage.maps, 1);
    assert.ok(result.limitations.some((text) => /não veio como lista/.test(text)));
  }
  const brokenSite: SiteProvider = { async check() { return { status: 'OK', finalUrl: 'https://www.padaria-exemplo.example/', checkedAt: T_SITE } as never; } };
  const result = await collect(NAMED(), { maps: mapsProvider([PLACE]), site: brokenSite });
  assert.equal(result.usage.site, 1);
  assert.ok(result.evidences.every((e) => validateEvidence(e).ok));
});

test('prazo por provedor: uma fonte que nunca responde vira falha, não trava a coleta', async () => {
  const never = new Promise<never>(() => undefined);
  const hungMaps: MapsProvider = { search: () => never };
  const started = Date.now();
  const outcome = await collectEvidence(NAMED(), { maps: hungMaps }, { budget: budget(), now: clock, providerTimeoutMs: 30 });
  assert.ok(outcome.ok);
  assert.equal(outcome.result.located, 'NOT_LOCATED');
  assert.equal(outcome.result.usage.maps, 1);
  assert.ok(outcome.result.limitations.some((text) => /tempo limite de 30 ms/.test(text)));
  allResults.push(outcome.result);

  const hungSite: SiteProvider = { check: () => never };
  const withSite = await collectEvidence(NAMED(), { maps: mapsProvider([PLACE]), site: hungSite }, { budget: budget(), now: clock, providerTimeoutMs: 30 });
  assert.ok(withSite.ok);
  assert.equal(withSite.result.usage.site, 1);
  assert.ok(withSite.result.limitations.some((text) => /Verificação do site falhou: .*tempo limite/.test(text)));
  allResults.push(withSite.result);
  assert.ok(Date.now() - started < 2000);
});

test('texto hostil do provedor (segredos, bidi, tamanho) não chega às evidências', async () => {
  const hostile = {
    ...PLACE,
    title: 'Bearer abcdefghijklmnopqrst token=SEGREDO-TOKEN-9 ‮ Padaria',
    address: 'sk-abcdefghijklmnopqrstuvwxyz1234 Rua X',
    phoneNumber: 'api_key=SEGREDO-CHAVE',
    type: 'Padaria\u0000​',
  };
  const result = await collect(NAMED(), { maps: mapsProvider([hostile]) });
  const text = JSON.stringify(result.evidences);
  assert.deepEqual(SECRETS.filter((secret) => text.includes(secret)), []);
  assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwxyz1234|abcdefghijklmnopqrst /);
  assert.doesNotMatch(text, /[‮​\u0000]/);
});

test('leitor de itens: identificadores herdados pelo protótipo são ignorados e itens além do limite são contados', () => {
  const inherited = parseMapsPlace(Object.create({ cid: CID, fid: FID, title: 'Herdado' }));
  assert.deepEqual(inherited?.identifiers, {});
  assert.equal(inherited?.title, null);
  const many = parseMapsPlaces(Array.from({ length: 130 }, () => ({ title: 'x' })));
  assert.equal(many.places.length, 100);
  assert.equal(many.ignored, 30);
});

test('INVARIANTES de todos os cenários: nunca NOT_FOUND, nunca nativo vindo de fonte externa, fontes saneadas, sem segredos', () => {
  assert.ok(allResults.length >= 15, `cenários acumulados: ${allResults.length}`);
  for (const result of allResults) {
    const ids = new Set<string>();
    for (const evidence of result.evidences) {
      assert.notEqual(evidence.status, 'NOT_FOUND', evidence.id);
      assert.equal(validateEvidence(evidence).ok, true, evidence.id);
      assert.ok(!ids.has(evidence.id), `id repetido ${evidence.id}`);
      ids.add(evidence.id);
      if (evidence.origin !== 'GOOGLE_NATIVE' && evidence.status !== 'NOT_VERIFIED') {
        assert.ok(!evidence.attribute.startsWith('google_'), `${evidence.id}: fonte externa provando recurso nativo`);
        assert.ok(!['CATEGORIES', 'REVIEWS', 'REVIEW_REPLIES', 'POSTS_ACTIVITY'].includes(evidence.criterionId), evidence.id);
      }
      if (evidence.sourceUrl) assert.ok(isSanitizedUrl(evidence.sourceUrl), `${evidence.id}: ${evidence.sourceUrl}`);
    }
    assert.deepEqual(SECRETS.filter((secret) => JSON.stringify(result).includes(secret)), []);
    assert.equal(result.criteria.length, 9);
  }
});

test('nenhuma chamada de rede, DNS ou disco em toda a coleta simulada', () => {
  for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
  assert.deepEqual(listData(), dataBefore);
  assert.equal(fs.existsSync(path.join(process.cwd(), '.data', 'link-audits')), false);
});
