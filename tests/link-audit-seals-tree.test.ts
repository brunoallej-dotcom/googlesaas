import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps } from '../src/lib/link-audit/node-fs-ops';
import { parseTreeEntries } from '../src/lib/link-audit-seals-channel/changes';
import { parseSealsTreeArgs, runSealsCheckCli, SEALS_CHECK_EXIT, USAGE_LINES } from '../src/lib/link-audit-seals-channel/cli';
import type { ChannelEnvironment } from '../src/lib/link-audit-seals-channel/paths';
import { summaryLines } from '../src/lib/link-audit-seals-channel/summary';
import { MAX_TREE_FILES, runSealsTreeCheck } from '../src/lib/link-audit-seals-channel/tree';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { signer } from './helpers/link-audit-seal-close-key-fixtures';
import { AUD_A, AUD_B, canonicalText, chainInRepo, closureFor, closureRepoPath, listItem, modesBytes, sealRepoPath, world, writeRepoFile, writeTrustList, type World } from './helpers/link-audit-seals-fixtures';

/*
 * P9.5 — modo ÁRVORE do `seals-check` (job `seals-verify` do `deploy.yml`; spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.5): S-03 a S-08
 * sobre TODOS os arquivos de `link-audit-seals/<amb>/` do commit, sem S-09/S-10 (as cadeias já passaram pelo verificador no merge; o receptor
 * verifica de novo no host). Checkout fictício em pasta temporária, cadeias v2 reais com chaves de teste; nenhum git nem rede.
 */
registerCleanup();

const KEY_A = signer('ensaio-chave-a');
const KEY_B = signer('ensaio-chave-b');

const tree = (w: World, env: ChannelEnvironment = 'homologacao', overrides: Readonly<Record<string, string>> = {}, readBudgetBytes?: number) => {
  const entries = parseTreeEntries(modesBytes(w.root, overrides));
  assert.ok(entries);
  return runSealsTreeCheck({ repoRoot: w.root, entries, env }, { fs: nodeFsOps, ...(readBudgetBytes === undefined ? {} : { readBudgetBytes }) });
};
const codes = (report: { readonly refusals: ReadonlyArray<{ readonly code: string }> }): string[] => report.refusals.map((item) => item.code);

test('P9.5 árvore: todos os manifestos e fechos do ambiente (não só os novos) passam pelo S-03 a S-08; o resumo traz uma linha por arquivo com sha256, seq e sealSha256', async () => {
  const w = world();
  writeTrustList(w, [listItem(KEY_A, 'active'), listItem(KEY_B, 'active')], 'homologacao');
  const chainA = chainInRepo(w, AUD_A, [KEY_A, KEY_A], 'homologacao');
  chainInRepo(w, AUD_B, [KEY_B], 'homologacao');
  writeRepoFile(w.root, closureRepoPath(KEY_A.keyId, 'homologacao'), canonicalText(closureFor(KEY_A, KEY_B, chainA.slice(1))));
  const report = await tree(w);
  assert.deepEqual(codes(report), []);
  assert.equal(report.touched, true);
  assert.deepEqual(report.manifests.map((line) => [line.relativePath, line.seq]), [[`${AUD_A}/seal-0001.json`, 1], [`${AUD_A}/seal-0002.json`, 2], [`${AUD_B}/seal-0001.json`, 1]]);
  for (const line of report.manifests) assert.match(line.bytesSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(report.closures.map((line) => [line.relativePath, line.retiredKeyId, line.signerKeyId]), [[`_closures/${KEY_A.keyId}.json`, KEY_A.keyId, KEY_B.keyId]]);
  const summary = summaryLines(report).join('\n');
  assert.ok(summary.includes(`| \`${AUD_A}/seal-0002.json\` |`));
  assert.ok(!summary.includes('"signature"'), 'nenhum conteúdo de arquivo no resumo');
});

test('P9.5 árvore: só o ambiente pedido; outro ambiente com arquivo quebrado não interfere; ambiente sem arquivos ⇒ nada verificado (touched false)', async () => {
  const w = world();
  chainInRepo(w, AUD_A, [KEY_A], 'homologacao');
  writeRepoFile(w.root, sealRepoPath(AUD_B, 1, 'producao'), '{"quebrado":true}\n');
  assert.deepEqual(codes(await tree(w, 'homologacao')), []);
  assert.deepEqual(codes(await tree(w, 'producao')), ['SEAL_FORMAT']);
  const empty = world();
  const report = await tree(empty, 'producao');
  assert.equal(report.manifests.length, 0);
  assert.deepEqual(codes(report), []);
});

test('P9.5 árvore: caminho fora da gramática (S-03), link/executável (S-04), acima de 256 KiB sem ler (S-05), v1/não canônico/nome trocado (S-06 a S-08), em QUALQUER arquivo da árvore', async () => {
  const w = world();
  const chain = chainInRepo(w, AUD_A, [KEY_A, KEY_A], 'homologacao');
  writeRepoFile(w.root, 'link-audit-seals/homologacao/seals/AUD-001/seal-0001.json', 'x');
  writeRepoFile(w.root, sealRepoPath(AUD_B, 1, 'homologacao'), `${JSON.stringify(chain[0], null, 2)}\n`);
  writeRepoFile(w.root, sealRepoPath('aud-00000000000000c1', 1, 'homologacao'), canonicalText(chain[0]));
  const big = sealRepoPath('aud-00000000000000c2', 1, 'homologacao');
  writeRepoFile(w.root, big, Buffer.alloc(256 * 1024 + 1, 0x20));
  const report = await tree(w, 'homologacao', { [sealRepoPath(AUD_A, 2, 'homologacao')]: '100755' });
  assert.deepEqual(codes(report), ['SEALS_UNEXPECTED_PATH', 'SEALS_BAD_MODE', 'SEALS_TOO_LARGE', 'SEAL_NOT_CANONICAL', 'SEAL_NAME_MISMATCH']);
  assert.ok(!report.refusals.some((item) => item.path?.includes('AUD-001')), 'caminho fora da gramática nunca ecoado');
});

test('P9.5 árvore: as cadeias NÃO são reverificadas (S-09/S-10): um manifesto válido de chave hoje revogada ou fora da lista passa (o receptor verifica de novo no host)', async () => {
  const w = world();
  chainInRepo(w, AUD_A, [KEY_A], 'homologacao');
  writeTrustList(w, [listItem(KEY_A, 'revoked')], 'homologacao');
  assert.deepEqual(codes(await tree(w)), []);
  writeTrustList(w, [], 'homologacao');
  assert.deepEqual(codes(await tree(w)), []);
});

test('P9.5 árvore: lista de confiança como link ⇒ SEALS_BAD_MODE (S-04); acima de 8 KiB ⇒ SEALS_TOO_LARGE (S-05); o formato dela não é julgado aqui (S-12 é do PR)', async () => {
  const w = world();
  chainInRepo(w, AUD_A, [KEY_A], 'homologacao');
  writeRepoFile(w.root, 'link-audit-seals/homologacao/trust-keys.txt', 'lixo-fora-da-gramatica\n');
  assert.deepEqual(codes(await tree(w)), []);
  writeRepoFile(w.root, 'link-audit-seals/homologacao/trust-keys.txt', 'x'.repeat(8193));
  assert.deepEqual(codes(await tree(w)), ['SEALS_TOO_LARGE']);
  writeRepoFile(w.root, 'link-audit-seals/homologacao/trust-keys.txt', '');
  assert.deepEqual(codes(await tree(w, 'homologacao', { 'link-audit-seals/homologacao/trust-keys.txt': '120000' })), ['SEALS_BAD_MODE']);
});

test(`P9.5 árvore: mais de ${MAX_TREE_FILES} manifestos e fechos ⇒ SEALS_TOO_MANY sem ler nenhum; teto de leitura esgotado ⇒ SEALS_TOO_MANY READ_BUDGET`, async () => {
  const w = world();
  const dir = path.join(w.root, 'link-audit-seals', 'homologacao', 'seals');
  for (let i = 0; i <= MAX_TREE_FILES; i += 1) {
    const audit = `aud-${i.toString(16).padStart(16, '0')}`;
    fs.mkdirSync(path.join(dir, audit), { recursive: true });
    fs.writeFileSync(path.join(dir, audit, 'seal-0001.json'), 'nunca lido');
  }
  const reads: string[] = [];
  const entries = parseTreeEntries(modesBytes(w.root));
  assert.ok(entries);
  const spy = { ...nodeFsOps, readFileBytes: async (file: string, max: number) => (reads.push(file), nodeFsOps.readFileBytes(file, max)) };
  const report = await runSealsTreeCheck({ repoRoot: w.root, entries, env: 'homologacao' }, { fs: spy });
  assert.deepEqual(codes(report), ['SEALS_TOO_MANY']);
  assert.equal(reads.length, 0, 'nada lido acima do teto de quantidade');

  const small = world();
  chainInRepo(small, AUD_A, [KEY_A, KEY_A], 'homologacao');
  const budget = await tree(small, 'homologacao', {}, 10);
  assert.ok(budget.refusals.some((item) => item.code === 'SEALS_TOO_MANY' && item.detail === 'READ_BUDGET'));
});

test('P9.5 CLI --tree: argumentos exatos (ambiente do enum, cada opção uma vez, sem misturar com o modo de mudanças); resumo com o título do seals-verify; recusa ⇒ ERRO <CÓDIGO> e saída 1', async () => {
  assert.deepEqual(parseSealsTreeArgs(['--tree', 'homologacao', '--modes', 'm', '--repo', 'r']), { tree: 'homologacao', modes: 'm', repo: 'r' });
  for (const bad of [
    ['--tree', 'staging', '--modes', 'm', '--repo', 'r'],
    ['--tree', 'homologacao', '--modes', 'm'],
    ['--tree', 'homologacao', '--tree', 'producao', '--modes', 'm', '--repo', 'r'],
    ['--tree', 'homologacao', '--modes', 'm', '--repo', 'r', '--changes', 'c'],
    ['--tree', 'homologacao', '--modes', '--repo', '--repo', 'r'],
  ]) {
    assert.equal(parseSealsTreeArgs(bad), null, bad.join(' '));
    const err: string[] = [];
    assert.equal(await runSealsCheckCli(bad, () => undefined, (line) => err.push(line), { fs: nodeFsOps }), SEALS_CHECK_EXIT.USAGE);
    assert.deepEqual(err, [...USAGE_LINES, 'ERRO SEALS_USAGE']);
  }
  const w = world();
  chainInRepo(w, AUD_A, [KEY_A], 'homologacao');
  const dir = tmpDir('p95-tree-cli-');
  const modesFile = path.join(dir, 'modes');
  fs.writeFileSync(modesFile, modesBytes(w.root));
  const out: string[] = [];
  const err: string[] = [];
  const ok = await runSealsCheckCli(['--tree', 'homologacao', '--modes', modesFile, '--repo', w.root], (line) => out.push(line), (line) => err.push(line), { fs: nodeFsOps });
  assert.equal(ok, SEALS_CHECK_EXIT.OK, err.join('\n'));
  assert.equal(out[0], '### seals-verify (homologacao): árvore inteira, S-03 a S-08');
  assert.ok(out.includes('Resultado: `OK`'));
  assert.ok(out.some((line) => line.startsWith(`| \`${AUD_A}/seal-0001.json\` |`)));
  fs.rmSync(path.join(w.root, 'link-audit-seals', 'producao'), { recursive: true });
  fs.writeFileSync(modesFile, modesBytes(w.root));
  const empty = await runSealsCheckCli(['--tree', 'producao', '--modes', modesFile, '--repo', w.root], (line) => out.push(line), () => undefined, { fs: nodeFsOps });
  assert.equal(empty, SEALS_CHECK_EXIT.OK);
  assert.ok(out.includes('Nenhum arquivo sob `link-audit-seals/producao/`: nada a verificar nem a entregar.'));

  writeRepoFile(w.root, sealRepoPath(AUD_A, 2, 'homologacao'), '{}\n');
  fs.writeFileSync(modesFile, modesBytes(w.root));
  const refusedErr: string[] = [];
  const refusedOut: string[] = [];
  const refused = await runSealsCheckCli(['--tree', 'homologacao', '--modes', modesFile, '--repo', w.root], (line) => refusedOut.push(line), (line) => refusedErr.push(line), { fs: nodeFsOps });
  assert.equal(refused, SEALS_CHECK_EXIT.REFUSED);
  assert.deepEqual(refusedErr, ['ERRO SEAL_FORMAT']);
  assert.ok(refusedOut.some((line) => line.includes('ordem das regras S-03 a S-08')));

  fs.writeFileSync(modesFile, 'lixo sem NUL');
  const unreadable: string[] = [];
  assert.equal(await runSealsCheckCli(['--tree', 'homologacao', '--modes', modesFile, '--repo', w.root], () => undefined, (line) => unreadable.push(line), { fs: nodeFsOps }), SEALS_CHECK_EXIT.USAGE);
  assert.deepEqual(unreadable, ['ERRO SEALS_INPUT_INVALID']);
});

/* ------------------------------------------------------------------------------------------------ revisão do PR #74, item 5 */

/** `git ls-tree -r -z` montado à mão: cada entrada `[modo, caminho (texto ou bytes)]`. */
const rawModes = (entries: ReadonlyArray<readonly [string, string | Buffer]>): Buffer =>
  Buffer.concat(entries.map(([mode, repoPath]) => Buffer.concat([Buffer.from(`${mode} ${mode === '160000' ? 'commit' : 'blob'} ${'a'.repeat(40)}\t`, 'utf8'), Buffer.isBuffer(repoPath) ? repoPath : Buffer.from(repoPath, 'utf8'), Buffer.from([0])])));
const treeOfRaw = async (w: World, raw: Buffer, env: ChannelEnvironment = 'homologacao', fsOps = nodeFsOps) => {
  const entries = parseTreeEntries(raw);
  assert.ok(entries, 'entrada na forma do git');
  return runSealsTreeCheck({ repoRoot: w.root, entries, env }, { fs: fsOps });
};
const details = (report: { readonly refusals: ReadonlyArray<{ readonly code: string; readonly detail: string | null }> }): string[] => report.refusals.map((item) => `${item.code}${item.detail === null ? '' : ` ${item.detail}`}`);

test('P9.5 árvore (revisão do PR #74, item 5): caminho do ambiente que não é UTF-8 é RECUSADO (nunca descartado nem "árvore vazia"); fora do ambiente não interfere', async () => {
  const w = world();
  const nonUtf8 = Buffer.concat([Buffer.from('link-audit-seals/homologacao/seals/', 'utf8'), Buffer.from([0xff, 0xfe]), Buffer.from('/seal-0001.json', 'utf8')]);
  const only = await treeOfRaw(w, rawModes([['100644', nonUtf8]]));
  assert.equal(only.touched, true, 'nunca "nada a verificar"');
  assert.deepEqual(codes(only), ['SEALS_UNEXPECTED_PATH']);
  chainInRepo(w, AUD_A, [KEY_A], 'homologacao');
  const mixed = await treeOfRaw(w, Buffer.concat([modesBytes(w.root), rawModes([['100644', nonUtf8]])]));
  assert.deepEqual(codes(mixed), ['SEALS_UNEXPECTED_PATH']);
  assert.equal(mixed.manifests.length, 1, 'os válidos continuam no resumo');
  assert.deepEqual(codes(await treeOfRaw(w, Buffer.concat([modesBytes(w.root), rawModes([['100644', nonUtf8]])]), 'producao')), [], 'o caminho é de homologação');
});

test('P9.5 árvore (revisão do PR #74, item 5): link, submódulo ou arquivo EXATAMENTE em link-audit-seals, link-audit-seals/<amb> ou <amb>/seals ⇒ SEALS_BAD_MODE / SEALS_UNEXPECTED_PATH com a pasta no detalhe (nunca "nada sob o ambiente")', async () => {
  const w = world();
  const cases: Array<[string, string, string]> = [
    ['120000', 'link-audit-seals/homologacao', 'SEALS_BAD_MODE homologacao'],
    ['100644', 'link-audit-seals/homologacao', 'SEALS_UNEXPECTED_PATH homologacao'],
    ['120000', 'link-audit-seals/homologacao/seals', 'SEALS_BAD_MODE homologacao/seals'],
    ['160000', 'link-audit-seals/homologacao/seals', 'SEALS_BAD_MODE homologacao/seals'],
    ['100755', 'link-audit-seals/homologacao/seals', 'SEALS_UNEXPECTED_PATH homologacao/seals'],
    ['120000', 'link-audit-seals', 'SEALS_BAD_MODE link-audit-seals'],
  ];
  for (const [mode, repoPath, expected] of cases) {
    const report = await treeOfRaw(w, rawModes([[mode, repoPath]]));
    assert.equal(report.touched, true, repoPath);
    assert.deepEqual(details(report), [expected], `${mode} ${repoPath}`);
  }
  assert.deepEqual(details(await treeOfRaw(w, rawModes([['120000', 'link-audit-seals/homologacao']]), 'producao')), [], 'a pasta do outro ambiente não interfere');
});

test('P9.5 árvore (revisão do PR #74, item 5): toda pasta ancestral de um arquivo, no CHECKOUT, tem de ser diretório real (lstat): pasta da auditoria, seals ou do ambiente como link ⇒ SEALS_UNEXPECTED_PATH com a pasta, e o arquivo nunca é lido', async () => {
  for (const linked of [`homologacao/seals/${AUD_A}`, 'homologacao/seals', 'homologacao']) {
    const w = world();
    const outside = path.join(tmpDir('p95-fora-'), 'alvo');
    const real = path.join(w.root, 'link-audit-seals', ...linked.split('/'));
    const chain = chainInRepo(w, AUD_A, [KEY_A], 'homologacao');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.renameSync(real, outside);
    fs.symlinkSync(outside, real);
    const reads: string[] = [];
    const spy = { ...nodeFsOps, readFileBytes: async (file: string, max: number) => (reads.push(file), nodeFsOps.readFileBytes(file, max)) };
    const report = await treeOfRaw(w, rawModes([['100644', sealRepoPath(AUD_A, 1, 'homologacao')], ['100644', 'link-audit-seals/homologacao/trust-keys.txt']]), 'homologacao', spy);
    assert.ok(details(report).includes(`SEALS_UNEXPECTED_PATH ${linked}`), `${linked}: ${JSON.stringify(details(report))}`);
    assert.ok(!reads.some((file) => file.endsWith('seal-0001.json')), `${linked}: nada lido através do link`);
    assert.equal(chain.length, 1);
  }
});
