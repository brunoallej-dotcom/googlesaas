import type { OperatorRecord } from '../link-audit/scoring/input';
import type { SubcriterionId } from '../link-audit/scoring/types';
import type { BlockerCode, BlockerSeverity, MapperBlocker } from './types';

/*
 * Bloqueios da prévia (spec §13). PURO. `BLOCKING` impede a finalização; `WARNING` é informativo. As mensagens são fixas e nunca
 * repetem valores da fonte. A ligação de um erro à decisão responsável (`op-NNNN`) é ESTRUTURADA: vem dos campos dos registros ou de
 * um EXPERIMENTO (`attributeFailure`: o próprio juiz — contrato do mapeador ou motor — é reexecutado sem cada registro), nunca da
 * leitura do texto de uma mensagem de erro.
 */
export type PreviewBlockerCode = BlockerCode | ServiceBlockerCode;

/** Códigos que o SERVIÇO emite (têm mensagem própria aqui); os demais vêm do mapeador com a mensagem dele. */
export type ServiceBlockerCode = 'NO_STORED_CAPTURE' | 'DECISION_PENDING' | 'DECISION_NEEDS_SITE_SCOPE' | 'DECISION_CATEGORY_MISMATCH' | 'DECISION_BASIS_UNVERIFIABLE' | 'DECISION_NOT_SUPPORTED' | 'EVIDENCE_PROVENANCE_UNPROVEN' | 'DECISIONS_HISTORY_UNRESOLVED' | 'ENGINE_REJECTED_INPUT';

export interface PreviewBlocker {
  readonly code: PreviewBlockerCode;
  readonly severity: BlockerSeverity;
  readonly message: string;
  readonly reasonCode: string | null;
  readonly decisionIds: readonly string[];
  readonly subcriterionIds: readonly SubcriterionId[];
}

const SERVICE_MESSAGES: Readonly<Record<ServiceBlockerCode, string>> = {
  DECISION_NOT_SUPPORTED: 'A decisão está fora do contrato aprovado da Onda 6C e não foi aplicada; ela impede a finalização. Revogue a decisão.',
  NO_STORED_CAPTURE: 'Não há captura armazenada e íntegra com relatório: nada foi enviado ao motor. É preciso coletar (fora desta etapa).',
  DECISION_PENDING: 'Há uma decisão gravada e ainda não confirmada (sem recibo). Ela não vale, a decisão que ela revoga ou substitui NÃO é considerada vigente enquanto isso, e a prévia não pode ser finalizada; o autor, com a origem comprovada, conclui reenviando o mesmo pedido.',
  DECISION_NEEDS_SITE_SCOPE: 'A decisão depende da leitura verificável do site, que ainda não existe. Ela não foi aplicada; revogue a decisão.',
  DECISION_CATEGORY_MISMATCH: 'O juízo C2 foi registrado antes da captura que fundamenta a categoria atual e não foi aplicado. Registre um novo juízo (substituindo este) ou revogue-o.',
  DECISION_BASIS_UNVERIFIABLE: 'A captura em que o juízo C2 foi registrado não existe mais ou não confere com as evidências atuais (restauração ou adulteração). O juízo não foi aplicado; substitua-o ou revogue-o.',
  DECISIONS_HISTORY_UNRESOLVED: 'A integridade do histórico de decisões NÃO está resolvida: a testemunha independente (resultados já selados) mostra que falta uma posição do histórico ou que ela é outra, não é confiável, não pôde ser lida ou não está configurada. Nenhuma decisão humana foi enviada ao motor e nada pode ser finalizado. Não apague nem mova arquivos; restaure o par decisões + recibos do mesmo instante a partir do backup e avise a operação.',
  EVIDENCE_PROVENANCE_UNPROVEN: 'A origem da coleta NÃO foi comprovada por uma prova independente (manifesto assinado fora da pasta de evidências). O SHA-256 prova que o arquivo não mudou depois de selado, não que veio da coleta; por isso o resultado não pode ser finalizado. A prévia continua consultável.',
  ENGINE_REJECTED_INPUT: 'O motor recusou a entrada montada: não há resultado.',
};

const uniqueSorted = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort();

export function previewBlocker(
  code: ServiceBlockerCode,
  severity: BlockerSeverity,
  extra: { reasonCode?: string; decisionIds?: readonly string[]; subcriterionIds?: readonly SubcriterionId[] } = {},
): PreviewBlocker {
  return { code, severity, message: SERVICE_MESSAGES[code], reasonCode: extra.reasonCode ?? null, decisionIds: uniqueSorted(extra.decisionIds ?? []), subcriterionIds: uniqueSorted(extra.subcriterionIds ?? []) };
}

export const fromMapper = (blocker: MapperBlocker, override: { decisionIds?: readonly string[]; subcriterionIds?: readonly SubcriterionId[] } = {}): PreviewBlocker => ({
  code: blocker.code,
  severity: blocker.severity,
  message: blocker.message,
  reasonCode: blocker.reasonCode,
  decisionIds: uniqueSorted(override.decisionIds ?? blocker.decisionIds),
  subcriterionIds: uniqueSorted(override.subcriterionIds ?? blocker.subcriterionIds),
});

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** BLOCKING primeiro, depois código, motivo e ids: a ordem não depende da ordem de montagem. */
export const sortPreviewBlockers = (items: readonly PreviewBlocker[]): PreviewBlocker[] =>
  [...items].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'BLOCKING' ? -1 : 1) || cmp(a.code, b.code) || cmp(a.reasonCode ?? '', b.reasonCode ?? '') || cmp(a.decisionIds.join(','), b.decisionIds.join(',')));

export interface Attribution {
  /** Decisões responsáveis (um subconjunto mínimo por rodada, repetido até a entrada passar). */
  readonly ids: readonly string[];
  /** `false` se o orçamento de execuções acabou antes de isolar os responsáveis (os ids são então candidatos, não prova). */
  readonly exact: boolean;
  /** A falha persiste SEM nenhuma decisão: o defeito não é das decisões. */
  readonly independentOfDecisions: boolean;
}

export const MAX_ATTRIBUTION_RUNS = 120;

/**
 * Descobre QUAIS registros causam a falha por experimento: `fails(subconjunto)` reexecuta o juiz real. Usa DELTA DEBUGGING
 * (ddmin: bisseção em subconjuntos e complementos, custo ~O(k·log n) para k culpados em n registros) para achar um subconjunto
 * minimamente culpado (dois registros que só falham juntos aparecem juntos) e repete sobre o restante até o juiz aceitar.
 * Determinístico (ordem por id). Se o orçamento de execuções acabar, devolve CANDIDATOS (`exact:false`), nunca omite um culpado.
 */
export function attributeFailure(records: readonly OperatorRecord[], fails: (subset: readonly OperatorRecord[]) => boolean, maxRuns = MAX_ATTRIBUTION_RUNS): Attribution {
  let runs = 0;
  const budget = (): boolean => runs >= maxRuns;
  const test = (subset: readonly OperatorRecord[]): boolean => {
    runs += 1;
    return fails(subset);
  };
  const sorted = [...records].sort((a, b) => cmp(a.id, b.id));
  if (test([])) return { ids: [], exact: true, independentOfDecisions: true };
  const found: string[] = [];
  let pool = sorted;
  while (pool.length > 0) {
    if (budget()) return { ids: uniqueSorted([...found, ...pool.map((record) => record.id)]), exact: false, independentOfDecisions: false };
    if (!test(pool)) break;
    // ddmin sobre `pool` (que falha)
    let current = pool;
    let granularity = 2;
    while (current.length >= 2) {
      if (budget()) return { ids: uniqueSorted([...found, ...pool.map((item) => item.id)]), exact: false, independentOfDecisions: false }; // o que sobra do `pool` pode ter outros culpados: todos são candidatos
      const size = Math.ceil(current.length / granularity);
      const chunks: OperatorRecord[][] = [];
      for (let i = 0; i < current.length; i += size) chunks.push(current.slice(i, i + size));
      let reduced = false;
      for (const chunk of chunks) {
        if (budget()) break;
        if (chunk.length < current.length && test(chunk)) {
          current = chunk;
          granularity = 2;
          reduced = true;
          break;
        }
      }
      if (!reduced && granularity > 2) {
        for (const chunk of chunks) {
          if (budget()) break;
          const complement = current.filter((item) => !chunk.includes(item));
          if (complement.length > 0 && test(complement)) {
            current = complement;
            granularity = Math.max(granularity - 1, 2);
            reduced = true;
            break;
          }
        }
      }
      if (!reduced) {
        if (granularity >= current.length) break;
        granularity = Math.min(granularity * 2, current.length);
      }
    }
    found.push(...current.map((item) => item.id));
    pool = pool.filter((record) => !current.includes(record));
  }
  return { ids: uniqueSorted(found), exact: !budget() || pool.length === 0, independentOfDecisions: false };
}
