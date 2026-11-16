import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createEvidenceReader, toAuditDetailDto, toListItem, type AuditView } from '../src/lib/link-audit-evidence';
import { bodyText, registerCleanup, SENTINEL, tmpDir, writeFull } from './helpers/link-audit-evidence-fixtures';

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
 * A captura REAL da TUVAPLAST (primeira consulta LIVE), lida somente para leitura. O caminho pode ser trocado com
 * GMN_TEST_TUVAPLAST_BASE; se a pasta não existir nesta máquina, o teste é ignorado.
 */
const BASE = process.env.GMN_TEST_TUVAPLAST_BASE ?? '/mnt/d/gmn-evidencias-privadas/link-audit';
const AUDIT = 'tuvaplast-20261022-maps01';
const present = fs.existsSync(path.join(BASE, AUDIT, 'MANIFEST.json'));
const snapshot = (): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(path.join(BASE, AUDIT)).sort().map((n) => [n, `${crypto.createHash('sha256').update(fs.readFileSync(path.join(BASE, AUDIT, n))).digest('hex')}:${fs.statSync(path.join(BASE, AUDIT, n)).mtimeMs}`]));

test('TUVAPLAST real: o que a interface exibirá (CID, HTTP 200, nota 5,0, 49 avaliações, 8 verificadas, 11 não verificadas), sem modificar a captura', { skip: !present && 'pasta da captura real ausente nesta máquina' }, async () => {
  const before = snapshot();
  const reader = createEvidenceReader({ baseDir: BASE, authorize: allow });
  const item = toListItem((await reader.listAudits(actor)).find((a) => a.auditId === AUDIT)!);
  assert.deepEqual([item.companyName, item.city, item.stateCode, item.confirmedCid, item.collectedAt, item.integrity.status], ['TUVAPLAST COMÉRCIO', 'Mogi Guaçu', 'SP', '4193491131727734142', '2026-10-22T12:54:48.079Z', 'OK']);
  const dto = toAuditDetailDto((await reader.getAudit(actor, AUDIT))!);
  assert.deepEqual([dto.source.httpStatus, dto.source.httpAttempts, dto.source.creditsReportedByApi, dto.source.resultCount], [200, 1, 3, 1]);
  assert.deepEqual([dto.establishment?.rating, dto.establishment?.ratingCount], [5, 49]);
  assert.equal(dto.establishment?.name, 'TUVAPLAST COMERCIO');
  assert.equal(dto.establishment?.address, 'Rua Pinhal, 371 - Jardim Santo Antonio, Mogi Guaçu - SP, 13847-176, Brasil');
  assert.equal(dto.establishment?.phone, '+55 19 99836-1197');
  assert.equal(dto.establishment?.website, 'https://www.tuvaplast.com.br/');
  assert.equal(dto.establishment?.category, 'Fabricante de brinquedos');
  assert.deepEqual(dto.establishment?.secondaryCategories, ['Loja de Brinquedos']);
  assert.equal(dto.establishment?.openingHours.length, 7);
  assert.deepEqual(dto.location, { latitude: -22.3471971, longitude: -46.9463052 });
  assert.deepEqual([dto.evidences.verified.length, dto.evidences.unverified.length, dto.evidences.other.length], [8, 11, 0]);
  assert.deepEqual(dto.identifiers.confirmed.map((c) => [c.type, c.value, c.expectedOrigin]), [['cid', '4193491131727734142', 'DERIVED_FROM_FID']]);
  assert.equal(dto.identifiers.returnedByProvider?.featureId, '0x94c8579e462460e3:0x3a3245f75b61e57e');
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
