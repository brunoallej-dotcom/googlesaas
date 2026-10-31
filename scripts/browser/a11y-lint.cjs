'use strict';
/*
 * Verificador de acessibilidade EM PÁGINA (via CDP), conjunto PRÓPRIO e REDUZIDO de regras. NÃO é o axe-core (indisponível offline neste
 * ambiente) e NÃO comprova conformidade WCAG: só pega erros mecânicos comuns. Cada problema vem com o escopo (`conteúdo`, `menu`, `cabeçalho`)
 * para separar o que é da Auditoria por Link do que é do dashboard em geral. Devolve { checked, issues: [{ rule, scope, where }] }.
 */
const A11Y_LINT_JS = `(() => {
  const issues = [];
  const scopeOf = (el) => (el.closest('aside') ? 'menu' : el.closest('header') ? 'cabeçalho' : 'conteúdo');
  const where = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label').slice(0, 30) + ']' : '') + ' "' + (el.innerText || '').trim().slice(0, 24).replace(/\\n/g, ' ') + '"';
  const add = (rule, el) => issues.push({ rule, scope: el ? scopeOf(el) : 'documento', where: el ? where(el) : '' });
  const shown = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0; };
  const byId = (id) => document.getElementById(id);
  const textOfIds = (ids) => ids.split(/\\s+/).map((id) => (byId(id) ? byId(id).textContent : '')).join(' ').trim();
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label'); if (label && label.trim()) return label.trim();
    const by = el.getAttribute('aria-labelledby'); if (by && textOfIds(by)) return textOfIds(by);
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && l.textContent.trim()) return l.textContent.trim(); }
    const wrap = el.closest('label'); if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
    if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').trim();
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return (el.value || '').trim();
    const t = (el.textContent || '').trim(); if (t) return t;
    return (el.getAttribute('title') || '').trim();
  };
  const html = document.documentElement;
  if (!html.getAttribute('lang')) add('o <html> não tem lang', null);
  if (!document.title.trim()) add('a página não tem <title>', null);
  const mains = document.querySelectorAll('main'); if (mains.length !== 1) issues.push({ rule: 'deve haver exatamente um <main> (há ' + mains.length + ')', scope: 'documento', where: '' });
  const h1 = document.querySelectorAll('h1'); if (h1.length !== 1) issues.push({ rule: 'deve haver exatamente um <h1> (há ' + h1.length + ')', scope: 'documento', where: '' });
  let previous = 0;
  for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) { if (!shown(h)) continue; const level = Number(h.tagName[1]); if (previous && level > previous + 1) add('salto de nível de título (h' + previous + ' → h' + level + ')', h); previous = level; }
  const navs = [...document.querySelectorAll('nav')].filter(shown); if (navs.length > 1) for (const n of navs) if (!n.getAttribute('aria-label') && !n.getAttribute('aria-labelledby')) add('há mais de um <nav> e este não tem nome', n);
  const ids = new Map(); for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) || 0) + 1);
  for (const [id, n] of ids) if (n > 1) issues.push({ rule: 'id duplicado: ' + id, scope: 'documento', where: '' });
  const interactive = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[tabindex]')].filter(shown);
  for (const el of interactive) {
    if (el.matches('[tabindex]') && Number(el.getAttribute('tabindex')) > 0) add('tabindex positivo', el);
    if (el.tagName === 'DIV' || el.tagName === 'SPAN') { if (!el.matches('[role=button],[role=link]')) continue; }
    if (!nameOf(el)) add('controle sem nome acessível', el);
    if (el.closest('[aria-hidden="true"]') && !el.disabled && el.getAttribute('tabindex') !== '-1') add('foco dentro de aria-hidden', el);
    if (el.tagName === 'A' && el.querySelector('button,a')) add('interativo aninhado dentro de link', el);
    if (el.tagName === 'BUTTON' && el.querySelector('button,a[href]')) add('interativo aninhado dentro de botão', el);
  }
  for (const el of document.querySelectorAll('input:not([type=hidden]),select,textarea')) { if (shown(el) && !nameOf(el)) add('campo sem rótulo', el); }
  for (const el of document.querySelectorAll('[aria-labelledby],[aria-describedby]')) { if (!shown(el)) continue; for (const attr of ['aria-labelledby', 'aria-describedby']) { const v = el.getAttribute(attr); if (v) for (const id of v.split(/\\s+/)) if (!byId(id)) add(attr + ' aponta para id inexistente (' + id + ')', el); } }
  for (const el of document.querySelectorAll('[aria-controls]')) { if (!shown(el)) continue; const id = el.getAttribute('aria-controls'); if (id && !byId(id)) add('aria-controls aponta para id inexistente (' + id + ')', el); }
  for (const img of document.querySelectorAll('img')) if (shown(img) && !img.hasAttribute('alt')) add('imagem sem alt', img);
  for (const d of document.querySelectorAll('dialog')) if (d.open && !nameOf(d)) add('diálogo aberto sem nome acessível', d);
  return { checked: interactive.length, issues };
})()`;

module.exports = { A11Y_LINT_JS };
