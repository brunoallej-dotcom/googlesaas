import assert from 'node:assert/strict';
import { createHash, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/lib/link-audit/canonical';
import {
  CLOSURE_KIND,
  createEvidenceSeal,
  createEvidenceSealV2,
  createKeyRetirementClosure,
  createSealedEvidenceProvenance,
  evidenceProvenanceFromConfig,
  MAX_CLOSURE_BYTES,
  MAX_TRUST_KEYS,
  parseTrustKeyring,
  parseTrustKeys,
  sealSha256,
  type AcceptedSealVersion,
  type EvidenceSealFile,
  type EvidenceSealFileV2,
  type EvidenceToProve,
  type EvidenceTrustReason,
  type TrustKeyring,
} from '../src/lib/link-audit-evidence/provenance';
import { registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { evidenceKeys, writeSealFile, type EvidenceKeys } from './helpers/link-audit-evidence-provenance-fixtures';

/*
 * W3.4 — trust list with key STATES and the retirement closure pinned by hash (contract `p1-contrato-verificador-v2.md` §5, §6, §7.1, §8 row 13,
 * §11). Covers V2-20 to V2-26, V2-42 and V2-47 (RS-16, RS-18 limit, D10, D12, B1, N1, N6, O2), the keyring part of V2-18 and of V2-19 (static part
 * lives in the single-seal file), and G6 through the verifier (golden file). Every list goes through `evidenceProvenanceFromConfig`, i.e. the
 * production parser `parseTrustKeyring`. The revocation PRE-STEP, its precedence and `revokedKeyIds` (V2-27/28/43/44) are W3.5: here a position
 * signed by a revoked key only has to fail closed.
 *
 * Closures and seals are built with the W3.1 producers (pinned by the independent golden vectors G1–G6); the pinned `closureSha256` is computed
 * here with node:crypto over the bytes this test writes, never by the code under test.
 */
registerCleanup();

const AUD = 'auditoria-anel-v2-01';
const NEW_AUDIT = 'auditoria-anel-v2-02';
const R = evidenceKeys('ek-anel-ret'); // the key being retired
const Q = evidenceKeys('ek-anel-ret2'); // a second retired key
const S = evidenceKeys('ek-anel-suc'); // successor, active
const H = evidenceKeys('ek-anel-tit'); // holder, active
const DOSSIER = { id: 'dossie-anel-01', sha256: 'a1'.repeat(32) };
const ev = (ref: string, fill: string): EvidenceToProve => ({ ref, contentSha256: fill.repeat(64), legacy: false });
const E1: readonly EvidenceToProve[] = [ev('capture:c0001', 'a'), ev('report:c0001-r0001', 'b')];
const E2: readonly EvidenceToProve[] = [...E1, ev('capture:c0002', 'c')];
const E3: readonly EvidenceToProve[] = [...E2, ev('capture:c0003', 'd')];
const E4: readonly EvidenceToProve[] = [...E3, ev('capture:c0004', 'e')];

type AnySeal = EvidenceSealFile | EvidenceSealFileV2;
interface Position {
  readonly keys: EvidenceKeys;
  readonly entries: readonly EvidenceToProve[];
  readonly version?: 1 | 2;
}
const plain = (entries: readonly EvidenceToProve[]) => entries.map(({ ref, contentSha256 }) => ({ ref, contentSha256 }));
/** A chain with the real producers; a v2 links to `sealSha256` of the previous position. Deterministic (Ed25519, fixed dates). */
function buildChain(positions: readonly Position[], auditId = AUD): AnySeal[] {
  const seals: AnySeal[] = [];
  positions.forEach(({ keys, entries, version }, index) => {
    const base = { auditId, seq: index + 1, sealedAt: `2026-11-19T1${index}:00:00.000Z`, keyId: keys.keyId, privateKey: keys.privateKey, entries: plain(entries) };
    seals.push(version === 1 ? createEvidenceSeal(base) : createEvidenceSealV2({ ...base, dossier: DOSSIER, prevSealSha256: index === 0 ? null : sealSha256(seals[index - 1] as AnySeal) }));
  });
  return seals;
}
function writeChain(seals: readonly AnySeal[], auditId = AUD, sealsDir = tmpDir('lep4-')): string {
  for (const seal of seals) writeSealFile(sealsDir, auditId, seal.seq, seal);
  return sealsDir;
}
const headOf = (seal: AnySeal, auditId = AUD) => ({ auditId, seq: seal.seq, sealSha256: sealSha256(seal) });
/** The delivered closure bytes (pretty JSON + LF), as an operator would copy them. */
function closureText(retired: EvidenceKeys, signer: EvidenceKeys, heads: ReadonlyArray<{ readonly auditId: string; readonly seq: number; readonly sealSha256: string }>, sealedAt = '2026-11-20T08:00:00.000Z'): string {
  const { privateKey } = signer;
  return `${JSON.stringify(createKeyRetirementClosure({ retiredKeyId: retired.keyId, signerKeyId: signer.keyId, sealedAt, heads, privateKey }), null, 2)}\n`;
}
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
/** Writes `<sealsDir>/_closures/<name>` and returns the SHA-256 of the exact bytes written (what the operator pins). */
function putClosure(sealsDir: string, name: string, text: string): string {
  const dir = path.join(sealsDir, '_closures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
  return sha256(text);
}
const item = (keys: EvidenceKeys, ...rest: string[]): string => [keys.keyId, keys.publicRaw, ...rest].join(':');
const listOf = (...items: string[]): string => items.join(',');
function classify(sealsDir: string, list: string, evidences: readonly EvidenceToProve[], versions: readonly AcceptedSealVersion[] = [2], auditId = AUD) {
  return evidenceProvenanceFromConfig({ sealsDir, trustKeys: list, acceptedVersions: versions }).classify(auditId, evidences);
}
const UNAUTH = (reason: EvidenceTrustReason) => ({ status: 'UNAUTHENTICATED', reason });
const authenticated = (head: AnySeal, keyIds: readonly string[]) => ({ status: 'AUTHENTICATED', headSeq: head.seq, headSealSha256: sealSha256(head), keyIds: [...new Set(keyIds)].sort() });
const UNCOVERED = UNAUTH('SEAL_KEY_RETIRED_UNCOVERED');

/** R1 R2 S3 with R retired by a closure (signed by S) whose head is 3: the base scenario of B1(b). */
function retiredScenario() {
  const seals = buildChain([{ keys: R, entries: E1 }, { keys: R, entries: E2 }, { keys: S, entries: E3 }]);
  const sealsDir = writeChain(seals);
  const text = closureText(R, S, [headOf(seals[2] as AnySeal)]);
  const pin = putClosure(sealsDir, `${R.keyId}.json`, text);
  return { seals, sealsDir, text, pin, list: listOf(item(R, 'retired', pin), item(S)) };
}

/* ============================================================================================ V2-20 */

test('V2-20 (RS-16, D12) trust list: 2 parts = active, the three states and a pinned closure hash parse; zero active is valid; parseTrustKeys is unchanged', () => {
  const pin = 'ab'.repeat(32);
  const ring = parseTrustKeyring(listOf(item(H), item(S, 'active'), item(R, 'retired', pin), item(Q, 'retired')));
  assert.ok(ring, 'valid list');
  assert.deepEqual([...ring.entries()].map(([id, entry]) => [id, entry.status, entry.closureSha256]), [
    [H.keyId, 'active', null],
    [S.keyId, 'active', null],
    [R.keyId, 'retired', pin],
    [Q.keyId, 'retired', null],
  ]);
  assert.equal(ring.get(H.keyId)?.key.asymmetricKeyType, 'ed25519');
  assert.deepEqual([...(parseTrustKeyring(listOf(item(R, 'revoked'), item(Q, 'retired', pin))) as TrustKeyring).values()].map((e) => e.status), ['revoked', 'retired'], 'zero active is a valid list');
  assert.equal(MAX_TRUST_KEYS, 16);
  const sixteen = Array.from({ length: MAX_TRUST_KEYS }, (_, index) => evidenceKeys(`ek-anel-lim-${String(index).padStart(2, '0')}`));
  assert.ok(parseTrustKeyring(listOf(...sixteen.map((keys, index) => item(keys, index < 2 ? 'active' : 'retired')))), '16 items, 2 active');
  // the old parser keeps its behavior: 2 parts only, any number of keys
  const three = listOf(item(H), item(S), item(R));
  assert.equal(parseTrustKeys(three)?.size, 3, 'parseTrustKeys: unchanged');
  assert.equal(parseTrustKeys(item(H, 'active')), null, 'parseTrustKeys still refuses 3 parts');
});

test('V2-20 (RS-16, RS-18, D12) a malformed list closes the policy as a whole (PROOF_NOT_CONFIGURED)', async () => {
  const sealsDir = writeChain(buildChain([{ keys: H, entries: E1 }]));
  const pin = 'ab'.repeat(32);
  const seventeen = Array.from({ length: MAX_TRUST_KEYS + 1 }, (_, index) => evidenceKeys(`ek-anel-max-${String(index).padStart(2, '0')}`));
  const invalid: ReadonlyArray<readonly [string, string]> = [
    ['5 parts', listOf(item(H), item(R, 'retired', pin, 'x'))],
    ['revoked:x', listOf(item(H), item(R, 'revoked', pin))],
    ['active:x', listOf(item(H), item(R, 'active', pin))],
    ['retired:non-hex', listOf(item(H), item(R, 'retired', 'z'.repeat(64)))],
    ['retired:short hash', listOf(item(H), item(R, 'retired', 'ab'.repeat(31)))],
    ['retired:HEX in upper case', listOf(item(H), item(R, 'retired', pin.toUpperCase()))],
    ['status in upper case', listOf(item(H), item(R, 'RETIRED'))],
    ['status with a space', listOf(item(H), item(R, ' revoked'))],
    ['empty status', listOf(item(H), item(R, ''))],
    ['unknown status', listOf(item(H), item(R, 'suspended'))],
    ['trailing comma', `${item(H)},`],
    ['empty item', listOf(item(H), '', item(S))],
    ['repeated id', listOf(item(H), `${H.keyId}:${S.publicRaw}`)],
    ['same public key under two ids (RS-16)', listOf(item(H), `ek-anel-copia:${H.publicRaw}:retired`)],
    ['three active keys', listOf(item(H), item(S), item(R, 'active'))],
    ['17 items', listOf(...seventeen.map((keys, index) => item(keys, index < 2 ? 'active' : 'revoked')))],
    ['small-order public key', listOf(item(H), `ek-anel-fraca:${Buffer.alloc(32).toString('base64url')}`)],
    ['malformed id', listOf(item(H), `EK-ANEL:${S.publicRaw}`)],
  ];
  for (const [label, list] of invalid) {
    assert.equal(parseTrustKeyring(list), null, `parse: ${label}`);
    assert.deepEqual(await classify(sealsDir, list, E1), UNAUTH('PROOF_NOT_CONFIGURED'), `policy: ${label}`);
  }
  assert.equal((await classify(sealsDir, item(H), E1)).status, 'AUTHENTICATED', 'control');
  // a programmatic keyring is held to the same limits
  const ring = parseTrustKeyring(listOf(item(H), item(S))) as TrustKeyring;
  const tooManyActive: TrustKeyring = new Map([...ring, [R.keyId, { key: (parseTrustKeyring(item(R)) as TrustKeyring).get(R.keyId)!.key, status: 'active' as const, closureSha256: null }]]);
  assert.deepEqual(await createSealedEvidenceProvenance({ sealsDir, keyring: tooManyActive, acceptedVersions: [2] }).classify(AUD, E1), UNAUTH('PROOF_NOT_CONFIGURED'), 'programmatic keyring with 3 active');
});

/* ============================================================================================ V2-21, V2-22 */

test('V2-21 (D10, D12) the two active keys interleave freely: A S A and S A S are AUTHENTICATED', async () => {
  const list = listOf(item(H), item(S));
  for (const order of [[H, S, H], [S, H, S]]) {
    const seals = buildChain(order.map((keys, index) => ({ keys, entries: [E1, E2, E3][index] as readonly EvidenceToProve[] })));
    assert.deepEqual(await classify(writeChain(seals), list, E3), authenticated(seals[2] as AnySeal, [H.keyId, S.keyId]), order.map((k) => k.keyId).join(' '));
  }
});

test('V2-22 (B1 a) a retired key signing seal-0001…k of a NEW audit is SEAL_KEY_RETIRED_UNCOVERED, even with a closure for other audits', async () => {
  const { sealsDir, list } = retiredScenario(); // valid closure for AUD
  for (const chain of [[{ keys: R, entries: E1 }], [{ keys: R, entries: E1 }, { keys: R, entries: E2 }]]) {
    const seals = buildChain(chain, NEW_AUDIT);
    writeChain(seals, NEW_AUDIT, sealsDir);
    assert.deepEqual(await classify(sealsDir, list, chain[chain.length - 1]?.entries as readonly EvidenceToProve[], [2], NEW_AUDIT), UNCOVERED, `new audit, ${chain.length} seal(s) by R`);
  }
  // a head that NAMES another audit covers nothing here, even when it carries this chain's seal hash
  const seals = buildChain([{ keys: R, entries: E1 }, { keys: R, entries: E2 }]);
  const dir = writeChain(seals);
  const pin = putClosure(dir, `${R.keyId}.json`, closureText(R, S, [{ auditId: 'auditoria-anel-v2-00', seq: 2, sealSha256: sealSha256(seals[1] as AnySeal) }]));
  assert.deepEqual(await classify(dir, listOf(item(R, 'retired', pin), item(S)), E2), UNCOVERED, 'head of another audit');
});

/* ============================================================================================ V2-23, V2-24 */

test('V2-23 (B1 b) R1 R2 S3 with a closure at head 3: deleting 3, re-signing 3′ with R, or regressing to an earlier position never authenticates', async () => {
  const intact = retiredScenario();
  assert.deepEqual(await classify(intact.sealsDir, intact.list, E3), authenticated(intact.seals[2] as AnySeal, [R.keyId, S.keyId]), 'intact chain, covered by the pinned closure');
  const deleted = retiredScenario();
  fs.rmSync(path.join(deleted.sealsDir, AUD, 'seal-0003.json'), { force: true });
  assert.deepEqual(await classify(deleted.sealsDir, deleted.list, E2), UNCOVERED, 'head 3 deleted (truncation)');
  const resigned = retiredScenario();
  const third = buildChain([{ keys: R, entries: E1 }, { keys: R, entries: E2 }, { keys: R, entries: E3 }]);
  writeSealFile(resigned.sealsDir, AUD, 3, third[2]);
  assert.deepEqual(await classify(resigned.sealsDir, resigned.list, E3), UNCOVERED, '3 deleted and re-signed by R (3′ ⊇ 2)');
  const regressed = retiredScenario();
  for (const seq of [2, 3]) fs.rmSync(path.join(regressed.sealsDir, AUD, `seal-000${seq}.json`), { force: true });
  assert.deepEqual(await classify(regressed.sealsDir, regressed.list, E1), UNCOVERED, 'regressed to R1');
});

test('V2-24 (B1 c) with ZERO active keys: a new audit is SEAL_KEY_RETIRED_UNCOVERED; an audit covered by its closure, chain intact, is AUTHENTICATED', async () => {
  const seals = buildChain([{ keys: R, entries: E1 }, { keys: R, entries: E2 }]);
  const sealsDir = writeChain(seals);
  const pin = putClosure(sealsDir, `${R.keyId}.json`, closureText(R, S, [headOf(seals[1] as AnySeal)]));
  const list = listOf(item(R, 'retired', pin), item(S, 'retired')); // both retired: nothing new can be authenticated
  assert.deepEqual(await classify(sealsDir, list, E2), authenticated(seals[1] as AnySeal, [R.keyId, S.keyId]), 'covered audit (the closure signer joins keyIds)');
  writeChain(buildChain([{ keys: R, entries: E1 }], NEW_AUDIT), NEW_AUDIT, sealsDir);
  assert.deepEqual(await classify(sealsDir, list, E1, [2], NEW_AUDIT), UNCOVERED, 'new audit');
  writeChain(buildChain([{ keys: S, entries: E1 }], 'auditoria-anel-v2-03'), 'auditoria-anel-v2-03', sealsDir);
  assert.deepEqual(await classify(sealsDir, list, E1, [2], 'auditoria-anel-v2-03'), UNCOVERED, 'a retired key without a pinned closure never counts');
});

/* ============================================================================================ V2-25 */

test('V2-25 (D12, §6) the PINNED HASH is the authority: no pin, other bytes (1 byte, reformatting, edited heads), missing, directory, link or > 256 KiB never count', async () => {
  const base = retiredScenario();
  assert.deepEqual(await classify(base.sealsDir, listOf(item(R, 'retired'), item(S)), E3), UNCOVERED, 'retired without a pinned hash');
  const variants: ReadonlyArray<readonly [string, (text: string) => string]> = [
    ['one byte', (text) => text.replace('"sealedAt": "2026-11-20T08:00:00.000Z"', '"sealedAt": "2026-11-20T08:00:00.001Z"')],
    ['reformatted (same JSON, same signature)', (text) => `${JSON.stringify(JSON.parse(text))}\n`],
    ['CRLF line endings', (text) => text.replace(/\n/g, '\r\n')],
    ['heads edited', (text) => text.replace('"seq": 3', '"seq": 2')],
  ];
  for (const [label, change] of variants) {
    const scenario = retiredScenario();
    const changed = change(scenario.text);
    assert.notEqual(changed, scenario.text, label);
    putClosure(scenario.sealsDir, `${R.keyId}.json`, changed);
    assert.deepEqual(await classify(scenario.sealsDir, scenario.list, E3), UNCOVERED, label);
  }
  type Scenario = ReturnType<typeof retiredScenario>;
  const closureFile = (sc: Scenario): string => path.join(sc.sealsDir, '_closures', `${R.keyId}.json`);
  const unreadable: ReadonlyArray<readonly [string, (sc: Scenario) => string]> = [
    ['missing', (sc) => (fs.rmSync(closureFile(sc)), sc.pin)],
    ['a directory', (sc) => (fs.rmSync(closureFile(sc)), fs.mkdirSync(closureFile(sc)), sc.pin)],
    ['a symbolic link to the right bytes', (sc) => {
      const elsewhere = path.join(tmpDir('lep4-elsewhere-'), 'closure.json');
      fs.writeFileSync(elsewhere, sc.text);
      fs.rmSync(closureFile(sc));
      fs.symlinkSync(elsewhere, closureFile(sc));
      return sc.pin;
    }],
    ['above MAX_CLOSURE_BYTES (pinned)', (sc) => putClosure(sc.sealsDir, `${R.keyId}.json`, ' '.repeat(MAX_CLOSURE_BYTES + 1))],
  ];
  for (const [label, damage] of unreadable) {
    const scenario = retiredScenario();
    const pinned = damage(scenario);
    assert.deepEqual(await classify(scenario.sealsDir, listOf(item(R, 'retired', pinned), item(S)), E3), UNCOVERED, label);
  }
});

test('V2-25 (D12, §6) a pinned file that is not a valid closure of R, or whose present signer does not sign it, never counts', async () => {
  const forged = (body: Record<string, unknown>, signer: EvidenceKeys): string => `${JSON.stringify({ ...body, signature: cryptoSign(null, Buffer.from(canonicalJson(body), 'utf8'), signer.privateKey).toString('base64url') }, null, 2)}\n`;
  const cases: ReadonlyArray<readonly [string, (scenario: ReturnType<typeof retiredScenario>) => string]> = [
    ['not a closure (schema)', () => '{"schemaVersion":1}\n'],
    ['closure of another key under R.json (retiredKeyId ≠ name)', (sc) => closureText(Q, S, [headOf(sc.seals[2] as AnySeal)])],
    ['signerKeyId = R (re-signed by R)', (sc) => forged({ schemaVersion: 1, kind: CLOSURE_KIND, retiredKeyId: R.keyId, signerKeyId: R.keyId, sealedAt: '2026-11-20T08:00:00.000Z', heads: [headOf(sc.seals[2] as AnySeal)] }, R)],
    ['signer S in the list, signature by another key', (sc) => forged({ schemaVersion: 1, kind: CLOSURE_KIND, retiredKeyId: R.keyId, signerKeyId: S.keyId, sealedAt: '2026-11-20T08:00:00.000Z', heads: [headOf(sc.seals[2] as AnySeal)] }, H)],
  ];
  for (const [label, make] of cases) {
    const scenario = retiredScenario();
    const pin = putClosure(scenario.sealsDir, `${R.keyId}.json`, make(scenario));
    assert.deepEqual(await classify(scenario.sealsDir, listOf(item(R, 'retired', pin), item(S)), E3), UNCOVERED, label);
  }
});

test('V2-25 (D12) R as the LAST signer inside the head authenticates; a v1 position of R is never covered; S or H may extend after the head', async () => {
  const lastR = buildChain([{ keys: S, entries: E1 }, { keys: R, entries: E2 }]);
  const lastDir = writeChain(lastR);
  const lastPin = putClosure(lastDir, `${R.keyId}.json`, closureText(R, S, [headOf(lastR[1] as AnySeal)]));
  assert.deepEqual(await classify(lastDir, listOf(item(R, 'retired', lastPin), item(S)), E2), authenticated(lastR[1] as AnySeal, [R.keyId, S.keyId]), 'R last, within the head');

  const v1First = buildChain([{ keys: R, entries: E1, version: 1 }, { keys: R, entries: E2 }]);
  const v1Dir = writeChain(v1First);
  const v1Pin = putClosure(v1Dir, `${R.keyId}.json`, closureText(R, S, [headOf(v1First[1] as AnySeal)]));
  assert.deepEqual(await classify(v1Dir, listOf(item(R, 'retired', v1Pin), item(S)), E2, [1, 2]), UNCOVERED, 'a v1 position of R inside the head');

  const extended = buildChain([{ keys: R, entries: E1 }, { keys: R, entries: E2 }, { keys: S, entries: E3 }, { keys: H, entries: E4 }]);
  const extDir = writeChain(extended);
  const extPin = putClosure(extDir, `${R.keyId}.json`, closureText(R, S, [headOf(extended[1] as AnySeal)]));
  assert.deepEqual(await classify(extDir, listOf(item(R, 'retired', extPin), item(S), item(H)), E4), authenticated(extended[3] as AnySeal, [R.keyId, S.keyId, H.keyId]), 'S and H after the head');
  const rAfter = buildChain([{ keys: R, entries: E1 }, { keys: R, entries: E2 }, { keys: R, entries: E3 }]);
  writeSealFile(extDir, AUD, 3, rAfter[2]);
  fs.rmSync(path.join(extDir, AUD, 'seal-0004.json'));
  assert.deepEqual(await classify(extDir, listOf(item(R, 'retired', extPin), item(S), item(H)), E3), UNCOVERED, 'R extending after its head');
});

/* ============================================================================================ V2-26 */

test('V2-26 (N1, N6) a closure signer revoked LATER keeps the history authenticated (and is in keyIds); closures of non-retired ids and unsafe _closures do not count', async () => {
  const seals = buildChain([{ keys: R, entries: E1 }, { keys: R, entries: E2 }]);
  const sealsDir = writeChain(seals);
  const pin = putClosure(sealsDir, `${R.keyId}.json`, closureText(R, S, [headOf(seals[1] as AnySeal)]));
  assert.deepEqual(await classify(sealsDir, listOf(item(R, 'retired', pin), item(S, 'revoked'), item(H)), E2), authenticated(seals[1] as AnySeal, [R.keyId, S.keyId]), 'signer revoked after pinning');
  // the closure of an id that is not `retired` is ignored: it neither rescues a revoked key nor matters for an active one
  assert.notEqual((await classify(sealsDir, listOf(item(R, 'revoked'), item(S)), E2)).status, 'AUTHENTICATED', 'revoked R + closure: no rescue');
  putClosure(sealsDir, `${H.keyId}.json`, 'não é um fecho');
  const byH = buildChain([{ keys: H, entries: E1 }], NEW_AUDIT);
  writeChain(byH, NEW_AUDIT, sealsDir);
  assert.deepEqual(await classify(sealsDir, listOf(item(H)), E1, [2], NEW_AUDIT), authenticated(byH[0] as AnySeal, [H.keyId]), 'garbage closure of an active key is ignored');
  // `_closures` must be a real directory (lstat, no link); otherwise every closure is ignored
  const linkedClosures = writeChain(seals);
  const realClosures = tmpDir('lep4-closures-');
  fs.writeFileSync(path.join(realClosures, `${R.keyId}.json`), closureText(R, S, [headOf(seals[1] as AnySeal)]));
  fs.symlinkSync(realClosures, path.join(linkedClosures, '_closures'));
  assert.deepEqual(await classify(linkedClosures, listOf(item(R, 'retired', pin), item(S)), E2), UNCOVERED, '_closures is a symbolic link');
  const fileClosures = writeChain(seals);
  fs.writeFileSync(path.join(fileClosures, '_closures'), 'arquivo, não pasta');
  assert.deepEqual(await classify(fileClosures, listOf(item(R, 'retired', pin), item(S)), E2), UNCOVERED, '_closures is a file');
});

test('V2-26 / W3.5 placeholder: a position signed by a REVOKED key never authenticates (the pre-step, its precedence and revokedKeyIds are W3.5)', async () => {
  const seals = buildChain([{ keys: H, entries: E1 }, { keys: S, entries: E2 }]);
  assert.deepEqual(await classify(writeChain(seals), listOf(item(H), item(S, 'revoked')), E2), UNAUTH('SEAL_KEY_REVOKED'));
});

/* ============================================================================================ V2-42, V2-47 */

test('V2-42 (N1) swapping the closure for another VALID one, rolling it back, a second closure file, or two retired keys closing each other: only the pinned bytes count', async () => {
  const seals = buildChain([{ keys: R, entries: E1 }, { keys: R, entries: E2 }]);
  const head = headOf(seals[1] as AnySeal);
  const current = closureText(R, S, [head]);
  const swaps: ReadonlyArray<readonly [string, string]> = [
    ['a draft (other sealedAt)', closureText(R, S, [head], '2026-11-20T07:00:00.000Z')],
    ['an older version (head 1)', closureText(R, S, [headOf(seals[0] as AnySeal)])],
    ['the closure of another ACTIVE key (H)', closureText(R, H, [head])],
  ];
  for (const [label, other] of swaps) {
    const sealsDir = writeChain(seals);
    const pin = putClosure(sealsDir, `${R.keyId}.json`, current);
    putClosure(sealsDir, `${R.keyId}.json`, other); // the folder writer swaps the file after the hash was pinned
    assert.deepEqual(await classify(sealsDir, listOf(item(R, 'retired', pin), item(S), item(H)), E2), UNCOVERED, label);
  }
  const two = writeChain(seals);
  const pin = putClosure(two, `${R.keyId}.json`, current);
  putClosure(two, `${R.keyId}.old.json`, closureText(R, S, [headOf(seals[0] as AnySeal)]));
  assert.deepEqual(await classify(two, listOf(item(R, 'retired', pin), item(S)), E2), authenticated(seals[1] as AnySeal, [R.keyId, S.keyId]), 'a second closure file is irrelevant');
  putClosure(two, `${R.keyId}.json`, closureText(R, S, [head], '2026-11-20T07:00:00.000Z'));
  putClosure(two, `${R.keyId}.json.bak`, current);
  assert.deepEqual(await classify(two, listOf(item(R, 'retired', pin), item(S)), E2), UNCOVERED, 'the pinned bytes under another name do not count');
  const mutual = buildChain([{ keys: R, entries: E1 }, { keys: Q, entries: E2 }]);
  const mutualDir = writeChain(mutual);
  putClosure(mutualDir, `${R.keyId}.json`, closureText(R, Q, [headOf(mutual[1] as AnySeal)]));
  putClosure(mutualDir, `${Q.keyId}.json`, closureText(Q, R, [headOf(mutual[1] as AnySeal)]));
  assert.deepEqual(await classify(mutualDir, listOf(item(R, 'retired'), item(Q, 'retired')), E2), UNCOVERED, 'two surviving retired keys closing each other, nothing pinned');
});

test('V2-47 (O2, N1) a pinned closure whose signer was REMOVED from the list still authenticates; with the signer present, a bad signature refuses it', async () => {
  const seals = buildChain([{ keys: R, entries: E1 }, { keys: R, entries: E2 }]);
  const sealsDir = writeChain(seals);
  const pin = putClosure(sealsDir, `${R.keyId}.json`, closureText(R, S, [headOf(seals[1] as AnySeal)]));
  assert.deepEqual(await classify(sealsDir, listOf(item(R, 'retired', pin), item(H)), E2), authenticated(seals[1] as AnySeal, [R.keyId, S.keyId]), 'signer gone: only the defense in depth is lost');
  assert.deepEqual(await classify(sealsDir, item(R, 'retired', pin), E2), authenticated(seals[1] as AnySeal, [R.keyId, S.keyId]), 'zero active, signer gone');
  const forgedDir = writeChain(seals);
  const body = { schemaVersion: 1, kind: CLOSURE_KIND, retiredKeyId: R.keyId, signerKeyId: S.keyId, sealedAt: '2026-11-20T08:00:00.000Z', heads: [headOf(seals[1] as AnySeal)] };
  const badPin = putClosure(forgedDir, `${R.keyId}.json`, `${JSON.stringify({ ...body, signature: cryptoSign(null, Buffer.from(canonicalJson(body), 'utf8'), H.privateKey).toString('base64url') }, null, 2)}\n`);
  assert.deepEqual(await classify(forgedDir, listOf(item(R, 'retired', badPin), item(S)), E2), UNCOVERED, 'signer present, signature does not verify');
  assert.deepEqual(await classify(forgedDir, listOf(item(R, 'retired', badPin), item(H)), E2), authenticated(seals[1] as AnySeal, [R.keyId, S.keyId]), 'the same bytes with the signer gone: the pin alone decides (contract §6)');
});

/* ============================================================================================ V2-18 (keyring part) */

test('V2-18 (keyring part) a v1 last on the compatible path [1,2]: retired signer ⇒ SEAL_KEY_RETIRED_UNCOVERED, revoked ⇒ SEAL_KEY_REVOKED, active ⇒ exactly {status:"AUTHENTICATED"}', async () => {
  const seals = buildChain([{ keys: R, entries: E1, version: 1 }]);
  const sealsDir = writeChain(seals);
  const pin = putClosure(sealsDir, `${R.keyId}.json`, closureText(R, S, [headOf(seals[0] as AnySeal)]));
  assert.deepEqual(await classify(sealsDir, listOf(item(R, 'retired', pin), item(S)), E1, [1, 2]), UNCOVERED, 'retired: a v1 is never covered');
  assert.deepEqual(await classify(sealsDir, listOf(item(R, 'revoked'), item(S)), E1, [1, 2]), UNAUTH('SEAL_KEY_REVOKED'), 'revoked');
  assert.deepEqual(await classify(sealsDir, listOf(item(R), item(S)), E1, [1, 2]), { status: 'AUTHENTICATED' }, 'active: today\'s answer');
});
