import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import test from 'node:test';
import {
  assembleEvidenceSealV2,
  assembleKeyRetirementClosure,
  buildEvidenceSealBodyV2,
  buildKeyRetirementClosureBody,
  createEvidenceSeal,
  createEvidenceSealV2,
  createKeyRetirementClosure,
  EvidenceSealError,
  MAX_CHAIN_SEALS,
  MAX_CLOSURE_BYTES,
  MAX_CLOSURE_HEADS,
  MAX_SEAL_BYTES,
  parseEvidenceSealV2Text,
  parseKeyRetirementClosureText,
  parseTrustKeys,
  sealSha256,
  verifyEd25519PureSignature,
  verifyEvidenceSealV2Signature,
  verifyKeyRetirementClosureSignature,
  type EvidenceSealBodyV2,
  type EvidenceSealErrorCode,
  type EvidenceSealFile,
  type EvidenceSealFileV2,
  type SealTextIssue,
  type SealTextParse,
} from '../src/lib/link-audit-evidence/provenance';

/*
 * W3.1 — manifest `v2` primitives (contract `docs/phase6-auditoria-link/p1-contrato-verificador-v2.md` §2, §6, §11).
 * Covers V2-02 (strict schema, RS-09/RS-10), V2-14 (`sealSha256`), V2-36 (external assembly, D5/RS-15), V2-37 (OpenSSL interop, RS-15/IA-22)
 * and V2-45 (raw text and closure limits, N6). The verifier (`classify`), the chain, the keyring and revocation are W3.2–W3.5.
 *
 * INDEPENDENT FIXTURES. Every expected value below was produced ONCE, offline, on 19/11/2026, by the author of this slice, WITHOUT the code under
 * test (contract §11 item 2). The tests only READ them; never regenerate them with `provenance.ts`.
 *  - Test seeds (fabricated, never used outside tests): A = bytes 0x00..0x1f, B = bytes 0x20..0x3f. Each one was wrapped as PKCS#8 DER
 *    (prefix 302e020100300506032b657004220420 + seed) into a scratch file `<seed>.der` (deleted; nothing PEM/PKCS#8 is committed).
 *  - Canonical text: Python 3.14 `json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)` over the inputs `V2_INPUT`,
 *    the v1 body with the same `auditId/seq/sealedAt/keyId/entries`, and `CLOSURE_INPUT` (all data is ASCII, so this equals `canonicalJson`).
 *  - Signatures (Ed25519 pure, no pre-hash, no context): `openssl pkeyutl -sign -inkey <seed>.der -keyform DER -rawin -in <canonical text file>`
 *    (OpenSSL 3.5.5), then base64url without padding. Seed A signs the v2 and v1 bodies; seed B signs the closure.
 *  - Public keys (trust-list format): `openssl pkey -inform DER -in <seed>.der -pubout -outform DER`, last 32 bytes, base64url.
 *  - Seal hashes: `sha256sum` of the canonical text of the FULL file (body + `signature`).
 *  - Cross-check: each public key and signature was recomputed with a pure-Python RFC 8032 §6 reference implementation (itself checked against
 *    RFC 8032 §7.1 TEST 1) and matched OpenSSL byte for byte.
 */
const SEED_A_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const SEED_B_HEX = '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f';
const PUBLIC_RAW_A = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
const PUBLIC_RAW_B = 'Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc';
const CANONICAL_V2_BODY =
  '{"auditId":"auditoria-prova-v2-01","dossier":{"id":"dossie-prova-v2-01","sha256":"89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567"},"entries":[{"contentSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","ref":"capture:c0001"},{"contentSha256":"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210","ref":"report:c0001-r0001"}],"keyId":"ek-teste-v2-a","kind":"LINK_AUDIT_EVIDENCE_SEAL","prevSealSha256":null,"schemaVersion":2,"sealedAt":"2026-11-19T12:00:00.000Z","seq":1}';
const SIG_V2 = 'eSqtIT_XunuXhO9UJp5GaRaCZMxD9xFW1c8JQJC8H8a85W3EIJ25j1NWw3z-aFqPj-50FSOsLRp63EN2v1rZBg';
const SEAL_SHA256_V2 = 'bdb090db810cae2706bc01abd3846afd64329f0242b34a73142486704968b2bd';
const CANONICAL_V1_BODY =
  '{"auditId":"auditoria-prova-v2-01","entries":[{"contentSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","ref":"capture:c0001"},{"contentSha256":"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210","ref":"report:c0001-r0001"}],"keyId":"ek-teste-v2-a","kind":"LINK_AUDIT_EVIDENCE_SEAL","schemaVersion":1,"sealedAt":"2026-11-19T12:00:00.000Z","seq":1}';
const SIG_V1 = 'FQIV0I2f8Sf3yTaXZXXxXZeHs7E_C_Z_Xn_c3LZrOCXOixVufja7NnLyyf5akbvSzz6hGj2YJ6I-HDcrLOddBA';
const SEAL_SHA256_V1 = '3cc40c3e79a3da2f985573f356339122a39f9f7b490a2dc9eff86f7eafc92208';
const CANONICAL_CLOSURE_BODY =
  '{"heads":[{"auditId":"auditoria-prova-v2-00","sealSha256":"13579bdf02468ace13579bdf02468ace13579bdf02468ace13579bdf02468ace","seq":2},{"auditId":"auditoria-prova-v2-01","sealSha256":"bdb090db810cae2706bc01abd3846afd64329f0242b34a73142486704968b2bd","seq":1}],"kind":"LINK_AUDIT_KEY_RETIREMENT_CLOSURE","retiredKeyId":"ek-teste-v2-a","schemaVersion":1,"sealedAt":"2026-11-20T09:30:00.000Z","signerKeyId":"ek-teste-v2-b"}';
const SIG_CLOSURE = 'QOphWPOfMXH7DviQa8D-nQ98onQeAyaL5un-oDJvakhjHvAQpGfu6kUndXhlbs3TLH-Hatb6AwWSnCGwYjhGBA';

/* --------------------------------------------------------------------------------------------------- inputs (fabricated) */

const KEY_ID_A = 'ek-teste-v2-a';
const KEY_ID_B = 'ek-teste-v2-b';
const AUDIT = 'auditoria-prova-v2-01';
const CAPTURE = { ref: 'capture:c0001', contentSha256: '0123456789abcdef'.repeat(4) };
const REPORT = { ref: 'report:c0001-r0001', contentSha256: 'fedcba9876543210'.repeat(4) };
/** Entries deliberately OUT of order: the builder sorts them like v1. */
const V2_INPUT = { auditId: AUDIT, seq: 1, sealedAt: '2026-11-19T12:00:00.000Z', keyId: KEY_ID_A, entries: [REPORT, CAPTURE], dossier: { id: 'dossie-prova-v2-01', sha256: '89abcdef01234567'.repeat(4) }, prevSealSha256: null };
const HEAD_00 = { auditId: 'auditoria-prova-v2-00', seq: 2, sealSha256: '13579bdf02468ace'.repeat(4) };
const HEAD_01 = { auditId: AUDIT, seq: 1, sealSha256: SEAL_SHA256_V2 };
/** Heads deliberately OUT of order: the builder sorts them by `auditId`. */
const CLOSURE_INPUT = { retiredKeyId: KEY_ID_A, signerKeyId: KEY_ID_B, sealedAt: '2026-11-20T09:30:00.000Z', heads: [HEAD_01, HEAD_00] };

/* --------------------------------------------------------------------------------------------------- helpers */

type Json = Record<string, unknown>;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** Test-only private key assembled in memory from a fixed seed (never PEM/PKCS#8 text in the repository). */
const fromSeed = (seedHex: string): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
/** "Simulated device" (K2 stand-in): it holds its own private key and only returns a signature over the bytes it is handed. */
function simulatedDevice(seedHex: string): { readonly sign: (bytes: Uint8Array) => string } {
  const held = fromSeed(seedHex);
  return { sign: (bytes) => cryptoSign(null, bytes, held).toString('base64url') };
}
function fromTrustList(id: string, raw: string): KeyObject {
  const keys = parseTrustKeys(`${id}:${raw}`);
  assert.ok(keys, 'the fixture public key is accepted in the trust-list format');
  return keys.get(id) as KeyObject;
}
const PUB_A = fromTrustList(KEY_ID_A, PUBLIC_RAW_A);
const PUB_B = fromTrustList(KEY_ID_B, PUBLIC_RAW_B);

const v2File = (): Json => ({ ...(JSON.parse(CANONICAL_V2_BODY) as Json), signature: SIG_V2 });
const v1File = (): Json => ({ ...(JSON.parse(CANONICAL_V1_BODY) as Json), signature: SIG_V1 });
const closureFile = (): Json => ({ ...(JSON.parse(CANONICAL_CLOSURE_BODY) as Json), signature: SIG_CLOSURE });
const utf8 = (value: unknown): Buffer => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const textOf = (value: unknown): string => JSON.stringify(value);

function rejectedWith<T>(result: SealTextParse<T>, issue: SealTextIssue, label: string): void {
  assert.deepEqual(result, { ok: false, reason: 'SEAL_INVALID', issue }, label);
}
function accepted<T>(result: SealTextParse<T>, label: string): T {
  assert.ok(result.ok, `${label}: ${JSON.stringify(result)}`);
  return result.value;
}

/** Throws `EvidenceSealError(code)`, returns nothing and the error carries no key or signature material. */
function assertRefused(run: () => unknown, code: EvidenceSealErrorCode, label: string, material: readonly string[] = []): void {
  let returned: unknown;
  assert.throws(
    () => {
      returned = run();
    },
    (error: unknown) => {
      assert.ok(error instanceof EvidenceSealError, `${label}: typed error`);
      assert.equal(error.code, code, label);
      const visible = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
      for (const item of [PUBLIC_RAW_A, PUBLIC_RAW_B, SIG_V2, SIG_V1, SIG_CLOSURE, ...material]) assert.ok(!visible.includes(item), `${label}: the error leaks key/signature material`);
      return true;
    },
    label,
  );
  assert.equal(returned, undefined, `${label}: nothing is returned`);
}

/** RFC 8032 §5.1: order L of the Ed25519 base point. */
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
/** Same signature with S replaced by S + L (still < 2^256): the classic Ed25519 malleability. */
function withScalarPlusL(signature: string): string {
  const raw = Buffer.from(signature, 'base64url');
  let scalar = 0n;
  for (let i = 63; i >= 32; i -= 1) scalar = (scalar << 8n) | BigInt(raw[i] as number);
  let shifted = scalar + ED25519_L;
  for (let i = 32; i < 64; i += 1) {
    raw[i] = Number(shifted & 0xffn);
    shifted >>= 8n;
  }
  return raw.toString('base64url');
}
/** Same 64 decoded bytes, different text: the last base64url char carries 2 data bits plus 4 bits that must be zero. */
function nonCanonicalVariant(signature: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return signature.slice(0, -1) + (alphabet[alphabet.indexOf(signature.slice(-1)) | 1] as string);
}
const reversedKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reversedKeys)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reversedKeys(child)]))
      : value;
/** Formatting variants of the SAME logical file (whitespace, line endings, key order). */
const FORMATS: ReadonlyArray<readonly [string, (file: Json) => string]> = [
  ['compact', (file) => JSON.stringify(file)],
  ['reversed key order', (file) => JSON.stringify(reversedKeys(file))],
  ['pretty, 2 spaces, LF', (file) => `${JSON.stringify(file, null, 2)}\n`],
  ['tabs, CRLF, reversed keys', (file) => `\r\n${JSON.stringify(reversedKeys(file), null, '\t').replace(/\n/g, '\r\n')}\r\n`],
  ['padded with blanks', (file) => `   ${JSON.stringify(file, null, 1)}   \n\n`],
];

/* ============================================================================================ V2-02: strict schema */

test('V2-02 positive control: the independent v2 fixture parses under the strict schema', () => {
  const parsed = accepted(parseEvidenceSealV2Text(utf8(v2File())), 'fixture');
  assert.deepEqual(parsed, v2File());
  // the schema does NOT judge `prevSealSha256` against `seq`: that incoherence is SEAL_CHAIN_BROKEN in the chain walk (contract §3 item 3,
  // §8 row 11, V2-11; W3.3), never SEAL_INVALID. Locked here so the schema cannot silently take that verdict over.
  accepted(parseEvidenceSealV2Text(utf8({ ...v2File(), prevSealSha256: 'ab'.repeat(32) })), 'seq 1 with prev (chain rule, not schema)');
  accepted(parseEvidenceSealV2Text(utf8({ ...v2File(), seq: 2 })), 'seq 2 with prev null (chain rule, not schema)');
  // an all-zero signature is well-FORMED (canonical, S = 0 < L): the schema checks format, the signature is checked against the key
  accepted(parseEvidenceSealV2Text(utf8({ ...v2File(), signature: 'A'.repeat(86) })), 'format-valid signature');
});

test('V2-02 strict schema: an unknown, missing or mistyped field is SEAL_INVALID', () => {
  for (const extra of [{ extra: 1 }, { source: 'LIVE' }, { signature2: SIG_V2 }]) rejectedWith(parseEvidenceSealV2Text(utf8({ ...v2File(), ...extra })), 'SCHEMA', `extra ${Object.keys(extra)[0]}`);
  const withSource = v2File();
  withSource.entries = [{ ...CAPTURE, source: 'LIVE' }, REPORT]; // `entries[].source` is NOT adopted (contract §1; RS-10): it needs v3
  rejectedWith(parseEvidenceSealV2Text(utf8(withSource)), 'SCHEMA', 'entries[].source');
  const dossierExtra = v2File();
  dossierExtra.dossier = { id: 'dossie-prova-v2-01', sha256: '89abcdef01234567'.repeat(4), operator: 'Pessoa Ficticia' };
  rejectedWith(parseEvidenceSealV2Text(utf8(dossierExtra)), 'SCHEMA', 'dossier extra');
  const proto = textOf(v2File()).replace(/^\{/, '{"__proto__":{"schemaVersion":2},');
  assert.ok(Object.keys(JSON.parse(proto) as Json).includes('__proto__'), 'JSON.parse keeps "__proto__" as an own key');
  rejectedWith(parseEvidenceSealV2Text(utf8(proto)), 'SCHEMA', '__proto__');
  for (const field of Object.keys(v2File())) {
    const missing = v2File();
    delete missing[field];
    rejectedWith(parseEvidenceSealV2Text(utf8(missing)), 'SCHEMA', `missing ${field}`);
  }
  for (const field of ['id', 'sha256']) {
    const missing = v2File();
    const dossier = { ...(missing.dossier as Json) };
    delete dossier[field];
    missing.dossier = dossier;
    rejectedWith(parseEvidenceSealV2Text(utf8(missing)), 'SCHEMA', `missing dossier.${field}`);
  }
  for (const entry of [{ ref: CAPTURE.ref }, { contentSha256: CAPTURE.contentSha256 }]) rejectedWith(parseEvidenceSealV2Text(utf8({ ...v2File(), entries: [entry] })), 'SCHEMA', `entry ${JSON.stringify(entry)}`);
  const mistyped: ReadonlyArray<readonly [string, unknown]> = [
    ['schemaVersion', 1],
    ['schemaVersion', 3],
    ['schemaVersion', '2'],
    ['kind', 'LINK_AUDIT_KEY_RETIREMENT_CLOSURE'],
    ['kind', 'link_audit_evidence_seal'],
    ['auditId', 'AUDITORIA-PROVA-V2-01'],
    ['auditId', 'curto'],
    ['auditId', '../auditoria-prova'],
    ['auditId', ' auditoria-prova-v2-01'],
    ['auditId', 7],
    ['seq', '1'],
    ['seq', 1.5],
    ['seq', -1],
    ['seq', null],
    ['seq', true],
    ['sealedAt', '2026-11-19T12:00:00Z'],
    ['sealedAt', '2026-11-19 12:00:00.000Z'],
    ['sealedAt', 0],
    ['keyId', 'EK-TESTE-V2-A'],
    ['keyId', 'ek'],
    ['keyId', null],
    ['entries', {}],
    ['entries', []],
    ['entries', 'capture:c0001'],
    ['dossier', null],
    ['dossier', 'dossie-prova-v2-01'],
    ['dossier', []],
    ['prevSealSha256', ''],
    ['prevSealSha256', 0],
    ['prevSealSha256', false],
    ['prevSealSha256', 'null'],
    ['prevSealSha256', 'a'.repeat(63)],
    ['signature', null],
    ['signature', 64],
  ];
  for (const [field, value] of mistyped) rejectedWith(parseEvidenceSealV2Text(utf8({ ...v2File(), [field]: value })), 'SCHEMA', `${field} = ${JSON.stringify(value)}`);
  for (const notObject of ['[]', 'null', '1', '"seal"', 'true']) rejectedWith(parseEvidenceSealV2Text(utf8(notObject)), 'SCHEMA', `top level ${notObject}`);
});

test('V2-02 seq bounds: 0, 257 and 9999 are SEAL_INVALID; 1 to 256 are accepted', () => {
  assert.equal(MAX_CHAIN_SEALS, 256);
  for (const seq of [0, 257, 9999]) rejectedWith(parseEvidenceSealV2Text(utf8({ ...v2File(), seq })), 'SCHEMA', `seq ${seq}`);
  for (const seq of [1, 2, 256]) accepted(parseEvidenceSealV2Text(utf8({ ...v2File(), seq })), `seq ${seq}`);
});

test('V2-02 entries: unordered or repeated refs, uppercase hashes and 0 or 2001 items are SEAL_INVALID', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['unordered', [REPORT, CAPTURE]],
    ['repeated entry', [CAPTURE, CAPTURE, REPORT]],
    ['repeated ref, other hash', [CAPTURE, { ...CAPTURE, contentSha256: 'f'.repeat(64) }, REPORT]],
    ['uppercase contentSha256', [{ ...CAPTURE, contentSha256: CAPTURE.contentSha256.toUpperCase() }, REPORT]],
    ['ref outside REF', [{ ...CAPTURE, ref: 'capture:c1' }]],
    ['ref uppercase', [{ ...CAPTURE, ref: 'CAPTURE:c0001' }]],
    ['ref with blank', [{ ...CAPTURE, ref: 'capture:c0001 ' }]],
  ];
  for (const [label, entries] of cases) rejectedWith(parseEvidenceSealV2Text(utf8({ ...v2File(), entries })), 'SCHEMA', label);
  rejectedWith(parseEvidenceSealV2Text(utf8({ ...v2File(), prevSealSha256: 'AB'.repeat(32) })), 'SCHEMA', 'uppercase prevSealSha256');
  rejectedWith(parseEvidenceSealV2Text(utf8({ ...v2File(), dossier: { id: 'dossie-prova-v2-01', sha256: '89ABCDEF01234567'.repeat(4) } })), 'SCHEMA', 'uppercase dossier.sha256');
  const refs = (count: number) => Array.from({ length: count }, (_, index) => ({ ref: `capture:c${String(index + 1).padStart(4, '0')}`, contentSha256: 'c'.repeat(64) }));
  accepted(parseEvidenceSealV2Text(utf8({ ...v2File(), entries: refs(2000) })), '2000 entries');
  const tooMany = utf8({ ...v2File(), entries: refs(2001) });
  assert.ok(tooMany.byteLength < MAX_SEAL_BYTES, '2001 entries still fit in the byte limit: the refusal is by count');
  rejectedWith(parseEvidenceSealV2Text(tooMany), 'SCHEMA', '2001 entries');
});

test('V2-02 dossier: a malformed id or sha256 is SEAL_INVALID', () => {
  const withDossier = (id: unknown, sha256: unknown = '89abcdef01234567'.repeat(4)) => utf8({ ...v2File(), dossier: { id, sha256 } });
  for (const id of ['ab', 'a'.repeat(65), '-dossie', '.dossie', '_dossie', 'Dossie-prova', 'dossiê-prova', 'dossie prova', 'ana@exemplo.invalid', '', 12]) rejectedWith(parseEvidenceSealV2Text(withDossier(id)), 'SCHEMA', `dossier.id ${JSON.stringify(id)}`);
  for (const sha256 of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), null]) rejectedWith(parseEvidenceSealV2Text(withDossier('dossie-prova-v2-01', sha256)), 'SCHEMA', `dossier.sha256 ${JSON.stringify(sha256)}`);
  for (const id of ['abc', 'a'.repeat(64), 'dossie.2026-11_19', '0dossie']) accepted(parseEvidenceSealV2Text(withDossier(id)), `dossier.id ${id}`);
});

test('V2-02 signature: wrong length, padding, non-canonical base64url and S+L are SEAL_INVALID', () => {
  const bodyBytes = utf8(CANONICAL_V2_BODY);
  const variant = nonCanonicalVariant(SIG_V2);
  assert.notEqual(variant, SIG_V2);
  assert.ok(Buffer.from(variant, 'base64url').equals(Buffer.from(SIG_V2, 'base64url')), 'the variant decodes to the SAME 64 bytes');
  assert.equal(cryptoVerify(null, bodyBytes, PUB_A, Buffer.from(variant, 'base64url')), true, 'so only the text check can refuse it');
  const plusL = withScalarPlusL(SIG_V2);
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['85 chars', SIG_V2.slice(0, 85)],
    ['87 chars', `${SIG_V2}A`],
    ['padded', `${SIG_V2}==`],
    ['standard base64 alphabet', SIG_V2.replace(/-/g, '+').replace(/_/g, '/')],
    ['non-canonical last char', variant],
    ['S + L', plusL],
    ['empty', ''],
  ];
  for (const [label, signature] of cases) {
    rejectedWith(parseEvidenceSealV2Text(utf8({ ...v2File(), signature })), 'SCHEMA', label);
    assert.equal(verifyEd25519PureSignature(bodyBytes, signature, PUB_A), false, `${label}: the pure verification refuses it too`);
  }
  assert.equal(verifyEd25519PureSignature(bodyBytes, SIG_V2, PUB_A), true, 'positive control');
});

test('V2-02 raw text: a duplicate JSON key, invalid UTF-8, a BOM, an oversize or non-JSON text is SEAL_INVALID', () => {
  const text = textOf(v2File());
  const duplicates: ReadonlyArray<readonly [string, string]> = [
    ['top-level seq', text.replace(/^\{/, '{"seq":2,')],
    ['dossier.id', text.replace('"dossier":{', '"dossier":{"id":"dossie-forjado",')],
    ['entries[0].ref', text.replace('[{"contentSha256":', '[{"ref":"capture:c0009","contentSha256":')],
  ];
  for (const [label, duplicated] of duplicates) {
    assert.deepEqual(JSON.parse(duplicated), v2File(), `${label}: JSON.parse silently keeps the last value`);
    rejectedWith(parseEvidenceSealV2Text(utf8(duplicated)), 'DUPLICATE_KEY', label);
  }
  // a VALUE equal to a key name, at the same or another level, is not a duplicate key
  accepted(parseEvidenceSealV2Text(utf8({ ...v2File(), auditId: 'signature', keyId: 'entries', dossier: { id: 'dossier', sha256: '89abcdef01234567'.repeat(4) } })), 'values equal to key names');

  const raw = utf8(text);
  const at = raw.indexOf('dossie-prova-v2-01') + 6;
  const splice = (bytes: readonly number[]) => Buffer.concat([raw.subarray(0, at), Buffer.from(bytes), raw.subarray(at)]);
  for (const bytes of [[0xff], [0xc0, 0xaf], [0x80], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xf8, 0x88, 0x80, 0x80, 0x80]]) rejectedWith(parseEvidenceSealV2Text(splice(bytes)), 'NOT_UTF8', `bytes ${Buffer.from(bytes).toString('hex')}`);
  rejectedWith(parseEvidenceSealV2Text(splice([0xc3, 0xaa])), 'SCHEMA', 'valid UTF-8 non-ASCII reaches the schema (all v2 fields are ASCII)');

  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(withBom)), v2File(), 'a default decoder strips the BOM silently');
  rejectedWith(parseEvidenceSealV2Text(withBom), 'BOM', 'UTF-8 BOM');
  rejectedWith(parseEvidenceSealV2Text(Buffer.concat([Buffer.from([0xff, 0xfe]), raw])), 'NOT_UTF8', 'UTF-16 BOM');

  accepted(parseEvidenceSealV2Text(utf8(text.padEnd(MAX_SEAL_BYTES, ' '))), 'exactly MAX_SEAL_BYTES');
  rejectedWith(parseEvidenceSealV2Text(utf8(text.padEnd(MAX_SEAL_BYTES + 1, ' '))), 'TOO_LARGE', 'MAX_SEAL_BYTES + 1');
  for (const broken of ['', ' ', '{', `${text}}`, `${text}{}`, text.slice(0, -1), "{'seq':1}"]) rejectedWith(parseEvidenceSealV2Text(utf8(broken)), 'NOT_JSON', `not JSON: ${broken.slice(0, 12)}`);
});

test('V2-02 / V2-36 the builders apply the same strict schema and never emit what the verifier refuses', () => {
  for (const [label, over] of [
    ['seq 257', { seq: 257 }],
    ['repeated ref', { entries: [CAPTURE, CAPTURE] }],
    ['no entries', { entries: [] }],
    ['dossier id', { dossier: { id: 'Dossie', sha256: 'a'.repeat(64) } }],
    ['uppercase prev', { seq: 2, prevSealSha256: 'A'.repeat(64) }],
    // producer-only coherence (contract §2 "null if and only if seq = 1"): the verifier judges it as SEAL_CHAIN_BROKEN (W3.3)
    ['seq 1 with prev', { prevSealSha256: 'a'.repeat(64) }],
    ['seq 2 without prev', { seq: 2 }],
  ] as const) {
    assertRefused(() => buildEvidenceSealBodyV2({ ...V2_INPUT, ...over }), 'SCHEMA_INVALID', `build: ${label}`);
    assertRefused(() => createEvidenceSealV2({ ...V2_INPUT, ...over, privateKey: fromSeed(SEED_A_HEX) }), 'SCHEMA_INVALID', `create: ${label}`);
  }
  const chained = buildEvidenceSealBodyV2({ ...V2_INPUT, seq: 2, prevSealSha256: SEAL_SHA256_V2 });
  assert.equal(chained.body.prevSealSha256, SEAL_SHA256_V2);
  for (const [label, over] of [
    ['signer = retired', { signerKeyId: KEY_ID_A }],
    ['repeated auditId', { heads: [HEAD_01, HEAD_01] }],
    ['head seq 0', { heads: [{ auditId: AUDIT, seq: 0, sealSha256: SEAL_SHA256_V2 }] }],
  ] as const) assertRefused(() => buildKeyRetirementClosureBody({ ...CLOSURE_INPUT, ...over }), 'SCHEMA_INVALID', `closure: ${label}`);
});

/* ============================================================================================ V2-14: sealSha256 */

test('V2-14 sealSha256 is the SHA-256 of the canonical full file and does not depend on formatting or key order (v2)', () => {
  for (const [label, format] of FORMATS) {
    const parsed = accepted(parseEvidenceSealV2Text(utf8(format(v2File()))), label);
    assert.equal(sealSha256(parsed), SEAL_SHA256_V2, `${label}: hash`);
    assert.equal(verifyEvidenceSealV2Signature(parsed, PUB_A), true, `${label}: authentication does not depend on formatting either`);
  }
  assert.equal(sealSha256(createEvidenceSealV2({ ...V2_INPUT, privateKey: fromSeed(SEED_A_HEX) })), SEAL_SHA256_V2, 'K1 output hashes to the independent value');
  // the hash covers the signature and every signed field
  const otherSigner = { ...v2File(), signature: simulatedDevice(SEED_B_HEX).sign(utf8(CANONICAL_V2_BODY)) } as unknown as EvidenceSealFileV2;
  assert.notEqual(sealSha256(otherSigner), SEAL_SHA256_V2, 'another signature, another hash');
  assert.notEqual(sealSha256({ ...v2File(), sealedAt: '2026-11-19T12:00:00.001Z' } as unknown as EvidenceSealFileV2), SEAL_SHA256_V2, 'another sealedAt, another hash');
});

test('V2-14 v1 and v2 with the same logical content have different hashes; the v1 hash is formatting-independent too', () => {
  const k1v1 = createEvidenceSeal({ auditId: AUDIT, seq: 1, sealedAt: V2_INPUT.sealedAt, keyId: KEY_ID_A, privateKey: fromSeed(SEED_A_HEX), entries: [REPORT, CAPTURE] });
  assert.deepEqual(k1v1, v1File(), 'the unchanged v1 producer matches the OpenSSL fixture (same seed, deterministic Ed25519)');
  for (const [label, format] of FORMATS) assert.equal(sealSha256(JSON.parse(format(v1File())) as EvidenceSealFile), SEAL_SHA256_V1, `v1 ${label}`);
  assert.equal(sealSha256(k1v1), SEAL_SHA256_V1);
  assert.notEqual(SEAL_SHA256_V1, SEAL_SHA256_V2);
  assert.notEqual(sealSha256(k1v1), sealSha256(createEvidenceSealV2({ ...V2_INPUT, privateKey: fromSeed(SEED_A_HEX) })), '`schemaVersion` is inside the hash: v1 and v2 never collide');
});

test('V2-14 sealSha256 is computed only AFTER the strict parse (v1 or v2): anything else is refused', () => {
  const refused: ReadonlyArray<readonly [string, unknown]> = [
    ['v2 with an extra field', { ...v2File(), extra: 1 }],
    ['v2 without signature', JSON.parse(CANONICAL_V2_BODY)],
    ['v2 non-canonical signature', { ...v2File(), signature: nonCanonicalVariant(SIG_V2) }],
    ['v2 S + L', { ...v2File(), signature: withScalarPlusL(SIG_V2) }],
    ['schemaVersion 3', { ...v2File(), schemaVersion: 3 }],
    ['v1 carrying v2 fields', { ...v1File(), dossier: { id: 'dossie-prova-v2-01', sha256: 'a'.repeat(64) }, prevSealSha256: null }],
    ['v1 non-canonical signature', { ...v1File(), signature: nonCanonicalVariant(SIG_V1) }],
    ['v1 unordered entries', { ...v1File(), entries: [REPORT, CAPTURE] }],
    ['null', null],
    ['array', [v2File()]],
  ];
  for (const [label, file] of refused) assertRefused(() => sealSha256(file as EvidenceSealFileV2), 'SCHEMA_INVALID', label);
});

/* ============================================================================================ V2-36: external assembly */

test('V2-36 external assembly: signingBytes signed by a simulated device give a file bit-for-bit identical to K1', () => {
  const { body, signingBytes } = buildEvidenceSealBodyV2(V2_INPUT);
  assert.equal(signingBytes.toString('utf8'), CANONICAL_V2_BODY, 'signed bytes = canonical body, exact field set, without `signature`');
  assert.deepEqual(body.entries, [CAPTURE, REPORT], 'entries sorted by ref like v1');
  const external = assembleEvidenceSealV2(body, simulatedDevice(SEED_A_HEX).sign(signingBytes), PUB_A);
  const k1 = createEvidenceSealV2({ ...V2_INPUT, privateKey: fromSeed(SEED_A_HEX) });
  assert.ok(utf8(external).equals(utf8(k1)), 'external and K1 serialize to the same bytes');
  assert.ok(utf8(k1).equals(utf8(createEvidenceSealV2({ ...V2_INPUT, privateKey: fromSeed(SEED_A_HEX) }))), 'K1 is deterministic');
  assert.deepEqual(external, v2File(), 'and both equal the OpenSSL-signed fixture');
  assert.equal(external.signature, SIG_V2);
  // the producer can hand the assembled file to the parser as is
  assert.deepEqual(accepted(parseEvidenceSealV2Text(utf8(external)), 'round trip'), external);
});

test('V2-36 a wrong signature is a typed EvidenceSealError: nothing is returned and no key material leaks', () => {
  const { body, signingBytes } = buildEvidenceSealBodyV2(V2_INPUT);
  const device = simulatedDevice(SEED_A_HEX);
  const good = device.sign(signingBytes);
  const flipped = Buffer.from(good, 'base64url');
  flipped[5] = (flipped[5] as number) ^ 0x01;
  const otherBody = buildEvidenceSealBodyV2({ ...V2_INPUT, seq: 2, prevSealSha256: SEAL_SHA256_V2 });
  const wrong: ReadonlyArray<readonly [string, string]> = [
    ['signed by another key', simulatedDevice(SEED_B_HEX).sign(signingBytes)],
    ['signed by a random key', cryptoSign(null, signingBytes, generateKeyPairSync('ed25519').privateKey).toString('base64url')],
    ['over other bytes', device.sign(otherBody.signingBytes)],
    ['the v1 signature of the same key', SIG_V1],
    ['one bit flipped', flipped.toString('base64url')],
    ['all zero', 'A'.repeat(86)],
    ['S + L', withScalarPlusL(good)],
    ['non-canonical text', nonCanonicalVariant(good)],
    ['85 chars', good.slice(0, 85)],
    ['empty', ''],
  ];
  for (const [label, signature] of wrong) assertRefused(() => assembleEvidenceSealV2(body, signature, PUB_A), 'SIGNATURE_DOES_NOT_VERIFY', label, [good]);
  assertRefused(() => assembleEvidenceSealV2(body, good, PUB_B), 'SIGNATURE_DOES_NOT_VERIFY', 'verified with another public key', [good]);
  // assemble recomputes the signed bytes from the body it receives: a body changed after the device signed is refused
  const tampered: EvidenceSealBodyV2 = { ...body, entries: [CAPTURE, { ...REPORT, contentSha256: 'e'.repeat(64) }] };
  assertRefused(() => assembleEvidenceSealV2(tampered, good, PUB_A), 'SIGNATURE_DOES_NOT_VERIFY', 'tampered body', [good]);
  assertRefused(() => assembleEvidenceSealV2({ ...body, keyId: KEY_ID_B }, good, PUB_A), 'SIGNATURE_DOES_NOT_VERIFY', 'other keyId', [good]);
  // never a private key, never a non-Ed25519 key, never a body outside the schema
  assertRefused(() => assembleEvidenceSealV2(body, good, fromSeed(SEED_A_HEX)), 'PUBLIC_KEY_INVALID', 'private key handed to assemble', [good]);
  assertRefused(() => assembleEvidenceSealV2(body, good, generateKeyPairSync('ed448').publicKey), 'PUBLIC_KEY_INVALID', 'Ed448 public key', [good]);
  assertRefused(() => assembleEvidenceSealV2({ ...body, signature: good } as unknown as EvidenceSealBodyV2, good, PUB_A), 'SCHEMA_INVALID', 'signature inside the body', [good]);
  assertRefused(() => assembleEvidenceSealV2({ ...body, extra: 1 } as unknown as EvidenceSealBodyV2, good, PUB_A), 'SCHEMA_INVALID', 'extra field', [good]);
  assert.equal(assembleEvidenceSealV2(body, good, PUB_A).signature, good, 'positive control');
});

test('V2-36 the same holds for the retirement closure: external = K1 bit for bit, wrong signature refused', () => {
  const { body, signingBytes } = buildKeyRetirementClosureBody(CLOSURE_INPUT);
  assert.equal(signingBytes.toString('utf8'), CANONICAL_CLOSURE_BODY, 'signed bytes = canonical closure body');
  assert.deepEqual(body.heads.map((head) => head.auditId), ['auditoria-prova-v2-00', AUDIT], 'heads sorted by auditId');
  const signer = simulatedDevice(SEED_B_HEX);
  const external = assembleKeyRetirementClosure(body, signer.sign(signingBytes), PUB_B);
  const k1 = createKeyRetirementClosure({ ...CLOSURE_INPUT, privateKey: fromSeed(SEED_B_HEX) });
  assert.ok(utf8(external).equals(utf8(k1)), 'external and K1 closures serialize to the same bytes');
  assert.deepEqual(external, closureFile());
  const good = external.signature;
  for (const [label, signature] of [
    ['signed by the RETIRED key itself', simulatedDevice(SEED_A_HEX).sign(signingBytes)],
    ['one char changed', `${good.slice(0, 10)}${good[10] === 'A' ? 'B' : 'A'}${good.slice(11)}`],
    ['S + L', withScalarPlusL(good)],
    ['non-canonical text', nonCanonicalVariant(good)],
  ] as const) assertRefused(() => assembleKeyRetirementClosure(body, signature, PUB_B), 'SIGNATURE_DOES_NOT_VERIFY', `closure: ${label}`, [good]);
  assertRefused(() => assembleKeyRetirementClosure({ ...body, heads: body.heads.slice(1) }, good, PUB_B), 'SIGNATURE_DOES_NOT_VERIFY', 'closure: head removed after signing', [good]);
  assertRefused(() => assembleKeyRetirementClosure(body, good, fromSeed(SEED_B_HEX)), 'PUBLIC_KEY_INVALID', 'closure: private key', [good]);
});

/* ============================================================================================ V2-37: OpenSSL interop */

test('V2-37 an Ed25519 pure signature produced OUTSIDE Node (OpenSSL) over signingBytes verifies with crypto.verify(null, …) and the trust-list key', () => {
  const { body, signingBytes } = buildEvidenceSealBodyV2(V2_INPUT);
  assert.ok(signingBytes.equals(utf8(CANONICAL_V2_BODY)), 'the bytes OpenSSL signed are exactly the builder output');
  assert.equal(cryptoVerify(null, signingBytes, PUB_A, Buffer.from(SIG_V2, 'base64url')), true, 'crypto.verify(null, …) accepts the OpenSSL signature');
  assert.equal(verifyEd25519PureSignature(signingBytes, SIG_V2, PUB_A), true);
  assert.deepEqual(assembleEvidenceSealV2(body, SIG_V2, PUB_A), v2File(), 'external assembly with the OpenSSL signature');
  assert.equal(verifyEvidenceSealV2Signature(accepted(parseEvidenceSealV2Text(utf8(v2File())), 'fixture'), PUB_A), true);
  const derived = createPublicKey(fromSeed(SEED_A_HEX)).export({ format: 'der', type: 'spki' });
  assert.equal(Buffer.from(derived.subarray(derived.length - 32)).toString('base64url'), PUBLIC_RAW_A, 'Node and OpenSSL derive the same public key from the seed');
  // and it does not verify under another key, over other bytes, or as the v1 signature
  assert.equal(verifyEd25519PureSignature(signingBytes, SIG_V2, PUB_B), false);
  assert.equal(verifyEd25519PureSignature(utf8(CANONICAL_V1_BODY), SIG_V2, PUB_A), false);
  assert.equal(verifyEvidenceSealV2Signature({ ...v2File(), signature: SIG_V1 } as unknown as EvidenceSealFileV2, PUB_A), false);
  assert.equal(verifyEvidenceSealV2Signature({ ...v2File(), seq: 2 } as unknown as EvidenceSealFileV2, PUB_A), false);
});

test('V2-37 the OpenSSL closure signature verifies the same way', () => {
  const { body, signingBytes } = buildKeyRetirementClosureBody(CLOSURE_INPUT);
  assert.ok(signingBytes.equals(utf8(CANONICAL_CLOSURE_BODY)));
  assert.equal(cryptoVerify(null, signingBytes, PUB_B, Buffer.from(SIG_CLOSURE, 'base64url')), true);
  assert.deepEqual(assembleKeyRetirementClosure(body, SIG_CLOSURE, PUB_B), closureFile());
  const parsed = accepted(parseKeyRetirementClosureText(utf8(closureFile())), 'closure fixture');
  assert.equal(verifyKeyRetirementClosureSignature(parsed, PUB_B), true);
  assert.equal(verifyKeyRetirementClosureSignature(parsed, PUB_A), false, 'not under the retired key');
});

/* ============================================================================================ V2-45: raw text (N6) and closure limits */

test('V2-45 any backslash in a seal text is SEAL_INVALID, even an escape that JSON.parse decodes to a valid value', () => {
  const text = textOf(v2File());
  const escapes: ReadonlyArray<readonly [string, string]> = [
    ['escaped key', text.replace('"seq":', '"s\\u0065q":')],
    ['escaped kind', text.replace('"LINK_AUDIT_EVIDENCE_SEAL"', '"LINK\\u005fAUDIT_EVIDENCE_SEAL"')],
    ['escaped ref', text.replace('"capture:c0001"', '"capture\\u003ac0001"')],
    ['escaped signature char', text.replace(`"${SIG_V2}"`, `"\\u0065${SIG_V2.slice(1)}"`)],
  ];
  for (const [label, escaped] of escapes) {
    assert.deepEqual(JSON.parse(escaped), v2File(), `${label}: JSON.parse would accept it as the very same seal`);
    rejectedWith(parseEvidenceSealV2Text(utf8(escaped)), 'BACKSLASH', label);
  }
  // an escaped key that would hide a duplicate after decoding is refused before any decoding
  rejectedWith(parseEvidenceSealV2Text(utf8(text.replace(/^\{/, '{"s\\u0065q":2,'))), 'BACKSLASH', 'escape hiding a duplicate');
  rejectedWith(parseEvidenceSealV2Text(utf8(`${text}\\`)), 'BACKSLASH', 'backslash outside strings');
});

test('V2-45 any backslash or duplicate key in a closure text is SEAL_INVALID', () => {
  const text = textOf(closureFile());
  accepted(parseKeyRetirementClosureText(utf8(text)), 'positive control');
  const escaped = text.replace('"ek-teste-v2-b"', '"ek-teste-v2-\\u0062"');
  assert.deepEqual(JSON.parse(escaped), closureFile());
  rejectedWith(parseKeyRetirementClosureText(utf8(escaped)), 'BACKSLASH', 'closure escape');
  const duplicates: ReadonlyArray<readonly [string, string]> = [
    ['retiredKeyId', text.replace(/^\{/, '{"retiredKeyId":"ek-forjada-x",')],
    ['head seq', text.replace('{"auditId":"auditoria-prova-v2-00",', '{"seq":256,"auditId":"auditoria-prova-v2-00",')],
  ];
  for (const [label, duplicated] of duplicates) {
    assert.deepEqual(JSON.parse(duplicated), closureFile(), `${label}: JSON.parse keeps the last value`);
    rejectedWith(parseKeyRetirementClosureText(utf8(duplicated)), 'DUPLICATE_KEY', `closure ${label}`);
  }
  // a seal duplicate key too (N6 applies to both files)
  rejectedWith(parseEvidenceSealV2Text(utf8(textOf(v2File()).replace(/^\{/, '{"keyId":"ek-forjada-x",'))), 'DUPLICATE_KEY', 'seal keyId');
  rejectedWith(parseKeyRetirementClosureText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(text)])), 'BOM', 'closure BOM');
  rejectedWith(parseKeyRetirementClosureText(Buffer.from([0x7b, 0xff, 0x7d])), 'NOT_UTF8', 'closure invalid UTF-8');
});

test('V2-45 a closure with 1000 heads fits in MAX_CLOSURE_BYTES; 1001 heads are refused', () => {
  assert.equal(MAX_CLOSURE_BYTES, 256 * 1024);
  assert.equal(MAX_CLOSURE_HEADS, 1000);
  // worst case: maximum-length auditIds (64 chars), seq 256, pretty-printed
  const heads = Array.from({ length: 1000 }, (_, index) => ({ auditId: `auditoria-fecho-${String(index).padStart(4, '0')}`.padEnd(64, 'x'), seq: 256, sealSha256: 'e'.repeat(64) }));
  const closure = createKeyRetirementClosure({ ...CLOSURE_INPUT, heads, privateKey: fromSeed(SEED_B_HEX) });
  const pretty = utf8(`${JSON.stringify(closure, null, 2)}\n`);
  assert.ok(pretty.byteLength <= MAX_CLOSURE_BYTES, `1000 heads take ${pretty.byteLength} bytes`);
  assert.equal(verifyKeyRetirementClosureSignature(accepted(parseKeyRetirementClosureText(pretty), '1000 heads'), PUB_B), true);

  assertRefused(() => buildKeyRetirementClosureBody({ ...CLOSURE_INPUT, heads: [...heads, { auditId: 'z'.repeat(64), seq: 1, sealSha256: 'e'.repeat(64) }] }), 'SCHEMA_INVALID', 'build 1001 heads');
  const over = utf8({ ...closure, heads: [...closure.heads, { auditId: 'z'.repeat(64), seq: 1, sealSha256: 'e'.repeat(64) }] });
  assert.ok(over.byteLength < MAX_CLOSURE_BYTES, '1001 heads still fit in the byte limit: the refusal is by count');
  rejectedWith(parseKeyRetirementClosureText(over), 'SCHEMA', 'parse 1001 heads');

  const compact = textOf(closureFile());
  accepted(parseKeyRetirementClosureText(utf8(compact.padEnd(MAX_CLOSURE_BYTES, ' '))), 'exactly MAX_CLOSURE_BYTES');
  rejectedWith(parseKeyRetirementClosureText(utf8(compact.padEnd(MAX_CLOSURE_BYTES + 1, ' '))), 'TOO_LARGE', 'MAX_CLOSURE_BYTES + 1');
  accepted(parseKeyRetirementClosureText(utf8({ ...closureFile(), heads: [] })), 'zero heads is a valid closure (contract §6: 0…1000)');
});

test('V2-45 (contract §6) the closure has the same strict schema discipline as the seal', () => {
  const head = (over: Json) => ({ ...(closureFile().heads as Json[])[0], ...over });
  const cases: ReadonlyArray<readonly [string, Json]> = [
    ['extra field', { ...closureFile(), extra: 1 }],
    ['wrong kind', { ...closureFile(), kind: 'LINK_AUDIT_EVIDENCE_SEAL' }],
    ['schemaVersion 2', { ...closureFile(), schemaVersion: 2 }],
    ['signer = retired', { ...closureFile(), signerKeyId: KEY_ID_A }],
    ['uppercase keyId', { ...closureFile(), retiredKeyId: 'EK-TESTE-V2-A' }],
    ['unordered heads', { ...closureFile(), heads: [...(closureFile().heads as Json[])].reverse() }],
    ['repeated auditId', { ...closureFile(), heads: [head({}), head({ seq: 1 })] }],
    ['head seq 0', { ...closureFile(), heads: [head({ seq: 0 })] }],
    ['head seq 257', { ...closureFile(), heads: [head({ seq: 257 })] }],
    ['uppercase head hash', { ...closureFile(), heads: [head({ sealSha256: 'A'.repeat(64) })] }],
    ['head extra field', { ...closureFile(), heads: [head({ keyId: KEY_ID_A })] }],
    ['non-canonical signature', { ...closureFile(), signature: nonCanonicalVariant(SIG_CLOSURE) }],
    ['S + L', { ...closureFile(), signature: withScalarPlusL(SIG_CLOSURE) }],
  ];
  for (const [label, file] of cases) rejectedWith(parseKeyRetirementClosureText(utf8(file)), 'SCHEMA', `closure ${label}`);
});
