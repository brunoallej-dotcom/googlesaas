import type { CompanyIdentity } from '@/lib/link-audit/audit';
import type { MapsLinkParseResult } from '@/lib/link-audit/maps-link';

/*
 * Estado da tela de Auditoria por Link: reducer PURO (sem React, sem rede, sem armazenamento).
 * Nada daqui é persistido; recarregar a página descarta tudo.
 */

export type Phase = 'idle' | 'loading' | 'done' | 'error';

export interface OperatorDetails {
  /** Dados digitados pelo operador. NÃO são evidência verificada pelo Google. */
  readonly name: string;
  readonly city: string;
  readonly stateCode: string;
  readonly acknowledged: boolean;
}

export interface LinkAuditUiState {
  readonly link: string;
  /** Contador que só cresce: respostas de pedidos antigos (mesmo do mesmo link) são descartadas. */
  readonly requestId: number;
  readonly validation: {
    readonly phase: Phase;
    readonly result: MapsLinkParseResult | null;
    readonly error: string | null;
  };
  readonly details: OperatorDetails;
  readonly confirmation: {
    readonly phase: Phase;
    readonly identity: CompanyIdentity | null;
    readonly error: string | null;
  };
}

export const EMPTY_DETAILS: OperatorDetails = { name: '', city: '', stateCode: '', acknowledged: false };

export const initialLinkAuditState: LinkAuditUiState = {
  link: '',
  requestId: 0,
  validation: { phase: 'idle', result: null, error: null },
  details: EMPTY_DETAILS,
  confirmation: { phase: 'idle', identity: null, error: null },
};

export type LinkAuditAction =
  | { readonly type: 'LINK_CHANGED'; readonly link: string }
  | { readonly type: 'VALIDATE_START' }
  | { readonly type: 'VALIDATE_SUCCESS'; readonly requestId: number; readonly link: string; readonly result: MapsLinkParseResult }
  | { readonly type: 'VALIDATE_FAILURE'; readonly requestId: number; readonly link: string; readonly message: string }
  | { readonly type: 'DETAILS_CHANGED'; readonly patch: Partial<OperatorDetails> }
  | { readonly type: 'CONFIRM_START' }
  | { readonly type: 'CONFIRM_SUCCESS'; readonly requestId: number; readonly link: string; readonly identity: CompanyIdentity }
  | { readonly type: 'CONFIRM_FAILURE'; readonly requestId: number; readonly link: string; readonly message: string }
  | { readonly type: 'CONFIRMATION_UNDONE' }
  | { readonly type: 'RESET' };

/** Pode confirmar: link identificado, caixa marcada e nenhuma requisição em andamento. */
export function canConfirm(state: LinkAuditUiState): boolean {
  return (
    state.validation.phase === 'done' &&
    state.validation.result?.status === 'IDENTIFIED' &&
    state.details.acknowledged &&
    state.confirmation.phase !== 'loading' &&
    state.confirmation.phase !== 'done'
  );
}

export function canValidate(state: LinkAuditUiState): boolean {
  return state.link.trim().length > 0 && state.validation.phase !== 'loading';
}

export function linkAuditReducer(state: LinkAuditUiState, action: LinkAuditAction): LinkAuditUiState {
  switch (action.type) {
    case 'LINK_CHANGED':
      // Mudou o link: o resultado, os dados digitados e a confirmação deixam de valer.
      return { ...initialLinkAuditState, link: action.link, requestId: state.requestId };

    case 'VALIDATE_START':
      if (state.link.trim().length === 0 || state.validation.phase === 'loading') return state;
      return {
        ...state,
        requestId: state.requestId + 1,
        validation: { phase: 'loading', result: null, error: null },
        details: EMPTY_DETAILS,
        confirmation: initialLinkAuditState.confirmation,
      };

    case 'VALIDATE_SUCCESS':
      // Resposta de um pedido antigo (o link já mudou ou a tela foi limpa) é descartada.
      if (state.validation.phase !== 'loading' || action.requestId !== state.requestId || action.link !== state.link) return state;
      return { ...state, validation: { phase: 'done', result: action.result, error: null } };

    case 'VALIDATE_FAILURE':
      if (state.validation.phase !== 'loading' || action.requestId !== state.requestId || action.link !== state.link) return state;
      return { ...state, validation: { phase: 'error', result: null, error: action.message } };

    case 'DETAILS_CHANGED':
      if (state.confirmation.phase === 'done' || state.confirmation.phase === 'loading') return state;
      return { ...state, details: { ...state.details, ...action.patch } };

    case 'CONFIRM_START':
      if (!canConfirm(state)) return state;
      return { ...state, requestId: state.requestId + 1, confirmation: { phase: 'loading', identity: null, error: null } };

    case 'CONFIRM_SUCCESS':
      if (state.confirmation.phase !== 'loading' || action.requestId !== state.requestId || action.link !== state.link) return state;
      return { ...state, confirmation: { phase: 'done', identity: action.identity, error: null } };

    case 'CONFIRM_FAILURE':
      if (state.confirmation.phase !== 'loading' || action.requestId !== state.requestId || action.link !== state.link) return state;
      return { ...state, confirmation: { phase: 'error', identity: null, error: action.message } };

    case 'CONFIRMATION_UNDONE':
      return {
        ...state,
        details: { ...state.details, acknowledged: false },
        confirmation: initialLinkAuditState.confirmation,
      };

    case 'RESET':
      return { ...initialLinkAuditState, requestId: state.requestId };
  }
}
