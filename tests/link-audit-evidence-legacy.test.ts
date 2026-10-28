import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createEvidenceReader } from '../src/lib/link-audit-evidence/reader';
import { verifyCapture } from '../scripts/link-audit-evidence';

/*
 * Leitura SOMENTE LEITURA da captura real da TUVAPLAST (primeira consulta LIVE), sem rede e sem modificar nada.
 * O caminho pode ser trocado com GMN_TEST_TUVAPLAST_BASE; se a pasta não existir (outra máquina), o teste é ignorado.
 */
const BASE = process.env.GMN_TEST_TUVAPLAST_BASE ?? '/mnt/d/gmn-evidencias-privadas/link-audit';
const AUDIT = 'tuvaplast-20261022-maps01';
const DIR = path.join(BASE, AUDIT);
const present = fs.existsSync(path.join(DIR, 'MANIFEST.json'));

const snapshot = (): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(DIR).sort().map((name) => [name, `${crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, name))).digest('hex')}:${fs.statSync(path.join(DIR, name)).mtimeMs}`]));

test('captura real da TUVAPLAST: leitura íntegra, identidade comprovada e NADA modificado', { skip: !present && 'pasta da captura real ausente nesta máquina' }, async () => {
  const before = snapshot();

  // arquivos originais: manifesto, hashes, corpo bruto (CID esperado) e relatório
  const verified = verifyCapture(DIR);
  assert.ok(verified.ok, JSON.stringify(verified));
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'MANIFEST.json'), 'utf8')) as { storageWarning: string; files: Array<{ name: string }> };
  assert.match(manifest.storageWarning, /NÃO é um backup independente/);
  const body = JSON.parse(fs.readFileSync(path.join(DIR, 'serper-body.json'), 'utf8')) as { places: Array<{ cid: string; fid: string; placeId: string }>; credits: number };
  assert.equal(body.places[0]?.cid, '4193491131727734142');
  assert.equal(BigInt(body.places[0]?.fid.split(":")[1] as string).toString(), '4193491131727734142');
  assert.equal(body.places[0]?.placeId, 'ChIJ42AkRp5XyJQRfuVhW_dFMjo');
  assert.equal(body.credits, 3);

  // leitor autorizado
  const reader = createEvidenceReader({ baseDir: BASE, authorize: (a) => a.email === 'operador@teste.com' });
  const actor = { email: 'operador@teste.com' };
  const listed = (await reader.listAudits(actor)).find((a) => a.auditId === AUDIT);
  assert.ok(listed);
  assert.deepEqual([listed.layout, listed.confirmedCid, listed.collectedAt], ['LEGACY', '4193491131727734142', '2026-10-22T12:54:48.079Z']);
  assert.equal(listed.integrity.status, 'OK');

  const view = await reader.getAudit(actor, AUDIT);
  assert.ok(view);
  assert.deepEqual([view.source.httpStatus, view.source.httpAttempts, view.source.creditsReportedByApi, view.located], [200, 1, 3, 'MATCHED']);
  assert.equal(view.source.officialGoogleApi, false);
  assert.equal(view.company.name, 'TUVAPLAST COMÉRCIO');
  assert.equal(view.company.city, 'Mogi Guaçu');
  assert.ok(view.evidences.verified.length === 8 && view.evidences.unverified.length === 11);
  const everything = JSON.stringify(view);
  assert.ok(everything.includes('4193491131727734142') && everything.includes('Rua Pinhal, 371'));
  assert.ok(!/bodyText|"places"|thumbnailUrl|googleusercontent|x-api-key/i.test(everything), 'corpo bruto e miniatura não saem do leitor');
  assert.equal((view.data.site as { accessClass: string }).accessClass, 'RESTRICTED_RESPONSE_UNSPECIFIED');
  assert.ok(view.limitations.some((l) => /não foi consultado de novo|não foi gravado/.test(l)));
  const versions = await reader.listVersions(actor, AUDIT);
  assert.deepEqual(versions[0]?.reportRevisions.map((r) => r.superseded), [true, false]);

  assert.deepEqual(snapshot(), before, 'SHA-256 e data de modificação de todos os arquivos idênticos antes e depois');
});
