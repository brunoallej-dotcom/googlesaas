import {
  Archive,
  Building2,
  CircleCheck,
  Clock,
  Database,
  Fingerprint,
  Globe,
  History,
  Info,
  ListChecks,
  LoaderCircle,
  MapPin,
  Phone,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Star,
  Tags,
  TriangleAlert,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { CRITERIA } from '@/lib/link-audit/methodology';
import type { AuditDetailDto, EvidenceDto } from '@/lib/link-audit-evidence';
import {
  ACCESS_CLASS_LABELS,
  COLLECTION_NOTICE,
  evidenceLabel,
  formatCoordinate,
  formatCount,
  formatDateTime,
  formatRating,
  IDENTIFIER_TYPE_LABELS,
  INTEGRITY_LABELS,
  ORIGIN_LABELS,
  PROVIDER_FIELD_LABELS,
  placeLine,
  STATE_LABELS,
} from './evidence-labels';

const WEEK = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo'];
const plain = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const dayRank = (day: string): number => {
  const index = WEEK.findIndex((name) => plain(day).startsWith(name));
  return index === -1 ? 99 : index;
};
/** Ressalva repetida em pelo menos 3 evidências verificadas: aparece uma vez no topo, não em cada cartão. */
function mostCommonLimitation(items: readonly EvidenceDto[]): string | null {
  const counts = new Map<string, number>();
  for (const item of items) if (item.limitation) counts.set(item.limitation, (counts.get(item.limitation) ?? 0) + 1);
  let best: [string, number] | null = null;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  return best && best[1] >= 3 ? best[0] : null;
}

const CRITERION_LABEL: Readonly<Record<string, string>> = Object.fromEntries(CRITERIA.map((criterion) => [criterion.id, criterion.label]));

function Card({ icon: Icon, title, children, className = '' }: { readonly icon: LucideIcon; readonly title: string; readonly children: React.ReactNode; readonly className?: string }): React.JSX.Element {
  return (
    <section className={`min-w-0 rounded-xl border border-white/[0.06] bg-gmn-tile/50 p-4 ${className}`}>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-gmn-text">
        <Icon className="h-[18px] w-[18px] shrink-0 text-gmn-accent" aria-hidden="true" />
        {title}
      </h3>
      <div className="mt-3 text-sm text-gmn-muted">{children}</div>
    </section>
  );
}

function Row({ icon: Icon, label, children }: { readonly icon?: LucideIcon; readonly label: string; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 py-1.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <dt className="flex items-center gap-1.5 text-xs text-gmn-muted">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        {label}
      </dt>
      <dd className="min-w-0 break-words text-sm text-gmn-text">{children}</dd>
    </div>
  );
}

const Dash = (): React.JSX.Element => <span className="text-gmn-muted">não informado</span>;

function EvidenceItem({ item, verified, sharedLimitation }: { readonly item: EvidenceDto; readonly verified: boolean; readonly sharedLimitation?: string | null }): React.JSX.Element {
  const criterion = CRITERION_LABEL[item.criterionId];
  return (
    <li className={`rounded-lg border p-3 ${verified ? 'border-gmn-success/25 bg-gmn-success/[0.05]' : 'border-dashed border-white/15 bg-white/[0.02]'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium text-gmn-text">{evidenceLabel(item.id, item.attribute)}</p>
        <StatusBadge tone={verified ? 'success' : 'neutral'} label={verified ? 'Verificada' : 'Não verificada'} icon={verified ? ShieldCheck : ShieldQuestion} dashed={!verified} />
      </div>
      {verified ? <p className="mt-1 break-words text-sm text-gmn-text">{item.claim}</p> : <p className="mt-1 break-words text-xs text-gmn-muted">{item.limitation ?? 'Sem motivo registrado.'}</p>}
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gmn-muted">
        <span>Origem: {ORIGIN_LABELS[item.origin] ?? item.origin}</span>
        {criterion && <span>Critério: {criterion}</span>}
        <span>Consulta: {formatDateTime(item.consultedAt)}</span>
      </p>
      {verified && item.limitation && item.limitation !== sharedLimitation && <p className="mt-1 break-words text-[11px] text-gmn-muted">{item.limitation}</p>}
    </li>
  );
}

interface StoredAuditDetailProps {
  readonly detail: AuditDetailDto;
  readonly loading: boolean;
  readonly onSelectRevision: (capture: number | null, revision: number) => void;
}

export function StoredAuditDetail({ detail, loading, onSelectRevision }: StoredAuditDetailProps): React.JSX.Element {
  const est = detail.establishment;
  const ids = detail.identifiers;
  const hours = [...(est?.openingHours ?? [])].sort((a, b) => dayRank(a.day) - dayRank(b.day));
  const integrityTone = detail.integrity.status === 'OK' ? 'success' : detail.integrity.status === 'MISMATCH' ? 'danger' : 'warning';
  const confirmedCid = ids.confirmed.find((entry) => entry.type === 'cid');
  const sharedLimitation = mostCommonLimitation(detail.evidences.verified);

  return (
    <article aria-label={`Detalhes da coleta de ${detail.company.name ?? detail.auditId}`} aria-busy={loading} className="min-w-0 space-y-4">
      <header className="rounded-xl border border-white/[0.06] bg-gmn-tile/50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="detalhe-auditoria-titulo" tabIndex={-1} className="break-words text-lg font-semibold text-gmn-text focus:outline-none">
              {detail.company.name ?? 'Empresa sem nome informado'}
            </h3>
            <p className="mt-0.5 text-xs text-gmn-muted">{placeLine(detail.company.city, detail.company.stateCode) || 'Cidade não informada'}</p>
            <p className="mt-0.5 text-[11px] text-gmn-muted">Nome e cidade informados por quem coletou; os dados do perfil estão abaixo.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {loading && <StatusBadge tone="info" label="Atualizando…" icon={LoaderCircle} spin />}
            <StatusBadge tone="info" label="Coleta de evidências" icon={Archive} />
            <StatusBadge tone={integrityTone} label={INTEGRITY_LABELS[detail.integrity.status] ?? detail.integrity.status} icon={detail.integrity.status === 'OK' ? CircleCheck : ShieldAlert} />
          </div>
        </div>
        <dl className="mt-3 grid gap-x-6 sm:grid-cols-2">
          <Row label="ID da auditoria">
            <span className="font-mono text-xs">{detail.auditId}</span>
          </Row>
          <Row label="Coletado em">{formatDateTime(detail.collectedAt)}</Row>
          <Row label="Situação">{STATE_LABELS[detail.state] ?? detail.state}</Row>
          <Row label="Metodologia">{detail.methodologyVersion ?? 'versão não registrada nesta coleta'}</Row>
        </dl>
      </header>

      <div role="note" className="rounded-xl border border-gmn-accent/30 bg-gmn-accent/[0.06] p-4">
        <p className="flex items-start gap-2 text-sm font-semibold text-gmn-text">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" aria-hidden="true" />
          {COLLECTION_NOTICE.title}
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-9 text-xs text-gmn-muted">
          {COLLECTION_NOTICE.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card icon={Building2} title="Estabelecimento">
          {est ? (
            <dl className="divide-y divide-white/[0.05]">
              <Row icon={Building2} label="Nome">{est.name ?? <Dash />}</Row>
              <Row icon={MapPin} label="Endereço">{est.address ?? <Dash />}</Row>
              <Row icon={MapPin} label="Localização">
                {detail.location ? (
                  <span className="font-mono text-xs">
                    {formatCoordinate(detail.location.latitude)}, {formatCoordinate(detail.location.longitude)}
                  </span>
                ) : (
                  <Dash />
                )}
              </Row>
              <Row icon={Phone} label="Telefone">{est.phone ?? <Dash />}</Row>
              <Row icon={Globe} label="Site no perfil">{est.website ? <span className="break-all">{est.website}</span> : <Dash />}</Row>
              <Row icon={Tags} label="Categoria">
                {est.category ? (
                  <>
                    {est.category}
                    {est.secondaryCategories.length > 0 && <span className="text-gmn-muted"> · também: {est.secondaryCategories.join(', ')}</span>}
                  </>
                ) : (
                  <Dash />
                )}
              </Row>
              <Row icon={Star} label="Nota e avaliações">
                {est.rating !== null ? (
                  <span>
                    <strong className="text-gmn-text">{formatRating(est.rating)}</strong> de 5 · {formatCount(est.ratingCount)} avaliações
                  </span>
                ) : (
                  <Dash />
                )}
              </Row>
            </dl>
          ) : (
            <p>O perfil não foi confirmado nesta coleta: nenhum dado do estabelecimento é exibido.</p>
          )}
          <p className="mt-3 text-[11px]">Dados do perfil obtidos via Serper /maps em {formatDateTime(est?.queriedAt ?? detail.collectedAt)}; o perfil não foi aberto diretamente no Google.</p>
        </Card>

        <Card icon={Clock} title="Horário de funcionamento">
          {hours.length > 0 ? (
            <table className="w-full text-sm">
              <caption className="sr-only">Horário de funcionamento por dia da semana</caption>
              <tbody className="divide-y divide-white/[0.05]">
                {hours.map((entry) => (
                  <tr key={entry.day}>
                    <th scope="row" className="py-1.5 pr-3 text-left text-xs font-normal text-gmn-muted first-letter:uppercase">
                      {entry.day}
                    </th>
                    <td className="py-1.5 text-right text-gmn-text">{entry.hours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>O perfil coletado não trouxe horários.</p>
          )}
        </Card>
      </div>

      <Card icon={Fingerprint} title="Identificadores">
        <p className="text-sm text-gmn-text">
          {confirmedCid ? (
            <>
              <strong>CID confirmado:</strong> <span className="break-all font-mono">{confirmedCid.value}</span>
            </>
          ) : (
            <strong>Nenhum identificador foi confirmado nesta coleta.</strong>
          )}
        </p>
        {confirmedCid && (
          <p className="mt-1 text-xs">
            {confirmedCid.expectedOrigin === 'DERIVED_FROM_FID' ? 'Esperado a partir do FID do link (conversão offline: a 2ª metade do FID, em decimal)' : 'Esperado a partir do cid do link'}; comparado com{' '}
            {confirmedCid.providerFields.map((field) => PROVIDER_FIELD_LABELS[field] ?? field).join(' e ') || 'o retorno do provedor'}.
          </p>
        )}
        <dl className="mt-3 divide-y divide-white/[0.05]">
          <Row label="No link original">
            {[ids.fromLink.cid && `CID ${ids.fromLink.cid}`, ids.fromLink.featureId && `FID ${ids.fromLink.featureId}`, ids.fromLink.placeId && `Place ID ${ids.fromLink.placeId}`].filter(Boolean).join(' · ') || <Dash />}
          </Row>
          <Row label="Derivado (offline)">{ids.derivedCid ? <span className="break-all font-mono text-xs">CID {ids.derivedCid.value}</span> : 'nenhum'}</Row>
          <Row label="Devolvido pelo Serper">
            {ids.returnedByProvider ? (
              <span className="break-all font-mono text-xs">
                {[ids.returnedByProvider.cid && `CID ${ids.returnedByProvider.cid}`, ids.returnedByProvider.featureId && `FID ${ids.returnedByProvider.featureId}`, ids.returnedByProvider.placeId && `Place ID ${ids.returnedByProvider.placeId}`].filter(Boolean).join(' · ')}
              </span>
            ) : (
              'nenhum perfil aceito'
            )}
          </Row>
          <Row label="Confirmados">
            {ids.confirmed.length > 0 ? ids.confirmed.map((entry) => `${IDENTIFIER_TYPE_LABELS[entry.type] ?? entry.type} ${entry.value}`).join(' · ') : 'nenhum'}
          </Row>
        </dl>
        <p className="mt-2 text-[11px]">O nome da empresa nunca confirma a identidade: só identificadores iguais aos do link.</p>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card icon={ShieldCheck} title={`Evidências verificadas (${detail.evidences.verified.length})`}>
          {sharedLimitation && <p className="mb-2 text-[11px]">Em todas as evidências verificadas: {sharedLimitation}</p>}
          {detail.evidences.verified.length > 0 ? (
            <ul className="space-y-2">
              {detail.evidences.verified.map((item) => (
                <EvidenceItem key={item.id} item={item} verified sharedLimitation={sharedLimitation} />
              ))}
            </ul>
          ) : (
            <p>Nenhuma evidência foi comprovada nesta coleta.</p>
          )}
        </Card>
        <Card icon={ShieldQuestion} title={`Evidências não verificadas (${detail.evidences.unverified.length})`}>
          <p className="mb-2 text-xs">Não verificado não significa ausente nem nota zero: significa que esta fonte não comprova a informação.</p>
          {detail.evidences.unverified.length > 0 ? (
            <ul className="space-y-2">
              {detail.evidences.unverified.map((item) => (
                <EvidenceItem key={item.id} item={item} verified={false} />
              ))}
            </ul>
          ) : (
            <p>Nenhuma evidência pendente.</p>
          )}
        </Card>
      </div>

      {detail.evidences.other.length > 0 && (
        <Card icon={ListChecks} title={`Outras evidências (${detail.evidences.other.length})`}>
          <ul className="space-y-2">
            {detail.evidences.other.map((item) => (
              <EvidenceItem key={item.id} item={item} verified={false} />
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card icon={Globe} title="Site oficial (observação da coleta)">
          {detail.site ? (
            <dl className="divide-y divide-white/[0.05]">
              <Row label="Endereço consultado">{detail.site.requestedUrl ? <span className="break-all">{detail.site.requestedUrl}</span> : <Dash />}</Row>
              <Row label="Resultado">{(detail.site.accessClass && ACCESS_CLASS_LABELS[detail.site.accessClass]) ?? detail.site.accessClass ?? <Dash />}</Row>
              <Row label="Requisições">{detail.site.httpRequests ?? <Dash />}</Row>
              <Row label="Observado em">{formatDateTime(detail.site.checkedAt)}</Row>
            </dl>
          ) : (
            <p>O site não foi verificado nesta coleta.</p>
          )}
          {detail.site?.accessNote && <p className="mt-2 text-xs">{detail.site.accessNote}</p>}
          <p className="mt-2 text-[11px]">O site é uma fonte separada do perfil; esta tela não consulta o site novamente.</p>
        </Card>

        <Card icon={TriangleAlert} title={`Limitações da coleta (${detail.limitations.length})`}>
          {detail.limitations.length > 0 ? (
            <ul className="list-disc space-y-1.5 pl-5">
              {detail.limitations.map((line) => (
                <li key={line} className="break-words">
                  {line}
                </li>
              ))}
            </ul>
          ) : (
            <p>Nenhuma limitação registrada.</p>
          )}
          {detail.divergences.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold text-gmn-text">Divergências entre perfil e site</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
                {detail.divergences.map((d, index) => (
                  <li key={`${d.field}-${index}`}>
                    {d.field}: perfil “{d.googleMaps}” × site “{d.site}”. {d.note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card icon={Database} title="Origem dos dados">
          <dl className="divide-y divide-white/[0.05]">
            <Row label="Fonte">{detail.source.label}</Row>
            <Row label="API oficial do Google">Não. Os dados vêm de um intermediário de coleta.</Row>
            <Row label="Resposta HTTP">{detail.source.httpStatus ?? <Dash />}</Row>
            <Row label="Chamadas">{detail.source.httpAttempts ?? <Dash />}</Row>
            <Row label="Créditos informados">{detail.source.creditsReportedByApi ?? <Dash />} <span className="text-xs text-gmn-muted">(informado pela própria resposta; o saldo real só o painel do provedor mostra)</span></Row>
            <Row label="Resultados">{detail.source.resultCount ?? <Dash />}</Row>
          </dl>
        </Card>

        <Card icon={History} title="Histórico de versões">
          {detail.versions.length > 0 ? (
            <ul className="space-y-3">
              {detail.versions.map((version) => (
                <li key={version.capture ?? 'sem-captura'} className="rounded-lg border border-white/[0.06] p-3">
                  <p className="text-sm text-gmn-text">
                    Captura {version.capture ?? '—'} · {formatDateTime(version.collectedAt)}
                    {version.httpStatus !== null && <span className="text-gmn-muted"> · HTTP {version.httpStatus}</span>}
                  </p>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {version.reportRevisions.map((revision) => {
                      const current = revision.revision === detail.selected.revision && (version.capture === null || version.capture === detail.selected.capture);
                      return (
                        <li key={revision.revision}>
                          <button
                            type="button"
                            disabled={loading}
                            aria-current={current ? 'true' : undefined}
                            onClick={() => onSelectRevision(version.capture, revision.revision)}
                            className={`rounded-md border px-2.5 py-1 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gmn-accent/60 disabled:opacity-60 ${
                              current ? 'border-gmn-accent/60 bg-gmn-accent/10 text-gmn-text' : 'border-white/[0.1] text-gmn-muted hover:border-white/25 hover:text-gmn-text'
                            }`}
                          >
                            Versão {revision.revision}
                            {revision.superseded ? ' (substituída)' : ' (atual)'}
                            <span className="ml-1 text-[10px] text-gmn-muted">{formatDateTime(revision.generatedAt)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <p>Sem histórico registrado.</p>
          )}
          <p className="mt-2 text-[11px]">Cada versão é um arquivo imutável: uma correção nunca sobrescreve a anterior.</p>
        </Card>
      </div>

      <Card icon={detail.integrity.status === 'OK' ? ShieldCheck : ShieldAlert} title="Integridade dos arquivos">
        <p className="text-sm text-gmn-text">
          {INTEGRITY_LABELS[detail.integrity.status] ?? detail.integrity.status} · {detail.integrity.checkedFiles} arquivo(s) conferido(s) com {detail.integrity.algorithm}
        </p>
        {detail.integrity.issues.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
            {detail.integrity.issues.map((issue, index) => (
              <li key={`${index}-${issue}`}>{issue}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px]">{detail.integrity.note}</p>
        <p className="mt-1 text-[11px]">Os arquivos ficam no mesmo disco do servidor: isto não é um backup independente.</p>
      </Card>
    </article>
  );
}
