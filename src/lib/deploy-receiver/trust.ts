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
 * Falha parcial (revisão do PR #70, item 5): logo antes do `docker stack deploy` a lista nova é gravada, de forma atômica, em
 * `<estado>/trust-keys.pending`. O serviço pode passar a rodar com ela mesmo que o deploy termine em erro (rollback, prazo, PD-xx). Só depois do
 * PD-07 ela é PROMOVIDA a `trust-keys.txt` (`rename`). Enquanto existir uma pendente, a lista de um deploy novo tem de ser transição válida a partir
 * da instalada E da pendente; pendente ilegível ou fora do formato ⇒ `E_TRUST_LIST_TRANSITION`. O receptor de manifestos só lê a instalada.
 */

export const INSTALLED_TRUST_FILE = 'trust-keys.txt';
export const PENDING_TRUST_FILE = 'trust-keys.pending';
export const TRUST_STDIN_IDLE_MS = 30_000;
const INSTALLED_MODE = 0o644;

export interface ReceivedTrustList {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  /** O valor da variável `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` (as linhas juntadas por `,`; '' = política fechada). */
  readonly value: string;
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Os itens de uma lista do estado (instalada ou pendente); `null` se o arquivo não existe. Irregular, ilegível ou fora do formato ⇒ recusa. */
async function stateListItems(stateDir: string, name: string, fs: ReceiverFs): Promise<readonly TrustListItem[] | null> {
  const file = nodePath.join(stateDir, name);
  const info = await fs.lstat(file);
  if (info === null) return null;
  if (!info.isFile || info.isSymbolicLink) throw new ReceiverError('E_TRUST_LIST_TRANSITION', null, `${name} is not a regular file`);
  let raw: Uint8Array;
  try {
    raw = await fs.readFileCapped(file, MAX_TRUST_LIST_BYTES);
  } catch {
    throw new ReceiverError('E_TRUST_LIST_TRANSITION', null, `${name} unreadable`);
  }
  const parsed = parseTrustListFile(raw);
  if (!parsed.ok) throw new ReceiverError('E_TRUST_LIST_TRANSITION', null, `${name} ${parsed.issue}`);
  return parsed.items;
}

function requireTransition(previous: readonly TrustListItem[], next: readonly TrustListItem[], from: string): void {
  const transition = trustListTransition(previous, next);
  if (transition.ok) return;
  const reasons = transition.violations.map((violation) => `${violation.keyId}:${violation.reason}`).join(' ');
  throw new ReceiverError('E_TRUST_LIST_TRANSITION', null, `trust list transition from ${from} ${reasons}`);
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
  const installed = (await stateListItems(stateDir, INSTALLED_TRUST_FILE, deps.fs)) ?? [];
  requireTransition(installed, parsed.items, 'installed');
  const pending = await stateListItems(stateDir, PENDING_TRUST_FILE, deps.fs);
  if (pending !== null) requireTransition(pending, parsed.items, 'pending');
  const notices = trustListTransition(installed, parsed.items).notices;
  deps.log.write('trust.accepted', { sha256, items: parsed.items.length, pendingChecked: pending !== null, notices: notices.map((notice) => `${notice.keyId}:${notice.notice}`).join(' ') || null });
  return { bytes, sha256, value: parsed.value };
}

/** Grava `bytes` em `<pasta>/<nome>` de forma atômica e durável (temporário exclusivo + `fsync` + `rename` + `fsync` da pasta). */
async function writeAtomic(stateDir: string, name: string, bytes: Uint8Array, deps: ReceiverDeps): Promise<void> {
  const temporary = nodePath.join(stateDir, `.${name}.tmp-${deps.randomSuffix()}`);
  try {
    const file = await deps.fs.createExclusive(temporary, INSTALLED_MODE);
    try {
      await file.write(bytes);
      await file.chmod(INSTALLED_MODE);
      await file.sync();
    } finally {
      await file.close();
    }
    await deps.fs.rename(temporary, nodePath.join(stateDir, name));
    await deps.fs.syncDirectory(stateDir);
  } catch {
    await deps.fs.unlink(temporary).catch(() => undefined);
    throw new ReceiverError('E_INTERNAL', null, `${name} write failed`);
  }
}

/** Antes do `docker stack deploy`: a lista nova como PENDENTE (atômica). */
export async function writePendingTrustList(list: ReceivedTrustList, stateDir: string, deps: ReceiverDeps): Promise<void> {
  await writeAtomic(stateDir, PENDING_TRUST_FILE, list.bytes, deps);
  deps.log.write('trust.pending', { sha256: list.sha256 });
}

/**
 * Passo 14, só depois do PD-07: PROMOVE a pendente a instalada (`rename` + `fsync` da pasta), se ela ainda tem os bytes recebidos (senão
 * grava a instalada direto, de forma atômica); devolve o SHA-256 relido do arquivo instalado. Falha ⇒ `E_INTERNAL`.
 */
export async function installTrustList(list: ReceivedTrustList, stateDir: string, deps: ReceiverDeps): Promise<string> {
  const target = nodePath.join(stateDir, INSTALLED_TRUST_FILE);
  const pending = nodePath.join(stateDir, PENDING_TRUST_FILE);
  let promoted = false;
  try {
    const current = await deps.fs.readFileCapped(pending, MAX_TRUST_LIST_BYTES);
    if (sha256Hex(current) === list.sha256) {
      await deps.fs.rename(pending, target);
      await deps.fs.syncDirectory(stateDir);
      promoted = true;
    }
  } catch {
    promoted = false;
  }
  if (!promoted) await writeAtomic(stateDir, INSTALLED_TRUST_FILE, list.bytes, deps);
  const installed = sha256Hex(await deps.fs.readFileCapped(target, MAX_TRUST_LIST_BYTES));
  deps.log.write('trust.installed', { sha256: installed, promotedFromPending: promoted });
  return installed;
}
