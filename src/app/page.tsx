'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  AuditPipelineStage,
  BattlefieldMetrics,
  FrontierLead,
  ProspectingOutput,
} from '@/types/gmn';
import { toBattlefieldMapModel } from '@/lib/battlefield-map-adapter';
import { AuditPanel } from '@/components/dashboard/audit-panel';
import { BattlefieldCard } from '@/components/dashboard/battlefield-card';
import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { ErrorBanner } from '@/components/dashboard/error-banner';
import { LeadsTable } from '@/components/dashboard/leads-table';
import { TerritorySummary } from '@/components/dashboard/territory-summary';
import { TopFilters } from '@/components/dashboard/top-filters';
import type { AuditJobTracker } from '@/components/dashboard/types';
import type { SavedCampaignSummary } from '@/lib/supabase';

export default function GmnIntelligenceDashboardPage(): React.JSX.Element {
  const [city, setCity] = useState<string>('Anápolis');
  const [stateCode, setStateCode] = useState<string>('GO');
  const [nicheKeyword, setNicheKeyword] = useState<string>('Clínica Odontológica');
  const [isProspecting, setIsProspecting] = useState<boolean>(false);
  const [campaign, setCampaign] = useState<ProspectingOutput | null>(null);
  const [auditsByLeadId, setAuditsByLeadId] = useState<Record<string, AuditJobTracker>>({});
  const [selectedLeadIdForModal, setSelectedLeadIdForModal] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [enqueuingLeadId, setEnqueuingLeadId] = useState<string | null>(null);
  const [savedCampaigns, setSavedCampaigns] = useState<readonly SavedCampaignSummary[]>([]);
  const [loadingCampaignId, setLoadingCampaignId] = useState<string | null>(null);
  // Último Campo de Batalha conhecido por lead: não é apagado se uma nova auditoria falhar ou recomeçar.
  const [lastBattlefieldByLeadId, setLastBattlefieldByLeadId] = useState<
    Record<string, { readonly auditId: string; readonly battlefield: BattlefieldMetrics }>
  >({});

  const redirectToLogin = (): void => {
    window.location.assign('/login');
  };

  const refreshSavedCampaigns = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/campaigns');
      if (!res.ok) return;
      const body = (await res.json()) as { campaigns?: SavedCampaignSummary[] };
      setSavedCampaigns(body.campaigns ?? []);
    } catch {
      /* lista de campanhas salvas é opcional */
    }
  }, []);

  useEffect(() => {
    void refreshSavedCampaigns();
  }, [refreshSavedCampaigns]);

  // Reabre uma campanha salva: somente leitura, nenhuma consulta paga.
  const handleOpenSavedCampaign = async (campaignId: string): Promise<void> => {
    setErrorBanner(null);
    setLoadingCampaignId(campaignId);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`);
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error('Não foi possível reabrir a campanha salva.');
      const data = (await res.json()) as ProspectingOutput;
      setAuditsByLeadId({});
      setLastBattlefieldByLeadId({});
      setSelectedLeadIdForModal(null);
      setCity(data.city);
      setStateCode(data.stateCode);
      setNicheKeyword(data.nicheKeyword);
      setCampaign(data);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingCampaignId(null);
    }
  };

  const handleLogout = async (): Promise<void> => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    redirectToLogin();
  };

  /** Anexa à tela uma auditoria que já existe (concluída, em andamento ou parada). */
  const attachExistingAudit = async (lead: FrontierLead, auditId: string): Promise<void> => {
    const res = await fetch(`/api/audit/${auditId}/status`);
    if (!res.ok) return;
    const state = (await res.json()) as AuditJobTracker;
    setAuditsByLeadId((prev) => ({
      ...prev,
      [lead.id]: { ...state, leadId: lead.id, recovered: state.status === 'COMPLETED' },
    }));
    setSelectedLeadIdForModal(lead.id);
  };

  const handleResumeAudit = async (tracker: AuditJobTracker): Promise<void> => {
    setErrorBanner(null);
    try {
      const res = await fetch(`/api/audit/${tracker.auditId}/resume`, { method: 'POST' });
      if (res.status === 401) return redirectToLogin();
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Não foi possível retomar a auditoria.');
      setAuditsByLeadId((prev) => ({
        ...prev,
        [tracker.leadId]: { ...tracker, status: 'QUEUED', phase: 'WAITING', phaseReason: null, resumable: false, errorMessage: undefined, recovered: false },
      }));
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRunProspecting = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setIsProspecting(true);
    setErrorBanner(null);

    try {
      const response = await fetch('/api/prospect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, stateCode, nicheKeyword }),
      });

      if (response.status === 401) return redirectToLogin();
      if (!response.ok) {
        const errData = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(errData.error ?? 'Erro ao executar Head Agent de prospecção');
      }

      const data = (await response.json()) as ProspectingOutput;
      setCampaign(data);
      void refreshSavedCampaigns();
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setIsProspecting(false);
    }
  };

  const handleTriggerAuditPdf = async (lead: FrontierLead, force = false): Promise<void> => {
    setErrorBanner(null);
    setEnqueuingLeadId(lead.id);
    try {
      const response = await fetch('/api/audit/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadId: lead.id,
          targetKeyword: nicheKeyword,
          interestCenter: lead.coordinates,
          gridZoom: '15z',
          gridStepMeters: 500,
          ...(force ? { force: true } : {}),
        }),
      });

      if (response.status === 401) return redirectToLogin();
      if (response.status === 409) {
        // Já existe auditoria desta empresa e palavra-chave: abre a existente em vez de duplicar.
        const conflict = (await response.json().catch(() => ({}))) as { error?: string; code?: string; auditId?: string };
        if (conflict.auditId) await attachExistingAudit(lead, conflict.auditId);
        if (conflict.code === 'ALREADY_COMPLETED' && conflict.auditId) {
          const again = window.confirm(
            'Já existe uma auditoria concluída para esta empresa e palavra-chave (aberta na tela).\n\nFazer uma NOVA coleta? Isso consome 49 consultas pagas do Serper.'
          );
          if (again) await handleTriggerAuditPdf(lead, true);
          return;
        }
        setErrorBanner(conflict.error ?? 'Já existe uma auditoria para esta empresa.');
        return;
      }
      if (!response.ok) {
        const errData = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(errData.error ?? 'Falha ao enfileirar auditoria');
      }

      const enqueueData = (await response.json()) as {
        auditId: string;
        status: AuditPipelineStage;
        progressPercent: number;
        workerAlive?: boolean;
      };

      setAuditsByLeadId((prev) => ({
        ...prev,
        [lead.id]: {
          auditId: enqueueData.auditId,
          leadId: lead.id,
          status: enqueueData.status,
          progressPercent: enqueueData.progressPercent,
          currentAgent: 'MAESTRO',
          phase: 'WAITING',
          ...(enqueueData.workerAlive === false
            ? { workerAlive: false, phaseReason: 'O Worker de auditorias não está ativo. Inicie-o com npm run worker.' }
            : {}),
        },
      }));

      setSelectedLeadIdForModal(lead.id);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setEnqueuingLeadId(null);
    }
  };

  const pollActiveAudits = useCallback(async () => {
    const activeEntries = Object.values(auditsByLeadId).filter(
      (a) => a.status !== 'COMPLETED' && a.status !== 'FAILED'
    );

    if (activeEntries.length === 0) {
      return;
    }

    for (const tracker of activeEntries) {
      try {
        const res = await fetch(`/api/audit/${tracker.auditId}/status`);
        if (res.status === 401) return redirectToLogin();
        if (!res.ok) {
          const errorData = (await res.json().catch(() => ({}))) as { error?: string };
          setErrorBanner(errorData.error ?? `Falha ao consultar o progresso: HTTP ${res.status}`);
          continue;
        }
        const state = (await res.json()) as AuditJobTracker;
        setAuditsByLeadId((prev) => ({
          ...prev,
          [tracker.leadId]: {
            ...tracker,
            ...state,
          },
        }));
      } catch {
        // Ignora erro transitório de polling
      }
    }
  }, [auditsByLeadId]);

  useEffect(() => {
    const interval = setInterval(() => {
      void pollActiveAudits();
    }, 1200);
    return () => clearInterval(interval);
  }, [pollActiveAudits]);

  const activeModalTracker = selectedLeadIdForModal
    ? auditsByLeadId[selectedLeadIdForModal] ?? null
    : null;
  const activeModalLead =
    campaign?.leads.find((l) => l.id === selectedLeadIdForModal) ?? null;

  // Reabre auditorias já concluídas (mesma empresa + palavra-chave) sem executar nada:
  // uma única consulta de leitura por campanha carregada. Não seleciona leads nem inicia auditorias.
  useEffect(() => {
    if (!campaign || campaign.leads.length === 0) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      keyword: campaign.nicheKeyword,
      placeIds: campaign.leads.map((l) => l.placeId).join(','),
    });

    fetch(`/api/audit/completed?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as {
          audits?: Record<string, Omit<AuditJobTracker, 'leadId'>>;
        };
        const saved = body.audits ?? {};
        setAuditsByLeadId((prev) => {
          const next = { ...prev };
          for (const lead of campaign.leads) {
            const audit = saved[lead.placeId];
            if (audit && !next[lead.id]) {
              next[lead.id] = { ...audit, leadId: lead.id, recovered: true };
            }
          }
          return next;
        });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.warn('Não foi possível consultar auditorias salvas', err);
      });

    return () => controller.abort();
  }, [campaign]);

  useEffect(() => {
    setLastBattlefieldByLeadId((prev) => {
      let next = prev;
      for (const [leadId, tracker] of Object.entries(auditsByLeadId)) {
        if (tracker.battlefield && prev[leadId]?.battlefield.roundId !== tracker.battlefield.roundId) {
          if (next === prev) next = { ...prev };
          next[leadId] = { auditId: tracker.auditId, battlefield: tracker.battlefield };
        }
      }
      return next;
    });
  }, [auditsByLeadId]);

  const liveBattlefield = activeModalTracker?.battlefield ?? null;
  const storedBattlefield = selectedLeadIdForModal
    ? lastBattlefieldByLeadId[selectedLeadIdForModal]
    : undefined;
  const viewBattlefield = liveBattlefield ?? storedBattlefield?.battlefield ?? null;
  const isStaleResult = liveBattlefield === null && viewBattlefield !== null;
  const viewAuditId = liveBattlefield ? activeModalTracker?.auditId : storedBattlefield?.auditId;

  const battlefieldModel = useMemo(
    () =>
      toBattlefieldMapModel({
        battlefield: viewBattlefield,
        lead: activeModalLead,
        auditId: viewAuditId,
      }),
    [viewBattlefield, activeModalLead, viewAuditId]
  );

  const handleInspectAudit = (leadId: string): void => {
    setSelectedLeadIdForModal(leadId);
    document.getElementById('battlefield')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <DashboardShell onLogout={() => void handleLogout()}>
      {errorBanner && (
        <ErrorBanner message={errorBanner} onDismiss={() => setErrorBanner(null)} />
      )}

      <div id="visao-geral" className="scroll-mt-6 space-y-5">
        <TopFilters
          city={city}
          stateCode={stateCode}
          nicheKeyword={nicheKeyword}
          isProspecting={isProspecting}
          onCityChange={setCity}
          onStateCodeChange={setStateCode}
          onNicheKeywordChange={setNicheKeyword}
          onSubmit={(e) => void handleRunProspecting(e)}
          savedCampaigns={savedCampaigns}
          activeCampaignId={campaign?.campaignId ?? null}
          loadingCampaignId={loadingCampaignId}
          onOpenSavedCampaign={(id) => void handleOpenSavedCampaign(id)}
        />

        <div className="grid grid-cols-1 items-stretch gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(380px,1fr)]">
          <BattlefieldCard
            model={battlefieldModel}
            lead={activeModalLead}
            tracker={activeModalTracker}
            isStaleResult={isStaleResult}
          />
          <TerritorySummary
            campaign={campaign}
            lead={activeModalLead}
            tracker={activeModalTracker}
            model={battlefieldModel}
          />
        </div>
      </div>

      <LeadsTable
        campaign={campaign}
        isProspecting={isProspecting}
        auditsByLeadId={auditsByLeadId}
        enqueuingLeadId={enqueuingLeadId}
        selectedLeadId={selectedLeadIdForModal}
        onGenerateAudit={(lead) => void handleTriggerAuditPdf(lead)}
        onInspectAudit={handleInspectAudit}
      />

      <AuditPanel
        tracker={activeModalTracker}
        lead={activeModalLead}
        onRetry={(lead) => void handleTriggerAuditPdf(lead)}
        onResume={(tracker) => void handleResumeAudit(tracker)}
      />
    </DashboardShell>
  );
}
