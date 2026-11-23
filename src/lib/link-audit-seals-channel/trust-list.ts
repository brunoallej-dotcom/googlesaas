import { MAX_TRUST_KEYS, parseTrustKeyring } from '../link-audit-evidence/provenance-core';
import { isRehearsalKeyId } from '../link-audit-evidence/simulated';
import { CHANNEL_KEY_ID_PATTERN, type ChannelEnvironment } from './paths';

/*
 * P9.2 — a LISTA DE CONFIANÇA versionada `link-audit-seals/<amb>/trust-keys.txt` (spec `ci-deploy-and-seal-delivery.md` §5.3): parser do
 * arquivo, regra de ambiente e regras de TRANSIÇÃO. Puro (sem disco, rede, ambiente nem relógio). É o módulo que o receptor de deploy (P9.3a)
 * reaproveita contra a lista INSTALADA: lá a transição roda sem a prova do fecho no commit-base (`newPins` é ignorado), que só o CI vê.
 */

/** Teto do arquivo: 16 itens de no máximo ~150 bytes cabem com folga; é também o teto do stdin da lista no receptor de deploy (§5.6 passo 3). */
export const MAX_TRUST_LIST_BYTES = 8 * 1024;
const NEWLINE = 0x0a;
const FIRST_VISIBLE_ASCII = 0x21;
const LAST_VISIBLE_ASCII = 0x7e;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const STATES: ReadonlySet<string> = new Set(['active', 'retired', 'revoked']);

export type TrustKeyState = 'active' | 'retired' | 'revoked';
export interface TrustListItem {
  readonly id: string;
  /** 32 bytes da pública Ed25519 em base64url. */
  readonly publicRaw: string;
  readonly status: TrustKeyState;
  /** `retired:<sha256>`: o hash fixado dos bytes do fecho; `null` nos outros casos. */
  readonly closureSha256: string | null;
}
export type TrustListFormatIssue = 'TOO_LARGE' | 'NOT_VISIBLE_ASCII' | 'NO_FINAL_NEWLINE' | 'EMPTY_LINE' | 'TOO_MANY_ITEMS' | 'ITEM_GRAMMAR' | 'KEYRING_REFUSED';
export type TrustListParse =
  | { readonly ok: true; readonly items: readonly TrustListItem[]; /** O valor da variável: as linhas juntadas por `,` ('' = política fechada). */ readonly value: string }
  | { readonly ok: false; readonly issue: TrustListFormatIssue };

/** Um item por linha, na gramática do contrato v2 §5: `<id>:<pub>` | `<id>:<pub>:active|retired|revoked` | `<id>:<pub>:retired:<sha256>`. */
function parseItemLine(line: string): TrustListItem | null {
  const parts = line.split(':');
  if (parts.length < 2 || parts.length > 4) return null;
  const [id, publicRaw, status = 'active', pinned] = parts as [string, string, string?, string?];
  if (!CHANNEL_KEY_ID_PATTERN.test(id) || !PUBLIC_KEY.test(publicRaw) || !STATES.has(status)) return null;
  if (parts.length === 4 && !(status === 'retired' && HEX64.test(pinned ?? ''))) return null;
  return { id, publicRaw, status: status as TrustKeyState, closureSha256: parts.length === 4 ? (pinned as string) : null };
}

const onlyVisibleAsciiAndNewlines = (raw: Uint8Array): boolean => raw.every((byte) => byte === NEWLINE || (byte >= FIRST_VISIBLE_ASCII && byte <= LAST_VISIBLE_ASCII));

/**
 * O arquivo da lista (§5.3, "Formato do arquivo"): 0 bytes = política FECHADA; senão só ASCII visível e `\n`, `\n` no fim de cada linha, sem
 * linha vazia, sem espaço nem comentário, até 16 itens, cada linha um item da gramática, e a junção por `,` aceita por `parseTrustKeyring`
 * (chave fraca ou malformada, id ou pública repetidos, mais de 2 `active` ⇒ recusa). Nunca lança.
 */
export function parseTrustListFile(raw: Uint8Array): TrustListParse {
  if (raw.byteLength > MAX_TRUST_LIST_BYTES) return { ok: false, issue: 'TOO_LARGE' };
  if (raw.byteLength === 0) return { ok: true, items: [], value: '' };
  if (!onlyVisibleAsciiAndNewlines(raw)) return { ok: false, issue: 'NOT_VISIBLE_ASCII' };
  if (raw[raw.byteLength - 1] !== NEWLINE) return { ok: false, issue: 'NO_FINAL_NEWLINE' };
  const lines = Buffer.from(raw).toString('ascii').slice(0, -1).split('\n');
  if (lines.some((line) => line === '')) return { ok: false, issue: 'EMPTY_LINE' };
  if (lines.length > MAX_TRUST_KEYS) return { ok: false, issue: 'TOO_MANY_ITEMS' };
  const items = lines.map(parseItemLine);
  if (items.some((item) => item === null)) return { ok: false, issue: 'ITEM_GRAMMAR' };
  const value = lines.join(',');
  return parseTrustKeyring(value) === null ? { ok: false, issue: 'KEYRING_REFUSED' } : { ok: true, items: items as TrustListItem[], value };
}

/**
 * Regra por ambiente (§5.3): produção sem nenhum id `ensaio-` (o servidor sem a trava recusaria a lista inteira); homologação só com ids
 * `ensaio-` (a W5 e a G2 usam só chave descartável). Devolve os ids fora da regra (vazio = conforme).
 */
export function trustListEnvironmentViolations(env: ChannelEnvironment, items: readonly TrustListItem[]): string[] {
  const wantsRehearsal = env === 'homologacao';
  return items.filter((item) => isRehearsalKeyId(item.id) !== wantsRehearsal).map((item) => item.id);
}

export type TrustTransitionReason = 'ITEM_REMOVED' | 'PUBLIC_KEY_CHANGED' | 'KEY_ID_CHANGED' | 'REVOKED_CHANGED' | 'RETIRED_REACTIVATED' | 'PIN_CHANGED' | 'PIN_REMOVED';
export interface TrustTransitionViolation {
  readonly keyId: string;
  readonly reason: TrustTransitionReason;
}
/** Aviso público: `retired` sem hash fixado nunca conta (contrato v2 §6, `SEAL_KEY_RETIRED_UNCOVERED`) até a fixação. */
export interface TrustTransitionNotice {
  readonly keyId: string;
  readonly notice: 'RETIRED_WITHOUT_PIN';
}
/** Uma fixação NOVA (`retired:<sha256>` que a lista anterior não tinha): o CI exige o fecho no commit-base e o S-11; o host não vê fechos. */
export interface TrustNewPin {
  readonly keyId: string;
  readonly closureSha256: string;
}
export interface TrustTransition {
  readonly ok: boolean;
  readonly violations: readonly TrustTransitionViolation[];
  readonly notices: readonly TrustTransitionNotice[];
  readonly newPins: readonly TrustNewPin[];
}

/** Estado de um item que já existia: `null` = transição permitida; senão o motivo fixo (tabela do §5.3). */
function stateChangeViolation(before: TrustListItem, after: TrustListItem): TrustTransitionReason | null {
  if (before.status === 'revoked') return after.status === 'revoked' ? null : 'REVOKED_CHANGED';
  if (after.status === 'revoked') return null; // qualquer → revoked
  if (before.status === 'retired' && after.status === 'active') return 'RETIRED_REACTIVATED';
  if (before.closureSha256 === null) return null;
  // `retired:<h>` só fica igual (ou vira revoked, acima)
  if (after.closureSha256 === null) return 'PIN_REMOVED';
  return after.closureSha256 === before.closureSha256 ? null : 'PIN_CHANGED';
}

const isNewPin = (before: TrustListItem | undefined, after: TrustListItem): boolean => after.closureSha256 !== null && before?.closureSha256 !== after.closureSha256;
const isUnpinnedRetirement = (before: TrustListItem | undefined, after: TrustListItem): boolean => after.status === 'retired' && after.closureSha256 === null && before?.status !== 'retired';

function violationsOf(previous: readonly TrustListItem[], next: ReadonlyMap<string, TrustListItem>): TrustTransitionViolation[] {
  const violations: TrustTransitionViolation[] = [];
  for (const before of previous) {
    const after = next.get(before.id);
    const reason = after === undefined ? 'ITEM_REMOVED' : after.publicRaw !== before.publicRaw ? 'PUBLIC_KEY_CHANGED' : stateChangeViolation(before, after);
    if (reason !== null) violations.push({ keyId: before.id, reason });
  }
  const idOfKey = new Map(previous.map((item) => [item.publicRaw, item.id]));
  for (const after of next.values()) {
    const formerId = idOfKey.get(after.publicRaw);
    if (formerId !== undefined && formerId !== after.id) violations.push({ keyId: after.id, reason: 'KEY_ID_CHANGED' });
  }
  return violations;
}

/**
 * Transição de `previous` (lista do commit-base no CI; a INSTALADA no receptor de deploy) para `next` (§5.3, tabela): item novo e
 * `qualquer → revoked` passam; `revoked → outro`, `retired → active`, trocar ou tirar o hash fixado, trocar a pública de um id ou o id de uma
 * pública e remover um item (inclusive voltar à lista vazia) não. `previous` vazio = primeira instalação. Pura e síncrona: cada fixação nova
 * vai em `newPins` para quem pode prová-la (o CI); `active → retired` sem hash passa com aviso.
 */
export function trustListTransition(previous: readonly TrustListItem[], next: readonly TrustListItem[]): TrustTransition {
  const nextById = new Map(next.map((item) => [item.id, item]));
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const violations = violationsOf(previous, nextById);
  const notices: TrustTransitionNotice[] = [];
  const newPins: TrustNewPin[] = [];
  for (const after of next) {
    const before = previousById.get(after.id);
    if (before !== undefined && stateChangeViolation(before, after) !== null) continue;
    if (isUnpinnedRetirement(before, after)) notices.push({ keyId: after.id, notice: 'RETIRED_WITHOUT_PIN' });
    if (isNewPin(before, after)) newPins.push({ keyId: after.id, closureSha256: after.closureSha256 as string });
  }
  return { ok: violations.length === 0, violations, notices, newPins };
}
