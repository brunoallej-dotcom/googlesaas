'use client';

import { Loader2, MapPinOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import type { BattlefieldMapProps } from './battlefield-map';

type LoaderState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly Map: ComponentType<BattlefieldMapProps> };

/**
 * Carrega o Leaflet só no navegador, dentro de um efeito: nada de Leaflet roda no servidor
 * (sem erro de hidratação). Não usa next/dynamic porque ele guarda a falha do import; aqui
 * "Tentar novamente" refaz o import sem reiniciar nenhuma auditoria.
 */
export function BattlefieldMapLoader(props: BattlefieldMapProps): React.JSX.Element {
  const [state, setState] = useState<LoaderState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    import('./battlefield-map')
      .then((mod) => {
        if (!cancelled) setState({ status: 'ready', Map: mod.BattlefieldMap });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (state.status === 'ready') {
    const MapComponent = state.Map;
    return <MapComponent {...props} />;
  }

  if (state.status === 'error') {
    return (
      <div
        role="alert"
        className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-xl bg-gmn-sidebar px-6 text-center"
      >
        <MapPinOff className="h-8 w-8 text-gmn-danger" aria-hidden="true" />
        <p className="text-sm font-medium text-gmn-text">Não foi possível carregar o mapa.</p>
        <p className="max-w-sm text-xs text-gmn-muted">
          Os resultados da auditoria estão salvos. Verifique a conexão e tente novamente.
        </p>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="rounded-lg border border-gmn-primary/40 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-gmn-primary/15"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="gmn-grid-bg absolute inset-0 flex animate-pulse flex-col items-center justify-center gap-2 rounded-xl bg-gmn-sidebar text-gmn-muted"
    >
      <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
      <span className="text-xs">Carregando mapa…</span>
    </div>
  );
}
