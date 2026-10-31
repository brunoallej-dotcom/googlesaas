import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/stub-lucide';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardHeader } from '../src/components/dashboard/dashboard-header';
import { DashboardShell } from '../src/components/dashboard/dashboard-shell';
import { NAV_ITEMS, Sidebar } from '../src/components/dashboard/sidebar';
import { AuditWorkspace } from '../src/components/link-audit/audit-workspace';
import { IdentityConfirmPanel } from '../src/components/link-audit/identity-confirm-panel';
import { LinkAuditScreen } from '../src/components/link-audit/link-audit-screen';
import { LinkEntryPanel } from '../src/components/link-audit/link-entry-panel';
import { CODE_MESSAGES, displayText, STATUS_VIEW } from '../src/components/link-audit/messages';
import { ParseResultPanel } from '../src/components/link-audit/parse-result-panel';
import { EMPTY_DETAILS, initialLinkAuditState, type LinkAuditUiState } from '../src/components/link-audit/state';
import type { CompanyIdentity } from '../src/lib/link-audit/audit';
import { parseGoogleMapsLink, type MapsLinkParseResult } from '../src/lib/link-audit/maps-link';
import LinkAuditPage, { metadata } from '../src/app/auditoria-por-link/page';

/* Links e identificadores FICTÍCIOS. */
const FID = '0x935ef1a2b3c4d5e6:0x1234567890abcdef';
const LINKS = {
  IDENTIFIED: `https://www.google.com/maps/place/Padaria+Exemplo/data=!1s${FID}`,
  RESOLUTION_PENDING: 'https://maps.app.goo.gl/AbCd1234',
  AMBIGUOUS: 'https://www.google.com/maps/place/Padaria+Exemplo/@-16.6869,-49.2648,17z',
  UNSUPPORTED: 'https://example.com/maps?cid=1',
  INVALID: 'Padaria Exemplo Goiânia',
  REJECTED: 'https://usuario:SEGREDO9@www.google.com/maps?cid=1',
} as const;

const text = (html: string): string =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const resultOf = (link: string): MapsLinkParseResult => parseGoogleMapsLink(link);
const panel = (result: MapsLinkParseResult | null, loading = false): string =>
  renderToStaticMarkup(createElement(ParseResultPanel, { result, loading }));

const noop = (): void => undefined;
const IDENTITY: CompanyIdentity = {
  originalLink: LINKS.IDENTIFIED,
  identifiers: { featureId: FID },
  name: '<script>alert(1)</script> Padaria',
  city: 'Cidade Exemplo',
  stateCode: 'GO',
  confirmation: { confirmedBy: 'ana@empresa.com', confirmedAt: '2026-10-20T15:00:00.000Z' },
};

test('os seis estados do parser aparecem com rótulo e mensagem em português', () => {
  const expected: Record<keyof typeof LINKS, RegExp> = {
    IDENTIFIED: /Identificado/,
    RESOLUTION_PENDING: /Resolução pendente/,
    AMBIGUOUS: /Ambíguo/,
    UNSUPPORTED: /Não suportado/,
    INVALID: /Inválido/,
    REJECTED: /Rejeitado/,
  };
  for (const [status, link] of Object.entries(LINKS) as Array<[keyof typeof LINKS, string]>) {
    const result = resultOf(link);
    assert.equal(result.status, status, link);
    const content = text(panel(result));
    assert.match(content, expected[status], status);
    assert.match(content, new RegExp(STATUS_VIEW[status].summary.slice(0, 25)), status);
    if (result.code !== 'IDENTIFIED') assert.ok(content.includes(CODE_MESSAGES[result.code].slice(0, 30)), `${status}: mensagem do código`);
    assert.match(content, /Nada foi consultado no Google/);
  }
});

test('todo código que o parser pode devolver tem mensagem em português', () => {
  const samples = [
    ...Object.values(LINKS),
    'https://www.google.com/maps/@-16.68,-49.26,15z', 'https://www.google.com/maps/search/padaria', 'https://www.google.com/maps',
    'https://www.google.com/maps?cid=1&cid=2', 'https://www.google.com/maps/dir/a/b', 'https://www.google.com/', 'https://goo.gl/abc1234',
    '', 'x'.repeat(3000), 'https://www.google.com/maps?cid=%ZZ', 'padaria', 'https:www.google.com/maps?cid=1', 'https://', 'https://www.google.com/maps?cid=abc',
    'https://evil.com\\@www.google.com/maps?cid=1', 'http://www.google.com/maps?cid=1', 'javascript:alert(1)', 'https://localhost/x',
    'https://142.250.1.1/maps?cid=1', 'https://www.ɡoogle.com/maps?cid=1', null,
  ];
  const codes = new Set(samples.map((sample) => parseGoogleMapsLink(sample).code));
  assert.ok(codes.size >= 20, `amostra cobre ${codes.size} códigos`);
  for (const code of codes) assert.ok((CODE_MESSAGES[code] ?? '').length > 10, code);
  for (const [code, message] of Object.entries(CODE_MESSAGES)) {
    assert.ok(message.length > 10, code);
    assert.doesNotMatch(message, /\b(invalid|unsupported|the link)\b/i, `${code} deve estar em português`);
  }
});

test('identificado: mostra identificadores e o link como TEXTO (nunca como link clicável)', () => {
  const html = panel(resultOf(LINKS.IDENTIFIED));
  const content = text(html);
  assert.match(content, /Feature ID \(fid\)/);
  assert.ok(content.includes(FID));
  assert.ok(content.includes(LINKS.IDENTIFIED));
  assert.match(content, /Nome que aparece no link/);
  assert.match(content, /Não verificado: o nome vem do próprio texto do link/);
  assert.doesNotMatch(html, /<a[\s>]/, 'nada de âncoras: sem redirecionamento a partir do link informado');
  assert.doesNotMatch(html, /href=/);
});

test('link curto fica com resolução pendente e explica que nada foi acessado', () => {
  const content = text(panel(resultOf(LINKS.RESOLUTION_PENDING)));
  assert.match(content, /Resolução pendente/);
  assert.match(content, /nenhum mecanismo autorizado de resolução existe nesta etapa/);
  assert.match(content, /maps\.app\.goo\.gl/);
  assert.doesNotMatch(content, /Identificador:/);
});

test('rejeitado nunca repete credenciais; vazio e carregando têm estados próprios', () => {
  assert.doesNotMatch(panel(resultOf(LINKS.REJECTED)), /SEGREDO9|usuario/);
  assert.match(text(panel(null)), /Nenhum link analisado ainda/);
  assert.match(text(panel(null, true)), /Analisando o link/);
});

test('o nome que vem do link é escapado (nada de HTML ou script na página)', () => {
  const html = panel(resultOf(`https://www.google.com/maps/place/%3Cimg+src%3Dx+onerror%3Dalert(1)%3E/data=!1s${FID}`));
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/i);
});

test('entrada do link: botões, carregamento, erro e acessibilidade', () => {
  const render = (props: Partial<Parameters<typeof LinkEntryPanel>[0]>): string =>
    renderToStaticMarkup(
      createElement(LinkEntryPanel, {
        link: '', loading: false, error: null, canValidate: false, canClear: false,
        onLinkChange: noop, onSubmit: noop, onClear: noop, ...props,
      }),
    );
  const empty = render({});
  assert.match(text(empty), /Validar link/);
  assert.match(empty.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '', /\sdisabled=""/);
  assert.match(empty, /for="link-audit-input"|htmlFor/);
  assert.match(empty, /id="link-audit-input"/);
  assert.match(empty, /autoComplete="off"|autocomplete="off"/);

  const ready = render({ link: LINKS.IDENTIFIED, canValidate: true, canClear: true });
  assert.doesNotMatch(ready.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '', /\sdisabled=""/);

  const loading = render({ link: LINKS.IDENTIFIED, loading: true, canValidate: false });
  assert.match(text(loading), /Analisando…/);

  const failed = render({ link: 'x', error: 'Não foi possível conectar ao servidor.' });
  assert.match(failed, /role="alert"/);
  assert.match(text(failed), /Não foi possível conectar ao servidor\./);
  assert.match(failed, /aria-invalid="true"/);
});

test('confirmação: só aparece o formulário com link identificado e exige a caixa', () => {
  const render = (result: MapsLinkParseResult | null, over: Partial<LinkAuditUiState> = {}, canConfirm = false): string =>
    renderToStaticMarkup(
      createElement(IdentityConfirmPanel, {
        result, details: over.details ?? EMPTY_DETAILS, confirmation: over.confirmation ?? initialLinkAuditState.confirmation,
        canConfirm, onDetailsChange: noop, onConfirm: noop, onUndo: noop,
      }),
    );
  for (const link of [LINKS.RESOLUTION_PENDING, LINKS.AMBIGUOUS, LINKS.UNSUPPORTED, LINKS.INVALID, LINKS.REJECTED]) {
    const html = render(resultOf(link));
    assert.doesNotMatch(html, /<form/, link);
    assert.match(text(html), /Nenhum nome, endereço ou categoria é inventado/);
  }
  assert.doesNotMatch(render(null), /<form/);

  const identified = render(resultOf(LINKS.IDENTIFIED));
  assert.match(identified, /<form/);
  assert.match(identified, /type="checkbox"/);
  assert.doesNotMatch(identified, /checked=""/);
  assert.match(identified.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '', /\sdisabled=""/, 'sem a caixa, o botão fica desabilitado');
  assert.match(text(identified), /informados por você/);
  assert.match(text(identified), /não são evidência do Google/);
  assert.match(text(identified), /Confirmo que o identificador detectado no link corresponde à empresa/);

  const enabled = render(resultOf(LINKS.IDENTIFIED), { details: { ...EMPTY_DETAILS, acknowledged: true } }, true);
  assert.match(enabled, /checked=""/);
  assert.doesNotMatch(enabled.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '', /\sdisabled=""/);
});

test('identidade confirmada: operador, hora, apenas nesta sessão, dados do operador rotulados e escapados', () => {
  const html = renderToStaticMarkup(
    createElement(IdentityConfirmPanel, {
      result: resultOf(LINKS.IDENTIFIED),
      details: { ...EMPTY_DETAILS, acknowledged: true },
      confirmation: { phase: 'done', identity: IDENTITY, error: null },
      canConfirm: false, onDetailsChange: noop, onConfirm: noop, onUndo: noop,
    }),
  );
  const content = text(html);
  assert.match(content, /Identidade confirmada/);
  assert.match(content, /ana@empresa\.com/);
  assert.match(content, /20\/10\/2026/);
  assert.match(content, /Apenas nesta sessão: nada foi salvo/);
  assert.match(content, /Nome \(informado por você\)/);
  assert.match(content, /Cidade \(informado por você\)/);
  assert.match(content, /não são evidência verificada pelo Google/);
  assert.match(content, /Desfazer confirmação/);
  assert.doesNotMatch(html, /<script/i, 'o nome digitado é escapado');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<form/, 'depois de confirmar não há como confirmar de novo');
});

test('área da auditoria: estados vazios honestos, sem dados inventados e sem botão de gerar', () => {
  const html = renderToStaticMarkup(createElement(AuditWorkspace, { identity: null }));
  const content = text(html);
  for (const title of [
    'Identificação da empresa', 'Evidências verificadas', 'Evidências não verificadas', 'Diagnóstico', 'Concorrentes',
    'Recomendações', 'Histórico', 'Relatório PDF', 'Critérios da metodologia',
  ]) {
    assert.ok(content.includes(title), title);
  }
  for (const label of ['Dados essenciais e consistência NAP', 'Autoridade local e competitividade']) assert.ok(content.includes(label), label);
  assert.match(content, /Avaliação na auditoria Lumos/);
  assert.match(content, /Auditoria Lumos/);
  assert.match(content, /Para avaliar uma empresa, escolha-a em Auditorias armazenadas e abra a auditoria Lumos/);
  assert.match(html, /<a href="#auditorias-armazenadas"/, 'o único link do espaço antigo é a âncora interna');
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.match(content, /Não implementado nesta etapa/);
  assert.match(content, /Aguardando um link identificado e a sua confirmação/);
  assert.match(content, /Nenhum snapshot é salvo nesta etapa/);
  assert.match(content, /Limites desta etapa/);
  assert.match(content, /Nada é salvo/);
  assert.match(content, /\/mnt\/d/);
  assert.doesNotMatch(html, /<button/, 'nenhum botão que simule geração de auditoria');
  assert.doesNotMatch(content, /Gerar (auditoria|relatório)|Iniciar auditoria|Baixar PDF/i);
  assert.doesNotMatch(content, /\b\d+\s*\/\s*100\b|nota geral|índice lumos:\s*\d|classificação:/i, 'sem pontuação nem classificação');

  const confirmed = text(renderToStaticMarkup(createElement(AuditWorkspace, { identity: IDENTITY })));
  assert.match(confirmed, /Identidade confirmada nesta sessão/);
  assert.doesNotMatch(confirmed, /Padaria|Cidade Exemplo/, 'a área não repete dados digitados como se fossem coletados');
});

test('menu: item novo para /auditoria-por-link; itens existentes e a âncora #auditoria ficam como antes', () => {
  assert.deepEqual(
    NAV_ITEMS.map(({ id, label, sectionId, href }) => ({ id, label, sectionId, href })),
    [
      { id: 'overview', label: 'Visão Geral', sectionId: 'visao-geral', href: undefined },
      { id: 'audits', label: 'Auditorias', sectionId: 'auditoria', href: undefined },
      { id: 'link-audit', label: 'Auditoria por Link', sectionId: undefined, href: '/auditoria-por-link' },
      { id: 'leads', label: 'Leads de Fronteira', sectionId: 'leads', href: undefined },
      { id: 'reports', label: 'Relatórios PDF', sectionId: 'relatorios', href: undefined },
      { id: 'rivals', label: 'Concorrentes', sectionId: 'concorrentes', href: undefined },
      { id: 'history', label: 'Histórico', sectionId: undefined, href: undefined },
      { id: 'settings', label: 'Configurações', sectionId: undefined, href: undefined },
    ],
  );

  const dashboard = renderToStaticMarkup(
    createElement(Sidebar, { collapsed: false, mobileOpen: false, activeSectionId: 'auditoria', onToggleCollapsed: noop, onCloseMobile: noop }),
  );
  assert.match(dashboard, /href="#auditoria"/, 'a aba Auditorias continua sendo a âncora do dashboard');
  assert.match(dashboard, /href="#visao-geral"/);
  assert.match(dashboard, /href="\/auditoria-por-link"/);
  assert.match(dashboard, /Auditoria por Link/);
  assert.equal((dashboard.match(/aria-current="location"/g) ?? []).length, 1, 'uma única seção ativa no dashboard');
  assert.doesNotMatch(dashboard, /aria-current="page"/);
  assert.doesNotMatch(dashboard, /href="\/#/, 'no dashboard as âncoras não ganham prefixo');
});

test('menu fora do dashboard: âncoras apontam para o dashboard e o item novo fica ativo', () => {
  const html = renderToStaticMarkup(
    createElement(Sidebar, {
      collapsed: false, mobileOpen: false, activeSectionId: '', activeRoute: '/auditoria-por-link',
      onToggleCollapsed: noop, onCloseMobile: noop,
    }),
  );
  assert.match(html, /href="\/#auditoria"/);
  assert.match(html, /href="\/#leads"/);
  assert.doesNotMatch(html, /href="#/);
  assert.doesNotMatch(html, /aria-current="location"/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(html, /aria-current="page"[^>]*>|<a[^>]*href="\/auditoria-por-link"[^>]*aria-current="page"/);
});

test('cabeçalho e shell: rótulo da seção, sem seção do dashboard marcada na tela nova, e dashboard inalterado', () => {
  const screen = renderToStaticMarkup(
    createElement(DashboardShell, {
      activeRoute: '/auditoria-por-link', sectionLabel: 'Auditoria por Link', hideSystemStatus: true, onLogout: noop,
      children: createElement('p', null, 'conteúdo'),
    }),
  );
  assert.match(text(screen), /Seção: Auditoria por Link/);
  assert.doesNotMatch(screen, /aria-current="location"/);
  assert.match(text(screen), /Sair/);

  const dashboard = renderToStaticMarkup(createElement(DashboardShell, { onLogout: noop, children: createElement('p', null, 'conteúdo') }));
  assert.match(text(dashboard), /Seção: Visão Geral/);
  assert.match(dashboard, /aria-current="location"/);
  assert.match(dashboard, /href="#auditoria"/);

  const header = renderToStaticMarkup(createElement(DashboardHeader, { sectionLabel: 'X', onOpenMobileMenu: noop, onLogout: noop, hideSystemStatus: true }));
  assert.match(text(header), /Seção: X/);
});

test('tela completa e página da rota', () => {
  assert.match(String(metadata.title), /Auditoria por Link/);
  const html = renderToStaticMarkup(createElement(LinkAuditPage));
  const content = text(html);
  assert.match(content, /Link do perfil/);
  assert.match(content, /Validar link/);
  assert.match(content, /Resultado da análise/);
  assert.match(content, /Confirmação da empresa/);
  assert.match(content, /Área da auditoria/);
  assert.match(content, /Seção: Auditoria por Link/);
  assert.match(html, /href="\/#auditoria"/);
  assert.equal(renderToStaticMarkup(createElement(LinkAuditScreen)), html, 'a página é só a tela');
  assert.doesNotMatch(html, /<a[^>]*href="https?:/, 'nenhum link externo na tela');
});

test('responsividade: grades colapsam em uma coluna no celular e não há largura fixa que cause rolagem horizontal', () => {
  const html = renderToStaticMarkup(createElement(LinkAuditScreen));
  assert.match(html, /grid gap-5 xl:grid-cols-2/);
  assert.match(html, /md:grid-cols-2 xl:grid-cols-3/);
  assert.match(html, /flex-col gap-2 sm:flex-row/);
  assert.match(panel(resultOf(LINKS.IDENTIFIED)), /break-all/, 'links e ids longos quebram linha em vez de estourar a largura');
  assert.doesNotMatch(html, /[\s"](?:min-)?w-\[\d{3,}px\]/, 'sem largura fixa grande (max-w do shell é aceitável)');
});

test('texto exibido nunca carrega caracteres de controle ou de direção (bidi) vindos do link ou do operador', () => {
  assert.equal(displayText('A\u202Eevil\u0000\u0007\u200B'), 'Aevil');
  const hint = text(panel(resultOf(`https://www.google.com/maps/place/A%E2%80%AEB/data=!1s${FID}`)));
  assert.doesNotMatch(hint, /[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/);
  assert.match(hint, /AB/);
  const confirmed = renderToStaticMarkup(
    createElement(IdentityConfirmPanel, {
      result: resultOf(LINKS.IDENTIFIED), details: { ...EMPTY_DETAILS, acknowledged: true },
      confirmation: { phase: 'done', identity: { ...IDENTITY, name: 'Padaria\u202E Exemplo', city: 'Cidade\u200B' }, error: null },
      canConfirm: false, onDetailsChange: noop, onConfirm: noop, onUndo: noop,
    }),
  );
  assert.doesNotMatch(confirmed, /[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/);
});
