import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/lib/link-audit/canonical';
import { nodeFsOps, type FileInfo, type FsOps } from '../src/lib/link-audit/snapshot-store';
import {
  createEvidenceSeal,
  createEvidenceSealV2,
  createKeyRetirementClosure,
  evidenceProvenanceFromConfig,
  MAX_CHAIN_SEALS,
  MAX_CLASSIFY_BYTES,
  MAX_SEAL_BYTES,
  sealSha256,
  type AcceptedSealVersion,
  type EvidenceSealFile,
  type EvidenceSealFileV2,
  type EvidenceToProve,
  type EvidenceTrustReason,
} from '../src/lib/link-audit-evidence/provenance';
import { createScoringBasisReader } from '../src/lib/link-audit-evidence/scoring-basis';
import { evidenceToProveFromBasis } from '../src/lib/link-audit-evidence/evidence-to-prove';
import { registerCleanup, tmpDir, world } from './helpers/link-audit-decisions-fixtures';
import { errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { evidenceKeys, sealAuditV2ForTests, writeSealFile, type EvidenceKeys } from './helpers/link-audit-evidence-provenance-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_A, resultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * W3.5 — the revocation PRE-STEP and the strict read limits (contract `p1-contrato-verificador-v2.md` §7, §8 rows 4–8, §2 "Limites", §11).
 * Covers V2-27, V2-28, V2-29, V2-31, V2-32, V2-43 and V2-44 (D12, question 12, M1, N3, N4, m2, m5, IA-13, IA-21, RS-20). The pre-step reads every
 * manifest once, tolerating per-file failures, and signals any AUTHENTIC position of a `revoked` key of THIS audit at THIS seq, with precedence
 * over every later row; the residuals are declared: nothing read ⇒ no signal (folder deleted, `seal-0000`, N > 256) and files left unread by the
 * byte budget are not examined.
 */
registerCleanup();

const AUD = 'auditoria-revoga-v2-01';
const OTHER = 'auditoria-revoga-v2-02';
const A = evidenceKeys('ek-revoga-a'); // active
const B = evidenceKeys('ek-revoga-b'); // active
const K = evidenceKeys('ek-revoga-k'); // revoked
const L = evidenceKeys('ek-revoga-l'); // revoked
const M = evidenceKeys('ek-revoga-m'); // revoked
const R = evidenceKeys('ek-revoga-r'); // retired, nothing pinned
const X = evidenceKeys('ek-revoga-x'); // never listed
const LIST = [`${A.keyId}:${A.publicRaw}`, `${B.keyId}:${B.publicRaw}`, `${K.keyId}:${K.publicRaw}:revoked`, `${L.keyId}:${L.publicRaw}:revoked`, `${M.keyId}:${M.publicRaw}:revoked`, `${R.keyId}:${R.publicRaw}:retired`].join(',');
const DOSSIER = { id: 'dossie-revoga-01', sha256: 'e1'.repeat(32) };
const ev = (ref: string, fill: string): EvidenceToProve => ({ ref, contentSha256: fill.repeat(64), legacy: false });
const E1: readonly EvidenceToProve[] = [ev('capture:c0001', 'a'), ev('report:c0001-r0001', 'b')];
const E2: readonly EvidenceToProve[] = [...E1, ev('capture:c0002', 'c')];
const E3: readonly EvidenceToProve[] = [...E2, ev('capture:c0003', 'd')];

type AnySeal = EvidenceSealFile | EvidenceSealFileV2;
interface Position {
  readonly keys: EvidenceKeys;
  readonly entries?: readonly EvidenceToProve[];
  readonly version?: 1 | 2;
  /** Overrides the link (re-signed by hand: the producer refuses an incoherent prev). */
  readonly prev?: string;
}
const plain = (entries: readonly EvidenceToProve[]) => entries.map(({ ref, contentSha256 }) => ({ ref, contentSha256 }));
const bodyOf = (file: AnySeal): Record<string, unknown> => {
  const { signature, ...body } = file;
  void signature;
  return body;
};
const signedBy = (body: Record<string, unknown>, keys: EvidenceKeys): AnySeal => ({ ...body, signature: cryptoSign(null, Buffer.from(canonicalJson(body), 'utf8'), keys.privateKey).toString('base64url') }) as AnySeal;
function buildChain(positions: readonly Position[], auditId = AUD): AnySeal[] {
  const seals: AnySeal[] = [];
  positions.forEach(({ keys, entries, version, prev }, index) => {
    const base = { auditId, seq: index + 1, sealedAt: `2026-11-19T1${index}:00:00.000Z`, keyId: keys.keyId, privateKey: keys.privateKey, entries: plain(entries ?? E1) };
    if (version === 1) return void seals.push(createEvidenceSeal(base));
    const linked = index === 0 ? null : sealSha256(seals[index - 1] as AnySeal);
    if (prev === undefined) return void seals.push(createEvidenceSealV2({ ...base, dossier: DOSSIER, prevSealSha256: linked }));
    const { privateKey, ...rest } = base;
    void privateKey;
    seals.push(signedBy({ schemaVersion: 2, kind: 'LINK_AUDIT_EVIDENCE_SEAL', ...rest, dossier: DOSSIER, prevSealSha256: prev }, keys));
  });
  return seals;
}
function writeChain(seals: readonly AnySeal[], auditId = AUD, sealsDir = tmpDir('lep5-')): string {
  for (const seal of seals) writeSealFile(sealsDir, auditId, seal.seq, seal);
  return sealsDir;
}
const nameOf = (seq: number): string => `seal-${String(seq).padStart(4, '0')}.json`;
const sealPath = (sealsDir: string, seq: number, auditId = AUD): string => path.join(sealsDir, auditId, nameOf(seq));
function replaceWith(sealsDir: string, seq: number, text: string, auditId = AUD): void {
  const file = sealPath(sealsDir, seq, auditId);
  fs.rmSync(file, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const classify = (sealsDir: string, evidences: readonly EvidenceToProve[], versions: readonly AcceptedSealVersion[] = [2], fsOps?: FsOps, list = LIST, auditId = AUD) =>
  evidenceProvenanceFromConfig({ sealsDir, trustKeys: list, acceptedVersions: versions }, fsOps).classify(auditId, evidences);
const UNAUTH = (reason: EvidenceTrustReason) => ({ status: 'UNAUTHENTICATED', reason });
const REVOKED = (...ids: string[]) => ({ status: 'UNAUTHENTICATED', reason: 'SEAL_KEY_REVOKED', revokedKeyIds: [...ids].sort() });
const BOTH: ReadonlyArray<readonly AcceptedSealVersion[]> = [[2], [1, 2]];
async function expectFor(sealsDir: string, evidences: readonly EvidenceToProve[], expected: unknown, label: string, versionsList = BOTH, fsOps?: FsOps): Promise<void> {
  for (const versions of versionsList) assert.deepEqual(await classify(sealsDir, evidences, versions, fsOps), expected, `${label} ${JSON.stringify(versions)}`);
}
const failingRead = (seq: number, failure: () => never = () => { throw errno('EIO'); }): FsOps =>
  faulty({ readFile: async (target, maxBytes) => (path.basename(target) === nameOf(seq) ? failure() : nodeFsOps.readFile(target, maxBytes)) });

/** In-memory read-only FsOps that records every call; `declared` can make lstat report a size other than the content's. */
function memoryFs(files: ReadonlyMap<string, string>, declared: ReadonlyMap<string, number> = new Map()): { readonly fs: FsOps; readonly reads: Array<{ readonly name: string; readonly maxBytes: number }> } {
  const reads: Array<{ readonly name: string; readonly maxBytes: number }> = [];
  const dirs = new Set([...files.keys()].flatMap((file) => [path.dirname(file), path.dirname(path.dirname(file))]));
  const info = (kind: 'file' | 'dir', size = 0): FileInfo => ({ isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => false, size, mtimeMs: 0 });
  const refuse = async (): Promise<never> => Promise.reject(new Error('write attempted'));
  const memory: FsOps = {
    lstat: async (target) => (dirs.has(target) ? info('dir') : files.has(target) ? info('file', declared.get(target) ?? Buffer.byteLength(files.get(target) as string)) : Promise.reject(errno('ENOENT'))),
    readdir: async (dir) => [...files.keys()].filter((file) => path.dirname(file) === dir).map((file) => path.basename(file)),
    realpath: async (target) => target,
    readFile: async (target, maxBytes) => {
      reads.push({ name: path.basename(target), maxBytes });
      const content = files.get(target);
      if (content === undefined) throw errno('ENOENT');
      if (Buffer.byteLength(content) > maxBytes) throw errno('ETOOBIG'); // what the descriptor check of the real FsOps does
      return content;
    },
    mkdir: refuse,
    writeExclusive: refuse,
    link: refuse,
    unlink: refuse,
    chmod: refuse,
    syncDirectory: refuse,
  };
  return { fs: memory, reads };
}
const MEMORY_ROOT = '/memoria/selos';
const junk = (bytes: number): string => `{${' '.repeat(bytes - 2)}}`;

/* ============================================================================================ V2-27, V2-28 */

test('V2-27 (D12, question 12) an AUTHENTIC signature of a revoked key at any position is SEAL_KEY_REVOKED with revokedKeyIds; an invalid one gives no signal', async () => {
  for (const [label, keys] of [['first', [K, A, A]], ['middle', [A, K, A]], ['last', [A, A, K]]] as const) {
    await expectFor(writeChain(buildChain(keys.map((k, i) => ({ keys: k, entries: [E1, E2, E3][i] as readonly EvidenceToProve[] })))), E3, REVOKED(K.keyId), `revoked ${label}`);
  }
  await expectFor(writeChain(buildChain([{ keys: K, entries: E1 }, { keys: L, entries: E2 }, { keys: A, entries: E3 }])), E3, REVOKED(K.keyId, L.keyId), 'two revoked keys, sorted');
  const three = await classify(writeChain(buildChain([{ keys: M, entries: E1 }, { keys: L, entries: E2 }, { keys: K, entries: E3 }])), E3);
  assert.deepEqual(three, REVOKED(K.keyId, L.keyId), 'at most 2 public ids (contract §7.2)');
  // a file that SAYS a revoked keyId but whose signature does not verify under it: SEAL_INVALID, and no signal
  const seals = buildChain([{ keys: A, entries: E1 }, { keys: K, entries: E2 }]);
  const forged = writeChain([seals[0] as AnySeal, signedBy(bodyOf(seals[1] as AnySeal), A)]);
  await expectFor(forged, E2, UNAUTH('SEAL_INVALID'), 'revoked keyId, signature of another key');
});

test('V2-27 (review MAJOR) the pre-step verifies on a LENIENT parse: a revoked seal with an escape or a duplicate key still signals; active-key or badly signed copies do not', async () => {
  const escape = (text: string): string => text.replace('"LINK_AUDIT_EVIDENCE_SEAL"', '"LINK\\u005fAUDIT_EVIDENCE_SEAL"');
  const representations: ReadonlyArray<readonly [string, (text: string) => string]> = [
    ['escaped character', escape],
    ['duplicate key (the last one carries the signed value)', (text) => text.replace(/^\{/, '{"seq":99,')],
  ];
  for (const [label, rewrite] of representations) {
    const revoked = buildChain([{ keys: A, entries: E1 }, { keys: K, entries: E2 }]);
    const original = JSON.stringify(revoked[1]);
    assert.notEqual(rewrite(original), original, label);
    assert.deepEqual(JSON.parse(rewrite(original)), JSON.parse(original), `${label}: JSON.parse sees the very same seal`);
    const dir = writeChain(revoked);
    replaceWith(dir, 2, rewrite(original));
    await expectFor(dir, E2, REVOKED(K.keyId), `revoked key, ${label}`);
    // the same representation signed by an ACTIVE key: the strict rules refuse it at row 8, and there is nothing to signal
    const active = buildChain([{ keys: A, entries: E1 }, { keys: B, entries: E2 }]);
    const activeDir = writeChain(active);
    replaceWith(activeDir, 2, rewrite(JSON.stringify(active[1])));
    await expectFor(activeDir, E2, UNAUTH('SEAL_INVALID'), `active key, ${label}`);
    // lenient-parsable, claims the revoked key, signed by another key: no signal
    const forgedDir = writeChain(revoked);
    replaceWith(forgedDir, 2, rewrite(JSON.stringify(signedBy(bodyOf(revoked[1] as AnySeal), A))));
    await expectFor(forgedDir, E2, UNAUTH('SEAL_INVALID'), `invalid signature, ${label}`);
  }
  // the v1 signing rule too, under production [2]
  const v1 = buildChain([{ keys: K, entries: E1, version: 1 }]);
  const v1Dir = writeChain(v1);
  replaceWith(v1Dir, 1, escape(JSON.stringify(v1[0])));
  assert.deepEqual(await classify(v1Dir, E1, [2]), REVOKED(K.keyId), 'escaped v1 of the revoked key');
  // still bound to THIS audit: an escaped copy of another audit's revoked seal never signals
  const crossDir = tmpDir('lep5-');
  replaceWith(crossDir, 1, escape(JSON.stringify(buildChain([{ keys: K, entries: E1 }], OTHER)[0])));
  await expectFor(crossDir, E1, UNAUTH('SEAL_INVALID'), "escaped copy of another audit's revoked seal");
});

test('V2-27 (review MAJOR, 2nd reading) the pre-step does not filter on schemaVersion: a revoked seal labelled 3 or without a version still signals; an active one does not', async () => {
  const relabelled = (seal: AnySeal, keys: EvidenceKeys, version: 3 | undefined): AnySeal => {
    const body = bodyOf(seal);
    if (version === undefined) delete body.schemaVersion;
    else body.schemaVersion = version;
    return signedBy(body, keys); // well signed over the relabelled body
  };
  for (const [label, version] of [['schemaVersion 3', 3], ['no schemaVersion', undefined]] as const) {
    const revoked = buildChain([{ keys: A, entries: E1 }, { keys: K, entries: E2 }]);
    await expectFor(writeChain([revoked[0] as AnySeal, relabelled(revoked[1] as AnySeal, K, version)]), E2, REVOKED(K.keyId), `revoked key, ${label}`);
    // the same by an ACTIVE key: no signal; [1,2] takes path B for an unknown latest version (V2-48) and row 8 refuses it, as [2] does
    const active = buildChain([{ keys: A, entries: E1 }, { keys: B, entries: E2 }]);
    await expectFor(writeChain([active[0] as AnySeal, relabelled(active[1] as AnySeal, B, version)]), E2, UNAUTH('SEAL_INVALID'), `active key, ${label}`);
  }
});

test('V2-28 (M1) the revocation signal WINS over a corrupted last seal, a gap, non-cumulativity, a broken link, a downgrade, an unknown or uncovered key; a deleted folder gives NO_SEAL', async () => {
  const base = (): AnySeal[] => buildChain([{ keys: K, entries: E1 }, { keys: A, entries: E2 }, { keys: A, entries: E3 }]);
  const corrupted = writeChain(base());
  replaceWith(corrupted, 3, '{ não é json');
  await expectFor(corrupted, E3, REVOKED(K.keyId), 'last seal corrupted');
  const gap = writeChain(base());
  fs.rmSync(sealPath(gap, 2));
  await expectFor(gap, E3, REVOKED(K.keyId), 'gap');
  const cases: ReadonlyArray<readonly [string, readonly Position[], readonly AcceptedSealVersion[]]> = [
    ['not cumulative', [{ keys: K, entries: E2 }, { keys: A, entries: E1 }], [2]],
    ['broken link', [{ keys: K, entries: E1 }, { keys: A, entries: E2, prev: 'f'.repeat(64) }], [2]],
    ['downgrade (v2 then v1)', [{ keys: K, entries: E1 }, { keys: A, entries: E2, version: 1 }], [2]],
    ['version not allowed (v1 before the revoked v2)', [{ keys: A, entries: E1, version: 1 }, { keys: K, entries: E2 }], [2]],
    ['unknown key elsewhere', [{ keys: K, entries: E1 }, { keys: X, entries: E2 }], [2]],
    ['retired key without a pinned closure', [{ keys: K, entries: E1 }, { keys: R, entries: E2 }], [2]],
  ];
  for (const [label, positions, versions] of cases) assert.deepEqual(await classify(writeChain(buildChain(positions)), E2, versions), REVOKED(K.keyId), label);
  assert.deepEqual(await classify(writeChain(base()), [ev('capture:c0009', 'f')]), REVOKED(K.keyId), 'evidence that the head does not cover');
  const deleted = writeChain(base());
  fs.rmSync(path.join(deleted, AUD), { recursive: true });
  await expectFor(deleted, E3, UNAUTH('NO_SEAL'), 'folder deleted: nothing read, no signal (residual i)');
  // DECLARED LIMIT of the library default (contract §4.3): [1,2] with a v1 last runs today's verifier and never scans below it
  assert.deepEqual(await classify(writeChain(buildChain([{ keys: K, entries: E1 }, { keys: A, entries: E2, version: 1 }])), E2, [1, 2]), { status: 'AUTHENTICATED' }, '[1,2] v1 last: path A, registered');
});

/* ============================================================================================ V2-43, V2-44 */

test('V2-43 (N3) a seal of audit Y signed by a revoked key, copied into X, gives NO revokedKeyIds and SEAL_INVALID: the pre-step checks auditId and the file seq', async () => {
  const theirs = buildChain([{ keys: K, entries: E1 }, { keys: K, entries: E2 }], OTHER);
  const copiedFirst = writeChain([theirs[0] as AnySeal]); // Y's seal-0001 as X's seal-0001
  await expectFor(copiedFirst, E1, UNAUTH('SEAL_INVALID'), "Y's revoked seal under X");
  const mixed = writeChain([buildChain([{ keys: A, entries: E1 }])[0] as AnySeal]);
  writeSealFile(mixed, AUD, 2, theirs[1]);
  await expectFor(mixed, E2, UNAUTH('SEAL_INVALID'), "Y's revoked seal-0002 inside X's chain");
  const mine = buildChain([{ keys: A, entries: E1 }, { keys: K, entries: E2 }]);
  const misnamed = writeChain([mine[0] as AnySeal]);
  writeSealFile(misnamed, AUD, 2, buildChain([{ keys: A, entries: E1 }])[0]);
  writeSealFile(misnamed, AUD, 3, mine[1]); // X's own revoked seq 2 under the name seal-0003
  await expectFor(misnamed, E2, UNAUTH('SEAL_INVALID'), 'own revoked seal under another seq');
  await expectFor(writeChain(mine), E2, REVOKED(K.keyId), 'control: the same seal at its own name signals');
});

test('V2-44 (N4) a file > 256 KiB, an I/O error or a directory elsewhere does not suppress the signal; the byte budget stops reading and what is unread is not examined', async () => {
  const seals = buildChain([{ keys: K, entries: E1 }, { keys: A, entries: E2 }, { keys: A, entries: E3 }]);
  const big = writeChain(seals);
  replaceWith(big, 2, ' '.repeat(MAX_SEAL_BYTES + 1));
  await expectFor(big, E3, REVOKED(K.keyId), 'a manifest above 256 KiB');
  await expectFor(writeChain(seals), E3, REVOKED(K.keyId), 'an I/O error', BOTH, failingRead(3));
  const dir = writeChain(seals);
  fs.rmSync(sealPath(dir, 2));
  fs.mkdirSync(sealPath(dir, 2));
  await expectFor(dir, E3, REVOKED(K.keyId), 'a directory');
  // the budget: files read before it is exceeded are examined; the rest are not (residual ii, contract §7.2)
  const revokedSeal = JSON.stringify(buildChain([{ keys: K, entries: E1 }])[0]);
  const early = new Map<string, string>([[path.join(MEMORY_ROOT, AUD, nameOf(1)), revokedSeal], ...Array.from({ length: 69 }, (_, i) => [path.join(MEMORY_ROOT, AUD, nameOf(i + 2)), junk(250_000)] as const)]);
  assert.deepEqual(await classify(MEMORY_ROOT, E1, [2], memoryFs(early).fs), REVOKED(K.keyId), 'revoked seal read before the budget ran out');
  const lateSeq = 70;
  // a VALID revoked seal at seq 70 (it would signal if it were read): only the budget keeps it out of the pre-step
  const lateSeal = createEvidenceSealV2({ auditId: AUD, seq: lateSeq, sealedAt: '2026-11-19T10:00:00.000Z', keyId: K.keyId, privateKey: K.privateKey, entries: plain(E1), dossier: DOSSIER, prevSealSha256: 'ab'.repeat(32) });
  const late = new Map<string, string>([...Array.from({ length: lateSeq - 1 }, (_, i) => [path.join(MEMORY_ROOT, AUD, nameOf(i + 1)), junk(250_000)] as const), [path.join(MEMORY_ROOT, AUD, nameOf(lateSeq)), JSON.stringify(lateSeal)]]);
  const memory = memoryFs(late);
  assert.deepEqual(await classify(MEMORY_ROOT, E1, [2], memory.fs), UNAUTH('VERIFICATION_ERROR'), 'budget exceeded before the revoked file: not examined');
  assert.ok(!memory.reads.some(({ name }) => name === nameOf(lateSeq)), 'the file after the budget is never read');
});

/* ============================================================================================ V2-31, V2-32 */

test('V2-31 (m2, m5) seal-0000 or N > 256 fail with ZERO reads under [2] (and no signal); every manifest and closure is read exactly once', async () => {
  assert.equal(MAX_CHAIN_SEALS, 256);
  const revoked = buildChain([{ keys: K, entries: E1 }, { keys: A, entries: E2 }]);
  for (const [label, extra] of [['seal-0000', 0], ['N = 257', MAX_CHAIN_SEALS + 1]] as const) {
    const dir = writeChain(revoked);
    writeSealFile(dir, AUD, extra, revoked[0]);
    const spy = recordingFs();
    assert.deepEqual(await classify(dir, E2, [2], spy.fs), UNAUTH('SEAL_CHAIN_BROKEN'), `${label} (nothing read: residual i)`);
    assert.deepEqual(spy.reads, [], `${label}: zero reads`);
    const compatible = recordingFs();
    assert.deepEqual(await classify(dir, E2, [1, 2], compatible.fs), UNAUTH('SEAL_CHAIN_BROKEN'), `${label} [1,2]`);
    assert.ok(compatible.reads.length <= 1, `${label} [1,2]: at most the latest, read to choose the path (registered)`);
  }
  // read once: a chain with a retired key covered by its pinned closure (manifests AND the closure)
  const covered = buildChain([{ keys: R, entries: E1 }, { keys: R, entries: E2 }, { keys: A, entries: E3 }]);
  const dir = writeChain(covered);
  const closureText = `${JSON.stringify(createKeyRetirementClosure({ retiredKeyId: R.keyId, signerKeyId: A.keyId, sealedAt: '2026-11-20T08:00:00.000Z', heads: [{ auditId: AUD, seq: 3, sealSha256: sealSha256(covered[2] as AnySeal) }], privateKey: A.privateKey }), null, 2)}\n`;
  fs.mkdirSync(path.join(dir, '_closures'));
  fs.writeFileSync(path.join(dir, '_closures', `${R.keyId}.json`), closureText);
  const pinned = LIST.replace(`${R.keyId}:${R.publicRaw}:retired`, `${R.keyId}:${R.publicRaw}:retired:${createHash('sha256').update(closureText).digest('hex')}`);
  for (const versions of BOTH) {
    const spy = recordingFs();
    assert.equal((await classify(dir, E3, versions, spy.fs, pinned)).status, 'AUTHENTICATED', JSON.stringify(versions));
    assert.deepEqual([...spy.reads].sort(), [`${R.keyId}.json`, nameOf(1), nameOf(2), nameOf(3)].sort(), `${JSON.stringify(versions)}: each file exactly once`);
  }
});

function recordingFs(): { readonly fs: FsOps; readonly reads: string[] } {
  const reads: string[] = [];
  return { fs: faulty({ readFile: async (target, maxBytes) => (reads.push(path.basename(target)), nodeFsOps.readFile(target, maxBytes)) }), reads };
}

test('V2-31 (m5, W3.3 review) the budget is checked BEFORE reading: a file larger than what is left is never opened, and readFile is capped at the remaining budget', async () => {
  assert.equal(MAX_CLASSIFY_BYTES, 16 * 1024 * 1024);
  const nearlyFull = 64 * 262_000; // 16_768_000 bytes of manifests first
  const remaining = MAX_CLASSIFY_BYTES - nearlyFull; // 9_216 left
  const files = new Map<string, string>(Array.from({ length: 64 }, (_, i) => [path.join(MEMORY_ROOT, AUD, nameOf(i + 1)), junk(262_000)] as const));
  files.set(path.join(MEMORY_ROOT, AUD, nameOf(65)), junk(9_000)); // fits in what is left
  files.set(path.join(MEMORY_ROOT, AUD, nameOf(66)), junk(5_000)); // does not: only 216 bytes remain
  const memory = memoryFs(files);
  assert.deepEqual(await classify(MEMORY_ROOT, E1, [2], memory.fs), UNAUTH('VERIFICATION_ERROR'));
  assert.equal(memory.reads.find(({ name }) => name === nameOf(65))?.maxBytes, remaining, 'readFile gets min(MAX_SEAL_BYTES, remaining budget)');
  assert.ok(memory.reads.every(({ maxBytes }) => maxBytes <= MAX_SEAL_BYTES));
  assert.ok(!memory.reads.some(({ name }) => name === nameOf(66)), 'refused BEFORE reading: never opened');
  // a file that declares less than it holds is still bounded by the descriptor check of readFile
  const growing = new Map(files);
  growing.delete(path.join(MEMORY_ROOT, AUD, nameOf(66)));
  growing.set(path.join(MEMORY_ROOT, AUD, nameOf(65)), junk(9_300));
  const lying = memoryFs(growing, new Map([[path.join(MEMORY_ROOT, AUD, nameOf(65)), 1_000]]));
  assert.deepEqual(await classify(MEMORY_ROOT, E1, [2], lying.fs), UNAUTH('VERIFICATION_ERROR'), 'declared 1 000, holds 9 300 > 9 216 left');
});

test('V2-32 (IA-13, RS-20) an unreadable entry at any position gives a fixed reason, never throws and never hangs', async () => {
  const seals = buildChain([{ keys: A, entries: E1 }, { keys: A, entries: E2 }, { keys: B, entries: E3 }]);
  const variants: ReadonlyArray<readonly [string, (dir: string, seq: number) => FsOps | undefined, EvidenceTrustReason]> = [
    ['not JSON', (dir, seq) => (replaceWith(dir, seq, '{ não é json'), undefined), 'SEAL_INVALID'],
    ['empty', (dir, seq) => (replaceWith(dir, seq, ''), undefined), 'SEAL_INVALID'],
    ['a directory', (dir, seq) => (fs.rmSync(sealPath(dir, seq)), fs.mkdirSync(sealPath(dir, seq)), undefined), 'SEAL_INVALID'],
    ['a symbolic link', (dir, seq) => {
      const elsewhere = path.join(tmpDir('lep5-elsewhere-'), 'seal.json');
      fs.writeFileSync(elsewhere, fs.readFileSync(sealPath(dir, seq)));
      fs.rmSync(sealPath(dir, seq));
      fs.symlinkSync(elsewhere, sealPath(dir, seq));
      return undefined;
    }, 'SEAL_INVALID'],
    ['a FIFO', (dir, seq) => (fs.rmSync(sealPath(dir, seq)), execFileSync('mkfifo', [sealPath(dir, seq)]), undefined), 'SEAL_INVALID'],
    ['above 256 KiB', (dir, seq) => (replaceWith(dir, seq, ' '.repeat(MAX_SEAL_BYTES + 1)), undefined), 'VERIFICATION_ERROR'],
    ['an I/O error', (_dir, seq) => failingRead(seq), 'VERIFICATION_ERROR'],
    ['a forced exception that is not an Error', (_dir, seq) => failingRead(seq, () => { throw 'falha forçada'; }), 'VERIFICATION_ERROR'],
    ['an lstat whose answer throws', (_dir, seq) => faulty({
      lstat: async (target) => {
        if (path.basename(target) !== nameOf(seq)) return nodeFsOps.lstat(target);
        return { isFile: () => { throw new Error('falha forçada'); }, isDirectory: () => false, isSymbolicLink: () => false, size: 1, mtimeMs: 0 };
      },
    }), 'VERIFICATION_ERROR'],
  ];
  for (const seq of [2, 3]) {
    for (const [label, damage, reason] of variants) {
      const dir = writeChain(seals);
      const fsOps = damage(dir, seq);
      const started = process.hrtime.bigint();
      for (const versions of BOTH) {
        const verdict = await classify(dir, E3, versions, fsOps).catch((error: unknown) => ({ threw: String(error) }));
        assert.deepEqual(verdict, UNAUTH(reason), `seal-000${seq} ${label} ${JSON.stringify(versions)}`);
      }
      assert.ok(process.hrtime.bigint() - started < 3_000_000_000n, `seal-000${seq} ${label}: did not hang`);
    }
  }
});

/* ============================================================================================ V2-29 */

test('V2-29 (question 12) revocation never touches history: the verifier only reads seals and closures, writes nothing, and the preview only forwards the reason', async () => {
  const w = await world();
  const sealsDir = tmpDir('lep5-');
  await sealAuditV2ForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys: K });
  const active = `${K.keyId}:${K.publicRaw}`;
  const revokedList = `${K.keyId}:${K.publicRaw}:revoked`;
  const policyWith = (list: string, fsOps?: FsOps) => evidenceProvenanceFromConfig({ sealsDir, trustKeys: list, acceptedVersions: [2] }, fsOps);
  // a result confirmed while K was active
  const before = await previewOver(w, { evidenceProvenance: policyWith(active) }).evaluate(OP_A, w.auditId);
  assert.ok(before.ok && before.value.payload.finalization.allowed, JSON.stringify(before).slice(0, 200));
  const e = resultsEnv();
  const done = await makeService(e, previewOver(w, { evidenceProvenance: policyWith(active) })).finalize(OP_A, w.auditId, { expectedHead: before.value.decisions.head, expectedInputSha256: before.value.inputSha256 as string });
  assert.ok(done.ok, JSON.stringify(done).slice(0, 200));
  const snapshot = (): string => JSON.stringify([e.base, e.anchors, sealsDir, w.evidenceDir, w.decisionsDir].map((root) => listTree(root)));
  const recorded = snapshot();
  // K is revoked now: the preview forwards the reason (only status, reason and missingRefs reach the DTO) and blocks new finalizations
  const spy = callLog();
  const after = await previewOver(w, { evidenceProvenance: policyWith(revokedList, spy.fs) }).evaluate(OP_A, w.auditId);
  assert.ok(after.ok, JSON.stringify(after).slice(0, 200));
  assert.deepEqual(after.value.payload.evidence.provenance, { status: 'UNAUTHENTICATED', reason: 'SEAL_KEY_REVOKED', missingRefs: [] });
  assert.ok(after.value.payload.blockers.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' && b.reasonCode === 'SEAL_KEY_REVOKED'));
  assert.equal(after.value.payload.finalization.allowed, false);
  const basis = await createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true }).readScoringBasis({ email: 'conferente@teste.invalid' }, w.auditId);
  if (basis.status !== 'READY') throw new Error(basis.status);
  assert.deepEqual(await policyWith(revokedList).classify(w.auditId, evidenceToProveFromBasis(basis.basis)), REVOKED(K.keyId), 'the policy itself carries revokedKeyIds');
  assert.equal(snapshot(), recorded, 'nothing recorded changed: results, receipts, seals, evidence, decisions');
  assert.ok(spy.calls.length > 0 && spy.calls.every(({ op }) => ['lstat', 'readdir', 'readFile', 'realpath'].includes(op)), `only reads: ${[...new Set(spy.calls.map((c) => c.op))].join(', ')}`);
  assert.ok(spy.calls.every(({ target }) => target.startsWith(path.join(sealsDir, w.auditId)) || target.startsWith(path.join(sealsDir, '_closures'))), 'only <sealsDir>/<auditId> and _closures');
});

function listTree(root: string): Array<readonly [string, string]> {
  if (!fs.existsSync(root)) return [];
  const out: Array<readonly [string, string]> = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push([path.relative(root, full), createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
    }
  };
  visit(root);
  return out.sort(([a], [b]) => (a < b ? -1 : 1));
}
function callLog(): { readonly fs: FsOps; readonly calls: Array<{ readonly op: string; readonly target: string }> } {
  const calls: Array<{ readonly op: string; readonly target: string }> = [];
  const logged = new Proxy(nodeFsOps, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push({ op: String(property), target: String(args[0]) });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { fs: logged, calls };
}
