import type { AuditDetailDto } from '@/lib/link-audit-evidence';
import { safeText } from './labels';
import type { Blocker, DecisionRequest, DecisionsList, FinalizeRequest, FinalizeSuccess, Head, LedgerActionResult, PendingRun, PreviewPayload, ResultsList, RunDetailResponse } from './types';
import { blockerOk, isDecisionsPayload, isEvidencePayload, isFinalizePayload, isHead, isLedgerActionPayload, isObj, isPreviewPayload, isResultsPayload, isRunDetailPayload } from './validators';

/*
 * Cliente HTTP da página da auditoria (I5). Roda no navegador: só `fetch` para o PRÓPRIO servidor (mesma origem, cookie de sessão).
 * Envia exclusivamente os corpos que as rotas aceitam (nunca pontuação, entrada do motor, autor ou data). Valida o formato da resposta
 * e nunca confia em texto da API: mensagens passam por `safeText` e são exibidas como texto.
 */
export type ApiFailure = {
  readonly kind: 'failure';
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly issues: readonly string[];
  readonly head?: Head | null;
  readonly blockers?: readonly Blocker[];
  readonly pending?: PendingRun | null;
  readonly retryAfterSeconds?: number;
};
export type ApiOutcome<T> =
  | { readonly kind: 'ok'; readonly status: number; readonly value: T }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden'; readonly message: string }
  /** 429: o limitador responde ANTES de qualquer processamento, então nada foi feito por esta requisição. */
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number; readonly fromHeader: boolean }
  | { readonly kind: 'network' }
  | { readonly kind: 'malformed' }
  | ApiFailure;

export const AUDIT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,63}$/;

export const DEFAULT_RATE_LIMIT_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 3600;

/**
 * Interpreta `Retry-After` com segurança: só aceita segundos inteiros (`^\d+$`, limitados a 1 h) ou uma data HTTP calculada contra o cabeçalho `Date`
 * DO SERVIDOR (nunca contra o relógio do cliente). Qualquer outra coisa (vazio, negativo, decimal, notação científica, texto, data sem
 * `Date`) é INVÁLIDA (`null`). Valores válidos ficam entre 1 s e 1 h.
 */
export function parseRetryAfter(header: string | null | undefined, serverDate: string | null | undefined): number | null {
  const value = (header ?? '').trim();
  if (value === '') return null;
  const clamp = (seconds: number): number => Math.min(Math.max(Math.ceil(seconds), 1), MAX_RETRY_AFTER_SECONDS);
  if (/^\d+$/.test(value)) return clamp(value.length > 15 ? Number.POSITIVE_INFINITY : Number(value)); // qualquer inteiro: o teto vale para todos (nunca "pedido maior ⇒ espera menor")
  if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    const target = Date.parse(value);
    const base = Date.parse((serverDate ?? '').trim());
    if (Number.isNaN(target) || Number.isNaN(base)) return null;
    return clamp((target - base) / 1000);
  }
  return null;
}

function pendingOf(value: unknown): PendingRun | null {
  if (!isObj(value) || typeof value.seq !== 'number' || typeof value.inputSha256 !== 'string' || typeof value.isMine !== 'boolean') return null;
  return value as unknown as PendingRun;
}

async function call<T>(method: 'GET' | 'POST', path: string, body: unknown, accept: (json: unknown) => T | null, signal?: AbortSignal): Promise<ApiOutcome<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      cache: 'no-store',
      redirect: 'error',
      credentials: 'same-origin',
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { kind: 'network' };
  }
  const parsedRetry = parseRetryAfter(response.headers.get('retry-after'), response.headers.get('date'));
  const retryAfterSeconds = parsedRetry ?? undefined;
  if (response.status === 401) return { kind: 'unauthorized' };
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const value = accept(json);
    return value === null ? { kind: 'malformed' } : { kind: 'ok', status: response.status, value };
  }
  const data = isObj(json) ? json : {};
  const code = typeof data.code === 'string' ? safeText(data.code, 60) : 'UNKNOWN';
  const message = safeText(data.error, 400) || 'Não foi possível concluir a operação.';
  if (response.status === 429) return { kind: 'rate_limited', retryAfterSeconds: retryAfterSeconds ?? DEFAULT_RATE_LIMIT_SECONDS, fromHeader: retryAfterSeconds !== undefined };
  if (response.status === 403) return { kind: 'forbidden', message };
  return {
    kind: 'failure',
    status: response.status,
    code,
    message,
    issues: Array.isArray(data.issues) ? data.issues.filter((item): item is string => typeof item === 'string').slice(0, 10).map((item) => safeText(item, 300)) : [],
    ...(data.head !== undefined && (data.head === null || isHead(data.head)) ? { head: data.head as Head | null } : {}),
    ...(Array.isArray(data.blockers) && data.blockers.every(blockerOk) ? { blockers: data.blockers as Blocker[] } : {}),
    ...(data.pending !== undefined ? { pending: pendingOf(data.pending) } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

const enc = encodeURIComponent;
export interface AuditApi {
  evidence(auditId: string, signal?: AbortSignal): Promise<ApiOutcome<AuditDetailDto>>;
  preview(auditId: string, signal?: AbortSignal): Promise<ApiOutcome<PreviewPayload>>;
  decisions(auditId: string, signal?: AbortSignal): Promise<ApiOutcome<DecisionsList>>;
  results(auditId: string, signal?: AbortSignal): Promise<ApiOutcome<ResultsList>>;
  resultDetail(auditId: string, seq: number, signal?: AbortSignal): Promise<ApiOutcome<RunDetailResponse>>;
  decide(auditId: string, request: DecisionRequest): Promise<ApiOutcome<Record<string, unknown>>>;
  finalize(auditId: string, request: FinalizeRequest): Promise<ApiOutcome<FinalizeSuccess>>;
  /** Livro de cabeças: inscrever (auditoria vazia) ou recuperar (verificável). Nunca adoção/restauração: essas exigem aprovação administrativa que não existe. */
  ledger(auditId: string, action: 'ENROLL' | 'RECOVER'): Promise<ApiOutcome<LedgerActionResult>>;
}

export const httpApi: AuditApi = {
  evidence: (id, signal) => call('GET', `/api/link-audit/evidence/${enc(id)}`, undefined, (json) => (isObj(json) && isEvidencePayload(json.audit, id) ? (json.audit as unknown as AuditDetailDto) : null), signal),
  preview: (id, signal) => call('GET', `/api/link-audit/scoring/${enc(id)}`, undefined, (json) => (isPreviewPayload(json, id) ? json : null), signal),
  decisions: (id, signal) => call('GET', `/api/link-audit/decisions/${enc(id)}`, undefined, (json) => (isDecisionsPayload(json, id) ? json : null), signal),
  results: (id, signal) => call('GET', `/api/link-audit/scoring/${enc(id)}/results`, undefined, (json) => (isResultsPayload(json, id) ? json : null), signal),
  resultDetail: (id, seq, signal) => call('GET', `/api/link-audit/scoring/${enc(id)}/results/${Math.trunc(seq)}`, undefined, (json) => (isRunDetailPayload(json, id, Math.trunc(seq)) ? json : null), signal),
  decide: (id, request) =>
    call('POST', request.kind === 'CREATE' ? `/api/link-audit/decisions/${enc(id)}` : `/api/link-audit/decisions/${enc(id)}/revocations`, request.body, (json) => (isObj(json) && json.anchored === true && typeof json.replayed === 'boolean' && isHead(json.head) ? json : null)),
  finalize: (id, request) =>
    call('POST', `/api/link-audit/scoring/${enc(id)}/finalize`, { expectedHead: request.expectedHead, expectedInputSha256: request.expectedInputSha256 }, (json) => (isFinalizePayload(json, id) ? json : null)),
  ledger: (id, action) => call('POST', `/api/link-audit/decisions/${enc(id)}/ledger`, { action }, (json) => (isLedgerActionPayload(json) ? json : null)),
};

/* nomes antigos (testes e usos externos): mesma validação, agora estrita */
export const isPreview = isPreviewPayload;
export const isDecisionsList = isDecisionsPayload;
export const isResultsList = isResultsPayload;
export const isRunDetail = isRunDetailPayload;
export const isFinalizeSuccess = isFinalizePayload;
