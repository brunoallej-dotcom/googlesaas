import { evidenceToProveFromBasis } from '../link-audit-evidence/evidence-to-prove';
import { CLOSED_EVIDENCE_PROVENANCE, type EvidenceProvenancePolicy, type EvidenceTrust, type EvidenceTrustReason } from '../link-audit-evidence/provenance';
import { canonicalJson, sha256Hex } from '../link-audit/canonical';
import { CRITERIA } from '../link-audit/methodology';
import type { OperatorRecord, ScoringInput } from '../link-audit/scoring/input';
import { scoreAudit, SUBCRITERIA, verifyScoreResult, type ScoreOutcome, type ScoreResult } from '../link-audit/scoring/index';
import { AUDIT_ID_PATTERN, HTTP_STATUS, isLedgerBlocking, isUnresolved, PUBLIC_MESSAGE, type DecisionDto, type GuardStatus, type Head, type LedgerReason, type LedgerState, type ListPayload, type ServiceErrorCode, type ServiceResult, type WitnessStatus } from '../link-audit-decisions';
import type { ScoringBasisOutcome } from '../link-audit-evidence/scoring-basis';
import { assembleScoringInput } from './assemble';
import { verifyAuditIdAlias, type AuditIdAlias } from './audit-id-alias';
import { attributeFailure, fromMapper, previewBlocker, sortPreviewBlockers, type PreviewBlocker } from './blockers';
import { classifyOperatorRecord, CRITERIA_SOURCES, decisionTargets } from './criteria-sources';
import { deriveOutcome, obtainedPointsOfCriterion, obtainedPointsOfSubcriterion, toPublicView, type OutcomePreview } from './outcome';
import type { AssembleResult, CriterionSourceView } from './types';

/** Porta de escrita do livro que a FINALIZAÇÃO recebe (R1.3, D-R1-3): os tipos moram na porta do livro das decisões; os resultados os alcançam por aqui (lista fechada de imports). */
export type { LedgerReason, LedgerView, ResultsLedgerPort, ResultsLedgerRead, RunDraft, RunRefusal, RunStep } from '../link-audit-decisions';

/*
 * Serviço de PRÉVIA da pontuação Lumos (Onda 6C, I3). Lê a base verificada (I1) e as decisões CONFIRMADAS (6B), monta a entrada
 * SOMENTE pelo mapeador (I2), executa o motor existente e devolve uma prévia. NUNCA grava, NUNCA gera recibo, NUNCA é definitiva
 * (`definitive:false`) e NUNCA aceita pontuação ou entrada do cliente: a única entrada é o `auditId`.
 *
 *  - Duas leituras: a base e as decisões são lidas, o cálculo só vale se uma SEGUNDA leitura trouxer exatamente o mesmo `head`, a
 *    mesma pendente e a mesma base (hash canônico). Se algo mudou, tenta de novo (até 3 vezes) e por fim recusa (`READ_INCONSISTENT`).
 *    Uma mudança DEPOIS da segunda leitura é inevitável numa prévia: por isso a resposta carrega o `head` consultado e o I4 reconfere
 *    tudo dentro da trava antes de gravar.
 *  - Decisões que NÃO podem ser aplicadas (fora do contrato aprovado, dependentes do site, juízo C2 de outra captura) ficam
 *    RETIDAS: não entram na entrada, bloqueiam a finalização e são apontadas pelo `op-NNNN` (campos estruturados, não texto).
 *  - O alias do `auditId` nunca localiza dados: tudo é lido pelo `auditId` da rota; qualquer incoerência de identidade falha fechado.
 *  - Cobertura insuficiente (`index:null`) NÃO é falha: é o desfecho INCONCLUSIVO. Bloqueio, decisão pendente e falha de
 *    integridade são coisas distintas e nunca se confundem com ele.
 */
export type PreviewState = 'SEM_EVIDENCIA' | 'DECISAO_PENDENTE' | 'ENTRADA_RECUSADA' | 'CALCULADO_NAO_FINALIZAVEL' | 'CALCULADO_FINALIZAVEL';
export type PreviewFailureCode = ServiceErrorCode | 'READ_INCONSISTENT' | 'AUDIT_IDENTITY_MISMATCH';

export const PREVIEW_HTTP_STATUS: Readonly<Record<PreviewFailureCode, number>> = Object.freeze({ ...HTTP_STATUS, READ_INCONSISTENT: 409, AUDIT_IDENTITY_MISMATCH: 409 });
export const PREVIEW_MESSAGE: Readonly<Record<PreviewFailureCode, string>> = Object.freeze({
  ...PUBLIC_MESSAGE,
  EVIDENCE_INTEGRITY: 'As evidências desta auditoria não passam na verificação de integridade; nenhum dado é exibido.',
  READ_INCONSISTENT: 'As evidências ou as decisões mudaram durante o cálculo da prévia. Nada foi calculado; tente novamente.',
  AUDIT_IDENTITY_MISMATCH: 'A identidade da auditoria não é coerente entre as evidências, as decisões e a entrada do motor; nenhum dado é exibido.',
});

export interface PreviewFailure {
  readonly ok: false;
  readonly code: PreviewFailureCode;
  readonly issues: readonly string[];
  readonly head?: Head | null;
}
export type PreviewResult = { readonly ok: true; readonly value: PreviewPayload } | PreviewFailure;

type ReadyBasisOf<T> = T extends { status: 'READY'; basis: infer B } ? B : never;
export type ReadyBasis = ReadyBasisOf<ScoringBasisOutcome>;

/**
 * Tudo o que a prévia calculou, para quem precisa MAIS do que a projeção pública (a finalização do I4): a entrada exata do motor,
 * o resultado completo, a base verificada e as decisões lidas. Estes dados são INTERNOS: nunca saem por uma rota.
 */
export interface Evaluation {
  readonly payload: PreviewPayload;
  readonly input: ScoringInput | null;
  readonly inputSha256: string | null;
  readonly result: ScoreResult | null;
  readonly outcome: OutcomePreview | null;
  readonly mapped: AssembleResult | null;
  readonly basis: ReadyBasis | null;
  readonly decisions: ListPayload;
  /** Decisões efetivamente aplicadas na entrada, com o carimbo de captura que a 6B gravou (rastreabilidade do vínculo do C2). */
  readonly applied: ReadonlyArray<{ readonly decisionId: string; readonly kind: string; readonly seq: number; readonly stampCapture: number | null; readonly stampCollectedAt: string | null }>;
  readonly held: readonly HeldDecision[];
  /** Impressão digital das DUAS leituras que concordaram (head, pendente, registros e base). */
  readonly fingerprint: string;
}
export type EvaluationResult = { readonly ok: true; readonly value: Evaluation } | PreviewFailure;

export interface PreviewActor {
  readonly email: string;
}
/** O que a finalização conferiu e vai citar (ausente = só prova a durabilidade e que o livro está protegido). */
export interface DurabilityExpectation {
  readonly decisionsHead?: { readonly seq: number; readonly sha256: string } | null;
  /** Cabeça de DECISÕES do livro (§16.17.7), a mesma que o resultado grava como `ledgerHead`. */
  readonly ledgerHead?: { readonly ledgerSeq: number; readonly sha256: string } | null;
}
export type DurabilityOutcome = { readonly ok: true } | { readonly ok: false; readonly code: 'INPUT_CHANGED' | 'DURABILITY_UNKNOWN'; readonly issues: readonly string[] };
export interface PreviewDeps {
  readonly basisReader: { readScoringBasis(actor: PreviewActor, auditId: string): Promise<ScoringBasisOutcome> };
  readonly decisions: {
    list(actor: PreviewActor, auditId: string): Promise<ServiceResult<ListPayload>>;
    /** Barreira de durabilidade do livro antes de selar um resultado que o cita. AUSENTE ⇒ a finalização que cita o livro é recusada (falha fechada). */
    durabilityBarrier?(actor: PreviewActor, auditId: string, expected: DurabilityExpectation, now?: string | (() => string)): Promise<DurabilityOutcome>;
  };
  /** Relógio do SERVIDOR (ISO). Só alimenta as verificações de "data futura" do mapeador; nunca entra na entrada do motor. */
  readonly clock: () => string;
  /** Somente para testes que simulam recusas do motor; o padrão é o motor real. */
  readonly score?: (input: ScoringInput) => ScoreOutcome;
  /**
   * PROVA de que as evidências vieram da coleta (autenticidade, independente de a pasta de evidências estar íntegra). Padrão: FECHADA (nada é autêntico ⇒
   * `EVIDENCE_PROVENANCE_UNPROVEN` bloqueia a finalização). Integridade (SHA-256) NÃO substitui isto: quem escreve na pasta sela o que quiser.
   */
  readonly evidenceProvenance?: EvidenceProvenancePolicy;
}

export interface HeldDecision {
  readonly decisionId: string;
  readonly code: 'DECISION_NOT_SUPPORTED' | 'DECISION_NEEDS_SITE_SCOPE' | 'DECISION_CATEGORY_MISMATCH' | 'DECISION_BASIS_UNVERIFIABLE';
}

export interface PreviewSubcriterion {
  readonly id: string;
  readonly label: string;
  readonly maxHalfPoints: number;
  readonly source: string;
  readonly sourceReason: string | null;
  readonly state: string | null;
  readonly stateReason: string | null;
  readonly tier: string | null;
  readonly evaluatedHalfPoints: number | null;
  /** Ausente em registros INCONCLUSIVOS (nada que pareça nota); `null` quando o subcritério não foi avaliado (nunca 0 para ausência). */
  readonly obtainedHalfPoints?: number | null;
  readonly decisionIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly potential: { readonly family: string | null; readonly halfPoints: number };
}
export interface PreviewCriterion {
  readonly id: string;
  readonly label: string;
  readonly maxPoints: number;
  readonly status: string | null;
  readonly evaluatedHalfPoints: number | null;
  readonly obtainedHalfPoints?: number | null;
  readonly subcriteria: readonly PreviewSubcriterion[];
}

export interface PreviewPayload {
  readonly definitive: false;
  readonly auditId: string;
  readonly scoringAuditId: string | null;
  readonly auditIdAlias: Pick<AuditIdAlias, 'applied' | 'rule' | 'reason'> | null;
  readonly state: PreviewState;
  readonly company: {
    readonly located: boolean;
    readonly profileState: 'AVAILABLE' | 'UNAVAILABLE' | 'NO_EVIDENCE';
    readonly unavailableReason: string | null;
    readonly identityMatchedBy: { readonly cid: boolean; readonly placeId: boolean } | null;
    readonly websiteHost: string | null;
    readonly source: 'Serper (intermediário)';
  };
  readonly evidence: {
    readonly integrity: { readonly status: string; readonly checkedFiles: number | null };
    /** Autenticidade da coleta (≠ integridade): `null` sem evidência. Sem prova independente a finalização é bloqueada. */
    readonly provenance: { readonly status: 'AUTHENTICATED' | 'UNAUTHENTICATED'; readonly reason: EvidenceTrustReason | null; readonly missingRefs: readonly string[] } | null;
    readonly layout: 'VERSIONED' | 'LEGACY' | null;
    readonly referenceDate: string | null;
    readonly referenceDateSource: { readonly ref: string; readonly observedAt: string } | null;
    readonly profileSource: { readonly ref: string; readonly observedAt: string } | null;
    readonly bases: ReadonlyArray<{ readonly ref: string; readonly kind: string; readonly observedAt: string; readonly origin: string; readonly contentSha256: string; readonly legacy: boolean; readonly superseded: boolean }>;
  };
  readonly decisions: {
    /** Head das decisões CONFIRMADAS efetivamente consultado (o mesmo nas duas leituras). */
    readonly head: Head | null;
    readonly count: number;
    readonly pending: { readonly seq: number; readonly action: 'RECORD' | 'REVOKE'; readonly decisionId: string | null; readonly revokes: string | null; readonly supersedes: string | null; readonly recordedAt: string; readonly entrySha256: string } | null;
    readonly finalizable: boolean;
    /** Testemunha do histórico de decisões (cabeças já confirmadas em resultados selados). Não resolvida ⇒ nada é finalizável. */
    readonly witness: { readonly status: WitnessStatus; readonly knownHeads: number; readonly coveredSeq: number | null; readonly unwitnessedAffecting: number };
    /**
     * Livro de cabeças: só `PROTECTED` (ou `NOT_REQUIRED` nos testes da 6B isolada) permite finalizar. `head` = cauda do livro (exibição); `decisionHead` = cabeça de DECISÕES, a que vai
     * no resultado novo (`ledgerHead`) e a que a barreira compara (§16.17.7).
     */
    readonly ledger: { readonly state: LedgerState; readonly reason: LedgerReason | null; readonly head: { readonly ledgerSeq: number; readonly sha256: string } | null; readonly decisionHead: { readonly ledgerSeq: number; readonly sha256: string } | null; readonly confirmedDecisions: number; readonly operationOpen: boolean; readonly externalGuard: GuardStatus };
    readonly applied: readonly string[];
    readonly held: readonly HeldDecision[];
  };
  readonly decisionOptions: ReadonlyArray<{ readonly type: 'JUDGEMENT' | 'NOT_APPLICABLE'; readonly subcriterionId: string; readonly code: string | null; readonly available: boolean; readonly reasonCode: string | null }>;
  readonly criteria: readonly PreviewCriterion[];
  readonly outcomePreview: OutcomePreview | null;
  readonly result: Record<string, unknown> | null;
  readonly blockers: readonly PreviewBlocker[];
  readonly missing: ReadonlyArray<{ readonly family: string; readonly label: string; readonly potentialHalfPoints: number; readonly note: 'potencial, ainda não comprovado' }>;
  readonly finalization: { readonly allowed: boolean; readonly expectedHead: Head | null; readonly expectedInputSha256: string | null; readonly latest: null };
}

const READ_ATTEMPTS = 3;
const POTENTIAL_NOTE = 'potencial, ainda não comprovado' as const;
const FAMILY_LABEL: Readonly<Record<string, string>> = {
  M4A_EXCLUDED: 'Nota e volume de avaliações: fora do cálculo por política (M-4a) até haver fonte e verificação comprovadas',
  NOT_COLLECTED: 'Dados do painel do perfil, avaliações datadas, respostas e publicações ainda não coletados',
  SITE_NOT_READ: 'Leitura verificável do site',
  ADDRESS_NOT_STRUCTURED: 'Decomposição determinística validada do endereço',
  HOURS_NOT_STRUCTURED: 'Estruturação validada dos horários',
  NO_EXTERNAL_SOURCE: 'Fonte externa verificada de nome, endereço e telefone para comparação',
  COMPLETENESS_NOT_PROVEN: 'Prova de completude da lista de categorias adicionais',
  COMPETITORS_NOT_COLLECTED: 'Concorrentes verificados',
  AUTHORITY_NOT_COLLECTED: 'Prova externa de autoridade',
  AWAITING_OPERATOR_DECISION: 'Juízo do operador sobre a categoria principal (C2)',
  UTM_NOT_PROVEN: 'UTM completo comprovado no website configurado',
  NO_STORED_CAPTURE: 'Captura armazenada e íntegra com relatório',
};
const familyLabel = (family: string): string => FAMILY_LABEL[family] ?? 'Dado automático indisponível nesta coleta';

const fail = (code: PreviewFailureCode, head?: Head | null): PreviewFailure => ({ ok: false, code, issues: [], ...(head !== undefined ? { head } : {}) });

interface Snapshot {
  readonly decisions: ListPayload;
  readonly basis: Extract<ScoringBasisOutcome, { status: 'NO_EVIDENCE' | 'READY' }>;
  /** Autenticidade das evidências da base (`null` quando não há evidência). */
  readonly trust: EvidenceTrust | null;
}

export function createScoringPreviewService(deps: PreviewDeps) {
  const score = deps.score ?? scoreAudit;
  const provenance = deps.evidenceProvenance ?? CLOSED_EVIDENCE_PROVENANCE;

  async function snapshot(actor: PreviewActor, auditId: string): Promise<{ ok: true; value: Snapshot } | PreviewFailure> {
    const decisions = await deps.decisions.list(actor, auditId);
    if (!decisions.ok) return { ok: false, code: decisions.code, issues: decisions.issues, ...(decisions.head !== undefined ? { head: decisions.head } : {}) };
    const basis = await deps.basisReader.readScoringBasis(actor, auditId);
    if (basis.status === 'NOT_FOUND') return fail('AUDIT_NOT_FOUND');
    if (basis.status === 'INTEGRITY_FAILED') return fail('EVIDENCE_INTEGRITY');
    if (basis.status !== 'NO_EVIDENCE' && basis.status !== 'READY') return fail('INTERNAL_ERROR'); // estado que o leitor não produz: nunca é tratado como pronto
    // autenticidade: a política NUNCA lança (qualquer falha é "não autêntica"); o hash que o leitor recalculou é o que o manifesto assinado precisa cobrir
    let trust: EvidenceTrust | null = null;
    if (basis.status === 'READY') {
      if (!basis.basis || !Array.isArray(basis.basis.evidences)) return fail('INTERNAL_ERROR'); // forma que o leitor não produz: nunca é tratada como pronta
      trust = await provenance.classify(auditId, evidenceToProveFromBasis(basis.basis));
    }
    return { ok: true, value: { decisions: decisions.value, basis, trust } };
  }

  /** Mesmo `head`, mesma pendente, mesma lista de vigentes e a MESMA base (hash canônico do que o leitor entregou). */
  function fingerprint(s: Snapshot): string {
    return sha256Hex(canonicalJson({ head: s.decisions.head, pending: s.decisions.pending?.entrySha256 ?? null, finalizable: s.decisions.finalizable, operatorRecords: s.decisions.operatorRecords, basis: s.basis, trust: s.trust }));
  }

  const captureNumber = (ref: string): number | null => {
    const match = /^capture:c(\d{4})$/.exec(ref);
    return match ? Number(match[1]) : null;
  };

  /**
   * O juízo C2 só vale para a categoria que o operador viu. A 6B grava, dentro do arquivo âncorado, o número (N) e a data da captura
   * mais recente existente quando decidiu. A fonte do perfil hoje (S) é o máximo, por (data, número), sobre as capturas existentes;
   * se S já existia quando a decisão foi tomada (S ≤ N), S era a fonte também então (o máximo de um conjunto que a contém), logo a
   * categoria é a mesma. Falha fechada: N ausente, menor que S, ou captura N que não existe mais / mudou de data (restauração,
   * adulteração) ⇒ o juízo é retido. O vínculo é à CAPTURA, não ao texto da categoria (o registro da 6B não a traz). A interface
   * precisa mostrar o perfil da captura-fonte (`evidence.profileSource`), que é o que este vínculo supõe que o operador viu.
   */
  function c2Binding(dto: DecisionDto, basis: ReadyBasis): 'OK' | 'MISMATCH' | 'UNVERIFIABLE' {
    if (basis.profile.state !== 'AVAILABLE') return 'OK'; // sem categoria o juízo não tem efeito (o mapeador avisa)
    const source = captureNumber(basis.profile.source.ref);
    const stamped = dto.basis.capture;
    if (source === null || stamped === null || stamped < source) return 'MISMATCH';
    const evidence = basis.evidences.find((item) => item.kind === 'CAPTURE' && item.ref === `capture:c${String(stamped).padStart(4, '0')}`);
    if (!evidence || dto.basis.collectedAt === null || evidence.observedAt !== dto.basis.collectedAt) return 'UNVERIFIABLE';
    return 'OK';
  }

  function compute(auditId: string, s: Snapshot, fp: string): EvaluationResult {
    const { decisions } = s;
    if (decisions.auditId !== auditId) return fail('AUDIT_IDENTITY_MISMATCH');
    const pending = decisions.pending;
    const pendingSummary = pending
      ? { seq: pending.seq, action: pending.action, decisionId: pending.decisionId, revokes: pending.revokes, supersedes: pending.supersedes, recordedAt: pending.recordedAt, entrySha256: pending.entrySha256 }
      : null;
    const serviceBlockers: PreviewBlocker[] = [];
    // uma pendente nunca vale; se for REVOGAÇÃO, a decisão revogada continua vigente nos registros e fica marcada como "pode estar revogada"
    const witness = { status: decisions.witness.status, knownHeads: decisions.witness.knownHeads, coveredSeq: decisions.witness.coveredSeq, unwitnessedAffecting: decisions.witness.unwitnessedAffecting };
    const headOf = (head: { readonly ledgerSeq: number; readonly sha256: string } | null) => (head ? { ledgerSeq: head.ledgerSeq, sha256: head.sha256 } : null);
    const ledger = { state: decisions.ledger.state, reason: decisions.ledger.reason, head: headOf(decisions.ledger.head), decisionHead: headOf(decisions.ledger.decisionHead), confirmedDecisions: decisions.ledger.confirmedDecisions, operationOpen: decisions.ledger.openOperation !== null, externalGuard: decisions.ledger.externalGuard };
    // integridade do histórico NÃO resolvida (retrocesso/divergência/fonte ilegível): a 6B já devolve ZERO decisões vigentes; aqui o motivo é dito e a finalização bloqueada
    if (isUnresolved(witness.status)) serviceBlockers.push(previewBlocker('DECISIONS_HISTORY_UNRESOLVED', 'BLOCKING', { reasonCode: witness.status }));
    else if (isLedgerBlocking(ledger.state)) {
      serviceBlockers.push(previewBlocker('DECISIONS_HISTORY_UNRESOLVED', 'BLOCKING', { reasonCode: ledger.reason ?? ledger.state }));
      // recibo removido de decisão já confirmada pelo livro: o autor consegue concluir, então a pendência (e a decisão afetada) continua sendo dita
      if (pending) serviceBlockers.push(previewBlocker('DECISION_PENDING', 'BLOCKING', { decisionIds: [pending.revokes ?? pending.decisionId ?? ''].filter((id) => id !== '') }));
    }
    else if (pending) serviceBlockers.push(previewBlocker('DECISION_PENDING', 'BLOCKING', { decisionIds: [pending.revokes ?? pending.decisionId ?? ''].filter((id) => id !== '') }));
    else if (!decisions.finalizable) serviceBlockers.push(previewBlocker('DECISION_PENDING', 'BLOCKING', { reasonCode: 'FINALIZABLE_FALSE' })); // a 6B disse "não finalizar" sem apontar a pendente: nunca se ignora

    if (s.basis.status === 'NO_EVIDENCE') {
      serviceBlockers.push(previewBlocker('NO_STORED_CAPTURE', 'BLOCKING'));
      const view = CRITERIA_SOURCES.map((row): CriterionSourceView => ({ id: row.id, criterionId: row.criterionId, maxHalfPoints: row.maxHalfPoints, source: row.channel === 'BLOCKED' ? 'BLOQUEADO' : 'SEM_DADO', reasonCode: row.channel === 'BLOCKED' ? row.blockedReason : ('NO_STORED_CAPTURE' as never), factEmitted: false, evidenceRefs: [], decisionIds: [] }));
      const noEvidencePayload: PreviewPayload = {
          definitive: false,
          auditId,
          scoringAuditId: null,
          auditIdAlias: null,
          state: 'SEM_EVIDENCIA',
          company: { located: false, profileState: 'NO_EVIDENCE', unavailableReason: null, identityMatchedBy: null, websiteHost: null, source: 'Serper (intermediário)' },
          evidence: { integrity: { status: s.basis.integrity.status, checkedFiles: s.basis.integrity.checkedFiles }, provenance: null, layout: null, referenceDate: null, referenceDateSource: null, profileSource: null, bases: [] },
          decisions: { head: decisions.head, count: decisions.decisions.length, pending: pendingSummary, finalizable: decisions.finalizable, witness, ledger, applied: [], held: [] },
          decisionOptions: [],
          criteria: buildCriteria(view, null, null),
          outcomePreview: null,
          result: null,
          blockers: sortPreviewBlockers(serviceBlockers),
          missing: buildMissing(view),
          finalization: { allowed: false, expectedHead: decisions.head, expectedInputSha256: null, latest: null },
      };
      return { ok: true, value: { payload: noEvidencePayload, input: null, inputSha256: null, result: null, outcome: null, mapped: null, basis: null, decisions, applied: [], held: [], fingerprint: fp } };
    }

    const basis = s.basis.basis;
    if (basis.auditId !== auditId) return fail('AUDIT_IDENTITY_MISMATCH');
    // SEM prova independente de que as evidências vieram da coleta, nada é finalizável (a prévia continua consultável e rotulada)
    if (s.trust === null || s.trust.status !== 'AUTHENTICATED') serviceBlockers.push(previewBlocker('EVIDENCE_PROVENANCE_UNPROVEN', 'BLOCKING', { reasonCode: s.trust?.status === 'UNAUTHENTICATED' ? s.trust.reason : 'VERIFICATION_ERROR' }));

    /* decisões: aplicar ou RETER (campos estruturados; o alias nunca é usado para localizar nada) */
    const recordsById = new Map<string, OperatorRecord>(decisions.operatorRecords.map((record) => [record.id, record]));
    if (recordsById.size !== decisions.operatorRecords.length || decisions.decisions.length !== decisions.operatorRecords.length) return fail('INTERNAL_ERROR');
    const applied: OperatorRecord[] = [];
    const appliedStamps: Evaluation['applied'][number][] = [];
    const held: HeldDecision[] = [];
    for (const dto of decisions.decisions) {
      const record = recordsById.get(dto.decisionId);
      if (!record) return fail('INTERNAL_ERROR');
      let hold: HeldDecision['code'] | null = null;
      if (dto.siteDependent) hold = 'DECISION_NEEDS_SITE_SCOPE';
      else if (classifyOperatorRecord(record) === 'NOT_SUPPORTED') hold = 'DECISION_NOT_SUPPORTED';
      else if (record.kind === 'JUDGEMENT' && record.subcriterionId === 'C2') {
        const binding = c2Binding(dto, basis);
        if (binding === 'MISMATCH') hold = 'DECISION_CATEGORY_MISMATCH';
        else if (binding === 'UNVERIFIABLE') hold = 'DECISION_BASIS_UNVERIFIABLE';
      }
      if (hold) {
        held.push({ decisionId: dto.decisionId, code: hold });
      } else {
        applied.push(record);
        appliedStamps.push({ decisionId: dto.decisionId, kind: dto.kind, seq: dto.seq, stampCapture: dto.basis.capture, stampCollectedAt: dto.basis.collectedAt });
      }
    }
    for (const code of ['DECISION_NOT_SUPPORTED', 'DECISION_NEEDS_SITE_SCOPE', 'DECISION_CATEGORY_MISMATCH', 'DECISION_BASIS_UNVERIFIABLE'] as const) {
      const ids = held.filter((item) => item.code === code).map((item) => item.decisionId);
      if (ids.length > 0) serviceBlockers.push(previewBlocker(code, 'BLOCKING', { decisionIds: ids, subcriterionIds: ids.flatMap((id) => decisionTargets(recordsById.get(id) as OperatorRecord)) }));
    }

    const now = deps.clock();
    const mapped: AssembleResult = assembleScoringInput(basis, applied, { now });
    const aliasTrace = mapped.traceability.auditId;
    if (aliasTrace !== null && (!verifyAuditIdAlias(aliasTrace) || aliasTrace.sourceAuditId !== auditId)) return fail('AUDIT_IDENTITY_MISMATCH');

    const blockers: PreviewBlocker[] = [...serviceBlockers];
    for (const blocker of mapped.blockers) {
      if (blocker.code !== 'ENGINE_CONTRACT_REJECTED') {
        blockers.push(fromMapper(blocker));
        continue;
      }
      const attribution = attributeFailure(applied, (subset) => assembleScoringInput(basis, subset, { now }).blockers.some((item) => item.code === 'ENGINE_CONTRACT_REJECTED'));
      blockers.push({
        ...fromMapper(blocker, { decisionIds: attribution.ids, subcriterionIds: attribution.ids.flatMap((id) => decisionTargets(recordsById.get(id) as OperatorRecord)) }),
        reasonCode: attribution.independentOfDecisions ? 'NOT_CAUSED_BY_DECISIONS' : attribution.exact ? null : 'ATTRIBUTION_INCOMPLETE',
      });
    }

    let result: ScoreResult | null = null;
    if (mapped.input) {
      const scored = score(mapped.input);
      if (scored.ok) {
        const verified = verifyScoreResult(scored.result, mapped.input);
        if (!verified.ok) return fail('INTERNAL_ERROR');
        if (scored.result.auditId !== mapped.traceability.auditId?.scoringAuditId || scored.result.inputSha256 !== mapped.inputSha256) return fail('AUDIT_IDENTITY_MISMATCH');
        result = scored.result;
      } else {
        const attribution = attributeFailure(applied, (subset) => {
          const again = assembleScoringInput(basis, subset, { now });
          return again.input !== null && !score(again.input).ok;
        });
        blockers.push(
          previewBlocker('ENGINE_REJECTED_INPUT', 'BLOCKING', {
            decisionIds: attribution.ids,
            subcriterionIds: attribution.ids.flatMap((id) => decisionTargets(recordsById.get(id) as OperatorRecord)),
            ...(attribution.independentOfDecisions ? { reasonCode: 'NOT_CAUSED_BY_DECISIONS' } : attribution.exact ? {} : { reasonCode: 'ATTRIBUTION_INCOMPLETE' }),
          }),
        );
      }
    }

    const outcome = result ? deriveOutcome(result) : null;
    const sorted = sortPreviewBlockers(blockers);
    const allowed = result !== null && mapped.finalizable && held.length === 0 && decisions.finalizable && pending === null && !sorted.some((item) => item.severity === 'BLOCKING');
    const state: PreviewState = pending ? 'DECISAO_PENDENTE' : result === null ? 'ENTRADA_RECUSADA' : allowed ? 'CALCULADO_FINALIZAVEL' : 'CALCULADO_NAO_FINALIZAVEL';
    const profile = basis.profile;
    const website = mapped.input?.profile?.website?.[0]?.value;

    const payload: PreviewPayload = {
        definitive: false,
        auditId,
        scoringAuditId: mapped.traceability.auditId?.scoringAuditId ?? null,
        auditIdAlias: aliasTrace ? { applied: aliasTrace.applied, rule: aliasTrace.rule, reason: aliasTrace.reason } : null,
        state,
        company: {
          located: profile.state === 'AVAILABLE',
          profileState: profile.state,
          unavailableReason: profile.state === 'UNAVAILABLE' ? profile.reason : null,
          identityMatchedBy: profile.state === 'AVAILABLE' ? { cid: profile.identity.matchedBy.cid, placeId: profile.identity.matchedBy.placeId } : null,
          websiteHost: typeof website === 'string' ? hostOf(website) : null,
          source: 'Serper (intermediário)',
        },
        evidence: {
          integrity: { status: 'OK', checkedFiles: null },
          provenance: s.trust === null ? null : { status: s.trust.status, reason: s.trust.status === 'UNAUTHENTICATED' ? s.trust.reason : null, missingRefs: s.trust.status === 'UNAUTHENTICATED' ? [...(s.trust.missingRefs ?? [])] : [] },
          layout: basis.layout,
          referenceDate: mapped.traceability.referenceDate,
          referenceDateSource: mapped.traceability.referenceDateSource ? { ref: mapped.traceability.referenceDateSource.ref, observedAt: mapped.traceability.referenceDateSource.observedAt } : null,
          profileSource: profile.state === 'AVAILABLE' ? { ref: profile.source.ref, observedAt: profile.source.observedAt } : null,
          bases: [...basis.evidences]
            .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
            .map((e) => ({ ref: e.ref, kind: e.kind, observedAt: e.observedAt, origin: e.origin, contentSha256: e.contentSha256, legacy: e.legacy, superseded: e.superseded })),
        },
        decisions: {
          head: decisions.head,
          count: decisions.decisions.length,
          pending: pendingSummary,
          finalizable: decisions.finalizable,
          witness,
          ledger,
          applied: applied.map((record) => record.id),
          held,
        },
        decisionOptions: buildOptions(mapped.criteriaView, decisions.decisions),
        criteria: buildCriteria(mapped.criteriaView, result, outcome),
        outcomePreview: outcome,
        result: result && outcome ? toPublicView(result, outcome) : null,
        blockers: sorted,
        missing: buildMissing(mapped.criteriaView),
        finalization: { allowed, expectedHead: decisions.head, expectedInputSha256: mapped.input ? mapped.inputSha256 : null, latest: null },
    };
    return { ok: true, value: { payload, input: mapped.input, inputSha256: mapped.input ? mapped.inputSha256 : null, result, outcome, mapped, basis, decisions, applied: appliedStamps, held, fingerprint: fp } };
  }

  /** Duas leituras que concordam (até 3 tentativas) e então o cálculo. Base de `preview` e da finalização. */
  async function evaluate(actor: PreviewActor, auditId: string): Promise<EvaluationResult> {
    if (typeof auditId !== 'string' || !AUDIT_ID_PATTERN.test(auditId)) return fail('INVALID_PARAMS');
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
      const first = await snapshot(actor, auditId);
      if (!first.ok) return first;
      const second = await snapshot(actor, auditId);
      if (!second.ok) return second;
      try {
        const fp = fingerprint(first.value);
        if (fp === fingerprint(second.value)) return compute(auditId, first.value, fp);
      } catch {
        return fail('INTERNAL_ERROR'); // forma inesperada vinda dos leitores: falha fechada, sem detalhe
      }
    }
    return fail('READ_INCONSISTENT');
  }

  return {
    evaluate,
    /** Prévia da pontuação. Nunca grava; nunca é definitiva; só o `auditId` vem do cliente. */
    async preview(actor: PreviewActor, auditId: string): Promise<PreviewResult> {
      const evaluated = await evaluate(actor, auditId);
      return evaluated.ok ? { ok: true, value: evaluated.value.payload } : evaluated;
    },
    /** Barreira de durabilidade antes de selar/concluir um resultado que cita o livro (falha fechada se a dependência não existir). */
    async durabilityBarrier(actor: PreviewActor, auditId: string, expected: DurabilityExpectation): Promise<DurabilityOutcome> {
      if (typeof auditId !== 'string' || !AUDIT_ID_PATTERN.test(auditId)) return { ok: false, code: 'DURABILITY_UNKNOWN', issues: ['auditId inválido.'] };
      const barrier = deps.decisions.durabilityBarrier;
      if (!barrier) return { ok: false, code: 'DURABILITY_UNKNOWN', issues: ['A barreira de durabilidade não está disponível: nada é selado citando o livro.'] };
      try {
        return await barrier.call(deps.decisions, actor, auditId, expected, deps.clock);
      } catch {
        return { ok: false, code: 'DURABILITY_UNKNOWN', issues: ['A barreira de durabilidade falhou: nada é selado.'] };
      }
    },
    /** Impressão digital de UMA leitura nova (head, pendente, registros e base): a finalização a compara com a da avaliação antes de publicar. */
    async fingerprintNow(actor: PreviewActor, auditId: string): Promise<{ readonly ok: true; readonly fingerprint: string } | PreviewFailure> {
      if (typeof auditId !== 'string' || !AUDIT_ID_PATTERN.test(auditId)) return fail('INVALID_PARAMS');
      const read = await snapshot(actor, auditId);
      if (!read.ok) return read;
      try {
        return { ok: true, fingerprint: fingerprint(read.value) };
      } catch {
        return fail('INTERNAL_ERROR');
      }
    },
  };
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

function buildOptions(view: readonly CriterionSourceView[], decisions: readonly DecisionDto[]): PreviewPayload['decisionOptions'] {
  const c2 = view.find((row) => row.id === 'C2');
  const hasC2 = decisions.some((dto) => dto.record.kind === 'JUDGEMENT' && dto.record.subcriterionId === 'C2');
  const available = c2 !== undefined && c2.factEmitted && c2.source !== 'BLOQUEADO';
  return [
    { type: 'JUDGEMENT', subcriterionId: 'C2', code: null, available, reasonCode: !available ? (c2?.reasonCode ?? 'BASIS_MISSING') : hasC2 ? 'EXISTING_DECISION_REPLACE' : null },
    { type: 'NOT_APPLICABLE', subcriterionId: 'S4', code: 'BUSINESS_MODEL', available: true, reasonCode: decisions.some((dto) => dto.record.kind === 'NOT_APPLICABLE' && dto.record.subcriterionIds.includes('S4')) ? 'EXISTING_DECISION_REPLACE' : null },
  ];
}

const POTENTIAL_STATES = new Set(['BLOQUEADO', 'SEM_DADO']);
function potentialOf(row: CriterionSourceView, state: string | null): { family: string | null; halfPoints: number } {
  const open = state !== 'SCORED' && state !== 'NOT_APPLICABLE' && state !== 'ABSENCE_PROVEN';
  const waiting = row.source === 'DECISAO_HUMANA' && row.reasonCode === 'AWAITING_OPERATOR_DECISION';
  if (open && (POTENTIAL_STATES.has(row.source) || waiting) && row.reasonCode !== null) return { family: row.reasonCode, halfPoints: row.maxHalfPoints };
  return { family: null, halfPoints: 0 };
}

/** @internal exportada só para teste. */
export function buildCriteria(view: readonly CriterionSourceView[], result: ScoreResult | null, outcome: OutcomePreview | null): PreviewCriterion[] {
  const showPoints = outcome?.outcome === 'PONTUADO';
  const labels = new Map(SUBCRITERIA.map((def) => [def.id as string, def.label]));
  return CRITERIA.map((criterion) => {
    const engineCriterion = result?.criteria.find((item) => item.id === criterion.id);
    const subcriteria: PreviewSubcriterion[] = view
      .filter((row) => row.criterionId === criterion.id)
      .map((row) => {
        const engine = result?.subcriteria.find((item) => item.id === row.id);
        return {
          id: row.id,
          label: labels.get(row.id) ?? row.id,
          maxHalfPoints: row.maxHalfPoints,
          source: row.source,
          sourceReason: row.reasonCode,
          state: engine?.state ?? null,
          stateReason: engine?.reasonCode ?? null,
          tier: engine && engine.state === 'SCORED' ? engine.tier : null,
          evaluatedHalfPoints: engine?.evaluatedHalfPoints ?? null,
          ...(showPoints && engine ? { obtainedHalfPoints: obtainedPointsOfSubcriterion(engine) } : {}),
          decisionIds: row.decisionIds,
          evidenceRefs: row.evidenceRefs,
          potential: potentialOf(row, engine?.state ?? null),
        };
      });
    return {
      id: criterion.id,
      label: criterion.label,
      maxPoints: criterion.maxWeight,
      status: engineCriterion?.status ?? null,
      evaluatedHalfPoints: engineCriterion?.evaluatedHalfPoints ?? null,
      ...(showPoints && engineCriterion ? { obtainedHalfPoints: obtainedPointsOfCriterion(engineCriterion) } : {}),
      subcriteria,
    };
  });
}

function buildMissing(view: readonly CriterionSourceView[]): PreviewPayload['missing'] {
  const totals = new Map<string, number>();
  for (const row of view) {
    const potential = potentialOf(row, null);
    if (potential.family !== null) totals.set(potential.family, (totals.get(potential.family) ?? 0) + potential.halfPoints);
  }
  return [...totals]
    .map(([family, potentialHalfPoints]) => ({ family, label: familyLabel(family), potentialHalfPoints, note: POTENTIAL_NOTE }))
    .sort((a, b) => b.potentialHalfPoints - a.potentialHalfPoints || (a.family < b.family ? -1 : 1));
}
