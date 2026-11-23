import type { BytesFsOps } from '../link-audit/fs-ops';
import { sealSha256 as sealDigestOf } from '../link-audit-evidence/provenance-core';
import { budgetedFs, readBudget } from './budget';
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
  /** Teto de leitura da execução (padrão `MAX_RUN_READ_BYTES`); só os testes passam outro. */
  readonly readBudgetBytes?: number;
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
  /** O teto informativo acabou antes da última cadeia (a informação está incompleta; nada é recusado por isso). */
  readonly chainsTruncated: boolean;
  /** Uma etapa falhou de forma inesperada: as recusas coletadas valem, mas a verificação não terminou (falha fechada). */
  readonly incomplete: boolean;
}

type SealPath = Extract<ChannelPath, { readonly kind: 'seal' }>;
type ClosurePath = Extract<ChannelPath, { readonly kind: 'closure' }>;
type TrustPath = Extract<ChannelPath, { readonly kind: 'trust-list' }>;
const isSealFile = (file: ReadFile): file is ReadFile & { readonly channel: SealPath } => file.channel.kind === 'seal';
const isClosureFile = (file: ReadFile): file is ReadFile & { readonly channel: ClosurePath } => file.channel.kind === 'closure';
const isTrustFile = (file: ReadFile): file is ReadFile & { readonly channel: TrustPath } => file.channel.kind === 'trust-list';

export const EMPTY_REPORT: SealsCheckReport = { touched: false, refusals: [], manifests: [], closures: [], trustLists: [], chains: [], chainsTruncated: false, incomplete: false };

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

/** O que as etapas compartilham: a entrada, a porta já com o teto de leitura, as listas do commit e o coletor de recusas. */
interface Run {
  readonly input: SealsCheckInput;
  readonly fs: BytesFsOps;
  readonly refusals: SealsRefusal[];
  trust: ReadonlyMap<ChannelEnvironment, CommitTrust>;
}

/** Recusa de `<amb>/seals` (ou da pasta de uma auditoria) que existe e não é diretório real: nunca é listada. */
const notDirectory = (env: ChannelEnvironment, detail = `${env}/${SEALS_SUBDIR}`): SealsRefusal => refusal('S-03', 'SEALS_UNEXPECTED_PATH', null, detail);

/** S-09 (nomes) e S-10 (cadeia pelo verificador real), por auditoria com arquivo novo. O S-10 só roda se todo arquivo novo dela passou do S-04 ao S-08. */
async function chainStage(run: Run, groups: readonly ChainGroup[]): Promise<void> {
  for (const group of groups) {
    const sealsDir = sealsDirOf(run.input.repoRoot, group.env);
    const newSeqs = group.candidates.map((candidate) => candidate.channel.seq);
    const onDisk = await seqsOnDisk(run.fs, auditDirOf(sealsDir, group.auditId));
    if (onDisk === null) {
      run.refusals.push(notDirectory(group.env, `${group.env}/${SEALS_SUBDIR}/${group.auditId}`));
      continue;
    }
    const lastPath = group.candidates.reduce((best, item) => (item.channel.seq > best.channel.seq ? item : best)).publicPath;
    if (!isAtEnd(onDisk.filter((seq) => !newSeqs.includes(seq)), newSeqs)) run.refusals.push(refusal('S-09', 'SEALS_NOT_AT_END', lastPath));
    const passed = group.judged.filter((item): item is Extract<JudgedSeal, { readonly ok: true }> => item.ok);
    if (passed.length !== group.candidates.length) continue; // um arquivo novo recusado do S-04 ao S-08: a cadeia não é julgada
    const lastNew = passed.reduce((best, item) => (item.channel.seq > best.channel.seq ? item : best));
    const code = await chainRefusalCode({ sealsDir, auditId: group.auditId, trustValue: run.trust.get(group.env)?.value ?? '', lastNew: lastNew.seal }, run.fs);
    if (code !== null) run.refusals.push(refusal('S-10', code, lastNew.publicPath));
  }
}

/** S-11 em cada fecho novo que passou do S-04 ao S-08, contra a lista do commit do ambiente; fecho novo exige o signatário `active`. */
async function closureStage(run: Run, closures: readonly JudgedClosure[]): Promise<void> {
  for (const item of closures) {
    if (!item.ok) continue;
    const motive = await closureMotive(item.closure, run.trust.get(item.channel.env)?.ring ?? null, sealsDirOf(run.input.repoRoot, item.channel.env), run.fs, 'active');
    if (motive !== null) run.refusals.push(refusal('S-11', `CLOSURE_${motive}`, item.publicPath));
  }
}

async function commitTrustByEnvironment(repoRoot: string, fs: BytesFsOps): Promise<Map<ChannelEnvironment, CommitTrust>> {
  const trust = new Map<ChannelEnvironment, CommitTrust>();
  for (const env of CHANNEL_ENVIRONMENTS) trust.set(env, await commitTrust(repoRoot, env, fs));
  return trust;
}

export function manifestLines(candidates: readonly Candidate[], judged: readonly JudgedSeal[]): ManifestLine[] {
  return candidates.flatMap((candidate) => {
    if (candidate.channel.kind !== 'seal') return [];
    const found = judged.find((item) => item.repoPath === candidate.repoPath);
    const seal = found?.seal ?? null;
    return [{ env: candidate.channel.env, relativePath: sealsRelativePath(candidate.channel) as string, bytesSha256: found?.bytesSha256 ?? null, seq: seal?.seq ?? null, sealSha256: seal ? sealDigestOf(seal) : null }];
  });
}

export function closureLines(candidates: readonly Candidate[], judged: readonly JudgedClosure[]): ClosureLine[] {
  return candidates.flatMap((candidate) => {
    if (candidate.channel.kind !== 'closure') return [];
    const found = judged.find((item) => item.repoPath === candidate.repoPath);
    const closure = found?.closure ?? null;
    return [{ env: candidate.channel.env, relativePath: sealsRelativePath(candidate.channel) as string, bytesSha256: found?.bytesSha256 ?? null, retiredKeyId: closure?.retiredKeyId ?? null, signerKeyId: closure?.signerKeyId ?? null, heads: closure?.heads ?? null }];
  });
}

/** S-12 em cada lista alterada e lida. Devolve as linhas do resumo e, por ambiente, a lista nova (para o veredito informativo). */
async function trustStage(run: Run, files: readonly ReadFile[], candidates: readonly Candidate[], lines: TrustListLine[]): Promise<Map<ChannelEnvironment, string>> {
  const nextValues = new Map<ChannelEnvironment, string>();
  const addedClosures = addedClosuresByEnvironment(candidates);
  for (const candidate of candidates) {
    if (candidate.channel.kind !== 'trust-list') continue;
    const env = candidate.channel.env;
    const file = files.filter(isTrustFile).find((item) => item.repoPath === candidate.repoPath);
    if (!file) {
      lines.push({ env, bytesSha256: null, items: null, notices: [] });
      continue;
    }
    const outcome = await judgeTrustList({ file, base: run.input.baseTrust[env], repoRoot: run.input.repoRoot, addedClosureKeyIds: addedClosures[env] }, run.fs);
    run.refusals.push(...outcome.refusals);
    lines.push({ env, bytesSha256: file.bytesSha256, items: outcome.items, notices: outcome.notices });
    if (outcome.nextValue !== null) nextValues.set(env, outcome.nextValue);
  }
  return nextValues;
}

/**
 * Só informação (§5.4): o veredito de cada cadeia do ambiente sob a lista nova, com teto de leitura PRÓPRIO (esgotado, trunca). A única
 * recusa possível é a de `<amb>/seals` que não é diretório real (nunca listado).
 */
async function informativeStage(run: Run, nextValues: ReadonlyMap<ChannelEnvironment, string>, budgetBytes: number | undefined, out: { chains: ChainInfoLine[]; truncated: boolean }, rawFs: BytesFsOps): Promise<void> {
  const budget = readBudget(budgetBytes);
  const fs = budgetedFs(rawFs, budget);
  for (const [env, value] of nextValues) {
    const listed = await chainVerdicts(sealsDirOf(run.input.repoRoot, env), value, fs, () => budget.exhausted);
    if (listed.kind === 'not-directory') {
      run.refusals.push(notDirectory(env));
      continue;
    }
    out.chains.push(...listed.verdicts.map((verdict) => ({ ...verdict, env })));
    if (listed.truncated) {
      out.truncated = true;
      return;
    }
  }
}

function addedClosuresByEnvironment(candidates: readonly Candidate[]): Record<ChannelEnvironment, Set<string>> {
  const added: Record<ChannelEnvironment, Set<string>> = { producao: new Set(), homologacao: new Set() };
  for (const candidate of candidates) if (candidate.channel.kind === 'closure') added[candidate.channel.env].add(candidate.channel.keyId);
  return added;
}

/** Roda uma etapa sem deixar uma falha inesperada apagar as recusas já coletadas: a falha só marca a execução como incompleta. */
export async function guarded(state: { incomplete: boolean }, stage: () => Promise<void>): Promise<void> {
  try {
    await stage();
  } catch {
    state.incomplete = true;
  }
}

/**
 * As regras S-01 a S-13 (§5.4) sobre a mudança. Uma falha inesperada numa etapa não apaga as recusas já coletadas: a execução fica
 * `incomplete` (quem chama recusa com a primeira recusa ou, sem nenhuma, com falha interna). Toda leitura conta no teto único da execução
 * (`MAX_RUN_READ_BYTES`); esgotado ⇒ `SEALS_TOO_MANY` (`READ_BUDGET`). Nada é escrito.
 */
export async function runSealsCheck(input: SealsCheckInput, deps: SealsCheckDeps): Promise<SealsCheckReport> {
  const classified = classify(input.changes);
  if (classified.length === 0) return EMPTY_REPORT;
  const touched = environmentsTouched(classified);
  const candidates = candidatesOf(classified);
  const refusals = [...structuralRefusals(classified), ...togetherRefusals(touched.trust, touched.seals)];
  if (candidates.length > MAX_NEW_FILES) return { ...EMPTY_REPORT, touched: true, refusals: sortRefusals([...refusals, refusal('S-05', 'SEALS_TOO_MANY')]) };
  const budget = readBudget(deps.readBudgetBytes);
  const run: Run = { input, fs: budgetedFs(deps.fs, budget), refusals, trust: new Map() };
  const state = { incomplete: false };
  const out = { files: [] as ReadFile[], seals: [] as JudgedSeal[], closures: [] as JudgedClosure[], lines: [] as TrustListLine[], chains: [] as ChainInfoLine[], truncated: false, next: new Map<ChannelEnvironment, string>() };
  await guarded(state, async () => {
    const moded = await checkModes(candidates, input.modes, input.repoRoot, run.fs);
    refusals.push(...moded.refusals);
    const read = await readWithinLimits(moded.sized, input.repoRoot, run.fs);
    refusals.push(...read.refusals);
    out.files = read.files;
    out.seals = read.files.filter(isSealFile).map(judgeSeal);
    out.closures = read.files.filter(isClosureFile).map(judgeClosure);
    for (const item of [...out.seals, ...out.closures]) if (!item.ok) refusals.push(item.refusal);
    run.trust = await commitTrustByEnvironment(input.repoRoot, run.fs);
  });
  await guarded(state, () => chainStage(run, chainGroups(candidates, out.seals)));
  await guarded(state, () => closureStage(run, out.closures));
  await guarded(state, async () => {
    out.next = await trustStage(run, out.files, candidates, out.lines);
  });
  await guarded(state, () => informativeStage(run, out.next, deps.readBudgetBytes, out, deps.fs));
  if (budget.exhausted) refusals.push(refusal('S-05', 'SEALS_TOO_MANY', null, 'READ_BUDGET'));
  return { touched: true, refusals: sortRefusals(refusals), manifests: manifestLines(candidates, out.seals), closures: closureLines(candidates, out.closures), trustLists: out.lines, chains: out.chains, chainsTruncated: out.truncated, incomplete: state.incomplete };
}
