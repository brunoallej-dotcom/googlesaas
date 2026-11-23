import { archivePaths, archiveRefusals, MAX_ARCHIVE_FILES } from './archive';
import { budgetedFs, MAX_RUN_READ_BYTES, readBudget } from './budget';
import type { TreeEntry } from './changes';
import { closureLines, EMPTY_REPORT, guarded, manifestLines, type SealsCheckDeps, type SealsCheckReport } from './check';
import { refusal, sortRefusals, type SealsRefusal } from './codes';
import { candidatesOf, checkModes, judgeClosure, judgeSeal, readWithinLimits, type Candidate, type ClassifiedChange, type JudgedClosure, type JudgedSeal, type ReadFile } from './files';
import { checkoutPath, classifyChannelPath, SEALS_ROOT, SEALS_SUBDIR, type ChannelEnvironment, type ChannelPath } from './paths';

/*
 * P9.5 — modo ÁRVORE do `seals-check` (spec `ci-deploy-and-seal-delivery.md` §5.5, job `seals-verify` do `deploy.yml`): as regras POR ARQUIVO
 * S-03 a S-08 sobre TODOS os arquivos de `link-audit-seals/<amb>/` do commit (não só os novos), antes da entrega, sem segredo. Não há S-01/S-02
 * (não é uma mudança), nem S-09/S-10 (as cadeias já passaram pelo verificador no merge, e o receptor verifica de novo no host os que faltam
 * lá), nem S-11 a S-13. No push, o job roda ANTES o modo de mudanças sobre o push (S-10 nas auditorias tocadas). Disco só pela porta
 * `BytesFsOps`; nenhum git, rede ou relógio. O resumo lista uma linha por arquivo, que o livro junta à linha da entrega da mesma execução
 * (§5.9).
 *
 * Revisão do PR #74 (item 5): nenhum caminho do canal é descartado em silêncio. Caminho que não é UTF-8 ou fora da gramática ⇒ recusa (nunca
 * "árvore vazia"); uma entrada do git EXATAMENTE em `link-audit-seals`, `link-audit-seals/<amb>` ou `link-audit-seals/<amb>/seals` (arquivo,
 * link ou submódulo onde tem de haver pasta) ⇒ `SEALS_UNEXPECTED_PATH` (arquivo) ou `SEALS_BAD_MODE` (link, submódulo); e toda pasta ancestral
 * de um arquivo, no checkout, tem de ser diretório real (`lstat`, sem link) ANTES de qualquer leitura (senão `SEALS_UNEXPECTED_PATH`).
 */

/** O mesmo teto de arquivos por execução da entrega (§5.5.2), conferido antes de ler qualquer arquivo (`SEALS_ARCHIVE_FULL`, `archive.ts`). */
export const MAX_TREE_FILES = MAX_ARCHIVE_FILES;
/** Teto da soma dos tamanhos lidos: o teto único de leitura de uma execução (`MAX_RUN_READ_BYTES`, 64 MiB). */
export const MAX_TREE_BYTES = MAX_RUN_READ_BYTES;
/** Modos de arquivo comum no git (o resto, link `120000` e submódulo `160000`, é "modo errado"). */
const FILE_MODES: ReadonlySet<string> = new Set(['100644', '100755']);
const PATH_SEPARATOR = '/';

export interface SealsTreeInput {
  /** Raiz do checkout do commit. */
  readonly repoRoot: string;
  /** `git ls-tree -r -z HEAD -- link-audit-seals`, sem descartar nada (`parseTreeEntries`). */
  readonly entries: readonly TreeEntry[];
  readonly env: ChannelEnvironment;
}

const isSealFile = (file: ReadFile): file is ReadFile & { readonly channel: Extract<ChannelPath, { readonly kind: 'seal' }> } => file.channel.kind === 'seal';
const isClosureFile = (file: ReadFile): file is ReadFile & { readonly channel: Extract<ChannelPath, { readonly kind: 'closure' }> } => file.channel.kind === 'closure';
const startsWithBytes = (bytes: Uint8Array, prefix: string): boolean => Buffer.from(bytes).subarray(0, Buffer.byteLength(prefix)).equals(Buffer.from(prefix, 'utf8'));
/** O detalhe público de uma pasta do canal: relativo a `link-audit-seals/` (`<amb>`, `<amb>/seals`, …), ou `link-audit-seals` para a raiz. */
const folderDetail = (repoPath: string): string => (repoPath === SEALS_ROOT ? SEALS_ROOT : repoPath.slice(SEALS_ROOT.length + 1));

interface TreeScan {
  readonly tree: ClassifiedChange[];
  readonly refusals: SealsRefusal[];
}

/** A árvore do ambiente (cada caminho como se fosse acrescentado) e as recusas estruturais: nada do canal fica de fora. */
function scanTree(input: SealsTreeInput): TreeScan {
  const envDir = `${SEALS_ROOT}/${input.env}`;
  const folders = new Set([SEALS_ROOT, envDir, `${envDir}/${SEALS_SUBDIR}`]);
  const tree: ClassifiedChange[] = [];
  const refusals: SealsRefusal[] = [];
  for (const entry of input.entries) {
    if (entry.path === null) {
      if (startsWithBytes(entry.pathBytes, `${envDir}/`)) refusals.push(refusal('S-03', 'SEALS_UNEXPECTED_PATH'));
      continue;
    }
    if (folders.has(entry.path)) {
      // um arquivo, link ou submódulo onde a gramática exige uma pasta: nunca "nada sob o ambiente"
      refusals.push(FILE_MODES.has(entry.mode) ? refusal('S-03', 'SEALS_UNEXPECTED_PATH', null, folderDetail(entry.path)) : refusal('S-04', 'SEALS_BAD_MODE', null, folderDetail(entry.path)));
      continue;
    }
    if (!entry.path.startsWith(`${envDir}/`)) continue;
    tree.push({ entry: { status: 'A', path: entry.path }, channel: classifyChannelPath(entry.path) ?? { kind: 'unexpected' } });
  }
  tree.sort((a, b) => (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0));
  for (const item of tree) if (item.channel.kind === 'unexpected') refusals.push(refusal('S-03', 'SEALS_UNEXPECTED_PATH'));
  return { tree, refusals };
}

/** As pastas ancestrais de um caminho do repositório, da raiz do canal até a pasta do arquivo. */
function ancestorsOf(repoPath: string): string[] {
  const parts = repoPath.split(PATH_SEPARATOR).slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join(PATH_SEPARATOR));
}

async function isRealDirectory(fs: SealsCheckDeps['fs'], target: string): Promise<boolean> {
  try {
    const info = await fs.lstat(target);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false; // ausente ou ilegível: não é pasta real (falha fechada)
  }
}

/**
 * Toda pasta ancestral de cada candidato tem de ser, no checkout, diretório real (`lstat`, sem seguir link). Uma que não é (link, arquivo,
 * ausente) ⇒ `SEALS_UNEXPECTED_PATH` com a pasta no detalhe, e os candidatos sob ela não são lidos.
 */
async function realAncestors(candidates: readonly Candidate[], input: SealsTreeInput, fs: SealsCheckDeps['fs']): Promise<{ readonly kept: Candidate[]; readonly refusals: SealsRefusal[] }> {
  const verdict = new Map<string, boolean>();
  const refusals: SealsRefusal[] = [];
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    let real = true;
    for (const folder of ancestorsOf(candidate.repoPath)) {
      if (!verdict.has(folder)) {
        const ok = await isRealDirectory(fs, checkoutPath(input.repoRoot, folder));
        verdict.set(folder, ok);
        if (!ok) refusals.push(refusal('S-03', 'SEALS_UNEXPECTED_PATH', null, folderDetail(folder)));
      }
      if (verdict.get(folder) !== true) {
        real = false;
        break;
      }
    }
    if (real) kept.push(candidate);
  }
  return { kept, refusals };
}

const modesOf = (entries: readonly TreeEntry[]): ReadonlyMap<string, string> => new Map(entries.flatMap((entry) => (entry.path === null ? [] : [[entry.path, entry.mode] as const])));

/**
 * S-03 a S-08 sobre a árvore inteira de um ambiente. O arquivo do ambiente acima de 1000 caminhos ou da soma de bytes ⇒ `SEALS_ARCHIVE_FULL` sem
 * ler nada (revisão do PR #74, item 9); toda leitura conta no teto único da execução (esgotado ⇒ `SEALS_TOO_MANY`, `READ_BUDGET`). Uma falha inesperada não apaga as recusas já coletadas
 * (`incomplete`). A lista de confiança passa só pelo S-04 e pelo S-05 (o formato dela é do S-12, do PR).
 */
export async function runSealsTreeCheck(input: SealsTreeInput, deps: SealsCheckDeps): Promise<SealsCheckReport> {
  const { tree, refusals } = scanTree(input);
  if (tree.length === 0 && refusals.length === 0) return EMPTY_REPORT;
  const full = await archiveRefusals(input.env, archivePaths(tree.map((item) => item.entry.path), input.env), input.repoRoot, deps.fs);
  if (full.length > 0) return { ...EMPTY_REPORT, touched: true, refusals: sortRefusals([...refusals, ...full]) };
  const candidates = candidatesOf(tree);
  const budget = readBudget(deps.readBudgetBytes);
  const fs = budgetedFs(deps.fs, budget);
  const state = { incomplete: false };
  const out = { seals: [] as JudgedSeal[], closures: [] as JudgedClosure[] };
  await guarded(state, async () => {
    const ancestors = await realAncestors(candidates, input, fs);
    refusals.push(...ancestors.refusals);
    const moded = await checkModes(ancestors.kept, modesOf(input.entries), input.repoRoot, fs);
    refusals.push(...moded.refusals);
    const read = await readWithinLimits(moded.sized, input.repoRoot, fs, MAX_TREE_BYTES);
    refusals.push(...read.refusals);
    out.seals = read.files.filter(isSealFile).map(judgeSeal);
    out.closures = read.files.filter(isClosureFile).map(judgeClosure);
    for (const item of [...out.seals, ...out.closures]) if (!item.ok) refusals.push(item.refusal);
  });
  if (budget.exhausted) refusals.push(refusal('S-05', 'SEALS_TOO_MANY', null, 'READ_BUDGET'));
  return {
    touched: true,
    refusals: sortRefusals(refusals),
    manifests: manifestLines(candidates, out.seals),
    closures: closureLines(candidates, out.closures),
    trustLists: [],
    chains: [],
    chainsTruncated: false,
    incomplete: state.incomplete,
  };
}
