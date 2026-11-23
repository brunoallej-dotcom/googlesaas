import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps } from '../src/lib/link-audit/node-fs-ops';
import type { BytesFsOps } from '../src/lib/link-audit/fs-ops';
import { createEvidenceSeal, MAX_SEAL_BYTES, sealSha256 } from '../src/lib/link-audit-evidence/provenance';
import { chainRefusalCode } from '../src/lib/link-audit-seals-channel/chains';
import { parseNameStatus, parseTreeModes } from '../src/lib/link-audit-seals-channel/changes';
import { runSealsCheckCli, SEALS_CHECK_EXIT } from '../src/lib/link-audit-seals-channel/cli';
import { classifyChannelPath } from '../src/lib/link-audit-seals-channel/paths';
import { closureSummaryLine, manifestSummaryLine, summaryLines } from '../src/lib/link-audit-seals-channel/summary';
import { errno, registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { E1, E2, signer } from './helpers/link-audit-seal-close-key-fixtures';
import { AUD_A, AUD_B, AUD_C, canonicalText, chainInRepo, changesBytes, check, cliArgs, closureFor, closureRepoPath, codes, listFile, listItem, modesBytes, nextSeal, sealRepoPath, world, writeRepoFile, writeTrustList, type World } from './helpers/link-audit-seals-fixtures';

/*
 * P9.2 — o job `seals` (spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.4, S-01 a S-14; critérios P9-S01 a P9-S12; o P9-S10 é o teste
 * estático do workflow em `link-audit-seals-workflow.test.ts`). Checkout fictício em pasta temporária, cadeias v2 REAIS assinadas por chaves
 * de TESTE geradas em memória e verificadas pelo VERIFICADOR v2 REAL; nenhum git nem rede.
 */
registerCleanup();

const KEY_A = signer('ek-canal-a');
const KEY_B = signer('ek-canal-b');
const KEY_R = signer('ek-canal-revogada');
const KEY_T = signer('ek-canal-aposentada');
const KEY_X = signer('ek-canal-fora');
const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Commit-base: lista de produção com A e B ativas e a cadeia de AUD_A com um manifesto de A. */
function baseWorld(): { readonly w: World; readonly chain: ReturnType<typeof chainInRepo> } {
  const w = world();
  writeTrustList(w, [listItem(KEY_A), listItem(KEY_B)]);
  return { w, chain: chainInRepo(w, AUD_A, [KEY_A]) };
}

/** Acrescenta o próximo manifesto (canônico) de AUD_A ao checkout e devolve o caminho do repositório. */
function addNext(w: World, chain: ReturnType<typeof chainInRepo>, spec: Parameters<typeof nextSeal>[2]): string {
  const seal = nextSeal(AUD_A, chain, spec);
  chain.push(seal);
  const repoPath = sealRepoPath(AUD_A, seal.seq);
  writeRepoFile(w.root, repoPath, canonicalText(seal));
  return repoPath;
}

/* ------------------------------------------------------------------------------------------------------------------- P9-S01 */

test('P9-S01 PR com M, D, R ou T sob `<amb>/seals/` ⇒ SEALS_NOT_APPEND_ONLY; só A passa', async () => {
  const { w, chain } = baseWorld();
  const existing = sealRepoPath(AUD_A, 1);
  for (const status of ['M', 'D', 'T']) assert.ok(codes(await check(w, [[status, existing]])).includes('SEALS_NOT_APPEND_ONLY'), status);
  const renamed = await check(w, [['R100', existing, sealRepoPath(AUD_B, 1)]]);
  assert.deepEqual(renamed.refusals.filter((item) => item.rule === 'S-01').map((item) => item.path), [`producao/seals/${AUD_A}/seal-0001.json`, `producao/seals/${AUD_B}/seal-0001.json`]);
  const copied = await check(w, [['C075', existing, sealRepoPath(AUD_B, 1)]]);
  assert.ok(codes(copied).includes('SEALS_NOT_APPEND_ONLY'), 'C');
  const added = addNext(w, chain, { signer: KEY_A, entries: E2 });
  assert.deepEqual((await check(w, [['A', added]])).refusals, [], 'só A passa');
});

/* ------------------------------------------------------------------------------------------------------------------- P9-S02 */

test('P9-S02 caminho fora da tabela do §5.2 (auditId fora de `^aud-[0-9a-f]{16}$`, seal-0000, seal-0257, caixa diferente, segmento a mais, ambiente desconhecido) ⇒ SEALS_UNEXPECTED_PATH, sem ecoar o caminho', async () => {
  const w = world();
  const unexpected = [
    'link-audit-seals/producao/seals/aud-002-autorizacao-01/seal-0001.json',
    'link-audit-seals/producao/seals/AUD-0123456789ABCDEF/seal-0001.json',
    'link-audit-seals/producao/seals/aud-0123456789abcde/seal-0001.json',
    'link-audit-seals/producao/seals/aud-0123456789abcdef0/seal-0001.json',
    `link-audit-seals/producao/seals/${AUD_A}/seal-0000.json`,
    `link-audit-seals/producao/seals/${AUD_A}/seal-0257.json`,
    `link-audit-seals/producao/seals/${AUD_A}/SEAL-0001.json`,
    `link-audit-seals/producao/seals/${AUD_A}/seal-0001.JSON`,
    `link-audit-seals/producao/seals/${AUD_A}/seal-1.json`,
    `link-audit-seals/producao/seals/${AUD_A}/sub/seal-0001.json`,
    `link-audit-seals/Producao/seals/${AUD_A}/seal-0001.json`,
    `link-audit-seals/staging/seals/${AUD_A}/seal-0001.json`,
    'link-audit-seals/producao/seals/_closures/EK-A.json',
    'link-audit-seals/producao/seals/_closures/abc.json',
    'link-audit-seals/producao/Trust-Keys.txt',
    'link-audit-seals/producao/trust-keys.txt.bak',
    'link-audit-seals/README.md',
    'link-audit-seals',
  ];
  for (const repoPath of unexpected) {
    assert.deepEqual(classifyChannelPath(repoPath), { kind: 'unexpected' }, repoPath);
    const report = await check(w, [['A', repoPath]]);
    assert.deepEqual(report.refusals.map((item) => [item.code, item.path]), [['SEALS_UNEXPECTED_PATH', null]], repoPath);
  }
  assert.deepEqual(classifyChannelPath(`link-audit-seals/producao/seals/${AUD_A}/seal-0256.json`), { kind: 'seal', env: 'producao', auditId: AUD_A, seq: 256 });
  assert.deepEqual(classifyChannelPath('link-audit-seals/homologacao/seals/_closures/ensaio-chave-01.json'), { kind: 'closure', env: 'homologacao', keyId: 'ensaio-chave-01' });
  assert.equal(classifyChannelPath('src/link-audit-seals/x'), null, 'fora do canal');
  const nonUtf8 = parseNameStatus(Buffer.concat([Buffer.from('A\0link-audit-seals/producao/', 'utf8'), Buffer.from([0xff, 0xfe]), Buffer.from('\0', 'utf8')]));
  assert.ok(nonUtf8.ok);
  assert.deepEqual(classifyChannelPath(nonUtf8.entries[0]?.path ?? ''), { kind: 'unexpected' }, 'caminho que não é UTF-8 nunca casa a gramática');
});

/* ------------------------------------------------------------------------------------------------------------------- P9-S03 */

test('P9-S03 link simbólico, executável ou submódulo ⇒ SEALS_BAD_MODE (modo no git e lstat no checkout), e o arquivo nunca é lido', async () => {
  const { w, chain } = baseWorld();
  const added = addNext(w, chain, { signer: KEY_A });
  for (const mode of ['100755', '120000', '160000']) assert.deepEqual(codes(await check(w, [['A', added]], { modeOverrides: { [added]: mode } })), ['SEALS_BAD_MODE'], mode);
  // o git diz 100644, mas o checkout tem um link simbólico no lugar
  const target = path.join(w.root, 'alvo.json');
  fs.renameSync(path.join(w.root, ...added.split('/')), target);
  fs.symlinkSync(target, path.join(w.root, ...added.split('/')));
  const reads: string[] = [];
  const spy: BytesFsOps = { ...nodeFsOps, readFileBytes: (file, max) => (reads.push(file), nodeFsOps.readFileBytes(file, max)) };
  assert.deepEqual(codes(await check(w, [['A', added]], { modeOverrides: { [added]: '100644' }, fs: spy })), ['SEALS_BAD_MODE']);
  assert.ok(!reads.some((file) => file.endsWith('seal-0002.json')), 'o link nunca é lido');
  // submódulo: no checkout, uma pasta vazia
  const sub = world();
  const subPath = sealRepoPath(AUD_B, 1);
  fs.mkdirSync(path.join(sub.root, ...subPath.split('/')), { recursive: true });
  assert.deepEqual(codes(await check(sub, [['A', subPath]], { modeOverrides: { [subPath]: '160000' } })), ['SEALS_BAD_MODE']);
  assert.deepEqual(codes(await check(sub, [['A', sealRepoPath(AUD_C, 1)]])), ['SEALS_BAD_MODE'], 'ausente dos modos ⇒ falha fechada');
});

/* ------------------------------------------------------------------------------------------------------------------- P9-S04 */

test('P9-S04 arquivo acima de 256 KiB é recusado SEM ser lido; mais de 200 arquivos novos ou mais de 16 MiB ⇒ SEALS_TOO_MANY sem ler nada', async () => {
  const w = world();
  const big = sealRepoPath(AUD_A, 1);
  writeRepoFile(w.root, big, Buffer.alloc(MAX_SEAL_BYTES + 1, 0x20));
  const reads: string[] = [];
  const spy: BytesFsOps = { ...nodeFsOps, readFileBytes: (file, max) => (reads.push(file), nodeFsOps.readFileBytes(file, max)), readFile: (file, max) => (reads.push(file), nodeFsOps.readFile(file, max)) };
  const report = await check(w, [['A', big]], { fs: spy });
  assert.deepEqual(report.refusals.map((item) => [item.rule, item.code, item.path]), [['S-05', 'SEALS_TOO_LARGE', `producao/seals/${AUD_A}/seal-0001.json`]]);
  assert.ok(!reads.some((file) => file.endsWith('seal-0001.json')), 'nunca lido');
  assert.equal(report.manifests[0]?.bytesSha256, null, 'sem hash de bytes não lidos');

  const many = world();
  const changes = Array.from({ length: 201 }, (_, index) => ['A', sealRepoPath(`aud-${String(index).padStart(16, '0')}`, 1)] as const);
  const touched: string[] = [];
  const counting: BytesFsOps = { ...nodeFsOps, lstat: (file) => (touched.push(file), nodeFsOps.lstat(file)) };
  assert.deepEqual(codes(await check(many, changes, { fs: counting })), ['SEALS_TOO_MANY']);
  assert.deepEqual(touched, [], 'nenhum disco tocado acima do teto de quantidade');

  const heavy = world();
  const heavyChanges = Array.from({ length: 65 }, (_, index) => {
    const repoPath = sealRepoPath(`aud-${String(index).padStart(16, '0')}`, 1);
    writeRepoFile(heavy.root, repoPath, Buffer.alloc(MAX_SEAL_BYTES, 0x20));
    return ['A', repoPath] as const;
  });
  const heavyReads: string[] = [];
  const heavySpy: BytesFsOps = { ...nodeFsOps, readFileBytes: (file, max) => (heavyReads.push(file), nodeFsOps.readFileBytes(file, max)) };
  assert.deepEqual(codes(await check(heavy, heavyChanges, { fs: heavySpy })), ['SEALS_TOO_MANY'], '65 × 256 KiB > 16 MiB');
  assert.equal(heavyReads.filter((file) => file.includes(`${path.sep}seals${path.sep}`)).length, 0, 'nada lido acima do teto de bytes');
});

/* ------------------------------------------------------------------------------------------------------------------- P9-S05 */

test('P9-S05 manifesto v1, com BOM, com `\\`, com chave repetida ou com campo extra ⇒ SEAL_FORMAT', async () => {
  const { w, chain } = baseWorld();
  const next = nextSeal(AUD_A, chain, { signer: KEY_A });
  const text = canonicalText(next);
  const target = sealRepoPath(AUD_A, 2);
  const v1 = createEvidenceSeal({ auditId: AUD_A, seq: 2, sealedAt: next.sealedAt, keyId: KEY_A.keyId, privateKey: KEY_A.privateKey, entries: E1 });
  const variants: ReadonlyArray<readonly [string, string | Buffer]> = [
    ['v1', canonicalText(v1)],
    ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])],
    ['barra invertida', text.replace('"dossie-canal-0001"', '"dossie-canal-000\\u0031"')],
    ['chave repetida', text.replace('{"schemaVersion":2,', '{"schemaVersion":2,"schemaVersion":2,')],
    ['campo extra', text.replace(/}\n$/, ',"extra":1}\n')],
    ['não é JSON', 'isto não é um manifesto\n'],
  ];
  for (const [label, content] of variants) {
    writeRepoFile(w.root, target, content);
    const report = await check(w, [['A', target]]);
    assert.deepEqual(report.refusals.map((item) => [item.rule, item.code]), [['S-06', 'SEAL_FORMAT']], label);
  }
});

/* ------------------------------------------------------------------------------------------------------------------- P9-S06 */

test('P9-S06 manifesto válido com espaços, outra ordem de chaves, CRLF ou sem `\\n` final ⇒ SEAL_NOT_CANONICAL (e o fecho também)', async () => {
  const { w, chain } = baseWorld();
  const next = nextSeal(AUD_A, chain, { signer: KEY_A });
  const target = sealRepoPath(AUD_A, 2);
  const { signature, ...body } = next;
  const reordered = { signature, ...Object.fromEntries(Object.entries(body).reverse()) };
  const variants: ReadonlyArray<readonly [string, string]> = [
    ['espaços', `${JSON.stringify(next, null, 2)}\n`],
    ['outra ordem de chaves', `${JSON.stringify(reordered)}\n`],
    ['CRLF', `${JSON.stringify(next, null, 2).replace(/\n/g, '\r\n')}\r\n`],
    ['CRLF no fim', `${JSON.stringify(next)}\r\n`],
    ['sem \\n final', JSON.stringify(next)],
    ['dois \\n', `${JSON.stringify(next)}\n\n`],
  ];
  for (const [label, content] of variants) {
    writeRepoFile(w.root, target, content);
    assert.deepEqual((await check(w, [['A', target]])).refusals.map((item) => [item.rule, item.code]), [['S-07', 'SEAL_NOT_CANONICAL']], label);
  }
  writeRepoFile(w.root, target, canonicalText(next));
  assert.deepEqual(codes(await check(w, [['A', target]])), [], 'a forma canônica passa');
  const closure = closureFor(KEY_A, KEY_B, chain);
  writeRepoFile(w.root, closureRepoPath(KEY_A.keyId), `${JSON.stringify(closure, null, 1)}\n`);
  assert.deepEqual(codes(await check(w, [['A', closureRepoPath(KEY_A.keyId)]])), ['SEAL_NOT_CANONICAL'], 'fecho fora da forma canônica');
});

/* ------------------------------------------------------------------------------------------------------------------- P9-S07 */

test('P9-S07 `auditId`/`seq` do corpo diferente do caminho ⇒ SEAL_NAME_MISMATCH', async () => {
  const { w, chain } = baseWorld();
  const otherAudit = nextSeal(AUD_A, chain, { signer: KEY_A, auditId: AUD_B });
  writeRepoFile(w.root, sealRepoPath(AUD_A, 2), canonicalText(otherAudit));
  assert.deepEqual((await check(w, [['A', sealRepoPath(AUD_A, 2)]])).refusals.map((item) => [item.rule, item.code]), [['S-08', 'SEAL_NAME_MISMATCH']], 'auditId');
  const otherSeq = nextSeal(AUD_A, chain, { signer: KEY_A, seq: 3 });
  writeRepoFile(w.root, sealRepoPath(AUD_A, 2), canonicalText(otherSeq));
  assert.deepEqual((await check(w, [['A', sealRepoPath(AUD_A, 2)]])).refusals.map((item) => [item.rule, item.code]), [['S-08', 'SEAL_NAME_MISMATCH']], 'seq');
});

/* ------------------------------------------------------------------------------------------------------------------- P9-S08 */

test('P9-S08 cadeia com buraco, `prevSealSha256` errado, não cumulativa, chave fora da lista, revogada ou aposentada sem fecho ⇒ SEAL_V2_<RAZÃO>', async () => {
  const scenario = async (label: string, build: (w: World) => readonly string[], expected: readonly string[]): Promise<void> => {
    const w = world();
    writeTrustList(w, [listItem(KEY_A), listItem(KEY_R, 'revoked'), listItem(KEY_T, 'retired')]);
    const added = build(w);
    assert.deepEqual(codes(await check(w, added.map((repoPath) => ['A', repoPath] as const))), expected, label);
  };
  const write = (w: World, seal: ReturnType<typeof nextSeal>): string => writeRepoFile(w.root, sealRepoPath(seal.auditId, seal.seq), canonicalText(seal)) && sealRepoPath(seal.auditId, seal.seq);
  await scenario('buraco no commit-base (1, 3) + 4', (w) => {
    const chain = chainInRepo(w, AUD_A, [KEY_A]);
    const phantom = nextSeal(AUD_A, chain, { signer: KEY_A });
    const third = nextSeal(AUD_A, [...chain, phantom], { signer: KEY_A });
    write(w, third);
    return [write(w, nextSeal(AUD_A, [...chain, phantom, third], { signer: KEY_A }))];
  }, ['SEAL_V2_SEAL_CHAIN_BROKEN']);
  await scenario('buraco nos novos (1 + 3)', (w) => {
    const chain = chainInRepo(w, AUD_A, [KEY_A]);
    const phantom = nextSeal(AUD_A, chain, { signer: KEY_A });
    return [write(w, nextSeal(AUD_A, [...chain, phantom], { signer: KEY_A }))];
  }, ['SEALS_NOT_AT_END', 'SEAL_V2_SEAL_CHAIN_BROKEN']);
  await scenario('prevSealSha256 errado', (w) => [write(w, nextSeal(AUD_A, chainInRepo(w, AUD_A, [KEY_A]), { signer: KEY_A, prev: 'e'.repeat(64) }))], ['SEAL_V2_SEAL_CHAIN_BROKEN']);
  await scenario('não cumulativa', (w) => {
    const first = nextSeal(AUD_A, [], { signer: KEY_A, entries: E2 });
    write(w, first);
    return [write(w, nextSeal(AUD_A, [first], { signer: KEY_A, entries: E1 }))];
  }, ['SEAL_V2_SEAL_NOT_CUMULATIVE']);
  await scenario('chave fora da lista', (w) => [write(w, nextSeal(AUD_A, chainInRepo(w, AUD_A, [KEY_A]), { signer: KEY_X }))], ['SEAL_V2_SEAL_INVALID']);
  await scenario('chave revogada', (w) => [write(w, nextSeal(AUD_A, chainInRepo(w, AUD_A, [KEY_A]), { signer: KEY_R }))], ['SEAL_V2_SEAL_KEY_REVOKED']);
  await scenario('aposentada sem fecho', (w) => [write(w, nextSeal(AUD_A, chainInRepo(w, AUD_A, [KEY_A]), { signer: KEY_T }))], ['SEAL_V2_SEAL_KEY_RETIRED_UNCOVERED']);
  await scenario('primeiro manifesto com a lista vazia', (w) => {
    writeTrustList(w, []);
    return [write(w, nextSeal(AUD_A, [], { signer: KEY_A }))];
  }, ['SEAL_V2_PROOF_NOT_CONFIGURED']);
});

test('P9-S08 cadeia correta ⇒ verde, com `headSeq` = último `seq` novo (dois novos de uma vez); uma cabeça que não é o último novo ⇒ SEAL_HEAD_MISMATCH', async () => {
  const { w, chain } = baseWorld();
  const second = addNext(w, chain, { signer: KEY_A, entries: E2 });
  const third = addNext(w, chain, { signer: KEY_B, entries: E2 });
  const report = await check(w, [['A', third], ['A', second]]);
  assert.deepEqual(report.refusals, []);
  assert.deepEqual(report.manifests.map((line) => [line.relativePath, line.seq, line.sealSha256]), [
    [`${AUD_A}/seal-0003.json`, 3, sealSha256(chain[2] as (typeof chain)[number])],
    [`${AUD_A}/seal-0002.json`, 2, sealSha256(chain[1] as (typeof chain)[number])],
  ]);
  const trustValue = `${listItem(KEY_A)},${listItem(KEY_B)}`;
  assert.equal(await chainRefusalCode({ sealsDir: w.sealsDir(), auditId: AUD_A, trustValue, lastNew: chain[2] as (typeof chain)[number] }, nodeFsOps), null, 'a cabeça autenticada é o último novo');
  assert.equal(await chainRefusalCode({ sealsDir: w.sealsDir(), auditId: AUD_A, trustValue, lastNew: chain[1] as (typeof chain)[number] }, nodeFsOps), 'SEAL_HEAD_MISMATCH');
  // mesmo `seq` da cabeça (3), outro `sealSha256`: só a comparação do digest recusa
  const sameSeq = nextSeal(AUD_A, chain.slice(0, 2), { signer: KEY_A, entries: [...E2, { ref: 'capture:c0003', contentSha256: '7'.repeat(64) }] });
  assert.equal(sameSeq.seq, 3);
  assert.notEqual(sealSha256(sameSeq), sealSha256(chain[2] as (typeof chain)[number]));
  assert.equal(await chainRefusalCode({ sealsDir: w.sealsDir(), auditId: AUD_A, trustValue, lastNew: sameSeq }, nodeFsOps), 'SEAL_HEAD_MISMATCH', 'mesmo seq, outro sealSha256');
});

/* ------------------------------------------------------------------------------------------------------------------- P9-S09 */

test('P9-S09 fecho novo com signatário fora da lista, assinatura inválida, `retiredKeyId` fora da lista ou cabeça ausente da cadeia do repositório ⇒ CLOSURE_<MOTIVO>; nome ≠ `retiredKeyId` ⇒ SEAL_NAME_MISMATCH (S-08); fecho válido passa', async () => {
  const { w, chain } = baseWorld();
  const target = closureRepoPath(KEY_A.keyId);
  const judge = async (text: string, repoPath = target): Promise<string[]> => {
    writeRepoFile(w.root, repoPath, text);
    const result = codes(await check(w, [['A', repoPath]]));
    fs.rmSync(path.join(w.root, ...repoPath.split('/')));
    return result;
  };
  assert.deepEqual(await judge(canonicalText(closureFor(KEY_A, KEY_B, chain))), [], 'fecho válido (A aposentada, B assina, cabeça na cadeia)');
  assert.deepEqual(await judge(canonicalText(closureFor(KEY_A, KEY_X, chain))), ['CLOSURE_SIGNER_NOT_LISTED']);
  const forged = closureFor(KEY_A, { ...KEY_X, keyId: KEY_B.keyId, publicRaw: KEY_B.publicRaw }, chain); // diz B, assinado por X
  assert.deepEqual(await judge(canonicalText(forged)), ['CLOSURE_SIGNATURE_INVALID']);
  assert.deepEqual(await judge(canonicalText(closureFor(KEY_X, KEY_B, chain)), closureRepoPath(KEY_X.keyId)), ['CLOSURE_RETIRED_NOT_LISTED']);
  const phantom = nextSeal(AUD_B, [], { signer: KEY_A });
  assert.deepEqual(await judge(canonicalText(closureFor(KEY_A, KEY_B, [chain[0] as (typeof chain)[number], phantom]))), ['CLOSURE_HEAD_NOT_IN_REPO'], 'cabeça de auditoria ausente');
  const otherHead = nextSeal(AUD_A, [], { signer: KEY_A, entries: E2 }); // mesma auditoria e seq, outro sealSha256
  assert.deepEqual(await judge(canonicalText(closureFor(KEY_A, KEY_B, [otherHead]))), ['CLOSURE_HEAD_NOT_IN_REPO'], 'cabeça com outro sealSha256');
  assert.deepEqual(await judge(canonicalText(closureFor(KEY_A, KEY_B, chain)), closureRepoPath(KEY_B.keyId)), ['SEAL_NAME_MISMATCH'], 'nome ≠ retiredKeyId');
  assert.deepEqual(await judge('{"schemaVersion":1}\n'), ['CLOSURE_FORMAT']);
});

/* ------------------------------------------------------------------------------------------------------------------- P9-S11 */

test('P9-S11 o resumo traz uma linha por arquivo novo, por tipo: manifesto com sha256sum, seq e sealSha256; fecho com sha256sum, retiredKeyId, signerKeyId e as cabeças `auditId:seq:<12 hex>`; nada além disso', async () => {
  const w = world();
  writeTrustList(w, [listItem(KEY_A), listItem(KEY_B)]);
  const chainA = chainInRepo(w, AUD_A, [KEY_A]);
  const chainB = chainInRepo(w, AUD_B, [KEY_A, KEY_A]);
  const newSeal = nextSeal(AUD_C, [], { signer: KEY_B });
  const sealText = canonicalText(newSeal);
  writeRepoFile(w.root, sealRepoPath(AUD_C, 1), sealText);
  const closure = closureFor(KEY_A, KEY_B, [chainA[0] as (typeof chainA)[number], chainB[1] as (typeof chainB)[number]]);
  const closureText = canonicalText(closure);
  writeRepoFile(w.root, closureRepoPath(KEY_A.keyId), closureText);
  const report = await check(w, [['A', sealRepoPath(AUD_C, 1)], ['A', closureRepoPath(KEY_A.keyId)]]);
  assert.deepEqual(report.refusals, []);
  const manifestLine = `| \`${AUD_C}/seal-0001.json\` | \`${sha256(sealText)}\` | \`1\` | \`${sealSha256(newSeal)}\` |`;
  assert.equal(manifestSummaryLine(report.manifests[0] as (typeof report.manifests)[number]), manifestLine);
  const heads = [chainA[0], chainB[1]].map((seal) => `\`${seal?.auditId}:${seal?.seq}:${sealSha256(seal as (typeof chainA)[number]).slice(0, 12)}\``).sort().join(', ');
  const closureLine = `| \`_closures/${KEY_A.keyId}.json\` | \`${sha256(closureText)}\` | \`${KEY_A.keyId}\` | \`${KEY_B.keyId}\` | ${heads} |`;
  assert.equal(closureSummaryLine(report.closures[0] as (typeof report.closures)[number]), closureLine);
  const out: string[] = [];
  const err: string[] = [];
  const dir = tmpDir('p92-cli-');
  fs.writeFileSync(path.join(dir, 'changes'), changesBytes([['A', sealRepoPath(AUD_C, 1)], ['A', closureRepoPath(KEY_A.keyId)]]));
  fs.writeFileSync(path.join(dir, 'modes'), modesBytes(w.root));
  fs.mkdirSync(path.join(dir, 'base', 'producao'), { recursive: true });
  fs.copyFileSync(path.join(w.root, 'link-audit-seals', 'producao', 'trust-keys.txt'), path.join(dir, 'base', 'producao', 'trust-keys.txt'));
  const exit = await runSealsCheckCli(['--changes', path.join(dir, 'changes'), '--modes', path.join(dir, 'modes'), '--base-trust', path.join(dir, 'base'), '--repo', w.root], (line) => out.push(line), (line) => err.push(line), { fs: nodeFsOps });
  assert.equal(exit, SEALS_CHECK_EXIT.OK);
  assert.deepEqual(err, []);
  const text = out.join('\n');
  assert.ok(text.includes(manifestLine) && text.includes(closureLine), 'as duas linhas no stdout (resumo do job)');
  assert.equal(out.filter((line) => line.startsWith(`| \`${AUD_C}/`)).length, 1, 'uma linha por manifesto novo');
  assert.equal(out.filter((line) => line.startsWith('| `_closures/')).length, 1, 'uma linha por fecho novo');
  for (const forbidden of [newSeal.signature, closure.signature, newSeal.sealedAt, closure.sealedAt, newSeal.dossier.sha256, 'a'.repeat(64), KEY_A.publicRaw, w.root, 'capture:c0001']) assert.ok(!text.includes(forbidden), `nenhum conteúdo de arquivo nem caminho de disco: ${forbidden.slice(0, 12)}`);
});

/* ------------------------------------------------------------------------------------------------------------------- P9-S12 */

test('P9-S12 cadeias não tocadas não são reverificadas: uma revogação na lista não deixa vermelho um PR que só mexe em outra auditoria', async () => {
  const w = world();
  writeTrustList(w, [listItem(KEY_R, 'revoked'), listItem(KEY_A)]);
  chainInRepo(w, AUD_A, [KEY_R]); // assinada pela chave hoje revogada (cadeia antiga)
  const chainB = chainInRepo(w, AUD_B, [KEY_A]);
  const touched: string[] = [];
  const spy: BytesFsOps = { ...nodeFsOps, readFile: (file, max) => (touched.push(file), nodeFsOps.readFile(file, max)), readFileBytes: (file, max) => (touched.push(file), nodeFsOps.readFileBytes(file, max)) };
  const seal = nextSeal(AUD_B, chainB, { signer: KEY_A });
  writeRepoFile(w.root, sealRepoPath(AUD_B, 2), canonicalText(seal));
  assert.deepEqual(codes(await check(w, [['A', sealRepoPath(AUD_B, 2)]], { fs: spy })), [], 'verde');
  assert.ok(!touched.some((file) => file.includes(AUD_A)), 'a cadeia revogada nem é lida');
  const onRevoked = nextSeal(AUD_A, [], { signer: KEY_A, seq: 2, prev: 'f'.repeat(64) });
  writeRepoFile(w.root, sealRepoPath(AUD_A, 2), canonicalText(onRevoked));
  assert.deepEqual(codes(await check(w, [['A', sealRepoPath(AUD_A, 2)]])), ['SEAL_V2_SEAL_KEY_REVOKED'], 'acrescentar à cadeia revogada recusa (S-10)');
});

/* ------------------------------------------------------------------------------------------------------------------- CLI */

test('CLI: uso fora da forma ⇒ 2 SEALS_USAGE; entrada ilegível ⇒ 2 SEALS_INPUT_INVALID; nada sob link-audit-seals/ ⇒ 0 e o resumo diz; recusa ⇒ 1 e `ERRO <CÓDIGO>` no stderr', async () => {
  const w = world();
  const dir = tmpDir('p92-cli-');
  const files = { changes: path.join(dir, 'changes'), modes: path.join(dir, 'modes'), base: path.join(dir, 'base') };
  const run = async (argv: readonly string[]): Promise<{ readonly exit: number; readonly out: string[]; readonly err: string[] }> => {
    const out: string[] = [];
    const err: string[] = [];
    const exit = await runSealsCheckCli(argv, (line) => out.push(line), (line) => err.push(line), { fs: nodeFsOps });
    return { exit, out, err };
  };
  const full = ['--changes', files.changes, '--modes', files.modes, '--base-trust', files.base, '--repo', w.root];
  for (const argv of [[], ['--changes', files.changes], [...full, '--extra', 'x'], [...full.slice(0, 6), '--changes', files.changes], ['--changes', '', ...full.slice(2)], ['--changes', '--modes', ...full.slice(2)]]) {
    const result = await run(argv);
    assert.equal(result.exit, SEALS_CHECK_EXIT.USAGE, argv.join(' '));
    assert.equal(result.err.at(-1), 'ERRO SEALS_USAGE');
  }
  assert.deepEqual((await run(full)).err, ['ERRO SEALS_INPUT_INVALID'], 'arquivos ausentes');
  fs.writeFileSync(files.changes, 'A\0src/app/page.tsx\0');
  fs.writeFileSync(files.modes, '');
  const outside = await run(full);
  assert.equal(outside.exit, SEALS_CHECK_EXIT.OK);
  assert.ok(outside.out.join('\n').includes('Nada mudou sob `link-audit-seals/`'));
  fs.writeFileSync(files.changes, 'A\0link-audit-seals/producao/seals/x.json'); // sem o NUL final
  assert.deepEqual((await run(full)).err, ['ERRO SEALS_INPUT_INVALID'], 'lista de mudanças truncada');
  fs.writeFileSync(files.changes, changesBytes([['D', sealRepoPath(AUD_A, 1)]]));
  const refused = await run(full);
  assert.equal(refused.exit, SEALS_CHECK_EXIT.REFUSED);
  assert.deepEqual(refused.err, ['ERRO SEALS_NOT_APPEND_ONLY']);
  assert.ok(refused.out.includes('Resultado: `ERRO SEALS_NOT_APPEND_ONLY` (1 recusa(s); o código é o da primeira, na ordem das regras S-01 a S-13)'));
  fs.writeFileSync(files.modes, 'lixo\0');
  assert.deepEqual((await run(full)).err, ['ERRO SEALS_INPUT_INVALID'], 'modos fora da forma');
});

test('entradas do workflow: o parser lê `-z` exatamente (R/C com dois caminhos, status desconhecido recusado) e os modos de `ls-tree -r -z`', () => {
  const parsed = parseNameStatus(Buffer.from('A\0a\0R087\0b\0c\0M\0d\0', 'utf8'));
  assert.deepEqual(parsed, { ok: true, entries: [{ status: 'A', path: 'a' }, { status: 'R', path: 'b' }, { status: 'R', path: 'c' }, { status: 'M', path: 'd' }] });
  for (const raw of ['U\0a\0', 'A\0\0', 'R100\0b\0', 'A\0a', 'AA\0a\0']) assert.deepEqual(parseNameStatus(Buffer.from(raw, 'utf8')), { ok: false }, JSON.stringify(raw));
  assert.deepEqual(parseNameStatus(new Uint8Array(0)), { ok: true, entries: [] });
  const modes = parseTreeModes(Buffer.from(`100644 blob ${'a'.repeat(40)}\tx/y.json\u0000120000 blob ${'b'.repeat(40)}\tx/z.json\u0000`, 'utf8'));
  assert.deepEqual([...(modes ?? new Map())], [['x/y.json', '100644'], ['x/z.json', '120000']]);
  for (const raw of [`100644 blob ${'a'.repeat(40)}\tx\u0000100644 blob ${'a'.repeat(40)}\tx\u0000`, '100644 blob abc\tx\u0000', `10064 blob ${'a'.repeat(40)}\tx\u0000`]) assert.equal(parseTreeModes(Buffer.from(raw, 'utf8')), null, raw);
});

test('o resumo nunca ecoa um caminho fora da gramática nem um auditId fora do padrão nas cabeças', async () => {
  const w = world();
  const report = await check(w, [['A', 'link-audit-seals/producao/seals/padaria-exemplo-0001/seal-0001.json']]);
  const text = summaryLines(report).join('\n');
  assert.ok(text.includes('SEALS_UNEXPECTED_PATH') && !text.includes('padaria'), 'só o código');
  const line = closureSummaryLine({ env: 'producao', relativePath: '_closures/ek-canal-a.json', bytesSha256: null, retiredKeyId: 'ek-canal-a', signerKeyId: 'ek-canal-b', heads: [{ auditId: 'padaria-exemplo-0001', seq: 1, sealSha256: '9'.repeat(64) }] });
  assert.ok(line.includes('`<fora do padrão>:1:999999999999`') && !line.includes('padaria'));
});

/* ------------------------------------------------------------------------------------------------------------------- revisão do PR #68 */

const runCli = async (argv: readonly string[], fsPort: BytesFsOps = nodeFsOps): Promise<{ readonly exit: number; readonly out: string[]; readonly err: string[] }> => {
  const out: string[] = [];
  const err: string[] = [];
  const exit = await runSealsCheckCli(argv, (line) => out.push(line), (line) => err.push(line), { fs: fsPort });
  return { exit, out, err };
};

test('correção 4: lista válida alterada + um ARQUIVO comum em `<amb>/seals` ⇒ SEALS_UNEXPECTED_PATH (nunca SEALS_INTERNAL); a etapa informativa não lista o que não é diretório', async () => {
  const w = world();
  writeTrustList(w, [listItem(KEY_A)]);
  writeRepoFile(w.root, 'link-audit-seals/producao/seals', 'não é uma pasta\n');
  const added = await check(w, [['M', 'link-audit-seals/producao/trust-keys.txt'], ['A', 'link-audit-seals/producao/seals']], { baseTrust: { producao: { kind: 'absent' } } });
  assert.equal(added.incomplete, false);
  assert.deepEqual(added.refusals.map((item) => [item.rule, item.code, item.detail]), [['S-03', 'SEALS_UNEXPECTED_PATH', null], ['S-03', 'SEALS_UNEXPECTED_PATH', 'producao/seals']]);
  const cli = await runCli(cliArgs(w, [['M', 'link-audit-seals/producao/trust-keys.txt'], ['A', 'link-audit-seals/producao/seals']]));
  assert.equal(cli.exit, SEALS_CHECK_EXIT.REFUSED);
  assert.deepEqual(cli.err, ['ERRO SEALS_UNEXPECTED_PATH']);
  // o arquivo já estava lá (fora da mudança): a própria etapa informativa recusa, sem listar
  const onlyList = await check(w, [['M', 'link-audit-seals/producao/trust-keys.txt']], { baseTrust: { producao: { kind: 'absent' } } });
  assert.deepEqual(onlyList.refusals.map((item) => [item.code, item.detail]), [['SEALS_UNEXPECTED_PATH', 'producao/seals']]);
  assert.deepEqual(onlyList.chains, []);
});

test('correção 4: uma etapa que lança depois de recusas coletadas não as apaga (saída 1 com a primeira); sem recusa nenhuma, a falha é SEALS_INTERNAL (saída 3)', async () => {
  const { w, chain } = baseWorld();
  const added = addNext(w, chain, { signer: KEY_A });
  const broken: BytesFsOps = { ...nodeFsOps, readdir: async () => { throw errno('EIO'); } };
  const report = await check(w, [['D', sealRepoPath(AUD_A, 1)], ['A', added]], { fs: broken });
  assert.equal(report.incomplete, true, 'a etapa das cadeias falhou');
  assert.deepEqual(codes(report), ['SEALS_NOT_APPEND_ONLY'], 'a recusa do S-01 continua');
  const withRefusal = await runCli(cliArgs(w, [['D', sealRepoPath(AUD_A, 1)], ['A', added]]), broken);
  assert.equal(withRefusal.exit, SEALS_CHECK_EXIT.REFUSED);
  assert.deepEqual(withRefusal.err, ['ERRO SEALS_NOT_APPEND_ONLY']);
  assert.ok(withRefusal.out.some((line) => line.startsWith('Verificação INCOMPLETA')));
  const alone = await runCli(cliArgs(w, [['A', added]]), broken);
  assert.equal(alone.exit, SEALS_CHECK_EXIT.UNEXPECTED);
  assert.deepEqual(alone.err, ['ERRO SEALS_INTERNAL'], 'falha fechada');
});

test('correção 5: teto ÚNICO de leitura da execução (arquivos novos + releitura da cadeia + cabeças + listas) ⇒ SEALS_TOO_MANY `READ_BUDGET`; o teto informativo só trunca', async () => {
  const { w, chain } = baseWorld();
  addNext(w, chain, { signer: KEY_A });
  addNext(w, chain, { signer: KEY_A });
  const added = addNext(w, chain, { signer: KEY_A });
  const newBytes = fs.statSync(path.join(w.root, ...added.split('/'))).size;
  const listBytes = fs.statSync(path.join(w.root, 'link-audit-seals', 'producao', 'trust-keys.txt')).size;
  assert.deepEqual(codes(await check(w, [['A', added]])), [], 'com o teto padrão passa');
  // cabe o arquivo novo e as listas, não cabe a releitura da cadeia inteira pelo verificador (S-10)
  const tight = await check(w, [['A', added]], { readBudgetBytes: newBytes + listBytes + 16 });
  assert.deepEqual(tight.refusals[0], { rule: 'S-05', code: 'SEALS_TOO_MANY', path: null, detail: 'READ_BUDGET' }, 'a primeira recusa é a do teto');
  // lista alterada com teto informativo pequeno: a informação das cadeias trunca, nada é recusado
  const info = world();
  writeTrustList(info, [listItem(KEY_A), listItem(KEY_B)]);
  chainInRepo(info, AUD_A, [KEY_A, KEY_A]);
  chainInRepo(info, AUD_B, [KEY_A]);
  const listOnly = await check(info, [['M', 'link-audit-seals/producao/trust-keys.txt']], { baseTrust: { producao: { kind: 'bytes', bytes: Buffer.from(listFile([listItem(KEY_A)])) } }, readBudgetBytes: 4 * listBytes + newBytes });
  assert.deepEqual(listOnly.refusals, []);
  assert.equal(listOnly.chainsTruncated, true);
  assert.ok(summaryLines(listOnly).some((line) => line.startsWith('Informação das cadeias TRUNCADA')));
  const full = await check(info, [['M', 'link-audit-seals/producao/trust-keys.txt']], { baseTrust: { producao: { kind: 'bytes', bytes: Buffer.from(listFile([listItem(KEY_A)])) } } });
  assert.deepEqual(full.chains.map((item) => [item.auditId, item.verdict, item.headSeq]), [[AUD_A, 'AUTHENTICATED', 2], [AUD_B, 'AUTHENTICATED', 1]]);
  assert.equal(full.chainsTruncated, false);
});
