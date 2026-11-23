import nodePath from 'node:path';
import { MAX_CHAIN_SEALS } from '../link-audit-evidence/provenance-core';

/*
 * P9.2 — GRAMÁTICA dos caminhos versionados do canal de manifestos (spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.2). Puro: só texto,
 * sem disco. Qualquer caminho sob `link-audit-seals/` que não case exatamente uma linha da tabela é `unexpected` (S-03).
 */

/** Diretório de topo do canal (espelho, byte a byte, da pasta de manifestos de cada ambiente). */
export const SEALS_ROOT = 'link-audit-seals';
export const CHANNEL_ENVIRONMENTS = ['producao', 'homologacao'] as const;
export type ChannelEnvironment = (typeof CHANNEL_ENVIRONMENTS)[number];
/** `auditId` no canal: subconjunto estrito do `AUDIT_ID_PATTERN`, sufixo de `openssl rand -hex 8` gerado na autorização (§5.2). */
export const AUDIT_ID_CHANNEL_PATTERN = /^aud-[0-9a-f]{16}$/;
/** O `TRUST_KEY_ID` do verificador v2 (não exportado por ele; paridade travada por teste contra `parseTrustKeyring`). */
export const CHANNEL_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{3,31}$/;
export const TRUST_LIST_FILE = 'trust-keys.txt';
export const SEALS_SUBDIR = 'seals';
/** A pasta dos fechos dentro da pasta de manifestos (o `CLOSURES_DIR` do `sign`; paridade travada por teste). */
export const CHANNEL_CLOSURES_DIR = '_closures';
const SEAL_NAME = /^seal-(\d{4})\.json$/;
const CLOSURE_NAME = /^(.+)\.json$/;
const PATH_SEPARATOR = '/';
const MIN_SEAL_SEQ = 1;

export type ChannelPath =
  | { readonly kind: 'trust-list'; readonly env: ChannelEnvironment }
  | { readonly kind: 'seal'; readonly env: ChannelEnvironment; readonly auditId: string; readonly seq: number }
  | { readonly kind: 'closure'; readonly env: ChannelEnvironment; readonly keyId: string }
  | { readonly kind: 'unexpected' };

const UNEXPECTED: ChannelPath = { kind: 'unexpected' };
const isEnvironment = (value: string | undefined): value is ChannelEnvironment => (CHANNEL_ENVIRONMENTS as readonly string[]).includes(value ?? '');

/** Verdadeiro para `link-audit-seals` e tudo abaixo dele (caminho do repositório, separador `/`, como o git o imprime). */
export const isChannelPath = (repoPath: string): boolean => repoPath === SEALS_ROOT || repoPath.startsWith(`${SEALS_ROOT}${PATH_SEPARATOR}`);

/** O caminho relativo a `link-audit-seals/` (vazio para o próprio diretório de topo). */
export const channelRelative = (repoPath: string): string => (repoPath === SEALS_ROOT ? '' : repoPath.slice(SEALS_ROOT.length + 1));

/** Sob `<amb>/seals/` de um ambiente válido (S-01: só acréscimo ali). */
export function isUnderSealsDir(repoPath: string): boolean {
  const [env, sub, ...rest] = channelRelative(repoPath).split(PATH_SEPARATOR);
  return isEnvironment(env) && sub === SEALS_SUBDIR && rest.length > 0;
}

function sealSeq(name: string): number | null {
  const match = SEAL_NAME.exec(name);
  const seq = match ? Number(match[1]) : NaN;
  return seq >= MIN_SEAL_SEQ && seq <= MAX_CHAIN_SEALS ? seq : null;
}

/** Classifica um caminho de `link-audit-seals/` pela tabela do §5.2. `null` = fora do canal. Exato: sem caixa diferente, sem segmento a mais. */
export function classifyChannelPath(repoPath: string): ChannelPath | null {
  if (!isChannelPath(repoPath)) return null;
  const parts = channelRelative(repoPath).split(PATH_SEPARATOR);
  const [env, second, third, fourth] = parts;
  if (!isEnvironment(env)) return UNEXPECTED;
  if (parts.length === 2) return second === TRUST_LIST_FILE ? { kind: 'trust-list', env } : UNEXPECTED;
  if (parts.length !== 4 || second !== SEALS_SUBDIR || third === undefined || fourth === undefined) return UNEXPECTED;
  if (third === CHANNEL_CLOSURES_DIR) {
    const keyId = CLOSURE_NAME.exec(fourth)?.[1];
    return keyId !== undefined && CHANNEL_KEY_ID_PATTERN.test(keyId) ? { kind: 'closure', env, keyId } : UNEXPECTED;
  }
  const seq = AUDIT_ID_CHANNEL_PATTERN.test(third) ? sealSeq(fourth) : null;
  return seq === null ? UNEXPECTED : { kind: 'seal', env, auditId: third, seq };
}

/** `link-audit-seals/<amb>/seals` sob a raiz do checkout (separador do sistema, para o disco). */
export const sealsDirOf = (repoRoot: string, env: ChannelEnvironment): string => nodePath.join(repoRoot, SEALS_ROOT, env, SEALS_SUBDIR);

/** Um caminho do repositório (separador `/`) sob a raiz do checkout, com o separador do sistema. */
export const checkoutPath = (repoRoot: string, repoPath: string): string => nodePath.join(repoRoot, ...repoPath.split(PATH_SEPARATOR));

/** O caminho mostrado no resumo: relativo à pasta de manifestos do ambiente (`aud-…/seal-0003.json`, `_closures/<R>.json`), como no §5.9. */
export function sealsRelativePath(path: ChannelPath): string | null {
  if (path.kind === 'seal') return `${path.auditId}/seal-${String(path.seq).padStart(4, '0')}.json`;
  if (path.kind === 'closure') return `${CHANNEL_CLOSURES_DIR}/${path.keyId}.json`;
  return null;
}

/** O caminho público de uma recusa: relativo a `link-audit-seals/`, só quando casa a gramática (nunca ecoa um caminho fora dela). */
export function publicChannelPath(path: ChannelPath | null): string | null {
  if (path === null || path.kind === 'unexpected') return null;
  if (path.kind === 'trust-list') return `${path.env}/${TRUST_LIST_FILE}`;
  return `${path.env}/${SEALS_SUBDIR}/${sealsRelativePath(path) as string}`;
}
