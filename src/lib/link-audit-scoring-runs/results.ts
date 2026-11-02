import path from 'node:path';
import type { WebsiteExpectation } from '../link-audit-evidence/scoring-basis';
import { judgeOrigin, originStatusOf, type OriginAuthenticator, type OriginStatus, type OriginVerdict } from '../link-audit-origin';
import { STORE_AUDIT_ID } from './audit-id-alias';
import type { PreviewBlocker } from './blockers';
import { MINIMUM_COVERAGE_PERCENT } from './outcome';
import { PREVIEW_HTTP_STATUS, PREVIEW_MESSAGE, type Evaluation, type PreviewActor, type PreviewFailure, type PreviewFailureCode } from './preview';
import { appendRun, assertResultsBase, nodeFsOps, probeDirectory, readRunLog, type FsOps, type RunAnchorSummary, type StoreErrorCode } from './results-store';
import { finalizeBodySchema, INTEGRITY_NOTE, RUN_FILE_KIND, RUN_SCHEMA_VERSION, type RunHead as Head, type ScoreRun, type ScoreRunDraft } from './results-types';
import { toPublicRun, verifyRunRecord } from './results-verify';
import { MAPPER_VERSION } from './types';

/*
 * Finalização e consulta dos RESULTADOS (Onda 6C, I4). Um resultado só nasce de uma avaliação (a MESMA da prévia: leitura dupla
 * concordante, decisões CONFIRMADAS, mapeador I2, motor, `verifyScoreResult`) e só é gravado se TODAS as condições abaixo valerem.
 * Nada vem do cliente além do que ele VIU (`expectedHead`, `expectedInputSha256`); autor e hora vêm da sessão e do servidor.
 *
 * POLÍTICA DE CONCORRÊNCIA E REVALIDAÇÃO (explícita):
 *  1. Trava por auditoria (em processo) + `link()` exclusivo do arquivo `sNNNN` (entre processos). Perdendo a corrida, relê e reavalia
 *     (até 5×): nunca grava sobre estado desatualizado.
 *  2. DENTRO da trava: reenvio idêntico? → senão avalia (leitura dupla) → confere `expectedHead` e `expectedInputSha256` → confere os
 *     bloqueios → RECHECA o website bruto (`rawSha256`) → confere se alguma evidência já usada em resultado anterior mudou de hash
 *     (captura trocada com o mesmo número e a mesma data) → relê UMA vez mais a impressão digital (head + pendente + registros + base)
 *     e exige que seja a da avaliação → só então monta, valida semanticamente e publica.
 *  3. O resultado grava o `head` das decisões e os hashes das evidências REALMENTE usados. Entre a última releitura e o `link()` resta
 *     uma janela inevitável (as pastas de evidências e de decisões não compartilham trava): o registro continua verdadeiro SOBRE o
 *     estado que ele grava e fica detectavelmente DESATUALIZADO (`stale`) se algo mudar depois. Depois do recibo há uma última
 *     releitura que avisa (`stateChangedAfterFinalization`) se o estado já mudou.
 *  4. Mesmo pedido (mesmo `inputSha256` e `head`) duas vezes ⇒ 200 `replayed`, um só resultado. Duas finalizações simultâneas do
 *     mesmo estado ⇒ um resultado. Pendente (sem recibo): só é concluída pelo autor AUTENTICADO e SE o servidor comprovar a ORIGEM do
 *     arquivo (etiqueta HMAC com chave fora das pastas) e o registro ainda se explicar (ver `link-audit-origin`). O pedido de reenvio
 *     vem da interface a partir do próprio arquivo, então NÃO é prova de nada: um arquivo forjado numa pasta nunca vira confirmado.
 *  5. O relógio do cliente nunca é fonte de verdade: `finalizedAt` é do servidor e monotônico.
 */
export type ResultsFailureCode =
  | PreviewFailureCode
  | 'NOT_FINALIZABLE'
  | 'INPUT_CHANGED'
  | 'RESULT_PENDING_UNCONFIRMED'
  | 'RESULT_PENDING_ORIGIN_UNPROVEN'
  | 'ORIGIN_KEY_NOT_CONFIGURED'
  | 'RESULT_ANCHOR_PENDING'
  | 'RESULTS_NOT_CONFIGURED'
  | 'RESULT_ANCHOR_NOT_CONFIGURED'
  | 'RESULTS_MISCONFIGURED'
  | 'RESULTS_STORAGE_UNAVAILABLE'
  | 'RESULT_ANCHOR_STORAGE_UNAVAILABLE'
  | 'RESULT_INTEGRITY'
  | 'RESULT_TRUNCATED'
  | 'RESULT_ANCHOR_MISMATCH'
  | 'RESULT_ANCHOR_INTEGRITY'
  | 'RESULT_NOT_FOUND'
  | 'RESULTS_LIMIT_REACHED'
  | 'RESULT_WRITE_CONFLICT'
  | 'WEBSITE_DERIVATION_MISMATCH'
  | 'EVIDENCE_HASH_CHANGED';

export const RESULTS_HTTP_STATUS: Readonly<Record<ResultsFailureCode, number>> = Object.freeze({
  ...PREVIEW_HTTP_STATUS,
  NOT_FINALIZABLE: 409,
  INPUT_CHANGED: 409,
  RESULT_PENDING_UNCONFIRMED: 409,
  RESULT_PENDING_ORIGIN_UNPROVEN: 409,
  ORIGIN_KEY_NOT_CONFIGURED: 503,
  RESULT_ANCHOR_PENDING: 503,
  RESULTS_NOT_CONFIGURED: 503,
  RESULT_ANCHOR_NOT_CONFIGURED: 503,
  RESULTS_MISCONFIGURED: 503,
  RESULTS_STORAGE_UNAVAILABLE: 503,
  RESULT_ANCHOR_STORAGE_UNAVAILABLE: 503,
  RESULT_INTEGRITY: 409,
  RESULT_TRUNCATED: 409,
  RESULT_ANCHOR_MISMATCH: 409,
  RESULT_ANCHOR_INTEGRITY: 409,
  RESULT_NOT_FOUND: 404,
  RESULTS_LIMIT_REACHED: 409,
  RESULT_WRITE_CONFLICT: 409,
  WEBSITE_DERIVATION_MISMATCH: 409,
  EVIDENCE_HASH_CHANGED: 409,
});

export const RESULTS_MESSAGE: Readonly<Record<ResultsFailureCode, string>> = Object.freeze({
  ...PREVIEW_MESSAGE,
  NOT_FINALIZABLE: 'A prévia não é finalizável: há bloqueios, decisão pendente ou a entrada foi recusada. Nada foi gravado.',
  INPUT_CHANGED: 'A entrada do motor mudou desde a prévia que você viu. Nada foi gravado; recarregue a prévia.',
  RESULT_PENDING_UNCONFIRMED: 'Há um resultado gravado e ainda não confirmado (sem recibo) nesta auditoria; só o autor, reenviando o mesmo pedido, o conclui. Nada foi gravado.',
  RESULT_PENDING_ORIGIN_UNPROVEN: 'A origem deste resultado pendente NÃO pôde ser comprovada pelo servidor (arquivo adulterado, forjado, anterior à proteção ou de outra chave). Ele NÃO pode ser concluído por esta tela e nenhum recibo foi gravado; siga o procedimento de quarentena.',
  ORIGIN_KEY_NOT_CONFIGURED: 'A chave de comprovação de origem dos resultados não está configurada (ou é fraca) neste servidor; nenhum resultado é gravado ou concluído.',
  RESULT_ANCHOR_PENDING: 'O resultado foi gravado, mas o recibo NÃO foi confirmado: ele ainda NÃO vale. Reenvie o MESMO pedido (é seguro repetir) para concluir.',
  RESULTS_NOT_CONFIGURED: 'O armazenamento de resultados não está configurado neste servidor.',
  RESULT_ANCHOR_NOT_CONFIGURED: 'O armazenamento de recibos de resultados não está configurado neste servidor; nenhum resultado é gravado.',
  RESULTS_MISCONFIGURED: 'O armazenamento de resultados ou de recibos está configurado de forma insegura (pastas iguais, aninhadas ou em área pública).',
  RESULTS_STORAGE_UNAVAILABLE: 'O armazenamento de resultados não está disponível neste servidor.',
  RESULT_ANCHOR_STORAGE_UNAVAILABLE: 'O armazenamento de recibos de resultados não está disponível neste servidor; nenhum resultado foi gravado.',
  RESULT_INTEGRITY: 'O histórico de resultados desta auditoria não passa na verificação de integridade; nenhum dado é exibido.',
  RESULT_TRUNCATED: 'O histórico de resultados está MENOR do que os recibos registram (arquivos removidos ou restaurados de cópia antiga); nenhum dado é exibido.',
  RESULT_ANCHOR_MISMATCH: 'Um resultado não confere com o recibo gravado na pasta separada (arquivo reescrito ou substituído); nenhum dado é exibido.',
  RESULT_ANCHOR_INTEGRITY: 'Os recibos de resultados desta auditoria não passam na verificação de integridade; nenhum dado é exibido.',
  RESULT_NOT_FOUND: 'Resultado não encontrado.',
  RESULTS_LIMIT_REACHED: 'Limite de resultados por auditoria atingido.',
  RESULT_WRITE_CONFLICT: 'Outro processo gravou ao mesmo tempo; nada foi sobrescrito. Tente novamente.',
  WEBSITE_DERIVATION_MISMATCH: 'O website derivado não confere com a evidência bruta íntegra reaberta agora. Nada foi gravado.',
  EVIDENCE_HASH_CHANGED: 'Uma evidência já usada em um resultado anterior mudou de conteúdo (mesmo número, outro hash). Nada foi gravado.',
});

const STORE_TO_RESULTS: Readonly<Record<StoreErrorCode, ResultsFailureCode>> = Object.freeze({
  INVALID_ID: 'INVALID_PARAMS',
  UNSAFE_PATH: 'RESULTS_MISCONFIGURED',
  STORAGE_MISSING: 'RESULTS_STORAGE_UNAVAILABLE',
  ANCHOR_MISSING: 'RESULT_ANCHOR_STORAGE_UNAVAILABLE',
  CORRUPT: 'RESULT_INTEGRITY',
  HASH_MISMATCH: 'RESULT_INTEGRITY',
  CHAIN_BROKEN: 'RESULT_INTEGRITY',
  SEQUENCE_GAP: 'RESULT_INTEGRITY',
  SCHEMA: 'RESULT_INTEGRITY',
  SEMANTIC: 'RESULT_INTEGRITY',
  TRUNCATED: 'RESULT_TRUNCATED',
  ANCHOR_MISMATCH: 'RESULT_ANCHOR_MISMATCH',
  ANCHOR_INTEGRITY: 'RESULT_ANCHOR_INTEGRITY',
  CONFLICT: 'RESULT_WRITE_CONFLICT',
  LIMIT_REACHED: 'RESULTS_LIMIT_REACHED',
  WRITE_FAILED: 'RESULTS_STORAGE_UNAVAILABLE',
  ANCHOR_WRITE_FAILED: 'RESULT_ANCHOR_STORAGE_UNAVAILABLE',
  ATOMIC_WRITE_UNAVAILABLE: 'RESULTS_STORAGE_UNAVAILABLE',
  STORAGE_FATAL: 'RESULTS_STORAGE_UNAVAILABLE',
  INTERNAL: 'INTERNAL_ERROR',
});
/** Detalhes de integridade ajudam o operador; detalhes de disco/caminho nunca saem. */
const DETAILED: ReadonlySet<ResultsFailureCode> = new Set(['RESULT_INTEGRITY', 'RESULT_TRUNCATED', 'RESULT_ANCHOR_MISMATCH', 'RESULT_ANCHOR_INTEGRITY', 'INVALID_PARAMS', 'EVIDENCE_HASH_CHANGED']);

export interface PendingRunDto {
  readonly seq: number;
  readonly finalizedAt: string;
  /**
   * ORIGEM comprovada pelo SERVIDOR (etiqueta HMAC com chave fora das pastas): `PROVEN`; `UNPROVEN` (sem etiqueta, adulterada, forjada ou
   * de outra chave: NÃO pode ser concluída); `UNVERIFIABLE` (este servidor não tem chave para comprovar). O arquivo, sozinho, nunca prova nada.
   */
  readonly origin: OriginStatus;
  /** Por que não foi comprovada (`null` quando comprovada). Não revela a etiqueta nem a chave. */
  readonly originDetail: Exclude<OriginVerdict, 'PROVEN'> | null;
  /** Origem COMPROVADA e o autor autenticado é DESTA sessão. Nunca derivado só do campo `finalizedBy` do arquivo; o e-mail de ninguém é revelado. */
  readonly isMine: boolean;
  /** Estado ESTRUTURADO para todos os perfis: o recibo falta (gravação interrompida OU recibo removido: indistinguíveis) e isso bloqueia novas finalizações. Nunca é confirmação. */
  readonly receipt: 'MISSING';
  readonly blocksFinalization: true;
  /** `outcome`, `level`, `coveragePercent` e `appliedDecisionCount` só são informados quando a origem foi comprovada (senão o conteúdo é do arquivo, não do servidor). */
  readonly outcome: 'PONTUADO' | 'INCONCLUSIVO' | null;
  readonly level: string | null;
  readonly coveragePercent: number | null;
  readonly appliedDecisionCount: number | null;
  readonly inputSha256: string;
  /** Head das decisões gravado: com `inputSha256`, é o pedido que o autor precisa reenviar para concluir. */
  readonly decisionsHead: Head | null;
  /** A entrada gravada é a MESMA de hoje? `false` = o resultado já nasce histórico; `null` = não foi possível comparar agora. */
  readonly matchesCurrent: boolean | null;
  readonly contentSha256: string;
}

export interface ResultsFailure {
  readonly ok: false;
  readonly code: ResultsFailureCode;
  readonly issues: readonly string[];
  /** `NOT_FINALIZABLE`: os bloqueios (mensagens fixas, ids de decisão). */
  readonly blockers?: readonly PreviewBlocker[];
  /** Head ATUAL das decisões nas recusas de `expectedHead` (para recarregar). */
  readonly head?: Head | null;
  readonly pending?: PendingRunDto;
}

export interface RunSummaryDto {
  readonly seq: number;
  readonly finalizedAt: string;
  readonly finalizedBy: string;
  readonly outcome: 'PONTUADO' | 'INCONCLUSIVO';
  readonly level: string | null;
  readonly reasonCode: string | null;
  readonly coveragePercent: number;
  readonly inputSha256: string;
  readonly resultSha256: string;
  readonly contentSha256: string;
  readonly decisionsHead: Head | null;
  /** Há um resultado mais novo confirmado. */
  readonly superseded: boolean;
  /** Só para o mais recente: a entrada ATUAL do motor difere da gravada (DESATUALIZADO). `null` = não foi possível recalcular agora. */
  readonly stale: boolean | null;
  /** Só para o mais recente: o head das decisões CONFIRMADAS de hoje difere do gravado (indicador SEPARADO de `stale`: uma decisão nova pode não alterar a entrada e ainda assim tornar o resultado histórico). */
  readonly decisionsChanged: boolean | null;
}

export interface ListRunsPayload {
  readonly definitive: true;
  readonly auditId: string;
  readonly results: readonly RunSummaryDto[];
  /** Head da cadeia de RESULTADOS confirmados. */
  readonly head: Head | null;
  readonly pending: PendingRunDto | null;
  readonly anchors: RunAnchorSummary;
  readonly currentInputSha256: string | null;
  readonly currentDecisionsHead: Head | null;
  readonly integrity: { readonly status: 'OK'; readonly algorithm: 'SHA-256'; readonly checkedFiles: number; readonly note: string };
}

export interface RunDetailPayload {
  readonly stale: boolean | null;
  readonly decisionsChanged: boolean | null;
  readonly superseded: boolean;
  readonly run: Record<string, unknown>;
}

export interface FinalizePayload {
  readonly definitive: true;
  readonly replayed: boolean;
  /** Head da cadeia de resultados confirmados depois desta operação. */
  readonly head: Head;
  readonly anchored: true;
  /** O estado (decisões/evidências) já mudou DEPOIS da gravação? No reenvio compara com HOJE; `null` = não foi possível comparar. O resultado continua válido para o estado que grava. */
  readonly stateChangedAfterFinalization: boolean | null;
  /** `true` quando este pedido CONCLUIU o recibo de um resultado que ficara pendente (a gravação foi anterior; o resultado pode já ser histórico). */
  readonly recoveredPending: boolean;
  readonly run: Record<string, unknown>;
}

export interface BasisRecheck {
  verifyWebsiteDerivation(actor: PreviewActor, auditId: string, expected: WebsiteExpectation): Promise<'MATCH' | 'MISMATCH' | 'NOT_AVAILABLE'>;
}
export interface PreviewEvaluator {
  evaluate(actor: PreviewActor, auditId: string): Promise<{ readonly ok: true; readonly value: Evaluation } | PreviewFailure>;
  fingerprintNow(actor: PreviewActor, auditId: string): Promise<{ readonly ok: true; readonly fingerprint: string } | PreviewFailure>;
}

export interface ResultsDeps {
  readonly preview: PreviewEvaluator;
  readonly basisReader: BasisRecheck;
  /** GMN_LINK_AUDIT_RESULTS_DIR e GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR: pastas dedicadas, absolutas, existentes. */
  readonly baseDir: string;
  readonly anchorDir: string;
  /** Pastas das outras raízes (evidências, decisões, âncoras das decisões): nenhuma pode ser igual ou aninhada às de resultados. */
  readonly otherDirs?: readonly string[];
  /** Relógio do SERVIDOR (ISO UTC com milissegundos). */
  readonly clock: () => string;
  readonly fs?: FsOps;
  readonly projectRoot?: string;
  /**
   * Autenticador de ORIGEM (chave do servidor FORA das pastas de dados). Com ele, os resultados novos saem assinados e uma pendente só é
   * concluída com a etiqueta válida. Sem ele nenhuma pendente é concluída (falha fechada) e a origem fica `UNVERIFIABLE`.
   */
  readonly origin?: OriginAuthenticator;
}

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const failure = (code: ResultsFailureCode, ...issues: string[]): ResultsFailure => ({ ok: false, code, issues });

/*
 * A verificação semântica custa alguns milissegundos por registro (reexecuta o motor). Um registro é IMUTÁVEL e `contentSha256` é
 * recalculado a cada leitura (`readSealedFile`), então ele identifica o conteúdo exato: uma verificação BEM-SUCEDIDA vale para o
 * resto do processo. Só sucessos são lembrados; qualquer alteração muda o hash e é verificada de novo.
 */
const VERIFIED = new Set<string>();
const VERIFIED_CAP = 4096;
function explains(run: ScoreRun): boolean {
  if (VERIFIED.has(run.contentSha256)) return true;
  if (verifyRunRecord(run).length > 0) return false;
  if (VERIFIED.size >= VERIFIED_CAP) VERIFIED.clear();
  VERIFIED.add(run.contentSha256);
  return true;
}
const unexplained = (runs: readonly ScoreRun[]): ResultsFailure | null => {
  const bad = runs.find((run) => !explains(run));
  return bad ? failure('RESULT_INTEGRITY', `${String(bad.seq).padStart(4, '0')}: o registro não se explica a partir de si mesmo.`) : null;
};
const sameHead = (a: Head | null, b: Head | null): boolean => (a === null || b === null ? a === b : a.seq === b.seq && a.sha256 === b.sha256);
/** Quem olha e o que se sabe de HOJE: a origem da pendente é julgada pelo servidor; `currentInputSha256` (se conhecido) diz se ela já nasce histórica. */
interface Viewer {
  readonly operator: string | null;
  readonly origin: OriginAuthenticator | undefined;
  readonly currentInputSha256?: string | null;
}
const pendingOf = (run: ScoreRun, viewer: Viewer): PendingRunDto => {
  const verdict = judgeOrigin(viewer.origin, 'RUN', run);
  const proven = verdict === 'PROVEN';
  const totals = (run.result as { totals?: { coveragePercent?: unknown } }).totals;
  const coverage = run.inconclusive?.coveragePercent ?? (typeof totals?.coveragePercent === 'number' ? totals.coveragePercent : null);
  return {
    seq: run.seq,
    finalizedAt: run.finalizedAt,
    origin: originStatusOf(verdict),
    originDetail: proven ? null : verdict,
    receipt: 'MISSING',
    blocksFinalization: true,
    isMine: proven && viewer.operator !== null && run.finalizedBy === viewer.operator,
    outcome: proven ? run.outcome : null,
    level: proven ? (run.scored?.level ?? null) : null,
    coveragePercent: proven ? coverage : null,
    appliedDecisionCount: proven ? run.decisions.appliedIds.length : null,
    inputSha256: run.inputSha256,
    decisionsHead: run.decisions.head,
    matchesCurrent: viewer.currentInputSha256 === undefined || viewer.currentInputSha256 === null ? null : viewer.currentInputSha256 === run.inputSha256,
    contentSha256: run.contentSha256,
  };
};
const chainHead = (runs: readonly ScoreRun[]): Head | null => {
  const last = runs[runs.length - 1];
  return last ? { seq: last.seq, sha256: last.contentSha256 } : null;
};

export function createScoringResultsService(deps: ResultsDeps) {
  const ops = deps.fs ?? nodeFsOps;
  const projectRoot = deps.projectRoot ?? process.cwd();
  const storeOptions = { fs: ops, projectRoot, anchorDir: deps.anchorDir };
  const viewerOf = (actor: PreviewActor, currentInputSha256?: string | null): Viewer => ({ operator: operatorOf(actor), origin: deps.origin, ...(currentInputSha256 !== undefined ? { currentInputSha256 } : {}) });

  async function realOrResolved(dir: string): Promise<string> {
    try {
      return (await ops.realpath(dir)).toLowerCase();
    } catch {
      return path.resolve(dir).toLowerCase();
    }
  }

  /** Bases válidas e SEPARADAS: resultados, recibos e as outras raízes (nenhuma igual, nenhuma dentro da outra). */
  async function checkConfiguration(): Promise<ResultsFailure | null> {
    const results = assertResultsBase(deps.baseDir, projectRoot);
    const anchors = assertResultsBase(deps.anchorDir, projectRoot);
    if (!results.ok || !anchors.ok) return failure('RESULTS_MISCONFIGURED');
    const resolved = [await realOrResolved(results.value), await realOrResolved(anchors.value)];
    const results2 = resolved.length;
    for (const other of deps.otherDirs ?? []) resolved.push(await realOrResolved(other));
    const inside = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep);
    for (let i = 0; i < results2; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        if (inside(resolved[i] as string, resolved[j] as string) || inside(resolved[j] as string, resolved[i] as string)) return failure('RESULTS_MISCONFIGURED');
      }
    }
    return null;
  }

  const validAuditId = (value: unknown): value is string => typeof value === 'string' && STORE_AUDIT_ID.test(value);
  const operatorOf = (actor: PreviewActor): string | null => {
    const email = typeof actor?.email === 'string' ? actor.email.trim().toLowerCase() : '';
    return email.length > 0 && email.length <= 254 && EMAIL.test(email) ? email : null;
  };
  const fromStore = (error: { readonly code: StoreErrorCode; readonly issues: readonly string[] }): ResultsFailure => {
    const code = STORE_TO_RESULTS[error.code];
    return failure(code, ...(DETAILED.has(code) ? error.issues : []));
  };

  /** Evidências já usadas em resultado anterior (confirmado ou pendente) têm o hash FIXADO: mudar de conteúdo com o mesmo número/data é adulteração. */
  function changedPinnedEvidence(all: readonly ScoreRun[], current: ReadonlyArray<{ readonly ref: string; readonly contentSha256: string; readonly bodySha256: string | null }>): string[] {
    const pinned = new Map<string, { content: string; body: string | null }>();
    for (const run of all) for (const item of run.evidenceBasis) if (!pinned.has(item.ref)) pinned.set(item.ref, { content: item.contentSha256, body: item.bodySha256 });
    const now = new Map(current.map((item) => [item.ref, item]));
    const problems: string[] = [];
    for (const [ref, before] of pinned) {
      const item = now.get(ref);
      if (!item) problems.push(`ausente: ${ref}`); // evidência já usada que sumiu (cauda removida): os resultados anteriores funcionam como manifesto
      else if (before.content !== item.contentSha256 || before.body !== item.bodySha256) problems.push(`mudou: ${ref}`);
    }
    return problems;
  }

  /** Mudança desde a gravação, por DOIS indicadores separados (nunca por relógio): a entrada do motor × o estado das decisões (head, pendente, finalizável). */
  function drift(now: Awaited<ReturnType<PreviewEvaluator['evaluate']>>, run: ScoreRun): { stale: boolean | null; decisionsChanged: boolean | null } {
    if (!now.ok) return { stale: null, decisionsChanged: null };
    const decisions = now.value.decisions;
    return {
      // entrada de hoje recusada/inexistente = a entrada gravada não é mais a de hoje
      stale: now.value.inputSha256 === null ? true : now.value.inputSha256 !== run.inputSha256,
      decisionsChanged: !sameHead(decisions.head, run.decisions.head) || decisions.pending !== null || !decisions.finalizable,
    };
  }

  /** Conclusão de uma pendente: as evidências que ela cita precisam existir HOJE com os mesmos hashes (senão o recibo não é dado). */
  function pendingEvidenceProblems(run: ScoreRun, ev: Evaluation): string[] {
    const current = ev.mapped?.traceability.evidences ?? [];
    return changedPinnedEvidence([run], current);
  }

  function draftFrom(evaluation: Evaluation, operator: string, finalizedAt: string): ScoreRunDraft | null {
    const { input, result, outcome, mapped, basis, decisions } = evaluation;
    const alias = mapped?.traceability.auditId;
    const referenceDateSource = mapped?.traceability.referenceDateSource;
    if (!input || !result || !outcome || !mapped || !basis || !alias || !referenceDateSource || evaluation.inputSha256 === null) return null;
    const website = mapped.traceability.websiteDerivation;
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    return {
      schemaVersion: RUN_SCHEMA_VERSION,
      kind: RUN_FILE_KIND,
      auditId: alias.sourceAuditId,
      finalizedAt,
      finalizedBy: operator,
      outcome: outcome.outcome,
      scored: outcome.outcome === 'PONTUADO' && outcome.level ? { level: outcome.level } : null,
      inconclusive: outcome.outcome === 'INCONCLUSIVO' && outcome.reasonCode ? { reasonCode: outcome.reasonCode, failedGates: [...outcome.failedGates], coveragePercent: outcome.coveragePercent, minimumCoveragePercent: MINIMUM_COVERAGE_PERCENT } : null,
      scoringAuditId: alias.scoringAuditId,
      auditIdAlias: { applied: alias.applied, rule: alias.rule, reason: alias.reason, sourceAuditId: alias.sourceAuditId },
      decisions: { head: decisions.head, count: decisions.decisions.length, appliedIds: evaluation.applied.map((item) => item.decisionId), applied: evaluation.applied.map((item) => ({ ...item })) },
      layout: basis.layout,
      evidenceBasis: mapped.traceability.evidences.map((item) => ({ ref: item.ref, kind: item.kind, observedAt: item.observedAt, contentSha256: item.contentSha256, bodySha256: item.bodySha256, legacy: item.legacy, superseded: item.superseded })),
      profileSource: basis.profile.state === 'AVAILABLE' ? { ref: basis.profile.source.ref, observedAt: basis.profile.source.observedAt, contentSha256: basis.profile.source.contentSha256, bodySha256: basis.profile.source.bodySha256 } : null,
      referenceDate: input.referenceDate,
      referenceDateSource: { ref: referenceDateSource.ref, observedAt: referenceDateSource.observedAt, rule: referenceDateSource.rule },
      websiteDerivation: website ? { rule: website.rule, rawSha256: website.rawSha256, sourceEvidence: { ...website.sourceEvidence }, utmLevel: website.utmLevel, x5Proof: website.x5Proof } : null,
      mapperVersion: MAPPER_VERSION,
      methodologyVersion: result.methodologyVersion,
      scoreModelVersion: result.scoreModelVersion,
      rulerFingerprint: result.rulerFingerprint,
      input: clone(input) as unknown as Record<string, unknown>,
      result: clone(result) as unknown as Record<string, unknown>,
      inputSha256: evaluation.inputSha256,
      resultSha256: result.resultSha256,
    };
  }

  return {
    /** Finaliza: grava o resultado imutável e o recibo, ou recusa sem gravar nada. */
    async finalize(actor: PreviewActor, auditId: string, rawBody: unknown): Promise<{ readonly ok: true; readonly value: FinalizePayload } | ResultsFailure> {
      if (!validAuditId(auditId)) return failure('INVALID_PARAMS', 'auditId inválido.');
      const operator = operatorOf(actor);
      if (operator === null) return failure('OPERATOR_IDENTITY_INVALID');
      const viewer = viewerOf(actor);
      if (!ISO_MS.test(deps.clock())) return failure('INTERNAL_ERROR');
      const config = await checkConfiguration();
      if (config) return config;
      if (!deps.origin) return failure('ORIGIN_KEY_NOT_CONFIGURED'); // sem autenticador de origem nada é gravado (as rotas já respondem 503)
      if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) return failure('INVALID_BODY');
      const extra = Object.keys(rawBody).filter((key) => key !== 'expectedHead' && key !== 'expectedInputSha256');
      if (extra.length > 0) return failure('FORBIDDEN_FIELDS', ...extra.slice(0, 10).map((key) => `campo não aceito: ${key.slice(0, 40)}`));
      const parsed = finalizeBodySchema.safeParse(rawBody);
      if (!parsed.success) return failure('INVALID_BODY');
      const { expectedHead, expectedInputSha256 } = parsed.data;

      let evaluated: Evaluation | null = null;
      let concludedPending = false;
      const appended = await appendRun<ResultsFailure>(
        deps.baseDir,
        auditId,
        async (ctx) => {
          const reject = (f: ResultsFailure): { ok: false; failure: ResultsFailure } => ({ ok: false, failure: f });
          // 1. reenvio idêntico (mesmo `inputSha256` e mesmo `head` das decisões) do último arquivo publicado
          const last = ctx.all[ctx.all.length - 1];
          if (last && last.inputSha256 === expectedInputSha256 && sameHead(last.decisions.head, expectedHead)) {
            if (last === ctx.pending && last.finalizedBy !== operator) return reject({ ...failure('RESULT_PENDING_UNCONFIRMED'), pending: pendingOf(last, viewer) });
            concludedPending = last === ctx.pending;
            if (concludedPending) {
              // CONCLUIR uma pendente = dar o recibo a um arquivo que vive numa pasta que quem escreve nela controla por inteiro. Camadas,
              // todas FECHADAS: (1) ORIGEM comprovada pelo servidor (etiqueta HMAC com chave fora das pastas; "autor" no arquivo não prova nada);
              // (2) o registro se explica (reexecuta o motor sobre a entrada gravada); (3) as evidências citadas existem HOJE com os mesmos hashes;
              // (4) o histórico de decisões não regrediu desde o head gravado. O pedido do operador (`expectedHead`/`expectedInputSha256`) vem da
              // interface a partir do próprio arquivo: NÃO é prova de nada.
              if (judgeOrigin(deps.origin, 'RUN', last) !== 'PROVEN') return reject({ ...failure('RESULT_PENDING_ORIGIN_UNPROVEN'), pending: pendingOf(last, viewer) });
              if (!explains(last)) return reject(failure('RESULT_INTEGRITY')); // nunca se dá recibo a um registro que não se explica
              const now = await deps.preview.evaluate(actor, auditId);
              if (!now.ok) return reject({ ...failure(now.code, ...now.issues), ...(now.head !== undefined ? { head: now.head } : {}) });
              // (2b) a conclusão também DEPENDE das evidências e do histórico de decisões: sem prova de coleta, ou com a integridade do histórico NÃO resolvida, ninguém dá recibo (falha fechada)
              if (now.value.payload.blockers.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' || b.code === 'DECISIONS_HISTORY_UNRESOLVED')) return reject({ ...failure('NOT_FINALIZABLE'), blockers: now.value.payload.blockers });
              const problems = pendingEvidenceProblems(last, now.value);
              if (problems.length > 0) return reject(failure('EVIDENCE_HASH_CHANGED', ...problems.slice(0, 10)));
              const gravado = last.decisions.head;
              const hoje = now.value.decisions.head;
              if (gravado !== null && (hoje === null || hoje.seq < gravado.seq)) return reject({ ...failure('HISTORY_REGRESSED'), head: hoje });
            } else if (!explains(last)) return reject(failure('RESULT_INTEGRITY')); // reenvio de um CONFIRMADO: nada é gravado, mas só se devolve o que se explica
            return { ok: true, replayOf: last.seq };
          }
          if (ctx.pending) return reject({ ...failure('RESULT_PENDING_UNCONFIRMED'), pending: pendingOf(ctx.pending, viewer) });

          // 2. avaliação (leitura dupla concordante) e confronto com o que o operador viu
          const ev = await deps.preview.evaluate(actor, auditId);
          if (!ev.ok) return reject({ ...failure(ev.code, ...ev.issues), ...(ev.head !== undefined ? { head: ev.head } : {}) });
          evaluated = ev.value;
          const current = ev.value.decisions.head;
          if (!sameHead(current, expectedHead)) {
            const regressed = expectedHead !== null && (current === null || current.seq < expectedHead.seq);
            return reject({ ...failure(regressed ? 'HISTORY_REGRESSED' : 'HEAD_MISMATCH'), head: current });
          }
          if (ev.value.inputSha256 !== expectedInputSha256) return reject(failure('INPUT_CHANGED'));
          // 3. bloqueios (inclui pendente, retidas, atribuição incompleta, entrada recusada): nada disso é finalizável
          if (!ev.value.payload.finalization.allowed || ev.value.payload.blockers.some((b) => b.severity === 'BLOCKING')) {
            return reject({ ...failure('NOT_FINALIZABLE'), blockers: ev.value.payload.blockers });
          }
          // 4. recheca do website BRUTO íntegro, só no servidor
          const emitted = ev.value.input?.profile?.website?.[0]?.value;
          if (emitted !== undefined) {
            if (emitted === null) return reject(failure('WEBSITE_DERIVATION_MISMATCH')); // o mapeador nunca envia website nulo
            const profile = ev.value.basis?.profile;
            const website = profile && profile.state === 'AVAILABLE' ? profile.website : null;
            if (!profile || profile.state !== 'AVAILABLE' || !website || website.state !== 'DERIVED' || website.derived !== emitted || !website.utm) return reject(failure('WEBSITE_DERIVATION_MISMATCH'));
            const verdict = await deps.basisReader.verifyWebsiteDerivation(actor, auditId, { sourceRef: profile.source.ref, rawSha256: website.derivation.rawSha256, derived: emitted, utmLevel: website.utm.level });
            if (verdict !== 'MATCH') return reject(failure('WEBSITE_DERIVATION_MISMATCH'));
          }
          // 5. evidência já usada em resultado anterior não pode ter mudado de conteúdo
          const changed = changedPinnedEvidence(ctx.all, ev.value.mapped?.traceability.evidences ?? []);
          if (changed.length > 0) return reject(failure('EVIDENCE_HASH_CHANGED', ...changed.slice(0, 10)));
          // 6. última releitura ANTES de publicar: precisa ser exatamente a da avaliação
          const again = await deps.preview.fingerprintNow(actor, auditId);
          if (!again.ok) return reject({ ...failure(again.code, ...again.issues) });
          if (again.fingerprint !== ev.value.fingerprint) return reject(failure('INPUT_CHANGED'));
          // 7. montagem
          const draft = draftFrom(ev.value, operator, ctx.finalizedAt);
          if (!draft) return reject(failure('INTERNAL_ERROR'));
          return { ok: true, draft };
        },
        { ...storeOptions, now: deps.clock, validate: (sealed) => verifyRunRecord(sealed), ...(deps.origin ? { origin: deps.origin } : {}) },
      );

      if (appended.ok) {
        // releitura INFORMATIVA depois do recibo: uma exceção aqui nunca pode transformar um sucesso durável em erro
        let changedAfter: boolean | null = null;
        try {
          if (!appended.replayed && evaluated) {
            const after = await deps.preview.fingerprintNow(actor, auditId);
            changedAfter = !after.ok || after.fingerprint !== (evaluated as Evaluation).fingerprint;
          } else if (appended.replayed) {
            const moved = drift(await deps.preview.evaluate(actor, auditId), appended.run);
            changedAfter = moved.stale === null || moved.decisionsChanged === null ? null : moved.stale || moved.decisionsChanged;
          }
        } catch {
          changedAfter = appended.replayed ? null : true;
        }
        const last = appended.runs[appended.runs.length - 1] ?? appended.run;
        return { ok: true, value: { definitive: true, replayed: appended.replayed, head: { seq: last.seq, sha256: last.contentSha256 }, anchored: true, stateChangedAfterFinalization: changedAfter, recoveredPending: concludedPending, run: toPublicRun(appended.run).detail } };
      }
      if (appended.code === 'REJECTED') return appended.failure;
      if (appended.code === 'ANCHOR_PENDING') return { ...failure('RESULT_ANCHOR_PENDING'), pending: pendingOf(appended.pending, viewer) };
      if (appended.code === 'PENDING_UNCONFIRMED') return { ...failure('RESULT_PENDING_UNCONFIRMED'), pending: pendingOf(appended.pending, viewer) };
      if (appended.code === 'ORIGIN_UNPROVEN') return { ...failure('RESULT_PENDING_ORIGIN_UNPROVEN'), pending: pendingOf(appended.pending, viewer) };
      return fromStore(appended as unknown as { readonly code: StoreErrorCode; readonly issues: readonly string[] });
    },

    /** Lista os resultados CONFIRMADOS (verificados por inteiro) e a pendente à parte. Falha de integridade ⇒ nenhum dado. */
    async list(actor: PreviewActor, auditId: string): Promise<{ readonly ok: true; readonly value: ListRunsPayload } | ResultsFailure> {
      if (!validAuditId(auditId)) return failure('INVALID_PARAMS', 'auditId inválido.');
      const config = await checkConfiguration();
      if (config) return config;
      const read = await readRunLog(deps.baseDir, auditId, storeOptions);
      if (!read.ok) return fromStore(read);
      const inconsistent = unexplained(read.value.runs);
      if (inconsistent) return inconsistent;
      const now = await deps.preview.evaluate(actor, auditId);
      // resultados já selados e verificados continuam consultáveis mesmo que a base atual não possa ser relida (`stale: null`); sem nenhum resultado, a auditoria inexistente é 404
      if (!now.ok && now.code === 'AUDIT_NOT_FOUND' && read.value.runs.length === 0 && read.value.pending === null) return failure('AUDIT_NOT_FOUND');
      const currentInputSha256 = now.ok ? now.value.inputSha256 : null;
      const currentDecisionsHead = now.ok ? now.value.decisions.head : null;
      const runs = read.value.runs;
      const results: RunSummaryDto[] = runs.map((run, index) => {
        const latest = index === runs.length - 1;
        const outcome = toPublicRun(run).outcomePreview;
        return {
          seq: run.seq,
          finalizedAt: run.finalizedAt,
          finalizedBy: run.finalizedBy,
          outcome: run.outcome,
          level: run.scored?.level ?? null,
          reasonCode: run.inconclusive?.reasonCode ?? null,
          coveragePercent: outcome.coveragePercent,
          inputSha256: run.inputSha256,
          resultSha256: run.resultSha256,
          contentSha256: run.contentSha256,
          decisionsHead: run.decisions.head,
          superseded: !latest,
          stale: latest ? drift(now, run).stale : null,
          decisionsChanged: latest ? drift(now, run).decisionsChanged : null,
        };
      });
      return {
        ok: true,
        value: {
          definitive: true,
          auditId,
          results,
          head: chainHead(runs),
          pending: read.value.pending ? pendingOf(read.value.pending, viewerOf(actor, currentInputSha256)) : null,
          anchors: read.value.anchors,
          currentInputSha256,
          currentDecisionsHead,
          integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles: read.value.checkedFiles, note: INTEGRITY_NOTE },
        },
      };
    },

    /** Um resultado CONFIRMADO, verificado (selo, bytes, recibos, encadeamento e semântica), em projeção pública. */
    async get(actor: PreviewActor, auditId: string, seq: number): Promise<{ readonly ok: true; readonly value: RunDetailPayload } | ResultsFailure> {
      if (!validAuditId(auditId) || !Number.isInteger(seq) || seq < 1) return failure('INVALID_PARAMS', 'Parâmetros inválidos.');
      const config = await checkConfiguration();
      if (config) return config;
      const read = await readRunLog(deps.baseDir, auditId, storeOptions);
      if (!read.ok) return fromStore(read);
      const runs = read.value.runs;
      const run = runs.find((item) => item.seq === seq);
      if (!run) return read.value.pending?.seq === seq ? { ...failure('RESULT_PENDING_UNCONFIRMED'), pending: pendingOf(read.value.pending, viewerOf(actor)) } : failure('RESULT_NOT_FOUND');
      const inconsistent = unexplained(runs); // consulta INTEGRAL: um registro inconsistente em qualquer posição invalida a consulta inteira
      if (inconsistent) return inconsistent;
      const latest = runs[runs.length - 1] === run;
      let stale: boolean | null = null;
      let decisionsChanged: boolean | null = null;
      if (latest) {
        const now = await deps.preview.evaluate(actor, auditId);
        ({ stale, decisionsChanged } = drift(now, run));
      }
      return { ok: true, value: { stale, decisionsChanged, superseded: !latest, run: toPublicRun(run).detail } };
    },
  };
}

export type ScoringResultsService = ReturnType<typeof createScoringResultsService>;

/**
 * Fornece à 6B as CABEÇAS CONHECIDAS do histórico de decisões (testemunha independente; R3-MINOR-2, R4-MINOR-1, INFO-1), a partir dos resultados em OUTRAS
 * pastas. Três classes, que NUNCA se misturam:
 *  - `heads` (testemunhas): o `decisions.head` de cada resultado CONFIRMADO (resultado + recibo) e o do resultado PENDENTE cuja ORIGEM o servidor comprova
 *    com uma chave em vigor (atual ou aposentada dentro da validade). Remover o recibo do resultado não apaga a testemunha enquanto a origem for comprovável;
 *  - `unverifiedHeads` (INDÍCIOS): o head de um resultado PENDENTE cuja origem NÃO é comprovada — forjado, ou assinado por chave aposentada VENCIDA,
 *    REVOGADA ou desconhecida, ou lido por um servidor sem autenticador. Um indício NUNCA é testemunha e uma chave comprometida NUNCA o torna confiável;
 *    a 6B só o usa para DENUNCIAR: se ele afirma uma posição que o histórico de hoje não tem (ou outra entrada), a testemunha deixa de ser confiável;
 *  - falha explícita (nunca "lista vazia"): `NOT_CONFIGURED` (caminho inseguro/ausente), `STORAGE_UNAVAILABLE` (não leu), `UNTRUSTED` (a cadeia de
 *    resultados não confere: adulterada, truncada, recibos incoerentes).
 * Sem resultados em pasta legível e configurada ⇒ `{ ok: true, heads: [] }` (a 6B diz `UNWITNESSED`: a testemunha ainda não existe; não é garantia).
 */
/** Mesma forma estrutural que a 6B espera (a 6C NÃO importa as decisões). */
export type KnownHeadsProvider = (
  auditId: string,
) => Promise<
  | { readonly ok: true; readonly heads: ReadonlyArray<{ readonly seq: number; readonly sha256: string }>; readonly unverifiedHeads?: ReadonlyArray<{ readonly seq: number; readonly sha256: string }> }
  | { readonly ok: false; readonly reason: 'NOT_CONFIGURED' | 'STORAGE_UNAVAILABLE' | 'UNTRUSTED' }
>;

const INTEGRITY_CODES: ReadonlySet<StoreErrorCode> = new Set(['CORRUPT', 'HASH_MISMATCH', 'CHAIN_BROKEN', 'SEQUENCE_GAP', 'SCHEMA', 'SEMANTIC', 'TRUNCATED', 'ANCHOR_MISMATCH', 'ANCHOR_INTEGRITY']);
/**
 * O armazenamento rotula erro de leitura/listagem do sistema operacional (EIO, EACCES, exceção desconhecida…) como `CORRUPT` (resultados) ou `ANCHOR_INTEGRITY`
 * (recibos) com "leitura: E…" / "listagem … : E…" / "listagem: DESCONHECIDO …": isso é DISPONIBILIDADE, não adulteração. Só diagnóstico: as duas classes falham fechado.
 */
const READ_ERRNO = /\b(?:leitura|listagem)[^:]*: (?:E[A-Z0-9]+|DESCONHECIDO)\b/;

export interface ResultsKnownHeadsOptions {
  readonly baseDir: string;
  readonly anchorDir: string;
  /**
   * Pastas que NÃO podem coincidir nem se aninhar com as duas acima (decisões, recibos das decisões, evidências, manifestos): sobreposição ⇒ `NOT_CONFIGURED`.
   * OBRIGATÓRIO (pode ser `[]` só em testes da própria primitiva): esquecer a defesa seria configuração insegura lida como "sem inconsistência" (INFO-1).
   */
  readonly otherDirs: ReadonlyArray<string | null | undefined>;
  readonly fs?: FsOps;
  readonly projectRoot?: string;
  readonly origin?: OriginAuthenticator;
}

/** Duas pastas da testemunha iguais ou aninhadas (inclusive por link simbólico) anulam a separação resultado × recibo: configuração inválida. */
async function overlappingDirs(dirs: readonly string[], ops: FsOps): Promise<boolean> {
  const real = async (target: string): Promise<string> => {
    try {
      return (await ops.realpath(target)).toLowerCase();
    } catch {
      return path.resolve(target).toLowerCase();
    }
  };
  const resolved = await Promise.all(dirs.map(real));
  return resolved.some((a, i) => resolved.some((b, j) => i !== j && (a === b || a.startsWith(b + path.sep))));
}

export function createResultsKnownHeads(options: ResultsKnownHeadsOptions): KnownHeadsProvider {
  return async (auditId) => {
    try {
      const ops = options.fs ?? nodeFsOps;
      const others = options.otherDirs.filter((dir): dir is string => typeof dir === 'string' && dir !== '');
      if (await overlappingDirs([options.baseDir, options.anchorDir, ...others], ops)) return { ok: false, reason: 'NOT_CONFIGURED' };
      // Sonda das pastas ANTES da leitura, para distinguir "não consigo ler" (armazenamento indisponível) de "não é um diretório comum" (configuração insegura):
      // o armazenamento rotula as duas coisas como UNSAFE_PATH. Raiz ausente ou erro de E/S ⇒ UNAVAILABLE; existe e não é diretório/é link ⇒ NOT_CONFIGURED.
      if (path.isAbsolute(options.baseDir) && path.isAbsolute(options.anchorDir)) {
        const subdirs = typeof auditId === 'string' && STORE_AUDIT_ID.test(auditId) ? [path.join(options.baseDir, auditId), path.join(options.anchorDir, auditId)] : [];
        for (const [dir, mustExist] of [[options.baseDir, true], [options.anchorDir, true], ...subdirs.map((sub): [string, boolean] => [sub, false])] as Array<[string, boolean]>) {
          const probed = await probeDirectory(ops, dir, mustExist);
          if (probed) return { ok: false, reason: probed };
        }
      }
      const read = await readRunLog(options.baseDir, auditId, { anchorDir: options.anchorDir, ...(options.fs ? { fs: options.fs } : {}), ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}) });
      if (!read.ok) {
        if (read.code === 'UNSAFE_PATH') return { ok: false, reason: 'NOT_CONFIGURED' };
        if ((read.code === 'CORRUPT' || read.code === 'ANCHOR_INTEGRITY') && read.issues.some((issue) => READ_ERRNO.test(issue))) return { ok: false, reason: 'STORAGE_UNAVAILABLE' };
        return { ok: false, reason: INTEGRITY_CODES.has(read.code) ? 'UNTRUSTED' : 'STORAGE_UNAVAILABLE' };
      }
      const headOf = (run: ScoreRun): { seq: number; sha256: string }[] => (run.decisions.head ? [{ seq: run.decisions.head.seq, sha256: run.decisions.head.sha256 }] : []);
      const pending = read.value.pending;
      const proven = pending !== null && judgeOrigin(options.origin, 'RUN', pending) === 'PROVEN';
      return {
        ok: true,
        heads: [...read.value.runs.flatMap(headOf), ...(pending && proven ? headOf(pending) : [])],
        unverifiedHeads: pending && !proven ? headOf(pending) : [],
      };
    } catch {
      return { ok: false, reason: 'STORAGE_UNAVAILABLE' };
    }
  };
}
