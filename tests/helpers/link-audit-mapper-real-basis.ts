import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateReport, persistCapture } from '../../scripts/link-audit-evidence';
import { createScoringBasisReader, type ScoringBasis } from '../../src/lib/link-audit-evidence/scoring-basis';
import { writeCapture, writeReport } from '../../src/lib/link-audit-evidence/store';
import { CID, clock, FID, LINK, PLACE_ID, T_NOW } from './link-audit-collect-fixtures';
import { AUDIT, bodyText, captureInput, tmpDir, writeFull } from './link-audit-evidence-fixtures';

/* Dados 100% FICTÍCIOS. As pastas são criadas em diretórios temporários; a pasta real da AUD-001 nunca é tocada. */
export const OPERATOR = { email: 'ana@empresa.com' };
const allow = (actor: { email: string }): boolean => actor.email === 'ana@empresa.com';

export async function readBasis(base: string, auditId = AUDIT): Promise<ScoringBasis> {
  const outcome = await createScoringBasisReader({ baseDir: base, authorize: allow }).readScoringBasis(OPERATOR, auditId);
  assert.equal(outcome.status, 'READY', JSON.stringify(outcome).slice(0, 300));
  return (outcome as { basis: ScoringBasis }).basis;
}

/** Pasta versionada (captura + site + relatório pelo mesmo pipeline de produção) com um corpo específico do provedor. */
export async function versioned(opts: { auditId?: string; place?: Record<string, unknown> } = {}): Promise<{ base: string; auditId: string; body: string }> {
  const base = tmpDir('lmap-');
  const auditId = opts.auditId ?? AUDIT;
  const body = bodyText(opts.place ?? {});
  await writeFull(base, { auditId, body });
  return { base, auditId, body };
}

/** Uma captura a mais na mesma auditoria (sem relatório), por exemplo uma tentativa posterior que falhou. */
export async function addCapture(base: string, auditId: string, over: { collectedAt: string; body?: string | null; status?: number; withReport?: boolean }): Promise<void> {
  const text = over.body === undefined ? bodyText() : over.body;
  const input = captureInput({ auditId, body: text, collectedAt: over.collectedAt });
  if (over.status !== undefined) (input as { response: unknown }).response = { httpStatus: over.status, attempts: 1, bodyText: text, failure: over.status >= 400 ? 'falha de teste' : null };
  const capture = await writeCapture(base, input);
  assert.ok(capture.ok, JSON.stringify(capture));
  if (over.withReport) {
    const report = await writeReport(base, auditId, capture.value.captureNumber, { kind: 'TESTE', evidences: [] }, T_NOW);
    assert.ok(report.ok, JSON.stringify(report));
  }
}

/** Réplica FICTÍCIA do layout legado (MANIFEST + SHA256SUMS + report.json vigente + report.v1-superseded.json). */
export async function legacyReplica(extraPlace: Record<string, unknown> = {}): Promise<{ base: string; dir: string; bodyText: string }> {
  const base = tmpDir('lmap-');
  const from = tmpDir('lmapfrom-');
  const body = JSON.stringify({
    searchParameters: { q: 'x' },
    places: [{ title: 'Padaria Exemplo', cid: CID, fid: FID, placeId: PLACE_ID, rating: 4.9, ratingCount: 12, phoneNumber: '(62) 3000-9999', website: 'https://legado.example/p?utm_source=ORIGEM-LEGADO&utm_medium=MEIO-LEGADO&token=TOKEN-LEGADO', type: 'Padaria', ...extraPlace }],
    credits: 3,
  });
  const stdout = ['{ "identity": { "snapshotId": "audit-20261022000000", "confirmedAt": "2026-10-22T12:54:45.249Z" },', '  "found": { "googleMaps": { "queriedAt": "2026-10-22T12:54:48.079Z" } } }'].join('\n');
  for (const [name, content] of Object.entries({
    'serper-body.json': body, 'serper-status.json': '{"attempts":1,"status":200,"ok":true}', 'serper-attempts.json': '{"attempts":1,"at":"2026-10-22T12:54:45.404Z"}',
    'summary.json': '{"exitCode":0,"serperAttempts":1,"siteHttpRequests":0}', 'run-stdout.txt': stdout, 'run-stderr.txt': '',
  })) fs.writeFileSync(path.join(from, name), content);
  const dir = path.join(base, AUDIT);
  assert.ok(persistCapture({ from, to: dir, now: clock }).ok);
  assert.ok((await generateReport({ dir, link: LINK, operator: 'ana@empresa.com', name: 'Padaria Exemplo', now: clock })).ok);
  fs.renameSync(path.join(dir, 'report.json'), path.join(dir, 'report.v1-superseded.json'));
  fs.renameSync(path.join(dir, 'report.json.sha256'), path.join(dir, 'report.v1-superseded.json.sha256'));
  assert.ok((await generateReport({ dir, link: LINK, operator: 'ana@empresa.com', name: 'Padaria Exemplo', now: clock })).ok);
  return { base, dir, bodyText: body };
}

/** Estado completo da árvore (caminho, modo, tamanho, mtime): comprova que nada foi escrito. */
export function treeState(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      const info = fs.lstatSync(full);
      out.push(`${path.relative(dir, full)}|${info.mode}|${info.size}|${info.mtimeMs}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}
