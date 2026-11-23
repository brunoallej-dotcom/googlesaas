import nodePath from 'node:path';
import type { BytesFsOps } from '../link-audit/fs-ops';
import { sealFileName } from '../link-audit-attestation/sign-chain';
import {
  MAX_CLOSURE_BYTES,
  MAX_SEAL_BYTES,
  parseEvidenceSealV2Text,
  parseKeyRetirementClosureText,
  sealSha256,
  verifyKeyRetirementClosureSignature,
  type KeyRetirementClosureFile,
  type TrustKeyring,
} from '../link-audit-evidence/provenance-core';
import type { ClosureMotive } from './codes';
import { sha256OfBytes } from './files';
import { AUDIT_ID_CHANNEL_PATTERN, CHANNEL_CLOSURES_DIR } from './paths';

/*
 * P9.2 — S-11, o FECHO de aposentadoria (spec §5.4; contrato do verificador v2 §6): signatário na lista com assinatura válida, `retiredKeyId`
 * na lista e cada cabeça presente na cadeia do repositório com o mesmo `seq` e `sealSha256`. O mesmo S-11 roda de novo no fecho de uma
 * fixação `retired:<sha256>` (S-12), que além disso precisa estar no commit-base com esse sha256 dos bytes.
 */

/** Os bytes de um arquivo comum do checkout (sem seguir link), com teto; `null` se não é isso. */
async function regularBytes(fs: BytesFsOps, file: string, cap: number): Promise<Uint8Array | null> {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > cap) return null;
    return await fs.readFileBytes(file, cap);
  } catch {
    return null;
  }
}

/** Uma cabeça do fecho existe na cadeia do repositório: o manifesto daquela posição, estrito, da mesma auditoria e `seq`, com o mesmo `sealSha256`. */
async function headInRepo(fs: BytesFsOps, sealsDir: string, head: KeyRetirementClosureFile['heads'][number]): Promise<boolean> {
  if (!AUDIT_ID_CHANNEL_PATTERN.test(head.auditId)) return false; // nunca vira caminho; no canal só há auditorias opacas
  const bytes = await regularBytes(fs, nodePath.join(sealsDir, head.auditId, sealFileName(head)), MAX_SEAL_BYTES);
  const parsed = bytes ? parseEvidenceSealV2Text(bytes) : null;
  return parsed?.ok === true && parsed.value.auditId === head.auditId && parsed.value.seq === head.seq && sealSha256(parsed.value) === head.sealSha256;
}

/** S-11 contra a lista dada (a do commit). `null` = passa. A ordem dos motivos é fixa. */
export async function closureMotive(closure: KeyRetirementClosureFile, ring: TrustKeyring | null, sealsDir: string, fs: BytesFsOps): Promise<ClosureMotive | null> {
  const signer = ring?.get(closure.signerKeyId);
  if (signer === undefined) return 'SIGNER_NOT_LISTED';
  if (!verifyKeyRetirementClosureSignature(closure, signer.key)) return 'SIGNATURE_INVALID';
  if (!ring?.has(closure.retiredKeyId)) return 'RETIRED_NOT_LISTED';
  for (const head of closure.heads) {
    if (!(await headInRepo(fs, sealsDir, head))) return 'HEAD_NOT_IN_REPO';
  }
  return null;
}

export interface PinProofInput {
  readonly sealsDir: string;
  readonly keyId: string;
  readonly closureSha256: string;
  /** Fechos acrescentados por ESTA mudança: não estão no commit-base. */
  readonly addedClosureKeyIds: ReadonlySet<string>;
  /** A lista do commit (a nova), contra a qual o S-11 roda de novo. */
  readonly ring: TrustKeyring | null;
}

/**
 * S-12, fixação `retired:<sha256>` (vinda de `active`, de `retired` ou item novo): `_closures/<id>.json` já existe no commit-base (está no
 * checkout e não foi acrescentado agora; o S-01 garante que nada sob `seals/` mudou), com esse sha256 dos BYTES, formato estrito, nome =
 * `retiredKeyId`, e passa de novo pelo S-11 contra a lista do commit.
 */
export async function isPinProven(input: PinProofInput, fs: BytesFsOps): Promise<boolean> {
  if (input.addedClosureKeyIds.has(input.keyId)) return false;
  const bytes = await regularBytes(fs, nodePath.join(input.sealsDir, CHANNEL_CLOSURES_DIR, `${input.keyId}.json`), MAX_CLOSURE_BYTES);
  if (bytes === null || sha256OfBytes(bytes) !== input.closureSha256) return false;
  const parsed = parseKeyRetirementClosureText(bytes);
  if (!parsed.ok || parsed.value.retiredKeyId !== input.keyId) return false;
  return (await closureMotive(parsed.value, input.ring, input.sealsDir, fs)) === null;
}
