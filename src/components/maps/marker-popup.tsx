import type { MapMarker } from '@/lib/battlefield-map-adapter';
import { TIER_META, formatCoordinate } from '@/lib/battlefield-map-utils';

interface MarkerPopupProps {
  readonly marker: MapMarker;
  readonly businessName: string | null;
  readonly keyword: string | null;
  /** O marcador coincide com a localização da empresa auditada. */
  readonly isCompanyLocation: boolean;
}

function positionText(marker: MapMarker): string {
  if (marker.tier === 'GRAY_UNREADABLE') return 'Sem leitura';
  if (marker.tier === 'INVISIBLE' || marker.rank === null) return 'Acima de 20';
  return `#${marker.rank}`;
}

function readingText(marker: MapMarker): string {
  const attempts =
    marker.attempts === null
      ? ''
      : ` (${marker.attempts} ${marker.attempts === 1 ? 'tentativa' : 'tentativas'})`;
  return marker.readStatus === 'VALID' ? `Lido com sucesso${attempts}` : `Sem leitura válida${attempts}`;
}

/** Conteúdo do popup: somente campos reais do ponto; nada é estimado. */
export function MarkerPopup({
  marker,
  businessName,
  keyword,
  isCompanyLocation,
}: MarkerPopupProps): React.JSX.Element {
  const meta = TIER_META[marker.tier];
  const rows: readonly (readonly [string, string])[] = [
    ['Posição da empresa', positionText(marker)],
    ['Latitude', formatCoordinate(marker.latitude)],
    ['Longitude', formatCoordinate(marker.longitude)],
    [
      'Distância do centro',
      marker.distanceMeters === null ? 'Não disponível' : `${Math.round(marker.distanceMeters)} m`,
    ],
    ['Status da leitura', readingText(marker)],
    ['Concorrente líder', marker.leaderName ?? 'Líder não informado'],
  ];

  return (
    <div className="gmn-popup">
      <p className="gmn-popup__title">Campo de Batalha — Ponto #{marker.pointNumber}</p>
      <p className="gmn-popup__tier">
        <span aria-hidden="true" className="gmn-popup__dot" style={{ backgroundColor: meta.color }} />
        {meta.classification}
      </p>
      <dl className="gmn-popup__list">
        {rows.map(([label, value]) => (
          <div key={label} className="gmn-popup__row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {(businessName || keyword) && (
        <p className="gmn-popup__footer">
          {businessName && <strong>{businessName}</strong>}
          {businessName && keyword && ' · '}
          {keyword && <span>“{keyword}”</span>}
        </p>
      )}
      {isCompanyLocation && (
        <p className="gmn-popup__company">Localização da empresa auditada</p>
      )}
    </div>
  );
}
