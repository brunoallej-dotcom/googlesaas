'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { Archive, FileSearch, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { requestAuditDetail, requestAuditList, type DetailSelection } from './evidence-api-client';
import type { AuditListItemDto } from '@/lib/link-audit-evidence';
import { syncAuditIdInUrl } from './audit-url';
import { evidenceReducer, filterAudits, initialEvidenceState, planFromLocation, type AuditRequestIssue } from './evidence-state';
import { RequestedAuditNotice } from './requested-audit-notice';
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
  /** Depois da escolha: `heading` = escolha do operador (foco no título do detalhe); `card` = volta pelo endereço (foco no cartão). */
  const afterSelect = useRef<'heading' | 'card' | null>(null);
  /** O operador dispensou o pedido do endereço: um `popstate` posterior não deve voltar a escolher a primeira empresa por ele. */
  const dismissed = useRef(false);
  // Lista carregada e o que a tela mostra, para o tratamento do endereço (sem reiniciar efeitos a cada renderização).
  const loadedItems = useRef<readonly AuditListItemDto[] | null>(null);
  const shown = useRef<{ selectedId: string | null; issue: AuditRequestIssue | null }>({ selectedId: null, issue: null });
  shown.current = { selectedId: state.selectedId, issue: state.requestIssue };
  // Referência estável: a função do pai muda a cada renderização e não pode reiniciar as consultas.
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

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

  /**
   * Aplica o endereço (`?auditId=`) à lista carregada. Um pedido que não se atende (fora da lista, formato inválido) mostra o
   * impedimento e NÃO escolhe outra empresa; sem pedido, vale a primeira (comportamento da 5B).
   */
  const applyLocation = useCallback(
    (items: readonly AuditListItemDto[]): void => {
      const plan = planFromLocation(items, window.location.search, shown.current);
      if (plan.do === 'select') {
        if (!plan.fromUrl && dismissed.current) return; // sem pedido e o operador dispensou: ele escolhe
        dismissed.current = false;
        // volta pelo endereço: leva o foco ao cartão escolhido, sem roubar o de quem digita
        afterSelect.current = plan.fromUrl ? 'card' : null;
        shown.current = { selectedId: plan.auditId, issue: null }; // vale já: o próximo evento não pode ver o estado antigo
        void select(plan.auditId);
      } else if (plan.do === 'issue') {
        dismissed.current = false;
        afterSelect.current = null;
        shown.current = { selectedId: null, issue: plan.issue };
        controllers.current.detail?.abort(); // uma consulta em andamento de outra empresa não pode aparecer
        detailRequests.current += 1;
        dispatch({ type: 'REQUEST_ISSUE', issue: plan.issue, request: detailRequests.current });
      }
    },
    [select],
  );

  const loadList = useCallback(async (): Promise<void> => {
    controllers.current.list?.abort();
    const controller = new AbortController();
    controllers.current.list = controller;
    loadedItems.current = null;
    dismissed.current = false;
    dispatch({ type: 'LIST_START' });
    const outcome = await requestAuditList(controller.signal);
    if (controller.signal.aborted) return;
    if (outcome.kind === 'unauthorized') return unauthorized.current();
    if (outcome.kind === 'ok') {
      loadedItems.current = outcome.value.audits;
      dispatch({ type: 'LIST_SUCCESS', items: outcome.value.audits, total: outcome.value.total });
      applyLocation(outcome.value.audits);
      return;
    }
    dispatch({ type: 'LIST_FAILURE', message: outcome.message, unavailable: outcome.kind === 'unavailable' });
  }, [applyLocation]);

  useEffect(() => {
    void loadList();
    const current = controllers.current;
    return () => {
      current.list?.abort();
      current.detail?.abort();
    };
  }, [loadList]);

  // Voltar/avançar no histórico: a exibição acompanha o endereço (nunca fica uma empresa diferente da que o endereço pede).
  useEffect(() => {
    const onPopState = (): void => {
      if (loadedItems.current) applyLocation(loadedItems.current);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyLocation]);

  // Depois de uma escolha, leva o foco: ao título do detalhe (escolha do operador) ou ao cartão (volta pelo endereço).
  const readyId = state.detail.data?.auditId ?? null;
  useEffect(() => {
    if (!afterSelect.current || !readyId) return;
    const target = afterSelect.current;
    afterSelect.current = null;
    const smooth = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (target === 'heading') {
      const heading = document.getElementById('detalhe-auditoria-titulo');
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ behavior: smooth, block: 'start' });
      return;
    }
    const card = document.querySelector<HTMLElement>('#auditorias-armazenadas li > button[aria-current="true"]');
    const idle = !document.activeElement || document.activeElement === document.body;
    if (idle) card?.focus({ preventScroll: true }); // quem já está digitando no filtro mantém o foco
    card?.scrollIntoView({ behavior: smooth, block: 'nearest' });
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
      {listReady && state.requestIssue && (
        <RequestedAuditNotice
          issue={state.requestIssue}
          canChoose={state.list.total > 0}
          onDismiss={() => {
            dismissed.current = true;
            syncAuditIdInUrl(null);
            dispatch({ type: 'REQUEST_DISMISSED' });
            // o aviso some: o foco continua dentro da área (no filtro; sem lista, no título da área)
            const title = document.getElementById('auditorias-armazenadas-title');
            if (!document.getElementById('filtro-auditorias') && title) title.setAttribute('tabindex', '-1');
            (document.getElementById('filtro-auditorias') ?? title)?.focus();
          }}
        />
      )}
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
              afterSelect.current = 'heading';
              dismissed.current = false;
              syncAuditIdInUrl(auditId); // o endereço passa a ser o da empresa exibida (atualizar/voltar não restauram outra)
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
                    className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-white/[0.1] px-3 text-sm text-gmn-text transition-colors hover:border-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70"
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    Tentar novamente
                  </button>
                )}
              </div>
            )}
            {state.detail.data && state.detail.data.auditId === state.selectedId && (state.detail.phase === 'ready' || state.detail.phase === 'loading') && (
              <StoredAuditDetail
                detail={state.detail.data}
                loading={state.detail.phase === 'loading'}
                onSelectRevision={(capture, revision) => {
                  afterSelect.current = null;
                  void select(state.selectedId ?? '', { ...(capture !== null ? { capture } : {}), revision });
                }}
              />
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
