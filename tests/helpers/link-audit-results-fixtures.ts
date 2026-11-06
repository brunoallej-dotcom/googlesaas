import { NOT_REQUIRED_VIEW } from '../../src/lib/link-audit-decisions/ledger-port';
import fs from 'node:fs';
import path from 'node:path';
import type { Head } from '../../src/lib/link-audit-decisions';
import { sha256Hex } from '../../src/lib/link-audit/canonical';
import { parseScoringInput, scoreAudit } from '../../src/lib/link-audit/scoring/index';
import { createScoringResultsService, type PreviewBlocker, type ResultsDeps } from '../../src/lib/link-audit-scoring-runs';
import type { Evaluation } from '../../src/lib/link-audit-scoring-runs';
import { deriveAuditIdAlias } from '../../src/lib/link-audit-scoring-runs/audit-id-alias';
import { deriveOutcome } from '../../src/lib/link-audit-scoring-runs/outcome';
import type { PreviewActor, PreviewFailure } from '../../src/lib/link-audit-scoring-runs/preview';
import type { PreviewEvaluator } from '../../src/lib/link-audit-scoring-runs/results';
import { MAPPER_VERSION } from '../../src/lib/link-audit-scoring-runs/types';
import type { WebsiteExpectation } from '../../src/lib/link-audit-evidence/scoring-basis';
import { registerCleanup, tmpDir } from './link-audit-decisions-fixtures';
import { clone, richInput } from './link-audit-scoring-fixtures';
import { TEST_ORIGIN } from './link-audit-origin-fixtures';

/*
 * Fixtures FICTÍCIAS da Onda 6C, I4. A avaliação é montada em memória com a ENTRADA REAL do motor (a rica fictícia, no FORMATO do
 * mapeador: sem avaliações, sem website, nada `complete`) e o RESULTADO REAL do motor — assim a verificação semântica do registro
 * (`verifyScoreResult`, hashes, desfecho) roda de verdade. O que é falso é só o caminho do disco de evidências/decisões: o mapeador
 * real nunca alcança a cobertura mínima hoje (teto de 17 %), por isso PONTUADO só existe com este avaliador injetado.
 */
registerCleanup();

export const RES_AUDIT = 'auditoria-res-0001';
export const OP_A = { email: 'ana@empresa.com' } satisfies PreviewActor;
export const OP_B = { email: 'bia@empresa.com' } satisfies PreviewActor;
const SHA = (seed: string): string => sha256Hex(`fixture:${seed}`);

const REFS: Readonly<Record<string, string>> = { n1: 'capture:c0001', site1: 'capture:c0002', soc1: 'capture:c0003', c1: 'capture:c0004', c2: 'capture:c0005', c3: 'capture:c0006' };
export const REFERENCE_REF = 'capture:c0001';
export const REFERENCE_AT = '2026-10-22T10:00:00.000Z';
export const WEBSITE_URL = 'https://exemplo.com.br/?utm_source=google&utm_medium=gbp';

export interface Spec {
  readonly auditId?: string;
  readonly kind?: 'PONTUADO' | 'INCONCLUSIVO';
  /** Muda o conteúdo da entrada (hash) sem mudar as evidências. */
  readonly variant?: string;
  /** Muda o hash de TODAS as evidências mantendo os números e as datas (captura trocada). */
  readonly evidenceSalt?: string;
  /** Muda o head das decisões. */
  readonly headSeed?: string;
  /** Inclui o website derivado (com UTM comprovado). */
  readonly website?: boolean;
  /** Evidências extras (números novos). */
  readonly extraRefs?: readonly string[];
  readonly blockers?: readonly PreviewBlocker[];
  readonly allowed?: boolean;
  /** Violações de política COERENTES com o motor (hashes e resultado refeitos): o mapeador real nunca as produziria. */
  readonly reviews?: boolean;
  readonly completeField?: boolean;
  readonly websiteWithoutProof?: boolean;
}

export function buildInput(spec: Spec): { input: Record<string, unknown>; alias: NonNullable<ReturnType<typeof deriveAuditIdAlias>> } {
  const auditId = spec.auditId ?? RES_AUDIT;
  const alias = deriveAuditIdAlias(auditId);
  if (!alias) throw new Error('auditId de teste inválido');
  const variant = spec.variant ?? 'v1';
  let text = JSON.stringify(richInput());
  for (const [from, to] of Object.entries(REFS)) text = text.split(`"${from}"`).join(`"${to}"`);
  const input = JSON.parse(text) as Record<string, any>;
  input.auditId = alias.scoringAuditId;
  input.referenceDate = REFERENCE_AT.slice(0, 10);
  for (const evidence of input.evidences as Array<Record<string, any>>) {
    evidence.contentSha256 = SHA(`${evidence.id}:${spec.evidenceSalt ?? 'base'}`);
    if (evidence.id === REFERENCE_REF) evidence.observedAt = REFERENCE_AT;
  }
  for (const ref of spec.extraRefs ?? []) input.evidences.push({ ...clone(input.evidences[0]), id: ref, contentSha256: SHA(`${ref}:${spec.evidenceSalt ?? 'base'}`) });
  // FORMATO DO MAPEADOR: nada `complete`, sem avaliações (M-4a), website só quando derivado e comprovado
  for (const key of Object.keys(input.profile)) for (const observation of input.profile[key]) observation.complete = false;
  delete input.profile.reviews;
  delete input.profile.website;
  input.profile.name = [{ evidenceIds: [REFERENCE_REF], complete: false, value: `Padaria Exemplo ${variant}` }];
  if (spec.website) input.profile.website = [{ evidenceIds: [REFERENCE_REF], complete: true, value: WEBSITE_URL }];
  if ((spec.kind ?? 'PONTUADO') === 'INCONCLUSIVO') {
    input.profile = { name: input.profile.name, phone: input.profile.phone, address: input.profile.address, ...(spec.website ? { website: input.profile.website } : {}) };
    delete input.site;
    delete input.nap;
    delete input.competitors;
    delete input.authority;
    input.operatorRecords = [];
  }
  if (spec.reviews) input.profile.reviews = [{ evidenceIds: [REFERENCE_REF], complete: false, value: { ratingShown: '4.9', reviewCount: 130 } }];
  if (spec.completeField) input.profile.phone[0].complete = true;
  return { input, alias };
}

/** Avaliação completa (o que `preview.evaluate` entregaria) a partir da entrada REAL e do resultado REAL do motor. */
export function buildEvaluation(spec: Spec = {}): Evaluation {
  const { input: raw, alias } = buildInput(spec);
  const parsed = parseScoringInput(raw);
  if (!parsed.ok) throw new Error(`entrada recusada: ${JSON.stringify(parsed.issues).slice(0, 300)}`);
  const input = parsed.input;
  const scored = scoreAudit(raw);
  if (!scored.ok) throw new Error('motor recusou a entrada de teste');
  const result = scored.result;
  const outcome = deriveOutcome(result);
  const expected = spec.kind ?? 'PONTUADO';
  if (outcome.outcome !== expected) throw new Error(`fixture esperava ${expected}, o motor deu ${outcome.outcome}`);
  const records = input.operatorRecords ?? [];
  const head: Head | null = records.length === 0 && spec.headSeed === undefined ? null : { seq: Math.max(1, records.length), sha256: SHA(`head:${spec.headSeed ?? 'h1'}`) };
  const bodySha = (id: string): string => SHA(`body:${id}:${spec.evidenceSalt ?? 'base'}`);
  const evidences = input.evidences.map((evidence) => ({ ref: evidence.id, kind: 'CAPTURE' as const, observedAt: evidence.observedAt, contentSha256: evidence.contentSha256, bodySha256: bodySha(evidence.id), legacy: false, superseded: false }));
  const source = { ref: REFERENCE_REF, observedAt: REFERENCE_AT, contentSha256: SHA(`${REFERENCE_REF}:${spec.evidenceSalt ?? 'base'}`), bodySha256: bodySha(REFERENCE_REF) };
  const rawWebsite = spec.website ? SHA('website-bruto') : null;
  const websiteTrace = spec.website && rawWebsite && !spec.websiteWithoutProof
    ? { rule: 'LUMOS_X1_X5_URL_V1', rawSha256: rawWebsite, sourceEvidence: { ref: REFERENCE_REF, contentSha256: source.contentSha256, bodySha256: source.bodySha256 }, utmLevel: 'COMPLETE' as const, x5Proof: 'PROVEN' }
    : null;
  const mapped = {
    input,
    inputSha256: result.inputSha256,
    traceability: {
      mapperVersion: MAPPER_VERSION,
      basisVersion: null,
      layout: 'VERSIONED',
      auditId: alias,
      referenceDate: input.referenceDate,
      referenceDateSource: { ref: REFERENCE_REF, observedAt: REFERENCE_AT, rule: 'LATEST_VERIFIED_EVIDENCE_DAY' },
      evidences,
      profile: { state: 'AVAILABLE', source, ageDays: 1, ageStatus: 'CURRENT' },
      facts: [],
      websiteDerivation: websiteTrace,
      excluded: { reviews: 'EXCLUDED_M4A' },
      operatorRecords: { count: records.length, ids: records.map((r) => r.id) },
      inputSha256: result.inputSha256,
    },
  };
  const basis = {
    layout: 'VERSIONED',
    profile: spec.website && websiteTrace ? { state: 'AVAILABLE', source, website: { state: 'DERIVED', derived: WEBSITE_URL, derivation: { rawSha256: websiteTrace.rawSha256 }, utm: { level: 'COMPLETE' } } } : { state: 'AVAILABLE', source, website: { state: 'ABSENT' } },
  };
  const decisions = { auditId: spec.auditId ?? RES_AUDIT, head, pending: null, finalizable: true, ledger: NOT_REQUIRED_VIEW, decisions: records.map((r) => ({ decisionId: r.id })), operatorRecords: records };
  const payload = {
    definitive: false,
    auditId: spec.auditId ?? RES_AUDIT,
    blockers: spec.blockers ?? [],
    finalization: { allowed: spec.allowed ?? true, expectedHead: head, expectedInputSha256: result.inputSha256, latest: null },
  };
  return {
    payload,
    input,
    inputSha256: result.inputSha256,
    result,
    outcome,
    mapped,
    basis,
    decisions,
    applied: records.map((record, index) => ({ decisionId: record.id, kind: record.kind, seq: index + 1, stampCapture: 1, stampCollectedAt: REFERENCE_AT })),
    held: [],
    fingerprint: sha256Hex(`fp:${result.inputSha256}:${head?.sha256 ?? 'sem-head'}`),
  } as unknown as Evaluation;
}

/** O corpo que o operador enviaria depois de ver a avaliação. */
export const bodyOf = (evaluation: Evaluation): { expectedHead: Head | null; expectedInputSha256: string } => ({ expectedHead: evaluation.decisions.head, expectedInputSha256: evaluation.inputSha256 as string });

export const BLOCKING = (code: string, decisionIds: string[] = []): PreviewBlocker => ({ code, severity: 'BLOCKING', message: 'Bloqueio de teste.', reasonCode: null, decisionIds, subcriterionIds: [] }) as unknown as PreviewBlocker;

/** Avaliador controlável: devolve o estado `current` e permite mudá-lo ENTRE as etapas da finalização. */
export class FakeEvaluator implements PreviewEvaluator {
  current: Evaluation | PreviewFailure;
  evaluateCalls = 0;
  fingerprintCalls = 0;
  barrierCalls = 0;
  /** Veredito da barreira de durabilidade (padrão: comprovada). Os avaliadores falsos não citam o livro, mas conclusões de pendentes com `ledgerHead` a chamam. */
  barrierOutcome: Awaited<ReturnType<PreviewEvaluator['durabilityBarrier']>> = { ok: true };
  /** Chamado a cada `evaluate` (depois de contar); pode trocar `current` para simular mudança entre etapas. */
  onEvaluate: ((n: number) => void) | null = null;
  /** Chamado a cada `fingerprintNow`; pode trocar `current`. */
  onFingerprint: ((n: number) => void) | null = null;
  constructor(current: Evaluation | PreviewFailure) {
    this.current = current;
  }
  async evaluate(): Promise<{ readonly ok: true; readonly value: Evaluation } | PreviewFailure> {
    this.evaluateCalls++;
    this.onEvaluate?.(this.evaluateCalls);
    return 'ok' in this.current && this.current.ok === false ? (this.current as PreviewFailure) : { ok: true, value: this.current as Evaluation };
  }
  async durabilityBarrier(): Promise<Awaited<ReturnType<PreviewEvaluator['durabilityBarrier']>>> {
    this.barrierCalls++;
    return this.barrierOutcome;
  }
  async fingerprintNow(): Promise<{ readonly ok: true; readonly fingerprint: string } | PreviewFailure> {
    this.fingerprintCalls++;
    this.onFingerprint?.(this.fingerprintCalls);
    return 'ok' in this.current && this.current.ok === false ? (this.current as PreviewFailure) : { ok: true, fingerprint: (this.current as Evaluation).fingerprint };
  }
}

export interface Verdicts {
  verdict: 'MATCH' | 'MISMATCH' | 'NOT_AVAILABLE';
  calls: WebsiteExpectation[];
}
export function fakeBasis(verdicts: Partial<Verdicts> = {}): { reader: ResultsDeps['basisReader']; state: Verdicts } {
  const state: Verdicts = { verdict: verdicts.verdict ?? 'MATCH', calls: [] };
  return {
    state,
    reader: {
      async verifyWebsiteDerivation(_actor, _auditId, expected) {
        state.calls.push(expected);
        return state.verdict;
      },
    },
  };
}

export interface ResultsEnv {
  readonly base: string;
  readonly anchors: string;
  readonly other: string;
}
export const resultsEnv = (): ResultsEnv => ({ base: tmpDir('lad-rs-'), anchors: tmpDir('lad-ra-'), other: tmpDir('lad-ro-') });

/** Relógio do servidor, estritamente crescente (milissegundos). */
export function tickClock(startSecond = 0): () => string {
  let tick = startSecond;
  return () => new Date(Date.UTC(2026, 9, 30, 12, 0, tick++)).toISOString();
}

export function makeService(e: ResultsEnv, evaluator: PreviewEvaluator, over: Partial<ResultsDeps> = {}) {
  const basis = fakeBasis();
  return createScoringResultsService({ origin: TEST_ORIGIN, preview: evaluator, basisReader: basis.reader, baseDir: e.base, anchorDir: e.anchors, otherDirs: [e.other], clock: tickClock(), ...over });
}

export const runPath = (e: ResultsEnv, seq: number, auditId = RES_AUDIT): string => path.join(e.base, auditId, `s${String(seq).padStart(4, '0')}.json`);
export const receiptPath = (e: ResultsEnv, seq: number, auditId = RES_AUDIT): string => path.join(e.anchors, auditId, `a${String(seq).padStart(4, '0')}.json`);
export const treeOf = (e: ResultsEnv): Record<string, string[]> => {
  const list = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);
  return { runs: list(e.base), anchors: list(e.anchors) };
};
