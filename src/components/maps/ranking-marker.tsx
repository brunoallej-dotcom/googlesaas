'use client';

import L from 'leaflet';
import { memo } from 'react';
import { Marker, Popup } from 'react-leaflet';
import type { GridPointVisualTier } from '@/types/gmn';
import type { MapMarker } from '@/lib/battlefield-map-adapter';
import { TIER_META } from '@/lib/battlefield-map-utils';
import { MarkerPopup } from './marker-popup';

const iconCache = new Map<string, L.DivIcon>();

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Um ícone por (faixa, rótulo, halo): os 49 marcadores não recriam ícones a cada render. */
function rankingIcon(tier: GridPointVisualTier, label: string, companyHalo: boolean): L.DivIcon {
  const key = `${tier}|${label}|${companyHalo ? 1 : 0}`;
  const cached = iconCache.get(key);
  if (cached) return cached;

  const meta = TIER_META[tier];
  const icon = L.divIcon({
    className: 'gmn-marker',
    html: `<span class="gmn-pin${companyHalo ? ' gmn-pin--company' : ''}" style="background:${meta.color};color:${meta.textColor}">${escapeHtml(label)}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -20],
  });
  iconCache.set(key, icon);
  return icon;
}

const TIER_Z: Record<GridPointVisualTier, number> = {
  GREEN_TOP3: 300,
  YELLOW_TOP7: 200,
  RED_8_TO_20: 100,
  INVISIBLE: 0,
  GRAY_UNREADABLE: 0,
};

interface RankingMarkerProps {
  readonly marker: MapMarker;
  readonly businessName: string | null;
  readonly keyword: string | null;
  /** A empresa está neste ponto: o marcador ganha um halo branco. */
  readonly isCompanyLocation: boolean;
}

function RankingMarkerBase({
  marker,
  businessName,
  keyword,
  isCompanyLocation,
}: RankingMarkerProps): React.JSX.Element {
  const description = `Ponto ${marker.pointNumber}: ${
    marker.tier === 'GRAY_UNREADABLE'
      ? 'sem leitura'
      : marker.rank === null
        ? 'acima de 20'
        : `posição ${marker.rank}`
  } (${TIER_META[marker.tier].classification})${isCompanyLocation ? ', localização da empresa' : ''}`;

  return (
    <Marker
      position={[marker.latitude, marker.longitude]}
      icon={rankingIcon(marker.tier, marker.label, isCompanyLocation)}
      title={description}
      zIndexOffset={TIER_Z[marker.tier] + (isCompanyLocation ? 500 : 0)}
      eventHandlers={{
        add: (event) => {
          // Leaflet só define aria-label em ícones <img>; aqui o ícone é um <div>.
          (event.target as L.Marker).getElement()?.setAttribute('aria-label', description);
        },
      }}
    >
      <Popup minWidth={240} maxWidth={300} autoPanPadding={[24, 24]}>
        <MarkerPopup
          marker={marker}
          businessName={businessName}
          keyword={keyword}
          isCompanyLocation={isCompanyLocation}
        />
      </Popup>
    </Marker>
  );
}

export const RankingMarker = memo(RankingMarkerBase);

const COMPANY_PIN_HTML =
  '<span class="gmn-company-pin"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01M9 12v.01M9 15v.01M9 18v.01"/></svg></span>';

const companyIcon = L.divIcon({
  className: 'gmn-marker',
  html: COMPANY_PIN_HTML,
  iconSize: [40, 40],
  iconAnchor: [20, 20],
  popupAnchor: [0, -22],
});

interface CompanyMarkerProps {
  readonly latitude: number;
  readonly longitude: number;
  readonly name: string | null;
}

/** Pino próprio da empresa; só usado quando ela não coincide com nenhum ponto da grade. */
export function CompanyMarker({ latitude, longitude, name }: CompanyMarkerProps): React.JSX.Element {
  const description = `Localização da empresa auditada${name ? `: ${name}` : ''}`;
  return (
    <Marker
      position={[latitude, longitude]}
      icon={companyIcon}
      title={description}
      zIndexOffset={1000}
      eventHandlers={{
        add: (event) => {
          (event.target as L.Marker).getElement()?.setAttribute('aria-label', description);
        },
      }}
    >
      <Popup minWidth={200} maxWidth={280}>
        <div className="gmn-popup">
          <p className="gmn-popup__title">Empresa auditada</p>
          <p className="gmn-popup__footer">{name ?? 'Nome não disponível'}</p>
        </div>
      </Popup>
    </Marker>
  );
}
