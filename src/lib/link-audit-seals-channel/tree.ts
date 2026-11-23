import { budgetedFs, MAX_RUN_READ_BYTES, readBudget } from './budget';
import { closureLines, EMPTY_REPORT, guarded, manifestLines, type SealsCheckDeps, type SealsCheckReport } from './check';
import { refusal, sortRefusals, type SealsRefusal } from './codes';
import { candidatesOf, checkModes, judgeClosure, judgeSeal, readWithinLimits, type ClassifiedChange, type JudgedClosure, type JudgedSeal, type ReadFile } from './files';
import { classifyChannelPath, SEALS_ROOT, type ChannelEnvironment, type ChannelPath } from './paths';

/*
 * P9.5 — modo ÁRVORE do `seals-check` (spec `ci-deploy-and-seal-delivery.md` §5.5, job `seals-verify` do `deploy.yml`): as regras POR ARQUIVO
 * S-03 a S-08 sobre TODOS os arquivos de `link-audit-seals/<amb>/` do commit (não só os novos), antes da entrega, sem segredo. Não há S-01/S-02
 * (não é uma mudança), nem S-09/S-10 (as cadeias já passaram pelo verificador no merge, e o receptor verifica de novo no host os que faltam
 * lá), nem S-11 a S-13. No push, o job roda ANTES o modo de mudanças sobre o push (S-10 nas auditorias tocadas). Disco só pela porta
 * `BytesFsOps`; nenhum git, rede ou relógio. O resumo lista uma linha por arquivo, que o livro junta à linha da entrega da mesma execução
 * (§5.9).
 */

/** O mesmo teto de arquivos por execução da entrega (§5.5.2, `SEALS_TOO_MANY`), conferido antes de ler qualquer arquivo. */
export const MAX_TREE_FILES = 1000;
/** Teto da soma dos tamanhos lidos: o teto único de leitura de uma execução (`MAX_RUN_READ_BYTES`, 64 MiB). */
export const MAX_TREE_BYTES = MAX_RUN_READ_BYTES;

export interface SealsTreeInput {
  /** Raiz do checkout do commit. */
  readonly repoRoot: string;
  /** Caminho ⇒ modo no git do commit (`git ls-tree -r -z HEAD -- link-audit-seals`). */
  readonly modes: ReadonlyMap<string, string>;
  readonly env: ChannelEnvironment;
}

const isSealFile = (file: ReadFile): file is ReadFile & { readonly channel: Extract<ChannelPath, { readonly kind: 'seal' }> } => file.channel.kind === 'seal';
const isClosureFile = (file: ReadFile): file is ReadFile & { readonly channel: Extract<ChannelPath, { readonly kind: 'closure' }> } => file.channel.kind === 'closure';

/** Todo caminho da árvore do ambiente, como se fosse acrescentado (a gramática e a seleção dos candidatos são as do job `seals`). */
function treeOf(input: SealsTreeInput): ClassifiedChange[] {
  const prefix = `${SEALS_ROOT}/${input.env}/`;
  return [...input.modes.keys()]
    .filter((path) => path.startsWith(prefix))
    .sort()
    .map((path) => ({ entry: { status: 'A' as const, path }, channel: classifyChannelPath(path) ?? { kind: 'unexpected' as const } }));
}

/** O número de manifestos e fechos sob `<amb>/seals/` (o que a entrega envia). */
const deliverableCount = (tree: readonly ClassifiedChange[]): number => tree.filter(({ channel }) => channel.kind === 'seal' || channel.kind === 'closure').length;

/**
 * S-03 a S-08 sobre a árvore inteira de um ambiente. Acima de `MAX_TREE_FILES` manifestos e fechos ⇒ `SEALS_TOO_MANY` sem ler nada; toda leitura
 * conta no teto único da execução (esgotado ⇒ `SEALS_TOO_MANY`, `READ_BUDGET`). Uma falha inesperada não apaga as recusas já coletadas
 * (`incomplete`). A lista de confiança passa só pelo S-04 e pelo S-05 (o formato dela é do S-12, do PR).
 */
export async function runSealsTreeCheck(input: SealsTreeInput, deps: SealsCheckDeps): Promise<SealsCheckReport> {
  const tree = treeOf(input);
  if (tree.length === 0) return EMPTY_REPORT;
  const refusals: SealsRefusal[] = tree.filter(({ channel }) => channel.kind === 'unexpected').map(() => refusal('S-03', 'SEALS_UNEXPECTED_PATH'));
  if (deliverableCount(tree) > MAX_TREE_FILES) return { ...EMPTY_REPORT, touched: true, refusals: sortRefusals([...refusals, refusal('S-05', 'SEALS_TOO_MANY')]) };
  const candidates = candidatesOf(tree);
  const budget = readBudget(deps.readBudgetBytes);
  const fs = budgetedFs(deps.fs, budget);
  const state = { incomplete: false };
  const out = { seals: [] as JudgedSeal[], closures: [] as JudgedClosure[] };
  await guarded(state, async () => {
    const moded = await checkModes(candidates, input.modes, input.repoRoot, fs);
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
