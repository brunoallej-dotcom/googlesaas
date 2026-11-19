import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sign as cryptoSign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/lib/link-audit/canonical';
import { nodeFsOps, type FileInfo, type FsOps } from '../src/lib/link-audit/snapshot-store';
import {
  createEvidenceSeal,
  createEvidenceSealV2,
  createSealedEvidenceProvenance,
  evidenceProvenanceFromConfig,
  MAX_CHAIN_SEALS,
  MAX_CLASSIFY_BYTES,
  MAX_SEAL_BYTES,
  parseTrustKeys,
  sealSha256,
  type AcceptedSealVersion,
  type EvidenceProvenancePolicy,
  type EvidenceSealFile,
  type EvidenceSealFileV2,
  type EvidenceToProve,
  type EvidenceTrustReason,
} from '../src/lib/link-audit-evidence/provenance';
import { registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { evidenceKeys, writeSealFile, type EvidenceKeys } from './helpers/link-audit-evidence-provenance-fixtures';

/*
 * W3.3 — the CHAIN on the walked path B (contract `p1-contrato-verificador-v2.md` §3, §4, §8 rows 4–14, §11). Covers V2-08 to V2-18, V2-30,
 * V2-33, V2-39 and V2-48 (IA-21, IA-07, IA-08, RS-10, RS-20, M3, N5, D12). V2-14 is in the W3.1 schema file. Keyring states and the retirement
 * closure are W3.4 (here every key of `trustedKeys` is active); the revocation pre-step (row 6) and its signal are W3.5.
 */
registerCleanup();

const AUD = 'auditoria-cadeia-v2-01';
const OTHER = 'auditoria-cadeia-v2-02';
const KEYS_A = evidenceKeys('ek-cadeia-a');
const KEYS_B = evidenceKeys('ek-cadeia-b');
const KEYS_X = evidenceKeys('ek-cadeia-fora'); // never in the trust list
const DOSSIER = { id: 'dossie-cadeia-01', sha256: 'd0'.repeat(32) };
const ev = (ref: string, fill: string): EvidenceToProve => ({ ref, contentSha256: fill.repeat(64), legacy: false });
const E1: readonly EvidenceToProve[] = [ev('capture:c0001', 'a'), ev('report:c0001-r0001', 'b')];
const E2: readonly EvidenceToProve[] = [...E1, ev('capture:c0002', 'c')];
const E3: readonly EvidenceToProve[] = [...E2, ev('capture:c0003', 'd')];

type AnySeal = EvidenceSealFile | EvidenceSealFileV2;
interface Position {
  readonly keys?: EvidenceKeys;
  readonly entries?: readonly EvidenceToProve[];
  readonly version?: 1 | 2;
  /** Overrides the link to the predecessor (then the file is re-signed by hand: the producer would refuse an incoherent prev). */
  readonly prev?: string | null;
  readonly seq?: number;
  readonly auditId?: string;
  readonly sealedAt?: string;
}
const sorted = (entries: readonly EvidenceToProve[]) => [...entries].map(({ ref, contentSha256 }) => ({ ref, contentSha256 })).sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
function resignedV2(body: Record<string, unknown>, keys: EvidenceKeys): EvidenceSealFileV2 {
  return { ...body, signature: cryptoSign(null, Buffer.from(canonicalJson(body), 'utf8'), keys.privateKey).toString('base64url') } as EvidenceSealFileV2;
}
const bodyOf = (file: AnySeal): Record<string, unknown> => {
  const { signature, ...body } = file;
  void signature;
  return body;
};
/** A chain built position by position with the real producers; a v2 links to `sealSha256` of the previous position (v1 or v2). */
function buildChain(positions: readonly Position[], auditId = AUD): AnySeal[] {
  const seals: AnySeal[] = [];
  positions.forEach((position, index) => {
    const keys = position.keys ?? KEYS_A;
    const base = { auditId: position.auditId ?? auditId, seq: position.seq ?? index + 1, sealedAt: position.sealedAt ?? `2026-11-19T1${index}:00:00.000Z`, keyId: keys.keyId, entries: sorted(position.entries ?? E1) };
    if (position.version === 1) return void seals.push(createEvidenceSeal({ ...base, privateKey: keys.privateKey }));
    const linked = index === 0 ? null : sealSha256(seals[index - 1] as AnySeal);
    if (position.prev === undefined) return void seals.push(createEvidenceSealV2({ ...base, privateKey: keys.privateKey, dossier: DOSSIER, prevSealSha256: linked }));
    seals.push(resignedV2({ schemaVersion: 2, kind: 'LINK_AUDIT_EVIDENCE_SEAL', ...base, dossier: DOSSIER, prevSealSha256: position.prev }, keys));
  });
  return seals;
}
function writeChain(seals: readonly AnySeal[], auditId = AUD, sealsDir = tmpDir('lep3-')): string {
  for (const seal of seals) writeSealFile(sealsDir, auditId, seal.seq, seal);
  return sealsDir;
}
const nameOf = (seq: number): string => `seal-${String(seq).padStart(4, '0')}.json`;
function writeNamed(sealsDir: string, auditId: string, name: string, text: string): string {
  const file = path.join(sealsDir, auditId, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, text);
  return file;
}
const remove = (sealsDir: string, seq: number, auditId = AUD): void => fs.rmSync(path.join(sealsDir, auditId, nameOf(seq)), { force: true });
const trusted = (...keys: EvidenceKeys[]): ReadonlyMap<string, KeyObject> => parseTrustKeys(keys.map((k) => k.trustKeys).join(',')) as ReadonlyMap<string, KeyObject>;
function policy(sealsDir: string, versions: readonly AcceptedSealVersion[] = [2], keys: readonly EvidenceKeys[] = [KEYS_A, KEYS_B], fsOps?: FsOps): EvidenceProvenancePolicy {
  return createSealedEvidenceProvenance({ sealsDir, trustedKeys: trusted(...keys), acceptedVersions: versions, ...(fsOps ? { fs: fsOps } : {}) });
}
const UNAUTH = (reason: EvidenceTrustReason) => ({ status: 'UNAUTHENTICATED', reason });
const authenticated = (head: AnySeal, keyIds: readonly string[]) => ({ status: 'AUTHENTICATED', headSeq: head.seq, headSealSha256: sealSha256(head), keyIds: [...new Set(keyIds)].sort() });
const BOTH: ReadonlyArray<readonly AcceptedSealVersion[]> = [[2], [1, 2]];
async function expectFor(sealsDir: string, evidences: readonly EvidenceToProve[], expected: unknown, label: string, versionsList = BOTH, keys?: readonly EvidenceKeys[]): Promise<void> {
  for (const versions of versionsList) assert.deepEqual(await policy(sealsDir, versions, keys).classify(AUD, evidences), expected, `${label} ${JSON.stringify(versions)}`);
}
/** Records every `readFile` (basename), delegating to the real disk. */
function readSpy(): { readonly fs: FsOps; readonly reads: string[] } {
  const reads: string[] = [];
  return { fs: faulty({ readFile: async (target, maxBytes) => (reads.push(path.basename(target)), nodeFsOps.readFile(target, maxBytes)) }), reads };
}

/* ============================================================================================ V2-08, V2-09 */

test('V2-08 (IA-21) a valid chain 1 → 2 → 3 (keys A, A, B) is AUTHENTICATED with the head metadata; each manifest is read once', async () => {
  const seals = buildChain([{ entries: E1 }, { entries: E2 }, { keys: KEYS_B, entries: E3 }]);
  const sealsDir = writeChain(seals);
  for (const versions of BOTH) {
    const spy = readSpy();
    assert.deepEqual(await policy(sealsDir, versions, undefined, spy.fs).classify(AUD, E3), authenticated(seals[2] as AnySeal, [KEYS_A.keyId, KEYS_B.keyId]), JSON.stringify(versions));
    assert.deepEqual([...spy.reads].sort(), [nameOf(1), nameOf(2), nameOf(3)], `${JSON.stringify(versions)}: one read per manifest`);
  }
  // the longest chain the contract allows (MAX_CHAIN_SEALS = 256) still authenticates
  assert.equal(MAX_CHAIN_SEALS, 256);
  const long = buildChain(Array.from({ length: MAX_CHAIN_SEALS }, () => ({ entries: E1, sealedAt: '2026-11-19T10:00:00.000Z' })));
  assert.deepEqual(await policy(writeChain(long), [2]).classify(AUD, E1), authenticated(long[MAX_CHAIN_SEALS - 1] as AnySeal, [KEYS_A.keyId]));
});

test('V2-09 (IA-21) a missing predecessor or a gap is SEAL_CHAIN_BROKEN; seal-0000 or more than 256 names break it before reading', async () => {
  const seals = buildChain([{ entries: E1 }, { entries: E2 }, { entries: E3 }]);
  for (const [label, missing] of [['predecessor 0002 deleted (gap 0001, 0003)', [2]], ['first 0001 deleted', [1]], ['only 0002 left', [1, 3]]] as const) {
    const sealsDir = writeChain(seals);
    for (const seq of missing) remove(sealsDir, seq);
    await expectFor(sealsDir, E3, UNAUTH('SEAL_CHAIN_BROKEN'), label);
  }
  const zero = writeChain(seals);
  writeNamed(zero, AUD, nameOf(0), JSON.stringify(seals[0]));
  await expectFor(zero, E3, UNAUTH('SEAL_CHAIN_BROKEN'), 'seal-0000 present');
  const tooMany = writeChain(seals);
  writeNamed(tooMany, AUD, nameOf(MAX_CHAIN_SEALS + 1), '{}');
  const spy = readSpy();
  assert.deepEqual(await policy(tooMany, [2], undefined, spy.fs).classify(AUD, E3), UNAUTH('SEAL_CHAIN_BROKEN'), 'N = 257');
  assert.deepEqual(spy.reads, [], 'names only: nothing is read');
  assert.deepEqual(await policy(tooMany, [1, 2]).classify(AUD, E3), UNAUTH('SEAL_CHAIN_BROKEN'), 'N = 257 [1,2] (latest read to choose the path, then walked)');
});

/* ============================================================================================ V2-10, V2-11 */

test('V2-10 (IA-21, RS-10) a predecessor replaced by ANOTHER valid manifest is SEAL_CHAIN_BROKEN; one changed byte in it is SEAL_INVALID', async () => {
  const seals = buildChain([{ entries: E1 }, { entries: E2 }, { entries: E3 }]);
  const replaced = writeChain(seals);
  const other = buildChain([{ entries: E1 }, { entries: E2, sealedAt: '2026-11-19T19:59:59.000Z' }]);
  writeSealFile(replaced, AUD, 2, other[1]); // valid by itself (signed, linked to the same 0001), but 0003 points to the original 0002
  await expectFor(replaced, E3, UNAUTH('SEAL_CHAIN_BROKEN'), 'replaced predecessor');
  const tampered = writeChain(seals);
  const text = JSON.stringify(seals[1]);
  writeNamed(tampered, AUD, nameOf(2), text.replace('"capture:c0002"', '"capture:c0009"'));
  await expectFor(tampered, E3, UNAUTH('SEAL_INVALID'), 'one byte in the predecessor');
  // the link is over the CANONICAL form: a predecessor re-formatted on disk still links
  const reformatted = writeChain(seals);
  writeNamed(reformatted, AUD, nameOf(2), `${JSON.stringify(seals[1], null, 2)}\r\n`);
  await expectFor(reformatted, E3, authenticated(seals[2] as AnySeal, [KEYS_A.keyId]), 'reformatted predecessor');
});

test('V2-11 (IA-21) seq 1 with a prev, seq > 1 without one, or a prev that skips a position (re-signed) is SEAL_CHAIN_BROKEN', async () => {
  const cases: ReadonlyArray<readonly [string, readonly Position[]]> = [
    ['seq 1 with prev', [{ entries: E1, prev: 'e'.repeat(64) }, { entries: E2 }]],
    ['seq 2 with prev null', [{ entries: E1 }, { entries: E2, prev: null }]],
  ];
  for (const [label, positions] of cases) await expectFor(writeChain(buildChain(positions)), E2, UNAUTH('SEAL_CHAIN_BROKEN'), label);
  const base = buildChain([{ entries: E1 }, { entries: E2 }]);
  const skipping = buildChain([{ entries: E1 }, { entries: E2 }, { entries: E3, prev: sealSha256(base[0] as AnySeal) }]);
  await expectFor(writeChain(skipping), E3, UNAUTH('SEAL_CHAIN_BROKEN'), 'seq 3 linked to seq 1');
});

/* ============================================================================================ V2-12, V2-13 */

test('V2-12 (IA-21, IA-08) a manifest that omits or changes an entry of its predecessor is SEAL_NOT_CUMULATIVE, also in an intermediate pair', async () => {
  const changed = E1.map((entry) => (entry.ref === 'capture:c0001' ? { ...entry, contentSha256: 'f'.repeat(64) } : entry));
  const cases: ReadonlyArray<readonly [string, readonly Position[], readonly EvidenceToProve[]]> = [
    ['last pair omits', [{ entries: E1 }, { entries: E2 }, { entries: E3.filter((e) => e.ref !== 'capture:c0002') }], E3.filter((e) => e.ref !== 'capture:c0002')],
    ['intermediate pair omits', [{ entries: E2 }, { entries: E1 }, { entries: E3 }], E3],
    ['hash changed', [{ entries: E1 }, { entries: [...changed, ev('capture:c0002', 'c')] }], [...changed, ev('capture:c0002', 'c')]],
  ];
  for (const [label, positions, evidences] of cases) await expectFor(writeChain(buildChain(positions)), evidences, UNAUTH('SEAL_NOT_CUMULATIVE'), label);
});

test('V2-13 (IA-08) re-sealing with EQUAL or a superset of entries is accepted', async () => {
  for (const [label, positions, evidences] of [
    ['equal entries', [{ entries: E1 }, { entries: E1 }, { entries: E1 }], E1],
    ['superset', [{ entries: E1 }, { entries: E3 }], E3],
    ['equal, superset, equal', [{ entries: E1 }, { entries: E1 }, { entries: E2 }, { entries: E2 }], E2],
  ] as const) {
    const seals = buildChain(positions);
    await expectFor(writeChain(seals), evidences, authenticated(seals[seals.length - 1] as AnySeal, [KEYS_A.keyId]), label);
  }
});

/* ============================================================================================ V2-15 */

test('V2-15 (IA-07, IA-21) a name that differs from the signed seq is SEAL_INVALID; names outside SEAL_FILE are ignored and never fill a gap', async () => {
  const seals = buildChain([{ entries: E1 }, { entries: E2 }, { entries: E3 }]);
  const misnamed = writeChain(seals.slice(0, 2));
  const third = buildChain([{ entries: E1 }, { entries: E2 }, { entries: E3, seq: 3 }]);
  writeSealFile(misnamed, AUD, 2, third[2]); // seal-0002.json holds the manifest signed as seq 3
  await expectFor(misnamed, E3, UNAUTH('SEAL_INVALID'), 'name 0002, signed seq 3');
  const ignored = ['SEAL-0002.json', 'seal-0002.JSON', 'seal-2.json', 'seal-00002.json', 'seal-0002.json.bak', 'seal-0002.json~', ' seal-0002.json', 'seal-0002.jsonx'];
  const valid = writeChain(seals.slice(0, 2));
  for (const name of ignored) writeNamed(valid, AUD, name, '{ "não é": "um manifesto" }');
  await expectFor(valid, E2, authenticated(seals[1] as AnySeal, [KEYS_A.keyId]), 'look-alike names are ignored');
  for (const name of ignored) {
    const gap = writeChain(seals);
    remove(gap, 2);
    writeNamed(gap, AUD, name, JSON.stringify(seals[1])); // the real 0002 under a look-alike name
    await expectFor(gap, E3, UNAUTH('SEAL_CHAIN_BROKEN'), `${name} does not fill the gap`);
  }
});

/* ============================================================================================ V2-16, V2-17, V2-18 */

test('V2-16 (IA-21) monotony on the walked path: [2] with v2 v1 and with v2 v1 v2 (well signed) is SEAL_DOWNGRADE; [1,2] with v2 v1 is path A', async () => {
  const v2v1 = buildChain([{ entries: E1 }, { entries: E2, version: 1 }]);
  assert.deepEqual(await policy(writeChain(v2v1), [2]).classify(AUD, E2), UNAUTH('SEAL_DOWNGRADE'), '[2] v2 v1');
  const v2v1v2 = buildChain([{ entries: E1 }, { entries: E2, version: 1 }, { entries: E3 }]);
  await expectFor(writeChain(v2v1v2), E3, UNAUTH('SEAL_DOWNGRADE'), 'v2 v1 v2');
  // DECLARED LIMIT of the library default (contract §4.3): with a v1 last, [1,2] runs today's verifier and does not walk the chain
  assert.deepEqual(await policy(writeChain(v2v1), [1, 2]).classify(AUD, E2), { status: 'AUTHENTICATED' }, '[1,2] v2 v1: path A, registered');
});

test('V2-17 (IA-21, M3) [2] refuses v1 at any position (SEAL_VERSION_NOT_ALLOWED, or SEAL_DOWNGRADE after a v2); [1,2] accepts the v1 → v2 promotion', async () => {
  const cases: ReadonlyArray<readonly [string, readonly Position[], EvidenceTrustReason]> = [
    ['only v1', [{ entries: E1, version: 1 }, { entries: E2, version: 1 }], 'SEAL_VERSION_NOT_ALLOWED'],
    ['prefix v1 v1 v2', [{ entries: E1, version: 1 }, { entries: E2, version: 1 }, { entries: E3 }], 'SEAL_VERSION_NOT_ALLOWED'],
    ['v1 in the middle after a v2', [{ entries: E1 }, { entries: E2, version: 1 }, { entries: E3 }], 'SEAL_DOWNGRADE'],
    ['v1 last after a v2', [{ entries: E1 }, { entries: E2 }, { entries: E3, version: 1 }], 'SEAL_DOWNGRADE'],
  ];
  for (const [label, positions, reason] of cases) assert.deepEqual(await policy(writeChain(buildChain(positions)), [2]).classify(AUD, E3.slice(0, positions.length + 1)), UNAUTH(reason), label);
  const promoted = buildChain([{ entries: E1, version: 1 }, { entries: E2, version: 1 }, { entries: E3 }]);
  assert.deepEqual(await policy(writeChain(promoted), [1, 2]).classify(AUD, E3), authenticated(promoted[2] as AnySeal, [KEYS_A.keyId]), '[1,2] promotion v1 v1 v2');
  const badLink = buildChain([{ entries: E1, version: 1 }, { entries: E2, prev: 'e'.repeat(64) }]);
  assert.deepEqual(await policy(writeChain(badLink), [1, 2]).classify(AUD, E2), UNAUTH('SEAL_CHAIN_BROKEN'), 'the promotion links by sealSha256 of the v1');
});

test('V2-18 (M3, N5) a v1 last with [2]: the v2 below deleted, unreadable or failing to read gives row 10, row 8 or row 7; [1,2] does not look below', async () => {
  const seals = buildChain([{ entries: E1 }, { entries: E2, version: 1 }]);
  const deleted = writeChain(seals);
  remove(deleted, 1);
  assert.deepEqual(await policy(deleted, [2]).classify(AUD, E2), UNAUTH('SEAL_VERSION_NOT_ALLOWED'), 'v2 below deleted (row 10 before the gap of row 11)');
  const unreadable: ReadonlyArray<readonly [string, (dir: string) => void]> = [
    ['not JSON', (dir) => writeNamed(dir, AUD, nameOf(1), '{ não é json')],
    ['empty', (dir) => writeNamed(dir, AUD, nameOf(1), '')],
    ['a directory', (dir) => fs.mkdirSync(path.join(dir, AUD, nameOf(1)))],
    ['a symbolic link to a valid copy', (dir) => fs.symlinkSync(writeNamed(tmpDir('lep3-elsewhere-'), AUD, nameOf(1), JSON.stringify(seals[0])), path.join(dir, AUD, nameOf(1)))],
  ];
  for (const [label, replace] of unreadable) {
    const dir = writeChain(seals);
    remove(dir, 1);
    replace(dir);
    assert.deepEqual(await policy(dir, [2]).classify(AUD, E2), UNAUTH('SEAL_INVALID'), `v2 below ${label} (row 8 before rows 9–10)`);
    assert.deepEqual(await policy(dir, [1, 2]).classify(AUD, E2), { status: 'AUTHENTICATED' }, `${label}: [1,2] path A does not look below (registered)`);
  }
  const ioError = faulty({ readFile: async (target, maxBytes) => (path.basename(target) === nameOf(1) ? Promise.reject(errno('EIO')) : nodeFsOps.readFile(target, maxBytes)) });
  assert.deepEqual(await policy(writeChain(seals), [2], undefined, ioError).classify(AUD, E2), UNAUTH('VERIFICATION_ERROR'), 'I/O error below (row 7)');
});

/* ============================================================================================ V2-30, V2-33 */

test('V2-30 (D12) an unknown keyId at any position, or a key removed from the list (not revoked), is SEAL_INVALID', async () => {
  const unknown = buildChain([{ entries: E1 }, { entries: E2, keys: KEYS_X }, { entries: E3 }]);
  await expectFor(writeChain(unknown), E3, UNAUTH('SEAL_INVALID'), 'unknown key in the middle');
  const ab = buildChain([{ entries: E1 }, { entries: E2, keys: KEYS_B }]);
  const dir = writeChain(ab);
  await expectFor(dir, E2, authenticated(ab[1] as AnySeal, [KEYS_A.keyId, KEYS_B.keyId]), 'control: both keys listed');
  await expectFor(dir, E2, UNAUTH('SEAL_INVALID'), 'key A removed from the list', BOTH, [KEYS_B]);
});

test('V2-33 (RS-20, IA-06) manifests and evidence of audit A under audit B are SEAL_INVALID or EVIDENCE_*, never AUTHENTICATED', async () => {
  const mine = buildChain([{ entries: E1 }, { entries: E2 }]);
  const theirs = buildChain([{ entries: [ev('capture:c0001', '1'), ev('report:c0001-r0001', '2')] }, { entries: [ev('capture:c0001', '1'), ev('report:c0001-r0001', '2'), ev('capture:c0002', '3')] }], OTHER);
  const theirEvidences = [ev('capture:c0001', '1'), ev('report:c0001-r0001', '2'), ev('capture:c0002', '3')];
  const copied = writeChain(theirs, AUD); // the whole chain of OTHER under AUD's folder
  await expectFor(copied, theirEvidences, UNAUTH('SEAL_INVALID'), 'chain of B under A');
  const mixed = writeChain([mine[0] as AnySeal, theirs[1] as AnySeal], AUD);
  await expectFor(mixed, E2, UNAUTH('SEAL_INVALID'), 'one position of B inside A');
  const own = writeChain(mine, AUD);
  for (const versions of BOTH) {
    const verdict = await policy(own, versions).classify(AUD, theirEvidences);
    assert.ok(verdict.status === 'UNAUTHENTICATED' && ['EVIDENCE_NOT_SEALED', 'EVIDENCE_HASH_MISMATCH', 'EVIDENCE_MISSING'].includes(verdict.reason), `evidence of B on A's chain: ${JSON.stringify(verdict)}`);
  }
});

/* ============================================================================================ V2-39, V2-48 */

test('V2-39 (R3-MINOR-6) with v2 too: a linked audit folder, a FIFO or linked manifest, and a seals folder overlapping another data folder fail closed', async () => {
  const seals = buildChain([{ entries: E1 }, { entries: E2 }]);
  const real = writeChain(seals);
  const linked = tmpDir('lep3-link-');
  fs.symlinkSync(path.join(real, AUD), path.join(linked, AUD));
  await expectFor(linked, E2, UNAUTH('SEAL_INVALID'), 'audit folder is a symbolic link');
  const fifo = writeChain(seals);
  remove(fifo, 2);
  execFileSync('mkfifo', [path.join(fifo, AUD, nameOf(2))]);
  const started = process.hrtime.bigint();
  await expectFor(fifo, E2, UNAUTH('SEAL_INVALID'), 'a manifest is a FIFO');
  assert.ok(process.hrtime.bigint() - started < 3_000_000_000n, 'did not hang on the FIFO');
  const linkedFile = writeChain(seals);
  remove(linkedFile, 2);
  fs.symlinkSync(writeNamed(tmpDir('lep3-elsewhere-'), AUD, nameOf(2), JSON.stringify(seals[1])), path.join(linkedFile, AUD, nameOf(2)));
  await expectFor(linkedFile, E2, UNAUTH('SEAL_INVALID'), 'a manifest is a symbolic link');
  const evidence = tmpDir('lep3-ev-');
  const nested = path.join(evidence, 'seals');
  writeChain(seals, AUD, nested);
  const alias = path.join(tmpDir('lep3-alias-'), 'seals');
  fs.symlinkSync(nested, alias);
  for (const [sealsDir, other] of [[evidence, evidence], [nested, evidence], [evidence, nested], [alias, evidence]] as const) {
    assert.deepEqual(await createSealedEvidenceProvenance({ sealsDir, trustedKeys: trusted(KEYS_A), acceptedVersions: [2], otherDirs: [other] }).classify(AUD, E2), UNAUTH('PROOF_NOT_CONFIGURED'), `${sealsDir} × ${other}`);
    assert.deepEqual(await evidenceProvenanceFromConfig({ sealsDir, trustKeys: KEYS_A.trustKeys, acceptedVersions: [2], otherDirs: [other] }).classify(AUD, E2), UNAUTH('PROOF_NOT_CONFIGURED'), `config ${sealsDir} × ${other}`);
  }
});

test('V2-48 (N5, M1) [1,2] with the latest unreadable or of schemaVersion 3 takes the walked path B and fails closed', async () => {
  // The revocation signal that path B must preserve here comes with the pre-step of W3.5 (no keyring states exist before W3.4).
  const promotion = buildChain([{ entries: E1, version: 1 }, { entries: E2 }]);
  const v1 = promotion.slice(0, 1);
  const v3 = resignedV2({ ...bodyOf(promotion[1] as AnySeal), schemaVersion: 3 }, KEYS_A); // a v2 relabelled as version 3, well signed
  const latest: ReadonlyArray<readonly [string, (dir: string) => void, EvidenceTrustReason]> = [
    ['not JSON', (dir) => writeNamed(dir, AUD, nameOf(2), '{ não é json'), 'SEAL_INVALID'],
    ['schemaVersion 3', (dir) => writeNamed(dir, AUD, nameOf(2), JSON.stringify(v3)), 'SEAL_INVALID'],
    ['a directory', (dir) => fs.mkdirSync(path.join(dir, AUD, nameOf(2))), 'SEAL_INVALID'],
    ['above 256 KiB', (dir) => writeNamed(dir, AUD, nameOf(2), ' '.repeat(MAX_SEAL_BYTES + 1)), 'VERIFICATION_ERROR'],
  ];
  for (const [label, put, reason] of latest) {
    const dir = writeChain(v1);
    put(dir);
    assert.deepEqual(await policy(dir, [1, 2]).classify(AUD, E1), UNAUTH(reason), `latest ${label}`);
  }
  const ioError = faulty({ readFile: async (target, maxBytes) => (path.basename(target) === nameOf(2) ? Promise.reject(errno('EIO')) : nodeFsOps.readFile(target, maxBytes)) });
  const dir = writeChain(v1);
  writeNamed(dir, AUD, nameOf(2), JSON.stringify(promotion[1]));
  assert.deepEqual(await policy(dir, [1, 2], undefined, ioError).classify(AUD, E2), UNAUTH('VERIFICATION_ERROR'), 'latest with an I/O error');
  // `[1]` (the old verifier) keeps today's answer for an unparseable latest, which path B does not
  const garbage = writeChain(v1);
  writeNamed(garbage, AUD, nameOf(2), '{ não é json');
  assert.deepEqual(await policy(garbage, [1]).classify(AUD, E1), UNAUTH('VERIFICATION_ERROR'), '[1]: today');
});

/* ----- contract §2 read limits on the chain: fail-closed until the W3.5 read-budget suite completes them ----- */

/** In-memory read-only FsOps (sizes reported by lstat), so a large chain costs no disk. */
function memoryFs(files: ReadonlyMap<string, string>): { readonly fs: FsOps; readonly reads: string[] } {
  const reads: string[] = [];
  const dirs = new Set([...files.keys()].flatMap((file) => [path.dirname(file), path.dirname(path.dirname(file))]));
  const info = (kind: 'file' | 'dir', size = 0): FileInfo => ({ isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => false, size, mtimeMs: 0 });
  const refuse = async (): Promise<never> => Promise.reject(new Error('write attempted'));
  const memory: FsOps = {
    lstat: async (target) => (dirs.has(target) ? info('dir') : files.has(target) ? info('file', Buffer.byteLength(files.get(target) as string)) : Promise.reject(errno('ENOENT'))),
    readdir: async (dir) => [...files.keys()].filter((file) => path.dirname(file) === dir).map((file) => path.basename(file)),
    realpath: async (target) => target,
    readFile: async (target) => (reads.push(path.basename(target)), files.has(target) ? (files.get(target) as string) : Promise.reject(errno('ENOENT'))),
    mkdir: refuse,
    writeExclusive: refuse,
    link: refuse,
    unlink: refuse,
    chmod: refuse,
    syncDirectory: refuse,
  };
  return { fs: memory, reads };
}

test('contract §2 limits on the chain (fail-closed now; W3.5 adds the revocation pre-step around them): more than MAX_CLASSIFY_BYTES is VERIFICATION_ERROR and stops reading', async () => {
  assert.equal(MAX_CLASSIFY_BYTES, 16 * 1024 * 1024);
  const sealsDir = '/memoria/selos';
  const perFile = 250_000; // under MAX_SEAL_BYTES; 70 of them exceed the classify budget
  const files = new Map(Array.from({ length: 70 }, (_, index) => [path.join(sealsDir, AUD, nameOf(index + 1)), `{${' '.repeat(perFile - 2)}}`] as const));
  for (const versions of BOTH) {
    const memory = memoryFs(files);
    assert.deepEqual(await policy(sealsDir, versions, undefined, memory.fs).classify(AUD, E1), UNAUTH('VERIFICATION_ERROR'), JSON.stringify(versions));
    assert.ok(memory.reads.length < files.size, `${JSON.stringify(versions)}: reading stopped (${memory.reads.length} of ${files.size})`);
    assert.equal(new Set(memory.reads).size, memory.reads.length, 'no file read twice');
  }
});
