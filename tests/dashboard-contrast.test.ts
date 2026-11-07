import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import config from '../tailwind.config';

/*
 * Correção de contraste do dashboard/login (decisão da Onda 6C, I7). WCAG 2.2 AA calculado sobre os TOKENS REAIS
 * (tailwind.config.ts) e sobre as classes lidas do código-fonte. Texto normal ≥ 4,5:1; anel/borda de foco ≥ 3:1 (SC 1.4.3 e 1.4.11).
 * LIMITE: mede combinações de tokens; não substitui verificação no navegador nem leitor de tela.
 */
type Rgb = readonly [number, number, number];
const GMN = (config.theme as { extend: { colors: { gmn: Record<string, string> } } }).extend.colors.gmn;
const ROOT = path.join(__dirname, '..');
const hex = (value: string): Rgb => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as unknown as Rgb;
const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: Rgb): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb => fg.map((c, i) => Math.round(c * alpha + (bg[i] as number) * (1 - alpha))) as unknown as Rgb;
const ratio = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const tok = (name: string): Rgb => hex(GMN[name] as string);
const WHITE = hex('#FFFFFF');
const SURFACES = ['bg', 'sidebar', 'card', 'tile', 'surface'] as const;
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

const WHITE_TEXT_BUTTONS: ReadonlyArray<readonly [string, string]> = [
  ['src/components/dashboard/leads-table.tsx', 'Baixar PDF'],
  ['src/components/dashboard/audit-panel.tsx', 'Baixar relatório PDF'],
  ['src/components/dashboard/top-filters.tsx', 'buscar'],
  ['src/app/login/page.tsx', 'entrar'],
];

/** Classes do elemento que contém `bg-gmn-primary-strong` (a string de className entre aspas/crases). */
const strongButtonClasses = (file: string): string[] =>
  read(file).split(/['"`]/).filter((segment) => /\bbg-gmn-primary-strong\b/.test(segment));

test('token primary-strong: 5,18:1 com branco; o primário da marca NÃO foi alterado', () => {
  assert.equal(GMN.primary, '#247BFF');
  assert.equal(GMN['primary-strong'], '#1D68DB');
  assert.ok(ratio(WHITE, tok('primary-strong')) >= 4.5, `repouso ${ratio(WHITE, tok('primary-strong')).toFixed(2)}`);
  assert.ok(ratio(WHITE, tok('primary-strong-hover')) >= 4.5, 'hover');
  assert.ok(ratio(WHITE, tok('primary')) < 4.5, 'prova: o primário puro não bastava');
  assert.ok(ratio(WHITE, tok('accent')) < 4.5, 'prova: o hover antigo (accent) não bastava');
});

test('os 4 botões com texto branco usam primary-strong em repouso e hover, nunca primário/accent puros', () => {
  for (const [file, label] of WHITE_TEXT_BUTTONS) {
    const segments = strongButtonClasses(file);
    assert.equal(segments.length, 1, `${file} (${label}): esperava 1 botão primary-strong`);
    const classes = segments[0] as string;
    assert.match(classes, /\btext-white\b/);
    assert.match(classes, /\bhover:bg-gmn-primary-strong-hover\b/, `${file}: hover`);
    assert.doesNotMatch(classes, /hover:bg-gmn-accent/, `${file}: hover claro`);
    assert.doesNotMatch(classes, /\bbg-gmn-primary\b(?!-)(?!\/)/, `${file}: primário puro`);
  }
});

test('botão desabilitado (opacity-60/50 sobre a superfície): permanece distinguível do ativo e informa a razão real', () => {
  const surfaces: Record<string, string> = { 'src/components/dashboard/top-filters.tsx': 'card', 'src/app/login/page.tsx': 'card' };
  for (const [file, surface] of Object.entries(surfaces)) {
    const classes = strongButtonClasses(file)[0] as string;
    const opacity = Number(/disabled:opacity-(\d+)/.exec(classes)?.[1]) / 100;
    assert.ok(opacity > 0 && opacity < 1, `${file}: disabled:opacity`);
    const bg = over(tok('primary-strong'), opacity, tok(surface));
    const fg = over(WHITE, opacity, tok(surface));
    assert.ok(ratio(fg, bg) >= 1.5, `${file}: disabled indistinguível`);
    assert.ok(ratio(bg, tok(surface)) >= 1.5, `${file}: disabled some no fundo`);
    // Isento do WCAG (controle inativo); o valor é registrado só para o relatório.
    assert.ok(Number.isFinite(ratio(fg, bg)));
  }
});

test('muted com transparência: os 4 pontos corrigidos usam /80 e passam sobre o fundo real (texto ≥ 4,5:1; ícone/"Em breve" distinguível do ativo)', () => {
  const placeholder = /placeholder:text-gmn-muted\/(\d+)/.exec(read('src/components/dashboard/top-filters.tsx'))?.[1];
  assert.equal(placeholder, '80');
  assert.ok(ratio(over(tok('muted'), 0.8, tok('tile')), tok('tile')) >= 4.5, 'placeholder sobre tile');
  assert.ok(ratio(over(tok('muted'), 0.6, tok('tile')), tok('tile')) < 4.5, 'prova: /60 não passava');

  assert.match(read('src/components/dashboard/sidebar.tsx'), /cursor-not-allowed text-gmn-muted\/80/);
  const disabledMenu = ratio(over(tok('muted'), 0.8, tok('sidebar')), tok('sidebar'));
  assert.ok(disabledMenu >= 4.5, `"Em breve" sobre sidebar: ${disabledMenu.toFixed(2)}`);
  assert.ok(disabledMenu < ratio(tok('muted'), tok('sidebar')), 'continua mais discreto que o item ativo');

  assert.match(read('src/components/dashboard/audit-panel.tsx'), /Swords className="h-7 w-7 text-gmn-muted\/80"/);
  assert.ok(ratio(over(tok('muted'), 0.8, tok('card')), tok('card')) >= 3, 'ícone de concorrentes (gráfico, ≥ 3:1)');

  assert.match(read('src/components/ui/metric-card.tsx'), /font-semibold leading-none text-gmn-muted\/80/);
  assert.ok(ratio(over(tok('muted'), 0.8, tok('card')), tok('card')) >= 4.5, 'traço do card sobre card');

  for (const file of ['src/components/dashboard/top-filters.tsx', 'src/components/dashboard/audit-panel.tsx', 'src/components/dashboard/sidebar.tsx', 'src/components/ui/metric-card.tsx']) {
    for (const match of read(file).matchAll(/gmn-muted\/(\d+)/g)) assert.ok(Number(match[1]) >= 80, `${file}: muted/${match[1]}`);
  }
});

test('anéis de foco de top-filters: borda de foco OPACA (≥ 3:1) e anel nunca abaixo de /40 sem ela; nenhum anel translúcido sem borda opaca', () => {
  const code = read('src/components/dashboard/top-filters.tsx');
  let found = 0;
  for (const segment of code.split(/['"`]/)) {
    for (const match of segment.matchAll(/focus(?:-visible)?:ring-gmn-accent\/(\d+)/g)) {
      found += 1;
      if (Number(match[1]) >= 70) continue;
      assert.match(segment, /focus:border-gmn-accent(?![/\w-])/, `${match[0]} sem borda de foco opaca`);
    }
  }
  assert.equal(found, 2);
  for (const surface of SURFACES) assert.ok(ratio(tok('accent'), tok(surface)) >= 3, `borda de foco sobre ${surface}`);
  assert.ok(ratio(over(tok('accent'), 0.6, tok('tile')), tok('tile')) < 3.5, 'registro: /60 translúcido era o limite');
});

test('anéis de foco dos demais controles do dashboard (sidebar, header) estão em /70 ou mais e ≥ 3:1', () => {
  for (const file of ['src/components/dashboard/sidebar.tsx', 'src/components/dashboard/dashboard-header.tsx']) {
    for (const match of read(file).matchAll(/focus-visible:ring-gmn-accent\/(\d+)/g)) {
      assert.ok(Number(match[1]) >= 70, `${file}: ${match[0]}`);
      for (const surface of SURFACES) assert.ok(ratio(over(tok('accent'), Number(match[1]) / 100, tok(surface)), tok(surface)) >= 3, `${file}: ${match[0]} sobre ${surface}`);
    }
  }
});

test('botão "Tentar novamente" (texto branco sobre vermelho): danger-strong ≥ 4,5:1 em repouso e no hover (opacity-90) sobre toda superfície; o danger da marca não muda', () => {
  assert.equal(GMN.danger, '#EF4444');
  assert.equal(GMN['danger-strong'], '#DC2626');
  assert.ok(ratio(WHITE, tok('danger')) < 4.5, 'prova: o danger puro não bastava');
  assert.ok(ratio(WHITE, tok('danger-strong')) >= 4.5, `repouso ${ratio(WHITE, tok('danger-strong')).toFixed(2)}`);
  const classes = read('src/components/dashboard/audit-panel.tsx').split(/['"`]/).filter((segment) => /\bbg-gmn-danger-strong\b/.test(segment));
  assert.equal(classes.length, 1, 'esperava exatamente um botão danger-strong em audit-panel');
  assert.match(classes[0] as string, /\btext-white\b/);
  assert.doesNotMatch(classes[0] as string, /\bbg-gmn-danger\b(?!-)(?!\/)/, 'danger puro com texto branco');
  const hoverOpacity = Number(/hover:opacity-(\d+)/.exec(classes[0] as string)?.[1]) / 100;
  assert.ok(hoverOpacity > 0 && hoverOpacity <= 1, 'hover:opacity');
  for (const surface of SURFACES) {
    const bg = over(tok('danger-strong'), hoverOpacity, tok(surface));
    const fg = over(WHITE, hoverOpacity, tok(surface));
    assert.ok(ratio(fg, bg) >= 4.5, `hover sobre ${surface}: ${ratio(fg, bg).toFixed(2)}`);
  }
  // Nenhum outro texto branco ficou sobre o danger puro (a barra de progresso é gráfico sem texto, ≥ 3:1 com a trilha).
  for (const file of ['src/components/dashboard/audit-panel.tsx', 'src/components/dashboard/leads-table.tsx', 'src/components/dashboard/top-filters.tsx', 'src/app/login/page.tsx']) {
    for (const segment of read(file).split(/['"`]/)) {
      if (/\bbg-gmn-danger\b(?!-)(?!\/)/.test(segment)) assert.doesNotMatch(segment, /\btext-white\b/, `${file}: texto branco sobre bg-gmn-danger`);
    }
  }
});

test('login: inputs com foco visível por teclado (focus-visible), contorno de 2px e borda OPACOS ≥ 3:1 sobre o tile, sem remover o contorno de alto contraste', () => {
  const code = read('src/app/login/page.tsx');
  const inputs = code.split('<input').slice(1).map((chunk) => chunk.split('/>')[0] as string);
  assert.equal(inputs.length, 2, 'e-mail e senha');
  for (const input of inputs) {
    const klass = /className="([^"]+)"/.exec(input)?.[1] ?? '';
    assert.match(klass, /\bfocus-visible:outline(?![\w-])/, 'contorno sólido no foco por teclado');
    assert.match(klass, /\bfocus-visible:outline-2\b/, 'contorno de 2px, igual ao global de globals.css');
    assert.match(klass, /\bfocus-visible:outline-offset-2\b/, 'afastado 2px, igual ao global');
    assert.match(klass, /\bfocus-visible:outline-gmn-accent(?![/\w-])/, 'contorno OPACO (sem /NN)');
    assert.match(klass, /\bfocus-visible:border-gmn-accent(?![/\w-])/, 'borda de foco opaca');
    assert.doesNotMatch(klass, /\boutline-none\b/, 'não remove o contorno (nem em modo de alto contraste do sistema)');
    assert.doesNotMatch(klass, /\bring-/, 'sem anel somado ao contorno (viraria uma faixa de 4px, diferente do resto do app)');
    assert.doesNotMatch(klass, /\bfocus:border-gmn-primary\b/, 'a borda primária (contraste baixo) saiu');
  }
  for (const surface of ['tile', 'card', 'bg']) assert.ok(ratio(tok('accent'), tok(surface)) >= 3, `foco (accent) sobre ${surface}`);
});
