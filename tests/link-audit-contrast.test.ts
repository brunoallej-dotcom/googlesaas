import assert from 'node:assert/strict';
import './helpers/stub-lucide';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import config from '../tailwind.config';
import { BUTTON_PRIMARY, BUTTON_QUIET, FIELD_CLASS } from '../src/components/link-audit/audit-page/ui-bits';

/*
 * Onda 6C, I6 — contraste WCAG 2.2 AA calculado sobre os TOKENS REAIS (tailwind.config.ts) e sobre as CONSTANTES de estilo do código.
 * Referência: texto normal ≥ 4,5:1; fronteira de componente de interface e anel de foco ≥ 3:1 (SC 1.4.3 e 1.4.11).
 * LIMITE: mede combinações de tokens; o navegador mede o que realmente é renderizado (ver o relatório). Não substitui leitor de tela.
 */
type Rgb = readonly [number, number, number];
const GMN = (config.theme as { extend: { colors: { gmn: Record<string, string> } } }).extend.colors.gmn;
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
const TAIL: Record<string, string> = { 'green-300': '#86efac', 'amber-300': '#fcd34d', 'red-300': '#fca5a5', 'sky-300': '#7dd3fc', white: '#FFFFFF' };
const SURFACES = ['bg', 'sidebar', 'card', 'tile', 'surface'] as const;

test('texto principal e secundário (muted) passam em AA (4,5:1) sobre TODAS as superfícies do tema, inclusive o topo do gradiente dos painéis', () => {
  for (const name of [...SURFACES, 'panelTop']) {
    const bg = name === 'panelTop' ? hex('#121F36') : tok(name);
    assert.ok(ratio(tok('text'), bg) >= 4.5, `texto sobre ${name}`);
    assert.ok(ratio(tok('muted'), bg) >= 4.5, `muted sobre ${name}: ${ratio(tok('muted'), bg).toFixed(2)}`);
  }
  assert.ok(ratio(tok('muted'), over(tok('tile'), 0.5, tok('card'))) >= 4.5, 'cartão tile/50');
});

test('selos e avisos de estado (sucesso, alerta, perigo, informação) passam em AA com o fundo translúcido sobre o card', () => {
  for (const [label, text, base, alpha] of [['sucesso', 'green-300', 'success', 0.1], ['alerta', 'amber-300', 'warning', 0.1], ['perigo', 'red-300', 'danger', 0.1], ['info', 'sky-300', 'accent', 0.1], ['aviso âmbar', 'amber-300', 'warning', 0.06], ['erro vermelho', 'red-300', 'danger', 0.06], ['ok verde', 'green-300', 'success', 0.06]] as const) {
    const r = ratio(hex(TAIL[text] as string), over(tok(base), alpha, tok('card')));
    assert.ok(r >= 4.5, `${label}: ${r.toFixed(2)}`);
  }
  assert.ok(ratio(tok('accent'), tok('card')) >= 4.5, 'links accent sobre card');
  assert.ok(ratio(tok('text'), over(tok('primary'), 0.18, tok('sidebar'))) >= 4.5, 'item ativo do menu');
});

test('botão primário: texto branco passa em AA no repouso E no hover (o token #247BFF sozinho dava 3,92:1 e foi substituído)', () => {
  const rest = /bg-\[(#[0-9A-Fa-f]{6})\]/.exec(BUTTON_PRIMARY)?.[1];
  const hover = /hover:bg-\[(#[0-9A-Fa-f]{6})\]/.exec(BUTTON_PRIMARY)?.[1];
  assert.ok(rest && hover, 'o botão usa cores explícitas');
  assert.ok(ratio(hex(TAIL.white as string), hex(rest as string)) >= 4.5, `repouso ${ratio(hex('#FFFFFF'), hex(rest as string)).toFixed(2)}`);
  assert.ok(ratio(hex(TAIL.white as string), hex(hover as string)) >= 4.5, 'hover');
  assert.ok(ratio(hex(TAIL.white as string), tok('primary')) < 4.5, 'prova de que o token original NÃO bastava');
  // nenhum botão com texto branco usa o token primário puro nos arquivos novos/alterados do I5/I6
  // TODO do dashboard (fora do I6, registrado): leads-table, audit-panel, top-filters e login ainda usam o token puro; recomenda-se ajustar o token
  const dir = path.join(__dirname, '..', 'src', 'components', 'link-audit');
  const files = [...fs.readdirSync(dir).filter((name) => name.endsWith('.tsx')).map((name) => path.join(dir, name)), ...fs.readdirSync(path.join(dir, 'audit-page')).map((name) => path.join(dir, 'audit-page', name))];
  assert.ok(files.length > 15);
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    assert.ok(!/bg-gmn-primary[^/\]]*text-white|text-white[^"']*bg-gmn-primary(?!\/)/.test(code), `${path.basename(file)}: texto branco sobre o token primário puro`);
    assert.ok(!/hover:bg-gmn-accent[^"'`]*text-white|text-white[^"'`]*hover:bg-gmn-accent/.test(code), `${path.basename(file)}: hover claro com texto branco`);
  }
});

test('campos: borda ≥ 3:1 (SC 1.4.11), placeholder ≥ 4,5:1 e anel de foco ≥ 3:1', () => {
  const border = /border-white\/(\d+)/.exec(FIELD_CLASS)?.[1];
  assert.ok(border, 'a borda do campo é explícita');
  for (const surface of ['tile', 'card'] as const) assert.ok(ratio(over(hex('#FFFFFF'), Number(border) / 100, tok(surface)), tok(surface)) >= 3, `borda do campo sobre ${surface}`);
  const placeholder = /placeholder:text-gmn-muted\/(\d+)/.exec(FIELD_CLASS)?.[1];
  assert.ok(placeholder);
  assert.ok(ratio(over(tok('muted'), Number(placeholder) / 100, tok('tile')), tok('tile')) >= 4.5, 'placeholder');
  for (const surface of [...SURFACES]) assert.ok(ratio(tok('accent'), tok(surface)) >= 3, `anel de foco sobre ${surface}`);
  assert.match(BUTTON_QUIET, /focus-visible:ring-2/);
});

test('nenhum texto do I5/I6 usa o muted com transparência abaixo de 80% (70% já cai abaixo de 4,5:1)', () => {
  const dir = path.join(__dirname, '..', 'src', 'components', 'link-audit');
  const files = [path.join(dir, 'stored-audit-list.tsx'), path.join(dir, 'stored-audit-detail.tsx'), path.join(dir, 'audit-workspace.tsx'), ...fs.readdirSync(path.join(dir, 'audit-page')).map((name) => path.join(dir, 'audit-page', name))];
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?<!placeholder:)text-gmn-muted\/(\d+)/g)) assert.ok(Number(match[1]) >= 80, `${path.basename(file)}: text-gmn-muted/${match[1]}`);
  }
  assert.ok(ratio(over(tok('muted'), 0.8, tok('tile')), tok('tile')) >= 4.5, '80% passa sobre tile');
  assert.ok(ratio(over(tok('muted'), 0.7, tok('tile')), tok('tile')) < 4.5, '70% NÃO passa: é por isso que o piso é 80%');
});

test('anel de foco: nenhum anel de foco da Auditoria por Link fica abaixo de /70 (medido: /60 dá 2,96:1 na pior superfície), salvo em campos com a borda de foco OPACA', () => {
  const root = path.join(__dirname, '..', 'src', 'components', 'link-audit');
  const files: string[] = [];
  const walk = (dir: string): void => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (/\.tsx$/.test(entry.name)) files.push(full); } };
  walk(root);
  let strong = 0;
  let withBorder = 0;
  for (const file of files) {
    for (const segment of fs.readFileSync(file, 'utf8').split(/['"`]/)) {
      for (const match of segment.matchAll(/focus(?:-visible)?:ring-gmn-accent\/(\d+)/g)) {
        if (Number(match[1]) >= 70) { strong += 1; continue; }
        withBorder += 1;
        assert.match(segment, /focus:border-gmn-accent/, `${path.relative(root, file)}: ${match[0]} sem borda de foco opaca`);
      }
    }
  }
  assert.ok(strong >= 10, `esperava ao menos 10 anéis fortes (achei ${strong})`);
  assert.ok(withBorder >= 3 && withBorder <= 6, `os anéis translúcidos são só os dos campos (achei ${withBorder})`);
});
