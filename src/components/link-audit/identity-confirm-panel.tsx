import { BadgeCheck, Loader2, Undo2, UserCheck } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { StatusBadge } from '@/components/ui/status-badge';
import type { CompanyIdentity } from '@/lib/link-audit/audit';
import type { MapsLinkParseResult } from '@/lib/link-audit/maps-link';
import { displayText, IDENTIFIER_LABELS } from './messages';
import type { LinkAuditUiState, OperatorDetails } from './state';

interface IdentityConfirmPanelProps {
  readonly result: MapsLinkParseResult | null;
  readonly details: OperatorDetails;
  readonly confirmation: LinkAuditUiState['confirmation'];
  readonly canConfirm: boolean;
  readonly onDetailsChange: (patch: Partial<OperatorDetails>) => void;
  readonly onConfirm: () => void;
  readonly onUndo: () => void;
}

const FIELD_CLASS =
  'h-11 w-full rounded-lg border border-white/40 bg-gmn-tile px-3 text-sm text-gmn-text transition-colors placeholder:text-gmn-muted/80 hover:border-white/60 focus:border-gmn-accent focus:outline-none focus:ring-2 focus:ring-gmn-accent/40';
const LABEL_CLASS = 'mb-1.5 block text-xs font-medium text-gmn-muted';

export function formatConfirmedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
}

function ConfirmedSummary({
  identity,
  onUndo,
}: {
  readonly identity: CompanyIdentity;
  readonly onUndo: () => void;
}): React.JSX.Element {
  const provided: Array<readonly [string, string]> = [];
  if (identity.name) provided.push(['Nome', displayText(identity.name)]);
  if (identity.city) provided.push(['Cidade', displayText(identity.city)]);
  if (identity.stateCode) provided.push(['UF', displayText(identity.stateCode)]);
  return (
    <div className="mt-4 space-y-3" aria-live="polite">
      <StatusBadge tone="success" label="Identidade confirmada" icon={BadgeCheck} />
      <p className="text-sm text-gmn-text">
        Confirmada por <strong className="break-all font-semibold">{identity.confirmation?.confirmedBy}</strong>
        {identity.confirmation ? ` em ${formatConfirmedAt(identity.confirmation.confirmedAt)}` : ''}.
      </p>
      <dl className="rounded-xl border border-white/[0.06] bg-gmn-tile/40 px-4 text-sm">
        {(Object.keys(IDENTIFIER_LABELS) as Array<keyof typeof IDENTIFIER_LABELS>).map((key) => {
          const value = identity.identifiers[key];
          return value ? (
            <div key={key} className="grid gap-1 border-t border-white/[0.06] py-2.5 first:border-t-0 sm:grid-cols-[11rem_1fr]">
              <dt className="text-xs font-medium text-gmn-muted">{IDENTIFIER_LABELS[key]}</dt>
              <dd className="min-w-0 break-all font-mono text-xs text-gmn-text">{value}</dd>
            </div>
          ) : null;
        })}
        {provided.map(([label, value]) => (
          <div key={label} className="grid gap-1 border-t border-white/[0.06] py-2.5 sm:grid-cols-[11rem_1fr]">
            <dt className="text-xs font-medium text-gmn-muted">{label} (informado por você)</dt>
            <dd className="min-w-0 break-words text-gmn-text">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-gmn-muted">
        Apenas nesta sessão: nada foi salvo e recarregar a página descarta a confirmação. Os dados digitados por você não são evidência verificada pelo Google.
      </p>
      <button
        type="button"
        onClick={onUndo}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-white/[0.1] bg-gmn-tile px-4 text-sm font-medium text-gmn-muted transition-colors hover:text-gmn-text"
      >
        <Undo2 className="h-4 w-4" aria-hidden="true" />
        Desfazer confirmação
      </button>
    </div>
  );
}

export function IdentityConfirmPanel({
  result,
  details,
  confirmation,
  canConfirm,
  onDetailsChange,
  onConfirm,
  onUndo,
}: IdentityConfirmPanelProps): React.JSX.Element {
  const identified = result?.status === 'IDENTIFIED';
  const loading = confirmation.phase === 'loading';

  return (
    <Panel
      id="confirmacao-da-empresa"
      icon={UserCheck}
      title="Confirmação da empresa"
      subtitle="Você confirma que o identificador do link corresponde à empresa que deseja auditar"
    >
      {!identified && (
        <p className="mt-4 rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-gmn-muted">
          A confirmação fica disponível quando o link é “Identificado”. Nenhum nome, endereço ou categoria é inventado: sem identificador, não há o que confirmar.
        </p>
      )}

      {identified && confirmation.phase === 'done' && confirmation.identity && (
        <ConfirmedSummary identity={confirmation.identity} onUndo={onUndo} />
      )}

      {identified && confirmation.phase !== 'done' && (
        <form
          className="mt-4 space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
          }}
        >
          <fieldset className="space-y-3">
            <legend className="text-xs text-gmn-muted">
              Opcional: dados que você já conhece. Ficam marcados como “informados por você” e não são evidência do Google.
            </legend>
            <div>
              <label htmlFor="link-audit-name" className={LABEL_CLASS}>
                Nome da empresa
              </label>
              <input
                id="link-audit-name"
                type="text"
                autoComplete="off"
                maxLength={200}
                value={details.name}
                onChange={(event) => onDetailsChange({ name: event.target.value })}
                className={FIELD_CLASS}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
              <div>
                <label htmlFor="link-audit-city" className={LABEL_CLASS}>
                  Cidade
                </label>
                <input
                  id="link-audit-city"
                  type="text"
                  autoComplete="off"
                  maxLength={120}
                  value={details.city}
                  onChange={(event) => onDetailsChange({ city: event.target.value })}
                  className={FIELD_CLASS}
                />
              </div>
              <div>
                <label htmlFor="link-audit-uf" className={LABEL_CLASS}>
                  UF
                </label>
                <input
                  id="link-audit-uf"
                  type="text"
                  autoComplete="off"
                  maxLength={2}
                  value={details.stateCode}
                  onChange={(event) => onDetailsChange({ stateCode: event.target.value.toUpperCase().replace(/[^A-Z]/g, '') })}
                  className={FIELD_CLASS}
                />
              </div>
            </div>
          </fieldset>

          <label htmlFor="link-audit-ack" className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/[0.08] bg-gmn-tile/40 p-3 text-sm text-gmn-text">
            <input
              id="link-audit-ack"
              type="checkbox"
              checked={details.acknowledged}
              onChange={(event) => onDetailsChange({ acknowledged: event.target.checked })}
              className="mt-0.5 h-5 w-5 shrink-0 accent-gmn-primary"
            />
            <span>Confirmo que o identificador detectado no link corresponde à empresa que pretendo auditar.</span>
          </label>

          {confirmation.error && (
            <p role="alert" className="rounded-lg border border-gmn-danger/40 bg-gmn-danger/10 px-3 py-2 text-sm text-red-200">
              {confirmation.error}
            </p>
          )}

          <button
            type="submit"
            disabled={!canConfirm}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#1D68DB] px-5 text-sm font-semibold text-white shadow-lg shadow-gmn-primary/25 transition hover:bg-[#1A5FCF] active:scale-[.99] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <BadgeCheck className="h-4 w-4" aria-hidden="true" />
            )}
            {loading ? 'Confirmando…' : 'Confirmar identidade'}
          </button>
        </form>
      )}
    </Panel>
  );
}
