import type { BytesFsOps } from '../link-audit/fs-ops';
import { chainSnapshot, selfTestSeal } from '../link-audit-attestation/sign-chain';
import { parseTrustKeyring } from '../link-audit-evidence/provenance-core';
import { chainRefusalCode } from '../link-audit-seals-channel/chains';
import { closureMotive } from '../link-audit-seals-channel/closures';
import type { Candidate } from './candidate';
import { SealReceiverError, v2Detail, type ClosureRefusalDetail } from './codes';
import type { SealTarget } from './grammar';
import { destinationOf } from './layout';
import type { InstalledTrustList } from './trust';

/*
 * P9.3b — a SEGUNDA verificação, no host (RC-06; spec §5.7 passos 6 e 8), com o verificador v2 REAL em modo produção (lista instalada com os
 * estados, fechos de `<raiz>/_closures/`, `acceptedVersions: [2]`), sem reimplementar nada:
 *  6. manifesto: o MESMO julgamento do autoteste do `sign` (`selfTestSeal`), sobre a fotografia SOMENTE LEITURA da pasta (`chainSnapshot`) mais o
 *     candidato em memória (`withVirtualFile`), com as evidências = entradas do candidato. Só passa com `AUTHENTICATED` cuja cabeça é o candidato
 *     (`headSeq` e `headSealSha256`): isso prova `seq` = último + 1 NO HOST, porque um buraco quebra a cadeia. Senão `E_V2_REFUSED <RAZÃO>`.
 *     Fecho: as regras do S-11 (`closureMotive` da P9.2) contra as cadeias DO HOST ⇒ `E_CLOSURE_REFUSED <MOTIVO>`;
 *  8. depois da gravação: releitura do disco (os bytes gravados = os recebidos) e nova classificação, agora sem nada em memória (a leitura da cadeia
 *     do `sign`, `chainRefusalCode` do S-10, ou o S-11 de novo) ⇒ `E_POSTWRITE_VERIFY`. O arquivo nunca é apagado.
 * Toda leitura passa por uma visão SOMENTE LEITURA da porta (qualquer escrita lança `EROFS`).
 */

const READ_ONLY = async (): Promise<never> => {
  throw Object.assign(new Error('a verificação do receptor é somente leitura'), { code: 'EROFS' });
};

/** A porta de disco sem nenhuma operação de escrita. */
export function readOnlyFs(fs: BytesFsOps): BytesFsOps {
  return { ...fs, mkdir: READ_ONLY, writeExclusive: READ_ONLY, link: READ_ONLY, unlink: READ_ONLY, chmod: READ_ONLY, syncDirectory: READ_ONLY };
}

const SELFTEST_HEAD_MISMATCH = 'SELFTEST_HEAD_MISMATCH';

async function closureRefusal(candidate: Extract<Candidate, { readonly kind: 'closure' }>, root: string, trust: InstalledTrustList, fs: BytesFsOps): Promise<ClosureRefusalDetail | null> {
  const motive = await closureMotive(candidate.closure, parseTrustKeyring(trust.value), root, readOnlyFs(fs));
  // `FORMAT` é do passo 3 (`E_FORMAT`): o S-11 daqui nunca o devolve, e o conjunto público não o tem
  return motive === null || motive === 'FORMAT' ? null : motive;
}

/** Passo 6. */
export async function verifyOnHost(fs: BytesFsOps, root: string, trust: InstalledTrustList, candidate: Candidate): Promise<void> {
  if (candidate.kind === 'closure') {
    const motive = await closureRefusal(candidate, root, trust, fs);
    if (motive !== null) throw new SealReceiverError('E_CLOSURE_REFUSED', motive, `closure S-11 ${motive}`);
    return;
  }
  const { seal, text } = candidate;
  const refused = await selfTestSeal({ sealsDir: root, trustKeys: trust.value, seal, text, entries: seal.entries }, { fs: chainSnapshot(readOnlyFs(fs)) });
  if (refused === null) return;
  const reason = refused.chainReason === SELFTEST_HEAD_MISMATCH ? 'HEAD_MISMATCH' : v2Detail(refused.chainReason);
  throw new SealReceiverError('E_V2_REFUSED', reason, `v2 ${refused.chainReason ?? 'no reason'}`);
}

/** Passo 8: releitura do arquivo gravado e nova classificação, sem nada em memória. */
export async function verifyAfterWrite(fs: BytesFsOps, root: string, target: SealTarget, trust: InstalledTrustList, candidate: Candidate, cap: number): Promise<void> {
  const view = readOnlyFs(fs);
  let written: Uint8Array;
  try {
    written = await view.readFileBytes(destinationOf(root, target), cap);
  } catch {
    throw new SealReceiverError('E_POSTWRITE_VERIFY', null, 'written file unreadable');
  }
  if (!Buffer.from(written).equals(Buffer.from(candidate.bytes))) throw new SealReceiverError('E_POSTWRITE_VERIFY', null, 'written bytes differ');
  if (candidate.kind === 'closure') {
    const motive = await closureRefusal(candidate, root, trust, view);
    if (motive !== null) throw new SealReceiverError('E_POSTWRITE_VERIFY', null, `closure S-11 ${motive} after write`);
    return;
  }
  const refused = await chainRefusalCode({ sealsDir: root, auditId: candidate.seal.auditId, trustValue: trust.value, lastNew: candidate.seal }, view);
  if (refused !== null) throw new SealReceiverError('E_POSTWRITE_VERIFY', null, `chain ${refused} after write`);
}
