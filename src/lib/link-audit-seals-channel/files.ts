import { createHash } from 'node:crypto';
import { errorCode, type BytesFsOps } from '../link-audit/fs-ops';
import { serializeSealFile } from '../link-audit-attestation/sign-chain';
import { MAX_CLOSURE_BYTES, MAX_SEAL_BYTES, parseEvidenceSealV2Text, parseKeyRetirementClosureText, type EvidenceSealFileV2, type KeyRetirementClosureFile } from '../link-audit-evidence/provenance-core';
import type { ChangeEntry } from './changes';
import { refusal, type SealsRefusal } from './codes';
import { checkoutPath, isUnderSealsDir, publicChannelPath, type ChannelPath } from './paths';
import { MAX_TRUST_LIST_BYTES } from './trust-list';

/*
 * P9.2 — regras POR ARQUIVO do job `seals` (spec §5.4, S-01 a S-08): só acréscimo, lista não apagada, gramática, modo, tamanho, formato
 * estrito, forma canônica e nome. Disco só pela porta `BytesFsOps` (lstat e leitura com teto, sem seguir link); nenhum arquivo é lido antes
 * do modo e do tamanho conferidos, e nenhum conteúdo sai daqui além do que o resumo publica (hashes, `seq`, ids).
 */

/** S-05: até 200 arquivos novos e 16 MiB por execução. */
export const MAX_NEW_FILES = 200;
export const MAX_RUN_BYTES = 16 * 1024 * 1024;
/** S-04: o único modo aceito no git (nunca link `120000`, executável `100755` nem submódulo `160000`). */
export const REGULAR_FILE_MODE = '100644';
const READ_TOO_LARGE_CODES: ReadonlySet<string> = new Set(['ETOOBIG', 'ECHANGED']);

type SealPath = Extract<ChannelPath, { readonly kind: 'seal' }>;
type ClosurePath = Extract<ChannelPath, { readonly kind: 'closure' }>;
type TrustPath = Extract<ChannelPath, { readonly kind: 'trust-list' }>;
export type FilePath = SealPath | ClosurePath | TrustPath;

export interface ClassifiedChange {
  readonly entry: ChangeEntry;
  readonly channel: ChannelPath;
}
/** Um arquivo novo (manifesto, fecho) ou alterado (lista) presente no commit, a examinar. */
export interface Candidate {
  readonly repoPath: string;
  readonly channel: FilePath;
  readonly publicPath: string;
}
export interface ReadFile extends Candidate {
  readonly bytes: Uint8Array;
  readonly bytesSha256: string;
}

export const sha256OfBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const isTrustPath = (channel: ChannelPath): channel is TrustPath => channel.kind === 'trust-list';

/** S-01 (só `A` sob `<amb>/seals/`), S-02 (lista: só `A` ou `M`) e S-03 (gramática do §5.2). Puras: nenhum disco. */
export function structuralRefusals(changes: readonly ClassifiedChange[]): SealsRefusal[] {
  const refusals: SealsRefusal[] = [];
  for (const { entry, channel } of changes) {
    const shown = publicChannelPath(channel);
    if (entry.status !== 'A' && isUnderSealsDir(entry.path)) refusals.push(refusal('S-01', 'SEALS_NOT_APPEND_ONLY', shown));
    // `D` apaga; `T`, `R` e `C` também deixam de ter o arquivo comum naquele caminho
    if (isTrustPath(channel) && entry.status !== 'A' && entry.status !== 'M') refusals.push(refusal('S-02', 'TRUST_LIST_DELETED', shown));
    if (channel.kind === 'unexpected') refusals.push(refusal('S-03', 'SEALS_UNEXPECTED_PATH'));
  }
  return refusals;
}

/** Os arquivos a examinar: manifestos e fechos com `A`, a lista com `A` ou `M`. */
export function candidatesOf(changes: readonly ClassifiedChange[]): Candidate[] {
  return changes.flatMap(({ entry, channel }) => {
    if (channel.kind === 'unexpected') return [];
    const wanted = isTrustPath(channel) ? entry.status === 'A' || entry.status === 'M' : entry.status === 'A';
    return wanted ? [{ repoPath: entry.path, channel, publicPath: publicChannelPath(channel) as string }] : [];
  });
}

/** S-04: modo `100644` no git E arquivo comum no checkout (`lstat`, sem seguir link). Devolve o tamanho declarado de quem passou. */
export async function checkModes(candidates: readonly Candidate[], modes: ReadonlyMap<string, string>, repoRoot: string, fs: BytesFsOps): Promise<{ readonly refusals: SealsRefusal[]; readonly sized: ReadonlyArray<Candidate & { readonly size: number }> }> {
  const refusals: SealsRefusal[] = [];
  const sized: Array<Candidate & { readonly size: number }> = [];
  for (const candidate of candidates) {
    const size = modes.get(candidate.repoPath) === REGULAR_FILE_MODE ? await regularFileSize(fs, checkoutPath(repoRoot, candidate.repoPath)) : null;
    if (size === null) refusals.push(refusal('S-04', 'SEALS_BAD_MODE', candidate.publicPath));
    else sized.push({ ...candidate, size });
  }
  return { refusals, sized };
}

async function regularFileSize(fs: BytesFsOps, file: string): Promise<number | null> {
  try {
    const info = await fs.lstat(file);
    return info.isFile() && !info.isSymbolicLink() ? info.size : null;
  } catch {
    return null;
  }
}

export const readCap = (channel: FilePath): number => (channel.kind === 'seal' ? MAX_SEAL_BYTES : channel.kind === 'closure' ? MAX_CLOSURE_BYTES : MAX_TRUST_LIST_BYTES);

/**
 * S-05: acima do teto por arquivo ⇒ `SEALS_TOO_LARGE` SEM abrir o arquivo; a soma acima de 16 MiB ⇒ `SEALS_TOO_MANY` sem ler nada. A leitura
 * em si também tem teto (no descritor, `readFileBytes`): um arquivo que cresceu depois do `lstat` é recusado, nunca lido inteiro. O modo árvore
 * do `seals-verify` (P9.5, `tree.ts`) passa o próprio teto da soma (`maxTotalBytes`); o job `seals` usa o padrão.
 */
export async function readWithinLimits(sized: ReadonlyArray<Candidate & { readonly size: number }>, repoRoot: string, fs: BytesFsOps, maxTotalBytes: number = MAX_RUN_BYTES): Promise<{ readonly refusals: SealsRefusal[]; readonly files: ReadFile[] }> {
  const refusals: SealsRefusal[] = [];
  const fitting = sized.filter((candidate) => {
    const fits = candidate.size <= readCap(candidate.channel);
    if (!fits) refusals.push(refusal('S-05', 'SEALS_TOO_LARGE', candidate.publicPath));
    return fits;
  });
  if (fitting.reduce((total, candidate) => total + candidate.size, 0) > maxTotalBytes) return { refusals: [...refusals, refusal('S-05', 'SEALS_TOO_MANY')], files: [] };
  const files: ReadFile[] = [];
  for (const candidate of fitting) {
    try {
      const bytes = await fs.readFileBytes(checkoutPath(repoRoot, candidate.repoPath), readCap(candidate.channel));
      files.push({ repoPath: candidate.repoPath, channel: candidate.channel, publicPath: candidate.publicPath, bytes, bytesSha256: sha256OfBytes(bytes) });
    } catch (error) {
      refusals.push(refusal(READ_TOO_LARGE_CODES.has(errorCode(error)) ? 'S-05' : 'S-04', READ_TOO_LARGE_CODES.has(errorCode(error)) ? 'SEALS_TOO_LARGE' : 'SEALS_BAD_MODE', candidate.publicPath));
    }
  }
  return { refusals, files };
}

/** S-07: os bytes são EXATAMENTE a forma canônica do `sign` (`serializeSealFile`: `JSON.stringify` do valor validado + `\n`). */
export function isCanonicalSeal(bytes: Uint8Array, seal: EvidenceSealFileV2): boolean {
  const text = serializeSealFile(seal);
  return text.ok && Buffer.from(text.text, 'utf8').equals(Buffer.from(bytes));
}

/** S-07 para o fecho: a forma em que o `close-key` grava (`sign-closure.ts`, `closureText`): `JSON.stringify` do valor validado + `\n`. */
export const isCanonicalClosure = (bytes: Uint8Array, closure: KeyRetirementClosureFile): boolean => Buffer.from(`${JSON.stringify(closure)}\n`, 'utf8').equals(Buffer.from(bytes));

export type JudgedSeal = ReadFile & { readonly channel: SealPath } & ({ readonly ok: true; readonly seal: EvidenceSealFileV2 } | { readonly ok: false; readonly seal: EvidenceSealFileV2 | null; readonly refusal: SealsRefusal });
export type JudgedClosure = ReadFile & { readonly channel: ClosurePath } & ({ readonly ok: true; readonly closure: KeyRetirementClosureFile } | { readonly ok: false; readonly closure: KeyRetirementClosureFile | null; readonly refusal: SealsRefusal });

/** S-06 (formato estrito, só v2), S-07 (forma canônica) e S-08 (`auditId` = pasta, `seq` = nome), nesta ordem, num manifesto lido. */
export function judgeSeal(file: ReadFile & { readonly channel: SealPath }): JudgedSeal {
  const parsed = parseEvidenceSealV2Text(file.bytes);
  if (!parsed.ok) return { ...file, ok: false, seal: null, refusal: refusal('S-06', 'SEAL_FORMAT', file.publicPath) };
  const seal = parsed.value;
  if (!isCanonicalSeal(file.bytes, seal)) return { ...file, ok: false, seal, refusal: refusal('S-07', 'SEAL_NOT_CANONICAL', file.publicPath) };
  if (seal.auditId !== file.channel.auditId || seal.seq !== file.channel.seq) return { ...file, ok: false, seal, refusal: refusal('S-08', 'SEAL_NAME_MISMATCH', file.publicPath) };
  return { ...file, ok: true, seal };
}

/** Fecho: formato (`parseKeyRetirementClosureText`, motivo do S-11), forma canônica (S-07) e `retiredKeyId` = nome (S-08). */
export function judgeClosure(file: ReadFile & { readonly channel: ClosurePath }): JudgedClosure {
  const parsed = parseKeyRetirementClosureText(file.bytes);
  if (!parsed.ok) return { ...file, ok: false, closure: null, refusal: refusal('S-11', 'CLOSURE_FORMAT', file.publicPath) };
  const closure = parsed.value;
  if (!isCanonicalClosure(file.bytes, closure)) return { ...file, ok: false, closure, refusal: refusal('S-07', 'SEAL_NOT_CANONICAL', file.publicPath) };
  if (closure.retiredKeyId !== file.channel.keyId) return { ...file, ok: false, closure, refusal: refusal('S-08', 'SEAL_NAME_MISMATCH', file.publicPath) };
  return { ...file, ok: true, closure };
}
