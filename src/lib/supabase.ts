import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuditPipelineStage,
  AgentName,
  BattlefieldMetrics,
  FrontierLead,
  JudgeTechnicalSheet,
  ProspectingOutput,
  ReputationMetrics,
  ReviewerAuditResult,
  RivalsMetrics,
  StrategistOutput,
  VitrineMetrics,
  DiagrammerOutput,
  BullMQAuditJobPayload,
} from '@/types/gmn';
import { StructuredLogger } from './logger';
import { normalizeAuditKeyword, normalizeAuditRow, selectLatestCompletedAudits } from './audit-state';
import type { ExistingAuditSummary } from './audit-liveness';
import { redactSecrets } from './redact';
import type { HealthReport } from './system-health';
import type { RoundSnapshot } from './history-compat';

/**
 * Repositório PostgreSQL (Supabase) com fallback automático em memória
 * quando executado em modo de desenvolvimento local sem credenciais externas.
 */
const memoryStore = {
  campaigns: new Map<string, ProspectingOutput>(),
  leads: new Map<string, FrontierLead>(),
  audits: new Map<string, Record<string, unknown>>(),
  battlefieldHistoryByPlaceAndKeyword: new Map<
    string,
    Array<{
      roundId: string;
      executedAt: string;
      greenTop3Count: number;
      averagePosition: number;
      centerLat?: number;
      centerLng?: number;
      zoomLevel?: string;
      stepMeters?: number;
      validPointsCount?: number;
      simulated?: boolean;
    }>
  >(),
};

let supabaseAdminClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (supabaseAdminClient) {
    return supabaseAdminClient;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey || url.includes('your-project-ref')) {
    return null;
  }

  supabaseAdminClient = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return supabaseAdminClient;
}

function leadFromRow(data: Record<string, unknown>): FrontierLead {
  return {
      id: String(data.id),
      campaignId: String(data.campaign_id),
      placeId: String(data.place_id),
      cid: data.cid ? String(data.cid) : null,
      featureId: data.feature_id ? String(data.feature_id) : null,
      businessName: String(data.business_name),
      primaryCategory: String(data.primary_category),
      secondaryCategories: Array.isArray(data.secondary_categories)
        ? (data.secondary_categories as string[])
        : [],
      frontierRank: Number(data.frontier_rank),
      frontierPage: (Number(data.frontier_page) === 2 ? 2 : 1) as 1 | 2,
      rating: Number(data.rating),
      totalReviews: Number(data.total_reviews),
      phoneRaw: data.phone_raw ? String(data.phone_raw) : null,
      phoneE164: data.phone_e164 ? String(data.phone_e164) : null,
      whatsappStatus: data.whatsapp_status as FrontierLead['whatsappStatus'],
      whatsappUrl: data.whatsapp_url ? String(data.whatsapp_url) : null,
      websiteStatus: data.website_status as FrontierLead['websiteStatus'],
      websiteUrl: data.website_url ? String(data.website_url) : null,
      addressRaw: data.address_raw ? String(data.address_raw) : null,
      isAddressHidden: Boolean(data.is_address_hidden),
      isServiceAreaBusiness: Boolean(data.is_service_area_business),
      coordinates: {
        latitude: Number(data.latitude),
        longitude: Number(data.longitude),
      },
      claimedByOwner: Boolean(data.claimed_by_owner),
      businessHoursConfigured: Boolean(data.business_hours_configured),
      attributesCount: Number(data.attributes_count),
      servicesListedCount: Number(data.services_listed_count),
      descriptionText: data.description_text ? String(data.description_text) : null,
      createdAt: String(data.created_at),
    };
}

export interface SavedCampaignSummary {
  readonly id: string;
  readonly city: string;
  readonly stateCode: string;
  readonly nicheKeyword: string;
  readonly totalCaptured: number;
  readonly createdAt: string;
}

export class GmnRepository {
  private readonly logger = new StructuredLogger('SYSTEM');

  /**
   * Salva a campanha de prospecção e os 10 leads de fronteira no PostgreSQL (Supabase).
   */
  public async saveProspectingCampaign(output: ProspectingOutput): Promise<void> {
    // Falhe antes de gravar qualquer campanha se a lista tiver duplicidades.
    const placeIds = output.leads.map((lead) => lead.placeId.trim());
    if (
      output.leads.length !== 10 ||
      placeIds.some((id) => id.length === 0) ||
      new Set(placeIds).size !== placeIds.length
    ) {
      throw new Error('A prospecção precisa conter exatamente 10 leads com place_id válido e único.');
    }

    const cacheResult = (): void => {
      memoryStore.campaigns.set(output.campaignId, output);
      for (const lead of output.leads) {
        memoryStore.leads.set(lead.id, lead);
      }
    };

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      cacheResult();
      this.logger.info('Campanha persistida no store local (Supabase não configurado no .env)', {
        campaignId: output.campaignId,
        leadsCount: output.leads.length,
      });
      return;
    }

    const { error: campaignError } = await supabase.from('prospecting_campaigns').insert({
      id: output.campaignId,
      city: output.city,
      state_code: output.stateCode,
      niche_keyword: output.nicheKeyword,
      center_lat: output.centerCoordinates.latitude,
      center_lng: output.centerCoordinates.longitude,
      total_captured: output.leads.length,
      status: 'COMPLETED',
    });

    if (campaignError) {
      throw new Error(`Erro ao persistir campanha no Supabase: ${campaignError.message}`);
    }

    const leadsRows = output.leads.map((lead) => ({
      id: lead.id,
      campaign_id: output.campaignId,
      place_id: lead.placeId,
      cid: lead.cid,
      feature_id: lead.featureId,
      business_name: lead.businessName,
      primary_category: lead.primaryCategory,
      secondary_categories: [...lead.secondaryCategories],
      frontier_rank: lead.frontierRank,
      frontier_page: lead.frontierPage,
      rating: lead.rating,
      total_reviews: lead.totalReviews,
      phone_raw: lead.phoneRaw,
      phone_e164: lead.phoneE164,
      whatsapp_status: lead.whatsappStatus,
      whatsapp_url: lead.whatsappUrl,
      website_status: lead.websiteStatus,
      website_url: lead.websiteUrl,
      address_raw: lead.addressRaw,
      is_address_hidden: lead.isAddressHidden,
      is_service_area_business: lead.isServiceAreaBusiness,
      latitude: lead.coordinates.latitude,
      longitude: lead.coordinates.longitude,
      claimed_by_owner: lead.claimedByOwner,
      business_hours_configured: lead.businessHoursConfigured,
      attributes_count: lead.attributesCount,
      services_listed_count: lead.servicesListedCount,
      description_text: lead.descriptionText,
    }));

    const { error: leadsError } = await supabase.from('gmn_leads').insert(leadsRows);
    if (leadsError) {
      // Evita deixar campanhas vazias depois de uma falha na gravação dos leads.
      const { error: cleanupError } = await supabase
        .from('prospecting_campaigns')
        .delete()
        .eq('id', output.campaignId);
      if (cleanupError) {
        this.logger.warn('Falha ao remover campanha incompleta', {
          campaignId: output.campaignId,
          error: cleanupError.message,
        });
      }
      throw new Error(`Erro ao persistir leads de fronteira no Supabase: ${leadsError.message}`);
    }

    // O cache local só deve refletir dados confirmados no banco.
    cacheResult();
  }

  /** Últimas auditorias com estado, duração e motivo de falha (para o diagnóstico; sem payloads). */
  public async listRecentAuditActivity(limit = 8): Promise<HealthReport['recentAudits']> {
    const supabase = getSupabaseAdmin();
    if (!supabase) return [];
    const { data, error } = await supabase
      .from('gmn_audits')
      .select('id, status, updated_at, started_at, completed_at, error_message')
      .order('updated_at', { ascending: false })
      .limit(Math.min(Math.max(1, limit), 20));
    if (error) throw new Error(`Falha ao consultar atividade recente: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map((row) => {
      const started = typeof row.started_at === 'string' ? Date.parse(row.started_at) : Number.NaN;
      const finished = typeof row.completed_at === 'string' ? Date.parse(row.completed_at) : Number.NaN;
      return {
        id: String(row.id),
        status: String(row.status),
        updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
        durationSeconds: Number.isFinite(started) && Number.isFinite(finished) ? Math.round((finished - started) / 1000) : null,
        error: typeof row.error_message === 'string' && row.error_message ? redactSecrets(row.error_message).slice(0, 300) : null,
      };
    });
  }

  /** Campanhas salvas mais recentes (somente leitura; nenhuma consulta externa). */
  public async listRecentCampaigns(limit = 20): Promise<readonly SavedCampaignSummary[]> {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return [...memoryStore.campaigns.values()].slice(-limit).reverse().map((c) => ({
        id: c.campaignId, city: c.city, stateCode: c.stateCode, nicheKeyword: c.nicheKeyword, totalCaptured: c.leads.length, createdAt: c.executedAt,
      }));
    }
    const { data, error } = await supabase
      .from('prospecting_campaigns')
      .select('id, city, state_code, niche_keyword, total_captured, created_at')
      .eq('status', 'COMPLETED')
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(1, limit), 50));
    if (error) throw new Error(`Falha ao consultar campanhas: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      city: String(row.city),
      stateCode: String(row.state_code),
      nicheKeyword: String(row.niche_keyword),
      totalCaptured: Number(row.total_captured ?? 0),
      createdAt: String(row.created_at),
    }));
  }

  /** Reabre uma campanha salva com seus leads, exatamente como foi capturada. */
  public async getCampaignWithLeads(campaignId: string): Promise<ProspectingOutput | null> {
    const supabase = getSupabaseAdmin();
    if (!supabase) return memoryStore.campaigns.get(campaignId) ?? null;
    const { data: campaign, error } = await supabase.from('prospecting_campaigns').select('*').eq('id', campaignId).maybeSingle();
    if (error) throw new Error(`Falha ao consultar campanha: ${error.message}`);
    if (!campaign) return null;
    const { data: leads, error: leadsError } = await supabase
      .from('gmn_leads')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('frontier_rank', { ascending: true });
    if (leadsError) throw new Error(`Falha ao consultar leads da campanha: ${leadsError.message}`);
    const row = campaign as Record<string, unknown>;
    return {
      campaignId: String(row.id),
      city: String(row.city),
      stateCode: String(row.state_code),
      nicheKeyword: String(row.niche_keyword),
      centerCoordinates: { latitude: Number(row.center_lat), longitude: Number(row.center_lng) },
      leads: ((leads ?? []) as Record<string, unknown>[]).map(leadFromRow),
      executedAt: String(row.created_at),
    };
  }

  public async getLeadById(leadId: string): Promise<FrontierLead | null> {
    const cached = memoryStore.leads.get(leadId);
    if (cached) {
      return cached;
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return null;
    }

    const { data, error } = await supabase
      .from('gmn_leads')
      .select('*')
      .eq('id', leadId)
      .single();

    if (error || !data) {
      return null;
    }

    return leadFromRow(data as Record<string, unknown>);
  }

  /**
   * Busca a última rodada histórica do Campo de Batalha para o mesmo perfil e palavra-chave
   * para permitir rastreamento mensal de evolução no PDF (ex: de 3 para 11 pontos verdes).
   */
  public async getPreviousBattlefieldRound(
    placeId: string,
    pureKeyword: string
  ): Promise<{
    roundId: string;
    executedAt: string;
    greenTop3Count: number;
    averagePosition: number;
  } | null> {
    const key = `${placeId}::${pureKeyword.toLowerCase().trim()}`;
    const supabase = getSupabaseAdmin();

    if (supabase) {
      const { data, error } = await supabase
        .from('gmn_battlefield_rounds')
        .select('id, executed_at, green_top3_count, average_position')
        .eq('place_id', placeId)
        .eq('keyword_pure', pureKeyword.toLowerCase().trim())
        .order('executed_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && data) {
        return {
          roundId: String(data.id),
          executedAt: String(data.executed_at),
          greenTop3Count: Number(data.green_top3_count),
          averagePosition: Number(data.average_position),
        };
      }
    }

    const localHistory = memoryStore.battlefieldHistoryByPlaceAndKeyword.get(key);
    if (localHistory && localHistory.length > 0) {
      return localHistory[localHistory.length - 1] ?? null;
    }

    return null;
  }

  /**
   * Rodadas anteriores (mais recentes primeiro) da mesma empresa e palavra-chave, com os parâmetros
   * da grade necessários para decidir se são comparáveis. Somente leitura.
   */
  public async getBattlefieldRoundCandidates(
    placeId: string,
    pureKeyword: string,
    limit = 5
  ): Promise<readonly RoundSnapshot[]> {
    const keyword = pureKeyword.toLowerCase().trim();
    const key = `${placeId}::${keyword}`;
    const supabase = getSupabaseAdmin();

    if (supabase) {
      const { data, error } = await supabase
        .from('gmn_battlefield_rounds')
        .select('id, executed_at, green_top3_count, average_position, center_lat, center_lng, zoom_level, step_meters, valid_points_count')
        .eq('place_id', placeId)
        .eq('keyword_pure', keyword)
        .order('executed_at', { ascending: false })
        .limit(limit);

      if (!error && data) {
        const rounds: RoundSnapshot[] = [];
        for (const row of data) {
          // Rodadas com líderes do fallback simulado nunca servem de base de comparação.
          const { count } = await supabase
            .from('gmn_battlefield_points')
            .select('id', { count: 'exact', head: true })
            .eq('round_id', row.id)
            .like('leader_place_id', 'ChIJ\\_RIVAL\\_DOMINATOR\\_%');
          rounds.push({
            roundId: String(row.id),
            executedAt: String(row.executed_at),
            greenTop3Count: Number(row.green_top3_count),
            averagePosition: Number(row.average_position),
            centerLat: typeof row.center_lat === 'number' ? row.center_lat : null,
            centerLng: typeof row.center_lng === 'number' ? row.center_lng : null,
            zoomLevel: typeof row.zoom_level === 'string' ? row.zoom_level : null,
            stepMeters: typeof row.step_meters === 'number' ? row.step_meters : null,
            validPointsCount: typeof row.valid_points_count === 'number' ? row.valid_points_count : null,
            simulated: (count ?? 0) > 0,
          });
        }
        return rounds;
      }
    }

    return (memoryStore.battlefieldHistoryByPlaceAndKeyword.get(key) ?? [])
      .slice()
      .reverse()
      .slice(0, limit)
      .map((entry) => ({
        roundId: entry.roundId,
        executedAt: entry.executedAt,
        greenTop3Count: entry.greenTop3Count,
        averagePosition: entry.averagePosition,
        centerLat: entry.centerLat ?? null,
        centerLng: entry.centerLng ?? null,
        zoomLevel: entry.zoomLevel ?? null,
        stepMeters: entry.stepMeters ?? null,
        validPointsCount: entry.validPointsCount ?? null,
        simulated: entry.simulated ?? false,
      }));
  }

  /**
   * Salva a rodada atual do Campo de Batalha e todos os 49 pontos na tabela relacional.
   */
  public async saveBattlefieldRound(
    auditId: string,
    leadId: string,
    metrics: BattlefieldMetrics
  ): Promise<void> {
    const key = `${metrics.placeId}::${metrics.pureKeyword.toLowerCase().trim()}`;
    const cacheRound = (): void => {
      const existing = memoryStore.battlefieldHistoryByPlaceAndKeyword.get(key) ?? [];
      existing.push({
        roundId: metrics.roundId,
        executedAt: metrics.executedAt,
        greenTop3Count: metrics.greenTop3Count,
        averagePosition: metrics.averagePosition,
        centerLat: metrics.centerOfInterest.latitude,
        centerLng: metrics.centerOfInterest.longitude,
        zoomLevel: metrics.zoomLevel,
        stepMeters: metrics.stepMeters,
        validPointsCount: metrics.validPointsCount,
        simulated: metrics.dataOrigin === 'SIMULATED',
      });
      memoryStore.battlefieldHistoryByPlaceAndKeyword.set(key, existing);
    };

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      cacheRound();
      return;
    }

    const { error: roundError } = await supabase.from('gmn_battlefield_rounds').insert({
      id: metrics.roundId,
      audit_id: auditId,
      lead_id: leadId,
      place_id: metrics.placeId,
      keyword_pure: metrics.pureKeyword.toLowerCase().trim(),
      center_lat: metrics.centerOfInterest.latitude,
      center_lng: metrics.centerOfInterest.longitude,
      zoom_level: metrics.zoomLevel,
      step_meters: metrics.stepMeters,
      total_points: 49,
      valid_points_count: metrics.validPointsCount,
      unreadable_points_count: metrics.unreadablePointsCount,
      green_top3_count: metrics.greenTop3Count,
      yellow_top4_to_7_count: metrics.yellowTop4To7Count,
      red_rank8_to_20_count: metrics.redRank8To20Count,
      invisible_count: metrics.invisibleCount,
      average_position: metrics.averagePosition,
      top3_percentage: metrics.top3Percentage,
      top7_percentage: metrics.top7Percentage,
      invisibility_percentage: metrics.invisibilityPercentage,
      previous_round_id: metrics.historicalEvolution.previousRoundId,
      previous_green_top3_count: metrics.historicalEvolution.previousGreenTop3Count,
      green_points_delta: metrics.historicalEvolution.greenPointsDelta,
      previous_average_position: metrics.historicalEvolution.previousAveragePosition,
      average_position_delta: metrics.historicalEvolution.averagePositionDelta,
      executed_at: metrics.executedAt,
    });

    if (roundError) {
      throw new Error(`Erro ao persistir rodada Campo de Batalha: ${roundError.message}`);
    }

    const pointRows = metrics.points.map((pt) => ({
      round_id: metrics.roundId,
      point_index: pt.pointIndex,
      row_index: pt.rowIndex,
      col_index: pt.colIndex,
      latitude: pt.latitude,
      longitude: pt.longitude,
      distance_from_center_meters: pt.distanceFromCenterMeters,
      read_status: pt.readStatus,
      attempts_made: pt.attemptsMade,
      target_rank: pt.targetRank,
      visual_tier: pt.visualTier,
      leader_place_id: pt.pointLeader?.placeId ?? null,
      leader_business_name: pt.pointLeader?.businessName ?? null,
      leader_primary_category: pt.pointLeader?.primaryCategory ?? null,
      leader_rating: pt.pointLeader?.rating ?? null,
      leader_total_reviews: pt.pointLeader?.totalReviews ?? null,
      leader_is_directory_filtered: pt.pointLeader?.isDirectoryFiltered ?? false,
    }));

    const { error: pointsError } = await supabase.from('gmn_battlefield_points').insert(pointRows);
    if (pointsError) {
      // The audit can be safely restarted without leaving a partial round behind.
      const { error: cleanupError } = await supabase
        .from('gmn_battlefield_rounds')
        .delete()
        .eq('id', metrics.roundId);
      if (cleanupError) {
        this.logger.error('Nao foi possivel remover rodada incompleta', {
          auditId,
          roundId: metrics.roundId,
          error: cleanupError.message,
        });
      }
      throw new Error(`Erro ao persistir os 49 pontos da matriz: ${pointsError.message}`);
    }
    cacheRound();
  }

  /**
   * Create the required gmn_audits row before enqueuing the worker.
   * Battlefield rounds have a foreign key to this row.
   */
  public async createAuditJob(payload: BullMQAuditJobPayload): Promise<void> {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      throw new Error('Supabase nao configurado. O processamento em Worker requer persistencia compartilhada.');
    }

    const { error } = await supabase.from('gmn_audits').insert({
      id: payload.auditId,
      lead_id: payload.lead.id,
      place_id: payload.lead.placeId,
      bullmq_job_id: payload.auditId,
      target_keyword: payload.targetKeyword,
      interest_center_lat: payload.interestCenter.latitude,
      interest_center_lng: payload.interestCenter.longitude,
      grid_zoom: payload.gridZoom,
      grid_step_meters: payload.gridStepMeters,
      status: 'QUEUED',
      progress_percent: 5,
      current_agent: 'MAESTRO',
      started_at: new Date().toISOString(),
    });

    if (error) {
      throw new Error(`Falha ao criar auditoria no Supabase: ${error.message}`);
    }

    memoryStore.audits.set(payload.auditId, {
      auditId: payload.auditId,
      status: 'QUEUED',
      progressPercent: 5,
      currentAgent: 'MAESTRO',
    });
  }

  /**
   * Atualiza o progresso e os payloads parciais da auditoria controlada pelo Maestro.
   */
  public async updateAuditProgress(
    auditId: string,
    stage: AuditPipelineStage,
    progressPercent: number,
    currentAgent: AgentName,
    partialData?: {
      reputation?: ReputationMetrics;
      vitrine?: VitrineMetrics;
      battlefield?: BattlefieldMetrics;
      rivals?: RivalsMetrics;
      judge?: JudgeTechnicalSheet;
      strategist?: StrategistOutput;
      reviewerLogs?: readonly ReviewerAuditResult[];
      diagrammer?: DiagrammerOutput;
      errorMessage?: string;
    }
  ): Promise<void> {
    const currentRecord = memoryStore.audits.get(auditId) ?? {};
    const updatedRecord: Record<string, unknown> = {
      ...currentRecord,
      auditId,
      status: stage,
      progressPercent,
      currentAgent,
      updatedAt: new Date().toISOString(),
      ...(partialData?.reputation ? { reputation: partialData.reputation } : {}),
      ...(partialData?.vitrine ? { vitrine: partialData.vitrine } : {}),
      ...(partialData?.battlefield ? { battlefield: partialData.battlefield } : {}),
      ...(partialData?.rivals ? { rivals: partialData.rivals } : {}),
      ...(partialData?.judge ? { judge: partialData.judge } : {}),
      ...(partialData?.strategist ? { strategist: partialData.strategist } : {}),
      ...(partialData?.reviewerLogs ? { reviewerLogs: partialData.reviewerLogs } : {}),
      ...(partialData?.diagrammer ? { diagrammer: partialData.diagrammer } : {}),
      ...(partialData?.errorMessage ? { errorMessage: partialData.errorMessage } : {}),
    };
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      memoryStore.audits.set(auditId, updatedRecord);
      return;
    }

    const updatePayload: Record<string, unknown> = {
      status: stage,
      progress_percent: progressPercent,
      current_agent: currentAgent,
    };

    if (partialData?.reputation) updatePayload.reputation_payload = partialData.reputation;
    if (partialData?.vitrine) updatePayload.vitrine_payload = partialData.vitrine;
    if (partialData?.battlefield) updatePayload.battlefield_payload = partialData.battlefield;
    if (partialData?.rivals) updatePayload.rivals_payload = partialData.rivals;
    if (partialData?.judge) updatePayload.judge_payload = partialData.judge;
    if (partialData?.strategist) updatePayload.strategist_payload = partialData.strategist;
    if (partialData?.reviewerLogs) {
      updatePayload.reviewer_audit_log = partialData.reviewerLogs;
      updatePayload.reviewer_iterations = partialData.reviewerLogs.length;
    }
    if (partialData?.diagrammer) {
      updatePayload.diagrammer_payload = partialData.diagrammer;
      updatePayload.pdf_storage_path = partialData.diagrammer.pdfStoragePath;
      updatePayload.pdf_download_url = partialData.diagrammer.pdfDownloadUrl;
      updatePayload.completed_at = partialData.diagrammer.generatedAt;
    }
    if (partialData?.errorMessage) {
      updatePayload.error_message = partialData.errorMessage;
    }

    // Estados finais não regridem: uma auditoria COMPLETED/FAILED nunca volta a RUNNING_*, e uma
    // COMPLETED nunca vira FAILED (ex.: evento tardio de um job duplicado).
    let query = supabase.from('gmn_audits').update(updatePayload).eq('id', auditId);
    if (stage === 'FAILED') query = query.neq('status', 'COMPLETED');
    else if (stage !== 'COMPLETED') query = query.not('status', 'in', '("COMPLETED","FAILED")');
    const { data, error } = await query.select('id').maybeSingle();

    if (error) {
      throw new Error(`Falha ao atualizar auditoria ${auditId}: ${error.message}`);
    }
    if (!data) {
      const existing = await supabase.from('gmn_audits').select('id, status').eq('id', auditId).maybeSingle();
      if (!existing.data) throw new Error(`Auditoria ${auditId} nao existe em gmn_audits.`);
      this.logger.warn('Atualização ignorada: a auditoria já está em estado final', {
        auditId,
        currentStatus: (existing.data as { status?: string }).status,
        ignoredStage: stage,
      });
      return;
    }
    memoryStore.audits.set(auditId, updatedRecord);
  }

  /**
   * Reivindica a auditoria para este Worker (compare-and-set): só quem encontrar `QUEUED` consegue.
   * Um segundo Worker, um job duplicado ou um job reentregue recebem `false` e NÃO executam nada.
   */
  public async claimAudit(auditId: string): Promise<boolean> {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      const record = memoryStore.audits.get(auditId);
      if (!record || record.status !== 'QUEUED') return false;
      memoryStore.audits.set(auditId, { ...record, status: 'RUNNING_EXTRACTION' });
      return true;
    }
    const { data, error } = await supabase
      .from('gmn_audits')
      .update({ status: 'RUNNING_EXTRACTION', progress_percent: 15, current_agent: 'BATTLEFIELD' })
      .eq('id', auditId)
      .eq('status', 'QUEUED')
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`Falha ao reivindicar a auditoria ${auditId}: ${error.message}`);
    return Boolean(data);
  }

  /**
   * Devolve uma auditoria parada (FAILED ou RUNNING_* sem sinal de vida) para `QUEUED`, preservando
   * todos os payloads já coletados. Compare-and-set: se ela terminou ou foi retomada nesse meio
   * tempo, devolve `false`.
   */
  public async requeueAuditForResume(auditId: string): Promise<boolean> {
    const supabase = getSupabaseAdmin();
    if (!supabase) return false;
    const { data, error } = await supabase
      .from('gmn_audits')
      .update({ status: 'QUEUED', error_message: null })
      .eq('id', auditId)
      .in('status', ['FAILED', 'RUNNING_EXTRACTION', 'RUNNING_RIVALS_AND_JUDGE', 'RUNNING_STRATEGIST', 'RUNNING_REVIEWER', 'RUNNING_DIAGRAMMER'])
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`Falha ao retomar a auditoria ${auditId}: ${error.message}`);
    return Boolean(data);
  }

  /**
   * Auditorias da mesma EMPRESA (`place_id`, e não o lead: a mesma empresa vira um lead novo a cada
   * campanha) e palavra-chave, mais recentes primeiro, para impedir duplicação paga.
   */
  public async listAuditsForLeadKeyword(
    placeId: string,
    keyword: string
  ): Promise<readonly ExistingAuditSummary[]> {
    const supabase = getSupabaseAdmin();
    if (!supabase) return [];
    const { data, error } = await supabase
      .from('gmn_audits')
      .select('id, status, target_keyword, updated_at, battlefield_payload')
      .eq('place_id', placeId)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw new Error(`Falha ao consultar auditorias do lead: ${error.message}`);
    const wanted = normalizeAuditKeyword(keyword);
    return ((data ?? []) as unknown as Record<string, unknown>[])
      .filter((row) => normalizeAuditKeyword(String(row.target_keyword ?? '')) === wanted)
      .map((row) => ({
        id: String(row.id),
        status: String(row.status),
        updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
        hasBattlefield: row.battlefield_payload !== null && row.battlefield_payload !== undefined,
      }));
  }

  /** Dados originais da auditoria (lead, palavra-chave, centro, grade) para retomá-la sem pedir nada ao cliente. */
  public async getAuditJobPayload(auditId: string): Promise<BullMQAuditJobPayload | null> {
    const supabase = getSupabaseAdmin();
    if (!supabase) return null;
    const { data, error } = await supabase.from('gmn_audits').select('*').eq('id', auditId).maybeSingle();
    if (error) throw new Error(`Falha ao ler a auditoria ${auditId}: ${error.message}`);
    if (!data) return null;
    const row = data as Record<string, unknown>;
    const lead = await this.getLeadById(String(row.lead_id));
    if (!lead || lead.placeId !== String(row.place_id)) return null;
    return {
      auditId,
      lead,
      targetKeyword: String(row.target_keyword),
      interestCenter: { latitude: Number(row.interest_center_lat), longitude: Number(row.interest_center_lng) },
      gridZoom: String(row.grid_zoom ?? '15z'),
      gridStepMeters: Number(row.grid_step_meters ?? 500),
    };
  }

  /** Preserve the last achieved percentage and expose the real failure. */
  public async markAuditFailed(auditId: string, errorMessage: string): Promise<void> {
    const previous = await this.getAuditState(auditId);
    const progress = Math.max(0, Math.min(100, Number(previous?.progressPercent ?? 5)));
    const agent = (previous?.currentAgent ?? 'MAESTRO') as AgentName;
    await this.updateAuditProgress(auditId, 'FAILED', progress, agent, { errorMessage });
  }

  /** Read Supabase first, as Next.js and the standalone Worker are separate processes. */
  public async getAuditState(auditId: string): Promise<Record<string, unknown> | null> {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return memoryStore.audits.get(auditId) ?? null;
    }

    const { data, error } = await supabase
      .from('gmn_audits')
      .select('*')
      .eq('id', auditId)
      .maybeSingle();

    if (error) {
      throw new Error(`Falha ao consultar auditoria ${auditId}: ${error.message}`);
    }

    return data ? normalizeAuditRow(data as Record<string, unknown>) : null;
  }

  /**
   * Resultados persistidos de uma auditoria, para gerar ou regenerar o PDF sem executar nada de novo.
   * Só leitura: não reexecuta Battlefield, Serper nem LLM.
   */
  public async getAuditForReport(auditId: string): Promise<{
    readonly state: Record<string, unknown>;
    readonly leadId: string;
    readonly createdAt: string | null;
    readonly completedAt: string | null;
  } | null> {
    const supabase = getSupabaseAdmin();
    if (!supabase) return null;

    const { data, error } = await supabase.from('gmn_audits').select('*').eq('id', auditId).maybeSingle();
    if (error) throw new Error(`Falha ao ler a auditoria ${auditId}: ${error.message}`);
    if (!data) return null;

    const row = data as Record<string, unknown>;
    return {
      state: normalizeAuditRow(row),
      leadId: String(row.lead_id),
      createdAt: typeof row.created_at === 'string' ? row.created_at : null,
      completedAt: typeof row.completed_at === 'string' ? row.completed_at : null,
    };
  }

  /** Cidade, UF e nicho da campanha que originou o lead (o lead não os traz). */
  public async getCampaignSummary(
    campaignId: string
  ): Promise<{ readonly city: string; readonly stateCode: string; readonly nicheKeyword: string } | null> {
    const cached = memoryStore.campaigns.get(campaignId);
    if (cached) {
      return { city: cached.city, stateCode: cached.stateCode, nicheKeyword: cached.nicheKeyword };
    }
    const supabase = getSupabaseAdmin();
    if (!supabase) return null;

    const { data, error } = await supabase
      .from('prospecting_campaigns')
      .select('city, state_code, niche_keyword')
      .eq('id', campaignId)
      .maybeSingle();
    if (error || !data) return null;
    return {
      city: String(data.city),
      stateCode: String(data.state_code),
      nicheKeyword: String(data.niche_keyword),
    };
  }

  /**
   * Atualiza só os metadados do PDF de uma auditoria já concluída (usado ao regenerar o PDF com
   * `--store`). Não altera status, progresso nem os demais resultados.
   */
  public async saveRegeneratedPdf(auditId: string, output: DiagrammerOutput): Promise<void> {
    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error('Supabase não configurado.');
    const { error } = await supabase
      .from('gmn_audits')
      .update({
        diagrammer_payload: output,
        pdf_storage_path: output.pdfStoragePath,
        pdf_download_url: output.pdfDownloadUrl,
      })
      .eq('id', auditId);
    if (error) throw new Error(`Falha ao atualizar o PDF da auditoria ${auditId}: ${error.message}`);
  }

  /**
   * Leitura somente de auditorias já concluídas, para reabrir o mapa sem rodar nada de novo.
   * Uma única consulta; não traz os payloads pesados (estratégia, log do revisor, vitrine).
   */
  public async getLatestCompletedAudits(
    placeIds: readonly string[],
    keyword: string
  ): Promise<Record<string, Record<string, unknown>>> {
    const supabase = getSupabaseAdmin();
    if (!supabase || placeIds.length === 0) {
      return {};
    }

    const { data, error } = await supabase
      .from('gmn_audits')
      .select(
        'id, lead_id, place_id, target_keyword, status, progress_percent, current_agent, created_at, ' +
          'battlefield_payload, judge_payload, reputation_payload, rivals_payload, diagrammer_payload'
      )
      .in('place_id', [...placeIds])
      .eq('status', 'COMPLETED')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      throw new Error(`Falha ao consultar auditorias concluídas: ${error.message}`);
    }

    return selectLatestCompletedAudits((data ?? []) as unknown as Record<string, unknown>[], keyword);
  }

}

export const gmnRepository = new GmnRepository();
