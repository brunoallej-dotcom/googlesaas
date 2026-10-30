import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { httpApi, isDecisionsList, isFinalizeSuccess, isPreview, isResultsList, isRunDetail } from '../src/components/link-audit/audit-page/api';
import { safeText } from '../src/components/link-audit/audit-page/labels';
import { AUDIT, decisionsFixture, detailResponse, finalizeSuccess, head, previewFixture, resultsFixture } from './helpers/link-audit-audit-page-fixtures';

/* Onda 6C, I5 — o cliente HTTP da página: corpos exatos, validação de formato, mapeamento de falhas e saneamento de texto. fetch é simulado. */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
interface Seen {
  url: string;
  init: RequestInit;
}
function stub(status: number, body: unknown, headers: Record<string, string> = {}): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as typeof fetch;
  return seen;
}

test('GET: mesma origem, sem cache, sem seguir redirecionamento, cookie da sessão; o auditId é codificado', async () => {
  const seen = stub(200, previewFixture());
  const out = await httpApi.preview('auditoria-ui-0001');
  assert.equal(out.kind, 'ok');
  assert.equal(seen[0]?.url, '/api/link-audit/scoring/auditoria-ui-0001');
  assert.deepEqual([seen[0]?.init.method, seen[0]?.init.cache, seen[0]?.init.redirect, seen[0]?.init.credentials], ['GET', 'no-store', 'error', 'same-origin']);
  assert.equal(seen[0]?.init.body, undefined);
  const odd = stub(200, resultsFixture());
  await httpApi.results('a/b?c');
  assert.equal(odd[0]?.url, '/api/link-audit/scoring/a%2Fb%3Fc/results');
});

test('os caminhos das cinco leituras e dos três envios', async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    urls.push(`${init.method} ${url}`);
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  await httpApi.evidence(AUDIT);
  await httpApi.preview(AUDIT);
  await httpApi.decisions(AUDIT);
  await httpApi.results(AUDIT);
  await httpApi.resultDetail(AUDIT, 3.9);
  await httpApi.decide(AUDIT, { kind: 'CREATE', body: { record: {}, expectedHead: null } });
  await httpApi.decide(AUDIT, { kind: 'REVOKE', body: { revokes: 'op-0001', reason: 'x'.repeat(20), expectedHead: null } });
  await httpApi.finalize(AUDIT, { expectedHead: null, expectedInputSha256: 'a'.repeat(64) });
  assert.deepEqual(urls, [
    `GET /api/link-audit/evidence/${AUDIT}`, `GET /api/link-audit/scoring/${AUDIT}`, `GET /api/link-audit/decisions/${AUDIT}`, `GET /api/link-audit/scoring/${AUDIT}/results`, `GET /api/link-audit/scoring/${AUDIT}/results/3`,
    `POST /api/link-audit/decisions/${AUDIT}`, `POST /api/link-audit/decisions/${AUDIT}/revocations`, `POST /api/link-audit/scoring/${AUDIT}/finalize`,
  ]);
});

test('finalização envia SOMENTE expectedHead e expectedInputSha256 (nunca pontuação, entrada, autor ou data), como JSON', async () => {
  const seen = stub(201, finalizeSuccess());
  const polluted = { expectedHead: head(2, 'b'), expectedInputSha256: 'c'.repeat(64), score: 100, finalizedBy: 'x@y.com', input: {} } as never;
  const out = await httpApi.finalize(AUDIT, polluted);
  assert.equal(out.kind, 'ok');
  assert.deepEqual(JSON.parse(seen[0]?.init.body as string), { expectedHead: head(2, 'b'), expectedInputSha256: 'c'.repeat(64) });
  assert.deepEqual(seen[0]?.init.headers, { 'Content-Type': 'application/json' });
  assert.equal(seen[0]?.init.method, 'POST');
});

test('401 ⇒ unauthorized; 403 ⇒ forbidden com a mensagem saneada; 429 ⇒ rate_limited (Retry-After válido, limitado a 1 h; ausente/inválido ⇒ 60 s estimados)', async () => {
  stub(401, { error: 'x', code: 'UNAUTHENTICATED' });
  assert.deepEqual(await httpApi.preview(AUDIT), { kind: 'unauthorized' });
  stub(403, { error: 'Acesso‮ negado.', code: 'CROSS_ORIGIN' });
  assert.deepEqual(await httpApi.finalize(AUDIT, { expectedHead: null, expectedInputSha256: 'a'.repeat(64) }), { kind: 'forbidden', message: 'Acesso negado.' });
  stub(429, { error: 'x', code: 'RATE_LIMITED' }, { 'retry-after': '17' });
  assert.deepEqual(await httpApi.preview(AUDIT), { kind: 'rate_limited', retryAfterSeconds: 17, fromHeader: true });
  stub(429, { error: 'x', code: 'RATE_LIMITED' }, { 'retry-after': '999999' });
  assert.deepEqual(await httpApi.preview(AUDIT), { kind: 'rate_limited', retryAfterSeconds: 3600, fromHeader: true });
  stub(429, { error: 'x' });
  assert.deepEqual(await httpApi.preview(AUDIT), { kind: 'rate_limited', retryAfterSeconds: 60, fromHeader: false });
});

test('falhas com código: status, código, mensagem, detalhes (máx. 10), head, bloqueios e pendente chegam; texto invisível/bidi é removido', async () => {
  const body = { error: 'Houve​ um ‮conflito.', code: 'HEAD_MISMATCH', issues: Array.from({ length: 30 }, (_, i) => `d${i}\u0007`), head: head(4, 'd'), blockers: [{ code: 'DECISION_PENDING', severity: 'BLOCKING', message: 'm', reasonCode: null, decisionIds: [], subcriterionIds: [] }], pending: { seq: 2, isMine: true, inputSha256: 'e'.repeat(64), decisionsHead: null } };
  stub(409, body, { 'retry-after': '5' });
  const out = await httpApi.finalize(AUDIT, { expectedHead: null, expectedInputSha256: 'a'.repeat(64) });
  assert.equal(out.kind, 'failure');
  if (out.kind !== 'failure') return;
  assert.deepEqual([out.status, out.code, out.message, out.issues.length, out.issues[0], out.head, out.retryAfterSeconds], [409, 'HEAD_MISMATCH', 'Houve um conflito.', 10, 'd0', head(4, 'd'), 5]);
  assert.equal(out.blockers?.[0]?.code, 'DECISION_PENDING');
  assert.equal(out.pending?.seq, 2);
  stub(409, { error: 'x', code: 'RESULT_PENDING_UNCONFIRMED', pending: { seq: 'não' } });
  const bad = await httpApi.finalize(AUDIT, { expectedHead: null, expectedInputSha256: 'a'.repeat(64) });
  assert.ok(bad.kind === 'failure' && bad.pending === null, 'pendente malformada vira null');
  stub(500, 'não é json');
  const noJson = await httpApi.preview(AUDIT);
  assert.ok(noJson.kind === 'failure' && noJson.code === 'UNKNOWN' && noJson.message.length > 0);
});

test('rede caindo ⇒ network; 200 com formato errado ⇒ malformed (nunca "ok" com dados inventados)', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('falhou');
  }) as typeof fetch;
  assert.deepEqual(await httpApi.results(AUDIT), { kind: 'network' });
  for (const [name, call, body] of [
    ['preview', () => httpApi.preview(AUDIT), { definitive: true }],
    ['decisions', () => httpApi.decisions(AUDIT), { auditId: AUDIT }],
    ['results', () => httpApi.results(AUDIT), { definitive: false, results: [] }],
    ['detail', () => httpApi.resultDetail(AUDIT, 1), { run: {} }],
    ['finalize', () => httpApi.finalize(AUDIT, { expectedHead: null, expectedInputSha256: 'a'.repeat(64) }), { definitive: true, anchored: false }],
    ['evidence', () => httpApi.evidence(AUDIT), { audit: { kind: 'OUTRA' } }],
    ['decide', () => httpApi.decide(AUDIT, { kind: 'CREATE', body: { record: {}, expectedHead: null } }), { anchored: false }],
  ] as const) {
    stub(200, body);
    assert.deepEqual(await call(), { kind: 'malformed' }, name);
  }
});

test('os validadores aceitam os payloads corretos e recusam formas parecidas', () => {
  assert.ok(isPreview(previewFixture()));
  assert.ok(!isPreview({ ...previewFixture(), definitive: true }));
  assert.ok(!isPreview({ ...previewFixture(), criteria: 'x' }));
  assert.ok(isDecisionsList(decisionsFixture()));
  assert.ok(!isDecisionsList({ ...decisionsFixture(), head: 'x' }));
  assert.ok(isResultsList(resultsFixture()));
  assert.ok(!isResultsList({ ...resultsFixture(), results: null }));
  assert.ok(isRunDetail(detailResponse()));
  assert.ok(!isRunDetail({ ...detailResponse(), superseded: 'não' }));
  assert.ok(isFinalizeSuccess(finalizeSuccess()));
  assert.ok(!isFinalizeSuccess({ ...finalizeSuccess(), replayed: undefined }));
});

test('safeText: remove controle, bidi e invisíveis, limita o tamanho e não transforma em HTML', () => {
  assert.equal(safeText('a\u0000b‮c​d e'), 'abcde');
  assert.equal(safeText('x'.repeat(1000), 10), 'xxxxxxxxxx');
  assert.equal(safeText(42), '');
  assert.equal(safeText('<script>alert(1)</script>'), '<script>alert(1)</script>', 'o texto é mantido literal: quem renderiza escapa');
});

/* ------------------------------------------------------------------------------------------------ Retry-After (429) */
import { DEFAULT_RATE_LIMIT_SECONDS, parseRetryAfter } from '../src/components/link-audit/audit-page/api';

test('Retry-After: segundos inteiros válidos (1 s a 1 h), data HTTP contra o Date DO SERVIDOR; o resto é inválido (null)', () => {
  const server = 'Fri, 30 Oct 2026 12:00:00 GMT';
  const cases: Array<[string | null | undefined, string | null, number | null]> = [
    ['17', null, 17], [' 17 ', null, 17], ['1', null, 1], ['0', null, 1], ['3600', null, 3600], ['99999', null, 3600], ['0000042', null, 42], ['123456789', null, 3600], ['99999999', null, 3600], ['123456789012345678901', null, 3600],
    ['Fri, 30 Oct 2026 12:00:45 GMT', server, 45], ['Fri, 30 Oct 2026 12:00:00 GMT', server, 1], ['Fri, 30 Oct 2026 11:00:00 GMT', server, 1], ['Fri, 30 Oct 2026 20:00:00 GMT', server, 3600],
    [null, null, null], [undefined, null, null], ['', null, null], ['   ', null, null],
    ['-5', null, null], ['12.5', null, null], ['1e3', null, null], ['abc', null, null], ['10 s', null, null], ['+7', null, null], ['0x10', null, null], ['1,2', null, null], ['10, 20', null, null], ['NaN', null, null], ['Infinity', null, null],
    ['Fri, 30 Oct 2026 12:00:45 GMT', null, null], ['Fri, 30 Oct 2026 12:00:45 GMT', 'lixo', null], ['Fri, 99 Oct 2026 12:00:45 GMT', server, null], ['amanhã', server, null], ['2026-10-30T12:00:45Z', server, null],
  ];
  for (const [header, date, expected] of cases) assert.equal(parseRetryAfter(header, date), expected, `${JSON.stringify(header)} / ${JSON.stringify(date)}`);
});

test('429 pelo cliente HTTP: cabeçalho válido, data HTTP, ausente e inválido; sempre rate_limited (nunca falha comum nem sucesso)', async () => {
  const body = { error: 'Muitas requisições.', code: 'RATE_LIMITED' };
  stub(429, body, { 'retry-after': '23' });
  assert.deepEqual(await httpApi.finalize(AUDIT, { expectedHead: null, expectedInputSha256: 'a'.repeat(64) }), { kind: 'rate_limited', retryAfterSeconds: 23, fromHeader: true });
  stub(429, body, { 'retry-after': 'Fri, 30 Oct 2026 12:01:00 GMT', date: 'Fri, 30 Oct 2026 12:00:00 GMT' });
  assert.deepEqual(await httpApi.finalize(AUDIT, { expectedHead: null, expectedInputSha256: 'a'.repeat(64) }), { kind: 'rate_limited', retryAfterSeconds: 60, fromHeader: true });
  for (const header of [undefined, '', 'abc', '-1', '1.5', '1e2']) {
    stub(429, body, header === undefined ? {} : { 'retry-after': header });
    assert.deepEqual(await httpApi.finalize(AUDIT, { expectedHead: null, expectedInputSha256: 'a'.repeat(64) }), { kind: 'rate_limited', retryAfterSeconds: DEFAULT_RATE_LIMIT_SECONDS, fromHeader: false }, String(header));
  }
  stub(429, 'não é json', { 'retry-after': '5' });
  assert.deepEqual(await httpApi.preview(AUDIT), { kind: 'rate_limited', retryAfterSeconds: 5, fromHeader: true });
});

test('corpo de falha: bloqueios malformados são descartados (não derrubam a tela); válidos chegam', async () => {
  stub(409, { error: 'x', code: 'NOT_FINALIZABLE', blockers: [{ code: 'X', severity: 'BLOCKING', message: 'm', reasonCode: null }] });
  const bad = await httpApi.finalize(AUDIT, { expectedHead: null, expectedInputSha256: 'a'.repeat(64) });
  assert.ok(bad.kind === 'failure' && bad.blockers === undefined);
  stub(409, { error: 'x', code: 'NOT_FINALIZABLE', blockers: [{ code: 'X', severity: 'BLOCKING', message: 'm', reasonCode: null, decisionIds: ['op-0001'], subcriterionIds: [] }] });
  const good = await httpApi.finalize(AUDIT, { expectedHead: null, expectedInputSha256: 'a'.repeat(64) });
  assert.ok(good.kind === 'failure' && good.blockers?.length === 1);
});
