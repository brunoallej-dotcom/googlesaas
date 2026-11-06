import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import './helpers/stub-lucide';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { syncAuditIdInUrl } from '../src/components/link-audit/audit-url';
import { AUDIT_ID_FORMAT, evidenceReducer, initialEvidenceState, planFromLocation, resolveAuditRequest, withAuditIdParam, type EvidenceUiState } from '../src/components/link-audit/evidence-state';
import { RequestedAuditNotice } from '../src/components/link-audit/requested-audit-notice';
import { AUDIT_ID_PATTERN, type AuditDetailDto, type AuditListItemDto } from '../src/lib/link-audit-evidence';

/*
 * Onda 6C, I6 (correção final) — o `?auditId=` do endereço e a empresa EXIBIDA nunca podem divergir em silêncio:
 *  - pedido que não se atende (fora da lista, formato inválido, repetido) ⇒ impedimento explícito, NENHUMA empresa substituta;
 *  - escolha do operador ⇒ o endereço passa a ser o da empresa exibida (replaceState); voltar/avançar reconcilia a exibição.
 */
const item = (auditId: string): AuditListItemDto => ({ auditId, companyName: `Empresa ${auditId}` }) as unknown as AuditListItemDto;
const ITEMS = [item('auditoria-aaa-0001'), item('auditoria-bbb-0002'), item('auditoria-ccc-0003')];
const NOTHING_SHOWN = { selectedId: null, issue: null } as const;
const detailOf = (auditId: string): AuditDetailDto => ({ auditId, companyName: `Detalhe de ${auditId}` }) as unknown as AuditDetailDto;

test('resolução do pedido: ausente, na lista, fora da lista, malformado, vazio e repetido', () => {
  assert.deepEqual(resolveAuditRequest(ITEMS, ''), { kind: 'none' });
  assert.deepEqual(resolveAuditRequest(ITEMS, '?x=1'), { kind: 'none' });
  assert.deepEqual(resolveAuditRequest(ITEMS, '?auditId=auditoria-bbb-0002'), { kind: 'listed', auditId: 'auditoria-bbb-0002' });
  assert.deepEqual(resolveAuditRequest(ITEMS, '?x=1&auditId=auditoria-ccc-0003'), { kind: 'listed', auditId: 'auditoria-ccc-0003' });
  assert.deepEqual(resolveAuditRequest(ITEMS, '?auditId=auditoria-zzz-9999'), { kind: 'missing', auditId: 'auditoria-zzz-9999' });
  assert.deepEqual(resolveAuditRequest([], '?auditId=auditoria-zzz-9999'), { kind: 'missing', auditId: 'auditoria-zzz-9999' }, 'lista vazia também não substitui');
  for (const bad of ['?auditId=', '?auditId=curto', '?auditId=../etc/passwd', '?auditId=%2e%2e%2f', '?auditId=AUDITORIA-MAIUSCULA', `?auditId=${'a'.repeat(65)}`, '?auditId=com espaço', '?auditId=a/b/c/d/e/f', '?auditId=auditoria-aaa-0001%00', '?auditId=<script>alert(1)</script>', '?auditId=auditoria-aaa-0001&auditId=auditoria-bbb-0002', '?auditId=auditoria-aaa-0001&auditId=']) {
    assert.deepEqual(resolveAuditRequest(ITEMS, bad), { kind: 'invalid' }, bad);
  }
  assert.deepEqual(resolveAuditRequest(ITEMS, '?auditid=auditoria-aaa-0001'), { kind: 'none' }, 'o nome do parâmetro diferencia maiúsculas: não é o pedido');
});

test('plano: sem pedido vale a primeira (5B); com pedido atendido escolhe a pedida; com pedido não atendido mostra o impedimento', () => {
  assert.deepEqual(planFromLocation(ITEMS, '', NOTHING_SHOWN), { do: 'select', auditId: 'auditoria-aaa-0001', fromUrl: false });
  assert.deepEqual(planFromLocation([], '', NOTHING_SHOWN), { do: 'nothing' });
  assert.deepEqual(planFromLocation(ITEMS, '', { selectedId: 'auditoria-aaa-0001', issue: null }), { do: 'nothing' }, 'já mostra a primeira');
  assert.deepEqual(planFromLocation(ITEMS, '?auditId=auditoria-bbb-0002', NOTHING_SHOWN), { do: 'select', auditId: 'auditoria-bbb-0002', fromUrl: true });
  assert.deepEqual(planFromLocation(ITEMS, '?auditId=auditoria-bbb-0002', { selectedId: 'auditoria-bbb-0002', issue: null }), { do: 'nothing' });
  assert.deepEqual(planFromLocation(ITEMS, '?auditId=auditoria-bbb-0002', { selectedId: 'auditoria-aaa-0001', issue: null }), { do: 'select', auditId: 'auditoria-bbb-0002', fromUrl: true }, 'voltar: a exibição acompanha o endereço');
  assert.deepEqual(planFromLocation(ITEMS, '?auditId=auditoria-bbb-0002', { selectedId: null, issue: { kind: 'missing', auditId: 'auditoria-bbb-0002' } }), { do: 'select', auditId: 'auditoria-bbb-0002', fromUrl: true }, 'a empresa apareceu na lista: atende o pedido');
  assert.deepEqual(planFromLocation(ITEMS, '?auditId=auditoria-zzz-9999', NOTHING_SHOWN), { do: 'issue', issue: { kind: 'missing', auditId: 'auditoria-zzz-9999' } });
  assert.deepEqual(planFromLocation(ITEMS, '?auditId=auditoria-zzz-9999', { selectedId: 'auditoria-aaa-0001', issue: null }), { do: 'issue', issue: { kind: 'missing', auditId: 'auditoria-zzz-9999' } }, 'limpa a empresa que estava exibida');
  assert.deepEqual(planFromLocation(ITEMS, '?auditId=auditoria-zzz-9999', { selectedId: null, issue: { kind: 'missing', auditId: 'auditoria-zzz-9999' } }), { do: 'nothing' });
  assert.deepEqual(planFromLocation(ITEMS, '?auditId=auditoria-yyy-8888', { selectedId: null, issue: { kind: 'missing', auditId: 'auditoria-zzz-9999' } }), { do: 'issue', issue: { kind: 'missing', auditId: 'auditoria-yyy-8888' } }, 'outro pedido ⇒ outro impedimento');
  assert.deepEqual(planFromLocation(ITEMS, '?auditId=lixo', NOTHING_SHOWN), { do: 'issue', issue: { kind: 'invalid' } });
  assert.deepEqual(planFromLocation([], '?auditId=lixo', NOTHING_SHOWN), { do: 'issue', issue: { kind: 'invalid' } });
});

test('invariante: com `?auditId=` no endereço, o plano NUNCA escolhe outra empresa que não a pedida', () => {
  const searches = ['?auditId=auditoria-zzz-9999', '?auditId=', '?auditId=lixo', '?auditId=auditoria-aaa-0001&auditId=auditoria-bbb-0002', '?auditId=auditoria-bbb-0002', '?x=1&auditId=auditoria-yyy-8888'];
  const shownStates = [NOTHING_SHOWN, { selectedId: 'auditoria-aaa-0001', issue: null }, { selectedId: null, issue: { kind: 'invalid' } as const }];
  for (const items of [ITEMS, [], [ITEMS[0] as AuditListItemDto]]) {
    for (const search of searches) {
      for (const shown of shownStates) {
        const plan = planFromLocation(items, search, shown);
        if (plan.do !== 'select') continue;
        const request = resolveAuditRequest(items, search);
        assert.equal(request.kind, 'listed', `${search}: só escolhe se a pedida está na lista`);
        assert.equal(plan.auditId, request.kind === 'listed' ? request.auditId : '', `${search}: escolheu outra empresa`);
      }
    }
  }
});

test('parâmetro do endereço: troca, remove e preserva os demais parâmetros', () => {
  assert.equal(withAuditIdParam('', 'auditoria-aaa-0001'), '?auditId=auditoria-aaa-0001');
  assert.equal(withAuditIdParam('?auditId=auditoria-aaa-0001', 'auditoria-bbb-0002'), '?auditId=auditoria-bbb-0002');
  assert.equal(withAuditIdParam('?x=1&auditId=auditoria-aaa-0001&y=2', 'auditoria-bbb-0002'), '?x=1&auditId=auditoria-bbb-0002&y=2');
  assert.equal(withAuditIdParam('?auditId=a&auditId=b', 'auditoria-bbb-0002'), '?auditId=auditoria-bbb-0002', 'repetidos viram um só');
  assert.equal(withAuditIdParam('?auditId=auditoria-aaa-0001', null), '');
  assert.equal(withAuditIdParam('?x=1&auditId=auditoria-aaa-0001', null), '?x=1');
  assert.equal(withAuditIdParam('', null), '');
});

test('endereço: a escolha troca a entrada atual do histórico (replaceState), preservando estado, fragmento e demais parâmetros', () => {
  const calls: Array<{ state: unknown; unused: string; url: string }> = [];
  const win = { location: { pathname: '/auditoria-por-link', search: '?x=1', hash: '#auditorias-armazenadas' }, history: { state: { __NA: true }, replaceState: (state: unknown, unused: string, url: string) => void calls.push({ state, unused, url }) } };
  const holder = globalThis as unknown as { window?: unknown };
  const previous = holder.window;
  holder.window = win;
  try {
    syncAuditIdInUrl('auditoria-bbb-0002');
    assert.deepEqual(calls, [{ state: { __NA: true }, unused: '', url: '/auditoria-por-link?x=1&auditId=auditoria-bbb-0002#auditorias-armazenadas' }]);
    win.location.search = '?x=1&auditId=auditoria-bbb-0002';
    syncAuditIdInUrl('auditoria-bbb-0002');
    assert.equal(calls.length, 1, 'já estava igual: não mexe no histórico');
    syncAuditIdInUrl(null);
    assert.equal(calls[1]?.url, '/auditoria-por-link?x=1#auditorias-armazenadas');
    win.location.search = '';
    win.location.hash = '';
    syncAuditIdInUrl(null);
    assert.equal(calls.length, 2, 'sem pedido e sem parâmetro: nada a fazer');
  } finally {
    if (previous === undefined) delete holder.window;
    else holder.window = previous;
  }
});

test('estado: o impedimento limpa a empresa e o detalhe; resposta atrasada de outra auditoria NÃO reaparece', () => {
  let state: EvidenceUiState = evidenceReducer(initialEvidenceState, { type: 'LIST_SUCCESS', items: ITEMS, total: 3 });
  state = evidenceReducer(state, { type: 'SELECT', auditId: 'auditoria-aaa-0001', request: 1 });
  state = evidenceReducer(state, { type: 'DETAIL_SUCCESS', request: 1, data: detailOf('auditoria-aaa-0001') });
  assert.equal(state.detail.data?.auditId, 'auditoria-aaa-0001');
  // o operador volta a um endereço que pede uma auditoria fora da lista, com uma consulta de outra empresa ainda em andamento
  state = evidenceReducer(state, { type: 'SELECT', auditId: 'auditoria-bbb-0002', request: 2 });
  state = evidenceReducer(state, { type: 'REQUEST_ISSUE', issue: { kind: 'missing', auditId: 'auditoria-zzz-9999' }, request: 3 });
  assert.equal(state.selectedId, null);
  assert.equal(state.detail.phase, 'idle');
  assert.equal(state.detail.data, null);
  assert.deepEqual(state.requestIssue, { kind: 'missing', auditId: 'auditoria-zzz-9999' });
  const late = evidenceReducer(state, { type: 'DETAIL_SUCCESS', request: 2, data: detailOf('auditoria-bbb-0002') });
  assert.equal(late.detail.data, null, 'a resposta atrasada de outra auditoria é ignorada');
  assert.equal(late.selectedId, null);
  const lateFailure = evidenceReducer(state, { type: 'DETAIL_FAILURE', request: 2, message: 'x' });
  assert.equal(lateFailure.detail.phase, 'idle');
  // dispensar o pedido não escolhe nada; escolher uma empresa e recarregar a lista limpam o impedimento
  const dismissed = evidenceReducer(state, { type: 'REQUEST_DISMISSED' });
  assert.equal(dismissed.requestIssue, null);
  assert.equal(dismissed.selectedId, null);
  assert.equal(evidenceReducer(state, { type: 'SELECT', auditId: 'auditoria-ccc-0003', request: 4 }).requestIssue, null);
  assert.equal(evidenceReducer(state, { type: 'LIST_START' }).requestIssue, null);
  assert.equal(evidenceReducer(state, { type: 'LIST_FAILURE', message: 'x' }).requestIssue, null);
});

test('aviso: mostra a identidade pedida, não escolhe substituta e oferece abrir a pedida ou dispensar (alvos de 44 px)', () => {
  const noop = (): void => undefined;
  const missing = renderToStaticMarkup(createElement(RequestedAuditNotice, { issue: { kind: 'missing', auditId: 'auditoria-zzz-9999' }, canChoose: true, onDismiss: noop }));
  assert.match(missing, /role="alert"/);
  assert.match(missing, /A auditoria pedida não está na lista carregada/);
  assert.match(missing, /<code[^>]*>auditoria-zzz-9999<\/code>/);
  assert.match(missing, /Nenhuma outra empresa foi selecionada no lugar dela/);
  assert.match(missing, /<a href="\/auditoria-por-link\/auditoria-zzz-9999"/);
  assert.match(missing, /Escolher outra empresa na lista/);
  assert.ok(!/Empresa auditoria-/.test(missing), 'sem dados de nenhuma empresa da lista');
  for (const control of missing.match(/<(?:a|button)[^>]*>/g) ?? []) assert.match(control, /min-h-11/, control);
  const empty = renderToStaticMarkup(createElement(RequestedAuditNotice, { issue: { kind: 'missing', auditId: 'auditoria-zzz-9999' }, canChoose: false, onDismiss: noop }));
  assert.match(empty, /Descartar o pedido/);
  assert.ok(!/Escolher outra empresa/.test(empty));
  const invalid = renderToStaticMarkup(createElement(RequestedAuditNotice, { issue: { kind: 'invalid' }, canChoose: true, onDismiss: noop }));
  assert.match(invalid, /identificador inválido/);
  assert.match(invalid, /Nenhuma empresa foi selecionada/);
  assert.ok(!/<a /.test(invalid), 'identificador inválido: não há o que abrir');
  assert.ok(!/href=/.test(invalid));
});

test('contêiner: o pedido do endereço nunca cai na primeira, o endereço acompanha a escolha e o histórico reconcilia a exibição', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'link-audit', 'stored-audits-panel.tsx'), 'utf8');
  assert.ok(!/items\[0\]|\.at\(0\)|pickInitialAudit|wantedAuditId/.test(src), 'nenhuma escolha de "primeira" fora do plano puro');
  assert.match(src, /planFromLocation\(items, window\.location\.search, shown\.current\)/);
  assert.match(src, /dispatch\(\{ type: 'REQUEST_ISSUE'/);
  assert.match(src, /addEventListener\('popstate'/);
  assert.match(src, /removeEventListener\('popstate'/);
  assert.match(src, /onSelect=\{\(auditId\) => \{[\s\S]*?syncAuditIdInUrl\(auditId\)[\s\S]*?select\(auditId\)/);
  assert.match(src, /syncAuditIdInUrl\(null\)/);
  assert.match(src, /<RequestedAuditNotice/);
  // nada de rede nova: continua só a lista e o detalhe da 5B
  assert.ok(!/scoring|decisions/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'a listagem não consulta prévia nem decisões');
});

test('estado: o detalhe entregue precisa ser o da empresa escolhida (falha fechada) e a regex do cliente é a do servidor', () => {
  let state: EvidenceUiState = evidenceReducer(initialEvidenceState, { type: 'LIST_SUCCESS', items: ITEMS, total: 3 });
  state = evidenceReducer(state, { type: 'SELECT', auditId: 'auditoria-aaa-0001', request: 1 });
  const wrong = evidenceReducer(state, { type: 'DETAIL_SUCCESS', request: 1, data: detailOf('auditoria-bbb-0002') });
  assert.equal(wrong.detail.data, null, 'dados de outra auditoria nunca ficam no estado');
  assert.equal(wrong.detail.phase, 'error');
  assert.match(wrong.detail.message ?? '', /não corresponde à auditoria escolhida/);
  assert.equal(evidenceReducer(state, { type: 'DETAIL_SUCCESS', request: 1, data: detailOf('auditoria-aaa-0001') }).detail.phase, 'ready');
  assert.equal(AUDIT_ID_FORMAT.source, AUDIT_ID_PATTERN.source, 'o cliente valida com a MESMA regex do servidor');
  assert.equal(AUDIT_ID_FORMAT.flags, AUDIT_ID_PATTERN.flags);
});

test('contêiner: dispensar não reabre a primeira por popstate; foco e estado exibido ficam coerentes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'link-audit', 'stored-audits-panel.tsx'), 'utf8');
  assert.match(src, /if \(!plan\.fromUrl && dismissed\.current\) return;/);
  assert.match(src, /dismissed\.current = true;\s*syncAuditIdInUrl\(null\)/);
  assert.match(src, /afterSelect\.current = plan\.fromUrl \? 'card' : null;/);
  assert.match(src, /shown\.current = \{ selectedId: plan\.auditId, issue: null \}/);
  assert.match(src, /state\.detail\.data\.auditId === state\.selectedId/);
  assert.match(src, /select\(state\.selectedId \?\? ''/);
  assert.match(src, /auditorias-armazenadas-title/, 'sem lista, o foco vai ao título da área');
});

