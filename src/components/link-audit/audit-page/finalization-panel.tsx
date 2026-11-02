import { CircleCheck, FileCheck2, LoaderCircle, RotateCcw, ShieldAlert, TimerReset, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import { INCONCLUSIVE_HEADLINE, safeText, shortHash } from './labels';
import type { FinalizeFlow, PageState } from './state';
import { finalizeEligibility } from './state';
import { PendingRunPanel } from './pending-panels';
import { BUTTON_PRIMARY, BUTTON_QUIET, ConfirmDialog, useExpired } from './ui-bits';

export interface FinalizationPanelProps {
  readonly state: PageState;
  readonly onOpen: () => void;
  readonly onCancel: () => void;
  readonly onAck: (acknowledged: boolean) => void;
  readonly onConfirm: () => void;
  readonly onRetry: () => void;
  readonly onCompletePending: () => void;
  readonly onReloadPreview: () => void;
}

export function FinalizationPanel(p: FinalizationPanelProps): React.JSX.Element {
  const { state } = p;
  const flow = state.finalize;
  const waitingRateLimit = !useExpired(flow.phase === 'rate_limited' ? flow.until : 0); // re-renderiza no vencimento: o botão principal destrava sozinho
  const eligibility = finalizeEligibility(state);
  const busy = flow.phase === 'submitting' || flow.phase === 'verifying' || waitingRateLimit;
  const pendingRun = state.results.data?.pending ?? null;
  const outcome = state.preview.data?.outcomePreview ?? null;
  return (
    <div className="space-y-4">
      <p className="text-xs text-gmn-muted">Registrar grava um resultado <strong className="text-gmn-text">definitivo e imutável</strong>, ligado às evidências e às decisões da prévia exibida. {outcome?.outcome === 'INCONCLUSIVO' ? 'Como a prévia é inconclusiva, o registro não terá nota.' : ''}</p>

      {pendingRun && <PendingRunPanel key={pendingRun.contentSha256} pending={pendingRun} busy={busy} onComplete={p.onCompletePending} />}

      <button type="button" disabled={!eligibility.allowed} onClick={p.onOpen} aria-describedby="finalizar-motivo" className={`${BUTTON_PRIMARY} w-full`}>
        <FileCheck2 className="h-4 w-4" aria-hidden="true" />
        Registrar resultado…
      </button>
      <p id="finalizar-motivo" className="text-xs text-gmn-muted">{eligibility.allowed ? 'A API declarou que esta prévia pode ser registrada. Você confirmará antes de gravar.' : eligibility.reason}</p>

      <FocusOnSettle phase={flow.phase}>
        <FlowStatus flow={flow} onRetry={p.onRetry} onReloadPreview={p.onReloadPreview} />
      </FocusOnSettle>

      <ConfirmDialog open={flow.phase === 'confirming'} titleId="confirmar-titulo" descriptionId="confirmar-descricao" onClose={p.onCancel} fallbackFocusId="finalizacao">
        {flow.phase === 'confirming' && (
          <>
            <h2 id="confirmar-titulo" className="text-base font-semibold text-gmn-text">Registrar este resultado?</h2>
            <div id="confirmar-descricao" className="mt-2 space-y-2 text-sm text-gmn-muted">
              {flow.outcome === 'INCONCLUSIVO' ? <p><strong className="text-gmn-text">{INCONCLUSIVE_HEADLINE}</strong> Este registro não terá nota: ele guarda que as evidências são insuficientes{outcome ? ` (cobertura ${outcome.coveragePercent}%, mínimo ${outcome.minimumCoveragePercent}%)` : ''}.</p> : <p>Será registrado o resultado pontuado desta prévia{outcome?.level ? ` (nível ${outcome.level === 'PUBLICAVEL' ? 'publicável' : 'provisório'})` : ''}.</p>}
              <p>O registro fica ligado ao ponto exato do histórico de decisões <code className="text-xs">{flow.request.expectedHead ? `#${flow.request.expectedHead.seq} · ${shortHash(flow.request.expectedHead.sha256)}` : 'sem decisões'}</code> e à entrada <code className="text-xs">{shortHash(flow.request.expectedInputSha256)}</code>. Se algo mudar antes da gravação, nada é registrado.</p>
            </div>
            <label className="mt-3 flex min-h-11 items-start gap-2 text-sm text-gmn-text">
              <input type="checkbox" checked={flow.acknowledged} onChange={(event) => p.onAck(event.target.checked)} className="mt-1 h-4 w-4 accent-[#247BFF]" />
              <span>Entendo que o registro é definitivo e imutável e que ele reflete somente esta prévia.</span>
            </label>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={p.onCancel} className={BUTTON_QUIET}>Cancelar</button>
              <button type="button" disabled={!flow.acknowledged} onClick={p.onConfirm} className={BUTTON_PRIMARY}>Confirmar e registrar</button>
            </div>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** Quando o fluxo chega a um desfecho (sucesso, conflito, erro, pendência, limite), o foco vai para o aviso: o teclado não fica "perdido". */
const SETTLED: ReadonlySet<string> = new Set(['done', 'conflict', 'error', 'anchor_pending', 'rate_limited']);
function FocusOnSettle({ phase, children }: { readonly phase: string; readonly children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(phase);
  useEffect(() => {
    if (previous.current !== phase && SETTLED.has(phase)) ref.current?.focus();
    previous.current = phase;
  }, [phase]);
  return (
    <div ref={ref} tabIndex={-1} className="rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70">
      {children}
    </div>
  );
}

function RateLimited({ flow, onRetry }: { readonly flow: Extract<FinalizeFlow, { phase: 'rate_limited' }>; readonly onRetry: () => void }): React.JSX.Element {
  const expired = useExpired(flow.until);
  const left = Math.max(1, Math.ceil((flow.until - Date.now()) / 1000));
  return (
    <div role="alert" className="rounded-xl border border-gmn-warning/50 bg-gmn-warning/[0.06] p-3 text-xs">
      <p className="flex items-center gap-2 font-semibold text-gmn-text"><TimerReset className="h-4 w-4 text-amber-300" aria-hidden="true" />Limite de requisições atingido.</p>
      <p className="mt-1 text-gmn-muted">Nada foi gravado por esta tentativa: não é um resultado confirmado nem uma pendência de recibo. {flow.fromHeader ? `O servidor pediu para aguardar ${flow.seconds} s.` : `O servidor não informou o tempo; por prudência, aguarde ${flow.seconds} s.`} Nada é reenviado automaticamente.</p>
      <button type="button" disabled={!expired} onClick={onRetry} className={`${BUTTON_QUIET} mt-2`}>
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        {expired ? 'Reenviar o mesmo pedido' : `Reenviar o mesmo pedido (disponível em cerca de ${left} s)`}
      </button>
    </div>
  );
}

function FlowStatus({ flow, onRetry, onReloadPreview }: { readonly flow: FinalizeFlow; readonly onRetry: () => void; readonly onReloadPreview: () => void }): React.JSX.Element | null {
  switch (flow.phase) {
    case 'submitting':
      return <p role="status" className="flex items-center gap-2 text-xs text-gmn-muted"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />{flow.recovery ? 'Reenviando o pedido original…' : 'Gravando… aguarde a confirmação do servidor.'}</p>;
    case 'verifying':
      return <p role="status" className="flex items-center gap-2 text-xs text-gmn-muted"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Confirmado pelo servidor. Relendo e verificando o resultado s{String(flow.seq).padStart(4, '0')}…</p>;
    case 'done':
      return (
        <div role="status" className={`rounded-xl border p-3 text-xs ${flow.verified ? 'border-gmn-success/40 bg-gmn-success/[0.06]' : 'border-gmn-warning/50 bg-gmn-warning/[0.06]'}`}>
          <StatusBadge tone={flow.verified ? 'success' : 'warning'} label={flow.verified ? 'Confirmado e verificado' : 'Confirmado — verificação pendente'} icon={flow.verified ? CircleCheck : TriangleAlert} />
          <p className="mt-2 text-gmn-muted">Resultado s{String(flow.seq).padStart(4, '0')} {flow.recovered ? 'teve a confirmação concluída agora (a gravação foi anterior)' : flow.replayed ? 'já estava confirmado (nada novo foi gravado)' : 'gravado com recibo'}.{flow.changedAfter === true ? ' O estado já mudou desde a gravação: trate-o como histórico.' : ''}</p>
        </div>
      );
    case 'anchor_pending':
      return (
        <div role="alert" className="rounded-xl border border-dashed border-gmn-warning/60 bg-gmn-warning/[0.06] p-3 text-xs">
          <p className="font-semibold text-gmn-text">Confirmação NÃO concluída.</p>
          <p className="mt-1 text-gmn-muted">{safeText(flow.message, 400)} O resultado ainda não vale. Reenviar o mesmo pedido é seguro.</p>
          <button type="button" onClick={onRetry} className={`${BUTTON_PRIMARY} mt-2`}><RotateCcw className="h-4 w-4" aria-hidden="true" />Reenviar o mesmo pedido</button>
        </div>
      );
    case 'rate_limited':
      return <RateLimited flow={flow} onRetry={onRetry} />;
    case 'conflict':
      return (
        <div role="alert" className="rounded-xl border border-gmn-warning/50 bg-gmn-warning/[0.06] p-3 text-xs">
          <p className="flex items-center gap-2 font-semibold text-gmn-text"><TriangleAlert className="h-4 w-4 text-amber-300" aria-hidden="true" />Nada foi gravado: a situação mudou.</p>
          <p className="mt-1 text-gmn-muted">{safeText(flow.message, 400)} A prévia anterior foi invalidada e a nova é carregada automaticamente. Revise a prévia atual e confirme novamente.</p>
          {flow.blockers.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-gmn-muted">
              {flow.blockers.slice(0, 5).map((blocker) => (
                <li key={`${blocker.code}-${blocker.decisionIds.join(',')}`}>{safeText(blocker.message, 240)}</li>
              ))}
            </ul>
          )}
          <button type="button" onClick={onReloadPreview} className={`${BUTTON_QUIET} mt-2`}>Recarregar a prévia agora</button>
        </div>
      );
    case 'error':
      return (
        <div role="alert" className="rounded-xl border border-gmn-danger/40 bg-gmn-danger/[0.06] p-3 text-xs">
          <p className="flex items-center gap-2 font-semibold text-gmn-text"><ShieldAlert className="h-4 w-4 text-red-300" aria-hidden="true" />Não foi possível registrar.</p>
          <p className="mt-1 text-gmn-muted">{safeText(flow.message, 400)}</p>
          {flow.request && <button type="button" onClick={onRetry} className={`${BUTTON_QUIET} mt-2`}><RotateCcw className="h-4 w-4" aria-hidden="true" />Reenviar o mesmo pedido</button>}
        </div>
      );
    default:
      return null;
  }
}

