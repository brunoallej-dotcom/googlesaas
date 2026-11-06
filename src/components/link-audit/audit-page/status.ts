import type { StatusTone } from '@/components/ui/status-badge';
import { INCONCLUSIVE_HEADLINE, PREVIEW_STATE_LABELS } from './labels';
import type { PageState, SectionName } from './state';
import type { ResultsList, RunSummary } from './types';

/* Derivação PURA do estado da auditoria e da obsolescência dos resultados (I5). Nada aqui calcula pontuação. */
export type HeadlineKind = 'loading' | 'integrity' | 'unavailable' | 'no_evidence' | 'pending' | 'refused' | 'blocked' | 'inconclusive' | 'scored';

export interface Headline {
  readonly kind: HeadlineKind;
  readonly tone: StatusTone;
  readonly title: string;
  readonly lines: readonly string[];
  readonly coverage: { readonly percent: number; readonly minimum: number } | null;
}
export interface RegistryLine {
  readonly tone: StatusTone;
  readonly text: string;
  readonly historical: boolean;
}

const SECTION_NAMES: Readonly<Record<SectionName, string>> = {
  evidence: 'As evidências',
  preview: 'A prévia',
  decisions: 'O histórico de decisões',
  results: 'O histórico de resultados',
};

export function integrityFailures(state: PageState): SectionName[] {
  return (['evidence', 'preview', 'decisions', 'results'] as const).filter((name) => state[name].phase === 'integrity');
}

export function deriveHeadline(state: PageState): Headline {
  const failed = integrityFailures(state);
  if (failed.length > 0) {
    return {
      kind: 'integrity',
      tone: 'danger',
      title: 'Erro de integridade — nenhum dado afetado é exibido.',
      lines: failed.map((name) => `${SECTION_NAMES[name]} não passou na verificação de integridade.`),
      coverage: null,
    };
  }
  const { preview } = state;
  if (!preview.data) {
    if (preview.phase === 'idle' || preview.phase === 'loading') return { kind: 'loading', tone: 'neutral', title: 'Carregando a auditoria…', lines: [], coverage: null };
    return { kind: 'unavailable', tone: 'warning', title: 'A prévia não pôde ser carregada.', lines: preview.message ? [preview.message] : [], coverage: null };
  }
  const data = preview.data;
  const lines: string[] = [];
  if (preview.invalidated) lines.push(`Prévia desatualizada: ${preview.invalidated}`);
  if (preview.phase === 'error' || preview.phase === 'unavailable') lines.push('A última tentativa de recarregar a prévia falhou; os dados abaixo podem estar velhos.');
  const outcome = data.outcomePreview;
  const coverage = outcome ? { percent: outcome.coveragePercent, minimum: outcome.minimumCoveragePercent } : null;
  switch (data.state) {
    case 'SEM_EVIDENCIA':
      return { kind: 'no_evidence', tone: 'neutral', title: 'Sem evidência armazenada — nada foi calculado.', lines, coverage: null };
    case 'DECISAO_PENDENTE':
      return { kind: 'pending', tone: 'warning', title: 'Decisão pendente — ela ainda não vale e impede registrar o resultado.', lines: [...lines, 'Reenvie o mesmo pedido (o autor) para concluir a confirmação.'], coverage };
    case 'ENTRADA_RECUSADA':
      return { kind: 'refused', tone: 'danger', title: 'O motor recusou a entrada — nenhum resultado foi calculado.', lines: [...lines, ...data.blockers.filter((b) => b.severity === 'BLOCKING').slice(0, 3).map((b) => b.message)], coverage: null };
    default:
      break;
  }
  if (outcome?.outcome === 'PONTUADO' && !data.result?.index) {
    return { kind: 'refused', tone: 'warning', title: 'Resposta inconsistente: a prévia diz "pontuado" mas não trouxe o índice. Nada é exibido como nota.', lines, coverage };
  }
  const blocked = data.state === 'CALCULADO_NAO_FINALIZAVEL';
  if (outcome?.outcome === 'INCONCLUSIVO') {
    return {
      kind: blocked ? 'blocked' : 'inconclusive',
      tone: blocked ? 'warning' : 'neutral',
      title: INCONCLUSIVE_HEADLINE,
      lines: [...lines, ...(blocked ? ['Há bloqueios abertos: este resultado ainda não pode ser registrado.'] : [])],
      coverage,
    };
  }
  return {
    kind: blocked ? 'blocked' : 'scored',
    tone: blocked ? 'warning' : 'info',
    title: blocked ? 'Prévia calculada — há bloqueios que impedem registrar.' : 'Prévia pontuada — ainda não registrada: é uma prévia, não um resultado definitivo.',
    lines,
    coverage,
  };
}

/* ------------------------------------------------------------------ obsolescência (indicadores SEPARADOS) */
export interface Obsolescence {
  readonly historical: boolean;
  /** Não foi possível comparar com o estado de hoje. */
  readonly unknown: boolean;
  readonly reasons: readonly string[];
}

export function runObsolescence(run: RunSummary, changedAfter: boolean | null = null): Obsolescence {
  const reasons: string[] = [];
  if (run.superseded) reasons.push('Versão substituída por um registro mais novo.');
  if (run.stale === true) reasons.push('A entrada do motor mudou desde este registro (stale).');
  if (run.decisionsChanged === true) reasons.push('As decisões mudaram desde este registro: nova decisão, revogação ou pendência.');
  if (changedAfter === true) reasons.push('O estado já havia mudado logo após a gravação.');
  const unknown = !run.superseded && (run.stale === null || run.decisionsChanged === null);
  return { historical: reasons.length > 0, unknown, reasons };
}

export function latestRun(results: ResultsList | null): RunSummary | null {
  return results && results.results.length > 0 ? (results.results[results.results.length - 1] as RunSummary) : null;
}

export function deriveRegistry(state: PageState, changedAfter: boolean | null): RegistryLine | null {
  if (state.results.phase === 'integrity') return null;
  const results = state.results.data;
  if (!results) return state.results.phase === 'idle' || state.results.phase === 'loading' ? null : { tone: 'warning', text: 'O histórico de resultados não pôde ser carregado.', historical: false };
  const pad = (seq: number): string => `s${String(seq).padStart(4, '0')}`;
  if (results.pending) {
    return { tone: 'warning', text: `Resultado ${pad(results.pending.seq)} gravado e ainda NÃO confirmado (sem recibo): não vale.`, historical: false };
  }
  const latest = latestRun(results);
  if (!latest) return { tone: 'neutral', text: 'Nenhum resultado registrado ainda.', historical: false };
  const obsolescence = runObsolescence(latest, changedAfter);
  if (obsolescence.historical) return { tone: 'warning', text: `Último registro: ${pad(latest.seq)} confirmado — HISTÓRICO: pode não representar a situação atual.`, historical: true };
  if (obsolescence.unknown) return { tone: 'neutral', text: `Último registro: ${pad(latest.seq)} confirmado — não foi possível compará-lo com o estado atual.`, historical: false };
  return { tone: 'success', text: `Último registro: ${pad(latest.seq)} confirmado e coerente com o estado atual.`, historical: false };
}

export const previewStateLabel = (state: string): string => PREVIEW_STATE_LABELS[state] ?? 'Estado desconhecido';
