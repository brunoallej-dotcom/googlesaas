import assert from 'node:assert/strict';
import test from 'node:test';
import { assessSiteAccess, LEGACY_RESTRICTED_MESSAGE, type SiteAccessSignals, type SiteCheckOutcome } from '../src/lib/link-audit/collector/site-access';
import { collectEvidence } from '../src/lib/link-audit/collector/collect';
import { createSiteProvider } from '../src/lib/link-audit-runtime/site-provider';
import { NAMED, PLACE, T_NOW, T_SITE, clock, mapsFake, publicResolver } from './helpers/link-audit-collect-fixtures';

const base = (over: Partial<SiteCheckOutcome>): SiteCheckOutcome => ({
  requestedUrl: 'https://www.padaria-exemplo.example/', finalUrl: null, status: 'OK', httpStatus: null, redirects: [], checkedAt: T_SITE, title: null,
  noindex: null, robotsTxt: 'UNKNOWN', localBusiness: null, telLinks: [], whatsappLinks: [], emailLinks: [], failureReason: null, ...over,
});
const signals = (over: Partial<SiteAccessSignals> = {}): SiteAccessSignals => ({ requests: 1, authChallenge: false, loginPathBlocked: false, requestLimitReached: false, ...over });

test('cada situação do site recebe a classe que a evidência sustenta', () => {
  const cls = (r: SiteCheckOutcome) => assessSiteAccess(r).class;
  assert.equal(cls(base({ status: 'OK', httpStatus: 200 })), 'REACHABLE');
  assert.equal(cls(base({ status: 'SKIPPED' })), 'NOT_ATTEMPTED');
  assert.equal(cls(base({ status: 'NOT_HTML', httpStatus: 200 })), 'NOT_HTML');
  assert.equal(cls(base({ status: 'UNREACHABLE', failureReason: 'getaddrinfo ENOTFOUND' })), 'UNREACHABLE');
  assert.equal(cls(base({ status: 'HTTP_ERROR', httpStatus: 401, access: signals({ authChallenge: false }) })), 'HTTP_401');
  assert.equal(cls(base({ status: 'HTTP_ERROR', httpStatus: 401, access: signals({ authChallenge: true }) })), 'AUTH_REQUIRED_EVIDENCED');
  assert.equal(cls(base({ status: 'HTTP_ERROR', httpStatus: 403, access: signals() })), 'HTTP_403');
  assert.equal(cls(base({ status: 'HTTP_ERROR', httpStatus: 403, access: signals({ authChallenge: true }) })), 'HTTP_403', '403 nunca vira "exige autenticação"');
  assert.equal(cls(base({ status: 'HTTP_ERROR', httpStatus: 500 })), 'HTTP_OTHER');
  assert.equal(cls(base({ status: 'BLOCKED', failureReason: 'Consulta bloqueada por segurança: x', access: signals({ loginPathBlocked: true }) })), 'LOGIN_PATH_BLOCKED');
  assert.equal(cls(base({ status: 'BLOCKED', failureReason: 'x', access: signals({ requestLimitReached: true }) })), 'REQUEST_LIMIT');
  assert.equal(cls(base({ status: 'BLOCKED', failureReason: 'Consulta bloqueada por segurança: Endereço privado' })), 'BLOCKED_BY_SAFETY');
  assert.equal(cls(base({ status: 'BLOCKED', failureReason: `Consulta bloqueada por segurança: ${LEGACY_RESTRICTED_MESSAGE}.` })), 'RESTRICTED_RESPONSE_UNSPECIFIED');
});

test('só 401 com desafio de autenticação afirma que a autenticação é exigida; nenhuma outra nota diz "exige login"', () => {
  for (const r of [
    base({ status: 'HTTP_ERROR', httpStatus: 401, access: signals() }),
    base({ status: 'HTTP_ERROR', httpStatus: 403, access: signals({ authChallenge: true }) }),
    base({ status: 'HTTP_ERROR', httpStatus: 500 }),
    base({ status: 'BLOCKED', failureReason: LEGACY_RESTRICTED_MESSAGE }),
    base({ status: 'UNREACHABLE' }),
  ]) {
    assert.doesNotMatch(assessSiteAccess(r).note, /(?<!não )(?<!prova que o site )exige (?:a )?(?:login|autentica)/i, assessSiteAccess(r).note);
  }
  assert.match(assessSiteAccess(base({ status: 'HTTP_ERROR', httpStatus: 403, access: signals() })).note, /não prova que o site exija login/);
  assert.match(assessSiteAccess(base({ status: 'HTTP_ERROR', httpStatus: 401, access: signals({ authChallenge: true }) })).note, /exige autenticação/);
});

test('integração: o provedor real do site com respostas 401/403/timeout vira evidência NOT_VERIFIED com a classe certa', async () => {
  const cases: Array<[string, () => { statusCode: number; headers: Record<string, string>; body: string } | Error, RegExp]> = [
    ['403', () => ({ statusCode: 403, headers: {}, body: '' }), /HTTP_403.*não prova que o site exija login/s],
    ['401 sem desafio', () => ({ statusCode: 401, headers: {}, body: '' }), /HTTP_401.*não há evidência suficiente/s],
    ['401 com desafio', () => ({ statusCode: 401, headers: { 'www-authenticate': 'Basic realm="x"' }, body: '' }), /AUTH_REQUIRED_EVIDENCED/],
    ['500', () => ({ statusCode: 500, headers: {}, body: '' }), /HTTP_OTHER/],
    ['conexão', () => new Error('ECONNREFUSED'), /UNREACHABLE/],
  ];
  for (const [label, reply, expected] of cases) {
    const provider = createSiteProvider({
      resolver: publicResolver,
      now: () => new Date(T_SITE),
      transport: async () => {
        const r = reply();
        if (r instanceof Error) throw r;
        return r;
      },
    });
    const outcome = await collectEvidence(NAMED(), { maps: mapsFake([PLACE]), site: provider }, { budget: { maps: 1, reviews: 0, site: 1 }, now: clock });
    assert.ok(outcome.ok, label);
    const evidence = outcome.result.evidences.find((e) => e.id === 'site-reachable');
    assert.equal(evidence?.status, 'NOT_VERIFIED', label);
    assert.match(evidence?.limitation ?? '', expected, label);
    assert.equal(outcome.result.siteObservation?.httpRequests !== null, true);
    assert.ok(outcome.result.siteObservation?.accessClass, label);
    void T_NOW;
  }
});
