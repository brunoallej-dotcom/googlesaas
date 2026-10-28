import fs from 'node:fs';
import path from 'node:path';
import type { EvidenceClass } from './report-types';
import {
  CONTENT_BOTTOM,
  CONTENT_WIDTH,
  FONT_FILES,
  FONT_NAMES,
  PAGE,
  REPORT_COLORS,
  fontsDirectory,
} from './report-theme';
import type { FontKey, FontSet, TextSanitizer } from './report-theme';

export type Doc = PDFKit.PDFDocument;
export type FontMode = 'inter' | 'standard';

/* -------------------------------------------------------------------------- */
/* Fontes e sanitização de texto                                              */
/* -------------------------------------------------------------------------- */

type FontkitLayout = (string: string, features?: unknown, script?: string, language?: string, direction?: string) => unknown;
interface PatchableFont {
  layout: FontkitLayout;
  __latinScriptForced?: boolean;
}

/**
 * Força o script latino na composição do texto.
 *
 * O fontkit deduz o script de cada trecho: um trecho só com dígitos e pontuação ("57,1%") cai no
 * script padrão (DFLT), cuja tabela de kerning da Inter aplica o DOBRO do ajuste em pares como
 * "7," e ",1", e a vírgula decimal fica sobreposta ao dígito ("57|1%"). O PDFKit compõe o texto
 * palavra por palavra, então isso acontece mesmo dentro de frases. Com `latn`, o mesmo trecho
 * recebe o kerning que a fonte aplicaria numa frase normal.
 */
export function forceLatinScript(doc: Doc, fontName: string): void {
  const embedded = (doc.font(fontName) as unknown as { _font?: { font?: PatchableFont } })._font?.font;
  if (!embedded || typeof embedded.layout !== 'function' || embedded.__latinScriptForced) return;
  const original = embedded.layout.bind(embedded);
  embedded.layout = (string, features, script, language, direction) =>
    original(string, features, script ?? 'latn', language, direction);
  embedded.__latinScriptForced = true;
}

/** Registra a Inter embutida (ou, sem os arquivos, as fontes padrão do PDF). */
export function registerFonts(doc: Doc, requested: FontMode = 'inter'): { fonts: FontSet; mode: FontMode } {
  const dir = fontsDirectory();
  const available =
    requested === 'inter' && (Object.values(FONT_FILES) as string[]).every((file) => fs.existsSync(path.join(dir, file)));
  if (available) {
    for (const key of Object.keys(FONT_FILES) as FontKey[]) {
      doc.registerFont(FONT_NAMES[key].inter, path.join(dir, FONT_FILES[key]));
    }
    for (const key of Object.keys(FONT_FILES) as FontKey[]) forceLatinScript(doc, FONT_NAMES[key].inter);
  }
  const mode: FontMode = available ? 'inter' : 'standard';
  const pick = (key: FontKey): string => FONT_NAMES[key][mode];
  return {
    mode,
    fonts: { regular: pick('regular'), medium: pick('medium'), semibold: pick('semibold'), bold: pick('bold') },
  };
}

const REPLACEMENTS: Readonly<Record<string, string>> = {
  '≥': '>=',
  '≤': '<=',
  '→': '->',
  '←': '<-',
  '↑': '^',
  '↓': 'v',
  '●': '•',
  '○': 'o',
  '◐': 'o',
  '✓': 'v',
  '✔': 'v',
  '✗': 'x',
  '×': 'x',
  '−': '-',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
};

const WIN_ANSI_EXTRAS = new Set([0x20ac, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2026, 0x2122]);

type GlyphFont = { hasGlyphForCodePoint?: (codePoint: number) => boolean };

/**
 * Garante que todo caractere impresso exista na fonte do documento. Nomes de estabelecimentos
 * podem trazer emojis e símbolos; eles são removidos ou trocados em vez de virarem "caixas".
 */
export function createSanitizer(doc: Doc, fonts: FontSet, mode: FontMode): TextSanitizer {
  let glyphFont: GlyphFont | null = null;
  if (mode === 'inter') {
    const internal = doc.font(fonts.regular) as unknown as { _font?: { font?: GlyphFont } };
    glyphFont = internal._font?.font ?? null;
  }

  const supported = (codePoint: number): boolean => {
    if (mode === 'inter' && glyphFont?.hasGlyphForCodePoint) return glyphFont.hasGlyphForCodePoint(codePoint);
    return codePoint <= 0xff || WIN_ANSI_EXTRAS.has(codePoint);
  };

  return (text: string): string => {
    let out = '';
    for (const char of text.normalize('NFC')) {
      const codePoint = char.codePointAt(0) ?? 0;
      if (char === '\n') {
        out += char;
        continue;
      }
      if (codePoint < 0x20) continue;
      if ((codePoint >= 0x200b && codePoint <= 0x200f) || codePoint === 0xfe0f) continue;
      const replacement = REPLACEMENTS[char];
      if (replacement !== undefined) {
        out += replacement;
      } else if (supported(codePoint)) {
        out += char;
      } else if (codePoint >= 0x1f000 || (codePoint >= 0x2600 && codePoint <= 0x27bf)) {
        // emojis e pictogramas: removidos
      } else {
        out += '?';
      }
    }
    return out.replace(/ {2,}/g, ' ').trim();
  };
}

/* -------------------------------------------------------------------------- */
/* Canvas: cursor, fluxo de páginas e medição                                 */
/* -------------------------------------------------------------------------- */

export interface TextStyle {
  readonly weight?: keyof FontSet;
  readonly size?: number;
  readonly color?: string;
  readonly lineGap?: number;
  readonly align?: 'left' | 'center' | 'right' | 'justify';
  readonly characterSpacing?: number;
}

export class Canvas {
  /** Cursor vertical do conteúdo corrente. */
  y: number = PAGE.marginTop;
  /** Chamado a cada nova página (cabeçalho). Deve devolver o `y` inicial do conteúdo. */
  onNewPage: (() => number) | null = null;
  /** Seções do dossiê com a página em que começam (alimenta o índice da capa). */
  readonly sections: { title: string; pageIndex: number }[] = [];

  constructor(
    readonly doc: Doc,
    readonly fonts: FontSet,
    readonly sanitize: TextSanitizer
  ) {}

  /** Registra que uma seção começa na página corrente. */
  mark(title: string): void {
    this.sections.push({ title, pageIndex: this.doc.bufferedPageRange().count - 1 });
  }

  newPage(): void {
    this.doc.addPage();
    this.y = this.onNewPage ? this.onNewPage() : PAGE.marginTop;
  }

  /**
   * Começa uma seção: continua na página corrente se ainda houver `minRemaining` pontos livres
   * (evita páginas quase vazias entre seções); do contrário abre uma nova página.
   */
  startSection(minRemaining: number): void {
    if (CONTENT_BOTTOM - this.y >= minRemaining) {
      this.y += 22;
    } else {
      this.newPage();
    }
  }

  /** Abre uma nova página se `height` não couber; devolve verdadeiro se abriu. */
  ensure(height: number): boolean {
    if (this.y + height > CONTENT_BOTTOM) {
      this.newPage();
      return true;
    }
    return false;
  }

  private apply(style: TextStyle): void {
    this.doc
      .font(this.fonts[style.weight ?? 'regular'])
      .fontSize(style.size ?? 9)
      .fillColor(style.color ?? REPORT_COLORS.text);
  }

  width(text: string, style: TextStyle = {}): number {
    this.apply(style);
    return this.doc.widthOfString(this.sanitize(text), { characterSpacing: style.characterSpacing ?? 0 });
  }

  measure(text: string, width: number, style: TextStyle = {}): number {
    if (!text) return 0;
    this.apply(style);
    return this.doc.heightOfString(this.sanitize(text), {
      width,
      lineGap: style.lineGap ?? 1.8,
      characterSpacing: style.characterSpacing ?? 0,
    });
  }

  /** Escreve um parágrafo em posição absoluta e devolve a altura usada. */
  paragraph(text: string, x: number, y: number, width: number, style: TextStyle = {}): number {
    if (!text) return 0;
    this.apply(style);
    const clean = this.sanitize(text);
    const options = {
      width,
      lineGap: style.lineGap ?? 1.8,
      align: style.align ?? 'left',
      characterSpacing: style.characterSpacing ?? 0,
    } as const;
    const height = this.doc.heightOfString(clean, options);
    this.doc.text(clean, x, y, options);
    return height;
  }

  /** Texto de uma linha só (sem quebra), cortado com reticências se passar de `maxWidth`. */
  line(text: string, x: number, y: number, style: TextStyle = {}, maxWidth?: number): void {
    this.apply(style);
    this.doc.text(this.sanitize(text), x, y, {
      lineBreak: false,
      width: maxWidth,
      ellipsis: maxWidth !== undefined,
      characterSpacing: style.characterSpacing ?? 0,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Primitivos visuais                                                         */
/* -------------------------------------------------------------------------- */

export function card(
  doc: Doc,
  x: number,
  y: number,
  w: number,
  h: number,
  options: { readonly fill?: string; readonly border?: string; readonly radius?: number; readonly borderWidth?: number } = {}
): void {
  const radius = options.radius ?? 9;
  doc.roundedRect(x, y, w, h, radius).fillColor(options.fill ?? '#FFFFFF').fill();
  doc
    .roundedRect(x, y, w, h, radius)
    .lineWidth(options.borderWidth ?? 0.8)
    .strokeColor(options.border ?? REPORT_COLORS.border)
    .stroke();
}

/** Marca do logotipo: pino de mapa. */
export function drawPin(doc: Doc, x: number, y: number, size: number, color: string, hole: string): void {
  const r = size / 2;
  doc.save();
  doc.circle(x + r, y + r, r).fillColor(color).fill();
  doc
    .moveTo(x + r - r * 0.62, y + r + r * 0.55)
    .lineTo(x + r, y + size * 1.28)
    .lineTo(x + r + r * 0.62, y + r + r * 0.55)
    .closePath()
    .fillColor(color)
    .fill();
  doc.circle(x + r, y + r, r * 0.42).fillColor(hole).fill();
  doc.restore();
}

export interface ClassStyle {
  readonly label: string;
  readonly color: string;
  readonly bg: string;
}

export const CLASS_STYLES: Record<EvidenceClass, ClassStyle> = {
  VERIFIED: { label: 'COMPROVADO', color: REPORT_COLORS.verified, bg: REPORT_COLORS.verifiedBg },
  PARTIAL: { label: 'PARCIALMENTE VERIFICADO', color: REPORT_COLORS.partial, bg: REPORT_COLORS.partialBg },
  NOT_VERIFIED: { label: 'NÃO VERIFICADO', color: REPORT_COLORS.notVerified, bg: REPORT_COLORS.notVerifiedBg },
  SIMULATED: { label: 'SIMULADO', color: REPORT_COLORS.simulated, bg: REPORT_COLORS.simulatedBg },
};

/**
 * Ícone da classe de evidência, desenhado em vetor (a fonte não tem esses símbolos):
 * comprovado = círculo cheio com visto; não verificado = círculo tracejado vazio; simulado = círculo hachurado.
 */
export function drawClassIcon(doc: Doc, cls: EvidenceClass, cx: number, cy: number, r: number): void {
  const style = CLASS_STYLES[cls];
  doc.save();
  if (cls === 'VERIFIED') {
    doc.circle(cx, cy, r).fillColor(style.color).fill();
    doc
      .moveTo(cx - r * 0.5, cy + r * 0.02)
      .lineTo(cx - r * 0.12, cy + r * 0.42)
      .lineTo(cx + r * 0.55, cy - r * 0.38)
      .lineWidth(r * 0.34)
      .lineCap('round')
      .lineJoin('round')
      .strokeColor('#FFFFFF')
      .stroke();
  } else if (cls === 'PARTIAL') {
    // meio círculo cheio: comprovado em parte
    doc.circle(cx, cy, r).fillColor('#FFFFFF').fill();
    doc.circle(cx, cy, r - 0.4).lineWidth(0.9).strokeColor(style.color).stroke();
    const rr = r - 0.4;
    doc.path(`M ${cx} ${cy - rr} A ${rr} ${rr} 0 0 1 ${cx} ${cy + rr} Z`).fillColor(style.color).fill();
  } else if (cls === 'NOT_VERIFIED') {
    doc.circle(cx, cy, r).fillColor('#FFFFFF').fill();
    doc.circle(cx, cy, r - 0.4).lineWidth(0.9).dash(1.6, { space: 1.2 }).strokeColor(style.color).stroke();
    doc.undash();
    doc.circle(cx, cy, r * 0.16).fillColor(style.color).fill();
  } else {
    doc.circle(cx, cy, r).fillColor(style.bg).fill();
    doc.circle(cx, cy, r).clip();
    doc.lineWidth(0.8).strokeColor(style.color);
    for (let d = -2 * r; d <= 2 * r; d += r * 0.55) {
      doc.moveTo(cx + d - r, cy + r).lineTo(cx + d + r, cy - r).stroke();
    }
  }
  doc.restore();
  if (cls === 'SIMULATED') {
    doc.circle(cx, cy, r).lineWidth(0.8).strokeColor(style.color).stroke();
  }
}

/** Selo da classe de evidência (ícone + texto), devolve a largura ocupada. */
export function classBadge(canvas: Canvas, x: number, y: number, cls: EvidenceClass, label?: string): number {
  const style = CLASS_STYLES[cls];
  const text = label ?? style.label;
  const textStyle: TextStyle = { weight: 'semibold', size: 6.2, color: style.color, characterSpacing: 0.35 };
  const textWidth = canvas.width(text, textStyle);
  const width = textWidth + 22;
  canvas.doc.roundedRect(x, y, width, 13.5, 6.75).fillColor(style.bg).fill();
  drawClassIcon(canvas.doc, cls, x + 7.5, y + 6.75, 3.6);
  canvas.line(text, x + 14, y + 4.3, textStyle);
  return width;
}

export function chip(
  canvas: Canvas,
  x: number,
  y: number,
  text: string,
  options: { readonly color: string; readonly bg: string; readonly size?: number; readonly dashed?: boolean }
): number {
  const size = options.size ?? 6.6;
  const style: TextStyle = { weight: 'semibold', size, color: options.color, characterSpacing: 0.25 };
  const width = canvas.width(text, style) + 14;
  const height = size + 7.5;
  canvas.doc.roundedRect(x, y, width, height, height / 2).fillColor(options.bg).fill();
  if (options.dashed) {
    canvas.doc.roundedRect(x + 0.4, y + 0.4, width - 0.8, height - 0.8, height / 2).lineWidth(0.7).dash(2, { space: 1.5 }).strokeColor(options.color).stroke();
    canvas.doc.undash();
  }
  canvas.line(text, x + 7, y + 3.6, style);
  return width;
}

export function progressBar(doc: Doc, x: number, y: number, w: number, h: number, percent: number, color: string): void {
  const clamped = Math.max(0, Math.min(100, percent));
  doc.roundedRect(x, y, w, h, h / 2).fillColor('#E6ECF5').fill();
  if (clamped > 0) doc.roundedRect(x, y, Math.max(h, (w * clamped) / 100), h, h / 2).fillColor(color).fill();
}

export interface BarSegment {
  readonly value: number;
  readonly color: string;
  readonly hatched?: boolean;
}

/** Barra empilhada (cobertura de evidências por peso). */
export function stackedBar(doc: Doc, x: number, y: number, w: number, h: number, segments: readonly BarSegment[]): void {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return;
  doc.save();
  doc.roundedRect(x, y, w, h, h / 2).clip();
  doc.rect(x, y, w, h).fillColor('#E6ECF5').fill();
  let cursor = x;
  for (const segment of segments) {
    const width = (segment.value / total) * w;
    if (width <= 0) continue;
    doc.rect(cursor, y, width, h).fillColor(segment.color).fill();
    if (segment.hatched) {
      doc.save();
      doc.rect(cursor, y, width, h).clip();
      doc.lineWidth(0.7).strokeColor('#FFFFFF');
      for (let d = -h; d < width + h; d += 3.2) doc.moveTo(cursor + d, y + h).lineTo(cursor + d + h, y).stroke();
      doc.restore();
    }
    cursor += width;
  }
  doc.restore();
}

/** Título de seção com barra de destaque; avança o cursor. */
export function sectionHeading(canvas: Canvas, title: string, subtitle?: string): void {
  const needed = subtitle ? 44 : 30;
  canvas.ensure(needed + 30);
  const { doc } = canvas;
  doc.roundedRect(PAGE.marginX, canvas.y + 1, 3.2, subtitle ? 26 : 16, 1.6).fillColor(REPORT_COLORS.primary).fill();
  canvas.line(title, PAGE.marginX + 11, canvas.y, { weight: 'bold', size: 13.5, color: REPORT_COLORS.navy });
  canvas.y += 20;
  if (subtitle) {
    const h = canvas.paragraph(subtitle, PAGE.marginX + 11, canvas.y - 2, CONTENT_WIDTH - 11, {
      size: 8.4,
      color: REPORT_COLORS.muted,
    });
    canvas.y += h + 4;
  } else {
    canvas.y += 2;
  }
}

/** Lista com marcadores; devolve a altura total (não pagina: o chamador garante o espaço). */
export function measureBullets(canvas: Canvas, items: readonly string[], width: number, style: TextStyle): number {
  return items.reduce((sum, item) => sum + canvas.measure(item, width - 10, style) + 3.2, 0);
}

export function drawBullets(
  canvas: Canvas,
  items: readonly string[],
  x: number,
  y: number,
  width: number,
  style: TextStyle,
  dotColor: string = REPORT_COLORS.primary
): number {
  let cursor = y;
  for (const item of items) {
    const h = canvas.paragraph(item, x + 10, cursor, width - 10, style);
    canvas.doc.circle(x + 3, cursor + (style.size ?? 9) * 0.55, 1.5).fillColor(dotColor).fill();
    cursor += h + 3.2;
  }
  return cursor - y;
}

export { CONTENT_BOTTOM, CONTENT_WIDTH, PAGE, REPORT_COLORS };
