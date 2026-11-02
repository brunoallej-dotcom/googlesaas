import path from 'node:path';
import type { OperatorRecord } from '../link-audit/scoring/input';
import { findClientProvidedScoreKeys } from '../link-audit/scoring/input';
import type { FsOps } from '../link-audit/snapshot-store';
import { nodeFsOps } from '../link-audit/snapshot-store';
import { judgeOrigin, originStatusOf, type OriginAuthenticator, type OriginStatus, type OriginVerdict } from '../link-audit-origin';
import type { AnchorSummary } from './anchor-store';
import { checkOperatorRecordsContract } from './contract';
import { availableRefs, captureRef, parseEvidenceRef, referencedEvidence, reportRef, type VersionLike } from './evidence-refs';
import { assertBase, type StoreErrorCode, type StoreFailure } from './files';
import { canSupersede, effectiveScoringRecords, slotConflicts, toScoringRecord, type DecisionView, type LogState } from './project';
import { appendEntry, assertDecisionBase, findReplay, readLog, type OperationSpec, type PendingFailure } from './store';
import { evaluateKnownHeads, isUnresolved, WITNESS_NOT_REQUIRED, type KnownHeadsRead, type WitnessSource, type WitnessVerdict } from './witness';
import {
  AUDIT_ID_PATTERN,
  createBodySchema,
  DECISION_FILE_KIND,
  DECISION_SCHEMA_VERSION,
  decisionIdFor,
  EMAIL_PATTERN,
  INTEGRITY_NOTE,
  MAX_EFFECTIVE_RECORDS,
  MAX_SEQ,
  RESERVED_FOR_REVOCATIONS,
  revokeBodySchema,
  type ClientRecord,
  type DecisionBasis,
  type DecisionDraft,
  type DecisionEntry,
  type ExpectedHead,
} from './types';

/*
 * Serviço das decisões humanas (Onda 6B): ÚNICO caminho de leitura/escrita usado pelas rotas. Autoria e data vêm do
 * servidor (o cliente nunca as envia); valores de pontuação e caracteres ocultos são recusados; toda evidência citada
 * precisa existir no serviço de evidências; o conjunto vigente passa pelo MESMO validador do motor da 6A; toda escrita
 * exige o `expectedHead` (a visão do operador) e só é CONFIRMADA depois do recibo na pasta de âncoras (Emenda 1 do ADR): sucesso
 * significa decisão E recibo duráveis; entre os dois ela é PENDENTE (existe, não vale, não é sucesso) e reenviar o MESMO pedido a
 * conclui sem duplicar. Nada é apagado ou sobrescrito.
 */
export type ServiceErrorCode =
  | 'INVALID_PARAMS'
  | 'INVALID_BODY'
  | 'FORBIDDEN_FIELDS'
  | 'INVALID_EVIDENCE_REFERENCE'
  | 'CONTRACT_REJECTED'
  | 'OPERATOR_IDENTITY_INVALID'
  | 'AUDIT_NOT_FOUND'
  | 'DECISION_NOT_FOUND'
  | 'HEAD_MISMATCH'
  | 'HISTORY_REGRESSED'
  | 'SUPERSEDE_REQUIRED'
  | 'SUPERSEDE_INVALID'
  | 'DECISION_NOT_ACTIVE'
  | 'EVIDENCE_REFERENCE_NOT_FOUND'
  | 'EVIDENCE_INTEGRITY'
  | 'DECISIONS_INTEGRITY'
  | 'DECISIONS_TRUNCATED'
  | 'ANCHOR_MISMATCH'
  | 'ANCHOR_INTEGRITY'
  | 'LIMIT_REACHED'
  | 'WRITE_CONFLICT'
  | 'ANCHOR_PENDING'
  | 'PENDING_UNCONFIRMED'
  | 'PENDING_ORIGIN_UNPROVEN'
  | 'DECISIONS_HISTORY_UNRESOLVED'
  | 'ORIGIN_KEY_NOT_CONFIGURED'
  | 'DECISIONS_STORAGE_UNAVAILABLE'
  | 'ANCHOR_STORAGE_UNAVAILABLE'
  | 'DECISIONS_MISCONFIGURED'
  | 'INTERNAL_ERROR';

export const HTTP_STATUS: Readonly<Record<ServiceErrorCode, number>> = Object.freeze({
  INVALID_PARAMS: 400,
  INVALID_BODY: 400,
  FORBIDDEN_FIELDS: 400,
  INVALID_EVIDENCE_REFERENCE: 400,
  CONTRACT_REJECTED: 400,
  OPERATOR_IDENTITY_INVALID: 403,
  AUDIT_NOT_FOUND: 404,
  DECISION_NOT_FOUND: 404,
  HEAD_MISMATCH: 409,
  HISTORY_REGRESSED: 409,
  SUPERSEDE_REQUIRED: 409,
  SUPERSEDE_INVALID: 409,
  DECISION_NOT_ACTIVE: 409,
  EVIDENCE_REFERENCE_NOT_FOUND: 409,
  EVIDENCE_INTEGRITY: 409,
  DECISIONS_INTEGRITY: 409,
  DECISIONS_TRUNCATED: 409,
  ANCHOR_MISMATCH: 409,
  ANCHOR_INTEGRITY: 409,
  LIMIT_REACHED: 409,
  WRITE_CONFLICT: 409,
  ANCHOR_PENDING: 503,
  PENDING_UNCONFIRMED: 409,
  PENDING_ORIGIN_UNPROVEN: 409,
  DECISIONS_HISTORY_UNRESOLVED: 409,
  ORIGIN_KEY_NOT_CONFIGURED: 503,
  DECISIONS_STORAGE_UNAVAILABLE: 503,
  ANCHOR_STORAGE_UNAVAILABLE: 503,
  DECISIONS_MISCONFIGURED: 503,
  INTERNAL_ERROR: 500,
});

export const PUBLIC_MESSAGE: Readonly<Record<ServiceErrorCode, string>> = Object.freeze({
  INVALID_PARAMS: 'Parâmetros inválidos.',
  INVALID_BODY: 'Corpo da requisição inválido.',
  FORBIDDEN_FIELDS: 'O corpo contém campos de pontuação ou de resultado, que o servidor não aceita.',
  INVALID_EVIDENCE_REFERENCE: 'Referência de evidência inválida.',
  CONTRACT_REJECTED: 'A decisão não atende ao contrato do motor de pontuação.',
  OPERATOR_IDENTITY_INVALID: 'A identidade do operador não pode ser registrada em uma decisão.',
  AUDIT_NOT_FOUND: 'Auditoria não encontrada.',
  DECISION_NOT_FOUND: 'Decisão não encontrada.',
  HEAD_MISMATCH: 'O histórico mudou desde a sua visão (ou não corresponde a ela); recarregue antes de gravar.',
  HISTORY_REGRESSED: 'O histórico atual está ATRÁS da sua visão: arquivos foram removidos ou restaurados de uma cópia antiga. Nada foi gravado.',
  SUPERSEDE_REQUIRED: 'Já existe uma decisão vigente para o mesmo subcritério.',
  SUPERSEDE_INVALID: 'A decisão informada não pode ser substituída por este registro.',
  DECISION_NOT_ACTIVE: 'A decisão informada não está vigente.',
  EVIDENCE_REFERENCE_NOT_FOUND: 'A evidência citada não existe nesta auditoria.',
  EVIDENCE_INTEGRITY: 'As evidências desta auditoria não passam na verificação de integridade.',
  DECISIONS_INTEGRITY: 'O histórico de decisões desta auditoria não passa na verificação de integridade; nenhum dado é exibido.',
  DECISIONS_TRUNCATED: 'O histórico de decisões está MENOR do que as âncoras registram (arquivos removidos ou restaurados de cópia antiga); nenhum dado é exibido.',
  ANCHOR_MISMATCH: 'Uma decisão não confere com a âncora gravada na pasta separada (arquivo reescrito ou substituído); nenhum dado é exibido.',
  ANCHOR_INTEGRITY: 'As âncoras desta auditoria não passam na verificação de integridade; nenhum dado é exibido.',
  LIMIT_REACHED: 'Limite de decisões atingido.',
  WRITE_CONFLICT: 'Outro processo gravou ao mesmo tempo; nada foi sobrescrito. Tente novamente.',
  ANCHOR_PENDING: 'A decisão foi gravada, mas o recibo na pasta de âncoras NÃO foi confirmado: ela ainda NÃO vale. Reenvie o MESMO pedido (é seguro repetir) para concluir.',
  PENDING_UNCONFIRMED: 'Há uma decisão gravada e ainda não confirmada neste histórico; só o autor, reenviando o mesmo pedido, a conclui. Nada foi gravado.',
  PENDING_ORIGIN_UNPROVEN: 'A origem desta decisão pendente NÃO pôde ser comprovada pelo servidor (arquivo adulterado, forjado, anterior à proteção ou de outra chave). Ela NÃO pode ser concluída por esta tela e nada foi gravado; siga o procedimento de quarentena.',
  DECISIONS_HISTORY_UNRESOLVED: 'A integridade do histórico de decisões NÃO está resolvida: a testemunha independente (resultados já selados) não confere com o histórico de hoje, ou não pôde ser lida. Nenhuma decisão é considerada vigente e nada foi gravado. Não apague nem mova arquivos; avise a operação.',
  ORIGIN_KEY_NOT_CONFIGURED: 'A chave de comprovação de origem das decisões não está configurada (ou é fraca) neste servidor; nenhuma decisão é gravada ou concluída.',
  DECISIONS_STORAGE_UNAVAILABLE: 'O armazenamento de decisões não está disponível neste servidor.',
  ANCHOR_STORAGE_UNAVAILABLE: 'O armazenamento de âncoras não está disponível neste servidor; nenhuma decisão foi gravada.',
  DECISIONS_MISCONFIGURED: 'O armazenamento de decisões ou de âncoras está configurado de forma insegura.',
  INTERNAL_ERROR: 'Não foi possível concluir a operação.',
});

export interface Head {
  readonly seq: number;
  readonly sha256: string;
}

export interface ServiceFailure {
  readonly ok: false;
  readonly code: ServiceErrorCode;
  readonly issues: readonly string[];
  /** Head CONFIRMADO do histórico (nas recusas de `expectedHead` e nas pendentes, para o operador recarregar ou reenviar). */
  readonly head?: Head | null;
  /** A decisão publicada e ainda não confirmada (só em `ANCHOR_PENDING`, `PENDING_UNCONFIRMED` e `PENDING_ORIGIN_UNPROVEN`). */
  readonly pending?: PendingDto;
}
export type ServiceResult<T> = { readonly ok: true; readonly value: T } | ServiceFailure;

const failure = (code: ServiceErrorCode, ...issues: string[]): ServiceFailure => ({ ok: false, code, issues });

const STORE_TO_SERVICE: Readonly<Record<StoreErrorCode, ServiceErrorCode>> = Object.freeze({
  INVALID_ID: 'INVALID_PARAMS',
  UNSAFE_PATH: 'DECISIONS_MISCONFIGURED',
  STORAGE_MISSING: 'DECISIONS_STORAGE_UNAVAILABLE',
  ANCHOR_MISSING: 'ANCHOR_STORAGE_UNAVAILABLE',
  CORRUPT: 'DECISIONS_INTEGRITY',
  HASH_MISMATCH: 'DECISIONS_INTEGRITY',
  CHAIN_BROKEN: 'DECISIONS_INTEGRITY',
  SEQUENCE_GAP: 'DECISIONS_INTEGRITY',
  SCHEMA: 'DECISIONS_INTEGRITY',
  SEMANTIC: 'DECISIONS_INTEGRITY',
  TRUNCATED: 'DECISIONS_TRUNCATED',
  ANCHOR_MISMATCH: 'ANCHOR_MISMATCH',
  ANCHOR_INTEGRITY: 'ANCHOR_INTEGRITY',
  CONFLICT: 'WRITE_CONFLICT',
  LIMIT_REACHED: 'LIMIT_REACHED',
  WRITE_FAILED: 'DECISIONS_STORAGE_UNAVAILABLE',
  ANCHOR_WRITE_FAILED: 'ANCHOR_STORAGE_UNAVAILABLE',
  ATOMIC_WRITE_UNAVAILABLE: 'DECISIONS_STORAGE_UNAVAILABLE',
  STORAGE_FATAL: 'DECISIONS_STORAGE_UNAVAILABLE',
  INTERNAL: 'INTERNAL_ERROR',
});

/** Detalhes de integridade ajudam o operador; detalhes de disco/caminho nunca saem. */
const DETAILED: ReadonlySet<ServiceErrorCode> = new Set(['DECISIONS_HISTORY_UNRESOLVED', 'DECISIONS_INTEGRITY', 'DECISIONS_TRUNCATED', 'ANCHOR_MISMATCH', 'ANCHOR_INTEGRITY', 'INVALID_PARAMS']);

/** Quem está olhando e com que autenticador: a origem de uma pendente só é afirmada quando o SERVIDOR a comprova. */
interface Viewer {
  readonly operator: string | null;
  readonly origin: OriginAuthenticator | undefined;
}

/** Pendente: o `head` devolvido é o CONFIRMADO (o mesmo `expectedHead` do pedido), para o autor reenviar sem alterar nada. */
const fromPending = (error: Pick<PendingFailure, 'code' | 'state' | 'pending'>, viewer: Viewer): ServiceFailure => ({
  ...failure(error.code === 'ORIGIN_UNPROVEN' ? 'PENDING_ORIGIN_UNPROVEN' : error.code),
  head: currentHead(error.state),
  pending: toPending(error.pending, viewer),
});

function fromStore(error: StoreFailure): ServiceFailure {
  const code = STORE_TO_SERVICE[error.code];
  return failure(code, ...(DETAILED.has(code) ? error.issues : []));
}

/* ------------------------------------------------------------------ dependências e DTOs */

export interface EvidenceActorLike {
  readonly email: string;
}

/** O que o serviço precisa do leitor de evidências (o `EvidenceReader` real satisfaz esta interface). */
export interface EvidenceLookup {
  getIntegrity(
    actor: EvidenceActorLike,
    auditId: string,
  ): Promise<{ readonly state: string; readonly integrity: { readonly status: 'OK' | 'MISMATCH' | 'INCOMPLETE' } } | null>;
  listVersions(actor: EvidenceActorLike, auditId: string): Promise<readonly VersionLike[]>;
}

export interface DecisionServiceOptions {
  readonly baseDir: string;
  /** Pasta de âncoras (OBRIGATÓRIA): outro local de gravação, nunca igual nem aninhada às de decisões e de evidências. */
  readonly anchorDir: string;
  readonly evidence: EvidenceLookup;
  /** Pasta de evidências: a de decisões e a de âncoras nunca podem ser a mesma nem ficar dentro (ou fora) dela. */
  readonly evidenceBaseDir?: string;
  readonly fs?: FsOps;
  readonly projectRoot?: string;
  /**
   * Autenticador de ORIGEM (chave do servidor FORA das pastas de dados). Com ele, as entradas novas saem assinadas e uma pendente só é
   * concluída com a etiqueta válida. Sem ele nenhuma pendente é concluída (falha fechada) e a origem fica `UNVERIFIABLE`.
   */
  readonly origin?: OriginAuthenticator;
  /**
   * TESTEMUNHA do histórico (R3-MINOR-2 / R4-MINOR-1 / INFO-1): fonte INDEPENDENTE das pastas de decisões que informa cabeças já CONFIRMADAS (hoje, os
   * resultados selados da 6C; fornecida pela camada de rotas). OBRIGATÓRIA: omitir é erro de compilação. Fonte ausente, ilegível ou não confiável,
   * retrocesso e divergência ⇒ integridade NÃO resolvida ⇒ falha fechada (nenhuma decisão vigente, nada finalizável, nenhuma escrita).
   * `WITNESS_NOT_REQUIRED` existe só para testes da 6B isolada; nada em `src/` além do serviço e do módulo da testemunha pode referenciá-lo.
   */
  readonly knownHeads: WitnessSource;
}

export interface DecisionDto {
  readonly decisionId: string;
  readonly seq: number;
  readonly kind: ClientRecord['kind'];
  readonly record: ClientRecord;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
  readonly revokedAtSeq: number | null;
  /**
   * `AMBIGUOUS`: há uma operação PENDENTE (sem recibo) que revoga ou substitui esta decisão. Pode ser uma gravação interrompida (a decisão
   * segue vigente) OU o recibo REMOVIDO de uma operação já confirmada (a decisão está revogada/substituída): os dois são indistinguíveis sem
   * testemunha externa. Por isso a decisão NÃO é projetada como vigente (fora de `decisions` e de `operatorRecords`) até a pendência ser resolvida.
   */
  readonly status: DecisionView['status'] | 'AMBIGUOUS';
  readonly basis: DecisionBasis;
  /** Depende de dados do site que só a integração com o motor (6C) conhece: pode ser recusada pela 6A se o escopo não bastar. */
  readonly siteDependent: boolean;
}

export interface HistoryEntryDto {
  readonly seq: number;
  readonly action: 'RECORD' | 'REVOKE';
  readonly decisionId: string | null;
  readonly revokes: string | null;
  readonly supersedes: string | null;
  readonly reason: string | null;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly entrySha256: string;
}

/** Decisão publicada e AINDA NÃO confirmada (falta o recibo na pasta de âncoras): existe no disco, mas não vale e não entra em `operatorRecords`. */
export interface PendingDto {
  readonly confirmed: false;
  readonly seq: number;
  readonly action: 'RECORD' | 'REVOKE';
  readonly decisionId: string | null;
  readonly revokes: string | null;
  readonly supersedes: string | null;
  /**
   * ORIGEM comprovada pelo SERVIDOR (etiqueta HMAC com chave fora das pastas): `PROVEN`; `UNPROVEN` (sem etiqueta, adulterada, forjada ou
   * de outra chave: NÃO pode ser concluída); `UNVERIFIABLE` (este servidor não tem chave para comprovar). O arquivo, sozinho, nunca prova nada.
   */
  readonly origin: OriginStatus;
  /** Por que não foi comprovada (`null` quando comprovada). Não revela a etiqueta nem a chave. */
  readonly originDetail: Exclude<OriginVerdict, 'PROVEN'> | null;
  /** Origem COMPROVADA e o autor autenticado é a sessão atual. Nunca derivado só do campo "autor" do arquivo. */
  readonly isMine: boolean;
  /** Só quando `isMine`: o motivo da revogação (texto do próprio autor). `null` para os demais. */
  readonly reason: string | null;
  /** Só quando `isMine`: o registro como foi enviado (permite ao autor conferir e reenviar exatamente o mesmo pedido). `null` para os demais. */
  readonly record: ClientRecord | null;
  readonly recordedAt: string;
  /** Autor afirmado pelo arquivo SÓ quando a origem foi comprovada; senão `null` (uma pendente forjada pode citar qualquer pessoa). */
  readonly recordedBy: string | null;
  readonly entrySha256: string;
}

export interface ListPayload {
  readonly auditId: string;
  /** Head das decisões CONFIRMADAS (decisão + recibo). A pendente nunca é o head. */
  readonly head: Head | null;
  /** Decisão publicada sem recibo (no máximo 1). Enquanto existir, a pontuação (6C) NÃO deve ser finalizada. */
  readonly pending: PendingDto | null;
  /**
   * `false` enquanto houver decisão pendente. Uma pendente pode ser tanto uma gravação interrompida quanto um RECIBO REMOVIDO de
   * uma decisão já confirmada (indistinguíveis). Se for uma REVOGAÇÃO (ou substituição), a decisão afetada NÃO é projetada como vigente:
   * sai de `decisions` e de `operatorRecords` e aparece como `AMBIGUOUS` em `allDecisions`/`ambiguousDecisionIds`. A 6C NÃO PODE finalizar
   * pontuação com `finalizable: false` (o 'não finalizar' é do consumidor; aqui é o sinal).
   */
  readonly finalizable: boolean;
  /**
   * Testemunha do histórico. `HISTORY_REGRESSED` / `HISTORY_DIVERGES` / `UNAVAILABLE` = integridade NÃO resolvida: `decisions` e `operatorRecords`
   * ficam VAZIOS, toda decisão antes vigente aparece `AMBIGUOUS` e `finalizable` é `false`. `RECEIPT_LOST_WITNESSED` = a pendente já estava confirmada.
   */
  readonly witness: WitnessVerdict;
  /** Somente as vigentes (sem as `AMBIGUOUS`). */
  readonly decisions: readonly DecisionDto[];
  /** Identificadores das decisões em dúvida por causa da operação pendente (só ids; vazio sem pendente). Nenhum conteúdo privado. */
  readonly ambiguousDecisionIds: readonly string[];
  /** Histórico completo (criação, substituição e revogação), em ordem. */
  readonly history: readonly HistoryEntryDto[];
  /** Todas as decisões (inclusive substituídas e revogadas) com o estado atual. */
  readonly allDecisions: readonly DecisionDto[];
  /** `operatorRecords` da entrada do motor da 6A (somente as vigentes). Atestado/observação dependem do escopo do site (ver `siteDependent`). */
  readonly operatorRecords: readonly OperatorRecord[];
  readonly limits: { readonly maxEffectiveRecords: number; readonly maxEntries: number; readonly reservedForRevocations: number };
  readonly anchors: AnchorSummary;
  readonly integrity: {
    readonly status: 'OK';
    readonly algorithm: 'SHA-256';
    readonly checkedFiles: number;
    /** Arquivos fora do padrão que não se parecem com entradas (ignorados) e temporários órfãos. */
    readonly ignoredFiles: number;
    readonly note: string;
  };
}

export interface CreatePayload {
  readonly decision: DecisionDto;
  readonly head: Head;
  readonly effectiveCount: number;
  /** Sempre `true`: sucesso só é devolvido com decisão E recibo duráveis. */
  readonly anchored: true;
  /** `true` ⇒ o pedido já tinha sido aplicado (reenvio): nada novo foi gravado (ou só o recibo da pendente foi concluído). */
  readonly replayed: boolean;
  readonly anchors: AnchorSummary;
}

export interface RevokePayload {
  readonly revocation: HistoryEntryDto;
  readonly revoked: DecisionDto;
  readonly head: Head;
  readonly effectiveCount: number;
  readonly anchored: true;
  readonly replayed: boolean;
  readonly anchors: AnchorSummary;
}

const SITE_DEPENDENT: ReadonlySet<string> = new Set(['SITE_SCOPE_ATTESTATION', 'OBSERVATION_CONFIRMATION']);

const toDto = (view: DecisionView, ambiguous = false): DecisionDto => ({
  decisionId: view.decisionId,
  seq: view.seq,
  kind: view.record.kind,
  record: view.record,
  recordedAt: view.recordedAt,
  recordedBy: view.recordedBy,
  supersedes: view.supersedes,
  supersededBy: view.supersededBy,
  revokedAtSeq: view.revokedAtSeq,
  status: ambiguous ? 'AMBIGUOUS' : view.status,
  basis: view.basis,
  siteDependent: SITE_DEPENDENT.has(view.record.kind),
});

/**
 * Decisões cujo estado depende de uma operação PENDENTE: a revogada e/ou a substituída por ela. Sem recibo não se sabe se a operação valeu
 * (gravação interrompida × recibo removido): projetar a anterior como vigente seria afirmar uma certeza que o histórico não dá.
 */
function ambiguousTargets(state: LogState, pending: DecisionEntry | null): ReadonlySet<string> {
  if (!pending) return new Set();
  const target = pending.action === 'REVOKE' ? pending.revokes : pending.supersedes;
  return target !== null && state.effective.some((view) => view.decisionId === target) ? new Set([target]) : new Set();
}

const toHistory = (entry: DecisionEntry): HistoryEntryDto => ({
  seq: entry.seq,
  action: entry.action,
  decisionId: entry.action === 'RECORD' ? entry.decisionId : null,
  revokes: entry.action === 'REVOKE' ? entry.revokes : null,
  supersedes: entry.action === 'RECORD' ? entry.supersedes : null,
  reason: entry.action === 'REVOKE' ? entry.reason : null,
  recordedAt: entry.recordedAt,
  recordedBy: entry.recordedBy,
  entrySha256: entry.contentSha256,
});

const toPending = (entry: DecisionEntry, viewer: Viewer): PendingDto => {
  const verdict = judgeOrigin(viewer.origin, 'DECISION', entry);
  const proven = verdict === 'PROVEN';
  const mine = proven && viewer.operator !== null && entry.recordedBy === viewer.operator;
  return {
    confirmed: false,
    seq: entry.seq,
    action: entry.action,
    decisionId: entry.action === 'RECORD' ? entry.decisionId : null,
    revokes: entry.action === 'REVOKE' ? entry.revokes : null,
    supersedes: entry.action === 'RECORD' ? entry.supersedes : null,
    origin: originStatusOf(verdict),
    originDetail: proven ? null : verdict,
    isMine: mine,
    reason: mine && entry.action === 'REVOKE' ? entry.reason : null,
    record: mine && entry.action === 'RECORD' ? entry.record : null,
    recordedAt: entry.recordedAt,
    recordedBy: proven ? entry.recordedBy : null,
    entrySha256: entry.contentSha256,
  };
};

const headOf = (state: LogState): Head => {
  if (!state.head) throw new Error('histórico vazio');
  return { seq: state.head.seq, sha256: state.head.sha256 };
};

const currentHead = (state: LogState): Head | null => (state.head ? { seq: state.head.seq, sha256: state.head.sha256 } : null);

/** Referências citadas por TODOS os registros vigentes + o candidato (para a validação cruzada da 6A). */
const allRefs = (views: readonly Pick<DecisionView, 'record'>[], extra: ClientRecord): string[] => [...views.flatMap((view) => referencedEvidence(view.record)), ...referencedEvidence(extra)];

/** Hora do servidor SEMPRE com milissegundos (a ordenação monotônica compara texto). */
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_ANY = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
export type Clock = string | (() => string);
const clockOf = (now: Clock): (() => string) => (typeof now === 'function' ? now : () => now);

function zodIssues(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string[] {
  return error.issues.slice(0, 10).map((issue) => `${issue.path.map(String).join('.') || '(corpo)'}: ${issue.message}`);
}

/** Controle (exceto \n e \t), separadores de linha, bidi, zero-width e outros invisíveis: dado imutável não pode carregá-los. */
const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/;

function hiddenCharacterPath(value: unknown, where = '(corpo)', depth = 0): string | null {
  if (typeof value === 'string') return HIDDEN_CHARACTERS.test(value) ? where : null;
  if (depth > 8 || value === null || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const found = hiddenCharacterPath(child, `${where}.${key}`, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Compara a visão do operador com o histórico relido (dentro da trava). */
function headProblem(state: LogState, expected: ExpectedHead | null): ServiceFailure | null {
  const current = currentHead(state);
  const withHead = (code: ServiceErrorCode, ...issues: string[]): ServiceFailure => ({ ...failure(code, ...issues), head: current });
  if (expected === null) return current === null ? null : withHead('HEAD_MISMATCH', 'O histórico já tem decisões; recarregue.');
  if (current === null || expected.seq > current.seq) {
    return withHead('HISTORY_REGRESSED', `A sua visão chegava à posição ${expected.seq}; o histórico atual chega à ${current?.seq ?? 0}.`);
  }
  const at = state.entries[expected.seq - 1];
  if (!at || at.contentSha256 !== expected.sha256) return withHead('HEAD_MISMATCH', `O conteúdo da posição ${expected.seq} difere da sua visão.`);
  if (expected.seq < current.seq) return withHead('HEAD_MISMATCH', 'Outras decisões foram gravadas depois da sua visão; recarregue.');
  return null;
}

/**
 * Antes de CONCLUIR uma pendente por reenvio, revalida o que a gravação original já exigia (e que uma entrada forjada na
 * pasta de decisões não passou por): data nem posterior ao relógio do servidor nem anterior à da entrada anterior (a hora é
 * monotônica), captura/revisão de relatório que EXISTEM no serviço de evidências (por existência, não por "a mais recente":
 * uma captura nova depois da gravação não invalida um reenvio legítimo) e o contrato da 6A sobre o conjunto vigente. Se algo
 * não confere, ela continua pendente (e bloqueando) para a quarentena.
 */
function pendingProblem(state: LogState, pending: DecisionEntry, nowIso: string, available: ReadonlySet<string> | null, viewer: Viewer): ServiceFailure | null {
  const issues: string[] = [];
  if (pending.recordedAt > nowIso) issues.push('A data da decisão pendente é posterior ao relógio do servidor.');
  const previous = state.entries[state.entries.length - 1];
  if (previous && pending.recordedAt < previous.recordedAt) issues.push('A data da decisão pendente é anterior à da entrada anterior.');
  if (pending.action === 'RECORD') {
    const basis = pending.basis;
    if (available !== null) {
      if (basis.capture !== null && !available.has(captureRef(basis.capture))) issues.push('A pendente cita uma captura que não existe no serviço de evidências.');
      if (basis.report !== null && !available.has(reportRef(basis.report.capture, basis.report.revision))) issues.push('A pendente cita uma revisão de relatório que não existe no serviço de evidências.');
    }
    const remaining = state.effective.filter((decision) => decision.decisionId !== pending.supersedes);
    const candidate = { decisionId: pending.decisionId, record: pending.record, recordedBy: pending.recordedBy, recordedAt: pending.recordedAt };
    issues.push(...checkOperatorRecordsContract([...remaining.map(toScoringRecord), toScoringRecord(candidate)], allRefs(remaining, pending.record), pending.recordedAt).slice(0, 5));
  }
  return issues.length > 0 ? { ...fromPending({ code: 'PENDING_UNCONFIRMED', state, pending }, viewer), issues } : null;
}

/** Falha de `appendEntry`: recusa de domínio, entrada pendente (sem recibo) ou erro de armazenamento. Nunca vira sucesso. */
function failedAppend(appended: Exclude<Awaited<ReturnType<typeof appendEntry<ServiceFailure>>>, { ok: true }>, viewer: Viewer): ServiceFailure {
  if ('pending' in appended) return fromPending(appended, viewer);
  if (appended.code === 'REJECTED') return appended.failure;
  return fromStore(appended);
}

export function createDecisionService(options: DecisionServiceOptions) {
  const ops = options.fs ?? nodeFsOps;
  const projectRoot = options.projectRoot ?? process.cwd();
  const storeOptions = { fs: ops, projectRoot, anchorDir: options.anchorDir, ...(options.origin ? { origin: options.origin } : {}) };

  async function realOrResolved(target: string): Promise<string> {
    try {
      return (await ops.realpath(target)).toLowerCase();
    } catch {
      return path.resolve(target).toLowerCase();
    }
  }

  /** Bases válidas e SEPARADAS entre si: decisões, âncoras e evidências (nenhuma igual, nenhuma dentro da outra). */
  async function checkConfiguration(): Promise<ServiceFailure | null> {
    const decisions = assertDecisionBase(options.baseDir, projectRoot);
    const anchors = assertBase(options.anchorDir, projectRoot, 'âncoras');
    if (!decisions.ok || !anchors.ok) return failure('DECISIONS_MISCONFIGURED');
    const resolved = [await realOrResolved(decisions.value), await realOrResolved(anchors.value)];
    if (options.evidenceBaseDir !== undefined) resolved.push(await realOrResolved(options.evidenceBaseDir));
    const inside = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep);
    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        if (inside(resolved[i] as string, resolved[j] as string) || inside(resolved[j] as string, resolved[i] as string)) return failure('DECISIONS_MISCONFIGURED');
      }
    }
    return null;
  }

  const validAuditId = (auditId: unknown): auditId is string => typeof auditId === 'string' && AUDIT_ID_PATTERN.test(auditId);

  function operatorOf(actor: EvidenceActorLike): string | null {
    const email = typeof actor?.email === 'string' ? actor.email.trim().toLowerCase() : '';
    return email.length > 0 && email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
  }

  /** Corpo do cliente: sem chaves de pontuação, sem caracteres ocultos, no formato estrito. */
  function parseBody<T>(
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } } },
    body: unknown,
  ): ServiceResult<T> {
    const forbidden = findClientProvidedScoreKeys(body);
    if (forbidden === null) return failure('INVALID_BODY', 'Corpo grande demais para ser analisado.');
    if (forbidden.length > 0) return failure('FORBIDDEN_FIELDS', ...forbidden.slice(0, 10).map((key) => `campo não aceito: ${key}`));
    const hidden = hiddenCharacterPath(body);
    if (hidden) return failure('INVALID_BODY', `${hidden}: caracteres de controle, de direção de texto ou invisíveis não são permitidos.`);
    const parsed = schema.safeParse(body);
    if (!parsed.success) return failure('INVALID_BODY', ...zodIssues(parsed.error));
    return { ok: true, value: parsed.data };
  }

  const HEAD_OK = (head: { seq: unknown; sha256: unknown } | null | undefined): head is { seq: number; sha256: string } =>
    Number.isInteger(head?.seq) && (head?.seq as number) >= 1 && (head?.seq as number) <= MAX_SEQ && typeof head?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(head.sha256);
  /** Máximo de cabeças aceitas de uma fonte (uma por resultado + pendente): acima disso a fonte é tratada como não confiável (DoS). */
  const MAX_KNOWN_HEADS = 2000;

  /**
   * Cabeças conhecidas da fonte independente. `null` = `WITNESS_NOT_REQUIRED` (só testes). Exceção, resposta malformada ou excessiva NUNCA viram "sem
   * cabeças": viram falha explícita (`STORAGE_UNAVAILABLE` / `UNTRUSTED`), isto é, integridade NÃO resolvida.
   */
  async function readKnownHeads(auditId: string): Promise<KnownHeadsRead | null> {
    if (options.knownHeads === WITNESS_NOT_REQUIRED) return null;
    try {
      const read = await options.knownHeads(auditId);
      if (!read || typeof read !== 'object') return { ok: false, reason: 'UNTRUSTED' };
      if (read.ok === false) return { ok: false, reason: read.reason === 'NOT_CONFIGURED' || read.reason === 'UNTRUSTED' ? read.reason : 'STORAGE_UNAVAILABLE' };
      if (read.ok !== true || !Array.isArray(read.heads)) return { ok: false, reason: 'UNTRUSTED' };
      const hints = read.unverifiedHeads ?? [];
      if (!Array.isArray(hints) || read.heads.length + hints.length > MAX_KNOWN_HEADS) return { ok: false, reason: 'UNTRUSTED' };
      if (!read.heads.every(HEAD_OK) || !hints.every(HEAD_OK)) return { ok: false, reason: 'UNTRUSTED' };
      return { ok: true, heads: read.heads.map((head) => ({ seq: head.seq, sha256: head.sha256 })), unverifiedHeads: hints.map((head) => ({ seq: head.seq, sha256: head.sha256 })) };
    } catch {
      return { ok: false, reason: 'STORAGE_UNAVAILABLE' };
    }
  }

  const chained = (entry: DecisionEntry): { seq: number; contentSha256: string; affectsPrior: boolean } => ({
    seq: entry.seq,
    contentSha256: entry.contentSha256,
    affectsPrior: entry.action === 'REVOKE' || (entry.action === 'RECORD' && entry.supersedes !== null),
  });

  function basisOf(versions: readonly VersionLike[]): DecisionBasis {
    const withCapture = versions.filter((version): version is VersionLike & { capture: number } => version.capture !== null);
    const latest = withCapture.reduce<(VersionLike & { capture: number }) | null>((best, version) => (best === null || version.capture > best.capture ? version : best), null);
    if (!latest) return { capture: null, report: null, collectedAt: null };
    const revisions = latest.reportRevisions.map((r) => r.revision);
    const collectedAt = latest.collectedAt !== null && latest.collectedAt.length <= 40 && ISO_ANY.test(latest.collectedAt) ? latest.collectedAt : null;
    return {
      capture: latest.capture,
      report: revisions.length > 0 ? { capture: latest.capture, revision: Math.max(...revisions) } : null,
      collectedAt,
    };
  }

  return {
    /** Decisões vigentes, histórico completo, âncoras e a projeção para o motor. Nada é devolvido se a verificação falhar. */
    async list(actor: EvidenceActorLike, auditId: string): Promise<ServiceResult<ListPayload>> {
      if (!validAuditId(auditId)) return failure('INVALID_PARAMS', 'auditId inválido.');
      const config = await checkConfiguration();
      if (config) return config;
      const integrity = await options.evidence.getIntegrity(actor, auditId);
      if (!integrity) return failure('AUDIT_NOT_FOUND');
      const read = await readLog(options.baseDir, auditId, storeOptions);
      if (!read.ok) return fromStore(read);
      const { state, pending, checkedFiles, anchors, unexpectedFiles, orphanTempFiles } = read.value;
      // TESTEMUNHA: sem integridade resolvida nenhuma decisão é projetada como vigente (falha fechada); senão, só as afetadas por operação pendente ficam em dúvida
      const witness = evaluateKnownHeads(state.entries.map(chained), pending ? chained(pending) : null, await readKnownHeads(auditId));
      const unresolved = isUnresolved(witness.status);
      const ambiguous: ReadonlySet<string> = unresolved ? new Set(state.effective.map((view) => view.decisionId)) : ambiguousTargets(state, pending);
      const settled = state.effective.filter((view) => !ambiguous.has(view.decisionId));
      return {
        ok: true,
        value: {
          auditId,
          head: currentHead(state),
          pending: pending ? toPending(pending, { operator: operatorOf(actor), origin: options.origin }) : null,
          finalizable: pending === null && !unresolved,
          witness,
          decisions: settled.map((view) => toDto(view)),
          ambiguousDecisionIds: [...ambiguous],
          history: state.entries.map(toHistory),
          allDecisions: state.decisions.map((view) => toDto(view, ambiguous.has(view.decisionId))),
          operatorRecords: effectiveScoringRecords({ effective: settled }),
          limits: { maxEffectiveRecords: MAX_EFFECTIVE_RECORDS, maxEntries: MAX_SEQ, reservedForRevocations: RESERVED_FOR_REVOCATIONS },
          anchors,
          integrity: { status: 'OK', algorithm: 'SHA-256', checkedFiles, ignoredFiles: unexpectedFiles.length + orphanTempFiles.length, note: INTEGRITY_NOTE },
        },
      };
    },

    /** Cria uma decisão (ou substitui explicitamente uma vigente). A hora é a do SERVIDOR (`now`). */
    async create(actor: EvidenceActorLike, auditId: string, body: unknown, now: Clock): Promise<ServiceResult<CreatePayload>> {
      if (!validAuditId(auditId)) return failure('INVALID_PARAMS', 'auditId inválido.');
      const clock = clockOf(now);
      if (!ISO_MS.test(clock())) return failure('INTERNAL_ERROR');
      const config = await checkConfiguration();
      if (config) return config;
      if (!options.origin) return failure('ORIGIN_KEY_NOT_CONFIGURED'); // sem autenticador de origem nada é gravado (as rotas já respondem 503)
      const parsed = parseBody(createBodySchema, body);
      if (!parsed.ok) return parsed;
      const { record, supersedes, expectedHead } = parsed.value;
      const operator = operatorOf(actor);
      if (operator === null) return failure('OPERATOR_IDENTITY_INVALID');
      const viewer: Viewer = { operator, origin: options.origin };

      const integrity = await options.evidence.getIntegrity(actor, auditId);
      if (!integrity) return failure('AUDIT_NOT_FOUND');
      if (integrity.integrity.status === 'MISMATCH' || integrity.state === 'CORRUPT') return failure('EVIDENCE_INTEGRITY');

      const refs = referencedEvidence(record);
      const unusable = refs.filter((ref) => {
        const parsedRef = parseEvidenceRef(ref);
        return parsedRef === null || parsedRef.kind === 'site';
      });
      if (unusable.length > 0) {
        return failure('INVALID_EVIDENCE_REFERENCE', 'Use capture:cNNNN ou report:cNNNN-rNNNN (site:cNNNN ainda não é verificável e não é aceito).');
      }
      const versions = await options.evidence.listVersions(actor, auditId);
      const available = availableRefs(versions);
      const missing = refs.filter((ref) => !available.has(ref));
      if (missing.length > 0) return failure('EVIDENCE_REFERENCE_NOT_FOUND', ...missing.slice(0, 10).map((ref) => `não existe: ${ref}`));
      const basis = basisOf(versions);

      const wanted: OperationSpec = { action: 'RECORD', record, supersedes: supersedes ?? null };
      const heads = await readKnownHeads(auditId);
      const appended = await appendEntry<ServiceFailure>(
        options.baseDir,
        auditId,
        ({ state, pending, entries, seq, recordedAt }) => {
          // Integridade do histórico NÃO resolvida (testemunha): nem escrita nova nem a conclusão de pendente (falha fechada)
          const witness = evaluateKnownHeads(state.entries.map(chained), pending ? chained(pending) : null, heads);
          if (isUnresolved(witness.status)) return { ok: false, failure: { ...failure('DECISIONS_HISTORY_UNRESOLVED', `testemunha: ${witness.status}`), head: currentHead(state) } };
          // Reenvio do MESMO pedido (resposta perdida, recibo que falhou): idempotente, antes de qualquer outra regra.
          const again = findReplay(entries, expectedHead, operator, wanted);
          if (again !== null) {
            const suspect = pending && again === pending.seq ? pendingProblem(state, pending, clock(), available, viewer) : null;
            return suspect ? { ok: false, failure: suspect } : { ok: true, replayOf: again };
          }
          if (pending) return { ok: false, failure: fromPending({ code: 'PENDING_UNCONFIRMED', state, pending }, viewer) };
          const stale = headProblem(state, expectedHead);
          if (stale) return { ok: false, failure: stale };
          // As últimas entradas só aceitam revogações (a auditoria nunca fica "congelada" sem poder revogar).
          if (seq > MAX_SEQ - RESERVED_FOR_REVOCATIONS) {
            return { ok: false, failure: failure('LIMIT_REACHED', `As últimas ${RESERVED_FOR_REVOCATIONS} entradas do histórico são reservadas a revogações.`) };
          }
          const ignore = new Set<string>();
          if (supersedes !== undefined) {
            const target = state.decisions.find((decision) => decision.decisionId === supersedes);
            if (!target) return { ok: false, failure: failure('DECISION_NOT_FOUND') };
            if (target.status !== 'ACTIVE') return { ok: false, failure: failure('DECISION_NOT_ACTIVE', `${supersedes} está ${target.status === 'REVOKED' ? 'revogada' : 'substituída'}.`) };
            if (!canSupersede(target, record)) {
              return {
                ok: false,
                failure: failure('SUPERSEDE_INVALID', 'Só é possível substituir uma decisão do mesmo tipo que cubra todos os subcritérios da anterior (para retirar ou trocar de assunto, revogue).'),
              };
            }
            ignore.add(supersedes);
          }
          const clashes = slotConflicts(state.effective, record, ignore);
          if (clashes.length > 0) {
            return {
              ok: false,
              failure: failure(
                'SUPERSEDE_REQUIRED',
                supersedes === undefined
                  ? `Já vigente(s): ${clashes.join(', ')}. Envie "supersedes" com o identificador para substituir (a anterior permanece no histórico); se for de natureza diferente (juízo × N/A), revogue antes.`
                  : `Além de ${supersedes}, ainda há decisão(ões) vigente(s) no mesmo subcritério: ${clashes.join(', ')}. Revogue-a(s) antes (revogação não apaga).`,
              ),
            };
          }
          const remaining = state.effective.filter((decision) => !ignore.has(decision.decisionId));
          if (remaining.length + 1 > MAX_EFFECTIVE_RECORDS) return { ok: false, failure: failure('LIMIT_REACHED', `No máximo ${MAX_EFFECTIVE_RECORDS} decisões vigentes por auditoria.`) };
          const decisionId = decisionIdFor(seq);
          const candidate = { decisionId, record, recordedBy: operator, recordedAt };
          const contractIssues = checkOperatorRecordsContract([...remaining.map(toScoringRecord), toScoringRecord(candidate)], allRefs(remaining, record), recordedAt);
          if (contractIssues.length > 0) return { ok: false, failure: failure('CONTRACT_REJECTED', ...contractIssues.slice(0, 10)) };
          const draft: DecisionDraft = {
            schemaVersion: DECISION_SCHEMA_VERSION,
            kind: DECISION_FILE_KIND,
            auditId,
            action: 'RECORD',
            recordedAt,
            recordedBy: operator,
            decisionId,
            record,
            supersedes: supersedes ?? null,
            basis,
          };
          return { ok: true, draft };
        },
        { ...storeOptions, now: clock },
      );
      if (!appended.ok) return failedAppend(appended, viewer);
      const entry = appended.entry;
      if (entry.action !== 'RECORD') return failure('INTERNAL_ERROR');
      const view = appended.state.decisions.find((decision) => decision.decisionId === entry.decisionId);
      if (!view) return failure('INTERNAL_ERROR');
      return {
        ok: true,
        value: { decision: toDto(view), head: headOf(appended.state), effectiveCount: appended.state.effective.length, anchored: appended.anchored, replayed: appended.replayed, anchors: appended.anchors },
      };
    },

    /** Revoga uma decisão vigente criando uma NOVA entrada (a original permanece). */
    async revoke(actor: EvidenceActorLike, auditId: string, body: unknown, now: Clock): Promise<ServiceResult<RevokePayload>> {
      if (!validAuditId(auditId)) return failure('INVALID_PARAMS', 'auditId inválido.');
      const clock = clockOf(now);
      if (!ISO_MS.test(clock())) return failure('INTERNAL_ERROR');
      const config = await checkConfiguration();
      if (config) return config;
      if (!options.origin) return failure('ORIGIN_KEY_NOT_CONFIGURED'); // sem autenticador de origem nada é gravado (as rotas já respondem 503)
      const parsed = parseBody(revokeBodySchema, body);
      if (!parsed.ok) return parsed;
      const operator = operatorOf(actor);
      if (operator === null) return failure('OPERATOR_IDENTITY_INVALID');
      const viewer: Viewer = { operator, origin: options.origin };
      const integrity = await options.evidence.getIntegrity(actor, auditId);
      if (!integrity) return failure('AUDIT_NOT_FOUND');

      const { revokes, reason, expectedHead } = parsed.value;
      const wanted: OperationSpec = { action: 'REVOKE', revokes, reason };
      const heads = await readKnownHeads(auditId);
      const appended = await appendEntry<ServiceFailure>(
        options.baseDir,
        auditId,
        ({ state, pending, entries, recordedAt }) => {
          const witness = evaluateKnownHeads(state.entries.map(chained), pending ? chained(pending) : null, heads);
          if (isUnresolved(witness.status)) return { ok: false, failure: { ...failure('DECISIONS_HISTORY_UNRESOLVED', `testemunha: ${witness.status}`), head: currentHead(state) } };
          const again = findReplay(entries, expectedHead, operator, wanted);
          if (again !== null) {
            const suspect = pending && again === pending.seq ? pendingProblem(state, pending, clock(), null, viewer) : null;
            return suspect ? { ok: false, failure: suspect } : { ok: true, replayOf: again };
          }
          if (pending) return { ok: false, failure: fromPending({ code: 'PENDING_UNCONFIRMED', state, pending }, viewer) };
          const stale = headProblem(state, expectedHead);
          if (stale) return { ok: false, failure: stale };
          const target = state.decisions.find((decision) => decision.decisionId === revokes);
          if (!target) return { ok: false, failure: failure('DECISION_NOT_FOUND') };
          if (target.status !== 'ACTIVE') {
            return { ok: false, failure: failure('DECISION_NOT_ACTIVE', `${revokes} já está ${target.status === 'REVOKED' ? 'revogada' : 'substituída'}.`) };
          }
          const draft: DecisionDraft = {
            schemaVersion: DECISION_SCHEMA_VERSION,
            kind: DECISION_FILE_KIND,
            auditId,
            action: 'REVOKE',
            recordedAt,
            recordedBy: operator,
            revokes,
            reason,
          };
          return { ok: true, draft };
        },
        { ...storeOptions, now: clock },
      );
      if (!appended.ok) return failedAppend(appended, viewer);
      const revoked = appended.state.decisions.find((decision) => decision.decisionId === revokes);
      if (!revoked) return failure('INTERNAL_ERROR');
      return {
        ok: true,
        value: {
          revocation: toHistory(appended.entry),
          revoked: toDto(revoked),
          head: headOf(appended.state),
          effectiveCount: appended.state.effective.length,
          anchored: appended.anchored,
          replayed: appended.replayed,
          anchors: appended.anchors,
        },
      };
    },
  };
}

export type DecisionService = ReturnType<typeof createDecisionService>;
