import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Loader2,
  ScanSearch,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { StatusBadge } from '@/components/ui/status-badge';
import type { MapsLinkParseResult } from '@/lib/link-audit/maps-link';
import { CODE_MESSAGES, displayText, IDENTIFIER_LABELS, SOURCE_FORM_LABELS, STATUS_VIEW, type ParseStatus } from './messages';

const STATUS_ICON: Readonly<Record<ParseStatus, LucideIcon>> = {
  IDENTIFIED: CheckCircle2,
  RESOLUTION_PENDING: Clock,
  AMBIGUOUS: AlertTriangle,
  UNSUPPORTED: Ban,
  INVALID: XCircle,
  REJECTED: ShieldAlert,
};

interface ParseResultPanelProps {
  readonly result: MapsLinkParseResult | null;
  readonly loading: boolean;
}

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid gap-1 border-t border-white/[0.06] py-2.5 first:border-t-0 sm:grid-cols-[11rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium text-gmn-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-gmn-text">{children}</dd>
    </div>
  );
}

/** Texto técnico (links, ids) sempre como TEXTO: nunca vira link clicável nem é interpretado. */
function Mono({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <code className="break-all rounded bg-gmn-tile px-1.5 py-0.5 font-mono text-xs text-gmn-text">{children}</code>;
}

export function ParseResultPanel({ result, loading }: ParseResultPanelProps): React.JSX.Element {
  return (
    <Panel
      id="resultado-da-analise"
      icon={ScanSearch}
      title="Resultado da análise"
      subtitle="Como o sistema classificou o link informado"
    >
      <div aria-live="polite" className="mt-4">
        {loading && (
          <p className="flex items-center gap-2 text-sm text-gmn-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Analisando o link…
          </p>
        )}

        {!loading && !result && (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-gmn-muted">
            Nenhum link analisado ainda. Cole um link acima e use “Validar link”.
          </p>
        )}

        {!loading && result && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                tone={STATUS_VIEW[result.status].tone}
                label={STATUS_VIEW[result.status].label}
                icon={STATUS_ICON[result.status]}
                dashed={result.status === 'RESOLUTION_PENDING' || result.status === 'AMBIGUOUS'}
              />
            </div>
            <p className="text-sm text-gmn-text">{STATUS_VIEW[result.status].summary}</p>
            {result.code !== 'IDENTIFIED' && (
              <p className="text-sm text-gmn-muted">{CODE_MESSAGES[result.code]}</p>
            )}

            <dl className="rounded-xl border border-white/[0.06] bg-gmn-tile/40 px-4">
              <Row label="Link informado">
                {result.originalInput ? <Mono>{result.originalInput}</Mono> : <span className="text-gmn-muted">—</span>}
              </Row>

              {result.status === 'IDENTIFIED' && (
                <>
                  <Row label="Endereço do Google">
                    <Mono>{result.canonicalHost}</Mono>
                  </Row>
                  {(Object.keys(IDENTIFIER_LABELS) as Array<keyof typeof IDENTIFIER_LABELS>).map((key) => {
                    const value = result.identifiers[key];
                    return value ? (
                      <Row key={key} label={`Identificador: ${IDENTIFIER_LABELS[key]}`}>
                        <Mono>{value}</Mono>
                      </Row>
                    ) : null;
                  })}
                  <Row label="Encontrado em">
                    {result.sourceForms.map((form) => SOURCE_FORM_LABELS[form] ?? form).join(', ')}
                  </Row>
                </>
              )}

              {(result.status === 'IDENTIFIED' || result.status === 'AMBIGUOUS') && displayText(result.untrustedLabelHint ?? '') && (
                <Row label="Nome que aparece no link">
                  <span>{displayText(result.untrustedLabelHint ?? '')}</span>
                  <span className="mt-0.5 block text-xs text-gmn-muted">
                    Não verificado: o nome vem do próprio texto do link e não identifica a empresa.
                  </span>
                </Row>
              )}

              {result.status === 'RESOLUTION_PENDING' && (
                <Row label="Endereço curto">
                  <Mono>{result.shortHost}</Mono>
                </Row>
              )}
            </dl>

            <p className="text-xs text-gmn-muted">
              Análise local do texto do link. Nada foi consultado no Google e nenhum redirecionamento foi seguido.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}
