import { ArrowRight, TriangleAlert } from 'lucide-react';
import type { AuditRequestIssue } from './evidence-state';

interface RequestedAuditNoticeProps {
  readonly issue: AuditRequestIssue;
  /** Há empresas na lista para escolher (senão não há o que "escolher"). */
  readonly canChoose: boolean;
  readonly onDismiss: () => void;
}

const ACTION_CLASS =
  'inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-white/[0.15] px-3 text-sm font-medium text-gmn-text transition-colors hover:border-white/30 hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70';

/**
 * Aviso de que a auditoria pedida pelo endereço (`?auditId=`) não pôde ser exibida. Nenhuma outra empresa é escolhida no lugar dela e
 * nenhum dado de outra auditoria aparece aqui. O identificador só é mostrado quando tem a forma válida (nunca o texto cru do endereço).
 */
export function RequestedAuditNotice({ issue, canChoose, onDismiss }: RequestedAuditNoticeProps): React.JSX.Element {
  return (
    <div role="alert" data-testid="requested-audit-notice" className="mt-4 rounded-xl border border-gmn-warning/40 bg-gmn-warning/[0.06] p-4">
      <p className="flex items-start gap-2 text-sm font-semibold text-gmn-text">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
        {issue.kind === 'missing' ? 'A auditoria pedida não está na lista carregada' : 'O endereço pede uma auditoria com identificador inválido'}
      </p>
      {issue.kind === 'missing' ? (
        <p className="mt-1 text-sm text-gmn-muted">
          O endereço pede a auditoria <code className="break-all rounded bg-white/[0.06] px-1 font-mono text-gmn-text">{issue.auditId}</code>, que não aparece entre as empresas listadas
          (a lista mostra só as primeiras). Ela pode estar fora da lista, ter sido removida ou o endereço pode estar incorreto.{' '}
          <strong className="font-semibold text-gmn-text">Nenhuma outra empresa foi selecionada no lugar dela.</strong>
        </p>
      ) : (
        <p className="mt-1 text-sm text-gmn-muted">
          O parâmetro <code className="rounded bg-white/[0.06] px-1 font-mono text-gmn-text">auditId</code> do endereço não tem o formato de um identificador de auditoria.{' '}
          <strong className="font-semibold text-gmn-text">Nenhuma empresa foi selecionada.</strong>
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {issue.kind === 'missing' && (
          <a href={`/auditoria-por-link/${encodeURIComponent(issue.auditId)}`} className={ACTION_CLASS}>
            Abrir a auditoria Lumos pedida
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
        )}
        <button type="button" onClick={onDismiss} className={ACTION_CLASS}>
          {canChoose ? 'Escolher outra empresa na lista' : 'Descartar o pedido'}
        </button>
      </div>
    </div>
  );
}
