import { History, Loader2, MapPin, Search, Zap } from 'lucide-react';
import type { SavedCampaignSummary } from '@/lib/supabase';

interface TopFiltersProps {
  readonly city: string;
  readonly stateCode: string;
  readonly nicheKeyword: string;
  readonly isProspecting: boolean;
  readonly onCityChange: (value: string) => void;
  readonly onStateCodeChange: (value: string) => void;
  readonly onNicheKeywordChange: (value: string) => void;
  readonly onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  /** Campanhas já salvas: reabrir não consome nenhuma consulta paga. */
  readonly savedCampaigns?: readonly SavedCampaignSummary[];
  readonly activeCampaignId?: string | null;
  readonly loadingCampaignId?: string | null;
  readonly onOpenSavedCampaign?: (campaignId: string) => void;
}

const LABEL_CLASS = 'mb-1.5 block text-xs font-medium text-gmn-muted';
const INPUT_CLASS =
  'h-11 w-full rounded-lg border border-white/[0.08] bg-gmn-tile text-sm text-gmn-text transition-colors placeholder:text-gmn-muted/80 hover:border-white/15 focus:border-gmn-accent focus:outline-none focus:ring-2 focus:ring-gmn-accent/40';
const ICON_CLASS =
  'pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gmn-muted';

export function TopFilters({
  city,
  stateCode,
  nicheKeyword,
  isProspecting,
  onCityChange,
  onStateCodeChange,
  onNicheKeywordChange,
  onSubmit,
  savedCampaigns = [],
  activeCampaignId = null,
  loadingCampaignId = null,
  onOpenSavedCampaign,
}: TopFiltersProps): React.JSX.Element {
  return (
    <section
      aria-label="Prospecção de Fronteira"
      className="rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#121F36] to-gmn-card p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
    >
      <form
        onSubmit={onSubmit}
        aria-busy={isProspecting}
        className="grid grid-cols-1 items-end gap-4 sm:grid-cols-[1fr_96px] lg:grid-cols-[1.2fr_110px_1.5fr_1.2fr]"
      >
        <div>
          <label htmlFor="prospect-city" className={LABEL_CLASS}>
            Cidade Alvo
          </label>
          <div className="relative">
            <MapPin className={ICON_CLASS} aria-hidden="true" />
            <input
              id="prospect-city"
              type="text"
              value={city}
              onChange={(e) => onCityChange(e.target.value)}
              required
              className={`${INPUT_CLASS} pl-10 pr-3`}
              placeholder="Ex: Anápolis"
            />
          </div>
        </div>
        <div>
          <label htmlFor="prospect-uf" className={LABEL_CLASS}>
            UF
          </label>
          <input
            id="prospect-uf"
            type="text"
            value={stateCode}
            onChange={(e) => onStateCodeChange(e.target.value)}
            maxLength={2}
            required
            className={`${INPUT_CLASS} px-3.5 uppercase`}
            placeholder="GO"
          />
        </div>
        <div className="sm:col-span-2 lg:col-span-1">
          <label htmlFor="prospect-niche" className={LABEL_CLASS}>
            Nicho / Palavra-chave
          </label>
          <div className="relative">
            <Search className={ICON_CLASS} aria-hidden="true" />
            <input
              id="prospect-niche"
              type="text"
              value={nicheKeyword}
              onChange={(e) => onNicheKeywordChange(e.target.value)}
              required
              className={`${INPUT_CLASS} pl-10 pr-3`}
              placeholder="Ex: Clínica Odontológica"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={isProspecting}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-gmn-primary-strong px-5 text-sm font-semibold text-white shadow-lg shadow-gmn-primary/25 transition hover:bg-gmn-primary-strong-hover active:scale-[.99] disabled:cursor-not-allowed disabled:opacity-60 sm:col-span-2 lg:col-span-1"
        >
          {isProspecting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Zap className="h-4 w-4" aria-hidden="true" />
          )}
          {isProspecting ? 'Rastreando Fronteira GMN...' : 'Capturar 10 Leads de Fronteira'}
        </button>
      </form>
      {onOpenSavedCampaign && savedCampaigns.length > 0 && (
        <div className="mt-4 flex flex-col gap-2 border-t border-white/[0.06] pt-4 sm:flex-row sm:items-center">
          <label htmlFor="saved-campaigns" className="flex items-center gap-2 text-xs font-medium text-gmn-muted">
            <History className="h-4 w-4" aria-hidden="true" />
            Campanhas salvas
          </label>
          <select
            id="saved-campaigns"
            value={activeCampaignId ?? ''}
            disabled={loadingCampaignId !== null}
            onChange={(e) => e.target.value && onOpenSavedCampaign(e.target.value)}
            className="h-10 min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-gmn-tile px-3 text-sm text-gmn-text focus:border-gmn-accent focus:outline-none focus:ring-2 focus:ring-gmn-accent/40 disabled:opacity-60"
          >
            <option value="">Abrir uma campanha salva (sem custo)…</option>
            {savedCampaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.city}/{c.stateCode} · {c.nicheKeyword} · {new Date(c.createdAt).toLocaleDateString('pt-BR')}
              </option>
            ))}
          </select>
        </div>
      )}
    </section>
  );
}
