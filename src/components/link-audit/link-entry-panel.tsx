import { Link2, Loader2, Search, X } from 'lucide-react';
import { Panel } from '@/components/ui/panel';

interface LinkEntryPanelProps {
  readonly link: string;
  readonly loading: boolean;
  readonly error: string | null;
  readonly canValidate: boolean;
  readonly canClear: boolean;
  readonly onLinkChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onClear: () => void;
}

const INPUT_CLASS =
  'h-11 w-full rounded-lg border border-white/40 bg-gmn-tile px-3 text-sm text-gmn-text transition-colors placeholder:text-gmn-muted/80 hover:border-white/60 focus:border-gmn-accent focus:outline-none focus:ring-2 focus:ring-gmn-accent/40';

export function LinkEntryPanel({
  link,
  loading,
  error,
  canValidate,
  canClear,
  onLinkChange,
  onSubmit,
  onClear,
}: LinkEntryPanelProps): React.JSX.Element {
  return (
    <Panel
      id="entrada-do-link"
      icon={Link2}
      title="Link do perfil"
      subtitle="Cole o link completo da página da empresa no Google Maps. Só o texto do link é analisado; nada é consultado fora desta tela."
    >
      <form
        className="mt-4 space-y-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div>
          <label htmlFor="link-audit-input" className="mb-1.5 block text-xs font-medium text-gmn-muted">
            Link do Google Maps
          </label>
          <input
            id="link-audit-input"
            name="link"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={link}
            onChange={(event) => onLinkChange(event.target.value)}
            placeholder="https://www.google.com/maps/place/…"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'link-audit-error' : 'link-audit-hint'}
            className={INPUT_CLASS}
          />
          <p id="link-audit-hint" className="mt-1.5 text-xs text-gmn-muted">
            Aceitos: links do Google Maps com o identificador do perfil. Links curtos (maps.app.goo.gl, goo.gl/maps, g.page) ficam com resolução pendente.
          </p>
        </div>

        {error && (
          <p
            id="link-audit-error"
            role="alert"
            className="rounded-lg border border-gmn-danger/40 bg-gmn-danger/10 px-3 py-2 text-sm text-red-200"
          >
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="submit"
            disabled={!canValidate}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#1D68DB] px-5 text-sm font-semibold text-white shadow-lg shadow-gmn-primary/25 transition hover:bg-[#1A5FCF] active:scale-[.99] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Search className="h-4 w-4" aria-hidden="true" />
            )}
            {loading ? 'Analisando…' : 'Validar link'}
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={!canClear}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-white/[0.1] bg-gmn-tile px-5 text-sm font-medium text-gmn-muted transition-colors hover:text-gmn-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Limpar
          </button>
        </div>
      </form>
    </Panel>
  );
}
