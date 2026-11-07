import {
  CheckCircle2,
  Circle,
  Download,
  ExternalLink,
  FileText,
  Globe,
  HelpCircle,
  History,
  Loader2,
  MapPin,
  MessageCircle,
  Phone,
  PauseCircle,
  PhoneOff,
  SearchX,
  Star,
  Target,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FrontierLead, ProspectingOutput, WebsitePresenceStatus } from '@/types/gmn';
import { presentWhatsAppContact } from '@/lib/whatsapp-contact';
import { AGENT_LABEL, PHASE_LABEL, RECOVERED_LABEL, STAGE_LABEL, WEBSITE_STATUS_LABEL } from '@/components/ui/labels';
import { Panel } from '@/components/ui/panel';
import { StatusBadge } from '@/components/ui/status-badge';
import type { StatusTone } from '@/components/ui/status-badge';
import type { AuditJobTracker } from './types';

interface LeadsTableProps {
  readonly campaign: ProspectingOutput | null;
  readonly isProspecting: boolean;
  readonly auditsByLeadId: Readonly<Record<string, AuditJobTracker>>;
  readonly enqueuingLeadId: string | null;
  readonly selectedLeadId: string | null;
  readonly onGenerateAudit: (lead: FrontierLead) => void;
  readonly onInspectAudit: (leadId: string) => void;
}

const WEBSITE_TONE: Record<WebsitePresenceStatus, StatusTone> = {
  OWN_DOMAIN: 'success',
  SOCIAL_LINK_ONLY: 'warning',
  MISSING: 'danger',
};

const ratingFmt = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((part) => /^\p{L}/u.test(part))
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase());
  return letters.join('') || '?';
}

function hostnameOf(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Mesma lógica de faixas da legenda: Top 3 verde, 4–7 amarelo, demais vermelho. */
function rankColor(rank: number): string {
  if (rank <= 3) return 'text-gmn-success';
  if (rank <= 7) return 'text-gmn-warning';
  return 'text-gmn-danger';
}

function CompanyCell({ lead }: { readonly lead: FrontierLead }): React.JSX.Element {
  const sab = lead.isServiceAreaBusiness && lead.isAddressHidden;
  return (
    <div className="flex min-w-[230px] items-start gap-3">
      <span
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-gmn-surface to-gmn-tile text-sm font-semibold text-gmn-accent ring-1 ring-white/[0.08]"
      >
        {initials(lead.businessName)}
      </span>
      <div className="min-w-0">
        <div className="font-medium leading-snug text-gmn-text">{lead.businessName}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gmn-muted">
          <span className="truncate">{lead.primaryCategory}</span>
          {sab ? (
            <span
              title="Prestador que atende no local do cliente, com endereço oculto legítimo"
              className="rounded bg-gmn-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-300 ring-1 ring-inset ring-gmn-accent/25"
            >
              SAB · endereço oculto
            </span>
          ) : (
            <span className="text-gmn-muted/70">Presencial</span>
          )}
        </div>
        <div
          title={lead.placeId}
          className="mt-1 max-w-[220px] truncate font-mono text-[11px] text-gmn-muted/70"
        >
          {lead.placeId}
        </div>
      </div>
    </div>
  );
}

function RatingCell({ lead }: { readonly lead: FrontierLead }): React.JSX.Element {
  return (
    <div className="whitespace-nowrap">
      <span className="inline-flex items-center gap-1 text-base font-semibold tabular-nums text-gmn-text">
        <Star className="h-4 w-4 fill-gmn-warning text-gmn-warning" aria-hidden="true" />
        {ratingFmt.format(lead.rating)}
      </span>
      <div className="text-xs tabular-nums text-gmn-muted">{lead.totalReviews} avaliações</div>
    </div>
  );
}

interface WhatsAppVisual {
  readonly tone: StatusTone;
  readonly icon: LucideIcon;
  readonly dashed: boolean;
}

const WHATSAPP_VISUAL: Record<FrontierLead['whatsappStatus'], WhatsAppVisual> = {
  VERIFIED_WHATSAPP: { tone: 'success', icon: CheckCircle2, dashed: false },
  LIKELY_MOBILE_WHATSAPP: { tone: 'warning', icon: HelpCircle, dashed: true },
  LANDLINE_ONLY: { tone: 'neutral', icon: Phone, dashed: false },
  MISSING: { tone: 'neutral', icon: PhoneOff, dashed: false },
};

function ContactCell({ lead }: { readonly lead: FrontierLead }): React.JSX.Element {
  const contact = presentWhatsAppContact(lead);
  const visual = WHATSAPP_VISUAL[lead.whatsappStatus];
  const verified = lead.whatsappStatus === 'VERIFIED_WHATSAPP';
  const Icon = verified ? MessageCircle : Phone;

  return (
    <div className="flex min-w-[210px] items-start gap-2.5">
      <Icon
        className={`mt-0.5 h-5 w-5 shrink-0 ${verified ? 'text-gmn-success' : 'text-gmn-muted'}`}
        aria-hidden="true"
      />
      <div className="flex flex-col items-start gap-1.5">
        {contact.phoneText ? (
          contact.phoneHref ? (
            <a
              href={contact.phoneHref}
              title="Ligar para o telefone listado no Google Maps"
              className="rounded text-sm font-medium tabular-nums text-gmn-text underline-offset-2 hover:text-gmn-accent hover:underline"
            >
              {contact.phoneText}
            </a>
          ) : (
            <span className="text-sm font-medium tabular-nums text-gmn-text">{contact.phoneText}</span>
          )
        ) : (
          <span className="text-xs text-gmn-muted">Telefone não informado</span>
        )}
        <StatusBadge
          tone={visual.tone}
          icon={visual.icon}
          dashed={visual.dashed}
          label={contact.statusLabel}
          title={contact.helpText ?? undefined}
        />
        {contact.whatsappPhoneText && (
          <span className="text-xs text-gmn-muted">WhatsApp no link: {contact.whatsappPhoneText}</span>
        )}
        {contact.whatsappHref && contact.actionLabel && (
          <a
            href={contact.whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            title={contact.helpText ?? undefined}
            aria-label={`${contact.actionLabel} — ${lead.businessName}. Conta não verificada.`}
            className={
              verified
                ? 'inline-flex items-center gap-1.5 rounded-md bg-gmn-success px-2.5 py-1 text-xs font-semibold text-slate-950 transition-colors hover:bg-green-400'
                : 'inline-flex items-center gap-1 rounded text-xs font-medium text-gmn-muted underline decoration-dashed underline-offset-4 transition-colors hover:text-amber-300'
            }
          >
            {contact.actionLabel} <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
      </div>
    </div>
  );
}

function WebsiteCell({ lead }: { readonly lead: FrontierLead }): React.JSX.Element {
  return (
    <div className="flex min-w-[150px] flex-col items-start gap-1.5">
      {lead.websiteUrl ? (
        <a
          href={lead.websiteUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Abrir site de ${lead.businessName} em nova aba`}
          className="inline-flex max-w-[190px] items-center gap-1 rounded text-sm text-gmn-accent underline-offset-2 hover:underline"
        >
          <span className="truncate">{hostnameOf(lead.websiteUrl)}</span>
          <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
        </a>
      ) : (
        <span className="text-sm text-gmn-muted" aria-label="Sem endereço de site">
          —
        </span>
      )}
      <StatusBadge
        tone={WEBSITE_TONE[lead.websiteStatus]}
        icon={Globe}
        label={WEBSITE_STATUS_LABEL[lead.websiteStatus]}
      />
    </div>
  );
}

function RankCell({ lead }: { readonly lead: FrontierLead }): React.JSX.Element {
  return (
    <div className="text-center">
      <div className={`text-xl font-semibold tabular-nums ${rankColor(lead.frontierRank)}`}>
        #{lead.frontierRank}
      </div>
      <div className="text-[11px] text-gmn-muted">{lead.frontierPage}ª pág.</div>
    </div>
  );
}

function AuditStatusBadge({
  tracker,
}: {
  readonly tracker: AuditJobTracker | undefined;
}): React.JSX.Element {
  if (!tracker) {
    return <StatusBadge tone="neutral" icon={Circle} label="Não iniciada" />;
  }
  if (tracker.status === 'COMPLETED') {
    return tracker.recovered ? (
      <StatusBadge tone="info" icon={History} label={RECOVERED_LABEL} />
    ) : (
      <StatusBadge tone="success" icon={CheckCircle2} label={STAGE_LABEL.COMPLETED} />
    );
  }
  if (tracker.phase === 'INTERRUPTED' && tracker.status !== 'FAILED') {
    return <StatusBadge tone="warning" icon={PauseCircle} dashed label={`${PHASE_LABEL.INTERRUPTED} · ${tracker.progressPercent}%`} />;
  }
  if (tracker.phase === 'WAITING') {
    return <StatusBadge tone="neutral" icon={Circle} label={PHASE_LABEL.WAITING} />;
  }
  if (tracker.status === 'FAILED') {
    return (
      <StatusBadge
        tone="danger"
        icon={XCircle}
        label={`Falhou em ${AGENT_LABEL[tracker.currentAgent]} (${tracker.progressPercent}%)`}
      />
    );
  }
  return (
    <StatusBadge
      tone="warning"
      icon={Loader2}
      spin
      label={`${STAGE_LABEL[tracker.status]} · ${tracker.progressPercent}%`}
    />
  );
}

const PRIMARY_OUTLINE_BTN =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-gmn-primary/40 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-gmn-primary/15 disabled:cursor-not-allowed disabled:opacity-60';
const GHOST_BTN =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2 text-xs font-medium text-gmn-text transition-colors hover:bg-white/[0.07]';

function ActionCell({
  lead,
  tracker,
  isEnqueuing,
  onGenerateAudit,
  onInspectAudit,
}: {
  readonly lead: FrontierLead;
  readonly tracker: AuditJobTracker | undefined;
  readonly isEnqueuing: boolean;
  readonly onGenerateAudit: (lead: FrontierLead) => void;
  readonly onInspectAudit: (leadId: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex min-w-[170px] flex-col items-stretch gap-2">
      {tracker && (
        <div>
          <AuditStatusBadge tracker={tracker} />
        </div>
      )}
      {!tracker ? (
        <button
          type="button"
          disabled={isEnqueuing}
          onClick={() => onGenerateAudit(lead)}
          aria-label={`Gerar Auditoria — ${lead.businessName}`}
          className={PRIMARY_OUTLINE_BTN}
        >
          {isEnqueuing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {isEnqueuing ? 'Enfileirando...' : 'Gerar Auditoria'}
        </button>
      ) : tracker.status === 'COMPLETED' && tracker.diagrammer ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => onInspectAudit(lead.id)} className={GHOST_BTN}>
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            Ver no mapa
          </button>
          <a
            href={`/api/audit/${tracker.diagrammer.auditId}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gmn-primary-strong px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-gmn-primary-strong-hover"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Baixar PDF
          </a>
        </div>
      ) : (
        <button type="button" onClick={() => onInspectAudit(lead.id)} className={GHOST_BTN}>
          {tracker.status === 'FAILED' || tracker.phase === 'INTERRUPTED' ? 'Ver detalhes' : 'Ver progresso'}
        </button>
      )}
    </div>
  );
}

function SkeletonRows(): React.JSX.Element {
  return (
    <div className="mt-4 space-y-3" role="status" aria-live="polite">
      <span className="sr-only">Rastreando fronteira, aguarde.</span>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex animate-pulse items-center gap-4 rounded-lg bg-gmn-tile p-3">
          <div className="h-10 w-10 shrink-0 rounded-full bg-gmn-surface" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-2/5 rounded bg-gmn-surface" />
            <div className="h-2.5 w-1/4 rounded bg-gmn-surface/70" />
          </div>
          <div className="hidden h-3 w-24 rounded bg-gmn-surface sm:block" />
          <div className="hidden h-3 w-20 rounded bg-gmn-surface md:block" />
          <div className="h-8 w-28 rounded-lg bg-gmn-surface" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  text,
  showFocusButton,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly text: string;
  readonly showFocusButton: boolean;
}): React.JSX.Element {
  return (
    <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed border-white/10 bg-gmn-tile px-6 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-gmn-primary/10 ring-1 ring-gmn-primary/20">
        <Icon className="h-6 w-6 text-gmn-accent" aria-hidden="true" />
      </span>
      <p className="text-sm font-medium text-gmn-text">{title}</p>
      <p className="max-w-md text-sm text-gmn-muted">{text}</p>
      {showFocusButton && (
        <button
          type="button"
          onClick={() => {
            const field = document.getElementById('prospect-city');
            field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            field?.focus();
          }}
          className={PRIMARY_OUTLINE_BTN}
        >
          Ir para os filtros
        </button>
      )}
    </div>
  );
}

export function LeadsTable({
  campaign,
  isProspecting,
  auditsByLeadId,
  enqueuingLeadId,
  selectedLeadId,
  onGenerateAudit,
  onInspectAudit,
}: LeadsTableProps): React.JSX.Element {
  const leadCount = campaign?.leads.length ?? 0;
  return (
    <Panel
      id="leads"
      icon={Target}
      iconClassName="text-gmn-danger"
      title="Leads de Fronteira"
      subtitle="Empresas próximas à sua zona de oportunidade (final da 1ª página e início da 2ª)."
      actions={
        campaign && (
          <div className="flex items-center gap-3 text-xs text-gmn-muted">
            <span className="rounded-full bg-white/[0.05] px-2.5 py-1 tabular-nums">
              {leadCount} {leadCount === 1 ? 'lead' : 'leads'}
            </span>
            <span className="font-mono">Campanha: {campaign.campaignId.slice(0, 8)}</span>
          </div>
        )
      }
    >
      {isProspecting ? (
        <SkeletonRows />
      ) : !campaign ? (
        <EmptyState
          icon={Target}
          title="Nenhuma prospecção executada"
          text="Preencha cidade, UF e nicho acima e capture os leads de fronteira para ver os resultados aqui."
          showFocusButton
        />
      ) : campaign.leads.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="Nenhum lead encontrado"
          text="A pesquisa não retornou empresas na faixa de fronteira. Tente outro nicho ou cidade."
          showFocusButton
        />
      ) : (
        <>
          {/* Desktop / tablet */}
          <div className="-mx-5 mt-4 hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Leads de fronteira da campanha atual</caption>
              <thead>
                <tr className="bg-gmn-tile text-[11px] font-medium uppercase tracking-wide text-gmn-muted">
                  <th scope="col" className="w-12 py-3 pl-5 pr-2">#</th>
                  <th scope="col" className="px-3 py-3">Empresa</th>
                  <th scope="col" className="px-3 py-3">Avaliações</th>
                  <th scope="col" className="px-3 py-3">Telefone / WhatsApp</th>
                  <th scope="col" className="px-3 py-3">Site</th>
                  <th scope="col" className="px-3 py-3 text-center">Posição</th>
                  <th scope="col" className="py-3 pl-3 pr-5">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {campaign.leads.map((lead, index) => (
                  <tr
                    key={lead.id}
                    className={`transition-colors hover:bg-white/[0.02] ${
                      selectedLeadId === lead.id
                        ? 'bg-gmn-primary/[0.06] shadow-[inset_3px_0_0_#247BFF]'
                        : ''
                    }`}
                  >
                    <td className="py-3.5 pl-5 pr-2 align-middle tabular-nums text-gmn-muted">{index + 1}</td>
                    <td className="px-3 py-3.5 align-middle"><CompanyCell lead={lead} /></td>
                    <td className="px-3 py-3.5 align-middle"><RatingCell lead={lead} /></td>
                    <td className="px-3 py-3.5 align-middle"><ContactCell lead={lead} /></td>
                    <td className="px-3 py-3.5 align-middle"><WebsiteCell lead={lead} /></td>
                    <td className="px-3 py-3.5 align-middle"><RankCell lead={lead} /></td>
                    <td className="py-3.5 pl-3 pr-5 align-middle">
                      <ActionCell
                        lead={lead}
                        tracker={auditsByLeadId[lead.id]}
                        isEnqueuing={enqueuingLeadId === lead.id}
                        onGenerateAudit={onGenerateAudit}
                        onInspectAudit={onInspectAudit}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile */}
          <ul className="-mx-5 mt-4 divide-y divide-white/[0.05] border-t border-white/[0.05] md:hidden">
            {campaign.leads.map((lead, index) => (
              <li
                key={lead.id}
                className={`space-y-3.5 px-5 py-4 ${
                  selectedLeadId === lead.id ? 'bg-gmn-primary/[0.06]' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="mt-1 w-4 shrink-0 text-xs tabular-nums text-gmn-muted">{index + 1}</span>
                    <CompanyCell lead={lead} />
                  </div>
                  <RankCell lead={lead} />
                </div>
                <RatingCell lead={lead} />
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <ContactCell lead={lead} />
                  <WebsiteCell lead={lead} />
                </div>
                <ActionCell
                  lead={lead}
                  tracker={auditsByLeadId[lead.id]}
                  isEnqueuing={enqueuingLeadId === lead.id}
                  onGenerateAudit={onGenerateAudit}
                  onInspectAudit={onInspectAudit}
                />
              </li>
            ))}
          </ul>
          <p className="mt-1 border-t border-white/[0.05] pt-4 text-xs text-gmn-muted">
            Contatos obtidos de dados públicos. “Celular — não confirmado” gera um link de
            tentativa; isso não garante que o estabelecimento tenha WhatsApp ativo.
          </p>
        </>
      )}
    </Panel>
  );
}
