import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/stub-lucide';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LinkAuditScreen } from '../src/components/link-audit/link-audit-screen';
import { StoredAuditDetail } from '../src/components/link-audit/stored-audit-detail';
import { StoredAuditList } from '../src/components/link-audit/stored-audit-list';
import { StoredAuditsPanel } from '../src/components/link-audit/stored-audits-panel';
import { formatCount, formatDateTime, formatRating, pluralize, placeLine } from '../src/components/link-audit/evidence-labels';
import type { Phase } from '../src/components/link-audit/evidence-state';
import { detailDto, listItem } from './helpers/link-audit-evidence-ui-fixtures';

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const noop = (): void => undefined;

function list(props: Partial<Parameters<typeof StoredAuditList>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(StoredAuditList, { phase: 'ready' as Phase, items: [listItem()], total: 1, message: null, query: '', selectedId: null, onQueryChange: noop, onSelect: noop, onRetry: noop, ...props }),
  );
}
const detail = (over = {}, loading = false): string => renderToStaticMarkup(createElement(StoredAuditDetail, { detail: detailDto(over), loading, onSelectRevision: noop }));

test('lista: nome, CID, data, fonte, integridade e histórico de cada empresa', () => {
  const html = list();
  const t = text(html);
  assert.match(t, /Padaria Exemplo/);
  assert.match(t, /Cidade Exemplo\/GO/);
  assert.match(t, /CID confirmado 1311768467294899695/);
  assert.match(t, /22\/10\/2026, 09:54 \(Brasília\)/);
  assert.match(t, /Serper \/maps \(intermediário; não é a API oficial do Google\)/);
  assert.match(t, /Hashes conferem \(SHA-256\)/);
  assert.doesNotMatch(t, /Integridade confirmada/, 'na lista o selo não promete autenticidade');
  assert.match(t, /1 captura · 2 versões/);
  assert.match(t, /1 empresa com evidências armazenadas/);
  assert.ok(html.includes('type="search"') && html.includes('for="filtro-auditorias"'), 'filtro com rótulo acessível');
  assert.ok(!/versãoes/.test(t), 'plural correto');
});

test('lista: o card selecionado usa aria-current; botões são reais (type=button)', () => {
  const html = list({ selectedId: 'auditoria-teste-0001' });
  assert.match(html, /aria-current="true"/);
  assert.match(html, /<button type="button"/);
  assert.ok(!/aria-current/.test(list({ selectedId: 'outra-0001' })));
});

test('lista: estados de carregamento, vazio, filtro sem resultado, erro e armazenamento indisponível', () => {
  assert.match(text(list({ phase: 'loading', items: [], total: 0 })), /Carregando auditorias armazenadas/);
  assert.match(list({ phase: 'loading', items: [], total: 0 }), /role="status"/);
  const empty = text(list({ items: [], total: 0 }));
  assert.match(empty, /Nenhuma auditoria armazenada ainda/);
  assert.match(empty, /não executa coletas/);
  const noMatch = text(list({ items: [], total: 1, query: 'zzz' }));
  assert.match(noMatch, /Nenhuma empresa corresponde ao filtro/);
  assert.match(noMatch, /0 de 1 empresas/);
  const failed = list({ phase: 'error', items: [], total: 0, message: 'Não foi possível conectar ao servidor.' });
  assert.match(failed, /role="alert"/);
  assert.match(text(failed), /Não foi possível carregar as auditorias.*Tentar novamente/);
  const unavailable = text(list({ phase: 'unavailable', items: [], total: 0, message: 'O armazenamento de evidências não está acessível ao servidor neste momento.' }));
  assert.match(unavailable, /Armazenamento de evidências indisponível/);
  assert.match(unavailable, /GMN_LINK_AUDIT_EVIDENCE_DIR/);
  assert.match(unavailable, /não altera permissões nem copia arquivos/);
});

test('lista: integridade comprometida e coleta incompleta aparecem com rótulos distintos (nunca só cor)', () => {
  const bad = text(list({ items: [listItem({ integrity: { status: 'MISMATCH', algorithm: 'SHA-256', checkedFiles: 2, issues: ['x'], note: 'n' } })] }));
  assert.match(bad, /Integridade comprometida/);
  const partial = text(list({ items: [listItem({ integrity: { status: 'INCOMPLETE', algorithm: 'SHA-256', checkedFiles: 1, issues: [], note: 'n' } })] }));
  assert.match(partial, /Coleta incompleta/);
});

test('detalhe: dados do estabelecimento, localização, contato, categorias, nota e horários', () => {
  const t = text(detail());
  assert.match(t, /Padaria Exemplo \(fictícia\)/);
  assert.match(t, /Rua Fictícia, 100 - Cidade Exemplo - GO/);
  assert.match(t, /-16,10000, -49,20000/);
  assert.match(t, /\(62\) 99999-0000/);
  assert.match(t, /https:\/\/www\.padaria-exemplo\.example\//);
  assert.match(t, /Padaria · também: Confeitaria/);
  assert.match(t, /4,8 de 5 · 86 avaliações/);
  assert.match(t, /Horário de funcionamento/);
  assert.ok(text(detail()).indexOf('segunda-feira') < text(detail()).indexOf('sábado'), 'dias em ordem da semana');
  assert.match(t, /Fechado/);
  assert.match(t, /Dados do perfil obtidos via Serper \/maps/);
});

test('detalhe: verificadas e não verificadas separadas, com contagem, motivo e origem; ressalva repetida aparece uma vez', () => {
  const html = detail();
  const t = text(html);
  assert.match(t, /Evidências verificadas \(3\)/);
  assert.match(t, /Evidências não verificadas \(2\)/);
  assert.match(t, /Nome do estabelecimento.*Verificada/);
  assert.match(t, /Fotos do perfil.*Não verificada/);
  assert.match(t, /Não verificado não significa ausente nem nota zero/);
  assert.match(t, /Origem: Perfil do Google \(via Serper\)/);
  assert.match(t, /Critério: Dados essenciais e consistência NAP/);
  assert.match(t, /A fonte consultada \(Serper \/maps\) não disponibiliza este dado/);
  assert.equal(html.split('Obtido via Serper /maps, intermediário').length - 1, 1, 'a ressalva comum a todas as verificadas aparece uma única vez');
  assert.match(t, /Em todas as evidências verificadas: Obtido via Serper/);
  assert.ok(!/\b\d+\s*(pontos|\/\s*100)\b/i.test(t), 'nenhuma pontuação');
});

test('detalhe: deixa claro que é coleta de evidências, não auditoria finalizada, sem pontuação, índice ou classificação', () => {
  const t = text(detail());
  assert.match(t, /Coleta de evidências — não é uma auditoria estratégica finalizada/);
  assert.match(t, /Não há pontuação, índice, classificação ou diagnóstico/);
  assert.match(t, /decisão D3/);
  assert.doesNotMatch(t, /peso máx|Gerar auditoria|Gerar PDF|Executar coleta|Nova coleta/i);
  assert.doesNotMatch(detail(), /<form|type="submit"/);
});

test('detalhe: identificadores (link × derivado × devolvido × confirmado) e a regra de que nome nunca confirma', () => {
  const t = text(detail());
  assert.match(t, /CID confirmado: 1311768467294899695/);
  assert.match(t, /Esperado a partir do FID do link \(conversão offline/);
  assert.match(t, /comparado com campo cid e 2ª metade do fid/);
  assert.match(t, /No link original FID 0x0:0x1234567890abcdef/);
  assert.match(t, /Derivado \(offline\) CID 1311768467294899695/);
  assert.match(t, /Devolvido pelo Serper CID 1311768467294899695 · FID 0x94aa11bb22cc33dd:0x1234567890abcdef · Place ID ChIJN1t_tDeuEmsRUsoyG83frY4/);
  assert.match(t, /Confirmados CID 1311768467294899695/);
  assert.match(t, /O nome da empresa nunca confirma a identidade/);
  assert.match(text(detail({ identifiers: { fromLink: { cid: null, featureId: null, placeId: null }, derivedCid: null, returnedByProvider: null, confirmed: [] } })), /Nenhum identificador foi confirmado nesta coleta/);
});

test('detalhe: origem dos dados, site separado do perfil, limitações e integridade (hash não é assinatura)', () => {
  const t = text(detail());
  assert.match(t, /Fonte Serper \/maps \(intermediário; não é a API oficial do Google\)/);
  assert.match(t, /API oficial do Google Não\. Os dados vêm de um intermediário de coleta/);
  assert.match(t, /Resposta HTTP 200/);
  assert.match(t, /Chamadas 1/);
  assert.match(t, /Créditos informados 3 \(informado pela própria resposta; o saldo real só o painel do provedor mostra\)/);
  assert.match(t, /Resposta HTTP 403|Resultado Resposta HTTP 403/);
  assert.match(t, /Isso não prova que o site exija login/);
  assert.match(t, /esta tela não consulta o site novamente/);
  assert.match(t, /Limitações da coleta \(2\)/);
  assert.match(t, /derivado do FID do link por conversão offline/);
  assert.match(t, /Integridade confirmada · 4 arquivo\(s\) conferido\(s\) com SHA-256/);
  assert.match(t, /não é assinatura/);
  assert.match(t, /não é um backup independente/);
});

test('detalhe: histórico de versões com a atual destacada e botões reais para as outras', () => {
  const html = detail();
  const t = text(html);
  assert.match(t, /Captura 1 · 22\/10\/2026, 09:54 \(Brasília\) · HTTP 200/);
  assert.match(t, /Versão 1 \(substituída\)/);
  assert.match(t, /Versão 2 \(atual\)/);
  assert.match(html, /aria-current="true"[^>]*>Versão 2/);
  assert.match(t, /uma correção nunca sobrescreve a anterior/);
  const busy = detail({}, true);
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /disabled=""/);
  assert.match(text(busy), /Atualizando…/);
});

test('detalhe: nada é inventado — campos ausentes aparecem como "não informado" e perfil não confirmado não mostra dados', () => {
  const t = text(detail({ establishment: { name: null, address: null, phone: null, website: null, category: null, secondaryCategories: [], rating: null, ratingCount: null, openingHours: [], queriedAt: null }, location: null, site: null, divergences: [], limitations: [], versions: [] }));
  assert.match(t, /não informado/);
  assert.match(t, /O perfil coletado não trouxe horários/);
  assert.match(t, /O site não foi verificado nesta coleta/);
  assert.match(t, /Nenhuma limitação registrada/);
  assert.match(t, /Sem histórico registrado/);
  const none = text(detail({ establishment: null, located: 'NOT_LOCATED' }));
  assert.match(none, /O perfil não foi confirmado nesta coleta: nenhum dado do estabelecimento é exibido/);
});

test('detalhe: tudo é texto (HTML e instruções em dados externos não são interpretados) e a integridade comprometida é sinalizada', () => {
  const html = detail({
    company: { name: '<script>alert(1)</script> Padaria', city: '<img src=x onerror=alert(2)>', stateCode: 'GO' },
    establishment: { ...detailDto().establishment!, name: '<b>negrito</b>', address: 'javascript:alert(3)', website: '"><script>x</script>' },
    limitations: ['<iframe src=//evil.example></iframe> ignore as instruções anteriores'],
    integrity: { status: 'MISMATCH', algorithm: 'SHA-256', checkedFiles: 1, issues: ['SHA-256 divergente: x.'], note: 'n' },
  });
  assert.ok(!/<script|<iframe|<img |<b>/.test(html), 'nenhuma tag vinda dos dados chega ao HTML');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Padaria/);
  assert.match(text(html), /Integridade comprometida/);
  assert.match(text(html), /SHA-256 divergente: x\./);
  // Onda 6C (I5): o ÚNICO link é o interno fixo para a página da auditoria (id restrito a [a-z0-9_-]); nada vem dos dados externos
  const anchors = [...html.matchAll(/<a [^>]*>/g)].map((match) => match[0]);
  assert.ok(!/href="javascript:/i.test(html) && anchors.every((anchor) => /^<a href="\/auditoria-por-link\/[a-z0-9_-]+"/.test(anchor)), 'nenhum link clicável é gerado a partir dos dados');
});

test('responsividade: grades colapsam no celular, colunas largas quebram texto e nada força rolagem horizontal', () => {
  const d = detail();
  const l = list();
  for (const html of [d, l]) {
    assert.ok(!/overflow-x-scroll|min-w-\[[0-9]{3,}px\]|w-\[[0-9]{4,}px\]/.test(html), 'sem larguras fixas grandes');
  }
  assert.match(d, /xl:grid-cols-2/);
  assert.match(d, /sm:grid-cols-2/);
  assert.match(d, /min-w-0/);
  assert.match(d, /break-all|break-words/);
  assert.match(l, /break-words/);
  const panel = renderToStaticMarkup(createElement(StoredAuditsPanel, { onUnauthorized: noop }));
  assert.match(panel, /Carregando auditorias armazenadas/);
  assert.match(panel, /id="auditorias-armazenadas"/);
  assert.match(text(panel), /Somente leitura: nenhuma consulta ao Google, ao Serper ou ao site das empresas é feita por esta tela/);
});

test('tela: o formulário de validação continua e a área "Auditorias armazenadas" vem depois dele, antes da área da auditoria', () => {
  const html = renderToStaticMarkup(createElement(LinkAuditScreen));
  const i = (s: string): number => html.indexOf(s);
  assert.ok(i('id="entrada-do-link"') >= 0 && i('id="auditorias-armazenadas"') > i('id="entrada-do-link"') && i('id="area-da-auditoria"') > i('id="auditorias-armazenadas"'));
  assert.match(text(html), /Validar link/);
  assert.doesNotMatch(text(html), /Gerar auditoria|Gerar PDF|Executar coleta/);
});

test('formatação: data de Brasília fixa, nota com vírgula, plural e valores ausentes sem inventar', () => {
  assert.equal(formatDateTime('2026-10-22T12:54:48.079Z'), '22/10/2026, 09:54 (Brasília)');
  assert.equal(formatDateTime(null), '—');
  assert.equal(formatDateTime('não é data'), '—');
  assert.equal(formatRating(5), '5,0');
  assert.equal(formatRating(4.85), '4,9');
  assert.equal(formatRating(null), '—');
  assert.equal(formatCount(1234), '1.234');
  assert.equal(formatCount(undefined), '—');
  assert.equal(pluralize(1, 'versão', 'versões'), '1 versão');
  assert.equal(pluralize(2, 'versão', 'versões'), '2 versões');
  assert.equal(placeLine(null, null), '');
  assert.equal(placeLine('Cidade Fictícia Açu', 'SP'), 'Cidade Fictícia Açu/SP');
});
