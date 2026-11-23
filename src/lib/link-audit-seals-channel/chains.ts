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

/** Os `seq` dos `seal-NNNN.json` da pasta da auditoria no checkout (pasta ausente ⇒ nenhum). */
export async function seqsOnDisk(fs: FsOps, auditDir: string): Promise<number[]> {
  let names: string[];
  try {
    names = await fs.readdir(auditDir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap((name) => {
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

/** Informação, quando a lista muda (§5.4): o veredito de cada cadeia do ambiente sob a lista nova. Não recusa nada. */
export async function chainVerdicts(sealsDir: string, trustValue: string, fs: FsOps): Promise<ChainVerdict[]> {
  let names: string[];
  try {
    names = await fs.readdir(sealsDir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const verdicts: ChainVerdict[] = [];
  for (const auditId of names.filter((name) => AUDIT_ID_CHANNEL_PATTERN.test(name)).sort()) {
    const facts = await readSealChain({ sealsDir, auditId, trustKeys: trustValue }, { fs });
    if (facts.status === 'VERIFIED') verdicts.push({ auditId, verdict: 'AUTHENTICATED', headSeq: facts.last.seq });
    else verdicts.push({ auditId, verdict: facts.status === 'INVALID' ? sealV2Code(facts.reason).slice('SEAL_V2_'.length) : 'NO_SEAL', headSeq: null });
  }
  return verdicts;
}

export const auditDirOf = (sealsDir: string, auditId: string): string => nodePath.join(sealsDir, auditId);
