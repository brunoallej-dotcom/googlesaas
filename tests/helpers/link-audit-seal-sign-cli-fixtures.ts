import { createCipheriv, generateKeyPairSync, pbkdf2Sync, randomBytes, scryptSync, type KeyObject } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { runSealCli } from '../../scripts/link-audit-seal';
import type { BytesFsOps } from '../../src/lib/link-audit/snapshot-store';
import type { CandidatePackage } from '../../src/lib/link-audit-attestation';
import type { KeyFileOps } from '../../src/lib/link-audit-attestation/sign-key';
import { tmpDir } from './link-audit-evidence-fixtures';
import { AUD, CONFIRM_LENGTH, E1, makePackage, NOW, writeStation, type StationFiles } from './link-audit-seal-sign-disk-fixtures';

/*
 * Fixtures da W4.4 (CLI do `sign`, papéis e chave K1). Dados 100% FICTÍCIOS em pastas temporárias. A chave é GERADA em memória a cada chamada
 * (nunca chave real, nunca texto de chave no repositório) e gravada CIFRADA (PKCS#8, frase de teste) numa pasta temporária 0700, arquivo 0600.
 * O terminal é FALSO: entrega o que o "custodiante digita" só quando o `sign` lê, registra o modo bruto (eco desligado) em cada entrega e
 * guarda como "eco" tudo o que chegasse com o modo bruto desligado (o que um terminal de verdade mostraria na tela).
 */

export const ROOT = path.join(__dirname, '..', '..');
export const KEY_ID = 'ek-teste-cli-a';
export const PASSPHRASE = 'frase de teste W4.4 — sentinela çãõ 7f3a9c';
export const CUSTODIAN = 'CUST-01';

/* ------------------------------------------------------------------------------------------------------------------- chave de teste */

export interface TestKeyFile {
  readonly dir: string;
  readonly keyPath: string;
  readonly keyId: string;
  /** `--trust-keys`: só esta chave, ativa (formato com estado do contrato v2). */
  readonly ring: string;
  readonly publicRaw: string;
  readonly privateKey: KeyObject;
  readonly passphrase: string;
  /** Todas as formas da PRIVADA e da frase que nunca podem aparecer em saída, argv, ambiente nem arquivo gravado (IA-04). */
  readonly sentinels: readonly string[];
}

export type KeyContent = 'encrypted' | 'plain-pem' | 'plain-der' | 'plain-jwk' | 'empty-passphrase' | 'legacy-cipher' | 'public-only' | 'ec-encrypted' | 'garbage' | 'pbkdf2-strong' | 'scrypt-weak';

/** Iterações do PBKDF2 da chave "forte" das fixtures (igual ao mínimo provisório do `sign`): sem aviso de KDF. */
export const STRONG_PBKDF2_ITERATIONS = 600_000;
/** Custo N do scrypt da chave "fraca" das fixtures (abaixo do mínimo provisório): o `sign` avisa. */
export const WEAK_SCRYPT_COST = 16_384;

export interface KeyFileOptions {
  readonly dir?: string;
  readonly fileName?: string;
  readonly content?: KeyContent;
  readonly passphrase?: string;
  readonly keyId?: string;
  readonly fileMode?: number;
  readonly dirMode?: number;
}

const PBES2_OID = Buffer.from('06092a864886f70d01050d', 'hex');
/** pbeWithSHA1AndDES-CBC (PBES1, legado): mesmo comprimento do OID do PBES2, então trocar o último byte mantém o DER bem formado. */
const PBES1_OID = Buffer.from('06092a864886f70d01050a', 'hex');

/** A PRIVADA em PEM cifrado (PBES2) com o OID trocado por PBES1: uma cifra legada que o `sign` recusa sem pedir a frase. */
function legacyCipherPem(privateKey: KeyObject, passphrase: string): string {
  const der = privateKey.export({ format: 'der', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase });
  const at = der.indexOf(PBES2_OID);
  if (at < 0) throw new Error('fixture: OID do PBES2 não encontrado');
  PBES1_OID.copy(der, at);
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${body}\n-----END ENCRYPTED PRIVATE KEY-----\n`;
}

/* PKCS#8 cifrado MONTADO À MÃO (PBES2 com PBKDF2-HMAC-SHA256 ou scrypt, AES-256-CBC), para escolher o custo do KDF, que a exportação do Node não deixa
 * escolher (ela usa PBKDF2 com 2048 iterações). O Node abre o resultado com a frase (conferido nos testes). */
const derOf = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const lengthBytes: number[] = [];
  for (let n = body.length; n > 0; n = Math.floor(n / 256)) lengthBytes.unshift(n % 256);
  const length = body.length < 0x80 ? Buffer.from([body.length]) : Buffer.from([0x80 | lengthBytes.length, ...lengthBytes]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const derInteger = (value: number): Buffer => {
  const bytes: number[] = [];
  let n = value;
  do {
    bytes.unshift(n % 256);
    n = Math.floor(n / 256);
  } while (n > 0);
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0);
  return derOf(0x02, Buffer.from(bytes));
};
const oid = (hex: string): Buffer => Buffer.from(hex, 'hex');
const OID_PBES2 = '06092a864886f70d01050d';
const OID_PBKDF2 = '06092a864886f70d01050c';
const OID_HMAC_SHA256 = '06082a864886f70d0209';
const OID_SCRYPT = '06092b06010401da47040b';
const OID_AES256_CBC = '060960864801650304012a';
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;

export function pbes2Pem(privateKey: KeyObject, passphrase: string, kdf: { readonly kind: 'pbkdf2'; readonly iterations: number } | { readonly kind: 'scrypt'; readonly cost: number }): string {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const phrase = Buffer.from(passphrase, 'utf8');
  const derived = kdf.kind === 'pbkdf2' ? pbkdf2Sync(phrase, salt, kdf.iterations, 32, 'sha256') : scryptSync(phrase, salt, 32, { N: kdf.cost, r: 8, p: 1, maxmem: SCRYPT_MAX_MEMORY });
  const kdfDer =
    kdf.kind === 'pbkdf2'
      ? derOf(0x30, oid(OID_PBKDF2), derOf(0x30, derOf(0x04, salt), derInteger(kdf.iterations), derOf(0x30, oid(OID_HMAC_SHA256), oid('0500'))))
      : derOf(0x30, oid(OID_SCRYPT), derOf(0x30, derOf(0x04, salt), derInteger(kdf.cost), derInteger(8), derInteger(1), derInteger(32)));
  const cipher = createCipheriv('aes-256-cbc', derived, iv);
  const encrypted = Buffer.concat([cipher.update(privateKey.export({ format: 'der', type: 'pkcs8' })), cipher.final()]);
  const info = derOf(0x30, derOf(0x30, oid(OID_PBES2), derOf(0x30, kdfDer, derOf(0x30, oid(OID_AES256_CBC), derOf(0x04, iv)))), derOf(0x04, encrypted));
  return `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${info.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()}\n-----END ENCRYPTED PRIVATE KEY-----\n`;
}

function keyBytes(content: KeyContent, privateKey: KeyObject, passphrase: string): Buffer {
  switch (content) {
    case 'encrypted':
      return Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase }));
    case 'empty-passphrase':
      return Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: '' }));
    case 'legacy-cipher':
      return Buffer.from(legacyCipherPem(privateKey, passphrase));
    case 'plain-pem':
      return Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' }));
    case 'plain-der':
      return privateKey.export({ format: 'der', type: 'pkcs8' });
    case 'plain-jwk':
      return Buffer.from(JSON.stringify(privateKey.export({ format: 'jwk' })));
    case 'public-only':
      return Buffer.from(String(generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' })));
    case 'ec-encrypted':
      return Buffer.from(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase }));
    case 'garbage':
      return Buffer.from('isto não é uma chave (fictício)\n');
    case 'pbkdf2-strong':
      return Buffer.from(pbes2Pem(privateKey, passphrase, { kind: 'pbkdf2', iterations: STRONG_PBKDF2_ITERATIONS }));
    case 'scrypt-weak':
      return Buffer.from(pbes2Pem(privateKey, passphrase, { kind: 'scrypt', cost: WEAK_SCRYPT_COST }));
  }
}

/** Formas da privada (semente e PKCS#8 em hex/base64/base64url/PEM) e da frase, para a varredura da IA-04. */
function sentinelsOf(privateKey: KeyObject, passphrase: string): string[] {
  const seed = Buffer.from(String(privateKey.export({ format: 'jwk' }).d), 'base64url');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  const pemBody = String(privateKey.export({ format: 'pem', type: 'pkcs8' })).split('\n').filter((line) => line && !line.startsWith('-----'));
  const phrase = Buffer.from(passphrase, 'utf8');
  return [
    ...[seed, der].flatMap((bytes) => [bytes.toString('hex'), bytes.toString('base64'), bytes.toString('base64url')]),
    ...pemBody,
    passphrase,
    phrase.toString('hex'),
    phrase.toString('base64'),
    'frase de teste W4.4',
  ];
}

/** Gera um par Ed25519 em memória e grava a privada (cifrada por padrão) em `<dir>/custodia.pem`: pasta 0700, arquivo 0600. */
export function makeKeyFile(options: KeyFileOptions = {}): TestKeyFile {
  const dir = options.dir ?? tmpDir('lasc-key-');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, options.dirMode ?? 0o700);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const passphrase = options.passphrase ?? PASSPHRASE;
  const keyPath = path.join(dir, options.fileName ?? 'custodia.pem');
  fs.writeFileSync(keyPath, keyBytes(options.content ?? 'encrypted', privateKey, passphrase), { mode: 0o600 });
  fs.chmodSync(keyPath, options.fileMode ?? 0o600);
  const keyId = options.keyId ?? KEY_ID;
  const publicRaw = String(publicKey.export({ format: 'jwk' }).x);
  return { dir, keyPath, keyId, ring: `${keyId}:${publicRaw}:active`, publicRaw, privateKey, passphrase, sentinels: sentinelsOf(privateKey, passphrase) };
}

/* ------------------------------------------------------------------------------------------------------------------- terminal falso */

export type Typed = string | { readonly kind: 'end' } | { readonly kind: 'error'; readonly message: string };

/**
 * Terminal FALSO (o `process.stdin` de um TTY): entrega UM item digitado por leitura (só quando há ouvinte de `data` e o fluxo foi retomado) e,
 * sem nada mais digitado, sinaliza fim (EOF) em vez de travar o teste.
 */
export class FakeTerminal extends EventEmitter {
  isTTY: boolean | undefined;
  isRaw = false;
  readonly rawCalls: boolean[] = [];
  /** O que um terminal de verdade mostraria por ECO: tudo o que chegou com o modo bruto DESLIGADO. */
  readonly echoed: string[] = [];
  readonly deliveries: Array<{ readonly text: string; readonly raw: boolean; readonly screen: string }> = [];
  private flowing = false;
  private readonly queue: Typed[];
  private readonly screen: () => string;
  readonly setRawMode: ((mode: boolean) => this) | undefined;

  constructor(typed: readonly Typed[], screen: () => string = () => '', options: { readonly isTTY?: boolean; readonly rawMode?: 'ok' | 'missing' | 'ignored' } = {}) {
    super();
    this.queue = [...typed];
    this.screen = screen;
    this.isTTY = options.isTTY ?? true;
    const rawMode = options.rawMode ?? 'ok';
    this.setRawMode =
      rawMode === 'missing'
        ? undefined
        : (mode: boolean): this => {
            this.rawCalls.push(mode);
            if (rawMode === 'ok') this.isRaw = mode;
            return this;
          };
  }

  resume(): this {
    this.flowing = true;
    setImmediate(() => this.pump());
    return this;
  }

  pause(): this {
    this.flowing = false;
    return this;
  }

  /** Quantos itens o `sign` chegou a ler. */
  get reads(): number {
    return this.deliveries.length;
  }

  private pump(): void {
    if (!this.flowing || this.listenerCount('data') === 0) return;
    const next = this.queue.shift();
    if (next === undefined || (typeof next === 'object' && next.kind === 'end')) {
      this.emit('end');
      return;
    }
    if (typeof next === 'object') {
      this.emit('error', new Error(next.message));
      return;
    }
    if (!this.isRaw) this.echoed.push(next);
    this.deliveries.push({ text: next, raw: this.isRaw, screen: this.screen() });
    this.emit('data', Buffer.from(next, 'utf8'));
    if (this.flowing) setImmediate(() => this.pump());
  }
}

/* ------------------------------------------------------------------------------------------------------------------- estação e execução */

export interface CliWorld {
  readonly station: StationFiles;
  readonly sealsDir: string;
  readonly key: TestKeyFile;
  readonly pkg: CandidatePackage;
  /** O que o custodiante digita no passo 11: os 12 primeiros caracteres do `packageSha256` APROVADO, lidos no dossiê. */
  readonly confirmation: string;
  argv(over?: Readonly<Record<string, string | null>>, extra?: readonly string[]): string[];
  /** Digitação padrão: a confirmação e depois a frase (cada uma com Enter). */
  typed(): Typed[];
}

/** Estação nova (pacote, aprovação, dossiê), pasta de manifestos vazia e chave cifrada própria. */
export function cliWorld(files: Parameters<typeof writeStation>[1] = {}, keyOptions: KeyFileOptions = {}): CliWorld {
  const pkg = files.pkg ?? makePackage(files.entries ?? E1);
  const station = writeStation(tmpDir('lasc-st-'), { ...files, pkg });
  const sealsDir = tmpDir('lasc-seals-');
  const key = makeKeyFile(keyOptions);
  const confirmation = pkg.packageSha256.slice(0, CONFIRM_LENGTH);
  const base = (): Array<[string, string | true]> => [
    ['audit', AUD],
    ['package', station.packagePath],
    ['approval', station.approvalPath],
    ['dossier', station.dossierPath],
    ...(station.riskAcceptancePath ? ([['risk-acceptance', station.riskAcceptancePath]] as Array<[string, string]>) : []),
    ['seals-dir', sealsDir],
    ['expect-seq', '1'],
    ['first', true],
    ['key-id', key.keyId],
    ['key-source', `file:${key.keyPath}`],
    ['custodian', CUSTODIAN],
    ['trust-keys', key.ring],
  ];
  return {
    station,
    sealsDir,
    key,
    pkg,
    confirmation,
    argv(over = {}, extra = []) {
      const pairs = base().filter(([name]) => !(name in over) || over[name] !== null);
      const merged = pairs.map(([name, value]): [string, string | true] => [name, name in over && over[name] !== null ? (over[name] as string) : value]);
      for (const [name, value] of Object.entries(over)) if (value !== null && !merged.some(([existing]) => existing === name)) merged.push([name, value]);
      return [...merged.flatMap(([name, value]) => (value === true ? [`--${name}`] : [`--${name}`, value])), ...extra];
    },
    typed: () => [`${confirmation}\r`, `${key.passphrase}\r`],
  };
}

export interface SignCliRun {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly terminal: FakeTerminal;
  readonly report: { reportOnFatalError: boolean; reportOnSignal: boolean; reportOnUncaughtException: boolean };
}

export interface SignCliOptions {
  readonly typed?: readonly Typed[];
  readonly terminal?: FakeTerminal;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Padrão: nenhuma (as pastas de teste ficam em os.tmpdir(), que a custódia recusa por padrão). `undefined` explícito em `defaults`. */
  readonly tempRoots?: readonly string[];
  readonly defaultTempRoots?: boolean;
  readonly projectRoot?: string | null;
  readonly fs?: BytesFsOps;
  readonly keyFs?: KeyFileOps;
  readonly now?: Date;
  readonly out?: (line: string) => void;
}

/** `npm run link-audit:seal -- sign …` em processo, com terminal falso, ambiente vazio e relatórios de diagnóstico falsos (todos ligados). */
export async function runSign(argv: readonly string[], options: SignCliOptions = {}): Promise<SignCliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const screen = (): string => [...err, ...out].join('\n');
  const terminal = options.terminal ?? new FakeTerminal(options.typed ?? [], screen);
  const report = { reportOnFatalError: true, reportOnSignal: true, reportOnUncaughtException: true };
  const sign = {
    terminal,
    env: options.env ?? {},
    report,
    ...(options.defaultTempRoots ? {} : { tempRoots: options.tempRoots ?? [] }),
    ...(options.fs ? { fs: options.fs } : {}),
    ...(options.keyFs ? { keyFs: options.keyFs } : {}),
  };
  const code = await runSealCli(
    ['sign', ...argv],
    (line) => {
      out.push(line);
      options.out?.(line);
    },
    (line) => err.push(line),
    () => new Date((options.now ?? new Date(NOW)).getTime()),
    { ...(options.projectRoot === null ? {} : { projectRoot: options.projectRoot ?? ROOT }), sign },
  );
  return { code, out, err, stdout: out.join('\n'), stderr: err.join('\n'), terminal, report };
}

/** O único objeto JSON da saída padrão (`--json`). */
export function jsonOut(run: SignCliRun): Record<string, unknown> {
  if (run.out.length !== 1) throw new Error(`--json deve imprimir exatamente uma linha (veio ${run.out.length}): ${run.stdout}`);
  return JSON.parse(run.out[0] ?? '') as Record<string, unknown>;
}

export const sealFile = (sealsDir: string, seq = 1, auditId = AUD): string => path.join(sealsDir, auditId, `seal-${String(seq).padStart(4, '0')}.json`);

/** Todos os arquivos (caminho relativo) abaixo de `dir`, para conferir que nada novo apareceu. */
export function treeOf(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]).sort();
}

/** Conteúdo de todos os arquivos comuns abaixo de `dir` (bytes como latin1, para a varredura de sentinelas). */
export function contentsOf(dir: string): string {
  return treeOf(dir)
    .map((rel) => path.join(dir, rel))
    .filter((file) => fs.lstatSync(file).isFile())
    .map((file) => fs.readFileSync(file).toString('latin1') + fs.readFileSync(file).toString('utf8'))
    .join('\n');
}

export { AUD, CONFIRM_LENGTH, E1, makePackage, NOW };
