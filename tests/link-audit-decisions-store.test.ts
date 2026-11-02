import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { appendEntry, clearStorageFatal, findReplay, isStorageFatal, readLog, seal, serialize, type BuildContext, type BuildOutcome } from '../src/lib/link-audit-decisions/store';
import { decisionIdFor, DECISION_FILE_KIND, DECISION_SCHEMA_VERSION, ANCHOR_FILE_KIND, anchorFileName, entryFileName, type DecisionDraft, type DecisionEntry } from '../src/lib/link-audit-decisions/types';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { clock, hashTree, registerCleanup, rec, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { TEST_ORIGIN } from './helpers/link-audit-origin-fixtures';

registerCleanup();

const AUDIT_ID = 'auditoria-teste-0001';
const OTHER_AUDIT = 'auditoria-teste-0002';
const BASIS = { capture: 1, report: { capture: 1, revision: 1 }, collectedAt: '2026-10-22T12:54:48.079Z' };

interface Env {
  readonly base: string;
  readonly anchors: string;
}
const env = (): Env => ({ base: tmpDir('lad-st-'), anchors: tmpDir('lad-an-') });
const ropts = (e: Env, fsOps?: FsOps) => ({ anchorDir: e.anchors, ...(fsOps ? { fs: fsOps } : {}) });
const wopts = (e: Env, fsOps?: FsOps, now: () => string = clock) => ({ origin: TEST_ORIGIN, anchorDir: e.anchors, now, ...(fsOps ? { fs: fsOps } : {}) });

const draftFor =
  (who = 'ana@empresa.com', auditId = AUDIT_ID, recordOf?: (seq: number) => Record<string, unknown>) =>
  ({ seq, recordedAt }: BuildContext): BuildOutcome<never> => ({
    ok: true,
    draft: {
      schemaVersion: DECISION_SCHEMA_VERSION,
      kind: DECISION_FILE_KIND,
      auditId,
      action: 'RECORD',
      recordedAt,
      recordedBy: who,
      decisionId: decisionIdFor(seq),
      record: recordOf ? recordOf(seq) : rec.nameEquivalence(`Nome ${seq} Ltda`, `Nome ${seq}`),
      supersedes: null,
      basis: BASIS,
    } as DecisionDraft,
  });

/** Pedido que é o REENVIO da entrada pendente (o serviço reconhece isso por `findReplay`; aqui o teste o declara). */
const resendPending =
  (fallback = draftFor()) =>
  (ctx: BuildContext): BuildOutcome<never> =>
    ctx.pending ? { ok: true, replayOf: ctx.pending.seq } : fallback(ctx);

const append = (e: Env, build = draftFor(), fsOps?: FsOps, now?: () => string) => appendEntry(e.base, AUDIT_ID, build, wopts(e, fsOps, now));
const read = (e: Env, auditId = AUDIT_ID, fsOps?: FsOps) => readLog(e.base, auditId, ropts(e, fsOps));
const code = async (e: Env, auditId = AUDIT_ID): Promise<string> => {
  const r = await read(e, auditId);
  return r.ok ? 'OK' : r.code;
};

async function filled(count = 3): Promise<{ e: Env; dir: string; adir: string }> {
  const e = env();
  for (let i = 0; i < count; i++) {
    const r = await append(e);
    assert.ok(r.ok, JSON.stringify(r));
  }
  return { e, dir: path.join(e.base, AUDIT_ID), adir: path.join(e.anchors, AUDIT_ID) };
}

const parseFile = (dir: string, name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>;
const overwrite = (dir: string, name: string, text: string): void => {
  const file = path.join(dir, name);
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, text);
};
const reseal = (body: Record<string, unknown>): string => {
  const { contentSha256, ...rest } = body;
  assert.ok(contentSha256);
  return serialize(seal(rest));
};
const copyDir = (from: string, to: string): void => {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) fs.copyFileSync(path.join(from, name), path.join(to, name));
};

/* ===================================================================== gravação e leitura básicas */

test('gravação: decisões e âncoras imutáveis (somente leitura), encadeadas e legíveis na verificação completa', async () => {
  const { e, dir, adir } = await filled(3);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['d0001.json', 'd0002.json', 'd0003.json']);
  assert.deepEqual(fs.readdirSync(adir).sort(), ['a0001.json', 'a0002.json', 'a0003.json']);
  for (const folder of [dir, adir]) for (const name of fs.readdirSync(folder)) assert.equal(fs.statSync(path.join(folder, name)).mode & 0o222, 0, `${name} deveria ser somente leitura`);
  const [a, b, c] = ['d0001.json', 'd0002.json', 'd0003.json'].map((n) => parseFile(dir, n));
  assert.deepEqual([a?.prevSha256, b?.prevSha256, c?.prevSha256], [null, a?.contentSha256, b?.contentSha256]);
  const anchors = ['a0001.json', 'a0002.json', 'a0003.json'].map((n) => parseFile(adir, n));
  assert.deepEqual(anchors.map((x) => x.headSha256), [a, b, c].map((x) => x?.contentSha256));
  assert.deepEqual(anchors.map((x) => x.prevAnchorSha256), [null, anchors[0]?.contentSha256, anchors[1]?.contentSha256]);
  const r = await read(e);
  assert.ok(r.ok);
  assert.deepEqual([r.value.checkedFiles, r.value.state.entries.length, r.value.state.head?.seq, r.value.anchors, r.value.unexpectedFiles.length, r.value.orphanTempFiles.length], [3, 3, 3, { count: 3, lastSeq: 3, unanchored: 0 }, 0, 0]);
  assert.equal(r.value.state.head?.sha256, c?.contentSha256);
});

test('auditoria sem decisões lê vazio sem criar nada; bases ausentes (decisões OU âncoras) são erro e NUNCA são criadas', async () => {
  const e = env();
  const empty = await read(e);
  assert.ok(empty.ok && empty.value.state.entries.length === 0 && empty.value.state.head === null && empty.value.anchors.count === 0);
  assert.deepEqual([fs.readdirSync(e.base), fs.readdirSync(e.anchors)], [[], []]);

  const noBase = { base: path.join(e.base, 'nao-existe'), anchors: e.anchors };
  const r1 = await read(noBase);
  assert.ok(!r1.ok && r1.code === 'STORAGE_MISSING');
  const a1 = await append(noBase);
  assert.ok(!a1.ok && a1.code === 'STORAGE_MISSING');
  assert.equal(fs.existsSync(noBase.base), false);

  const noAnchors = { base: e.base, anchors: path.join(e.anchors, 'nao-existe') };
  const r2 = await read(noAnchors);
  assert.ok(!r2.ok && r2.code === 'ANCHOR_MISSING');
  const a2 = await append(noAnchors);
  assert.ok(!a2.ok && a2.code === 'ANCHOR_MISSING');
  assert.equal(fs.existsSync(noAnchors.anchors), false);
  assert.deepEqual(fs.readdirSync(e.base), [], 'sem âncoras nenhuma decisão é gravada (nem a pasta da auditoria)');
});

test('caminhos: auditId e bases inseguros são recusados; symlink na base ou na pasta da auditoria (decisões e âncoras) também', async () => {
  const e = env();
  for (const bad of ['../x', 'ABCDEFGH', 'curto', 'a/b-12345678', 'x'.repeat(65), '', 'ok-ok-ok\u0000']) {
    const r = await read(e, bad);
    assert.ok(!r.ok && r.code === 'INVALID_ID', JSON.stringify(bad));
  }
  assert.ok(!(await readLog('relativo/dir', AUDIT_ID, ropts(e))).ok);
  assert.ok(!(await readLog('', AUDIT_ID, ropts(e))).ok);
  assert.ok(!(await readLog(e.base, AUDIT_ID, { anchorDir: 'relativo/ancoras' })).ok);
  for (const inside of ['public', 'src', '.next', 'node_modules']) {
    const r = await readLog(path.join(process.cwd(), inside, 'x'), AUDIT_ID, ropts(e));
    assert.ok(!r.ok && r.code === 'UNSAFE_PATH', inside);
    const ra = await readLog(e.base, AUDIT_ID, { anchorDir: path.join(process.cwd(), inside, 'x') });
    assert.ok(!ra.ok && ra.code === 'UNSAFE_PATH', `âncoras em ${inside}`);
  }
  const alvo = tmpDir('lad-alvo-');
  fs.symlinkSync(alvo, path.join(e.base, AUDIT_ID));
  const viaLink = await read(e);
  assert.ok(!viaLink.ok && viaLink.code === 'UNSAFE_PATH');
  const appended = await append(e);
  assert.ok(!appended.ok && appended.code === 'UNSAFE_PATH');
  assert.deepEqual(fs.readdirSync(alvo), []); // nada foi escrito pelo symlink

  const e2 = env();
  fs.symlinkSync(alvo, path.join(e2.anchors, AUDIT_ID));
  const anchorsViaLink = await append(e2);
  assert.ok(!anchorsViaLink.ok && anchorsViaLink.code === 'UNSAFE_PATH');
  assert.deepEqual(fs.readdirSync(alvo), []);
  assert.deepEqual(fs.readdirSync(e2.base), [], 'nenhuma decisão gravada');
  const linkedBase = path.join(tmpDir('lad-st-'), 'base-link');
  fs.symlinkSync(e.base, linkedBase);
  assert.ok(!(await readLog(linkedBase, AUDIT_ID, ropts(e))).ok);
});

/* ===================================================================== adulteração do conteúdo e da cadeia */

test('adulteração: conteúdo alterado ⇒ HASH_MISMATCH e NENHUM dado é devolvido', async () => {
  const { e, dir } = await filled(3);
  const entry = parseFile(dir, 'd0002.json');
  overwrite(dir, 'd0002.json', serialize({ ...entry, recordedBy: 'intruso@empresa.com' }));
  const r = await read(e);
  assert.ok(!r.ok && r.code === 'HASH_MISMATCH');
  assert.ok(!('value' in r));
});

test('adulteração: arquivo do MEIO reescrito e re-selado (hash válido) quebra o encadeamento do seguinte', async () => {
  const { e, dir } = await filled(3);
  overwrite(dir, 'd0002.json', reseal({ ...parseFile(dir, 'd0002.json'), recordedBy: 'intruso@empresa.com' }));
  assert.equal(await code(e), 'CHAIN_BROKEN');
});

test('lacunas e numeração: arquivo removido no meio/início, saltos e d0000 ⇒ SEQUENCE_GAP', async () => {
  for (const removed of ['d0001.json', 'd0002.json']) {
    const { e, dir } = await filled(3);
    fs.rmSync(path.join(dir, removed));
    assert.equal(await code(e), 'SEQUENCE_GAP', removed);
  }
  const jump = await filled(2);
  fs.copyFileSync(path.join(jump.dir, 'd0002.json'), path.join(jump.dir, 'd0004.json'));
  assert.equal(await code(jump.e), 'SEQUENCE_GAP');
  const zero = await filled(1);
  fs.copyFileSync(path.join(zero.dir, 'd0001.json'), path.join(zero.dir, 'd0000.json'));
  assert.equal(await code(zero.e), 'SEQUENCE_GAP');
});

test('cópias e trocas: duplicata, troca de ordem e arquivo de outra auditoria são recusados', async () => {
  const dup = await filled(2);
  fs.copyFileSync(path.join(dup.dir, 'd0002.json'), path.join(dup.dir, 'd0003.json'));
  assert.equal(await code(dup.e), 'CHAIN_BROKEN');

  const swap = await filled(3);
  const [one, two] = [fs.readFileSync(path.join(swap.dir, 'd0001.json'), 'utf8'), fs.readFileSync(path.join(swap.dir, 'd0002.json'), 'utf8')];
  overwrite(swap.dir, 'd0001.json', two);
  overwrite(swap.dir, 'd0002.json', one);
  assert.equal(await code(swap.e), 'CHAIN_BROKEN');

  const foreign = await filled(1);
  const other = path.join(foreign.e.base, OTHER_AUDIT);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'd0001.json'), serialize(parseFile(foreign.dir, 'd0001.json')));
  assert.equal(await code(foreign.e, OTHER_AUDIT), 'CHAIN_BROKEN');
  assert.equal(await code(foreign.e, AUDIT_ID), 'OK');
});

/* ===================================================================== B1: o FIM do histórico (âncoras) */

test('B1 — apagar o ÚLTIMO arquivo de decisão é detectado (TRUNCATED) e nenhum dado é devolvido', async () => {
  const { e, dir } = await filled(3);
  fs.rmSync(path.join(dir, 'd0003.json'));
  const r = await read(e);
  assert.ok(!r.ok && r.code === 'TRUNCATED' && !('value' in r));
  const w = await append(e); // e nenhuma escrita é aceita sobre um histórico truncado
  assert.ok(!w.ok && w.code === 'TRUNCATED');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['d0001.json', 'd0002.json']);
});

test('B1 — apagar vários sufixos, ou TODOS os arquivos de decisão, também é detectado', async () => {
  const many = await filled(6);
  for (const n of [4, 5, 6]) fs.rmSync(path.join(many.dir, entryFileName(n)));
  assert.equal(await code(many.e), 'TRUNCATED');
  const all = await filled(3);
  fs.rmSync(all.dir, { recursive: true, force: true });
  assert.equal(await code(all.e), 'TRUNCATED');
});

test('B1 — refazer o hash do ÚLTIMO arquivo (nenhum seguinte o referencia) é detectado pela âncora (ANCHOR_MISMATCH)', async () => {
  const { e, dir } = await filled(3);
  overwrite(dir, 'd0003.json', reseal({ ...parseFile(dir, 'd0003.json'), recordedBy: 'intruso@empresa.com' }));
  assert.equal(await code(e), 'ANCHOR_MISMATCH');
});

test('B1 — apagar a última REVOGAÇÃO (a decisão voltaria a valer) é detectado', async () => {
  const e = env();
  assert.ok((await append(e)).ok);
  const revoke = await append(e, ({ recordedAt }) => ({
    ok: true,
    draft: { schemaVersion: DECISION_SCHEMA_VERSION, kind: DECISION_FILE_KIND, auditId: AUDIT_ID, action: 'REVOKE', recordedAt, recordedBy: 'ana@empresa.com', revokes: 'op-0001', reason: 'Informação conferida e incorreta; decisão desfeita.' } as DecisionDraft,
  }));
  assert.ok(revoke.ok && revoke.state.effective.length === 0);
  fs.rmSync(path.join(e.base, AUDIT_ID, 'd0002.json'));
  assert.equal(await code(e), 'TRUNCATED'); // sem a âncora, a decisão 1 reapareceria como vigente com "integridade OK"
});

test('B1 — restaurar uma CÓPIA ANTIGA da pasta de decisões (erro operacional) é detectado', async () => {
  const { e, dir } = await filled(3);
  const backup = path.join(tmpDir('lad-bkp-'), AUDIT_ID);
  copyDir(dir, backup);
  for (let i = 0; i < 2; i++) assert.ok((await append(e)).ok);
  assert.equal(await code(e), 'OK');
  fs.rmSync(dir, { recursive: true, force: true });
  copyDir(backup, dir); // volta ao estado de 3 arquivos
  assert.equal(await code(e), 'TRUNCATED');
});

test('B1 — LIMITE ASSUMIDO: quem apaga o último arquivo de decisão E a última âncora (as duas pastas) não é detectado pelo armazenamento', async () => {
  const { e, dir, adir } = await filled(3);
  fs.rmSync(path.join(dir, 'd0003.json'));
  fs.rmSync(path.join(adir, 'a0003.json'));
  const r = await read(e);
  assert.ok(r.ok && r.value.state.head?.seq === 2); // por isso o expectedHead existe (ver o teste do serviço) e o ADR documenta o limite
});

test('âncoras adulteradas: hash errado, lacuna, outra auditoria, número trocado, bytes não canônicos, symlink e nome suspeito', async () => {
  const wrongHash = await filled(2);
  overwrite(wrongHash.adir, 'a0002.json', reseal({ ...parseFile(wrongHash.adir, 'a0002.json'), headSha256: 'f'.repeat(64) }));
  assert.equal(await code(wrongHash.e), 'ANCHOR_MISMATCH');

  const edited = await filled(2);
  overwrite(edited.adir, 'a0002.json', serialize({ ...parseFile(edited.adir, 'a0002.json'), anchoredAt: '2020-01-01T00:00:00.000Z' }));
  assert.equal(await code(edited.e), 'ANCHOR_INTEGRITY'); // hash não confere

  const gap = await filled(3);
  fs.rmSync(path.join(gap.adir, 'a0002.json'));
  assert.equal(await code(gap.e), 'ANCHOR_INTEGRITY');

  const foreign = await filled(2);
  overwrite(foreign.adir, 'a0002.json', reseal({ ...parseFile(foreign.adir, 'a0002.json'), auditId: OTHER_AUDIT }));
  assert.equal(await code(foreign.e), 'ANCHOR_INTEGRITY');

  const renumbered = await filled(2);
  overwrite(renumbered.adir, 'a0002.json', reseal({ ...parseFile(renumbered.adir, 'a0002.json'), seq: 1 }));
  assert.equal(await code(renumbered.e), 'ANCHOR_INTEGRITY');

  const minified = await filled(1);
  overwrite(minified.adir, 'a0001.json', JSON.stringify(parseFile(minified.adir, 'a0001.json')));
  assert.equal(await code(minified.e), 'ANCHOR_INTEGRITY');

  const suspicious = await filled(1);
  fs.writeFileSync(path.join(suspicious.adir, 'a0002.json.bak'), 'x');
  assert.equal(await code(suspicious.e), 'ANCHOR_INTEGRITY');

  const link = await filled(1);
  const real = path.join(link.adir, 'real.txt');
  fs.writeFileSync(real, fs.readFileSync(path.join(link.adir, 'a0001.json')));
  fs.rmSync(path.join(link.adir, 'a0001.json'));
  fs.symlinkSync(real, path.join(link.adir, 'a0001.json'));
  assert.equal(await code(link.e), 'ANCHOR_INTEGRITY');
});

test('âncoras removidas: 2 ou mais sem âncora é falha; exatamente 1 é uma entrada PENDENTE: não vale, bloqueia escritas alheias e só o reenvio a conclui', async () => {
  const many = await filled(3);
  fs.rmSync(path.join(many.adir, 'a0003.json'));
  fs.rmSync(path.join(many.adir, 'a0002.json'));
  assert.equal(await code(many.e), 'ANCHOR_INTEGRITY');
  const whole = await filled(3);
  fs.rmSync(whole.adir, { recursive: true, force: true });
  assert.equal(await code(whole.e), 'ANCHOR_INTEGRITY');

  const one = await filled(3);
  fs.rmSync(path.join(one.adir, 'a0003.json'));
  const before = await read(one.e);
  assert.ok(before.ok && before.value.anchors.unanchored === 1);
  // a cauda sem recibo é PENDENTE: o estado devolvido termina na última CONFIRMADA e a pendente vem à parte
  assert.deepEqual([before.value.state.head?.seq, before.value.state.entries.length, before.value.pending?.seq, before.value.checkedFiles], [2, 2, 3, 3]);
  // um pedido qualquer NÃO a "legitima": nada é gravado nem reparado
  const refused = await append(one.e);
  assert.ok(!refused.ok && refused.code === 'PENDING_UNCONFIRMED' && 'pending' in refused && refused.pending.seq === 3 && refused.state.head?.seq === 2);
  assert.deepEqual(fs.readdirSync(one.adir).sort(), ['a0001.json', 'a0002.json']);
  assert.deepEqual(fs.readdirSync(one.dir).sort(), ['d0001.json', 'd0002.json', 'd0003.json']);
  // só o REENVIO da própria pendente grava o recibo que faltava
  const concluded = await append(one.e, resendPending());
  assert.ok(concluded.ok && concluded.replayed && concluded.anchored && concluded.entry.seq === 3 && concluded.state.head?.seq === 3);
  assert.deepEqual(fs.readdirSync(one.adir).sort(), ['a0001.json', 'a0002.json', 'a0003.json']);
  const after = await read(one.e);
  assert.ok(after.ok && after.value.anchors.unanchored === 0 && after.value.pending === null && after.value.state.head?.seq === 3);
  const written = await append(one.e);
  assert.ok(written.ok && !written.replayed && written.entry.seq === 4);
});

test('janela de queda: falha ao gravar a âncora DEPOIS da decisão ⇒ ANCHOR_PENDING (NUNCA sucesso); a entrada fica pendente; só o reenvio a conclui, sem duplicar', async () => {
  const e = env();
  assert.ok((await append(e)).ok);
  const failingAnchors = faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(e.anchors)) throw errno('ENOSPC', 'sem espaço /mnt/secreto/ancora');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const second = await append(e, draftFor(), failingAnchors);
  assert.ok(!second.ok && second.code === 'ANCHOR_PENDING' && 'pending' in second && second.pending.seq === 2 && second.state.head?.seq === 1);
  assert.ok(!JSON.stringify(second).includes('/mnt/secreto'));
  const state = await read(e);
  assert.ok(state.ok && state.value.state.entries.length === 1 && state.value.pending?.seq === 2 && state.value.anchors.unanchored === 1);

  const other = await append(e, draftFor(), failingAnchors); // um pedido DIFERENTE não passa por cima da pendente
  assert.ok(!other.ok && other.code === 'PENDING_UNCONFIRMED');
  const stillFailing = await append(e, resendPending(), failingAnchors); // o reenvio com o recibo ainda impossível continua pendente
  assert.ok(!stillFailing.ok && stillFailing.code === 'ANCHOR_PENDING');
  assert.deepEqual(fs.readdirSync(path.join(e.base, AUDIT_ID)).sort(), ['d0001.json', 'd0002.json']);

  const healthy = await append(e, resendPending()); // disco saudável: o reenvio conclui o recibo, sem nova decisão
  assert.ok(healthy.ok && healthy.replayed && healthy.anchored && healthy.entry.seq === 2);
  const final = await read(e);
  assert.ok(final.ok && final.value.anchors.unanchored === 0 && final.value.anchors.count === 2 && final.value.state.entries.length === 2 && final.value.pending === null);
});

test('o recibo é tentado algumas vezes antes de desistir (erro transitório do volume não deixa a decisão pendente)', async () => {
  const e = env();
  let tries = 0;
  const flaky = faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(e.anchors) && tries++ < 2) throw errno('EAGAIN');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const r = await append(e, draftFor(), flaky);
  assert.ok(r.ok && !r.replayed && r.anchored, JSON.stringify(r));
  assert.equal(tries, 3);
});

test('âncora com disco indisponível ANTES da decisão: erro, nenhuma decisão gravada (fail-closed)', async () => {
  const e = env();
  const brokenAnchors = faulty({
    async mkdir(dir) {
      if (dir.startsWith(e.anchors)) throw errno('EACCES');
      return nodeFsOps.mkdir(dir);
    },
  });
  const r = await append(e, draftFor(), brokenAnchors);
  assert.ok(!r.ok && r.code === 'WRITE_FAILED');
  assert.deepEqual(fs.readdirSync(e.base), [], 'nenhuma decisão (nem pasta da auditoria) foi criada');
});

test('EIO/EROFS na pasta de ÂNCORAS também bloqueia as escritas até reiniciar (fail-closed)', async () => {
  const e = env();
  assert.ok((await append(e)).ok);
  const fatal = faulty({
    async link(from, to) {
      if (to.startsWith(e.anchors)) throw errno('EIO');
      return nodeFsOps.link(from, to);
    },
  });
  const r = await append(e, draftFor(), fatal);
  assert.ok(!r.ok && r.code === 'ANCHOR_PENDING'); // a decisão já estava publicada; só o recibo falhou ⇒ pendente, nunca sucesso
  const blocked = await append(e); // disco "saudável": o bloqueio continua
  assert.ok(!blocked.ok && blocked.code === 'STORAGE_FATAL');
  const listed = await read(e);
  assert.ok(listed.ok && listed.value.pending?.seq === 2); // leituras continuam e mostram a pendente
  clearStorageFatal(e.anchors);
  const resent = await append(e, resendPending());
  assert.ok(resent.ok && resent.replayed && resent.entry.seq === 2);
  assert.ok((await append(e)).ok);
});

/* ===================================================================== bytes canônicos (S1) */

test('S1 — bytes do arquivo: chave duplicada, espaço extra em texto, formatação diferente, campo omitido, CRLF e BOM são recusados', async () => {
  // chave duplicada com o valor original por último: o hash do objeto "passa", mas os bytes não são os gravados
  const dup = await filled(2);
  const original = fs.readFileSync(path.join(dup.dir, 'd0002.json'), 'utf8');
  overwrite(dup.dir, 'd0002.json', original.replace('"recordedBy": "ana@empresa.com"', '"recordedBy": "intruso@empresa.com",\n  "recordedBy": "ana@empresa.com"'));
  assert.equal(await code(dup.e), 'CORRUPT');

  // espaço extra dentro de um texto: o Zod faz trim e o objeto parece igual; o hash do JSON BRUTO acusa
  const pad = await filled(2);
  const before = fs.readFileSync(path.join(pad.dir, 'd0002.json'), 'utf8');
  const text = before.replace('"nameA": "Nome 2 Ltda"', '"nameA": "Nome 2 Ltda  "');
  assert.notEqual(text, before);
  overwrite(pad.dir, 'd0002.json', text);
  assert.equal(await code(pad.e), 'HASH_MISMATCH');

  const minified = await filled(1);
  overwrite(minified.dir, 'd0001.json', JSON.stringify(parseFile(minified.dir, 'd0001.json')));
  assert.equal(await code(minified.e), 'CORRUPT');

  const crlf = await filled(1);
  overwrite(crlf.dir, 'd0001.json', fs.readFileSync(path.join(crlf.dir, 'd0001.json'), 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(await code(crlf.e), 'CORRUPT');

  // campo com valor padrão do Zod omitido (causeEvidenceIds): o objeto normalizado seria igual, o bruto não
  const e = env();
  const na = await append(e, draftFor('ana@empresa.com', AUDIT_ID, () => ({ ...rec.naModel(), causeEvidenceIds: [] })));
  assert.ok(na.ok);
  const dir = path.join(e.base, AUDIT_ID);
  const body = parseFile(dir, 'd0001.json') as { record: Record<string, unknown> };
  assert.deepEqual(body.record.causeEvidenceIds, []);
  delete body.record.causeEvidenceIds;
  overwrite(dir, 'd0001.json', serialize(body));
  assert.equal(await code(e), 'HASH_MISMATCH');

  const bom = await filled(1);
  overwrite(bom.dir, 'd0001.json', `﻿${fs.readFileSync(path.join(bom.dir, 'd0001.json'), 'utf8')}`);
  assert.ok(['SCHEMA', 'CORRUPT'].includes(await code(bom.e)));
});

test('arquivos inválidos: não-JSON, fora do formato (mesmo selado), __proto__, grande demais, vazio, symlink e diretório com nome de entrada', async () => {
  const notJson = await filled(2);
  overwrite(notJson.dir, 'd0002.json', 'isto não é json');
  assert.equal(await code(notJson.e), 'SCHEMA');

  const extra = await filled(2);
  overwrite(extra.dir, 'd0002.json', reseal({ ...parseFile(extra.dir, 'd0002.json'), points: 10 }));
  assert.equal(await code(extra.e), 'SCHEMA'); // campo de pontuação em arquivo: fora do formato, mesmo com hash válido

  const proto = await filled(2);
  const raw = fs.readFileSync(path.join(proto.dir, 'd0002.json'), 'utf8');
  overwrite(proto.dir, 'd0002.json', raw.replace('{\n', '{\n  "__proto__": {"x": 1},\n'));
  assert.ok(['SCHEMA', 'HASH_MISMATCH', 'CORRUPT'].includes(await code(proto.e)));

  const big = await filled(1);
  overwrite(big.dir, 'd0001.json', 'x'.repeat(70 * 1024));
  assert.equal(await code(big.e), 'CORRUPT');

  const empty = await filled(1);
  overwrite(empty.dir, 'd0001.json', '');
  assert.equal(await code(empty.e), 'SCHEMA');

  const link = await filled(1);
  const real = path.join(link.dir, 'real.txt');
  fs.writeFileSync(real, fs.readFileSync(path.join(link.dir, 'd0001.json')));
  fs.rmSync(path.join(link.dir, 'd0001.json'));
  fs.symlinkSync(real, path.join(link.dir, 'd0001.json'));
  assert.equal(await code(link.e), 'CORRUPT');

  const asDirectory = await filled(1);
  fs.rmSync(path.join(asDirectory.dir, 'd0001.json'));
  fs.mkdirSync(path.join(asDirectory.dir, 'd0001.json'));
  assert.equal(await code(asDirectory.e), 'CORRUPT');
});

test('consistência semântica: cadeia com hashes válidos mas revogando o que não existe, ou com identificador trocado, é recusada', async () => {
  const e = env();
  const dir = path.join(e.base, AUDIT_ID);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, 'd0001.json'),
    serialize(
      seal({ schemaVersion: DECISION_SCHEMA_VERSION, kind: DECISION_FILE_KIND, auditId: AUDIT_ID, seq: 1, action: 'REVOKE', recordedAt: clock(), recordedBy: 'ana@empresa.com', prevSha256: null, revokes: 'op-0009', reason: 'Informação conferida e incorreta; decisão desfeita.' }),
    ),
  );
  assert.equal(await code(e), 'SEMANTIC');

  const e2 = env();
  const dir2 = path.join(e2.base, AUDIT_ID);
  fs.mkdirSync(dir2);
  fs.writeFileSync(
    path.join(dir2, 'd0001.json'),
    serialize(
      seal({ schemaVersion: DECISION_SCHEMA_VERSION, kind: DECISION_FILE_KIND, auditId: AUDIT_ID, seq: 1, action: 'RECORD', recordedAt: clock(), recordedBy: 'ana@empresa.com', prevSha256: null, decisionId: 'op-0042', record: rec.c2(), supersedes: null, basis: BASIS }),
    ),
  );
  assert.equal(await code(e2), 'SEMANTIC');
});

test('S4 — nomes que PARECEM entradas (d0003.json.bak, D0001.JSON) são falha; ruído comum (desktop.ini) e temporários órfãos são ignorados e contados', async () => {
  for (const name of ['d0003.json.bak', 'D0001.JSON', 'd0002.json~', 'd0001.json.orig']) {
    const { e, dir } = await filled(2);
    fs.writeFileSync(path.join(dir, name), 'rastro');
    const r = await read(e);
    assert.ok(!r.ok && r.code === 'CORRUPT', name);
    const w = await append(e);
    assert.ok(!w.ok && w.code === 'CORRUPT', `escrita recusada: ${name}`);
  }
  const { e, dir } = await filled(2);
  fs.writeFileSync(path.join(dir, 'desktop.ini'), 'x');
  fs.writeFileSync(path.join(dir, '.tmp-d0003.json-abc'), 'resto');
  const r = await read(e);
  assert.ok(r.ok);
  assert.deepEqual([r.value.unexpectedFiles, r.value.orphanTempFiles, r.value.state.entries.length], [['desktop.ini'], ['.tmp-d0003.json-abc'], 2]);
});

/* ===================================================================== concorrência e corridas */

test('concorrência: 12 gravações simultâneas geram sequências únicas e contínuas, cadeia e âncoras válidas e nenhum temporário', async () => {
  const e = env();
  const results = await Promise.all(Array.from({ length: 12 }, () => append(e)));
  assert.ok(results.every((r) => r.ok && r.anchored));
  const seqs = results.map((r) => (r.ok ? r.entry.seq : -1)).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 12 }, (_, i) => i + 1));
  const r = await read(e);
  assert.ok(r.ok && r.value.state.entries.length === 12 && r.value.anchors.count === 12 && r.value.anchors.unanchored === 0);
  for (const folder of [path.join(e.base, AUDIT_ID), path.join(e.anchors, AUDIT_ID)]) assert.ok(fs.readdirSync(folder).every((name) => /^[da]\d{4}\.json$/.test(name)));
});

/** Simula OUTRO processo: logo antes do `link()` do número N, grava (com hash e encadeamento válidos) o arquivo N e, se `anchored`, o recibo dele (um processo saudável); sem ele, um que caiu entre os dois. */
function racing(e: Env, times: number, anchored = true): { ops: FsOps; competitor: () => number } {
  let raced = 0;
  const dir = path.join(e.base, AUDIT_ID);
  const adir = path.join(e.anchors, AUDIT_ID);
  const ops: FsOps = {
    ...nodeFsOps,
    async link(from, to) {
      if (raced < times && to.startsWith(dir) && /d\d{4}\.json$/.test(to)) {
        raced++;
        const names = fs.readdirSync(dir).filter((n) => /^d\d{4}\.json$/.test(n)).sort();
        const last = names.length ? (JSON.parse(fs.readFileSync(path.join(dir, names[names.length - 1] as string), 'utf8')) as DecisionEntry) : null;
        const seq = names.length + 1;
        const competitor = seal({
          schemaVersion: DECISION_SCHEMA_VERSION,
          kind: DECISION_FILE_KIND,
          auditId: AUDIT_ID,
          seq,
          action: 'RECORD',
          recordedAt: clock(),
          recordedBy: 'bia@empresa.com',
          prevSha256: last?.contentSha256 ?? null,
          decisionId: decisionIdFor(seq),
          record: rec.nameEquivalence(`Concorrente ${seq}`, `Conc ${seq}`),
          supersedes: null,
          basis: BASIS,
        });
        fs.writeFileSync(path.join(dir, entryFileName(seq)), serialize(competitor), { mode: 0o444 });
        if (anchored) {
          fs.mkdirSync(adir, { recursive: true });
          const receipts = fs.readdirSync(adir).filter((n) => /^a\d{4}\.json$/.test(n)).sort();
          const previous = receipts.length ? (JSON.parse(fs.readFileSync(path.join(adir, receipts[receipts.length - 1] as string), 'utf8')) as { contentSha256: string }).contentSha256 : null;
          const receipt = seal({ schemaVersion: DECISION_SCHEMA_VERSION, kind: ANCHOR_FILE_KIND, auditId: AUDIT_ID, seq, headSha256: competitor.contentSha256, anchoredAt: competitor.recordedAt, prevAnchorSha256: previous });
          fs.writeFileSync(path.join(adir, anchorFileName(seq)), serialize(receipt), { mode: 0o444 });
        }
      }
      return nodeFsOps.link(from, to);
    },
  };
  return { ops, competitor: () => raced };
}

test('corrida entre processos: o link() exclusivo falha, o estado é relido (com o recibo do outro) e a decisão vai para o PRÓXIMO número sem sobrescrever', async () => {
  const e = env();
  fs.mkdirSync(path.join(e.base, AUDIT_ID));
  const { ops, competitor } = racing(e, 1);
  let builds = 0;
  const r = await append(
    e,
    (ctx) => {
      builds++;
      return draftFor()(ctx);
    },
    ops,
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([competitor(), builds, r.entry.seq, r.anchored], [1, 2, 2, true]); // reavaliou com o estado novo
  const read2 = await read(e);
  assert.ok(read2.ok);
  assert.deepEqual(read2.value.state.entries.map((x) => [x.seq, x.recordedBy]), [[1, 'bia@empresa.com'], [2, 'ana@empresa.com']]);
  assert.equal(read2.value.anchors.count, 2); // o recibo do outro processo e o nosso
  const dir = path.join(e.base, AUDIT_ID);
  assert.equal(parseFile(dir, 'd0002.json').prevSha256, parseFile(dir, 'd0001.json').contentSha256);
});

test('corrida com um processo que caiu ANTES do recibo: a entrada dele é PENDENTE e a nossa NÃO é gravada sobre ela (nem a "legitima")', async () => {
  const e = env();
  fs.mkdirSync(path.join(e.base, AUDIT_ID));
  const { ops, competitor } = racing(e, 1, false);
  const r = await append(e, draftFor(), ops);
  assert.ok(!r.ok && r.code === 'PENDING_UNCONFIRMED' && 'pending' in r && r.pending.recordedBy === 'bia@empresa.com', JSON.stringify(r));
  assert.equal(competitor(), 1);
  assert.deepEqual(fs.readdirSync(path.join(e.base, AUDIT_ID)), ['d0001.json']); // nada nosso foi gravado
  assert.deepEqual(fs.readdirSync(path.join(e.anchors, AUDIT_ID)), []); // e o recibo do outro NÃO foi fabricado por nós
  const view = await read(e);
  assert.ok(view.ok && view.value.state.entries.length === 0 && view.value.state.head === null && view.value.pending?.seq === 1);
});

test('corrida contínua: depois de 5 tentativas devolve CONFLICT e preserva TODOS os arquivos do outro processo', async () => {
  const e = env();
  fs.mkdirSync(path.join(e.base, AUDIT_ID));
  const { ops, competitor } = racing(e, 99); // o outro processo é saudável: grava a decisão e o recibo de cada número
  const r = await append(e, draftFor(), ops);
  assert.ok(!r.ok && r.code === 'CONFLICT');
  assert.equal(competitor(), 5);
  const read2 = await read(e);
  assert.ok(read2.ok && read2.value.state.entries.length === 5);
  assert.ok(read2.value.state.entries.every((x) => x.recordedBy === 'bia@empresa.com'));
});

test('recusa de domínio no builder: nada é gravado em nenhuma das pastas', async () => {
  const e = env();
  const r = await appendEntry<string>(e.base, AUDIT_ID, () => ({ ok: false, failure: 'NAO' }), wopts(e));
  assert.ok(!r.ok && r.code === 'REJECTED' && r.failure === 'NAO');
  assert.deepEqual([fs.readdirSync(path.join(e.base, AUDIT_ID)), fs.readdirSync(path.join(e.anchors, AUDIT_ID))], [[], []]);
});

test('entrada montada fora do contrato (erro de programação) é recusada antes de gravar, como erro INTERNO (não como adulteração)', async () => {
  const e = env();
  const r = await append(e, (ctx) => ({ ok: true, draft: { ...(draftFor()(ctx) as { draft: DecisionDraft }).draft, recordedBy: 'dev@localhost' } as DecisionDraft }));
  assert.ok(!r.ok && r.code === 'INTERNAL');
  assert.deepEqual(fs.readdirSync(path.join(e.base, AUDIT_ID)), []);
});

test('S11 — recordedAt é decidido DENTRO da trava e nunca fica anterior à última entrada', async () => {
  const e = env();
  const first = await append(e, draftFor(), undefined, () => '2026-10-21T12:00:10.000Z');
  const second = await append(e, draftFor(), undefined, () => '2026-10-21T12:00:05.000Z'); // relógio "atrasado"
  assert.ok(first.ok && second.ok);
  assert.deepEqual([first.entry.recordedAt, second.entry.recordedAt], ['2026-10-21T12:00:10.000Z', '2026-10-21T12:00:10.000Z']);
  const third = await append(e, draftFor(), undefined, () => '2026-10-21T12:00:20.000Z');
  assert.ok(third.ok && third.entry.recordedAt === '2026-10-21T12:00:20.000Z');
});

/* ===================================================================== falhas de disco e escrita atômica */

test('falha de disco comum (ENOSPC): WRITE_FAILED, nada publicado, temporário removido e nova tentativa possível', async () => {
  const e = env();
  const ops = faulty({
    async writeExclusive() {
      throw errno('ENOSPC', 'ENOSPC: sem espaço /mnt/secreto/arquivo');
    },
  });
  const r = await append(e, draftFor(), ops);
  assert.ok(!r.ok && r.code === 'WRITE_FAILED');
  assert.ok(!JSON.stringify(r).includes('/mnt/secreto'), 'nenhum caminho sai na mensagem');
  assert.deepEqual(fs.readdirSync(path.join(e.base, AUDIT_ID)), []);
  assert.equal(isStorageFatal(e.base), false);
  const again = await append(e);
  assert.ok(again.ok && again.entry.seq === 1);
});

test('falha FATAL (EIO/EROFS): interrompe todas as escritas até reiniciar; leituras continuam', async () => {
  for (const fatal of ['EIO', 'EROFS']) {
    const e = env();
    assert.ok((await append(e)).ok);
    const ops = faulty({
      async link(from, to) {
        if (to.startsWith(e.base)) throw errno(fatal);
        return nodeFsOps.link(from, to);
      },
    });
    const r = await append(e, draftFor(), ops);
    assert.ok(!r.ok && r.code === 'STORAGE_FATAL', fatal);
    assert.equal(isStorageFatal(e.base), true);
    const blocked = await append(e); // disco "saudável": continua bloqueado
    assert.ok(!blocked.ok && blocked.code === 'STORAGE_FATAL');
    assert.ok((await read(e)).ok);
    assert.deepEqual(fs.readdirSync(path.join(e.base, AUDIT_ID)), ['d0001.json']); // nada parcial
    clearStorageFatal(e.base);
    assert.ok((await append(e)).ok);
  }
});

test('S2 — sem link() atômico (EPERM/EXDEV/ENOTSUP…) NÃO se grava: erro, nada publicado, nenhum arquivo parcial, nenhum temporário', async () => {
  for (const unsupported of ['EPERM', 'EXDEV', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP']) {
    const e = env();
    const writes: string[] = [];
    const ops = faulty({
      async link() {
        throw errno(unsupported);
      },
      async writeExclusive(target, data, mode) {
        writes.push(path.basename(target));
        return nodeFsOps.writeExclusive(target, data, mode);
      },
    });
    const r = await append(e, draftFor(), ops);
    assert.ok(!r.ok && r.code === 'ATOMIC_WRITE_UNAVAILABLE', unsupported);
    assert.deepEqual(fs.readdirSync(path.join(e.base, AUDIT_ID)), [], 'nenhum arquivo (nem temporário) ficou na pasta');
    assert.ok(writes.length > 0 && writes.every((name) => name.startsWith('.tmp-')), `só temporários foram escritos: ${writes.join(',')}`); // nunca o arquivo final direto
    assert.ok((await append(e)).ok); // com o disco normal volta a funcionar: não ficou envenenada
  }
});

test('S2 — o mesmo vale para a âncora: sem link() atômico ela não é gravada de forma parcial; a decisão fica PENDENTE (nunca sucesso) e íntegra', async () => {
  const e = env();
  const ops = faulty({
    async link(from, to) {
      if (to.startsWith(e.anchors)) throw errno('EPERM');
      return nodeFsOps.link(from, to);
    },
  });
  const r = await append(e, draftFor(), ops);
  assert.ok(!r.ok && r.code === 'ANCHOR_PENDING');
  assert.deepEqual(fs.readdirSync(path.join(e.anchors, AUDIT_ID)), []); // nem recibo parcial nem temporário
  const state = await read(e);
  assert.ok(state.ok && state.value.anchors.unanchored === 1 && state.value.pending?.seq === 1 && state.value.state.entries.length === 0);
});

/* ===================================================================== limites */

test('S5 — limite de 9999 entradas: a próxima gravação é recusada (LIMIT_REACHED) e nada é criado; cada arquivo é lido uma só vez', async () => {
  const e = env();
  const dir = path.join(e.base, AUDIT_ID);
  const adir = path.join(e.anchors, AUDIT_ID);
  fs.mkdirSync(dir);
  fs.mkdirSync(adir);
  let prev: string | null = null;
  let prevAnchor: string | null = null;
  for (let seq = 1; seq <= 9999; seq++) {
    const entry = seal(
      seq % 2 === 1
        ? { schemaVersion: DECISION_SCHEMA_VERSION, kind: DECISION_FILE_KIND, auditId: AUDIT_ID, seq, action: 'RECORD', recordedAt: '2026-10-21T12:00:00.000Z', recordedBy: 'ana@empresa.com', prevSha256: prev, decisionId: decisionIdFor(seq), record: rec.c2(), supersedes: null, basis: BASIS }
        : { schemaVersion: DECISION_SCHEMA_VERSION, kind: DECISION_FILE_KIND, auditId: AUDIT_ID, seq, action: 'REVOKE', recordedAt: '2026-10-21T12:00:00.000Z', recordedBy: 'ana@empresa.com', prevSha256: prev, revokes: decisionIdFor(seq - 1), reason: 'Informação conferida e incorreta; decisão desfeita.' },
    ) as unknown as DecisionEntry;
    prev = entry.contentSha256;
    fs.writeFileSync(path.join(dir, entryFileName(seq)), serialize(entry));
    const anchor: { contentSha256: string } = seal({ schemaVersion: DECISION_SCHEMA_VERSION, kind: ANCHOR_FILE_KIND, auditId: AUDIT_ID, seq, headSha256: entry.contentSha256, anchoredAt: '2026-10-21T12:00:00.000Z', prevAnchorSha256: prevAnchor });
    prevAnchor = anchor.contentSha256;
    fs.writeFileSync(path.join(adir, anchorFileName(seq)), serialize(anchor));
  }
  let reads = 0;
  const counting = faulty({
    async readFile(file, maxBytes) {
      reads++;
      return nodeFsOps.readFile(file, maxBytes);
    },
  });
  const r = await read(e, AUDIT_ID, counting);
  assert.ok(r.ok && r.value.state.entries.length === 9999 && r.value.state.effective.length === 1 && r.value.anchors.count === 9999);
  assert.equal(reads, 2 * 9999, 'cada arquivo (decisão e âncora) é lido exatamente UMA vez: sem releituras (determinístico, sem depender do relógio)');
  const before = { d: hashTree(dir), a: hashTree(adir) };
  const w = await append(e);
  assert.ok(!w.ok && w.code === 'LIMIT_REACHED');
  assert.deepEqual({ d: hashTree(dir), a: hashTree(adir) }, before);
});

test('mensagens de erro nunca contêm caminhos do servidor (inclusive com espaços no caminho)', async () => {
  const { e, dir } = await filled(2);
  overwrite(dir, 'd0002.json', 'lixo');
  const r = await read(e);
  assert.ok(!r.ok);
  const text = JSON.stringify(r);
  assert.ok(!text.includes(e.base) && !/\/(?:tmp|home|mnt|var)\//.test(text), 'sem caminho');
  const spaced = path.join(tmpDir('lad-sp-'), 'minha pasta', 'sub dir');
  fs.mkdirSync(spaced, { recursive: true });
  const ops = faulty({
    async mkdir() {
      throw errno('EACCES', `EACCES: permissão negada ${spaced}/x`);
    },
  });
  const failed = await append({ base: spaced, anchors: e.anchors }, draftFor(), ops);
  assert.ok(!failed.ok);
  assert.ok(!JSON.stringify(failed).includes('minha pasta') && !JSON.stringify(failed).includes('sub dir'));
});

/* ===================================================================== reenvio idempotente (findReplay) */

test('findReplay: só é reenvio a entrada logo depois da visão, encadeada a ela, do MESMO autor e com a MESMA operação', async () => {
  const { e, dir } = await filled(3);
  const entries = ['d0001.json', 'd0002.json', 'd0003.json'].map((n) => parseFile(dir, n) as unknown as DecisionEntry);
  const head = (n: number) => ({ seq: n, sha256: entries[n - 1]?.contentSha256 as string });
  const second = entries[1];
  assert.ok(second && second.action === 'RECORD');
  const same = { action: 'RECORD' as const, record: second.record, supersedes: null };
  assert.equal(findReplay(entries, head(1), 'ana@empresa.com', same), 2); // a visão chegava à 1; o pedido é a entrada 2
  assert.equal(findReplay(entries, head(2), 'ana@empresa.com', same), null); // a entrada 3 é outra operação
  assert.equal(findReplay(entries, head(1), 'bia@empresa.com', same), null); // outro autor nunca é reenvio
  assert.equal(findReplay(entries, head(1), 'ana@empresa.com', { ...same, record: { ...second.record, justification: 'Outra justificativa, mais longa.' } as typeof second.record }), null);
  assert.equal(findReplay(entries, head(1), 'ana@empresa.com', { ...same, supersedes: 'op-0001' }), null);
  assert.equal(findReplay(entries, { seq: 1, sha256: 'f'.repeat(64) }, 'ana@empresa.com', same), null); // visão que não confere com este histórico
  assert.equal(findReplay(entries, { seq: 99, sha256: head(1).sha256 }, 'ana@empresa.com', same), null);
  assert.equal(findReplay(entries, null, 'ana@empresa.com', { action: 'RECORD', record: (entries[0] as typeof second).record, supersedes: null }), 1); // visão "vazio" + a primeira entrada
  assert.equal(findReplay(entries, null, 'ana@empresa.com', same), null);
  assert.equal(findReplay(entries, head(3), 'ana@empresa.com', same), null); // nada depois da visão
  assert.equal(findReplay([], null, 'ana@empresa.com', same), null);
  assert.equal(findReplay(entries, head(1), 'ana@empresa.com', { action: 'REVOKE', revokes: 'op-0002', reason: 'Informação conferida e incorreta; decisão desfeita.' }), null);
  assert.ok(e.base);
});

/* ===================================================================== recibo que já existe quando vamos gravá-lo (EEXIST) */

/** Logo antes do `link()` do recibo `a0001`, "outro processo" grava um recibo para o número 1 com o hash informado. */
function rivalReceipt(e: Env, headSha256: () => string): FsOps {
  let done = false;
  return faulty({
    async link(from, to) {
      if (!done && to.startsWith(e.anchors) && path.basename(to) === 'a0001.json') {
        done = true;
        const receipt = seal({ schemaVersion: DECISION_SCHEMA_VERSION, kind: ANCHOR_FILE_KIND, auditId: AUDIT_ID, seq: 1, headSha256: headSha256(), anchoredAt: clock(), prevAnchorSha256: null });
        fs.writeFileSync(path.join(e.anchors, AUDIT_ID, 'a0001.json'), serialize(receipt), { mode: 0o444 });
      }
      return nodeFsOps.link(from, to);
    },
  });
}

test('recibo gravado por outro processo no mesmo instante: se for IDÊNTICO ao esperado a decisão é confirmada; se NÃO for, nunca é sucesso', async () => {
  const same = env();
  const sameOps = rivalReceipt(same, () => (JSON.parse(fs.readFileSync(path.join(same.base, AUDIT_ID, 'd0001.json'), 'utf8')) as DecisionEntry).contentSha256);
  const adopted = await append(same, draftFor(), sameOps);
  assert.ok(adopted.ok && adopted.anchored && adopted.entry.seq === 1, JSON.stringify(adopted));
  const view = await read(same);
  assert.ok(view.ok && view.value.anchors.unanchored === 0 && view.value.pending === null);

  const other = env();
  const otherOps = rivalReceipt(other, () => 'e'.repeat(64));
  const refused = await append(other, draftFor(), otherOps);
  assert.ok(!refused.ok && refused.code === 'ANCHOR_PENDING', JSON.stringify(refused)); // o recibo existente NÃO corresponde à decisão
  assert.equal(await code(other), 'ANCHOR_MISMATCH'); // e a leitura acusa o conflito, em vez de dar a decisão por boa
});

test('findReplay não depende de a leitura ter conferido a cadeia: com entradas NÃO encadeadas à visão, nunca reconhece reenvio (defesa em profundidade)', () => {
  const mk = (seq: number, prev: string | null, sha: string): DecisionEntry =>
    ({ schemaVersion: 1, kind: DECISION_FILE_KIND, auditId: AUDIT_ID, seq, recordedAt: '2026-10-21T12:00:00.000Z', recordedBy: 'ana@empresa.com', prevSha256: prev, contentSha256: sha, action: 'RECORD', decisionId: decisionIdFor(seq), record: rec.c2(), supersedes: null, basis: BASIS }) as unknown as DecisionEntry;
  const op = { action: 'RECORD' as const, record: rec.c2() as never, supersedes: null };
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const c = 'c'.repeat(64);
  // visão = (1, a) mas a entrada 1 tem hash b: a visão não confere ⇒ não é reenvio (mesmo com a entrada 2 encadeada a "a")
  assert.equal(findReplay([mk(1, null, b), mk(2, a, c)], { seq: 1, sha256: a }, 'ana@empresa.com', op), null);
  // visão confere, mas a entrada seguinte NÃO está encadeada a ela
  assert.equal(findReplay([mk(1, null, a), mk(2, c, b)], { seq: 1, sha256: a }, 'ana@empresa.com', op), null);
  // visão "vazio", mas a primeira entrada diz ter um anterior
  assert.equal(findReplay([mk(1, a, b)], null, 'ana@empresa.com', op), null);
  // e o caso válido continua sendo reconhecido
  assert.equal(findReplay([mk(1, null, a), mk(2, a, b)], { seq: 1, sha256: a }, 'ana@empresa.com', op), 2);
});
