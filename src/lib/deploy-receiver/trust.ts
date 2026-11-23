import { createHash } from 'node:crypto';
import nodePath from 'node:path';
import { MAX_TRUST_LIST_BYTES, parseTrustListFile, trustListEnvironmentViolations, trustListTransition, type TrustListItem } from '../link-audit-seals-channel/trust-list';
import { ReceiverError } from './codes';
import type { DeployEnvironment } from './grammar';
import { readAllCapped } from './input';
import type { ReceiverDeps, ReceiverFs } from './ports';

/*
 * P9.3a — a lista de confiança no receptor de deploy (spec §5.3, §5.6 passos 3 e 14), com o módulo da lista da P9.2 (parser do arquivo, regra de
 * ambiente e `trustListTransition`), sem reimplementar nada:
 *  - passo 3: stdin até 8 KiB; SHA-256 = o declarado (`E_TRUST_LIST_MISMATCH`); formato, `parseTrustKeyring` e regra de ambiente
 *    (`E_TRUST_LIST_INVALID`); TRANSIÇÃO a partir da lista INSTALADA (`<estado>/trust-keys.txt`), sem a prova do fecho no commit-base, que só o
 *    CI vê (`newPins` é ignorado): ausente ou vazia ⇒ primeira instalação, livre; igual ⇒ passa; senão `E_TRUST_LIST_TRANSITION`. Instalada
 *    ilegível ou fora do formato ⇒ também `E_TRUST_LIST_TRANSITION` (falha fechada, como `BASE_UNREADABLE` no CI);
 *  - passo 14: instala a lista (temporário + `fsync` + `rename` + `fsync` da pasta), `0644` para o receptor de manifestos ler, e devolve o
 *    SHA-256 RELIDO do arquivo instalado.
 */

export const INSTALLED_TRUST_FILE = 'trust-keys.txt';
export const TRUST_STDIN_IDLE_MS = 30_000;
const INSTALLED_MODE = 0o644;

export interface ReceivedTrustList {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  /** O valor da variável `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` (as linhas juntadas por `,`; '' = política fechada). */
  readonly value: string;
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function installedItems(stateDir: string, fs: ReceiverFs): Promise<readonly TrustListItem[]> {
  const file = nodePath.join(stateDir, INSTALLED_TRUST_FILE);
  const info = await fs.lstat(file);
  if (info === null) return [];
  if (!info.isFile || info.isSymbolicLink) throw new ReceiverError('E_TRUST_LIST_TRANSITION', null, 'installed trust list is not a regular file');
  let raw: Uint8Array;
  try {
    raw = await fs.readFileCapped(file, MAX_TRUST_LIST_BYTES);
  } catch {
    throw new ReceiverError('E_TRUST_LIST_TRANSITION', null, 'installed trust list unreadable');
  }
  const parsed = parseTrustListFile(raw);
  if (!parsed.ok) throw new ReceiverError('E_TRUST_LIST_TRANSITION', null, `installed trust list ${parsed.issue}`);
  return parsed.items;
}

/** Passo 3: a lista do stdin, conferida (hash, formato, ambiente) e aceita como transição a partir da instalada. */
export async function receiveTrustList(declaredSha256: string, env: DeployEnvironment, stateDir: string, deps: ReceiverDeps): Promise<ReceivedTrustList> {
  const bytes = await readAllCapped(deps.stdin, MAX_TRUST_LIST_BYTES, TRUST_STDIN_IDLE_MS);
  const sha256 = sha256Hex(bytes);
  if (sha256 !== declaredSha256) throw new ReceiverError('E_TRUST_LIST_MISMATCH', null, 'trust list sha256 differs from the declared one');
  const parsed = parseTrustListFile(bytes);
  if (!parsed.ok) throw new ReceiverError('E_TRUST_LIST_INVALID', null, `trust list ${parsed.issue}`);
  const offEnvironment = trustListEnvironmentViolations(env, parsed.items);
  if (offEnvironment.length > 0) throw new ReceiverError('E_TRUST_LIST_INVALID', null, `trust list ENV_PREFIX ${offEnvironment.join(' ')}`);
  const transition = trustListTransition(await installedItems(stateDir, deps.fs), parsed.items);
  if (!transition.ok) {
    const reasons = transition.violations.map((violation) => `${violation.keyId}:${violation.reason}`).join(' ');
    throw new ReceiverError('E_TRUST_LIST_TRANSITION', null, `trust list transition ${reasons}`);
  }
  deps.log.write('trust.accepted', { sha256, items: parsed.items.length, notices: transition.notices.map((notice) => `${notice.keyId}:${notice.notice}`).join(' ') || null });
  return { bytes, sha256, value: parsed.value };
}

/** Passo 14: instala a lista de forma atômica e durável; devolve o SHA-256 relido do arquivo instalado. Falha ⇒ `E_INTERNAL`. */
export async function installTrustList(list: ReceivedTrustList, stateDir: string, deps: ReceiverDeps): Promise<string> {
  const target = nodePath.join(stateDir, INSTALLED_TRUST_FILE);
  const temporary = nodePath.join(stateDir, `.${INSTALLED_TRUST_FILE}.tmp-${deps.randomSuffix()}`);
  try {
    const file = await deps.fs.createExclusive(temporary, INSTALLED_MODE);
    try {
      await file.write(list.bytes);
      await file.chmod(INSTALLED_MODE);
      await file.sync();
    } finally {
      await file.close();
    }
    await deps.fs.rename(temporary, target);
    await deps.fs.syncDirectory(stateDir);
  } catch {
    await deps.fs.unlink(temporary).catch(() => undefined);
    throw new ReceiverError('E_INTERNAL', null, 'trust list install failed');
  }
  const installed = sha256Hex(await deps.fs.readFileCapped(target, MAX_TRUST_LIST_BYTES));
  deps.log.write('trust.installed', { sha256: installed });
  return installed;
}
