import { CircleCheck, Hand, History, LoaderCircle, RotateCcw, Undo2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import { DECISION_KIND_LABELS, DECISION_STATUS_LABELS, formatDateTime, JUDGEMENT_C2_VALUES, OPTION_UNAVAILABLE_LABELS, safeText } from './labels';
import { HistoryIntegrityBanner, LedgerPanel, PendingDecisionPanel, WitnessCoverageNote } from './pending-panels';
import type { DecisionForm, OptionKey, RevokeFlow } from './state';
import type { DecisionDto, DecisionsList, LedgerActionKind, PreviewPayload } from './types';
import { BUTTON_PRIMARY, BUTTON_QUIET, FIELD_CLASS } from './ui-bits';

const HELD_LABELS: Readonly<Record<string, string>> = {
  DECISION_NOT_SUPPORTED: 'Retida: fora do contrato aprovado — não entrou no cálculo; revogue-a.',
  DECISION_NEEDS_SITE_SCOPE: 'Retida: depende da leitura do site, que ainda não existe — revogue-a.',
  DECISION_CATEGORY_MISMATCH: 'Retida: registrada antes da captura atual da categoria — substitua ou revogue.',
  DECISION_BASIS_UNVERIFIABLE: 'Retida: a captura em que foi registrada não confere mais — substitua ou revogue.',
};

function describeRecord(dto: DecisionDto): string {
  const record = dto.record;
  const subject = typeof record.subcriterionId === 'string' ? record.subcriterionId : Array.isArray(record.subcriterionIds) ? record.subcriterionIds.map((id) => safeText(id, 8)).join(', ') : '';
  const value = typeof record.value === 'string' ? ` · ${safeText(record.value, 40)}` : typeof record.code === 'string' ? ` · ${safeText(record.code, 40)}` : '';
  return `${DECISION_KIND_LABELS[dto.kind] ?? dto.kind}${subject ? ` — ${subject}` : ''}${value}`;
}

export interface DecisionsPanelProps {
  readonly decisions: DecisionsList;
  readonly preview: PreviewPayload | null;
  readonly form: DecisionForm;
  readonly revoke: RevokeFlow;
  readonly canWrite: boolean;
  /** Pode agir sobre o LIVRO (inscrever/recuperar) mesmo fora de PROTECTED. */
  readonly canLedger: boolean;
  readonly onOpenForm: (key: OptionKey) => void;
  readonly onCloseForm: () => void;
  readonly onFormField: (patch: { value?: string; justification?: string }) => void;
  readonly onSubmitForm: () => void;
  readonly onResendForm: () => void;
  readonly onOpenRevoke: (decisionId: string) => void;
  readonly onCloseRevoke: () => void;
  readonly onRevokeField: (reason: string) => void;
  readonly onSubmitRevoke: () => void;
  readonly onResendRevoke: () => void;
  readonly onResendListed: () => void;
  readonly onLedgerAction: (action: LedgerActionKind) => void;
}

export function DecisionsPanel(p: DecisionsPanelProps): React.JSX.Element {
  const held = new Map((p.preview?.decisions.held ?? []).map((item) => [item.decisionId, item.code]));
  const options = p.preview?.decisionOptions ?? [];
  const history = [...p.decisions.history].reverse();
  const inactive = p.decisions.allDecisions.filter((dto) => dto.status !== 'ACTIVE');
  return (
    <div className="space-y-5">
      <LedgerPanel ledger={p.decisions.ledger} canAct={p.canLedger} onAction={p.onLedgerAction} />
      <HistoryIntegrityBanner status={p.decisions.witness.status} />
      <WitnessCoverageNote witness={p.decisions.witness} />
      {p.decisions.pending && <PendingDecisionPanel key={p.decisions.pending.entrySha256} pending={p.decisions.pending} ambiguousIds={p.decisions.ambiguousDecisionIds} witness={p.decisions.witness.status} ledger={p.decisions.ledger} onResend={p.onResendListed} />}

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gmn-muted">Decisões vigentes ({p.decisions.decisions.length})</h3>
        {p.decisions.decisions.length === 0 ? (
          <p className="mt-2 rounded-xl border border-dashed border-white/15 p-4 text-center text-xs text-gmn-muted">Nenhuma decisão humana vigente. O cálculo usa apenas dados automáticos verificados.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {p.decisions.decisions.map((dto) => (
              <li key={dto.decisionId} className="rounded-xl border border-white/[0.06] bg-gmn-tile/50 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-gmn-text"><span className="font-mono text-gmn-muted">{dto.decisionId}</span> {describeRecord(dto)}</p>
                  <button type="button" disabled={!p.canWrite} onClick={() => p.onOpenRevoke(dto.decisionId)} className={BUTTON_QUIET} aria-label={`Revogar a decisão ${dto.decisionId}`}><Undo2 className="h-4 w-4" aria-hidden="true" />Revogar</button>
                </div>
                <p className="mt-1 text-gmn-muted">Registrada em {formatDateTime(dto.recordedAt)} por {safeText(dto.recordedBy, 120)}{dto.supersedes ? ` · substitui ${dto.supersedes}` : ''}</p>
                {held.has(dto.decisionId) && <p className="mt-1 text-amber-300">{HELD_LABELS[held.get(dto.decisionId) as string] ?? 'Retida: não entrou no cálculo.'}</p>}
                {typeof dto.record.justification === 'string' && (
                  <details className="mt-1">
                    <summary className="flex min-h-11 cursor-pointer items-center text-gmn-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70">Justificativa do operador</summary>
                    <p className="mt-1 whitespace-pre-wrap break-words text-gmn-text">{safeText(dto.record.justification, 2000)}</p>
                  </details>
                )}
                {p.revoke.decisionId === dto.decisionId && p.revoke.phase !== 'closed' && <RevokeForm {...p} />}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gmn-muted">Registrar decisão</h3>
        <p className="mt-1 text-xs text-gmn-muted">Só aparecem os tipos que o contrato aprovado aceita. Os demais tipos da 6B não são oferecidos aqui.</p>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {options.map((option) => {
            const key = option.subcriterionId as OptionKey;
            return (
              <li key={option.subcriterionId} className="rounded-xl border border-white/[0.06] bg-gmn-tile/50 p-3 text-xs">
                <p className="font-medium text-gmn-text">{option.type === 'JUDGEMENT' ? 'Juízo sobre a categoria principal (C2)' : 'Marcar S4 como não aplicável (modelo de negócio)'}</p>
                {option.reasonCode && <p className="mt-1 text-gmn-muted">{OPTION_UNAVAILABLE_LABELS[option.reasonCode] ?? 'Indisponível agora.'}</p>}
                <button type="button" disabled={!option.available || !p.canWrite} onClick={() => p.onOpenForm(key)} className={`${BUTTON_QUIET} mt-2`}><Hand className="h-4 w-4" aria-hidden="true" />{option.reasonCode === 'EXISTING_DECISION_REPLACE' ? 'Substituir' : 'Registrar'}</button>
              </li>
            );
          })}
          {options.length === 0 && <li className="text-xs text-gmn-muted">Nenhum tipo disponível: não há prévia calculada.</li>}
        </ul>
        {p.form.phase !== 'closed' && <DecisionFormView {...p} />}
      </div>

      <details className="rounded-xl border border-white/[0.06] bg-gmn-tile/40">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-xs font-semibold text-gmn-text focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70"><History className="h-4 w-4 text-gmn-muted" aria-hidden="true" />Histórico completo ({history.length})</summary>
        <ol className="space-y-1 px-3 pb-3 text-xs text-gmn-muted">
          {history.map((entry) => (
            <li key={entry.seq}>#{entry.seq} · {formatDateTime(entry.recordedAt)} · {entry.action === 'REVOKE' ? `revogou ${safeText(entry.revokes, 12)}` : `registrou ${safeText(entry.decisionId, 12)}`} · {safeText(entry.recordedBy, 120)}{entry.reason ? ` · motivo: ${safeText(entry.reason, 300)}` : ''}</li>
          ))}
          {inactive.map((dto) => (
            <li key={`i-${dto.decisionId}`} className="text-gmn-muted/80">{dto.decisionId}: <StatusBadge tone="neutral" label={DECISION_STATUS_LABELS[dto.status] ?? dto.status} icon={CircleCheck} dashed /></li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function DecisionFormView(p: DecisionsPanelProps): React.JSX.Element {
  const { form } = p;
  const busy = form.phase === 'submitting';
  const isC2 = form.optionKey === 'C2';
  const errorId = 'decisao-erros';
  const selectRef = useRef<HTMLSelectElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // ao abrir, o foco vai para o PRIMEIRO campo (o juízo no C2; a justificativa no S4)
  useEffect(() => {
    (isC2 ? selectRef.current : textRef.current)?.focus();
  }, [isC2]);
  return (
    <form
      className="mt-3 space-y-3 rounded-xl border border-gmn-accent/30 bg-gmn-accent/[0.04] p-4"
      aria-labelledby="decisao-titulo"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy && !event.nativeEvent.isComposing) {
          event.stopPropagation();
          p.onCloseForm();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        p.onSubmitForm();
      }}
    >
      <h4 id="decisao-titulo" className="text-sm font-semibold text-gmn-text">{isC2 ? 'Juízo sobre a categoria principal (C2)' : 'S4 não aplicável — modelo de negócio'}</h4>
      {isC2 && (
        <div>
          <label htmlFor="decisao-valor" className="text-xs font-medium text-gmn-text">Juízo</label>
          <select ref={selectRef} id="decisao-valor" value={form.value} disabled={busy} onChange={(event) => p.onFormField({ value: event.target.value })} aria-invalid={form.fieldErrors.length > 0 && !form.value} aria-describedby={form.fieldErrors.length > 0 ? errorId : undefined} className={`${FIELD_CLASS} mt-1 min-h-11`}>
            <option value="">Selecione…</option>
            {JUDGEMENT_C2_VALUES.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label htmlFor="decisao-justificativa" className="text-xs font-medium text-gmn-text">Justificativa (mín. 20 caracteres; fica registrada com seu e-mail e a data)</label>
        <textarea ref={textRef} id="decisao-justificativa" rows={3} maxLength={2000} value={form.justification} disabled={busy} onChange={(event) => p.onFormField({ justification: event.target.value })} aria-describedby={form.fieldErrors.length > 0 ? errorId : undefined} aria-invalid={form.fieldErrors.length > 0 && form.justification.trim().length < 20} className={`${FIELD_CLASS} mt-1`} />
        <p className="mt-1 text-right text-[11px] text-gmn-muted">{form.justification.trim().length}/2000</p>
      </div>
      {form.fieldErrors.length > 0 && (
        <ul id={errorId} role="alert" className="list-disc space-y-0.5 pl-5 text-xs text-red-300">
          {form.fieldErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {form.message && (
        <p role="alert" className={`rounded-lg border px-3 py-2 text-xs ${form.phase === 'pending' ? 'border-gmn-warning/50 text-amber-200' : form.phase === 'conflict' ? 'border-gmn-warning/50 text-amber-200' : 'border-gmn-danger/40 text-red-200'}`}>
          {form.phase === 'conflict' ? `Conflito: ${form.message} Seu rascunho foi mantido; revise e envie de novo.` : form.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {form.phase === 'pending' ? (
          <button type="button" onClick={p.onResendForm} className={BUTTON_PRIMARY}><RotateCcw className="h-4 w-4" aria-hidden="true" />Reenviar o mesmo pedido</button>
        ) : (
          <button type="submit" disabled={busy} className={BUTTON_PRIMARY}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{busy ? 'Registrando…' : 'Registrar decisão'}</button>
        )}
        <button type="button" onClick={p.onCloseForm} disabled={busy} className={BUTTON_QUIET}>Cancelar</button>
      </div>
    </form>
  );
}

function RevokeForm(p: DecisionsPanelProps): React.JSX.Element {
  const { revoke } = p;
  const busy = revoke.phase === 'submitting';
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    reasonRef.current?.focus();
  }, []);
  return (
    <form
      className="mt-3 space-y-2 rounded-lg border border-gmn-warning/30 bg-gmn-warning/[0.04] p-3"
      aria-label={`Revogar ${revoke.decisionId ?? ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy && !event.nativeEvent.isComposing) {
          event.stopPropagation();
          p.onCloseRevoke();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        p.onSubmitRevoke();
      }}
    >
      <label htmlFor="revogacao-motivo" className="text-xs font-medium text-gmn-text">Motivo da revogação (mín. 20 caracteres). A decisão permanece no histórico.</label>
      <textarea ref={reasonRef} id="revogacao-motivo" rows={2} maxLength={2000} value={revoke.reason} disabled={busy} onChange={(event) => p.onRevokeField(event.target.value)} className={FIELD_CLASS} />
      {revoke.message && <p role="alert" className="text-xs text-amber-200">{revoke.message}</p>}
      <div className="flex flex-wrap gap-2">
        {revoke.phase === 'pending' ? (
          <button type="button" onClick={p.onResendRevoke} className={BUTTON_PRIMARY}><RotateCcw className="h-4 w-4" aria-hidden="true" />Reenviar o mesmo pedido</button>
        ) : (
          <button type="submit" disabled={busy} className={BUTTON_PRIMARY}>{busy ? 'Revogando…' : 'Confirmar revogação'}</button>
        )}
        <button type="button" onClick={p.onCloseRevoke} disabled={busy} className={BUTTON_QUIET}>Cancelar</button>
      </div>
    </form>
  );
}
