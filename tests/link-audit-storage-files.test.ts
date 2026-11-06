import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import {
  assertBase,
  atomicOnly,
  ATOMIC_UNAVAILABLE_ERRNO,
  clearStorageFatal,
  dirStatus,
  ensureDirectory,
  fail,
  FATAL_ERRNO,
  hashOk,
  isBaseTripped,
  isStorageFatal,
  locateIn,
  readSealedFile,
  scrubPaths,
  seal,
  serialize,
  splitNames,
  tripBase,
} from '../src/lib/link-audit-storage';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { errno, faulty, registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';

registerCleanup();

/* Primitivas do módulo NEUTRO (Onda 6C, I0). Testadas sem nenhum conhecimento de decisões, evidências ou do motor. */

const schema = z.object({ kind: z.literal('AMOSTRA'), seq: z.number().int(), texto: z.string(), contentSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const sample = { kind: 'AMOSTRA', seq: 1, texto: 'ação — acentuação' };

/* ===================================================================== selo e serialização */

test('seal: hash do JSON canônico — independe da ordem das chaves, não altera a entrada e descarta undefined', () => {
  const a = seal({ kind: 'AMOSTRA', seq: 1, texto: 'x' });
  const b = seal({ texto: 'x', seq: 1, kind: 'AMOSTRA' });
  assert.equal(a.contentSha256, b.contentSha256);
  assert.match(a.contentSha256, /^[0-9a-f]{64}$/);
  const input = { kind: 'AMOSTRA', seq: 2, opcional: undefined as string | undefined };
  const sealed = seal(input);
  assert.ok(!('opcional' in sealed));
  assert.ok('opcional' in input, 'a entrada original não é alterada');
  assert.notEqual(seal({ ...sample, seq: 2 }).contentSha256, seal(sample).contentSha256);
});

test('hashOk confere o selo; qualquer alteração (valor, chave extra) o invalida', () => {
  const sealed = seal(sample);
  assert.equal(hashOk(sealed), true);
  const changed = { ...sealed, texto: 'outro' };
  assert.equal(hashOk(changed), false);
  const withExtra = { ...sealed, extra: 1 };
  assert.equal(hashOk(withExtra), false);
});

test('serialize: 2 espaços e quebra de linha final (os bytes que a leitura estrita exige)', () => {
  assert.equal(serialize({ a: 1, b: [1] }), '{\n  "a": 1,\n  "b": [\n    1\n  ]\n}\n');
  assert.equal(serialize('x'), '"x"\n');
});

/* ===================================================================== leitura ESTRITA dos bytes */

async function write(dir: string, name: string, text: string): Promise<string> {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('readSealedFile: aceita só os bytes exatos que este módulo grava; recusa chave duplicada, espaços, CRLF, BOM, hash errado, esquema errado, tamanho e symlink', async () => {
  const dir = tmpDir('stor-read-');
  const good = seal(sample);
  const ok = await readSealedFile(nodeFsOps, await write(dir, 'ok.json', serialize(good)), 4096, schema);
  assert.ok(ok.ok && ok.value.texto === sample.texto);

  const cases: Array<[string, string, string]> = [
    ['json inválido', '{ nao e json', 'SCHEMA'],
    ['esquema errado', serialize({ ...good, seq: 'um' }), 'SCHEMA'],
    ['campo extra', serialize({ ...good, extra: 1 }), 'SCHEMA'],
    ['hash errado', serialize({ ...good, texto: 'adulterado' }), 'HASH_MISMATCH'],
    ['espaço extra na formatação', `${serialize(good).replace('"seq": 1', '"seq":  1')}`, 'CORRUPT'],
    ['CRLF', serialize(good).replace(/\n/g, '\r\n'), 'CORRUPT'],
    ['sem quebra de linha final', serialize(good).trimEnd(), 'CORRUPT'],
    ['BOM', `\uFEFF${serialize(good)}`, 'SCHEMA'],
    ['chave duplicada com o valor original por último', serialize(good).replace('"seq": 1,', '"seq": 99,\n  "seq": 1,'), 'CORRUPT'],
  ];
  for (const [index, [label, text, code]] of cases.entries()) {
    const r = await readSealedFile(nodeFsOps, await write(dir, `caso-${index}.json`, text), 4096, schema);
    assert.ok(!r.ok && r.code === code, `${label}: esperava ${code}, veio ${r.ok ? 'ok' : r.code}`);
  }
  const big = await readSealedFile(nodeFsOps, await write(dir, 'grande.json', serialize(good)), 10, schema);
  assert.ok(!big.ok && big.code === 'CORRUPT');
  const missing = await readSealedFile(nodeFsOps, path.join(dir, 'nao-existe.json'), 4096, schema);
  assert.ok(!missing.ok && missing.code === 'CORRUPT');
  fs.symlinkSync(path.join(dir, 'ok.json'), path.join(dir, 'link.json'));
  const linked = await readSealedFile(nodeFsOps, path.join(dir, 'link.json'), 4096, schema);
  assert.ok(!linked.ok && linked.code === 'CORRUPT', 'symlink nunca é seguido');
});

test('readSealedFile: um esquema que NORMALIZA o conteúdo (acrescenta padrão) é recusado como não canônico; as mensagens nunca trazem o caminho do disco', async () => {
  const dir = tmpDir('stor-norm-');
  const withDefault = z.object({ kind: z.literal('AMOSTRA'), seq: z.number(), texto: z.string(), extra: z.array(z.string()).default([]), contentSha256: z.string() }).strict();
  const file = await write(dir, 'n.json', serialize(seal(sample)));
  const r = await readSealedFile(nodeFsOps, file, 4096, withDefault);
  assert.ok(!r.ok && r.code === 'CORRUPT');
  const texts = JSON.stringify(r);
  assert.ok(!texts.includes(dir), 'sem caminho do disco');
  const gone = await readSealedFile(nodeFsOps, path.join(dir, 'x.json'), 10, schema);
  assert.ok(!JSON.stringify(gone).includes(dir));
});

/* ===================================================================== só se grava de forma atômica */

test('atomicOnly: sem link() atômico (EPERM/EXDEV/ENOTSUP/ENOSYS/EOPNOTSUPP) o erro vira ELINKUNAVAILABLE; EEXIST e o sucesso passam intactos; o resto das operações é preservado', async () => {
  for (const code of ['EPERM', 'EXDEV', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP']) {
    const ops = atomicOnly(faulty({ async link() { throw errno(code); } }));
    await assert.rejects(ops.link('a', 'b'), (error: NodeJS.ErrnoException) => error.code === ATOMIC_UNAVAILABLE_ERRNO, code);
  }
  await assert.rejects(atomicOnly(faulty({ async link() { throw errno('EEXIST'); } })).link('a', 'b'), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  await assert.rejects(atomicOnly(faulty({ async link() { throw errno('EACCES'); } })).link('a', 'b'), (error: NodeJS.ErrnoException) => error.code === 'EACCES');
  let linked = 0;
  const passthrough = atomicOnly(faulty({ async link() { linked++; } }));
  await passthrough.link('a', 'b');
  assert.equal(linked, 1);
  assert.equal(passthrough.readFile, nodeFsOps.readFile);
  assert.equal(ATOMIC_UNAVAILABLE_ERRNO, 'ELINKUNAVAILABLE');
});

/* ===================================================================== caminhos seguros */

test('assertBase: só caminho absoluto, sem byte nulo e fora de public/, src/, .next/ e node_modules/ (sem diferenciar caixa)', () => {
  const root = '/srv/app';
  for (const bad of [undefined, null, 42, '', 'relativo/dir', '/srv/dados/\u0000x']) {
    const r = assertBase(bad, root, 'resultados');
    assert.ok(!r.ok && r.code === 'UNSAFE_PATH', String(bad));
    assert.ok(!r.ok && r.issues[0]?.includes('resultados'), 'a mensagem cita o rótulo informado');
  }
  for (const forbidden of ['/srv/app/public', '/srv/app/public/x', '/SRV/APP/SRC', '/srv/app/.next/cache', '/srv/app/Node_Modules/pkg']) {
    const r = assertBase(forbidden, root, 'âncoras');
    assert.ok(!r.ok && r.code === 'UNSAFE_PATH', forbidden);
  }
  assert.deepEqual(assertBase('/srv/dados/pasta', root, 'x'), { ok: true, value: '/srv/dados/pasta' });
  assert.ok(assertBase('/srv/app-dados', root, 'x').ok, 'prefixo parecido não é a pasta proibida');
  assert.ok(assertBase('/srv/app/dados', root, 'x').ok);
});

test('locateIn: a regra do identificador é DO CONSUMIDOR (padrão e mensagem), e o caminho nunca sai da base', () => {
  const rule = { pattern: /^[a-z]{3,6}$/, message: 'identificador inválido para este consumidor' };
  const ok = locateIn('/srv/dados', 'abcd', '/srv/app', 'x', rule);
  assert.deepEqual(ok, { ok: true, value: { root: '/srv/dados', dir: '/srv/dados/abcd' } });
  for (const bad of ['ab', 'ABCD', '../abc', 'abc/def', 'a\u0000b', 42, undefined]) {
    const r = locateIn('/srv/dados', bad, '/srv/app', 'x', rule);
    assert.ok(!r.ok && r.code === 'INVALID_ID' && r.issues[0] === rule.message, String(bad));
  }
  const unsafe = locateIn('relativo', 'abcd', '/srv/app', 'x', rule);
  assert.ok(!unsafe.ok && unsafe.code === 'UNSAFE_PATH');
  const permissive = locateIn('/srv/dados', '../fora', '/srv/app', 'x', { pattern: /.+/, message: 'm' });
  assert.ok(!permissive.ok && permissive.code === 'UNSAFE_PATH', 'mesmo um padrão frouxo não deixa o caminho sair da base');
});

test('scrubPaths e fail: caminhos absolutos (POSIX e Windows) nunca ficam nas mensagens', () => {
  assert.equal(scrubPaths('erro em /srv/dados/privado/a.json agora'), 'erro em [caminho]');
  assert.equal(scrubPaths('falhou C:\\gmn\\segredo\\x.json'), 'falhou [caminho]');
  assert.equal(scrubPaths('sem caminho nenhum'), 'sem caminho nenhum');
  const f = fail('CORRUPT', 'a /x/y', 'b');
  assert.deepEqual(f, { ok: false, code: 'CORRUPT', issues: ['a [caminho]', 'b'] });
});

/* ===================================================================== diretórios */

test('dirStatus e ensureDirectory: ausente, arquivo e symlink são distinguidos; criar é seguro e erros de disco são saneados', async () => {
  const base = tmpDir('stor-dir-');
  assert.equal(await dirStatus(nodeFsOps, path.join(base, 'nada')), 'MISSING');
  fs.writeFileSync(path.join(base, 'arquivo'), 'x');
  assert.equal(await dirStatus(nodeFsOps, path.join(base, 'arquivo')), 'UNSAFE');
  fs.symlinkSync(base, path.join(base, 'atalho'));
  assert.equal(await dirStatus(nodeFsOps, path.join(base, 'atalho')), 'UNSAFE');
  assert.equal(await dirStatus(nodeFsOps, base), 'EXISTS');

  assert.equal(await ensureDirectory(nodeFsOps, path.join(base, 'nova'), 'x'), null);
  assert.equal(await dirStatus(nodeFsOps, path.join(base, 'nova')), 'EXISTS');
  assert.equal(await ensureDirectory(nodeFsOps, path.join(base, 'nova'), 'x'), null, 'idempotente');
  const viaLink = await ensureDirectory(nodeFsOps, path.join(base, 'atalho'), 'resultados');
  assert.ok(viaLink && viaLink.code === 'UNSAFE_PATH');
  const broken: FsOps = faulty({ async mkdir() { throw errno('EACCES', `EACCES: negado ${base}/x`); } });
  const denied = await ensureDirectory(broken, path.join(base, 'outra'), 'resultados');
  assert.ok(denied && denied.code === 'WRITE_FAILED' && !JSON.stringify(denied).includes(base));
  const weird: FsOps = faulty({ async lstat() { throw errno('EIO'); } });
  const unreadable = await ensureDirectory(weird, path.join(base, 'z'), 'resultados');
  assert.ok(unreadable && unreadable.code === 'WRITE_FAILED');
});

/* ===================================================================== nomes de arquivo */

test('splitNames: classifica entradas válidas, temporários órfãos, nomes SUSPEITOS e ruído — para qualquer prefixo', () => {
  for (const [prefix, pattern] of [['s', /^s(\d{4})\.json$/], ['z', /^z(\d{4})\.json$/]] as const) {
    const names = [`${prefix}0003.json`, `${prefix}0001.json`, `${prefix}0002.json`, `${prefix.toUpperCase()}0004.JSON`, `${prefix}0005.json.bak`, `.tmp-${prefix}0006.json-ab`, 'desktop.ini', 'leia-me.txt'];
    const r = splitNames(names, pattern, prefix);
    assert.deepEqual(r.numbers, [1, 2, 3], prefix);
    assert.deepEqual(r.suspicious.sort(), [`${prefix.toUpperCase()}0004.JSON`, `${prefix}0005.json.bak`].sort());
    assert.deepEqual(r.orphanTempFiles, [`.tmp-${prefix}0006.json-ab`]);
    assert.deepEqual(r.unexpectedFiles.sort(), ['desktop.ini', 'leia-me.txt']);
  }
  // o prefixo é literal: caracteres especiais de expressão regular não viram curinga
  const odd = splitNames(['x0001.json', '.0002.json'], /^\.(\d{4})\.json$/, '.');
  assert.deepEqual(odd.numbers, [2]);
  assert.deepEqual(odd.suspicious, [], 'o nome que casa com o padrão é entrada; "x0001.json" não começa com o prefixo e é só ruído');
  assert.deepEqual(odd.unexpectedFiles, ['x0001.json']);
});

/* ===================================================================== trava após erro fatal de disco */

test('trava fatal: EIO/EROFS bloqueiam a base até limpar; limpar uma base não afeta as outras; o estado é por processo', () => {
  clearStorageFatal();
  assert.deepEqual([...FATAL_ERRNO].sort(), ['EIO', 'EROFS']);
  const a = path.resolve('/srv/a');
  const b = path.resolve('/srv/b');
  assert.equal(isBaseTripped(a), false);
  tripBase(a);
  tripBase(b);
  assert.ok(isBaseTripped(a) && isStorageFatal('/srv/a') && isStorageFatal('/srv/b'));
  clearStorageFatal('/srv/a');
  assert.ok(!isStorageFatal('/srv/a') && isStorageFatal('/srv/b'));
  clearStorageFatal();
  assert.ok(!isStorageFatal('/srv/b'));
});

test('ensureDirectory: um mkdir que "funciona" mas NÃO cria a pasta é recusado (a criação é conferida, não presumida)', async () => {
  const base = tmpDir('stor-fake-mkdir-');
  const noop: FsOps = faulty({ async mkdir() {} });
  const r = await ensureDirectory(noop, path.join(base, 'fantasma'), 'resultados');
  assert.ok(r && r.code === 'UNSAFE_PATH' && r.issues[0] === 'A pasta de resultados da auditoria não é um diretório comum.');
  assert.equal(fs.existsSync(path.join(base, 'fantasma')), false);
});

test('padrões com a flag g/y não quebram o módulo: o resultado é o mesmo em chamadas repetidas (sem estado entre elas)', () => {
  const rule = { pattern: /^[a-z]{3,6}$/g, message: 'inválido' };
  for (let i = 0; i < 4; i++) assert.ok(locateIn('/srv/dados', 'abcd', '/srv/app', 'x', rule).ok, `chamada ${i + 1}`);
  const names = ['z0001.json', 'z0002.json', 'z0003.json', 'z0004.json'];
  const expected = splitNames(names, /^z(\d{4})\.json$/, 'z');
  for (const flags of ['g', 'y', 'gy']) {
    const r = splitNames(names, new RegExp('^z(\\d{4})\\.json$', flags), 'z');
    assert.deepEqual(r, expected, `flags "${flags}"`);
    assert.deepEqual(r.numbers, [1, 2, 3, 4]);
    assert.deepEqual(r.suspicious, []);
  }
});
