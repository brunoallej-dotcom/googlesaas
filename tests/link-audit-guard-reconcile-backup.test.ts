import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readLedgerBackup } from '../src/lib/link-audit-guard-reconcile/backup';
import { registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { headAt, ledgerOf, ROUND, sha256Hex, writeRound } from './helpers/link-audit-guard-reconcile-fixtures';
import { isoAt, LEDGER_AUTH_A, makeRecord } from './helpers/link-audit-ledger-fixtures';

/*
 * G1.b.2b — LEITURA DA RODADA DE BACKUP do livro pela reconciliação externa (GE-E5): só uma rodada VÁLIDA do plano de backup (marcador
 * `RODADA-VALIDA`, sem `RODADA-INCOMPLETA`), cuja cópia confere EXATAMENTE com o próprio `SHA256SUMS` (mesmos arquivos, mesmos hashes), com a raiz
 * do livro só com pastas de auditoria. Cada livro é lido pelo leitor do próprio livro (esquema, hash, bytes, sequência) e o encadeamento é conferido;
 * um livro ilegível vira um achado daquela auditoria, nunca derruba as outras. Somente leitura: nada é gravado na rodada.
 */
registerCleanup();
const ROOT = path.resolve(__dirname, '..');
const A = 'auditoria-backup-a1';
const B = 'auditoria-backup-b1';

const snapshotOf = (dir: string): string => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${path.relative(dir, full)}:${sha256Hex(fs.readFileSync(full))}:${fs.statSync(full).mtimeMs}`);
    }
  };
  walk(dir);
  return out.join('\n');
};

test('G1.b.2b backup: rodada válida ⇒ rótulo, hash do manifesto e, por auditoria (ordem estável), os hashes de cada posição do livro; nada é gravado', async () => {
  const a = ledgerOf(A, 5);
  const b = ledgerOf(B, 1);
  const roundDir = writeRound({ [B]: b, [A]: a });
  const before = snapshotOf(roundDir);
  const read = await readLedgerBackup(roundDir, ROOT);
  assert.ok(read.ok, JSON.stringify(read));
  if (!read.ok) return;
  assert.equal(read.value.round, ROUND);
  assert.equal(read.value.manifestSha256, sha256Hex(fs.readFileSync(path.join(roundDir, 'SHA256SUMS'))));
  assert.deepEqual(read.value.ledgers.map((ledger) => ledger.auditId), [A, B]);
  const [first, second] = read.value.ledgers;
  assert.ok(first?.status === 'OK' && second?.status === 'OK');
  if (first?.status !== 'OK' || second?.status !== 'OK') return;
  assert.deepEqual(first.shas, a.map((record) => record.contentSha256));
  assert.equal(first.shas[2], headAt(a, 3).sha256);
  assert.deepEqual(second.shas, [b[0]?.contentSha256]);
  assert.equal(snapshotOf(roundDir), before, 'somente leitura');
});

test('G1.b.2b backup: rodada sem RODADA-VALIDA, com RODADA-INCOMPLETA ou com rótulo fora do formato do plano ⇒ recusada', async () => {
  const ledgers = { [A]: ledgerOf(A, 3) };
  const codeOf = async (dir: string): Promise<string> => {
    const read = await readLedgerBackup(dir, ROOT);
    return read.ok ? 'OK' : read.code;
  };
  assert.equal(await codeOf(writeRound(ledgers, { noValidMarker: true })), 'BACKUP_ROUND_NOT_VALID');
  assert.equal(await codeOf(writeRound(ledgers, { incomplete: true })), 'BACKUP_ROUND_NOT_VALID');
  assert.equal(await codeOf(writeRound(ledgers, { round: 'rodada-qualquer' })), 'BACKUP_NOT_A_ROUND');
  const valid = writeRound(ledgers);
  assert.equal(await codeOf(path.join(valid, 'dados')), 'BACKUP_NOT_A_ROUND', 'a pasta dados/ não é a rodada');
  assert.equal(await codeOf(path.join(valid, 'nao-existe')), 'BACKUP_NOT_A_ROUND');
  const link = path.join(path.dirname(valid), '20261122-031500-9999');
  fs.symlinkSync(valid, link);
  assert.equal(await codeOf(link), 'BACKUP_NOT_A_ROUND', 'link simbólico para uma rodada não é rodada');
});

test('G1.b.2b backup: a cópia precisa conferir EXATAMENTE com o SHA256SUMS (arquivo alterado, a mais, a menos, manifesto malformado) ⇒ recusada', async () => {
  const ledgers = { [A]: ledgerOf(A, 3) };
  const codeOf = async (dir: string): Promise<string> => {
    const read = await readLedgerBackup(dir, ROOT);
    return read.ok ? 'OK' : read.code;
  };
  assert.equal(await codeOf(writeRound(ledgers, { afterManifest: (data) => fs.appendFileSync(path.join(data, A, 'l000002.json'), ' ') })), 'BACKUP_MANIFEST_MISMATCH');
  assert.equal(await codeOf(writeRound(ledgers, { afterManifest: (data) => fs.writeFileSync(path.join(data, A, 'l000009.json'), '{}') })), 'BACKUP_MANIFEST_MISMATCH');
  assert.equal(await codeOf(writeRound(ledgers, { afterManifest: (data) => fs.rmSync(path.join(data, A, 'l000003.json')) })), 'BACKUP_MANIFEST_MISMATCH');
  const malformed = writeRound(ledgers);
  fs.appendFileSync(path.join(malformed, 'SHA256SUMS'), 'isto não é uma linha do sha256sum\n');
  assert.equal(await codeOf(malformed), 'BACKUP_MANIFEST_INVALID');
  const repeated = writeRound(ledgers);
  const line = fs.readFileSync(path.join(repeated, 'SHA256SUMS'), 'utf8').split('\n')[0] ?? '';
  fs.appendFileSync(path.join(repeated, 'SHA256SUMS'), `${line}\n`);
  assert.equal(await codeOf(repeated), 'BACKUP_MANIFEST_INVALID', 'linha repetida');
});

test('G1.b.2b backup: a raiz do livro copiada só tem pastas de auditoria com id válido; link simbólico ou arquivo solto ⇒ recusada', async () => {
  const ledgers = { [A]: ledgerOf(A, 3) };
  const codeOf = async (dir: string): Promise<string> => {
    const read = await readLedgerBackup(dir, ROOT);
    return read.ok ? 'OK' : read.code;
  };
  assert.equal(await codeOf(writeRound(ledgers, { beforeManifest: (data) => fs.writeFileSync(path.join(data, 'LEIA-ME.txt'), 'x') })), 'BACKUP_UNEXPECTED_ENTRY');
  assert.equal(await codeOf(writeRound(ledgers, { beforeManifest: (data) => fs.mkdirSync(path.join(data, 'Nome Com Espaço')) })), 'BACKUP_UNEXPECTED_ENTRY');
  assert.equal(await codeOf(writeRound(ledgers, { afterManifest: (data) => fs.symlinkSync(path.join(data, A, 'l000001.json'), path.join(data, A, 'l000004.json')) })), 'BACKUP_UNEXPECTED_ENTRY');
});

test('G1.b.2b backup: livro ilegível de UMA auditoria (lacuna, registro adulterado antes do manifesto, encadeamento quebrado) ⇒ só ela sai UNREADABLE, as outras seguem', async () => {
  const a = ledgerOf(A, 5);
  const roundDir = writeRound({ [A]: a, [B]: ledgerOf(B, 3) }, { beforeManifest: (data) => fs.rmSync(path.join(data, A, 'l000003.json')) });
  const read = await readLedgerBackup(roundDir, ROOT);
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(read.value.ledgers.map((ledger) => [ledger.auditId, ledger.status, ledger.status === 'UNREADABLE' ? ledger.reason : null]), [[A, 'UNREADABLE', 'SEQUENCE_GAP'], [B, 'OK', null]]);
  const tampered = writeRound({ [A]: a }, {
    beforeManifest: (data) => {
      const file = path.join(data, A, 'l000002.json');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"actor": "ana@empresa.com"', '"actor": "bia@empresa.com"'));
    },
  });
  const second = await readLedgerBackup(tampered, ROOT);
  assert.ok(second.ok, 'hash do registro não confere');
  assert.deepEqual(second.ok ? second.value.ledgers[0] : null, { auditId: A, status: 'UNREADABLE', reason: 'HASH_MISMATCH' });
  // encadeamento: um registro 3 válido sozinho (selado e assinado), mas encadeado ao registro 2 de OUTRO livro
  const other = ledgerOf('auditoria-backup-c1', 5);
  const forged = makeRecord(LEDGER_AUTH_A, A, other[1] as (typeof a)[number], { event: 'CHECKPOINT', recordedAt: isoAt(9), actor: 'system', checkpoint: { throughSeq: 2, throughSha256: (a[1] as (typeof a)[number]).contentSha256 } });
  const chain = writeRound({ [A]: [...a.slice(0, 2), forged] });
  const third = await readLedgerBackup(chain, ROOT);
  assert.deepEqual(third.ok ? third.value.ledgers[0] : null, { auditId: A, status: 'UNREADABLE', reason: 'CHAIN_BROKEN' });
});

test('G1.b.2b backup: rodada vazia (livro sem auditorias) é válida e não tem livros', async () => {
  const read = await readLedgerBackup(writeRound({}), ROOT);
  assert.ok(read.ok && read.value.ledgers.length === 0);
});
