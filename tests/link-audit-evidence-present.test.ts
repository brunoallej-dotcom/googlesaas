import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createEvidenceReader, toAuditDetailDto, toListItem, type AuditView } from '../src/lib/link-audit-evidence';
import { deriveCidFromFeatureId } from '../src/lib/link-audit/identifiers';
import { bodyText, registerCleanup, SENTINEL, tmpDir, writeFull } from './helpers/link-audit-evidence-fixtures';
import { AUD001_AUDIT, AUD001_BASE, AUD001_DIR, aud001CapturePresent, readAud001Json } from './helpers/link-audit-aud001-real-capture';

registerCleanup();
const actor = { email: 'ana@empresa.com' };
const allow = (a: { email: string }): boolean => a.email === 'ana@empresa.com';

const TOP_KEYS = ['auditId', 'collectedAt', 'company', 'divergences', 'establishment', 'evidences', 'identifiers', 'integrity', 'kind', 'layout', 'limitations', 'located', 'location', 'methodologyVersion', 'scoring', 'selected', 'site', 'source', 'state', 'versions'];

test('DTO de detalhe: só os campos previstos, com coordenadas, horários e evidências; nada do corpo bruto', async () => {
  const base = tmpDir();
  await writeFull(base, { body: bodyText({ latitude: -16.1, longitude: -49.2, openingHours: { 'quinta-feira': '07:15–17:15', sábado: 'Fechado' } }) });
  const reader = createEvidenceReader({ baseDir: base, authorize: allow });
  const view = await reader.getAudit(actor, 'auditoria-teste-0001');
  assert.ok(view);
  const dto = toAuditDetailDto(view);
  assert.deepEqual(Object.keys(dto).sort(), TOP_KEYS);
  assert.deepEqual(dto.location, { latitude: -16.1, longitude: -49.2 });
  assert.equal(dto.establishment?.name, 'Padaria Exemplo (fictícia)');
  assert.deepEqual(dto.establishment?.openingHours, [{ day: 'quinta-feira', hours: '07:15–17:15' }, { day: 'sábado', hours: 'Fechado' }]);
  assert.equal(dto.establishment?.ratingCount, 86);
  assert.ok(dto.evidences.verified.length >= 8);
  assert.ok(dto.evidences.verified.every((e) => e.criterionId.length > 0));
  assert.equal(dto.identifiers.returnedByProvider?.placeId, 'ChIJN1t_tDeuEmsRUsoyG83frY4');
  assert.equal(dto.identifiers.derivedCid, null, 'o link do fixture já traz o cid: nada foi derivado');
  assert.deepEqual(dto.integrity.status, 'OK');
  assert.ok(!JSON.stringify(dto).includes(SENTINEL) && !/bodyText|thumbnail|"places"/.test(JSON.stringify(dto)));
});

test('DTO de lista: resumo seguro por empresa', async () => {
  const base = tmpDir();
  await writeFull(base);
  const [summary] = await createEvidenceReader({ baseDir: base, authorize: allow }).listAudits(actor);
  assert.ok(summary);
  const item = toListItem(summary);
  assert.deepEqual(Object.keys(item).sort(), ['auditId', 'captureCount', 'city', 'collectedAt', 'companyName', 'confirmedCid', 'integrity', 'layout', 'reportRevisions', 'sourceLabel', 'state', 'stateCode']);
  assert.equal(item.sourceLabel, 'Serper /maps (intermediário; não é a API oficial do Google)');
});

test('DTO com visão hostil (tipos errados, textos enormes, listas gigantes) não lança e é limitado', () => {
  const huge = 'x'.repeat(50_000);
  const view = {
    auditId: 'auditoria-teste-0001', layout: 'VERSIONED', selected: { capture: 1, revision: 1 }, state: 'COMPLETE',
    company: { name: huge, city: null, stateCode: null, originalLink: null }, collectedAt: null, methodologyVersion: null,
    source: { provider: 'x', officialGoogleApi: false, description: null, httpStatus: null, httpAttempts: null, creditsReportedByApi: null, resultCount: null },
    located: null, location: null, identifiers: 'não é objeto', identityBasis: null,
    data: { googleMaps: { name: huge, openingHours: [['a', 'b'], 'lixo', [1, 2], ...Array.from({ length: 100 }, (_, i) => [`dia${i}`, 'h'])], secondaryCategories: Array.from({ length: 100 }, () => huge), rating: 'cinco', ratingCount: Number.NaN }, site: { accessNote: huge } },
    evidences: { verified: Array.from({ length: 5 }, () => ({ id: huge, criterionId: huge, attribute: huge, claim: huge, status: 'VERIFIED', origin: 'X', consultedAt: null, limitation: huge })), unverified: [], other: [] },
    limitations: Array.from({ length: 500 }, () => huge), divergences: [{ field: huge, googleMaps: huge, site: huge, note: huge }, 'lixo', null],
    calls: null, scoring: 'NOT_AVAILABLE_PENDING_D3',
    integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles: 1, issues: Array.from({ length: 100 }, () => 'x'), note: 'n' },
    versions: Array.from({ length: 500 }, () => ({ capture: 1, collectedAt: null, httpStatus: null, reportRevisions: Array.from({ length: 500 }, (_, r) => ({ revision: r, generatedAt: null, superseded: false })) })),
  } as unknown as AuditView;
  const dto = toAuditDetailDto(view);
  assert.ok(dto.establishment && dto.establishment.name!.length <= 600 && dto.establishment.openingHours.length <= 14 && dto.establishment.secondaryCategories.length <= 10);
  assert.equal(dto.establishment?.rating, null);
  assert.equal(dto.establishment?.ratingCount, null);
  assert.ok(dto.limitations.length <= 40 && dto.limitations.every((l) => l.length <= 1200));
  assert.ok(dto.versions.length <= 20 && dto.versions[0]!.reportRevisions.length <= 20);
  assert.ok(dto.evidences.verified.length <= 40);
  assert.ok(dto.integrity.issues.length <= 20);
  assert.ok(dto.evidences.verified.every((e) => e.claim.length <= 600 && e.id.length <= 80));
  assert.equal(dto.identifiers.confirmed.length, 0);
  assert.ok(dto.divergences.length <= 10);
  assert.ok(JSON.stringify(dto).length < 600_000, 'a resposta tem teto mesmo com dados enormes');
});

/*
 * A captura REAL da AUD-001 (primeira consulta LIVE), lida somente para leitura. A pasta é localizada só por variáveis de
 * ambiente (ver tests/helpers/link-audit-aud001-real-capture.ts); sem ela nesta máquina, o teste é ignorado. O repositório
 * é público: nenhum dado da empresa fica escrito aqui. O que a interface exibirá é conferido contra os próprios arquivos da
 * captura (corpo bruto do provedor e relatório) e contra a coerência CID ↔ FID, em vez de valores reais fixados no código.
 */
const BASE = AUD001_BASE;
const AUDIT = AUD001_AUDIT;
const present = aud001CapturePresent();
const snapshot = (): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(AUD001_DIR).sort().map((n) => [n, `${crypto.createHash('sha256').update(fs.readFileSync(path.join(AUD001_DIR, n))).digest('hex')}:${fs.statSync(path.join(AUD001_DIR, n)).mtimeMs}`]));

type RawReport = {
  identity: { operatorProvided: { name: string; city: string; stateCode: string } };
  providerResult: { latitude: number; longitude: number };
  data: { googleMaps: { name: string; address: string; phone: string; website: string; category: string; secondaryCategories: string[]; rating: number; ratingCount: number } };
};

test('AUD-001 real: o que a interface exibirá (CID, HTTP 200, nota e avaliações, 8 verificadas, 11 não verificadas), sem modificar a captura', { skip: !present && 'pasta da captura real ausente nesta máquina' }, async () => {
  const before = snapshot();
  const place = readAud001Json<{ places: Array<{ cid: string; fid: string }> }>('serper-body.json').places[0]!;
  const report = readAud001Json<RawReport>('report.json');
  const given = report.identity.operatorProvided;
  const maps = report.data.googleMaps;
  const reader = createEvidenceReader({ baseDir: BASE, authorize: allow });
  const item = toListItem((await reader.listAudits(actor)).find((a) => a.auditId === AUDIT)!);
  assert.deepEqual([item.companyName, item.city, item.stateCode, item.confirmedCid, item.collectedAt, item.integrity.status], [given.name, given.city, 'SP', place.cid, '2026-10-22T12:54:48.079Z', 'OK']);
  const dto = toAuditDetailDto((await reader.getAudit(actor, AUDIT))!);
  assert.deepEqual([dto.source.httpStatus, dto.source.httpAttempts, dto.source.creditsReportedByApi, dto.source.resultCount], [200, 1, 3, 1]);
  assert.ok(maps.ratingCount >= 5, 'nota elegível (≥ 5 avaliações)');
  assert.deepEqual([dto.establishment?.rating, dto.establishment?.ratingCount], [maps.rating, maps.ratingCount]);
  assert.ok(maps.name.length > 0 && maps.address.length > 0 && maps.phone.length > 0 && maps.category.length > 0);
  assert.deepEqual(
    [dto.establishment?.name, dto.establishment?.address, dto.establishment?.phone, dto.establishment?.category, dto.establishment?.secondaryCategories],
    [maps.name, maps.address, maps.phone, maps.category, maps.secondaryCategories.slice(0, 10)],
  );
  const site = new URL(dto.establishment?.website ?? '');
  assert.deepEqual([site.protocol, site.host, site.pathname, site.search, site.hash], ['https:', new URL(maps.website).host, '/', '', ''], 'website só como esquema + host');
  assert.equal(dto.establishment?.openingHours.length, 7);
  assert.deepEqual(dto.location, { latitude: report.providerResult.latitude, longitude: report.providerResult.longitude });
  assert.deepEqual([dto.evidences.verified.length, dto.evidences.unverified.length, dto.evidences.other.length], [8, 11, 0]);
  const fromLink = deriveCidFromFeatureId(dto.identifiers.fromLink.featureId);
  assert.ok(fromLink.ok && fromLink.cid === place.cid, 'o CID derivado do FID do link é o devolvido pelo provedor');
  assert.deepEqual(dto.identifiers.confirmed.map((c) => [c.type, c.value, c.expectedOrigin]), [['cid', place.cid, 'DERIVED_FROM_FID']]);
  assert.equal(dto.identifiers.returnedByProvider?.featureId, place.fid);
  assert.equal(dto.site?.accessClass, 'RESTRICTED_RESPONSE_UNSPECIFIED');
  assert.deepEqual(dto.versions[0]?.reportRevisions.map((r) => [r.revision, r.superseded]), [[1, true], [2, false]]);
  assert.equal(dto.scoring, 'NOT_AVAILABLE_PENDING_D3');
  const wire = JSON.stringify(dto);
  assert.ok(!/bodyText|thumbnail|googleusercontent|"places"|searchParameters/.test(wire));
  assert.deepEqual(snapshot(), before, 'SHA-256 e data de modificação idênticos antes e depois');
});

test('DTO: website e requestedUrl só saem como esquema + host; caminho, credenciais, parâmetros (inclusive UTM) e fragmento nunca', () => {
  const raw = 'https://user:pass@exemplo.com.br/convidado/abc123XYZ;jsessionid=SECRET012345?token=zz&utm_source=gbp';
  const view = {
    auditId: 'auditoria-teste-0001', layout: 'VERSIONED', selected: { capture: 1, revision: 1 }, state: 'COMPLETE',
    company: { name: null, city: null, stateCode: null, originalLink: null }, collectedAt: null, methodologyVersion: null,
    source: { provider: 'x', officialGoogleApi: false, description: null, httpStatus: null, httpAttempts: null, creditsReportedByApi: null, resultCount: null },
    located: null, location: null, identifiers: null, identityBasis: null,
    data: { googleMaps: { name: 'Empresa', website: raw }, site: { requestedUrl: raw, accessClass: 'OK' } },
    evidences: { verified: [], unverified: [], other: [] }, limitations: [], divergences: [], calls: null, scoring: 'NOT_AVAILABLE_PENDING_D3',
    integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles: 1, issues: [], note: 'n' }, versions: [],
  } as unknown as AuditView;
  const dto = toAuditDetailDto(view);
  assert.equal(dto.establishment?.website, 'https://exemplo.com.br/');
  assert.equal(dto.site?.requestedUrl, 'https://exemplo.com.br/');
  assert.ok(!/SECRET012345|jsessionid|convidado|abc123XYZ|token|user:pass|gbp/.test(JSON.stringify(dto)));
  const junk = toAuditDetailDto({ ...view, data: { googleMaps: { name: 'E', website: 'texto livre ?token=zz' }, site: { requestedUrl: 'javascript:alert(1)' } } } as unknown as AuditView);
  assert.equal(junk.establishment?.website, null, 'valor que não é URL http(s) não é exibido');
  assert.equal(junk.site?.requestedUrl, null);
});

test('DTO: URLs dentro de textos livres (claim, limitation, limitations, divergências, notas) saem só como esquema + host', () => {
  const raw = 'https://exemplo.com.br/convidado/abc123XYZ;jsessionid=SECRET012345/x?token=zz';
  const evidence = { id: 'e1', criterionId: 'C1', attribute: 'website', claim: `Site informado no perfil: ${raw}`, status: 'VERIFIED', origin: 'GOOGLE_MAPS', consultedAt: null, limitation: `Veja (${raw}), depois ${raw}.` };
  const view = {
    auditId: 'auditoria-teste-0001', layout: 'VERSIONED', selected: { capture: 1, revision: 1 }, state: 'COMPLETE',
    company: { name: null, city: null, stateCode: null, originalLink: null }, collectedAt: null, methodologyVersion: null,
    source: { provider: 'x', officialGoogleApi: false, description: `fonte ${raw}`, httpStatus: null, httpAttempts: null, creditsReportedByApi: null, resultCount: null },
    located: null, location: null, identifiers: null, identityBasis: null,
    data: { googleMaps: { name: 'Empresa', address: `Rua A, ${raw}` }, site: { accessClass: 'OK', accessNote: `nota ${raw}` } },
    evidences: { verified: [evidence], unverified: [evidence], other: [evidence] },
    limitations: [`Limite: ${raw}!`, `https://${'a'.repeat(3000)}.com/segredo`],
    divergences: [{ field: 'website', googleMaps: 'exemplo.com.br', site: 'exemplo.com.br', note: `Diferem: ${raw}.` }],
    calls: null, scoring: 'NOT_AVAILABLE_PENDING_D3',
    integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles: 1, issues: [`erro em ${raw}`], note: `nota ${raw}` }, versions: [],
  } as unknown as AuditView;
  const dto = toAuditDetailDto(view);
  const wire = JSON.stringify(dto);
  assert.ok(!/convidado|abc123XYZ|jsessionid|SECRET012345|token=zz|segredo/.test(wire), 'nenhum segmento do caminho aparece no JSON do DTO');
  assert.equal(dto.evidences.verified[0]?.claim, 'Site informado no perfil: https://exemplo.com.br/');
  assert.equal(dto.evidences.verified[0]?.limitation, 'Veja (https://exemplo.com.br/), depois https://exemplo.com.br/.');
  assert.equal(dto.limitations[0], 'Limite: https://exemplo.com.br/!', 'pontuação colada ao link é preservada');
  assert.equal(dto.limitations[1], '[link omitido]', 'URL que não reduz vira marcador neutro');
  assert.equal(dto.divergences[0]?.note, 'Diferem: https://exemplo.com.br/.');
});
