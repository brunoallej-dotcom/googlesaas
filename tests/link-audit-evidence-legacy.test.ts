import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { deriveCidFromFeatureId } from '../src/lib/link-audit/identifiers';
import { createEvidenceReader } from '../src/lib/link-audit-evidence/reader';
import { verifyCapture } from '../scripts/link-audit-evidence';
import { AUD001_AUDIT, AUD001_BASE, AUD001_DIR, aud001CapturePresent, readAud001Json } from './helpers/link-audit-aud001-real-capture';

/*
 * Leitura SOMENTE LEITURA da captura real da AUD-001 (primeira consulta LIVE), sem rede e sem modificar nada.
 * A pasta é localizada só por variáveis de ambiente (ver tests/helpers/link-audit-aud001-real-capture.ts); sem ela
 * (outra máquina, CI), o teste é ignorado. O repositório é público: nenhum dado da empresa fica escrito aqui. As
 * asserções conferem o leitor contra os próprios arquivos da captura (corpo bruto do provedor e relatório) e a
 * coerência CID ↔ FID, em vez de valores reais fixados no código.
 */
const BASE = AUD001_BASE;
const AUDIT = AUD001_AUDIT;
const DIR = AUD001_DIR;
const present = aud001CapturePresent();

type RawPlace = { cid: string; fid: string; placeId: string };
type RawReport = { identity: { operatorProvided: { name: string; city: string } }; data: { googleMaps: { address: string } } };

const snapshot = (): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(DIR).sort().map((name) => [name, `${crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, name))).digest('hex')}:${fs.statSync(path.join(DIR, name)).mtimeMs}`]));

test('captura real da AUD-001: leitura íntegra, identidade comprovada e NADA modificado', { skip: !present && 'pasta da captura real ausente nesta máquina' }, async () => {
  const before = snapshot();

  // arquivos originais: manifesto, hashes, corpo bruto (CID coerente com o FID) e relatório
  const verified = verifyCapture(DIR);
  assert.ok(verified.ok, JSON.stringify(verified));
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'MANIFEST.json'), 'utf8')) as { storageWarning: string; files: Array<{ name: string }> };
  assert.match(manifest.storageWarning, /NÃO é um backup independente/);
  const body = readAud001Json<{ places: RawPlace[]; credits: number }>('serper-body.json');
  const place = body.places[0];
  assert.ok(place, 'um resultado no corpo bruto');
  const derived = deriveCidFromFeatureId(place.fid);
  assert.ok(derived.ok && derived.cid === place.cid, 'o cid devolvido é a 2ª metade do fid devolvido, em decimal');
  assert.equal(BigInt(place.fid.split(':')[1] as string).toString(), place.cid);
  assert.match(place.placeId, /^[A-Za-z0-9_-]{20,255}$/);
  assert.equal(body.credits, 3);
  const report = readAud001Json<RawReport>('report.json');
  const given = report.identity.operatorProvided;
  assert.ok(given.name.length > 0 && given.city.length > 0, 'nome e cidade informados pelo operador');

  // leitor autorizado
  const reader = createEvidenceReader({ baseDir: BASE, authorize: (a) => a.email === 'operador@teste.com' });
  const actor = { email: 'operador@teste.com' };
  const listed = (await reader.listAudits(actor)).find((a) => a.auditId === AUDIT);
  assert.ok(listed);
  assert.deepEqual([listed.layout, listed.confirmedCid, listed.collectedAt], ['LEGACY', place.cid, '2026-10-22T12:54:48.079Z']);
  assert.equal(listed.integrity.status, 'OK');

  const view = await reader.getAudit(actor, AUDIT);
  assert.ok(view);
  assert.deepEqual([view.source.httpStatus, view.source.httpAttempts, view.source.creditsReportedByApi, view.located], [200, 1, 3, 'MATCHED']);
  assert.equal(view.source.officialGoogleApi, false);
  assert.deepEqual([view.company.name, view.company.city], [given.name, given.city]);
  assert.ok(view.evidences.verified.length === 8 && view.evidences.unverified.length === 11);
  const everything = JSON.stringify(view);
  assert.ok(everything.includes(place.cid) && everything.includes(report.data.googleMaps.address));
  assert.ok(!/bodyText|"places"|thumbnailUrl|googleusercontent|x-api-key/i.test(everything), 'corpo bruto e miniatura não saem do leitor');
  assert.equal((view.data.site as { accessClass: string }).accessClass, 'RESTRICTED_RESPONSE_UNSPECIFIED');
  assert.ok(view.limitations.some((l) => /não foi consultado de novo|não foi gravado/.test(l)));
  const versions = await reader.listVersions(actor, AUDIT);
  assert.deepEqual(versions[0]?.reportRevisions.map((r) => r.superseded), [true, false]);

  assert.deepEqual(snapshot(), before, 'SHA-256 e data de modificação de todos os arquivos idênticos antes e depois');
});
