import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalSchema, candidatePackageSchema, computePackageSha256, isPackageHashConsistent, PackageHashError, type Approval, type CandidatePackage } from '../src/lib/link-audit-attestation';
import { canonicalJson, sha256Hex } from '../src/lib/link-audit/canonical';

/* Dados 100% FICTÍCIOS. */
const h = (c: string): string => c.repeat(64);
const AUDIT = 'auditoria-teste-0001';
const AT = '2026-10-22T12:54:48.079Z';

function basePackage(): CandidatePackage {
  const pkg: CandidatePackage = {
    schemaVersion: 1,
    kind: 'LINK_AUDIT_P1_CANDIDATE',
    auditId: AUDIT,
    layout: 'VERSIONED',
    attestable: true,
    summary: { company: { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' }, firstCollectedAt: AT, lastCollectedAt: AT, captures: 1, reportRevisions: 2, artifacts: 0, containsLegacy: false },
    integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles: 6 },
    checks: [{ id: 'INTEGRITY_LOCAL', status: 'PASS' }, { id: 'REPORT_REPRODUCES', status: 'NOT_EXECUTED' }],
    gap: { maxHours: 24, observedHours: 2, justification: null },
    entries: [
      { ref: 'capture:c0001', contentSha256: h('a'), legacy: false },
      { ref: 'report:c0001-r0001', contentSha256: h('b'), legacy: false },
      { ref: 'report:c0001-r0002', contentSha256: h('c'), legacy: false },
    ],
    delta: null,
    packageSha256: h('0'),
    generatedAt: '2026-10-23T10:00:00.000Z',
  };
  return { ...pkg, packageSha256: computePackageSha256(pkg) };
}
const mutate = (fn: (p: CandidatePackage) => CandidatePackage): CandidatePackage => fn(structuredClone(basePackage()));
const rehash = (p: CandidatePackage): CandidatePackage => ({ ...p, packageSha256: computePackageSha256(p) });

test('pacote válido passa no esquema estrito e o hash declarado confere', () => {
  const pkg = basePackage();
  assert.ok(candidatePackageSchema.safeParse(pkg).success);
  assert.ok(isPackageHashConsistent(pkg));
  assert.match(pkg.packageSha256, /^[0-9a-f]{64}$/);
});

test('IA-10: mesmo conjunto e mesmos argumentos ⇒ mesmo packageSha256 (independe da ordem das chaves, de generatedAt e de delta)', () => {
  const pkg = basePackage();
  const reordered = JSON.parse(JSON.stringify({ entries: pkg.entries, gap: pkg.gap, checks: pkg.checks, integrity: pkg.integrity, summary: pkg.summary, attestable: pkg.attestable, layout: pkg.layout, auditId: pkg.auditId, kind: pkg.kind, schemaVersion: pkg.schemaVersion })) as unknown;
  assert.equal(computePackageSha256(reordered), pkg.packageSha256);
  assert.equal(computePackageSha256({ ...pkg, generatedAt: '2030-01-01T00:00:00.000Z' }), pkg.packageSha256);
  assert.equal(computePackageSha256({ ...pkg, delta: { added: ['capture:c0009'], changed: [], missing: [] } }), pkg.packageSha256);
  const { delta: _d, packageSha256: _p, generatedAt: _g, ...body } = pkg;
  assert.equal(pkg.packageSha256, sha256Hex(canonicalJson(body)), 'é o SHA-256 do JSON canônico do corpo (spec §5.3)');
});

test('IA-10: qualquer mudança em ref, hash, resumo ou verificação muda o hash', () => {
  const original = basePackage().packageSha256;
  const variants: Array<[string, (p: CandidatePackage) => CandidatePackage]> = [
    ['ref', (p) => ({ ...p, entries: p.entries.map((e, i) => (i === 2 ? { ...e, ref: 'report:c0001-r0003' } : e)) })],
    ['contentSha256', (p) => ({ ...p, entries: p.entries.map((e, i) => (i === 0 ? { ...e, contentSha256: h('f') } : e)) })],
    ['entrada a menos', (p) => ({ ...p, entries: p.entries.slice(0, 2), summary: { ...p.summary, reportRevisions: 1 } })],
    ['resumo (empresa)', (p) => ({ ...p, summary: { ...p.summary, company: { ...p.summary.company, city: 'Outra Cidade' } } })],
    ['resumo (data)', (p) => ({ ...p, summary: { ...p.summary, lastCollectedAt: '2026-10-22T13:00:00.000Z' } })],
    ['verificação (status)', (p) => ({ ...p, checks: [{ id: 'INTEGRITY_LOCAL', status: 'FAIL' }, ...p.checks.slice(1)] })],
    ['verificação (a mais)', (p) => ({ ...p, checks: [...p.checks, { id: 'URL_QUERY_COHERENCE', status: 'NOT_EXECUTED' }] })],
    ['integridade', (p) => ({ ...p, integrity: { ...p.integrity, checkedFiles: 7 } })],
    ['intervalo', (p) => ({ ...p, gap: p.gap && { ...p.gap, justification: 'chuva' } })],
    ['auditId', (p) => ({ ...p, auditId: 'auditoria-teste-0002' })],
  ];
  const seen = new Set<string>([original]);
  for (const [label, fn] of variants) {
    const hash = computePackageSha256(mutate(fn));
    assert.ok(!seen.has(hash), `${label} não mudou o hash`);
    seen.add(hash);
  }
});

test('hash declarado que não confere com o corpo é detectado (adulteração depois do hash)', () => {
  const tampered = mutate((p) => ({ ...p, entries: p.entries.map((e, i) => (i === 0 ? { ...e, contentSha256: h('f') } : e)) }));
  assert.equal(isPackageHashConsistent(tampered), false);
  assert.equal(isPackageHashConsistent(rehash(tampered)), true);
});

test('o hash recusa corpo fora de forma ou com campo extra (nunca ignora em silêncio)', () => {
  assert.throws(() => computePackageSha256({ ...basePackage(), extra: 1 }), PackageHashError);
  assert.throws(() => computePackageSha256(null), PackageHashError);
  assert.throws(() => computePackageSha256({ ...basePackage(), entries: [] }), PackageHashError);
});

test('esquema do pacote: estrito e com as coerências da spec (ordem, repetição, legado, contagens, tamanho)', () => {
  const bad = (pkg: unknown): boolean => !candidatePackageSchema.safeParse(pkg).success;
  assert.ok(bad({ ...basePackage(), extra: true }));
  assert.ok(bad({ ...basePackage(), kind: 'OUTRO' }));
  assert.ok(bad({ ...basePackage(), schemaVersion: 2 }));
  assert.ok(bad({ ...basePackage(), packageSha256: 'abc' }));
  assert.ok(bad({ ...basePackage(), generatedAt: 'ontem' }));
  assert.ok(bad(mutate((p) => ({ ...p, entries: [...p.entries].reverse() }))), 'fora de ordem');
  assert.ok(bad(mutate((p) => ({ ...p, entries: [p.entries[0]!, p.entries[0]!, ...p.entries.slice(1)], summary: { ...p.summary, captures: 2 } }))), 'repetida');
  assert.ok(bad(mutate((p) => ({ ...p, entries: [{ ...p.entries[0]!, legacy: true }, ...p.entries.slice(1)] }))), 'legado sem containsLegacy');
  assert.ok(bad(mutate((p) => ({ ...p, summary: { ...p.summary, captures: 5 } }))), 'contagem');
  assert.ok(bad(mutate((p) => ({ ...p, checks: [...p.checks, p.checks[0]!] }))), 'verificação repetida');
  assert.ok(bad(mutate((p) => ({ ...p, checks: [{ id: 'INVENTADA' as never, status: 'PASS' }] }))));
  assert.ok(bad(mutate((p) => ({ ...p, summary: { ...p.summary, company: { ...p.summary.company, stateCode: 'goiás' } } }))));
  const many = Array.from({ length: 2001 }, (_, i) => ({ ref: `capture:c${String(i + 1).padStart(4, '0')}`, contentSha256: h('a'), legacy: false }));
  assert.ok(bad(mutate((p) => ({ ...p, entries: many, summary: { ...p.summary, captures: 2001, reportRevisions: 0 } }))), 'mais de 2000');
});

test('esquema do pacote: legado só é válido como NÃO atestável; empresa desconhecida é null (NOT_VERIFIED), nunca inventada', () => {
  const legacy = mutate((p) => ({
    ...p,
    layout: 'LEGACY',
    attestable: false,
    gap: null,
    entries: [{ ref: 'capture:c0001', contentSha256: h('a'), legacy: true }, { ref: 'legacy-status:c0001', contentSha256: h('d'), legacy: true }],
    summary: { ...p.summary, company: { name: null, city: null, stateCode: null }, captures: 1, reportRevisions: 0, artifacts: 1, containsLegacy: true },
  }));
  assert.ok(candidatePackageSchema.safeParse(rehash(legacy)).success);
  assert.ok(!candidatePackageSchema.safeParse({ ...rehash(legacy), attestable: true }).success);
});

const approval = (): Approval => ({
  schemaVersion: 1,
  kind: 'LINK_AUDIT_P1_APPROVAL',
  auditId: AUDIT,
  packageSha256: basePackage().packageSha256,
  decision: 'APPROVED',
  approvedBy: 'AB',
  operator: 'CD',
  approvedAt: '2026-10-23T11:00:00.000Z',
  dossier: { id: 'dossie-0001', sha256: h('9') },
  humanChecks: [{ id: 'AUTHORIZATION_CONSUMED', result: 'PASS', note: 'conferido no painel' }],
  riskAcceptance: null,
});

test('esquema da aprovação: válido passa; estrito; só APPROVED; rótulos sem e-mail nem telefone; hashes hex64', () => {
  assert.ok(approvalSchema.safeParse(approval()).success);
  const bad = (over: Record<string, unknown>): boolean => !approvalSchema.safeParse({ ...approval(), ...over }).success;
  assert.ok(bad({ extra: 1 }));
  for (const decision of ['REJECTED', 'approved', 'PENDING', '']) assert.ok(bad({ decision }), decision);
  assert.ok(bad({ approvedBy: 'ana@empresa.com' }));
  assert.ok(bad({ operator: '11 91234-5678' }));
  assert.ok(bad({ approvedBy: '' }));
  assert.ok(bad({ packageSha256: 'xyz' }));
  assert.ok(bad({ dossier: { id: 'd', sha256: 'curto' } }));
  assert.ok(bad({ dossier: { id: 'd', sha256: h('9'), extra: 1 } }));
  assert.ok(bad({ humanChecks: [{ id: 'INVENTADA', result: 'PASS', note: '' }] }));
  assert.ok(bad({ auditId: 'CURTO' }));
  assert.ok(approvalSchema.safeParse({ ...approval(), riskAcceptance: { id: 'aceite-1', sha256: h('8') } }).success);
});
