import { gunzipSync } from 'node:zlib';

/**
 * Decodificador mínimo de tiles vetoriais Mapbox (MVT, protobuf), sem dependências.
 * Especificação: https://github.com/mapbox/vector-tile-spec (versões 1 e 2).
 */

export type MvtValue = string | number | boolean;
export type MvtPoint = readonly [number, number];

export interface MvtFeature {
  /** 1 = pontos, 2 = linhas, 3 = polígonos. */
  readonly type: 1 | 2 | 3;
  readonly properties: Readonly<Record<string, MvtValue>>;
  /** Pontos: cada item tem 1 ponto. Linhas: cada item é uma linha. Polígonos: cada item é um anel. */
  readonly geometry: readonly (readonly MvtPoint[])[];
}

export interface MvtLayer {
  readonly name: string;
  readonly extent: number;
  readonly features: readonly MvtFeature[];
}

export type MvtTile = Readonly<Record<string, MvtLayer>>;

class Reader {
  public pos: number;

  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    private readonly end: number = buf.length
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.end) throw new Error('MVT: fim inesperado ao ler varint');
      const byte = this.buf[this.pos++] as number;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error('MVT: varint longo demais');
    }
  }

  /** Inteiro de 64 bits com sinal (complemento de dois) em BigInt. */
  varintBig(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.end) throw new Error('MVT: fim inesperado ao ler varint');
      const byte = this.buf[this.pos++] as number;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error('MVT: varint longo demais');
    }
  }

  bytes(): Uint8Array {
    const length = this.varint();
    const start = this.pos;
    this.pos += length;
    if (this.pos > this.end) throw new Error('MVT: campo maior que o buffer');
    return this.buf.subarray(start, start + length);
  }

  string(): string {
    return Buffer.from(this.bytes()).toString('utf8');
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2:
        this.bytes();
        break;
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`MVT: tipo de fio desconhecido ${wireType}`);
    }
  }

  fixed32(): number {
    const value = Buffer.from(this.buf.subarray(this.pos, this.pos + 4)).readFloatLE(0);
    this.pos += 4;
    return value;
  }

  fixed64(): number {
    const value = Buffer.from(this.buf.subarray(this.pos, this.pos + 8)).readDoubleLE(0);
    this.pos += 8;
    return value;
  }
}

function zigzag(n: number): number {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

function readValue(bytes: Uint8Array): MvtValue {
  const reader = new Reader(bytes);
  let value: MvtValue = '';
  while (!reader.done) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    switch (field) {
      case 1:
        value = reader.string();
        break;
      case 2:
        value = reader.fixed32();
        break;
      case 3:
        value = reader.fixed64();
        break;
      case 4:
        value = Number(BigInt.asIntN(64, reader.varintBig()));
        break;
      case 5:
        value = Number(reader.varintBig());
        break;
      case 6: {
        const raw = reader.varintBig();
        value = Number((raw >> 1n) ^ -(raw & 1n));
        break;
      }
      case 7:
        value = reader.varint() !== 0;
        break;
      default:
        reader.skip(wire);
    }
  }
  return value;
}

function decodeGeometry(commands: readonly number[], type: 1 | 2 | 3): MvtPoint[][] {
  const result: MvtPoint[][] = [];
  let current: MvtPoint[] = [];
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < commands.length) {
    const header = commands[i++] as number;
    const command = header & 7;
    const count = Math.floor(header / 8);
    if (command === 1 || command === 2) {
      for (let k = 0; k < count; k++) {
        x += zigzag(commands[i++] as number);
        y += zigzag(commands[i++] as number);
        if (command === 1) {
          if (type === 1) {
            result.push([[x, y]]);
            continue;
          }
          if (current.length > 0) result.push(current);
          current = [[x, y]];
        } else {
          current.push([x, y]);
        }
      }
    } else if (command === 7) {
      const first = current[0];
      if (first) current.push(first);
    } else {
      throw new Error(`MVT: comando de geometria inválido ${command}`);
    }
  }
  if (type !== 1 && current.length > 0) result.push(current);
  return result;
}

function decodeFeature(bytes: Uint8Array, keys: readonly string[], values: readonly MvtValue[]): MvtFeature {
  const reader = new Reader(bytes);
  let type: 1 | 2 | 3 = 1;
  const tags: number[] = [];
  const commands: number[] = [];

  while (!reader.done) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 3) {
      const t = reader.varint();
      if (t === 1 || t === 2 || t === 3) type = t;
    } else if (field === 2 || field === 4) {
      const packed = new Reader(reader.bytes());
      const target = field === 2 ? tags : commands;
      while (!packed.done) target.push(packed.varint());
    } else {
      reader.skip(wire);
    }
  }

  const properties: Record<string, MvtValue> = {};
  for (let i = 0; i + 1 < tags.length; i += 2) {
    const key = keys[tags[i] as number];
    const value = values[tags[i + 1] as number];
    if (key !== undefined && value !== undefined) properties[key] = value;
  }
  return { type, properties, geometry: decodeGeometry(commands, type) };
}

function decodeLayer(bytes: Uint8Array): MvtLayer {
  const reader = new Reader(bytes);
  let name = '';
  let extent = 4096;
  const keys: string[] = [];
  const values: MvtValue[] = [];
  const rawFeatures: Uint8Array[] = [];

  while (!reader.done) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    switch (field) {
      case 1:
        name = reader.string();
        break;
      case 2:
        rawFeatures.push(reader.bytes());
        break;
      case 3:
        keys.push(reader.string());
        break;
      case 4:
        values.push(readValue(reader.bytes()));
        break;
      case 5:
        extent = reader.varint();
        break;
      default:
        reader.skip(wire);
    }
  }
  return { name, extent, features: rawFeatures.map((raw) => decodeFeature(raw, keys, values)) };
}

/** Decodifica um tile (aceita conteúdo comprimido com gzip). */
export function decodeVectorTile(input: Uint8Array): MvtTile {
  const buffer = input.length > 2 && input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input;
  const reader = new Reader(buffer);
  const layers: Record<string, MvtLayer> = {};
  while (!reader.done) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 3) {
      const layer = decodeLayer(reader.bytes());
      layers[layer.name] = layer;
    } else {
      reader.skip(wire);
    }
  }
  return layers;
}
