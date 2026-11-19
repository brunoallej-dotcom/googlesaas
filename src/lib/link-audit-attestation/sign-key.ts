import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { SignRefusal, SignRefusalCode } from './sign-core';

/*
 * P1 W4.4 — a CHAVE K1 do `sign` (spec §8 K1, decisão D11; §5.5 passo 12; §5.5.1 itens 1 e 2; IA-04, IA-22; RS-11, RS-12, RS-13). O arquivo de
 * `--key-source file:<caminho>` é uma chave PKCS#8 CIFRADA (PEM `ENCRYPTED PRIVATE KEY`, PBES2) aberta com a frase digitada no terminal (porta
 * injetada `passphrase`, nunca argv nem ambiente). Antes de pedir a frase, a CUSTÓDIA do arquivo (IA-22): fora de qualquer árvore com `.git`, fora
 * do projeto, fora das pastas temporárias, sem link simbólico, arquivo 0600 com um só nome numa pasta 0700, e cifrado. Só LEITURA do disco.
 * Revisão da W4.4: a custódia vale para o arquivo ABERTO, não para um caminho conferido antes. O arquivo é aberto UMA vez (sem seguir link no último
 * componente, sem travar em FIFO); tipo, permissão, número de nomes e tamanho vêm do `fstat` do descritor; o lugar vem do caminho REAL do próprio
 * descritor (`/proc/self/fd/<fd>`), e a leitura é feita pelo MESMO descritor. Sem esse caminho (sistema sem `/proc`), recusa fechada.
 * Qualquer falha é recusa com código e mensagem FIXOS (sem caminho, sem conteúdo, sem o objeto de erro: RS-13). Limite declarado: o Node não zera
 * um `KeyObject`; os buffers da frase e do arquivo são zerados em todo caminho.
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
/** `fstat` do descritor aberto: o que a custódia confere do arquivo que será LIDO. */
export interface KeyFileStat {
  isFile(): boolean;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
}
/** O arquivo de chave ABERTO: tudo o que se confere dele e a leitura saem deste descritor (revisão da W4.4). */
export interface OpenedKeyFile {
  stat(): Promise<KeyFileStat>;
  /** Caminho real do descritor aberto (Linux: `readlink('/proc/self/fd/<fd>')`); rejeita onde não há `/proc`. */
  realPath(): Promise<string>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}
/** O que a custódia e a abertura usam do disco. Injetável nos testes; nada aqui escreve. */
export interface KeyFileOps {
  /** Metadados das pastas (os `.git` acima do arquivo e a pasta dele, pelo caminho real); nunca do arquivo de chave. */
  lstat(target: string): Promise<KeyFileInfo>;
  /** Caminho real das raízes proibidas (projeto e pastas temporárias). */
  realpath(target: string): Promise<string>;
  /** Abre o arquivo de chave UMA vez: só leitura, sem seguir link no último componente e sem travar em FIFO. */
  openKeyFile(target: string): Promise<OpenedKeyFile>;
}

export const nodeKeyFileOps: KeyFileOps = {
  lstat: (target) => fsPromises.lstat(target),
  realpath: (target) => fsPromises.realpath(target),
  async openKeyFile(target) {
    const { constants } = fsPromises;
    const handle = await fsPromises.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    return {
      stat: () => handle.stat(),
      realPath: () => fsPromises.readlink(`/proc/self/fd/${handle.fd}`),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
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
const UNSAFE_HARDLINK = unsafe('o arquivo tem mais de um nome (hardlink): outro nome do mesmo arquivo pode estar num lugar proibido');
const UNSAFE_NO_DESCRIPTOR_PATH = unsafe('não foi possível obter o caminho real do arquivo ABERTO (/proc/self/fd indisponível: sistema sem /proc ou fora do Linux); sem ele a custódia não é provada');
const UNSAFE_MOVED = unsafe('o arquivo mudou de lugar durante a conferência (o caminho real do descritor mudou)');
const UNPROVABLE = unsafe('não foi possível conferir o caminho (erro ao inspecionar uma pasta acima do arquivo)');
const NOT_ENCRYPTED = refuse('SECRET_NOT_ENCRYPTED', 'O arquivo da chave está em TEXTO CLARO (chave privada sem cifra): trate-a como exposta, gere/cifre outra numa estação limpa (PKCS#8 com frase) e destrua a cópia em claro.');
const UNPROTECTED_EMPTY = refuse('SIGN_KEY_UNPROTECTED', 'A chave cifrada abre com frase VAZIA: está sem proteção.');
const UNPROTECTED_LEGACY = refuse('SIGN_KEY_UNPROTECTED', 'A chave usa cifra legada (não PBES2): proteção insuficiente; recifre-a em PKCS#8 com PBES2.');
const REJECTED_UNREADABLE = refuse('SIGN_KEY_REJECTED', 'O arquivo da chave não pôde ser lido como arquivo comum (inexistente, diretório, especial ou ilegível).');
const REJECTED_TOO_BIG = refuse('SIGN_KEY_REJECTED', 'O arquivo da chave é grande demais para uma chave Ed25519 cifrada.');
const REJECTED_CHANGED = refuse('SIGN_KEY_REJECTED', 'O arquivo da chave mudou durante a leitura.');
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

async function locationRefusal(fs: KeyFileOps, file: string, roots: Roots): Promise<SignRefusal | null> {
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

type Roots = { readonly project: readonly string[]; readonly temp: readonly string[] };
const DELETED_SUFFIX = ' (deleted)';

/** Caminho real do DESCRITOR: absoluto, normalizado, de arquivo não apagado; senão `null` (a custódia não é provada). */
async function descriptorPath(opened: OpenedKeyFile): Promise<string | null> {
  try {
    const real = await opened.realPath();
    const usable = typeof real === 'string' && path.isAbsolute(real) && path.normalize(real) === real && !real.includes('\0') && !real.endsWith(DELETED_SUFFIX);
    return usable ? real : null;
  } catch {
    return null;
  }
}

/** Lê pelo descritor até o fim; um byte a mais que o `fstat` declarou denuncia um arquivo que cresceu (quem chama recusa). */
async function readAll(opened: OpenedKeyFile, buffer: Buffer): Promise<number> {
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await opened.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return length;
}

/**
 * Custódia e leitura sobre o MESMO descritor (IA-22, revisão da W4.4): `fstat` (arquivo comum, exatamente 0600, UM nome, tamanho limitado) → caminho
 * REAL do descritor → lugar (projeto, temporárias, `.git` acima) e pasta real 0700 → leitura pelo descritor → o caminho do descritor não mudou.
 * O buffer alocado vai para `keep` antes de qualquer byte lido, para quem chama zerá-lo em toda saída que não seja sucesso.
 */
async function checkedRead(fs: KeyFileOps, opened: OpenedKeyFile, roots: Roots, keep: (buffer: Buffer) => void): Promise<Buffer | SignRefusal> {
  const info = await opened.stat();
  if (!info.isFile()) return REJECTED_UNREADABLE;
  if ((info.mode & PERMISSION_BITS) !== FILE_MODE) return UNSAFE_FILE_MODE;
  if (info.nlink !== 1) return UNSAFE_HARDLINK;
  if (info.size > MAX_KEY_FILE_BYTES) return REJECTED_TOO_BIG;
  const real = await descriptorPath(opened);
  if (real === null) return UNSAFE_NO_DESCRIPTOR_PATH;
  const placed = (await locationRefusal(fs, real, roots)) ?? (await dirModeRefusal(fs, path.dirname(real)));
  if (placed) return placed;
  // `size + 1`: o byte a mais denuncia crescimento depois do fstat; Buffer.alloc (zerado, fora do pool)
  const buffer = Buffer.alloc(info.size + 1);
  keep(buffer);
  const length = await readAll(opened, buffer);
  if (length > info.size) return REJECTED_CHANGED;
  if ((await descriptorPath(opened)) !== real) return UNSAFE_MOVED;
  return buffer.subarray(0, length);
}

/**
 * Abre UMA vez e confere/lê pelo descritor; fecha sempre. Falha de leitura (inclusive depois de leitura parcial), falha no `close` ou qualquer
 * recusa ⇒ o buffer é ZERADO antes de devolver a recusa. Link simbólico no último componente ⇒ `ELOOP` (`O_NOFOLLOW`).
 */
async function readThroughDescriptor(fs: KeyFileOps, file: string, roots: Roots): Promise<Buffer | SignRefusal> {
  let opened: OpenedKeyFile;
  try {
    opened = await fs.openKeyFile(file);
  } catch (error) {
    return errorCode(error) === 'ELOOP' ? UNSAFE_SYMLINK : REJECTED_UNREADABLE;
  }
  const held: { buffer: Buffer | null } = { buffer: null };
  let outcome: Buffer | SignRefusal;
  try {
    outcome = await checkedRead(fs, opened, roots, (buffer) => {
      held.buffer = buffer;
    });
  } catch {
    outcome = REJECTED_UNREADABLE;
  }
  try {
    await opened.close();
  } catch {
    outcome = REJECTED_UNREADABLE;
  }
  if ('ok' in outcome) held.buffer?.fill(0);
  return outcome;
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

/* KDF do PBES2 (aviso, não recusa; decisão do manager na revisão da W4.4): o runbook da W5 fixa os parâmetros; até lá, mínimos PROVISÓRIOS. */

/** PBKDF2-HMAC-SHA256: recomendação atual da OWASP. Provisório até o runbook da W5. */
export const MIN_PBKDF2_ITERATIONS = 600_000;
/** scrypt (N, com r = 8 e p = 1): recomendação atual da OWASP. Provisório até o runbook da W5. */
export const MIN_SCRYPT_COST = 2 ** 17;
const PBKDF2_OID = Buffer.from('06092a864886f70d01050c', 'hex');
const SCRYPT_OID = Buffer.from('06092b06010401da47040b', 'hex');
const DER_INTEGER = 0x02;
const DER_OCTET_STRING = 0x04;
const DER_OID = 0x06;
const MAX_INTEGER_BYTES = 6;

type KdfParams = { readonly kind: 'PBKDF2'; readonly iterations: number } | { readonly kind: 'SCRYPT'; readonly cost: number } | null;

/** O valor de um INTEGER DER em `offset` (até 6 bytes, cabe num número seguro); `null` fora disso. */
function derInteger(der: Buffer, offset: number): number | null {
  const node = derAt(der, offset);
  if (node?.tag !== DER_INTEGER || node.end - node.start < 1 || node.end - node.start > MAX_INTEGER_BYTES) return null;
  let value = 0;
  for (let index = node.start; index < node.end; index += 1) value = value * BYTE + (der[index] as number);
  return value;
}

/**
 * `PBES2-params ::= SEQUENCE { keyDerivationFunc AlgorithmIdentifier, encryptionScheme AlgorithmIdentifier }`; nos parâmetros do PBKDF2 (RFC 8018)
 * e do scrypt (RFC 7914), o primeiro INTEGER depois do sal é o custo (iterações ou N). `null` se não reconhecido.
 */
function kdfOf(der: Buffer): KdfParams {
  const outer = derAt(der, 0);
  const algorithm = outer?.tag === DER_SEQUENCE ? derAt(der, outer.start) : null;
  const pbes2Oid = algorithm?.tag === DER_SEQUENCE ? derAt(der, algorithm.start) : null;
  const params = pbes2Oid?.tag === DER_OID ? derAt(der, pbes2Oid.end) : null;
  const kdf = params?.tag === DER_SEQUENCE ? derAt(der, params.start) : null;
  const kdfOid = kdf?.tag === DER_SEQUENCE ? derAt(der, kdf.start) : null;
  const kdfParams = kdfOid?.tag === DER_OID ? derAt(der, kdfOid.end) : null;
  const salt = kdfParams?.tag === DER_SEQUENCE ? derAt(der, kdfParams.start) : null;
  if (!kdf || !kdfOid || salt?.tag !== DER_OCTET_STRING) return null;
  const cost = derInteger(der, salt.end);
  if (cost === null) return null;
  const id = der.subarray(kdf.start, kdfOid.end);
  if (id.equals(PBKDF2_OID)) return { kind: 'PBKDF2', iterations: cost };
  return id.equals(SCRYPT_OID) ? { kind: 'SCRYPT', cost } : null;
}

const KDF_NOTICE_TAIL = 'o runbook da W5 fixa os parâmetros; nenhuma chave real antes disso. Recifre a chave antes de usá-la de verdade.';

/** O aviso (na saída de erro, antes da frase) quando o KDF está abaixo do mínimo provisório ou não pôde ser conferido; `null` se está bom. */
function kdfNotice(kdf: KdfParams): string | null {
  if (kdf === null) return `Aviso (KDF): os parâmetros do KDF da chave (PBES2) não puderam ser conferidos; ${KDF_NOTICE_TAIL}`;
  if (kdf.kind === 'PBKDF2' && kdf.iterations < MIN_PBKDF2_ITERATIONS) return `Aviso (KDF): a chave usa PBKDF2 com ${kdf.iterations} iterações, abaixo do mínimo provisório de ${MIN_PBKDF2_ITERATIONS}; ${KDF_NOTICE_TAIL}`;
  if (kdf.kind === 'SCRYPT' && kdf.cost < MIN_SCRYPT_COST) return `Aviso (KDF): a chave usa scrypt com custo N=${kdf.cost}, abaixo do mínimo provisório de N=${MIN_SCRYPT_COST}; ${KDF_NOTICE_TAIL}`;
  return null;
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
async function decryptKey(bytes: Buffer, keyId: string, deps: Pick<OpenK1Deps, 'passphrase' | 'warn'>): Promise<KeyObject | SignRefusal> {
  const match = ENCRYPTED_PEM.exec(bytes.toString('latin1'));
  if (!match) return opensWithoutPassphrase(bytes) ? NOT_ENCRYPTED : REJECTED_FORMAT;
  const pem = match[0];
  const der = Buffer.from((match[1] ?? '').replace(/[\r\n]/g, ''), 'base64');
  const pbes2 = isPbes2(der);
  const kdf = pbes2 ? kdfOf(der) : null;
  der.fill(0);
  if (!pbes2) return UNPROTECTED_LEGACY;
  if (opensWith(pem, '') !== null) return UNPROTECTED_EMPTY;
  const notice = kdfNotice(kdf);
  if (notice !== null) deps.warn?.(notice);
  let secret: Buffer;
  try {
    secret = await deps.passphrase(keyId);
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
  /** Avisos não secretos (KDF abaixo do mínimo provisório), na saída de erro, antes de pedir a frase. */
  readonly warn?: (line: string) => void;
}

/**
 * Passo 12 com K1: lugar pelo caminho DADO (antecipa a recusa; não é a prova) → custódia e leitura pelo DESCRITOR aberto (IA-22) → formato cifrado
 * (PBES2, não vazio; aviso de KDF) → frase → chave Ed25519. Devolve a chave ou a recusa; nunca lança e nunca repassa um objeto de erro (RS-13).
 */
export async function openK1Key(keyPath: string, keyId: string, deps: OpenK1Deps): Promise<KeyObject | SignRefusal> {
  try {
    const file = path.resolve(keyPath);
    const roots: Roots = { project: await bothForms(deps.fs, [deps.custody.projectRoot]), temp: await bothForms(deps.fs, deps.custody.tempRoots) };
    const byGivenPath = await locationRefusal(deps.fs, file, roots);
    if (byGivenPath) return byGivenPath;
    const bytes = await readThroughDescriptor(deps.fs, file, roots);
    if ('ok' in bytes) return bytes;
    try {
      return await decryptKey(bytes, keyId, deps);
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
