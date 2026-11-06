import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import {
  clearStorageFatal,
  confirmReceipt,
  isBaseTripped,
  locateIn,
  prepareReceiptDirectory,
  readReceipts,
  receiptBody,
  seal,
  serialize,
  verifyReceipts,
  writeReceipt,
  type Location,
  type ReceiptProfile,
  type ReceiptSubject,
} from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { errno, faulty, registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';

registerCleanup();

/*
 * Protocolo de recibos do módulo NEUTRO, exercitado com um perfil DIFERENTE do da 6B (prefixo `z`, outro tipo de arquivo, 2
 * tentativas e textos próprios). Se a mecânica dependesse da 6B, estes testes não passariam; se o perfil não mandasse no
 * comportamento específico (nomes, mensagens, tentativas), também não.
 */
const AUDIT = 'resultados-teste-01';
const ID_RULE = { pattern: /^[a-z][a-z0-9-]{7,40}$/, message: 'identificador de teste inválido' };
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const schema = z
  .object({
    schemaVersion: z.literal(7),
    kind: z.literal('RECIBO_DE_TESTE'),
    auditId: z.string(),
    seq: z.number().int().min(1),
    headSha256: hex,
    anchoredAt: z.string(),
    prevAnchorSha256: hex.nullable(),
    contentSha256: hex,
  })
  .strict();
type TestReceipt = z.infer<typeof schema>;
const name = (seq: number): string => `z${String(seq).padStart(4, '0')}.json`;

const profile: ReceiptProfile<TestReceipt> = {
  schemaVersion: 7,
  kind: 'RECIBO_DE_TESTE',
  prefix: 'z',
  filePattern: /^z(\d{4})\.json$/,
  fileName: name,
  maxBytes: 8192,
  schema,
  attempts: 2,
  messages: {
    storeMissing: 'RT: a base de recibos de teste não existe.',
    storeNotDirectory: 'RT: a base de recibos de teste não é um diretório.',
    auditNotDirectory: 'RT: a pasta de recibos da auditoria não é um diretório.',
    listingLabel: 'listagem dos recibos de teste',
    directoryLabel: 'recibos de teste',
    suspicious: (n) => `RT: nome suspeito ${n}.`,
    gap: (expected, found) => `RT: lacuna (esperado ${expected}, achado ${found}).`,
    otherAudit: (n) => `RT: ${n} é de outra auditoria.`,
    sequenceMismatch: (n, seq) => `RT: ${n} diz ${seq}.`,
    notChained: (n) => `RT: ${n} fora da cadeia.`,
    truncated: (entries, receipts) => `RT: ${entries} entradas e recibos até ${receipts}.`,
    mismatch: (seq) => `RT: a entrada ${seq} não confere.`,
    tooManyUnanchored: (count) => `RT: ${count} entradas sem recibo.`,
    fatalBefore: 'RT: bloqueado por erro fatal anterior.',
    invalidContract: 'RT: recibo montado fora do contrato.',
    label: (n) => `Recibo ${n}`,
    exists: (n) => `RT: ${n} já existe.`,
    noAtomicLink: 'RT: sem link() atômico.',
    fatalNow: (code) => `RT: erro fatal ${code}.`,
    noAttempt: 'RT: nenhuma tentativa.',
    notLast: (n) => `RT: ${n} não é o último.`,
    notMatching: (n, seq) => `RT: ${n} não corresponde à entrada ${seq}.`,
  },
};

const sha = (n: number): string => n.toString(16).padStart(64, 'a');
const subject = (seq: number, hash = sha(seq)): ReceiptSubject => ({ auditId: AUDIT, seq, contentSha256: hash });

interface Env {
  readonly root: string;
  readonly located: Location;
}
function env(): Env {
  const root = tmpDir('stor-rcp-');
  const located = locateIn(root, AUDIT, '/srv/projeto', 'recibos', ID_RULE);
  assert.ok(located.ok);
  return { root, located: located.value };
}

/** Grava `count` recibos encadeados pelo caminho normal e devolve-os. */
async function chain(e: Env, count: number, ops: FsOps = nodeFsOps): Promise<TestReceipt[]> {
  assert.equal(await prepareReceiptDirectory(profile, ops, e.located), null);
  const out: TestReceipt[] = [];
  for (let seq = 1; seq <= count; seq++) {
    const r = await confirmReceipt(profile, ops, e.located, subject(seq), out[out.length - 1], `2026-10-21T12:00:0${seq}.000Z`);
    assert.ok(r.ok, JSON.stringify(r));
    out.push(r.value);
  }
  return out;
}
const unlock = (file: string): void => fs.chmodSync(file, 0o644);

/* ===================================================================== gravação e leitura */

test('recibos: gravados de forma imutável (0444), encadeados, com as chaves na ORDEM canônica e lidos de volta pelo mesmo protocolo', async () => {
  const e = env();
  const receipts = await chain(e, 3);
  assert.deepEqual(fs.readdirSync(e.located.dir).sort(), ['z0001.json', 'z0002.json', 'z0003.json']);
  for (const file of fs.readdirSync(e.located.dir)) assert.equal(fs.statSync(path.join(e.located.dir, file)).mode & 0o222, 0, `${file} somente leitura`);
  assert.deepEqual([receipts[0]?.prevAnchorSha256, receipts[1]?.prevAnchorSha256, receipts[2]?.prevAnchorSha256], [null, receipts[0]?.contentSha256, receipts[1]?.contentSha256]);
  const text = fs.readFileSync(path.join(e.located.dir, 'z0002.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['schemaVersion', 'kind', 'auditId', 'seq', 'headSha256', 'anchoredAt', 'prevAnchorSha256', 'contentSha256']);
  assert.equal(text, serialize(JSON.parse(text)), 'bytes canônicos');
  const read = await readReceipts(profile, nodeFsOps, e.located, AUDIT);
  assert.ok(read.ok && read.value.anchors.length === 3 && read.value.unexpectedFiles.length === 0);
  const entries = [1, 2, 3].map((n) => ({ contentSha256: sha(n) }));
  assert.deepEqual(verifyReceipts(profile, entries, read.ok ? read.value.anchors : []), { ok: true, value: { count: 3, lastSeq: 3, unanchored: 0 } });
});

test('receiptBody: o primeiro recibo não tem anterior; os demais se encadeiam ao selo do anterior; o hash da entrada é o `headSha256`', () => {
  const first = receiptBody(profile, subject(1), undefined, '2026-10-21T12:00:00.000Z');
  assert.deepEqual(first, { schemaVersion: 7, kind: 'RECIBO_DE_TESTE', auditId: AUDIT, seq: 1, headSha256: sha(1), anchoredAt: '2026-10-21T12:00:00.000Z', prevAnchorSha256: null });
  const sealed = seal(first) as TestReceipt;
  const second = receiptBody(profile, subject(2), sealed, '2026-10-21T12:00:01.000Z');
  assert.equal(second.prevAnchorSha256, sealed.contentSha256);
  assert.equal(second.headSha256, sha(2));
});

test('leitura: pasta ausente da auditoria = nenhum recibo; base ausente, base que é arquivo e pasta da auditoria que é arquivo usam os TEXTOS do perfil', async () => {
  const e = env();
  const none = await readReceipts(profile, nodeFsOps, e.located, AUDIT);
  assert.ok(none.ok && none.value.anchors.length === 0);
  const missing = await readReceipts(profile, nodeFsOps, { root: path.join(e.root, 'nao-existe'), dir: path.join(e.root, 'nao-existe', AUDIT) }, AUDIT);
  assert.ok(!missing.ok && missing.code === 'ANCHOR_MISSING' && missing.issues[0] === 'RT: a base de recibos de teste não existe.');
  const asFile = path.join(e.root, 'arquivo');
  fs.writeFileSync(asFile, 'x');
  const notDir = await readReceipts(profile, nodeFsOps, { root: asFile, dir: path.join(asFile, AUDIT) }, AUDIT);
  assert.ok(!notDir.ok && notDir.code === 'UNSAFE_PATH' && notDir.issues[0] === 'RT: a base de recibos de teste não é um diretório.');
  fs.writeFileSync(e.located.dir, 'x');
  const auditFile = await readReceipts(profile, nodeFsOps, e.located, AUDIT);
  assert.ok(!auditFile.ok && auditFile.code === 'UNSAFE_PATH' && auditFile.issues[0] === 'RT: a pasta de recibos da auditoria não é um diretório.');
});

test('leitura: lacuna, nome suspeito, recibo de outra auditoria, número interno errado, cadeia quebrada, hash e formato adulterados — sempre ANCHOR_INTEGRITY com o texto do perfil', async () => {
  const code = async (e: Env): Promise<{ code: string; issue: string }> => {
    const r = await readReceipts(profile, nodeFsOps, e.located, AUDIT);
    assert.ok(!r.ok, 'esperava falha');
    return { code: r.code, issue: r.issues[0] ?? '' };
  };
  let e = env();
  await chain(e, 3);
  unlock(path.join(e.located.dir, 'z0002.json'));
  fs.rmSync(path.join(e.located.dir, 'z0002.json'));
  assert.deepEqual(await code(e), { code: 'ANCHOR_INTEGRITY', issue: 'RT: lacuna (esperado z0002.json, achado z0003.json).' });

  e = env();
  await chain(e, 2);
  fs.writeFileSync(path.join(e.located.dir, 'z0003.json.bak'), 'resto');
  assert.deepEqual(await code(e), { code: 'ANCHOR_INTEGRITY', issue: 'RT: nome suspeito z0003.json.bak.' });

  e = env();
  await chain(e, 2);
  fs.writeFileSync(path.join(e.located.dir, 'Z0003.JSON'), 'resto');
  assert.equal((await code(e)).code, 'ANCHOR_INTEGRITY', 'caixa diferente também é suspeita');

  const reseal = (file: string, change: Record<string, unknown>): void => {
    const { contentSha256, ...body } = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.ok(contentSha256);
    unlock(file);
    fs.writeFileSync(file, serialize(seal({ ...body, ...change })));
  };
  e = env();
  await chain(e, 2);
  reseal(path.join(e.located.dir, 'z0002.json'), { auditId: 'outra-auditoria-01' });
  assert.deepEqual(await code(e), { code: 'ANCHOR_INTEGRITY', issue: 'RT: z0002.json é de outra auditoria.' });

  e = env();
  await chain(e, 2);
  reseal(path.join(e.located.dir, 'z0002.json'), { seq: 5 });
  assert.deepEqual(await code(e), { code: 'ANCHOR_INTEGRITY', issue: 'RT: z0002.json diz 5.' });

  e = env();
  await chain(e, 2);
  reseal(path.join(e.located.dir, 'z0002.json'), { prevAnchorSha256: sha(99) });
  assert.deepEqual(await code(e), { code: 'ANCHOR_INTEGRITY', issue: 'RT: z0002.json fora da cadeia.' });

  e = env();
  await chain(e, 1);
  const file = path.join(e.located.dir, 'z0001.json');
  unlock(file);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"anchoredAt"', '"anchoredAt "'));
  assert.equal((await code(e)).code, 'ANCHOR_INTEGRITY');
  fs.rmSync(file);
  fs.symlinkSync(path.join(e.root, 'qualquer'), file);
  assert.equal((await code(e)).code, 'ANCHOR_INTEGRITY', 'symlink nunca é seguido');
});

test('leitura: ruído (`desktop.ini`) e temporários órfãos são informados, não bloqueiam', async () => {
  const e = env();
  await chain(e, 2);
  fs.writeFileSync(path.join(e.located.dir, 'desktop.ini'), 'x');
  fs.writeFileSync(path.join(e.located.dir, '.tmp-z0003.json-ab12'), 'resto');
  const r = await readReceipts(profile, nodeFsOps, e.located, AUDIT);
  assert.ok(r.ok && r.value.anchors.length === 2);
  assert.deepEqual([r.ok && r.value.unexpectedFiles, r.ok && r.value.orphanTempFiles], [['desktop.ini'], ['.tmp-z0003.json-ab12']]);
});

/* ===================================================================== confronto com o histórico */

test('verifyReceipts: recibo à frente = TRUNCATED; hash diferente = ANCHOR_MISMATCH; uma entrada sem recibo é a pendente; duas são falha — com os textos do perfil', () => {
  const r = (n: number, hash = sha(n)) => seal(receiptBody(profile, subject(n, hash), undefined, '2026-10-21T12:00:00.000Z')) as TestReceipt;
  const entries = [1, 2, 3].map((n) => ({ contentSha256: sha(n) }));
  const t = verifyReceipts(profile, entries.slice(0, 2), [r(1), r(2), r(3)]);
  assert.ok(!t.ok && t.code === 'TRUNCATED' && t.issues[0] === 'RT: 2 entradas e recibos até 3.');
  const m = verifyReceipts(profile, entries, [r(1), r(2, sha(77))]);
  assert.ok(!m.ok && m.code === 'ANCHOR_MISMATCH' && m.issues[0] === 'RT: a entrada 2 não confere.');
  assert.deepEqual(verifyReceipts(profile, entries, [r(1), r(2)]), { ok: true, value: { count: 2, lastSeq: 2, unanchored: 1 } });
  assert.deepEqual(verifyReceipts(profile, [], []), { ok: true, value: { count: 0, lastSeq: 0, unanchored: 0 } });
  const many = verifyReceipts(profile, entries, [r(1)]);
  assert.ok(!many.ok && many.code === 'ANCHOR_INTEGRITY' && many.issues[0] === 'RT: 2 entradas sem recibo.');
});

/* ===================================================================== escrita, tentativas e recuperação */

test('confirmReceipt: tenta exatamente `attempts` vezes (do PERFIL) e devolve o último erro; erro transitório seguido de sucesso confirma', async () => {
  const e = env();
  await prepareReceiptDirectory(profile, nodeFsOps, e.located);
  let calls = 0;
  const alwaysFull = faulty({ async writeExclusive() { calls++; throw errno('ENOSPC', `ENOSPC ${e.root}`); } });
  const failed = await confirmReceipt(profile, alwaysFull, e.located, subject(1), undefined, '2026-10-21T12:00:00.000Z');
  assert.ok(!failed.ok && failed.code === 'ANCHOR_WRITE_FAILED');
  assert.equal(calls, 2, 'o perfil define 2 tentativas');
  assert.ok(!JSON.stringify(failed).includes(e.root), 'sem caminho do disco');
  assert.deepEqual(fs.readdirSync(e.located.dir), [], 'nenhum arquivo nem temporário ficou');

  let n = 0;
  const flaky = faulty({
    async writeExclusive(target, data, mode) {
      if (n++ === 0) throw errno('EAGAIN');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const okay = await confirmReceipt(profile, flaky, e.located, subject(1), undefined, '2026-10-21T12:00:00.000Z');
  assert.ok(okay.ok && okay.value.seq === 1);
});

test('confirmReceipt: EEXIST só vale se o recibo existente for IDÊNTICO ao esperado (adoção); diferente = ANCHOR_MISMATCH; existente que não é o último = ANCHOR_INTEGRITY', async () => {
  // um "outro processo" grava o recibo 1 logo antes do nosso link()
  const rival = (headSha: string): FsOps => {
    let done = false;
    return faulty({
      async link(from, to) {
        if (!done && path.basename(to) === 'z0001.json') {
          done = true;
          fs.writeFileSync(to, serialize(seal(receiptBody(profile, subject(1, headSha), undefined, '2026-10-21T13:00:00.000Z'))), { mode: 0o444 });
        }
        return nodeFsOps.link(from, to);
      },
    });
  };
  let e = env();
  await prepareReceiptDirectory(profile, nodeFsOps, e.located);
  const same = await confirmReceipt(profile, rival(sha(1)), e.located, subject(1), undefined, '2026-10-21T12:00:00.000Z');
  assert.ok(same.ok && same.value.anchoredAt === '2026-10-21T13:00:00.000Z', 'adotou o recibo do outro processo');

  e = env();
  await prepareReceiptDirectory(profile, nodeFsOps, e.located);
  const different = await confirmReceipt(profile, rival(sha(55)), e.located, subject(1), undefined, '2026-10-21T12:00:00.000Z');
  assert.ok(!different.ok && different.code === 'ANCHOR_MISMATCH' && different.issues[0] === 'RT: z0001.json não corresponde à entrada 1.');

  e = env();
  await chain(e, 3);
  const notLast = await confirmReceipt(profile, nodeFsOps, e.located, subject(1), undefined, '2026-10-21T12:00:00.000Z');
  assert.ok(!notLast.ok && notLast.code === 'ANCHOR_INTEGRITY' && notLast.issues[0] === 'RT: z0001.json não é o último.');
});

test('writeReceipt: erro fatal (EIO/EROFS) trava a base — escritas seguintes recusam SEM tocar o disco — e leituras continuam; sem link() atômico não há retentativa nem arquivo parcial', async () => {
  clearStorageFatal();
  const e = env();
  await chain(e, 1);
  const eio = faulty({ async link() { throw errno('EIO'); } });
  const fatal = await confirmReceipt(profile, eio, e.located, subject(2), undefined, '2026-10-21T12:00:00.000Z');
  assert.ok(!fatal.ok && fatal.code === 'STORAGE_FATAL' && fatal.issues[0] === 'RT: erro fatal EIO.');
  assert.ok(isBaseTripped(e.located.root));
  let touched = 0;
  const spy = faulty({ async writeExclusive() { touched++; throw errno('EACCES'); } });
  const blocked = await writeReceipt(profile, spy, e.located, receiptBody(profile, subject(2), undefined, '2026-10-21T12:00:00.000Z'));
  assert.ok(!blocked.ok && blocked.code === 'STORAGE_FATAL' && blocked.issues[0] === 'RT: bloqueado por erro fatal anterior.');
  assert.equal(touched, 0, 'nada foi escrito');
  assert.ok((await readReceipts(profile, nodeFsOps, e.located, AUDIT)).ok, 'leituras continuam');
  clearStorageFatal();

  let attempts = 0;
  const noLink = faulty({
    async link() {
      attempts++;
      throw errno('EPERM');
    },
  });
  const unavailable = await confirmReceipt(profile, noLink, e.located, subject(2), undefined, '2026-10-21T12:00:00.000Z');
  assert.ok(!unavailable.ok && unavailable.code === 'ATOMIC_WRITE_UNAVAILABLE' && unavailable.issues[0] === 'RT: sem link() atômico.');
  assert.equal(attempts, 1, 'sem link() atômico não se repete');
  assert.deepEqual(fs.readdirSync(e.located.dir), ['z0001.json'], 'nem recibo parcial nem temporário');
});

test('writeReceipt: um corpo que não segue o esquema do perfil é recusado como erro interno e nada é gravado', async () => {
  const e = env();
  await prepareReceiptDirectory(profile, nodeFsOps, e.located);
  const bad = { ...receiptBody(profile, subject(1), undefined, '2026-10-21T12:00:00.000Z'), headSha256: 'curto' };
  const r = await writeReceipt(profile, nodeFsOps, e.located, bad);
  assert.ok(!r.ok && r.code === 'INTERNAL' && r.issues[0] === 'RT: recibo montado fora do contrato.');
  assert.deepEqual(fs.readdirSync(e.located.dir), []);
});

test('prepareReceiptDirectory: base ausente é erro (a base NUNCA é criada); a pasta da auditoria é criada; atalho (symlink) é recusado', async () => {
  const e = env();
  const base = path.join(e.root, 'nao-existe');
  const noBase = await prepareReceiptDirectory(profile, nodeFsOps, { root: base, dir: path.join(base, AUDIT) });
  assert.ok(noBase && noBase.code === 'ANCHOR_MISSING' && noBase.issues[0] === 'RT: a base de recibos de teste não existe.');
  assert.ok(!fs.existsSync(base), 'a base não foi criada');
  assert.equal(await prepareReceiptDirectory(profile, nodeFsOps, e.located), null);
  assert.ok(fs.statSync(e.located.dir).isDirectory());
  const link = path.join(e.root, 'atalho');
  fs.symlinkSync(e.root, link);
  const viaLink = await prepareReceiptDirectory(profile, nodeFsOps, { root: e.root, dir: link });
  assert.ok(viaLink && viaLink.code === 'UNSAFE_PATH');
});

test('dois perfis convivem na mesma pasta sem se confundir: o recibo do outro prefixo é só ruído', async () => {
  const e = env();
  await chain(e, 2);
  const other: ReceiptProfile<TestReceipt> = { ...profile, prefix: 'y', filePattern: /^y(\d{4})\.json$/, fileName: (seq) => `y${String(seq).padStart(4, '0')}.json` };
  assert.ok((await confirmReceipt(other, nodeFsOps, e.located, subject(1), undefined, '2026-10-21T12:00:00.000Z')).ok);
  const mine = await readReceipts(profile, nodeFsOps, e.located, AUDIT);
  assert.ok(mine.ok && mine.value.anchors.length === 2 && mine.value.unexpectedFiles.includes('y0001.json'));
  const theirs = await readReceipts(other, nodeFsOps, e.located, AUDIT);
  assert.ok(theirs.ok && theirs.value.anchors.length === 1);
});

test('leitura: falha ao LISTAR a pasta (readdir) é ANCHOR_INTEGRITY com o rótulo do perfil, sem caminho do disco', async () => {
  const e = env();
  await chain(e, 2);
  const unreadable = faulty({ async readdir() { throw errno('EACCES', `EACCES: negado ${e.located.dir}/x /mnt/segredo`); } });
  const r = await readReceipts(profile, unreadable, e.located, AUDIT);
  assert.ok(!r.ok && r.code === 'ANCHOR_INTEGRITY' && r.issues[0]?.includes('listagem dos recibos de teste'), JSON.stringify(r));
  assert.ok(!JSON.stringify(r).includes(e.root) && !JSON.stringify(r).includes('/mnt/segredo'));
});

test('confirmReceipt: um perfil sem nenhuma tentativa devolve erro interno com o texto do perfil e não toca o disco', async () => {
  const e = env();
  await prepareReceiptDirectory(profile, nodeFsOps, e.located);
  const never: ReceiptProfile<TestReceipt> = { ...profile, attempts: 0 };
  const r = await confirmReceipt(never, nodeFsOps, e.located, subject(1), undefined, '2026-10-21T12:00:00.000Z');
  assert.ok(!r.ok && r.code === 'INTERNAL' && r.issues[0] === 'RT: nenhuma tentativa.');
  assert.deepEqual(fs.readdirSync(e.located.dir), []);
});
