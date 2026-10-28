'use client';

import { useReducer } from 'react';
import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { requestConfirmation, requestParse } from './api-client';
import { AuditWorkspace } from './audit-workspace';
import { IdentityConfirmPanel } from './identity-confirm-panel';
import { LinkEntryPanel } from './link-entry-panel';
import { ParseResultPanel } from './parse-result-panel';
import { StoredAuditsPanel } from './stored-audits-panel';
import { canConfirm, canValidate, initialLinkAuditState, linkAuditReducer } from './state';

const LOGIN_PATH = '/login?next=/auditoria-por-link';

/**
 * Tela de Auditoria por Link (Fase 6, Onda 3). Tudo é estado desta tela: nada é gravado, nada vai ao
 * Google. A análise do link acontece no servidor (rota autenticada) com o parser da Onda 1.
 */
export function LinkAuditScreen(): React.JSX.Element {
  const [state, dispatch] = useReducer(linkAuditReducer, initialLinkAuditState);

  const goToLogin = (): void => {
    window.location.assign(LOGIN_PATH);
  };

  const handleLogout = async (): Promise<void> => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  };

  const validate = async (): Promise<void> => {
    if (!canValidate(state)) return;
    const link = state.link;
    const requestId = state.requestId + 1; // o reducer atribui o mesmo número ao iniciar
    dispatch({ type: 'VALIDATE_START' });
    const outcome = await requestParse(link);
    if (outcome.kind === 'unauthorized') return goToLogin();
    if (outcome.kind === 'error') return dispatch({ type: 'VALIDATE_FAILURE', requestId, link, message: outcome.message });
    dispatch({ type: 'VALIDATE_SUCCESS', requestId, link, result: outcome.value });
  };

  const confirm = async (): Promise<void> => {
    if (!canConfirm(state)) return;
    const link = state.link;
    const requestId = state.requestId + 1;
    dispatch({ type: 'CONFIRM_START' });
    const outcome = await requestConfirmation({
      link,
      name: state.details.name,
      city: state.details.city,
      stateCode: state.details.stateCode,
    });
    if (outcome.kind === 'unauthorized') return goToLogin();
    if (outcome.kind === 'error') return dispatch({ type: 'CONFIRM_FAILURE', requestId, link, message: outcome.message });
    dispatch({ type: 'CONFIRM_SUCCESS', requestId, link, identity: outcome.value });
  };

  return (
    <DashboardShell
      onLogout={() => void handleLogout()}
      activeRoute="/auditoria-por-link"
      sectionLabel="Auditoria por Link"
      hideSystemStatus
    >
      <div className="space-y-5">
        <LinkEntryPanel
          link={state.link}
          loading={state.validation.phase === 'loading'}
          error={state.validation.error}
          canValidate={canValidate(state)}
          canClear={state.link.length > 0 || state.validation.result !== null}
          onLinkChange={(link) => dispatch({ type: 'LINK_CHANGED', link })}
          onSubmit={() => void validate()}
          onClear={() => dispatch({ type: 'RESET' })}
        />
        <div className="grid gap-5 xl:grid-cols-2">
          <ParseResultPanel result={state.validation.result} loading={state.validation.phase === 'loading'} />
          <IdentityConfirmPanel
            result={state.validation.result}
            details={state.details}
            confirmation={state.confirmation}
            canConfirm={canConfirm(state)}
            onDetailsChange={(patch) => dispatch({ type: 'DETAILS_CHANGED', patch })}
            onConfirm={() => void confirm()}
            onUndo={() => dispatch({ type: 'CONFIRMATION_UNDONE' })}
          />
        </div>
        <StoredAuditsPanel onUnauthorized={goToLogin} />
        <AuditWorkspace identity={state.confirmation.identity} />
      </div>
    </DashboardShell>
  );
}
