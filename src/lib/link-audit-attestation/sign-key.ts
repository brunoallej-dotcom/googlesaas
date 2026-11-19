import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { SignRefusal, SignRefusalCode } from './sign-core';

/*
 * P1 W4.4 — a CHAVE K1 do `sign` (spec §8 K1, decisão D11; §5.5 passo 12; §5.5.1 itens 1 e 2; IA-04, IA-22; RS-11, RS-12, RS-13). O arquivo de
 * `--key-source file:<caminho>` é uma chave PKCS#8 CIFRADA (PEM `ENCRYPTED PRIVATE KEY`, PBES2) aberta com a frase digitada no terminal (porta
 * injetada `passphrase`, nunca argv nem ambiente). Antes de pedir a frase, a CUSTÓDIA do arquivo (IA-22): fora de qualquer árvore com `.git`, fora
 * do projeto, fora das pastas temporárias, sem link simbólico, arquivo 0600 numa pasta 0700, e cifrado. Só LEITURA do disco: um `open` sem seguir
 * link e sem travar em FIFO; tipo, permissão e tamanho conferidos no descritor. Qualquer falha é recusa com código e mensagem FIXOS (sem caminho,
 * sem conteúdo, sem o objeto de erro: RS-13). Limite declarado: o Node não zera um `KeyObject`; os buffers da frase e do arquivo são zerados.
 */

export type KeySource = { readonly kind: 'file'; readonly path: string } | { readonly kind: 'external'; readonly id: string };

const FILE_PREFIX = 'file:';
const EXTERNAL_PREFIX = 'external:';
/** `file:<caminho>` (K1) ou `external:<id>` (K2, recusado nesta W4); qualquer outra coisa ⇒ `null` (quem chama decide a recusa, sem ecoar). */
export function parseKeySource(value: string): KeySource | 'BAD_FILE_PATH' | null {
  if (value.startsWith(FILE_PREFIX)) {
    const target = value.slice(FILE_PREFIX.length);
    return target.length > 0 && !target.includes('\0') ? { kind: 'file', path: target } : 'BAD_FILE_PATH';
  }
  if (value.startsWith(EXTERNAL_PREFIX)) return { kind: 'external', id: value.slice(EXTERNAL_PREFIX.length) };
  return null;
}

/* ------------------------------------------------------------------------------------------------------------------- disco (só leitura) */

export interface KeyFileInfo {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly mode: number;
}
export interface KeyFileRead {
  readonly bytes: Buffer;
  readonly mode: number;
}
/** O que a custódia e a abertura usam do disco. Injetável nos testes; nada aqui escreve. */
export interface KeyFileOps {
  lstat(target: string): Promise<KeyFileInfo>;
  realpath(target: string): Promise<string>;
  /** Lê o arquivo sem seguir link e sem travar em FIFO; tipo, permissão e tamanho do DESCRITOR; recusa acima de `maxBytes`. */
  readKeyFile(target: string, maxBytes: number): Promise<KeyFileRead>;
}

class KeyFileError extends Error {
  readonly code: 'ENOTFILE' | 'ETOOBIG' | 'ECHANGED';
  constructor(code: 'ENOTFILE' | 'ETOOBIG' | 'ECHANGED') {
    super(`arquivo de chave recusado (${code})`);
    this.name = 'KeyFileError';
    this.code = code;
  }
}

export const nodeKeyFileOps: KeyFileOps = {
  lstat: (target) => fsPromises.lstat(target),
  realpath: (target) => fsPromises.realpath(target),
  async readKeyFile(target, maxBytes) {
    const { constants } = fsPromises;
    const handle = await fsPromises.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new KeyFileError('ENOTFILE');
      if (info.size > maxBytes) throw new KeyFileError('ETOOBIG');
      // `size + 1`: um byte a mais denuncia um arquivo que cresceu depois do fstat (falha fechada); Buffer.alloc (zerado, fora do pool)
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > info.size) {
        buffer.fill(0);
        throw new KeyFileError('ECHANGED');
      }
      return { bytes: buffer.subarray(0, length), mode: info.mode };
    } finally {
      await handle.close();
    }
  },
};

/* ------------------------------------------------------------------------------------------------------------------- recusas (texto fixo) */

const NOTHING_SIGNED = 'A chave não foi aberta. Nada foi assinado.';
const refuse = (code: SignRefusalCode, message: string): SignRefusal => ({ ok: false, code, message: `${message} ${NOTHING_SIGNED}` });
const unsafe = (why: string): SignRefusal => refuse('SECRET_PATH_UNSAFE', `Custódia insegura do arquivo da chave: ${why} (RS-12).`);

const UNSAFE_PROJECT = unsafe('está dentro da árvore do projeto');
const UNSAFE_TEMP = unsafe('está numa pasta temporária (os.tmpdir(), /tmp, /var/tmp ou /dev/shm)');
const UNSAFE_GIT = unsafe('está numa árvore com .git (repositório) em alguma pasta acima dele');
const UNSAFE_SYMLINK = unsafe('o caminho é um link simbólico');
const UNSAFE_FILE_MODE = unsafe('o arquivo não tem permissão exatamente 0600');
const UNSAFE_DIR_MODE = unsafe('a pasta do arquivo não tem permissão exatamente 0700');
const UNPROVABLE = unsafe('não foi possível conferir o caminho (erro ao inspecionar uma pasta acima do arquivo)');
const NOT_ENCRYPTED = refuse('SECRET_NOT_ENCRYPTED', 'O arquivo da chave está em TEXTO CLARO (chave privada sem cifra): trate-a como exposta, gere/cifre outra numa estação limpa (PKCS#8 com frase) e destrua a cópia em claro.');
const UNPROTECTED_EMPTY = refuse('SIGN_KEY_UNPROTECTED', 'A chave cifrada abre com frase VAZIA: está sem proteção.');
const UNPROTECTED_LEGACY = refuse('SIGN_KEY_UNPROTECTED', 'A chave usa cifra legada (não PBES2): proteção insuficiente; recifre-a em PKCS#8 com PBES2.');
const REJECTED_UNREADABLE = refuse('SIGN_KEY_REJECTED', 'O arquivo da chave não pôde ser lido como arquivo comum (inexistente, diretório, especial ou ilegível).');
const REJECTED_TOO_BIG = refuse('SIGN_KEY_REJECTED', 'O arquivo da chave é grande demais para uma chave Ed25519 cifrada.');
const REJECTED_FORMAT = refuse('SIGN_KEY_REJECTED', 'Formato de chave não suportado: o sign aceita só PKCS#8 cifrado em PEM (BEGIN ENCRYPTED PRIVATE KEY).');
const REJECTED_PASSPHRASE = refuse('SIGN_KEY_REJECTED', 'A frase não abre a chave (frase errada ou arquivo corrompido). Rode o sign de novo para tentar outra vez.');
const REJECTED_EMPTY_PASSPHRASE = refuse('SIGN_KEY_REJECTED', 'Frase vazia.');
const REJECTED_NO_PASSPHRASE = refuse('SIGN_KEY_REJECTED', 'A frase não foi obtida (sem terminal interativo, entrada interrompida ou falha do terminal).');
const REJECTED_NOT_ED25519 = refuse('SIGN_KEY_REJECTED', 'A chave aberta não é Ed25519.');
const REJECTED_UNEXPECTED = refuse('SIGN_KEY_REJECTED', 'Falha inesperada ao abrir a chave.');

/* ------------------------------------------------------------------------------------------------------------------- custódia (IA-22) */

/** Teto do arquivo de chave: uma Ed25519 cifrada em PEM tem menos de 1 KiB. */
export const MAX_KEY_FILE_BYTES = 16 * 1024;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const PERMISSION_BITS = 0o7777;
const FIXED_TEMP_ROOTS = ['/tmp', '/var/tmp', '/dev/shm'];

export interface KeyCustody {
  /** Raiz do projeto: a chave nunca pode estar dentro dela. */
  readonly projectRoot: string;
  /** Pastas temporárias proibidas (padrão: `defaultTempRoots`). */
  readonly tempRoots: readonly string[];
}

/**
 * As pastas temporárias proibidas: o que `os.tmpdir()` devolveria (TMPDIR, TMP, TEMP) e, sempre, `/tmp`, `/var/tmp` e `/dev/shm`. Um superconjunto
 * de `os.tmpdir()` sem importar `node:os` (fora da lista de imports do artefato, §5.5.1 item 7). Lê do ambiente SÓ estes três valores.
 */
export function defaultTempRoots(env: Readonly<Record<string, string | undefined>>): string[] {
  const fromEnv = ['TMPDIR', 'TMP', 'TEMP'].map((name) => env[name]).filter((value): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0'));
  return [...new Set([...fromEnv, ...FIXED_TEMP_ROOTS].map((dir) => path.resolve(dir)))];
}

const isInside = (child: string, root: string): boolean => {
  const relative = path.relative(root, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const errorCode = (error: unknown): unknown => (typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined);

/** Cada raiz pelo caminho dado E pelo caminho real (quando existe): um link no caminho da raiz não a esconde. */
async function bothForms(fs: KeyFileOps, roots: readonly string[]): Promise<string[]> {
  const forms: string[] = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    forms.push(resolved);
    try {
      forms.push(await fs.realpath(resolved));
    } catch {
      // raiz inexistente (ex.: /dev/shm ausente): basta a forma dada
    }
  }
  return forms;
}

/** Algum `.git` (pasta OU arquivo, como o de um worktree) numa pasta acima do arquivo ⇒ recusa; erro que não seja "não existe" ⇒ não provado. */
async function gitAncestorRefusal(fs: KeyFileOps, file: string): Promise<SignRefusal | null> {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    try {
      await fs.lstat(path.join(dir, '.git'));
      return UNSAFE_GIT;
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return UNPROVABLE;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

async function locationRefusal(fs: KeyFileOps, file: string, roots: { readonly project: readonly string[]; readonly temp: readonly string[] }): Promise<SignRefusal | null> {
  if (roots.project.some((root) => isInside(file, root))) return UNSAFE_PROJECT;
  if (roots.temp.some((root) => isInside(file, root))) return UNSAFE_TEMP;
  return gitAncestorRefusal(fs, file);
}

async function dirModeRefusal(fs: KeyFileOps, dir: string): Promise<SignRefusal | null> {
  try {
    const info = await fs.lstat(dir);
    return info.isDirectory() && (info.mode & PERMISSION_BITS) === DIR_MODE ? null : UNSAFE_DIR_MODE;
  } catch {
    return UNPROVABLE;
  }
}

/**
 * Custódia (IA-22), ANTES de ler o conteúdo: lugar pelo caminho dado (projeto, temporárias, `.git`), depois o próprio arquivo (não pode ser link
 * simbólico; tem de ser arquivo comum), o lugar pelo caminho REAL (um link numa pasta do caminho não esconde nada) e a pasta real com 0700.
 */
async function custodyRefusal(fs: KeyFileOps, file: string, custody: KeyCustody): Promise<SignRefusal | null> {
  const roots = { project: await bothForms(fs, [custody.projectRoot]), temp: await bothForms(fs, custody.tempRoots) };
  const byGivenPath = await locationRefusal(fs, file, roots);
  if (byGivenPath) return byGivenPath;
  let info: KeyFileInfo;
  try {
    info = await fs.lstat(file);
  } catch {
    return REJECTED_UNREADABLE;
  }
  if (info.isSymbolicLink()) return UNSAFE_SYMLINK;
  if (!info.isFile()) return REJECTED_UNREADABLE;
  let real: string;
  try {
    real = await fs.realpath(file);
  } catch {
    return UNPROVABLE;
  }
  const byRealPath = real === file ? null : await locationRefusal(fs, real, roots);
  return byRealPath ?? dirModeRefusal(fs, path.dirname(real));
}

/** Uma leitura do arquivo (sem seguir link), com a permissão do DESCRITOR: exatamente 0600. */
async function readKeyBytes(fs: KeyFileOps, file: string): Promise<Buffer | SignRefusal> {
  let read: KeyFileRead;
  try {
    read = await fs.readKeyFile(file, MAX_KEY_FILE_BYTES);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ETOOBIG') return REJECTED_TOO_BIG;
    return code === 'ELOOP' ? UNSAFE_SYMLINK : REJECTED_UNREADABLE;
  }
  if ((read.mode & PERMISSION_BITS) !== FILE_MODE) {
    read.bytes.fill(0);
    return UNSAFE_FILE_MODE;
  }
  return read.bytes;
}

/* ------------------------------------------------------------------------------------------------------------------- formato e abertura */

const ENCRYPTED_PEM = /^\s*-----BEGIN ENCRYPTED PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n?-----END ENCRYPTED PRIVATE KEY-----\s*$/;
/** OID do PBES2 (1.2.840.113549.1.5.13) em DER: `06 09 2A 86 48 86 F7 0D 01 05 0D`. */
const PBES2_OID = Buffer.from('06092a864886f70d01050d', 'hex');
const DER_SEQUENCE = 0x30;
const DER_LONG_FORM = 0x80;
const DER_MAX_LENGTH_BYTES = 4;
const BYTE = 256;

/** Uma TLV DER em `offset`: tag, início e fim do valor; `null` se não cabe no buffer. */
function derAt(der: Buffer, offset: number): { readonly tag: number; readonly start: number; readonly end: number } | null {
  if (offset + 2 > der.length) return null;
  const tag = der[offset] as number;
  let length = der[offset + 1] as number;
  let start = offset + 2;
  if (length & DER_LONG_FORM) {
    const count = length & ~DER_LONG_FORM;
    if (count < 1 || count > DER_MAX_LENGTH_BYTES || start + count > der.length) return null;
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * BYTE + (der[start + index] as number);
    start += count;
  }
  return start + length > der.length ? null : { tag, start, end: start + length };
}

/** `EncryptedPrivateKeyInfo ::= SEQUENCE { SEQUENCE { OID, params }, OCTET STRING }`: o OID do algoritmo é o do PBES2. */
function isPbes2(der: Buffer): boolean {
  const outer = derAt(der, 0);
  if (outer?.tag !== DER_SEQUENCE) return false;
  const algorithm = derAt(der, outer.start);
  if (algorithm?.tag !== DER_SEQUENCE) return false;
  return der.subarray(algorithm.start, algorithm.start + PBES2_OID.length).equals(PBES2_OID);
}

/** Uma chave privada que o Node abre SEM frase (PEM, DER PKCS#8/SEC1/PKCS#1 ou JWK) está em texto claro. */
function opensWithoutPassphrase(bytes: Buffer): boolean {
  const text = bytes.toString('utf8');
  const attempts: Array<() => unknown> = [
    () => createPrivateKey(text),
    () => createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' }),
    () => createPrivateKey({ key: bytes, format: 'der', type: 'sec1' }),
    () => createPrivateKey({ key: bytes, format: 'der', type: 'pkcs1' }),
    () => createPrivateKey({ key: JSON.parse(text) as Record<string, unknown>, format: 'jwk' }),
  ];
  return attempts.some((attempt) => {
    try {
      attempt();
      return true;
    } catch {
      return false; // formato que não abre sem frase: não é texto claro reconhecido
    }
  });
}

const opensWith = (pem: string, passphrase: string | Buffer): KeyObject | null => {
  try {
    return createPrivateKey({ key: pem, format: 'pem', passphrase });
  } catch {
    return null; // frase errada ou arquivo corrompido: quem chama devolve a recusa fixa (o objeto de erro nunca sai, RS-13)
  }
};

/**
 * Do conteúdo à chave: PEM `ENCRYPTED PRIVATE KEY` com PBES2 que NÃO abre com frase vazia; só então a frase é pedida (uma vez) e a chave aberta.
 * Texto claro ⇒ `SECRET_NOT_ENCRYPTED`; outro formato ⇒ `SIGN_KEY_REJECTED`; frase vazia que abre ou cifra legada ⇒ `SIGN_KEY_UNPROTECTED`.
 */
async function decryptKey(bytes: Buffer, keyId: string, passphrase: (keyId: string) => Promise<Buffer>): Promise<KeyObject | SignRefusal> {
  const match = ENCRYPTED_PEM.exec(bytes.toString('latin1'));
  if (!match) return opensWithoutPassphrase(bytes) ? NOT_ENCRYPTED : REJECTED_FORMAT;
  const pem = match[0];
  const der = Buffer.from((match[1] ?? '').replace(/[\r\n]/g, ''), 'base64');
  const pbes2 = isPbes2(der);
  der.fill(0);
  if (!pbes2) return UNPROTECTED_LEGACY;
  if (opensWith(pem, '') !== null) return UNPROTECTED_EMPTY;
  let secret: Buffer;
  try {
    secret = await passphrase(keyId);
  } catch {
    return REJECTED_NO_PASSPHRASE;
  }
  try {
    if (secret.length === 0) return REJECTED_EMPTY_PASSPHRASE;
    const key = opensWith(pem, secret);
    if (key === null) return REJECTED_PASSPHRASE;
    return key.asymmetricKeyType === 'ed25519' ? key : REJECTED_NOT_ED25519;
  } finally {
    secret.fill(0);
  }
}

export interface OpenK1Deps {
  readonly fs: KeyFileOps;
  readonly custody: KeyCustody;
  /** A frase, digitada no terminal sem eco (passo 12); os bytes devolvidos são zerados depois de abrir a chave. */
  readonly passphrase: (keyId: string) => Promise<Buffer>;
}

/**
 * Passo 12 com K1: custódia (IA-22) → uma leitura do arquivo (0600) → formato cifrado (PBES2, não vazio) → frase → chave Ed25519. Devolve a chave
 * ou a recusa; nunca lança e nunca repassa um objeto de erro (pode carregar material, RS-13).
 */
export async function openK1Key(keyPath: string, keyId: string, deps: OpenK1Deps): Promise<KeyObject | SignRefusal> {
  try {
    const file = path.resolve(keyPath);
    const unsafeCustody = await custodyRefusal(deps.fs, file, deps.custody);
    if (unsafeCustody) return unsafeCustody;
    const bytes = await readKeyBytes(deps.fs, file);
    if ('ok' in bytes) return bytes;
    try {
      return await decryptKey(bytes, keyId, deps.passphrase);
    } finally {
      bytes.fill(0);
    }
  } catch {
    return REJECTED_UNEXPECTED;
  }
}

/** `<keyId>:<pública base64url>` (32 bytes da Ed25519, o formato da lista com estado): não secreta, impressa no passo 12. */
export function publicKeyText(keyId: string, key: KeyObject): string {
  return `${keyId}:${String(createPublicKey(key).export({ format: 'jwk' }).x)}`;
}
