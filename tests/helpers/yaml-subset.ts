/**
 * Leitor de um SUBCONJUNTO estrito de YAML, só para os testes estáticos dos arquivos de implantação (workflow do deploy, stack e
 * sobreposição de homologação). O projeto não declara parser de YAML e não acrescenta dependências (P9.4): este leitor cobre só o
 * que esses arquivos usam e LANÇA erro no resto, para que uma construção nova não passe despercebida pelos testes.
 *
 * Suportado: mapas e listas em bloco (recuo por espaços), lista sem recuo sob uma chave, item de lista que abre um mapa
 * (`- chave: valor`), escalares simples, entre aspas simples ou duplas, blocos literais `|`/`|-`, coleções em fluxo de um nível
 * (`[a, b]`, `{ a: b }`) e comentários `#`. Recusado: tabulação no recuo, âncoras e aliases (`&`, `*`), tags (`!`), chaves
 * complexas (`?`), vários documentos (`---`), blocos dobrados (`>`), chave repetida e escalar simples com `: ` ou ` #` no meio.
 */
export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

export class YamlSubsetError extends Error {
  constructor(message: string, line: number) {
    super(`yaml-subset (linha ${line}): ${message}`);
    this.name = 'YamlSubsetError';
  }
}

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly no: number;
}

const PLAIN_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const DOUBLE_QUOTE_ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', n: '\n', t: '\t', '/': '/' };

export const isYamlMap = (value: YamlValue | undefined): value is YamlMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Lê o documento inteiro. */
export function parseYamlSubset(source: string): YamlValue {
  return new Parser(source.replace(/\r\n/g, '\n').split('\n')).parseDocument();
}

/** Posição do primeiro `#` que inicia comentário (fora de aspas, no início ou depois de espaço); -1 se não há. */
function commentStart(text: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === '"' && ch === '\\') {
      i++;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1] ?? ''))) return i;
  }
  return -1;
}

const stripComment = (text: string): string => {
  const at = commentStart(text);
  return (at < 0 ? text : text.slice(0, at)).trim();
};

/** Separa por vírgulas fora de aspas (coleção em fluxo de um nível). */
function splitFlow(inner: string, no: number): string[] {
  const parts: string[] = [];
  let quote: '"' | "'" | null = null;
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] ?? '';
    if (quote === '"' && ch === '\\') {
      current += ch + (inner[i + 1] ?? '');
      i++;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === '[' || ch === '{') throw new YamlSubsetError('coleção em fluxo aninhada não suportada', no);
    if (ch === ',') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote !== null) throw new YamlSubsetError('aspas não fechadas na coleção em fluxo', no);
  parts.push(current.trim());
  return parts;
}

function parseDoubleQuoted(text: string, no: number): string {
  let out = '';
  for (let i = 1; i < text.length - 1; i++) {
    const ch = text[i] ?? '';
    if (ch === '"') throw new YamlSubsetError('aspas duplas no meio do valor', no);
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const escaped = DOUBLE_QUOTE_ESCAPES[text[i + 1] ?? ''];
    if (escaped === undefined) throw new YamlSubsetError('escape não suportado entre aspas duplas', no);
    out += escaped;
    i++;
  }
  return out;
}

function parseSingleQuoted(text: string, no: number): string {
  const inner = text.slice(1, -1);
  if (inner.replace(/''/g, '').includes("'")) throw new YamlSubsetError('aspas simples no meio do valor', no);
  return inner.replace(/''/g, "'");
}

function parsePlain(text: string, no: number): YamlScalar {
  if (/^[&*!%@`|>?]/.test(text)) throw new YamlSubsetError(`indicador não suportado no início de "${text.slice(0, 20)}"`, no);
  if (/: |:$| #/.test(text)) throw new YamlSubsetError('escalar simples com ": " ou " #" (use aspas)', no);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** Escalar de uma linha (sem comentário): aspas, fluxo ou simples. */
function parseScalarText(text: string, no: number): YamlScalar {
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) throw new YamlSubsetError('aspas duplas não fechadas', no);
    return parseDoubleQuoted(text, no);
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) throw new YamlSubsetError('aspas simples não fechadas', no);
    return parseSingleQuoted(text, no);
  }
  return parsePlain(text, no);
}

function parseInline(raw: string, no: number): YamlValue {
  const text = stripComment(raw);
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new YamlSubsetError('lista em fluxo não fechada', no);
    const inner = text.slice(1, -1).trim();
    return inner === '' ? [] : splitFlow(inner, no).map((item) => parseScalarText(item, no));
  }
  if (text.startsWith('{')) {
    if (!text.endsWith('}')) throw new YamlSubsetError('mapa em fluxo não fechado', no);
    const inner = text.slice(1, -1).trim();
    const map: YamlMap = {};
    for (const entry of inner === '' ? [] : splitFlow(inner, no)) {
      const at = entry.search(/:(\s|$)/);
      if (at <= 0) throw new YamlSubsetError('entrada de mapa em fluxo sem "chave: valor"', no);
      const key = entry.slice(0, at).trim();
      if (!PLAIN_KEY.test(key) || Object.hasOwn(map, key)) throw new YamlSubsetError(`chave inválida ou repetida "${key}"`, no);
      map[key] = parseScalarText(entry.slice(at + 1).trim(), no);
    }
    return map;
  }
  return parseScalarText(text, no);
}

/** `chave: resto` (a chave sem aspas); null se o texto não é entrada de mapa. */
function splitEntry(text: string): { key: string; rest: string } | null {
  if (/^["'[{]/.test(text)) return null;
  const at = text.search(/:(\s|$)/);
  if (at <= 0) return null;
  const key = text.slice(0, at);
  return PLAIN_KEY.test(key) ? { key, rest: text.slice(at + 1).trim() } : null;
}

const isSeqItem = (text: string): boolean => text === '-' || text.startsWith('- ');

class Parser {
  private pos = 0;

  constructor(private readonly raw: readonly string[]) {}

  parseDocument(): YamlValue {
    const first = this.peek();
    if (first === null) return null;
    if (first.indent !== 0) throw new YamlSubsetError('o documento começa recuado', first.no);
    const value = this.parseBlock(0);
    const rest = this.peek();
    if (rest !== null) throw new YamlSubsetError('conteúdo fora da estrutura', rest.no);
    return value;
  }

  /** Próxima linha estrutural, sem consumir (pula linhas vazias e comentários). */
  private peek(): Line | null {
    while (this.pos < this.raw.length) {
      const line = this.raw[this.pos] ?? '';
      const trimmed = line.trim();
      if (trimmed !== '' && !trimmed.startsWith('#')) break;
      this.pos++;
    }
    if (this.pos >= this.raw.length) return null;
    const line = this.raw[this.pos] ?? '';
    const indent = line.length - line.trimStart().length;
    if (line.slice(0, indent).includes('\t')) throw new YamlSubsetError('tabulação no recuo', this.pos + 1);
    const text = line.slice(indent).trimEnd();
    if (text === '---' || text === '...' || text.startsWith('? ')) throw new YamlSubsetError(`construção não suportada "${text}"`, this.pos + 1);
    return { indent, text, no: this.pos + 1 };
  }

  private parseBlock(indent: number): YamlValue {
    const line = this.peek();
    if (line === null || line.indent !== indent) throw new YamlSubsetError('recuo inesperado', line?.no ?? this.raw.length);
    return isSeqItem(line.text) ? this.parseSequence(indent) : this.parseMapping(indent, null);
  }

  private parseSequence(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    for (let line = this.peek(); line !== null && line.indent === indent && isSeqItem(line.text); line = this.peek()) {
      this.pos++;
      const rest = line.text === '-' ? '' : line.text.slice(2).trim();
      if (rest === '') {
        const next = this.peek();
        items.push(next !== null && next.indent > indent ? this.parseBlock(next.indent) : null);
      } else if (splitEntry(rest) !== null) {
        items.push(this.parseMapping(indent + 2, { text: rest, no: line.no }));
      } else if (isSeqItem(rest) || /^[|>]/.test(rest)) {
        throw new YamlSubsetError('item de lista não suportado', line.no);
      } else {
        items.push(parseInline(rest, line.no));
      }
    }
    this.assertNoDeeper(indent);
    return items;
  }

  private parseMapping(indent: number, first: { text: string; no: number } | null): YamlMap {
    const map: YamlMap = {};
    if (first !== null) this.parseEntry(map, first.text, indent, first.no);
    for (let line = this.peek(); line !== null && line.indent === indent && !isSeqItem(line.text); line = this.peek()) {
      this.pos++;
      this.parseEntry(map, line.text, indent, line.no);
    }
    this.assertNoDeeper(indent);
    return map;
  }

  private assertNoDeeper(indent: number): void {
    const next = this.peek();
    if (next !== null && next.indent > indent) throw new YamlSubsetError('recuo inesperado', next.no);
  }

  private parseEntry(map: YamlMap, text: string, indent: number, no: number): void {
    const entry = splitEntry(text);
    if (entry === null) throw new YamlSubsetError(`linha não é "chave: valor": "${text.slice(0, 40)}"`, no);
    if (Object.hasOwn(map, entry.key)) throw new YamlSubsetError(`chave repetida "${entry.key}"`, no);
    map[entry.key] = this.parseValue(stripComment(entry.rest), indent, no);
  }

  private parseValue(rest: string, indent: number, no: number): YamlValue {
    if (rest === '|' || rest === '|-') return this.parseLiteral(indent, rest === '|-');
    if (rest.startsWith('|') || rest.startsWith('>')) throw new YamlSubsetError(`bloco "${rest}" não suportado`, no);
    if (rest !== '') return parseInline(rest, no);
    const next = this.peek();
    if (next === null) return null;
    if (next.indent > indent) return this.parseBlock(next.indent);
    if (next.indent === indent && isSeqItem(next.text)) return this.parseSequence(indent);
    return null;
  }

  /** Bloco literal: linhas vazias ou mais recuadas que a chave; o recuo do conteúdo é o da primeira linha não vazia. */
  private parseLiteral(keyIndent: number, strip: boolean): string {
    const lines: string[] = [];
    while (this.pos < this.raw.length) {
      const line = this.raw[this.pos] ?? '';
      if (line.trim() !== '' && line.length - line.trimStart().length <= keyIndent) break;
      lines.push(line);
      this.pos++;
    }
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
    const firstContent = lines.find((line) => line.trim() !== '') ?? '';
    const contentIndent = firstContent.length - firstContent.trimStart().length;
    const body = lines.map((line) => (line.trim() === '' ? '' : line.slice(contentIndent))).join('\n');
    return strip || body === '' ? body : `${body}\n`;
  }
}
