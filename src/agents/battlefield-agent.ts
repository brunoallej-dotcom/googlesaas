import { randomUUID } from 'crypto';
import type {
  BattlefieldGridPoint,
  BattlefieldHistoricalEvolution,
  BattlefieldMetrics,
  FrontierLead,
  GridPointCompetitorLeader,
  GridPointVisualTier,
} from '@/types/gmn';
import { executeWithRetry, mapWithConcurrency } from '@/lib/resilience';
import { StructuredLogger } from '@/lib/logger';
import { gmnRepository } from '@/lib/supabase';
import { computeTerritoryRankMetrics } from '@/lib/battlefield-metrics';
import { BATTLEFIELD_METHOD_VERSION, isDemoMode } from '@/lib/evidence/types';
import type { ProviderFailure } from '@/lib/evidence/types';
import { selectCompatibleRound, type CurrentRoundParams } from '@/lib/history-compat';

interface CoordinateNode {
  readonly pointIndex: number;
  readonly rowIndex: number;
  readonly colIndex: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly distanceFromCenterMeters: number;
}

interface DataForSeoMapsRankItem {
  readonly place_id?: string;
  readonly cid?: string;
  readonly title?: string;
  readonly category?: string;
  readonly rank_group?: number;
  readonly rank_absolute?: number;
  readonly rating?: {
    readonly value?: number;
    readonly votes_count?: number;
  };
  readonly url?: string;
}

type SearchProvider = 'SERPER' | 'DATAFORSEO' | 'NONE';

interface SerperMapsGridItem {
  readonly position?: number;
  readonly placeId?: string;
  readonly cid?: string;
  readonly title?: string;
  readonly type?: string;
  readonly rating?: number;
  readonly ratingCount?: number;
  readonly website?: string;
}

const GENERIC_DIRECTORY_NAME_PATTERNS: readonly RegExp[] = [
  /guiamais/i,
  /solutudo/i,
  /apontador/i,
  /telelistas/i,
  /doctoralia/i,
  /getninjas/i,
  /lista\s+telef[oô]nica/i,
];

/**
 * ============================================================================
 * AGENTE 3: CAMPO DE BATALHA (MATRIZ 7x7 = 49 PONTOS COM SERPER.DEV / DATAFORSEO)
 * ============================================================================
 */
export class BattlefieldAgent {
  private readonly logger = new StructuredLogger('BATTLEFIELD');

  public sanitizePureKeyword(rawKeyword: string, cityToStrip: string): string {
    const escapedCity = cityToStrip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regexCity = new RegExp(`\\b(em|de|na|no)?\\s*${escapedCity}\\b`, 'gi');
    const cleaned = rawKeyword
      .replace(regexCity, '')
      .replace(/\s+-\s+[A-Z]{2}\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    return cleaned.length > 0 ? cleaned : rawKeyword.trim();
  }

  public build49PointMatrix(
    centerLat: number,
    centerLng: number,
    stepMeters: number
  ): readonly CoordinateNode[] {
    const earthRadiusMeters = 6378137;
    const nodes: CoordinateNode[] = [];
    let pointIndex = 0;

    for (let rowOffset = -3; rowOffset <= 3; rowOffset++) {
      for (let colOffset = -3; colOffset <= 3; colOffset++) {
        const northMeters = -rowOffset * stepMeters;
        const eastMeters = colOffset * stepMeters;

        const dLat = (northMeters / earthRadiusMeters) * (180 / Math.PI);
        const dLng =
          (eastMeters / (earthRadiusMeters * Math.cos((Math.PI * centerLat) / 180))) *
          (180 / Math.PI);

        const latitude = Number((centerLat + dLat).toFixed(6));
        const longitude = Number((centerLng + dLng).toFixed(6));
        const distanceFromCenterMeters = Number(
          Math.sqrt(northMeters * northMeters + eastMeters * eastMeters).toFixed(1)
        );

        nodes.push({
          pointIndex,
          rowIndex: rowOffset + 3,
          colIndex: colOffset + 3,
          latitude,
          longitude,
          distanceFromCenterMeters,
        });
        pointIndex += 1;
      }
    }

    return nodes;
  }

  public async executeBattlefieldGrid(params: {
    readonly auditId: string;
    readonly lead: FrontierLead;
    readonly rawKeyword: string;
    readonly city: string;
    readonly interestCenter?: { readonly latitude: number; readonly longitude: number };
    readonly zoomLevel?: string;
    readonly stepMeters?: number;
  }): Promise<BattlefieldMetrics> {
    const roundId = randomUUID();
    const zoomLevel = params.zoomLevel ?? process.env.BATTLEFIELD_DEFAULT_ZOOM ?? '15z';
    const stepMeters =
      params.stepMeters ?? Number(process.env.BATTLEFIELD_STEP_METERS ?? '500');
    const concurrencyLimit = Number(process.env.BATTLEFIELD_CONCURRENCY ?? '7');
    const centerOfInterest = params.interestCenter ?? params.lead.coordinates;

    const pureKeyword = this.sanitizePureKeyword(params.rawKeyword, params.city);
    const matrixNodes = this.build49PointMatrix(
      centerOfInterest.latitude,
      centerOfInterest.longitude,
      stepMeters
    );

    this.logger.info('Iniciando varredura Campo de Batalha (49 pontos com palavra-chave pura)', {
      auditId: params.auditId,
      roundId,
      targetPlaceId: params.lead.placeId,
      pureKeyword,
      centerOfInterest,
      zoomLevel,
      stepMeters,
    });

    const provider = this.detectProvider();
    const demo = isDemoMode();
    const providerFailures: ProviderFailure[] = [];
    const pointErrors: string[] = [];
    const simulatedRun = provider === 'NONE' && demo;

    let evaluatedPoints: readonly BattlefieldGridPoint[];
    if (provider === 'NONE' && !demo) {
      // Sem provedor de busca não há medição: nada é inventado e nenhuma chamada é tentada.
      const reason =
        'Nenhum provedor de busca territorial está configurado (SERPER_API_KEY ausente ou inválida).';
      providerFailures.push({
        provider: 'Serper.dev (Google Maps)',
        operation: 'busca territorial por coordenada',
        reason,
        at: new Date().toISOString(),
      });
      this.logger.error('Campo de Batalha sem provedor: pontos marcados como sem leitura', {
        auditId: params.auditId,
        reason,
      });
      evaluatedPoints = matrixNodes.map((node) => this.unreadablePoint(node, 1));
    } else {
      if (simulatedRun) {
        this.logger.warn('MODO DEMONSTRAÇÃO: medição territorial SIMULADA, não representa a empresa real', {
          auditId: params.auditId,
        });
      }
      evaluatedPoints = await mapWithConcurrency(matrixNodes, concurrencyLimit, async (node) =>
        this.evaluateSingleGridPoint(node, params.lead, pureKeyword, zoomLevel, params.auditId, pointErrors)
      );
      if (pointErrors.length > 0) {
        const grouped = new Map<string, number>();
        for (const message of pointErrors) grouped.set(message, (grouped.get(message) ?? 0) + 1);
        for (const [reason, occurrences] of grouped) {
          providerFailures.push({
            provider: provider === 'DATAFORSEO' ? 'DataForSEO (Maps)' : 'Serper.dev (Google Maps)',
            operation: 'busca territorial por coordenada',
            reason: `${reason} (${occurrences} ponto${occurrences === 1 ? '' : 's'})`,
            at: new Date().toISOString(),
          });
        }
      }
    }

    const rank = computeTerritoryRankMetrics(evaluatedPoints);
    const validPoints = evaluatedPoints.filter((pt) => pt.readStatus === 'VALID');
    const unreadablePointsCount = rank.unreadablePoints;
    const validPointsCount = rank.validPoints;

    const greenTop3Count = validPoints.filter((pt) => pt.visualTier === 'GREEN_TOP3').length;
    const yellowTop4To7Count = validPoints.filter(
      (pt) => pt.visualTier === 'YELLOW_TOP7'
    ).length;
    const redRank8To20Count = validPoints.filter(
      (pt) => pt.visualTier === 'RED_8_TO_20'
    ).length;
    const invisibleCount = validPoints.filter((pt) => pt.visualTier === 'INVISIBLE').length;

    // `averagePosition` mantém a convenção histórica (fora do Top 20 = 21): é um ÍNDICE, e a
    // média das posições realmente conhecidas é informada à parte em `knownPositionAverage`.
    const averagePosition = rank.rankIndexAverage ?? 0;
    const top3Percentage = rank.top3Percent ?? 0;
    const top7Percentage = rank.top7Percent ?? 0;
    const invisibilityPercentage = rank.outsideTop20Percent ?? 0;

    const executedAt = new Date().toISOString();
    const currentRound: CurrentRoundParams = {
      executedAt,
      centerLat: centerOfInterest.latitude,
      centerLng: centerOfInterest.longitude,
      zoomLevel,
      stepMeters,
      validPointsCount,
    };
    // Só compara com rodadas compatíveis (mesma grade, cobertura e dados reais).
    const candidates = await gmnRepository.getBattlefieldRoundCandidates(
      params.lead.placeId,
      pureKeyword
    );
    const selection = simulatedRun
      ? { round: null, incompatibleReason: 'A rodada atual usa dados simulados.' }
      : selectCompatibleRound(candidates, currentRound);

    const historicalEvolution = this.computeHistoricalEvolution(
      selection.round
        ? {
            roundId: selection.round.roundId,
            executedAt: selection.round.executedAt,
            greenTop3Count: selection.round.greenTop3Count,
            averagePosition: selection.round.averagePosition,
          }
        : null,
      greenTop3Count,
      averagePosition,
      selection.incompatibleReason
    );

    const metrics: BattlefieldMetrics = {
      roundId,
      placeId: params.lead.placeId,
      pureKeyword,
      centerOfInterest,
      zoomLevel,
      stepMeters,
      totalGridPoints: 49,
      validPointsCount,
      unreadablePointsCount,
      greenTop3Count,
      yellowTop4To7Count,
      redRank8To20Count,
      invisibleCount,
      averagePosition,
      top3Percentage,
      top7Percentage,
      invisibilityPercentage,
      points: evaluatedPoints,
      historicalEvolution,
      executedAt,
      dataOrigin: simulatedRun ? 'SIMULATED' : 'COLLECTED',
      methodVersion: BATTLEFIELD_METHOD_VERSION,
      rankIndexAverage: rank.rankIndexAverage,
      knownPositionAverage: rank.knownPositionAverage,
      knownPositionPointsCount: rank.knownPositionPoints,
      outsideTop20Count: rank.outsideTop20Points,
      top20Percentage: rank.top20Percent,
      providerFailures,
    };

    await gmnRepository.saveBattlefieldRound(params.auditId, params.lead.id, metrics);

    return metrics;
  }

  private unreadablePoint(node: CoordinateNode, attemptsMade: number): BattlefieldGridPoint {
    return {
      pointIndex: node.pointIndex,
      rowIndex: node.rowIndex,
      colIndex: node.colIndex,
      latitude: node.latitude,
      longitude: node.longitude,
      distanceFromCenterMeters: node.distanceFromCenterMeters,
      readStatus: 'UNREADABLE',
      attemptsMade,
      targetRank: null,
      visualTier: 'GRAY_UNREADABLE',
      displayLabel: 'S/L',
      pointLeader: null,
    };
  }

  private detectProvider(): SearchProvider {
    const serperApiKey = process.env.SERPER_API_KEY;
    if (serperApiKey && serperApiKey.trim().length > 10 && !serperApiKey.includes('cole-sua-api-key')) {
      return 'SERPER';
    }
    const login = process.env.DATAFORSEO_LOGIN;
    const password = process.env.DATAFORSEO_PASSWORD;
    if (login && password && !login.includes('your-dataforseo-login')) return 'DATAFORSEO';
    return 'NONE';
  }

  private async evaluateSingleGridPoint(
    node: CoordinateNode,
    targetLead: FrontierLead,
    pureKeyword: string,
    zoomLevel: string,
    auditId: string,
    errorSink: string[]
  ): Promise<BattlefieldGridPoint> {
    const maxRetries = Number(process.env.BATTLEFIELD_POINT_RETRIES ?? '3');

    const retryExecution = await executeWithRetry(
      async (attempt) => {
        return await this.queryMapsAtCoordinate(
          node,
          targetLead,
          pureKeyword,
          zoomLevel,
          attempt
        );
      },
      {
        maxAttempts: maxRetries,
        baseDelayMs: 350,
        maxDelayMs: 2000,
        timeoutMs: 9000,
        operationName: `Battlefield_Point_${node.pointIndex}_(${node.latitude},${node.longitude})`,
        agent: 'BATTLEFIELD',
        correlationId: auditId,
      }
    );

    if (!retryExecution.success || !retryExecution.data) {
      // Falha de coleta nunca vira posição: o ponto fica sem leitura e fora das médias.
      errorSink.push(retryExecution.lastError ?? 'Falha desconhecida na consulta.');
      return this.unreadablePoint(node, retryExecution.attemptsMade);
    }

    const { targetRank, pointLeader } = retryExecution.data;
    const visualTier = this.classifyVisualTier(targetRank);
    const displayLabel =
      targetRank !== null && targetRank <= 20 ? `#${targetRank}` : '>20';

    return {
      pointIndex: node.pointIndex,
      rowIndex: node.rowIndex,
      colIndex: node.colIndex,
      latitude: node.latitude,
      longitude: node.longitude,
      distanceFromCenterMeters: node.distanceFromCenterMeters,
      readStatus: 'VALID',
      attemptsMade: retryExecution.attemptsMade,
      targetRank: targetRank !== null && targetRank <= 20 ? targetRank : null,
      visualTier,
      displayLabel,
      pointLeader,
    };
  }

  private classifyVisualTier(targetRank: number | null): GridPointVisualTier {
    if (targetRank === null || targetRank > 20) {
      return 'INVISIBLE';
    }
    if (targetRank <= 3) {
      return 'GREEN_TOP3';
    }
    if (targetRank <= 7) {
      return 'YELLOW_TOP7';
    }
    return 'RED_8_TO_20';
  }

  private async queryMapsAtCoordinate(
    node: CoordinateNode,
    targetLead: FrontierLead,
    pureKeyword: string,
    zoomLevel: string,
    _attempt: number
  ): Promise<{
    targetRank: number | null;
    pointLeader: GridPointCompetitorLeader | null;
  }> {
    const serperApiKey = process.env.SERPER_API_KEY;
    const serperUrl = process.env.SERPER_MAPS_URL ?? 'https://google.serper.dev/maps';

    // 1. Provedor Primário: Serper.dev Google Maps API (Coordenada + Zoom Fixo + Palavra-chave Pura)
    if (
      serperApiKey &&
      serperApiKey.trim().length > 10 &&
      !serperApiKey.includes('cole-sua-api-key')
    ) {
      const response = await fetch(serperUrl, {
        method: 'POST',
        headers: {
          'X-API-KEY': serperApiKey.trim(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: pureKeyword, // Palavra-chave PURA (sem o nome da cidade)
          ll: `@${node.latitude},${node.longitude},${zoomLevel}`,
          gl: 'br',
          hl: 'pt-br',
        }),
      });

      if (!response.ok) {
        throw new Error(`Serper.dev Maps Point HTTP ${response.status}`);
      }

      const payload = (await response.json()) as { places?: SerperMapsGridItem[] };
      const places = payload.places ?? [];

      if (places.length === 0) {
        throw new Error('Pino Serper.dev sem resposta de estabelecimentos');
      }

      // Localização estrita pelo ID do perfil (placeId ou cid) — NUNCA pelo nome!
      let targetRank: number | null = null;
      for (let i = 0; i < places.length; i++) {
        const item = places[i]!;
        const matchesPlaceId = Boolean(item.placeId && item.placeId === targetLead.placeId);
        const matchesCid = Boolean(
          targetLead.cid && item.cid && String(item.cid) === String(targetLead.cid)
        );
        if (matchesPlaceId || matchesCid) {
          targetRank = item.position ?? i + 1;
          break;
        }
      }

      // Identifica o líder #1 do ponto ignorando diretórios genéricos
      let pointLeader: GridPointCompetitorLeader | null = null;
      for (const candidate of places) {
        const title = candidate.title ?? '';
        const isGenericDirectory = GENERIC_DIRECTORY_NAME_PATTERNS.some((rx) => rx.test(title));
        const candidateId = candidate.placeId ?? candidate.cid;
        if (!isGenericDirectory && candidateId) {
          pointLeader = {
            placeId: candidateId,
            businessName: title || 'Concorrente Local #1',
            primaryCategory: candidate.type ?? targetLead.primaryCategory,
            rating: typeof candidate.rating === 'number' ? Number(candidate.rating.toFixed(2)) : null,
            totalReviews: typeof candidate.ratingCount === 'number' ? candidate.ratingCount : null,
            hasWebsite: Boolean(candidate.website),
            isDirectoryFiltered: false,
          };
          break;
        }
      }

      return { targetRank, pointLeader };
    }

    // 2. Provedor Secundário: DataForSEO Maps API
    const login = process.env.DATAFORSEO_LOGIN;
    const password = process.env.DATAFORSEO_PASSWORD;
    const baseUrl = process.env.DATAFORSEO_BASE_URL ?? 'https://api.dataforseo.com/v3';

    if (login && password && !login.includes('your-dataforseo-login')) {
      const authHeader = Buffer.from(`${login}:${password}`).toString('base64');
      const response = await fetch(`${baseUrl}/serp/google/maps/live/advanced`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          {
            keyword: pureKeyword,
            location_coordinate: `${node.latitude},${node.longitude},${zoomLevel}`,
            language_code: 'pt-BR',
            depth: 20,
          },
        ]),
      });

      if (!response.ok) {
        throw new Error(`DataForSEO Maps Point HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        tasks?: Array<{
          result?: Array<{
            items?: DataForSeoMapsRankItem[];
          }>;
        }>;
      };

      const items = payload.tasks?.[0]?.result?.[0]?.items ?? [];
      if (items.length === 0) {
        throw new Error('Pino sem resposta SERP Maps');
      }

      let targetRank: number | null = null;
      for (const item of items) {
        const matchesPlaceId = Boolean(item.place_id && item.place_id === targetLead.placeId);
        const matchesCid = Boolean(
          targetLead.cid && item.cid && String(item.cid) === String(targetLead.cid)
        );
        if (matchesPlaceId || matchesCid) {
          targetRank = item.rank_group ?? item.rank_absolute ?? null;
          break;
        }
      }

      let pointLeader: GridPointCompetitorLeader | null = null;
      for (const candidate of items) {
        const title = candidate.title ?? '';
        const isGenericDirectory = GENERIC_DIRECTORY_NAME_PATTERNS.some((rx) => rx.test(title));
        if (!isGenericDirectory && candidate.place_id) {
          pointLeader = {
            placeId: candidate.place_id,
            businessName: title || 'Concorrente Local #1',
            primaryCategory: candidate.category ?? targetLead.primaryCategory,
            rating: typeof candidate.rating?.value === 'number' ? Number(candidate.rating.value.toFixed(2)) : null,
            totalReviews: typeof candidate.rating?.votes_count === 'number' ? candidate.rating.votes_count : null,
            hasWebsite: Boolean(candidate.url),
            isDirectoryFiltered: false,
          };
          break;
        }
      }

      return { targetRank, pointLeader };
    }

    // 3. Modo demonstração (somente com GMN_DEMO_MODE=true): resultado SIMULADO, nunca real.
    if (!isDemoMode()) {
      throw new Error('Nenhum provedor de busca territorial configurado.');
    }
    if (node.pointIndex === 6 || node.pointIndex === 42) {
      throw new Error('Timeout de socket simulado na malha de proxy geográfico');
    }

    const manhattanDist = Math.abs(node.rowIndex - 3) + Math.abs(node.colIndex - 3);
    let targetRank: number | null;

    if (manhattanDist === 0) {
      targetRank = 2;
    } else if (manhattanDist === 1) {
      targetRank = node.colIndex >= 3 ? 3 : 5;
    } else if (manhattanDist === 2) {
      targetRank = node.rowIndex <= 3 ? 6 : 11;
    } else if (manhattanDist === 3) {
      targetRank = node.pointIndex % 2 === 0 ? 14 : 19;
    } else {
      targetRank = null;
    }

    const rivalPool: readonly GridPointCompetitorLeader[] = [
      {
        placeId: `ChIJ_RIVAL_DOMINATOR_ALPHA`,
        businessName: `${targetLead.primaryCategory} Alpha Prime Center`,
        primaryCategory: targetLead.primaryCategory,
        rating: 4.9,
        totalReviews: 248,
        hasWebsite: true,
        isDirectoryFiltered: false,
      },
      {
        placeId: `ChIJ_RIVAL_DOMINATOR_BETA`,
        businessName: `Instituto Master de ${targetLead.primaryCategory}`,
        primaryCategory: targetLead.primaryCategory,
        rating: 4.8,
        totalReviews: 174,
        hasWebsite: true,
        isDirectoryFiltered: false,
      },
      {
        placeId: `ChIJ_RIVAL_DOMINATOR_GAMMA`,
        businessName: `${targetLead.primaryCategory} Referência Regional`,
        primaryCategory: targetLead.primaryCategory,
        rating: 4.7,
        totalReviews: 119,
        hasWebsite: false,
        isDirectoryFiltered: false,
      },
    ];

    const pointLeader =
      node.rowIndex <= 2
        ? rivalPool[0]!
        : node.colIndex <= 2
          ? rivalPool[1]!
          : rivalPool[2]!;

    return { targetRank, pointLeader };
  }

  /**
   * Evolução em relação à rodada anterior REAL (mesma empresa e palavra-chave).
   * Sem rodada anterior não há o que comparar: nada é estimado nem inventado.
   */
  public computeHistoricalEvolution(
    previousRound: {
      roundId: string;
      executedAt: string;
      greenTop3Count: number;
      averagePosition: number;
    } | null,
    currentGreenTop3Count: number,
    currentAveragePosition: number,
    incompatibleReason: string | null = null
  ): BattlefieldHistoricalEvolution {
    if (!previousRound) {
      return {
        incompatibleReason,
        hasPreviousRound: false,
        previousRoundId: null,
        previousExecutedAt: null,
        previousGreenTop3Count: null,
        currentGreenTop3Count,
        greenPointsDelta: null,
        previousAveragePosition: null,
        currentAveragePosition,
        averagePositionDelta: null,
        evolutionSummaryText: incompatibleReason
          ? `Existe medição anterior, mas ela não é comparável com a atual: ${incompatibleReason} Por isso nenhuma evolução foi calculada.`
          : 'Esta é a primeira medição do Campo de Batalha para esta empresa e palavra-chave, então ainda não há rodada anterior para comparar. A evolução aparecerá a partir da próxima auditoria com a mesma palavra-chave e a mesma grade.',
      };
    }

    const greenPointsDelta = currentGreenTop3Count - previousRound.greenTop3Count;
    const averagePositionDelta = Number(
      (currentAveragePosition - previousRound.averagePosition).toFixed(2)
    );

    return {
      hasPreviousRound: true,
      previousRoundId: previousRound.roundId,
      previousExecutedAt: previousRound.executedAt,
      previousGreenTop3Count: previousRound.greenTop3Count,
      currentGreenTop3Count,
      greenPointsDelta,
      previousAveragePosition: previousRound.averagePosition,
      currentAveragePosition,
      averagePositionDelta,
      evolutionSummaryText: `Evolução histórica de ${previousRound.greenTop3Count} para ${currentGreenTop3Count} pontos verdes (Top 3) na grade de 49 coordenadas (${greenPointsDelta >= 0 ? `+${greenPointsDelta}` : greenPointsDelta} pontos).`,
    };
  }
}

export const battlefieldAgent = new BattlefieldAgent();
