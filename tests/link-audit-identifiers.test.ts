import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEvidence } from '../src/lib/link-audit/collector/collect';
import { hasComparableIdentifier, matchPlace, parseMapsPlace, parseMapsPlaces } from '../src/lib/link-audit/collector/maps-place';
import { buildExpectedIdentity, deriveCidFromFeatureId, featureIdParts, MAX_UINT64, normalizeCid, placeEntityCid } from '../src/lib/link-audit/identifiers';
import { parseGoogleMapsLink } from '../src/lib/link-audit/maps-link';
import { buildSerperMapsBody, createSerperMapsProvider, type SerperTransport } from '../src/lib/link-audit-runtime/serper-maps-provider';
import { runLinkAuditCollection } from '../src/lib/link-audit-runtime/run';
import { FAKE_KEY, clock, identityFor, inputFor, mapsFake, PLACE, siteFake, SITE_HTML } from './helpers/link-audit-collect-fixtures';

/* Pares PÚBLICOS: Google (Places API / URLs do Maps, Sydney Opera House) e DataForSEO (central de ajuda). */
const GOOGLE_FID = '0x6b12ae665e892fdd:0x3133f8d75a1ac251';
const GOOGLE_CID = '3545450935484072529';
const DATAFORSEO_HEX = '28e48b1a90ccf57e';
const DATAFORSEO_CID = '2946633002421908862';
/* Empresa de referência da Onda 4C. */
const AUD001_LINK = 'https://www.google.com/maps/place/AUD-001+COMERCIO/data=!4m2!3m1!1s0x0:0x5b7d9e2c4a6f8e1d?sa=X&ved=1t:2428&hl=pt-BR&ictx=111';
const AUD001_FID = '0x0:0x5b7d9e2c4a6f8e1d';
const AUD001_CID = '6592599342604848669';

test('conversão FID → CID com os pares públicos do Google e da DataForSEO', () => {
  const google = deriveCidFromFeatureId(GOOGLE_FID);
  assert.ok(google.ok);
  assert.equal(google.cid, GOOGLE_CID);
  assert.equal(google.origin, 'DERIVED_FROM_FID');
  assert.equal(google.featureId, GOOGLE_FID, 'o FID original é preservado');
  const dataforseo = deriveCidFromFeatureId(`0x1:0x${DATAFORSEO_HEX}`);
  assert.ok(dataforseo.ok && dataforseo.cid === DATAFORSEO_CID);
});

test('FID com prefixo 0x0 (link da AUD-001) e FID completo dão o mesmo CID quando a 2ª parte é igual', () => {
  const zero = deriveCidFromFeatureId(AUD001_FID);
  const full = deriveCidFromFeatureId('0x94a1b2c3d4e5f607:0x5b7d9e2c4a6f8e1d');
  assert.ok(zero.ok && full.ok);
  assert.equal(zero.cid, AUD001_CID);
  assert.equal(full.cid, AUD001_CID);
  assert.equal(zero.featureId, AUD001_FID);
});

test('valores acima de Number.MAX_SAFE_INTEGER não perdem precisão (BigInt)', () => {
  assert.ok(BigInt(AUD001_CID) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.notEqual(String(Number(AUD001_CID)), AUD001_CID, 'prova: Number realmente perderia dígitos');
  assert.equal((deriveCidFromFeatureId(AUD001_FID) as { cid: string }).cid, AUD001_CID);
  const top = deriveCidFromFeatureId('0x1:0xffffffffffffffff');
  assert.ok(top.ok && top.cid === MAX_UINT64.toString());
  assert.equal(MAX_UINT64.toString(), '18446744073709551615');
});

test('limites do CID decimal: 1 e 2^64−1 valem; 0, 2^64 e formatos estranhos não', () => {
  for (const ok of ['1', '18446744073709551615', '0000000000000000001', AUD001_CID]) assert.equal(normalizeCid(ok).ok, true, ok);
  assert.deepEqual(normalizeCid('0000000000000000001'), { ok: true, cid: '1' }, 'zeros à esquerda são removidos');
  for (const bad of ['0', '00', '18446744073709551616', '99999999999999999999', '', ' 1', '1 ', '+1', '-1', '1.5', '1e3', '0x10', '१२३', '123456789012345678901', 'abc']) {
    assert.equal(normalizeCid(bad).ok, false, JSON.stringify(bad));
  }
  for (const notText of [1, 1n, null, undefined, {}, [], Number.MAX_SAFE_INTEGER]) assert.equal(normalizeCid(notText).ok, false);
});

test('FID inválido é recusado sem derivar nada', () => {
  for (const bad of ['', '0x0:', '0x:0x1', '0x1:0x', '1:2', '0x1;0x2', '0x1:0x1:0x1', '0x11111111111111111:0x1', '0x1:0x11111111111111111', '0x1:0xg', '0x0:0x0', ' 0x1:0x2', null, undefined, 7, {}]) {
    assert.equal(deriveCidFromFeatureId(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(featureIdParts('0X6B12AE665E892FDD:0X3133F8D75A1AC251')?.featureId, GOOGLE_FID, 'maiúsculas viram minúsculas');
});

test('o parser da Onda 1 não muda: o link da AUD-001 só traz o FID e a identidade esperada deriva o CID', () => {
  const parsed = parseGoogleMapsLink(AUD001_LINK);
  assert.equal(parsed.status, 'IDENTIFIED');
  assert.deepEqual(parsed.status === 'IDENTIFIED' && parsed.identifiers, { featureId: AUD001_FID });
  const expected = buildExpectedIdentity({ featureId: AUD001_FID });
  assert.deepEqual(expected.cid, { value: AUD001_CID, origin: 'DERIVED_FROM_FID' });
  assert.equal(expected.featureId, AUD001_FID);
  assert.equal(expected.placeId, undefined, 'o Place ID nunca é inventado');
});

test('link com cid e fid que não se correspondem: identidade esperada inconsistente', () => {
  const conflict = buildExpectedIdentity({ cid: '123', featureId: AUD001_FID });
  assert.match(conflict.conflict ?? '', /não correspondem/);
  const fine = buildExpectedIdentity({ cid: AUD001_CID, featureId: AUD001_FID });
  assert.equal(fine.conflict, undefined);
  assert.deepEqual(fine.cid, { value: AUD001_CID, origin: 'LINK' });
});

// --------------------------------------------------------------------------------- casamento

const wanted = { featureId: AUD001_FID };
const place = (extra: Record<string, unknown>) => parseMapsPlace({ title: 'AUD-001 COMÉRCIO', ...extra })!;

test('CID correspondente aceita; CID divergente não aceita', () => {
  assert.equal(matchPlace([place({ cid: AUD001_CID })], wanted).state, 'MATCHED');
  assert.equal(matchPlace([place({ cid: '6592599342604848670' })], wanted).state, 'NOT_LOCATED', 'um dígito de diferença');
  assert.equal(matchPlace([place({ cid: '6592599342604848668' })], wanted).state, 'NOT_LOCATED');
});

test('FID do resultado com prefixo diferente mas mesmo CID: equivalente (prefixo 0x0 do link não contradiz)', () => {
  const real = place({ fid: '0x94a1b2c3d4e5f607:0x5b7d9e2c4a6f8e1d' });
  const match = matchPlace([real], wanted);
  assert.equal(match.state, 'MATCHED');
  assert.deepEqual(match.state === 'MATCHED' && match.basis, { provenCid: AUD001_CID, cid: true, placeId: false, expectedCidOrigin: 'DERIVED_FROM_FID', resultCidSource: 'fid' });
  assert.equal(matchPlace([place({ fid: '0x94a1b2c3d4e5f607:0x5b7d9e2c4a6f8e1d', cid: AUD001_CID })], wanted).state, 'MATCHED');
  // prefixos diferentes e não-zero dos dois lados também são equivalentes
  assert.equal(matchPlace([real], { featureId: '0x11:0x5b7d9e2c4a6f8e1d' }).state, 'MATCHED');
});

test('FID do resultado com 2ª parte diferente não casa, mesmo com o prefixo igual', () => {
  assert.equal(matchPlace([place({ fid: '0x0:0x5b7d9e2c4a6f8e1e' })], wanted).state, 'NOT_LOCATED');
});

test('resposta sem identificador comparável: identidade não confirmada, nada aceito por nome', () => {
  const nameOnly = place({});
  assert.equal(matchPlace([nameOnly], wanted).state, 'NOT_LOCATED');
  assert.equal(hasComparableIdentifier(nameOnly, wanted), false);
  assert.equal(hasComparableIdentifier(place({ placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4' }), wanted), false, 'placeId não é comparável com um link que só tem fid');
  assert.equal(hasComparableIdentifier(place({ cid: '1' }), wanted), true);
  assert.equal(hasComparableIdentifier(place({ fid: '0x1:0x2' }), wanted), true);
});

test('empresas com nomes semelhantes: só o CID decide', () => {
  const certa = place({ title: 'AUD-001 COMERCIO LTDA', cid: AUD001_CID });
  const parecida = place({ title: 'AUD-001 COMÉRCIO', cid: '6592599342604848000' });
  assert.equal(matchPlace([parecida], wanted).state, 'NOT_LOCATED', 'nome idêntico, CID diferente');
  const both = matchPlace([parecida, certa], wanted);
  assert.equal(both.state, 'MATCHED');
  assert.equal(both.state === 'MATCHED' && both.place.title, 'AUD-001 COMERCIO LTDA');
});

test('respostas contraditórias: nada é escolhido', () => {
  const internal = place({ cid: AUD001_CID, fid: '0x1:0x2' });
  assert.equal(placeEntityCid(internal.identifiers).state, 'CONTRADICTORY');
  assert.equal(matchPlace([internal], wanted).state, 'AMBIGUOUS', 'cid casa mas o próprio fid discorda');
  const viaFid = place({ cid: '999', fid: '0x1:0x5b7d9e2c4a6f8e1d' });
  assert.equal(matchPlace([viaFid], wanted).state, 'AMBIGUOUS', 'o fid casa mas o próprio cid discorda');
  assert.equal(matchPlace([place({ cid: '999', fid: '0x1:0x2' })], wanted).state, 'NOT_LOCATED', 'contraditório e sem relação com a empresa é ignorado');
  const withPlaceId = { featureId: AUD001_FID, placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4' };
  assert.equal(matchPlace([place({ cid: AUD001_CID, placeId: 'ChIJoutroPlaceIdAAAAAAAAA' })], withPlaceId).state, 'AMBIGUOUS', 'cid casa, placeId diverge');
  assert.equal(matchPlace([place({ placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', cid: '777' })], withPlaceId).state, 'AMBIGUOUS', 'placeId casa, cid diverge');
  assert.equal(matchPlace([place({ cid: AUD001_CID }), place({ cid: '6592599342604848670', placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4' })], withPlaceId).state, 'AMBIGUOUS', 'dois negócios distintos');
  assert.equal(matchPlace([place({ cid: AUD001_CID })], { cid: '1', featureId: AUD001_FID }).state, 'AMBIGUOUS', 'identidade esperada inconsistente');
});

test('cid de resultado fora de 64 bits, com sinal ou como número impreciso é descartado', () => {
  for (const cid of ['18446744073709551616', '-5', '1.5', '1 2', 6592599342604848669, 1e21]) {
    const parsed = parseMapsPlace({ title: 'x', cid });
    assert.equal(parsed?.identifiers.cid, undefined, String(cid));
  }
  assert.equal(parseMapsPlace({ title: 'x', cid: '06592599342604848669' })?.identifiers.cid, AUD001_CID, 'zeros à esquerda normalizados');
  assert.equal(parseMapsPlaces([{ title: 'x', cid: AUD001_CID }]).places[0]?.identifiers.cid, AUD001_CID);
});

// -------------------------------------------------------------------------- coletor e identidade original

const aud001Identity = () => identityFor(AUD001_LINK, { name: 'AUD-001 COMÉRCIO' });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('coleta da AUD-001: aceita por CID derivado, preserva a identidade original e as confirmações do operador', async () => {
  const identity = aud001Identity();
  const input = inputFor(identity, 'snap-aud-001-0001');
  const before = clone(input);
  const outcome = await collectEvidence(
    input,
    { maps: mapsFake([{ title: 'Outra', cid: '1' }, { title: 'AUD-001 COMÉRCIO', fid: '0x94a1b2c3d4e5f607:0x5b7d9e2c4a6f8e1d', address: 'Rua Fictícia, 1' }]) },
    { budget: { maps: 1, reviews: 0, site: 0 }, now: clock },
  );
  assert.ok(outcome.ok);
  assert.equal(outcome.result.located, 'MATCHED');
  assert.deepEqual(outcome.result.identityBasis, { expectedCid: { value: AUD001_CID, origin: 'DERIVED_FROM_FID' }, matchedBy: { cid: true, placeId: false, provenCid: AUD001_CID, resultCidSource: 'fid' } });
  assert.match(outcome.result.limitations.join(' '), /CID do resultado do Serper foi derivado do fid dele/);
  assert.match(outcome.result.limitations.join(' '), new RegExp(`CID esperado \\(${AUD001_CID}\\) foi derivado do FID do link por conversão offline; não foi retornado por nenhuma API`));
  assert.deepEqual(outcome.result.provenIdentifiers, { cid: AUD001_CID }, 'o CID foi efetivamente comparado e confirmado; o FID não é igual por inteiro (prefixo difere)');
  assert.deepEqual(outcome.result.identifiers.fromLink, { featureId: AUD001_FID });
  assert.deepEqual(outcome.result.identifiers.derived, { cid: { value: AUD001_CID, derivedFrom: 'featureId', method: 'hex-suffix-to-decimal-bigint' } });
  assert.deepEqual(outcome.result.identifiers.returnedByProvider, { featureId: '0x94a1b2c3d4e5f607:0x5b7d9e2c4a6f8e1d' });
  assert.deepEqual(outcome.result.identifiers.confirmed, [{ type: 'cid', value: AUD001_CID, expectedOrigin: 'DERIVED_FROM_FID', providerFields: ['fid (2ª metade)'], result: 'EQUAL' }]);
  assert.deepEqual(input, before, 'a entrada não é mutada');
  assert.equal(identity.identifiers.featureId, AUD001_FID);
  assert.equal(identity.identifiers.cid, undefined, 'o CID derivado não entra na identidade confirmada');
  assert.equal(identity.confirmation?.confirmedBy, 'ana@empresa.com');
  assert.equal(identity.name, 'AUD-001 COMÉRCIO');
});

test('coleta: resposta sem CID/FID comparável ⇒ identidade não confirmada; nada do perfil é aceito', async () => {
  const outcome = await collectEvidence(inputFor(aud001Identity()), { maps: mapsFake([{ title: 'AUD-001 COMÉRCIO', address: 'Rua Fictícia, 1', phoneNumber: '(62) 3333-4444' }]) }, { budget: { maps: 1, reviews: 0, site: 0 }, now: clock });
  assert.ok(outcome.ok);
  assert.equal(outcome.result.located, 'NOT_LOCATED');
  assert.equal(outcome.result.profile, null);
  assert.equal(outcome.result.identityBasis.matchedBy, null);
  assert.match(outcome.result.limitations.join(' '), /nenhum com identificador comparável/);
});

test('coleta: link com cid e fid incompatíveis é recusado antes de qualquer chamada', async () => {
  const bad = identityFor('https://www.google.com/maps/place/X/data=!1s0x0:0x5b7d9e2c4a6f8e1d?cid=123');
  let called = 0;
  const outcome = await collectEvidence(inputFor(bad), { maps: { search: async () => { called += 1; return { state: 'FAILED', reason: 'x' }; } } }, { budget: { maps: 1, reviews: 0, site: 0 }, now: clock });
  assert.ok(!outcome.ok && outcome.code === 'IDENTITY_MISMATCH');
  assert.equal(called, 0);
});

// --------------------------------------------------------------------------- adaptador e orçamento

test('o adaptador só envia "cid" se o pedido trouxer; o coletor nunca o pede (parâmetro de entrada não confirmado)', async () => {
  assert.deepEqual(buildSerperMapsBody({ query: 'AUD-001 COMÉRCIO', viewport: null }), { q: 'AUD-001 COMÉRCIO', gl: 'br', hl: 'pt-br', page: 1 });
  assert.equal((buildSerperMapsBody({ query: 'x', viewport: null, cid: AUD001_CID }) as { cid?: string }).cid, AUD001_CID);
  assert.equal('cid' in buildSerperMapsBody({ query: 'x', viewport: null, cid: '12abc' }), false, 'cid inválido nunca é enviado');
  const seen: unknown[] = [];
  const transport: SerperTransport = async (_url, init) => { seen.push(JSON.parse(init.body)); return { ok: true, status: 200, readText: async () => '{"places":[]}' }; };
  const provider = createSerperMapsProvider({ apiKey: FAKE_KEY, transport, now: clock });
  await collectEvidence(inputFor(aud001Identity()), { maps: provider }, { budget: { maps: 1, reviews: 0, site: 0 }, now: clock });
  assert.equal(seen.length, 1, 'uma única chamada');
  assert.deepEqual(seen[0], { q: 'AUD-001 COMÉRCIO', gl: 'br', hl: 'pt-br', page: 1 });
});

test('DRY_RUN da AUD-001: CID derivado, requisição sem chave, critério e 3 créditos; nenhum provedor acionado', async () => {
  const outcome = await runLinkAuditCollection(
    { input: inputFor(aud001Identity(), 'snap-aud-001-0001') },
    { now: clock, providers: { maps: { search: async () => { throw new Error('ACIONADO'); } } }, createLiveProviders: () => { throw new Error('ACIONADO'); } },
  );
  assert.ok(outcome.ok && outcome.kind === 'PLAN');
  const plan = outcome.plan;
  assert.deepEqual(plan.expectedIdentity, { featureId: AUD001_FID, cid: AUD001_CID, cidOrigin: 'derivado do FID (conversão offline)', placeId: null, conflict: null });
  assert.deepEqual(plan.request, { method: 'POST', url: 'https://google.serper.dev/maps', headers: { 'X-API-KEY': '<não exibida>', 'Content-Type': 'application/json' }, body: { q: 'AUD-001 COMÉRCIO', gl: 'br', hl: 'pt-br', page: 1 } });
  assert.deepEqual(plan.cost.credits, { min: 3, max: 3 });
  assert.equal(plan.cost.confirmed, false);
  assert.equal(plan.externalTraffic, false);
  assert.ok(plan.confirmationCriterion.some((line) => /nome nunca confirma/.test(line)));
  assert.ok(!JSON.stringify(plan).includes(FAKE_KEY));
});

test('SIMULATED completo com FID de prefixo diferente: relatório mostra a base da identidade e zero tráfego', async () => {
  const outcome = await runLinkAuditCollection(
    { mode: 'SIMULATED', input: inputFor(aud001Identity(), 'snap-aud-001-0001') },
    { now: clock, providers: { maps: mapsFake([{ ...PLACE, cid: undefined, fid: '0x94a1b2c3d4e5f607:0x5b7d9e2c4a6f8e1d', website: undefined }]), site: siteFake({ '/': { body: SITE_HTML } }) } },
  );
  assert.ok(outcome.ok && outcome.kind === 'REPORT');
  assert.equal(outcome.report.located, 'MATCHED');
  assert.equal(outcome.report.identityBasis.expectedCid?.origin, 'DERIVED_FROM_FID');
  assert.equal(outcome.report.identity.identifiers.featureId, AUD001_FID);
  assert.equal(outcome.report.externalTraffic, false);
});

test('revisão 4C: identificador inválido ao lado de um que casa recusa o perfil; zeros à esquerda do link contam como comprovado', async () => {
  const lixo = parseMapsPlace({ title: 'x', fid: '0x94a1b2c3d4e5f607:0x5b7d9e2c4a6f8e1d', cid: 'lixo' })!;
  assert.equal(lixo.identifierInvalid, true);
  assert.equal(matchPlace([lixo], wanted).state, 'AMBIGUOUS');
  assert.equal(parseMapsPlace({ title: 'x', fid: '0x1:0x2' })!.identifierInvalid, false);
  const comZeros = identityFor('https://www.google.com/maps/place/X/data=!1s0x0:0x5b7d9e2c4a6f8e1d?cid=06592599342604848669');
  const outcome = await collectEvidence(inputFor(comZeros), { maps: mapsFake([{ title: 'X', cid: AUD001_CID }]) }, { budget: { maps: 1, reviews: 0, site: 0 }, now: clock });
  assert.ok(outcome.ok);
  assert.equal(outcome.result.located, 'MATCHED');
});

test('revisão 4C: link com cid e fid incompatíveis é recusado em SIMULATED/LIVE antes de consumir autorização e no DRY_RUN não monta requisição', async () => {
  const bad = inputFor(identityFor('https://www.google.com/maps/place/X/data=!1s0x0:0x5b7d9e2c4a6f8e1d?cid=123', { name: 'X' }));
  const plan = await runLinkAuditCollection({ input: bad }, { now: clock });
  assert.ok(plan.ok && plan.kind === 'PLAN' && plan.plan.request === null && plan.plan.expectedIdentity.conflict);
  let marked = 0;
  const live = await runLinkAuditCollection(
    { mode: 'LIVE', input: bad, authorization: { authorizationId: 'auth-teste-0001' } },
    { now: clock, liveEnabled: true, usedStore: { isUsed: () => false, companyUsedSince: () => false, markUsed: () => { marked += 1; return { ok: true }; } }, createLiveProviders: () => ({}) },
  );
  assert.ok(!live.ok && live.code === 'IDENTITY_MISMATCH');
  assert.equal(marked, 0, 'a autorização não é queimada por um erro detectável offline');
});

test('identificadores: link × derivado × retornado × confirmado ficam separados e nada é comprovado sem comparação', async () => {
  const run = async (place: Record<string, unknown>, link = AUD001_LINK) =>
    (await collectEvidence(inputFor(identityFor(link, { name: 'AUD-001 COMÉRCIO' })), { maps: mapsFake([place]) }, { budget: { maps: 1, reviews: 0, site: 0 }, now: clock }));
  // retorno com cid + fid + placeId extra: o placeId é mostrado como retornado mas NÃO como confirmado (o link não o tinha)
  const full = await run({ title: 'T', cid: AUD001_CID, fid: '0x94d1e2f3a4b5c6d7:0x5b7d9e2c4a6f8e1d', placeId: 'ChIJ_AUD001_ficticio_placeId' });
  assert.ok(full.ok);
  assert.deepEqual(full.result.identifiers.returnedByProvider, { cid: AUD001_CID, featureId: '0x94d1e2f3a4b5c6d7:0x5b7d9e2c4a6f8e1d', placeId: 'ChIJ_AUD001_ficticio_placeId' });
  assert.deepEqual(full.result.identifiers.confirmed.map((c) => [c.type, c.providerFields.join('+')]), [['cid', 'cid+fid (2ª metade)']]);
  assert.deepEqual(full.result.provenIdentifiers, { cid: AUD001_CID });
  // link com cid explícito + fid exato: confirmados cid (origem LINK) e featureId (igual por inteiro)
  const both = await run({ title: 'T', cid: AUD001_CID, fid: AUD001_FID }, 'https://www.google.com/maps/place/X/data=!1s0x0:0x5b7d9e2c4a6f8e1d?cid=6592599342604848669');
  assert.ok(both.ok);
  assert.deepEqual(both.result.identifiers.confirmed.map((c) => [c.type, c.expectedOrigin]), [['cid', 'LINK'], ['featureId', 'LINK']]);
  assert.deepEqual(both.result.identifiers.derived, {});
  // perfil não aceito: nada retornado, nada confirmado, nada comprovado
  const none = await run({ title: 'T', cid: '6592599342604848670' });
  assert.ok(none.ok);
  assert.equal(none.result.identifiers.returnedByProvider, null);
  assert.deepEqual(none.result.identifiers.confirmed, []);
  assert.deepEqual(none.result.provenIdentifiers, {});
});
