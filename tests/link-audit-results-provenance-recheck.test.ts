import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createProvenanceRecheck } from '../src/lib/link-audit-evidence/provenance-recheck';
import { createEvidenceSealV2, createKeyRetirementClosure, evidenceProvenanceFromConfig, sealSha256, type EvidenceProvenancePolicy, type EvidenceSealFileV2 } from '../src/lib/link-audit-evidence/provenance';
import { createScoringBasisReader } from '../src/lib/link-audit-evidence/scoring-basis';
import { seal, serialize } from '../src/lib/link-audit-storage';
import { provenanceVerdictOf, type ProvenanceRecheckOutcome, type ProvenanceRecheckPort } from '../src/lib/link-audit-scoring-runs/results';
import { scoreRunSchema, type ScoreRun } from '../src/lib/link-audit-scoring-runs/results-types';
import { hashTree, registerCleanup, tmpDir, world, type World } from './helpers/link-audit-decisions-fixtures';
import { evidenceKeys, sealAuditV2ForTests, TEST_DOSSIER, writeSealFile, type EvidenceKeys } from './helpers/link-audit-evidence-provenance-fixtures';
import { previewOver } from './helpers/link-audit-preview-fixtures';
import { bodyOf, buildEvaluation, FakeEvaluator, makeService, OP_A, OP_B, resultsEnv, type ResultsEnv } from './helpers/link-audit-results-fixtures';

/*
 * R2.2 — RECONFERÊNCIA da proveniência na RELEITURA dos resultados (plano, onda R2; contrato do verificador v2 §6 e §7.3; D12 da spec do P1).
 *  - a porta (domínio de evidências, composta em `scoring/shared.ts`) devolve os ids REVOGADOS pela lista de confiança de HOJE e o `classify` de HOJE sobre a base de evidências
 *    GRAVADA no resultado;
 *  - a lista e o detalhe calculam `provenanceState` sem reescrever nada: campo ausente ⇒ `NOT_RECORDED`; presente e (chave gravada ou do `classify` de hoje revogada, ou `classify`
 *    ≠ autenticado, ou outra cabeça, ou porta com erro/configuração inválida) ⇒ `RECHECK`; tudo confere ⇒ `VERIFIED`;
 *  - "a reconferir" NÃO é falha de integridade (nunca 409) e nunca esconde o resultado; campo malformado continua 409 (R2.1);
 *  - a porta é chamada uma vez por base DENTRO de uma requisição e nada é lembrado entre requisições.
 * Pastas temporárias reais, chaves de TESTE geradas a cada execução, e-mails fictícios, nenhuma rede.
 */
registerCleanup();

const show = (value: unknown): string => JSON.stringify(value).slice(0, 360);
const PROVENANCE_FIELDS = /headSeq|headSealSha256|keyIds|evidenceProvenance|revokedKeyIds/;
const FIXTURES = path.join(__dirname, 'fixtures', 'link-audit-results-provenance');

type Status = 'active' | 'retired' | 'revoked';
const entryOf = (keys: EvidenceKeys, status: Status, pin?: string): string => `${keys.keyId}:${keys.publicRaw}:${status}${pin ? `:${pin}` : ''}`;
const listOf = (...entries: string[]): string => entries.join(',');
const policyOf = (sealsDir: string | null, list: string | undefined): EvidenceProvenancePolicy => evidenceProvenanceFromConfig({ sealsDir, trustKeys: list, acceptedVersions: [2] });
/** A porta como `shared.ts` a compõe: a MESMA política de produção (`[2]`) e a MESMA lista de chaves, montadas para UMA requisição. */
const portOf = (sealsDir: string | null, list: string | undefined): ProvenanceRecheckPort => createProvenanceRecheck({ policy: policyOf(sealsDir, list), trustKeys: list });
const basisOf = (run: ScoreRun) => run.evidenceBasis.map(({ ref, contentSha256, legacy }) => ({ ref, contentSha256, legacy }));
const pinOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function onlyRunOf(e: ResultsEnv, auditId: string): ScoreRun {
  const dir = path.join(e.base, auditId);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => /^s\d{4}\.json$/.test(name)), ['s0001.json']);
  return JSON.parse(fs.readFileSync(path.join(dir, 's0001.json'), 'utf8')) as ScoreRun;
}

type SeenBasis = ReadonlyArray<{ readonly ref: string; readonly contentSha256: string; readonly legacy: boolean }>;
/** Porta que conta as chamadas e guarda a base COMPLETA recebida (ref, hash e `legacy`), delegando a outra porta ou a uma resposta fixa. */
function counting(answer: ProvenanceRecheckPort | ((auditId: string) => Promise<ProvenanceRecheckOutcome>)): { readonly port: ProvenanceRecheckPort; readonly calls: SeenBasis[] } {
  const calls: SeenBasis[] = [];
  return {
    calls,
    port: {
      async recheck(auditId, evidences) {
        calls.push(evidences.map(({ ref, contentSha256, legacy }) => ({ ref, contentSha256, legacy })));
        return typeof answer === 'function' ? answer(auditId) : answer.recheck(auditId, evidences);
      },
    },
  };
}

interface Confirmed {
  readonly w: World;
  readonly e: ResultsEnv;
  readonly sealsDir: string;
  readonly run: ScoreRun;
  readonly preview: ReturnType<typeof previewOver>;
}

/** Finaliza com a prévia sobre `list` (produção: `[2]`) e devolve o resultado gravado. */
async function finalizeWith(w: World, sealsDir: string, list: string): Promise<Confirmed> {
  const preview = previewOver(w, { evidenceProvenance: policyOf(sealsDir, list) });
  const e = resultsEnv();
  const ev = await preview.evaluate(OP_A, w.auditId);
  assert.ok(ev.ok && ev.value.payload.finalization.allowed, show(ev));
  const done = await makeService(e, preview, { provenanceRecheck: portOf(sealsDir, list) }).finalize(OP_A, w.auditId, { expectedHead: ev.value.decisions.head, expectedInputSha256: ev.value.inputSha256 as string });
  assert.ok(done.ok, show(done));
  return { w, e, sealsDir, run: onlyRunOf(e, w.auditId), preview };
}

/** Mundo real atestado por UM manifesto v2 da chave A (ativa); o resultado confirmado grava a cabeça 1 e `keyIds = [A]`. */
async function confirmedWorld(keyId = 'ek-rec-ativa'): Promise<Confirmed & { readonly A: EvidenceKeys; readonly sealed: EvidenceSealFileV2 }> {
  const w = await world();
  const sealsDir = tmpDir('lrr-');
  const A = evidenceKeys(keyId);
  const sealed = await sealAuditV2ForTests({ evidenceDir: w.evidenceDir, auditId: w.auditId, sealsDir, keys: A });
  const c = await finalizeWith(w, sealsDir, entryOf(A, 'active'));
  assert.deepEqual(c.run.evidenceProvenance, { headSeq: 1, headSealSha256: sealSha256(sealed), keyIds: [A.keyId] });
  return { ...c, A, sealed };
}

/** UMA requisição de leitura (serviço novo, como nas rotas): lista e detalhe do s0001, com a porta dada (ou sem porta). */
async function readWith(c: Pick<Confirmed, 'w' | 'e' | 'preview'>, port: ProvenanceRecheckPort | undefined) {
  const svc = makeService(c.e, c.preview, port ? { provenanceRecheck: port } : {});
  const listed = await svc.list(OP_B, c.w.auditId);
  assert.ok(listed.ok, show(listed));
  const detail = await svc.get(OP_B, c.w.auditId, 1);
  assert.ok(detail.ok, show(detail));
  assert.equal(listed.value.results.length, 1, 'o resultado continua na lista');
  return { listed: listed.value, detail: detail.value, states: [listed.value.results[0]?.provenanceState, detail.value.provenanceState] };
}
const verdictWith = async (c: Pick<Confirmed, 'w' | 'run'>, port: ProvenanceRecheckPort) => provenanceVerdictOf(c.run.evidenceProvenance, await port.recheck(c.w.auditId, basisOf(c.run)));
const trees = (c: Pick<Confirmed, 'e'>) => [hashTree(c.e.base), hashTree(c.e.anchors)];

/* ============================================================================================ a porta (domínio de evidências) */

test('R2.2 porta: ids revogados pela lista ATUAL (aposentada não é revogada); classify delegado à política com a base dada; lista ausente ou inválida ⇒ NOT_CONFIGURED', async () => {
  const A = evidenceKeys('ek-porta-ativa');
  const B = evidenceKeys('ek-porta-revogada');
  const C = evidenceKeys('ek-porta-aposentada');
  const D = evidenceKeys('ek-porta-revogada-2');
  const answer = { status: 'AUTHENTICATED', headSeq: 1, headSealSha256: 'ab'.repeat(32), keyIds: [A.keyId] } as const;
  const seen: unknown[] = [];
  const policy: EvidenceProvenancePolicy = {
    async classify(auditId, evidences) {
      seen.push([auditId, evidences]);
      return answer;
    },
  };
  const base = [{ ref: 'capture:c0001', contentSha256: 'cd'.repeat(32), legacy: false }];
  const port = createProvenanceRecheck({ policy, trustKeys: listOf(entryOf(A, 'active'), entryOf(D, 'revoked'), entryOf(C, 'retired'), entryOf(B, 'revoked')) });
  assert.deepEqual(await port.recheck('auditoria-porta-0001', base), { kind: 'CHECKED', revokedKeyIds: [B.keyId, D.keyId].sort(), trust: answer });
  assert.deepEqual(seen, [['auditoria-porta-0001', base]], 'a política recebe exatamente a auditoria e a base dadas');
  assert.deepEqual(await createProvenanceRecheck({ policy, trustKeys: listOf(entryOf(A, 'active'), entryOf(C, 'retired', 'ef'.repeat(32))) }).recheck('auditoria-porta-0001', base), { kind: 'CHECKED', revokedKeyIds: [], trust: answer }, 'aposentada (com ou sem fecho) nunca é revogada');
  for (const invalid of [undefined, '', 'lixo', `${A.keyId}:${A.publicRaw}:REVOKED`, listOf(entryOf(A, 'active'), entryOf(A, 'revoked'))]) {
    assert.deepEqual(await createProvenanceRecheck({ policy, trustKeys: invalid }).recheck('auditoria-porta-0001', base), { kind: 'NOT_CONFIGURED' }, String(invalid));
  }
  const throwing: EvidenceProvenancePolicy = {
    async classify() {
      throw new Error('falha de teste');
    },
  };
  const thrown = await createProvenanceRecheck({ policy: throwing, trustKeys: entryOf(A, 'active') }).recheck('auditoria-porta-0001', base);
  assert.equal(thrown.kind, 'CHECKED');
  assert.equal(thrown.kind === 'CHECKED' ? thrown.trust.status : null, 'UNAUTHENTICATED', 'exceção da política nunca vira autenticado');
});

/* ============================================================================================ veredito (função pura) */

test('R2.2 veredito: tabela de estados e precedência (a revogação é dita mesmo quando o classify também falha)', () => {
  const recorded = { headSeq: 2, headSealSha256: 'aa'.repeat(32), keyIds: ['ek-chave-a', 'ek-chave-r', 'ek-chave-s'] };
  const authentic = { status: 'AUTHENTICATED' as const, headSeq: 2, headSealSha256: 'aa'.repeat(32), keyIds: ['ek-chave-a', 'ek-chave-r', 'ek-chave-s'] };
  const checked = (trust: unknown, revokedKeyIds: readonly string[] = []) => ({ kind: 'CHECKED', revokedKeyIds, trust }) as unknown as ProvenanceRecheckOutcome;
  const cases: ReadonlyArray<readonly [string, typeof recorded | undefined, unknown, { state: string; cause: string | null }]> = [
    ['legado sem o campo', undefined, checked(authentic), { state: 'NOT_RECORDED', cause: null }],
    ['legado sem o campo, porta com erro', undefined, 'PORT_ERROR', { state: 'NOT_RECORDED', cause: null }],
    ['tudo confere', recorded, checked(authentic), { state: 'VERIFIED', cause: null }],
    ['revogada uma das gravadas', recorded, checked(authentic, ['ek-chave-s']), { state: 'RECHECK', cause: 'KEY_REVOKED' }],
    ['revogada e a pasta sumiu (NO_SEAL)', recorded, checked({ status: 'UNAUTHENTICATED', reason: 'NO_SEAL' }, ['ek-chave-a']), { state: 'RECHECK', cause: 'KEY_REVOKED' }],
    ['revogada só no classify de hoje (signatário de fecho posterior)', recorded, checked({ ...authentic, keyIds: [...authentic.keyIds, 'ek-chave-t'] }, ['ek-chave-t']), { state: 'RECHECK', cause: 'KEY_REVOKED' }],
    ['revogada que não é desta cadeia', recorded, checked(authentic, ['ek-outra-chave']), { state: 'VERIFIED', cause: null }],
    ['UNAUTHENTICATED sem revogação', recorded, checked({ status: 'UNAUTHENTICATED', reason: 'EVIDENCE_HASH_MISMATCH' }), { state: 'RECHECK', cause: 'UNAUTHENTICATED' }],
    ['status desconhecido', recorded, checked({ status: 'TALVEZ' }), { state: 'RECHECK', cause: 'UNAUTHENTICATED' }],
    ['outra cabeça (mesmo número, outro hash)', recorded, checked({ ...authentic, headSealSha256: 'bb'.repeat(32) }), { state: 'RECHECK', cause: 'CHAIN_CHANGED' }],
    ['cadeia estendida (cabeça 3)', recorded, checked({ ...authentic, headSeq: 3 }), { state: 'RECHECK', cause: 'CHAIN_CHANGED' }],
    ['AUTHENTICATED do caminho v1 (sem cabeça)', recorded, checked({ status: 'AUTHENTICATED' }), { state: 'RECHECK', cause: 'CHAIN_CHANGED' }],
    ['configuração inválida', recorded, { kind: 'NOT_CONFIGURED' }, { state: 'RECHECK', cause: 'NOT_CONFIGURED' }],
    ['erro da porta', recorded, 'PORT_ERROR', { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['resposta nula', recorded, null, { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['resposta vazia', recorded, {}, { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['revogados fora de forma', recorded, checked(authentic, 'ek-chave-a' as never), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['revogado não texto', recorded, checked(authentic, [7] as never), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['sem trust', recorded, { kind: 'CHECKED', revokedKeyIds: [] }, { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['keyIds de hoje fora de forma', recorded, checked({ ...authentic, keyIds: 'ek-chave-a' }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['keyIds de hoje vazios (mesma cabeça)', recorded, checked({ ...authentic, keyIds: [] }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['keyIds de hoje repetidos', recorded, checked({ ...authentic, keyIds: ['ek-chave-a', 'ek-chave-a', 'ek-chave-r', 'ek-chave-s'] }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['keyIds de hoje fora de ordem', recorded, checked({ ...authentic, keyIds: ['ek-chave-s', 'ek-chave-a', 'ek-chave-r'] }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['id de hoje fora do padrão (maiúsculo)', recorded, checked({ ...authentic, keyIds: ['EK-CHAVE-A', 'ek-chave-r', 'ek-chave-s'] }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['id de hoje fora do padrão (ponto)', recorded, checked({ ...authentic, keyIds: ['ek.chave.a', 'ek-chave-r', 'ek-chave-s'] }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['id de hoje não texto', recorded, checked({ ...authentic, keyIds: ['ek-chave-a', 7] }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['17 ids de hoje', recorded, checked({ ...authentic, keyIds: Array.from({ length: 17 }, (_, i) => `ek-chave-${String(i).padStart(2, '0')}`) }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['cabeça 0', recorded, checked({ ...authentic, headSeq: 0 }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['cabeça negativa', recorded, checked({ ...authentic, headSeq: -2 }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['cabeça não inteira', recorded, checked({ ...authentic, headSeq: 2.5 }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['cabeça texto', recorded, checked({ ...authentic, headSeq: '2' }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['cabeça 257', recorded, checked({ ...authentic, headSeq: 257 }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['hash maiúsculo', recorded, checked({ ...authentic, headSealSha256: 'AA'.repeat(32) }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['hash curto', recorded, checked({ ...authentic, headSealSha256: 'aa'.repeat(31) }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['sem hash (cabeça e chaves presentes)', recorded, checked({ status: 'AUTHENTICATED', headSeq: 2, keyIds: authentic.keyIds }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['sem keyIds (cabeça presente)', recorded, checked({ status: 'AUTHENTICATED', headSeq: 2, headSealSha256: authentic.headSealSha256 }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
    ['campo extra', recorded, checked({ ...authentic, revokedKeyIds: [] }), { state: 'RECHECK', cause: 'PORT_ERROR' }],
  ];
  for (const [label, rec, outcome, expected] of cases) assert.deepEqual(provenanceVerdictOf(rec, outcome as ProvenanceRecheckOutcome), expected, label);
});

/* ============================================================================================ releitura com o verificador real */

test('R2.2 releitura: tudo confere ⇒ VERIFIED na lista e no detalhe; a porta recebe a base GRAVADA; nada de chaves nem hashes da proveniência nas respostas', async () => {
  const c = await confirmedWorld('ek-rec-confere');
  const spy = counting(portOf(c.sealsDir, entryOf(c.A, 'active')));
  const read = await readWith(c, spy.port);
  assert.deepEqual(read.states, ['VERIFIED', 'VERIFIED']);
  assert.deepEqual(spy.calls, [basisOf(c.run), basisOf(c.run)], 'uma chamada na lista, uma no detalhe, sempre com a base gravada COMPLETA (ref, hash e legacy)');
  for (const out of [read.listed, read.detail]) {
    const text = JSON.stringify(out);
    assert.ok(!PROVENANCE_FIELDS.test(text), 'nenhum campo da proveniência nas respostas');
    assert.ok(!text.includes(c.A.keyId) && !text.includes(sealSha256(c.sealed)), 'nem o id da chave nem o hash da cabeça');
  }
  assert.deepEqual(await verdictWith(c, portOf(c.sealsDir, entryOf(c.A, 'active'))), { state: 'VERIFIED', cause: null });
});

test('R2.2 revogação: chave gravada revogada HOJE + pasta de manifestos removida (ou corrompida) ⇒ legível (200), "A reconferir" pela interseção; nada reescrito', async () => {
  const c = await confirmedWorld('ek-rec-revogada');
  const before = trees(c);
  const revoked = entryOf(c.A, 'revoked');
  // com a pasta: o verificador também acusa SEAL_KEY_REVOKED, mas a marcação vem da interseção com os keyIds gravados
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, revoked))).states, ['RECHECK', 'RECHECK']);
  assert.deepEqual(await verdictWith(c, portOf(c.sealsDir, revoked)), { state: 'RECHECK', cause: 'KEY_REVOKED' });
  // manifesto corrompido: o sinal do verificador some (SEAL_INVALID), a interseção continua
  writeSealFile(c.sealsDir, c.w.auditId, 1, { lixo: true });
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, revoked))).states, ['RECHECK', 'RECHECK']);
  assert.deepEqual(await verdictWith(c, portOf(c.sealsDir, revoked)), { state: 'RECHECK', cause: 'KEY_REVOKED' });
  // pasta APAGADA: nada é lido (NO_SEAL, residual (i) do contrato §7.2); só a interseção com os keyIds gravados diz que a chave foi revogada
  fs.rmSync(path.join(c.sealsDir, c.w.auditId), { recursive: true, force: true });
  const gone = await readWith(c, portOf(c.sealsDir, revoked));
  assert.deepEqual(gone.states, ['RECHECK', 'RECHECK']);
  assert.equal(gone.listed.results[0]?.contentSha256, c.run.contentSha256, 'o mesmo resultado, exibido');
  assert.deepEqual(await verdictWith(c, portOf(c.sealsDir, revoked)), { state: 'RECHECK', cause: 'KEY_REVOKED' });
  assert.deepEqual(trees(c), before, 'nenhum resultado ou recibo foi reescrito');
});

test('R2.2 UNAUTHENTICATED sem revogação ⇒ "A reconferir", sem 409 e sem reescrita (bytes e hash iguais)', async () => {
  const c = await confirmedWorld('ek-rec-unauth');
  const file = path.join(c.e.base, c.w.auditId, 's0001.json');
  const bytes = fs.readFileSync(file);
  const before = trees(c);
  const active = entryOf(c.A, 'active');
  // a chave sumiu da lista (sem revogação): SEAL_INVALID
  const other = evidenceKeys('ek-rec-outra');
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, entryOf(other, 'active')))).states, ['RECHECK', 'RECHECK']);
  assert.deepEqual(await verdictWith(c, portOf(c.sealsDir, entryOf(other, 'active'))), { state: 'RECHECK', cause: 'UNAUTHENTICATED' });
  // manifesto adulterado
  const sealFile = path.join(c.sealsDir, c.w.auditId, 'seal-0001.json');
  const pristine = JSON.parse(fs.readFileSync(sealFile, 'utf8')) as EvidenceSealFileV2;
  writeSealFile(c.sealsDir, c.w.auditId, 1, { ...pristine, sealedAt: '2026-10-30T12:00:01.000Z' });
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, active))).states, ['RECHECK', 'RECHECK']);
  assert.deepEqual(await verdictWith(c, portOf(c.sealsDir, active)), { state: 'RECHECK', cause: 'UNAUTHENTICATED' });
  // pasta apagada sem revogação: NO_SEAL
  fs.rmSync(path.join(c.sealsDir, c.w.auditId), { recursive: true, force: true });
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, active))).states, ['RECHECK', 'RECHECK']);
  assert.deepEqual(await verdictWith(c, portOf(c.sealsDir, active)), { state: 'RECHECK', cause: 'UNAUTHENTICATED' });
  assert.ok(fs.readFileSync(file).equals(bytes), 'mesmos bytes');
  assert.equal((JSON.parse(bytes.toString('utf8')) as ScoreRun).contentSha256, c.run.contentSha256, 'mesmo hash');
  assert.deepEqual(trees(c), before);
  // controle: a cadeia restaurada volta a conferir (nada foi lembrado entre as requisições)
  writeSealFile(c.sealsDir, c.w.auditId, 1, pristine);
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, active))).states, ['VERIFIED', 'VERIFIED']);
});

test('R2.2 cadeia trocada ou estendida (mesma base, AUTHENTICATED com outra cabeça) ⇒ "A reconferir"', async () => {
  const c = await confirmedWorld('ek-rec-troca');
  const active = entryOf(c.A, 'active');
  const entries = c.sealed.entries.map(({ ref, contentSha256 }) => ({ ref, contentSha256 }));
  // trocada: outro seal-0001 válido, da MESMA chave e com as MESMAS entradas (outra hora ⇒ outro hash)
  const replaced = createEvidenceSealV2({ auditId: c.w.auditId, seq: 1, sealedAt: '2026-10-31T09:00:00.000Z', keyId: c.A.keyId, privateKey: c.A.privateKey, entries, dossier: TEST_DOSSIER, prevSealSha256: null });
  writeSealFile(c.sealsDir, c.w.auditId, 1, replaced);
  assert.equal((await policyOf(c.sealsDir, active).classify(c.w.auditId, basisOf(c.run))).status, 'AUTHENTICATED', 'o verificador autentica a cadeia nova');
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, active))).states, ['RECHECK', 'RECHECK']);
  assert.deepEqual(await verdictWith(c, portOf(c.sealsDir, active)), { state: 'RECHECK', cause: 'CHAIN_CHANGED' });
  // estendida: a cabeça gravada continua na cadeia, mas a cabeça de hoje é outra (o verificador não diz se a gravada é ancestral: falha fechada)
  writeSealFile(c.sealsDir, c.w.auditId, 1, c.sealed);
  const second = createEvidenceSealV2({ auditId: c.w.auditId, seq: 2, sealedAt: '2026-10-31T10:00:00.000Z', keyId: c.A.keyId, privateKey: c.A.privateKey, entries, dossier: TEST_DOSSIER, prevSealSha256: sealSha256(c.sealed) });
  writeSealFile(c.sealsDir, c.w.auditId, 2, second);
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, active))).states, ['RECHECK', 'RECHECK']);
  assert.deepEqual(await verdictWith(c, portOf(c.sealsDir, active)), { state: 'RECHECK', cause: 'CHAIN_CHANGED' });
  // controle: de volta à cadeia gravada
  fs.rmSync(path.join(c.sealsDir, c.w.auditId, 'seal-0002.json'), { force: true });
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, active))).states, ['VERIFIED', 'VERIFIED']);
});

/**
 * Cadeia de DOIS manifestos v2 sobre a base do mundo: `seal-0001` da chave R (APOSENTADA, com fecho assinado por S e fixado por hash na lista) e `seal-0002` da chave ativa A.
 * O resultado grava `keyIds = [A, R, S]` (posições + signatário do fecho, contrato §6, §7.3).
 */
async function retiredChainWorld() {
  const w = await world();
  const sealsDir = tmpDir('lrr-');
  const R = evidenceKeys('ek-rec-ret');
  const S = evidenceKeys('ek-rec-suc');
  const A = evidenceKeys('ek-rec-ati');
  const probe = await createScoringBasisReader({ baseDir: w.evidenceDir, authorize: () => true }).readScoringBasis({ email: 'conferente@teste.invalid' }, w.auditId);
  if (probe.status !== 'READY') throw new Error(probe.status);
  const entries = probe.basis.evidences.map(({ ref, contentSha256 }) => ({ ref, contentSha256 })).sort((a, b) => (a.ref < b.ref ? -1 : 1));
  const first = createEvidenceSealV2({ auditId: w.auditId, seq: 1, sealedAt: '2026-11-20T10:00:00.000Z', keyId: R.keyId, privateKey: R.privateKey, entries, dossier: TEST_DOSSIER, prevSealSha256: null });
  const second = createEvidenceSealV2({ auditId: w.auditId, seq: 2, sealedAt: '2026-11-20T11:00:00.000Z', keyId: A.keyId, privateKey: A.privateKey, entries, dossier: TEST_DOSSIER, prevSealSha256: sealSha256(first) });
  writeSealFile(sealsDir, w.auditId, 1, first);
  writeSealFile(sealsDir, w.auditId, 2, second);
  const closure = `${JSON.stringify(createKeyRetirementClosure({ retiredKeyId: R.keyId, signerKeyId: S.keyId, sealedAt: '2026-11-20T10:30:00.000Z', heads: [{ auditId: w.auditId, seq: 1, sealSha256: sealSha256(first) }], privateKey: S.privateKey }), null, 2)}\n`;
  fs.mkdirSync(path.join(sealsDir, '_closures'), { recursive: true });
  fs.writeFileSync(path.join(sealsDir, '_closures', `${R.keyId}.json`), closure);
  const pin = pinOf(closure);
  const c = await finalizeWith(w, sealsDir, listOf(entryOf(R, 'retired', pin), entryOf(S, 'active'), entryOf(A, 'active')));
  assert.deepEqual(c.run.evidenceProvenance, { headSeq: 2, headSealSha256: sealSha256(second), keyIds: [A.keyId, R.keyId, S.keyId].sort() });
  return { ...c, R, S, A, pin };
}

test('R2.2 aposentada coberta por fecho continua autenticada; revogar o SIGNATÁRIO do fecho (gravado em keyIds) marca, sem o verificador acusar nada', async () => {
  const c = await retiredChainWorld();
  const today = listOf(entryOf(c.R, 'retired', c.pin), entryOf(c.S, 'active'), entryOf(c.A, 'active'));
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, today))).states, ['VERIFIED', 'VERIFIED'], 'a aposentada coberta pelo fecho fixado não é revogada');
  const signerRevoked = listOf(entryOf(c.R, 'retired', c.pin), entryOf(c.S, 'revoked'), entryOf(c.A, 'active'));
  const trust = await policyOf(c.sealsDir, signerRevoked).classify(c.w.auditId, basisOf(c.run));
  assert.deepEqual(trust, { status: 'AUTHENTICATED', ...c.run.evidenceProvenance }, 'contrato §6: o histórico não cai; o verificador continua autenticando');
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, signerRevoked))).states, ['RECHECK', 'RECHECK']);
  assert.deepEqual(await verdictWith(c, portOf(c.sealsDir, signerRevoked)), { state: 'RECHECK', cause: 'KEY_REVOKED' });
  // revogar a própria aposentada (posição da cadeia) também marca
  const retiredRevoked = listOf(entryOf(c.R, 'revoked'), entryOf(c.S, 'active'), entryOf(c.A, 'active'));
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, retiredRevoked))).states, ['RECHECK', 'RECHECK']);
});

test('R2.2 chave aposentada DEPOIS da finalização, com fecho cobrindo a cabeça gravada: continua autenticada; revogar o signatário do fecho (só no classify de hoje) marca', async () => {
  const c = await confirmedWorld('ek-rec-depois');
  const S = evidenceKeys('ek-rec-depois-suc');
  const closure = `${JSON.stringify(createKeyRetirementClosure({ retiredKeyId: c.A.keyId, signerKeyId: S.keyId, sealedAt: '2026-11-01T10:00:00.000Z', heads: [{ auditId: c.w.auditId, seq: 1, sealSha256: sealSha256(c.sealed) }], privateKey: S.privateKey }), null, 2)}\n`;
  fs.mkdirSync(path.join(c.sealsDir, '_closures'), { recursive: true });
  fs.writeFileSync(path.join(c.sealsDir, '_closures', `${c.A.keyId}.json`), closure);
  const pin = pinOf(closure);
  const retired = listOf(entryOf(c.A, 'retired', pin), entryOf(S, 'active'));
  assert.deepEqual(await policyOf(c.sealsDir, retired).classify(c.w.auditId, basisOf(c.run)), { status: 'AUTHENTICATED', headSeq: 1, headSealSha256: sealSha256(c.sealed), keyIds: [c.A.keyId, S.keyId].sort() });
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, retired))).states, ['VERIFIED', 'VERIFIED']);
  const signerRevoked = listOf(entryOf(c.A, 'retired', pin), entryOf(S, 'revoked'));
  assert.equal((await policyOf(c.sealsDir, signerRevoked).classify(c.w.auditId, basisOf(c.run))).status, 'AUTHENTICATED', 'o histórico não cai (contrato §6)');
  assert.deepEqual((await readWith(c, portOf(c.sealsDir, signerRevoked))).states, ['RECHECK', 'RECHECK']);
  assert.deepEqual(await verdictWith(c, portOf(c.sealsDir, signerRevoked)), { state: 'RECHECK', cause: 'KEY_REVOKED' });
  // aposentada SEM o fecho fixado: só verifica o que o fecho congelou ⇒ SEAL_KEY_RETIRED_UNCOVERED
  assert.deepEqual(await verdictWith(c, portOf(c.sealsDir, listOf(entryOf(c.A, 'retired'), entryOf(S, 'active')))), { state: 'RECHECK', cause: 'UNAUTHENTICATED' });
});

/* ============================================================================================ legado, malformado, porta */

test('R2.2 legado v1/v2 sem o campo ⇒ "Proveniência não registrada", sem chamar a porta; os bytes não mudam', async () => {
  const auditId = 'auditoria-legado-v1';
  const e = resultsEnv();
  for (const [kind, root] of [['results', e.base], ['anchors', e.anchors]] as const) {
    fs.mkdirSync(path.join(root, auditId), { recursive: true });
    for (const name of fs.readdirSync(path.join(FIXTURES, kind, auditId))) fs.copyFileSync(path.join(FIXTURES, kind, auditId, name), path.join(root, auditId, name));
  }
  const before = [hashTree(e.base), hashTree(e.anchors)];
  const spy = counting(async () => ({ kind: 'CHECKED', revokedKeyIds: [], trust: { status: 'AUTHENTICATED' } }));
  const svc = makeService(e, new FakeEvaluator(buildEvaluation({ auditId })), { provenanceRecheck: spy.port });
  const listed = await svc.list(OP_A, auditId);
  const detail = await svc.get(OP_A, auditId, 1);
  assert.ok(listed.ok && detail.ok, show([listed, detail]));
  assert.deepEqual([listed.value.results[0]?.provenanceState, detail.value.provenanceState], ['NOT_RECORDED', 'NOT_RECORDED']);
  assert.equal(spy.calls.length, 0, 'sem o campo não há o que reconferir');
  assert.deepEqual([hashTree(e.base), hashTree(e.anchors)], before);
  // v2 legado (cita o livro; a leitura pelo serviço exige o livro): o veredito sobre o registro lido do disco
  const v2 = scoreRunSchema.parse(JSON.parse(fs.readFileSync(path.join(FIXTURES, 'results', 'auditoria-legado-v2', 's0001.json'), 'utf8')));
  assert.equal(v2.schemaVersion, 2);
  assert.deepEqual(provenanceVerdictOf(v2.evidenceProvenance, { kind: 'CHECKED', revokedKeyIds: ['ek-teste-0001'], trust: { status: 'UNAUTHENTICATED' } }), { state: 'NOT_RECORDED', cause: null });
});

test('R2.2 campo malformado continua falhando fechado (409 RESULT_INTEGRITY), sem consultar a porta', async () => {
  const ev = buildEvaluation();
  const e = resultsEnv();
  assert.ok((await makeService(e, new FakeEvaluator(ev)).finalize(OP_A, 'auditoria-res-0001', bodyOf(ev))).ok);
  const file = path.join(e.base, 'auditoria-res-0001', 's0001.json');
  const run = JSON.parse(fs.readFileSync(file, 'utf8')) as ScoreRun;
  const { contentSha256, ...body } = run;
  void contentSha256;
  fs.chmodSync(file, 0o644);
  for (const malformed of [null, { ...run.evidenceProvenance, keyIds: [] }, { ...run.evidenceProvenance, extra: true }]) {
    fs.writeFileSync(file, serialize(seal({ ...body, evidenceProvenance: malformed })));
    const spy = counting(async () => ({ kind: 'CHECKED', revokedKeyIds: [], trust: { status: 'AUTHENTICATED' } }));
    const svc = makeService(e, new FakeEvaluator(ev), { provenanceRecheck: spy.port });
    for (const out of [await svc.list(OP_A, 'auditoria-res-0001'), await svc.get(OP_A, 'auditoria-res-0001', 1)]) assert.ok(!out.ok && out.code === 'RESULT_INTEGRITY', `${show(malformed)}: ${show(out)}`);
    assert.equal(spy.calls.length, 0, 'integridade antes da reconferência');
  }
});

test('R2.2 erro, configuração inválida ou resposta fora de forma da porta ⇒ "A reconferir" (nunca autenticado, nunca 409, nunca esconde o resultado)', async () => {
  const ev = buildEvaluation();
  const e = resultsEnv();
  assert.ok((await makeService(e, new FakeEvaluator(ev)).finalize(OP_A, 'auditoria-res-0001', bodyOf(ev))).ok);
  const run = onlyRunOf(e, 'auditoria-res-0001');
  const authentic = { status: 'AUTHENTICATED', ...run.evidenceProvenance };
  const fixed = (outcome: unknown): ProvenanceRecheckPort => ({ recheck: async () => outcome as ProvenanceRecheckOutcome });
  const sealsDir = tmpDir('lrr-');
  const A = evidenceKeys('ek-teste-0001');
  const ports: ReadonlyArray<readonly [string, ProvenanceRecheckPort | undefined]> = [
    ['porta ausente', undefined],
    ['porta que lança', { recheck: async () => { throw new Error('falha de teste'); } }],
    ['porta que lança sem promessa', { recheck: () => { throw new Error('falha síncrona de teste'); } }],
    ['NOT_CONFIGURED', fixed({ kind: 'NOT_CONFIGURED' })],
    ['resposta nula', fixed(null)],
    ['resposta vazia', fixed({})],
    ['revogados fora de forma', fixed({ kind: 'CHECKED', revokedKeyIds: null, trust: authentic })],
    ['lista de chaves inválida (porta real)', portOf(sealsDir, 'lixo')],
    ['sem pasta de manifestos (política fechada, porta real)', portOf(null, entryOf(A, 'active'))],
  ];
  for (const [label, port] of ports) {
    const svc = makeService(e, new FakeEvaluator(ev), port ? { provenanceRecheck: port } : {});
    const listed = await svc.list(OP_A, 'auditoria-res-0001');
    const detail = await svc.get(OP_A, 'auditoria-res-0001', 1);
    assert.ok(listed.ok && detail.ok, `${label}: ${show([listed, detail])}`);
    assert.equal(listed.value.results.length, 1, `${label}: o resultado continua na lista`);
    assert.deepEqual([listed.value.results[0]?.provenanceState, detail.value.provenanceState], ['RECHECK', 'RECHECK'], label);
  }
  // controle: a mesma base com a resposta autêntica confere
  const svc = makeService(e, new FakeEvaluator(ev), { provenanceRecheck: fixed({ kind: 'CHECKED', revokedKeyIds: [], trust: authentic }) });
  const ok = await svc.list(OP_A, 'auditoria-res-0001');
  assert.ok(ok.ok && ok.value.results[0]?.provenanceState === 'VERIFIED', show(ok));
});

test('R2.2 resposta AUTHENTICATED com a cabeça gravada mas prova fora de forma (keyIds vazios, repetidos, fora de ordem, fora do padrão; cabeça ou hash inválidos; campo extra) ⇒ "A reconferir"', async () => {
  const ev = buildEvaluation();
  const e = resultsEnv();
  assert.ok((await makeService(e, new FakeEvaluator(ev)).finalize(OP_A, 'auditoria-res-0001', bodyOf(ev))).ok);
  const run = onlyRunOf(e, 'auditoria-res-0001');
  const recorded = run.evidenceProvenance as NonNullable<ScoreRun['evidenceProvenance']>;
  const authentic = { status: 'AUTHENTICATED', headSeq: recorded.headSeq, headSealSha256: recorded.headSealSha256, keyIds: [...recorded.keyIds] };
  const [only] = recorded.keyIds;
  const variants: ReadonlyArray<readonly [string, unknown]> = [
    ['keyIds vazios', { ...authentic, keyIds: [] }],
    ['keyIds repetidos', { ...authentic, keyIds: [only, only] }],
    ['keyIds fora de ordem', { ...authentic, keyIds: ['ek-teste-0002', only] }],
    ['id fora do padrão', { ...authentic, keyIds: ['EK-TESTE-0001'] }],
    ['cabeça 0', { ...authentic, headSeq: 0 }],
    ['cabeça negativa', { ...authentic, headSeq: -1 }],
    ['cabeça não inteira', { ...authentic, headSeq: recorded.headSeq + 0.5 }],
    ['hash maiúsculo', { ...authentic, headSealSha256: recorded.headSealSha256.toUpperCase() }],
    ['hash curto', { ...authentic, headSealSha256: recorded.headSealSha256.slice(2) }],
    ['campo extra', { ...authentic, missingRefs: [] }],
  ];
  for (const [label, trust] of variants) {
    const port: ProvenanceRecheckPort = { recheck: async () => ({ kind: 'CHECKED', revokedKeyIds: [], trust }) as unknown as ProvenanceRecheckOutcome };
    const svc = makeService(e, new FakeEvaluator(ev), { provenanceRecheck: port });
    const listed = await svc.list(OP_A, 'auditoria-res-0001');
    const detail = await svc.get(OP_A, 'auditoria-res-0001', 1);
    assert.ok(listed.ok && detail.ok, `${label}: ${show([listed, detail])}`);
    assert.deepEqual([listed.value.results[0]?.provenanceState, detail.value.provenanceState], ['RECHECK', 'RECHECK'], label);
  }
  // controle: a prova bem formada e igual à gravada confere
  const fine = makeService(e, new FakeEvaluator(ev), { provenanceRecheck: { recheck: async () => ({ kind: 'CHECKED', revokedKeyIds: [], trust: authentic }) as unknown as ProvenanceRecheckOutcome } });
  const ok = await fine.get(OP_A, 'auditoria-res-0001', 1);
  assert.ok(ok.ok && ok.value.provenanceState === 'VERIFIED', show(ok));
});

test('R2.2 a porta recebe a base GRAVADA completa (ref, hash e legacy), nunca a base de hoje, mesmo quando a de hoje difere', async () => {
  const ev = buildEvaluation();
  const e = resultsEnv();
  const evaluator = new FakeEvaluator(ev);
  assert.ok((await makeService(e, evaluator).finalize(OP_A, 'auditoria-res-0001', bodyOf(ev))).ok);
  const run = onlyRunOf(e, 'auditoria-res-0001');
  // hoje: outros hashes e uma captura a mais (a avaliação de hoje alimenta `stale`, nunca a reconferência)
  evaluator.current = buildEvaluation({ evidenceSalt: 'base-de-hoje', extraRefs: ['capture:c0009'] });
  const spy = counting(async () => ({ kind: 'CHECKED', revokedKeyIds: [], trust: { status: 'AUTHENTICATED', ...run.evidenceProvenance } }));
  const svc = makeService(e, evaluator, { provenanceRecheck: spy.port });
  const listed = await svc.list(OP_A, 'auditoria-res-0001');
  const detail = await svc.get(OP_A, 'auditoria-res-0001', 1);
  assert.ok(listed.ok && detail.ok, show([listed, detail]));
  assert.equal(listed.value.results[0]?.stale, true, 'a base de hoje é outra (o resultado está desatualizado)');
  const recordedBasis = basisOf(run);
  assert.deepEqual(spy.calls, [recordedBasis, recordedBasis], 'lista e detalhe reconferem a base GRAVADA');
  const today = (evaluator.current as { mapped: { traceability: { evidences: Array<{ ref: string; contentSha256: string }> } } }).mapped.traceability.evidences;
  assert.ok(today.some((item) => !recordedBasis.some((rec) => rec.ref === item.ref && rec.contentSha256 === item.contentSha256)), 'controle: a base de hoje difere da gravada');
});

/* ============================================================================================ custo: dedupe dentro da requisição, nada entre requisições */

test('R2.2 custo: a porta é chamada UMA vez por base dentro da requisição; nada é lembrado entre requisições (revogar entre elas muda o estado)', async () => {
  const e = resultsEnv();
  const evaluator = new FakeEvaluator(buildEvaluation({ variant: 'v1' }));
  const writer = makeService(e, evaluator);
  for (const spec of [{ variant: 'v1' }, { variant: 'v2' }, { variant: 'v3', extraRefs: ['capture:c0007'] }]) {
    evaluator.current = buildEvaluation(spec);
    const done = await writer.finalize(OP_A, 'auditoria-res-0001', bodyOf(evaluator.current as never));
    assert.ok(done.ok, show(done));
  }
  const first = JSON.parse(fs.readFileSync(path.join(e.base, 'auditoria-res-0001', 's0001.json'), 'utf8')) as ScoreRun;
  let revoked: string[] = [];
  const spy = counting(async () => ({ kind: 'CHECKED', revokedKeyIds: [...revoked], trust: { status: 'AUTHENTICATED', ...first.evidenceProvenance } }));
  const reader = makeService(e, evaluator, { provenanceRecheck: spy.port });
  const states = async () => {
    const listed = await reader.list(OP_B, 'auditoria-res-0001');
    assert.ok(listed.ok, show(listed));
    return listed.value.results.map((r) => r.provenanceState);
  };
  assert.deepEqual(await states(), ['VERIFIED', 'VERIFIED', 'VERIFIED']);
  assert.equal(spy.calls.length, 2, 's0001 e s0002 têm a MESMA base gravada (uma chamada); s0003 tem outra');
  assert.deepEqual(spy.calls.map((basis) => basis.length).sort(), [6, 7]);
  revoked = ['ek-teste-0001'];
  assert.deepEqual(await states(), ['RECHECK', 'RECHECK', 'RECHECK'], 'a revogação entre as requisições aparece na seguinte');
  assert.equal(spy.calls.length, 4, 'a segunda requisição consulta a porta de novo');
  const detail = await reader.get(OP_B, 'auditoria-res-0001', 2);
  assert.ok(detail.ok && detail.value.provenanceState === 'RECHECK', show(detail));
  assert.equal(spy.calls.length, 5, 'o detalhe reconfere só o resultado pedido');
  revoked = [];
  const again = await reader.get(OP_B, 'auditoria-res-0001', 2);
  assert.ok(again.ok && again.value.provenanceState === 'VERIFIED', show(again));
});

/* ============================================================================================ composição e isolamento (RL-29) */

test('R2.2 composição: shared.ts monta a porta com a MESMA política e a MESMA lista de chaves da requisição; scoring-runs não lê ambiente nem importa o verificador', () => {
  const root = path.join(__dirname, '..');
  const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const shared = strip(fs.readFileSync(path.join(root, 'src', 'app', 'api', 'link-audit', 'scoring', 'shared.ts'), 'utf8'));
  assert.match(shared, /createProvenanceRecheck\(\{\s*policy:\s*[\w.]*evidenceProvenance,\s*trustKeys(?:\s*:\s*[\w.]*trustKeys)?\s*\}\)/, 'a porta usa a política da prévia e a lista lida nesta requisição');
  assert.match(shared, /provenanceRecheck:/, 'o serviço de resultados recebe a porta');
  const results = strip(fs.readFileSync(path.join(root, 'src', 'lib', 'link-audit-scoring-runs', 'results.ts'), 'utf8'));
  assert.ok(!/process\.env|link-audit-evidence\/provenance|link-audit-ledger|link-audit-decisions/.test(results), 'results.ts não lê ambiente nem importa o verificador ou o livro');
});
