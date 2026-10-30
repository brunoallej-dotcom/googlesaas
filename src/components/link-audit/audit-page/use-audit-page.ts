'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { httpApi } from './api';
import type { Ctx } from './controller';
import { loadAll, newTokens } from './controller';
import type { Action, PageState } from './state';
import { initialPageState, pageReducer } from './state';

/**
 * Liga o reducer ao React com um estado SÍNCRONO (a referência é atualizada antes da renderização): o controlador sempre lê o estado
 * mais novo logo depois de um `dispatch`, mesmo dentro de uma mesma sequência assíncrona.
 */
export function useAuditPage(auditId: string): { readonly state: PageState; readonly ctx: Ctx } {
  const [state, setState] = useState<PageState>(() => initialPageState(auditId));
  const ref = useRef<PageState>(state);
  const dispatch = useCallback((action: Action): void => {
    ref.current = pageReducer(ref.current, action);
    setState(ref.current);
  }, []);
  const ctx = useMemo<Ctx>(() => ({ api: httpApi, dispatch, getState: () => ref.current, auditId, tokens: newTokens() }), [auditId, dispatch]);

  useEffect(() => {
    void loadAll(ctx);
  }, [ctx]);

  useEffect(() => {
    if (state.unauthorized) window.location.assign(`/login?next=${encodeURIComponent(`/auditoria-por-link/${auditId}`)}`);
  }, [state.unauthorized, auditId]);

  return { state, ctx };
}
