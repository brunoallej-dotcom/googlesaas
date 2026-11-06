import type { AuditDetailDto, AuditListItemDto } from '@/lib/link-audit-evidence';
import type { DetailSelection } from './evidence-api-client';

/*
 * Estado puro da área "Auditorias armazenadas" (Onda 5B). Sem efeitos: o contêiner dispara as consultas e
 * entrega os resultados com um número de pedido; respostas atrasadas de um pedido antigo são ignoradas.
 */

export type Phase = 'loading' | 'ready' | 'error' | 'unavailable';

export interface EvidenceUiState {
  readonly list: { readonly phase: Phase; readonly items: readonly AuditListItemDto[]; readonly total: number; readonly message: string | null };
  readonly query: string;
  readonly selectedId: string | null;
  readonly selection: DetailSelection;
  readonly detail: { readonly phase: Phase | 'idle'; readonly data: AuditDetailDto | null; readonly message: string | null };
  readonly detailRequest: number;
  /** Pedido do endereço (`?auditId=`) que NÃO pôde ser atendido. Enquanto existir, nenhuma outra empresa fica selecionada em seu lugar. */
  readonly requestIssue: AuditRequestIssue | null;
}

/** Por que o `?auditId=` do endereço não foi atendido: fora da lista carregada (identidade preservada) ou com formato inválido (nunca ecoado). */
export type AuditRequestIssue = { readonly kind: 'missing'; readonly auditId: string } | { readonly kind: 'invalid' };

export const initialEvidenceState: EvidenceUiState = {
  list: { phase: 'loading', items: [], total: 0, message: null },
  query: '',
  selectedId: null,
  selection: {},
  detail: { phase: 'idle', data: null, message: null },
  detailRequest: 0,
  requestIssue: null,
};

export type EvidenceAction =
  | { readonly type: 'LIST_START' }
  | { readonly type: 'LIST_SUCCESS'; readonly items: readonly AuditListItemDto[]; readonly total: number }
  | { readonly type: 'LIST_FAILURE'; readonly message: string; readonly unavailable?: boolean }
  | { readonly type: 'QUERY_CHANGED'; readonly query: string }
  | { readonly type: 'SELECT'; readonly auditId: string; readonly request: number; readonly selection?: DetailSelection }
  | { readonly type: 'REQUEST_ISSUE'; readonly issue: AuditRequestIssue; readonly request: number }
  | { readonly type: 'REQUEST_DISMISSED' }
  | { readonly type: 'DETAIL_SUCCESS'; readonly request: number; readonly data: AuditDetailDto }
  | { readonly type: 'DETAIL_FAILURE'; readonly request: number; readonly message: string };

export function evidenceReducer(state: EvidenceUiState, action: EvidenceAction): EvidenceUiState {
  switch (action.type) {
    case 'LIST_START':
      return { ...state, list: { ...state.list, phase: 'loading', message: null }, requestIssue: null };
    case 'LIST_SUCCESS':
      return { ...state, list: { phase: 'ready', items: action.items, total: action.total, message: null } };
    case 'LIST_FAILURE':
      return { ...state, list: { phase: action.unavailable ? 'unavailable' : 'error', items: [], total: 0, message: action.message }, requestIssue: null };
    case 'QUERY_CHANGED':
      return { ...state, query: action.query.slice(0, 120) };
    case 'SELECT':
      return {
        ...state,
        selectedId: action.auditId,
        selection: action.selection ?? {},
        detail: { phase: 'loading', data: action.auditId === state.selectedId ? state.detail.data : null, message: null },
        detailRequest: action.request,
        requestIssue: null,
      };
    case 'REQUEST_ISSUE':
      // o pedido não existe: NADA fica selecionado (nem dados de outra auditoria) e respostas atrasadas de antes são ignoradas
      return { ...state, selectedId: null, selection: {}, detail: { phase: 'idle', data: null, message: null }, detailRequest: action.request, requestIssue: action.issue };
    case 'REQUEST_DISMISSED':
      return { ...state, requestIssue: null };
    case 'DETAIL_SUCCESS':
      if (action.request !== state.detailRequest) return state;
      // falha fechada: o detalhe entregue precisa ser o da empresa escolhida; senão nada dele é mostrado
      if (action.data.auditId !== state.selectedId) return { ...state, detail: { phase: 'error', data: null, message: 'A resposta não corresponde à auditoria escolhida e não foi exibida.' } };
      return { ...state, detail: { phase: 'ready', data: action.data, message: null } };
    case 'DETAIL_FAILURE':
      if (action.request !== state.detailRequest) return state;
      return { ...state, detail: { phase: 'error', data: null, message: action.message } };
    default:
      return state;
  }
}

/** `?auditId=` com a forma de um identificador de auditoria (nunca é usado como caminho nem enviado sem validação). */
export const AUDIT_ID_FORMAT = /^[a-z0-9][a-z0-9_-]{7,63}$/;

/** O que o endereço pede, confrontado com a lista carregada. */
export type AuditRequest =
  | { readonly kind: 'none' }
  | { readonly kind: 'listed'; readonly auditId: string }
  | { readonly kind: 'missing'; readonly auditId: string }
  | { readonly kind: 'invalid' };

/**
 * Resolve o `?auditId=` do endereço. Um pedido presente NUNCA é trocado por outra empresa: se não estiver na lista (`missing`) ou
 * não tiver formato de identificador, vazio ou repetido (`invalid`), a decisão é exibir o impedimento, não escolher uma substituta.
 */
export function resolveAuditRequest(items: readonly AuditListItemDto[], search: string): AuditRequest {
  const values = new URLSearchParams(search).getAll('auditId');
  if (values.length === 0) return { kind: 'none' };
  const value = values.length === 1 ? (values[0] as string) : null;
  if (value === null || !AUDIT_ID_FORMAT.test(value)) return { kind: 'invalid' };
  return items.some((item) => item.auditId === value) ? { kind: 'listed', auditId: value } : { kind: 'missing', auditId: value };
}

/** Ação do contêiner para um pedido do endereço: escolher, mostrar o impedimento ou nada. */
export type LocationPlan =
  | { readonly do: 'select'; readonly auditId: string; readonly fromUrl: boolean }
  | { readonly do: 'issue'; readonly issue: AuditRequestIssue }
  | { readonly do: 'nothing' };

/**
 * Decide o que fazer com a lista carregada e o endereço atual. `current` é o que a tela já mostra (para não repetir consulta).
 * Sem `?auditId=`, vale a primeira empresa (comportamento da 5B). Com `?auditId=` que não se atende, mostra o impedimento.
 */
export function planFromLocation(items: readonly AuditListItemDto[], search: string, current: { readonly selectedId: string | null; readonly issue: AuditRequestIssue | null }): LocationPlan {
  const request = resolveAuditRequest(items, search);
  if (request.kind === 'listed') return current.selectedId === request.auditId && current.issue === null ? { do: 'nothing' } : { do: 'select', auditId: request.auditId, fromUrl: true };
  if (request.kind === 'missing' || request.kind === 'invalid') {
    const issue: AuditRequestIssue = request.kind === 'missing' ? { kind: 'missing', auditId: request.auditId } : { kind: 'invalid' };
    const same = current.issue !== null && current.issue.kind === issue.kind && (issue.kind === 'invalid' || (current.issue.kind === 'missing' && current.issue.auditId === issue.auditId));
    return same && current.selectedId === null ? { do: 'nothing' } : { do: 'issue', issue };
  }
  const first = items[0];
  if (!first) return { do: 'nothing' };
  return current.selectedId === first.auditId && current.issue === null ? { do: 'nothing' } : { do: 'select', auditId: first.auditId, fromUrl: false };
}

/** A parte `?…` do endereço com `auditId` trocado (ou removido, se `null`), preservando os demais parâmetros. */
export function withAuditIdParam(search: string, auditId: string | null): string {
  const params = new URLSearchParams(search);
  if (auditId === null) params.delete('auditId');
  else params.set('auditId', auditId);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

const plain = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Filtro local por empresa, cidade, UF ou CID (sem acentos, sem diferenciar caixa). */
export function filterAudits(items: readonly AuditListItemDto[], query: string): readonly AuditListItemDto[] {
  const needle = plain(query.trim());
  if (!needle) return items;
  return items.filter((item) => plain([item.companyName, item.city, item.stateCode, item.confirmedCid, item.auditId].filter(Boolean).join(' ')).includes(needle));
}
