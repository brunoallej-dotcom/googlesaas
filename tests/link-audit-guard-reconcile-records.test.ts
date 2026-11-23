import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildRecord, readRecords, recordFileName, RECORD_KIND, RECORD_VERSION, serializeRecord, writeRecord, type ReconcileRecord } from '../src/lib/link-audit-guard-reconcile/records';
import type { Analysis, GuardRow } from '../src/lib/link-audit-guard-reconcile/model';
import { registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { ROUND } from './helpers/link-audit-guard-reconcile-fixtures';

/*
 * G1.b.2b — REGISTRO DA PRÓPRIA RECONCILIAÇÃO (GE-E5; regra 6: quem percebe a guarda que "esqueceu" é a reconciliação, comparando com o registro
 * anterior). Uma pasta do responsável, FORA da VPS, com `reconcile-NNNNNN.json` em sequência e ENCADEADOS (`previousRecordSha256` = SHA-256 dos bytes
 * do anterior). Cada rodada grava um arquivo NOVO por criação exclusiva (temporário + `link()`): nunca sobrescreve, nunca apaga um registro. Pasta
 * com lacuna, encadeamento quebrado, nome estranho ou registro editado à mão ⇒ recusada (a comparação com o "anterior" deixaria de valer).
 */
registerCleanup();
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const H = (c: string): string => c.repeat(64);
const ROW: GuardRow = { auditRef: H('a'), keyId: 'gk-test-a', ledgerSeq: 3, sha256: H('3') };
const analysis = (over: Partial<Analysis> = {}): Analysis => ({
  audits: [],
  findings: [],
  witness: [ROW],
  summary: { audits: 1, consistent: 1, behind: 0, noHead: 0, divergent: 0, headsOnRetiredKey: 0, guardHeads: 1, findings: 0 },
  ...over,
});
const recordFor = (previous: { readonly record: ReconcileRecord; readonly sha256: string } | null, over: Partial<Analysis> = {}): ReconcileRecord =>
  buildRecord({ previous, createdAt: new Date(Date.UTC(2026, 10, 22, 4, 0, 0)), backup: { round: ROUND, manifestSha256: H('f') }, keyIds: ['gk-test-a'], analysis: analysis(over) });

test('G1.b.2b registro: pasta vazia ⇒ nenhum anterior; o primeiro é reconcile-000001.json, sem anterior, modo 0600; o segundo encadeia o SHA-256 dos bytes do primeiro', async () => {
  const dir = tmpDir('lagr-rec-');
  assert.deepEqual(await readRecords(dir), { ok: true, value: { last: null } });
  const first = recordFor(null);
  assert.deepEqual([first.kind, first.version, first.sequence, first.previousRecordSha256, first.outcome], [RECORD_KIND, RECORD_VERSION, 1, null, 'CLEAN']);
  const wrote = await writeRecord(dir, first);
  assert.deepEqual(wrote, { ok: true, fileName: recordFileName(1), sha256: sha256(serializeRecord(first)) });
  assert.equal(fs.statSync(path.join(dir, recordFileName(1))).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(dir, recordFileName(1)), 'utf8'), serializeRecord(first));
  const read = await readRecords(dir);
  assert.ok(read.ok && read.value.last !== null);
  if (!read.ok || read.value.last === null) return;
  assert.deepEqual(read.value.last.record, first);
  const second = recordFor(read.value.last, { findings: [{ code: 'GUARD_REGRESSED', auditRef: H('a'), auditId: 'auditoria-nunca-no-registro', backupSeq: 3, guardSeq: 2, recordedSeq: 3 }] });
  assert.deepEqual([second.sequence, second.previousRecordSha256, second.outcome], [2, sha256(fs.readFileSync(path.join(dir, recordFileName(1)))), 'DIVERGENT']);
  assert.deepEqual(second.findings, [{ code: 'GUARD_REGRESSED', auditRef: H('a') }]);
  assert.ok(!serializeRecord(second).includes('auditoria-nunca-no-registro'), 'o registro nunca guarda auditId');
  assert.ok((await writeRecord(dir, second)).ok);
  const again = await readRecords(dir);
  assert.ok(again.ok && again.value.last?.record.sequence === 2 && again.value.last.fileName === recordFileName(2));
  assert.deepEqual(fs.readdirSync(dir).sort(), [recordFileName(1), recordFileName(2)], 'nenhum temporário sobra');
});

test('G1.b.2b registro: criação EXCLUSIVA — um registro com o mesmo número já existente ⇒ RECORD_EXISTS e o arquivo existente fica intacto byte a byte', async () => {
  const dir = tmpDir('lagr-rec-');
  const first = recordFor(null);
  assert.ok((await writeRecord(dir, first)).ok);
  const before = fs.readFileSync(path.join(dir, recordFileName(1)));
  const rival = recordFor(null, { witness: [{ ...ROW, ledgerSeq: 9 }] });
  assert.deepEqual(await writeRecord(dir, rival), { ok: false, code: 'RECORD_EXISTS' });
  assert.deepEqual(fs.readFileSync(path.join(dir, recordFileName(1))), before);
  assert.deepEqual(fs.readdirSync(dir), [recordFileName(1)], 'o temporário da tentativa recusada não sobra');
});

test('G1.b.2b registro: pasta com lacuna, encadeamento quebrado, registro editado à mão, nome fora do padrão ou registro malformado ⇒ RECORDS_INVALID', async () => {
  const chain = async (): Promise<string> => {
    const dir = tmpDir('lagr-rec-');
    const first = recordFor(null);
    await writeRecord(dir, first);
    await writeRecord(dir, recordFor({ record: first, sha256: sha256(serializeRecord(first)) }));
    return dir;
  };
  const codeOf = async (dir: string): Promise<string> => {
    const read = await readRecords(dir);
    return read.ok ? 'OK' : read.code;
  };
  const gap = await chain();
  fs.renameSync(path.join(gap, recordFileName(2)), path.join(gap, recordFileName(3)));
  assert.equal(await codeOf(gap), 'RECORDS_INVALID');
  const edited = await chain();
  fs.writeFileSync(path.join(edited, recordFileName(1)), serializeRecord({ ...recordFor(null), createdAt: '2026-11-21T04:00:00.000Z' }));
  assert.equal(await codeOf(edited), 'RECORDS_INVALID', 'o anterior mudou: o encadeamento do seguinte não confere');
  const reformatted = await chain();
  const text = fs.readFileSync(path.join(reformatted, recordFileName(2)), 'utf8');
  fs.writeFileSync(path.join(reformatted, recordFileName(2)), JSON.stringify(JSON.parse(text)));
  assert.equal(await codeOf(reformatted), 'RECORDS_INVALID', 'bytes que este CLI não grava');
  const strange = await chain();
  fs.writeFileSync(path.join(strange, 'reconcile-3.json'), '{}');
  assert.equal(await codeOf(strange), 'RECORDS_INVALID');
  const broken = await chain();
  fs.writeFileSync(path.join(broken, recordFileName(3)), '{"kind":');
  assert.equal(await codeOf(broken), 'RECORDS_INVALID');
  const ignored = await chain();
  fs.writeFileSync(path.join(ignored, 'LEIA-ME.txt'), 'anotações do responsável');
  fs.writeFileSync(path.join(ignored, '.tmp-reconcile-000003-abc.json'), 'sobra de uma tentativa interrompida');
  assert.equal(await codeOf(ignored), 'OK', 'outros arquivos e temporários órfãos não contam');
});

test('G1.b.2b registro: pasta ausente, que não é diretório ou que é link simbólico ⇒ RECORDS_DIR_INVALID', async () => {
  const base = tmpDir('lagr-rec-');
  const real = path.join(base, 'registros');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(base, 'atalho'));
  fs.writeFileSync(path.join(base, 'arquivo'), 'x');
  for (const dir of [path.join(base, 'nao-existe'), path.join(base, 'atalho'), path.join(base, 'arquivo')]) assert.deepEqual(await readRecords(dir), { ok: false, code: 'RECORDS_DIR_INVALID' });
  assert.deepEqual(await writeRecord(path.join(base, 'atalho'), recordFor(null)), { ok: false, code: 'RECORDS_DIR_INVALID' });
});

test('G1.b.2b registro: forma estável (ordem fixa das chaves; linhas em ordem de pseudônimo e posição)', () => {
  const record = recordFor(null, { witness: [{ ...ROW, auditRef: H('b') }, ROW, { ...ROW, ledgerSeq: 1 }] });
  assert.deepEqual(Object.keys(record), ['kind', 'version', 'sequence', 'createdAt', 'previousRecordSha256', 'backup', 'keyIds', 'outcome', 'findings', 'heads']);
  assert.deepEqual(record.heads.map((row) => [row.auditRef[0], row.ledgerSeq]), [['a', 1], ['a', 3], ['b', 3]]);
  assert.equal(record.createdAt, '2026-11-22T04:00:00.000Z');
});
