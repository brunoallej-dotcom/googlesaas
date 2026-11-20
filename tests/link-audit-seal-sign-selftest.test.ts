import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps, type BytesFsOps, type FileInfo, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { chainSnapshot, readSealChain, selfTestSeal, type SealManifest } from '../src/lib/link-audit-attestation/sign-chain';
import { runSign } from '../src/lib/link-audit-attestation/sign-run';
import {
  createEvidenceSeal,
  createEvidenceSealV2,
  createKeyRetirementClosure,
  createSealedEvidenceProvenance,
  MAX_CLASSIFY_BYTES,
  MAX_SEAL_BYTES,
  parseTrustKeyring,
  publicKeyFromRaw,
  sealSha256,
  type EvidenceSealFileV2,
  type TrustKeyring,
} from '../src/lib/link-audit-evidence/provenance';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { chainOn, deliverSeal, E1, goldenSigner, item, signer, type TestSigner } from './helpers/link-audit-seal-close-key-fixtures';
import { AUD as CLI_AUD, cliWorld, runSign as runSignCli } from './helpers/link-audit-seal-sign-cli-fixtures';
import { AUD, KEY_ID, RING, signDeps, signInput, testKey, writeStation } from './helpers/link-audit-seal-sign-disk-fixtures';
import { GOLDEN } from './helpers/link-audit-seal-v2-golden';

/*
 * P1 W4.5 (A) — AUTOTESTE do passo 14 do `sign` (spec §5.5 passo 14; §5.5.1 item 2, que prevalece; contrato do verificador v2 §12-C9). Depois da
 * assinatura e ANTES da gravação, o manifesto novo é verificado pelo VERIFICADOR v2 REAL com a lista COMPLETA com estado (`--trust-keys`), os fechos
 * `_closures/` da pasta e `acceptedVersions: [2]`, sobre a cadeia anterior mais o manifesto novo EM MEMÓRIA (a mesma fotografia somente leitura da
 * leitura da cadeia, sem nova leitura do disco), com as evidências = `entries` do pacote. Diferente de `AUTHENTICATED` ⇒ `SIGN_SELFTEST_FAILED`
 * (código 3), nada gravado. Dados 100% FICTÍCIOS em pastas temporárias; chaves de TESTE geradas em memória ou as sementes dos vetores-ouro.
 */
registerCleanup();

const NEW_AT = '2026-11-21T09:00:00.000Z';
const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
const textOf = (seal: SealManifest): string => `${JSON.stringify(seal)}\n`;
const evidencesOf = (seal: SealManifest) => seal.entries.map(({ ref, contentSha256 }) => ({ ref, contentSha256, legacy: false }));

/** O próximo manifesto v2 da cadeia, assinado pela chave indicada (o que o passo 13 produziria). */
function nextSeal(previous: EvidenceSealFileV2 | null, key: TestSigner, auditId: string, sealedAt = NEW_AT): SealManifest {
  return createEvidenceSealV2({ auditId, seq: previous ? previous.seq + 1 : 1, sealedAt, keyId: key.keyId, privateKey: key.privateKey, entries: E1, dossier: { id: 'dossie-auto-0001', sha256: 'e'.repeat(64) }, prevSealSha256: previous ? sealSha256(previous) : null });
}

/** Fecho de aposentadoria de `retired` assinado por `by`, gravado em `_closures/` da pasta; devolve o hash dos BYTES gravados (o que a lista fixa). */
function closeOn(sealsDir: string, retired: TestSigner, by: TestSigner, heads: ReadonlyArray<{ auditId: string; seq: number; sealSha256: string }>): string {
  const closure = createKeyRetirementClosure({ retiredKeyId: retired.keyId, signerKeyId: by.keyId, sealedAt: '2026-11-20T08:00:00.000Z', heads, privateKey: by.privateKey });
  const text = `${JSON.stringify(closure)}\n`;
  fs.mkdirSync(path.join(sealsDir, '_closures'), { recursive: true });
  fs.writeFileSync(path.join(sealsDir, '_closures', `${retired.keyId}.json`), text);
  return sha256(text);
}

/** O que o servidor diria se o manifesto fosse entregue: o verificador real sobre uma CÓPIA da pasta com o arquivo novo (a original fica intacta). */
async function serverVerdict(sealsDir: string, seal: SealManifest, policy: { readonly keyring?: TrustKeyring; readonly trustedKeys?: ReadonlyMap<string, ReturnType<typeof publicKeyFromRaw>> }) {
  const copy = tmpDir('lasa-copia-');
  fs.cpSync(sealsDir, copy, { recursive: true });
  deliverSeal(copy, seal.auditId, seal.seq, textOf(seal));
  const options = policy.keyring ? { keyring: policy.keyring } : { trustedKeys: policy.trustedKeys as ReadonlyMap<string, NonNullable<ReturnType<typeof publicKeyFromRaw>>> };
  return createSealedEvidenceProvenance({ sealsDir: copy, ...options, acceptedVersions: [2] }).classify(seal.auditId, evidencesOf(seal));
}

function failed(refusal: Awaited<ReturnType<typeof selfTestSeal>>, chainReason: string, label: string): void {
  assert.ok(refusal, `${label}: esperava recusa do autoteste`);
  assert.equal(refusal.code, 'SIGN_SELFTEST_FAILED', label);
  assert.equal(refusal.chainReason, chainReason, label);
  assert.match(refusal.message, /autoteste/i, label);
  assert.match(refusal.message, /Nada foi gravado/, label);
}

/* =============================================================================================================== C9: lista completa × pública derivada */

test('C9 (passo 14 com a lista COMPLETA com estado e os fechos): cadeia anterior R1 R2 com R aposentada e fecho fixado só até a cabeça 1 ⇒ SIGN_SELFTEST_FAILED (SEAL_KEY_RETIRED_UNCOVERED); a mesma cadeia passaria com as públicas sem estado', async () => {
  const sealsDir = tmpDir('lasa-c9-');
  const [R, S] = [signer('ek-auto-r'), signer('ek-auto-s')];
  const seals = chainOn(sealsDir, AUD, [R, R]);
  const pin = closeOn(sealsDir, R, S, [{ auditId: AUD, seq: 1, sealSha256: sealSha256(seals[0] as EvidenceSealFileV2) }]); // R2 fica FORA do fecho
  const trustKeys = `${item(R, `retired:${pin}`)},${item(S)}`;
  const seal = nextSeal(seals[1] as EvidenceSealFileV2, S, AUD);
  failed(await selfTestSeal({ sealsDir, trustKeys, seal, text: textOf(seal), entries: seal.entries }, { fs: nodeFsOps }), 'SEAL_KEY_RETIRED_UNCOVERED', 'aposentada fora do fecho fixado');
  // o servidor (lista com estado) recusaria; as públicas SEM estado (o que a "pública derivada"/lista sem estado faria) aceitariam
  assert.deepEqual(await serverVerdict(sealsDir, seal, { keyring: parseTrustKeyring(trustKeys) as TrustKeyring }), { status: 'UNAUTHENTICATED', reason: 'SEAL_KEY_RETIRED_UNCOVERED' });
  const stateless = new Map([R, S].map((key) => [key.keyId, publicKeyFromRaw(key.publicRaw)]));
  assert.equal((await serverVerdict(sealsDir, seal, { trustedKeys: stateless })).status, 'AUTHENTICATED', 'sem os estados da lista, o mesmo manifesto passaria');
  assert.deepEqual(fs.readdirSync(path.join(sealsDir, AUD)).sort(), ['seal-0001.json', 'seal-0002.json'], 'o autoteste nunca escreve');
});

test('C9: com a "pública derivada como única de confiança" um manifesto de chave aposentada (fora do fecho) ou revogada passaria; o autoteste com a lista completa o recusa', async () => {
  const sealsDir = tmpDir('lasa-c9b-');
  const S = signer('ek-auto-s');
  const seals = chainOn(sealsDir, AUD, [S]);
  const seal = nextSeal(seals[0] as EvidenceSealFileV2, S, AUD);
  const derivedOnly = new Map([[S.keyId, publicKeyFromRaw(S.publicRaw)]]);
  assert.equal((await serverVerdict(sealsDir, seal, { trustedKeys: derivedOnly })).status, 'AUTHENTICATED', 'pública derivada como única de confiança aceita');
  const T = signer('ek-auto-t');
  const pin = closeOn(sealsDir, S, T, [{ auditId: AUD, seq: 1, sealSha256: sealSha256(seals[0] as EvidenceSealFileV2) }]);
  failed(await selfTestSeal({ sealsDir, trustKeys: `${item(S, `retired:${pin}`)},${item(T)}`, seal, text: textOf(seal), entries: seal.entries }, { fs: nodeFsOps }), 'SEAL_KEY_RETIRED_UNCOVERED', 'aposentada depois da cabeça');
  const revoked = await selfTestSeal({ sealsDir, trustKeys: item(S, 'revoked'), seal, text: textOf(seal), entries: seal.entries }, { fs: nodeFsOps });
  failed(revoked, 'SEAL_KEY_REVOKED', 'revogada');
});

/* =============================================================================================================== caminho bom e o que é julgado */

test('passo 14: primeiro manifesto (pasta sem a auditoria) e continuação ⇒ autoteste aprova (null); G1–G2 da aposentada a cobertos pelo fecho G6 fixado e G3 (chave b) também', async () => {
  const sealsDir = tmpDir('lasa-bom-');
  const S = signer('ek-auto-s');
  const first = nextSeal(null, S, AUD);
  assert.equal(await selfTestSeal({ sealsDir, trustKeys: item(S), seal: first, text: textOf(first), entries: first.entries }, { fs: nodeFsOps }), null, 'pasta sem a subpasta da auditoria');
  fs.mkdirSync(path.join(sealsDir, 'auditoria-vazia-01'));
  const empty = nextSeal(null, S, 'auditoria-vazia-01');
  assert.equal(await selfTestSeal({ sealsDir, trustKeys: item(S), seal: empty, text: textOf(empty), entries: empty.entries }, { fs: nodeFsOps }), null, 'subpasta vazia');
  const seals = chainOn(sealsDir, AUD, [S, S]);
  const third = nextSeal(seals[1] as EvidenceSealFileV2, S, AUD);
  assert.equal(await selfTestSeal({ sealsDir, trustKeys: item(S), seal: third, text: textOf(third), entries: third.entries }, { fs: nodeFsOps }), null, 'continuação');
  // vetores-ouro: G1, G2 (a, aposentada), fecho G6 fixado pelos BYTES entregues, G3 (b)
  const gold = tmpDir('lasa-ouro-');
  const fileOf = (vector: typeof GOLDEN.g1 | typeof GOLDEN.g2 | typeof GOLDEN.g3): SealManifest => ({ ...vector.body, entries: [...vector.body.entries].sort((x, y) => (x.ref < y.ref ? -1 : 1)), signature: vector.signature }) as SealManifest;
  for (const vector of [GOLDEN.g1, GOLDEN.g2]) deliverSeal(gold, vector.body.auditId, vector.body.seq, textOf(fileOf(vector)));
  fs.mkdirSync(path.join(gold, '_closures'));
  fs.writeFileSync(path.join(gold, '_closures', `${GOLDEN.keys.a.keyId}.json`), Buffer.from(GOLDEN.g6.fileHex, 'hex'));
  const [a, b] = [goldenSigner('a'), goldenSigner('b')];
  const g3 = fileOf(GOLDEN.g3);
  assert.equal(await selfTestSeal({ sealsDir: gold, trustKeys: `${item(a, `retired:${GOLDEN.g6.closureSha256}`)},${item(b)}`, seal: g3, text: textOf(g3), entries: g3.entries }, { fs: nodeFsOps }), null, 'G3 sobre G1–G2 cobertos por G6');
  failed(await selfTestSeal({ sealsDir: gold, trustKeys: `${item(a, 'retired')},${item(b)}`, seal: g3, text: textOf(g3), entries: g3.entries }, { fs: nodeFsOps }), 'SEAL_KEY_RETIRED_UNCOVERED', 'G6 sem hash fixado');
});

test('passo 14: o autoteste julga os BYTES a gravar e exige que a cabeça autenticada seja o manifesto novo (outro manifesto, 1 byte trocado, outra auditoria ou entries que não são as do pacote ⇒ recusa)', async () => {
  const sealsDir = tmpDir('lasa-bytes-');
  const S = signer('ek-auto-s');
  const seals = chainOn(sealsDir, AUD, [S]);
  const seal = nextSeal(seals[0] as EvidenceSealFileV2, S, AUD);
  const other = nextSeal(seals[0] as EvidenceSealFileV2, S, AUD, '2026-11-21T10:00:00.000Z');
  const run = (text: string, entries = seal.entries, trustKeys = item(S)) => selfTestSeal({ sealsDir, trustKeys, seal, text, entries }, { fs: nodeFsOps });
  failed(await run(textOf(other)), 'SELFTEST_HEAD_MISMATCH', 'texto de outro manifesto do mesmo seq');
  const flipped = textOf(seal).replace(seal.signature, `${seal.signature.slice(0, -2)}${seal.signature.endsWith('AA') ? 'BA' : 'AA'}`);
  failed(await run(flipped), 'SEAL_INVALID', 'assinatura com 1 caractere trocado');
  failed(await run(textOf(seal), [...seal.entries, { ref: 'capture:c0009', contentSha256: 'f'.repeat(64) }]), 'EVIDENCE_NOT_SEALED', 'evidência do pacote fora do manifesto');
  failed(await run(textOf(seal), [seal.entries[0] as SealManifest['entries'][number]]), 'EVIDENCE_MISSING', 'manifesto com entrada fora do pacote');
  failed(await run(textOf(seal), seal.entries, 'lixo'), 'PROOF_NOT_CONFIGURED', 'lista fora de forma');
  const elsewhere = nextSeal(null, S, 'auditoria-auto-outra');
  failed(await selfTestSeal({ sealsDir, trustKeys: item(S), seal: elsewhere, text: textOf(seal), entries: elsewhere.entries }, { fs: nodeFsOps }), 'SEAL_INVALID', 'bytes de outra auditoria na subpasta desta');
});

test('passo 14 em modo produção (acceptedVersions [2]): cadeia anterior com um v1 ⇒ SIGN_SELFTEST_FAILED (SEAL_VERSION_NOT_ALLOWED), embora a promoção v1 → v2 passe no padrão de biblioteca [1,2]', async () => {
  const sealsDir = tmpDir('lasa-v1-');
  const S = signer('ek-auto-s');
  const v1 = createEvidenceSeal({ auditId: AUD, seq: 1, sealedAt: '2026-11-18T10:00:00.000Z', keyId: S.keyId, privateKey: S.privateKey, entries: E1 });
  deliverSeal(sealsDir, AUD, 1, `${JSON.stringify(v1)}\n`);
  const seal = createEvidenceSealV2({ auditId: AUD, seq: 2, sealedAt: NEW_AT, keyId: S.keyId, privateKey: S.privateKey, entries: E1, dossier: { id: 'dossie-auto-0001', sha256: 'e'.repeat(64) }, prevSealSha256: sealSha256(v1) });
  failed(await selfTestSeal({ sealsDir, trustKeys: item(S), seal, text: textOf(seal), entries: seal.entries }, { fs: nodeFsOps }), 'SEAL_VERSION_NOT_ALLOWED', 'v1 na cadeia anterior');
  const copy = tmpDir('lasa-v1-copia-');
  fs.cpSync(sealsDir, copy, { recursive: true });
  deliverSeal(copy, AUD, 2, textOf(seal));
  const library = await createSealedEvidenceProvenance({ sealsDir: copy, keyring: parseTrustKeyring(item(S)) as TrustKeyring, acceptedVersions: [1, 2] }).classify(AUD, evidencesOf(seal));
  assert.equal(library.status, 'AUTHENTICATED', 'no padrão [1,2] a promoção passaria (por isso o autoteste fixa [2])');
});

test('passo 14: o manifesto em memória nunca esconde um arquivo REAL de mesmo nome (seq já gravado na pasta ⇒ recusa, sem ler o arquivo real como se fosse o novo)', async () => {
  const sealsDir = tmpDir('lasa-nome-');
  const S = signer('ek-auto-s');
  const seals = chainOn(sealsDir, AUD, [S, S]);
  const rival = nextSeal(seals[0] as EvidenceSealFileV2, S, AUD); // seq 2, como o seal-0002.json que já existe
  const refusal = await selfTestSeal({ sealsDir, trustKeys: item(S), seal: rival, text: textOf(rival), entries: rival.entries }, { fs: nodeFsOps });
  assert.ok(refusal && refusal.code === 'SIGN_SELFTEST_FAILED', 'o nome já existe: o autoteste recusa');
  assert.equal(fs.readFileSync(path.join(sealsDir, AUD, 'seal-0002.json'), 'utf8'), textOf(seals[1] as EvidenceSealFileV2), 'o arquivo real fica intacto');
});

/* =============================================================================================================== mesma fotografia, sem nova leitura */

type Call = { readonly op: string; readonly target: string };
function spyFs(base: FsOps = nodeFsOps): { readonly fs: FsOps; readonly calls: Call[] } {
  const calls: Call[] = [];
  const source = base as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const proxy = Object.fromEntries(Object.keys(base).map((name) => [name, (...args: unknown[]) => (calls.push({ op: name, target: String(args[0]) }), (source[name] as (...a: unknown[]) => Promise<unknown>)(...args))]));
  return { fs: proxy as unknown as FsOps, calls };
}

test('passo 14 sem nova leitura do disco: depois da leitura da cadeia (mesma fotografia somente leitura), o autoteste não faz NENHUMA chamada ao disco, com cadeia, com fecho e no primeiro manifesto', async () => {
  const [R, S] = [signer('ek-auto-r'), signer('ek-auto-s')];
  const withClosure = tmpDir('lasa-foto-');
  const seals = chainOn(withClosure, AUD, [R, R]);
  const pin = closeOn(withClosure, R, S, [{ auditId: AUD, seq: 2, sealSha256: sealSha256(seals[1] as EvidenceSealFileV2) }]);
  const cases: ReadonlyArray<readonly [string, string, string, EvidenceSealFileV2 | null]> = [
    ['cadeia R1 R2 coberta pelo fecho fixado + S3', withClosure, `${item(R, `retired:${pin}`)},${item(S)}`, seals[1] as EvidenceSealFileV2],
    ['primeiro manifesto (subpasta ausente)', tmpDir('lasa-foto-'), item(S), null],
  ];
  for (const [label, sealsDir, trustKeys, previous] of cases) {
    const spy = spyFs();
    const snapshot = chainSnapshot(spy.fs);
    const chain = await readSealChain({ sealsDir, auditId: AUD, trustKeys }, { fs: snapshot });
    assert.equal(chain.status, previous ? 'VERIFIED' : 'EMPTY', label);
    const before = spy.calls.length;
    const seal = nextSeal(previous, S, AUD);
    assert.equal(await selfTestSeal({ sealsDir, trustKeys, seal, text: textOf(seal), entries: seal.entries }, { fs: snapshot }), null, label);
    assert.deepEqual(spy.calls.slice(before), [], `${label}: nenhuma chamada nova ao disco`);
    assert.ok(!spy.calls.some((call) => /^(mkdir|writeExclusive|link|unlink|chmod|syncDirectory)$/.test(call.op)), `${label}: nunca escreve`);
  }
});

/* =============================================================================================================== pelo sign inteiro (disco) */

const SEAL_NAME = /seal-\d{4}\.json$/;
/** Disco real em que cada `seal-NNNN.json` DECLARA 256 KiB no `lstat`: 64 manifestos esgotam exatamente o orçamento de 16 MiB de um `classify`. */
function inflated(base: BytesFsOps = nodeFsOps): BytesFsOps {
  return {
    ...base,
    lstat: async (target) => {
      const info = await base.lstat(target);
      if (!SEAL_NAME.test(target) || !info.isFile()) return info;
      const big: FileInfo = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: MAX_SEAL_BYTES, mtimeMs: info.mtimeMs };
      return big;
    },
  };
}
const FULL_CHAIN = MAX_CLASSIFY_BYTES / MAX_SEAL_BYTES; // 64

test('passo 14 pelo sign inteiro: a cadeia anterior verifica (passo 7), mas com o manifesto novo o servidor estouraria o orçamento de 16 MiB ⇒ SIGN_SELFTEST_FAILED (VERIFICATION_ERROR) depois da chave, e NADA gravado (nem temporário)', async () => {
  assert.equal(FULL_CHAIN, 64);
  const station = writeStation(tmpDir('lasa-st-'));
  const sealsDir = tmpDir('lasa-orc-');
  const a = { keyId: KEY_ID, privateKey: testKey('a'), publicRaw: GOLDEN.keys.a.publicRaw };
  chainOn(sealsDir, AUD, Array.from({ length: FULL_CHAIN }, () => a));
  const before = fs.readdirSync(path.join(sealsDir, AUD)).sort();
  const deps = signDeps({ fs: inflated(), now: () => new Date('2026-11-25T09:00:00.000Z') });
  const result = await runSign(signInput(station, sealsDir, { expectSeq: FULL_CHAIN + 1, first: false }), deps);
  assert.equal(result.ok ? 'GRAVOU' : result.code, 'SIGN_SELFTEST_FAILED');
  if (result.ok) assert.fail('esperava recusa');
  assert.equal(result.chainReason, 'VERIFICATION_ERROR');
  assert.deepEqual(deps.order(), ['confirm', 'openKey'], 'o autoteste vem DEPOIS da assinatura (passo 13), logo depois da chave');
  assert.deepEqual(fs.readdirSync(path.join(sealsDir, AUD)).sort(), before, 'nada gravado: nem manifesto nem temporário');
  // a mesma estação com o orçamento real (sem inflar) assina normalmente: o autoteste não recusa à toa
  const ok = await runSign(signInput(station, sealsDir, { expectSeq: FULL_CHAIN + 1, first: false }), signDeps({ now: () => new Date('2026-11-25T09:00:00.000Z') }));
  assert.ok(ok.ok, ok.ok ? '' : `${ok.code} (${ok.chainReason ?? '-'})`);
});

test('passo 14 pelo sign inteiro: entre a chave aberta e a primeira escrita não há leitura de manifesto nem de pasta (o autoteste usa a fotografia da leitura da cadeia); o gravado é exatamente o autotestado e o servidor o AUTENTICA', async () => {
  const station = writeStation(tmpDir('lasa-st-'));
  const sealsDir = tmpDir('lasa-ordem-');
  const events: string[] = [];
  const base = nodeFsOps as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const observed = Object.fromEntries(Object.keys(nodeFsOps).map((name) => [name, (...args: unknown[]) => (events.push(`${name}:${path.basename(String(args[0]))}`), (base[name] as (...a: unknown[]) => Promise<unknown>)(...args))])) as unknown as BytesFsOps;
  const a = { keyId: KEY_ID, privateKey: testKey('a'), publicRaw: GOLDEN.keys.a.publicRaw };
  chainOn(sealsDir, AUD, [a, a]);
  const result = await runSign(signInput(station, sealsDir, { expectSeq: 3, first: false }), signDeps({ fs: observed, now: () => new Date('2026-11-25T09:00:00.000Z'), openKey: () => (events.push('openKey'), testKey('a')) }));
  if (!result.ok) assert.fail(`${result.code} (${result.chainReason ?? '-'})`);
  const opened = events.indexOf('openKey');
  const firstWrite = events.findIndex((event) => /^(mkdir|writeExclusive|link|unlink|chmod|syncDirectory):/.test(event));
  assert.ok(opened > 0 && firstWrite > opened, events.join(' '));
  const between = events.slice(opened + 1, firstWrite);
  assert.ok(between.every((event) => !/^(readFile|readFileBytes|readdir):/.test(event)), `sem leitura de arquivo nem de pasta entre a chave e a gravação: ${between.join(' ')}`);
  const keyring = parseTrustKeyring(RING) as TrustKeyring;
  assert.deepEqual(await createSealedEvidenceProvenance({ sealsDir, keyring, acceptedVersions: [2] }).classify(AUD, evidencesOf(result.seal)), { status: 'AUTHENTICATED', headSeq: 3, headSealSha256: sealSha256(result.seal), keyIds: [KEY_ID] });
  assert.equal(fs.readFileSync(path.join(sealsDir, AUD, 'seal-0003.json'), 'utf8'), textOf(result.seal));
});

/* =============================================================================================================== pelo CLI */

test('passo 14 pelo CLI: SIGN_SELFTEST_FAILED ⇒ código 3, RECUSADO: e "Código: SIGN_SELFTEST_FAILED (VERIFICATION_ERROR)", nada gravado; no sucesso, a saída humana registra o autoteste e o aviso que resta é só o do artifactSha256 nulo (W4.6)', async () => {
  const world = cliWorld();
  const key = { keyId: world.key.keyId, privateKey: world.key.privateKey, publicRaw: world.key.publicRaw };
  chainOn(world.sealsDir, CLI_AUD, Array.from({ length: FULL_CHAIN }, () => key));
  const later = new Date('2026-11-25T09:00:00.000Z');
  const refusedRun = await runSignCli(world.argv({ 'expect-seq': String(FULL_CHAIN + 1), first: null }), { typed: world.typed(), fs: inflated(), now: later });
  assert.equal(refusedRun.code, 3, refusedRun.stderr);
  const at = refusedRun.err.findIndex((line) => line.startsWith('RECUSADO: '));
  assert.ok(at >= 0 && /autoteste/i.test(refusedRun.err[at] ?? ''), refusedRun.stderr);
  assert.equal(refusedRun.err[at + 1], 'Código: SIGN_SELFTEST_FAILED (VERIFICATION_ERROR)');
  assert.equal(fs.readdirSync(path.join(world.sealsDir, CLI_AUD)).length, FULL_CHAIN, 'nada gravado');
  const json = await runSignCli(world.argv({ 'expect-seq': String(FULL_CHAIN + 1), first: null }, ['--json']), { typed: world.typed(), fs: inflated(), now: later });
  assert.deepEqual([json.code, (JSON.parse(json.out[0] ?? '{}') as Record<string, unknown>).code, (JSON.parse(json.out[0] ?? '{}') as Record<string, unknown>).chainReason], [3, 'SIGN_SELFTEST_FAILED', 'VERIFICATION_ERROR']);
  const fresh = cliWorld();
  const ok = await runSignCli(fresh.argv(), { typed: fresh.typed() });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /Autoteste \(passo 14\)/, 'a saída humana registra o autoteste');
  assert.doesNotMatch(ok.stderr, /autoteste do passo 14 \(onda W4\.5\) ainda não existe/i, 'o aviso do autoteste ausente saiu');
  assert.match(ok.stderr, /artifactSha256 é nulo/, 'o aviso do artefato da W4.6 continua');
});
