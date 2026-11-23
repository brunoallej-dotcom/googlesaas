import type { SiteCheckResult } from '../../site-check';

/*
 * Classificação do acesso ao site próprio (Onda 4D). Módulo PURO. Descreve o que foi OBSERVADO; nunca afirma
 * que o site "exige login" sem evidência: um 401/403 pode ser só um site que recusa acesso automatizado.
 */

/** Sinais registrados pelo transporte limitador (somente leitura do que a conexão mostrou). */
export interface SiteAccessSignals {
  /** Requisições HTTP feitas à verificação. */
  readonly requests: number;
  /** Algum `WWW-Authenticate` (desafio de autenticação) foi visto. */
  readonly authChallenge: boolean;
  /** Nossa regra recusou um caminho/host de login ou de área autenticada. */
  readonly loginPathBlocked: boolean;
  /** O teto de requisições por verificação foi atingido. */
  readonly requestLimitReached: boolean;
}

export type SiteCheckOutcome = SiteCheckResult & { readonly access?: SiteAccessSignals };

export type SiteAccessClass =
  | 'REACHABLE'
  | 'NOT_ATTEMPTED'
  | 'UNREACHABLE'
  | 'BLOCKED_BY_SAFETY'
  | 'LOGIN_PATH_BLOCKED'
  | 'REQUEST_LIMIT'
  | 'HTTP_401'
  | 'HTTP_403'
  | 'AUTH_REQUIRED_EVIDENCED'
  | 'HTTP_OTHER'
  | 'NOT_HTML'
  /** Só para a coleta original da AUD-001, cujo código HTTP não foi gravado (ver documentação da Onda 4D). */
  | 'RESTRICTED_RESPONSE_UNSPECIFIED';

export interface SiteAccessAssessment {
  readonly class: SiteAccessClass;
  /** O que foi observado, em português, sem afirmar além da evidência. */
  readonly note: string;
}

/** Mensagem do transporte da coleta original (antes da Onda 4D), que juntava 401, 403 e desafio num só erro. */
export const LEGACY_RESTRICTED_MESSAGE = 'Área autenticada ou restrita: não coletada';

export function assessSiteAccess(result: SiteCheckOutcome): SiteAccessAssessment {
  const access = result.access;
  switch (result.status) {
    case 'OK':
      return { class: 'REACHABLE', note: 'O site respondeu e a página inicial foi lida.' };
    case 'SKIPPED':
      return { class: 'NOT_ATTEMPTED', note: 'O site não foi consultado.' };
    case 'NOT_HTML':
      return { class: 'NOT_HTML', note: 'O site respondeu, mas o conteúdo não é uma página HTML; nada foi lido.' };
    case 'UNREACHABLE':
      return { class: 'UNREACHABLE', note: 'Não foi possível conectar ao site (endereço, conexão ou prazo); isso não indica o motivo nem que o site não exista.' };
    case 'BLOCKED': {
      const reason = result.failureReason ?? '';
      if (access?.loginPathBlocked) {
        return { class: 'LOGIN_PATH_BLOCKED', note: 'A verificação foi encerrada por regra do sistema, que não coleta páginas de login ou áreas autenticadas (a página inicial ou um redirecionamento apontava para uma).' };
      }
      if (access?.requestLimitReached) {
        return { class: 'REQUEST_LIMIT', note: 'A verificação atingiu o limite de requisições HTTP permitido.' };
      }
      if (reason.includes(LEGACY_RESTRICTED_MESSAGE)) {
        return {
          class: 'RESTRICTED_RESPONSE_UNSPECIFIED',
          note: 'O site respondeu 401, 403 ou um desafio de autenticação (o código exato não foi registrado nesta coleta). Isso não prova que o site exija login; pode ser recusa de acesso automatizado.',
        };
      }
      return { class: 'BLOCKED_BY_SAFETY', note: 'A verificação foi bloqueada por uma regra de segurança do sistema (endereço não permitido, redirecionamentos em excesso ou protocolo).' };
    }
    case 'HTTP_ERROR': {
      const code = result.httpStatus;
      if (code === 401) {
        return access?.authChallenge
          ? { class: 'AUTH_REQUIRED_EVIDENCED', note: 'O site respondeu HTTP 401 com desafio de autenticação (WWW-Authenticate): o acesso à página exige autenticação.' }
          : { class: 'HTTP_401', note: 'O site respondeu HTTP 401 sem desafio de autenticação; não há evidência suficiente de que exija login.' };
      }
      if (code === 403) {
        return { class: 'HTTP_403', note: 'O site respondeu HTTP 403 à verificação automatizada: acesso automatizado recusado ou restrito. Isso não prova que o site exija login.' };
      }
      return { class: 'HTTP_OTHER', note: `O site respondeu HTTP ${code ?? '?'}; a página inicial não foi lida.` };
    }
    default:
      return { class: 'BLOCKED_BY_SAFETY', note: 'Resultado da verificação do site em formato inesperado.' };
  }
}
