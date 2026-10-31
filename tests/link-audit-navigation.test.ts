import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import './helpers/stub-lucide';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardHeader } from '../src/components/dashboard/dashboard-header';
import { NAV_ITEMS } from '../src/components/dashboard/sidebar';
import { filterAudits } from '../src/components/link-audit/evidence-state';
import { StoredAuditList } from '../src/components/link-audit/stored-audit-list';
import type { AuditListItemDto } from '../src/lib/link-audit-evidence';

/* Onda 6C, I6 — navegação entre a listagem (Onda 5B) e a área operacional Lumos. Sem navegador: regras puras e renderização estática. */
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const item = (auditId: string, name: string | null = 'Padaria Exemplo'): AuditListItemDto =>
  ({ auditId, state: 'COMPLETE', companyName: name, city: 'Cidade Exemplo', stateCode: 'GO', confirmedCid: '123456789', collectedAt: '2026-10-22T12:54:48.079Z', sourceLabel: 'Serper (intermediário)', integrity: { status: 'OK' }, captureCount: 1, reportRevisions: 1 }) as unknown as AuditListItemDto;
const noop = (): void => undefined;
const list = (items: readonly AuditListItemDto[], selectedId: string | null = null): string =>
  renderToStaticMarkup(createElement(StoredAuditList, { phase: 'ready', items, total: items.length, message: null, query: '', selectedId, onQueryChange: noop, onSelect: noop, onRetry: noop }));

test('listagem: cada cartão tem o botão de seleção (5B) E um link contextual para a auditoria Lumos, só com o id codificado', () => {
  const html = list([item('auditoria-aaa-0001'), item('auditoria-bbb-0002', null)], 'auditoria-aaa-0001');
  assert.equal((html.match(/<a /g) ?? []).length, 2, 'um link por cartão');
  // WCAG 2.5.3 (rótulo no nome): o nome acessível CONTÉM o texto visível "Abrir auditoria Lumos"
  assert.match(html, /<a href="\/auditoria-por-link\/auditoria-aaa-0001" aria-label="Abrir auditoria Lumos de Padaria Exemplo"/);
  assert.match(html, /<a href="\/auditoria-por-link\/auditoria-bbb-0002" aria-label="Abrir auditoria Lumos de auditoria-bbb-0002"/);
  assert.equal((text(html).match(/Abrir auditoria Lumos/g) ?? []).length, 2);
  assert.equal((html.match(/<button/g) ?? []).length, 2, 'a seleção da 5B continua sendo botão');
  assert.match(html, /aria-current="true"/);
  assert.match(html, /min-h-11/, 'área de toque confortável');
  // botão e link são IRMÃOS no <li>: nenhum interativo aninhado em outro
  for (const li of html.match(/<li[^>]*>[\s\S]*?<\/li>/g) ?? []) {
    assert.equal((li.match(/<button/g) ?? []).length, 1);
    assert.equal((li.match(/<a /g) ?? []).length, 1);
    assert.ok(!/<button[^>]*>(?:(?!<\/button>)[\s\S])*<a /.test(li), 'link dentro do botão');
    assert.ok(!/<a [^>]*>(?:(?!<\/a>)[\s\S])*<button/.test(li), 'botão dentro do link');
    assert.ok(li.indexOf('<button') < li.indexOf('<a '), 'ordem de tabulação: seleção, depois o link');
  }
});

test('listagem: o cartão NÃO mostra resultado, nota, estado Lumos nem histórico (nada que pareça atual sem consulta); filtros e estados da 5B seguem iguais', () => {
  const t = text(list([item('auditoria-aaa-0001')]));
  assert.ok(!/inconclus|pontuad|índice|nota |cobertura|Histórico|desatualizad|definitiv|resultado/i.test(t), t);
  assert.match(t, /CID confirmado 123456789/);
  assert.match(t, /Serper \(intermediário\)/);
  assert.equal(filterAudits([item('auditoria-aaa-0001'), item('auditoria-bbb-0002', 'Outra Loja')], 'padaria').length, 1);
  const states = ['loading', 'error', 'unavailable'] as const;
  for (const phase of states) {
    const html = renderToStaticMarkup(createElement(StoredAuditList, { phase, items: [], total: 0, message: 'falha', query: '', selectedId: null, onQueryChange: noop, onSelect: noop, onRetry: noop }));
    assert.ok(!/auditoria-por-link\//.test(html), `${phase}: sem links sem lista`);
  }
  const empty = renderToStaticMarkup(createElement(StoredAuditList, { phase: 'ready', items: [], total: 0, message: null, query: '', selectedId: null, onQueryChange: noop, onSelect: noop, onRetry: noop }));
  assert.match(text(empty), /Nenhuma auditoria armazenada ainda/);
});

test('listagem e detalhe da 5B não chamam a prévia, as decisões nem os resultados (sem N chamadas para decorar cartões)', () => {
  const dir = path.join(__dirname, '..', 'src', 'components', 'link-audit');
  for (const name of ['evidence-api-client.ts', 'stored-audits-panel.tsx', 'stored-audit-list.tsx', 'stored-audit-detail.tsx', 'evidence-state.ts', 'link-audit-screen.tsx', 'api-client.ts']) {
    const code = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(!/\/api\/link-audit\/(scoring|decisions)/.test(code), `${name} não pode consultar prévia/decisões/resultados`);
  }
  for (const name of fs.readdirSync(path.join(dir, 'audit-page')).filter((file) => /\.tsx?$/.test(file))) {
    const code = fs.readFileSync(path.join(dir, 'audit-page', name), 'utf8');
    assert.ok(!/setInterval|requestAnimationFrame\([^)]*fetch|EventSource|WebSocket|BroadcastChannel/.test(code), `${name}: sem polling nem canais em tempo real`);
  }
});

test('menu: a Auditoria por Link aparece UMA vez, com rota própria; o botão de menu e o Sair têm área de toque de 44 px no celular', () => {
  assert.equal(NAV_ITEMS.filter((nav) => nav.href === '/auditoria-por-link').length, 1);
  assert.equal(NAV_ITEMS.filter((nav) => /Auditoria por Link/.test(nav.label)).length, 1);
  const header = renderToStaticMarkup(createElement(DashboardHeader, { sectionLabel: 'Auditoria por Link', onOpenMobileMenu: noop, onLogout: noop, hideSystemStatus: true }));
  assert.match(header, /aria-label="Abrir menu"[^>]*aria-expanded="false"/);
  assert.match(renderToStaticMarkup(createElement(DashboardHeader, { sectionLabel: 'x', onOpenMobileMenu: noop, mobileMenuOpen: true })), /aria-expanded="true"/);
  assert.match(header, /aria-label="Abrir menu"[^>]*class="[^"]*\bh-11 w-11\b/);
  assert.match(header, /<button[^>]*class="[^"]*\bmin-h-11 min-w-11\b[^"]*"[^>]*>[^]*?Sair/);
  const sidebar = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'dashboard', 'sidebar.tsx'), 'utf8');
  assert.match(sidebar, /aria-label="Fechar menu"[\s\S]{0,40}className="[^"]*\bh-11 w-11\b/);
});

test('menu móvel fechado não deixa itens focáveis nem lidos (invisible abaixo de lg); aberto, visível', () => {
  const sidebar = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'dashboard', 'sidebar.tsx'), 'utf8');
  assert.match(sidebar, /'-translate-x-full invisible lg:visible'/);
  assert.match(sidebar, /mobileOpen \? 'translate-x-0'/);
});

test('workspace: o retorno à listagem leva o auditId (empresa escolhida volta selecionada) e a âncora da seção', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'link-audit', 'audit-page', 'audit-detail-screen.tsx'), 'utf8');
  assert.match(code, /href=\{`\/auditoria-por-link\?auditId=\$\{encodeURIComponent\(auditId\)\}#auditorias-armazenadas`\}/);
});

test('menu móvel: o foco de volta mira o botão "Abrir menu" (o "Recolher menu" da barra também usa aria-controls e viria antes no DOM)', () => {
  const root = path.join(__dirname, '..', 'src', 'components', 'dashboard');
  const shell = fs.readFileSync(path.join(root, 'dashboard-shell.tsx'), 'utf8');
  assert.match(shell, /querySelector<HTMLElement>\('button\[aria-label="Abrir menu"\]'\)\?\.focus\(\)/);
  assert.match(shell, /querySelector<HTMLElement>\('#gmn-sidebar \[aria-label="Fechar menu"\]'\)\?\.focus\(\)/);
  assert.ok(!/querySelector<HTMLElement>\('\[aria-controls="gmn-sidebar"\]'\)/.test(shell), 'alvo ambíguo');
  const controls = ['dashboard-header.tsx', 'sidebar.tsx'].reduce((total, file) => total + (fs.readFileSync(path.join(root, file), 'utf8').match(/aria-controls="gmn-sidebar"/g) ?? []).length, 0);
  assert.equal(controls, 2, 'se isto mudar, reavalie o alvo do foco');
});

test('reflow a 320 px: as linhas rótulo/valor do workspace quebram e o valor não estoura a caixa', () => {
  for (const file of ['company-panel.tsx', 'side-panels.tsx', 'results-panel.tsx']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'link-audit', 'audit-page', file), 'utf8');
    assert.match(src, /flex flex-wrap items-baseline gap-x-2 gap-y-0\.5/, file);
    assert.match(src, /<dd className="min-w-0 break-words text-gmn-text">/, file);
  }
});

test('casca do dashboard: há exatamente um marco <main> com o conteúdo da página (e o menu e o cabeçalho ficam fora dele)', async () => {
  const { DashboardShell } = await import('../src/components/dashboard/dashboard-shell');
  const html = renderToStaticMarkup(createElement(DashboardShell, { activeRoute: '/auditoria-por-link', sectionLabel: 'Auditoria por Link', onLogout: noop, children: createElement('p', { id: 'conteudo-teste' }, 'conteúdo') }));
  assert.equal((html.match(/<main[\s>]/g) ?? []).length, 1);
  const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? '';
  assert.match(main, /id="conteudo-teste"/);
  assert.ok(!/<aside|<header/.test(main), 'menu e cabeçalho não ficam dentro do marco principal');
});

test('menu: o item da PÁGINA ATUAL é link de documento (<a>), não do roteador; o <nav> tem nome (há outro <nav> nas telas da auditoria)', () => {
  const sidebar = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'dashboard', 'sidebar.tsx'), 'utf8');
  assert.match(sidebar, /routeActive \? \(\s*<a href=\{item\.href\}[^>]*aria-current="page"/);
  assert.match(sidebar, /<Link href=\{item\.href\}/);
  assert.match(sidebar, /<nav aria-label="Menu principal"/);
});

test('rótulo no nome (WCAG 2.5.3): o botão de atualizar contém o texto visível nos dois estados; títulos sem salto de nível', () => {
  const screen = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'link-audit', 'audit-page', 'audit-detail-screen.tsx'), 'utf8');
  assert.match(screen, /cooling \? 'Atualizado: aguarde/);
  assert.match(screen, /'Atualizar prévia, decisões e resultados'/);
  assert.match(screen, /\{cooling \? 'Atualizado' : 'Atualizar'\}/);
  const gates = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'link-audit', 'audit-page', 'result-panel.tsx'), 'utf8');
  assert.ok(!/<h4/.test(gates) && /<h3[^>]*>Portões da metodologia<\/h3>/.test(gates), 'sob o <h2> da seção vem o <h3>');
});

