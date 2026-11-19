import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, sha256Hex } from '../src/lib/link-audit/canonical';
import { CHECK_IDS, computePackageSha256, type Approval, type CandidatePackage } from '../src/lib/link-audit-attestation';
import { approvalSchema } from '../src/lib/link-audit-attestation/schemas';
import { runSignCore, type LastSealFacts, type SignCoreInput } from '../src/lib/link-audit-attestation/sign-core';
import { buildEvidenceSealBodyV2, createEvidenceSealV2 } from '../src/lib/link-audit-evidence/provenance';

/*
 * P1 W4.1 — núcleo PURO do `sign` (spec §5.5 passos 1–6 e 8–10; §5.5.1 item 3). Dados 100% FICTÍCIOS; a chave é de teste, gerada em memória,
 * e só aparece como o valor devolvido pelo espião do leitor de chave (IA-01: 0 chamadas em toda recusa).
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
const rawHashed = (body: Record<string, unknown>): Record<string, unknown> => {
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
  ...over,
});
const validInput = (over: Partial<SignCoreInput> = {}): SignCoreInput => {
  const pkg = makePackage();
  return inputFor(pkg, makeApproval(pkg), over);
};

/** Roda o núcleo com relógio e leitor de chave espiões; registra a ordem das chamadas. */
function run(input: SignCoreInput, now: string = NOW) {
  const calls: string[] = [];
  const result = runSignCore(input, {
    now: () => {
      calls.push('now');
      return new Date(now);
    },
    openKey: () => {
      calls.push('openKey');
      return TEST_KEY;
    },
  });
  return { result, calls, keyCalls: calls.filter((call) => call === 'openKey').length };
}

function assertRefused(input: SignCoreInput, code: string, now: string = NOW) {
  const { result, keyCalls } = run(input, now);
  assert.equal(result.ok ? 'OK' : result.code, code);
  assert.equal(keyCalls, 0, 'o leitor de chave nunca é chamado numa recusa');
  assert.ok(!('plan' in result) && !('key' in result), 'recusa não devolve plano de manifesto nem chave');
  if (result.ok) assert.fail('esperava recusa');
  assert.ok(result.message.length > 0 && !result.message.includes('Empresa Fictícia') && !result.message.includes('FICTÍCIO'), 'mensagem sem conteúdo de arquivo');
  return result;
}

function assertSigned(input: SignCoreInput, now: string = NOW) {
  const { result, calls } = run(input, now);
  if (!result.ok) assert.fail(`esperava sucesso, veio ${result.code}`);
  assert.deepEqual(calls, ['now', 'openKey'], 'o relógio é lido no passo 10 e a chave só depois de todas as recusas, uma vez');
  assert.equal(result.key, TEST_KEY);
  return result.plan;
}

/* --------------------------------------------------------------------------------------------------------------- caminho feliz */

test('IA-01 caminho feliz: tudo válido ⇒ plano com o conjunto exato do pacote, o dossiê lido e o relógio; a chave é aberta uma única vez, no fim', () => {
  const pkg = makePackage();
  const plan = assertSigned(inputFor(pkg, makeApproval(pkg)));
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

test('IA-01 primeiro manifesto (sem último manifesto): sem o passo 8, o plano sai igual', () => {
  const plan = assertSigned(validInput({ lastSeal: null }));
  assert.equal(plan.entries.length, ENTRIES.length);
});

/* --------------------------------------------------------------------------------------------------------------- IA-01 (a)–(d) */

test('IA-01 (a): hash de entrada já atestada mudou ⇒ SIGN_EVIDENCE_CHANGED (informa a ref); chave não aberta', () => {
  const changed = ENTRIES.slice(0, 3).map((entry) => (entry.ref === 'capture:c0002' ? { ...entry, contentSha256: h('e') } : entry));
  const refusal = assertRefused(validInput({ lastSeal: makeLastSeal({ entries: changed }) }), 'SIGN_EVIDENCE_CHANGED');
  assert.deepEqual(refusal.refs, ['capture:c0002']);
  assert.match(refusal.message, /capture:c0002/);
});

test('IA-01 (a): entrada do último manifesto sumiu do pacote ⇒ SIGN_EVIDENCE_CHANGED; no máximo 5 refs informadas', () => {
  const extra = ['capture:c0010', 'capture:c0011', 'capture:c0012', 'capture:c0013', 'capture:c0014', 'capture:c0015'].map((ref) => ({ ref, contentSha256: h('f') }));
  const one = assertRefused(validInput({ lastSeal: makeLastSeal({ entries: [...ENTRIES.slice(0, 3), extra[0]!] }) }), 'SIGN_EVIDENCE_CHANGED');
  assert.deepEqual(one.refs, ['capture:c0010']);
  const many = assertRefused(validInput({ lastSeal: makeLastSeal({ entries: [...ENTRIES.slice(0, 3), ...extra] }) }), 'SIGN_EVIDENCE_CHANGED');
  assert.deepEqual(many.refs, extra.slice(0, 5).map((entry) => entry.ref));
});

test('IA-01 (a): entradas novas no pacote são permitidas; o mesmo conjunto do último manifesto também', () => {
  assertSigned(validInput({ lastSeal: makeLastSeal({ entries: ENTRIES.slice(0, 1) }) }));
  assertSigned(validInput({ lastSeal: makeLastSeal({ entries: [...ENTRIES] }) }));
});

test('IA-01 (b): pacote legado (como o export o produz) ⇒ SIGN_LEGACY_NOT_ATTESTABLE, inclusive com dossiê e aprovação válidos', () => {
  const allNotExecuted = Object.fromEntries(CHECK_IDS.map((id) => [id, 'NOT_EXECUTED'])) as Record<CheckId, CheckStatus>;
  const legacy = makePackage({ legacy: true, checks: allNotExecuted });
  assert.equal(legacy.attestable, false);
  const refusal = assertRefused(inputFor(legacy, makeApproval(legacy), { lastSeal: null }), 'SIGN_LEGACY_NOT_ATTESTABLE');
  assert.match(refusal.message, /legada não é atestável/);
});

test('IA-01 (c): pacote a assinar não é o aprovado ⇒ SIGN_PACKAGE_MISMATCH; decisão diferente de APPROVED ⇒ SIGN_APPROVAL_INVALID', () => {
  const pkg = makePackage();
  const otherApproved = makePackage({ checks: { REPORT_REPRODUCES: 'PASS' } });
  const refusal = assertRefused(inputFor(pkg, makeApproval(otherApproved)), 'SIGN_PACKAGE_MISMATCH');
  assert.match(refusal.message, /não é o aprovado/);
  for (const decision of ['REJECTED', 'approved', 'PENDING']) assertRefused(inputFor(pkg, { ...makeApproval(pkg), decision }), 'SIGN_APPROVAL_INVALID');
});

test('IA-01 (d): FAIL em verificação ⇒ SIGN_INTEGRITY_NOT_OK; integridade ≠ OK é recusada já no passo 1 (o esquema da W1 fixa "OK")', () => {
  const failing = makePackage({ checks: { HTTP_2XX_AND_COLLECTED_AT: 'FAIL' } });
  const refusal = assertRefused(inputFor(failing, makeApproval(failing)), 'SIGN_INTEGRITY_NOT_OK');
  assert.match(refusal.message, /HTTP_2XX_AND_COLLECTED_AT/);
  const broken = rawHashed({ ...packageBody(), integrity: { status: 'FAIL', algorithm: 'SHA-256', checkedFiles: ENTRIES.length } });
  assertRefused(inputFor(broken, makeApproval(broken)), 'SIGN_PACKAGE_INVALID');
});

/* --------------------------------------------------------------------------------------------------------------- IA-11 */

test('IA-11: entrada do pacote alterada sem refazer o hash ⇒ SIGN_PACKAGE_INVALID; refazendo o hash sem reaprovar ⇒ SIGN_PACKAGE_MISMATCH', () => {
  const pkg = makePackage();
  const approval = makeApproval(pkg);
  const tampered = structuredClone(pkg);
  tampered.entries[1] = { ...tampered.entries[1]!, contentSha256: h('f') };
  assertRefused(inputFor(tampered, approval), 'SIGN_PACKAGE_INVALID');
  assertRefused(inputFor({ ...tampered, packageSha256: computePackageSha256(tampered) }, approval), 'SIGN_PACKAGE_MISMATCH');
  const added = structuredClone(pkg);
  added.entries.push({ ref: 'report:c0002-r0002', contentSha256: h('e'), legacy: false });
  added.summary.reportRevisions = 3;
  added.integrity.checkedFiles = 5;
  assertRefused(inputFor({ ...added, packageSha256: computePackageSha256(added) }, approval), 'SIGN_PACKAGE_MISMATCH');
});

test('IA-11: campos fora do hash (generatedAt, delta) não mudam o pacote aprovado', () => {
  const pkg = makePackage();
  const moved = { ...pkg, generatedAt: '2026-11-18T15:00:00.000Z', delta: { added: ['capture:c0002'], changed: [], missing: [] } };
  assertSigned(inputFor(moved, makeApproval(pkg)));
});

test('passo 1: bytes do pacote/aprovação fora de forma (não JSON, BOM, UTF-8 inválido, não objeto, campo extra) ⇒ recusa sem abrir a chave', () => {
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
  for (const packageBytes of badPackages) assertRefused({ ...validInput(), packageBytes, approvalBytes: approval }, 'SIGN_PACKAGE_INVALID');
  for (const approvalBytes of [Buffer.from('{'), bytes({ ...makeApproval(pkg), extra: true }), bytes(null)]) assertRefused({ ...validInput(), approvalBytes }, 'SIGN_APPROVAL_INVALID');
});

test('entrada do núcleo: --audit fora do padrão ou --custodian fora de rótulo curto ⇒ USAGE, antes de ler qualquer coisa', () => {
  for (const auditId of ['', 'CURTO', '../auditoria-teste-0001', 'auditoria/teste-0001', 'Auditoria-Teste-0001']) assertRefused(validInput({ auditId }), 'USAGE');
  for (const custodian of ['', 'ana@exemplo.invalid', '11 91234-5678', 'a/b', 'x'.repeat(65)]) assertRefused(validInput({ custodian }), 'USAGE');
});

/* --------------------------------------------------------------------------------------------------------------- IA-06 (itens 2 e 3) */

test('IA-06 (2): --audit diferente do auditId do pacote ou da aprovação ⇒ SIGN_AUDIT_MISMATCH', () => {
  assertRefused(validInput({ auditId: OTHER_AUDIT }), 'SIGN_AUDIT_MISMATCH');
  const pkg = makePackage();
  assertRefused(inputFor(pkg, makeApproval(pkg, { auditId: OTHER_AUDIT })), 'SIGN_AUDIT_MISMATCH');
  const other = makePackage({ auditId: OTHER_AUDIT });
  assertRefused(inputFor(other, makeApproval(other)), 'SIGN_AUDIT_MISMATCH');
  assertRefused(inputFor(other, makeApproval(other, { auditId: OTHER_AUDIT })), 'SIGN_AUDIT_MISMATCH');
});

test('IA-06 (3): último manifesto (válido e assinado) de outra auditoria ⇒ SIGN_SEAL_CHAIN_INVALID', () => {
  assertRefused(validInput({ lastSeal: makeLastSeal({ auditId: OTHER_AUDIT }) }), 'SIGN_SEAL_CHAIN_INVALID');
});

test('IA-06 (3): último manifesto fora de forma (data, entradas vazias, ref ou hash inválidos) ⇒ SIGN_SEAL_CHAIN_INVALID', () => {
  const base: LastSealFacts = { auditId: AUDIT, sealedAt: LAST_SEALED_AT, entries: ENTRIES.slice(0, 3) };
  const malformed: LastSealFacts[] = [
    { ...base, sealedAt: '2026-11-18T12:00:00Z' },
    { ...base, sealedAt: 'ontem' },
    { ...base, entries: [] },
    { ...base, entries: [{ ref: 'site:c0001', contentSha256: h('a') }] },
    { ...base, entries: [{ ref: 'capture:c0001', contentSha256: 'A'.repeat(64) }] },
  ];
  assertSigned(validInput({ lastSeal: base }));
  for (const lastSeal of malformed) assertRefused(validInput({ lastSeal }), 'SIGN_SEAL_CHAIN_INVALID');
});

/* --------------------------------------------------------------------------------------------------------------- IA-17 (herdado) */

test('IA-17 (RS-02): FAIL em cada verificação mecânica ⇒ SIGN_INTEGRITY_NOT_OK, mesmo com resultado humano PASS na aprovação', () => {
  for (const id of MECHANICAL) {
    const pkg = makePackage({ checks: { [id]: 'FAIL' } });
    const refusal = assertRefused(inputFor(pkg, makeApproval(pkg)), 'SIGN_INTEGRITY_NOT_OK');
    assert.match(refusal.message, new RegExp(id));
  }
});

test('IA-17 (RS-02): FAIL numa verificação não mecanizável nunca chega ao sign (o esquema da W1 recusa) ⇒ SIGN_PACKAGE_INVALID', () => {
  for (const id of NON_MECHANICAL) {
    const body = packageBody();
    const broken = rawHashed({ ...body, checks: body.checks.map((check) => (check.id === id ? { ...check, status: 'FAIL' } : check)) });
    assertRefused(inputFor(broken, makeApproval(broken)), 'SIGN_PACKAGE_INVALID');
  }
});

test('IA-17 (RS-02): verificação mecânica que só o export executa em NOT_EXECUTED ⇒ SIGN_CHECK_NOT_EXECUTED (a aprovação não pode supri-la)', () => {
  for (const id of NOT_HUMAN) {
    const pkg = makePackage({ checks: { [id]: 'NOT_EXECUTED' } });
    const refusal = assertRefused(inputFor(pkg, makeApproval(pkg)), 'SIGN_CHECK_NOT_EXECUTED');
    assert.match(refusal.message, new RegExp(id));
  }
});

test('IA-17 (RS-02): NOT_EXECUTED sem resultado humano PASS com nota ⇒ SIGN_CHECK_NOT_EXECUTED (ausente, FAIL, nota vazia ou só espaços)', () => {
  const pkg = makePackage();
  for (const id of HUMAN) {
    const variants: Array<Approval['humanChecks']> = [
      makeApproval(pkg).humanChecks.filter((check) => check.id !== id),
      makeApproval(pkg).humanChecks.map((check) => (check.id === id ? { ...check, result: 'FAIL' as const } : check)),
      makeApproval(pkg).humanChecks.map((check) => (check.id === id ? { ...check, note: '' } : check)),
      makeApproval(pkg).humanChecks.map((check) => (check.id === id ? { ...check, note: '   ' } : check)),
    ];
    for (const humanChecks of variants) {
      const refusal = assertRefused(inputFor(pkg, makeApproval(pkg, { humanChecks })), 'SIGN_CHECK_NOT_EXECUTED');
      assert.match(refusal.message, new RegExp(id));
    }
  }
});

test('W4.1 (herdado da W1): resultado humano só é aceito para verificação que o pacote marca NOT_EXECUTED', () => {
  const pkg = makePackage({ checks: { REPORT_REPRODUCES: 'PASS' } });
  const refusal = assertRefused(inputFor(pkg, makeApproval(pkg)), 'SIGN_APPROVAL_INVALID');
  assert.match(refusal.message, /REPORT_REPRODUCES/);
  const failNote = makeApproval(pkg).humanChecks.map((check) => (check.id === 'REPORT_REPRODUCES' ? { ...check, result: 'FAIL' as const } : check));
  assertRefused(inputFor(pkg, makeApproval(pkg, { humanChecks: failNote })), 'SIGN_APPROVAL_INVALID');
  assertSigned(inputFor(pkg, makeApproval(pkg, { humanChecks: makeApproval(pkg).humanChecks.filter((check) => check.id !== 'REPORT_REPRODUCES') })));
});

/* --------------------------------------------------------------------------------------------------------------- dossiê (passo 6 e §5.5.1 item 3) */

test('passo 6: SHA-256 dos BYTES do dossiê ≠ approval.dossier.sha256 ⇒ SIGN_DOSSIER_MISMATCH', () => {
  assert.notEqual(sha256(DOSSIER), sha256Hex(DOSSIER.toString('utf8')), 'premissa: decodificar como texto mudaria o hash');
  assertRefused(validInput({ dossierBytes: Buffer.concat([DOSSIER, Buffer.from([0x0a])]) }), 'SIGN_DOSSIER_MISMATCH');
  assertRefused(validInput({ dossierBytes: new Uint8Array(0) }), 'SIGN_DOSSIER_MISMATCH');
  const pkg = makePackage();
  assertRefused(inputFor(pkg, makeApproval(pkg, { dossier: { id: 'dossie-2026-0001', sha256: h('9') } })), 'SIGN_DOSSIER_MISMATCH');
});

test('W4.1 (herdado da W1, §5.5.1 item 3): approval.dossier.id segue o padrão do contrato v2; tudo o que a aprovação aceita o manifesto v2 aceita', () => {
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

test('passo 9 (RS-01): conferente = custodiante sem aceite formal ⇒ SIGN_ROLE_SEPARATION, inclusive com caixa, separadores ou largura diferentes', () => {
  for (const custodian of ['CONF-01', 'conf-01', 'CONF 01', 'Conf.01', 'conf_01', 'ＣＯＮＦ-01']) {
    const refusal = assertRefused(validInput({ custodian }), 'SIGN_ROLE_SEPARATION');
    assert.match(refusal.message, /sem aceite formal de risco/);
  }
});

test('passo 9 (RS-01): com aceite formal ⇒ prossegue com roleException e requiresLaterReview; operador = conferente só marca revisão', () => {
  const pkg = makePackage();
  const accepted = assertSigned(inputFor(pkg, makeApproval(pkg, { riskAcceptance: { id: 'aceite-0001', sha256: h('8') } }), { custodian: 'CONF-01' }));
  assert.deepEqual([accepted.roleException, accepted.requiresLaterReview], [true, true]);
  const sameOperator = assertSigned(inputFor(pkg, makeApproval(pkg, { operator: 'conf 01' })));
  assert.deepEqual([sameOperator.roleException, sameOperator.requiresLaterReview], [false, true]);
  const acceptedButDistinct = assertSigned(inputFor(pkg, makeApproval(pkg, { riskAcceptance: { id: 'aceite-0001', sha256: h('8') } })));
  assert.deepEqual([acceptedButDistinct.roleException, acceptedButDistinct.requiresLaterReview], [false, false]);
});

/* --------------------------------------------------------------------------------------------------------------- passo 10 */

test('passo 10: relógio antes do último manifesto ou da última coleta ⇒ SIGN_CLOCK_REGRESSION; instante igual é aceito', () => {
  assertRefused(validInput(), 'SIGN_CLOCK_REGRESSION', '2026-11-18T11:59:59.999Z');
  assert.equal(assertSigned(validInput(), LAST_SEALED_AT).sealedAt, LAST_SEALED_AT);
  assertRefused(validInput({ lastSeal: null }), 'SIGN_CLOCK_REGRESSION', '2026-11-18T09:59:59.999Z');
  assert.equal(assertSigned(validInput({ lastSeal: null }), LAST_COLLECTED_AT).sealedAt, LAST_COLLECTED_AT);
  assertRefused(validInput({ lastSeal: makeLastSeal({ sealedAt: '2026-11-18T08:00:00.000Z' }) }), 'SIGN_CLOCK_REGRESSION', '2026-11-18T09:30:00.000Z');
});

test('passo 10: relógio inválido ou fora do formato do manifesto ⇒ UNEXPECTED, sem abrir a chave', () => {
  assertRefused(validInput(), 'UNEXPECTED', 'não é data');
  assertRefused(validInput(), 'UNEXPECTED', '+010000-01-01T00:00:00.000Z');
});

/* --------------------------------------------------------------------------------------------------------------- ordem do §5.5 */

type Fault = 'PACKAGE_SCHEMA' | 'APPROVAL_SCHEMA' | 'AUDIT' | 'PACKAGE_HASH' | 'NOT_APPROVED' | 'CHECK_FAIL' | 'LEGACY' | 'HUMAN_MISSING' | 'HUMAN_EXTRA' | 'DOSSIER' | 'CHAIN_AUDIT' | 'EVIDENCE_CHANGED' | 'ROLE' | 'CLOCK';
/** Falhas na ordem do §5.5 (1, 1, 1, 2, 3, 4a, 4/5, 4b, 4b, 6, 7*, 8, 9, 10); 7* = guarda mínima do último manifesto (a cadeia é da W4.2). */
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
];

function build(faults: ReadonlySet<Fault>): { readonly input: SignCoreInput; readonly now: string } {
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
  return { input, now: has('CLOCK') ? '2026-11-18T11:00:00.000Z' : NOW };
}

test('IA-01 ordem do §5.5: com TODAS as falhas juntas, corrigir uma por vez revela as recusas exatamente nesta ordem; a chave só no fim', () => {
  for (let rung = 0; rung <= LADDER.length; rung += 1) {
    const { input, now } = build(new Set(LADDER.slice(rung).map(([fault]) => fault)));
    const { result, keyCalls } = run(input, now);
    assert.equal(result.ok ? 'OK' : result.code, LADDER[rung]?.[1] ?? 'OK', `degrau ${rung} (${LADDER[rung]?.[0] ?? 'nenhuma falha'})`);
    assert.equal(keyCalls, rung < LADDER.length ? 0 : 1, `degrau ${rung}: chave`);
  }
});

test('IA-01: cada falha sozinha dá o seu código, com o leitor de chave em 0 chamadas', () => {
  for (const [fault, code] of LADDER) {
    const { input, now } = build(new Set([fault]));
    assertRefused(input, code, now);
  }
});
