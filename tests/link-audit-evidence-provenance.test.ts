import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildReportFromCapture } from '../src/lib/link-audit/collector/capture-report';
import { nodeFsOps, type FsOps } from '../src/lib/link-audit/snapshot-store';
import {
  CLOSED_EVIDENCE_PROVENANCE,
  createEvidenceSeal,
  createSealedEvidenceProvenance,
  evidenceProvenanceFromConfig,
  isWeakEd25519PublicKey,
  parseTrustKeys,
  publicKeyFromRaw,
  type EvidenceProvenancePolicy,
  type EvidenceToProve,
} from '../src/lib/link-audit-evidence/provenance';
import { sealed, writeCapture, writeReport, writeSiteObservation } from '../src/lib/link-audit-evidence/store';
import { reportName } from '../src/lib/link-audit-evidence/types';
import { createScoringPreviewService } from '../src/lib/link-audit-scoring-runs';
import { createScoringBasisReader } from '../src/lib/link-audit-evidence/scoring-basis';
import { identityFor, inputFor, LINK, T_NOW } from './helpers/link-audit-collect-fixtures';
import { AUDIT as LEGACY_AUDIT } from './helpers/link-audit-evidence-fixtures';
import { legacyReplica } from './helpers/link-audit-mapper-real-basis';
import { fakeList } from './helpers/link-audit-preview-fixtures';
import { ANA, clock, must, registerCleanup, rec, tmpDir, world, type World } from './helpers/link-audit-decisions-fixtures';
import { bodyText, captureInput, errno, faulty } from './helpers/link-audit-evidence-fixtures';
import { evidenceKeys, sealAuditForTests, sealAuditV2ForTests, TRUSTING_EVIDENCE_POLICY, writeSealFile } from './helpers/link-audit-evidence-provenance-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { makeService, OP_A, OP_B, resultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * PROVENIÊNCIA DAS EVIDÊNCIAS (2ª revisão independente, R2-MINOR-1; decisão do responsável): quem escreve SÓ na pasta de evidências, com o próprio
 * pipeline de gravação (selo SHA-256 refeito, integridade "OK"), NÃO pode fabricar fatos que o sistema trate como autênticos. Integridade do
 * arquivo ≠ autenticidade da evidência: só um manifesto assinado por chave de confiança, guardado FORA da pasta de evidências, autentica.
 * R2.1: os cenários em que a coleta legítima precisa ser FINALIZÁVEL atestam com manifesto v2 (`sealAuditV2ForTests`); a resposta do caminho v1 (só `{status}`, sem a cabeça
 * que o resultado grava) deixou de ser finalizável (`SEAL_VERSION_NOT_ALLOWED`, ver `link-audit-results-provenance.test.ts`). Os testes do caminho v1 do verificador não mudaram.
 */
registerCleanup();

const FORGED = { title: 'Padaria FORJADA pelo invasor', phoneNumber: '(11) 90000-1234', address: 'Avenida Inventada, 999 - Outra Cidade - SP' };

/** O MESMO pipeline do coletor, sem chave nenhuma: grava captura + site + relatório com o corpo que o invasor quiser (integridade OK). */
async function appendForgedCapture(w: World, collectedAt: string): Promise<number> {
  const text = bodyText(FORGED);
  const cap = await writeCapture(w.evidenceDir, captureInput({ auditId: w.auditId, body: text, collectedAt }));
  assert.ok(cap.ok, JSON.stringify(cap));
  const outcome = {
    requestedUrl: 'https://www.padaria-exemplo.example/', finalUrl: null, status: 'HTTP_ERROR', httpStatus: 403, redirects: [], checkedAt: collectedAt, title: null, noindex: null, robotsTxt: 'UNKNOWN', localBusiness: null, telLinks: [], whatsappLinks: [],
    emailLinks: [], failureReason: 'O site respondeu HTTP 403.', access: { requests: 1, authChallenge: false, loginPathBlocked: false, requestLimitReached: false, timeLimitReached: false, botChallenge: false },
  };
  assert.ok((await writeSiteObservation(w.evidenceDir, w.auditId, cap.value.captureNumber, outcome as never, collectedAt)).ok);
  const built = await buildReportFromCapture({
    rawBody: text, body: { name: `c000${cap.value.captureNumber}.capture.json`, sha256: cap.value.contentSha256, bytes: Buffer.byteLength(text) }, otherFiles: [], httpStatus: 200, httpAttempts: 1, collectedAt,
    input: inputFor(identityFor(LINK, { name: 'Padaria Exemplo', city: 'Cidade Exemplo', stateCode: 'GO' }), 'snap-exemplo-0001'), site: null, siteOutcome: outcome as never, generatedAt: T_NOW,
  } as never);
  assert.ok(built.ok, JSON.stringify(built).slice(0, 200));
  assert.ok((await writeReport(w.evidenceDir, w.auditId, cap.value.captureNumber, JSON.parse(JSON.stringify(built.report)) as Record<string, unknown>, T_NOW)).ok);
  return cap.value.captureNumber;
}

const receiptsFail = (anchorDir: string): FsOps =>
  faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(anchorDir)) throw errno('ENOSPC');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });

const policyFor = (sealsDir: string, keys = evidenceKeys()): { policy: EvidenceProvenancePolicy; keys: ReturnType<typeof evidenceKeys> } => ({
  policy: createSealedEvidenceProvenance({ sealsDir, trustedKeys: parseTrustKeys(keys.trustKeys) as never }),
  keys,
});

const SAMPLE: EvidenceToProve[] = [
  { ref: 'capture:c0001', contentSha256: 'a'.repeat(64), legacy: false },
  { ref: 'report:c0001-r0001', contentSha256: 'b'.repeat(64), legacy: false },
];
const sealOf = (keys: ReturnType<typeof evidenceKeys>, over: Partial<Parameters<typeof createEvidenceSeal>[0]> = {}) =>
  createEvidenceSeal({ auditId: 'auditoria-prova-01', seq: 1, sealedAt: '2026-10-30T12:00:00.000Z', keyId: keys.keyId, privateKey: keys.privateKey, entries: SAMPLE, ...over });
const AUD = 'auditoria-prova-01';

/* ------------------------------------------------------------------------------------------------ política fechada e configuração */

test('sem prova configurada a política é FECHADA: nada é autêntico (não existe valor que "confie em tudo")', async () => {
  assert.deepEqual(await CLOSED_EVIDENCE_PROVENANCE.classify(AUD, SAMPLE), { status: 'UNAUTHENTICATED', reason: 'PROOF_NOT_CONFIGURED' });
  const keys = evidenceKeys();
  const dir = tmpDir('lep-');
  for (const config of [
    { sealsDir: null, trustKeys: keys.trustKeys },
    { sealsDir: dir, trustKeys: undefined },
    { sealsDir: dir, trustKeys: '' },
    { sealsDir: dir, trustKeys: 'curta' },
    { sealsDir: dir, trustKeys: `${keys.keyId}:${keys.publicRaw},${keys.keyId}:${keys.publicRaw}` }, // id repetido
    { sealsDir: dir, trustKeys: `${keys.keyId}:${keys.publicRaw},ruim` }, // um item ruim invalida tudo
    { sealsDir: dir, trustKeys: `${keys.keyId}:${keys.publicRaw.slice(1)}` },
    { sealsDir: dir, trustKeys: `OK-MAIUSCULO:${keys.publicRaw}` },
  ]) assert.equal((await evidenceProvenanceFromConfig(config).classify(AUD, SAMPLE)).status, 'UNAUTHENTICATED', JSON.stringify(config).slice(0, 60));
  // a pasta de manifestos não pode ser a de evidências nem estar aninhada nela (nem o contrário): a política fica FECHADA
  const evidence = tmpDir('lep-ev-');
  fs.mkdirSync(path.join(evidence, AUD), { recursive: true });
  const nested = path.join(evidence, 'seals');
  fs.mkdirSync(nested);
  writeSealFile(nested, AUD, 1, sealOf(keys));
  for (const [sealsDir, evidenceDir] of [[evidence, evidence], [nested, evidence], [evidence, nested]] as const) {
    assert.deepEqual(await evidenceProvenanceFromConfig({ sealsDir, trustKeys: keys.trustKeys, otherDirs: [evidenceDir] }).classify(AUD, SAMPLE), { status: 'UNAUTHENTICATED', reason: 'PROOF_NOT_CONFIGURED' }, `${sealsDir} × ${evidenceDir}`);
  }
  assert.equal((await evidenceProvenanceFromConfig({ sealsDir: nested, trustKeys: keys.trustKeys, otherDirs: [tmpDir('lep-outra-')] }).classify(AUD, SAMPLE)).status, 'AUTHENTICATED', 'pastas separadas funcionam');
  assert.equal(publicKeyFromRaw(keys.publicRaw) !== null, true);
  assert.equal(publicKeyFromRaw('x'.repeat(43)), null);
});

/* ------------------------------------------------------------------------------------------------ a verificação do manifesto */

test('manifesto válido de chave de confiança autentica exatamente o que cobre; legado sem manifesto NUNCA é autêntico', async () => {
  const sealsDir = tmpDir('lep-');
  const { policy, keys } = policyFor(sealsDir);
  assert.deepEqual(await policy.classify(AUD, SAMPLE), { status: 'UNAUTHENTICATED', reason: 'NO_SEAL' });
  assert.deepEqual(await policy.classify(AUD, SAMPLE.map((e) => ({ ...e, legacy: true }))), { status: 'UNAUTHENTICATED', reason: 'LEGACY_NO_SEAL' }, 'captura legada sem prova independente: sem autenticidade atribuída');
  writeSealFile(sealsDir, AUD, 1, sealOf(keys));
  assert.deepEqual(await policy.classify(AUD, SAMPLE), { status: 'AUTHENTICATED' });
  assert.deepEqual(await policy.classify(AUD, [SAMPLE[0] as EvidenceToProve]), { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_MISSING', missingRefs: ['report:c0001-r0001'] }, 'o manifesto define o conjunto EXATO: o que foi atestado e hoje falta bloqueia (R3-MINOR-1)');
  assert.deepEqual(await policy.classify(AUD, [...SAMPLE, { ref: 'capture:c0002', contentSha256: 'c'.repeat(64), legacy: false }]), { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_NOT_SEALED' }, 'captura nova fora do manifesto');
  assert.deepEqual(await policy.classify(AUD, [{ ...(SAMPLE[0] as EvidenceToProve), contentSha256: 'd'.repeat(64) }]), { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_HASH_MISMATCH' }, 'mesmo ref, conteúdo diferente');
  assert.equal((await policy.classify(AUD, [])).status, 'UNAUTHENTICATED', 'sem evidência não há o que autenticar');
  assert.equal((await policy.classify('auditoria-outra-02', SAMPLE)).status, 'UNAUTHENTICATED');
});

test('manifesto FORJADO, adulterado, de chave desconhecida, de outra auditoria ou mal formado é recusado (SEAL_INVALID), sem recuar para um mais antigo', async () => {
  const mine = evidenceKeys();
  const attacker = evidenceKeys('ek-atacante-01');
  const cases: Array<[string, (dir: string, keys: ReturnType<typeof evidenceKeys>) => void]> = [
    ['assinado por chave que o servidor NÃO conhece', (dir) => writeSealFile(dir, AUD, 1, sealOf(attacker))],
    ['mesmo keyId de confiança, mas assinatura de OUTRA chave privada', (dir) => writeSealFile(dir, AUD, 1, sealOf({ ...attacker, keyId: mine.keyId }))],
    ['hash trocado depois de assinado', (dir, keys) => { const s = sealOf(keys); writeSealFile(dir, AUD, 1, { ...s, entries: s.entries.map((e, i) => (i === 0 ? { ...e, contentSha256: 'e'.repeat(64) } : e)) }); }],
    ['entrada acrescentada depois de assinado', (dir, keys) => { const s = sealOf(keys); writeSealFile(dir, AUD, 1, { ...s, entries: [...s.entries, { ref: 'capture:c0009', contentSha256: 'f'.repeat(64) }] }); }],
    ['manifesto de OUTRA auditoria copiado para esta pasta', (dir, keys) => writeSealFile(dir, AUD, 1, sealOf(keys, { auditId: 'auditoria-outra-02' }))],
    ['seq do arquivo diferente do seq assinado', (dir, keys) => writeSealFile(dir, AUD, 2, sealOf(keys, { seq: 1 }))],
    ['entradas fora de ordem', (dir, keys) => { const s = sealOf(keys); writeSealFile(dir, AUD, 1, { ...s, entries: [...s.entries].reverse() }); }],
    ['campo extra', (dir, keys) => writeSealFile(dir, AUD, 1, { ...sealOf(keys), extra: 1 })],
    ['assinatura ausente', (dir, keys) => { const { signature, ...rest } = sealOf(keys); void signature; writeSealFile(dir, AUD, 1, rest); }],
    ['JSON inválido', (dir) => { const file = writeSealFile(dir, AUD, 1, {}); fs.chmodSync(file, 0o644); fs.writeFileSync(file, '{ não é json'); }],
  ];
  for (const [label, build] of cases) {
    const dir = tmpDir('lep-');
    const { policy } = policyFor(dir, mine);
    build(dir, mine);
    const verdict = await policy.classify(AUD, SAMPLE);
    assert.equal(verdict.status, 'UNAUTHENTICATED', label);
    assert.ok(verdict.status === 'UNAUTHENTICATED' && ['SEAL_INVALID', 'VERIFICATION_ERROR'].includes(verdict.reason), `${label}: ${JSON.stringify(verdict)}`);
  }
  // o mais novo inválido NÃO faz recuar para o antigo válido: o atacante não escolhe qual passado vale
  const dir = tmpDir('lep-');
  const { policy, keys } = policyFor(dir, mine);
  writeSealFile(dir, AUD, 1, sealOf(keys));
  assert.equal((await policy.classify(AUD, SAMPLE)).status, 'AUTHENTICATED');
  writeSealFile(dir, AUD, 2, sealOf(attacker, { seq: 2 }));
  assert.deepEqual(await policy.classify(AUD, SAMPLE), { status: 'UNAUTHENTICATED', reason: 'SEAL_INVALID' });
});

test('manifesto mais novo e cumulativo passa a cobrir a captura nova; a pasta de manifestos como link simbólico ou FIFO falha fechada sem travar', async () => {
  const dir = tmpDir('lep-');
  const { policy, keys } = policyFor(dir);
  const extra: EvidenceToProve = { ref: 'capture:c0002', contentSha256: 'c'.repeat(64), legacy: false };
  writeSealFile(dir, AUD, 1, sealOf(keys));
  assert.equal((await policy.classify(AUD, [...SAMPLE, extra])).status, 'UNAUTHENTICATED');
  writeSealFile(dir, AUD, 2, sealOf(keys, { seq: 2, entries: [...SAMPLE, extra] }));
  assert.equal((await policy.classify(AUD, [...SAMPLE, extra])).status, 'AUTHENTICATED');
  // a pasta da auditoria nos manifestos é um link simbólico para outra pasta
  const real = tmpDir('lep-real-');
  writeSealFile(real, AUD, 1, sealOf(keys));
  const linked = tmpDir('lep-link-');
  fs.symlinkSync(path.join(real, AUD), path.join(linked, AUD));
  assert.deepEqual(await createSealedEvidenceProvenance({ sealsDir: linked, trustedKeys: parseTrustKeys(keys.trustKeys) as never }).classify(AUD, SAMPLE), { status: 'UNAUTHENTICATED', reason: 'SEAL_INVALID' });
  // o arquivo do manifesto é um FIFO: O_NONBLOCK + fstat ⇒ recusa na hora
  const fifoDir = tmpDir('lep-fifo-');
  fs.mkdirSync(path.join(fifoDir, AUD));
  execFileSync('mkfifo', [path.join(fifoDir, AUD, 'seal-0001.json')]);
  const started = Date.now();
  const fifo = await createSealedEvidenceProvenance({ sealsDir: fifoDir, trustedKeys: parseTrustKeys(keys.trustKeys) as never }).classify(AUD, SAMPLE);
  assert.equal(fifo.status, 'UNAUTHENTICATED');
  assert.ok(Date.now() - started < 3000, 'não travou');
});

/* ------------------------------------------------------------------------------------------------ o ataque do revisor (RV2-F1) e a fronteira com o motor */

test('RV2-F1 (permanente): captura FORJADA só na pasta de evidências (integridade OK) não é autêntica: a prévia a rotula, a finalização é recusada e NADA é gravado', async () => {
  const w = await world();
  const sealsDir = tmpDir('lep-');
  const keys = evidenceKeys();
  await sealAuditV2ForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys }); // a coleta legítima foi atestada por quem tem a chave
  const { policy } = policyFor(sealsDir, keys);
  const preview = previewOver(w, { evidenceProvenance: policy });
  const before = await preview.evaluate(OP_B, w.auditId);
  assert.ok(before.ok);
  assert.equal(before.value.payload.evidence.provenance?.status, 'AUTHENTICATED');
  assert.equal(before.value.payload.finalization.allowed, true, 'a coleta legítima atestada é finalizável');

  const n = await appendForgedCapture(w, '2026-10-22T13:30:00.000Z');
  const now = await preview.evaluate(OP_B, w.auditId);
  assert.ok(now.ok, JSON.stringify(now).slice(0, 200));
  assert.equal((now.value.input?.profile?.name?.[0] as { value?: string } | undefined)?.value, FORGED.title, `os fatos fabricados chegam ao mapeador (captura ${n}) — a integridade está OK`);
  assert.deepEqual(now.value.payload.evidence.provenance, { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_NOT_SEALED', missingRefs: [] });
  assert.equal(now.value.payload.finalization.allowed, false);
  assert.ok(now.value.payload.blockers.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' && b.severity === 'BLOCKING' && b.reasonCode === 'EVIDENCE_NOT_SEALED'));

  const e = resultsEnv();
  const svc = makeService(e, preview);
  const attempt = await svc.finalize(OP_B, w.auditId, { expectedHead: now.value.decisions.head, expectedInputSha256: now.value.inputSha256 as string });
  assert.ok(!attempt.ok && attempt.code === 'NOT_FINALIZABLE' && attempt.blockers?.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN'), JSON.stringify(attempt).slice(0, 200));
  assert.deepEqual(fs.existsSync(path.join(e.base, w.auditId)) ? fs.readdirSync(path.join(e.base, w.auditId)) : [], [], 'nenhum resultado gravado');
  assert.deepEqual(fs.existsSync(path.join(e.anchors, w.auditId)) ? fs.readdirSync(path.join(e.anchors, w.auditId)) : [], [], 'nenhum recibo gravado');
});

test('evidência ADULTERADA com o selo SHA-256 refeito (integridade OK): o hash diverge do manifesto ⇒ EVIDENCE_HASH_MISMATCH e a finalização é recusada', async () => {
  const w = await world();
  const sealsDir = tmpDir('lep-');
  const keys = evidenceKeys();
  await sealAuditForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys });
  const { policy } = policyFor(sealsDir, keys);
  const preview = previewOver(w, { evidenceProvenance: policy });
  assert.equal((await preview.evaluate(OP_B, w.auditId)).ok, true);
  // o invasor reescreve o relatório 1 mudando um campo e refaz o selo (o que o próprio pipeline faria)
  const file = path.join(w.evidenceDir, w.auditId, reportName(1, 1));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const { contentSha256, ...rest } = parsed;
  void contentSha256;
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, `${JSON.stringify(sealed({ ...rest, generatedAt: '2026-10-23T09:59:59.000Z' }))}\n`);
  const evaluated = await preview.evaluate(OP_B, w.auditId);
  assert.ok(evaluated.ok, JSON.stringify(evaluated).slice(0, 200));
  assert.deepEqual(evaluated.value.payload.evidence.provenance, { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_HASH_MISMATCH', missingRefs: [] });
  assert.equal(evaluated.value.payload.finalization.allowed, false);
});

test('padrão de produção (sem política): a prévia continua consultável e rotulada, mas NADA é finalizável', async () => {
  const w = await world();
  const preview = createScoringPreviewService({ basisReader: createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true }), decisions: w.raw, clock: () => '2026-10-23T10:00:00.000Z' });
  const payload = await preview.preview(ANA, w.auditId);
  assert.ok(payload.ok);
  assert.deepEqual(payload.value.evidence.provenance, { status: 'UNAUTHENTICATED', reason: 'PROOF_NOT_CONFIGURED', missingRefs: [] });
  assert.equal(payload.value.finalization.allowed, false);
  assert.equal(payload.value.state, 'CALCULADO_NAO_FINALIZAVEL');
  assert.ok(payload.value.blockers.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN'));
  assert.ok(payload.value.company.located, 'os dados continuam consultáveis (com a ressalva)');
  const svc = makeService(resultsEnv(), preview);
  const head = (await must(w.raw.list(ANA, w.auditId))).head;
  const attempt = await svc.finalize(OP_A, w.auditId, { expectedHead: head, expectedInputSha256: payload.value.finalization.expectedInputSha256 ?? 'a'.repeat(64) });
  assert.ok(!attempt.ok && (attempt.code === 'NOT_FINALIZABLE' || attempt.code === 'INPUT_CHANGED'), JSON.stringify(attempt).slice(0, 200));
});

/* ------------------------------------------------------------------------------------------------ conclusão de pendente */

test('CONCLUIR uma pendente também depende das evidências: sem prova de coleta ninguém dá o recibo; com a prova, o autor conclui', async () => {
  const w = await world();
  const sealsDir = tmpDir('lep-');
  const keys = evidenceKeys();
  await sealAuditV2ForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys });
  const trusted = previewOver(w, { evidenceProvenance: policyFor(sealsDir, keys).policy });
  const ev = await trusted.evaluate(OP_A, w.auditId);
  assert.ok(ev.ok);
  const body = { expectedHead: ev.value.decisions.head, expectedInputSha256: ev.value.inputSha256 as string };
  const e = resultsEnv();
  const failing = makeService(e, trusted, { fs: receiptsFail(e.anchors) });
  const pending = await failing.finalize(OP_A, w.auditId, body);
  assert.ok(!pending.ok && pending.code === 'RESULT_ANCHOR_PENDING');
  // o servidor perdeu a prova (manifestos removidos): a pendente legítima NÃO é concluída
  fs.rmSync(path.join(sealsDir, w.auditId), { recursive: true, force: true });
  const closed = makeService(e, previewOver(w, { evidenceProvenance: policyFor(sealsDir, keys).policy }));
  const refused = await closed.finalize(OP_A, w.auditId, body);
  assert.ok(!refused.ok && refused.code === 'NOT_FINALIZABLE' && refused.blockers?.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN'), JSON.stringify(refused).slice(0, 200));
  assert.equal(fs.existsSync(path.join(e.anchors, w.auditId, 'a0001.json')), false, 'nenhum recibo sem prova de coleta');
  // restaurada a prova, o AUTOR conclui (recuperação legítima preservada)
  await sealAuditV2ForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys });
  const reopened = makeService(e, previewOver(w, { evidenceProvenance: policyFor(sealsDir, keys).policy }));
  const done = await reopened.finalize(OP_A, w.auditId, body);
  assert.ok(done.ok && done.value.recoveredPending === true, JSON.stringify(done).slice(0, 200));
  assert.equal(fs.existsSync(path.join(e.anchors, w.auditId, 'a0001.json')), true);
});

test('o double de teste não vaza para produção: nenhum módulo de src importa os helpers de teste e a política "confia em tudo" só existe em tests/helpers', async () => {
  assert.equal(await TRUSTING_EVIDENCE_POLICY.classify(AUD, SAMPLE).then((t) => t.status), 'AUTHENTICATED');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && /TRUSTING_EVIDENCE_POLICY|tests\/helpers|authenticate\s*:\s*true/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  assert.deepEqual(offenders, []);
  void generateKeyPairSync;
  void rec;
  void clock;
});

test('chave pública de ORDEM PEQUENA (forjável) nunca é aceita como chave de confiança; chaves legítimas continuam aceitas', async () => {
  const hex = (value: string): Buffer => Buffer.from(value, 'hex');
  const smallOrder: Array<[string, string]> = [
    ['identidade (ordem 1)', '0100000000000000000000000000000000000000000000000000000000000000'],
    ['y = −1 (ordem 2)', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
    ['y = 0 (ordem 4)', '0000000000000000000000000000000000000000000000000000000000000000'],
    ['y = 0, sinal (ordem 4)', '0000000000000000000000000000000000000000000000000000000000000080'],
    ['ordem 8 (a)', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'],
    ['ordem 8 (b)', '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'],
    ['não canônico (y ≥ p)', 'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
  ];
  for (const [label, raw] of smallOrder) {
    assert.equal(isWeakEd25519PublicKey(hex(raw)), true, label);
    assert.equal(publicKeyFromRaw(hex(raw).toString('base64url')), null, label);
    assert.equal(parseTrustKeys(`ek-fraca-0001:${hex(raw).toString('base64url')}`), null, label);
  }
  for (let i = 0; i < 8; i += 1) {
    const keys = evidenceKeys(`ek-ok-000${i}`);
    assert.equal(isWeakEd25519PublicKey(Buffer.from(keys.publicRaw, 'base64url')), false);
    assert.ok(publicKeyFromRaw(keys.publicRaw) !== null);
  }
  // e o motivo da regra: com a identidade como "chave de confiança" uma assinatura universal seria aceita pelo verificador do Node
  const { createPublicKey, verify } = await import('node:crypto');
  const universal = Buffer.concat([hex(smallOrder[0]![1]), Buffer.alloc(32)]);
  const weakKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), hex(smallOrder[0]![1])]), format: 'der', type: 'spki' });
  assert.equal(verify(null, Buffer.from('qualquer mensagem'), weakKey, universal), true, 'sem a regra, isto seria uma forja aceita');
  const dir = tmpDir('lep-weak-');
  writeSealFile(dir, AUD, 1, { ...sealOf(evidenceKeys()), keyId: 'ek-fraca-0001', signature: universal.toString('base64url') });
  assert.deepEqual(await evidenceProvenanceFromConfig({ sealsDir: dir, trustKeys: `ek-fraca-0001:${hex(smallOrder[0]![1]).toString('base64url')}` }).classify(AUD, SAMPLE), { status: 'UNAUTHENTICATED', reason: 'PROOF_NOT_CONFIGURED' });
});

/* ------------------------------------------------------------------------------ R3-MINOR-1: o manifesto define o conjunto EXATO (bidirecional) */
const removeCaptureFiles = (w: World, capture: number): void => {
  for (const name of fs.readdirSync(path.join(w.evidenceDir, w.auditId))) {
    if (!name.startsWith(`c${String(capture).padStart(4, '0')}`)) continue;
    fs.chmodSync(path.join(w.evidenceDir, w.auditId, name), 0o644);
    fs.rmSync(path.join(w.evidenceDir, w.auditId, name));
  }
};

test('R3-MINOR-1 (regressão do revisor): REMOVER a captura 2 não faz a captura 1 voltar a ser a "situação atual" autêntica: EVIDENCE_MISSING, finalização recusada, nada gravado', async () => {
  const w = await world();
  await appendForgedCapture(w, '2026-10-22T13:30:00.000Z'); // 2ª captura (LEGÍTIMA neste teste: é atestada abaixo)
  const sealsDir = tmpDir('lep-');
  const keys = evidenceKeys();
  await sealAuditV2ForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys });
  const preview = previewOver(w, { evidenceProvenance: policyFor(sealsDir, keys).policy });
  const before = await preview.evaluate(OP_B, w.auditId);
  assert.ok(before.ok);
  assert.equal(before.value.payload.evidence.provenance?.status, 'AUTHENTICATED');
  assert.equal(before.value.payload.evidence.profileSource?.ref, 'capture:c0002', 'a captura mais recente é a fonte do perfil');
  assert.equal(before.value.payload.finalization.allowed, true);

  removeCaptureFiles(w, 2); // quem escreve só na pasta de evidências apaga a captura recente (e seus anexos)
  const after = await preview.evaluate(OP_B, w.auditId);
  assert.ok(after.ok, JSON.stringify(after).slice(0, 200));
  assert.equal(after.value.payload.evidence.profileSource?.ref, 'capture:c0001', 'o passado passa a ser a fonte do perfil…');
  const provenance = after.value.payload.evidence.provenance;
  assert.equal(provenance?.status, 'UNAUTHENTICATED', '…mas NÃO como situação atual autêntica');
  assert.equal(provenance?.reason, 'EVIDENCE_MISSING');
  assert.ok(provenance?.missingRefs.includes('capture:c0002') && provenance.missingRefs.includes('report:c0002-r0001'), JSON.stringify(provenance));
  assert.equal(after.value.payload.finalization.allowed, false);
  assert.ok(after.value.payload.blockers.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' && b.reasonCode === 'EVIDENCE_MISSING'));
  const e = resultsEnv();
  const attempt = await makeService(e, preview).finalize(OP_B, w.auditId, { expectedHead: after.value.decisions.head, expectedInputSha256: after.value.inputSha256 as string });
  assert.ok(!attempt.ok && attempt.code === 'NOT_FINALIZABLE' && attempt.blockers?.some((b) => b.reasonCode === 'EVIDENCE_MISSING'), JSON.stringify(attempt).slice(0, 220));
  assert.deepEqual(fs.existsSync(path.join(e.base, w.auditId)) ? fs.readdirSync(path.join(e.base, w.auditId)) : [], []);
});

test('R3-MINOR-1: REMOVER a revisão mais recente do relatório (r0002) volta ao relatório antigo: EVIDENCE_MISSING', async () => {
  const w = await world();
  const reportFile = path.join(w.evidenceDir, w.auditId, reportName(1, 1));
  const first = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as { report: Record<string, unknown> };
  const second = await writeReport(w.evidenceDir, w.auditId, 1, { ...first.report, revisao: 'segunda' }, '2026-10-23T10:00:00.000Z');
  assert.ok(second.ok, JSON.stringify(second));
  const sealsDir = tmpDir('lep-');
  const keys = evidenceKeys();
  const sealed = await sealAuditForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys });
  assert.ok(sealed.entries.some((entry) => entry.ref === 'report:c0001-r0002'));
  const preview = previewOver(w, { evidenceProvenance: policyFor(sealsDir, keys).policy });
  assert.equal((await preview.evaluate(OP_B, w.auditId)).ok, true);
  const r2 = path.join(w.evidenceDir, w.auditId, reportName(1, 2));
  fs.chmodSync(r2, 0o644);
  fs.rmSync(r2);
  const after = await preview.evaluate(OP_B, w.auditId);
  assert.ok(after.ok);
  assert.deepEqual(after.value.payload.evidence.provenance, { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_MISSING', missingRefs: ['report:c0001-r0002'] });
  assert.equal(after.value.payload.finalization.allowed, false);
});

test('R3-MINOR-1: o sentido inverso continua valendo (capturas NOVAS fora do manifesto) e a consulta histórica legítima não é bloqueada nem rotulada como atual', async () => {
  const w = await world();
  const sealsDir = tmpDir('lep-');
  const keys = evidenceKeys();
  await sealAuditForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys });
  await appendForgedCapture(w, '2026-10-22T13:30:00.000Z');
  const preview = previewOver(w, { evidenceProvenance: policyFor(sealsDir, keys).policy });
  const view = await preview.evaluate(OP_B, w.auditId);
  assert.ok(view.ok);
  assert.deepEqual(view.value.payload.evidence.provenance, { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_NOT_SEALED', missingRefs: [] });
  // consultável (200), com os dados à vista e rotulados; só a finalização é bloqueada
  assert.equal(view.value.payload.company.located, true);
  assert.equal(view.value.payload.finalization.allowed, false);
});

/* ------------------------------------------------------------------------------ R3-MINOR-3: serper-status.json do legado INFLUENCIA a pontuação */
function legacyPolicy(_base: string): { keys: ReturnType<typeof evidenceKeys>; sealsDir: string; policy: EvidenceProvenancePolicy } {
  const keys = evidenceKeys();
  const sealsDir = tmpDir('lep-leg-');
  return { keys, sealsDir, policy: policyFor(sealsDir, keys).policy };
}
const legacyPreview = (base: string, policy: EvidenceProvenancePolicy) =>
  previewOver({ evidenceDir: base, raw: { list: async (_actor: unknown, id: string) => ({ ok: true, value: fakeList(id, []) }) } as never }, { evidenceProvenance: policy });
const rewriteLegacyFile = (dir: string, name: string, content: string | null): void => {
  const file = path.join(dir, name);
  if (content === null) {
    fs.chmodSync(file, 0o644);
    fs.rmSync(file);
  } else {
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, content);
  }
  // o invasor também refaz o SHA256SUMS (qualquer um refaz): a INTEGRIDADE local continua "OK"
  const sums = path.join(dir, 'SHA256SUMS');
  fs.chmodSync(sums, 0o644);
  const lines = fs.readFileSync(sums, 'utf8').split('\n').filter((line) => line !== '');
  const kept = lines.filter((line) => !line.endsWith(`  ${name}`) && !line.endsWith(` ${name}`));
  if (content !== null) kept.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`);
  fs.writeFileSync(sums, `${kept.join('\n')}\n`);
};

test('R3-MINOR-3: o status do provedor do layout legado ENTRA na prova de coleta: sem o manifesto cobrindo-o a base não é autêntica; atestado, é', async () => {
  const { base } = await legacyReplica();
  const { keys, sealsDir, policy } = legacyPolicy(base);
  const basis = await createScoringBasisReader({ baseDir: base, authorize: () => true }).readScoringBasis({ email: 'x@y.z' }, LEGACY_AUDIT);
  assert.ok(basis.status === 'READY');
  assert.deepEqual(basis.basis.artifacts?.map((a) => a.ref), ['legacy-status:c0001'], 'o status é um artefato da base');
  // sem manifesto: legado nunca é autêntico
  const unsealed = await legacyPreview(base, policy).evaluate(OP_B, LEGACY_AUDIT);
  assert.ok(unsealed.ok && unsealed.value.payload.evidence.provenance?.reason === 'LEGACY_NO_SEAL' && unsealed.value.payload.finalization.allowed === false);
  // atestado por quem tem a chave (ato explícito) — o manifesto cobre capturas, relatórios E o status
  const manifest = await sealAuditV2ForTests({ evidenceDir: base, auditId: LEGACY_AUDIT, sealsDir, keys });
  assert.ok(manifest.entries.some((entry) => entry.ref === 'legacy-status:c0001'));
  const sealed = await legacyPreview(base, policy).evaluate(OP_B, LEGACY_AUDIT);
  assert.ok(sealed.ok && sealed.value.payload.evidence.provenance?.status === 'AUTHENTICATED');
  assert.equal(sealed.value.payload.company.located, true, 'com o status 200 o perfil é localizado');
});

test('R3-MINOR-3 (regressão do revisor): REESCREVER o serper-status.json (e o SHA256SUMS) muda o perfil, mas a base DEIXA de ser autêntica (EVIDENCE_HASH_MISMATCH) e a finalização é recusada', async () => {
  const { base, dir } = await legacyReplica();
  const { keys, sealsDir, policy } = legacyPolicy(base);
  await sealAuditV2ForTests({ evidenceDir: base, auditId: LEGACY_AUDIT, sealsDir, keys });
  const before = await legacyPreview(base, policy).evaluate(OP_B, LEGACY_AUDIT);
  assert.ok(before.ok && before.value.payload.company.located === true && before.value.payload.evidence.provenance?.status === 'AUTHENTICATED');
  rewriteLegacyFile(dir, 'serper-status.json', '{"attempts":1,"status":500,"ok":false}');
  const after = await legacyPreview(base, policy).evaluate(OP_B, LEGACY_AUDIT);
  assert.ok(after.ok, JSON.stringify(after).slice(0, 200));
  assert.equal(after.value.payload.evidence.integrity.status, 'OK', 'a INTEGRIDADE local continua OK: é exatamente o que o ataque explora');
  assert.equal(after.value.payload.company.located, false, 'o status forjado SUPRIME o perfil (influência real sobre a pontuação)');
  assert.deepEqual(after.value.payload.evidence.provenance, { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_HASH_MISMATCH', missingRefs: [] });
  assert.equal(after.value.payload.finalization.allowed, false);
  assert.ok(after.value.payload.blockers.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' && b.reasonCode === 'EVIDENCE_HASH_MISMATCH'));
});

test('R3-MINOR-3: REMOVER o status legado (arquivo + linha do SHA256SUMS): a integridade local JÁ falha (EVIDENCE_INTEGRITY, nada é exibido) e, no nível da prova, o artefato atestado ausente é EVIDENCE_MISSING', async () => {
  const { base, dir } = await legacyReplica();
  const { keys, sealsDir, policy } = legacyPolicy(base);
  const manifest = await sealAuditForTests({ evidenceDir: base, auditId: LEGACY_AUDIT, sealsDir, keys });
  rewriteLegacyFile(dir, 'serper-status.json', null);
  // camada 1 (integridade local): o leitor recusa a coleta — nenhum dado é entregue
  const after = await legacyPreview(base, policy).evaluate(OP_B, LEGACY_AUDIT);
  assert.ok(!after.ok && after.code === 'EVIDENCE_INTEGRITY', JSON.stringify(after).slice(0, 200));
  // camada 2 (prova de coleta), exercitada diretamente: a base de hoje SEM o artefato frente ao manifesto que o atesta
  const present = manifest.entries.filter((entry) => entry.ref !== 'legacy-status:c0001').map((entry) => ({ ref: entry.ref, contentSha256: entry.contentSha256, legacy: true }));
  assert.deepEqual(await policy.classify(LEGACY_AUDIT, present), { status: 'UNAUTHENTICATED', reason: 'EVIDENCE_MISSING', missingRefs: ['legacy-status:c0001'] });
});

test('R3-INFO-6 / R3-MINOR-6: a pasta de manifestos não pode se sobrepor a NENHUMA outra pasta de dados — nem por link simbólico (checado pelo caminho real a cada verificação)', async () => {
  const keys = evidenceKeys();
  const evidence = tmpDir('lep-ev-');
  const decisions = tmpDir('lep-dec-');
  const realSeals = path.join(evidence, 'dentro');
  fs.mkdirSync(realSeals);
  writeSealFile(realSeals, AUD, 1, sealOf(keys));
  const link = path.join(tmpDir('lep-link-'), 'seals');
  fs.symlinkSync(realSeals, link); // o caminho CONFIGURADO parece separado; o real está DENTRO da pasta de evidências
  const viaLink = evidenceProvenanceFromConfig({ sealsDir: link, trustKeys: keys.trustKeys, otherDirs: [evidence, decisions] });
  assert.deepEqual(await viaLink.classify(AUD, SAMPLE), { status: 'UNAUTHENTICATED', reason: 'PROOF_NOT_CONFIGURED' });
  // sem sobreposição real, a mesma configuração autentica
  const separate = tmpDir('lep-sep-');
  writeSealFile(separate, AUD, 1, sealOf(keys));
  assert.equal((await evidenceProvenanceFromConfig({ sealsDir: separate, trustKeys: keys.trustKeys, otherDirs: [evidence, decisions] }).classify(AUD, SAMPLE)).status, 'AUTHENTICATED');
  // idem contra as pastas de DECISÕES/RESULTADOS (lexical)
  assert.deepEqual(await evidenceProvenanceFromConfig({ sealsDir: separate, trustKeys: keys.trustKeys, otherDirs: [path.join(separate, '..')] }).classify(AUD, SAMPLE), { status: 'UNAUTHENTICATED', reason: 'PROOF_NOT_CONFIGURED' });
});
