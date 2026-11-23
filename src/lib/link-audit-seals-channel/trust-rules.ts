import type { BytesFsOps } from '../link-audit/fs-ops';
import { parseTrustKeyring, type TrustKeyring } from '../link-audit-evidence/provenance-core';
import { isPinProven } from './closures';
import { refusal, type SealsRefusal } from './codes';
import type { ReadFile } from './files';
import { checkoutPath, CHANNEL_ENVIRONMENTS, SEALS_ROOT, sealsDirOf, TRUST_LIST_FILE, type ChannelEnvironment } from './paths';
import { MAX_TRUST_LIST_BYTES, parseTrustListFile, trustListEnvironmentViolations, trustListTransition, type TrustListItem, type TrustTransitionNotice } from './trust-list';

/*
 * P9.2 — S-12 (a lista alterada: formato, ambiente, transição a partir do commit-base e prova de cada fixação nova) e a lista DO COMMIT que o
 * S-10 e o S-11 usam. Disco só pela porta; a lista do commit-base chega em bytes (o workflow a extrai com `git show`, o comando não chama git).
 */

/** A lista do commit-base de um ambiente: ausente (primeira introdução), os bytes, ou ilegível (falha fechada se a lista mudar). */
export type BaseTrustList = { readonly kind: 'absent' } | { readonly kind: 'bytes'; readonly bytes: Uint8Array } | { readonly kind: 'unreadable' };

export interface CommitTrust {
  /** O valor da variável ('' = política fechada: arquivo ausente, vazio, irregular ou fora do formato). */
  readonly value: string;
  readonly ring: TrustKeyring | null;
}

/** A lista do commit de um ambiente, lida do checkout (arquivo comum, com teto). Qualquer defeito ⇒ política fechada. */
export async function commitTrust(repoRoot: string, env: ChannelEnvironment, fs: BytesFsOps): Promise<CommitTrust> {
  const closed: CommitTrust = { value: '', ring: null };
  try {
    const file = checkoutPath(repoRoot, `${SEALS_ROOT}/${env}/${TRUST_LIST_FILE}`);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TRUST_LIST_BYTES) return closed;
    const parsed = parseTrustListFile(await fs.readFileBytes(file, MAX_TRUST_LIST_BYTES));
    return parsed.ok ? { value: parsed.value, ring: parseTrustKeyring(parsed.value) } : closed;
  } catch {
    return closed;
  }
}

export interface TrustListOutcome {
  readonly refusals: SealsRefusal[];
  /** Itens da lista nova (null se fora do formato). */
  readonly items: number | null;
  readonly notices: readonly TrustTransitionNotice[];
  /** A lista nova no formato da variável, só quando passou no formato (para o veredito informativo das cadeias). */
  readonly nextValue: string | null;
}

function baseItems(base: BaseTrustList): readonly TrustListItem[] | null {
  if (base.kind === 'absent') return [];
  if (base.kind === 'unreadable') return null;
  const parsed = parseTrustListFile(base.bytes);
  return parsed.ok ? parsed.items : null;
}

export interface TrustListInput {
  readonly file: ReadFile & { readonly channel: { readonly kind: 'trust-list'; readonly env: ChannelEnvironment } };
  readonly base: BaseTrustList;
  readonly repoRoot: string;
  readonly addedClosureKeyIds: ReadonlySet<string>;
}

/** S-12 numa lista alterada: `TRUST_LIST_FORMAT`, `TRUST_LIST_ENV_PREFIX` e `TRUST_LIST_TRANSITION` (um por motivo, com o id da chave). */
export async function judgeTrustList(input: TrustListInput, fs: BytesFsOps): Promise<TrustListOutcome> {
  const { file } = input;
  const parsed = parseTrustListFile(file.bytes);
  if (!parsed.ok) return { refusals: [refusal('S-12', 'TRUST_LIST_FORMAT', file.publicPath, parsed.issue)], items: null, notices: [], nextValue: null };
  const refusals: SealsRefusal[] = [];
  const offEnvironment = trustListEnvironmentViolations(file.channel.env, parsed.items);
  if (offEnvironment.length > 0) refusals.push(refusal('S-12', 'TRUST_LIST_ENV_PREFIX', file.publicPath, offEnvironment.join(' ')));
  const previous = baseItems(input.base);
  if (previous === null) return { refusals: [...refusals, refusal('S-12', 'TRUST_LIST_TRANSITION', file.publicPath, 'BASE_UNREADABLE')], items: parsed.items.length, notices: [], nextValue: parsed.value };
  const transition = trustListTransition(previous, parsed.items);
  for (const violation of transition.violations) refusals.push(refusal('S-12', 'TRUST_LIST_TRANSITION', file.publicPath, `${violation.keyId} ${violation.reason}`));
  const ring = parseTrustKeyring(parsed.value);
  const sealsDir = sealsDirOf(input.repoRoot, file.channel.env);
  for (const pin of transition.newPins) {
    const proven = await isPinProven({ sealsDir, keyId: pin.keyId, closureSha256: pin.closureSha256, addedClosureKeyIds: input.addedClosureKeyIds, ring }, fs);
    if (!proven) refusals.push(refusal('S-12', 'TRUST_LIST_TRANSITION', file.publicPath, `${pin.keyId} PIN_UNPROVEN`));
  }
  return { refusals, items: parsed.items.length, notices: transition.notices, nextValue: parsed.value };
}

/** S-13: no mesmo ambiente, a lista mudou (qualquer status) E há arquivo novo sob `<amb>/seals/`. */
export function togetherRefusals(trustChanged: ReadonlySet<ChannelEnvironment>, sealsAdded: ReadonlySet<ChannelEnvironment>): SealsRefusal[] {
  return CHANNEL_ENVIRONMENTS.filter((env) => trustChanged.has(env) && sealsAdded.has(env)).map((env) => refusal('S-13', 'SEALS_AND_TRUST_LIST_TOGETHER', `${env}/${TRUST_LIST_FILE}`));
}
