import {
  ClipboardList,
  FileText,
  Gauge,
  History,
  Lightbulb,
  ListChecks,
  ShieldCheck,
  ShieldQuestion,
  Stethoscope,
  UsersRound,
  Building2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { StatusBadge } from '@/components/ui/status-badge';
import type { CompanyIdentity } from '@/lib/link-audit/audit';
import { CRITERIA } from '@/lib/link-audit/methodology';
import { LIMITS_NOTICE } from './messages';

interface AuditWorkspaceProps {
  readonly identity: CompanyIdentity | null;
}

function Card({
  icon: Icon,
  title,
  badge = 'Não implementado nesta etapa',
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly badge?: string | null;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-white/[0.06] bg-gmn-tile/50 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-gmn-text">
          <Icon className="h-[18px] w-[18px] shrink-0 text-gmn-accent" aria-hidden="true" />
          <span className="min-w-0">{title}</span>
        </h3>
      </div>
      {badge && <StatusBadge tone="neutral" label={badge} icon={ShieldQuestion} dashed />}
      <div className="text-sm text-gmn-muted">{children}</div>
    </section>
  );
}

export function AuditWorkspace({ identity }: AuditWorkspaceProps): React.JSX.Element {
  return (
    <Panel
      id="area-da-auditoria"
      icon={ClipboardList}
      title="Área da auditoria"
      subtitle="Resumo desta sessão. Nada abaixo contém dados: a avaliação de cada empresa acontece na auditoria Lumos (veja “Auditorias armazenadas”)."
    >
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card icon={Building2} title="Identificação da empresa" badge={null}>
          {identity?.confirmation ? (
            <p>
              Identidade confirmada nesta sessão pelo identificador do link. Nenhum dado da empresa foi obtido do Google.
            </p>
          ) : (
            <p>Aguardando um link identificado e a sua confirmação.</p>
          )}
        </Card>

        <Card icon={Gauge} title="Auditoria Lumos" badge={null}>
          <p>Para avaliar uma empresa, escolha-a em Auditorias armazenadas e abra a auditoria Lumos: ali ficam a prévia, as decisões humanas e o registro de resultados.</p>
          <a href="#auditorias-armazenadas" className="mt-2 inline-flex min-h-11 items-center rounded-lg border border-white/[0.1] px-3 text-sm font-medium text-gmn-text transition-colors hover:border-white/25 hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/70">
            Ir para Auditorias armazenadas
          </a>
        </Card>

        <Card icon={ShieldCheck} title="Evidências verificadas">
          <p>Nada foi coletado para o link validado nesta tela. As coletas já preservadas aparecem em “Auditorias armazenadas”.</p>
        </Card>

        <Card icon={ShieldQuestion} title="Evidências não verificadas">
          <p>Nenhum registro. Informações que não puderem ser comprovadas ficarão aqui, sem virar nota zero nem ausência.</p>
        </Card>

        <Card icon={Stethoscope} title="Diagnóstico">
          <p>Sem diagnóstico. Ele depende das evidências e da metodologia aprovada.</p>
        </Card>

        <Card icon={UsersRound} title="Concorrentes">
          <p>Sem concorrentes. A origem e os critérios de seleção ainda dependem de decisão (D5).</p>
        </Card>

        <Card icon={Lightbulb} title="Recomendações">
          <p>Sem recomendações. Elas serão baseadas em achados comprovados.</p>
        </Card>

        <Card icon={History} title="Histórico">
          <p>Sem histórico. Nenhum snapshot é salvo nesta etapa.</p>
        </Card>

        <Card icon={FileText} title="Relatório PDF">
          <p>Indisponível. O relatório de 12 páginas depende das decisões de identidade visual e de pontuação (D3 e D4).</p>
        </Card>

        <Card icon={ListChecks} title="Critérios da metodologia" badge="Avaliação na auditoria Lumos">
          <ul className="space-y-1.5">
            {CRITERIA.map((criterion) => (
              <li key={criterion.id} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">{criterion.label}</span>
                <span className="shrink-0 text-xs text-gmn-muted">peso máx. {criterion.maxWeight}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs">Reconstrução v1 da metodologia; a régua de pontos ainda não foi aprovada.</p>
        </Card>
      </div>

      <div role="note" className="mt-5 rounded-xl border border-gmn-accent/30 bg-gmn-accent/[0.06] p-4">
        <p className="text-sm font-semibold text-gmn-text">Limites desta etapa</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gmn-muted">
          {LIMITS_NOTICE.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
