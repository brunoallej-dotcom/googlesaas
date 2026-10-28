/**
 * ============================================================================
 * TIPAGEM ESTRITA DE DOMÍNIO - SISTEMA DE INTELIGÊNCIA GMN
 * Comunicação entre Head Agent, Maestro e os 8 Agentes de Auditoria
 * ============================================================================
 */

export type WhatsAppPresenceStatus =
  | 'VERIFIED_WHATSAPP'
  | 'LIKELY_MOBILE_WHATSAPP'
  | 'LANDLINE_ONLY'
  | 'MISSING';

export type WebsitePresenceStatus =
  | 'OWN_DOMAIN'
  | 'SOCIAL_LINK_ONLY'
  | 'MISSING';

/** Origem de cada campo do lead: o que veio de uma coleta real e o que o sistema não sabe. */
export type LeadFieldOrigin = 'COLLECTED' | 'UNKNOWN';

export interface LeadFieldProvenance {
  readonly claimedByOwner?: LeadFieldOrigin;
  readonly rating?: LeadFieldOrigin;
  readonly totalReviews?: LeadFieldOrigin;
  readonly attributesCount?: LeadFieldOrigin;
  readonly servicesListedCount?: LeadFieldOrigin;
  readonly businessHoursConfigured?: LeadFieldOrigin;
}

export type AuditPipelineStage =
  | 'QUEUED'
  | 'RUNNING_EXTRACTION'
  | 'RUNNING_RIVALS_AND_JUDGE'
  | 'RUNNING_STRATEGIST'
  | 'RUNNING_REVIEWER'
  | 'RUNNING_DIAGRAMMER'
  | 'COMPLETED'
  | 'FAILED';

export type AgentName =
  | 'HEAD_PROSPECTOR'
  | 'MAESTRO'
  | 'REPUTATION'
  | 'VITRINE'
  | 'BATTLEFIELD'
  | 'RIVALS'
  | 'JUDGE'
  | 'STRATEGIST'
  | 'REVIEWER'
  | 'DIAGRAMMER';

/**
 * ----------------------------------------------------------------------------
 * 1. MÓDULO DE PROSPECÇÃO (HEAD AGENT)
 * ----------------------------------------------------------------------------
 */
export interface ProspectingInput {
  readonly city: string;
  readonly stateCode: string;
  readonly nicheKeyword: string;
  readonly centerCoordinates?: {
    readonly latitude: number;
    readonly longitude: number;
  };
}

export interface FrontierLead {
  readonly id: string;
  readonly campaignId: string;
  readonly placeId: string; // Identificador imutável do Google Maps
  readonly cid: string | null;
  readonly featureId: string | null;
  readonly businessName: string;
  readonly primaryCategory: string;
  readonly secondaryCategories: readonly string[];
  readonly frontierRank: number; // Posição entre 15 e 26 (final da 1ª pág / início da 2ª pág)
  readonly frontierPage: 1 | 2;
  readonly rating: number;
  readonly totalReviews: number;
  readonly phoneRaw: string | null;
  readonly phoneE164: string | null;
  readonly whatsappStatus: WhatsAppPresenceStatus;
  readonly whatsappUrl: string | null;
  readonly websiteStatus: WebsitePresenceStatus;
  readonly websiteUrl: string | null;
  readonly addressRaw: string | null;
  readonly isAddressHidden: boolean;
  readonly isServiceAreaBusiness: boolean; // Prestador que atende no local do cliente (SAB)
  readonly coordinates: {
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly claimedByOwner: boolean;
  readonly businessHoursConfigured: boolean;
  readonly attributesCount: number;
  readonly servicesListedCount: number;
  readonly descriptionText: string | null;
  readonly createdAt: string;
  /**
   * Origem dos campos (Fase 4). Opcional: leads antigos e leads relidos do banco não a possuem,
   * e nesse caso campos que o coletor nunca obteve (reivindicação, atributos, serviços) são
   * tratados como NÃO VERIFICADOS, nunca como comprovados.
   */
  readonly provenance?: LeadFieldProvenance;
}

export interface ProspectingOutput {
  readonly campaignId: string;
  readonly city: string;
  readonly stateCode: string;
  readonly nicheKeyword: string;
  readonly centerCoordinates: {
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly leads: readonly FrontierLead[]; // Exatamente 10 leads quentes de fronteira
  readonly executedAt: string;
}

/**
 * ----------------------------------------------------------------------------
 * 2. AGENTE 1: REPUTAÇÃO
 * ----------------------------------------------------------------------------
 */
export interface ReviewSample {
  readonly reviewId: string;
  readonly authorName: string;
  readonly rating: number;
  readonly publishedAt: string;
  readonly daysAgo: number;
  readonly textSnippet: string;
  readonly hasOwnerReply: boolean;
  readonly ownerReplyDaysDelay: number | null;
}

export interface ReputationMetrics {
  readonly placeId: string;
  readonly averageRating: number;
  readonly totalReviews: number;
  /** `null` quando a distribuição real não foi coletada (nunca estimada). */
  readonly starDistribution: {
    readonly fiveStar: number;
    readonly fourStar: number;
    readonly threeStar: number;
    readonly twoStar: number;
    readonly oneStar: number;
  } | null;
  /** 0 a 100, sobre a amostra coletada. `null` sem avaliações com resposta mensurável. */
  readonly ownerResponseRatePercent: number | null;
  readonly averageOwnerResponseHours: number | null;
  /** Novas avaliações em 30 dias. `null` quando não comprovado; veja `reviewsAnalysis`. */
  readonly interactionsLast30Days: number | null;
  readonly ownerRepliesLast30Days: number | null;
  readonly monthlyVelocityTarget: number;
  readonly velocityStatus: 'ACCELERATING' | 'STAGNANT' | 'CRITICAL_DORMANT' | 'NOT_VERIFIED';
  readonly recentReviewsSample: readonly ReviewSample[];
  readonly extractedAt: string;
  /** Fase 4: disponibilidade e limitações da coleta de avaliações datadas. */
  readonly reviewsAvailability?: {
    readonly state: 'FETCHED' | 'UNAVAILABLE';
    readonly provider: string | null;
    readonly reason: string | null;
    readonly collectedAt: string | null;
    readonly analysis: import('@/lib/serper-reviews').ReviewSampleAnalysis | null;
  };
}

/**
 * ----------------------------------------------------------------------------
 * 3. AGENTE 2: VITRINE
 * ----------------------------------------------------------------------------
 */
export interface MediaItemMetadata {
  readonly mediaId: string;
  readonly url: string;
  readonly mediaType: 'PHOTO' | 'VIDEO';
  readonly source: 'OWNER' | 'CUSTOMER';
  readonly categoryTag: 'EXTERIOR' | 'INTERIOR' | 'TEAM' | 'PRODUCT' | 'LOGO' | 'COVER' | 'GENERAL';
  readonly uploadedAt: string;
  readonly resolutionWidth: number;
  readonly resolutionHeight: number;
}

export interface GooglePostMetadata {
  readonly postId: string;
  readonly postType: 'UPDATE' | 'OFFER' | 'EVENT';
  readonly summaryText: string;
  readonly mediaUrl: string | null;
  readonly callToActionType: string | null;
  readonly publishedAt: string;
  readonly daysSincePublished: number;
}

export interface VitrineMetrics {
  readonly placeId: string;
  /** Os contadores são `null` quando não há fonte real: indisponível nunca vira 0 nem estimativa. */
  readonly totalPhotosCount: number | null;
  readonly ownerPhotosCount: number | null;
  readonly customerPhotosCount: number | null;
  readonly totalVideosCount: number | null;
  readonly hasCoverPhoto: boolean | null;
  readonly hasLogoPhoto: boolean | null;
  readonly lastMediaUploadedAt: string | null;
  readonly daysSinceLastMedia: number | null;
  readonly lastPostPublishedAt: string | null;
  readonly daysSinceLastPost: number | null;
  readonly totalActivePostsLast90Days: number | null;
  readonly latestPost: GooglePostMetadata | null;
  readonly mediaGallerySample: readonly MediaItemMetadata[];
  readonly extractedAt: string;
  /** Fase 4: o que foi (ou não) obtido de uma fonte real. */
  readonly availability?: {
    readonly state: 'FETCHED' | 'UNAVAILABLE';
    readonly provider: string | null;
    readonly reason: string | null;
    readonly collectedAt: string | null;
    /** Campos efetivamente fornecidos pela fonte (ex.: totalPhotosCount). */
    readonly fieldsProvided: readonly string[];
  };
}

/**
 * ----------------------------------------------------------------------------
 * 4. AGENTE 3: CAMPO DE BATALHA (MATRIZ 7x7 = 49 PONTOS & HISTÓRICO)
 * ----------------------------------------------------------------------------
 */
export type GridPointReadStatus = 'VALID' | 'UNREADABLE';

export type GridPointVisualTier =
  | 'GREEN_TOP3'       // Posições 1 a 3
  | 'YELLOW_TOP7'      // Posições 4 a 7
  | 'RED_8_TO_20'      // Posições 8 a 20
  | 'INVISIBLE'        // Posição > 20 (Não listado na 1ª página local do pino)
  | 'GRAY_UNREADABLE'; // Sem leitura após 3 tentativas de retry (Excluído da média, nunca "Err")

export interface GridPointCompetitorLeader {
  readonly placeId: string;
  readonly businessName: string;
  readonly primaryCategory: string;
  /** `null` quando o provedor não informou (nunca preenchido com valor padrão). */
  readonly rating: number | null;
  readonly totalReviews: number | null;
  readonly hasWebsite: boolean;
  readonly isDirectoryFiltered: boolean;
}

export interface BattlefieldGridPoint {
  readonly pointIndex: number; // 0..48
  readonly rowIndex: number;   // 0..6 (Norte -> Sul)
  readonly colIndex: number;   // 0..6 (Oeste -> Leste)
  readonly latitude: number;
  readonly longitude: number;
  readonly distanceFromCenterMeters: number;
  readonly readStatus: GridPointReadStatus;
  readonly attemptsMade: number; // 1..3
  readonly targetRank: number | null; // 1..20 quando encontrado; null quando invisível ou sem leitura
  readonly visualTier: GridPointVisualTier;
  readonly displayLabel: string; // Ex: "#2", "#6", "#14", ">20", "S/L" (Nunca "Err")
  readonly pointLeader: GridPointCompetitorLeader | null;
}

export interface BattlefieldHistoricalEvolution {
  readonly hasPreviousRound: boolean;
  readonly previousRoundId: string | null;
  readonly previousExecutedAt: string | null;
  readonly previousGreenTop3Count: number | null;
  readonly currentGreenTop3Count: number;
  readonly greenPointsDelta: number | null; // Ex: +8 (evolução de 3 para 11 pontos verdes)
  readonly previousAveragePosition: number | null;
  readonly currentAveragePosition: number;
  readonly averagePositionDelta: number | null; // Negativo = melhora de ranking
  readonly evolutionSummaryText: string;
  /** Fase 4: por que a rodada anterior não foi comparada, quando existe mas é incompatível. */
  readonly incompatibleReason?: string | null;
}

export interface BattlefieldMetrics {
  readonly roundId: string;
  readonly placeId: string;
  readonly pureKeyword: string; // Sem o nome da cidade para não corromper o raio
  readonly centerOfInterest: {
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly zoomLevel: string; // Ex: "15z"
  readonly stepMeters: number; // Distância entre pinos adjacentes (ex: 500m)
  readonly totalGridPoints: 49;
  readonly validPointsCount: number;
  readonly unreadablePointsCount: number; // Pontos cinzas excluídos do denominador
  readonly greenTop3Count: number;
  readonly yellowTop4To7Count: number;
  readonly redRank8To20Count: number;
  readonly invisibleCount: number;
  readonly averagePosition: number; // Calculada estritamente sobre pontos válidos
  readonly top3Percentage: number;  // (greenTop3Count / validPointsCount) * 100
  readonly top7Percentage: number;  // ((greenTop3Count + yellowTop4To7Count) / validPointsCount) * 100
  readonly invisibilityPercentage: number; // (invisibleCount / validPointsCount) * 100
  readonly points: readonly BattlefieldGridPoint[]; // Exatamente 49 itens
  readonly historicalEvolution: BattlefieldHistoricalEvolution;
  readonly executedAt: string;
  /** Fase 4: origem da medição e metodologia, para comparar rodadas somente quando compatíveis. */
  readonly dataOrigin?: 'COLLECTED' | 'SIMULATED';
  readonly methodVersion?: string;
  /** Mesma convenção de `averagePosition` (fora do Top 20 = 21), com nome honesto. */
  readonly rankIndexAverage?: number | null;
  /** Média apenas das posições efetivamente conhecidas (1 a 20). */
  readonly knownPositionAverage?: number | null;
  readonly knownPositionPointsCount?: number;
  readonly outsideTop20Count?: number;
  readonly top20Percentage?: number | null;
  /** Falhas de coleta por ponto, sem credenciais. */
  readonly providerFailures?: readonly import('@/lib/evidence/types').ProviderFailure[];
}

/**
 * ----------------------------------------------------------------------------
 * 5. AGENTE 4: RIVAIS (DOMINADORES REAIS DO TERRITÓRIO)
 * ----------------------------------------------------------------------------
 */
export interface TerritoryDominatorProfile {
  readonly rankPosition: 1 | 2 | 3;
  readonly placeId: string;
  readonly businessName: string;
  readonly primaryCategory: string;
  readonly pointsWonAsNumberOne: number; // Quantos pontos da grade 49 esse rival liderou em #1
  readonly dominanceSharePercent: number; // % de domínio sobre os pontos válidos
  readonly rating: number | null;
  readonly totalReviews: number | null;
  /** Fase 4: sem fonte real, estes campos são `null` (nunca estimados). */
  readonly estimatedReviewsLast30Days: number | null;
  readonly ownerResponseRatePercent: number | null;
  readonly totalPhotosCount: number | null;
  readonly hasOwnWebsite: boolean;
  readonly gapAnalysisVsTarget: {
    readonly reviewsGap: number | null;
    readonly ratingGap: number | null;
    readonly photosGap: number | null;
    readonly primaryAdvantageSummary: string;
  };
}

export interface RivalsMetrics {
  readonly placeId: string;
  readonly totalUniqueLeadersIdentified: number;
  readonly genericDirectoriesFilteredCount: number;
  readonly topDominators: readonly TerritoryDominatorProfile[];
  readonly competitiveGapHeadline: string;
  readonly extractedAt: string;
}

/**
 * ----------------------------------------------------------------------------
 * 6. AGENTE 5: JUIZ (CHECKLIST DE 21 ITENS COM REGRA DE CONTEXTO SAB)
 * ----------------------------------------------------------------------------
 */
export type JudgeCategoryKey =
  | 'IDENTITY_AND_NAP'
  | 'CATEGORIZATION_AND_SERVICES'
  | 'REPUTATION_AND_CONVERSION'
  | 'VITRINE_AND_CONTENT'
  | 'GEOGRAPHIC_AUTHORITY';

export type JudgeItemStatus =
  | 'PASS'
  | 'PARTIAL'
  | 'FAIL'
  | 'EXEMPT_BY_CONTEXT_RULE' // Regra de Exceção Crítica (ex: Endereço Oculto legítimo em SAB)
  | 'NOT_EVALUATED'; // Fase 4: sem evidência para pontuar (nem aprovado nem reprovado)

export interface JudgeChecklistItem {
  readonly itemNumber: number; // 1 a 21
  readonly code: string;
  readonly category: JudgeCategoryKey;
  readonly title: string;
  readonly status: JudgeItemStatus;
  /** 0 a 100. `null` (Fase 4) = sem base de pontuação: não é zero nem 100. */
  readonly scoreAwarded: number | null;
  readonly maxWeight: number;
  readonly isContextExceptionApplied: boolean;
  readonly evidenceObserved: string;
  readonly technicalRecommendation: string;
  /** Fase 4: status da evidência e fonte. `scoreAwarded` segue a metodologia histórica. */
  readonly evidence?: import('@/lib/evidence/types').AuditEvidence;
}

export interface JudgeCategoryScore {
  readonly category: JudgeCategoryKey;
  readonly categoryLabel: string;
  /** 0 a 100 sobre os critérios pontuados da categoria; `null` se nenhum foi pontuado. */
  readonly scorePercent: number | null;
  readonly passedItemsCount: number;
  readonly totalItemsCount: number;
}

export interface JudgeTechnicalSheet {
  readonly placeId: string;
  readonly overallScore: number; // 0 a 100
  readonly healthClassification: 'ELITE' | 'COMPETITIVE' | 'VULNERABLE' | 'CRITICAL_INVISIBLE' | 'INSUFFICIENT_EVIDENCE';
  readonly businessModelContext: {
    readonly isServiceAreaBusiness: boolean;
    readonly isAddressHidden: boolean;
    readonly addressExceptionRuleTriggered: boolean;
    readonly contextJustification: string;
  };
  readonly categoryScores: readonly JudgeCategoryScore[];
  readonly checklist21Items: readonly JudgeChecklistItem[]; // Exatamente 21 itens auditados
  readonly rawFactsRegistry: {
    readonly rating: number;
    readonly totalReviews: number;
    readonly ownerResponseRatePercent: number | null;
    readonly interactionsLast30Days: number | null;
    readonly totalPhotosCount: number | null;
    readonly customerPhotosCount: number | null;
    readonly totalVideosCount: number | null;
    readonly daysSinceLastMedia: number | null;
    readonly daysSinceLastPost: number | null;
    readonly validGridPoints: number;
    readonly unreadableGridPoints: number;
    readonly averageGridPosition: number;
    readonly top3Percentage: number;
    readonly top7Percentage: number;
    readonly invisibilityPercentage: number;
    readonly greenTop3Count: number;
    readonly topRivalName: string | null;
    readonly topRivalReviews: number | null;
    readonly topRivalPointsWon: number;
    readonly overallJudgeScore: number;
  };
  readonly evaluatedAt: string;
  /** Fase 4: indicadores separados (histórico x verificado x parcial x cobertura). */
  readonly scoreSummary?: import('@/lib/judge-scoring').JudgeScoreSummary;
  /**
   * Como `overallScore` foi calculado. Ausente em fichas anteriores à Fase 4 (Score Juiz histórico:
   * 21 critérios, denominador 102). `PHASE4_SCORED_WEIGHT` = pontuação recalculada só sobre os
   * critérios com pontuação (ver `scoreSummary`); não é comparável ao score histórico.
   */
  readonly scoreMethod?: 'PHASE4_SCORED_WEIGHT';
  readonly evidenceBundle?: import('@/lib/evidence/types').EvidenceBundle;
}

/**
 * ----------------------------------------------------------------------------
 * 7. AGENTE 6: ESTRATEGISTA (DIAGNÓSTICO E PLANO TÁTICO ONDAS P0–P3)
 * ----------------------------------------------------------------------------
 */
export type TacticalWavePriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface TacticalWaveAction {
  readonly actionCode: string;
  readonly title: string;
  readonly technicalInstruction: string;
  readonly expectedImpact: string;
  readonly effortLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Fase 4: recomendação ancorada em evidência (todos os campos abaixo são opcionais). */
  readonly classification?: 'PROVEN_ACTION' | 'HYPOTHESIS' | 'NOT_APPLICABLE';
  /** Problema ou oportunidade identificada. */
  readonly problem?: string;
  /** O que foi observado e de qual critério/fonte vem. */
  readonly evidenceSummary?: string;
  readonly justification?: string;
  readonly evidenceCriteria?: readonly number[];
  readonly priority?: string;
  readonly timeframe?: string;
  readonly indicator?: string;
  /** 0 a 1. */
  readonly confidence?: number;
}

export interface TacticalWavePlan {
  readonly wave: TacticalWavePriority;
  readonly waveTitle: string;
  readonly timeframeLabel: string; // P0 (0-7d), P1 (8-30d), P2 (31-60d), P3 (61-90d)
  readonly objective: string;
  readonly actions: readonly TacticalWaveAction[];
}

export interface StrategistOutput {
  readonly placeId: string;
  readonly revisionAttempt: number;
  readonly executiveSummary: string;
  readonly diagnosticNarrative: string;
  readonly territoryOpportunityNarrative: string;
  readonly citedMetricsSnapshot: {
    readonly rating: number;
    readonly totalReviews: number;
    readonly ownerResponseRatePercent: number | null;
    readonly interactionsLast30Days: number | null;
    readonly totalPhotosCount: number | null;
    readonly averageGridPosition: number;
    readonly top3Percentage: number;
    readonly top7Percentage: number;
    readonly invisibilityPercentage: number;
    readonly overallJudgeScore: number;
  };
  readonly tacticalWaves: readonly [
    TacticalWavePlan, // P0
    TacticalWavePlan, // P1
    TacticalWavePlan, // P2
    TacticalWavePlan  // P3
  ];
  /** Fase 4: critérios já atendidos que o plano apenas recomenda manter. */
  readonly maintainNotes?: readonly string[];
  readonly generatedAt: string;
}

/**
 * ----------------------------------------------------------------------------
 * 8. AGENTE 7: REVISOR (AUDITORIA MATEMÁTICA CONTRA A FICHA BRUTA)
 * ----------------------------------------------------------------------------
 */
export interface MathematicalDiscrepancy {
  readonly metricField: string;
  readonly expectedRawValue: number;
  readonly foundInStrategistOutput: number;
  readonly locationContext: 'CITED_SNAPSHOT' | 'EXECUTIVE_TEXT' | 'DIAGNOSTIC_TEXT' | 'TACTICAL_WAVE';
  readonly correctionDirective: string;
}

export interface ReviewerAuditResult {
  readonly approved: boolean;
  readonly iterationNumber: number;
  readonly totalChecksPerformed: number;
  readonly discrepancies: readonly MathematicalDiscrepancy[];
  readonly auditTimestamp: string;
}

/**
 * ----------------------------------------------------------------------------
 * 9. AGENTE 8: DIAGRAMADOR & DOSSIÊ COMPLETO DO MAESTRO
 * ----------------------------------------------------------------------------
 */
export interface DiagrammerOutput {
  readonly auditId: string;
  readonly pdfFileName: string;
  readonly pdfStoragePath: string;
  readonly pdfDownloadUrl: string;
  readonly pageCount: number;
  readonly fileSizeBytes: number;
  /** Quando o PDF foi gerado (distinto da data de coleta). */
  readonly generatedAt: string;
  /** Data da coleta territorial que originou o relatório (opcional: PDFs antigos não têm). */
  readonly dataCollectedAt?: string;
  /** Cobertura de evidências verificadas dos 21 critérios do Juiz (opcional). */
  readonly evidenceCoverage?: {
    readonly verifiedCriteria: number;
    readonly totalCriteria: number;
    readonly verifiedWeightPercent: number;
  };
}

export interface CompleteAuditDossier {
  readonly auditId: string;
  readonly lead: FrontierLead;
  readonly targetKeyword: string;
  readonly status: AuditPipelineStage;
  readonly progressPercent: number;
  readonly currentAgent: AgentName;
  readonly reputation: ReputationMetrics;
  readonly vitrine: VitrineMetrics;
  readonly battlefield: BattlefieldMetrics;
  readonly rivals: RivalsMetrics;
  readonly judge: JudgeTechnicalSheet;
  readonly strategist: StrategistOutput;
  readonly reviewerLogs: readonly ReviewerAuditResult[];
  readonly diagrammer: DiagrammerOutput;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface BullMQAuditJobPayload {
  readonly auditId: string;
  readonly lead: FrontierLead;
  readonly targetKeyword: string;
  readonly interestCenter: {
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly gridZoom: string;
  readonly gridStepMeters: number;
  /** Retomada explícita: reaproveita Reputação, Vitrine e Battlefield já persistidos (sem novas consultas pagas). */
  readonly resume?: boolean;
}
