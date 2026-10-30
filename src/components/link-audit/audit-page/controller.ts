import type { AuditApi, ApiOutcome } from './api';
import { JUDGEMENT_C2_VALUES, safeText } from './labels';
import type { Action, OptionKey, PageState, Phase, SectionName } from './state';
import { finalizeEligibility } from './state';
import type { DecisionRequest, FinalizeRequest, Head } from './types';

/*
 * Fluxos da página da auditoria (I5): carregamentos independentes, finalização, decisões e revogação. A API é INJETADA (testável sem
 * React nem rede). Regras: o navegador nunca calcula pontuação; só envia expectedHead/expectedInputSha256 da prévia EXIBIDA e os
 * campos do formulário; sucesso só é mostrado depois que o servidor confirma (201/200) e o resultado é relido pela API de consulta.
 */
export interface Ctx {
  readonly api: AuditApi;
  readonly dispatch: (action: Action) => void;
  readonly getState: () => PageState;
  readonly auditId: string;
  /** Contadores por seção: uma resposta que chega depois de uma recarga mais nova é descartada. */
  readonly tokens: Record<SectionName | 'detail', number>;
  /** Relógio LOCAL, só para contar a espera do limite de taxa (injetável nos testes). */
  readonly now?: () => number;
}
const clock = (ctx: Ctx): number => (ctx.now ?? Date.now)();
const headEquals = (a: Head | null, b: Head | null): boolean => (a === null || b === null ? a === b : a.seq === b.seq && a.sha256 === b.sha256);
export const newTokens = (): Ctx['tokens'] => ({ evidence: 0, preview: 0, decisions: 0, results: 0, detail: 0 });

const INTEGRITY_CODES: ReadonlySet<string> = new Set([
  'EVIDENCE_INTEGRITY', 'INTEGRITY_FAILED', 'DECISIONS_INTEGRITY', 'DECISIONS_TRUNCATED', 'ANCHOR_MISMATCH', 'ANCHOR_INTEGRITY',
  'RESULT_INTEGRITY', 'RESULT_TRUNCATED', 'RESULT_ANCHOR_MISMATCH', 'RESULT_ANCHOR_INTEGRITY', 'AUDIT_IDENTITY_MISMATCH',
]);
/** Conflitos que INVALIDAM a prévia exibida: nada pode ser finalizado/gravado até uma nova consulta. */
const STALE_VIEW_CODES: ReadonlySet<string> = new Set(['HEAD_MISMATCH', 'HISTORY_REGRESSED', 'INPUT_CHANGED', 'EVIDENCE_HASH_CHANGED', 'WEBSITE_DERIVATION_MISMATCH', 'NOT_FINALIZABLE', 'SUPERSEDE_REQUIRED', 'SUPERSEDE_INVALID', 'DECISION_NOT_ACTIVE', 'EVIDENCE_REFERENCE_NOT_FOUND', 'WRITE_CONFLICT', 'RESULT_WRITE_CONFLICT', 'READ_INCONSISTENT']);

type Failed = Exclude<ApiOutcome<unknown>, { kind: 'ok' }>;

/** Qual leitura a falha de integridade atinge, POR CÓDIGO (não pela rota que a devolveu). */
function integritySections(code: string): SectionName[] {
  if (code.startsWith('RESULT_')) return ['results'];
  if (code.startsWith('DECISIONS_') || code.startsWith('ANCHOR_')) return ['decisions', 'preview'];
  return ['evidence', 'preview']; // EVIDENCE_INTEGRITY, INTEGRITY_FAILED, AUDIT_IDENTITY_MISMATCH
}
function markIntegrity(ctx: Ctx, out: Extract<Failed, { kind: 'failure' }>): void {
  const failure = sectionFailure(out);
  for (const section of integritySections(out.code)) ctx.dispatch({ type: 'SECTION_FAIL', section, ...failure });
}

/** Texto fixo para o operador; nunca ecoa valores desconhecidos. */
export function describeFailure(out: Failed): string {
  switch (out.kind) {
    case 'network': return 'Sem resposta do servidor. Verifique a conexão; o resultado da última operação pode não ter sido registrado.';
    case 'rate_limited': return `Muitas requisições em pouco tempo. Aguarde ${out.retryAfterSeconds} s${out.fromHeader ? '' : ' (tempo estimado: o servidor não informou)'} e tente de novo.`;
    case 'forbidden': return out.message || 'Acesso negado para esta operação.';
    case 'malformed': return 'Resposta inesperada do servidor. Recarregue antes de continuar.';
    case 'unauthorized': return 'Sessão expirada.';
    default: return out.message || 'Não foi possível concluir a operação.';
  }
}

function sectionFailure(out: Failed): { phase: Exclude<Phase, 'idle' | 'loading' | 'ready'>; message: string; code: string | null } {
  if (out.kind === 'forbidden') return { phase: 'denied', message: describeFailure(out), code: null };
  if (out.kind === 'failure') {
    if (INTEGRITY_CODES.has(out.code)) return { phase: 'integrity', message: describeFailure(out), code: out.code };
    if (out.status === 503) return { phase: 'unavailable', message: describeFailure(out), code: out.code };
    return { phase: 'error', message: describeFailure(out), code: out.code };
  }
  return { phase: 'error', message: describeFailure(out), code: null };
}

/* ------------------------------------------------------------------ leituras */
export async function loadSection(ctx: Ctx, name: SectionName): Promise<void> {
  const token = ++ctx.tokens[name];
  ctx.dispatch({ type: 'SECTION_START', section: name });
  const out = await (name === 'evidence' ? ctx.api.evidence(ctx.auditId) : name === 'preview' ? ctx.api.preview(ctx.auditId) : name === 'decisions' ? ctx.api.decisions(ctx.auditId) : ctx.api.results(ctx.auditId));
  if (token !== ctx.tokens[name]) return; // chegou depois de uma recarga mais nova
  if (out.kind === 'unauthorized') return ctx.dispatch({ type: 'UNAUTHORIZED' });
  if (out.kind === 'ok') {
    if (name === 'evidence') ctx.dispatch({ type: 'SECTION_OK', section: 'evidence', data: out.value as never });
    else if (name === 'preview') ctx.dispatch({ type: 'SECTION_OK', section: 'preview', data: out.value as never });
    else if (name === 'decisions') ctx.dispatch({ type: 'SECTION_OK', section: 'decisions', data: out.value as never });
    else ctx.dispatch({ type: 'SECTION_OK', section: 'results', data: out.value as never });
    return;
  }
  ctx.dispatch({ type: 'SECTION_FAIL', section: name, ...sectionFailure(out) });
}

export async function loadAll(ctx: Ctx): Promise<void> {
  await Promise.all((['evidence', 'preview', 'decisions', 'results'] as const).map((name) => loadSection(ctx, name)));
}
/** Depois de uma mudança, só o que ela afeta (poucas requisições, respeitando os limites de taxa). */
export const reload = (ctx: Ctx, names: readonly SectionName[]): Promise<void[]> => Promise.all(names.map((name) => loadSection(ctx, name)));

export async function selectResult(ctx: Ctx, seq: number | null): Promise<void> {
  const token = ++ctx.tokens.detail;
  ctx.dispatch({ type: 'DETAIL_SELECT', seq });
  if (seq === null) return;
  const out = await ctx.api.resultDetail(ctx.auditId, seq);
  if (token !== ctx.tokens.detail) return;
  if (out.kind === 'unauthorized') return ctx.dispatch({ type: 'UNAUTHORIZED' });
  if (out.kind === 'ok') return ctx.dispatch({ type: 'DETAIL_OK', seq, data: out.value });
  const failure = sectionFailure(out);
  ctx.dispatch({ type: 'DETAIL_FAIL', seq, phase: failure.phase === 'integrity' ? 'integrity' : 'error', message: failure.message });
  if (failure.phase === 'integrity') ctx.dispatch({ type: 'SECTION_FAIL', section: 'results', ...failure });
}

/* ------------------------------------------------------------------ finalização */
export function openFinalize(ctx: Ctx): void {
  const state = ctx.getState();
  const eligibility = finalizeEligibility(state, clock(ctx));
  const data = state.preview.data;
  if (!eligibility.allowed || !data || data.finalization.expectedInputSha256 === null || !data.outcomePreview) {
    ctx.dispatch({ type: 'NOTICE', notice: { tone: 'warning', text: eligibility.reason ?? 'Não é possível finalizar agora.' } });
    return;
  }
  // o pedido é CAPTURADO da prévia exibida neste instante; recarregar a prévia depois não o altera (nem o reaproveita)
  const request: FinalizeRequest = { expectedHead: data.finalization.expectedHead, expectedInputSha256: data.finalization.expectedInputSha256 };
  ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'confirming', request, outcome: data.outcomePreview.outcome, acknowledged: false } });
}
export const cancelFinalize = (ctx: Ctx): void => {
  if (ctx.getState().finalize.phase === 'confirming') ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'idle' } });
};

export async function confirmFinalize(ctx: Ctx): Promise<void> {
  const flow = ctx.getState().finalize;
  if (flow.phase !== 'confirming' || !flow.acknowledged) return;
  // a prévia pode ter sido invalidada ou recarregada com a caixa aberta: o pedido capturado só vale se ainda for a prévia exibida
  const data = ctx.getState().preview.data;
  const stillShown = data && ctx.getState().preview.invalidated === null && data.finalization.expectedInputSha256 === flow.request.expectedInputSha256 && JSON.stringify(data.finalization.expectedHead) === JSON.stringify(flow.request.expectedHead);
  if (!stillShown) {
    ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'idle' } });
    ctx.dispatch({ type: 'NOTICE', notice: { tone: 'warning', text: 'A prévia mudou enquanto a confirmação estava aberta. Revise a nova prévia e confirme de novo.' } });
    return;
  }
  await submitFinalize(ctx, flow.request, false);
}

/** Reenvio de recuperação: SOMENTE o pedido original (o mesmo corpo); o servidor exige o mesmo operador. */
export async function retryFinalize(ctx: Ctx): Promise<void> {
  const flow = ctx.getState().finalize;
  if (flow.phase === 'rate_limited') {
    // enquanto o limite vale NADA é enviado; depois dele, só por ação manual e só o MESMO pedido
    if (clock(ctx) < flow.until) return ctx.dispatch({ type: 'NOTICE', notice: { tone: 'info', text: `Aguarde o fim do limite de requisições (cerca de ${Math.max(1, Math.ceil((flow.until - clock(ctx)) / 1000))} s).` } });
    return submitFinalize(ctx, flow.request, true);
  }
  if (flow.phase === 'anchor_pending' || (flow.phase === 'error' && flow.request)) await submitFinalize(ctx, flow.request as FinalizeRequest, true);
}

/** Resultado pendente DESTA sessão, vindo do histórico (depois de recarregar a página): o pedido é reconstruído só do que a API expõe. */
export async function completePendingRun(ctx: Ctx): Promise<void> {
  const pending = ctx.getState().results.data?.pending;
  if (!pending || !pending.isMine) return;
  await submitFinalize(ctx, { expectedHead: pending.decisionsHead, expectedInputSha256: pending.inputSha256 }, true);
}

async function submitFinalize(ctx: Ctx, request: FinalizeRequest, recovery: boolean): Promise<void> {
  // GUARDA ÚNICA para todas as rotas de envio (confirmar, reenviar, concluir pendente): nada é enviado com outro envio em andamento
  // nem dentro do prazo de um 429
  const current = ctx.getState().finalize;
  if (current.phase === 'submitting' || current.phase === 'verifying') return;
  if (current.phase === 'rate_limited' && clock(ctx) < current.until) {
    return ctx.dispatch({ type: 'NOTICE', notice: { tone: 'info', text: `Aguarde o fim do limite de requisições (cerca de ${Math.max(1, Math.ceil((current.until - clock(ctx)) / 1000))} s).` } });
  }
  ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'submitting', request, recovery } });
  ctx.dispatch({ type: 'NOTICE', notice: null });
  const out = await ctx.api.finalize(ctx.auditId, request);
  if (out.kind === 'unauthorized') return ctx.dispatch({ type: 'UNAUTHORIZED' });
  if (out.kind === 'ok') {
    const seq = out.value.run.seq;
    ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'verifying', seq } });
    // "Após a confirmação, recarregar o resultado verificado": a lista e o detalhe passam pela verificação integral do servidor
    ctx.tokens.results++; // uma leitura anterior ainda em voo não pode sobrescrever a lista nova
    ctx.tokens.detail++;
    const [list, detail] = await Promise.all([ctx.api.results(ctx.auditId), ctx.api.resultDetail(ctx.auditId, seq)]);
    const listed = list.kind === 'ok' ? list.value : null;
    const run = out.value.run;
    const matchesRequest = run.hashes.inputSha256 === request.expectedInputSha256 && headEquals(run.decisions.head, request.expectedHead); // o registro confirmado é o do pedido enviado
    const verified = matchesRequest && listed !== null && detail.kind === 'ok' && detail.value.run.hashes.contentSha256 === run.hashes.contentSha256 && listed.results.some((item) => item.seq === seq && item.contentSha256 === run.hashes.contentSha256);
    if (listed) ctx.dispatch({ type: 'SECTION_OK', section: 'results', data: listed });
    else if (list.kind !== 'ok' && list.kind !== 'unauthorized') ctx.dispatch({ type: 'SECTION_FAIL', section: 'results', ...sectionFailure(list) });
    if (detail.kind === 'ok') {
      ctx.dispatch({ type: 'DETAIL_SELECT', seq });
      ctx.dispatch({ type: 'DETAIL_OK', seq, data: detail.value });
    }
    ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'done', seq, replayed: out.value.replayed, recovered: out.value.recoveredPending, changedAfter: out.value.stateChangedAfterFinalization, verified } });
    ctx.dispatch({
      type: 'NOTICE',
      notice: verified
        ? { tone: out.value.stateChangedAfterFinalization === true ? 'warning' : 'success', text: out.value.stateChangedAfterFinalization === true ? `Resultado s${String(seq).padStart(4, '0')} confirmado e verificado, mas o estado já mudou: ele é HISTÓRICO.` : `Resultado s${String(seq).padStart(4, '0')} confirmado e verificado.` }
        : { tone: 'warning', text: 'O servidor confirmou o registro, mas não foi possível relê-lo e verificá-lo agora. Recarregue o histórico.' },
    });
    await loadSection(ctx, 'preview');
    return;
  }
  if (out.kind === 'failure') {
    if (out.code === 'RESULT_ANCHOR_PENDING') {
      ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'anchor_pending', request, message: describeFailure(out) } });
      await loadSection(ctx, 'results');
      return;
    }
    if (out.code === 'RESULT_PENDING_UNCONFIRMED') {
      await loadSection(ctx, 'results');
      const pending = ctx.getState().results.data?.pending;
      if (pending?.isMine) ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'anchor_pending', request: { expectedHead: pending.decisionsHead, expectedInputSha256: pending.inputSha256 }, message: describeFailure(out) } });
      else ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'error', code: out.code, message: 'Há um resultado gravado e não confirmado de outro operador; somente o autor pode concluí-lo.', request: null } });
      return;
    }
    if (STALE_VIEW_CODES.has(out.code)) {
      ctx.dispatch({ type: 'PREVIEW_INVALIDATE', reason: describeFailure(out) });
      ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'conflict', code: out.code, message: describeFailure(out), blockers: out.blockers ?? [] } });
      await reload(ctx, ['preview', 'decisions', 'results']); // nova consulta obrigatória; a confirmação anterior NÃO é reaproveitada
      return;
    }
    if (INTEGRITY_CODES.has(out.code)) {
      markIntegrity(ctx, out);
      ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'error', code: out.code, message: describeFailure(out), request: null } });
      return;
    }
    ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'error', code: out.code, message: describeFailure(out), request: out.status === 503 ? request : null } });
    await loadSection(ctx, 'results'); // um erro inesperado pode ter deixado uma pendência: ela precisa aparecer
    return;
  }
  if (out.kind === 'rate_limited') {
    // 429 é decidido ANTES de processar: nada foi gravado. Não é sucesso nem pendência; o pedido original fica guardado para reenvio manual
    ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'rate_limited', request, until: clock(ctx) + out.retryAfterSeconds * 1000, seconds: out.retryAfterSeconds, fromHeader: out.fromHeader } });
    if (recovery) await loadSection(ctx, 'results'); // numa recuperação, uma tentativa ANTERIOR pode ter deixado pendência: ela precisa aparecer
    return;
  }
  // rede / acesso / resposta inesperada: desfecho INCERTO; o mesmo pedido pode ser reenviado com segurança
  ctx.dispatch({ type: 'FINALIZE_SET', flow: { phase: 'error', code: null, message: describeFailure(out), request: out.kind === 'forbidden' ? null : request } });
}

/* ------------------------------------------------------------------ decisões */
const OPTION_SUBCRITERION: Readonly<Record<OptionKey, string>> = { C2: 'C2', S4: 'S4' };

export function buildDecisionRequest(state: PageState): { readonly ok: true; readonly request: DecisionRequest } | { readonly ok: false; readonly errors: readonly string[] } {
  const { form, preview, decisions } = state;
  const errors: string[] = [];
  if (!form.optionKey) return { ok: false, errors: ['Escolha o tipo de decisão.'] };
  if (decisions.phase !== 'ready' || !decisions.data) return { ok: false, errors: ['A lista de decisões não está carregada.'] };
  if (decisions.data.pending) errors.push('Há uma decisão pendente (sem recibo); conclua-a antes de registrar outra.');
  const option = preview.data?.decisionOptions.find((item) => item.subcriterionId === OPTION_SUBCRITERION[form.optionKey as OptionKey]);
  if (!option || !option.available) errors.push('Este tipo de decisão não está disponível agora.');
  const justification = form.justification.trim();
  if (justification.length < 20) errors.push('A justificativa exige pelo menos 20 caracteres.');
  if (justification.length > 2000) errors.push('A justificativa passa de 2000 caracteres.');
  if (form.optionKey === 'C2' && !JUDGEMENT_C2_VALUES.some((item) => item.value === form.value)) errors.push('Escolha o juízo sobre a categoria principal.');
  if (errors.length > 0) return { ok: false, errors };
  const record = form.optionKey === 'C2' ? { kind: 'JUDGEMENT', subcriterionId: 'C2', value: form.value, justification } : { kind: 'NOT_APPLICABLE', subcriterionIds: ['S4'], code: 'BUSINESS_MODEL', justification };
  const active = decisions.data.decisions.find((dto) => dto.status === 'ACTIVE' && (form.optionKey === 'C2' ? dto.kind === 'JUDGEMENT' && dto.record.subcriterionId === 'C2' : dto.kind === 'NOT_APPLICABLE' && Array.isArray(dto.record.subcriterionIds) && dto.record.subcriterionIds.includes('S4')));
  return { ok: true, request: { kind: 'CREATE', body: { record, ...(active ? { supersedes: active.decisionId } : {}), expectedHead: decisions.data.head } } };
}

export function buildRevokeRequest(state: PageState): { readonly ok: true; readonly request: DecisionRequest } | { readonly ok: false; readonly errors: readonly string[] } {
  const { revoke, decisions } = state;
  if (!revoke.decisionId) return { ok: false, errors: ['Escolha a decisão a revogar.'] };
  if (decisions.phase !== 'ready' || !decisions.data) return { ok: false, errors: ['A lista de decisões não está carregada.'] };
  if (decisions.data.pending) return { ok: false, errors: ['Há uma decisão pendente (sem recibo); conclua-a antes.'] };
  const reason = revoke.reason.trim();
  if (reason.length < 20) return { ok: false, errors: ['O motivo exige pelo menos 20 caracteres.'] };
  if (reason.length > 2000) return { ok: false, errors: ['O motivo passa de 2000 caracteres.'] };
  return { ok: true, request: { kind: 'REVOKE', body: { revokes: revoke.decisionId, reason, expectedHead: decisions.data.head } } };
}

interface DecisionHandlers {
  readonly onSubmitting: () => void;
  readonly onOk: (replayed: boolean) => void;
  readonly onPending: (request: DecisionRequest, message: string) => void;
  readonly onConflict: (message: string) => void;
  readonly onError: (message: string) => void;
}

async function runDecision(ctx: Ctx, request: DecisionRequest, h: DecisionHandlers): Promise<void> {
  h.onSubmitting();
  const out = await ctx.api.decide(ctx.auditId, request);
  if (out.kind === 'unauthorized') return ctx.dispatch({ type: 'UNAUTHORIZED' });
  if (out.kind === 'ok') {
    h.onOk(out.value.replayed === true);
    await reload(ctx, ['decisions', 'preview', 'results']); // resultados também: o registro mais recente pode ter virado histórico
    return;
  }
  if (out.kind === 'failure') {
    if (out.code === 'ANCHOR_PENDING') {
      h.onPending(request, describeFailure(out));
      await reload(ctx, ['decisions']);
      return;
    }
    if (STALE_VIEW_CODES.has(out.code) || out.code === 'PENDING_UNCONFIRMED') {
      h.onConflict(describeFailure(out));
      ctx.dispatch({ type: 'PREVIEW_INVALIDATE', reason: 'o histórico de decisões mudou.' });
      await reload(ctx, ['decisions', 'preview', 'results']);
      return;
    }
    if (INTEGRITY_CODES.has(out.code)) {
      markIntegrity(ctx, out);
      return h.onError(describeFailure(out));
    }
    return h.onError([describeFailure(out), ...out.issues.slice(0, 3).map((issue) => safeText(issue, 200))].join(' '));
  }
  // rede/malformada: desfecho incerto ⇒ o MESMO pedido pode ser reenviado com segurança (429 e acesso negado caem em onError: nada foi processado)
  if (out.kind === 'network' || out.kind === 'malformed') return h.onPending(request, describeFailure(out));
  h.onError(describeFailure(out));
}

export function openForm(ctx: Ctx, optionKey: OptionKey): void {
  ctx.dispatch({ type: 'REVOKE_CLOSE' });
  ctx.dispatch({ type: 'FORM_OPEN', optionKey });
}

export async function submitForm(ctx: Ctx): Promise<void> {
  const state = ctx.getState();
  if (state.form.phase !== 'editing' && state.form.phase !== 'conflict' && state.form.phase !== 'error') return;
  const built = buildDecisionRequest(state);
  if (!built.ok) return ctx.dispatch({ type: 'FORM_SET', patch: { phase: 'editing', fieldErrors: built.errors, message: null } });
  await sendForm(ctx, built.request);
}
/** Reenvio do pedido EXATO que ficou pendente/incerto. */
export async function resendForm(ctx: Ctx): Promise<void> {
  const request = ctx.getState().form.pendingRequest;
  if (request) await sendForm(ctx, request);
}
const sendForm = (ctx: Ctx, request: DecisionRequest): Promise<void> =>
  runDecision(ctx, request, {
    onSubmitting: () => ctx.dispatch({ type: 'FORM_SET', patch: { phase: 'submitting', message: null, fieldErrors: [] } }),
    onOk: (replayed) => {
      ctx.dispatch({ type: 'FORM_CLOSE' });
      ctx.dispatch({ type: 'NOTICE', notice: { tone: 'success', text: replayed ? 'Esta decisão já estava registrada e confirmada.' : 'Decisão registrada e confirmada. A prévia está sendo recarregada.' } });
    },
    onPending: (pendingRequest, message) => ctx.dispatch({ type: 'FORM_SET', patch: { phase: 'pending', message, pendingRequest } }),
    onConflict: (message) => ctx.dispatch({ type: 'FORM_SET', patch: { phase: 'conflict', message, pendingRequest: null } }),
    onError: (message) => ctx.dispatch({ type: 'FORM_SET', patch: { phase: 'error', message } }),
  });

export async function submitRevoke(ctx: Ctx): Promise<void> {
  const state = ctx.getState();
  if (state.revoke.phase !== 'editing' && state.revoke.phase !== 'conflict' && state.revoke.phase !== 'error') return;
  const built = buildRevokeRequest(state);
  if (!built.ok) return ctx.dispatch({ type: 'REVOKE_SET', patch: { phase: 'editing', message: built.errors.join(' ') } });
  await sendRevoke(ctx, built.request);
}
export async function resendRevoke(ctx: Ctx): Promise<void> {
  const request = ctx.getState().revoke.pendingRequest;
  if (request) await sendRevoke(ctx, request);
}
const sendRevoke = (ctx: Ctx, request: DecisionRequest): Promise<void> =>
  runDecision(ctx, request, {
    onSubmitting: () => ctx.dispatch({ type: 'REVOKE_SET', patch: { phase: 'submitting', message: null } }),
    onOk: (replayed) => {
      ctx.dispatch({ type: 'REVOKE_CLOSE' });
      ctx.dispatch({ type: 'NOTICE', notice: { tone: 'success', text: replayed ? 'Esta revogação já estava registrada.' : 'Decisão revogada (o histórico permanece). A prévia está sendo recarregada.' } });
    },
    onPending: (pendingRequest, message) => ctx.dispatch({ type: 'REVOKE_SET', patch: { phase: 'pending', message, pendingRequest } }),
    onConflict: (message) => ctx.dispatch({ type: 'REVOKE_SET', patch: { phase: 'conflict', message, pendingRequest: null } }),
    onError: (message) => ctx.dispatch({ type: 'REVOKE_SET', patch: { phase: 'error', message } }),
  });

/** Decisão pendente que veio do histórico (recarregou a página): reenvia o pedido original reconstruído do que a API expõe. */
export async function resendListedPending(ctx: Ctx): Promise<void> {
  const list = ctx.getState().decisions.data;
  const pending = list?.pending;
  if (!list || !pending) return;
  const request: DecisionRequest | null =
    pending.action === 'RECORD' && pending.record
      ? { kind: 'CREATE', body: { record: pending.record, ...(pending.supersedes ? { supersedes: pending.supersedes } : {}), expectedHead: list.head } }
      : pending.action === 'REVOKE' && pending.revokes && pending.reason
        ? { kind: 'REVOKE', body: { revokes: pending.revokes, reason: pending.reason, expectedHead: list.head } }
        : null;
  if (!request) return ctx.dispatch({ type: 'NOTICE', notice: { tone: 'warning', text: 'O pedido original não pôde ser reconstruído a partir do histórico.' } });
  await runDecision(ctx, request, {
    onSubmitting: () => ctx.dispatch({ type: 'NOTICE', notice: { tone: 'info', text: 'Reenviando o pedido pendente…' } }),
    onOk: () => ctx.dispatch({ type: 'NOTICE', notice: { tone: 'success', text: 'Decisão pendente concluída e confirmada.' } }),
    onPending: (_r, message) => ctx.dispatch({ type: 'NOTICE', notice: { tone: 'warning', text: message } }),
    onConflict: (message) => ctx.dispatch({ type: 'NOTICE', notice: { tone: 'warning', text: message } }),
    onError: (message) => ctx.dispatch({ type: 'NOTICE', notice: { tone: 'danger', text: message } }),
  });
}
