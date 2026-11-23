import type { BytesFsOps } from '../link-audit/fs-ops';
import { sealSha256 as sealDigestOf } from '../link-audit-evidence/provenance-core';
import { auditDirOf, chainRefusalCode, chainVerdicts, isAtEnd, seqsOnDisk, type ChainVerdict } from './chains';
import type { ChangeEntry } from './changes';
import { closureMotive } from './closures';
import { refusal, sortRefusals, type SealsRefusal } from './codes';
import { candidatesOf, checkModes, judgeClosure, judgeSeal, MAX_NEW_FILES, readWithinLimits, structuralRefusals, type Candidate, type ClassifiedChange, type JudgedClosure, type JudgedSeal, type ReadFile } from './files';
import { CHANNEL_ENVIRONMENTS, classifyChannelPath, isUnderSealsDir, SEALS_ROOT, SEALS_SUBDIR, sealsDirOf, sealsRelativePath, type ChannelEnvironment, type ChannelPath } from './paths';
import { commitTrust, judgeTrustList, togetherRefusals, type BaseTrustList, type CommitTrust } from './trust-rules';
import type { TrustTransitionNotice } from './trust-list';

/*
 * P9.2 — o núcleo do job `seals` (spec `ci-deploy-and-seal-delivery.md` §5.4): as regras S-01 a S-13 NA ORDEM sobre a lista de mudanças, com
 * disco só pela porta `BytesFsOps` (o checkout do commit) e nenhum git, rede, ambiente ou relógio. Todas as recusas são listadas; o código
 * fixo é o da primeira (ordem da regra). Cadeias não tocadas não são reverificadas (P9-S12). O mesmo núcleo vai ao receptor de manifestos (P9.3b).
 */

export interface SealsCheckInput {
  /** Raiz do checkout do commit (base + mudanças). */
  readonly repoRoot: string;
  readonly changes: readonly ChangeEntry[];
  /** Caminho ⇒ modo no git do commit (`git ls-tree -r -z HEAD`). */
  readonly modes: ReadonlyMap<string, string>;
  readonly baseTrust: Readonly<Record<ChannelEnvironment, BaseTrustList>>;
}
export interface SealsCheckDeps {
  readonly fs: BytesFsOps;
}

/** S-14, manifesto: caminho relativo à pasta de manifestos do ambiente, `sha256sum` dos bytes, `seq` e `sealSha256` (null = não apurado). */
export interface ManifestLine {
  readonly env: ChannelEnvironment;
  readonly relativePath: string;
  readonly bytesSha256: string | null;
  readonly seq: number | null;
  readonly sealSha256: string | null;
}
/** S-14, fecho: caminho, `sha256sum`, `retiredKeyId`, `signerKeyId` e TODAS as cabeças. */
export interface ClosureLine {
  readonly env: ChannelEnvironment;
  readonly relativePath: string;
  readonly bytesSha256: string | null;
  readonly retiredKeyId: string | null;
  readonly signerKeyId: string | null;
  readonly heads: ReadonlyArray<{ readonly auditId: string; readonly seq: number; readonly sealSha256: string }> | null;
}
export interface TrustListLine {
  readonly env: ChannelEnvironment;
  readonly bytesSha256: string | null;
  readonly items: number | null;
  readonly notices: readonly TrustTransitionNotice[];
}
export interface ChainInfoLine extends ChainVerdict {
  readonly env: ChannelEnvironment;
}
export interface SealsCheckReport {
  /** Algo mudou sob `link-audit-seals/`. */
  readonly touched: boolean;
  readonly refusals: readonly SealsRefusal[];
  readonly manifests: readonly ManifestLine[];
  readonly closures: readonly ClosureLine[];
  readonly trustLists: readonly TrustListLine[];
  /** Só informação: o veredito de cada cadeia do ambiente sob a lista nova, quando a lista mudou. */
  readonly chains: readonly ChainInfoLine[];
}

type SealPath = Extract<ChannelPath, { readonly kind: 'seal' }>;
type ClosurePath = Extract<ChannelPath, { readonly kind: 'closure' }>;
type TrustPath = Extract<ChannelPath, { readonly kind: 'trust-list' }>;
const isSealFile = (file: ReadFile): file is ReadFile & { readonly channel: SealPath } => file.channel.kind === 'seal';
const isClosureFile = (file: ReadFile): file is ReadFile & { readonly channel: ClosurePath } => file.channel.kind === 'closure';
const isTrustFile = (file: ReadFile): file is ReadFile & { readonly channel: TrustPath } => file.channel.kind === 'trust-list';

const EMPTY_REPORT: SealsCheckReport = { touched: false, refusals: [], manifests: [], closures: [], trustLists: [], chains: [] };

function classify(changes: readonly ChangeEntry[]): ClassifiedChange[] {
  return changes.flatMap((entry) => {
    const channel = classifyChannelPath(entry.path);
    return channel === null ? [] : [{ entry, channel }];
  });
}

const envOfSealsPath = (repoPath: string): ChannelEnvironment | null => CHANNEL_ENVIRONMENTS.find((env) => repoPath.startsWith(`${SEALS_ROOT}/${env}/${SEALS_SUBDIR}/`)) ?? null;

/** Ambientes com a lista mudada (qualquer status) e com arquivo novo sob `<amb>/seals/` (S-13). */
function environmentsTouched(changes: readonly ClassifiedChange[]): { readonly trust: Set<ChannelEnvironment>; readonly seals: Set<ChannelEnvironment> } {
  const trust = new Set<ChannelEnvironment>();
  const seals = new Set<ChannelEnvironment>();
  for (const { entry, channel } of changes) {
    if (channel.kind === 'trust-list') trust.add(channel.env);
    const env = entry.status === 'A' && isUnderSealsDir(entry.path) ? envOfSealsPath(entry.path) : null;
    if (env !== null) seals.add(env);
  }
  return { trust, seals };
}

interface ChainGroup {
  readonly env: ChannelEnvironment;
  readonly auditId: string;
  readonly candidates: ReadonlyArray<Candidate & { readonly channel: SealPath }>;
  readonly judged: readonly JudgedSeal[];
}

function chainGroups(candidates: readonly Candidate[], judged: readonly JudgedSeal[]): ChainGroup[] {
  const groups = new Map<string, ChainGroup>();
  for (const candidate of candidates) {
    if (candidate.channel.kind !== 'seal') continue;
    const { env, auditId } = candidate.channel;
    const key = `${env}/${auditId}`;
    const group = groups.get(key) ?? { env, auditId, candidates: [], judged: judged.filter((item) => item.channel.env === env && item.channel.auditId === auditId) };
    groups.set(key, { ...group, candidates: [...group.candidates, candidate as Candidate & { readonly channel: SealPath }] });
  }
  return [...groups.values()].sort((a, b) => (`${a.env}/${a.auditId}` < `${b.env}/${b.auditId}` ? -1 : 1));
}

/** S-09 (nomes) e S-10 (cadeia pelo verificador real), por auditoria com arquivo novo. O S-10 só roda se todo arquivo novo dela passou do S-04 ao S-08. */
async function chainRefusals(groups: readonly ChainGroup[], input: SealsCheckInput, trust: ReadonlyMap<ChannelEnvironment, CommitTrust>, fs: BytesFsOps): Promise<SealsRefusal[]> {
  const refusals: SealsRefusal[] = [];
  for (const group of groups) {
    const sealsDir = sealsDirOf(input.repoRoot, group.env);
    const newSeqs = group.candidates.map((candidate) => candidate.channel.seq);
    const baseSeqs = (await seqsOnDisk(fs, auditDirOf(sealsDir, group.auditId))).filter((seq) => !newSeqs.includes(seq));
    const lastPath = group.candidates.reduce((best, item) => (item.channel.seq > best.channel.seq ? item : best)).publicPath;
    if (!isAtEnd(baseSeqs, newSeqs)) refusals.push(refusal('S-09', 'SEALS_NOT_AT_END', lastPath));
    const passed = group.judged.filter((item): item is Extract<JudgedSeal, { readonly ok: true }> => item.ok);
    if (passed.length !== group.candidates.length) continue; // um arquivo novo recusado do S-04 ao S-08: a cadeia não é julgada
    const lastNew = passed.reduce((best, item) => (item.channel.seq > best.channel.seq ? item : best));
    const code = await chainRefusalCode({ sealsDir, auditId: group.auditId, trustValue: trust.get(group.env)?.value ?? '', lastNew: lastNew.seal }, fs);
    if (code !== null) refusals.push(refusal('S-10', code, lastNew.publicPath));
  }
  return refusals;
}

/** S-11 em cada fecho novo que passou do S-04 ao S-08, contra a lista do commit do ambiente. */
async function closureRefusals(closures: readonly JudgedClosure[], input: SealsCheckInput, trust: ReadonlyMap<ChannelEnvironment, CommitTrust>, fs: BytesFsOps): Promise<SealsRefusal[]> {
  const refusals: SealsRefusal[] = [];
  for (const item of closures) {
    if (!item.ok) continue;
    const motive = await closureMotive(item.closure, trust.get(item.channel.env)?.ring ?? null, sealsDirOf(input.repoRoot, item.channel.env), fs);
    if (motive !== null) refusals.push(refusal('S-11', `CLOSURE_${motive}`, item.publicPath));
  }
  return refusals;
}

async function commitTrustByEnvironment(repoRoot: string, fs: BytesFsOps): Promise<Map<ChannelEnvironment, CommitTrust>> {
  const trust = new Map<ChannelEnvironment, CommitTrust>();
  for (const env of CHANNEL_ENVIRONMENTS) trust.set(env, await commitTrust(repoRoot, env, fs));
  return trust;
}

function manifestLines(candidates: readonly Candidate[], judged: readonly JudgedSeal[]): ManifestLine[] {
  return candidates.flatMap((candidate) => {
    if (candidate.channel.kind !== 'seal') return [];
    const found = judged.find((item) => item.repoPath === candidate.repoPath);
    const seal = found?.seal ?? null;
    return [{ env: candidate.channel.env, relativePath: sealsRelativePath(candidate.channel) as string, bytesSha256: found?.bytesSha256 ?? null, seq: seal?.seq ?? null, sealSha256: seal ? sealDigestOf(seal) : null }];
  });
}

function closureLines(candidates: readonly Candidate[], judged: readonly JudgedClosure[]): ClosureLine[] {
  return candidates.flatMap((candidate) => {
    if (candidate.channel.kind !== 'closure') return [];
    const found = judged.find((item) => item.repoPath === candidate.repoPath);
    const closure = found?.closure ?? null;
    return [{ env: candidate.channel.env, relativePath: sealsRelativePath(candidate.channel) as string, bytesSha256: found?.bytesSha256 ?? null, retiredKeyId: closure?.retiredKeyId ?? null, signerKeyId: closure?.signerKeyId ?? null, heads: closure?.heads ?? null }];
  });
}


interface TrustStage {
  readonly refusals: SealsRefusal[];
  readonly lines: TrustListLine[];
  readonly chains: ChainInfoLine[];
}

/** S-12 em cada lista alterada e lida, e o veredito informativo das cadeias do ambiente sob a lista nova. */
async function trustStage(files: readonly ReadFile[], candidates: readonly Candidate[], input: SealsCheckInput, addedClosures: Readonly<Record<ChannelEnvironment, ReadonlySet<string>>>, fs: BytesFsOps): Promise<TrustStage> {
  const stage: TrustStage = { refusals: [], lines: [], chains: [] };
  for (const candidate of candidates) {
    if (candidate.channel.kind !== 'trust-list') continue;
    const env = candidate.channel.env;
    const file = files.filter(isTrustFile).find((item) => item.repoPath === candidate.repoPath);
    if (!file) {
      stage.lines.push({ env, bytesSha256: null, items: null, notices: [] });
      continue;
    }
    const outcome = await judgeTrustList({ file, base: input.baseTrust[env], repoRoot: input.repoRoot, addedClosureKeyIds: addedClosures[env] }, fs);
    stage.refusals.push(...outcome.refusals);
    stage.lines.push({ env, bytesSha256: file.bytesSha256, items: outcome.items, notices: outcome.notices });
    if (outcome.nextValue !== null) stage.chains.push(...(await chainVerdicts(sealsDirOf(input.repoRoot, env), outcome.nextValue, fs)).map((verdict) => ({ ...verdict, env })));
  }
  return stage;
}

function addedClosuresByEnvironment(candidates: readonly Candidate[]): Record<ChannelEnvironment, Set<string>> {
  const added: Record<ChannelEnvironment, Set<string>> = { producao: new Set(), homologacao: new Set() };
  for (const candidate of candidates) if (candidate.channel.kind === 'closure') added[candidate.channel.env].add(candidate.channel.keyId);
  return added;
}

/**
 * As regras S-01 a S-13 (§5.4) sobre a mudança. Nunca lança por conteúdo de arquivo (um erro de E/S inesperado do checkout sobe a quem chama,
 * que responde com falha fechada). Nada é escrito.
 */
export async function runSealsCheck(input: SealsCheckInput, deps: SealsCheckDeps): Promise<SealsCheckReport> {
  const classified = classify(input.changes);
  if (classified.length === 0) return EMPTY_REPORT;
  const refusals = structuralRefusals(classified);
  const candidates = candidatesOf(classified);
  const touched = environmentsTouched(classified);
  refusals.push(...togetherRefusals(touched.trust, touched.seals));
  if (candidates.length > MAX_NEW_FILES) return { ...EMPTY_REPORT, touched: true, refusals: sortRefusals([...refusals, refusal('S-05', 'SEALS_TOO_MANY')]) };
  const moded = await checkModes(candidates, input.modes, input.repoRoot, deps.fs);
  const read = await readWithinLimits(moded.sized, input.repoRoot, deps.fs);
  refusals.push(...moded.refusals, ...read.refusals);
  const seals = read.files.filter(isSealFile).map(judgeSeal);
  const closures = read.files.filter(isClosureFile).map(judgeClosure);
  for (const item of [...seals, ...closures]) if (!item.ok) refusals.push(item.refusal);
  const trust = await commitTrustByEnvironment(input.repoRoot, deps.fs);
  refusals.push(...(await chainRefusals(chainGroups(candidates, seals), input, trust, deps.fs)));
  refusals.push(...(await closureRefusals(closures, input, trust, deps.fs)));
  const stage = await trustStage(read.files, candidates, input, addedClosuresByEnvironment(candidates), deps.fs);
  refusals.push(...stage.refusals);
  return { touched: true, refusals: sortRefusals(refusals), manifests: manifestLines(candidates, seals), closures: closureLines(candidates, closures), trustLists: stage.lines, chains: stage.chains };
}
