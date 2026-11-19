import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../src/lib/link-audit/canonical';
import { CHECK_IDS, computePackageSha256, type Approval, type CandidatePackage } from '../src/lib/link-audit-attestation';
import { approvalSchema } from '../src/lib/link-audit-attestation/schemas';
import { runSignCore, type ConfirmationFacts, type LastSealFacts, type SignCoreDeps, type SignCoreInput } from '../src/lib/link-audit-attestation/sign-core';
import { buildEvidenceSealBodyV2, createEvidenceSealV2 } from '../src/lib/link-audit-evidence/provenance';

/*
 * P1 W4.1 — núcleo PURO do `sign` (spec §5.5 passos 1–6 e 8–11; §5.5.1 item 3). Dados 100% FICTÍCIOS; a chave é de teste, gerada em memória,
 * e só aparece como o valor devolvido pelo espião do leitor de chave (IA-01: 0 chamadas em toda recusa). A confirmação humana (passo 11) é a
 * porta injetada `confirm`: o espião devolve o texto "digitado" e, sem outra instrução, digita os 12 primeiros caracteres certos.
 */
const h = (c: string): string => c.repeat(64);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const AUDIT = 'auditoria-teste-0001';
const OTHER_AUDIT = 'auditoria-teste-0002';
const FIRST_COLLECTED_AT = '2026-11-18T09:00:00.000Z';
const LAST_COLLECTED_AT = '2026-11-18T10:00:00.000Z';
const LAST_SEALED_AT = '2026-11-18T12:00:00.000Z';
const NOW = '2026-11-19T09:00:00.000Z';
const KEY_ID = 'ek-202611-a';
const TEST_KEY = generateKeyPairSync('ed25519').privateKey;
/** Bytes do dossiê com trechos que NÃO são UTF-8: o hash é sobre os bytes lidos, nunca sobre um texto decodificado. */
const DOSSIER = Buffer.concat([Buffer.from('Dossiê de aprovação FICTÍCIO (parte A).\n', 'utf8'), Buffer.from([0xff, 0xfe, 0x00, 0x80])]);
/** Arquivo do aceite formal de risco (passo 9): só existência e hash, conteúdo humano. Bytes com trecho fora de UTF-8, como o dossiê. */
const RISK = Buffer.concat([Buffer.from('Aceite formal de risco FICTÍCIO: uma pessoa acumula conferente e custodiante.\n', 'utf8'), Buffer.from([0xfe, 0x01])]);
const RISK_REF = { id: 'aceite-0001', sha256: sha256(RISK) } as const;
/** Passo 11: o custodiante digita os 12 primeiros caracteres de `packageSha256`, lidos no dossiê. */
const CONFIRM_LENGTH = 12;

type CheckId = (typeof CHECK_IDS)[number];
type CheckStatus = 'PASS' | 'FAIL' | 'NOT_EXECUTED';
const MECHANICAL = ['INTEGRITY_LOCAL', 'COLLECTOR_HASH_MATCHES', 'COLLECTION_GAP_WITHIN_LIMIT', 'HTTP_2XX_AND_COLLECTED_AT', 'REPORT_REPRODUCES'] as const;
const NOT_HUMAN = ['INTEGRITY_LOCAL', 'COLLECTOR_HASH_MATCHES', 'COLLECTION_GAP_WITHIN_LIMIT', 'HTTP_2XX_AND_COLLECTED_AT'] as const;
const NON_MECHANICAL = ['AUTHORIZATION_CONSUMED', 'PROVIDER_PANEL_CREDITS', 'URL_QUERY_COHERENCE'] as const;
const HUMAN = [...NON_MECHANICAL, 'REPORT_REPRODUCES'] as const;

const ENTRIES = [
  { ref: 'capture:c0001', contentSha256: h('a') },
  { ref: 'capture:c0002', contentSha256: h('b') },
  { ref: 'report:c0001-r0001', contentSha256: h('c') },
  { ref: 'report:c0002-r0001', contentSha256: h('d') },
] as const;

interface PackageVariant {
  readonly checks?: Partial<Record<CheckId, CheckStatus>>;
  readonly legacy?: boolean;
  readonly auditId?: string;
}

/** Pacote como o `export` o entrega (atestável, versionado), com o hash refeito sobre o corpo. */
function packageBody(variant: PackageVariant = {}): Omit<CandidatePackage, 'packageSha256'> {
  const legacy = variant.legacy ?? false;
  const statuses: Record<CheckId, CheckStatus> = {
    INTEGRITY_LOCAL: 'PASS',
    COLLECTOR_HASH_MATCHES: 'PASS',
    COLLECTION_GAP_WITHIN_LIMIT: 'PASS',
    HTTP_2XX_AND_COLLECTED_AT: 'PASS',
    REPORT_REPRODUCES: 'NOT_EXECUTED',
    AUTHORIZATION_CONSUMED: 'NOT_EXECUTED',
    PROVIDER_PANEL_CREDITS: 'NOT_EXECUTED',
    URL_QUERY_COHERENCE: 'NOT_EXECUTED',
    ...variant.checks,
  };
  return {
    schemaVersion: 1,
    kind: 'LINK_AUDIT_P1_CANDIDATE',
    auditId: variant.auditId ?? AUDIT,
    layout: legacy ? 'LEGACY' : 'VERSIONED',
    attestable: !legacy,
    summary: { company: { name: 'Empresa Fictícia', city: 'Cidade Fictícia', stateCode: 'GO' }, firstCollectedAt: FIRST_COLLECTED_AT, lastCollectedAt: LAST_COLLECTED_AT, captures: 2, reportRevisions: 2, artifacts: 0, containsLegacy: legacy },
    integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles: ENTRIES.length },
    checks: CHECK_IDS.map((id) => ({ id, status: statuses[id] })),
    gap: legacy ? null : { maxHours: 24, observedHours: 3, justification: null },
    entries: ENTRIES.map((entry) => ({ ...entry, legacy })),
    delta: null,
    generatedAt: '2026-11-18T13:00:00.000Z',
  };
}
const makePackage = (variant: PackageVariant = {}): CandidatePackage => {
  const body = packageBody(variant);
  return { ...body, packageSha256: computePackageSha256(body) };
};
/** Hash "na mão" (sem o esquema): para pacotes que o esquema recusa, mas que um atacante aprovaria. */
const rawHashed = (body: Record<string, unknown>): Record<string, unknown> & { readonly packageSha256: string } => {
  const { delta: _delta, generatedAt: _generatedAt, ...hashed } = body;
  return { ...body, packageSha256: sha256Hex(canonicalJson(hashed)) };
};

const makeApproval = (pkg: { readonly packageSha256: unknown }, over: Partial<Approval> = {}): Approval => ({
  schemaVersion: 1,
  kind: 'LINK_AUDIT_P1_APPROVAL',
  auditId: AUDIT,
  packageSha256: String(pkg.packageSha256),
  decision: 'APPROVED',
  approvedBy: 'CONF-01',
  operator: 'OPER-01',
  approvedAt: '2026-11-18T14:00:00.000Z',
  dossier: { id: 'dossie-2026-0001', sha256: sha256(DOSSIER) },
  humanChecks: HUMAN.map((id) => ({ id, result: 'PASS' as const, note: 'conferido pelo conferente (fictício)' })),
  riskAcceptance: null,
  ...over,
});

/** Último manifesto REAL (`v2`, assinado pela chave de teste): `EvidenceSealFileV2` satisfaz `LastSealFacts` estruturalmente. */
const makeLastSeal = (over: { readonly auditId?: string; readonly entries?: ReadonlyArray<{ ref: string; contentSha256: string }>; readonly sealedAt?: string } = {}): LastSealFacts =>
  createEvidenceSealV2({
    auditId: over.auditId ?? AUDIT,
    seq: 1,
    sealedAt: over.sealedAt ?? LAST_SEALED_AT,
    keyId: KEY_ID,
    entries: over.entries ?? ENTRIES.slice(0, 3),
    dossier: { id: 'dossie-2026-0000', sha256: h('9') },
    prevSealSha256: null,
    privateKey: TEST_KEY,
  });

const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value, null, 2), 'utf8');
const inputFor = (pkg: unknown, approval: unknown, over: Partial<SignCoreInput> = {}): SignCoreInput => ({
  auditId: AUDIT,
  custodian: 'CUST-01',
  packageBytes: bytes(pkg),
  approvalBytes: bytes(approval),
  dossierBytes: DOSSIER,
  lastSeal: makeLastSeal(),
  riskAcceptanceBytes: null,
  ...over,
});
const validInput = (over: Partial<SignCoreInput> = {}): SignCoreInput => {
  const pkg = makePackage();
  return inputFor(pkg, makeApproval(pkg), over);
};

/** O que um custodiante que leu o dossiê digitaria: os 12 primeiros caracteres do `packageSha256` dos bytes do pacote ('' se nem é JSON). */
function rightPrefix(input: SignCoreInput): string {
  try {
    return String((JSON.parse(Buffer.from(input.packageBytes).toString('utf8')) as { packageSha256?: unknown }).packageSha256).slice(0, CONFIRM_LENGTH);
  } catch {
    return '';
  }
}

type Confirm = SignCoreDeps<unknown>['confirm'];
/** Digita um texto fixo (assíncrono, como a tela real). */
const typing = (text: unknown): Confirm => async () => text as string;

/**
 * Roda o núcleo com relógio, confirmação e leitor de chave espiões; registra a ordem das chamadas e o que a tela da confirmação recebeu. Sem
 * `confirm`, o custodiante digita os 12 caracteres certos; com `confirm`, ele é chamado como veio (um `throw` síncrono continua síncrono).
 */
async function run(input: SignCoreInput, now: string = NOW, confirm?: Confirm) {
  const calls: string[] = [];
  const facts: ConfirmationFacts[] = [];
  const result = await runSignCore(input, {
    now: () => {
      calls.push('now');
      return new Date(now);
    },
    confirm: (seen) => {
      calls.push('confirm');
      facts.push(seen);
      return confirm ? confirm(seen) : Promise.resolve(rightPrefix(input));
    },
    openKey: () => {
      calls.push('openKey');
      return TEST_KEY;
    },
  });
  const count = (name: string): number => calls.filter((call) => call === name).length;
  return { result, calls, facts, keyCalls: count('openKey'), confirmCalls: count('confirm') };
}

async function assertRefused(input: SignCoreInput, code: string, now: string = NOW, confirm?: Confirm) {
  const { result, keyCalls, confirmCalls } = await run(input, now, confirm);
  assert.equal(result.ok ? 'OK' : result.code, code);
  assert.equal(keyCalls, 0, 'o leitor de chave nunca é chamado numa recusa');
  assert.equal(confirmCalls, code === 'SIGN_CONFIRMATION_FAILED' ? 1 : 0, 'a confirmação humana só depois de TODAS as recusas dos passos 1–10');
  assert.ok(!('plan' in result) && !('key' in result), 'recusa não devolve plano de manifesto nem chave');
  if (result.ok) assert.fail('esperava recusa');
  assert.ok(result.message.length > 0 && !result.message.includes('Empresa Fictícia') && !result.message.includes('FICTÍCIO'), 'mensagem sem conteúdo de arquivo');
  return result;
}

async function assertSigned(input: SignCoreInput, now: string = NOW) {
  const { result, calls } = await run(input, now);
  if (!result.ok) assert.fail(`esperava sucesso, veio ${result.code}`);
  assert.deepEqual(calls, ['now', 'confirm', 'openKey'], 'relógio no passo 10, confirmação humana no 11 e a chave só depois, uma vez (passo 12)');
  assert.equal(result.key, TEST_KEY);
  return result.plan;
}

/* --------------------------------------------------------------------------------------------------------------- caminho feliz */

test('IA-01 caminho feliz: tudo válido ⇒ plano com o conjunto exato do pacote, o dossiê lido e o relógio; a chave é aberta uma única vez, no fim', async () => {
  const pkg = makePackage();
  const plan = await assertSigned(inputFor(pkg, makeApproval(pkg)));
  assert.deepEqual(plan, {
    auditId: AUDIT,
    sealedAt: NOW,
    packageSha256: pkg.packageSha256,
    entries: ENTRIES.map((entry) => ({ ref: entry.ref, contentSha256: entry.contentSha256 })),
    dossier: { id: 'dossie-2026-0001', sha256: sha256(DOSSIER) },
    approvedBy: 'CONF-01',
    operator: 'OPER-01',
    custodian: 'CUST-01',
    roleException: false,
    requiresLaterReview: false,
  });
});

test('IA-01 primeiro manifesto (sem último manifesto): sem o passo 8, o plano sai igual', async () => {
  const plan = await assertSigned(validInput({ lastSeal: null }));
  assert.equal(plan.entries.length, ENTRIES.length);
});

/* --------------------------------------------------------------------------------------------------------------- IA-01 (a)–(d) */

test('IA-01 (a): hash de entrada já atestada mudou ⇒ SIGN_EVIDENCE_CHANGED (informa a ref); chave não aberta', async () => {
  const changed = ENTRIES.slice(0, 3).map((entry) => (entry.ref === 'capture:c0002' ? { ...entry, contentSha256: h('e') } : entry));
  const refusal = await assertRefused(validInput({ lastSeal: makeLastSeal({ entries: changed }) }), 'SIGN_EVIDENCE_CHANGED');
  assert.deepEqual(refusal.refs, ['capture:c0002']);
  assert.match(refusal.message, /capture:c0002/);
});

test('IA-01 (a): entrada do último manifesto sumiu do pacote ⇒ SIGN_EVIDENCE_CHANGED; no máximo 5 refs informadas', async () => {
  const extra = ['capture:c0010', 'capture:c0011', 'capture:c0012', 'capture:c0013', 'capture:c0014', 'capture:c0015'].map((ref) => ({ ref, contentSha256: h('f') }));
  const one = await assertRefused(validInput({ lastSeal: makeLastSeal({ entries: [...ENTRIES.slice(0, 3), extra[0]!] }) }), 'SIGN_EVIDENCE_CHANGED');
  assert.deepEqual(one.refs, ['capture:c0010']);
  const many = await assertRefused(validInput({ lastSeal: makeLastSeal({ entries: [...ENTRIES.slice(0, 3), ...extra] }) }), 'SIGN_EVIDENCE_CHANGED');
  assert.deepEqual(many.refs, extra.slice(0, 5).map((entry) => entry.ref));
});

test('IA-01 (a): entradas novas no pacote são permitidas; o mesmo conjunto do último manifesto também', async () => {
  await assertSigned(validInput({ lastSeal: makeLastSeal({ entries: ENTRIES.slice(0, 1) }) }));
  await assertSigned(validInput({ lastSeal: makeLastSeal({ entries: [...ENTRIES] }) }));
});

test('IA-01 (b): pacote legado (como o export o produz) ⇒ SIGN_LEGACY_NOT_ATTESTABLE, inclusive com dossiê e aprovação válidos', async () => {
  const allNotExecuted = Object.fromEntries(CHECK_IDS.map((id) => [id, 'NOT_EXECUTED'])) as Record<CheckId, CheckStatus>;
  const legacy = makePackage({ legacy: true, checks: allNotExecuted });
  assert.equal(legacy.attestable, false);
  const refusal = await assertRefused(inputFor(legacy, makeApproval(legacy), { lastSeal: null }), 'SIGN_LEGACY_NOT_ATTESTABLE');
  assert.match(refusal.message, /legada não é atestável/);
});

test('IA-01 (c): pacote a assinar não é o aprovado ⇒ SIGN_PACKAGE_MISMATCH; decisão diferente de APPROVED ⇒ SIGN_APPROVAL_INVALID', async () => {
  const pkg = makePackage();
  const otherApproved = makePackage({ checks: { REPORT_REPRODUCES: 'PASS' } });
  const refusal = await assertRefused(inputFor(pkg, makeApproval(otherApproved)), 'SIGN_PACKAGE_MISMATCH');
  assert.match(refusal.message, /não é o aprovado/);
  for (const decision of ['REJECTED', 'approved', 'PENDING']) await assertRefused(inputFor(pkg, { ...makeApproval(pkg), decision }), 'SIGN_APPROVAL_INVALID');
});

test('IA-01 (d): FAIL em verificação ⇒ SIGN_INTEGRITY_NOT_OK; integridade ≠ OK é recusada já no passo 1 (o esquema da W1 fixa "OK")', async () => {
  const failing = makePackage({ checks: { HTTP_2XX_AND_COLLECTED_AT: 'FAIL' } });
  const refusal = await assertRefused(inputFor(failing, makeApproval(failing)), 'SIGN_INTEGRITY_NOT_OK');
  assert.match(refusal.message, /HTTP_2XX_AND_COLLECTED_AT/);
  const broken = rawHashed({ ...packageBody(), integrity: { status: 'FAIL', algorithm: 'SHA-256', checkedFiles: ENTRIES.length } });
  await assertRefused(inputFor(broken, makeApproval(broken)), 'SIGN_PACKAGE_INVALID');
});

/* --------------------------------------------------------------------------------------------------------------- IA-11 */

test('IA-11: entrada do pacote alterada sem refazer o hash ⇒ SIGN_PACKAGE_INVALID; refazendo o hash sem reaprovar ⇒ SIGN_PACKAGE_MISMATCH', async () => {
  const pkg = makePackage();
  const approval = makeApproval(pkg);
  const tampered = structuredClone(pkg);
  tampered.entries[1] = { ...tampered.entries[1]!, contentSha256: h('f') };
  await assertRefused(inputFor(tampered, approval), 'SIGN_PACKAGE_INVALID');
  await assertRefused(inputFor({ ...tampered, packageSha256: computePackageSha256(tampered) }, approval), 'SIGN_PACKAGE_MISMATCH');
  const added = structuredClone(pkg);
  added.entries.push({ ref: 'report:c0002-r0002', contentSha256: h('e'), legacy: false });
  added.summary.reportRevisions = 3;
  added.integrity.checkedFiles = 5;
  await assertRefused(inputFor({ ...added, packageSha256: computePackageSha256(added) }, approval), 'SIGN_PACKAGE_MISMATCH');
});

test('IA-11: campos fora do hash (generatedAt, delta) não mudam o pacote aprovado', async () => {
  const pkg = makePackage();
  const moved = { ...pkg, generatedAt: '2026-11-18T15:00:00.000Z', delta: { added: ['capture:c0002'], changed: [], missing: [] } };
  await assertSigned(inputFor(moved, makeApproval(pkg)));
});

test('passo 1: bytes do pacote/aprovação fora de forma (não JSON, BOM, UTF-8 inválido, não objeto, campo extra) ⇒ recusa sem abrir a chave', async () => {
  const pkg = makePackage();
  const approval = bytes(makeApproval(pkg));
  const good = bytes(pkg);
  const badPackages: Uint8Array[] = [
    Buffer.from('não é json'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]),
    Buffer.concat([good.subarray(0, 10), Buffer.from([0xff]), good.subarray(10)]),
    bytes([pkg]),
    bytes({ ...pkg, extra: true }),
    new Uint8Array(0),
  ];
  for (const packageBytes of badPackages) await assertRefused({ ...validInput(), packageBytes, approvalBytes: approval }, 'SIGN_PACKAGE_INVALID');
  for (const approvalBytes of [Buffer.from('{'), bytes({ ...makeApproval(pkg), extra: true }), bytes(null)]) await assertRefused({ ...validInput(), approvalBytes }, 'SIGN_APPROVAL_INVALID');
});

test('passo 1: UTF-8 inválido é recusado mesmo onde a troca por U+FFFD daria um pacote coerente (decodificação estrita)', async () => {
  const body = packageBody();
  const named = { ...body, summary: { ...body.summary, company: { ...body.summary.company, name: 'Empresa �' } } };
  const pkg = { ...named, packageSha256: computePackageSha256(named) };
  await assertSigned(inputFor(pkg, makeApproval(pkg)));
  const raw = Buffer.from(bytes(pkg));
  const at = raw.indexOf(Buffer.from('�', 'utf8'));
  assert.ok(at > 0);
  const broken = Buffer.concat([raw.subarray(0, at), Buffer.from([0xff]), raw.subarray(at + 3)]);
  await assertRefused({ ...inputFor(pkg, makeApproval(pkg)), packageBytes: broken }, 'SIGN_PACKAGE_INVALID');
});

test('entrada do núcleo: --audit fora do padrão ou --custodian fora de rótulo curto ⇒ USAGE, antes de ler qualquer coisa', async () => {
  for (const auditId of ['', 'CURTO', '../auditoria-teste-0001', 'auditoria/teste-0001', 'Auditoria-Teste-0001']) await assertRefused(validInput({ auditId }), 'USAGE');
  for (const custodian of ['', 'ana@exemplo.invalid', '11 91234-5678', 'a/b', 'x'.repeat(65)]) await assertRefused(validInput({ custodian }), 'USAGE');
});

/* --------------------------------------------------------------------------------------------------------------- IA-06 (itens 2 e 3) */

test('IA-06 (2): --audit diferente do auditId do pacote ou da aprovação ⇒ SIGN_AUDIT_MISMATCH', async () => {
  await assertRefused(validInput({ auditId: OTHER_AUDIT }), 'SIGN_AUDIT_MISMATCH');
  const pkg = makePackage();
  await assertRefused(inputFor(pkg, makeApproval(pkg, { auditId: OTHER_AUDIT })), 'SIGN_AUDIT_MISMATCH');
  const other = makePackage({ auditId: OTHER_AUDIT });
  await assertRefused(inputFor(other, makeApproval(other)), 'SIGN_AUDIT_MISMATCH');
  await assertRefused(inputFor(other, makeApproval(other, { auditId: OTHER_AUDIT })), 'SIGN_AUDIT_MISMATCH');
});

test('IA-06 (3): último manifesto (válido e assinado) de outra auditoria ⇒ SIGN_SEAL_CHAIN_INVALID', async () => {
  await assertRefused(validInput({ lastSeal: makeLastSeal({ auditId: OTHER_AUDIT }) }), 'SIGN_SEAL_CHAIN_INVALID');
});

test('IA-06 (3): último manifesto fora de forma (data, entradas vazias, ref ou hash inválidos) ⇒ SIGN_SEAL_CHAIN_INVALID', async () => {
  const base: LastSealFacts = { auditId: AUDIT, sealedAt: LAST_SEALED_AT, entries: ENTRIES.slice(0, 3) };
  const malformed: LastSealFacts[] = [
    { ...base, sealedAt: '2026-11-18T12:00:00Z' },
    { ...base, sealedAt: 'ontem' },
    { ...base, entries: [] },
    { ...base, entries: [{ ref: 'site:c0001', contentSha256: h('a') }] },
    { ...base, entries: [{ ref: 'capture:c0001', contentSha256: 'A'.repeat(64) }] },
  ];
  await assertSigned(validInput({ lastSeal: base }));
  for (const lastSeal of malformed) await assertRefused(validInput({ lastSeal }), 'SIGN_SEAL_CHAIN_INVALID');
});

/* --------------------------------------------------------------------------------------------------------------- IA-17 (herdado) */

test('IA-17 (RS-02): FAIL em cada verificação mecânica ⇒ SIGN_INTEGRITY_NOT_OK, mesmo com resultado humano PASS na aprovação', async () => {
  for (const id of MECHANICAL) {
    const pkg = makePackage({ checks: { [id]: 'FAIL' } });
    const refusal = await assertRefused(inputFor(pkg, makeApproval(pkg)), 'SIGN_INTEGRITY_NOT_OK');
    assert.match(refusal.message, new RegExp(id));
  }
});

test('IA-17 (RS-02): FAIL numa verificação não mecanizável nunca chega ao sign (o esquema da W1 recusa) ⇒ SIGN_PACKAGE_INVALID', async () => {
  for (const id of NON_MECHANICAL) {
    const body = packageBody();
    const broken = rawHashed({ ...body, checks: body.checks.map((check) => (check.id === id ? { ...check, status: 'FAIL' } : check)) });
    await assertRefused(inputFor(broken, makeApproval(broken)), 'SIGN_PACKAGE_INVALID');
  }
});

test('IA-17 (RS-02): verificação mecânica que só o export executa em NOT_EXECUTED ⇒ SIGN_CHECK_NOT_EXECUTED (a aprovação não pode supri-la)', async () => {
  for (const id of NOT_HUMAN) {
    const pkg = makePackage({ checks: { [id]: 'NOT_EXECUTED' } });
    const refusal = await assertRefused(inputFor(pkg, makeApproval(pkg)), 'SIGN_CHECK_NOT_EXECUTED');
    assert.match(refusal.message, new RegExp(id));
  }
});

test('IA-17 (RS-02): NOT_EXECUTED sem resultado humano PASS com nota ⇒ SIGN_CHECK_NOT_EXECUTED (ausente, FAIL, nota vazia ou só espaços)', async () => {
  const pkg = makePackage();
  for (const id of HUMAN) {
    const variants: Array<Approval['humanChecks']> = [
      makeApproval(pkg).humanChecks.filter((check) => check.id !== id),
      makeApproval(pkg).humanChecks.map((check) => (check.id === id ? { ...check, result: 'FAIL' as const } : check)),
      makeApproval(pkg).humanChecks.map((check) => (check.id === id ? { ...check, note: '' } : check)),
      makeApproval(pkg).humanChecks.map((check) => (check.id === id ? { ...check, note: '   ' } : check)),
    ];
    for (const humanChecks of variants) {
      const refusal = await assertRefused(inputFor(pkg, makeApproval(pkg, { humanChecks })), 'SIGN_CHECK_NOT_EXECUTED');
      assert.match(refusal.message, new RegExp(id));
    }
  }
});

test('W4.1 (herdado da W1): resultado humano só é aceito para verificação que o pacote marca NOT_EXECUTED', async () => {
  const pkg = makePackage({ checks: { REPORT_REPRODUCES: 'PASS' } });
  const refusal = await assertRefused(inputFor(pkg, makeApproval(pkg)), 'SIGN_APPROVAL_INVALID');
  assert.match(refusal.message, /REPORT_REPRODUCES/);
  const failNote = makeApproval(pkg).humanChecks.map((check) => (check.id === 'REPORT_REPRODUCES' ? { ...check, result: 'FAIL' as const } : check));
  await assertRefused(inputFor(pkg, makeApproval(pkg, { humanChecks: failNote })), 'SIGN_APPROVAL_INVALID');
  await assertSigned(inputFor(pkg, makeApproval(pkg, { humanChecks: makeApproval(pkg).humanChecks.filter((check) => check.id !== 'REPORT_REPRODUCES') })));
});

/* --------------------------------------------------------------------------------------------------------------- dossiê (passo 6 e §5.5.1 item 3) */

test('passo 6: SHA-256 dos BYTES do dossiê ≠ approval.dossier.sha256 ⇒ SIGN_DOSSIER_MISMATCH', async () => {
  assert.notEqual(sha256(DOSSIER), sha256Hex(DOSSIER.toString('utf8')), 'premissa: decodificar como texto mudaria o hash');
  await assertRefused(validInput({ dossierBytes: Buffer.concat([DOSSIER, Buffer.from([0x0a])]) }), 'SIGN_DOSSIER_MISMATCH');
  await assertRefused(validInput({ dossierBytes: new Uint8Array(0) }), 'SIGN_DOSSIER_MISMATCH');
  const pkg = makePackage();
  await assertRefused(inputFor(pkg, makeApproval(pkg, { dossier: { id: 'dossie-2026-0001', sha256: h('9') } })), 'SIGN_DOSSIER_MISMATCH');
});

test('W4.1 (herdado da W1, §5.5.1 item 3): approval.dossier.id segue o padrão do contrato v2; tudo o que a aprovação aceita o manifesto v2 aceita', async () => {
  const approvalAccepts = (id: string): boolean => approvalSchema.safeParse({ ...makeApproval(makePackage()), dossier: { id, sha256: h('9') } }).success;
  const sealAccepts = (id: string): boolean => {
    try {
      buildEvidenceSealBodyV2({ auditId: AUDIT, seq: 1, sealedAt: NOW, keyId: KEY_ID, entries: ENTRIES.slice(0, 1), dossier: { id, sha256: h('9') }, prevSealSha256: null });
      return true;
    } catch {
      return false;
    }
  };
  const corpus = ['dossie-0001', 'd01', 'abc', '0ab', 'dossie.2026_11-a', 'a'.repeat(64), 'a'.repeat(65), 'ab', 'Dossie-0001', 'DOS-1', 'dossie 0001', '-dossie', '.dossie', '_dossie', 'dossiê-1', 'dossie/1', 'dossie@x', '', '11912345678', 'op-202611190'];
  assert.deepEqual(corpus.filter(approvalAccepts), ['dossie-0001', 'd01', 'abc', '0ab', 'dossie.2026_11-a', 'a'.repeat(64)]);
  for (const id of corpus.filter(approvalAccepts)) assert.ok(sealAccepts(id), `a aprovação aceita "${id}" e o manifesto v2 não`);
  assert.deepEqual(corpus.filter((id) => sealAccepts(id) && !approvalAccepts(id)), ['11912345678', 'op-202611190'], 'só é mais estrito que o contrato para o que parece telefone (sem PII)');
  assert.ok(approvalSchema.safeParse({ ...makeApproval(makePackage()), riskAcceptance: { id: 'Aceite 1', sha256: h('8') } }).success, 'riskAcceptance.id não muda');
});

/* --------------------------------------------------------------------------------------------------------------- passo 9 (RS-01) */

test('passo 9 (RS-01): conferente = custodiante sem aceite formal ⇒ SIGN_ROLE_SEPARATION, inclusive com caixa, separadores ou largura diferentes', async () => {
  for (const custodian of ['CONF-01', 'conf-01', 'CONF 01', 'Conf.01', 'conf_01', 'ＣＯＮＦ-01']) {
    const refusal = await assertRefused(validInput({ custodian }), 'SIGN_ROLE_SEPARATION');
    assert.match(refusal.message, /sem aceite formal de risco/);
  }
});

test('passo 9 (RS-01): com aceite formal (referência E arquivo com o hash citado) ⇒ prossegue com roleException e requiresLaterReview; operador = conferente só marca revisão', async () => {
  const pkg = makePackage();
  const accepted = await assertSigned(inputFor(pkg, makeApproval(pkg, { riskAcceptance: RISK_REF }), { custodian: 'CONF-01', riskAcceptanceBytes: RISK }));
  assert.deepEqual([accepted.roleException, accepted.requiresLaterReview], [true, true]);
  const sameOperator = await assertSigned(inputFor(pkg, makeApproval(pkg, { operator: 'conf 01' })));
  assert.deepEqual([sameOperator.roleException, sameOperator.requiresLaterReview], [false, true]);
  const acceptedButDistinct = await assertSigned(inputFor(pkg, makeApproval(pkg, { riskAcceptance: RISK_REF }), { riskAcceptanceBytes: RISK }));
  assert.deepEqual([acceptedButDistinct.roleException, acceptedButDistinct.requiresLaterReview], [false, false]);
});

test('passo 9 (RS-01, revisão da W4.1): papéis coincidem e o aceite não EXISTE ou não tem o hash citado ⇒ SIGN_ROLE_SEPARATION dizendo qual condição faltou', async () => {
  const pkg = makePackage();
  const cited = makeApproval(pkg, { riskAcceptance: RISK_REF });
  const missing = await assertRefused(inputFor(pkg, cited, { custodian: 'CONF-01', riskAcceptanceBytes: null }), 'SIGN_ROLE_SEPARATION');
  assert.match(missing.message, /arquivo do aceite formal de risco não foi fornecido/);
  for (const riskAcceptanceBytes of [Buffer.concat([RISK, Buffer.from([0x0a])]), RISK.subarray(1), DOSSIER]) {
    const wrong = await assertRefused(inputFor(pkg, cited, { custodian: 'conf 01', riskAcceptanceBytes }), 'SIGN_ROLE_SEPARATION');
    assert.match(wrong.message, /SHA-256 do arquivo do aceite formal de risco não confere/);
  }
  const empty = new Uint8Array(0);
  const citedEmpty = makeApproval(pkg, { riskAcceptance: { id: 'aceite-0001', sha256: sha256(empty) } });
  const vazio = await assertRefused(inputFor(pkg, citedEmpty, { custodian: 'CONF-01', riskAcceptanceBytes: empty }), 'SIGN_ROLE_SEPARATION');
  assert.match(vazio.message, /não foi fornecido \(ou está vazio\)/, 'arquivo vazio não é aceite escrito, mesmo com o hash do vazio citado');
  const notCited = await assertRefused(inputFor(pkg, makeApproval(pkg), { custodian: 'CONF-01', riskAcceptanceBytes: RISK }), 'SIGN_ROLE_SEPARATION');
  assert.match(notCited.message, /sem aceite formal de risco/, 'bytes sem a referência na aprovação não suprem o aceite');
  for (const refusal of [missing, vazio, notCited]) assert.ok(!refusal.message.includes(RISK_REF.sha256) && !refusal.message.includes('/'), 'sem hash, caminho nem conteúdo do aceite');
});

test('passo 9 (revisão da W4.1): papéis distintos ⇒ os bytes do aceite são ignorados (ausentes, de outro arquivo ou sem referência)', async () => {
  const pkg = makePackage();
  for (const riskAcceptanceBytes of [null, RISK, DOSSIER, new Uint8Array(0)]) {
    for (const approval of [makeApproval(pkg), makeApproval(pkg, { riskAcceptance: RISK_REF })]) {
      const plan = await assertSigned(inputFor(pkg, approval, { riskAcceptanceBytes }));
      assert.deepEqual([plan.roleException, plan.requiresLaterReview], [false, false]);
    }
  }
});

/* --------------------------------------------------------------------------------------------------------------- passo 10 */

test('passo 10: relógio antes do último manifesto ou da última coleta ⇒ SIGN_CLOCK_REGRESSION; instante igual é aceito', async () => {
  await assertRefused(validInput(), 'SIGN_CLOCK_REGRESSION', '2026-11-18T11:59:59.999Z');
  assert.equal((await assertSigned(validInput(), LAST_SEALED_AT)).sealedAt, LAST_SEALED_AT);
  await assertRefused(validInput({ lastSeal: null }), 'SIGN_CLOCK_REGRESSION', '2026-11-18T09:59:59.999Z');
  assert.equal((await assertSigned(validInput({ lastSeal: null }), LAST_COLLECTED_AT)).sealedAt, LAST_COLLECTED_AT);
  await assertRefused(validInput({ lastSeal: makeLastSeal({ sealedAt: '2026-11-18T08:00:00.000Z' }) }), 'SIGN_CLOCK_REGRESSION', '2026-11-18T09:30:00.000Z');
});

test('passo 10: relógio inválido ou fora do formato do manifesto ⇒ UNEXPECTED, sem abrir a chave', async () => {
  await assertRefused(validInput(), 'UNEXPECTED', 'não é data');
  await assertRefused(validInput(), 'UNEXPECTED', '+010000-01-01T00:00:00.000Z');
});

/* --------------------------------------------------------------------------------------------------------------- passo 11 (revisão da W4.1) */

test('passo 11: a confirmação humana vem depois de todas as recusas e antes da chave, uma vez; a tela recebe só auditId e o número de entradas (nunca o hash)', async () => {
  const pkg = makePackage();
  const { result, calls, facts } = await run(inputFor(pkg, makeApproval(pkg)));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['now', 'confirm', 'openKey']);
  assert.deepEqual(facts, [{ auditId: AUDIT, entries: ENTRIES.length }]);
  const shown = JSON.stringify(facts);
  assert.ok(!shown.includes(pkg.packageSha256.slice(0, CONFIRM_LENGTH)) && !shown.includes(sha256(DOSSIER)), 'o custodiante lê os 12 caracteres no dossiê, não na tela');
});

test('passo 11: texto digitado ≠ 12 primeiros caracteres de packageSha256 (comparação exata, sem normalizar) ⇒ SIGN_CONFIRMATION_FAILED, chave não aberta', async () => {
  const pkg = makePackage();
  const input = inputFor(pkg, makeApproval(pkg));
  const right = pkg.packageSha256.slice(0, CONFIRM_LENGTH);
  const flip = (text: string, at: number): string => text.slice(0, at) + (text[at] === '0' ? '1' : '0') + text.slice(at + 1);
  const wrong: unknown[] = [
    '',
    right.slice(0, CONFIRM_LENGTH - 1),
    pkg.packageSha256.slice(0, CONFIRM_LENGTH + 1),
    pkg.packageSha256,
    pkg.packageSha256.slice(-CONFIRM_LENGTH),
    flip(right, 0),
    flip(right, CONFIRM_LENGTH - 1),
    right.toUpperCase(),
    `${right}\n`,
    ` ${right}`,
    `${right} `,
    right.normalize('NFKC').replace(/[0-9]/gu, (digit) => String.fromCodePoint(0xff10 + Number(digit))),
    undefined,
    null,
    Number.NaN,
  ];
  assert.notEqual(right.toUpperCase(), right, 'premissa: o prefixo tem letra');
  for (const typed of wrong) {
    const refusal = await assertRefused(input, 'SIGN_CONFIRMATION_FAILED', NOW, typing(typed));
    assert.match(refusal.message, /não confere com os 12 primeiros caracteres/);
    assert.ok(!refusal.message.includes(right) && (typeof typed !== 'string' || typed === '' || !refusal.message.includes(typed)), 'nem o esperado nem o digitado aparecem na mensagem');
  }
});

test('passo 11: confirm que lança (síncrono) ou rejeita ⇒ SIGN_CONFIRMATION_FAILED, nunca sucesso; o erro da tela não vaza', async () => {
  const pkg = makePackage();
  const input = inputFor(pkg, makeApproval(pkg));
  const failures: Confirm[] = [
    () => {
      throw new Error('SENTINELA-TTY sem terminal');
    },
    async () => {
      throw new Error('SENTINELA-TTY interrompido');
    },
    () => Promise.reject(Object.assign(new Error('SENTINELA-TTY EOF'), { code: 'EOF' })),
  ];
  for (const confirm of failures) {
    const refusal = await assertRefused(input, 'SIGN_CONFIRMATION_FAILED', NOW, confirm);
    assert.match(refusal.message, /confirmação humana não foi obtida/);
    assert.ok(!JSON.stringify(refusal).includes('SENTINELA'), 'o objeto de erro nunca sai do núcleo');
  }
});

/* --------------------------------------------------------------------------------------------------------------- ordem do §5.5 */

type Fault = 'PACKAGE_SCHEMA' | 'APPROVAL_SCHEMA' | 'AUDIT' | 'PACKAGE_HASH' | 'NOT_APPROVED' | 'CHECK_FAIL' | 'LEGACY' | 'HUMAN_MISSING' | 'HUMAN_EXTRA' | 'DOSSIER' | 'CHAIN_AUDIT' | 'EVIDENCE_CHANGED' | 'ROLE' | 'CLOCK' | 'CONFIRM';
/** Falhas na ordem do §5.5 (1, 1, 1, 2, 3, 4a, 4/5, 4b, 4b, 6, 7*, 8, 9, 10, 11); 7* = guarda mínima do último manifesto (a cadeia é da W4.2). */
const LADDER: ReadonlyArray<readonly [Fault, string]> = [
  ['PACKAGE_SCHEMA', 'SIGN_PACKAGE_INVALID'],
  ['APPROVAL_SCHEMA', 'SIGN_APPROVAL_INVALID'],
  ['AUDIT', 'SIGN_AUDIT_MISMATCH'],
  ['PACKAGE_HASH', 'SIGN_PACKAGE_INVALID'],
  ['NOT_APPROVED', 'SIGN_PACKAGE_MISMATCH'],
  ['CHECK_FAIL', 'SIGN_INTEGRITY_NOT_OK'],
  ['LEGACY', 'SIGN_LEGACY_NOT_ATTESTABLE'],
  ['HUMAN_MISSING', 'SIGN_CHECK_NOT_EXECUTED'],
  ['HUMAN_EXTRA', 'SIGN_APPROVAL_INVALID'],
  ['DOSSIER', 'SIGN_DOSSIER_MISMATCH'],
  ['CHAIN_AUDIT', 'SIGN_SEAL_CHAIN_INVALID'],
  ['EVIDENCE_CHANGED', 'SIGN_EVIDENCE_CHANGED'],
  ['ROLE', 'SIGN_ROLE_SEPARATION'],
  ['CLOCK', 'SIGN_CLOCK_REGRESSION'],
  ['CONFIRM', 'SIGN_CONFIRMATION_FAILED'],
];

function build(faults: ReadonlySet<Fault>): { readonly input: SignCoreInput; readonly now: string; readonly confirm?: Confirm } {
  const has = (fault: Fault): boolean => faults.has(fault);
  const checks: Partial<Record<CheckId, CheckStatus>> = {};
  if (has('LEGACY')) for (const id of MECHANICAL) checks[id] = 'NOT_EXECUTED';
  if (has('HUMAN_EXTRA')) checks.REPORT_REPRODUCES = 'PASS';
  if (has('CHECK_FAIL')) checks.HTTP_2XX_AND_COLLECTED_AT = 'FAIL';
  const pkg: Record<string, unknown> = { ...makePackage({ legacy: has('LEGACY'), checks }) };
  const approval: Record<string, unknown> = { ...makeApproval(pkg as { packageSha256: string }) };
  if (has('PACKAGE_HASH')) pkg.packageSha256 = h('0');
  if (has('PACKAGE_SCHEMA')) pkg.extra = true;
  if (has('NOT_APPROVED')) approval.packageSha256 = h('1');
  if (has('APPROVAL_SCHEMA')) approval.extra = true;
  if (has('HUMAN_MISSING')) approval.humanChecks = makeApproval(pkg as { packageSha256: string }).humanChecks.filter((check) => check.id !== 'AUTHORIZATION_CONSUMED');
  const sealed = ENTRIES.slice(0, 3).map((entry) => (has('EVIDENCE_CHANGED') && entry.ref === 'capture:c0001' ? { ...entry, contentSha256: h('e') } : entry));
  const input = inputFor(pkg, approval, {
    auditId: has('AUDIT') ? OTHER_AUDIT : AUDIT,
    custodian: has('ROLE') ? 'CONF-01' : 'CUST-01',
    dossierBytes: has('DOSSIER') ? Buffer.concat([DOSSIER, Buffer.from([0x0a])]) : DOSSIER,
    lastSeal: makeLastSeal({ auditId: has('CHAIN_AUDIT') ? OTHER_AUDIT : AUDIT, entries: sealed }),
  });
  return { input, now: has('CLOCK') ? '2026-11-18T11:00:00.000Z' : NOW, ...(has('CONFIRM') ? { confirm: typing(rightPrefix(input).toUpperCase()) } : {}) };
}

test('IA-01 ordem do §5.5: com TODAS as falhas juntas, corrigir uma por vez revela as recusas exatamente nesta ordem; a confirmação e a chave só no fim', async () => {
  for (let rung = 0; rung <= LADDER.length; rung += 1) {
    const { input, now, confirm } = build(new Set(LADDER.slice(rung).map(([fault]) => fault)));
    const { result, keyCalls, confirmCalls } = await run(input, now, confirm);
    assert.equal(result.ok ? 'OK' : result.code, LADDER[rung]?.[1] ?? 'OK', `degrau ${rung} (${LADDER[rung]?.[0] ?? 'nenhuma falha'})`);
    assert.equal(keyCalls, rung < LADDER.length ? 0 : 1, `degrau ${rung}: chave`);
    assert.equal(confirmCalls, rung < LADDER.length - 1 ? 0 : 1, `degrau ${rung}: confirmação`);
  }
});

test('IA-01: cada falha sozinha dá o seu código, com o leitor de chave em 0 chamadas', async () => {
  for (const [fault, code] of LADDER) {
    const { input, now, confirm } = build(new Set([fault]));
    await assertRefused(input, code, now, confirm);
  }
});
