import path from 'node:path';
import type { WebsiteExpectation } from '../link-audit-evidence/scoring-basis';
import { judgeOrigin, originStatusOf, type OriginAuthenticator, type OriginStatus, type OriginVerdict } from '../link-audit-origin';
import { STORE_AUDIT_ID } from './audit-id-alias';
import type { PreviewBlocker } from './blockers';
import { MINIMUM_COVERAGE_PERCENT } from './outcome';
import { PREVIEW_HTTP_STATUS, PREVIEW_MESSAGE, type DurabilityExpectation, type DurabilityOutcome, type Evaluation, type LedgerReason, type LedgerView, type PreviewActor, type PreviewFailure, type PreviewFailureCode, type ResultsLedgerPort, type ResultsLedgerRead, type RunDraft, type RunRefusal, type RunStep } from './preview';
import { appendRun, assertResultsBase, isDurabilityUnknown, nodeFsOps, probeDirectory, readRunLog, type FsOps, type RunAnchorSummary, type RunLedgerContextGate, type RunLedgerGate, type RunLedgerHooks, type RunLog, type StoreErrorCode } from './results-store';
import { finalizeBodySchema, INTEGRITY_NOTE, RUN_FILE_KIND, RUN_SCHEMA_VERSION, RUN_SCHEMA_VERSION_LEDGER, type RunHead as Head, type ScoreRun, type ScoreRunDraft } from './results-types';
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
  | 'RESULT_DURABILITY_UNKNOWN'
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
  RESULT_DURABILITY_UNKNOWN: 503,
  WEBSITE_DERIVATION_MISMATCH: 409,
  EVIDENCE_HASH_CHANGED: 409,
});

export const RESULTS_MESSAGE: Readonly<Record<ResultsFailureCode, string>> = Object.freeze({
  ...PREVIEW_MESSAGE,
  NOT_FINALIZABLE: 'A prévia não é finalizável: há bloqueios, decisão pendente ou a entrada foi recusada. Nada foi gravado.',
  INPUT_CHANGED: 'A entrada do motor mudou desde a prévia que você viu. Nada foi gravado; recarregue a prévia.',
  RESULT_PENDING_UNCONFIRMED: 'Há um resultado gravado e ainda não confirmado nesta auditoria (sem recibo ou sem a confirmação do livro de cabeças); só o autor, reenviando o mesmo pedido, o conclui. Nada foi gravado.',
  RESULT_PENDING_ORIGIN_UNPROVEN: 'A origem deste resultado pendente NÃO pôde ser comprovada pelo servidor (arquivo adulterado, forjado, anterior à proteção ou de outra chave). Ele NÃO pode ser concluído por esta tela e nenhum recibo foi gravado; siga o procedimento de quarentena.',
  ORIGIN_KEY_NOT_CONFIGURED: 'A chave de comprovação de origem dos resultados não está configurada (ou é fraca) neste servidor; nenhum resultado é gravado ou concluído.',
  RESULT_ANCHOR_PENDING: 'O resultado foi gravado, mas o recibo ou a confirmação no livro de cabeças NÃO foi concluído: ele ainda NÃO vale e bloqueia novas finalizações. Só o autor, reenviando o MESMO pedido (é seguro repetir), o conclui.',
  RESULTS_NOT_CONFIGURED: 'O armazenamento de resultados não está configurado neste servidor.',
  RESULT_ANCHOR_NOT_CONFIGURED: 'O armazenamento de recibos de resultados não está configurado neste servidor; nenhum resultado é gravado.',
  RESULTS_MISCONFIGURED: 'O armazenamento de resultados ou de recibos está configurado de forma insegura (pastas iguais, aninhadas ou em área pública).',
  // D-17 (R1.5): as consultas também dependem do livro de cabeças (sem ele, ou com ele ilegível, nada é exibido)
  RESULTS_STORAGE_UNAVAILABLE: 'O armazenamento de resultados, ou o livro de cabeças que os confirma, não está disponível neste servidor; nenhum resultado foi gravado ou exibido.',
  RESULT_ANCHOR_STORAGE_UNAVAILABLE: 'O armazenamento de recibos de resultados não está disponível neste servidor; nenhum resultado foi gravado.',
  RESULT_INTEGRITY: 'O histórico de resultados desta auditoria não passa na verificação de integridade; nenhum dado é exibido.',
  RESULT_TRUNCATED: 'O histórico de resultados está MENOR do que os recibos registram (arquivos removidos ou restaurados de cópia antiga); nenhum dado é exibido.',
  RESULT_ANCHOR_MISMATCH: 'Um resultado não confere com o recibo gravado na pasta separada (arquivo reescrito ou substituído); nenhum dado é exibido.',
  RESULT_ANCHOR_INTEGRITY: 'Os recibos de resultados desta auditoria não passam na verificação de integridade; nenhum dado é exibido.',
  RESULT_NOT_FOUND: 'Resultado não encontrado.',
  RESULTS_LIMIT_REACHED: 'Limite de resultados por auditoria atingido.',
  RESULT_WRITE_CONFLICT: 'A gravação não pôde ser concluída com segurança agora (outro processo gravou ao mesmo tempo ou a operação passou do prazo seguro); nada foi publicado nem sobrescrito. Tente novamente.',
  RESULT_DURABILITY_UNKNOWN: 'A durabilidade do livro, do resultado ou do recibo NÃO foi comprovada. Isto NÃO é sucesso e nenhum resultado foi confirmado; as escritas ficam interrompidas até o servidor reiniciar — depois, reenvie o MESMO pedido.',
  WEBSITE_DERIVATION_MISMATCH: 'O website derivado não confere com a evidência bruta íntegra reaberta agora. Nada foi gravado.',
  EVIDENCE_HASH_CHANGED: 'Uma evidência já usada em um resultado anterior mudou de conteúdo (mesmo número, outro hash). Nada foi gravado.',
  // D-17 (R1.3): a gravação do RUN_INTENT falhou — o texto das decisões (que fala de decisão) não serve aqui
  LEDGER_UNAVAILABLE: 'O livro de cabeças não pôde ser gravado; nenhum resultado foi publicado.',
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
  /**
   * Estado ESTRUTURADO para todos os perfis, e NUNCA confirmação (bloqueia novas finalizações nos dois casos): `MISSING` = o recibo falta (gravação interrompida OU recibo
   * removido: indistinguíveis); `PRESENT` = fase C do livro (R1.5, spec §16.17.9, D-18): o recibo existe, mas o livro de cabeças não confirmou — só o autor conclui.
   */
  readonly receipt: 'MISSING' | 'PRESENT';
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

/**
 * O que confirma os resultados devolvidos (R1.5; spec §16.17.9, MINOR-4, D-23): `LEDGER` = cada objeto devolvido como confirmado tem o hash do `RUN_CONFIRMED` do livro de
 * cabeças (conferido no PRÓPRIO objeto); `RECEIPT_ONLY` = confirmado só por recibo, sem prova do livro (auditoria legada ou sem o livro, `NOT_REQUIRED`) — a tela diz isso e a
 * Onda 7 (PDF) o recusa. Marcador UNIFORME no topo da lista e do detalhe.
 */
export type ResultsConfirmation = 'LEDGER' | 'RECEIPT_ONLY';

export interface ListRunsPayload {
  readonly definitive: true;
  readonly auditId: string;
  readonly confirmation: ResultsConfirmation;
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
  readonly confirmation: ResultsConfirmation;
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
  /** Barreira de durabilidade do livro, chamada DENTRO da trava de finalização, antes de montar um resultado que cita `ledgerHead` (ou de concluir um pendente). */
  durabilityBarrier(actor: PreviewActor, auditId: string, expected: DurabilityExpectation): Promise<DurabilityOutcome>;
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
  /**
   * PORTA DE ESCRITA DO LIVRO (R1.3, D-R1-3; spec §16.17.3): com ela, toda finalização em auditoria protegida grava `RUN_INTENT` ANTES de publicar o resultado e `RUN_CONFIRMED`
   * DEPOIS do recibo durável (fsync estrito de resultados e recibos), e só então responde sucesso. AUSENTE ⇒ o comportamento de antes (recibo = confirmação) e as
   * consultas marcadas `RECEIPT_ONLY` (R1.5, RL-26). Com ela, as consultas exigem o livro (`view`): cada objeto devolvido como confirmado tem o hash do `RUN_CONFIRMED`. As rotas
   * sempre a ligam (`scoring/shared.ts`).
   */
  readonly ledger?: ResultsLedgerPort;
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

/* ------------------------------------------------------------------ finalização pelo livro (R1.3; spec §16.17.3) */

/** Tentativas de casar R0 com a vista do livro antes de acusar (uma corrida legítima só acrescenta e se resolve na releitura; persistente ⇒ `RESULT_INTEGRITY`). */
const OBJECT_LEDGER_ATTEMPTS = 3;
const OBJECT_LEDGER_MISMATCH = 'livro: os resultados lidos não são os que o livro de cabeças confirma (objeto diferente, ausente ou fora do livro); nada foi gravado.';
/** Recusa de um passo do livro ⇒ código público dos resultados (nenhum código novo, D-11). */
const RUN_TO_RESULTS: Readonly<Record<RunRefusal['code'], ResultsFailureCode>> = Object.freeze({
  STALE_INPUT: 'INPUT_CHANGED',
  RUNS_UNRESOLVED: 'RESULT_INTEGRITY',
  RUN_DEADLINE: 'RESULT_WRITE_CONFLICT',
  RUN_CLOSED: 'RESULT_WRITE_CONFLICT',
  DURABILITY_UNKNOWN: 'RESULT_DURABILITY_UNKNOWN',
  PENDING_UNCONFIRMED: 'RESULT_PENDING_UNCONFIRMED',
  LEDGER_ENROLLMENT_REQUIRED: 'LEDGER_ENROLLMENT_REQUIRED',
  LEDGER_LEGACY_READ_ONLY: 'LEDGER_LEGACY_READ_ONLY',
  LEDGER_NOT_CONFIGURED: 'LEDGER_NOT_CONFIGURED',
  DECISIONS_HISTORY_UNRESOLVED: 'DECISIONS_HISTORY_UNRESOLVED',
  LEDGER_OPERATION_IN_PROGRESS: 'LEDGER_OPERATION_IN_PROGRESS',
  LEDGER_UNAVAILABLE: 'LEDGER_UNAVAILABLE',
  LEDGER_CAPACITY_EXHAUSTED: 'LEDGER_CAPACITY_EXHAUSTED',
  LEDGER_GUARD_UNAVAILABLE: 'LEDGER_GUARD_UNAVAILABLE',
  ADMIN_APPROVAL_UNAVAILABLE: 'ADMIN_APPROVAL_UNAVAILABLE',
  LEDGER_ACTION_INVALID: 'LEDGER_ACTION_INVALID',
});
/** As frases do livro já são fixas e sem caminho; a durabilidade usa só o texto público (nunca "Nada foi gravado" depois do passo 6). */
const fromRun = (refusal: RunRefusal): ResultsFailure => {
  const code = RUN_TO_RESULTS[refusal.code];
  return failure(code, ...(code === 'RESULT_DURABILITY_UNKNOWN' ? [] : refusal.issues.slice(0, 5)));
};
/**
 * Recusa do FECHO QUE CONFIRMA (passo 11 e conclusão B/C), quando resultado e recibo já são duráveis: em regra a operação fica (ou volta a ficar) em fase C e só o autor conclui
 * (`RESULT_ANCHOR_PENDING`), salvo durabilidade desconhecida. A operação ENCERRADA por outro processo antes da confirmação (`RUN_CLOSED`, p.ex. `RUN_ABORTED` alheio da fase A
 * vencida) é outra coisa: o resultado publicado depois do encerramento nunca será confirmado (contradição `RESULT_PUBLISHED_AFTER_ABORT`, sem receita) — `RESULT_INTEGRITY`,
 * nunca a promessa de concluir por reenvio (revisão da R1.4). Nenhum código novo (D-11).
 */
const anchorPendingOr = (refusal: RunRefusal): ResultsFailure =>
  refusal.code === 'DURABILITY_UNKNOWN' ? fromRun(refusal) : failure(refusal.code === 'RUN_CLOSED' ? 'RESULT_INTEGRITY' : 'RESULT_ANCHOR_PENDING', ...refusal.issues.slice(0, 5));
/** O que o `RUN_INTENT` precisa do resultado JÁ SELADO (formato v2: o resultado cita a cabeça de decisões do livro). */
const draftOf = (run: ScoreRun): RunDraft | null =>
  run.ledgerHead
    ? {
        runSeq: run.seq,
        prevRunSha256: run.prevSha256,
        runSha256: run.contentSha256,
        author: run.finalizedBy,
        citedLedgerHead: { ledgerSeq: run.ledgerHead.ledgerSeq, sha256: run.ledgerHead.sha256 },
        decisionsHead: run.decisions.head ? { seq: run.decisions.head.seq, sha256: run.decisions.head.sha256 } : null,
      }
    : null;
/**
 * PASSO 1b (spec §16.17.3, MAJOR-1): R0 (a leitura de resultados e recibos) e a vista do livro vêm de leituras DIFERENTES; quem escreve nas pastas de resultados (sem chave) pode
 * alternar o objeto entre elas. Antes de montar qualquer coisa: (i) o último confirmado de R0 tem o `runSha256` do último `RUN_CONFIRMED` (o que fixa a cadeia inteira: R0 já
 * conferiu `prevSha256` e o livro encadeia `prevRunSha256`); (ii) com operação aberta em B/C, a pendente efetiva `all[runSeq − 1]` existe e tem o `runSha256` do `RUN_INTENT`;
 * (iii) R0 não tem nada além do que o livro confirma, salvo essa pendente efetiva. Diferença ⇒ `MISMATCH` (relê; persistente ⇒ `RESULT_INTEGRITY`).
 */
function crossCheck(read: { readonly runs: readonly ScoreRun[]; readonly pending: ScoreRun | null; readonly all: readonly ScoreRun[] }, runs: NonNullable<LedgerView['runs']>): { readonly kind: 'OK' } | { readonly kind: 'MISMATCH' } | { readonly kind: 'OPEN'; readonly run: ScoreRun; readonly receipt: boolean } {
  const confirmed = runs.confirmed;
  const open = runs.open;
  if (read.all.length !== confirmed.length + (open ? 1 : 0)) return { kind: 'MISMATCH' };
  for (const [index, ref] of confirmed.entries()) if (ref.runSeq !== index + 1) return { kind: 'MISMATCH' };
  const last = confirmed[confirmed.length - 1];
  if (last && read.all[confirmed.length - 1]?.contentSha256 !== last.runSha256) return { kind: 'MISMATCH' };
  if (!open) return read.pending === null ? { kind: 'OK' } : { kind: 'MISMATCH' };
  const effective = read.all[open.runSeq - 1];
  if (open.runSeq !== confirmed.length + 1 || !effective || effective.contentSha256 !== open.runSha256) return { kind: 'MISMATCH' };
  return { kind: 'OPEN', run: effective, receipt: read.pending !== effective };
}
/* ------------------------------------------------------------------ consultas pelo livro (R1.5; spec §16.17.9) */

/** Razões de DISPONIBILIDADE (MINOR-3): sem a vista do livro nada é exibido e a resposta é 503 — nunca "sem livro = confie no recibo". */
const AVAILABILITY_REASONS: ReadonlySet<LedgerReason> = new Set<LedgerReason>(['NOT_CONFIGURED', 'UNAVAILABLE', 'DURABILITY_UNKNOWN', 'GUARD_UNAVAILABLE', 'RESULTS_EVIDENCE_UNAVAILABLE']);
/**
 * Razões de DECISÃO com que os resultados seguem consultáveis (16.17.9): o cruzamento de resultados vem ANTES do livro × decisões, então `runs` existe e o livro autêntico
 * continua provando os resultados. Qualquer outra razão de `HISTORY_UNRESOLVED` (testemunhas, chaves, as três contradições de resultado, disponibilidade) fecha as consultas.
 */
const DECISION_ONLY_REASONS: ReadonlySet<LedgerReason> = new Set<LedgerReason>(['HISTORY_REGRESSED', 'HISTORY_DIVERGES', 'RECEIPT_REMOVED', 'UNLEDGERED_ENTRY', 'UNLEDGERED_PENDING', 'PUBLISHED_AFTER_ABORT', 'LEDGER_BEHIND', 'BEHIND_UNVERIFIABLE']);
/** As três contradições de RESULTADO que vão em `ledger.reason` e congelam também as decisões (16.17.5, D-21). */
/**
 * Recusas da conclusão B/C que NÃO levam a pendente (revisão da R1.5): integridade (nenhum dado sai de um registro que não se explica, como nas consultas) e durabilidade
 * desconhecida (nada se afirma enquanto a base está travada; mesma regra de `fromRun`).
 */
const CONCLUSION_WITHOUT_PENDING: ReadonlySet<ResultsFailureCode> = new Set<ResultsFailureCode>(['RESULT_INTEGRITY', 'RESULT_DURABILITY_UNKNOWN', 'DECISIONS_DURABILITY_UNKNOWN']);
const RESULT_CONTRADICTIONS: ReadonlySet<LedgerReason> = new Set<LedgerReason>(['UNLEDGERED_RESULT', 'RESULT_DIVERGES', 'RESULT_PUBLISHED_AFTER_ABORT']);
const NO_LEDGER_FOR_V2 = 'livro: há resultado que cita o livro de cabeças e este serviço não o lê; nenhum dado é exibido.';
const CONSULT_MISMATCH = 'livro: os resultados lidos não são os que o livro de cabeças confirma (objeto diferente, ausente ou fora do livro); nenhum dado é exibido.';
/** Recusa das consultas por uma razão do livro (MINOR-3, M-R34): disponibilidade ⇒ 503; integridade — inclusive razão desconhecida ou ausente (falha fechada) — ⇒ 409. Nenhum dado. */
const refusedByLedger = (reason: LedgerReason | 'RESULT_RECEIPT_REMOVED' | 'RESULT_REGRESSED' | null): ResultsFailure =>
  reason !== null && AVAILABILITY_REASONS.has(reason as LedgerReason) ? failure('RESULTS_STORAGE_UNAVAILABLE', `livro: ${reason}`) : failure('RESULT_INTEGRITY', `livro: ${reason ?? 'UNRESOLVED'}`);

/** O que as consultas podem devolver depois de conferir R0 com a vista do livro: os confirmados (cada um com o hash do livro) e a pendente efetiva, com a marca de confirmação. */
interface Consulted {
  readonly confirmation: ResultsConfirmation;
  readonly confirmed: readonly ScoreRun[];
  readonly pending: { readonly run: ScoreRun; readonly receipt: PendingRunDto['receipt'] } | null;
}
type ConsultVerdict = ({ readonly kind: 'OK' } & Consulted) | { readonly kind: 'MISMATCH' } | { readonly kind: 'REFUSED'; readonly failure: ResultsFailure };
const MISMATCH: ConsultVerdict = { kind: 'MISMATCH' };

/**
 * CONFERÊNCIA OBJETO × LIVRO DAS CONSULTAS (16.17.9, MAJOR-1, M-R19/M-R22). R0 (`readRunLog`) foi lida ANTES da vista; quem escreve nas pastas de resultados (sem chave) pode
 * alternar o objeto entre as duas leituras. Um objeto só sai como CONFIRMADO se o hash DELE é o `runSha256` do `RUN_CONFIRMED` daquela posição (cada um, não só "seq ≤ |C|");
 * a operação aberta em B/C sai como PENDENTE só se o hash é o do `RUN_INTENT` e a fase que R0 mostra (recibo ou não) é a da vista; em fase A, R0 não pode ter o número dela; R0
 * nunca tem nada além disso. Diferença ⇒ `MISMATCH` (relê). Estados sem prova do livro: só o legado comprovado (`LEDGER_ABSENT_WITH_HISTORY`) é `RECEIPT_ONLY` (D-23).
 */
function consultAgainstLedger(read: RunLog & { readonly all: readonly ScoreRun[] }, ledger: ResultsLedgerRead): ConsultVerdict {
  if (ledger.kind === 'UNAVAILABLE') return { kind: 'REFUSED', failure: failure('RESULTS_STORAGE_UNAVAILABLE', ...ledger.issues.slice(0, 5)) };
  if (ledger.kind === 'INTEGRITY') return { kind: 'REFUSED', failure: failure('RESULT_INTEGRITY', ...ledger.issues.slice(0, 5)) };
  const view = ledger.view;
  if (view.state === 'LEGACY_READ_ONLY') {
    if (view.reason !== 'LEDGER_ABSENT_WITH_HISTORY') return { kind: 'REFUSED', failure: refusedByLedger(view.reason) };
    // legado: sem livro só existe v1 (um v2 cita o livro e seria LEDGER_REMOVED_WITNESSED na vista); um v2 em R0 é leitura diferente da vista ⇒ relê
    if (read.all.some((run) => run.schemaVersion !== RUN_SCHEMA_VERSION || run.ledgerHead !== undefined)) return MISMATCH;
    return { kind: 'OK', confirmation: 'RECEIPT_ONLY', confirmed: read.runs, pending: read.pending ? { run: read.pending, receipt: 'MISSING' } : null };
  }
  // ainda não inscrita: vacuidade verificável (§16.2: sem livro e sem histórico); resultado em R0 é leitura diferente da vista ⇒ relê
  if (view.state === 'ENROLLMENT_PENDING') return read.all.length === 0 ? { kind: 'OK', confirmation: 'LEDGER', confirmed: [], pending: null } : MISMATCH;
  // `NOT_REQUIRED` só existe SEM a porta (D-R1-3); vindo dela é anomalia ⇒ falha fechada
  if (view.state !== 'PROTECTED' && view.state !== 'HISTORY_UNRESOLVED') return { kind: 'REFUSED', failure: failure('RESULTS_STORAGE_UNAVAILABLE', `livro: ${view.state}`) };
  if (view.state === 'HISTORY_UNRESOLVED' && (view.reason === null || !DECISION_ONLY_REASONS.has(view.reason))) return { kind: 'REFUSED', failure: refusedByLedger(view.reason) };
  const runs = view.runs;
  if (!runs) return { kind: 'REFUSED', failure: refusedByLedger(view.reason) };
  if (runs.state !== 'OK') return { kind: 'REFUSED', failure: refusedByLedger(runs.reason) };
  const open = runs.open !== null && runs.open.phase !== 'A' ? runs.open : null;
  const checked = crossCheck(read, { ...runs, open });
  if (checked.kind === 'MISMATCH') return MISMATCH;
  const confirmed = read.all.slice(0, runs.confirmed.length);
  if (confirmed.some((run, index) => run.seq !== runs.confirmed[index]?.runSeq || run.contentSha256 !== runs.confirmed[index]?.runSha256)) return MISMATCH;
  if (checked.kind === 'OK') return { kind: 'OK', confirmation: 'LEDGER', confirmed, pending: null };
  if (checked.receipt !== (open?.phase === 'C')) return MISMATCH;
  return { kind: 'OK', confirmation: 'LEDGER', confirmed, pending: { run: checked.run, receipt: checked.receipt ? 'PRESENT' : 'MISSING' } };
}

/** Quem olha e o que se sabe de HOJE: a origem da pendente é julgada pelo servidor; `currentInputSha256` (se conhecido) diz se ela já nasce histórica. */
interface Viewer {
  readonly operator: string | null;
  readonly origin: OriginAuthenticator | undefined;
  readonly currentInputSha256?: string | null;
}
const pendingOf = (run: ScoreRun, viewer: Viewer, receipt: PendingRunDto['receipt'] = 'MISSING'): PendingRunDto => {
  const verdict = judgeOrigin(viewer.origin, 'RUN', run);
  const proven = verdict === 'PROVEN';
  const totals = (run.result as { totals?: { coveragePercent?: unknown } }).totals;
  const coverage = run.inconclusive?.coveragePercent ?? (typeof totals?.coveragePercent === 'number' ? totals.coveragePercent : null);
  return {
    seq: run.seq,
    finalizedAt: run.finalizedAt,
    origin: originStatusOf(verdict),
    originDetail: proven ? null : verdict,
    receipt,
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
    // fsync estrito da finalização pelo livro (D-15): nunca sucesso, nunca "armazenamento indisponível" genérico
    if (isDurabilityUnknown(error)) return failure('RESULT_DURABILITY_UNKNOWN');
    // revisão da R1.5 (`junin-01`, MAJOR): erro de E/S ao LISTAR ou LER resultados/recibos é DISPONIBILIDADE (503, sem dado), nunca integridade; forma hostil continua 409
    if (isReadIoFailure(error)) return failure('RESULTS_STORAGE_UNAVAILABLE');
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
    // Auditoria PROTEGIDA pelo livro ⇒ formato v2 citando a cabeça de DECISÕES do livro (§16.17.7: nunca uma posição RUN_*; uma finalização não a move); sem livro (testes da 6B/6C
    // isoladas) o formato v1 de sempre.
    const ledgerHead = decisions.ledger.state === 'PROTECTED' && decisions.ledger.decisionHead ? { ledgerSeq: decisions.ledger.decisionHead.ledgerSeq, sha256: decisions.ledger.decisionHead.sha256 } : null;
    return {
      schemaVersion: ledgerHead ? RUN_SCHEMA_VERSION_LEDGER : RUN_SCHEMA_VERSION,
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
      ...(ledgerHead ? { ledgerHead } : {}),
    };
  }

  /**
   * PASSOS DO LIVRO de UMA finalização (R1.3; spec §16.17.3), ligados à porta de escrita. A sessão do livro é a do passo 1 desta tentativa; cada passo devolve `OK`, `RESTART`
   * (recomeça do passo 0) ou a recusa já traduzida. Operação aberta em B/C (R1.4; §16.17.4): o passo 1b entrega a PENDENTE EFETIVA ao `build` (`OPEN`); só o AUTOR a conclui, pelo
   * reenvio idêntico, e só se a sessão do livro recebeu a autorização da conclusão (`concludable`: receita com origem comprovada pela testemunha e o autor pedindo).
   */
  function ledgerSteps(port: ResultsLedgerPort, auditId: string, operator: string): { readonly hooks: RunLedgerHooks<ResultsFailure>; readonly unresolved: () => ResultsFailure | null; readonly conclusionBlocked: (stage: 'ORIGIN' | 'GRANT') => ResultsFailure | null } {
    let session: unknown = null;
    let mismatches = 0;
    /** Livro NÃO resolvido nesta tentativa (`HISTORY_UNRESOLVED`): o reenvio idêntico não pode responder 200 sobre ele (falha fechada; o reenvio pelo livro é da R1.6). */
    let unresolved: ResultsFailure | null = null;
    /**
     * O que o livro desta tentativa diz da CONCLUSÃO de uma pendente (R1.4): `null` = nenhuma operação aberta em B/C foi vista (o livro não está `PROTECTED` — `blockedByState` —,
     * ou não há pendente efetiva); senão, se ela tem receita (`recoverable`: origem comprovada pela testemunha, D-16) e se ESTA sessão recebeu a autorização (só o autor).
     */
    let open: { readonly recoverable: boolean; readonly concludable: boolean } | null = null;
    let blockedByState: ResultsFailure | null = null;
    const refuse = (f: ResultsFailure): RunLedgerGate<ResultsFailure> => ({ kind: 'REFUSED', failure: f });
    /** O recibo já é durável quando o fecho que confirma falha: a resposta `RESULT_ANCHOR_PENDING` leva a pendente na fase C (`receipt: 'PRESENT'`, 16.17.3 passo 11; R1.5). */
    const inPhaseC = (f: ResultsFailure, sealed: ScoreRun): ResultsFailure => (f.code === 'RESULT_ANCHOR_PENDING' ? { ...f, pending: pendingOf(sealed, { operator, origin: deps.origin }, 'PRESENT') } : f);
    const gateOf = (outcome: RunStep, map: (refusal: RunRefusal) => ResultsFailure = fromRun): RunLedgerGate<ResultsFailure> =>
      outcome.kind === 'OK' ? { kind: 'OK' } : outcome.kind === 'RESTART' ? { kind: 'RESTART' } : refuse(map(outcome.refusal));
    const hooks: RunLedgerHooks<ResultsFailure> = {
      async context(read): Promise<RunLedgerContextGate<ResultsFailure>> {
        session = null;
        unresolved = null;
        open = null;
        blockedByState = null;
        const ctx = await port.context({ auditId, actor: operator, nowIso: deps.clock() });
        if (ctx.kind === 'REFUSED') return refuse(fromRun(ctx.refusal));
        const runs = ctx.view.runs;
        if (runs && runs.state !== 'OK') return refuse(failure('RESULT_INTEGRITY', `livro: ${runs.reason ?? 'UNRESOLVED'}`));
        if (ctx.view.state !== 'PROTECTED') {
          // a avaliação desta finalização recusa (`NOT_FINALIZABLE`, bloqueio do livro); o livro não autorizou RUN_INTENT, então nada pode ser publicado por este caminho. O reenvio
          // idêntico (que não avalia) também é recusado com o livro não resolvido: durabilidade desconhecida, citação que não confere etc. nunca respondem 200.
          if (ctx.view.state === 'HISTORY_UNRESOLVED') {
            const reason = ctx.view.reason;
            // R1.5: as três contradições de RESULTADO (16.17.5) respondem como as consultas (RESULT_INTEGRITY), nunca com o texto das decisões
            unresolved =
              reason === 'DURABILITY_UNKNOWN'
                ? failure('RESULT_DURABILITY_UNKNOWN')
                : reason !== null && RESULT_CONTRADICTIONS.has(reason)
                  ? failure('RESULT_INTEGRITY', `livro: ${reason}`)
                  : failure(reason === 'NOT_CONFIGURED' ? 'LEDGER_NOT_CONFIGURED' : 'DECISIONS_HISTORY_UNRESOLVED', `livro: ${reason ?? 'UNRESOLVED'}`);
          }
          // nenhuma conclusão de pendente fora de PROTECTED (o livro não autoriza nada; falha fechada mesmo que o resto passe)
          blockedByState = unresolved ?? failure(ctx.view.state === 'LEGACY_READ_ONLY' ? 'LEDGER_LEGACY_READ_ONLY' : ctx.view.state === 'ENROLLMENT_PENDING' ? 'LEDGER_ENROLLMENT_REQUIRED' : 'DECISIONS_HISTORY_UNRESOLVED');
          session = ctx.session;
          return { kind: 'OK' };
        }
        if (!runs) return refuse(failure('RESULT_INTEGRITY', 'livro: UNRESOLVED'));
        if (runs.open !== null && runs.open.phase === 'A') return refuse(failure('LEDGER_OPERATION_IN_PROGRESS'));
        const checked = crossCheck(read, runs);
        if (checked.kind === 'MISMATCH') return ++mismatches >= OBJECT_LEDGER_ATTEMPTS ? refuse(failure('RESULT_INTEGRITY', OBJECT_LEDGER_MISMATCH)) : { kind: 'RESTART' };
        session = ctx.session;
        // B (sem recibo) ou C (com recibo): a pendente EFETIVA vai ao `build` (R1.4), que exige o autor, a origem e todas as reconferências; a conclusão só segue com a autorização
        if (checked.kind === 'OPEN') {
          open = { recoverable: runs.open?.recoverable === true, concludable: ctx.concludable };
          return { kind: 'OPEN', run: checked.run, receipt: checked.receipt };
        }
        return { kind: 'OK' };
      },
      async intent(sealed) {
        const run = draftOf(sealed);
        if (!run || session === null) return refuse(failure('INTERNAL_ERROR'));
        return gateOf(await port.intent({ session, auditId, actor: operator, nowIso: deps.clock(), run }));
      },
      async gate() {
        if (session === null) return refuse(failure('INTERNAL_ERROR'));
        return gateOf(await port.gate({ session, auditId, actor: operator, nowIso: deps.clock() }));
      },
      async confirmed(sealed) {
        const run = draftOf(sealed);
        if (!run || session === null) return refuse(failure('INTERNAL_ERROR'));
        // resultado e recibo existem e são duráveis; sem o RUN_CONFIRMED a operação fica em fase C (só o autor conclui): RESULT_ANCHOR_PENDING com a pendente (`PRESENT`, R1.5) — salvo
        // durabilidade desconhecida
        return gateOf(await port.confirmed({ session, auditId, actor: operator, nowIso: deps.clock(), run }), (refusal) => inPhaseC(anchorPendingOr(refusal), sealed));
      },
      async conclude(sealed) {
        const run = draftOf(sealed);
        if (!run || session === null) return refuse(failure('INTERNAL_ERROR'));
        // o recibo já é durável; sem o RUN_CONFIRMED a operação fica (ou volta a ficar) em fase C: RESULT_ANCHOR_PENDING — salvo durabilidade desconhecida ou quem não é o autor
        return gateOf(await port.conclude({ session, auditId, actor: operator, nowIso: deps.clock(), run }), (refusal) => (refusal.code === 'PENDING_UNCONFIRMED' ? fromRun(refusal) : inPhaseC(anchorPendingOr(refusal), sealed)));
      },
    };
    /**
     * O livro desta tentativa permite CONCLUIR a pendente? Em dois momentos do `build`: `ORIGIN` logo depois da origem conferida pelo serviço (a testemunha do livro também precisa
     * comprová-la: D-16, chave vencida/revogada/desconhecida ⇒ operação aberta e sem receita) e `GRANT` depois de TODAS as reconferências (a sessão do livro autorizou esta
     * conclusão: só o autor, com receita e testemunha das decisões resolvida). Sem operação B/C vista pelo livro, ninguém conclui. Tudo antes de qualquer gravação.
     */
    const conclusionBlocked = (stage: 'ORIGIN' | 'GRANT'): ResultsFailure | null => {
      if (open === null) return blockedByState ?? failure('RESULT_PENDING_UNCONFIRMED');
      if (stage === 'ORIGIN') return open.recoverable ? null : failure('RESULT_PENDING_ORIGIN_UNPROVEN');
      return open.concludable ? null : failure('RESULT_PENDING_UNCONFIRMED');
    };
    return { hooks, unresolved: () => unresolved, conclusionBlocked };
  }

  /**
   * LEITURA DAS CONSULTAS (R1.5; spec §16.17.9): R0 (`readRunLog`) e depois a vista do livro (porta somente leitura, independente das evidências), conferidas objeto a objeto;
   * diferença ⇒ relê as DUAS, até `OBJECT_LEDGER_ATTEMPTS` vezes (uma corrida legítima só acrescenta e se resolve na releitura); persistente ⇒ `RESULT_INTEGRITY` (409). Sem a porta
   * (6B/6C isoladas, `NOT_REQUIRED`; D-R1-3): recibo = confirmação, marcado `RECEIPT_ONLY` (RL-26). As rotas sempre ligam a porta.
   */
  async function consult(auditId: string): Promise<{ readonly ok: true; readonly value: Consulted & { readonly read: RunLog } } | ResultsFailure> {
    for (let attempt = 1; ; attempt += 1) {
      const read = await readRunLog(deps.baseDir, auditId, storeOptions);
      if (!read.ok) return fromStore(read);
      if (!deps.ledger) {
        // revisão da R1.5 (`junin-01`, MINOR): sem o livro, só v1 sem `ledgerHead` pode sair confirmado por recibo; um v2 CITA o livro e, sem a leitura dele, nada é afirmado
        if (read.value.all.some((run) => run.schemaVersion !== RUN_SCHEMA_VERSION || run.ledgerHead !== undefined)) return failure('RESULT_INTEGRITY', NO_LEDGER_FOR_V2);
        return { ok: true, value: { read: read.value, confirmation: 'RECEIPT_ONLY', confirmed: read.value.runs, pending: read.value.pending ? { run: read.value.pending, receipt: 'MISSING' } : null } };
      }
      let ledger: ResultsLedgerRead;
      try {
        ledger = await deps.ledger.view({ auditId, nowIso: deps.clock() });
      } catch {
        ledger = { kind: 'UNAVAILABLE', issues: ['livro: UNAVAILABLE'] }; // exceção nunca vira "sem livro"
      }
      const verdict = consultAgainstLedger(read.value, ledger);
      if (verdict.kind === 'REFUSED') return verdict.failure;
      if (verdict.kind === 'OK') return { ok: true, value: { read: read.value, confirmation: verdict.confirmation, confirmed: verdict.confirmed, pending: verdict.pending } };
      if (attempt >= OBJECT_LEDGER_ATTEMPTS) return failure('RESULT_INTEGRITY', CONSULT_MISMATCH);
    }
  }
  /** A prévia é fonte OPCIONAL de `stale`/`decisionsChanged` (D-14, RL-27): falha ou exceção ⇒ "não foi possível comparar", nunca bloqueia nem decide a confirmação. */
  async function evaluateOptional(actor: PreviewActor, auditId: string): Promise<Awaited<ReturnType<PreviewEvaluator['evaluate']>>> {
    try {
      return await deps.preview.evaluate(actor, auditId);
    } catch {
      return { ok: false, code: 'INTERNAL_ERROR', issues: [] };
    }
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
      const runLedger = deps.ledger ? ledgerSteps(deps.ledger, auditId, operator) : null;
      const appended = await appendRun<ResultsFailure>(
        deps.baseDir,
        auditId,
        async (ctx) => {
          const reject = (f: ResultsFailure): { ok: false; failure: ResultsFailure } => ({ ok: false, failure: f });
          // a pendente vai no corpo com o estado do recibo (R1.5): a pendente efetiva da fase C do livro já tem recibo (`PRESENT`), e isso continua NÃO sendo confirmação
          const pendingBody = (run: ScoreRun): { pending: PendingRunDto } => ({ pending: pendingOf(run, viewer, ctx.pendingReceipt ? 'PRESENT' : 'MISSING') });
          // 1. reenvio idêntico (mesmo `inputSha256` e mesmo `head` das decisões) do último arquivo publicado
          const last = ctx.all[ctx.all.length - 1];
          if (last && last.inputSha256 === expectedInputSha256 && sameHead(last.decisions.head, expectedHead)) {
            // com o livro NÃO resolvido (R1.3), nem o reenvio de confirmado nem a conclusão de pendente respondem: nada é afirmado sobre um livro em dúvida
            const unresolved = runLedger?.unresolved() ?? null;
            if (unresolved) return reject(unresolved);
            // §16.17.4 (R1.4): só o AUTOR conclui — e-mail da sessão normalizado (`operatorOf`) === `finalizedBy` (o `RUN_INTENT` amarra o hash, logo também `run.author`)
            if (last === ctx.pending && last.finalizedBy !== operator) return reject({ ...failure('RESULT_PENDING_UNCONFIRMED'), ...pendingBody(last) });
            concludedPending = last === ctx.pending;
            if (concludedPending) {
              // CONCLUIR uma pendente = dar o recibo a um arquivo que vive numa pasta que quem escreve nela controla por inteiro. Camadas,
              // todas FECHADAS: (1) ORIGEM comprovada pelo servidor (etiqueta HMAC com chave fora das pastas; "autor" no arquivo não prova nada);
              // (2) o registro se explica (reexecuta o motor sobre a entrada gravada); (3) as evidências citadas existem HOJE com os mesmos hashes;
              // (4) o histórico de decisões não regrediu desde o head gravado. O pedido do operador (`expectedHead`/`expectedInputSha256`) vem da
              // interface a partir do próprio arquivo: NÃO é prova de nada.
              if (judgeOrigin(deps.origin, 'RUN', last) !== 'PROVEN') return reject({ ...failure('RESULT_PENDING_ORIGIN_UNPROVEN'), ...pendingBody(last) });
              // (1b) com o livro: a origem também comprovada pela testemunha que o livro lê (D-16)
              const unprovable = runLedger ? runLedger.conclusionBlocked('ORIGIN') : null;
              if (unprovable) return reject({ ...unprovable, ...pendingBody(last) });
              if (!explains(last)) return reject(failure('RESULT_INTEGRITY')); // nunca se dá recibo a um registro que não se explica (integridade: sem dado)
              // revisão da R1.5 (`junin-01`, MINOR): toda recusa da conclusão leva a pendente com o recibo da fase (MISSING na B, PRESENT na C), salvo integridade e durabilidade
              const refuseConclusion = (f: ResultsFailure): { ok: false; failure: ResultsFailure } => reject(CONCLUSION_WITHOUT_PENDING.has(f.code) ? f : { ...f, ...pendingBody(last) });
              const now = await deps.preview.evaluate(actor, auditId);
              if (!now.ok) return refuseConclusion({ ...failure(now.code, ...now.issues), ...(now.head !== undefined ? { head: now.head } : {}) });
              // (2b) a conclusão também DEPENDE das evidências e do histórico de decisões: sem prova de coleta, ou com a integridade do histórico NÃO resolvida, ninguém dá recibo (falha fechada)
              if (now.value.payload.blockers.some((b) => b.code === 'EVIDENCE_PROVENANCE_UNPROVEN' || b.code === 'DECISIONS_HISTORY_UNRESOLVED')) return refuseConclusion({ ...failure('NOT_FINALIZABLE'), blockers: now.value.payload.blockers });
              const problems = pendingEvidenceProblems(last, now.value);
              if (problems.length > 0) return refuseConclusion(failure('EVIDENCE_HASH_CHANGED', ...problems.slice(0, 10)));
              const gravado = last.decisions.head;
              const hoje = now.value.decisions.head;
              if (gravado !== null && (hoje === null || hoje.seq < gravado.seq)) return refuseConclusion({ ...failure('HISTORY_REGRESSED'), head: hoje });
              // (5) DURABILIDADE: concluir dá o recibo a um resultado que CITA o livro; o livro (e as decisões) precisam estar comprovadamente duráveis agora, e protegidos
              if (last.ledgerHead) {
                const barrier = await deps.preview.durabilityBarrier(actor, auditId, {});
                if (!barrier.ok) return refuseConclusion(failure(barrier.code === 'DURABILITY_UNKNOWN' ? 'RESULT_DURABILITY_UNKNOWN' : 'INPUT_CHANGED', ...barrier.issues.slice(0, 3)));
              }
              // (6) com o livro (R1.4): a sessão do livro autorizou ESTA conclusão (só o autor, com receita); sem a autorização, nada é gravado — nem o recibo da fase B
              const ungranted = runLedger ? runLedger.conclusionBlocked('GRANT') : null;
              if (ungranted) return reject({ ...ungranted, ...pendingBody(last) });
            } else if (!explains(last)) return reject(failure('RESULT_INTEGRITY')); // reenvio de um CONFIRMADO: nada é gravado, mas só se devolve o que se explica
            return { ok: true, replayOf: last.seq };
          }
          if (ctx.pending) return reject({ ...failure('RESULT_PENDING_UNCONFIRMED'), ...pendingBody(ctx.pending) });

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
          // 6b. BARREIRA DE DURABILIDADE (só quando o resultado cita o livro): a cabeça citada está autenticada (livro PROTEGIDO), as escritas do livro, das decisões e dos recibos têm a durabilidade
          // comprovada AGORA e, depois disso, a vista continua mostrando EXATAMENTE as cabeças avaliadas (nenhuma gravação concorrente mudou o estado nem travou a base entre a verificação e o selamento).
          // Qualquer dúvida ⇒ nada é selado. O que é montado a seguir vem da MESMA avaliação que a barreira conferiu.
          const cited = ev.value.decisions.ledger.state === 'PROTECTED' ? ev.value.decisions.ledger.decisionHead : null;
          if (cited) {
            const barrier = await deps.preview.durabilityBarrier(actor, auditId, { decisionsHead: ev.value.decisions.head, ledgerHead: { ledgerSeq: cited.ledgerSeq, sha256: cited.sha256 } });
            if (!barrier.ok) return reject(failure(barrier.code === 'DURABILITY_UNKNOWN' ? 'RESULT_DURABILITY_UNKNOWN' : 'INPUT_CHANGED', ...barrier.issues.slice(0, 3)));
          }
          // 7. montagem
          const draft = draftFrom(ev.value, operator, ctx.finalizedAt);
          if (!draft) return reject(failure('INTERNAL_ERROR'));
          return { ok: true, draft };
        },
        { ...storeOptions, now: deps.clock, validate: (sealed) => verifyRunRecord(sealed), ...(deps.origin ? { origin: deps.origin } : {}), ...(runLedger ? { ledger: runLedger.hooks } : {}) },
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

    /**
     * Lista os resultados CONFIRMADOS (verificados por inteiro e, com o livro, cada um com o hash do `RUN_CONFIRMED`) e a pendente à parte. Falha de integridade ⇒ nenhum dado;
     * livro indisponível ⇒ 503 (R1.5; spec §16.17.9).
     */
    async list(actor: PreviewActor, auditId: string): Promise<{ readonly ok: true; readonly value: ListRunsPayload } | ResultsFailure> {
      if (!validAuditId(auditId)) return failure('INVALID_PARAMS', 'auditId inválido.');
      const config = await checkConfiguration();
      if (config) return config;
      const consulted = await consult(auditId);
      if (!consulted.ok) return consulted;
      const { read, confirmation, confirmed, pending } = consulted.value;
      const inconsistent = unexplained(confirmed);
      if (inconsistent) return inconsistent;
      const now = await evaluateOptional(actor, auditId);
      // resultados já selados e verificados continuam consultáveis mesmo que a base atual não possa ser relida (`stale: null`); sem nenhum resultado, a auditoria inexistente é 404
      if (!now.ok && now.code === 'AUDIT_NOT_FOUND' && confirmed.length === 0 && pending === null) return failure('AUDIT_NOT_FOUND');
      const currentInputSha256 = now.ok ? now.value.inputSha256 : null;
      const currentDecisionsHead = now.ok ? now.value.decisions.head : null;
      const results: RunSummaryDto[] = confirmed.map((run, index) => {
        const latest = index === confirmed.length - 1;
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
          confirmation,
          results,
          head: chainHead(confirmed),
          pending: pending ? pendingOf(pending.run, viewerOf(actor, currentInputSha256), pending.receipt) : null,
          anchors: read.anchors,
          currentInputSha256,
          currentDecisionsHead,
          integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles: read.checkedFiles, note: INTEGRITY_NOTE },
        },
      };
    },

    /** Um resultado CONFIRMADO (com o livro: o hash DELE é o do `RUN_CONFIRMED`), verificado (selo, bytes, recibos, encadeamento e semântica), em projeção pública. */
    async get(actor: PreviewActor, auditId: string, seq: number): Promise<{ readonly ok: true; readonly value: RunDetailPayload } | ResultsFailure> {
      if (!validAuditId(auditId) || !Number.isInteger(seq) || seq < 1) return failure('INVALID_PARAMS', 'Parâmetros inválidos.');
      const config = await checkConfiguration();
      if (config) return config;
      const consulted = await consult(auditId);
      if (!consulted.ok) return consulted;
      const { confirmation, confirmed, pending } = consulted.value;
      const run = confirmed.find((item) => item.seq === seq);
      // a pendente (B ou C) nunca é entregue como resultado: RESULT_PENDING_UNCONFIRMED com o resumo dela (16.17.9)
      if (!run) return pending?.run.seq === seq ? { ...failure('RESULT_PENDING_UNCONFIRMED'), pending: pendingOf(pending.run, viewerOf(actor), pending.receipt) } : failure('RESULT_NOT_FOUND');
      const inconsistent = unexplained(confirmed); // consulta INTEGRAL: um registro inconsistente em qualquer posição invalida a consulta inteira
      if (inconsistent) return inconsistent;
      const latest = confirmed[confirmed.length - 1] === run;
      let stale: boolean | null = null;
      let decisionsChanged: boolean | null = null;
      if (latest) ({ stale, decisionsChanged } = drift(await evaluateOptional(actor, auditId), run));
      return { ok: true, value: { confirmation, stale, decisionsChanged, superseded: !latest, run: toPublicRun(run).detail } };
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
  | {
      readonly ok: true;
      readonly heads: ReadonlyArray<{ readonly seq: number; readonly sha256: string }>;
      readonly unverifiedHeads?: ReadonlyArray<{ readonly seq: number; readonly sha256: string }>;
      readonly hasResults?: boolean;
      readonly ledgerHeads?: ReadonlyArray<{ readonly ledgerSeq: number; readonly sha256: string }>;
      readonly unverifiedLedgerHeads?: ReadonlyArray<{ readonly ledgerSeq: number; readonly sha256: string }>;
      /** Os resultados em si, para o LIVRO (spec §16.17.8): ancorados em ordem e o pendente, com a origem julgada. `finalizedBy` só circula entre módulos do servidor. */
      readonly runs?: { readonly anchored: readonly KnownRunRef[]; readonly pending: KnownRunRef | null };
    }
  | { readonly ok: false; readonly reason: 'NOT_CONFIGURED' | 'STORAGE_UNAVAILABLE' | 'UNTRUSTED' }
>;
/** Um resultado como a testemunha o entrega (mesma forma estrutural do `RunRef` da porta do livro; a 6C NÃO importa as decisões). */
export interface KnownRunRef {
  readonly seq: number;
  readonly sha256: string;
  readonly prevSha256: string | null;
  readonly schemaVersion: 1 | 2;
  readonly ledgerHead: { readonly ledgerSeq: number; readonly sha256: string } | null;
  readonly finalizedBy: string;
  readonly originProven: boolean;
  /** Id PÚBLICO da chave de origem do arquivo (`origin.kid`; `null` sem etiqueta). Só diagnóstico (portão do runbook, R1.5); nunca prova. */
  readonly originKid: string | null;
}

const INTEGRITY_CODES: ReadonlySet<StoreErrorCode> = new Set(['CORRUPT', 'HASH_MISMATCH', 'CHAIN_BROKEN', 'SEQUENCE_GAP', 'SCHEMA', 'SEMANTIC', 'TRUNCATED', 'ANCHOR_MISMATCH', 'ANCHOR_INTEGRITY']);
/**
 * O armazenamento rotula erro de leitura/listagem do sistema operacional (EIO, EACCES, exceção desconhecida…) como `CORRUPT` (resultados) ou `ANCHOR_INTEGRITY`
 * (recibos) com "leitura: E…" / "listagem … : E…" / "listagem: DESCONHECIDO …": isso é DISPONIBILIDADE, não adulteração. Só diagnóstico: as duas classes falham fechado.
 */
const READ_ERRNO = /\b(?:leitura|listagem)[^:]*: (?:E[A-Z0-9]+|DESCONHECIDO)\b/;
/** Arquivo de FORMATO hostil no lugar de um resultado/recibo (FIFO, soquete, diretório, link, grande demais, mudou durante a leitura): integridade, nunca "indisponível" (como no livro, R7-07). */
const HOSTILE_SHAPE = /\b(?:leitura|listagem)[^:]*: (?:ENOTFILE|ETOOBIG|ECHANGED|ELOOP|EISDIR|ENOTDIR)\b/;
/**
 * Revisão da R1.5 (`junin-01`, MAJOR): o armazenamento rotula o erro do sistema operacional ao listar/ler resultados (`CORRUPT`) ou recibos (`ANCHOR_INTEGRITY`) como se fosse
 * adulteração. Nas consultas e na finalização isso é DISPONIBILIDADE (503 `RESULTS_STORAGE_UNAVAILABLE`, sem dado; a finalização continua recusando, nada é gravado); conteúdo
 * inválido e forma hostil continuam integridade (409).
 */
function isReadIoFailure(error: { readonly code: StoreErrorCode; readonly issues: readonly string[] }): boolean {
  return (error.code === 'CORRUPT' || error.code === 'ANCHOR_INTEGRITY') && error.issues.some((issue) => READ_ERRNO.test(issue)) && !error.issues.some((issue) => HOSTILE_SHAPE.test(issue));
}

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
      const ledgerOf = (run: ScoreRun): Array<{ ledgerSeq: number; sha256: string }> => (run.ledgerHead ? [{ ledgerSeq: run.ledgerHead.ledgerSeq, sha256: run.ledgerHead.sha256 }] : []);
      const refOf = (run: ScoreRun): KnownRunRef => ({
        seq: run.seq,
        sha256: run.contentSha256,
        prevSha256: run.prevSha256,
        schemaVersion: run.schemaVersion,
        ledgerHead: run.ledgerHead ? { ledgerSeq: run.ledgerHead.ledgerSeq, sha256: run.ledgerHead.sha256 } : null,
        finalizedBy: run.finalizedBy,
        originProven: judgeOrigin(options.origin, 'RUN', run) === 'PROVEN',
        originKid: run.origin?.kid ?? null,
      });
      return {
        ok: true,
        heads: [...read.value.runs.flatMap(headOf), ...(pending && proven ? headOf(pending) : [])],
        unverifiedHeads: pending && !proven ? headOf(pending) : [],
        // O LIVRO precisa saber se a auditoria já teve resultado (com ou sem `ledgerHead`) e quais posições do livro eles citam.
        hasResults: read.value.runs.length > 0 || pending !== null,
        ledgerHeads: [...read.value.runs.flatMap(ledgerOf), ...(pending && proven ? ledgerOf(pending) : [])],
        unverifiedLedgerHeads: pending && !proven ? ledgerOf(pending) : [],
        // o LIVRO confere o que ele cita (RUN_CONFIRMED ⇒ resultado e recibo) e a fase da operação de resultado aberta (§16.17.4, 16.17.5)
        runs: { anchored: read.value.runs.map(refOf), pending: pending ? refOf(pending) : null },
      };
    } catch {
      return { ok: false, reason: 'STORAGE_UNAVAILABLE' };
    }
  };
}
