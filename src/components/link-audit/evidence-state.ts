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
}

export const initialEvidenceState: EvidenceUiState = {
  list: { phase: 'loading', items: [], total: 0, message: null },
  query: '',
  selectedId: null,
  selection: {},
  detail: { phase: 'idle', data: null, message: null },
  detailRequest: 0,
};

export type EvidenceAction =
  | { readonly type: 'LIST_START' }
  | { readonly type: 'LIST_SUCCESS'; readonly items: readonly AuditListItemDto[]; readonly total: number }
  | { readonly type: 'LIST_FAILURE'; readonly message: string; readonly unavailable?: boolean }
  | { readonly type: 'QUERY_CHANGED'; readonly query: string }
  | { readonly type: 'SELECT'; readonly auditId: string; readonly request: number; readonly selection?: DetailSelection }
  | { readonly type: 'DETAIL_SUCCESS'; readonly request: number; readonly data: AuditDetailDto }
  | { readonly type: 'DETAIL_FAILURE'; readonly request: number; readonly message: string };

export function evidenceReducer(state: EvidenceUiState, action: EvidenceAction): EvidenceUiState {
  switch (action.type) {
    case 'LIST_START':
      return { ...state, list: { ...state.list, phase: 'loading', message: null } };
    case 'LIST_SUCCESS':
      return { ...state, list: { phase: 'ready', items: action.items, total: action.total, message: null } };
    case 'LIST_FAILURE':
      return { ...state, list: { phase: action.unavailable ? 'unavailable' : 'error', items: [], total: 0, message: action.message } };
    case 'QUERY_CHANGED':
      return { ...state, query: action.query.slice(0, 120) };
    case 'SELECT':
      return {
        ...state,
        selectedId: action.auditId,
        selection: action.selection ?? {},
        detail: { phase: 'loading', data: action.auditId === state.selectedId ? state.detail.data : null, message: null },
        detailRequest: action.request,
      };
    case 'DETAIL_SUCCESS':
      if (action.request !== state.detailRequest) return state;
      return { ...state, detail: { phase: 'ready', data: action.data, message: null } };
    case 'DETAIL_FAILURE':
      if (action.request !== state.detailRequest) return state;
      return { ...state, detail: { phase: 'error', data: null, message: action.message } };
    default:
      return state;
  }
}

const plain = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Filtro local por empresa, cidade, UF ou CID (sem acentos, sem diferenciar caixa). */
export function filterAudits(items: readonly AuditListItemDto[], query: string): readonly AuditListItemDto[] {
  const needle = plain(query.trim());
  if (!needle) return items;
  return items.filter((item) => plain([item.companyName, item.city, item.stateCode, item.confirmedCid, item.auditId].filter(Boolean).join(' ')).includes(needle));
}
