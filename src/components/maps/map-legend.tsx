import type { MapCounts } from '@/lib/battlefield-map-adapter';
import { TIER_META, TIER_ORDER } from '@/lib/battlefield-map-utils';
import type { GridPointVisualTier } from '@/types/gmn';

interface MapLegendProps {
  /** Com `counts` mostra a quantidade de cada faixa; sem dado, "—". */
  readonly counts?: MapCounts | null;
  readonly variant: 'list' | 'inline';
}

function countFor(tier: GridPointVisualTier, counts: MapCounts | null | undefined): string {
  if (!counts) return '—';
  const value: Record<GridPointVisualTier, number> = {
    GREEN_TOP3: counts.top3,
    YELLOW_TOP7: counts.top4to7,
    RED_8_TO_20: counts.rank8to20,
    INVISIBLE: counts.above20,
    GRAY_UNREADABLE: counts.unreadable,
  };
  return String(value[tier]);
}

function CompanySwatch(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 shrink-0 rounded-full border-2 border-white bg-gmn-sidebar"
    />
  );
}

export function MapLegend({ counts, variant }: MapLegendProps): React.JSX.Element {
  if (variant === 'inline') {
    return (
      <ul
        aria-label="Legenda dos marcadores"
        className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gmn-muted"
      >
        {TIER_ORDER.map((tier) => (
          <li key={tier} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: TIER_META[tier].color }}
            />
            {TIER_META[tier].legendLabel}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <CompanySwatch />
          Sua empresa (auditada)
        </li>
      </ul>
    );
  }

  return (
    <ul className="space-y-2.5 text-sm">
      {TIER_ORDER.map((tier) => (
        <li key={tier} className="flex items-center gap-2.5 text-gmn-muted">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: TIER_META[tier].color }}
          />
          <span className="flex-1">{TIER_META[tier].legendLabel}</span>
          <span className="font-mono text-xs tabular-nums text-gmn-text">{countFor(tier, counts)}</span>
        </li>
      ))}
      <li className="flex items-center gap-2.5 text-gmn-muted">
        <CompanySwatch />
        <span className="flex-1">Sua empresa (auditada)</span>
        <span className="font-mono text-xs tabular-nums text-gmn-text">{counts ? '1' : '—'}</span>
      </li>
    </ul>
  );
}
