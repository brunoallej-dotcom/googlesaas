import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../src/lib/link-audit/canonical';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import { CHECK_IDS, computePackageSha256, type Approval, type CandidatePackage } from '../src/lib/link-audit-attestation';
import { exportCandidatePackage } from '../src/lib/link-audit-attestation/export-run';
import { buildSealManifestBody, readSealChain, runSignWithChain, sealFileName, signSealManifest, type SignWithChainInput } from '../src/lib/link-audit-attestation/sign-chain';
import { MAX_SEAL_SEQ, runSignCore, type ConfirmationFacts, type SignCoreDeps, type SignPlan, type SignRefusal } from '../src/lib/link-audit-attestation/sign-core';
import { evidenceToProveFromBasis } from '../src/lib/link-audit-evidence/evidence-to-prove';
import {
  createEvidenceSeal,
  createEvidenceSealV2,
  createSealedEvidenceProvenance,
  MAX_CHAIN_SEALS,
  parseTrustKeyring,
  SEAL_FILE,
  sealSha256,
  type EvidenceSealFile,
  type EvidenceSealFileV2,
  type EvidenceToProve,
  type TrustKeyring,
} from '../src/lib/link-audit-evidence/provenance';
import { createScoringBasisReader } from '../src/lib/link-audit-evidence/scoring-basis';
import { sealed, writeReport } from '../src/lib/link-audit-evidence/store';
import { reportName } from '../src/lib/link-audit-evidence/types';
import { errno, faulty, registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { evidenceKeys, type EvidenceKeys } from './helpers/link-audit-evidence-provenance-fixtures';
import { HOUR, makeAudit, NOW as EXPORT_NOW, type FixtureAudit } from './helpers/link-audit-seal-export-fixtures';
import { GOLDEN } from './helpers/link-audit-seal-v2-golden';

/*
 * P1 W4.2 — cadeia e manifesto do `sign` (spec §5.5 passos 7 e 13; §5.5.1 item 2; §7.1; contrato do verificador v2 §2, §3, §5, §6). A cadeia é lida
 * e verificada pelo VERIFICADOR v2 REAL (lista com estado e fechos, `acceptedVersions: [2]`), o núcleo decide `seq`/`--expect-seq`/`--first` na
 * posição do passo 7, e o corpo v2 sai do plano. Dados 100% FICTÍCIOS em pastas temporárias; chaves de TESTE geradas em memória (ou as sementes
 * de teste dos vetores-ouro); a assinatura aqui existe só para a ida e volta (a chave real, a gravação e o autoteste são W4.3–W4.5). Revisão da
 * W4.1: a confirmação humana (passo 11) é a porta injetada `confirm`, chamada depois da cadeia julgada e antes da chave; o espião digita os 12
 * primeiros caracteres certos, salvo instrução.
 */
registerCleanup();

type Entries = ReadonlyArray<{ readonly ref: string; readonly contentSha256: string }>;
const h = (c: string): string => c.repeat(64);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const byRef = (a: { readonly ref: string }, b: { readonly ref: string }): number => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
const plain = (entries: Entries): Array<{ ref: string; contentSha256: string }> => [...entries].sort(byRef).map(({ ref, contentSha256 }) => ({ ref, contentSha256 }));
const ROOT = path.join(__dirname, '..');

const AUD = 'auditoria-cadeia-sign-01';
const OTHER = 'auditoria-cadeia-sign-02';
const KEYS_A = evidenceKeys('ek-sign-cadeia-a');
const KEYS_B = evidenceKeys('ek-sign-cadeia-b');
const KEYS_X = evidenceKeys('ek-sign-cadeia-fora'); // nunca está na lista
/** `--trust-keys` no formato com estado do contrato v2 (§5): A e B ativas. */
const RING = `${KEYS_A.trustKeys}:active,${KEYS_B.trustKeys}`;
const DOSSIER = Buffer.from('Dossiê de aprovação FICTÍCIO da cadeia (W4.2).\n', 'utf8');
const DOSSIER_ID = 'dossie-cadeia-0001';
const PREVIOUS_DOSSIER = { id: 'dossie-anterior-0001', sha256: h('9') };
const LAST_COLLECTED_AT = '2026-11-18T09:00:00.000Z';
const NOW = '2026-11-19T09:00:00.000Z';
const ev = (ref: string, fill: string): { ref: string; contentSha256: string } => ({ ref, contentSha256: h(fill) });
const E1: Entries = [ev('capture:c0001', 'a'), ev('report:c0001-r0001', 'b')];
const E2: Entries = plain([...E1, ev('capture:c0002', 'c'), ev('report:c0002-r0001', 'd')]);
/** E2 + nova revisão de relatório (IA-08: entra; nada some). */
const E3: Entries = plain([...E2, ev('report:c0002-r0002', 'e')]);

/* --------------------------------------------------------------------------------------------------------------- fixtures */

const NOT_EXECUTED: ReadonlySet<string> = new Set(['REPORT_REPRODUCES', 'AUTHORIZATION_CONSUMED', 'PROVIDER_PANEL_CREDITS', 'URL_QUERY_COHERENCE']);

/** Pacote atestável como o `export` o entrega, com o hash refeito sobre o corpo; empresa `null` (NOT_VERIFIED: nenhum dado de empresa). */
function makePackage(entries: Entries, auditId = AUD, lastCollectedAt = LAST_COLLECTED_AT): CandidatePackage {
  const list = plain(entries);
  const count = (prefix: string): number => list.filter((entry) => entry.ref.startsWith(prefix)).length;
  const body = {
    schemaVersion: 1 as const,
    kind: 'LINK_AUDIT_P1_CANDIDATE' as const,
    auditId,
    layout: 'VERSIONED' as const,
    attestable: true,
    summary: { company: { name: null, city: null, stateCode: null }, firstCollectedAt: lastCollectedAt, lastCollectedAt, captures: count('capture:'), reportRevisions: count('report:'), artifacts: 0, containsLegacy: false },
    integrity: { status: 'OK' as const, algorithm: 'SHA-256' as const, checkedFiles: list.length },
    checks: CHECK_IDS.map((id) => ({ id, status: NOT_EXECUTED.has(id) ? ('NOT_EXECUTED' as const) : ('PASS' as const) })),
    gap: { maxHours: 24, observedHours: 1, justification: null },
    entries: list.map((entry) => ({ ...entry, legacy: false })),
    delta: null,
    generatedAt: '2026-11-18T13:00:00.000Z',
  };
  return { ...body, packageSha256: computePackageSha256(body) };
}

function makeApproval(pkg: CandidatePackage, dossier: Uint8Array = DOSSIER, dossierId = DOSSIER_ID): Approval {
  return {
    schemaVersion: 1,
    kind: 'LINK_AUDIT_P1_APPROVAL',
    auditId: pkg.auditId,
    packageSha256: pkg.packageSha256,
    decision: 'APPROVED',
    approvedBy: 'CONF-01',
    operator: 'OPER-01',
    approvedAt: '2026-11-18T14:00:00.000Z',
    dossier: { id: dossierId, sha256: sha256(dossier) },
    humanChecks: pkg.checks.filter((check) => check.status === 'NOT_EXECUTED').map((check) => ({ id: check.id as Approval['humanChecks'][number]['id'], result: 'PASS' as const, note: 'conferido pelo conferente (fictício)' })),
    riskAcceptance: null,
  };
}

const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value, null, 2), 'utf8');

interface Scenario {
  readonly sealsDir: string;
  readonly expectSeq: number;
  readonly first?: boolean;
  readonly entries?: Entries;
  readonly pkg?: CandidatePackage;
  readonly approval?: unknown;
  readonly auditId?: string;
  readonly dossier?: Uint8Array;
  readonly trustKeys?: string;
  readonly custodian?: string;
  readonly riskAcceptance?: Uint8Array | null;
}
function inputOf(scenario: Scenario): SignWithChainInput {
  const pkg = scenario.pkg ?? makePackage(scenario.entries ?? E3);
  return {
    auditId: scenario.auditId ?? pkg.auditId,
    custodian: scenario.custodian ?? 'CUST-01',
    packageBytes: bytes(pkg),
    approvalBytes: bytes(scenario.approval ?? makeApproval(pkg)),
    dossierBytes: scenario.dossier ?? DOSSIER,
    sealsDir: scenario.sealsDir,
    trustKeys: scenario.trustKeys ?? RING,
    expectSeq: scenario.expectSeq,
    first: scenario.first ?? false,
    riskAcceptanceBytes: scenario.riskAcceptance ?? null,
  };
}

/** O leitor de chave é um espião: devolve um valor-sentinela (nenhuma chave real) e conta as chamadas (IA-01: zero em toda recusa). */
const KEY_SENTINEL = Symbol('chave-de-teste-nao-aberta');
const CONFIRM_LENGTH = 12;
type Confirm = SignCoreDeps<unknown>['confirm'];
interface RunOptions {
  readonly now?: string;
  readonly fs?: FsOps;
  /** O que o custodiante "digita"; sem isto, os 12 primeiros caracteres certos do `packageSha256` dos bytes do pacote. */
  readonly confirm?: Confirm;
}
/** O que um custodiante que leu o dossiê digitaria ('' se os bytes nem são JSON). */
function rightPrefix(input: SignWithChainInput): string {
  try {
    return String((JSON.parse(Buffer.from(input.packageBytes).toString('utf8')) as { packageSha256?: unknown }).packageSha256).slice(0, CONFIRM_LENGTH);
  } catch {
    return '';
  }
}
async function run(input: SignWithChainInput, options: RunOptions = {}) {
  const calls: string[] = [];
  const facts: ConfirmationFacts[] = [];
  const result = await runSignWithChain(input, {
    fs: options.fs ?? nodeFsOps,
    now: () => new Date(options.now ?? NOW),
    confirm: (seen) => {
      calls.push('confirm');
      facts.push(seen);
      return options.confirm ? options.confirm(seen) : Promise.resolve(rightPrefix(input));
    },
    openKey: () => {
      calls.push('openKey');
      return KEY_SENTINEL;
    },
  });
  const count = (name: string): number => calls.filter((call) => call === name).length;
  return { result, calls, facts, keyCalls: count('openKey'), confirmCalls: count('confirm') };
}
async function refusedWith(input: SignWithChainInput, code: string, options: RunOptions = {}): Promise<SignRefusal> {
  const { result, keyCalls, confirmCalls } = await run(input, options);
  assert.equal(result.ok ? 'OK' : result.code, code);
  assert.equal(keyCalls, 0, 'a chave nunca é aberta numa recusa');
  assert.equal(confirmCalls, code === 'SIGN_CONFIRMATION_FAILED' ? 1 : 0, 'a confirmação humana só depois de todas as recusas dos passos 1–10 (cadeia inclusive)');
  if (result.ok) assert.fail('esperava recusa');
  assert.ok(result.message.length > 0 && !result.message.includes(input.sealsDir) && !result.message.includes('FICTÍCIO'), 'mensagem sem caminho de disco nem conteúdo de arquivo');
  return result;
}
async function chainRefused(input: SignWithChainInput, chainReason: string, label: string, options: RunOptions = {}): Promise<SignRefusal> {
  const refusal = await refusedWith(input, 'SIGN_SEAL_CHAIN_INVALID', options);
  assert.equal(refusal.chainReason, chainReason, label);
  return refusal;
}
async function planned(input: SignWithChainInput, options: RunOptions = {}): Promise<SignPlan> {
  const { result, calls, facts } = await run(input, options);
  if (!result.ok) assert.fail(`esperava plano, veio ${result.code} (${result.chainReason ?? '-'})`);
  assert.deepEqual(calls, ['confirm', 'openKey'], 'confirmação humana uma vez, depois de todas as recusas; a chave uma vez, depois dela');
  assert.deepEqual(facts, [{ auditId: result.plan.auditId, seq: result.plan.seq, entries: result.plan.entries.length }], 'a tela recebe auditId, seq e o número de entradas, nunca o hash');
  assert.equal(result.key, KEY_SENTINEL);
  return result.plan;
}

/** Entrega um manifesto como a cópia da estação o guarda: `<seals-dir>/<auditId>/<sealFileName(seal)>`, somente leitura. */
function deliver(sealsDir: string, auditId: string, seal: { readonly seq: number }, text = `${JSON.stringify(seal)}\n`): string {
  return writeRaw(sealsDir, auditId, sealFileName(seal), text);
}
function writeRaw(sealsDir: string, auditId: string, name: string, text: string | Uint8Array): string {
  const file = path.join(sealsDir, auditId, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o444);
  return file;
}

type AnySeal = EvidenceSealFile | EvidenceSealFileV2;
interface Link {
  readonly entries: Entries;
  readonly keys?: EvidenceKeys;
  readonly version?: 1 | 2;
  readonly auditId?: string;
  /** Sobrescreve o elo (o produtor aceita qualquer hex num `seq > 1`): cadeia bem assinada mas quebrada. */
  readonly prev?: string;
}
/** Cadeia real, posição a posição, com os produtores do verificador; cada v2 aponta para o `sealSha256` da anterior. */
function chain(sealsDir: string, links: readonly Link[], auditId = AUD): AnySeal[] {
  const seals: AnySeal[] = [];
  links.forEach((link, index) => {
    const keys = link.keys ?? KEYS_A;
    const base = { auditId: link.auditId ?? auditId, seq: index + 1, sealedAt: `2026-11-18T1${index}:00:00.000Z`, keyId: keys.keyId, privateKey: keys.privateKey, entries: plain(link.entries) };
    const previous = seals[index - 1];
    const seal = link.version === 1 ? createEvidenceSeal(base) : createEvidenceSealV2({ ...base, dossier: PREVIOUS_DOSSIER, prevSealSha256: link.prev ?? (previous ? sealSha256(previous) : null) });
    seals.push(seal);
    deliver(sealsDir, auditId, seal);
  });
  return seals;
}

/* =============================================================================================================== IA-07 */

test('IA-07: sem manifesto + --first --expect-seq 1 ⇒ seq 1 e prevSealSha256 null; pasta ausente, vazia ou só com lixo fora do padrão contam como "sem manifesto"', async () => {
  const sealsDir = tmpDir('lass-');
  const plan = await planned(inputOf({ sealsDir, expectSeq: 1, first: true }));
  assert.deepEqual([plan.seq, plan.prevSealSha256], [1, null]);
  assert.deepEqual(await readSealChain({ sealsDir, auditId: AUD, trustKeys: RING }, { fs: nodeFsOps }), { status: 'EMPTY' });
  fs.mkdirSync(path.join(sealsDir, AUD));
  assert.equal((await planned(inputOf({ sealsDir, expectSeq: 1, first: true }))).seq, 1, 'subpasta vazia');
  writeRaw(sealsDir, AUD, '.seal-0001.json.tmp-a1b2c3', 'temporário de uma queda (W4.3)');
  writeRaw(sealsDir, AUD, 'leia-me.txt', 'anotação');
  writeRaw(sealsDir, AUD, 'seal-1.json', '{}');
  assert.equal((await planned(inputOf({ sealsDir, expectSeq: 1, first: true }))).seq, 1, 'nomes fora de SEAL_FILE não são manifesto');
  // manifestos de OUTRA auditoria (outra subpasta) não contam para esta
  chain(sealsDir, [{ entries: E1 }], OTHER);
  assert.equal((await planned(inputOf({ sealsDir, expectSeq: 1, first: true }))).seq, 1);
});

test('IA-07: com seal-0003.json válido ⇒ seq = 4 e prevSealSha256 = sealSha256(seal-0003); a cadeia lida é a que o verificador autenticou', async () => {
  const sealsDir = tmpDir('lass-');
  const seals = chain(sealsDir, [{ entries: E1 }, { entries: E2 }, { keys: KEYS_B, entries: E2 }]);
  const head = seals[2] as EvidenceSealFileV2;
  const plan = await planned(inputOf({ sealsDir, entries: E3, expectSeq: 4 }));
  assert.deepEqual([plan.seq, plan.prevSealSha256], [4, sealSha256(head)]);
  assert.deepEqual(await readSealChain({ sealsDir, auditId: AUD, trustKeys: RING }, { fs: nodeFsOps }), {
    status: 'VERIFIED',
    last: { auditId: AUD, seq: 3, sealSha256: sealSha256(head), sealedAt: head.sealedAt, entries: head.entries },
  });
});

test('IA-07: nome do arquivo = seq assinado (seal-NNNN.json, casa com SEAL_FILE e devolve o mesmo seq)', () => {
  for (const seq of [1, 4, 12, 255, MAX_CHAIN_SEALS]) {
    const name = sealFileName({ seq });
    assert.equal(name, `seal-${String(seq).padStart(4, '0')}.json`);
    assert.equal(Number(SEAL_FILE.exec(name)?.[1]), seq);
  }
});

test('IA-07: --expect-seq diferente do calculado (último + 1) ⇒ SIGN_SEQ_MISMATCH; --first com manifesto existente ⇒ recusado', async () => {
  const sealsDir = tmpDir('lass-');
  chain(sealsDir, [{ entries: E1 }, { entries: E2 }, { entries: E2 }]);
  for (const expectSeq of [1, 2, 3, 5, 6, MAX_CHAIN_SEALS]) {
    const refusal = await refusedWith(inputOf({ sealsDir, expectSeq }), 'SIGN_SEQ_MISMATCH');
    assert.match(refusal.message, /--expect-seq/);
  }
  const first = await refusedWith(inputOf({ sealsDir, expectSeq: 1, first: true }), 'SIGN_SEQ_MISMATCH');
  assert.match(first.message, /--first/);
  assert.equal((await planned(inputOf({ sealsDir, expectSeq: 4 }))).seq, 4);
});

test('IA-07 (§7.1): sem --first e sem manifestos ⇒ SIGN_SEAL_CHAIN_INVALID; pasta vazia com --expect-seq > 1 ⇒ SIGN_SEAL_CHAIN_INVALID (manifesto apagado; nunca recomeçar)', async () => {
  const sealsDir = tmpDir('lass-');
  await chainRefused(inputOf({ sealsDir, expectSeq: 1 }), 'NO_SEAL_WITHOUT_FIRST', 'sem --first');
  for (const expectSeq of [2, 4, MAX_CHAIN_SEALS]) await chainRefused(inputOf({ sealsDir, expectSeq }), 'NO_SEAL_EXPECTED_SEQ', `--expect-seq ${expectSeq}`);
  // a cópia da estação perdeu os manifestos: o registro externo diz 4, a pasta está vazia
  chain(sealsDir, [{ entries: E1 }, { entries: E2 }, { entries: E2 }]);
  for (const seq of [1, 2, 3]) fs.rmSync(path.join(sealsDir, AUD, sealFileName({ seq })), { force: true });
  await chainRefused(inputOf({ sealsDir, expectSeq: 4 }), 'NO_SEAL_EXPECTED_SEQ', 'pasta esvaziada');
});

test('IA-07: --expect-seq fora de 1..256 ou não inteiro, e --first sem --expect-seq 1 ⇒ USAGE, antes de qualquer outra recusa', async () => {
  assert.equal(MAX_SEAL_SEQ, MAX_CHAIN_SEALS, 'o limite do núcleo é o do contrato v2 (cópia deliberada: o núcleo não importa o verificador)');
  const sealsDir = tmpDir('lass-');
  const broken = { ...makePackage(E3), extra: true }; // passo 1 recusaria; USAGE vem antes
  for (const expectSeq of [0, -1, 1.5, MAX_CHAIN_SEALS + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await refusedWith(inputOf({ sealsDir, expectSeq }), 'USAGE');
    await refusedWith({ ...inputOf({ sealsDir, expectSeq }), packageBytes: bytes(broken) }, 'USAGE');
  }
  for (const expectSeq of [2, 3]) await refusedWith(inputOf({ sealsDir, expectSeq, first: true }), 'USAGE');
  await refusedWith({ ...inputOf({ sealsDir, expectSeq: 1 }), first: 'sim' as never }, 'USAGE');
  // 256 é aceito na entrada (a recusa que vem é a da cadeia, não USAGE)
  await chainRefused(inputOf({ sealsDir, expectSeq: MAX_CHAIN_SEALS }), 'NO_SEAL_EXPECTED_SEQ', '256 na entrada');
});

/* =============================================================================================================== IA-06 (3) e §7.1 */

test('IA-06 (3): último manifesto (válido, assinado) de OUTRA auditoria na pasta desta ⇒ SIGN_SEAL_CHAIN_INVALID', async () => {
  const sealsDir = tmpDir('lass-');
  const foreign = tmpDir('lass-');
  const other = chain(foreign, [{ entries: E1 }, { entries: E2 }], OTHER);
  chain(sealsDir, [{ entries: E1 }]);
  deliver(sealsDir, AUD, other[1] as AnySeal); // seal-0002.json de OTHER copiado para a pasta de AUD
  await chainRefused(inputOf({ sealsDir, expectSeq: 3 }), 'SEAL_INVALID', 'cabeça de outra auditoria');
  const whole = tmpDir('lass-');
  for (const seal of other) deliver(whole, AUD, seal); // a cadeia inteira de OTHER sob AUD
  await chainRefused(inputOf({ sealsDir: whole, expectSeq: 3 }), 'SEAL_INVALID', 'cadeia de outra auditoria');
});

test('§7.1: cadeia inválida ⇒ SIGN_SEAL_CHAIN_INVALID com o código do verificador v2 real (malformado, assinatura, chave fora da lista, lacuna, elo, cumulatividade, v1, estados da lista); nunca assina por cima', async () => {
  const cases: ReadonlyArray<readonly [string, string, (dir: string) => void, number, string?]> = [
    ['último não é JSON', 'SEAL_INVALID', (dir) => (chain(dir, [{ entries: E1 }]), writeRaw(dir, AUD, sealFileName({ seq: 2 }), 'não é json')), 3],
    ['assinatura de outra chave', 'SEAL_INVALID', (dir) => {
      const seals = chain(dir, [{ entries: E1 }, { entries: E2 }]);
      const forged = { ...(seals[1] as EvidenceSealFileV2), signature: createEvidenceSealV2({ ...(seals[1] as EvidenceSealFileV2), privateKey: KEYS_B.privateKey }).signature };
      deliver(dir, AUD, forged);
    }, 3],
    ['chave fora da lista', 'SEAL_INVALID', (dir) => void chain(dir, [{ entries: E1, keys: KEYS_X }]), 2],
    ['lacuna (0001, 0003)', 'SEAL_CHAIN_BROKEN', (dir) => (chain(dir, [{ entries: E1 }, { entries: E2 }, { entries: E2 }]), fs.rmSync(path.join(dir, AUD, sealFileName({ seq: 2 })))), 4],
    ['seal-0000', 'SEAL_CHAIN_BROKEN', (dir) => (chain(dir, [{ entries: E1 }]), writeRaw(dir, AUD, 'seal-0000.json', '{}')), 2],
    ['elo quebrado (bem assinado)', 'SEAL_CHAIN_BROKEN', (dir) => void chain(dir, [{ entries: E1 }, { entries: E2, prev: h('0') }]), 3],
    ['não cumulativo', 'SEAL_NOT_CUMULATIVE', (dir) => void chain(dir, [{ entries: E2 }, { entries: E1 }]), 3],
    ['só v1 (produção aceita só v2)', 'SEAL_VERSION_NOT_ALLOWED', (dir) => void chain(dir, [{ entries: E1, version: 1 }]), 2],
    ['v1 abaixo de um v2', 'SEAL_VERSION_NOT_ALLOWED', (dir) => void chain(dir, [{ entries: E1, version: 1 }, { entries: E2 }]), 3],
    ['chave revogada', 'SEAL_KEY_REVOKED', (dir) => void chain(dir, [{ entries: E1 }, { entries: E2, keys: KEYS_B }]), 3, `${KEYS_A.trustKeys}:revoked,${KEYS_B.trustKeys}`],
    ['aposentada sem fecho fixado', 'SEAL_KEY_RETIRED_UNCOVERED', (dir) => void chain(dir, [{ entries: E1 }, { entries: E2, keys: KEYS_B }]), 3, `${KEYS_A.trustKeys}:retired,${KEYS_B.trustKeys}`],
    ['nome em outra caixa (seal-0002.JSON)', 'SEAL_NAME_CASE_VARIANT', (dir) => (chain(dir, [{ entries: E1 }]), writeRaw(dir, AUD, 'seal-0002.JSON', '{}')), 2],
    ['nome em outra caixa (Seal-0001.json, sozinho)', 'SEAL_NAME_CASE_VARIANT', (dir) => void writeRaw(dir, AUD, 'Seal-0001.json', '{}'), 1],
    ['último é diretório', 'SEAL_INVALID', (dir) => (chain(dir, [{ entries: E1 }]), fs.mkdirSync(path.join(dir, AUD, sealFileName({ seq: 2 })))), 3],
    ['último é link simbólico', 'SEAL_INVALID', (dir) => {
      const seals = chain(dir, [{ entries: E1 }, { entries: E2 }]);
      const outside = path.join(tmpDir('lass-fora-'), 'alvo.json');
      fs.writeFileSync(outside, JSON.stringify(seals[1]));
      fs.rmSync(path.join(dir, AUD, sealFileName({ seq: 2 })), { force: true });
      fs.symlinkSync(outside, path.join(dir, AUD, sealFileName({ seq: 2 })));
    }, 3],
    ['subpasta da auditoria é link simbólico', 'SEAL_INVALID', (dir) => {
      const real = tmpDir('lass-real-');
      chain(real, [{ entries: E1 }]);
      fs.symlinkSync(path.join(real, AUD), path.join(dir, AUD));
    }, 2],
    ['subpasta da auditoria é arquivo', 'SEAL_INVALID', (dir) => void fs.writeFileSync(path.join(dir, AUD), 'arquivo'), 1, undefined],
  ];
  for (const [label, reason, arrange, expectSeq, trustKeys] of cases) {
    const sealsDir = tmpDir('lass-');
    arrange(sealsDir);
    await chainRefused(inputOf({ sealsDir, expectSeq, first: expectSeq === 1, ...(trustKeys ? { trustKeys } : {}) }), reason, label);
  }
});

test('§5.5.1 item 2: --trust-keys fora do formato da lista com estado ⇒ SIGN_SEAL_CHAIN_INVALID (PROOF_NOT_CONFIGURED), inclusive com a pasta vazia e --first', async () => {
  const sealsDir = tmpDir('lass-');
  for (const trustKeys of ['', 'lixo', `${KEYS_A.trustKeys},${KEYS_A.trustKeys}`, `${KEYS_A.trustKeys}:ACTIVE`, `${KEYS_A.trustKeys}:retired:${h('A')}`, `${KEYS_A.trustKeys},`]) {
    await chainRefused(inputOf({ sealsDir, expectSeq: 1, first: true, trustKeys }), 'PROOF_NOT_CONFIGURED', JSON.stringify(trustKeys));
  }
});

test('§7.1: --seals-dir inexistente ou que não é diretório ⇒ SIGN_SEAL_CHAIN_INVALID (provável erro de digitação; nunca "começar do 1")', async () => {
  const missing = path.join(tmpDir('lass-'), 'nao-existe');
  await chainRefused(inputOf({ sealsDir: missing, expectSeq: 1, first: true }), 'SEALS_DIR_UNREADABLE', 'inexistente');
  const file = path.join(tmpDir('lass-'), 'arquivo');
  fs.writeFileSync(file, 'x');
  await chainRefused(inputOf({ sealsDir: file, expectSeq: 1, first: true }), 'SEALS_DIR_UNREADABLE', 'arquivo');
});

test('§7.1: erro de E/S ao ler a pasta, o último ou um anterior ⇒ SIGN_SEAL_CHAIN_INVALID (VERIFICATION_ERROR), sem lançar; só ENOENT da subpasta é "sem manifesto"', async () => {
  const sealsDir = tmpDir('lass-');
  chain(sealsDir, [{ entries: E1 }, { entries: E2 }]);
  const dir = path.join(sealsDir, AUD);
  const failing: ReadonlyArray<readonly [string, FsOps]> = [
    ['lstat da subpasta (EACCES)', faulty({ lstat: async (target) => (target === dir ? Promise.reject(errno('EACCES')) : nodeFsOps.lstat(target)) })],
    ['readdir (EIO)', faulty({ readdir: async () => Promise.reject(errno('EIO')) })],
    ['leitura do último (EIO)', faulty({ readFile: async (target, max) => (target.endsWith(sealFileName({ seq: 2 })) ? Promise.reject(errno('EIO')) : nodeFsOps.readFile(target, max)) })],
    ['leitura do anterior (EIO)', faulty({ readFile: async (target, max) => (target.endsWith(sealFileName({ seq: 1 })) ? Promise.reject(errno('EIO')) : nodeFsOps.readFile(target, max)) })],
  ];
  for (const [label, fsOps] of failing) await chainRefused(inputOf({ sealsDir, expectSeq: 3 }), 'VERIFICATION_ERROR', label, { fs: fsOps });
  // o EACCES da subpasta NUNCA vira "sem manifesto" (senão --first --expect-seq 1 recomeçaria a cadeia)
  await chainRefused(inputOf({ sealsDir, expectSeq: 1, first: true }), 'VERIFICATION_ERROR', 'EACCES com --first', { fs: failing[0]?.[1] as FsOps });
});

test('leitura única (RS-04 no espírito): cada manifesto é lido do disco exatamente uma vez (o último é compartilhado com o verificador) e nada é escrito', async () => {
  const sealsDir = tmpDir('lass-');
  chain(sealsDir, [{ entries: E1 }, { entries: E2 }, { entries: E3 }]);
  const reads: string[] = [];
  const writes: string[] = [];
  const refuseWrite = (name: string) => async (): Promise<never> => {
    writes.push(name);
    throw errno('EROFS');
  };
  const spy = faulty({
    readFile: async (target, max) => (reads.push(path.basename(target)), nodeFsOps.readFile(target, max)),
    mkdir: refuseWrite('mkdir'),
    writeExclusive: refuseWrite('writeExclusive'),
    link: refuseWrite('link'),
    unlink: refuseWrite('unlink'),
    chmod: refuseWrite('chmod'),
    syncDirectory: refuseWrite('syncDirectory'),
  });
  assert.equal((await planned(inputOf({ sealsDir, expectSeq: 4 }), { fs: spy })).seq, 4);
  assert.deepEqual([...reads].sort(), [1, 2, 3].map((seq) => sealFileName({ seq })));
  assert.deepEqual(writes, []);
});

test('TOCTOU: o verificador julga os MESMOS bytes de onde saem entries, sealedAt, seq e prev (um 2º read que devolvesse outra cabeça nunca acontece)', async () => {
  const sealsDir = tmpDir('lass-');
  const seals = chain(sealsDir, [{ entries: E1 }, { entries: E2 }]);
  const swapped = createEvidenceSealV2({ ...(seals[1] as EvidenceSealFileV2), entries: plain(E3), privateKey: KEYS_A.privateKey });
  const headName = sealFileName({ seq: 2 });
  let headReads = 0;
  const flipping = faulty({
    readFile: async (target, max) => {
      if (!target.endsWith(headName)) return nodeFsOps.readFile(target, max);
      headReads += 1;
      return headReads === 1 ? nodeFsOps.readFile(target, max) : JSON.stringify(swapped);
    },
  });
  const plan = await planned(inputOf({ sealsDir, entries: E3, expectSeq: 3 }), { fs: flipping });
  assert.equal(headReads, 1);
  assert.equal(plan.prevSealSha256, sealSha256(seals[1] as EvidenceSealFileV2));
});

/* =============================================================================================================== ordem do §5.5 */

type ChainFault = 'DOSSIER' | 'CHAIN_INVALID' | 'SEQ' | 'EVIDENCE_CHANGED' | 'ROLE' | 'CLOCK' | 'CONFIRM';
/** Passos 6, 7 (cadeia inválida antes do seq), 7 (seq), 8, 9, 10 e 11 (confirmação humana, revisão da W4.1). */
const CHAIN_LADDER: ReadonlyArray<readonly [ChainFault, string]> = [
  ['DOSSIER', 'SIGN_DOSSIER_MISMATCH'],
  ['CHAIN_INVALID', 'SIGN_SEAL_CHAIN_INVALID'],
  ['SEQ', 'SIGN_SEQ_MISMATCH'],
  ['EVIDENCE_CHANGED', 'SIGN_EVIDENCE_CHANGED'],
  ['ROLE', 'SIGN_ROLE_SEPARATION'],
  ['CLOCK', 'SIGN_CLOCK_REGRESSION'],
  ['CONFIRM', 'SIGN_CONFIRMATION_FAILED'],
];
function ladder(sealsDir: string, faults: ReadonlySet<ChainFault>): { readonly input: SignWithChainInput; readonly now: string; readonly confirm?: Confirm } {
  const has = (fault: ChainFault): boolean => faults.has(fault);
  const pkg = makePackage(has('EVIDENCE_CHANGED') ? E3.filter((entry) => entry.ref !== 'capture:c0002') : E3);
  const input = inputOf({
    sealsDir,
    pkg,
    dossier: has('DOSSIER') ? Buffer.concat([DOSSIER, Buffer.from('\n')]) : DOSSIER,
    trustKeys: has('CHAIN_INVALID') ? KEYS_B.trustKeys : RING, // a cadeia é de A: fora da lista ⇒ SEAL_INVALID
    expectSeq: has('SEQ') ? 4 : 3,
    custodian: has('ROLE') ? 'CONF-01' : 'CUST-01',
  });
  const wrong = has('CONFIRM') ? { confirm: async (): Promise<string> => rightPrefix(input).toUpperCase() } : {};
  return { input, now: has('CLOCK') ? '2026-11-18T10:30:00.000Z' : NOW, ...wrong }; // antes do último manifesto (11:00), depois da coleta (09:00)
}

test('ordem do §5.5: com todas as falhas juntas, corrigir uma por vez revela 6 → 7 (cadeia) → 7 (seq) → 8 → 9 → 10 → 11; a confirmação e a chave só no fim', async () => {
  const sealsDir = tmpDir('lass-');
  chain(sealsDir, [{ entries: E1 }, { entries: E2 }]);
  for (let rung = 0; rung <= CHAIN_LADDER.length; rung += 1) {
    const { input, now, confirm } = ladder(sealsDir, new Set(CHAIN_LADDER.slice(rung).map(([fault]) => fault)));
    const { result, keyCalls, confirmCalls } = await run(input, { now, ...(confirm ? { confirm } : {}) });
    assert.equal(result.ok ? 'OK' : result.code, CHAIN_LADDER[rung]?.[1] ?? 'OK', `degrau ${rung} (${CHAIN_LADDER[rung]?.[0] ?? 'nenhuma falha'})`);
    assert.equal(keyCalls, rung < CHAIN_LADDER.length ? 0 : 1, `degrau ${rung}: chave`);
    assert.equal(confirmCalls, rung < CHAIN_LADDER.length - 1 ? 0 : 1, `degrau ${rung}: confirmação`);
  }
  for (const [fault, code] of CHAIN_LADDER) {
    const { input, now, confirm } = ladder(sealsDir, new Set([fault]));
    await refusedWith(input, code, { now, ...(confirm ? { confirm } : {}) });
  }
});

test('ordem do §5.5: recusas dos passos 1–5 vêm antes da cadeia inválida (a cadeia é lida antes, mas julgada no passo 7)', async () => {
  const sealsDir = tmpDir('lass-');
  writeRaw(sealsDir, AUD, sealFileName({ seq: 1 }), 'não é json');
  const pkg = makePackage(E3);
  await refusedWith({ ...inputOf({ sealsDir, expectSeq: 2 }), packageBytes: bytes({ ...pkg, extra: true }) }, 'SIGN_PACKAGE_INVALID');
  await refusedWith(inputOf({ sealsDir, expectSeq: 2, pkg, approval: makeApproval(makePackage(E2)) }), 'SIGN_PACKAGE_MISMATCH');
  await refusedWith(inputOf({ sealsDir, expectSeq: 2, auditId: OTHER, pkg }), 'SIGN_AUDIT_MISMATCH');
  await chainRefused(inputOf({ sealsDir, expectSeq: 2, pkg }), 'SEAL_INVALID', 'sozinha');
});

/* =============================================================================================================== IA-08 */

test('IA-08: entries = exatamente o conjunto do pacote, ordenado e sem repetição; contém o anterior com os mesmos hashes; nova revisão entra; prev = sealSha256 do anterior', async () => {
  const sealsDir = tmpDir('lass-');
  const seals = chain(sealsDir, [{ entries: E1 }, { entries: E2 }]);
  const pkg = makePackage(E3);
  const plan = await planned(inputOf({ sealsDir, pkg, expectSeq: 3 }));
  const built = buildSealManifestBody(plan, KEYS_A.keyId);
  if (!built.ok) assert.fail(built.code);
  const { body } = built;
  assert.deepEqual(body.entries, pkg.entries.map(({ ref, contentSha256 }) => ({ ref, contentSha256 })), 'o conjunto EXATO do pacote, na mesma ordem');
  assert.ok(body.entries.every((entry, index) => index === 0 || (body.entries[index - 1] as { ref: string }).ref < entry.ref), 'estritamente ordenado (sem repetição)');
  const attested = new Map(body.entries.map((entry) => [entry.ref, entry.contentSha256]));
  assert.ok((seals[1] as EvidenceSealFileV2).entries.every((entry) => attested.get(entry.ref) === entry.contentSha256), 'cumulativo com os mesmos hashes');
  assert.ok(attested.has('report:c0002-r0002'), 'a nova revisão entrou');
  assert.deepEqual(
    { schemaVersion: body.schemaVersion, kind: body.kind, auditId: body.auditId, seq: body.seq, sealedAt: body.sealedAt, keyId: body.keyId, dossier: body.dossier, prevSealSha256: body.prevSealSha256 },
    { schemaVersion: 2, kind: 'LINK_AUDIT_EVIDENCE_SEAL', auditId: AUD, seq: 3, sealedAt: NOW, keyId: KEYS_A.keyId, dossier: { id: DOSSIER_ID, sha256: sha256(DOSSIER) }, prevSealSha256: sealSha256(seals[1] as EvidenceSealFileV2) },
  );
  assert.equal(built.signingBytes.toString('utf8'), canonicalJson(body), 'bytes assinados = canonicalJson(corpo)');
  const firstPlan = await planned(inputOf({ sealsDir: tmpDir('lass-'), pkg, expectSeq: 1, first: true }));
  const firstBody = buildSealManifestBody(firstPlan, KEYS_A.keyId);
  assert.ok(firstBody.ok && firstBody.body.prevSealSha256 === null && firstBody.body.seq === 1, 'null só no seq = 1');
});

test('IA-08: pacote desordenado ou com ref repetida nunca vira plano (esquema do pacote, passo 1), mesmo com o hash refeito à mão', async () => {
  const sealsDir = tmpDir('lass-');
  const body = makePackage(E3);
  /** Hash "na mão" (sem o esquema): o que um pacote adulterado e reaprovado traria. */
  const rehash = (entries: CandidatePackage['entries']): Record<string, unknown> & { readonly packageSha256: string } => {
    const changed = { ...body, entries };
    const { delta: _delta, generatedAt: _generatedAt, packageSha256: _hash, ...hashed } = changed;
    return { ...changed, packageSha256: sha256Hex(canonicalJson(hashed)) };
  };
  for (const entries of [[...body.entries].reverse(), [body.entries[0], ...body.entries] as CandidatePackage['entries']]) {
    const pkg = rehash(entries);
    await refusedWith(inputOf({ sealsDir, expectSeq: 1, first: true, pkg: pkg as unknown as CandidatePackage, approval: { ...makeApproval(makePackage(E3)), packageSha256: pkg.packageSha256 } }), 'SIGN_PACKAGE_INVALID');
  }
});

test('IA-08: a montagem do corpo nunca reordena nem deduplica em silêncio, e recusa seq/prev incoerentes (recusa tipada, sem lançar)', () => {
  const plan: SignPlan = {
    auditId: AUD, sealedAt: NOW, seq: 2, prevSealSha256: h('7'), packageSha256: h('8'), entries: plain(E3), dossier: { id: DOSSIER_ID, sha256: h('9') },
    approvedBy: 'CONF-01', operator: 'OPER-01', custodian: 'CUST-01', roleException: false, requiresLaterReview: false,
  };
  const ok = buildSealManifestBody(plan, KEYS_A.keyId);
  assert.ok(ok.ok && ok.body.entries.length === E3.length);
  const broken: ReadonlyArray<readonly [string, SignPlan, string?]> = [
    ['entradas desordenadas', { ...plan, entries: [...plain(E3)].reverse() }],
    ['ref repetida', { ...plan, entries: [plain(E3)[0] as { ref: string; contentSha256: string }, ...plain(E3)] }],
    ['entradas vazias', { ...plan, entries: [] }],
    ['seq 1 com prev', { ...plan, seq: 1 }],
    ['seq 2 sem prev', { ...plan, prevSealSha256: null }],
    ['seq 257', { ...plan, seq: MAX_CHAIN_SEALS + 1 }],
    ['keyId fora do padrão', plan, 'EK-A'],
  ];
  for (const [label, candidate, keyId] of broken) {
    const result = buildSealManifestBody(candidate, keyId ?? KEYS_A.keyId);
    assert.equal(result.ok ? 'OK' : result.code, 'UNEXPECTED', label);
  }
});

/* =============================================================================================================== IA-03 (lado fonte) */

const LOCAL_ACTOR = { email: 'p1-sign-teste' } as const;
async function basisEvidences(audit: FixtureAudit): Promise<EvidenceToProve[]> {
  const basis = await createScoringBasisReader({ baseDir: audit.base, authorize: () => true }).readScoringBasis(LOCAL_ACTOR, audit.auditId);
  if (basis.status !== 'READY') throw new Error(`base não íntegra: ${basis.status}`);
  return evidenceToProveFromBasis(basis.basis);
}
async function exportedPackage(audit: FixtureAudit, now: Date): Promise<CandidatePackage> {
  const outcome = await exportCandidatePackage({
    evidenceDir: audit.base, auditId: audit.auditId, collectorHashes: new Map(audit.captures.map((capture) => [capture.n, capture.contentSha256])), maxGapHours: 24,
    gapJustification: null, sealsDir: null, out: null, projectRoot: ROOT, now: () => now,
  });
  if (!outcome.ok) throw new Error(`export recusado: ${outcome.code}`);
  return outcome.package;
}
/** Lista de chaves montada com a pública DERIVADA da privada de teste (como o passo 12 fará), no formato com estado. */
function derivedRing(keyId: string, privateKey: KeyObject): string {
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return `${keyId}:${Buffer.from(der.subarray(der.length - 32)).toString('base64url')}:active`;
}
const verifierFor = (sealsDir: string, keyring: TrustKeyring) => createSealedEvidenceProvenance({ sealsDir, keyring, acceptedVersions: [2] });
const flipHex = (value: string): string => `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;
const flipChar = (value: string, at: number): string => `${value.slice(0, at)}${value[at] === 'A' ? 'B' : 'A'}${value.slice(at + 1)}`;

test('IA-03 (fonte): pacote do export real → plano → corpo v2 → assinatura de teste ⇒ AUTHENTICATED pelo verificador v2 real (pública derivada, [2]) sobre readScoringBasis; 2ª assinatura encadeia', async () => {
  const audit = await makeAudit([{}, { report: true }]);
  const keys = evidenceKeys('ek-sign-ida-volta');
  const trustKeys = derivedRing(keys.keyId, keys.privateKey);
  const keyring = parseTrustKeyring(trustKeys) as TrustKeyring;
  const sealsDir = tmpDir('lass-rt-');
  // 1ª assinatura (seq 1)
  const pkg1 = await exportedPackage(audit, EXPORT_NOW);
  const plan1 = await planned(inputOf({ sealsDir, pkg: pkg1, expectSeq: 1, first: true, trustKeys }), { now: new Date(EXPORT_NOW.getTime() + HOUR / 2).toISOString() });
  const signed1 = signSealManifest(plan1, keys.keyId, keys.privateKey);
  if (!signed1.ok) assert.fail(signed1.code);
  deliver(sealsDir, audit.auditId, signed1.seal);
  assert.deepEqual(await verifierFor(sealsDir, keyring).classify(audit.auditId, await basisEvidences(audit)), { status: 'AUTHENTICATED', headSeq: 1, headSealSha256: sealSha256(signed1.seal), keyIds: [keys.keyId] });
  // nova revisão de relatório na pasta ⇒ novo export ⇒ 2ª assinatura (seq 2, encadeada), lida e verificada pelo sign
  const firstReport = JSON.parse(fs.readFileSync(path.join(audit.dir, reportName(1, 1)), 'utf8')) as { readonly report: Record<string, unknown> };
  const revised = await writeReport(audit.base, audit.auditId, 1, firstReport.report, '2026-10-22T13:30:00.000Z');
  assert.ok(revised.ok && revised.value.revision === 2);
  const pkg2 = await exportedPackage(audit, new Date(EXPORT_NOW.getTime() + HOUR));
  assert.ok(pkg2.entries.some((entry) => entry.ref === 'report:c0001-r0002'));
  const plan2 = await planned(inputOf({ sealsDir, pkg: pkg2, expectSeq: 2, trustKeys }), { now: new Date(EXPORT_NOW.getTime() + (3 * HOUR) / 2).toISOString() });
  assert.deepEqual([plan2.seq, plan2.prevSealSha256], [2, sealSha256(signed1.seal)]);
  const signed2 = signSealManifest(plan2, keys.keyId, keys.privateKey);
  if (!signed2.ok) assert.fail(signed2.code);
  deliver(sealsDir, audit.auditId, signed2.seal);
  assert.deepEqual(await verifierFor(sealsDir, keyring).classify(audit.auditId, await basisEvidences(audit)), { status: 'AUTHENTICATED', headSeq: 2, headSealSha256: sealSha256(signed2.seal), keyIds: [keys.keyId] });
});

test('IA-03 (fonte): 1 byte alterado em contentSha256, ref, signature, seq, keyId, sealedAt, dossier, prevSealSha256 ou auditId do manifesto, ou no arquivo de evidência ⇒ UNAUTHENTICATED', async () => {
  const audit = await makeAudit([{}, { report: true }]);
  const keys = evidenceKeys('ek-sign-um-byte');
  const trustKeys = derivedRing(keys.keyId, keys.privateKey);
  const keyring = parseTrustKeyring(trustKeys) as TrustKeyring;
  const sealsDir = tmpDir('lass-rt-');
  const seal1 = createEvidenceSealV2({ auditId: audit.auditId, seq: 1, sealedAt: EXPORT_NOW.toISOString(), keyId: keys.keyId, privateKey: keys.privateKey, entries: (await basisEvidences(audit)).map(({ ref, contentSha256 }) => ({ ref, contentSha256 })), dossier: PREVIOUS_DOSSIER, prevSealSha256: null });
  deliver(sealsDir, audit.auditId, seal1);
  const pkg = await exportedPackage(audit, EXPORT_NOW);
  const plan = await planned(inputOf({ sealsDir, pkg, expectSeq: 2, trustKeys }), { now: new Date(EXPORT_NOW.getTime() + HOUR).toISOString() });
  const signed = signSealManifest(plan, keys.keyId, keys.privateKey);
  if (!signed.ok) assert.fail(signed.code);
  const seal2 = signed.seal;
  const evidences = await basisEvidences(audit);
  const withSecond = (text: string): string => {
    const dir = tmpDir('lass-um-');
    deliver(dir, audit.auditId, seal1);
    writeRaw(dir, audit.auditId, sealFileName(seal2), text);
    return dir;
  };
  assert.deepEqual(await verifierFor(withSecond(JSON.stringify(seal2)), keyring).classify(audit.auditId, evidences), { status: 'AUTHENTICATED', headSeq: 2, headSealSha256: sealSha256(seal2), keyIds: [keys.keyId] });
  const mutations: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ...seal2.entries.map((entry, index) => [`entries[${index}].contentSha256`, { ...seal2, entries: seal2.entries.map((other, at) => (at === index ? { ...other, contentSha256: flipHex(entry.contentSha256) } : other)) }] as const),
    ['entries[0].ref', { ...seal2, entries: seal2.entries.map((entry, at) => (at === 0 ? { ...entry, ref: entry.ref.replace('c0001', 'c0009') } : entry)) }],
    ['signature', { ...seal2, signature: flipChar(seal2.signature, 10) }],
    ['seq', { ...seal2, seq: 3 }],
    ['keyId', { ...seal2, keyId: `${seal2.keyId.slice(0, -1)}x` }],
    ['sealedAt', { ...seal2, sealedAt: seal2.sealedAt.replace(/\.(\d)/, (_match, digit: string) => `.${digit === '0' ? '1' : '0'}`) }],
    ['dossier.id', { ...seal2, dossier: { ...seal2.dossier, id: `${seal2.dossier.id.slice(0, -1)}x` } }],
    ['dossier.sha256', { ...seal2, dossier: { ...seal2.dossier, sha256: flipHex(seal2.dossier.sha256) } }],
    ['prevSealSha256', { ...seal2, prevSealSha256: flipHex(seal2.prevSealSha256 as string) }],
    ['auditId', { ...seal2, auditId: `${seal2.auditId.slice(0, -1)}x` }],
  ];
  for (const [label, mutated] of mutations) {
    assert.notEqual(JSON.stringify(mutated), JSON.stringify(seal2), `${label}: a mutação muda o arquivo`);
    assert.equal((await verifierFor(withSecond(JSON.stringify(mutated)), keyring).classify(audit.auditId, evidences)).status, 'UNAUTHENTICATED', label);
  }
  // (d) 1 byte no arquivo de evidência (selo de integridade refeito, como o próprio armazenamento gravaria)
  const file = path.join(audit.dir, reportName(1, 1));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const { contentSha256: _old, ...rest } = parsed;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, `${JSON.stringify(sealed({ ...rest, generatedAt: `${String(rest.generatedAt).slice(0, -2)}9Z` }))}\n`);
  assert.deepEqual(await verifierFor(withSecond(JSON.stringify(seal2)), keyring).classify(audit.auditId, await basisEvidences(audit)), { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_HASH_MISMATCH' });
});

test('assinatura: chave que não é privada Ed25519 ⇒ recusa UNEXPECTED com mensagem fixa (sem material de chave); a assinatura é conferida com a pública derivada', async () => {
  const plan = await planned(inputOf({ sealsDir: tmpDir('lass-'), expectSeq: 1, first: true }));
  const signed = signSealManifest(plan, KEYS_A.keyId, KEYS_A.privateKey);
  assert.ok(signed.ok);
  for (const key of [createPublicKey(KEYS_A.privateKey), generateKeyPairSync('x25519').privateKey]) {
    const refusal = signSealManifest(plan, KEYS_A.keyId, key);
    assert.equal(refusal.ok ? 'OK' : refusal.code, 'UNEXPECTED');
    if (refusal.ok) continue;
    const exported = key.export({ format: 'der', type: key.type === 'public' ? 'spki' : 'pkcs8' });
    for (const encoding of ['hex', 'base64', 'base64url'] as const) assert.ok(!refusal.message.includes(exported.toString(encoding).slice(-24)), `sem material de chave (${encoding})`);
  }
});

/* =============================================================================================================== vetores-ouro (RS-09) e fechos */

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const fromSeed = (seedHex: string): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
const { a: GA, b: GB } = GOLDEN.keys;
const GOLD_AUDIT = GOLDEN.g1.body.auditId;
const GOLD_RING = `${GA.keyId}:${GA.publicRaw},${GB.keyId}:${GB.publicRaw}`;
const SEED_OF: Readonly<Record<string, string>> = { [GA.keyId]: GA.seedHex, [GB.keyId]: GB.seedHex };
/** Cabeçalho dos vetores: os hashes de dossiê são `sha256("ouro|<rótulo>")`; o rótulo de G1..G3 é `dossie-0N` (premissa conferida abaixo). */
const goldenDossier = (n: number): Buffer => Buffer.from(`ouro|dossie-0${n}`, 'utf8');
type GoldenV2 = typeof GOLDEN.g1 | typeof GOLDEN.g2 | typeof GOLDEN.g3;
const fileOf = (vector: GoldenV2): EvidenceSealFileV2 => ({ ...vector.body, entries: plain(vector.body.entries), signature: vector.signature });

/** Do pacote aos bytes: o plano do sign (cadeia lida e verificada) + corpo + assinatura com a semente de teste = o vetor gerado por rota independente. */
async function produceGolden(vector: GoldenV2, sealsDir: string, trustKeys = GOLD_RING): Promise<void> {
  const n = vector.body.seq;
  const dossier = goldenDossier(n);
  assert.equal(sha256(dossier), vector.body.dossier.sha256, `premissa do vetor G${n}`);
  const pkg = makePackage(vector.body.entries, GOLD_AUDIT, '2026-11-19T09:00:00.000Z');
  const plan = await planned(inputOf({ sealsDir, pkg, approval: makeApproval(pkg, dossier, vector.body.dossier.id), dossier, expectSeq: n, first: n === 1, trustKeys }), { now: vector.body.sealedAt });
  const built = buildSealManifestBody(plan, vector.body.keyId);
  if (!built.ok) assert.fail(built.code);
  assert.equal(built.signingBytes.toString('hex'), vector.canonicalHex, `G${n}: bytes canônicos`);
  const signed = signSealManifest(plan, vector.body.keyId, fromSeed(SEED_OF[vector.body.keyId] as string));
  if (!signed.ok) assert.fail(signed.code);
  assert.deepEqual(signed.seal, fileOf(vector), `G${n}: arquivo`);
  assert.equal(signed.seal.signature, vector.signature, `G${n}: assinatura`);
  assert.equal(sealSha256(signed.seal), vector.sealSha256, `G${n}: sealSha256`);
}

test('IA-03 (fonte, RS-09): o sign reproduz os vetores-ouro G1 → G2 → G3 a partir do pacote (cadeia dos próprios vetores lida e verificada; G3 com a outra chave)', async () => {
  const sealsDir = tmpDir('lass-ouro-');
  await produceGolden(GOLDEN.g1, sealsDir);
  deliver(sealsDir, GOLD_AUDIT, fileOf(GOLDEN.g1)); // a cadeia seguinte parte dos BYTES do vetor, não do que foi produzido
  await produceGolden(GOLDEN.g2, sealsDir);
  deliver(sealsDir, GOLD_AUDIT, fileOf(GOLDEN.g2));
  await produceGolden(GOLDEN.g3, sealsDir);
});

test('§5.5.1 item 2 (lista completa com estado e fechos): G1–G2 da chave aposentada a, cobertos pelo fecho G6 fixado por hash ⇒ cadeia verificada e G3 (chave b) reproduzido; sem o hash fixado ⇒ SIGN_SEAL_CHAIN_INVALID', async () => {
  const sealsDir = tmpDir('lass-fecho-');
  deliver(sealsDir, GOLD_AUDIT, fileOf(GOLDEN.g1));
  deliver(sealsDir, GOLD_AUDIT, fileOf(GOLDEN.g2));
  fs.mkdirSync(path.join(sealsDir, '_closures'));
  fs.writeFileSync(path.join(sealsDir, '_closures', `${GA.keyId}.json`), Buffer.from(GOLDEN.g6.fileHex, 'hex'));
  const pinned = `${GA.keyId}:${GA.publicRaw}:retired:${GOLDEN.g6.closureSha256},${GB.keyId}:${GB.publicRaw}:active`;
  await produceGolden(GOLDEN.g3, sealsDir, pinned);
  const pkg = makePackage(GOLDEN.g3.body.entries, GOLD_AUDIT, '2026-11-19T09:00:00.000Z');
  const g3 = (trustKeys: string): SignWithChainInput => inputOf({ sealsDir, pkg, approval: makeApproval(pkg, goldenDossier(3), GOLDEN.g3.body.dossier.id), dossier: goldenDossier(3), expectSeq: 3, trustKeys });
  await chainRefused(g3(`${GA.keyId}:${GA.publicRaw}:retired,${GB.keyId}:${GB.publicRaw}`), 'SEAL_KEY_RETIRED_UNCOVERED', 'aposentada sem hash fixado', { now: GOLDEN.g3.body.sealedAt });
  await chainRefused(g3(`${GA.keyId}:${GA.publicRaw}:retired:${GOLDEN.g6.canonicalFileSha256},${GB.keyId}:${GB.publicRaw}`), 'SEAL_KEY_RETIRED_UNCOVERED', 'hash fixado de outros bytes', { now: GOLDEN.g3.body.sealedAt });
});

/* =============================================================================================================== guarda do passo 7 no núcleo */

test('passo 7 no núcleo: fato de cadeia fora de forma (seq, sealSha256) ⇒ SIGN_SEAL_CHAIN_INVALID; o código da cadeia só é repassado se for código fixo', async () => {
  const pkg = makePackage(E3);
  const core = (chain: unknown, expectSeq = 2) =>
    runSignCore(
      { auditId: AUD, custodian: 'CUST-01', packageBytes: bytes(pkg), approvalBytes: bytes(makeApproval(pkg)), dossierBytes: DOSSIER, riskAcceptanceBytes: null, chain: chain as never, expectSeq, first: false },
      { now: () => new Date(NOW), confirm: async () => pkg.packageSha256.slice(0, CONFIRM_LENGTH), openKey: () => KEY_SENTINEL },
    );
  const last = { auditId: AUD, seq: 1, sealSha256: h('7'), sealedAt: '2026-11-18T10:00:00.000Z', entries: plain(E1) };
  assert.ok((await core({ status: 'VERIFIED', last })).ok);
  for (const malformed of [{ ...last, seq: 0 }, { ...last, seq: 1.5 }, { ...last, seq: MAX_CHAIN_SEALS + 1 }, { ...last, sealSha256: 'A'.repeat(64) }, { ...last, sealSha256: null }]) {
    const result = await core({ status: 'VERIFIED', last: malformed });
    assert.equal(result.ok ? 'OK' : result.code, 'SIGN_SEAL_CHAIN_INVALID', JSON.stringify(malformed));
  }
  const coded = await core({ status: 'INVALID', reason: 'SEAL_CHAIN_BROKEN' });
  assert.ok(!coded.ok && coded.code === 'SIGN_SEAL_CHAIN_INVALID' && coded.chainReason === 'SEAL_CHAIN_BROKEN');
  const free = await core({ status: 'INVALID', reason: 'texto livre /tmp/x' });
  assert.ok(!free.ok && free.code === 'SIGN_SEAL_CHAIN_INVALID' && free.chainReason === undefined && !free.message.includes('/tmp/x'));
  const unknown = await core({ status: 'OUTRO' });
  assert.equal(unknown.ok ? 'OK' : unknown.code, 'SIGN_SEAL_CHAIN_INVALID');
});

test('§7.1 (revisão W4.2): erro de E/S na RAIZ --seals-dir (realpath ou lstat) ⇒ VERIFICATION_ERROR; só inexistente ou não diretório é SEALS_DIR_UNREADABLE', async () => {
  const sealsDir = tmpDir('lass-');
  chain(sealsDir, [{ entries: E1 }]);
  const root = fs.realpathSync(sealsDir);
  const failing: ReadonlyArray<readonly [string, FsOps]> = [
    ['realpath da raiz (EACCES)', faulty({ realpath: async (target) => (path.resolve(target) === path.resolve(sealsDir) ? Promise.reject(errno('EACCES')) : nodeFsOps.realpath(target)) })],
    ['lstat da raiz (EIO)', faulty({ lstat: async (target) => (target === root ? Promise.reject(errno('EIO')) : nodeFsOps.lstat(target)) })],
  ];
  for (const [label, fsOps] of failing) {
    await chainRefused(inputOf({ sealsDir, expectSeq: 2 }), 'VERIFICATION_ERROR', label, { fs: fsOps });
    await chainRefused(inputOf({ sealsDir, expectSeq: 1, first: true }), 'VERIFICATION_ERROR', `${label} com --first`, { fs: fsOps });
  }
  const enotdir = faulty({ realpath: async (target) => (path.resolve(target) === path.resolve(sealsDir) ? Promise.reject(errno('ENOTDIR')) : nodeFsOps.realpath(target)) });
  await chainRefused(inputOf({ sealsDir, expectSeq: 1, first: true }), 'SEALS_DIR_UNREADABLE', 'ENOTDIR na raiz', { fs: enotdir });
});

/* =============================================================================================================== revisão da W4.1: passos 9 e 11 pela cadeia */

/** Fotografia da cópia da estação: nomes e bytes de cada arquivo (para provar que nada foi escrito nem apagado). */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = sha256(fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

test('passo 11 pela cadeia (revisão da W4.1): confirmação errada ⇒ SIGN_CONFIRMATION_FAILED, nada assinado, chave não aberta; a cadeia foi lida e julgada antes', async () => {
  const sealsDir = tmpDir('lass-');
  chain(sealsDir, [{ entries: E1 }, { entries: E2 }]);
  const before = snapshotTree(sealsDir);
  const input = inputOf({ sealsDir, expectSeq: 3 });
  const right = rightPrefix(input);
  for (const typed of [right.toUpperCase(), right.slice(0, CONFIRM_LENGTH - 1), `${right}\n`, makePackage(E3).packageSha256]) {
    const { result, calls, facts } = await run(input, { confirm: async () => typed });
    assert.equal(result.ok ? 'OK' : result.code, 'SIGN_CONFIRMATION_FAILED', JSON.stringify(typed));
    assert.ok(!('plan' in result) && !('key' in result), 'nada para assinar');
    assert.deepEqual(calls, ['confirm'], 'a chave não é aberta');
    assert.deepEqual(facts, [{ auditId: AUD, seq: 3, entries: E3.length }], 'a confirmação vem depois da cadeia julgada (seq calculado) e não mostra o hash');
  }
  for (const failing of [async (): Promise<string> => Promise.reject(new Error('SENTINELA sem TTY')), (): Promise<string> => { throw new Error('SENTINELA EOF'); }]) {
    const refusal = await refusedWith(input, 'SIGN_CONFIRMATION_FAILED', { confirm: failing });
    assert.ok(!JSON.stringify(refusal).includes('SENTINELA'));
  }
  assert.equal(right, makePackage(E3).packageSha256.slice(0, CONFIRM_LENGTH));
  assert.equal((await planned(input)).seq, 3, 'com os 12 caracteres certos, o mesmo cenário dá plano');
  assert.deepEqual(snapshotTree(sealsDir), before, 'a cópia da estação não muda');
});

test('passo 11 pela cadeia: recusa da cadeia (passo 7) nunca chega à confirmação humana', async () => {
  const sealsDir = tmpDir('lass-');
  chain(sealsDir, [{ entries: E1 }, { entries: E2 }]);
  await chainRefused(inputOf({ sealsDir, expectSeq: 3, trustKeys: KEYS_B.trustKeys }), 'SEAL_INVALID', 'cadeia fora da lista');
  await refusedWith(inputOf({ sealsDir, expectSeq: 4 }), 'SIGN_SEQ_MISMATCH');
});

test('passo 9 pela cadeia (revisão da W4.1): runSignWithChain repassa os bytes do aceite de risco ao núcleo (existência e hash)', async () => {
  const sealsDir = tmpDir('lass-');
  chain(sealsDir, [{ entries: E1 }, { entries: E2 }]);
  const risk = Buffer.from('Aceite formal de risco FICTÍCIO da cadeia.\n', 'utf8');
  const pkg = makePackage(E3);
  const approval = { ...makeApproval(pkg), riskAcceptance: { id: 'aceite-cadeia-0001', sha256: sha256(risk) } };
  const same = { sealsDir, expectSeq: 3, pkg, approval, custodian: 'conf 01' } as const;
  const plan = await planned(inputOf({ ...same, riskAcceptance: risk }));
  assert.deepEqual([plan.roleException, plan.requiresLaterReview], [true, true]);
  await refusedWith(inputOf({ ...same, riskAcceptance: null }), 'SIGN_ROLE_SEPARATION');
  await refusedWith(inputOf({ ...same, riskAcceptance: Buffer.concat([risk, Buffer.from('x')]) }), 'SIGN_ROLE_SEPARATION');
});
