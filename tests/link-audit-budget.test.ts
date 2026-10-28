import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CallLedger,
  evaluateAuthorization,
  identifiersFingerprint,
  LIVE_HARD_LIMITS,
  MAX_AUTHORIZATION_WINDOW_MS,
  type AuthorizationContext,
  type ConsumptionAuthorization,
} from '../src/lib/link-audit/collector/budget';
import { CID, FID, T_NOW, clock } from './helpers/link-audit-collect-fixtures';

const limits = (maps = 1, reviews = 0, site = 1) => ({ 'serper-maps': maps, 'serper-reviews': reviews, 'site-check': site });
const IDS = { cid: CID, featureId: FID };

test('razão: a chamada é reservada antes, o limite vale e uma falha NUNCA é repetida', () => {
  const ledger = new CallLedger('SIMULATED', limits(3), clock);
  const first = ledger.reserve('serper-maps');
  assert.ok(first.ok);
  ledger.settle(first, 'failed', 'HTTP 500');
  const second = ledger.reserve('serper-maps');
  assert.ok(!second.ok && /falhou e não é repetida/.test(second.reason), 'mesmo com 3 de limite, após falha não há segunda tentativa');
  const summary = ledger.summary()['serper-maps'];
  assert.deepEqual({ simulated: summary.simulated, failed: summary.failed, denied: summary.denied }, { simulated: 1, failed: 1, denied: 1 });
  assert.equal(ledger.externalTraffic, false);
});

test('razão: o limite é respeitado e orçamento zero nega tudo', () => {
  const ledger = new CallLedger('LIVE', limits(1, 0, 1), clock);
  const a = ledger.reserve('serper-maps');
  assert.ok(a.ok);
  ledger.settle(a, 'ok');
  const b = ledger.reserve('serper-maps');
  assert.ok(!b.ok && /limite de chamadas atingido/.test(b.reason));
  const reviews = ledger.reserve('serper-reviews');
  assert.ok(!reviews.ok && /orçamento igual a zero/.test(reviews.reason));
  assert.equal(ledger.externalTraffic, true, 'em LIVE a tentativa conta como enviada');
  assert.equal(ledger.summary()['serper-maps'].sent, 1);
  assert.deepEqual(ledger.list().map((entry) => entry.status), ['sent', 'ok', 'denied', 'denied']);
});

test('razão em DRY_RUN: nunca autoriza chamada; só registra o plano', () => {
  const ledger = new CallLedger('DRY_RUN', limits(2), clock);
  ledger.plan('serper-maps');
  ledger.plan('serper-maps');
  ledger.plan('serper-maps'); // acima do limite: não entra
  assert.equal(ledger.summary()['serper-maps'].planned, 2);
  const reservation = ledger.reserve('serper-maps');
  assert.ok(!reservation.ok && /DRY_RUN/.test(reservation.reason));
  assert.equal(ledger.externalTraffic, false);
  assert.equal(ledger.summary()['serper-maps'].sent, 0);
});

test('razão: entradas têm data (do relógio injetado) e settle de reserva negada é inofensivo', () => {
  const ledger = new CallLedger('SIMULATED', limits(0), clock);
  const denied = ledger.reserve('serper-maps');
  assert.ok(!denied.ok);
  ledger.settle(denied, 'ok');
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.list()[0]?.at, T_NOW);
});

function authorization(overrides: Partial<ConsumptionAuthorization> = {}): ConsumptionAuthorization {
  return {
    authorizationId: 'auth-teste-0001',
    snapshotId: 'snap-exemplo-0001',
    identifiersFingerprint: identifiersFingerprint(IDS),
    maxMapsCalls: 1,
    maxSiteHttpRequests: 8,
    expiresAt: '2026-10-21T13:00:00.000Z',
    costAcknowledged: true,
    operator: 'ana@empresa.com',
    ...overrides,
  };
}

function context(overrides: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    liveEnabled: true,
    snapshotId: 'snap-exemplo-0001',
    identifiers: IDS,
    now: clock(),
    requested: { maps: 1, siteHttpRequests: 8 },
    isUsed: () => false,
    ...overrides,
  };
}

test('autorização válida libera exatamente o pedido, nunca acima dos tetos do LIVE', () => {
  const ok = evaluateAuthorization(authorization(), context());
  assert.ok(ok.ok);
  assert.deepEqual(ok.effective, { maps: 1, siteHttpRequests: 8 });
  const big = evaluateAuthorization(authorization({ maxMapsCalls: 9, maxSiteHttpRequests: 99 }), context({ requested: { maps: 9, siteHttpRequests: 99 } }));
  assert.ok(big.ok);
  assert.deepEqual(big.effective, { maps: LIVE_HARD_LIMITS.maps, siteHttpRequests: LIVE_HARD_LIMITS.siteHttpRequests });
});

test('falha fechada: cada defeito da autorização tem a sua recusa', () => {
  const deny = (auth: unknown, ctx: AuthorizationContext = context()) => {
    const result = evaluateAuthorization(auth, ctx);
    assert.ok(!result.ok, JSON.stringify(auth)?.slice(0, 80));
    return result.ok ? '' : result.code;
  };
  assert.equal(deny(authorization(), context({ liveEnabled: false })), 'LIVE_DISABLED');
  assert.equal(deny(undefined), 'NO_AUTHORIZATION');
  assert.equal(deny(null), 'NO_AUTHORIZATION');
  assert.equal(deny('autorizado'), 'NO_AUTHORIZATION');
  assert.equal(deny({}), 'INVALID_AUTHORIZATION');
  assert.equal(deny(authorization({ authorizationId: 'curto' })), 'INVALID_AUTHORIZATION');
  assert.equal(deny(authorization({ authorizationId: '../../etc/passwd' })), 'INVALID_AUTHORIZATION');
  assert.equal(deny(authorization({ maxMapsCalls: -1 })), 'INVALID_AUTHORIZATION');
  assert.equal(deny(authorization({ maxMapsCalls: 1.5 })), 'INVALID_AUTHORIZATION');
  assert.equal(deny({ ...authorization(), maxMapsCalls: '1' }), 'INVALID_AUTHORIZATION');
  assert.equal(deny(authorization({ expiresAt: 'amanhã' })), 'INVALID_AUTHORIZATION');
  assert.equal(deny(authorization({ costAcknowledged: false })), 'COST_NOT_ACKNOWLEDGED');
  assert.equal(deny({ ...authorization(), costAcknowledged: 'true' }), 'COST_NOT_ACKNOWLEDGED');
  assert.equal(deny(authorization({ expiresAt: '2026-10-21T12:30:00.000Z' })), 'EXPIRED', 'vence no próprio instante');
  assert.equal(deny(authorization({ expiresAt: '2026-10-21T12:00:00.000Z' })), 'EXPIRED');
  assert.equal(deny(authorization({ expiresAt: new Date(Date.parse(T_NOW) + MAX_AUTHORIZATION_WINDOW_MS + 1000).toISOString() })), 'INVALID_AUTHORIZATION', 'validade acima de 24 h');
  assert.equal(deny(authorization({ snapshotId: 'snap-outra-0002' })), 'WRONG_AUDIT');
  assert.equal(deny(authorization({ identifiersFingerprint: identifiersFingerprint({ cid: '1' }) })), 'WRONG_COMPANY');
  assert.equal(deny(authorization({ maxMapsCalls: 0 })), 'LIMIT_ABOVE_AUTHORIZED');
  assert.equal(deny(authorization({ maxSiteHttpRequests: 4 })), 'LIMIT_ABOVE_AUTHORIZED');
  assert.equal(deny(authorization(), context({ isUsed: (id) => id === 'auth-teste-0001' })), 'ALREADY_USED');
});

test('a impressão dos identificadores distingue empresas', () => {
  assert.notEqual(identifiersFingerprint({ cid: CID }), identifiersFingerprint({ cid: CID, featureId: FID }));
  assert.equal(identifiersFingerprint(IDS), identifiersFingerprint({ featureId: FID, cid: CID }));
});
