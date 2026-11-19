import assert from 'node:assert/strict';
import { createHash, createPrivateKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/lib/link-audit/canonical';
import {
  assembleEvidenceSealV2,
  assembleKeyRetirementClosure,
  buildEvidenceSealBodyV2,
  buildKeyRetirementClosureBody,
  createEvidenceSeal,
  createEvidenceSealV2,
  createKeyRetirementClosure,
  createSealedEvidenceProvenance,
  evidenceProvenanceFromConfig,
  parseEvidenceSealV2Text,
  parseKeyRetirementClosureText,
  parseTrustKeys,
  sealSha256,
  verifyEd25519PureSignature,
  verifyEvidenceSealV2Signature,
  verifyKeyRetirementClosureSignature,
  type AcceptedSealVersion,
  type EvidenceSealFile,
  type EvidenceToProve,
} from '../src/lib/link-audit-evidence/provenance';
import { registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { writeSealFile } from './helpers/link-audit-evidence-provenance-fixtures';
import { GOLDEN } from './helpers/link-audit-seal-v2-golden';

/*
 * V2-38 (RS-09, IA-03) — golden vectors G1–G6 of the v2 format (contract §11). The VALUES come from `helpers/link-audit-seal-v2-golden.ts`, produced
 * by an independent route (Python canonical text, OpenSSL signatures, sha256sum; header of that file). These tests only read them: they recompute
 * `canonicalJson`, compare byte for byte, verify the signatures with the raw public keys in trust-list format, check `sealSha256`, go through the
 * verifier, and fail with one byte changed in each field. G1 → G2 → G3 go through the chain verifier (W3.3); G6 retires key a over G1–G2 and goes
 * through the closure logic of the keyring (W3.4).
 */
registerCleanup();

const { a: KEY_A, b: KEY_B } = GOLDEN.keys;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const fromSeed = (seedHex: string): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
const TRUST = parseTrustKeys(`${KEY_A.keyId}:${KEY_A.publicRaw},${KEY_B.keyId}:${KEY_B.publicRaw}`) as ReadonlyMap<string, KeyObject>;
const SEED_OF: Readonly<Record<string, string>> = { [KEY_A.keyId]: KEY_A.seedHex, [KEY_B.keyId]: KEY_B.seedHex };
const publicOf = (keyId: string): KeyObject => {
  const key = TRUST.get(keyId);
  assert.ok(key, `${keyId} is in the trust list`);
  return key;
};
const hexOf = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fileOf = <B extends object>(vector: { readonly body: B; readonly signature: string }): B & { readonly signature: string } => ({ ...vector.body, signature: vector.signature });
function inputOf<T extends { readonly schemaVersion: unknown; readonly kind: unknown }>(body: T): Omit<T, 'schemaVersion' | 'kind'> {
  const { schemaVersion, kind, ...rest } = body;
  void schemaVersion;
  void kind;
  return rest;
}
const evidencesOf = (body: { readonly entries: ReadonlyArray<{ readonly ref: string; readonly contentSha256: string }> }): EvidenceToProve[] => body.entries.map((entry) => ({ ref: entry.ref, contentSha256: entry.contentSha256, legacy: false }));

/** Writes the EXACT text as `seal-0001.json` (no re-serialization). */
function writeSealText(sealsDir: string, auditId: string, text: string): void {
  const file = path.join(sealsDir, auditId, 'seal-0001.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, text);
}

type Entries = ReadonlyArray<{ readonly ref: string; readonly contentSha256: string }>;
interface SealVector<B> {
  readonly body: B;
  readonly canonicalHex: string;
  readonly signature: string;
  readonly sealSha256: string;
}
type V2Body = { readonly schemaVersion: 2; readonly kind: 'LINK_AUDIT_EVIDENCE_SEAL'; readonly auditId: string; readonly seq: number; readonly sealedAt: string; readonly keyId: string; readonly entries: Entries; readonly dossier: { readonly id: string; readonly sha256: string }; readonly prevSealSha256: string | null };
type V1Body = { readonly schemaVersion: 1; readonly kind: 'LINK_AUDIT_EVIDENCE_SEAL'; readonly auditId: string; readonly seq: number; readonly sealedAt: string; readonly keyId: string; readonly entries: Entries };
const V2_VECTORS: ReadonlyArray<readonly [string, SealVector<V2Body>]> = [['G1', GOLDEN.g1], ['G2', GOLDEN.g2], ['G3', GOLDEN.g3]];
const G4: SealVector<V1Body> = GOLDEN.g4;
/** The data module is deeply readonly; the seal file types use mutable arrays. A plain JSON copy is what a reader would hand over. */
const plainFile = <T,>(vector: SealVector<object>): T => JSON.parse(JSON.stringify(fileOf(vector))) as T;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
/** Every leaf changed by exactly one byte (last char XOR 1; number XOR 1). `null` is handled at the text level by the callers. */
function leafVariants(value: Json, at = ''): Array<readonly [string, Json]> {
  if (typeof value === 'string') return [[at, value.slice(0, -1) + String.fromCharCode(value.charCodeAt(value.length - 1) ^ 1)]];
  if (typeof value === 'number') return [[at, value ^ 1]];
  if (Array.isArray(value)) return value.flatMap((item: Json, index: number) => leafVariants(item, `${at}[${index}]`).map(([where, changed]) => [where, value.map((other: Json, j: number) => (j === index ? changed : other))] as const));
  if (value !== null && typeof value === 'object') {
    const record = value as { readonly [key: string]: Json };
    return Object.entries(record).flatMap(([key, item]) => leafVariants(item, at ? `${at}.${key}` : key).map(([where, changed]) => [where, { ...record, [key]: changed }] as const));
  }
  return [];
}
function oneByteTexts(file: object, serialize: (value: unknown) => string): Array<readonly [string, string]> {
  const base = serialize(file);
  const texts: Array<readonly [string, string]> = leafVariants(file as Json).map(([where, changed]) => [where, serialize(changed)] as const);
  if (base.includes('"prevSealSha256":null')) texts.push(['prevSealSha256 (null)', base.replace('"prevSealSha256":null', '"prevSealSha256":nulm')]);
  for (const [where, text] of texts) {
    const x = Buffer.from(base, 'utf8');
    const y = Buffer.from(text, 'utf8');
    assert.ok(x.length === y.length && x.reduce((count, byte, index) => count + (byte === y[index] ? 0 : 1), 0) === 1, `${where}: exactly one byte changed`);
  }
  return texts;
}

/* ============================================================================================ G5 */

test('V2-38 (RS-09) G5 canonicalJson probe: key order, NFD to NFC, numbers, escapes and nesting match the independent canonical bytes', () => {
  assert.equal(hexOf(canonicalJson(GOLDEN.g5.value)), GOLDEN.g5.canonicalHex);
  assert.ok(JSON.stringify(GOLDEN.g5.value).includes('́'), 'the probe input holds decomposed (NFD) sequences');
  assert.ok(!Buffer.from(GOLDEN.g5.canonicalHex, 'hex').toString('utf8').includes('́'), 'the canonical bytes hold none');
});

/* ============================================================================================ G1–G4 */

test('V2-38 (RS-09, IA-03) G1–G3: canonical bytes, OpenSSL signature under the trust-list key, sealSha256, chain links and K1 parity', () => {
  for (const [label, vector] of V2_VECTORS) {
    const key = publicOf(vector.body.keyId);
    const { body, signingBytes } = buildEvidenceSealBodyV2(inputOf(vector.body));
    assert.equal(signingBytes.toString('hex'), vector.canonicalHex, `${label}: builder bytes = independent canonical bytes`);
    assert.equal(hexOf(canonicalJson(vector.body)), vector.canonicalHex, `${label}: canonicalJson`);
    assert.equal(cryptoVerify(null, signingBytes, key, Buffer.from(vector.signature, 'base64url')), true, `${label}: crypto.verify(null, …)`);
    assert.equal(verifyEd25519PureSignature(signingBytes, vector.signature, key), true, `${label}: pure verification`);
    const file = assembleEvidenceSealV2(body, vector.signature, key);
    assert.deepEqual(file, fileOf(vector), `${label}: external assembly`);
    assert.equal(sealSha256(file), vector.sealSha256, `${label}: sealSha256`);
    const parsed = parseEvidenceSealV2Text(Buffer.from(JSON.stringify(fileOf(vector), null, 2), 'utf8'));
    assert.ok(parsed.ok && verifyEvidenceSealV2Signature(parsed.value, key) && sealSha256(parsed.value) === vector.sealSha256, `${label}: parsed from a pretty-printed copy`);
    assert.deepEqual(createEvidenceSealV2({ ...inputOf(vector.body), privateKey: fromSeed(SEED_OF[vector.body.keyId] as string) }), fileOf(vector), `${label}: K1 (Node) = OpenSSL, bit for bit`);
  }
  assert.equal(GOLDEN.g1.body.prevSealSha256, null);
  assert.equal(GOLDEN.g2.body.prevSealSha256, GOLDEN.g1.sealSha256, 'G2 links to G1');
  assert.equal(GOLDEN.g3.body.prevSealSha256, GOLDEN.g2.sealSha256, 'G3 links to G2');
  assert.notEqual(GOLDEN.g3.body.keyId, GOLDEN.g2.body.keyId, 'G3 continues with ANOTHER key');
});

test('V2-38 (RS-09) G4 v1 non-regression: canonical bytes, OpenSSL signature, sealSha256 and the unchanged v1 producer', () => {
  const vector = G4;
  const key = publicOf(vector.body.keyId);
  assert.equal(hexOf(canonicalJson(vector.body)), vector.canonicalHex);
  assert.equal(cryptoVerify(null, Buffer.from(vector.canonicalHex, 'hex'), key, Buffer.from(vector.signature, 'base64url')), true);
  assert.deepEqual(createEvidenceSeal({ ...inputOf(vector.body), privateKey: fromSeed(KEY_A.seedHex) }), fileOf(vector), 'createEvidenceSeal (v1) = OpenSSL, bit for bit');
  assert.equal(sealSha256(plainFile<EvidenceSealFile>(vector)), vector.sealSha256);
  assert.notEqual(vector.sealSha256, GOLDEN.g1.sealSha256);
});

test('V2-38 (IA-21) through the verifier: G1 gives the golden head metadata; G4 (v1) gives exactly {status:"AUTHENTICATED"} on the compatible path', async () => {
  const sealsDir = tmpDir('lepg-');
  writeSealFile(sealsDir, GOLDEN.g1.body.auditId, 1, fileOf(GOLDEN.g1));
  writeSealFile(sealsDir, GOLDEN.g4.body.auditId, 1, fileOf(GOLDEN.g4));
  for (const acceptedVersions of [[2], [1, 2]] as const) {
    const verdict = await createSealedEvidenceProvenance({ sealsDir, trustedKeys: TRUST, acceptedVersions }).classify(GOLDEN.g1.body.auditId, evidencesOf(GOLDEN.g1.body));
    assert.deepEqual(verdict, { status: 'AUTHENTICATED', headSeq: 1, headSealSha256: GOLDEN.g1.sealSha256, keyIds: [KEY_A.keyId] }, JSON.stringify(acceptedVersions));
  }
  assert.deepEqual(await createSealedEvidenceProvenance({ sealsDir, trustedKeys: TRUST, acceptedVersions: [1, 2] }).classify(GOLDEN.g4.body.auditId, evidencesOf(GOLDEN.g4.body)), { status: 'AUTHENTICATED' });
  assert.deepEqual(await createSealedEvidenceProvenance({ sealsDir, trustedKeys: TRUST, acceptedVersions: [2] }).classify(GOLDEN.g4.body.auditId, evidencesOf(GOLDEN.g4.body)), { status: 'UNAUTHENTICATED', reason: 'SEAL_VERSION_NOT_ALLOWED' });
});

test('V2-38 (IA-21, W3.3) G1 → G2 → G3 through the chain verifier: the golden head metadata, and one changed byte in G2 or G3 never authenticates', async () => {
  const auditId = GOLDEN.g1.body.auditId;
  const chain: ReadonlyArray<readonly [number, SealVector<V2Body>]> = [[1, GOLDEN.g1], [2, GOLDEN.g2], [3, GOLDEN.g3]];
  const writeGoldenChain = (): string => {
    const sealsDir = tmpDir('lepg-');
    for (const [seq, vector] of chain) writeSealFile(sealsDir, auditId, seq, fileOf(vector));
    return sealsDir;
  };
  const sealsDir = writeGoldenChain();
  for (const acceptedVersions of [[2], [1, 2]] as const) {
    const verdict = await createSealedEvidenceProvenance({ sealsDir, trustedKeys: TRUST, acceptedVersions }).classify(auditId, evidencesOf(GOLDEN.g3.body));
    assert.deepEqual(verdict, { status: 'AUTHENTICATED', headSeq: 3, headSealSha256: GOLDEN.g3.sealSha256, keyIds: [KEY_A.keyId, KEY_B.keyId] }, JSON.stringify(acceptedVersions));
  }
  for (const [seq, vector] of chain.slice(1)) {
    for (const [where, text] of oneByteTexts(fileOf(vector), (value) => JSON.stringify(value))) {
      const dir = writeGoldenChain();
      const file = path.join(dir, auditId, `seal-000${seq}.json`);
      fs.chmodSync(file, 0o644);
      fs.writeFileSync(file, text);
      const verdict = await createSealedEvidenceProvenance({ sealsDir: dir, trustedKeys: TRUST, acceptedVersions: [2] }).classify(auditId, evidencesOf(GOLDEN.g3.body));
      assert.equal(verdict.status, 'UNAUTHENTICATED', `G${seq} ${where}: ${JSON.stringify(verdict)}`);
    }
  }
});

test('V2-38 (RS-09) one changed byte in each field: G1 and G4 are refused by the verifier, G2 and G3 by the signature check', async () => {
  const sealsDir = tmpDir('lepg-');
  const compact = (value: unknown): string => JSON.stringify(value);
  const verified: ReadonlyArray<readonly [string, SealVector<V1Body | V2Body>, readonly AcceptedSealVersion[]]> = [['G1', GOLDEN.g1, [2]], ['G4', G4, [1, 2]]];
  for (const [label, vector, versions] of verified) {
    const variants = oneByteTexts(fileOf(vector), compact);
    assert.ok(variants.length >= 10, `${label}: ${variants.length} variants`);
    for (const [where, text] of variants) {
      writeSealText(sealsDir, vector.body.auditId, text);
      const verdict = await createSealedEvidenceProvenance({ sealsDir, trustedKeys: TRUST, acceptedVersions: versions }).classify(vector.body.auditId, evidencesOf(vector.body));
      assert.equal(verdict.status, 'UNAUTHENTICATED', `${label} ${where}: ${JSON.stringify(verdict)}`);
    }
  }
  for (const [label, vector] of V2_VECTORS.slice(1)) {
    for (const [where, text] of oneByteTexts(fileOf(vector), compact)) {
      const parsed = parseEvidenceSealV2Text(Buffer.from(text, 'utf8'));
      const key = parsed.ok ? TRUST.get(parsed.value.keyId) : undefined;
      assert.ok(!parsed.ok || !key || !verifyEvidenceSealV2Signature(parsed.value, key), `${label} ${where}: still verifies`);
    }
  }
});

/* ============================================================================================ G6 */

test('V2-38 (D12, W3.4) G6 through the verifier: key a retired by the pinned G6 closure covers G1–G2, G3 (key b) extends it; other bytes never count', async () => {
  const auditId = GOLDEN.g1.body.auditId;
  const chain: ReadonlyArray<readonly [number, SealVector<V2Body>]> = [[1, GOLDEN.g1], [2, GOLDEN.g2], [3, GOLDEN.g3]];
  const sealsDir = tmpDir('lepg-');
  for (const [seq, vector] of chain) writeSealFile(sealsDir, auditId, seq, fileOf(vector));
  fs.mkdirSync(path.join(sealsDir, '_closures'));
  fs.writeFileSync(path.join(sealsDir, '_closures', `${KEY_A.keyId}.json`), Buffer.from(GOLDEN.g6.fileHex, 'hex'));
  const list = (status: string) => `${KEY_A.keyId}:${KEY_A.publicRaw}:${status},${KEY_B.keyId}:${KEY_B.publicRaw}:active`;
  const verdict = (status: string) => evidenceProvenanceFromConfig({ sealsDir, trustKeys: list(status), acceptedVersions: [2] }).classify(auditId, evidencesOf(GOLDEN.g3.body));
  assert.deepEqual(await verdict(`retired:${GOLDEN.g6.closureSha256}`), { status: 'AUTHENTICATED', headSeq: 3, headSealSha256: GOLDEN.g3.sealSha256, keyIds: [KEY_A.keyId, KEY_B.keyId] }, 'pinned closureSha256');
  assert.deepEqual(await verdict(`retired:${GOLDEN.g6.canonicalFileSha256}`), { status: 'UNAUTHENTICATED', reason: 'SEAL_KEY_RETIRED_UNCOVERED' }, 'the hash of the CANONICAL form is not the pin');
  assert.deepEqual(await verdict('retired'), { status: 'UNAUTHENTICATED', reason: 'SEAL_KEY_RETIRED_UNCOVERED' }, 'nothing pinned');
});

test('V2-38 (RS-09, D12) G6 closure: exact delivered bytes, closureSha256 pinned over the RAW bytes (not the canonical form), canonical body and signature', () => {
  const vector = GOLDEN.g6;
  const bytes = Buffer.from(vector.fileHex, 'hex');
  assert.equal(sha256(bytes), vector.closureSha256, 'the pin is the SHA-256 of the delivered bytes');
  const parsed = parseKeyRetirementClosureText(bytes);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(parsed.value, fileOf(vector));
  assert.equal(sha256(Buffer.from(canonicalJson(parsed.value), 'utf8')), vector.canonicalFileSha256);
  assert.notEqual(vector.closureSha256, vector.canonicalFileSha256, 'the canonical form hashes differently: only the delivered bytes match the pin');
  const reformatted = Buffer.from(JSON.stringify(parsed.value), 'utf8');
  assert.ok(parseKeyRetirementClosureText(reformatted).ok && sha256(reformatted) !== vector.closureSha256, 'a reformatted copy parses and verifies, yet no longer matches the pin');

  const { body, signingBytes } = buildKeyRetirementClosureBody(inputOf(vector.body));
  assert.equal(signingBytes.toString('hex'), vector.canonicalHex);
  assert.equal(hexOf(canonicalJson(vector.body)), vector.canonicalHex);
  const signer = publicOf(vector.body.signerKeyId);
  assert.equal(cryptoVerify(null, signingBytes, signer, Buffer.from(vector.signature, 'base64url')), true);
  assert.equal(verifyKeyRetirementClosureSignature(parsed.value, signer), true);
  assert.equal(verifyKeyRetirementClosureSignature(parsed.value, publicOf(vector.body.retiredKeyId)), false, 'not under the retired key');
  assert.deepEqual(assembleKeyRetirementClosure(body, vector.signature, signer), fileOf(vector));
  assert.deepEqual(createKeyRetirementClosure({ ...inputOf(vector.body), privateKey: fromSeed(KEY_B.seedHex) }), fileOf(vector), 'K1 (Node) = OpenSSL');
  // it covers G1–G2: retired = the key of G1 and G2, head = G2; G3 (another, active key) extends after the head
  assert.equal(vector.body.retiredKeyId, GOLDEN.g2.body.keyId);
  assert.equal(vector.body.signerKeyId, GOLDEN.g3.body.keyId);
  assert.deepEqual(vector.body.heads, [{ auditId: GOLDEN.g2.body.auditId, seq: 2, sealSha256: GOLDEN.g2.sealSha256 }]);

  const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  assert.equal(pretty(parsed.value), bytes.toString('utf8'), 'the delivered bytes are this exact pretty form');
  for (const [where, text] of oneByteTexts(fileOf(vector), pretty)) {
    const changed = Buffer.from(text, 'utf8');
    assert.notEqual(sha256(changed), vector.closureSha256, `${where}: the pin refuses it`);
    const reparsed = parseKeyRetirementClosureText(changed);
    assert.ok(!reparsed.ok || !verifyKeyRetirementClosureSignature(reparsed.value, signer), `${where}: the signature refuses it too`);
  }
});
