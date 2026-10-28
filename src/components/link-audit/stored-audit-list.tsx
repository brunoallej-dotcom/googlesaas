import { Archive, CircleCheck, FileSearch, Fingerprint, LoaderCircle, RefreshCw, Search, ShieldAlert, ShieldQuestion, TriangleAlert } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import type { AuditListItemDto } from '@/lib/link-audit-evidence';
import type { Phase } from './evidence-state';
import { formatDateTime, LIST_INTEGRITY_LABELS, placeLine, pluralize } from './evidence-labels';

const INPUT_CLASS =
  'h-11 w-full rounded-lg border border-white/[0.08] bg-gmn-tile pl-10 pr-3 text-sm text-gmn-text transition-colors placeholder:text-gmn-muted/60 hover:border-white/15 focus:border-gmn-accent/60 focus:outline-none focus:ring-2 focus:ring-gmn-accent/40';

interface StoredAuditListProps {
  readonly phase: Phase;
  readonly items: readonly AuditListItemDto[];
  readonly total: number;
  readonly message: string | null;
  readonly query: string;
  readonly selectedId: string | null;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (auditId: string) => void;
  readonly onRetry: () => void;
}

function IntegrityBadge({ status }: { readonly status: AuditListItemDto['integrity']['status'] }): React.JSX.Element {
  const label = LIST_INTEGRITY_LABELS[status] ?? status;
  if (status === 'OK') return <StatusBadge tone="success" label={label} icon={CircleCheck} />;
  if (status === 'MISMATCH') return <StatusBadge tone="danger" label={label} icon={ShieldAlert} />;
  return <StatusBadge tone="warning" label={label} icon={TriangleAlert} dashed />;
}

function AuditCard({ item, selected, onSelect }: { readonly item: AuditListItemDto; readonly selected: boolean; readonly onSelect: (auditId: string) => void }): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(item.auditId)}
        aria-current={selected ? 'true' : undefined}
        className={`w-full rounded-xl border p-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/60 ${
          selected ? 'border-gmn-accent/60 bg-gmn-accent/[0.08]' : 'border-white/[0.06] bg-gmn-tile/50 hover:border-white/15 hover:bg-gmn-tile'
        }`}
      >
        <p className="break-words text-sm font-semibold text-gmn-text">{item.companyName ?? 'Empresa sem nome informado'}</p>
        <p className="mt-0.5 text-xs text-gmn-muted">{placeLine(item.city, item.stateCode) || 'Cidade não informada'}</p>
        <dl className="mt-3 space-y-1.5 text-xs">
          <div className="flex items-baseline gap-2">
            <dt className="flex shrink-0 items-center gap-1 text-gmn-muted">
              <Fingerprint className="h-3.5 w-3.5" aria-hidden="true" />
              CID confirmado
            </dt>
            <dd className="min-w-0 break-all font-mono text-gmn-text">{item.confirmedCid ?? 'não confirmado'}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="shrink-0 text-gmn-muted">Coleta</dt>
            <dd className="text-gmn-text">{formatDateTime(item.collectedAt)}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="shrink-0 text-gmn-muted">Fonte</dt>
            <dd className="min-w-0 text-gmn-text">{item.sourceLabel}</dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <IntegrityBadge status={item.integrity.status} />
          <StatusBadge tone="neutral" label={`${pluralize(item.captureCount, 'captura', 'capturas')} · ${pluralize(item.reportRevisions, 'versão', 'versões')}`} icon={Archive} />
        </div>
      </button>
    </li>
  );
}

export function StoredAuditList({ phase, items, total, message, query, selectedId, onQueryChange, onSelect, onRetry }: StoredAuditListProps): React.JSX.Element {
  if (phase === 'loading') {
    return (
      <div role="status" aria-live="polite" className="mt-4 space-y-3">
        <p className="flex items-center gap-2 text-sm text-gmn-muted">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          Carregando auditorias armazenadas…
        </p>
        <div aria-hidden="true" className="space-y-3">
          {[0, 1].map((n) => (
            <div key={n} className="h-28 animate-pulse rounded-xl border border-white/[0.06] bg-gmn-tile/50" />
          ))}
        </div>
      </div>
    );
  }

  if (phase === 'unavailable' || phase === 'error') {
    return (
      <div role="alert" className="mt-4 rounded-xl border border-gmn-warning/40 bg-gmn-warning/[0.06] p-4">
        <p className="flex items-start gap-2 text-sm font-semibold text-gmn-text">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
          {phase === 'unavailable' ? 'Armazenamento de evidências indisponível' : 'Não foi possível carregar as auditorias'}
        </p>
        <p className="mt-1 text-sm text-gmn-muted">{message}</p>
        {phase === 'unavailable' && (
          <p className="mt-2 text-xs text-gmn-muted">
            O administrador do servidor define a pasta privada na variável <code className="rounded bg-white/[0.06] px-1">GMN_LINK_AUDIT_EVIDENCE_DIR</code> e reinicia o servidor. A interface não altera permissões nem copia arquivos.
          </p>
        )}
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-white/[0.1] px-3 text-sm text-gmn-text transition-colors hover:border-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/60"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Tentar novamente
        </button>
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="mt-4 rounded-xl border border-dashed border-white/15 p-5 text-center">
        <ShieldQuestion className="mx-auto h-6 w-6 text-gmn-muted" aria-hidden="true" />
        <p className="mt-2 text-sm font-semibold text-gmn-text">Nenhuma auditoria armazenada ainda</p>
        <p className="mt-1 text-xs text-gmn-muted">As coletas autorizadas aparecem aqui assim que forem preservadas. Esta tela apenas lê; ela não executa coletas.</p>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="relative">
        <label htmlFor="filtro-auditorias" className="sr-only">
          Filtrar por empresa, cidade ou CID
        </label>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gmn-muted" aria-hidden="true" />
        <input
          id="filtro-auditorias"
          type="search"
          value={query}
          maxLength={120}
          autoComplete="off"
          placeholder="Filtrar por empresa, cidade ou CID"
          onChange={(event) => onQueryChange(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <p className="text-xs text-gmn-muted" aria-live="polite">
        {items.length === total ? `${total} ${total === 1 ? 'empresa com evidências armazenadas' : 'empresas com evidências armazenadas'}` : `${items.length} de ${total} empresas`}
      </p>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-4 text-center">
          <FileSearch className="mx-auto h-5 w-5 text-gmn-muted" aria-hidden="true" />
          <p className="mt-1 text-sm text-gmn-muted">Nenhuma empresa corresponde ao filtro.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <AuditCard key={item.auditId} item={item} selected={item.auditId === selectedId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </div>
  );
}
