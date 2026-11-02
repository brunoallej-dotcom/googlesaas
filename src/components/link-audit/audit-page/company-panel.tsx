import { Building2, CircleCheck, ShieldAlert, ShieldCheck, ShieldQuestion, TriangleAlert } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import type { AuditDetailDto } from '@/lib/link-audit-evidence';
import { formatDateTime, placeLine, safeText, PROVENANCE_REASON_LABELS } from './labels';
import type { PreviewPayload } from './types';
import { CopyHash } from './ui-bits';

const PROFILE_REASONS: Readonly<Record<string, string>> = {
  IDENTITY_NOT_CONFIRMED: 'A identidade (CID/Place ID) não foi confirmada nesta coleta.',
  NOT_LOCATED: 'O perfil não foi localizado no corpo da coleta.',
  AMBIGUOUS_IDENTITY: 'Mais de um perfil corresponde à identidade; nada foi escolhido.',
  BODY_UNREADABLE: 'O corpo da coleta não pôde ser lido.',
  NO_USABLE_CAPTURE: 'Não há captura utilizável (resposta 2xx).',
};

export function CompanyPanel({ evidence, preview }: { readonly evidence: AuditDetailDto | null; readonly preview: PreviewPayload | null }): React.JSX.Element {
  const name = safeText(evidence?.company.name) || 'Empresa sem nome informado';
  const place = evidence ? placeLine(safeText(evidence.company.city) || null, safeText(evidence.company.stateCode) || null) : '';
  const cid = evidence?.identifiers.confirmed.find((item) => item.type === 'cid')?.value ?? null;
  const integrityOk = preview?.evidence.integrity.status === 'OK';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-lg font-semibold text-gmn-text"><Building2 className="h-5 w-5 shrink-0 text-gmn-accent" aria-hidden="true" /><span className="break-words">{name}</span></p>
          <p className="mt-0.5 text-xs text-gmn-muted">{place || 'Cidade não informada'} · nome informado pelo operador na confirmação de identidade</p>
        </div>
        {preview && (
          <div className="flex flex-wrap items-center gap-2" data-testid="evidence-states">
            {integrityOk ? (
              <StatusBadge tone="success" label="Integridade local verificada (SHA-256)" icon={CircleCheck} />
            ) : (
              <StatusBadge tone="danger" label={preview.evidence.integrity.status === 'INCOMPLETE' ? 'Evidência incompleta' : 'Evidência adulterada ou ilegível'} icon={ShieldAlert} />
            )}
            {preview.evidence.provenance !== null && (preview.evidence.provenance.status === 'AUTHENTICATED' ? (
              <StatusBadge tone="success" label="Origem da coleta autenticada" icon={ShieldCheck} />
            ) : (
              <StatusBadge tone="warning" label="Origem da coleta NÃO comprovada" icon={ShieldQuestion} />
            ))}
          </div>
        )}
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
        <Row label="CID confirmado" value={cid ? <code className="break-all font-mono text-gmn-text">{safeText(cid, 40)}</code> : 'não confirmado'} />
        <Row label="Fonte dos dados" value={safeText(preview?.company.source ?? evidence?.source.label) || '—'} />
        <Row label="Coleta" value={formatDateTime(evidence?.collectedAt)} />
        <Row label="Data de referência" value={preview?.evidence.referenceDate ?? '—'} />
        <Row label="Captura que sustenta o perfil" value={preview?.evidence.profileSource ? <>{safeText(preview.evidence.profileSource.ref, 40)} · {formatDateTime(preview.evidence.profileSource.observedAt)}</> : '—'} />
        <Row label="Site informado no perfil (host)" value={safeText(preview?.company.websiteHost) || '—'} />
        <Row
          label="Origem da coleta (autenticidade)"
          value={
            !preview || preview.evidence.provenance === null ? '—' : preview.evidence.provenance.status === 'AUTHENTICATED' ? 'comprovada por manifesto assinado, fora da pasta de evidências' : (
              <>
                <strong className="text-gmn-text">NÃO comprovada:</strong> {safeText(PROVENANCE_REASON_LABELS[preview.evidence.provenance.reason ?? ''] ?? 'motivo não informado', 300)}{preview.evidence.provenance.missingRefs.length > 0 ? ` (ausente: ${preview.evidence.provenance.missingRefs.map((ref) => safeText(ref, 30)).join(', ')})` : ''}. A integridade (SHA-256) mostra que o arquivo não mudou depois de selado; não mostra quem o coletou. A finalização fica bloqueada.
              </>
            )
          }
        />
        <Row label="Formato das evidências" value={preview?.evidence.layout === 'LEGACY' ? 'legado (coleta anterior à versão atual)' : preview?.evidence.layout ? 'versionado' : '—'} />
        <Row label="Perfil" value={preview ? (preview.company.located ? 'localizado e identidade comprovada' : safeText(PROFILE_REASONS[preview.company.unavailableReason ?? ''] ?? 'não disponível para o motor', 160)) : '—'} />
      </dl>
      {preview && preview.evidence.bases.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gmn-muted">Evidências usadas (integridade local verificada por SHA-256)</h3>
          <ul className="mt-2 space-y-1.5">
            {preview.evidence.bases.map((base) => (
              <li key={base.ref} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/[0.06] bg-gmn-tile/50 px-3 py-2 text-xs">
                <span className="font-medium text-gmn-text">{safeText(base.ref, 40)}</span>
                <span className="text-gmn-muted">{base.kind === 'CAPTURE' ? 'captura' : 'relatório'} · {formatDateTime(base.observedAt)}</span>
                <span className="text-gmn-muted" data-testid="base-origin">{preview.evidence.provenance?.status === 'AUTHENTICATED' ? 'origem autenticada' : 'origem NÃO comprovada'}</span>
                {base.superseded && <StatusBadge tone="neutral" label="substituída" icon={TriangleAlert} dashed />}
                {base.legacy && <StatusBadge tone="neutral" label="legado" icon={TriangleAlert} dashed />}
                <CopyHash value={base.contentSha256} label={`hash de ${safeText(base.ref, 40)}`} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <dt className="shrink-0 text-gmn-muted">{label}</dt>
      <dd className="min-w-0 break-words text-gmn-text">{value}</dd>
    </div>
  );
}
