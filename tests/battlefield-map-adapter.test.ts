import assert from 'node:assert/strict';
import test from 'node:test';
import { toBattlefieldMapModel, EMPTY_BATTLEFIELD_MODEL } from '../src/lib/battlefield-map-adapter';
import { buildFixtureBattlefield, buildFixtureLead } from '../src/dev/battlefield-fixture';
import type { BattlefieldMetrics } from '../src/types/gmn';

const lead = buildFixtureLead();

function withPoints(
  base: BattlefieldMetrics,
  mutate: (points: BattlefieldMetrics['points']) => BattlefieldMetrics['points']
): BattlefieldMetrics {
  return { ...base, points: mutate(base.points) };
}

test('converte os 49 pontos sem alterar nem gerar coordenadas', () => {
  const bf = buildFixtureBattlefield('full');
  const model = toBattlefieldMapModel({ battlefield: bf, lead });

  assert.equal(model.markers.length, 49);
  for (const marker of model.markers) {
    const source = bf.points.find((pt) => pt.pointIndex === marker.pointIndex);
    assert.ok(source);
    assert.equal(marker.latitude, source.latitude);
    assert.equal(marker.longitude, source.longitude);
    assert.equal(marker.pointNumber, marker.pointIndex + 1);
  }
  assert.equal(model.coverage.collected, 49);
  assert.equal(model.coverage.missing, 0);
});

test('contagens e percentuais batem com as métricas do agente (denominador = leituras válidas)', () => {
  for (const variant of ['full', 'unreadable', 'partial'] as const) {
    const bf = buildFixtureBattlefield(variant);
    const model = toBattlefieldMapModel({ battlefield: bf, lead });

    assert.equal(model.counts.top3, bf.greenTop3Count, variant);
    assert.equal(model.counts.top4to7, bf.yellowTop4To7Count, variant);
    assert.equal(model.counts.rank8to20, bf.redRank8To20Count, variant);
    assert.equal(model.counts.above20, bf.invisibleCount, variant);
    assert.equal(model.counts.unreadable, bf.unreadablePointsCount, variant);
    assert.equal(model.coverage.valid, bf.validPointsCount, variant);
    assert.equal(model.percentages.top3, bf.top3Percentage, variant);
    assert.equal(model.percentages.top7, bf.top7Percentage, variant);
    assert.equal(model.percentages.above20, bf.invisibilityPercentage, variant);
    assert.equal(model.averagePosition, bf.averagePosition, variant);
  }
});

test('sem leitura fica cinza e fora do denominador, e é informado à parte', () => {
  const bf = buildFixtureBattlefield('unreadable');
  const model = toBattlefieldMapModel({ battlefield: bf, lead });

  assert.equal(model.coverage.unreadable, 2);
  assert.equal(model.coverage.valid, 47);
  const unreadable = model.markers.filter((m) => m.tier === 'GRAY_UNREADABLE');
  assert.equal(unreadable.length, 2);
  assert.ok(unreadable.every((m) => m.label === 'S/L' && m.rank === null));
  // Os 2 pontos sem leitura continuam no mapa (têm coordenada real).
  assert.equal(model.markers.length, 49);
});

test('ponto válido sem posição vira "acima de 20" (azul), não "sem leitura"', () => {
  const bf = buildFixtureBattlefield('full');
  const model = toBattlefieldMapModel({ battlefield: bf, lead });
  const farPoint = model.markers.find((m) => m.pointIndex === 0);
  assert.equal(farPoint?.tier, 'INVISIBLE');
  assert.equal(farPoint?.label, '>20');
  assert.equal(farPoint?.rank, null);
});

test('resultado incompleto mostra só os pontos coletados e informa os ausentes', () => {
  const bf = buildFixtureBattlefield('partial');
  const model = toBattlefieldMapModel({ battlefield: bf, lead });

  assert.equal(model.markers.length, 30);
  assert.equal(model.coverage.collected, 30);
  assert.equal(model.coverage.missing, 19);
  assert.equal(model.coverage.expected, 49);
});

test('coordenada inválida não é plotada, é contada e a posição continua nas contagens', () => {
  const full = buildFixtureBattlefield('full');
  const broken = withPoints(full, (points) =>
    points.map((pt) => (pt.pointIndex === 10 ? { ...pt, latitude: Number.NaN } : pt))
  );
  const model = toBattlefieldMapModel({ battlefield: broken, lead });

  assert.equal(model.markers.length, 48);
  assert.equal(model.coverage.invalid, 1);
  assert.equal(model.coverage.collected, 49);
  assert.equal(model.markers.some((m) => m.pointIndex === 10), false);
  // Nenhuma coordenada foi inventada para o ponto descartado.
  assert.equal(model.markers.every((m) => Number.isFinite(m.latitude)), true);
});

test('posição fora do formato vira sem leitura em vez de ser interpretada', () => {
  const full = buildFixtureBattlefield('full');
  const weird = withPoints(full, (points) =>
    points.map((pt) => (pt.pointIndex === 24 ? { ...pt, targetRank: 0 } : pt))
  );
  const model = toBattlefieldMapModel({ battlefield: weird, lead });
  const center = model.markers.find((m) => m.pointIndex === 24);
  assert.equal(center?.tier, 'GRAY_UNREADABLE');
});

test('sem leituras válidas, percentuais e posição média ficam indisponíveis (null), nunca 0%', () => {
  const full = buildFixtureBattlefield('full');
  const allUnreadable = withPoints(full, (points) =>
    points.map((pt) => ({ ...pt, readStatus: 'UNREADABLE' as const, targetRank: null }))
  );
  const model = toBattlefieldMapModel({ battlefield: allUnreadable, lead });

  assert.equal(model.coverage.valid, 0);
  assert.equal(model.percentages.top3, null);
  assert.equal(model.percentages.top7, null);
  assert.equal(model.percentages.above20, null);
  assert.equal(model.averagePosition, null);
});

test('preserva dados reais do ponto e não expõe nota/avaliações do líder', () => {
  const bf = buildFixtureBattlefield('full');
  const model = toBattlefieldMapModel({ battlefield: bf, lead });
  const marker = model.markers.find((m) => m.pointIndex === 24);
  const source = bf.points.find((pt) => pt.pointIndex === 24);

  assert.equal(marker?.leaderName, source?.pointLeader?.businessName);
  assert.equal(marker?.attempts, source?.attemptsMade);
  assert.equal(marker?.distanceMeters, source?.distanceFromCenterMeters);
  assert.equal('leaderRating' in (marker ?? {}), false);
  assert.equal('rating' in (marker ?? {}), false);
});

test('nome genérico de líder vira "não informado" (null)', () => {
  const full = buildFixtureBattlefield('full');
  const generic = withPoints(full, (points) =>
    points.map((pt) =>
      pt.pointIndex === 24 && pt.pointLeader
        ? { ...pt, pointLeader: { ...pt.pointLeader, businessName: 'Concorrente Local #1' } }
        : pt
    )
  );
  const model = toBattlefieldMapModel({ battlefield: generic, lead });
  assert.equal(model.markers.find((m) => m.pointIndex === 24)?.leaderName, null);
});

test('empresa coincide com o ponto central da grade (halo) e não desloca coordenadas', () => {
  const bf = buildFixtureBattlefield('full');
  const model = toBattlefieldMapModel({ battlefield: bf, lead });
  assert.equal(model.company?.source, 'lead');
  assert.equal(model.companyCoincidesWithPointIndex, 24);
  assert.equal(model.company?.latitude, lead.coordinates.latitude);
});

test('empresa fora da grade não coincide com nenhum ponto', () => {
  const bf = buildFixtureBattlefield('full');
  const far = { ...lead, coordinates: { latitude: -16.2, longitude: -48.8 } };
  const model = toBattlefieldMapModel({ battlefield: bf, lead: far });
  assert.equal(model.companyCoincidesWithPointIndex, null);
});

test('sem lead, a empresa usa o centro de interesse', () => {
  const bf = buildFixtureBattlefield('full');
  const model = toBattlefieldMapModel({ battlefield: bf });
  assert.equal(model.company?.source, 'center');
});

test('evolução só aparece com rodada anterior real (baseline sem previousRoundId é ocultado)', () => {
  const bf = buildFixtureBattlefield('full');
  const fabricated: BattlefieldMetrics = {
    ...bf,
    historicalEvolution: {
      ...bf.historicalEvolution,
      hasPreviousRound: true,
      previousRoundId: null,
      previousGreenTop3Count: 1,
      greenPointsDelta: 3,
      averagePositionDelta: -2.4,
      evolutionSummaryText: 'baseline',
    },
  };
  assert.equal(toBattlefieldMapModel({ battlefield: fabricated, lead }).evolution, null);

  const real: BattlefieldMetrics = {
    ...fabricated,
    historicalEvolution: { ...fabricated.historicalEvolution, previousRoundId: 'round-anterior' },
  };
  const evolution = toBattlefieldMapModel({ battlefield: real, lead }).evolution;
  assert.equal(evolution?.greenPointsDelta, 3);
  assert.equal(evolution?.averagePositionDelta, -2.4);
});

test('trocar de empresa/auditoria troca marcadores e fitKey, sem resíduo da anterior', () => {
  const first = buildFixtureBattlefield('full');
  const second: BattlefieldMetrics = {
    ...buildFixtureBattlefield('partial'),
    roundId: 'outra-rodada',
    placeId: 'OUTRA_EMPRESA',
  };
  const a = toBattlefieldMapModel({ battlefield: first, lead, auditId: 'audit-A' });
  const b = toBattlefieldMapModel({ battlefield: second, lead: { ...lead, id: 'outro', placeId: 'OUTRA_EMPRESA' }, auditId: 'audit-B' });

  assert.notEqual(a.fitKey, b.fitKey);
  assert.equal(a.markers.length, 49);
  assert.equal(b.markers.length, 30);
  // O mesmo dado gera o mesmo modelo (função pura).
  assert.deepEqual(a, toBattlefieldMapModel({ battlefield: first, lead, auditId: 'audit-A' }));
});

test('erros e entradas vazias: modelo vazio, sem lançar exceção', () => {
  assert.equal(toBattlefieldMapModel({ battlefield: null, lead }), EMPTY_BATTLEFIELD_MODEL);
  assert.equal(toBattlefieldMapModel({ battlefield: undefined }), EMPTY_BATTLEFIELD_MODEL);
  const noPoints = { ...buildFixtureBattlefield('full'), points: undefined } as unknown as BattlefieldMetrics;
  assert.equal(toBattlefieldMapModel({ battlefield: noPoints, lead }).hasData, false);
  assert.equal(EMPTY_BATTLEFIELD_MODEL.coverage.collected, 0);
  assert.equal(EMPTY_BATTLEFIELD_MODEL.markers.length, 0);
});
