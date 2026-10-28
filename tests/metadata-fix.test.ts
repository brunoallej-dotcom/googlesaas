import assert from 'node:assert/strict';
import test from 'node:test';
import PDFDocument from 'pdfkit';
import { applyMetadataFix, countPdfPages, PdfInspectionError, planMetadataFix, rollbackMetadataFix, type MetadataPort } from '../src/lib/pdf/metadata-fix';
import { sha256 } from '../src/lib/pdf/migration';
import { checkAllowedChanges, diffRows } from '../src/lib/pdf/migration-rows';

async function pdf(pages: number): Promise<Buffer> {
  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  for (let i = 0; i < pages; i++) { doc.addPage(); doc.text(`Página ${i + 1}`); }
  doc.end();
  return done;
}

test('contagem de páginas: confere objetos /Page com o /Count da raiz (1, 3, 11 e 12 páginas)', async () => {
  for (const n of [1, 3, 11, 12]) assert.equal(countPdfPages(await pdf(n)), n);
});

test('contagem de páginas: recusa arquivo que não é PDF, sem páginas ou com contagem inconsistente', async () => {
  assert.throws(() => countPdfPages(Buffer.from('<html></html>')), PdfInspectionError);
  assert.throws(() => countPdfPages(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj')), /Nenhuma página/);
  const good = (await pdf(3)).toString('latin1').replace(/\/Count 3/, '/Count 7');
  assert.throws(() => countPdfPages(Buffer.from(good, 'latin1')), /Contagem inconsistente/);
});

const AUDIT = '859b4021-404e-40fc-acba-da21e1fd4746';
const payload = { auditId: AUDIT, pageCount: 3, fileSizeBytes: 13332, generatedAt: '2026-10-16T01:30:35.374Z', pdfFileName: 'x.pdf', pdfDownloadUrl: `/api/audit/${AUDIT}/pdf` };

test('plano: só pageCount e fileSizeBytes mudam e só se o arquivo é exatamente o oficial', async () => {
  const official = await pdf(11);
  const plan = planMetadataFix({ auditId: AUDIT, payload, officialBytes: official, expectedOfficialSha256: sha256(official), privateCopySha256: sha256(official) });
  assert.deepEqual(plan.after, { pageCount: 11, fileSizeBytes: official.byteLength });
  assert.equal(plan.changed, true);
  const changedKeys = Object.keys(plan.payloadAfter).filter((k) => JSON.stringify(plan.payloadAfter[k]) !== JSON.stringify(payload[k as keyof typeof payload]));
  assert.deepEqual(changedKeys.sort(), ['fileSizeBytes', 'pageCount']);
  assert.equal(plan.payloadAfter.generatedAt, payload.generatedAt);

  assert.throws(() => planMetadataFix({ auditId: AUDIT, payload, officialBytes: official, expectedOfficialSha256: 'a'.repeat(64) }), /não é o oficial/);
  assert.throws(() => planMetadataFix({ auditId: AUDIT, payload, officialBytes: official, expectedOfficialSha256: sha256(official), privateCopySha256: 'b'.repeat(64) }), /bucket privado difere/);
  const already = planMetadataFix({ auditId: AUDIT, payload: { ...payload, pageCount: 11, fileSizeBytes: official.byteLength }, officialBytes: official, expectedOfficialSha256: sha256(official) });
  assert.equal(already.changed, false);
});

function fakePort(initial: Record<string, unknown>, options: { failWrite?: boolean; corruptWrite?: boolean } = {}) {
  let row = { diagrammer_payload: initial as Record<string, unknown> | null, updated_at: 't0' };
  let clock = 0;
  let writes = 0;
  const port: MetadataPort = {
    read: async () => structuredClone(row),
    update: async (_id, payloadValue, expected) => {
      if (options.failWrite || row.updated_at !== expected) return false;
      writes++;
      row = { diagrammer_payload: options.corruptWrite && writes === 1 ? { ...payloadValue, pageCount: 999 } : payloadValue, updated_at: `t${++clock}` };
      return true;
    },
  };
  return { port, get row() { return row; } };
}

test('aplicação: compare-and-set por updated_at, verificação pós-escrita e reversão automática', async () => {
  const official = await pdf(11);
  const plan = planMetadataFix({ auditId: AUDIT, payload, officialBytes: official, expectedOfficialSha256: sha256(official) });

  const ok = fakePort(payload);
  const result = await applyMetadataFix(ok.port, plan);
  assert.deepEqual([result.updatedAtBefore, result.updatedAtAfter], ['t0', 't1']);
  assert.deepEqual(ok.row.diagrammer_payload, plan.payloadAfter);

  // payload mudou desde o plano ⇒ aborta sem escrever
  const drift = fakePort({ ...payload, pageCount: 5 });
  await assert.rejects(() => applyMetadataFix(drift.port, plan), /mudou desde a leitura do plano/);
  assert.equal(drift.row.updated_at, 't0');

  // UPDATE condicional que não altera 1 linha ⇒ erro, nada muda
  const blocked = fakePort(payload, { failWrite: true });
  await assert.rejects(() => applyMetadataFix(blocked.port, plan), /nada foi alterado/);

  // escrita corrompida ⇒ revertida automaticamente
  const corrupt = fakePort(payload, { corruptWrite: true });
  await assert.rejects(() => applyMetadataFix(corrupt.port, plan), /revertido automaticamente/);
  assert.deepEqual(corrupt.row.diagrammer_payload, payload);
});

test('reversão manual: só desfaz o que este procedimento fez', async () => {
  const official = await pdf(11);
  const plan = planMetadataFix({ auditId: AUDIT, payload, officialBytes: official, expectedOfficialSha256: sha256(official) });
  const fake = fakePort(payload);
  await applyMetadataFix(fake.port, plan);
  await rollbackMetadataFix(fake.port, { auditId: AUDIT, payloadBefore: plan.payloadBefore, payloadAfter: plan.payloadAfter });
  assert.deepEqual(fake.row.diagrammer_payload, payload);

  const other = fakePort({ ...plan.payloadAfter, generatedAt: 'outra alteração' });
  await assert.rejects(() => rollbackMetadataFix(other.port, { auditId: AUDIT, payloadBefore: plan.payloadBefore, payloadAfter: plan.payloadAfter }), /reversão recusada/);
});

test('verificação campo a campo da correção: só diagrammer_payload.{pageCount,fileSizeBytes} e updated_at, só a linha prevista', () => {
  const dump = (rows: Record<string, Record<string, unknown>>) => ({ takenAt: 't', tables: { gmn_audits: rows } });
  const before = dump({ [AUDIT]: { id: AUDIT, updated_at: 't0', diagrammer_payload: payload }, outra: { id: 'outra', updated_at: 't0', diagrammer_payload: payload } });
  const ok = dump({ [AUDIT]: { id: AUDIT, updated_at: 't1', diagrammer_payload: { ...payload, pageCount: 11, fileSizeBytes: 271346 } }, outra: before.tables.gmn_audits.outra! });
  assert.equal(checkAllowedChanges(diffRows(before, ok), [AUDIT], ['diagrammer_payload', 'updated_at'], ['pageCount', 'fileSizeBytes']).ok, true);
  const bad = dump({ [AUDIT]: { id: AUDIT, updated_at: 't1', diagrammer_payload: { ...payload, pageCount: 11, generatedAt: 'x' } }, outra: before.tables.gmn_audits.outra! });
  assert.match(checkAllowedChanges(diffRows(before, bad), [AUDIT], ['diagrammer_payload', 'updated_at'], ['pageCount', 'fileSizeBytes']).violations.join(' '), /generatedAt/);
});
