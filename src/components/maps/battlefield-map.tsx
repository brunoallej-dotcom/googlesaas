'use client';

import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { AttributionControl, MapContainer, TileLayer, useMap } from 'react-leaflet';
import type { BattlefieldMapModel } from '@/lib/battlefield-map-adapter';
import { MAP_TILE_CONFIG } from '@/lib/battlefield-map-utils';
import { CompanyMarker, RankingMarker } from './ranking-marker';

export type BaseMapStatus = 'ok' | 'failed';

export interface BattlefieldMapProps {
  readonly model: BattlefieldMapModel;
  readonly businessName: string | null;
  /** Muda para recriar a camada de tiles ("Tentar novamente"). */
  readonly tileKey: number;
  readonly onBaseMapStatus: (status: BaseMapStatus) => void;
}

/** Enquadra os pontos só quando os dados mudam (fitKey) ou o usuário pede; polling não desfaz o zoom dele. */
function FitBounds({
  model,
  reframeNonce,
}: {
  readonly model: BattlefieldMapModel;
  readonly reframeNonce: number;
}): null {
  const map = useMap();
  useEffect(() => {
    const coordinates: L.LatLngTuple[] = model.markers.map((m) => [m.latitude, m.longitude]);
    if (model.company) coordinates.push([model.company.latitude, model.company.longitude]);
    if (coordinates.length === 0) return;
    map.fitBounds(L.latLngBounds(coordinates), { padding: [32, 32], maxZoom: 16, animate: false });
    // `model` é lido do render em que fitKey mudou; mudanças sem novo fitKey não reenquadram.
  }, [map, model.fitKey, reframeNonce]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** A roda do mouse só dá zoom depois de um clique no mapa, para não prender a rolagem da página. */
function WheelGuard(): null {
  const map = useMap();
  useEffect(() => {
    map.scrollWheelZoom.disable();
    const container = map.getContainer();
    const enable = (): void => void map.scrollWheelZoom.enable();
    const disable = (): void => void map.scrollWheelZoom.disable();
    map.on('click', enable);
    container.addEventListener('mouseleave', disable);
    return () => {
      map.off('click', enable);
      container.removeEventListener('mouseleave', disable);
    };
  }, [map]);
  return null;
}

/**
 * Esc fecha o popup mesmo com o foco em um marcador. O Leaflet só trata Esc quando o foco está
 * no próprio contêiner do mapa; o evento de teclado do marcador sobe até aqui.
 */
function PopupEscape(): null {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') map.closePopup();
    };
    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [map]);
  return null;
}

function ReframeControl({ onReframe }: { readonly onReframe: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) L.DomEvent.disableClickPropagation(ref.current);
  }, []);
  return (
    <div className="leaflet-bottom leaflet-left">
      <div ref={ref} className="leaflet-control gmn-reframe">
        <button type="button" onClick={onReframe} aria-label="Reenquadrar o mapa nos pontos">
          Reenquadrar
        </button>
      </div>
    </div>
  );
}

export function BattlefieldMap({
  model,
  businessName,
  tileKey,
  onBaseMapStatus,
}: BattlefieldMapProps): React.JSX.Element {
  const [reframeNonce, setReframeNonce] = useState(0);
  const loads = useRef(0);
  const errors = useRef(0);
  const reported = useRef<BaseMapStatus>('ok');

  // Nova camada de tiles: zera a contagem e volta ao estado normal.
  useEffect(() => {
    loads.current = 0;
    errors.current = 0;
    reported.current = 'ok';
    onBaseMapStatus('ok');
  }, [tileKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const evaluate = (): void => {
    const next: BaseMapStatus = errors.current >= 3 && loads.current === 0 ? 'failed' : 'ok';
    if (next !== reported.current) {
      reported.current = next;
      onBaseMapStatus(next);
    }
  };

  const first = model.markers[0];
  const initialCenter: L.LatLngTuple = model.company
    ? [model.company.latitude, model.company.longitude]
    : first
      ? [first.latitude, first.longitude]
      : [0, 0];

  return (
    <MapContainer
      center={initialCenter}
      zoom={15}
      minZoom={3}
      maxZoom={MAP_TILE_CONFIG.maxZoom}
      attributionControl={false}
      className="gmn-map absolute inset-0 h-full w-full rounded-xl"
      aria-label="Mapa do Campo de Batalha Geográfico"
    >
      <TileLayer
        key={tileKey}
        url={MAP_TILE_CONFIG.url}
        attribution={MAP_TILE_CONFIG.attribution}
        maxZoom={MAP_TILE_CONFIG.maxZoom}
        eventHandlers={{
          tileload: () => {
            loads.current += 1;
            evaluate();
          },
          tileerror: () => {
            errors.current += 1;
            evaluate();
          },
        }}
      />
      <AttributionControl position="bottomright" prefix={false} />
      <FitBounds model={model} reframeNonce={reframeNonce} />
      <WheelGuard />
      <PopupEscape />
      <ReframeControl onReframe={() => setReframeNonce((n) => n + 1)} />

      {model.markers.map((marker) => (
        <RankingMarker
          key={marker.pointIndex}
          marker={marker}
          businessName={businessName}
          keyword={model.keyword}
          isCompanyLocation={marker.pointIndex === model.companyCoincidesWithPointIndex}
        />
      ))}
      {model.company && model.companyCoincidesWithPointIndex === null && (
        <CompanyMarker
          latitude={model.company.latitude}
          longitude={model.company.longitude}
          name={businessName ?? model.company.name}
        />
      )}
    </MapContainer>
  );
}
