import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  anchorBody,
  confirmAnchor,
  prepareAnchorDirectory,
  readAnchors,
  verifyAnchors,
  writeAnchor,
} from '../src/lib/link-audit-decisions/anchor-store';
import { assertBase, clearStorageFatal, isBaseTripped, locateIn, seal, serialize, splitNames, tripBase } from '../src/lib/link-audit-decisions/files';
import { ANCHOR_FILE, anchorFileName, ENTRY_FILE } from '../src/lib/link-audit-decisions/types';
import { canonicalJson } from '../src/lib/link-audit/canonical';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';

registerCleanup();

/*
 * DIFERENCIAL do protocolo de recibos da 6B (Onda 6C, I0). Cada cenário chama as funções de `anchor-store.ts` e as primitivas
 * de `files.ts` da 6B e registra: o resultado COMPLETO (códigos e TODAS as mensagens), o TRAÇO das chamadas de disco (ordem e
 * argumentos; o conteúdo gravado entra como hash), a árvore de arquivos com modos e a trava de erro fatal.
 *
 * Origem: o harness foi escrito pela revisão independente do I0 e PORTADO para cá. A referência
 * (`tests/fixtures/link-audit-storage/anchor-protocol-differential-v1.json`) foi GERADA RODANDO ESTE MESMO ARQUIVO no commit-base
 * d7b0eec (extraído com `git archive`), antes de qualquer código da refatoração. Este teste exige saída IDÊNTICA no código atual.
 * Regenerar a referência é mudar o protocolo da 6B: exige decisão deliberada (o hash dela está fixado abaixo).
 * Fora de propósito: a corrida entre DOIS escritores com hashes diferentes (não determinística, também no commit-base).
 */
const FIXTURE = path.join(__dirname, 'fixtures', 'link-audit-storage', 'anchor-protocol-differential-v1.json');
const FIXTURE_SHA256 = 'bb02974d9d33e53dad8074737debd526ebcbf29bf58860f05cd32089e48059f0';

const AUDIT = 'auditoria-diff-0001';
const errno = (code: string, message = code): Error => Object.assign(new Error(message), { code });
const sha = (n: number | string): string => crypto.createHash('sha256').update(String(n)).digest('hex');
const subject = (seq: number, hash = sha(seq)): any => ({ auditId: AUDIT, seq, contentSha256: hash });
const T0 = '2026-10-21T12:00:00.000Z';

const out: Record<string, unknown> = {};
const roots: string[] = [];
function fresh(): { root: string; located: { root: string; dir: string } } {
  const root = tmpDir('zzd-');
  roots.push(root);
  const located = locateIn(root, AUDIT, '/srv/proj', 'âncoras');
  if (!located.ok) throw new Error('locate');
  return { root, located: located.value };
}
const norm = (text: string, root?: string): string => {
  let t = text;
  for (const r of roots) t = t.split(r).join('<R>');
  if (root) t = t.split(root).join('<R>');
  return t.replace(/-[0-9a-f]{16}\b/g, '-<rnd>');
};
function traced(trace: string[], over: Partial<FsOps> = {}): FsOps {
  const ops: any = { ...nodeFsOps, ...over };
  const wrapped: any = {};
  for (const key of Object.keys(nodeFsOps)) {
    wrapped[key] = async (...args: unknown[]) => {
      const shown = args.map((a) => (typeof a === 'string' ? (key === 'writeExclusive' && args.indexOf(a) === 1 ? `#${sha(a).slice(0, 8)}` : norm(a)) : String(a))).join(',');
      trace.push(`${key}(${shown})`);
      try {
        const r = await ops[key](...args);
        trace.push('  ok');
        return r;
      } catch (error) {
        trace.push(`  throw ${(error as { code?: string }).code}`);
        throw error;
      }
    };
  }
  return wrapped as FsOps;
}
function tree(dir: string): Record<string, string> {
  const res: Record<string, string> = {};
  if (!fs.existsSync(dir)) return res;
  if (!fs.statSync(dir).isDirectory()) return { '<não é diretório>': fs.lstatSync(dir).isSymbolicLink() ? 'symlink' : 'file' };
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    res[norm(name)] = st.isFile() ? `${(st.mode & 0o777).toString(8)}:${sha(fs.readFileSync(full, 'utf8'))}` : st.isSymbolicLink() ? 'symlink' : 'dir';
  }
  return res;
}
const plain = (v: unknown): unknown => JSON.parse(norm(canonicalJson(v)));

async function scenario(name: string, fn: (ctx: { root: string; located: { root: string; dir: string }; trace: string[] }) => Promise<unknown>): Promise<void> {
  clearStorageFatal();
  const ctx = { ...fresh(), trace: [] as string[] };
  let result: unknown;
  try {
    result = await fn(ctx);
  } catch (error) {
    result = { THROWN: String((error as Error).message) };
  }
  out[name] = { result: plain(result), trace: ctx.trace, tree: tree(ctx.located.dir), tripped: isBaseTripped(ctx.located.root) };
  clearStorageFatal();
}

async function chain(located: { root: string; dir: string }, count: number, from = 1): Promise<any[]> {
  const prep = await prepareAnchorDirectory(nodeFsOps, located);
  if (prep) throw new Error(`prep ${prep.code}`);
  const received: any[] = [];
  const existing = await readAnchors(nodeFsOps, located, AUDIT);
  let prev = existing.ok ? existing.value.anchors[existing.value.anchors.length - 1] : undefined;
  for (let seq = from; seq < from + count; seq++) {
    const r = await confirmAnchor(nodeFsOps, located, subject(seq), prev, `2026-10-21T12:00:0${seq % 10}.000Z`);
    if (!r.ok) throw new Error(`chain ${r.code}`);
    received.push(r.value);
    prev = r.value;
  }
  return received;
}
const unlock = (file: string): void => fs.chmodSync(file, 0o644);
const reseal = (file: string, change: Record<string, unknown>): void => {
  const { contentSha256, ...body } = JSON.parse(fs.readFileSync(file, 'utf8'));
  unlock(file);
  fs.writeFileSync(file, serialize(seal({ ...body, ...change })));
};

test('DIFERENCIAL — as funções de recibo e as primitivas da 6B reproduzem exatamente a saída do commit-base (resultado, mensagens, traço de disco, árvore, modos)', async () => {
  // ---------- readAnchors
  await scenario('read: base ausente', async ({ root, trace }) => readAnchors(traced(trace), { root: path.join(root, 'nada'), dir: path.join(root, 'nada', AUDIT) }, AUDIT));
  await scenario('read: base é arquivo', async ({ root, trace }) => {
    fs.writeFileSync(path.join(root, 'f'), 'x');
    return readAnchors(traced(trace), { root: path.join(root, 'f'), dir: path.join(root, 'f', AUDIT) }, AUDIT);
  });
  await scenario('read: base symlink', async ({ root, trace }) => {
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'lnk'));
    return readAnchors(traced(trace), { root: path.join(root, 'lnk'), dir: path.join(root, 'lnk', AUDIT) }, AUDIT);
  });
  await scenario('read: auditoria ausente', async ({ located, trace }) => readAnchors(traced(trace), located, AUDIT));
  await scenario('read: auditoria é arquivo', async ({ located, trace }) => {
    fs.writeFileSync(located.dir, 'x');
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: auditoria symlink', async ({ root, located, trace }) => {
    fs.mkdirSync(path.join(root, 'alvo'));
    fs.symlinkSync(path.join(root, 'alvo'), located.dir);
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: lstat da base dá EIO (ERROR)', async ({ located, trace }) =>
    readAnchors(traced(trace, { async lstat() { throw errno('EIO'); } }), located, AUDIT),
  );
  await scenario('read: readdir falha', async ({ located, root, trace }) => {
    await chain(located, 2);
    return readAnchors(traced(trace, { async readdir() { throw errno('EACCES', `EACCES: negado ${root}/x /mnt/segredo`); } }), located, AUDIT);
  });
  await scenario('read: íntegro 3', async ({ located, trace }) => {
    await chain(located, 3);
    fs.writeFileSync(path.join(located.dir, 'desktop.ini'), 'x');
    fs.writeFileSync(path.join(located.dir, '.tmp-a0004.json-abcdef0123456789'), 'x');
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: nome suspeito longo', async ({ located, trace }) => {
    await chain(located, 1);
    fs.writeFileSync(path.join(located.dir, `a0002${'x'.repeat(120)}`), 'x');
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: suspeito maiúsculo', async ({ located, trace }) => {
    await chain(located, 1);
    fs.writeFileSync(path.join(located.dir, 'A0002.JSON'), 'x');
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: lacuna', async ({ located, trace }) => {
    await chain(located, 3);
    unlock(path.join(located.dir, 'a0002.json'));
    fs.rmSync(path.join(located.dir, 'a0002.json'));
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: não começa em 1', async ({ located, trace }) => {
    await chain(located, 2);
    unlock(path.join(located.dir, 'a0001.json'));
    fs.rmSync(path.join(located.dir, 'a0001.json'));
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: outra auditoria', async ({ located, trace }) => {
    await chain(located, 2);
    reseal(path.join(located.dir, 'a0002.json'), { auditId: 'outra-auditoria-01' });
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: seq interna', async ({ located, trace }) => {
    await chain(located, 2);
    reseal(path.join(located.dir, 'a0002.json'), { seq: 5 });
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: encadeamento', async ({ located, trace }) => {
    await chain(located, 2);
    reseal(path.join(located.dir, 'a0002.json'), { prevAnchorSha256: sha('x') });
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: primeiro com prev não nulo', async ({ located, trace }) => {
    await chain(located, 2);
    reseal(path.join(located.dir, 'a0001.json'), { prevAnchorSha256: sha('x') });
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: esquema errado', async ({ located, trace }) => {
    await chain(located, 2);
    reseal(path.join(located.dir, 'a0002.json'), { kind: 'OUTRO' });
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: json inválido', async ({ located, trace }) => {
    await chain(located, 2);
    unlock(path.join(located.dir, 'a0002.json'));
    fs.writeFileSync(path.join(located.dir, 'a0002.json'), '{ nao');
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: hash errado', async ({ located, trace }) => {
    await chain(located, 2);
    const f = path.join(located.dir, 'a0002.json');
    unlock(f);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.anchoredAt = '2027-01-01T00:00:00.000Z';
    fs.writeFileSync(f, serialize(j));
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: bytes não canônicos', async ({ located, trace }) => {
    await chain(located, 2);
    const f = path.join(located.dir, 'a0002.json');
    unlock(f);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"seq": 2', '"seq":  2'));
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: arquivo grande', async ({ located, trace }) => {
    await chain(located, 1);
    const f = path.join(located.dir, 'a0001.json');
    unlock(f);
    fs.writeFileSync(f, ' '.repeat(70 * 1024));
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: symlink como arquivo', async ({ located, trace }) => {
    await chain(located, 1);
    const f = path.join(located.dir, 'a0001.json');
    const copy = path.join(located.root, 'copia.json');
    fs.copyFileSync(f, copy);
    unlock(f);
    fs.rmSync(f);
    fs.symlinkSync(copy, f);
    return readAnchors(traced(trace), located, AUDIT);
  });
  await scenario('read: auditId consultado diferente', async ({ located, trace }) => {
    await chain(located, 2);
    return readAnchors(traced(trace), located, 'outra-auditoria-02');
  });
  await scenario('read: muitos (12) com índice > 9', async ({ located, trace }) => {
    await chain(located, 12);
    return readAnchors(traced(trace), located, AUDIT);
  });

  // ---------- verifyAnchors (puro)
  {
    const { located } = fresh();
    const anchors = await chain(located, 3);
    const entries = (n: number, bad?: number) => Array.from({ length: n }, (_, i) => ({ contentSha256: bad === i + 1 ? sha('ruim') : sha(i + 1) }));
    out['verify'] = plain({
      ok3: verifyAnchors(entries(3) as any, anchors),
      pend: verifyAnchors(entries(4) as any, anchors),
      two: verifyAnchors(entries(5) as any, anchors),
      trunc: verifyAnchors(entries(2) as any, anchors),
      trunc0: verifyAnchors([] as any, anchors),
      mism: verifyAnchors(entries(3, 2) as any, anchors),
      mismLast: verifyAnchors(entries(3, 3) as any, anchors),
      empty: verifyAnchors([] as any, []),
      one: verifyAnchors(entries(1) as any, []),
      onlyUnanch: verifyAnchors(entries(2) as any, []),
    });
  }

  // ---------- anchorBody
  {
    const prev = seal({ x: 1 }) as any;
    out['body'] = plain({
      first: anchorBody(subject(1) as any, undefined, T0),
      firstKeys: Object.keys(anchorBody(subject(1) as any, undefined, T0)),
      second: anchorBody(subject(2) as any, prev, T0),
      withExtraFieldsOnEntry: anchorBody({ ...subject(3), extra: 'x', kind: 'ZZ', schemaVersion: 9 } as any, undefined, T0),
      json: JSON.stringify(anchorBody(subject(2) as any, prev, T0)),
    });
  }

  // ---------- prepareAnchorDirectory
  await scenario('prep: base ausente', async ({ root, trace }) => prepareAnchorDirectory(traced(trace), { root: path.join(root, 'nada'), dir: path.join(root, 'nada', AUDIT) }));
  await scenario('prep: base é arquivo', async ({ root, trace }) => {
    fs.writeFileSync(path.join(root, 'f'), 'x');
    return prepareAnchorDirectory(traced(trace), { root: path.join(root, 'f'), dir: path.join(root, 'f', AUDIT) });
  });
  await scenario('prep: cria', async ({ located, trace }) => prepareAnchorDirectory(traced(trace), located));
  await scenario('prep: idempotente', async ({ located, trace }) => {
    fs.mkdirSync(located.dir);
    return prepareAnchorDirectory(traced(trace), located);
  });
  await scenario('prep: auditoria symlink', async ({ root, located, trace }) => {
    fs.mkdirSync(path.join(root, 'alvo'));
    fs.symlinkSync(path.join(root, 'alvo'), located.dir);
    return prepareAnchorDirectory(traced(trace), located);
  });
  await scenario('prep: auditoria arquivo', async ({ located, trace }) => {
    fs.writeFileSync(located.dir, 'x');
    return prepareAnchorDirectory(traced(trace), located);
  });
  await scenario('prep: lstat EIO', async ({ located, trace }) => prepareAnchorDirectory(traced(trace, { async lstat() { throw errno('EIO'); } }), located));
  await scenario('prep: mkdir falha', async ({ located, root, trace }) =>
    prepareAnchorDirectory(traced(trace, { async mkdir() { throw errno('EACCES', `EACCES: negado ${root}/x`); } }), located),
  );
  await scenario('prep: mkdir "ok" mas não cria', async ({ located, trace }) => prepareAnchorDirectory(traced(trace, { async mkdir() {} }), located));

  // ---------- writeAnchor
  const bodyOf = (seq: number, prev?: any) => anchorBody(subject(seq) as any, prev, T0);
  await scenario('write: ok', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    return writeAnchor(traced(trace), located, bodyOf(1));
  });
  await scenario('write: base travada', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    tripBase(located.root);
    return writeAnchor(traced(trace), located, bodyOf(1));
  });
  await scenario('write: contrato inválido', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    return writeAnchor(traced(trace), located, { ...bodyOf(1), headSha256: 'curto' } as any);
  });
  await scenario('write: contrato inválido (seq 0)', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    return writeAnchor(traced(trace), located, { ...bodyOf(0) } as any);
  });
  await scenario('write: conflito', async ({ located, trace }) => {
    await chain(located, 1);
    return writeAnchor(traced(trace), located, bodyOf(1));
  });
  for (const code of ['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']) {
    await scenario(`write: link ${code}`, async ({ located, trace }) => {
      await prepareAnchorDirectory(nodeFsOps, located);
      return writeAnchor(traced(trace, { async link() { throw errno(code); } }), located, bodyOf(1));
    });
  }
  for (const code of ['EIO', 'EROFS']) {
    await scenario(`write: link ${code}`, async ({ located, trace }) => {
      await prepareAnchorDirectory(nodeFsOps, located);
      const r = await writeAnchor(traced(trace, { async link() { throw errno(code); } }), located, bodyOf(1));
      const again = await writeAnchor(traced(trace), located, bodyOf(1));
      return { r, again };
    });
    await scenario(`write: tmp ${code}`, async ({ located, trace }) => {
      await prepareAnchorDirectory(nodeFsOps, located);
      return writeAnchor(traced(trace, { async writeExclusive() { throw errno(code, `${code}: x ${located.dir}/y`); } }), located, bodyOf(1));
    });
  }
  await scenario('write: ENOSPC no tmp', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    return writeAnchor(traced(trace, { async writeExclusive() { throw errno('ENOSPC', `sem espaço ${located.dir}/t`); } }), located, bodyOf(1));
  });
  await scenario('write: EACCES no link', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    return writeAnchor(traced(trace, { async link() { throw errno('EACCES', 'negado /mnt/x'); } }), located, bodyOf(1));
  });
  await scenario('write: pasta da auditoria ausente', async ({ located, trace }) => writeAnchor(traced(trace), located, bodyOf(1)));
  await scenario('write: chmod/unlink/sync falham (best effort)', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    return writeAnchor(
      traced(trace, {
        async chmod() { throw errno('EPERM'); },
        async unlink() { throw errno('EPERM'); },
        async syncDirectory() { throw errno('EIO'); },
      }),
      located,
      bodyOf(1),
    );
  });
  await scenario('write: EEXIST no tmp', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    return writeAnchor(traced(trace, { async writeExclusive() { throw errno('EEXIST'); } }), located, bodyOf(1));
  });

  // ---------- confirmAnchor
  await scenario('confirm: ok primeiro', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    return confirmAnchor(traced(trace), located, subject(1), undefined, T0);
  });
  await scenario('confirm: ENOSPC → 3 tentativas', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    return confirmAnchor(traced(trace, { async writeExclusive() { throw errno('ENOSPC', `x ${located.dir}`); } }), located, subject(1), undefined, T0);
  });
  await scenario('confirm: 2 falhas + sucesso', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    let n = 0;
    return confirmAnchor(traced(trace, { async writeExclusive(t, d, m) { if (n++ < 2) throw errno('EAGAIN'); return nodeFsOps.writeExclusive(t, d, m); } }), located, subject(1), undefined, T0);
  });
  await scenario('confirm: 3 falhas diferentes → última', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    let n = 0;
    return confirmAnchor(traced(trace, { async writeExclusive() { n++; throw errno(n === 1 ? 'EAGAIN' : n === 2 ? 'ENOSPC' : 'EBUSY', `m${n}`); } }), located, subject(1), undefined, T0);
  });
  await scenario('confirm: EIO no link → fatal, 1 tentativa', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    const r = await confirmAnchor(traced(trace, { async link() { throw errno('EIO'); } }), located, subject(1), undefined, T0);
    const after = await confirmAnchor(traced(trace), located, subject(1), undefined, T0);
    return { r, after };
  });
  await scenario('confirm: EROFS no link', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    return confirmAnchor(traced(trace, { async link() { throw errno('EROFS'); } }), located, subject(1), undefined, T0);
  });
  await scenario('confirm: sem link atômico', async ({ located, trace }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    return confirmAnchor(traced(trace, { async link() { throw errno('EXDEV'); } }), located, subject(1), undefined, T0);
  });
  await scenario('confirm: EEXIST idêntico → adota', async ({ located, trace }) => {
    await chain(located, 2);
    const read = await readAnchors(nodeFsOps, located, AUDIT);
    const prev = read.ok ? read.value.anchors[0] : undefined;
    return confirmAnchor(traced(trace), located, subject(2), prev, '2030-01-01T00:00:00.000Z');
  });
  await scenario('confirm: EEXIST hash diferente', async ({ located, trace }) => {
    await chain(located, 2);
    const read = await readAnchors(nodeFsOps, located, AUDIT);
    const prev = read.ok ? read.value.anchors[0] : undefined;
    return confirmAnchor(traced(trace), located, subject(2, sha('outro')), prev, T0);
  });
  await scenario('confirm: EEXIST não é a última', async ({ located, trace }) => {
    await chain(located, 3);
    return confirmAnchor(traced(trace), located, subject(1), undefined, T0);
  });
  await scenario('confirm: EEXIST com pasta adulterada', async ({ located, trace }) => {
    await chain(located, 2);
    reseal(path.join(located.dir, 'a0001.json'), { auditId: 'outra-auditoria-01' });
    return confirmAnchor(traced(trace), located, subject(2), undefined, T0);
  });
  await scenario('confirm: EEXIST e readdir falha', async ({ located, trace }) => {
    await chain(located, 1);
    return confirmAnchor(traced(trace, { async readdir() { throw errno('EIO', 'x /y/z'); } }), located, subject(1), undefined, T0);
  });
  await scenario('confirm: corrida (2 paralelos, mesmo recibo)', async ({ located }) => {
    await prepareAnchorDirectory(nodeFsOps, located);
    const rs = await Promise.all([confirmAnchor(nodeFsOps, located, subject(1), undefined, T0), confirmAnchor(nodeFsOps, located, subject(1), undefined, T0)]);
    return rs;
  });
  await scenario('confirm: pasta da auditoria ausente', async ({ located, trace }) => confirmAnchor(traced(trace), located, subject(1), undefined, T0));
  await scenario('confirm: com anterior', async ({ located, trace }) => {
    const a = await chain(located, 2);
    return confirmAnchor(traced(trace), located, subject(3), a[1], T0);
  });

  // ---------- primitivas
  out['prims'] = plain({
    split: [
      splitNames(['a1.json', 'a0001.json', 'a0001.json.bak', 'A0002.JSON', '.tmp-a0003.json-ab', 'readme', 'a', 'a9', 'ax1', ''], ANCHOR_FILE, 'a'),
      splitNames(['d0002.json', 'd0001.json', 'd0100.json', 'D0003.json', 'd.json', 'dx'], ENTRY_FILE, 'd'),
    ],
    locate: [
      locateIn('/srv/d', AUDIT, '/srv/proj', 'decisões'),
      locateIn('/srv/d', 'x', '/srv/proj', 'decisões'),
      locateIn('/srv/d', 42, '/srv/proj', 'decisões'),
      locateIn('/srv/d', 'a'.repeat(65), '/srv/proj', 'decisões'),
      locateIn('/srv/d', 'a'.repeat(64), '/srv/proj', 'decisões'),
      locateIn('/srv/d', 'abcdefg', '/srv/proj', 'decisões'),
      locateIn('/srv/d', 'abcdefgh\n', '/srv/proj', 'decisões'),
      locateIn('/srv/proj/src/x', AUDIT, '/srv/proj', 'decisões'),
      locateIn('d', AUDIT, '/srv/proj', 'âncoras'),
      locateIn(undefined, 'invalido!!', '/srv/proj', 'âncoras'),
      locateIn('/', AUDIT, '/srv/proj', 'x'),
    ],
    base: [assertBase('/srv/d/', '/srv/proj', 'x'), assertBase('/srv/proj/Public', '/srv/proj', 'x')],
    filename: [anchorFileName(1), anchorFileName(1234)],
  });

  const actual = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
  const record = process.env.GMN_RECORD_DIFF;
  if (record) {
    fs.writeFileSync(record, `${JSON.stringify(actual, null, 1)}\n`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), 'os mesmos cenários');
  for (const key of Object.keys(expected)) assert.deepEqual(actual[key], expected[key], `cenário: ${key}`);
});

test('a referência diferencial gerada no commit-base não foi alterada', () => {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex'), FIXTURE_SHA256);
});
