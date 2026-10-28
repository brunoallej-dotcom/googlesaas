'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { Archive, FileSearch, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { requestAuditDetail, requestAuditList, type DetailSelection } from './evidence-api-client';
import { evidenceReducer, filterAudits, initialEvidenceState } from './evidence-state';
import { StoredAuditDetail } from './stored-audit-detail';
import { StoredAuditList } from './stored-audit-list';

interface StoredAuditsPanelProps {
  /** Chamado quando o servidor responde 401 (sessão expirada). */
  readonly onUnauthorized: () => void;
}

/**
 * Área "Auditorias armazenadas" (Fase 6, Onda 5B). SOMENTE LEITURA: lista e detalha evidências já preservadas,
 * lidas pelo servidor com autenticação. Não coleta, não gera auditoria, não calcula pontuação e não envia
 * nenhum caminho de arquivo (só o identificador da auditoria e números de versão).
 */
export function StoredAuditsPanel({ onUnauthorized }: StoredAuditsPanelProps): React.JSX.Element {
  const [state, dispatch] = useReducer(evidenceReducer, initialEvidenceState);
  const detailRequests = useRef(0);
  const controllers = useRef<{ list: AbortController | null; detail: AbortController | null }>({ list: null, detail: null });
  const userPicked = useRef(false);
  // Referência estável: a função do pai muda a cada renderização e não pode reiniciar as consultas.
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  const loadList = useCallback(async (): Promise<void> => {
    controllers.current.list?.abort();
    const controller = new AbortController();
    controllers.current.list = controller;
    dispatch({ type: 'LIST_START' });
    const outcome = await requestAuditList(controller.signal);
    if (controller.signal.aborted) return;
    if (outcome.kind === 'unauthorized') return unauthorized.current();
    if (outcome.kind === 'ok') return dispatch({ type: 'LIST_SUCCESS', items: outcome.value.audits, total: outcome.value.total });
    dispatch({ type: 'LIST_FAILURE', message: outcome.message, unavailable: outcome.kind === 'unavailable' });
  }, []);

  const select = useCallback(
    async (auditId: string, selection: DetailSelection = {}): Promise<void> => {
      controllers.current.detail?.abort();
      const controller = new AbortController();
      controllers.current.detail = controller;
      detailRequests.current += 1;
      const request = detailRequests.current;
      dispatch({ type: 'SELECT', auditId, request, selection });
      const outcome = await requestAuditDetail(auditId, selection, controller.signal);
      if (controller.signal.aborted) return;
      if (outcome.kind === 'unauthorized') return unauthorized.current();
      if (outcome.kind === 'ok') return dispatch({ type: 'DETAIL_SUCCESS', request, data: outcome.value });
      dispatch({ type: 'DETAIL_FAILURE', request, message: outcome.message });
    },
    [],
  );

  useEffect(() => {
    void loadList();
    const current = controllers.current;
    return () => {
      current.list?.abort();
      current.detail?.abort();
    };
  }, [loadList]);

  // Com auditorias carregadas e nada escolhido, mostra a primeira (a lista é pequena e ordenada).
  useEffect(() => {
    if (state.list.phase === 'ready' && state.list.items.length > 0 && state.selectedId === null) {
      void select((state.list.items[0] as (typeof state.list.items)[number]).auditId);
    }
  }, [state.list, state.selectedId, select]);

  // Depois de uma escolha do operador, leva o foco ao título do detalhe (acessibilidade e celular).
  const readyId = state.detail.data?.auditId ?? null;
  useEffect(() => {
    if (userPicked.current && readyId) {
      userPicked.current = false;
      const heading = document.getElementById('detalhe-auditoria-titulo');
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [readyId, state.detail.phase]);

  const visible = filterAudits(state.list.items, state.query);
  const listReady = state.list.phase === 'ready';

  return (
    <Panel
      id="auditorias-armazenadas"
      icon={Archive}
      title="Auditorias armazenadas"
      subtitle="Evidências já coletadas e preservadas. Somente leitura: nenhuma consulta ao Google, ao Serper ou ao site das empresas é feita por esta tela."
    >
      <div className={listReady && state.list.total > 0 ? 'grid gap-5 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]' : ''}>
        <div className="min-w-0">
          <StoredAuditList
            phase={state.list.phase}
            items={visible}
            total={state.list.total}
            message={state.list.message}
            query={state.query}
            selectedId={state.selectedId}
            onQueryChange={(query) => dispatch({ type: 'QUERY_CHANGED', query })}
            onSelect={(auditId) => {
              userPicked.current = true;
              void select(auditId);
            }}
            onRetry={() => void loadList()}
          />
        </div>

        {listReady && state.list.total > 0 && (
          <div className="mt-4 min-w-0 xl:mt-4" aria-live="polite">
            {state.detail.phase === 'idle' && (
              <div className="rounded-xl border border-dashed border-white/15 p-6 text-center">
                <FileSearch className="mx-auto h-6 w-6 text-gmn-muted" aria-hidden="true" />
                <p className="mt-2 text-sm text-gmn-muted">Selecione uma empresa para ver as evidências coletadas.</p>
              </div>
            )}
            {state.detail.phase === 'loading' && state.detail.data === null && (
              <div role="status" className="space-y-3">
                <p className="flex items-center gap-2 text-sm text-gmn-muted">
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Carregando e conferindo a integridade da coleta…
                </p>
                <div aria-hidden="true" className="h-40 animate-pulse rounded-xl border border-white/[0.06] bg-gmn-tile/50" />
              </div>
            )}
            {state.detail.phase === 'error' && (
              <div role="alert" className="rounded-xl border border-gmn-warning/40 bg-gmn-warning/[0.06] p-4">
                <p className="flex items-start gap-2 text-sm font-semibold text-gmn-text">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
                  Não foi possível exibir esta coleta
                </p>
                <p className="mt-1 text-sm text-gmn-muted">{state.detail.message}</p>
                {state.selectedId && (
                  <button
                    type="button"
                    onClick={() => void select(state.selectedId as string, state.selection)}
                    className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-white/[0.1] px-3 text-sm text-gmn-text transition-colors hover:border-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/60"
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    Tentar novamente
                  </button>
                )}
              </div>
            )}
            {state.detail.data && (state.detail.phase === 'ready' || state.detail.phase === 'loading') && (
              <StoredAuditDetail
                detail={state.detail.data}
                loading={state.detail.phase === 'loading'}
                onSelectRevision={(capture, revision) => {
                  userPicked.current = false;
                  void select(state.detail.data?.auditId ?? '', { ...(capture !== null ? { capture } : {}), revision });
                }}
              />
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
