import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { isDetail, isListItem, requestAuditDetail, requestAuditList } from '../src/components/link-audit/evidence-api-client';
import { evidenceReducer, filterAudits, initialEvidenceState, type EvidenceUiState } from '../src/components/link-audit/evidence-state';
import { detailDto, listItem } from './helpers/link-audit-evidence-ui-fixtures';

test('estado inicial: lista carregando, nenhuma seleção, detalhe ocioso', () => {
  assert.equal(initialEvidenceState.list.phase, 'loading');
  assert.equal(initialEvidenceState.selectedId, null);
  assert.equal(initialEvidenceState.detail.phase, 'idle');
});

test('lista: sucesso, falha e indisponível; nunca mistura mensagens com dados antigos', () => {
  let s: EvidenceUiState = evidenceReducer(initialEvidenceState, { type: 'LIST_SUCCESS', items: [listItem()], total: 1 });
  assert.deepEqual([s.list.phase, s.list.total, s.list.items.length], ['ready', 1, 1]);
  s = evidenceReducer(s, { type: 'LIST_START' });
  assert.equal(s.list.phase, 'loading');
  s = evidenceReducer(s, { type: 'LIST_FAILURE', message: 'x' });
  assert.deepEqual([s.list.phase, s.list.items.length, s.list.message], ['error', 0, 'x']);
  s = evidenceReducer(s, { type: 'LIST_FAILURE', message: 'sem pasta', unavailable: true });
  assert.equal(s.list.phase, 'unavailable');
});

test('seleção: respostas atrasadas de um pedido antigo são ignoradas', () => {
  let s = evidenceReducer(initialEvidenceState, { type: 'SELECT', auditId: 'auditoria-a-0001', request: 1 });
  s = evidenceReducer(s, { type: 'SELECT', auditId: 'auditoria-b-0002', request: 2 });
  assert.equal(s.selectedId, 'auditoria-b-0002');
  const late = evidenceReducer(s, { type: 'DETAIL_SUCCESS', request: 1, data: detailDto({ auditId: 'auditoria-a-0001' }) });
  assert.equal(late, s, 'a resposta do pedido 1 não altera o estado');
  const lateFail = evidenceReducer(s, { type: 'DETAIL_FAILURE', request: 1, message: 'x' });
  assert.equal(lateFail, s);
  const fresh = evidenceReducer(s, { type: 'DETAIL_SUCCESS', request: 2, data: detailDto({ auditId: 'auditoria-b-0002' }) });
  assert.deepEqual([fresh.detail.phase, fresh.detail.data?.auditId], ['ready', 'auditoria-b-0002']);
});

test('trocar de empresa descarta o detalhe anterior; reabrir a mesma (versão) mantém o detalhe enquanto recarrega', () => {
  let s = evidenceReducer(initialEvidenceState, { type: 'SELECT', auditId: 'auditoria-a-0001', request: 1 });
  s = evidenceReducer(s, { type: 'DETAIL_SUCCESS', request: 1, data: detailDto({ auditId: 'auditoria-a-0001' }) });
  const other = evidenceReducer(s, { type: 'SELECT', auditId: 'auditoria-b-0002', request: 2 });
  assert.equal(other.detail.data, null);
  const sameCompany = evidenceReducer(s, { type: 'SELECT', auditId: 'auditoria-a-0001', request: 2, selection: { capture: 1, revision: 1 } });
  assert.equal(sameCompany.detail.phase, 'loading');
  assert.equal(sameCompany.detail.data?.auditId, 'auditoria-a-0001', 'sem piscar a tela ao trocar de versão');
  assert.deepEqual(sameCompany.selection, { capture: 1, revision: 1 });
  const failed = evidenceReducer(sameCompany, { type: 'DETAIL_FAILURE', request: 2, message: 'erro' });
  assert.deepEqual([failed.detail.phase, failed.detail.data], ['error', null]);
});

test('filtro local: sem acento, sem caixa, por empresa, cidade, UF e CID; consulta limitada a 120 caracteres', () => {
  const items = [
    listItem({ auditId: 'auditoria-a-0001', companyName: 'TUVAPLAST COMÉRCIO', city: 'Mogi Guaçu', stateCode: 'SP', confirmedCid: '4193491131727734142' }),
    listItem({ auditId: 'auditoria-b-0002', companyName: 'Padaria Exemplo', city: 'Goiânia', stateCode: 'GO', confirmedCid: null }),
  ];
  assert.equal(filterAudits(items, '').length, 2);
  assert.equal(filterAudits(items, '   ').length, 2);
  assert.deepEqual(filterAudits(items, 'tuvaplast comercio').map((i) => i.auditId), ['auditoria-a-0001']);
  assert.deepEqual(filterAudits(items, 'MOGI GUACU').map((i) => i.auditId), ['auditoria-a-0001']);
  assert.deepEqual(filterAudits(items, 'goiania').map((i) => i.auditId), ['auditoria-b-0002']);
  assert.deepEqual(filterAudits(items, '4193491').map((i) => i.auditId), ['auditoria-a-0001']);
  assert.deepEqual(filterAudits(items, ' sp ').map((i) => i.auditId), ['auditoria-a-0001']);
  assert.equal(filterAudits(items, 'inexistente').length, 0);
  const s = evidenceReducer(initialEvidenceState, { type: 'QUERY_CHANGED', query: 'x'.repeat(500) });
  assert.equal(s.query.length, 120);
});

test('validação de formato: lista e detalhe só são aceitos com a forma esperada', () => {
  assert.ok(isListItem(listItem()));
  assert.ok(isDetail(detailDto()));
  for (const bad of [null, undefined, 'x', 1, [], {}, { auditId: 1 }, { ...listItem(), integrity: null }]) assert.ok(!isListItem(bad), JSON.stringify(bad));
  for (const bad of [null, {}, { ...detailDto(), kind: 'OUTRA' }, { ...detailDto(), evidences: null }, { ...detailDto(), evidences: { verified: 1, unverified: [] } }, { ...detailDto(), integrity: undefined }, { ...detailDto(), limitations: 'x' }]) assert.ok(!isDetail(bad));
});

interface Call { url: string; init: RequestInit | undefined }
function mockFetch(handler: (url: string) => Response | Promise<Response> | Error): Call[] {
  const calls: Call[] = [];
  mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const result = await handler(String(input));
    if (result instanceof Error) throw result;
    return result;
  });
  return calls;
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('cliente: só GET na mesma origem, sem corpo, sem caminhos; id codificado; formato validado', async (t) => {
  t.after(() => mock.restoreAll());
  const calls = mockFetch((url) => (url.includes('?limit') ? json({ audits: [listItem()], total: 1 }) : json({ audit: detailDto() })));
  const list = await requestAuditList();
  assert.ok(list.kind === 'ok' && list.value.total === 1);
  const detail = await requestAuditDetail('auditoria-teste-0001', { capture: 1, revision: 2 });
  assert.ok(detail.kind === 'ok' && detail.value.auditId === 'auditoria-teste-0001');
  await requestAuditDetail('a/b?x=1#y'); // o identificador nunca vira caminho nem parâmetro: só é codificado
  assert.deepEqual(calls.map((c) => c.url), ['/api/link-audit/evidence?limit=50&offset=0', '/api/link-audit/evidence/auditoria-teste-0001?capture=1&revision=2', '/api/link-audit/evidence/a%2Fb%3Fx%3D1%23y']);
  for (const call of calls) {
    assert.equal(call.init?.method, 'GET');
    assert.equal(call.init?.body, undefined, 'GET sem corpo');
    assert.equal(call.init?.cache, 'no-store');
    assert.equal(call.init?.redirect, 'error');
    assert.equal(call.init?.credentials, 'same-origin');
    assert.ok(call.url.startsWith('/api/'), 'sempre o próprio servidor');
  }
});

test('cliente: 401 = não autorizado; 503 = indisponível com mensagem própria; 409/404/429/erros viram mensagens seguras', async (t) => {
  t.after(() => mock.restoreAll());
  const cases: Array<[Response | Error, string, RegExp | null]> = [
    [json({ code: 'NO_SESSION' }, 401), 'unauthorized', null],
    [json({ code: 'EVIDENCE_NOT_CONFIGURED', error: 'x' }, 503), 'unavailable', /não foi configurado/],
    [json({ code: 'EVIDENCE_STORAGE_UNAVAILABLE' }, 503), 'unavailable', /não está acessível/],
    [json({ code: 'INTERNAL_ERROR', error: '/mnt/d/segredo' }, 503), 'error', /Não foi possível concluir/],
    [json({ code: 'INTEGRITY_FAILED' }, 409), 'error', /integridade.*não são exibidos/],
    [json({ code: 'AUDIT_INCOMPLETE' }, 409), 'error', /incompleta/],
    [json({ code: 'NOT_FOUND' }, 404), 'error', /não foi encontrada/],
    [json({ code: 'FORBIDDEN' }, 403), 'error', /Acesso negado/],
    [json({ code: 'RATE_LIMITED' }, 429), 'error', /Muitas consultas/],
    [new Response('<html>', { status: 500 }), 'error', /Não foi possível concluir/],
    [new Error('rede caiu'), 'error', /conectar ao servidor/],
    [json({ audits: 'x', total: 1 }), 'error', /inesperada/],
    [json({ audits: [{ nada: 1 }], total: 1 }), 'error', /inesperada/],
  ];
  for (const [reply, kind, message] of cases) {
    mock.restoreAll();
    mockFetch(() => (reply instanceof Response ? reply.clone() : reply));
    const outcome = await requestAuditList();
    assert.equal(outcome.kind, kind, String(reply instanceof Response ? reply.status : reply.message));
    if (message && (outcome.kind === 'error' || outcome.kind === 'unavailable')) assert.match(outcome.message, message);
    if (outcome.kind === 'error' || outcome.kind === 'unavailable') assert.ok(!/\/mnt\/|segredo/.test(outcome.message), 'a mensagem do servidor nunca é repassada');
  }
});
