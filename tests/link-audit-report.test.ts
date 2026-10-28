import assert from 'node:assert/strict';
import test from 'node:test';
import { collectEvidence } from '../src/lib/link-audit/collector/collect';
import { CallLedger } from '../src/lib/link-audit/collector/budget';
import { divergences, profileSummary } from '../src/lib/link-audit/collector/summaries';
import { parseMapsPlaces } from '../src/lib/link-audit/collector/maps-place';
import { MAPS_ORIGIN_LIMITATION } from '../src/lib/link-audit/collector/capabilities';
import { NAMED, PLACE, SITE_HTML, clock, mapsFake, siteFake } from './helpers/link-audit-collect-fixtures';

const place = () => {
  const parsed = parseMapsPlaces([PLACE]).places[0];
  assert.ok(parsed);
  return parsed;
};

test('a limitação de origem diz Serper /maps, intermediário, e que não é a API oficial do Google Business Profile', () => {
  assert.match(MAPS_ORIGIN_LIMITATION, /Serper \/maps/);
  assert.match(MAPS_ORIGIN_LIMITATION, /intermediário/);
  assert.match(MAPS_ORIGIN_LIMITATION, /não é a API oficial do Google Business Profile/);
});

test('resumo do perfil: site saneado, sem parâmetros de rastreio', () => {
  const profile = profileSummary(place());
  assert.equal(profile.website, 'https://www.padaria-exemplo.example/');
  assert.equal(profile.name, 'Padaria Exemplo (fictícia)');
});

test('divergências só existem quando o site foi realmente lido', () => {
  const profile = profileSummary(place());
  assert.deepEqual(divergences(profile, null, []), []);
  assert.deepEqual(divergences(null, null, []), []);
});

test('coleta com razão: reserva antes da chamada e resultado traz o horário da consulta de cada fonte', async () => {
  const ledger = new CallLedger('SIMULATED', { 'serper-maps': 1, 'serper-reviews': 0, 'site-check': 1 }, clock);
  const outcome = await collectEvidence(NAMED(), { maps: mapsFake([PLACE]), site: siteFake({ '/': { body: SITE_HTML }, '/robots.txt': { body: '' } }) }, { budget: { maps: 1, reviews: 0, site: 1 }, now: clock, ledger });
  assert.ok(outcome.ok);
  assert.equal(outcome.result.queriedAt.maps, '2026-10-21T12:10:00.000Z');
  assert.equal(outcome.result.queriedAt.site, '2026-10-21T12:20:00.000Z');
  assert.deepEqual(ledger.list().filter((e) => e.status === 'simulated').map((e) => e.provider), ['serper-maps', 'site-check']);
});

test('razão com orçamento zero para o /maps: o provedor nunca é acionado', async () => {
  const ledger = new CallLedger('SIMULATED', { 'serper-maps': 0, 'serper-reviews': 0, 'site-check': 1 }, clock);
  let called = 0;
  const outcome = await collectEvidence(NAMED(), { maps: { search: async () => { called += 1; return { state: 'OK', value: [], fetchedAt: '2026-10-21T12:00:00.000Z' }; } } }, { budget: { maps: 1, reviews: 0, site: 1 }, now: clock, ledger });
  assert.ok(outcome.ok);
  assert.equal(called, 0);
  assert.match(outcome.result.limitations.join(' '), /não executada/);
});
