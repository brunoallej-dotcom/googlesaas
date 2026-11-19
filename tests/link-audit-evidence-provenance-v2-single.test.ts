import assert from 'node:assert/strict';
import { sign as cryptoSign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PROVENANCE_REASON_LABELS } from '../src/components/link-audit/audit-page/labels';
import { isPreviewPayload } from '../src/components/link-audit/audit-page/validators';
import { canonicalJson } from '../src/lib/link-audit/canonical';
import { nodeFsOps, type FileInfo, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { evidenceToProveFromBasis } from '../src/lib/link-audit-evidence/evidence-to-prove';
import {
  createEvidenceSeal,
  createEvidenceSealV2,
  createSealedEvidenceProvenance,
  evidenceProvenanceFromConfig,
  parseTrustKeys,
  sealSha256,
  type AcceptedSealVersion,
  type EvidenceProvenancePolicy,
  type EvidenceSealFileV2,
  type EvidenceToProve,
  type EvidenceTrustReason,
  type TrustKeyring,
} from '../src/lib/link-audit-evidence/provenance';
import { createScoringBasisReader } from '../src/lib/link-audit-evidence/scoring-basis';
import { sealed } from '../src/lib/link-audit-evidence/store';
import { reportName } from '../src/lib/link-audit-evidence/types';
import { AUDIT as UI_AUDIT, previewFixture } from './helpers/link-audit-audit-page-fixtures';
import { registerCleanup, tmpDir, world } from './helpers/link-audit-decisions-fixtures';
import { evidenceKeys, sealAuditV2ForTests, writeSealFile, type EvidenceKeys } from './helpers/link-audit-evidence-provenance-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { OP_B } from './helpers/link-audit-results-fixtures';

/*
 * W3.2 — the verifier for ONE v2 manifest (`seq` 1) next to the unchanged v1 path (contract `p1-contrato-verificador-v2.md` §3, §4, §8, §9, §11).
 * Covers V2-01, V2-03 to V2-07, V2-19, V2-34, V2-35, V2-40 and V2-41 (IA-03, IA-21, RS-09, RS-10, RS-20, M3, D12). The golden vectors (V2-38)
 * live in `link-audit-evidence-provenance-v2-golden.test.ts`. Chains (seq > 1) are W3.3; keyring states and the closure W3.4; revocation W3.5.
 */
registerCleanup();

const AUD = 'auditoria-prova-v2-02';
const SEALED_AT = '2026-11-19T12:00:00.000Z';
const DOSSIER = { id: 'dossie-prova-v2-02', sha256: 'c'.repeat(64) };
const SAMPLE: EvidenceToProve[] = [
  { ref: 'capture:c0001', contentSha256: 'a'.repeat(64), legacy: false },
  { ref: 'report:c0001-r0001', contentSha256: 'b'.repeat(64), legacy: false },
];
const KEYS_A = evidenceKeys('ek-teste-v2-a');
const KEYS_B = evidenceKeys('ek-teste-v2-b');
/** `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` value with only key A (public part). */
const LIST_A = KEYS_A.trustKeys;

const v2Of = (keys: EvidenceKeys, over: Partial<Parameters<typeof createEvidenceSealV2>[0]> = {}): EvidenceSealFileV2 =>
  createEvidenceSealV2({ auditId: AUD, seq: 1, sealedAt: SEALED_AT, keyId: keys.keyId, privateKey: keys.privateKey, entries: SAMPLE, dossier: DOSSIER, prevSealSha256: null, ...over });
const v1Of = (keys: EvidenceKeys, over: Partial<Parameters<typeof createEvidenceSeal>[0]> = {}) =>
  createEvidenceSeal({ auditId: AUD, seq: 1, sealedAt: SEALED_AT, keyId: keys.keyId, privateKey: keys.privateKey, entries: SAMPLE, ...over });
const trusted = (...keys: EvidenceKeys[]): ReadonlyMap<string, KeyObject> => parseTrustKeys(keys.map((k) => k.trustKeys).join(',')) as ReadonlyMap<string, KeyObject>;
function policy(sealsDir: string, versions?: readonly AcceptedSealVersion[], keys: readonly EvidenceKeys[] = [KEYS_A, KEYS_B], fsOps?: FsOps): EvidenceProvenancePolicy {
  return createSealedEvidenceProvenance({ sealsDir, trustedKeys: trusted(...keys), ...(versions ? { acceptedVersions: versions } : {}), ...(fsOps ? { fs: fsOps } : {}) });
}
/** Re-signed by hand: bypasses the producer guards to build well-signed but adversarial files. */
function resigned(body: Record<string, unknown>, keys: EvidenceKeys): Record<string, unknown> {
  return { ...body, signature: cryptoSign(null, Buffer.from(canonicalJson(body), 'utf8'), keys.privateKey).toString('base64url') };
}
const bodyOf = (file: { readonly signature: string }): Record<string, unknown> => {
  const { signature, ...body } = file;
  void signature;
  return body;
};
/** Writes the EXACT text given (no re-serialization), read-only like a delivered manifest. */
function writeSealText(sealsDir: string, auditId: string, seq: number, text: string): void {
  const dir = path.join(sealsDir, auditId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `seal-${String(seq).padStart(4, '0')}.json`);
  if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o444);
}
const differingBytes = (a: string, b: string): number => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return Number.POSITIVE_INFINITY;
  let count = 0;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) count += 1;
  return count;
};
const UNAUTH = (reason: EvidenceTrustReason) => ({ status: 'UNAUTHENTICATED', reason });

/* ============================================================================================ V2-01 */

test('V2-01 (IA-03, IA-21) a valid v2 seal (chain of 1) over readScoringBasis is AUTHENTICATED and returns headSeq, headSealSha256 and keyIds', async () => {
  const w = await world();
  const sealsDir = tmpDir('lep2-');
  const seal = await sealAuditV2ForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys: KEYS_A });
  const basis = await createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true }).readScoringBasis({ email: 'conferente@teste.invalid' }, w.auditId);
  if (basis.status !== 'READY') throw new Error(basis.status);
  const evidences = evidenceToProveFromBasis(basis.basis);
  for (const versions of [[2], [1, 2], undefined] as const) {
    assert.deepEqual(await policy(sealsDir, versions).classify(w.auditId, evidences), { status: 'AUTHENTICATED', headSeq: 1, headSealSha256: sealSha256(seal), keyIds: [KEYS_A.keyId] }, `versions ${JSON.stringify(versions)}`);
  }
  // the preview consumes only the status: v2 makes the audit finalizable and the head metadata stays on the server (not in the DTO)
  const evaluated = await previewOver(w, { evidenceProvenance: policy(sealsDir, [2]) }).evaluate(OP_B, w.auditId);
  assert.ok(evaluated.ok, JSON.stringify(evaluated).slice(0, 200));
  assert.deepEqual(evaluated.value.payload.evidence.provenance, { status: 'AUTHENTICATED', reason: null, missingRefs: [] });
  assert.equal(evaluated.value.payload.finalization.allowed, true);
});

/* ============================================================================================ V2-03 */

test('V2-03 (IA-03 a-c, RS-09) one changed byte in any field of the seal is UNAUTHENTICATED; re-signed with a wrong prev is SEAL_CHAIN_BROKEN', async () => {
  const seal = v2Of(KEYS_A);
  const text = JSON.stringify(seal);
  const variants: ReadonlyArray<readonly [string, string]> = [
    ['contentSha256', text.replace(`"${'a'.repeat(64)}"`, `"${'a'.repeat(63)}b"`)],
    ['ref', text.replace('"capture:c0001"', '"capture:c0002"')],
    ['signature', text.replace(seal.signature, `${seal.signature.slice(0, 20)}${seal.signature[20] === 'A' ? 'B' : 'A'}${seal.signature.slice(21)}`)],
    ['seq', text.replace('"seq":1', '"seq":2')],
    ['keyId (another TRUSTED key)', text.replace('"ek-teste-v2-a"', '"ek-teste-v2-b"')],
    ['sealedAt', text.replace(SEALED_AT, '2026-11-19T12:00:00.001Z')],
    ['dossier.id', text.replace('"dossie-prova-v2-02"', '"dossie-prova-v2-03"')],
    ['dossier.sha256', text.replace(`"${'c'.repeat(64)}"`, `"${'c'.repeat(63)}d"`)],
    ['prevSealSha256', text.replace('"prevSealSha256":null', '"prevSealSha256":nulm')],
    ['auditId', text.replace(`"${AUD}"`, '"auditoria-prova-v2-03"')],
  ];
  for (const versions of [[2], [1, 2]] as const) {
    const sealsDir = tmpDir('lep2-');
    writeSealText(sealsDir, AUD, 1, text);
    assert.equal((await policy(sealsDir, versions).classify(AUD, SAMPLE)).status, 'AUTHENTICATED', 'positive control');
    for (const [label, variant] of variants) {
      assert.equal(differingBytes(text, variant), 1, `${label}: exactly one byte changed`);
      writeSealText(sealsDir, AUD, 1, variant);
      assert.deepEqual(await policy(sealsDir, versions).classify(AUD, SAMPLE), UNAUTH('SEAL_INVALID'), `${label} ${JSON.stringify(versions)}`);
    }
    // re-signed with a valid key, but `seq` 1 with a non-null prev: the chain does not close (contract §3 item 3, §8 row 11)
    writeSealFile(sealsDir, AUD, 1, resigned({ ...bodyOf(seal), prevSealSha256: 'e'.repeat(64) }, KEYS_A));
    assert.deepEqual(await policy(sealsDir, versions).classify(AUD, SAMPLE), UNAUTH('SEAL_CHAIN_BROKEN'), `wrong prev ${JSON.stringify(versions)}`);
  }
});

/* ============================================================================================ V2-04, V2-05 */

test('V2-04 (IA-03 d, IA-21) one changed byte in an evidence file (integrity seal redone) is EVIDENCE_HASH_MISMATCH and blocks finalization', async () => {
  const w = await world();
  const sealsDir = tmpDir('lep2-');
  await sealAuditV2ForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys: KEYS_A });
  const preview = previewOver(w, { evidenceProvenance: policy(sealsDir, [2]) });
  assert.equal((await preview.evaluate(OP_B, w.auditId)).ok, true);
  const file = path.join(w.evidenceDir, w.auditId, reportName(1, 1));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const { contentSha256, ...rest } = parsed;
  void contentSha256;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, `${JSON.stringify(sealed({ ...rest, generatedAt: '2026-10-23T09:59:59.001Z' }))}\n`); // what the store's own pipeline would write
  const evaluated = await preview.evaluate(OP_B, w.auditId);
  assert.ok(evaluated.ok, JSON.stringify(evaluated).slice(0, 200));
  assert.deepEqual(evaluated.value.payload.evidence.provenance, { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_HASH_MISMATCH', missingRefs: [] });
  assert.equal(evaluated.value.payload.finalization.allowed, false);
  // and at the policy level, one hex digit of difference is enough
  const dir = tmpDir('lep2-');
  writeSealFile(dir, AUD, 1, v2Of(KEYS_A));
  assert.deepEqual(await policy(dir, [2]).classify(AUD, [SAMPLE[0] as EvidenceToProve, { ...(SAMPLE[1] as EvidenceToProve), contentSha256: `${'b'.repeat(63)}c` }]), UNAUTH('EVIDENCE_HASH_MISMATCH'));
});

test('V2-05 (IA-21) two-way coverage on the v2 seal: evidence outside it is EVIDENCE_NOT_SEALED; attested evidence gone is EVIDENCE_MISSING (at most 5 refs)', async () => {
  const refs = ['capture:c0001', 'capture:c0002', 'capture:c0003', 'capture:c0004', 'report:c0001-r0001', 'report:c0002-r0001', 'report:c0003-r0001'];
  const all: EvidenceToProve[] = refs.map((ref, index) => ({ ref, contentSha256: String(index).repeat(64), legacy: false }));
  const sealsDir = tmpDir('lep2-');
  const seal = v2Of(KEYS_A, { entries: all });
  writeSealFile(sealsDir, AUD, 1, seal);
  const p = policy(sealsDir, [2]);
  assert.deepEqual(await p.classify(AUD, all), { status: 'AUTHENTICATED', headSeq: 1, headSealSha256: sealSha256(seal), keyIds: [KEYS_A.keyId] });
  assert.deepEqual(await p.classify(AUD, [all[0] as EvidenceToProve]), { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_MISSING', missingRefs: refs.slice(1, 6) });
  assert.deepEqual(await p.classify(AUD, [...all, { ref: 'capture:c0005', contentSha256: 'f'.repeat(64), legacy: false }]), UNAUTH('EVIDENCE_NOT_SEALED'));
});

/* ============================================================================================ V2-06, V2-07 */

test('V2-06 (IA-21) a v1 last seal keeps EXACTLY today\'s answer {status:"AUTHENTICATED"} on the compatible path (the v1 suite runs with no diff)', async () => {
  // The other half of V2-06 is a gate, not a test: `git diff --quiet origin/main -- tests/link-audit-evidence-provenance.test.ts`.
  const sealsDir = tmpDir('lep2-');
  writeSealFile(sealsDir, AUD, 1, v1Of(KEYS_A));
  for (const versions of [undefined, [1, 2], [2, 1], [1]] as const) assert.deepEqual(await policy(sealsDir, versions).classify(AUD, SAMPLE), { status: 'AUTHENTICATED' }, `versions ${JSON.stringify(versions)}`);
  assert.deepEqual(await evidenceProvenanceFromConfig({ sealsDir, trustKeys: LIST_A }).classify(AUD, SAMPLE), { status: 'AUTHENTICATED' }, 'library default [1,2]');
  // path A is today's verifier, raw-text rules included: an escape that decodes to the same v1 seal still authenticates there (declared limit,
  // contract §4.3); the walked path (production [2]) refuses the same bytes before looking at the version
  const escaped = JSON.stringify(v1Of(KEYS_A)).replace('"LINK_AUDIT_EVIDENCE_SEAL"', '"LINK\\u005fAUDIT_EVIDENCE_SEAL"');
  writeSealText(sealsDir, AUD, 1, escaped);
  assert.deepEqual(await policy(sealsDir, [1, 2]).classify(AUD, SAMPLE), { status: 'AUTHENTICATED' }, 'path A = exactly today');
  assert.deepEqual(await policy(sealsDir, [2]).classify(AUD, SAMPLE), UNAUTH('SEAL_INVALID'), 'path B: raw text first');
});

test('V2-07 (IA-21, RS-10) [1] refuses v2 (SEAL_INVALID) and the literal v1 schema refuses schemaVersion 2', async () => {
  const sealsDir = tmpDir('lep2-');
  writeSealFile(sealsDir, AUD, 1, v2Of(KEYS_A));
  assert.deepEqual(await policy(sealsDir, [1]).classify(AUD, SAMPLE), UNAUTH('SEAL_INVALID'), '[1] emulates the old verifier');
  // a v2 body relabelled `schemaVersion: 1` (re-signed): the strict v1 schema refuses the v2 fields
  writeSealFile(sealsDir, AUD, 1, resigned({ ...bodyOf(v2Of(KEYS_A)), schemaVersion: 1 }, KEYS_A));
  for (const versions of [[1], [1, 2], [2]] as const) assert.deepEqual(await policy(sealsDir, versions).classify(AUD, SAMPLE), UNAUTH('SEAL_INVALID'), `v2 fields as v1 ${JSON.stringify(versions)}`);
  // a v1 body relabelled `schemaVersion: 2` (re-signed): neither the v1 literal nor the strict v2 schema accepts it
  writeSealFile(sealsDir, AUD, 1, resigned({ ...bodyOf(v1Of(KEYS_A)), schemaVersion: 2 }, KEYS_A));
  for (const versions of [[1], [1, 2], [2]] as const) assert.deepEqual(await policy(sealsDir, versions).classify(AUD, SAMPLE), UNAUTH('SEAL_INVALID'), `v1 fields as v2 ${JSON.stringify(versions)}`);
});

/* ============================================================================================ V2-19 */

test('V2-19 (M3) invalid acceptedVersions, or keyring together with trustedKeys, close the policy (PROOF_NOT_CONFIGURED)', async () => {
  const sealsDir = tmpDir('lep2-');
  writeSealFile(sealsDir, AUD, 1, v2Of(KEYS_A));
  const closed = { status: 'UNAUTHENTICATED', reason: 'PROOF_NOT_CONFIGURED' };
  for (const versions of [[], [3], [2, 2], [1, 1], [1, 2, 2], [0], ['2'], [1, 2, 3], '2', null, {}]) {
    assert.deepEqual(await createSealedEvidenceProvenance({ sealsDir, trustedKeys: trusted(KEYS_A), acceptedVersions: versions as never }).classify(AUD, SAMPLE), closed, `policy ${JSON.stringify(versions)}`);
    assert.deepEqual(await evidenceProvenanceFromConfig({ sealsDir, trustKeys: LIST_A, acceptedVersions: versions as never }).classify(AUD, SAMPLE), closed, `config ${JSON.stringify(versions)}`);
  }
  const keyring: TrustKeyring = new Map([[KEYS_A.keyId, { key: trusted(KEYS_A).get(KEYS_A.keyId) as KeyObject, status: 'active' as const, closureSha256: null }]]);
  assert.deepEqual(await createSealedEvidenceProvenance({ sealsDir, trustedKeys: trusted(KEYS_A), keyring, acceptedVersions: [2] }).classify(AUD, SAMPLE), closed, 'keyring + trustedKeys together');
  // W3.2 hook (fail-closed): keyring states and closures arrive in W3.4; until then a keyring alone does not authenticate anything
  assert.deepEqual(await createSealedEvidenceProvenance({ sealsDir, keyring, acceptedVersions: [2] }).classify(AUD, SAMPLE), closed, 'keyring alone (until W3.4)');
  assert.deepEqual(await createSealedEvidenceProvenance({ sealsDir, acceptedVersions: [2] }).classify(AUD, SAMPLE), closed, 'no keys at all');
  assert.equal((await policy(sealsDir, [2, 1]).classify(AUD, SAMPLE)).status, 'AUTHENTICATED', '[2,1] is the same set as [1,2]');
});

test('V2-19 (M3) production [2]: a well-signed v1 seal is SEAL_VERSION_NOT_ALLOWED; a badly signed one is SEAL_INVALID first (row 8 before row 10)', async () => {
  const sealsDir = tmpDir('lep2-');
  writeSealFile(sealsDir, AUD, 1, v1Of(KEYS_A));
  assert.deepEqual(await policy(sealsDir, [2]).classify(AUD, SAMPLE), UNAUTH('SEAL_VERSION_NOT_ALLOWED'));
  assert.deepEqual(await evidenceProvenanceFromConfig({ sealsDir, trustKeys: LIST_A, acceptedVersions: [2] }).classify(AUD, SAMPLE), UNAUTH('SEAL_VERSION_NOT_ALLOWED'));
  writeSealFile(sealsDir, AUD, 1, v1Of(evidenceKeys('ek-atacante-01')));
  assert.deepEqual(await policy(sealsDir, [2]).classify(AUD, SAMPLE), UNAUTH('SEAL_INVALID'), 'unknown key');
  writeSealFile(sealsDir, AUD, 1, { ...v1Of(KEYS_A), signature: v1Of(KEYS_B).signature });
  assert.deepEqual(await policy(sealsDir, [2]).classify(AUD, SAMPLE), UNAUTH('SEAL_INVALID'), 'signature of another key');
  const v2 = v2Of(KEYS_A);
  writeSealFile(sealsDir, AUD, 1, v2);
  assert.deepEqual(await evidenceProvenanceFromConfig({ sealsDir, trustKeys: LIST_A, acceptedVersions: [2] }).classify(AUD, SAMPLE), { status: 'AUTHENTICATED', headSeq: 1, headSealSha256: sealSha256(v2), keyIds: [KEYS_A.keyId] });
});

/* ----- static part of V2-19: every caller outside tests/ chooses acceptedVersions explicitly; production is [2] ----- */
const ROOT = path.join(__dirname, '..');
const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
    return /\.(?:ts|tsx|js|cjs|mjs)$/.test(entry.name) ? [full] : [];
  });
}
/** The argument text of each CALL (not the definition) of `name`, up to the matching parenthesis. */
function callArguments(code: string, name: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`, 'g'))) {
    let depth = 0;
    const start = (match.index ?? 0) + match[0].length - 1;
    for (let i = start; i < code.length; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')' && (depth -= 1) === 0) {
        found.push(code.slice(start + 1, i));
        break;
      }
    }
  }
  return found;
}

test('V2-19 (M3, static) every caller outside tests/ passes acceptedVersions explicitly, production passes [2], and only provenance.ts still builds trustedKeys', () => {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))];
  const calls: Array<readonly [string, string]> = [];
  for (const file of files) {
    const code = strip(fs.readFileSync(file, 'utf8'));
    for (const name of ['createSealedEvidenceProvenance', 'evidenceProvenanceFromConfig']) for (const args of callArguments(code, name)) calls.push([path.relative(ROOT, file), args]);
    // `trustedKeys` (every key active) is test-only (contract §5). Narrow, per-file allowance: provenance.ts itself, until W3.4 moves
    // `evidenceProvenanceFromConfig` to `parseTrustKeyring`.
    if (/\btrustedKeys\s*:/.test(code)) assert.equal(path.relative(ROOT, file), path.join('src', 'lib', 'link-audit-evidence', 'provenance.ts'), `${path.relative(ROOT, file)} passes trustedKeys`);
  }
  assert.ok(calls.length >= 2, `callers found: ${calls.map(([file]) => file).join(', ')}`);
  for (const [file, args] of calls) assert.match(args, /\bacceptedVersions\s*:/, `${file} must pass acceptedVersions explicitly`);
  const production = calls.filter(([file]) => file === path.join('src', 'app', 'api', 'link-audit', 'scoring', 'shared.ts'));
  assert.equal(production.length, 1);
  assert.match((production[0] as readonly [string, string])[1], /\bacceptedVersions\s*:\s*\[\s*2\s*\]/, 'production accepts only v2');
});

/* ============================================================================================ V2-34, V2-35 */

function spyFs(): { readonly fs: FsOps; readonly calls: string[] } {
  const calls: string[] = [];
  const spied = new Proxy(nodeFsOps, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { fs: spied, calls };
}

test('V2-34 (RS-20) a non-normalized auditId is NO_SEAL without touching the disk; a body auditId in another case or of another audit is SEAL_INVALID', async () => {
  const sealsDir = tmpDir('lep2-');
  writeSealFile(sealsDir, AUD, 1, v2Of(KEYS_A));
  const malformed = [
    AUD.toUpperCase(),
    ` ${AUD}`,
    `${AUD} `,
    `${AUD}/`,
    `../${AUD}`,
    '..%2fauditoria-prova',
    '%2e%2e%2fauditoria-prova',
    'auditoria-prová-v2-02',
    'auditoria-prova​-v2-02',
    `${AUD}\u0000`,
    'ａuditoria-prova-v2-02',
    '',
    'a'.repeat(65),
  ];
  for (const versions of [[2], [1, 2]] as const) {
    for (const auditId of malformed) {
      const spy = spyFs();
      const p = createSealedEvidenceProvenance({ sealsDir, trustedKeys: trusted(KEYS_A), acceptedVersions: versions, fs: spy.fs, otherDirs: [tmpDir('lep2-other-')] });
      assert.deepEqual(await p.classify(auditId, SAMPLE), UNAUTH('NO_SEAL'), JSON.stringify(auditId));
      assert.deepEqual(spy.calls, [], `${JSON.stringify(auditId)}: no disk access`);
    }
  }
  // the body says the same audit in another case (re-signed: the producer would refuse it), or another audit altogether
  writeSealFile(sealsDir, AUD, 1, resigned({ ...bodyOf(v2Of(KEYS_A)), auditId: AUD.toUpperCase() }, KEYS_A));
  assert.deepEqual(await policy(sealsDir, [2]).classify(AUD, SAMPLE), UNAUTH('SEAL_INVALID'), 'body auditId in upper case');
  writeSealFile(sealsDir, AUD, 1, v2Of(KEYS_A, { auditId: 'auditoria-prova-v2-99' }));
  assert.deepEqual(await policy(sealsDir, [2]).classify(AUD, SAMPLE), UNAUTH('SEAL_INVALID'), 'a valid seal of another audit');
});

/** In-memory read-only FsOps: no real disk, so a trapped `Date` can only be touched by the verifier itself. */
function memoryFs(files: Readonly<Record<string, string>>): FsOps {
  const dirs = new Set(Object.keys(files).flatMap((file) => [path.dirname(file), path.dirname(path.dirname(file))]));
  const info = (kind: 'file' | 'dir'): FileInfo => ({ isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => false, size: 0, mtimeMs: 0 });
  const missing = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const refuse = async (): Promise<never> => {
    throw new Error('write attempted');
  };
  return {
    async lstat(target) {
      if (dirs.has(target)) return info('dir');
      if (target in files) return info('file');
      throw missing();
    },
    async readdir(dir) {
      return Object.keys(files).filter((file) => path.dirname(file) === dir).map((file) => path.basename(file));
    },
    async realpath(target) {
      return target;
    },
    async readFile(target, maxBytes) {
      const content = files[target];
      if (content === undefined) throw missing();
      if (Buffer.byteLength(content) > maxBytes) throw new Error('too big');
      return content;
    },
    mkdir: refuse,
    writeExclusive: refuse,
    link: refuse,
    unlink: refuse,
    chmod: refuse,
    syncDirectory: refuse,
  };
}

test('V2-35 (D12, RS-20) nothing is decided by date: any sealedAt keeps the verdict and Date / Date.now are never called', async () => {
  const sealsDir = '/memoria/selos';
  const RealDate = globalThis.Date;
  for (const sealedAt of ['1970-01-01T00:00:00.000Z', '2999-12-31T23:59:59.999Z', '0000-00-00T00:00:00.000Z', '2026-13-45T25:61:61.999Z']) {
    const seal = v2Of(KEYS_A, { sealedAt });
    const p = createSealedEvidenceProvenance({ sealsDir, trustedKeys: trusted(KEYS_A), acceptedVersions: [2], fs: memoryFs({ [path.join(sealsDir, AUD, 'seal-0001.json')]: JSON.stringify(seal) }) });
    let touched = 0;
    const touch = (): never => {
      touched += 1;
      throw new Error('Date used by the verifier');
    };
    globalThis.Date = new Proxy(RealDate, { construct: touch, apply: touch, get: (target, property, receiver) => (property === 'now' ? touch : Reflect.get(target, property, receiver)) }) as DateConstructor;
    let verdict: unknown;
    try {
      verdict = await p.classify(AUD, SAMPLE);
    } finally {
      globalThis.Date = RealDate;
    }
    assert.equal(touched, 0, `${sealedAt}: Date was used`);
    assert.deepEqual(verdict, { status: 'AUTHENTICATED', headSeq: 1, headSealSha256: sealSha256(seal), keyIds: [KEYS_A.keyId] }, sealedAt);
  }
});

/* ============================================================================================ V2-40, V2-41 */

/** Compile-time exhaustive: a reason added to `EvidenceTrustReason` without being listed here breaks the typecheck. */
const ALL_REASONS: Readonly<Record<EvidenceTrustReason, true>> = {
  PROOF_NOT_CONFIGURED: true,
  NO_SEAL: true,
  LEGACY_NO_SEAL: true,
  SEAL_INVALID: true,
  EVIDENCE_NOT_SEALED: true,
  EVIDENCE_MISSING: true,
  EVIDENCE_HASH_MISMATCH: true,
  VERIFICATION_ERROR: true,
  SEAL_CHAIN_BROKEN: true,
  SEAL_NOT_CUMULATIVE: true,
  SEAL_DOWNGRADE: true,
  SEAL_VERSION_NOT_ALLOWED: true,
  SEAL_KEY_RETIRED_UNCOVERED: true,
  SEAL_KEY_REVOKED: true,
};

test('V2-40 (contract §10) the audit page labels and the DTO validator accept every reason, the six new ones included; EvidenceToProve is unchanged', () => {
  const reasons = Object.keys(ALL_REASONS);
  assert.equal(reasons.length, 14);
  for (const reason of reasons) {
    const label = PROVENANCE_REASON_LABELS[reason];
    assert.ok(typeof label === 'string' && label.length >= 20 && /^[a-zà-ú]/.test(label) && !/undefined|null|\bSEAL_|TODO/.test(label), `${reason}: pt-BR label in the existing style (${label})`);
    const blocked = structuredClone(previewFixture()) as unknown as Record<string, Record<string, unknown>>;
    (blocked as Record<string, unknown>).state = 'CALCULADO_NAO_FINALIZAVEL';
    (blocked as Record<string, unknown>).finalization = { allowed: false, expectedHead: null, expectedInputSha256: null, latest: null };
    (blocked.evidence as Record<string, unknown>).provenance = { status: 'UNAUTHENTICATED', reason, missingRefs: reason === 'EVIDENCE_MISSING' ? ['capture:c0002'] : [] };
    (blocked as Record<string, unknown>).blockers = [{ code: 'EVIDENCE_PROVENANCE_UNPROVEN', severity: 'BLOCKING', message: 'A origem da coleta NÃO foi comprovada.', reasonCode: reason, decisionIds: [], subcriterionIds: [] }];
    assert.equal(isPreviewPayload(blocked, UI_AUDIT), true, `${reason}: accepted by the DTO validator`);
    (blocked.evidence as Record<string, unknown>).provenance = { status: 'UNAUTHENTICATED', reason: `${reason}_X`, missingRefs: [] };
    assert.equal(isPreviewPayload(blocked, UI_AUDIT), false, `${reason}_X: an unknown reason is still refused`);
  }
  assert.equal(new Set(reasons.map((reason) => PROVENANCE_REASON_LABELS[reason])).size, reasons.length, 'one distinct label per reason');
  const source = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'link-audit-evidence', 'provenance.ts'), 'utf8');
  assert.match(source, /export interface EvidenceToProve \{\n  readonly ref: string;\n  readonly contentSha256: string;\n  readonly legacy: boolean;\n\}/, 'EvidenceToProve is unchanged');
});

/** All forms of dependency: `import/export … from`, side-effect `import 'x'`, dynamic `import('x')` and `require('x')`. */
const importsOf = (source: string): string[] => {
  const code = strip(source);
  return [
    ...[...code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''),
    ...[...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? ''),
  ];
};

test('V2-41 (IA-05 spirit, static) the import graph of provenance.ts gains no dependency and provenance.ts itself has no network, environment or clock', () => {
  const entry = path.join(ROOT, 'src', 'lib', 'link-audit-evidence', 'provenance.ts');
  assert.deepEqual(new Set(importsOf(fs.readFileSync(entry, 'utf8'))), new Set(['node:crypto', 'node:path', 'zod', '../link-audit/canonical', '../link-audit/snapshot-store', './types']), 'direct imports (contract §10)');
  const external = new Set<string>();
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of importsOf(fs.readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        external.add(specifier);
        continue;
      }
      const base = path.resolve(path.dirname(file), specifier);
      const target = [`${base}.ts`, path.join(base, 'index.ts')].find((candidate) => fs.existsSync(candidate));
      assert.ok(target, `${specifier} from ${path.relative(ROOT, file)} resolves`);
      visit(target as string);
    }
  };
  visit(entry);
  // Frozen as of W3.2. `node:dns`/`node:net` were ALREADY reachable (snapshot-store → evidence → url-safety) and are not used by provenance.ts.
  assert.deepEqual([...external].sort(), ['node:crypto', 'node:dns', 'node:fs/promises', 'node:net', 'node:path', 'zod'], 'transitive external modules');
  const own = strip(fs.readFileSync(entry, 'utf8'));
  assert.ok(!/\bfetch\s*\(|node:(?:http|https|http2|dns|net|tls|dgram|child_process|fs)\b|XMLHttpRequest|WebSocket/.test(own), 'no network or direct disk module');
  assert.ok(!/process\.env|Date\.now|new Date\s*\(|Math\.random/.test(own), 'no environment, clock or randomness');
});
