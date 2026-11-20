import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/lib/link-audit/canonical';
import { nodeFsOps, type BytesFsOps } from '../src/lib/link-audit/snapshot-store';
import { MAX_SERVER_ENTRIES, runCloseKey, type CloseKeyResult } from '../src/lib/link-audit-attestation/sign-closure';
import { collectUpTo, MAX_RECEIPT_BYTES, MAX_RECEIPT_FILES, nodeCloseFsOps, readReceipts, type CloseFsOps } from '../src/lib/link-audit-attestation/sign-receipts';
import {
  createEvidenceSealV2,
  createSealedEvidenceProvenance,
  MAX_CLOSURE_HEADS,
  parseKeyRetirementClosureText,
  parseTrustKeyring,
  sealSha256,
  type EvidenceSealFileV2,
  type TrustKeyring,
} from '../src/lib/link-audit-evidence/provenance';
import { errno, registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import {
  chainOn,
  CHAIN_BASE,
  CLOSE_NOW,
  closeDeps,
  closeWorld,
  closurePath,
  deliverSeal,
  E1,
  E2,
  filesUnder,
  goldenSigner,
  item,
  receiptFor,
  signer,
  writeReceipt,
  writeReceipts,
  type CloseWorld,
} from './helpers/link-audit-seal-close-key-fixtures';
import { GOLDEN } from './helpers/link-audit-seal-v2-golden';

/*
 * P1 W4.5 (B) — o comando de FECHO `close-key` (spec §5.5.1 item 9; contrato do verificador v2 §6 "Procedimento", V2-46 e N2). As `heads` vêm SÓ do
 * registro EXTERNO (a pasta de recibos do passo 16), nunca da pasta do servidor; cadeia com posição de R no servidor sem recibo correspondente ⇒
 * `UNKNOWN_SEAL_ON_SERVER`, EXCLUÍDA; a cabeça de cada auditoria é o maior `seq` de R no registro, presente e idêntico na cópia do servidor. O
 * fecho é assinado pela chave ATIVA S ≠ R e autotestado com R `retired:<sha256 do fecho>` antes de ser gravado em `_closures/<R>.json` com criação
 * exclusiva. Núcleo com o disco real e as portas (confirmação e chave) injetadas; o CLI está em `link-audit-seal-close-key-cli.test.ts`.
 * Dados 100% FICTÍCIOS; chaves de TESTE geradas em memória ou as sementes dos vetores-ouro.
 */
registerCleanup();

const X = 'auditoria-fecho-x1';
const Y = 'auditoria-fecho-y1';
const Z = 'auditoria-fecho-z1';
const WRITE_OPS: ReadonlySet<string> = new Set(['mkdir', 'writeExclusive', 'link', 'unlink', 'chmod', 'syncDirectory']);
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const evidencesOf = (seal: EvidenceSealFileV2) => seal.entries.map(({ ref, contentSha256 }) => ({ ref, contentSha256, legacy: false }));
const at = (seal: EvidenceSealFileV2 | undefined): EvidenceSealFileV2 => seal ?? assert.fail('manifesto ausente na fixture');

type Done = Extract<CloseKeyResult, { readonly ok: true }>;
function closed(result: CloseKeyResult): Done {
  if (!result.ok) assert.fail(`esperava fecho gravado, veio ${result.code} (${result.chainReason ?? '-'}): ${result.message}`);
  return result;
}
function refused(world: CloseWorld, result: CloseKeyResult, code: string, label = code): Extract<CloseKeyResult, { readonly ok: false }> {
  assert.equal(result.ok ? 'GRAVOU' : result.code, code, label);
  if (result.ok) assert.fail(label);
  for (const fragment of [world.sealsDir, world.receiptsDir, os.tmpdir() + path.sep]) assert.ok(!result.message.includes(fragment), `${label}: mensagem sem caminho de disco`);
  assert.ok(!fs.existsSync(closurePath(world.sealsDir, world.retired.keyId)) || code === 'CLOSE_ALREADY_EXISTS', `${label}: nenhum fecho gravado`);
  return result;
}
/** O verificador v2 real (modo produção) sobre a cópia do servidor, com a lista indicada. */
const verdictOf = (sealsDir: string, trustKeys: string, seal: EvidenceSealFileV2) =>
  createSealedEvidenceProvenance({ sealsDir, keyring: parseTrustKeyring(trustKeys) as TrustKeyring, acceptedVersions: [2] }).classify(seal.auditId, evidencesOf(seal));

/** Espião do disco: registra cada chamada (nome e alvo) e delega ao real (ou ao substituto). */
function spyFs(over: Partial<BytesFsOps> = {}): { readonly fs: BytesFsOps; readonly calls: Array<{ readonly op: string; readonly target: string }> } {
  const calls: Array<{ readonly op: string; readonly target: string }> = [];
  const base = { ...nodeFsOps, ...over } as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const proxy = Object.fromEntries(Object.keys(nodeFsOps).map((name) => [name, (...args: unknown[]) => (calls.push({ op: name, target: String(args[0]) }), (base[name] as (...a: unknown[]) => Promise<unknown>)(...args))]));
  return { fs: proxy as unknown as BytesFsOps, calls };
}

/* =============================================================================================================== V2-46 e as cabeças */

test('V2-46 (N2): cadeia com posição de R no servidor e SEM recibo ⇒ UNKNOWN_SEAL_ON_SERVER e EXCLUÍDA das heads; a recibada entra com a cabeça do registro; o fecho gravado faz valer só ela', async () => {
  const world = closeWorld();
  const { retired: R, closer: S } = world;
  const x = chainOn(world.sealsDir, X, [R, R]);
  writeReceipts(world.receiptsDir, x);
  const y = chainOn(world.sealsDir, Y, [R]); // no servidor, ausente do registro externo
  const z = chainOn(world.sealsDir, Z, [S, S]);
  writeReceipts(world.receiptsDir, z);
  const deps = closeDeps(world);
  const done = closed(await runCloseKey(world.input(), deps));
  assert.deepEqual(done.heads, [{ auditId: X, seq: 2, sealSha256: sealSha256(at(x[1])) }]);
  assert.deepEqual(done.unknownSealsOnServer, [{ auditId: Y, seqs: [1] }]);
  assert.deepEqual(done.receiptedHeadsNotOnServer, []);
  assert.deepEqual(deps.order(), ['confirm', 'openKey']);
  const bytes = fs.readFileSync(closurePath(world.sealsDir, R.keyId));
  assert.equal(sha256(bytes), done.closureSha256, 'closureSha256 = SHA-256 dos BYTES gravados (o que a lista fixa, §6)');
  assert.equal(done.fileName, `_closures/${R.keyId}.json`);
  assert.equal(done.pinnedTrustKey, `${R.keyId}:${R.publicRaw}:retired:${done.closureSha256}`);
  const parsed = parseKeyRetirementClosureText(bytes);
  assert.ok(parsed.ok);
  assert.deepEqual([parsed.value.retiredKeyId, parsed.value.signerKeyId, parsed.value.sealedAt, parsed.value.heads], [R.keyId, S.keyId, CLOSE_NOW, done.heads]);
  const pinned = `${done.pinnedTrustKey},${item(S)}`;
  assert.deepEqual(await verdictOf(world.sealsDir, pinned, at(x[1])), { status: 'AUTHENTICATED', headSeq: 2, headSealSha256: sealSha256(at(x[1])), keyIds: [R.keyId, S.keyId].sort() });
  assert.deepEqual(await verdictOf(world.sealsDir, pinned, at(y[0])), { status: 'UNAUTHENTICATED', reason: 'SEAL_KEY_RETIRED_UNCOVERED' }, 'a cadeia desconhecida NÃO é coberta');
  assert.equal((await verdictOf(world.sealsDir, pinned, at(z[1]))).status, 'AUTHENTICATED', 'cadeias sem R não mudam');
  assert.deepEqual(await verdictOf(world.sealsDir, `${item(R, 'retired')},${item(S)}`, at(x[1])), { status: 'UNAUTHENTICATED', reason: 'SEAL_KEY_RETIRED_UNCOVERED' }, 'sem fixar o hash, R não conta');
});

test('§6: a cabeça é o MAIOR seq de R com recibo e manifesto presente e idêntico; posições posteriores de S seguem normais; heads estritamente ordenadas por auditId, uma por auditoria', async () => {
  const world = closeWorld();
  const { retired: R, closer: S } = world;
  const late = 'auditoria-fecho-c3';
  const early = 'auditoria-fecho-a1';
  const middle = 'auditoria-fecho-b2';
  const seals = new Map([
    [late, chainOn(world.sealsDir, late, [R, R, S, S], (seq) => (seq > 2 ? E2 : E1))],
    [early, chainOn(world.sealsDir, early, [R])],
    [middle, chainOn(world.sealsDir, middle, [S, R, R])],
  ]);
  for (const list of seals.values()) writeReceipts(world.receiptsDir, list);
  const done = closed(await runCloseKey(world.input(), closeDeps(world)));
  assert.deepEqual(done.heads, [
    { auditId: early, seq: 1, sealSha256: sealSha256(at(seals.get(early)?.[0])) },
    { auditId: middle, seq: 3, sealSha256: sealSha256(at(seals.get(middle)?.[2])) },
    { auditId: late, seq: 2, sealSha256: sealSha256(at(seals.get(late)?.[1])) },
  ]);
  const pinned = `${done.pinnedTrustKey},${item(S)}`;
  for (const list of seals.values()) assert.equal((await verdictOf(world.sealsDir, pinned, at(list.at(-1)))).status, 'AUTHENTICATED');
});

test('V2-46: posição de R sem recibo ACIMA ou ABAIXO da cabeça, ou com recibo de OUTRO conteúdo (sealSha256), põe a cadeia inteira em UNKNOWN_SEAL_ON_SERVER (nada dela é coberto); zero heads ainda grava um fecho válido', async () => {
  const world = closeWorld();
  const { retired: R } = world;
  const above = chainOn(world.sealsDir, X, [R, R, R]);
  writeReceipts(world.receiptsDir, above.slice(0, 2)); // R3 no servidor sem recibo
  const below = chainOn(world.sealsDir, Y, [R, R]);
  writeReceipts(world.receiptsDir, below.slice(1)); // R1 sem recibo
  const other = chainOn(world.sealsDir, Z, [R]);
  const resigned = createEvidenceSealV2({ ...at(other[0]), sealedAt: new Date(CHAIN_BASE + 60_000).toISOString(), privateKey: R.privateKey });
  writeReceipt(world.receiptsDir, 'z-seal-0001.json', receiptFor(resigned)); // o registro conhece OUTRO manifesto nesta posição
  const done = closed(await runCloseKey(world.input(), closeDeps(world)));
  assert.deepEqual(done.heads, []);
  assert.deepEqual(done.unknownSealsOnServer, [
    { auditId: X, seqs: [3] },
    { auditId: Y, seqs: [1] },
    { auditId: Z, seqs: [1] },
  ]);
  const parsed = parseKeyRetirementClosureText(fs.readFileSync(closurePath(world.sealsDir, R.keyId)));
  assert.ok(parsed.ok && parsed.value.heads.length === 0, 'fecho válido com zero heads');
});

test('§6 (retrocesso): cabeça do registro AUSENTE ou DIFERENTE na cópia do servidor ⇒ a auditoria fica fora (receiptedHeadsNotOnServer); nunca se fecha numa cabeça menor tirada da pasta', async () => {
  const world = closeWorld();
  const { retired: R, closer: S } = world;
  const scratch = tmpDir('lack-orig-');
  const full = chainOn(scratch, X, [R, R, R]);
  writeReceipts(world.receiptsDir, full);
  for (const seal of full.slice(0, 2)) deliverSeal(world.sealsDir, X, seal.seq, `${JSON.stringify(seal)}\n`); // o servidor perdeu o R3
  const gone = chainOn(scratch, Y, [R]);
  writeReceipts(world.receiptsDir, gone); // auditoria inteira ausente do servidor
  const swapped = chainOn(scratch, Z, [R, R]);
  writeReceipts(world.receiptsDir, swapped);
  deliverSeal(world.sealsDir, Z, 1, `${JSON.stringify(swapped[0])}\n`);
  const sByS = createEvidenceSealV2({ auditId: Z, seq: 2, sealedAt: at(swapped[1]).sealedAt, keyId: S.keyId, privateKey: S.privateKey, entries: E1, dossier: at(swapped[1]).dossier, prevSealSha256: sealSha256(at(swapped[0])) });
  deliverSeal(world.sealsDir, Z, 2, `${JSON.stringify(sByS)}\n`); // no servidor, a posição 2 é de S, não a R2 do registro
  const done = closed(await runCloseKey(world.input(), closeDeps(world)));
  assert.deepEqual(done.heads, []);
  assert.deepEqual(done.unknownSealsOnServer, []);
  assert.deepEqual(done.receiptedHeadsNotOnServer, [
    { auditId: X, seq: 3 },
    { auditId: Y, seq: 1 },
    { auditId: Z, seq: 2 },
  ]);
});

/* =============================================================================================================== recibos */

test('§5.5.1 item 9: recibos duplicados IDÊNTICOS (mesmo conteúdo, outra formatação) são tolerados; DIVERGENTES para a mesma posição ⇒ CLOSE_RECEIPTS_CONFLICT antes da confirmação e da chave, também em posição sem R', async () => {
  const world = closeWorld();
  const { retired: R, closer: S } = world;
  const x = chainOn(world.sealsDir, X, [R, R]);
  writeReceipts(world.receiptsDir, x);
  writeReceipt(world.receiptsDir, 'copia-identada.json', receiptFor(at(x[1])), 'pretty');
  assert.equal(closed(await runCloseKey(world.input(), closeDeps(world))).heads.length, 1);
  for (const [label, conflicting] of [
    ['mesma posição de R, outro manifesto', receiptFor(at(x[1]), { sealSha256: 'f'.repeat(64) })],
    ['mesma posição, outra chave', receiptFor(at(x[1]), { keyId: S.keyId })],
    ['mesma posição, outro campo qualquer', receiptFor(at(x[1]), { custodian: 'CUST-99' })],
  ] as const) {
    const again = closeWorld({ retired: R, closer: S });
    writeReceipts(again.receiptsDir, chainOn(again.sealsDir, X, [R, R]));
    writeReceipt(again.receiptsDir, 'divergente.json', { ...conflicting, auditId: X });
    const deps = closeDeps(again);
    const refusal = refused(again, await runCloseKey(again.input(), deps), 'CLOSE_RECEIPTS_CONFLICT', label);
    assert.match(refusal.message, new RegExp(`${X}.*seq 2|seq 2.*${X}`), `${label}: cita a posição (auditId e seq, públicos)`);
    assert.deepEqual(deps.order(), [], `${label}: nem confirmação nem chave`);
  }
  const onlyS = closeWorld({ retired: R, closer: S });
  const z = chainOn(onlyS.sealsDir, Z, [S]);
  writeReceipts(onlyS.receiptsDir, z);
  writeReceipt(onlyS.receiptsDir, 'z-divergente.json', receiptFor(at(z[0]), { entries: 9 }));
  refused(onlyS, await runCloseKey(onlyS.input(), closeDeps(onlyS)), 'CLOSE_RECEIPTS_CONFLICT', 'divergência em posição sem R também recusa (registro incoerente)');
});

test('§5.5.1 item 9: cada recibo passa por esquema zod ESTRITO e pelo texto estrito (UTF-8, sem BOM, sem barra invertida, sem chave repetida), com limite de tamanho ⇒ senão CLOSE_RECEIPTS_INVALID, nada lido depois, nada gravado', async () => {
  const R = signer('ek-fecho-r');
  const S = signer('ek-fecho-s');
  const base = (world: CloseWorld): Record<string, unknown> => receiptFor(at(chainOn(world.sealsDir, X, [R])[0]));
  const pad = (receipt: Record<string, unknown>, bytes: number): string => {
    const text = JSON.stringify(receipt);
    return `${text}${' '.repeat(Math.max(0, bytes - Buffer.byteLength(text)))}`;
  };
  const cases: ReadonlyArray<readonly [string, (receipt: Record<string, unknown>) => string | Buffer]> = [
    ['campo desconhecido', (r) => JSON.stringify({ ...r, extra: 1 })],
    ['campo ausente', (r) => JSON.stringify({ ...r, custodian: undefined })],
    ['ok false', (r) => JSON.stringify({ ...r, ok: false })],
    ['schemaVersion 1', (r) => JSON.stringify({ ...r, schemaVersion: 1 })],
    ['seq 0', (r) => JSON.stringify({ ...r, seq: 0 })],
    ['seq 257', (r) => JSON.stringify({ ...r, seq: 257, prevSealSha256: 'a'.repeat(64) })],
    ['seq texto', (r) => JSON.stringify({ ...r, seq: '1' })],
    ['keyId maiúsculo', (r) => JSON.stringify({ ...r, keyId: 'EK-FECHO-R' })],
    ['sealSha256 maiúsculo', (r) => JSON.stringify({ ...r, sealSha256: String(r.sealSha256).toUpperCase() })],
    ['auditId fora do padrão', (r) => JSON.stringify({ ...r, auditId: '../fora' })],
    ['prev nulo com seq 2', (r) => JSON.stringify({ ...r, seq: 2 })],
    ['prev preenchido com seq 1', (r) => JSON.stringify({ ...r, prevSealSha256: 'a'.repeat(64) })],
    ['entries 0', (r) => JSON.stringify({ ...r, entries: 0 })],
    ['custodiante com e-mail', (r) => JSON.stringify({ ...r, custodian: 'cust@exemplo.invalid' })],
    ['sealedAt sem milissegundos', (r) => JSON.stringify({ ...r, sealedAt: '2026-11-18T10:00:00Z' })],
    ['não é JSON', () => 'isto não é um recibo'],
    ['vazio', () => ''],
    ['lista em vez de objeto', (r) => JSON.stringify([r])],
    ['BOM', (r) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(r))])],
    ['UTF-8 inválido', (r) => Buffer.concat([Buffer.from(JSON.stringify(r).slice(0, -1)), Buffer.from([0xc3, 0x28]), Buffer.from('}')])],
    ['barra invertida', (r) => JSON.stringify({ ...r, custodian: 'CUST\\u0030' }).replace('\\\\u', '\\u')],
    ['chave repetida', (r) => JSON.stringify(r).replace('"ok":true', `"keyId":"${S.keyId}","ok":true`)],
    ['acima do limite', (r) => pad(r, MAX_RECEIPT_BYTES + 1)],
  ];
  for (const [label, render] of cases) {
    const world = closeWorld({ retired: R, closer: S });
    fs.writeFileSync(path.join(world.receiptsDir, 'recibo.json'), render(base(world)));
    const deps = closeDeps(world);
    refused(world, await runCloseKey(world.input(), deps), 'CLOSE_RECEIPTS_INVALID', label);
    assert.deepEqual(deps.order(), [], `${label}: nem confirmação nem chave`);
  }
  const atLimit = closeWorld({ retired: R, closer: S });
  fs.writeFileSync(path.join(atLimit.receiptsDir, 'recibo.json'), pad(base(atLimit), MAX_RECEIPT_BYTES));
  assert.equal(closed(await runCloseKey(atLimit.input(), closeDeps(atLimit))).heads.length, 1, `recibo com exatamente ${MAX_RECEIPT_BYTES} bytes é aceito`);
});

test('§5.5.1 item 9: a pasta de recibos só tem arquivos comuns *.json lidos SEM seguir link (link simbólico, diretório, FIFO, oculto ou outra extensão ⇒ CLOSE_RECEIPTS_INVALID; nada é ignorado em silêncio)', async () => {
  const R = signer('ek-fecho-r');
  const S = signer('ek-fecho-s');
  let hasMkfifo = true;
  try {
    execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
  } catch {
    hasMkfifo = false;
  }
  const cases: ReadonlyArray<readonly [string, (dir: string, valid: string) => void]> = [
    ['link simbólico para recibo válido', (dir, valid) => fs.symlinkSync(valid, path.join(dir, 'link.json'))],
    ['diretório com nome .json', (dir) => fs.mkdirSync(path.join(dir, 'pasta.json'))],
    ['arquivo oculto', (dir, valid) => fs.copyFileSync(valid, path.join(dir, '.oculto.json'))],
    ['outra extensão', (dir, valid) => fs.copyFileSync(valid, path.join(dir, 'recibo.txt'))],
    ['extensão em maiúsculas', (dir, valid) => fs.copyFileSync(valid, path.join(dir, 'recibo.JSON'))],
    ...(hasMkfifo ? [['FIFO com nome .json', (dir: string) => execFileSync('mkfifo', [path.join(dir, 'fila.json')])] as const] : []),
  ];
  for (const [label, plant] of cases) {
    const world = closeWorld({ retired: R, closer: S });
    const x = chainOn(world.sealsDir, X, [R]);
    const valid = writeReceipt(tmpDir('lack-fora-'), 'valido.json', receiptFor(at(x[0])));
    writeReceipts(world.receiptsDir, x);
    plant(world.receiptsDir, valid);
    refused(world, await runCloseKey(world.input(), closeDeps(world)), 'CLOSE_RECEIPTS_INVALID', label);
  }
});

test('§5.5.1 item 9: --receipts-dir inexistente, arquivo, link simbólico, VAZIA ou sobreposta à cópia do servidor (dentro dela ou contendo-a, pela identidade dev/ino do descritor) ⇒ CLOSE_RECEIPTS_INVALID; o registro externo nunca é a pasta do servidor', async () => {
  const R = signer('ek-fecho-r');
  const S = signer('ek-fecho-s');
  const OVERLAP = /não pode estar dentro da cópia do servidor/;
  const cases: ReadonlyArray<readonly [string, (world: CloseWorld) => { readonly receiptsDir: string; readonly sealsDir?: string }, RegExp?]> = [
    ['inexistente', (world) => ({ receiptsDir: path.join(world.receiptsDir, 'nao-existe') })],
    ['arquivo', (world) => ({ receiptsDir: writeReceipt(world.receiptsDir, 'um.json', {}) })],
    ['link simbólico', (world) => {
      const link = path.join(tmpDir('lack-ln-'), 'recibos');
      fs.symlinkSync(world.receiptsDir, link);
      return { receiptsDir: link };
    }],
    ['vazia', () => ({ receiptsDir: tmpDir('lack-vazia-') })],
    ['dentro da cópia do servidor', (world) => {
      const inside = path.join(world.sealsDir, 'recibos');
      fs.mkdirSync(inside);
      for (const name of fs.readdirSync(world.receiptsDir)) fs.copyFileSync(path.join(world.receiptsDir, name), path.join(inside, name));
      return { receiptsDir: inside };
    }, OVERLAP],
    ['contendo a cópia do servidor', (world) => {
      const parent = tmpDir('lack-pai-');
      fs.cpSync(world.sealsDir, path.join(parent, 'copia'), { recursive: true });
      for (const name of fs.readdirSync(world.receiptsDir)) fs.copyFileSync(path.join(world.receiptsDir, name), path.join(parent, name));
      return { receiptsDir: parent, sealsDir: path.join(parent, 'copia') };
    }, OVERLAP],
    ['a mesma pasta por outro caminho (link no caminho da cópia)', (world) => {
      const link = path.join(tmpDir('lack-ln2-'), 'copia');
      fs.symlinkSync(world.receiptsDir, link);
      return { receiptsDir: world.receiptsDir, sealsDir: link };
    }, OVERLAP],
  ];
  for (const [label, setup, message] of cases) {
    const world = closeWorld({ retired: R, closer: S });
    writeReceipts(world.receiptsDir, chainOn(world.sealsDir, X, [R]));
    const over = setup(world);
    const refusal = refused(world, await runCloseKey(world.input(over), closeDeps(world)), 'CLOSE_RECEIPTS_INVALID', label);
    if (message) assert.match(refusal.message, message, label);
  }
});

test('revisão da W4.5 (TOCTOU, MAJOR): a pasta de recibos é aberta UMA vez (O_DIRECTORY|O_NOFOLLOW) e enumerada e lida SÓ pelo descritor: trocá-la por um link para recibos forjados depois de aberta não muda o que é lido', async () => {
  const world = closeWorld();
  const { retired: R } = world;
  const x = chainOn(world.sealsDir, X, [R, R]);
  writeReceipts(world.receiptsDir, x);
  const forged = chainOn(world.sealsDir, Y, [R]); // no servidor sem recibo: só um recibo FORJADO a faria cabeça
  const evil = tmpDir('lack-forjados-');
  writeReceipts(evil, [...x, ...forged]);
  const moved = `${world.receiptsDir}-movida`;
  let swaps = 0;
  const swapping: CloseFsOps = {
    ...nodeCloseFsOps,
    async openDir(target) {
      const opened = await nodeCloseFsOps.openDir(target);
      fs.renameSync(world.receiptsDir, moved); // entre abrir e enumerar/ler: a pasta some e um link aponta para os forjados
      fs.symlinkSync(evil, world.receiptsDir);
      swaps += 1;
      return opened;
    },
  };
  let result: CloseKeyResult;
  try {
    result = await runCloseKey(world.input(), closeDeps(world, { closeFs: swapping }));
  } finally {
    fs.rmSync(moved, { recursive: true, force: true });
  }
  const done = closed(result);
  assert.equal(swaps, 1);
  assert.deepEqual(done.heads, [{ auditId: X, seq: 2, sealSha256: sealSha256(at(x[1])) }], 'só os recibos da pasta ABERTA');
  assert.deepEqual(done.unknownSealsOnServer, [{ auditId: Y, seqs: [1] }], 'o recibo forjado nunca foi lido: Y continua desconhecida');
});

test('revisão da W4.5 (TOCTOU): a pasta e os recibos só são consultados pelo descritor; por caminho, só os METADADOS das pastas ACIMA (e da cópia do servidor e das dela), nunca a própria pasta nem um recibo', async () => {
  const world = closeWorld();
  writeReceipts(world.receiptsDir, chainOn(world.sealsDir, X, [world.retired]));
  const calls: Array<{ readonly op: string; readonly target: string }> = [];
  const spied: CloseFsOps = {
    lstat: (target) => (calls.push({ op: 'lstat', target }), nodeCloseFsOps.lstat(target)),
    listDir: (target, limit) => (calls.push({ op: 'listDir', target }), nodeCloseFsOps.listDir(target, limit)),
    openDir: (target) => (calls.push({ op: 'openDir', target }), nodeCloseFsOps.openDir(target)),
  };
  closed(await runCloseKey(world.input(), closeDeps(world, { closeFs: spied })));
  const receipts = fs.realpathSync(world.receiptsDir);
  const seals = fs.realpathSync(world.sealsDir);
  assert.deepEqual(calls.filter((call) => call.op === 'openDir').map((call) => call.target), [path.resolve(world.receiptsDir)], 'aberta uma vez');
  const ancestors = (dir: string): string[] => (dir === path.dirname(dir) ? [dir] : [dir, ...ancestors(path.dirname(dir))]);
  const allowed = new Set([...ancestors(path.dirname(receipts)), ...ancestors(seals)]);
  for (const call of calls.filter((entry) => entry.op === 'lstat')) assert.ok(allowed.has(call.target), `lstat(${call.target}) fora das pastas acima e da cópia do servidor`);
  assert.ok(!calls.some((call) => call.target.startsWith(receipts + path.sep) || (call.op !== 'openDir' && call.target === receipts)), 'nada da pasta de recibos por caminho');
});

test('revisão da W4.5 (TOCTOU): pasta de recibos gravável por grupo ou outros, ou com pasta ACIMA gravável por outros sem sticky bit ⇒ CLOSE_RECEIPTS_INVALID; acima com sticky bit (como /tmp) passa; recibo gravável por grupo ou outros ⇒ recusado', async () => {
  const R = signer('ek-fecho-r');
  const S = signer('ek-fecho-s');
  const setups: ReadonlyArray<readonly [string, (world: CloseWorld) => string, boolean]> = [
    ['pasta 0775', (world) => (fs.chmodSync(world.receiptsDir, 0o775), world.receiptsDir), false],
    ['pasta 0757', (world) => (fs.chmodSync(world.receiptsDir, 0o757), world.receiptsDir), false],
    ['pasta 0755', (world) => (fs.chmodSync(world.receiptsDir, 0o755), world.receiptsDir), true],
    ['acima 0777 sem sticky', (world) => nested(world, 0o777), false],
    ['acima 0770', (world) => nested(world, 0o770), false],
    ['acima 1777 (sticky, como /tmp)', (world) => nested(world, 0o1777), true],
    ['recibo 0664', (world) => (fs.readdirSync(world.receiptsDir).forEach((name) => fs.chmodSync(path.join(world.receiptsDir, name), 0o664)), world.receiptsDir), false],
    ['recibo 0646', (world) => (fs.readdirSync(world.receiptsDir).forEach((name) => fs.chmodSync(path.join(world.receiptsDir, name), 0o646)), world.receiptsDir), false],
  ];
  function nested(world: CloseWorld, mode: number): string {
    const parent = tmpDir('lack-acima-');
    const inner = path.join(parent, 'recibos');
    fs.cpSync(world.receiptsDir, inner, { recursive: true });
    fs.chmodSync(parent, mode);
    return inner;
  }
  for (const [label, setup, accepted] of setups) {
    const world = closeWorld({ retired: R, closer: S });
    writeReceipts(world.receiptsDir, chainOn(world.sealsDir, X, [R]));
    const receiptsDir = setup(world);
    const result = await runCloseKey(world.input({ receiptsDir }), closeDeps(world));
    if (accepted) assert.equal(closed(result).heads.length, 1, label);
    else refused(world, result, 'CLOSE_RECEIPTS_INVALID', label);
  }
  const noUid = closeWorld({ retired: R, closer: S });
  writeReceipts(noUid.receiptsDir, chainOn(noUid.sealsDir, X, [R]));
  refused(noUid, await runCloseKey(noUid.input(), closeDeps(noUid, { uid: undefined })), 'CLOSE_RECEIPTS_INVALID', 'sem como conferir o dono (fora do Linux): recusa');
  refused(noUid, await runCloseKey(noUid.input(), closeDeps(noUid, { uid: (process.getuid?.() ?? 0) + 1 })), 'CLOSE_RECEIPTS_INVALID', 'pasta de outro usuário');
});

test('revisão da W4.5 (MINOR): as recusas da pasta de recibos nunca ecoam o NOME de um arquivo (pode trazer dado de cliente); citam a posição ordinal', async () => {
  const R = signer('ek-fecho-r');
  const S = signer('ek-fecho-s');
  for (const [name, content] of [['ACME-SP-123.json', 'não é JSON'], ['cliente-acme-sp.txt', '{}'], ['ACME-SP-123.JSON', '{}']] as const) {
    const world = closeWorld({ retired: R, closer: S });
    writeReceipts(world.receiptsDir, chainOn(world.sealsDir, X, [R]));
    fs.writeFileSync(path.join(world.receiptsDir, name), content);
    const refusal = refused(world, await runCloseKey(world.input(), closeDeps(world)), 'CLOSE_RECEIPTS_INVALID', name);
    assert.ok(!/ACME|acme|cliente/.test(refusal.message), `${name}: nome nunca ecoado (${refusal.message})`);
    assert.match(refusal.message, /\d+º arquivo/, `${name}: posição ordinal`);
  }
});

test('revisão da W4.5 (TOCTOU): recibo que muda de tamanho entre o fstat e a leitura pelo descritor ⇒ CLOSE_RECEIPTS_INVALID (nunca se aceita um recibo cortado ou crescido)', async () => {
  const R = signer('ek-fecho-r');
  for (const [label, change] of [
    ['cresceu', (bytes: Uint8Array) => Buffer.concat([bytes, Buffer.from(' ')])],
    ['encolheu', (bytes: Uint8Array) => bytes.subarray(0, bytes.length - 1)],
  ] as const) {
    const world = closeWorld({ retired: R });
    writeReceipts(world.receiptsDir, chainOn(world.sealsDir, X, [R]));
    const changing: CloseFsOps = {
      ...nodeCloseFsOps,
      async openDir(target) {
        const opened = await nodeCloseFsOps.openDir(target);
        return { ...opened, read: async (name, maxBytes) => ((read) => ({ stat: read.stat, bytes: change(read.bytes) }))(await opened.read(name, maxBytes)) };
      },
    };
    const refusal = refused(world, await runCloseKey(world.input(), closeDeps(world, { closeFs: changing })), 'CLOSE_RECEIPTS_INVALID', label);
    assert.match(refusal.message, /mudou durante a leitura/, label);
  }
});

test(`§5.5.1 item 9 (limite exato, revisão da W4.5): exatamente ${MAX_RECEIPT_FILES} arquivos não esbarram no teto; ${MAX_RECEIPT_FILES + 1} ⇒ CLOSE_RECEIPTS_INVALID antes de ler qualquer recibo`, async () => {
  assert.equal(MAX_RECEIPT_FILES, 10_000, 'valor de produção');
  const world = closeWorld();
  for (let index = 0; index < MAX_RECEIPT_FILES; index += 1) fs.writeFileSync(path.join(world.receiptsDir, `r${String(index).padStart(5, '0')}.json`), '');
  const atLimit = refused(world, await runCloseKey(world.input(), closeDeps(world)), 'CLOSE_RECEIPTS_INVALID', 'no teto');
  assert.doesNotMatch(atLimit.message, /mais de/, `no teto a recusa é do 1º recibo (vazio), não do número de arquivos: ${atLimit.message}`);
  fs.writeFileSync(path.join(world.receiptsDir, 'r99999.json'), '');
  let reads = 0;
  const counting: CloseFsOps = {
    ...nodeCloseFsOps,
    async openDir(target) {
      const opened = await nodeCloseFsOps.openDir(target);
      return { ...opened, read: (name, maxBytes) => ((reads += 1), opened.read(name, maxBytes)) };
    },
  };
  const over = refused(world, await runCloseKey(world.input(), closeDeps(world, { closeFs: counting })), 'CLOSE_RECEIPTS_INVALID', 'acima do teto');
  assert.match(over.message, new RegExp(`mais de ${MAX_RECEIPT_FILES}`));
  assert.equal(reads, 0, 'nenhum recibo lido');
});

test('revisão da W4.5 (MINOR): os tetos valem DURANTE a enumeração (opendir iterativo, para na entrada máximo + 1): recibos com limite injetado (limite aceito, limite + 1 recusado) e a raiz da cópia do servidor', async () => {
  const pulls = { count: 0 };
  async function* names(total: number): AsyncGenerator<{ readonly name: string }> {
    for (let index = 0; index < total; index += 1) {
      pulls.count += 1;
      yield { name: `n${index}` };
    }
  }
  assert.deepEqual(await collectUpTo(names(3), 3), ['n0', 'n1', 'n2']);
  pulls.count = 0;
  assert.equal(await collectUpTo(names(50_000), 5), null);
  assert.equal(pulls.count, 6, 'para na entrada máximo + 1');
  const R = signer('ek-fecho-r');
  const world = closeWorld({ retired: R });
  const seals = chainOn(world.sealsDir, X, [R, R, R]);
  writeReceipts(world.receiptsDir, seals);
  const sealsRoot = fs.realpathSync(world.sealsDir);
  const uid = process.getuid?.();
  const read = await readReceipts(nodeCloseFsOps, { receiptsDir: world.receiptsDir, sealsRoot, uid, maxFiles: 3 });
  assert.ok(read.ok && read.receipts.length === 3, 'limite injetado aceito');
  writeReceipt(world.receiptsDir, 'extra.json', receiptFor(at(seals[0])));
  const limits: number[] = [];
  const recording: CloseFsOps = {
    ...nodeCloseFsOps,
    async openDir(target) {
      const opened = await nodeCloseFsOps.openDir(target);
      return { ...opened, list: (limit) => (limits.push(limit), opened.list(limit)) };
    },
  };
  const over = await readReceipts(recording, { receiptsDir: world.receiptsDir, sealsRoot, uid, maxFiles: 3 });
  assert.equal(over.ok ? 'OK' : over.code, 'CLOSE_RECEIPTS_INVALID', 'limite + 1 recusado');
  assert.deepEqual(limits, [3], 'o teto vai para a enumeração (não é conferido depois de listar tudo)');
  const rootLimits: number[] = [];
  const crowded: CloseFsOps = { ...nodeCloseFsOps, listDir: async (_target, limit) => (rootLimits.push(limit), null) };
  const refusal = refused(world, await runCloseKey(world.input(), closeDeps(world, { closeFs: crowded })), 'CLOSE_SERVER_COPY_INVALID', 'raiz da cópia acima do teto');
  assert.equal(refusal.chainReason, 'TOO_MANY_AUDITS');
  assert.deepEqual(rootLimits, [MAX_SERVER_ENTRIES], 'a raiz é enumerada com o teto');
});

/* =============================================================================================================== chaves e argumentos */

test('§5.5.1 item 9 / §6: R ausente da lista ou REVOGADA ⇒ CLOSE_KEY_STATE_INVALID; S não ativa ⇒ SIGN_KEY_NOT_ACTIVE; S = R ou id fora do padrão ⇒ USAGE; tudo antes de tocar o disco', async () => {
  const world = closeWorld();
  const { retired: R, closer: S } = world;
  writeReceipts(world.receiptsDir, chainOn(world.sealsDir, X, [R]));
  const cases: ReadonlyArray<readonly [string, Partial<Parameters<CloseWorld['input']>[0]>, string]> = [
    ['R fora da lista', { trustKeys: item(S) }, 'CLOSE_KEY_STATE_INVALID'],
    ['R revogada (dúvida ⇒ revoked, nunca retired)', { trustKeys: `${item(R, 'revoked')},${item(S)}` }, 'CLOSE_KEY_STATE_INVALID'],
    ['S fora da lista', { trustKeys: item(R) }, 'SIGN_KEY_NOT_ACTIVE'],
    ['S aposentada', { trustKeys: `${item(R)},${item(S, 'retired')}` }, 'SIGN_KEY_NOT_ACTIVE'],
    ['S revogada', { trustKeys: `${item(R)},${item(S, 'revoked')}` }, 'SIGN_KEY_NOT_ACTIVE'],
    ['S = R', { signerKeyId: R.keyId }, 'USAGE'],
    ['R fora do padrão', { retiredKeyId: 'R' }, 'USAGE'],
    ['S fora do padrão', { signerKeyId: 'EK-FECHO-S' }, 'USAGE'],
    ['lista fora de forma', { trustKeys: 'lixo' }, 'USAGE'],
    ['custodiante com e-mail', { custodian: 'cust@exemplo.invalid' }, 'USAGE'],
  ];
  const closeCalls: string[] = [];
  const untouchable: CloseFsOps = {
    lstat: async (target) => (closeCalls.push(target), nodeCloseFsOps.lstat(target)),
    listDir: async (target, limit) => (closeCalls.push(target), nodeCloseFsOps.listDir(target, limit)),
    openDir: async (target) => (closeCalls.push(target), nodeCloseFsOps.openDir(target)),
  };
  for (const [label, over, code] of cases) {
    const spy = spyFs();
    const deps = closeDeps(world, { fs: spy.fs, closeFs: untouchable });
    refused(world, await runCloseKey(world.input(over), deps), code, label);
    assert.deepEqual([spy.calls, closeCalls], [[], []], `${label}: nada lido`);
    assert.deepEqual(deps.order(), [], `${label}: nem confirmação nem chave`);
  }
  for (const state of ['active', 'retired', `retired:${'c'.repeat(64)}`]) {
    const ok = closeWorld({ retired: R, closer: S });
    writeReceipts(ok.receiptsDir, chainOn(ok.sealsDir, X, [R]));
    assert.equal(closed(await runCloseKey(ok.input({ trustKeys: `${item(R, state)},${item(S)}` }), closeDeps(ok))).heads.length, 1, `R ${state} pode ser fechada (reemissão inclusive)`);
  }
});

test(`§6 (limite exato, revisão da W4.5): exatamente ${MAX_CLOSURE_HEADS} auditorias cobertas ⇒ fecho gravado com ${MAX_CLOSURE_HEADS} heads; ${MAX_CLOSURE_HEADS + 1} ⇒ CLOSE_TOO_MANY_HEADS antes da confirmação e da chave`, async () => {
  const world = closeWorld();
  for (let index = 0; index < MAX_CLOSURE_HEADS; index += 1) writeReceipts(world.receiptsDir, chainOn(world.sealsDir, `auditoria-muitas-${String(index).padStart(4, '0')}`, [world.retired]));
  const done = closed(await runCloseKey(world.input(), closeDeps(world)));
  assert.equal(done.heads.length, MAX_CLOSURE_HEADS);
  fs.rmSync(path.join(world.sealsDir, '_closures'), { recursive: true, force: true });
  writeReceipts(world.receiptsDir, chainOn(world.sealsDir, 'auditoria-muitas-9999', [world.retired]));
  const deps = closeDeps(world);
  refused(world, await runCloseKey(world.input(), deps), 'CLOSE_TOO_MANY_HEADS');
  assert.deepEqual(deps.order(), []);
});

/* =============================================================================================================== cópia do servidor e _closures */

test('criação exclusiva: _closures/<R>.json já existente ⇒ CLOSE_ALREADY_EXISTS antes da confirmação e da chave (o arquivo fica intacto); _closures que é link ou arquivo ⇒ CLOSE_SERVER_COPY_INVALID', async () => {
  const world = closeWorld();
  writeReceipts(world.receiptsDir, chainOn(world.sealsDir, X, [world.retired]));
  fs.mkdirSync(path.join(world.sealsDir, '_closures'));
  fs.writeFileSync(closurePath(world.sealsDir, world.retired.keyId), 'fecho anterior (fictício)');
  const deps = closeDeps(world);
  refused(world, await runCloseKey(world.input(), deps), 'CLOSE_ALREADY_EXISTS');
  assert.deepEqual(deps.order(), []);
  assert.equal(fs.readFileSync(closurePath(world.sealsDir, world.retired.keyId), 'utf8'), 'fecho anterior (fictício)');
  for (const [label, plant] of [
    ['_closures link simbólico', (dir: string) => fs.symlinkSync(tmpDir('lack-alvo-'), path.join(dir, '_closures'))],
    ['_closures arquivo', (dir: string) => fs.writeFileSync(path.join(dir, '_closures'), '')],
  ] as const) {
    const other = closeWorld();
    writeReceipts(other.receiptsDir, chainOn(other.sealsDir, X, [other.retired]));
    plant(other.sealsDir);
    refused(other, await runCloseKey(other.input(), closeDeps(other)), 'CLOSE_SERVER_COPY_INVALID', label);
  }
});

test('cópia do servidor: --seals-dir inexistente ou arquivo, erro de E/S ao ler uma posição, ou nome de manifesto em outra caixa ⇒ CLOSE_SERVER_COPY_INVALID antes da confirmação e da chave', async () => {
  const cases: ReadonlyArray<readonly [string, (world: CloseWorld) => { readonly sealsDir?: string; readonly fs?: BytesFsOps; readonly closeFs?: CloseFsOps }]> = [
    ['inexistente', (world) => ({ sealsDir: path.join(world.sealsDir, 'nao-existe') })],
    ['arquivo', () => ({ sealsDir: writeReceipt(tmpDir('lack-arq-'), 'x.json', {}) })],
    ['E/S ao ler um manifesto', () => ({ fs: { ...nodeFsOps, readFile: async () => Promise.reject(errno('EIO')) } })],
    // revisão da W4.5: a raiz é enumerada com teto pelo disco do close-key (opendir iterativo), não pela fotografia
    ['E/S ao listar a cópia', (world) => ({ closeFs: { ...nodeCloseFsOps, listDir: async (dir: string, limit: number) => (dir === fs.realpathSync(world.sealsDir) ? Promise.reject(errno('EACCES')) : nodeCloseFsOps.listDir(dir, limit)) } })],
    ['E/S ao ler uma auditoria', (world) => ({ fs: { ...nodeFsOps, readdir: async (dir: string) => (dir === path.join(fs.realpathSync(world.sealsDir), X) ? Promise.reject(errno('EACCES')) : nodeFsOps.readdir(dir)) } })],
    ['nome em outra caixa', (world) => (fs.copyFileSync(path.join(world.sealsDir, X, 'seal-0001.json'), path.join(world.sealsDir, X, 'SEAL-0002.json')), {})],
  ];
  for (const [label, setup] of cases) {
    const world = closeWorld();
    writeReceipts(world.receiptsDir, chainOn(world.sealsDir, X, [world.retired]));
    const { sealsDir, fs: ops, closeFs } = setup(world);
    const deps = closeDeps(world, { ...(ops ? { fs: ops } : {}), ...(closeFs ? { closeFs } : {}) });
    refused(world, await runCloseKey(world.input(sealsDir ? { sealsDir } : {}), deps), 'CLOSE_SERVER_COPY_INVALID', label);
    assert.deepEqual(deps.order(), [], `${label}: nem confirmação nem chave`);
  }
});

/* =============================================================================================================== autoteste do fecho */

test('autoteste do fecho: cadeia coberta que o servidor recusaria com R retired:<hash do fecho> (posição de chave revogada, arquivo ilegível depois da cabeça) ⇒ SIGN_SELFTEST_FAILED citando a auditoria; nada gravado', async () => {
  const world = closeWorld();
  const { retired: R, closer: S } = world;
  const K = signer('ek-fecho-k');
  const x = chainOn(world.sealsDir, X, [R, R, K]);
  writeReceipts(world.receiptsDir, x);
  const deps = closeDeps(world);
  const refusal = refused(world, await runCloseKey(world.input({ trustKeys: `${item(R)},${item(S)},${item(K, 'revoked')}` }), deps), 'SIGN_SELFTEST_FAILED', 'posição de chave revogada');
  assert.equal(refusal.chainReason, 'SEAL_KEY_REVOKED');
  assert.ok(refusal.message.includes(X), 'cita a auditoria (id público)');
  assert.deepEqual(deps.order(), ['confirm', 'openKey'], 'o autoteste vem depois da assinatura do fecho');
  assert.ok(!fs.existsSync(path.join(world.sealsDir, '_closures')), 'nada gravado (nem a pasta _closures)');
  const junk = closeWorld({ retired: R, closer: S });
  writeReceipts(junk.receiptsDir, chainOn(junk.sealsDir, X, [R, R]));
  deliverSeal(junk.sealsDir, X, 3, 'lixo que não é JSON (fictício)\n');
  const second = refused(junk, await runCloseKey(junk.input(), closeDeps(junk)), 'SIGN_SELFTEST_FAILED', 'posição ilegível depois da cabeça');
  assert.equal(second.chainReason, 'SEAL_INVALID');
});

test('autoteste do fecho: o servidor (verificador real) autentica cada cadeia coberta com a lista em que R está retired:<closureSha256> e o fecho entra em keyIds; a cópia do servidor só ganha _closures/<R>.json (cada manifesto lido uma vez, nada mais escrito, recibos intocados)', async () => {
  const world = closeWorld();
  const { retired: R, closer: S } = world;
  const x = chainOn(world.sealsDir, X, [R, R, S]);
  writeReceipts(world.receiptsDir, x);
  const beforeSeals = filesUnder(world.sealsDir);
  const beforeReceipts = new Map(filesUnder(world.receiptsDir).map((rel) => [rel, fs.readFileSync(path.join(world.receiptsDir, rel), 'utf8')]));
  const spy = spyFs();
  const done = closed(await runCloseKey(world.input(), closeDeps(world, { fs: spy.fs })));
  const root = fs.realpathSync(world.sealsDir);
  const closures = path.join(root, '_closures');
  const writes = spy.calls.filter((call) => WRITE_OPS.has(call.op));
  assert.ok(writes.length > 0 && writes.every((call) => call.target === closures || call.target === root || call.target.startsWith(closures + path.sep)), `escrita só em _closures/: ${writes.map((call) => `${call.op}:${call.target}`).join(' ')}`);
  const sealReads = spy.calls.filter((call) => call.op === 'readFile' && /seal-\d{4}\.json$/.test(call.target)).map((call) => path.basename(call.target)).sort();
  assert.deepEqual(sealReads, ['seal-0001.json', 'seal-0002.json', 'seal-0003.json'], 'cada manifesto lido do disco uma vez (a fotografia serve ao autoteste)');
  assert.deepEqual(filesUnder(world.sealsDir), [...beforeSeals, `_closures/${R.keyId}.json`].sort());
  for (const [rel, text] of beforeReceipts) assert.equal(fs.readFileSync(path.join(world.receiptsDir, rel), 'utf8'), text);
  assert.deepEqual(await verdictOf(world.sealsDir, `${done.pinnedTrustKey},${item(S)}`, at(x[2])), { status: 'AUTHENTICATED', headSeq: 3, headSealSha256: sealSha256(at(x[2])), keyIds: [R.keyId, S.keyId].sort() });
  assert.equal(fs.statSync(closurePath(world.sealsDir, R.keyId)).mode & 0o777, 0o444, 'o fecho nasce somente leitura');
});

test('vetor-ouro G6 (RS-09): G1–G2 da chave a com recibos, fechados pela chave b no instante de G6 ⇒ o corpo canônico e a assinatura do fecho gravado são os de G6 (os bytes entregues são outros, por isso o closureSha256 é o deles)', async () => {
  const [a, b] = [goldenSigner('a'), goldenSigner('b')];
  const world = closeWorld({ retired: a, closer: b });
  const fileOf = (vector: typeof GOLDEN.g1 | typeof GOLDEN.g2): EvidenceSealFileV2 => ({ ...vector.body, entries: [...vector.body.entries].sort((m, n) => (m.ref < n.ref ? -1 : 1)), signature: vector.signature }) as EvidenceSealFileV2;
  const seals = [fileOf(GOLDEN.g1), fileOf(GOLDEN.g2)];
  for (const seal of seals) deliverSeal(world.sealsDir, seal.auditId, seal.seq, `${JSON.stringify(seal)}\n`);
  writeReceipts(world.receiptsDir, seals);
  const done = closed(await runCloseKey(world.input(), closeDeps(world, { now: () => new Date(GOLDEN.g6.body.sealedAt) })));
  const parsed = parseKeyRetirementClosureText(fs.readFileSync(closurePath(world.sealsDir, a.keyId)));
  assert.ok(parsed.ok);
  assert.equal(parsed.value.signature, GOLDEN.g6.signature, 'assinatura de G6 (Ed25519 determinístico)');
  assert.equal(sha256(canonicalJson(parsed.value)), GOLDEN.g6.canonicalFileSha256, 'forma canônica de G6');
  assert.deepEqual(done.heads, GOLDEN.g6.body.heads);
  assert.notEqual(done.closureSha256, GOLDEN.g6.closureSha256, 'a autoridade é o hash dos BYTES entregues (outra formatação ⇒ outro hash)');
});

/* =============================================================================================================== portas, relógio e gravação */

test('confirmação (TTY) depois de todas as recusas que não precisam da chave: a tela recebe S e as contagens, NUNCA o id de R; texto diferente do id de R, ou porta que falha ⇒ SIGN_CONFIRMATION_FAILED, a chave não é aberta e nada é gravado', async () => {
  const world = closeWorld();
  const { retired: R, closer: S } = world;
  writeReceipts(world.receiptsDir, chainOn(world.sealsDir, X, [R]));
  chainOn(world.sealsDir, Y, [R]);
  for (const [label, confirm] of [
    ['texto diferente', async () => R.keyId.toUpperCase()],
    ['id com espaço', async () => ` ${R.keyId}`],
    ['porta que lança', async (): Promise<string> => Promise.reject(new Error('sem TTY'))],
  ] as const) {
    const deps = closeDeps(world, { confirm });
    refused(world, await runCloseKey(world.input(), deps), 'SIGN_CONFIRMATION_FAILED', label);
    assert.deepEqual(deps.order(), ['confirm'], `${label}: a chave não é aberta`);
    assert.deepEqual(deps.facts(), [{ signerKeyId: S.keyId, heads: 1, unknown: 1, missing: 0 }], `${label}: a tela recebe S e as contagens`);
  }
});

test('chave: a recusa da abertura passa adiante; a pública derivada diferente da de S na lista ⇒ SIGN_KEY_MISMATCH; nada gravado', async () => {
  const world = closeWorld();
  writeReceipts(world.receiptsDir, chainOn(world.sealsDir, X, [world.retired]));
  refused(world, await runCloseKey(world.input(), closeDeps(world, { openKey: () => signer('ek-outra').privateKey })), 'SIGN_KEY_MISMATCH', 'outra chave');
  refused(world, await runCloseKey(world.input(), closeDeps(world, { openKey: () => world.retired.privateKey })), 'SIGN_KEY_MISMATCH', 'a própria R');
  refused(world, await runCloseKey(world.input(), closeDeps(world, { openKey: () => ({ ok: false, code: 'SIGN_KEY_REJECTED', message: 'A frase não abre a chave. Nada foi assinado.' }) })), 'SIGN_KEY_REJECTED', 'recusa da abertura');
});

test('relógio: sealedAt do fecho antes do último manifesto coberto ⇒ SIGN_CLOCK_REGRESSION antes da confirmação; o instante vem do relógio injetado', async () => {
  const world = closeWorld();
  const x = chainOn(world.sealsDir, X, [world.retired, world.retired]);
  writeReceipts(world.receiptsDir, x);
  const deps = closeDeps(world, { now: () => new Date(Date.parse(at(x[1]).sealedAt) - 1) });
  refused(world, await runCloseKey(world.input(), deps), 'SIGN_CLOCK_REGRESSION');
  assert.deepEqual(deps.order(), []);
  assert.equal(closed(await runCloseKey(world.input(), closeDeps(world, { now: () => new Date(at(x[1]).sealedAt) }))).sealedAt, at(x[1]).sealedAt);
});

test('gravação à prova de queda: _closures criada se ausente (e a raiz sincronizada), temporário .<R>.json.tmp-<aleatório> + fsync + link() exclusivo + remoção + fsync da pasta; corrida no link() ⇒ CLOSE_ALREADY_EXISTS; falha antes do link() ⇒ SIGN_WRITE_FAILED sem resto', async () => {
  const world = closeWorld();
  writeReceipts(world.receiptsDir, chainOn(world.sealsDir, X, [world.retired]));
  const spy = spyFs();
  closed(await runCloseKey(world.input(), closeDeps(world, { fs: spy.fs })));
  const root = fs.realpathSync(world.sealsDir);
  const dir = path.join(root, '_closures');
  const writes = spy.calls.filter((call) => WRITE_OPS.has(call.op));
  const temp = writes[2]?.target ?? '';
  assert.match(path.basename(temp), new RegExp(`^\\.${world.retired.keyId}\\.json\\.tmp-[0-9a-f]{32}$`));
  assert.deepEqual(writes.map((call) => [call.op, call.target]), [
    ['mkdir', dir],
    ['syncDirectory', root],
    ['writeExclusive', temp],
    ['link', temp],
    ['unlink', temp],
    ['syncDirectory', dir],
  ]);
  assert.deepEqual(fs.readdirSync(dir), [`${world.retired.keyId}.json`]);
  const race = closeWorld();
  writeReceipts(race.receiptsDir, chainOn(race.sealsDir, X, [race.retired]));
  const raced = { ...nodeFsOps, link: async (from: string, to: string) => (fs.writeFileSync(to, 'outro processo (fictício)'), nodeFsOps.link(from, to)) };
  refused(race, await runCloseKey(race.input(), closeDeps(race, { fs: raced })), 'CLOSE_ALREADY_EXISTS', 'corrida no link()');
  assert.equal(fs.readFileSync(closurePath(race.sealsDir, race.retired.keyId), 'utf8'), 'outro processo (fictício)', 'nada sobrescrito');
  assert.deepEqual(fs.readdirSync(path.join(race.sealsDir, '_closures')), [`${race.retired.keyId}.json`], 'o temporário foi removido');
  const broken = closeWorld();
  writeReceipts(broken.receiptsDir, chainOn(broken.sealsDir, X, [broken.retired]));
  refused(broken, await runCloseKey(broken.input(), closeDeps(broken, { fs: { ...nodeFsOps, writeExclusive: async () => Promise.reject(errno('ENOSPC')) } })), 'SIGN_WRITE_FAILED', 'disco cheio');
  assert.deepEqual(fs.readdirSync(path.join(broken.sealsDir, '_closures')), []);
});
