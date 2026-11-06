import type { AuditDetailDto } from '@/lib/link-audit-evidence';
import type { DecisionsList, FinalizeRequest, PreviewPayload, ResultsList, RunDetailResponse, DecisionRequest, Blocker } from './types';

/* Estado da página da auditoria (I5). Reducer PURO: nada de rede, relógio ou DOM aqui. */
export type SectionName = 'evidence' | 'preview' | 'decisions' | 'results';
export type Phase = 'idle' | 'loading' | 'ready' | 'error' | 'integrity' | 'unavailable' | 'denied';

export interface Section<T> {
  readonly phase: Phase;
  /** Os últimos dados BONS. Em `integrity` é sempre `null` (nenhum dado é exibido). */
  readonly data: T | null;
  readonly message: string | null;
  readonly code: string | null;
}
const empty = <T,>(): Section<T> => ({ phase: 'idle', data: null, message: null, code: null });

export type FinalizeFlow =
  | { readonly phase: 'idle' }
  | { readonly phase: 'confirming'; readonly request: FinalizeRequest; readonly outcome: 'PONTUADO' | 'INCONCLUSIVO'; readonly acknowledged: boolean }
  | { readonly phase: 'submitting'; readonly request: FinalizeRequest; readonly recovery: boolean }
  | { readonly phase: 'verifying'; readonly seq: number }
  /** O servidor confirmou (201/200). `verified` só é verdadeiro depois de reler o resultado pela API de consulta. */
  | { readonly phase: 'done'; readonly seq: number; readonly replayed: boolean; readonly recovered: boolean; readonly changedAfter: boolean | null; readonly verified: boolean }
  /** Gravado e NÃO confirmado (sem recibo): nunca é sucesso. Só o mesmo pedido, do mesmo operador, pode concluir. */
  | { readonly phase: 'anchor_pending'; readonly request: FinalizeRequest; readonly message: string }
  /**
   * HTTP 429 na finalização: o limitador responde ANTES de processar, então NADA foi gravado por esta requisição (não é resultado
   * confirmado nem pendência de recibo). `until` é o instante (ms do relógio LOCAL, só para a contagem) em que o reenvio MANUAL do mesmo
   * pedido volta a ser permitido; nada é reenviado automaticamente.
   */
  | { readonly phase: 'rate_limited'; readonly request: FinalizeRequest; readonly until: number; readonly seconds: number; readonly fromHeader: boolean }
  | { readonly phase: 'conflict'; readonly code: string; readonly message: string; readonly blockers: readonly Blocker[] }
  /** `request` é mantido quando o desfecho é INCERTO (rede, limite): reenviar o MESMO pedido é seguro (idempotente). */
  | { readonly phase: 'error'; readonly code: string | null; readonly message: string; readonly request: FinalizeRequest | null };

export type OptionKey = 'C2' | 'S4';
export interface DecisionForm {
  readonly optionKey: OptionKey | null;
  readonly value: string;
  readonly justification: string;
  readonly phase: 'closed' | 'editing' | 'submitting' | 'pending' | 'conflict' | 'error';
  readonly message: string | null;
  readonly fieldErrors: readonly string[];
  /** O pedido EXATO que ficou pendente (sem recibo): só ele pode ser reenviado. */
  readonly pendingRequest: DecisionRequest | null;
}
export interface RevokeFlow {
  readonly decisionId: string | null;
  readonly reason: string;
  readonly phase: 'closed' | 'editing' | 'submitting' | 'pending' | 'conflict' | 'error';
  readonly message: string | null;
  readonly pendingRequest: DecisionRequest | null;
}
export interface Notice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger';
  readonly text: string;
}
export interface DetailState {
  readonly seq: number | null;
  readonly phase: 'idle' | 'loading' | 'ready' | 'error' | 'integrity';
  readonly data: RunDetailResponse | null;
  readonly message: string | null;
}

export interface PageState {
  readonly auditId: string;
  readonly evidence: Section<AuditDetailDto>;
  readonly preview: Section<PreviewPayload> & { readonly invalidated: string | null };
  readonly decisions: Section<DecisionsList>;
  readonly results: Section<ResultsList>;
  readonly detail: DetailState;
  readonly finalize: FinalizeFlow;
  readonly form: DecisionForm;
  readonly revoke: RevokeFlow;
  readonly notice: Notice | null;
  readonly unauthorized: boolean;
}

export const CLOSED_FORM: DecisionForm = { optionKey: null, value: '', justification: '', phase: 'closed', message: null, fieldErrors: [], pendingRequest: null };
export const CLOSED_REVOKE: RevokeFlow = { decisionId: null, reason: '', phase: 'closed', message: null, pendingRequest: null };

export const initialPageState = (auditId: string): PageState => ({
  auditId,
  evidence: empty(),
  preview: { ...empty<PreviewPayload>(), invalidated: null },
  decisions: empty(),
  results: empty(),
  detail: { seq: null, phase: 'idle', data: null, message: null },
  finalize: { phase: 'idle' },
  form: CLOSED_FORM,
  revoke: CLOSED_REVOKE,
  notice: null,
  unauthorized: false,
});

export type Action =
  | { readonly type: 'SECTION_START'; readonly section: SectionName }
  | { readonly type: 'SECTION_OK'; readonly section: 'evidence'; readonly data: AuditDetailDto }
  | { readonly type: 'SECTION_OK'; readonly section: 'preview'; readonly data: PreviewPayload }
  | { readonly type: 'SECTION_OK'; readonly section: 'decisions'; readonly data: DecisionsList }
  | { readonly type: 'SECTION_OK'; readonly section: 'results'; readonly data: ResultsList }
  | { readonly type: 'SECTION_FAIL'; readonly section: SectionName; readonly phase: Exclude<Phase, 'idle' | 'loading' | 'ready'>; readonly message: string; readonly code: string | null }
  | { readonly type: 'PREVIEW_INVALIDATE'; readonly reason: string }
  | { readonly type: 'DETAIL_SELECT'; readonly seq: number | null }
  | { readonly type: 'DETAIL_OK'; readonly seq: number; readonly data: RunDetailResponse }
  | { readonly type: 'DETAIL_FAIL'; readonly seq: number; readonly phase: 'error' | 'integrity'; readonly message: string }
  | { readonly type: 'FINALIZE_SET'; readonly flow: FinalizeFlow }
  | { readonly type: 'FINALIZE_ACK'; readonly acknowledged: boolean }
  | { readonly type: 'FORM_OPEN'; readonly optionKey: OptionKey }
  | { readonly type: 'FORM_FIELD'; readonly patch: Partial<Pick<DecisionForm, 'value' | 'justification'>> }
  | { readonly type: 'FORM_SET'; readonly patch: Partial<DecisionForm> }
  | { readonly type: 'FORM_CLOSE' }
  | { readonly type: 'REVOKE_OPEN'; readonly decisionId: string }
  | { readonly type: 'REVOKE_FIELD'; readonly reason: string }
  | { readonly type: 'REVOKE_SET'; readonly patch: Partial<RevokeFlow> }
  | { readonly type: 'REVOKE_CLOSE' }
  | { readonly type: 'NOTICE'; readonly notice: Notice | null }
  | { readonly type: 'UNAUTHORIZED' };

export function pageReducer(state: PageState, action: Action): PageState {
  switch (action.type) {
    case 'SECTION_START': {
      const key = action.section;
      const current = state[key] as Section<unknown>;
      return { ...state, [key]: { ...current, phase: 'loading', message: null, code: null } } as PageState;
    }
    case 'SECTION_OK': {
      const next = { phase: 'ready' as const, data: action.data, message: null, code: null };
      if (action.section === 'preview') return { ...state, preview: { ...next, invalidated: null } as PageState['preview'] };
      return { ...state, [action.section]: next } as PageState;
    }
    case 'SECTION_FAIL': {
      const current = state[action.section] as Section<unknown>;
      // falha de integridade NUNCA mantém dados; outras falhas mantêm os últimos dados bons (marcados como possivelmente velhos pela UI)
      const keep = action.phase === 'integrity' || action.phase === 'denied' ? null : current.data;
      const next = { ...current, phase: action.phase, data: keep, message: action.message, code: action.code };
      return { ...state, [action.section]: next } as PageState;
    }
    case 'PREVIEW_INVALIDATE':
      return { ...state, preview: { ...state.preview, invalidated: action.reason } };
    case 'DETAIL_SELECT':
      return { ...state, detail: action.seq === null ? { seq: null, phase: 'idle', data: null, message: null } : { seq: action.seq, phase: 'loading', data: null, message: null } };
    case 'DETAIL_OK':
      return state.detail.seq === action.seq ? { ...state, detail: { seq: action.seq, phase: 'ready', data: action.data, message: null } } : state;
    case 'DETAIL_FAIL':
      return state.detail.seq === action.seq ? { ...state, detail: { seq: action.seq, phase: action.phase, data: null, message: action.message } } : state;
    case 'FINALIZE_SET':
      return { ...state, finalize: action.flow };
    case 'FINALIZE_ACK':
      return state.finalize.phase === 'confirming' ? { ...state, finalize: { ...state.finalize, acknowledged: action.acknowledged } } : state;
    case 'FORM_OPEN':
      return { ...state, form: { ...CLOSED_FORM, optionKey: action.optionKey, phase: 'editing' } };
    case 'FORM_FIELD': // em "pendente" o reenvio é do pedido ORIGINAL: o rascunho não é editado
      return state.form.phase === 'closed' || state.form.phase === 'submitting' || state.form.phase === 'pending' ? state : { ...state, form: { ...state.form, ...action.patch, fieldErrors: [], ...(state.form.phase === 'error' ? { phase: 'editing' as const, message: null } : {}) } };
    case 'FORM_SET':
      return { ...state, form: { ...state.form, ...action.patch } };
    case 'FORM_CLOSE':
      return { ...state, form: CLOSED_FORM };
    case 'REVOKE_OPEN':
      return { ...state, revoke: { ...CLOSED_REVOKE, decisionId: action.decisionId, phase: 'editing' } };
    case 'REVOKE_FIELD':
      return state.revoke.phase === 'closed' || state.revoke.phase === 'submitting' || state.revoke.phase === 'pending' ? state : { ...state, revoke: { ...state.revoke, reason: action.reason } };
    case 'REVOKE_SET':
      return { ...state, revoke: { ...state.revoke, ...action.patch } };
    case 'REVOKE_CLOSE':
      return { ...state, revoke: CLOSED_REVOKE };
    case 'NOTICE':
      return { ...state, notice: action.notice };
    case 'UNAUTHORIZED':
      return { ...state, unauthorized: true };
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ elegibilidade */
export interface Eligibility {
  readonly allowed: boolean;
  /** Motivo (texto fixo) quando não pode finalizar. */
  readonly reason: string | null;
}

/**
 * Só se finaliza com a API declarando `finalization.allowed:true` na prévia EXIBIDA e válida (não invalidada), sem decisão ou
 * resultado pendente e com a prévia concordando com a lista de decisões que a tela mostra. Nada é calculado no navegador.
 */
export function finalizeEligibility(state: PageState, now: number = Date.now()): Eligibility {
  const preview = state.preview;
  const no = (reason: string): Eligibility => ({ allowed: false, reason });
  if (state.finalize.phase === 'rate_limited' && now < state.finalize.until) return no(`Limite de requisições atingido: aguarde cerca de ${Math.max(1, Math.ceil((state.finalize.until - now) / 1000))} s.`);
  if (state.finalize.phase === 'submitting' || state.finalize.phase === 'verifying') return no('Há uma finalização em andamento.');
  if (preview.phase === 'loading') return no('A prévia está sendo recarregada.');
  if (preview.invalidated !== null) return no('A prévia foi invalidada por uma mudança; recarregue antes de finalizar.');
  if (preview.phase !== 'ready' || !preview.data) return no('A prévia não está disponível.');
  const data = preview.data;
  if (!data.finalization.allowed) return no('A API não permite finalizar esta prévia (veja os bloqueios).');
  if (data.finalization.expectedInputSha256 === null) return no('A prévia não tem entrada do motor para registrar.');
  if (data.blockers.some((blocker) => blocker.severity === 'BLOCKING')) return no('Há bloqueios abertos.');
  if (state.decisions.phase !== 'ready' || !state.decisions.data) return no('A lista de decisões não está carregada.');
  if (state.decisions.data.pending !== null || data.decisions.pending !== null) return no('Há uma decisão pendente (sem recibo).');
  const shown = state.decisions.data.head;
  const used = data.finalization.expectedHead;
  if ((shown === null) !== (used === null) || (shown !== null && used !== null && (shown.seq !== used.seq || shown.sha256 !== used.sha256))) return no('A lista de decisões e a prévia não estão no mesmo ponto do histórico; recarregue.');
  if (state.results.phase !== 'ready' || !state.results.data) return no('O histórico de resultados não está carregado.');
  if (state.results.data.pending !== null) return no('Há um resultado gravado e ainda não confirmado; conclua-o antes.');
  return { allowed: true, reason: null };
}
