import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { buildReportFromCapture } from '../../src/lib/link-audit/collector/capture-report';
import { nodeFsOps, type FsOps } from '../../src/lib/link-audit/snapshot-store';
import { type CaptureInput, writeCapture, writeReport, writeSiteObservation } from '../../src/lib/link-audit-evidence/store';
import { CID, FID, LINK, PLACE, SITE_HTML, T_NOW, identityFor, inputFor } from './link-audit-collect-fixtures';

/* Dados 100% FICTÍCIOS. */
export const AUDIT = 'auditoria-teste-0001';
export const SENTINEL = 'SENTINELA-CORPO-BRUTO-9f3a';
export const COLLECTED_AT = '2026-10-22T12:54:48.079Z';
export const REQUEST_URL = 'https://google.serper.dev/maps';
export const REQUEST_BODY = { q: 'Padaria Exemplo Cidade Exemplo GO', gl: 'br', hl: 'pt-br', page: 1 };

const dirs: string[] = [];
export const tmpDir = (prefix = 'lae-'): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
export const registerCleanup = (): void => after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

export const bodyText = (extra: Record<string, unknown> = {}, credits = 3): string =>
  JSON.stringify({
    searchParameters: { q: REQUEST_BODY.q, gl: 'br', hl: 'pt-br', type: 'maps', num: 10, page: 1, engine: 'google' },
    places: [{ ...PLACE, position: 1, internalNote: SENTINEL, thumbnailUrl: 'https://lh3.example/foto-opaca', ...extra }],
    credits,
  });

export const identity = () => identityFor(LINK, { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' });

export function captureInput(over: Partial<CaptureInput> & { body?: string | null } = {}): CaptureInput {
  const text = over.body === undefined ? bodyText() : over.body;
  const id = identity();
  return {
    auditId: over.auditId ?? AUDIT,
    collectedAt: over.collectedAt ?? COLLECTED_AT,
    request: over.request ?? { url: REQUEST_URL, body: REQUEST_BODY },
    response: over.response ?? { httpStatus: 200, attempts: 1, bodyText: text, failure: null },
    input: over.input ?? { snapshotId: 'snap-exemplo-0001', originalLink: LINK, identity: JSON.parse(JSON.stringify(id)) as Record<string, unknown> },
  };
}

/** Grava captura + site + relatório (o mesmo pipeline de produção) e devolve o que foi publicado. */
export async function writeFull(base: string, opts: { fs?: FsOps; auditId?: string; body?: string } = {}) {
  const auditId = opts.auditId ?? AUDIT;
  const options = opts.fs ? { fs: opts.fs } : {};
  const text = opts.body ?? bodyText();
  const cap = await writeCapture(base, captureInput({ auditId, body: text }), options);
  if (!cap.ok) throw new Error(`captura: ${cap.issues.join(' ')}`);
  const siteOutcome = {
    requestedUrl: 'https://www.padaria-exemplo.example/', finalUrl: null, status: 'HTTP_ERROR', httpStatus: 403, redirects: [], checkedAt: '2026-10-22T12:54:48.084Z', title: null,
    noindex: null, robotsTxt: 'UNKNOWN', localBusiness: null, telLinks: [], whatsappLinks: [], emailLinks: [], failureReason: 'O site respondeu HTTP 403.', access: { requests: 1, authChallenge: false, loginPathBlocked: false, requestLimitReached: false },
  };
  const site = await writeSiteObservation(base, auditId, cap.value.captureNumber, siteOutcome, siteOutcome.checkedAt, options);
  if (!site.ok) throw new Error(`site: ${site.issues.join(' ')}`);
  const input = inputFor(identity(), 'snap-exemplo-0001');
  const built = await buildReportFromCapture({
    rawBody: text, body: { name: 'c0001.capture.json', sha256: cap.value.contentSha256, bytes: Buffer.byteLength(text) }, otherFiles: [], httpStatus: 200, httpAttempts: 1,
    collectedAt: COLLECTED_AT, input, site: null, siteOutcome: siteOutcome as never, generatedAt: T_NOW,
  });
  if (!built.ok) throw new Error(`relatório: ${built.reason}`);
  const rep = await writeReport(base, auditId, cap.value.captureNumber, JSON.parse(JSON.stringify(built.report)) as Record<string, unknown>, T_NOW, options);
  if (!rep.ok) throw new Error(`relatório gravado: ${rep.issues.join(' ')}`);
  return { cap: cap.value, site: site.value, rep: rep.value, report: built.report };
}

export const faulty = (over: Partial<FsOps>): FsOps => ({ ...nodeFsOps, ...over });
export const errno = (code: string, message = code): Error => Object.assign(new Error(message), { code });
export { CID, FID, SITE_HTML };
