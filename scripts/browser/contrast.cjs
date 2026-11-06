'use strict';
/*
 * Medidor de contraste WCAG 2.x EXECUTADO NA PÁGINA (via CDP): para cada texto visível, compõe a cor do texto e os fundos (inclusive
 * translúcidos e degradês) e compara com 4,5:1 (3:1 para texto grande). Controles desabilitados são isentos (WCAG 1.4.3).
 * Devolve { checked, failures[], failureCount }.
 */
const CONTRAST_JS = `(() => {
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (f, bg) => ({ r: f.r * f.a + bg.r * (1 - f.a), g: f.g * f.a + bg.g * (1 - f.a), b: f.b * f.a + bg.b * (1 - f.a), a: 1 });
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const page = { r: 7, g: 13, b: 28, a: 1 };
  const bases = (el) => { const inner = []; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); const c = parse(cs.backgroundColor); const grad = cs.backgroundImage && cs.backgroundImage.includes('gradient') ? (cs.backgroundImage.match(/rgba?\\([^)]*\\)/g) || []).map(parse).filter(Boolean) : []; if (grad.length) return { base: grad.map((g) => over(g, page)), inner }; if (c && c.a > 0) { if (c.a >= 1) return { base: [c], inner }; inner.push(c); } } return { base: [page], inner }; };
  const out = []; let checked = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n; (n = walker.nextNode()); ) {
    const el = n.parentElement; if (!el || seen.has(el)) continue; if (!n.textContent.trim()) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0 || !el.getClientRects().length) continue;
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue; if (cs.clip && cs.clip.startsWith('rect(0')) continue;
    if (el.closest(':disabled, [aria-disabled="true"], script, style')) continue;
    seen.add(el); checked++;
    const { base, inner } = bases(el); const fg = parse(cs.color); if (!fg) continue;
    let worst = 99, worstBg = null;
    for (const b0 of base) { let bg = b0; for (let i = inner.length - 1; i >= 0; i--) bg = over(inner[i], bg); const text = fg.a < 1 ? over(fg, bg) : fg; const rr = ratio(text, bg); if (rr < worst) { worst = rr; worstBg = bg; } }
    const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700; const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (worst < need) out.push({ tag: el.tagName, text: n.textContent.trim().slice(0, 40), ratio: Math.round(worst * 100) / 100, need, size: Math.round(size) });
  }
  return { checked, failures: out.slice(0, 20), failureCount: out.length };
})()`;

module.exports = { CONTRAST_JS };
