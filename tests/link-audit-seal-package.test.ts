import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalSchema, candidatePackageSchema, computePackageSha256, isPackageHashConsistent, PackageHashError, type Approval, type CandidatePackage } from '../src/lib/link-audit-attestation';
import { canonicalJson, sha256Hex } from '../src/lib/link-audit/canonical';

/* Dados 100% FICTÍCIOS. */
const h = (c: string): string => c.repeat(64);
const AUDIT = 'auditoria-teste-0001';
const AT = '2026-10-22T12:54:48.079Z';

const fullChecks = (): CandidatePackage['checks'] => [
  { id: 'INTEGRITY_LOCAL', status: 'PASS' },
  { id: 'COLLECTOR_HASH_MATCHES', status: 'PASS' },
  { id: 'COLLECTION_GAP_WITHIN_LIMIT', status: 'PASS' },
  { id: 'HTTP_2XX_AND_COLLECTED_AT', status: 'NOT_EXECUTED' },
  { id: 'REPORT_REPRODUCES', status: 'NOT_EXECUTED' },
  { id: 'AUTHORIZATION_CONSUMED', status: 'NOT_EXECUTED' },
  { id: 'PROVIDER_PANEL_CREDITS', status: 'NOT_EXECUTED' },
  { id: 'URL_QUERY_COHERENCE', status: 'NOT_EXECUTED' },
];

function basePackage(): CandidatePackage {
  const pkg: CandidatePackage = {
    schemaVersion: 1,
    kind: 'LINK_AUDIT_P1_CANDIDATE',
    auditId: AUDIT,
    layout: 'VERSIONED',
    attestable: true,
    summary: { company: { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' }, firstCollectedAt: AT, lastCollectedAt: AT, captures: 1, reportRevisions: 2, artifacts: 0, containsLegacy: false },
    integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles: 6 },
    checks: fullChecks(),
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
const rawBodyHash = (p: CandidatePackage): string => {
  const { delta: _d, packageSha256: _p, generatedAt: _g, ...body } = p;
  return sha256Hex(canonicalJson(body));
};
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
    ['verificação (outra)', (p) => ({ ...p, checks: p.checks.map((c) => (c.id === 'HTTP_2XX_AND_COLLECTED_AT' ? { ...c, status: 'PASS' as const } : c)) })],
    ['layout', (p) => ({ ...p, layout: 'LEGACY' })],
    ['attestable', (p) => ({ ...p, attestable: false })],
    ['kind', (p) => ({ ...p, kind: 'LINK_AUDIT_P1_OTHER' as never })],
    ['schemaVersion', (p) => ({ ...p, schemaVersion: 2 as never })],
    ['maxHours', (p) => ({ ...p, gap: p.gap && { ...p.gap, maxHours: 48 } })],
    ['observedHours', (p) => ({ ...p, gap: p.gap && { ...p.gap, observedHours: 3 } })],
    ['entries[].legacy', (p) => ({ ...p, entries: p.entries.map((e, i) => (i === 1 ? { ...e, legacy: true } : e)) })],
    ['integrity.algorithm', (p) => ({ ...p, integrity: { ...p.integrity, algorithm: 'SHA-512' as never } })],
    ['firstCollectedAt', (p) => ({ ...p, summary: { ...p.summary, firstCollectedAt: '2026-10-22T12:00:00.000Z' } })],
    ['integridade', (p) => ({ ...p, integrity: { ...p.integrity, checkedFiles: 7 } })],
    ['intervalo', (p) => ({ ...p, gap: p.gap && { ...p.gap, justification: 'chuva' } })],
    ['auditId', (p) => ({ ...p, auditId: 'auditoria-teste-0002' })],
  ];
  const seen = new Set<string>([original]);
  for (const [label, fn] of variants) {
    const hash = rawBodyHash(mutate(fn));
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

/* ---------------------------------------------------------------- revisão independente (M1, M2, M3, M4, m1, m2, m3) */
const badPkg = (pkg: unknown): boolean => !candidatePackageSchema.safeParse(pkg).success;

test('M1: coerências cruzadas do pacote (atestável exige gap; LEGACY ⇔ containsLegacy; datas em ordem; verificações obrigatórias uma vez)', () => {
  assert.ok(badPkg(mutate((p) => ({ ...p, gap: null }))), 'atestável sem gap');
  assert.ok(badPkg(mutate((p) => ({ ...p, layout: 'LEGACY' }))), 'LEGACY sem containsLegacy');
  const legacyBody = (p: CandidatePackage, layout: 'VERSIONED' | 'LEGACY'): CandidatePackage => ({ ...p, layout, attestable: false, gap: null, entries: [{ ref: 'capture:c0001', contentSha256: h('a'), legacy: true }], summary: { ...p.summary, captures: 1, reportRevisions: 0, artifacts: 0, containsLegacy: true } });
  assert.ok(candidatePackageSchema.safeParse(legacyBody(basePackage(), 'LEGACY')).success);
  assert.ok(badPkg(legacyBody(basePackage(), 'VERSIONED')), 'containsLegacy com layout VERSIONED');
  assert.ok(badPkg(mutate((p) => ({ ...p, summary: { ...p.summary, firstCollectedAt: '2026-10-23T00:00:00.000Z' } }))), 'primeira depois da última');
  for (const id of ['INTEGRITY_LOCAL', 'COLLECTOR_HASH_MATCHES', 'COLLECTION_GAP_WITHIN_LIMIT', 'HTTP_2XX_AND_COLLECTED_AT', 'REPORT_REPRODUCES', 'AUTHORIZATION_CONSUMED', 'PROVIDER_PANEL_CREDITS', 'URL_QUERY_COHERENCE']) {
    assert.ok(badPkg(mutate((p) => ({ ...p, checks: p.checks.filter((c) => c.id !== id) }))), `falta ${id}`);
  }
  for (const id of ['AUTHORIZATION_CONSUMED', 'PROVIDER_PANEL_CREDITS', 'URL_QUERY_COHERENCE']) {
    assert.ok(badPkg(mutate((p) => ({ ...p, checks: p.checks.map((c) => (c.id === id ? { ...c, status: 'PASS' as const } : c)) }))), `${id} nunca é mecanizável`);
  }
});

test('M2: hash consistente implica corpo válido (o hash recusa ordem, repetição, contagem e legado incoerentes)', () => {
  const bodies: CandidatePackage[] = [
    mutate((p) => ({ ...p, entries: [...p.entries].reverse() })),
    mutate((p) => ({ ...p, entries: [p.entries[0]!, p.entries[0]!, ...p.entries.slice(1)], summary: { ...p.summary, captures: 2 } })),
    mutate((p) => ({ ...p, summary: { ...p.summary, captures: 5 } })),
    mutate((p) => ({ ...p, entries: [{ ...p.entries[0]!, legacy: true }, ...p.entries.slice(1)] })),
    mutate((p) => ({ ...p, gap: null })),
  ];
  for (const body of bodies) {
    assert.throws(() => computePackageSha256(body), PackageHashError);
    assert.equal(isPackageHashConsistent({ ...body, packageSha256: rawBodyHash(body) }), false);
  }
});

test('M3: texto livre e rótulos sem e-mail (inclusive largura total), telefone, controle ou bidi; identificador curto por lista de permissão', () => {
  const bad = (over: Record<string, unknown>): boolean => !approvalSchema.safeParse({ ...approval(), ...over }).success;
  const good = (over: Record<string, unknown>): boolean => approvalSchema.safeParse({ ...approval(), ...over }).success;
  const pii = ['ana@x.com', 'ana＠x.com', '11 91234-5678', '(11) 91234.5678', '１１９１２３４５６７８', 'a\u202Eb', 'a\u0000b', 'a\u200Bb'];
  for (const value of pii) {
    assert.ok(bad({ approvedBy: value }), `approvedBy ${value}`);
    assert.ok(bad({ operator: value }), `operator ${value}`);
    assert.ok(bad({ dossier: { id: value, sha256: h('9') } }), `dossier.id ${value}`);
    assert.ok(bad({ riskAcceptance: { id: value, sha256: h('8') } }), `riskAcceptance.id ${value}`);
    assert.ok(bad({ humanChecks: [{ id: 'AUTHORIZATION_CONSUMED', result: 'PASS', note: value }] }), `note ${value}`);
    assert.ok(badPkg(mutate((p) => ({ ...p, gap: p.gap && { ...p.gap, justification: value } }))), `gap.justification ${value}`);
  }
  assert.ok(good({ approvedBy: 'OP-20261023' }), '8 dígitos é aceito');
  assert.ok(good({ operator: 'José D.' }));
  assert.ok(bad({ approvedBy: 'OP-202610231' }), '9 dígitos');
  assert.ok(bad({ approvedBy: 'a/b' }), 'fora da lista de permissão');
  assert.ok(good({ humanChecks: [{ id: 'AUTHORIZATION_CONSUMED', result: 'PASS', note: 'Conferido no painel, ok.' }] }));
});

test('M4: humanChecks sem id repetido, só ids não mecanizáveis (e REPORT_REPRODUCES), no máximo 4', () => {
  const bad = (humanChecks: unknown): boolean => !approvalSchema.safeParse({ ...approval(), humanChecks }).success;
  const hc = (id: string) => ({ id, result: 'PASS', note: '' });
  assert.ok(bad([hc('AUTHORIZATION_CONSUMED'), hc('AUTHORIZATION_CONSUMED')]));
  for (const id of ['INTEGRITY_LOCAL', 'COLLECTOR_HASH_MATCHES', 'COLLECTION_GAP_WITHIN_LIMIT', 'HTTP_2XX_AND_COLLECTED_AT']) assert.ok(bad([hc(id)]), id);
  assert.ok(approvalSchema.safeParse({ ...approval(), humanChecks: ['AUTHORIZATION_CONSUMED', 'PROVIDER_PANEL_CREDITS', 'URL_QUERY_COHERENCE', 'REPORT_REPRODUCES'].map(hc) }).success);
  assert.ok(bad([...['AUTHORIZATION_CONSUMED', 'PROVIDER_PANEL_CREDITS', 'URL_QUERY_COHERENCE', 'REPORT_REPRODUCES'].map(hc), hc('REPORT_REPRODUCES')]));
});

test('m1/m2: observedHours inteiro; delta limitado; nome/cidade sem controle nem bidi', () => {
  assert.ok(badPkg(mutate((p) => ({ ...p, gap: p.gap && { ...p.gap, observedHours: 1.5 } }))));
  const refs = Array.from({ length: 2001 }, (_, i) => `capture:c${String(i + 1).padStart(4, '0')}`);
  assert.ok(badPkg(mutate((p) => ({ ...p, delta: { added: refs, changed: [], missing: [] } }))));
  for (const value of ['Pad\u202Earia', 'Pad\u0007aria', 'Pad\u200Baria']) {
    assert.ok(badPkg(mutate((p) => ({ ...p, summary: { ...p.summary, company: { ...p.summary.company, name: value } } }))), `name ${value}`);
    assert.ok(badPkg(mutate((p) => ({ ...p, summary: { ...p.summary, company: { ...p.summary.company, city: value } } }))), `city ${value}`);
  }
});

/** VETOR-OURO: o hash esperado é literal. Se `canonicalJson` ou o corpo mudarem, hashes já aprovados se moveriam: este teste tem de falhar. */
const GOLDEN_SHA256 = '4194569139930c19913885f23a32f8a3c9f2c834150f84f52c066b04f83c105c';
test('m3 GOLDEN: corpo fixo ⇒ packageSha256 literal; o mesmo corpo com strings em NFD dá o mesmo hash', () => {
  const body = basePackage();
  assert.equal(body.packageSha256, GOLDEN_SHA256);
  const nfd = (value: string): string => value.normalize('NFD');
  const decomposed = mutate((p) => ({ ...p, summary: { ...p.summary, company: { name: nfd('Padaria Exemplo São João'), city: nfd('Goiânia'), stateCode: 'GO' } } }));
  const composed = mutate((p) => ({ ...p, summary: { ...p.summary, company: { name: 'Padaria Exemplo São João', city: 'Goiânia', stateCode: 'GO' } } }));
  assert.notEqual(decomposed.summary.company.name, composed.summary.company.name);
  assert.equal(computePackageSha256(decomposed), computePackageSha256(composed));
  assert.equal(computePackageSha256(composed), GOLDEN_COMPOSED_SHA256);
});
const GOLDEN_COMPOSED_SHA256 = 'dc236479f8614a58786ccf6eff1c99765cf31073e06add9cbc6c1a9cd00285d3';
