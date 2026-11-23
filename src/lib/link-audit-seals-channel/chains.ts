import nodePath from 'node:path';
import { errorCode, type FsOps } from '../link-audit/fs-ops';
import { readSealChain } from '../link-audit-attestation/sign-chain';
import { SEAL_FILE, sealSha256, type EvidenceSealFileV2 } from '../link-audit-evidence/provenance-core';
import { sealV2Code, type SealsRefusalCode } from './codes';
import { AUDIT_ID_CHANNEL_PATTERN } from './paths';

/*
 * P9.2 — as CADEIAS (spec §5.4, S-09 e S-10). A cadeia inteira do commit (base + novos) passa pelo VERIFICADOR v2 REAL pelo mesmo método do
 * `sign` (`readSealChain`: lista com estado do commit, fechos de `_closures/`, `acceptedVersions: [2]`, evidências = entradas da cabeça). Só as
 * auditorias com arquivo novo são verificadas: uma revogação legítima deixa cadeias antigas `SEAL_KEY_REVOKED` sem travar o CI (P9-S12).
 */

/** Estado de uma pasta do checkout pelo `lstat` (sem seguir link): ausente, diretório real, ou outra coisa (arquivo, link, FIFO). */
export async function directoryState(fs: FsOps, dir: string): Promise<'absent' | 'directory' | 'not-directory'> {
  try {
    const info = await fs.lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink() ? 'directory' : 'not-directory';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'absent';
    throw error;
  }
}

/** Os `seq` dos `seal-NNNN.json` da pasta da auditoria no checkout (pasta ausente ⇒ nenhum; não diretório ⇒ `null`, nunca listado). */
export async function seqsOnDisk(fs: FsOps, auditDir: string): Promise<number[] | null> {
  const state = await directoryState(fs, auditDir);
  if (state === 'absent') return [];
  if (state === 'not-directory') return null;
  return (await fs.readdir(auditDir)).flatMap((name) => {
    const match = SEAL_FILE.exec(name);
    return match ? [Number(match[1])] : [];
  });
}

/** S-09: os `seq` novos vêm logo depois do maior `seq` do commit-base, contíguos (`max+1, max+2, …`). */
export function isAtEnd(baseSeqs: readonly number[], newSeqs: readonly number[]): boolean {
  const start = baseSeqs.reduce((max, seq) => Math.max(max, seq), 0) + 1;
  return [...newSeqs].sort((a, b) => a - b).every((seq, index) => seq === start + index);
}

export interface ChainHeadExpectation {
  readonly sealsDir: string;
  readonly auditId: string;
  /** A lista do commit, no formato da variável (linhas juntadas por `,`; '' = política fechada). */
  readonly trustValue: string;
  /** O último manifesto novo da auditoria. */
  readonly lastNew: EvidenceSealFileV2;
}

/** S-10: `AUTHENTICATED` com `headSeq` = último `seq` novo e `headSealSha256` = `sealSha256` dele; senão `SEAL_V2_<RAZÃO>` ou `SEAL_HEAD_MISMATCH`. */
export async function chainRefusalCode(input: ChainHeadExpectation, fs: FsOps): Promise<SealsRefusalCode | null> {
  const facts = await readSealChain({ sealsDir: input.sealsDir, auditId: input.auditId, trustKeys: input.trustValue }, { fs });
  if (facts.status === 'INVALID') return sealV2Code(facts.reason);
  if (facts.status !== 'VERIFIED') return 'SEAL_HEAD_MISMATCH';
  return facts.last.seq === input.lastNew.seq && facts.last.sealSha256 === sealSha256(input.lastNew) ? null : 'SEAL_HEAD_MISMATCH';
}

export interface ChainVerdict {
  readonly auditId: string;
  /** `AUTHENTICATED` ou a razão fixa da recusa (`NO_SEAL` para pasta sem manifesto). */
  readonly verdict: string;
  readonly headSeq: number | null;
}
export type ChainVerdicts =
  | { readonly kind: 'listed'; readonly verdicts: readonly ChainVerdict[]; /** O teto informativo acabou antes da última cadeia. */ readonly truncated: boolean }
  /** `<amb>/seals` existe e não é diretório real: nada é listado (quem chama recusa). */
  | { readonly kind: 'not-directory' };

/**
 * Informação, quando a lista muda (§5.4): o veredito de cada cadeia do ambiente sob a lista nova. Não recusa nada. `isExhausted` é o teto
 * informativo: esgotado, a lista para (truncada) e a cadeia que estava sendo lida não entra.
 */
export async function chainVerdicts(sealsDir: string, trustValue: string, fs: FsOps, isExhausted: () => boolean = () => false): Promise<ChainVerdicts> {
  const state = await directoryState(fs, sealsDir);
  if (state === 'not-directory') return { kind: 'not-directory' };
  if (state === 'absent') return { kind: 'listed', verdicts: [], truncated: false };
  const verdicts: ChainVerdict[] = [];
  for (const auditId of (await fs.readdir(sealsDir)).filter((name) => AUDIT_ID_CHANNEL_PATTERN.test(name)).sort()) {
    const facts = await readSealChain({ sealsDir, auditId, trustKeys: trustValue }, { fs });
    if (isExhausted()) return { kind: 'listed', verdicts, truncated: true };
    if (facts.status === 'VERIFIED') verdicts.push({ auditId, verdict: 'AUTHENTICATED', headSeq: facts.last.seq });
    else verdicts.push({ auditId, verdict: facts.status === 'INVALID' ? sealV2Code(facts.reason).slice('SEAL_V2_'.length) : 'NO_SEAL', headSeq: null });
  }
  return { kind: 'listed', verdicts, truncated: false };
}

export const auditDirOf = (sealsDir: string, auditId: string): string => nodePath.join(sealsDir, auditId);
