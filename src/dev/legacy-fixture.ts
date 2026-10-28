/**
 * ============================================================================
 * FIXTURES DE TESTE NO FORMATO ANTERIOR À FASE 4. NÃO SÃO RESULTADOS DE AUDITORIA.
 *
 * Reproduzem o que a plataforma gravava antes da Fase 4 (avaliações e vitrine simuladas, Juiz sem
 * evidência, Estrategista com ações fixas). Servem para testar que auditorias históricas continuam
 * legíveis, sem serem promovidas a "verificadas", e que o score histórico é preservado.
 * ============================================================================
 */
import type {
  BattlefieldMetrics,
  FrontierLead,
  JudgeCategoryScore,
  JudgeChecklistItem,
  JudgeTechnicalSheet,
  ReputationMetrics,
  ReviewSample,
  RivalsMetrics,
  StrategistOutput,
  VitrineMetrics,
} from '@/types/gmn';
import { vitrineAgent } from '@/agents/vitrine-agent';

const DAY = 24 * 60 * 60 * 1000;

export function legacyReputation(lead: FrontierLead): ReputationMetrics {
  const now = Date.now();
  const days = [4, 11, 19, 27, 38, 49, 64, 78, 92, 115];
  const authors = ['Carlos Eduardo M.', 'Fernanda Peixoto', 'Marcos Vinícius S.', 'Juliana Borges', 'Roberto Alencar', 'Patrícia Gomes', 'Henrique Teixeira', 'Camila Rocha', 'André Luiz F.', 'Luciana Martins'];
  const sample: ReviewSample[] = days.map((daysAgo, index) => {
    const hasOwnerReply = index % 3 === 0;
    return {
      reviewId: `rev_${lead.placeId}_${index + 1}`,
      authorName: authors[index] ?? `Cliente #${index + 1}`,
      rating: index === 3 ? 3 : index === 7 ? 4 : 5,
      publishedAt: new Date(now - daysAgo * DAY).toISOString(),
      daysAgo,
      textSnippet: 'Atendimento de teste (fixture legada).',
      hasOwnerReply,
      ownerReplyDaysDelay: hasOwnerReply ? Number((1.5 + index * 0.4).toFixed(1)) : null,
    };
  });
  const replied = sample.filter((r) => r.hasOwnerReply).length;
  const last30 = sample.filter((r) => r.daysAgo <= 30).length;
  return {
    placeId: lead.placeId,
    averageRating: lead.rating,
    totalReviews: lead.totalReviews,
    starDistribution: { fiveStar: 27, fourStar: 6, threeStar: 3, twoStar: 2, oneStar: 1 },
    ownerResponseRatePercent: Number(((replied / sample.length) * 100).toFixed(1)),
    averageOwnerResponseHours: 40,
    interactionsLast30Days: last30,
    ownerRepliesLast30Days: 1,
    monthlyVelocityTarget: 12,
    velocityStatus: last30 >= 8 ? 'ACCELERATING' : last30 >= 3 ? 'STAGNANT' : 'CRITICAL_DORMANT',
    recentReviewsSample: sample.slice(0, 6),
    extractedAt: new Date(now).toISOString(),
  };
}

export function legacyVitrine(lead: FrontierLead): VitrineMetrics {
  const demo = vitrineAgent.buildDeterministicVitrinePayload(lead);
  const photos = demo.mediaGallery.filter((m) => m.mediaType === 'PHOTO');
  const sorted = [...demo.mediaGallery].sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  return {
    placeId: lead.placeId,
    totalPhotosCount: photos.length,
    ownerPhotosCount: photos.filter((m) => m.source === 'OWNER').length,
    customerPhotosCount: photos.filter((m) => m.source === 'CUSTOMER').length,
    totalVideosCount: demo.mediaGallery.filter((m) => m.mediaType === 'VIDEO').length,
    hasCoverPhoto: true,
    hasLogoPhoto: true,
    lastMediaUploadedAt: sorted[0]?.uploadedAt ?? null,
    daysSinceLastMedia: 39,
    lastPostPublishedAt: demo.latestPost?.publishedAt ?? null,
    daysSinceLastPost: demo.latestPost?.daysSincePublished ?? null,
    totalActivePostsLast90Days: demo.totalActivePostsLast90Days,
    latestPost: demo.latestPost,
    mediaGallerySample: sorted.slice(0, 8),
    extractedAt: new Date().toISOString(),
  };
}

const CATEGORY_LABELS = {
  IDENTITY_AND_NAP: '1. Identidade, NAP & Conformidade',
  CATEGORIZATION_AND_SERVICES: '2. Categorização, Serviços & Atributos',
  REPUTATION_AND_CONVERSION: '3. Reputação, Velocidade & Conversão',
  VITRINE_AND_CONTENT: '4. Vitrine Visual & Google Posts',
  GEOGRAPHIC_AUTHORITY: '5. Autoridade Geográfica (Grade 49 Pontos)',
} as const;

type Band = readonly [number, number, number];
const bandItem = (value: number, high: number, mid: number, scores: Band): { status: JudgeChecklistItem['status']; score: number } =>
  value >= high ? { status: 'PASS', score: scores[0] } : value >= mid ? { status: 'PARTIAL', score: scores[1] } : { status: 'FAIL', score: scores[2] };

/** Ficha do Juiz no formato anterior à Fase 4: pontuação para todos os critérios, sem evidência. */
export function legacyJudge(params: {
  lead: FrontierLead;
  reputation: ReputationMetrics;
  vitrine: VitrineMetrics;
  battlefield: BattlefieldMetrics;
  rivals: RivalsMetrics;
}): JudgeTechnicalSheet {
  const { lead, reputation, vitrine, battlefield, rivals } = params;
  const topRivalReviews = rivals.topDominators[0]?.totalReviews ?? 150;
  const hasKeywordInName = lead.businessName.toLowerCase().includes(lead.primaryCategory.toLowerCase().split(' ')[0] ?? '');
  const addressHidden = lead.isAddressHidden;
  const rate = reputation.ownerResponseRatePercent ?? 0;
  const n30 = reputation.interactionsLast30Days ?? 0;
  const photos = vitrine.totalPhotosCount ?? 0;
  const videos = vitrine.totalVideosCount ?? 0;

  const r = (itemNumber: number, code: string, category: JudgeChecklistItem['category'], title: string, w: number, status: JudgeChecklistItem['status'], score: number, observed: string): JudgeChecklistItem => ({
    itemNumber, code, category, title, status, scoreAwarded: score, maxWeight: w, isContextExceptionApplied: false, evidenceObserved: observed,
    technicalRecommendation: 'Recomendação fixa do formato anterior (fixture).',
  });

  const rating = bandItem(reputation.averageRating, 4.6, 4.2, [100, 65, 25]);
  const volume = reputation.totalReviews >= topRivalReviews * 0.7 ? { status: 'PASS' as const, score: 100 } : reputation.totalReviews >= topRivalReviews * 0.25 ? { status: 'PARTIAL' as const, score: 45 } : { status: 'FAIL' as const, score: 15 };
  const velocity = bandItem(n30, 8, 3, [100, 55, 15]);
  const response = bandItem(rate, 90, 50, [100, 50, 10]);
  const photo = bandItem(photos, 40, 15, [100, 55, 20]);
  const video = bandItem(videos, 3, 1, [100, 50, 0]);
  const fresh = vitrine.daysSinceLastMedia !== null && vitrine.daysSinceLastMedia <= 14 ? { status: 'PASS' as const, score: 100 } : vitrine.daysSinceLastMedia !== null && vitrine.daysSinceLastMedia <= 45 ? { status: 'PARTIAL' as const, score: 50 } : { status: 'FAIL' as const, score: 15 };
  const post = vitrine.daysSinceLastPost !== null && vitrine.daysSinceLastPost <= 7 ? { status: 'PASS' as const, score: 100 } : vitrine.daysSinceLastPost !== null && vitrine.daysSinceLastPost <= 30 ? { status: 'PARTIAL' as const, score: 45 } : { status: 'FAIL' as const, score: 10 };
  const top3 = bandItem(battlefield.top3Percentage, 35, 10, [100, 50, 15]);
  const top7 = bandItem(battlefield.top7Percentage, 55, 20, [100, 55, 20]);
  const inv = battlefield.invisibilityPercentage <= 20 ? { status: 'PASS' as const, score: 100 } : battlefield.invisibilityPercentage <= 50 ? { status: 'PARTIAL' as const, score: 45 } : { status: 'FAIL' as const, score: 10 };

  const items: JudgeChecklistItem[] = [
    r(1, 'NAP_01_CLAIMED', 'IDENTITY_AND_NAP', 'Propriedade Reivindicada e Verificada no GBP', 6, lead.claimedByOwner ? 'PASS' : 'FAIL', lead.claimedByOwner ? 100 : 0, 'Perfil verificado pelo proprietário.'),
    r(2, 'NAP_02_NAME_SEMANTICS', 'IDENTITY_AND_NAP', 'Otimização Semântica do Nome Comercial (Sem Keyword Stuffing)', 5, hasKeywordInName ? 'PASS' : 'PARTIAL', hasKeywordInName ? 100 : 65, `Nome atual registrado: "${lead.businessName}".`),
    r(3, 'NAP_03_ADDRESS_CONTEXT', 'IDENTITY_AND_NAP', 'Consistência de Endereço Físico vs. Área de Cobertura (Regra SAB)', 6, !addressHidden ? 'PASS' : 'FAIL', !addressHidden ? 100 : 0, `Endereço físico público ativo: ${lead.addressRaw ?? 'Verificado'}.`),
    r(4, 'NAP_04_WHATSAPP_CONVERSION', 'IDENTITY_AND_NAP', 'Canal de WhatsApp Habilitado para Conversão Direta', 5, lead.whatsappStatus === 'VERIFIED_WHATSAPP' ? 'PASS' : lead.whatsappStatus === 'LIKELY_MOBILE_WHATSAPP' ? 'PARTIAL' : 'FAIL', lead.whatsappStatus === 'VERIFIED_WHATSAPP' ? 100 : lead.whatsappStatus === 'LIKELY_MOBILE_WHATSAPP' ? 75 : 0, `Status de WhatsApp: ${lead.whatsappStatus}.`),
    r(5, 'NAP_05_OWN_WEBSITE', 'IDENTITY_AND_NAP', 'Domínio Próprio Indexável Vinculado com LocalBusiness Schema', 6, lead.websiteStatus === 'OWN_DOMAIN' ? 'PASS' : lead.websiteStatus === 'SOCIAL_LINK_ONLY' ? 'PARTIAL' : 'FAIL', lead.websiteStatus === 'OWN_DOMAIN' ? 100 : lead.websiteStatus === 'SOCIAL_LINK_ONLY' ? 35 : 0, `Domínio próprio ativo: ${lead.websiteUrl}.`),
    r(6, 'CAT_06_PRIMARY_MATCH', 'CATEGORIZATION_AND_SERVICES', 'Aderência da Categoria Principal ao Dominador #1 da Grade', 6, 'PASS', 100, `Categoria primária "${lead.primaryCategory}" compatível com a intenção de busca.`),
    r(7, 'CAT_07_SECONDARY_DEPTH', 'CATEGORIZATION_AND_SERVICES', 'Densidade de Categorias Secundárias Complementares', 4, lead.secondaryCategories.length >= 3 ? 'PASS' : 'PARTIAL', lead.secondaryCategories.length >= 3 ? 100 : 55, `${lead.secondaryCategories.length} categorias secundárias preenchidas.`),
    r(8, 'CAT_08_SERVICES_CATALOG', 'CATEGORIZATION_AND_SERVICES', 'Catálogo Estruturado de Serviços com Descrição Semântica', 5, lead.servicesListedCount >= 10 ? 'PASS' : lead.servicesListedCount >= 4 ? 'PARTIAL' : 'FAIL', lead.servicesListedCount >= 10 ? 100 : lead.servicesListedCount >= 4 ? 60 : 20, `${lead.servicesListedCount} serviços cadastrados.`),
    r(9, 'CAT_09_ATTRIBUTES_HOURS', 'CATEGORIZATION_AND_SERVICES', 'Horário de Funcionamento, Feriados e Atributos Operacionais', 3, lead.businessHoursConfigured && lead.attributesCount >= 4 ? 'PASS' : 'PARTIAL', lead.businessHoursConfigured ? 85 : 30, 'Horário configurado.'),
    r(10, 'REP_10_RATING_HEALTH', 'REPUTATION_AND_CONVERSION', 'Nota Média de Estrelas na Zona de Alta Conversão (4.6 a 4.9)', 5, rating.status, rating.score, `Nota atual de ${reputation.averageRating} estrelas.`),
    r(11, 'REP_11_VOLUME_VS_LEADER', 'REPUTATION_AND_CONVERSION', 'Volume Total de Avaliações vs. Dominador #1 do Território', 6, volume.status, volume.score, `${reputation.totalReviews} avaliações contra ${topRivalReviews} do líder.`),
    r(12, 'REP_12_VELOCITY_30D', 'REPUTATION_AND_CONVERSION', 'Ritmo de Novas Avaliações nos Últimos 30 Dias (Recência)', 6, velocity.status, velocity.score, `${n30} novas avaliações em 30 dias.`),
    r(13, 'REP_13_OWNER_RESPONSE_RATE', 'REPUTATION_AND_CONVERSION', 'Taxa de Resposta do Proprietário às Avaliações (>90%)', 5, response.status, response.score, `Taxa de resposta em ${rate}%.`),
    r(14, 'REP_14_KEYWORD_RICHTEXT_REVIEWS', 'REPUTATION_AND_CONVERSION', 'Presença de Termos de Serviços nos Depoimentos de Clientes', 4, 'PARTIAL', 60, 'Resultado fixo do formato anterior.'),
    r(15, 'VIT_15_PHOTO_VOLUME', 'VITRINE_AND_CONTENT', 'Acervo Total de Fotografias Proprietárias e de Clientes', 4, photo.status, photo.score, `${photos} fotos totais.`),
    r(16, 'VIT_16_VIDEO_ASSETS', 'VITRINE_AND_CONTENT', 'Presença de Vídeos Nativos Demonstrativos (<30s)', 3, video.status, video.score, `${videos} vídeo(s).`),
    r(17, 'VIT_17_MEDIA_FRESHNESS', 'VITRINE_AND_CONTENT', 'Recência da Última Mídia Publicada (<14 Dias)', 4, fresh.status, fresh.score, `Última mídia há ${vitrine.daysSinceLastMedia} dias.`),
    r(18, 'VIT_18_GOOGLE_POSTS_CADENCE', 'VITRINE_AND_CONTENT', 'Cadência de Publicações no Mural de Atualizações (Google Posts)', 4, post.status, post.score, `Último post há ${vitrine.daysSinceLastPost} dias.`),
    r(19, 'GEO_19_TOP3_SHARE', 'GEOGRAPHIC_AUTHORITY', 'Taxa de Domínio no Local Pack (Top 3 na Grade de 49 Coordenadas)', 6, top3.status, top3.score, `${battlefield.top3Percentage}% no Top 3.`),
    r(20, 'GEO_20_TOP7_PRESENCE', 'GEOGRAPHIC_AUTHORITY', 'Densidade de Presença Competitiva até o Top 7 Regional', 4, top7.status, top7.score, `${battlefield.top7Percentage}% até o Top 7.`),
    r(21, 'GEO_21_INVISIBILITY_SHIELD', 'GEOGRAPHIC_AUTHORITY', 'Controle de Zonas de Invisibilidade (>20 na Grade)', 5, inv.status, inv.score, `${battlefield.invisibilityPercentage}% de invisibilidade.`),
  ];

  const totalMax = Math.max(1, items.reduce((sum, i) => sum + i.maxWeight, 0));
  const overall = Number(((items.reduce((sum, i) => sum + ((i.scoreAwarded ?? 0) / 100) * i.maxWeight, 0) / totalMax) * 100).toFixed(1));
  const categoryScores: JudgeCategoryScore[] = (Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]).map((category) => {
    const inCat = items.filter((i) => i.category === category);
    const weight = Math.max(1, inCat.reduce((sum, i) => sum + i.maxWeight, 0));
    return {
      category,
      categoryLabel: CATEGORY_LABELS[category],
      scorePercent: Number(((inCat.reduce((sum, i) => sum + ((i.scoreAwarded ?? 0) / 100) * i.maxWeight, 0) / weight) * 100).toFixed(1)),
      passedItemsCount: inCat.filter((i) => i.status === 'PASS').length,
      totalItemsCount: inCat.length,
    };
  });
  const top = rivals.topDominators[0];

  return {
    placeId: lead.placeId,
    overallScore: overall,
    healthClassification: overall >= 82 ? 'ELITE' : overall >= 64 ? 'COMPETITIVE' : overall >= 45 ? 'VULNERABLE' : 'CRITICAL_INVISIBLE',
    businessModelContext: { isServiceAreaBusiness: false, isAddressHidden: addressHidden, addressExceptionRuleTriggered: false, contextJustification: 'Negócio com atendimento físico local e endereço público devidamente exposto.' },
    categoryScores,
    checklist21Items: items,
    rawFactsRegistry: {
      rating: reputation.averageRating, totalReviews: reputation.totalReviews, ownerResponseRatePercent: rate, interactionsLast30Days: n30,
      totalPhotosCount: photos, customerPhotosCount: vitrine.customerPhotosCount ?? 0, totalVideosCount: videos,
      daysSinceLastMedia: vitrine.daysSinceLastMedia, daysSinceLastPost: vitrine.daysSinceLastPost,
      validGridPoints: battlefield.validPointsCount, unreadableGridPoints: battlefield.unreadablePointsCount, averageGridPosition: battlefield.averagePosition,
      top3Percentage: battlefield.top3Percentage, top7Percentage: battlefield.top7Percentage, invisibilityPercentage: battlefield.invisibilityPercentage,
      greenTop3Count: battlefield.greenTop3Count, topRivalName: top?.businessName ?? 'Líder Regional', topRivalReviews: top?.totalReviews ?? 180,
      topRivalPointsWon: top?.pointsWonAsNumberOne ?? 18, overallJudgeScore: overall,
    },
    evaluatedAt: new Date().toISOString(),
  };
}

/** Estrategista no formato anterior: ações fixas, com promessas numéricas. */
export function legacyStrategist(lead: FrontierLead, judge: JudgeTechnicalSheet, battlefield: BattlefieldMetrics): StrategistOutput {
  const raw = judge.rawFactsRegistry;
  const act = (actionCode: string, title: string, impact: string) => ({ actionCode, title, technicalInstruction: 'Instrução fixa do formato anterior.', expectedImpact: impact, effortLevel: 'LOW' as const });
  const wave = (key: 'P0' | 'P1' | 'P2' | 'P3', actions: ReturnType<typeof act>[]) => ({ wave: key, waveTitle: `Onda ${key}`, timeframeLabel: key, objective: `Objetivo ${key}`, actions });
  return {
    placeId: lead.placeId,
    revisionAttempt: 1,
    executiveSummary: `A auditoria apurou um Score Global de ${raw.overallJudgeScore}/100 (formato anterior).`,
    diagnosticNarrative: `A posição média real da empresa é ${raw.averageGridPosition} (formato anterior).`,
    territoryOpportunityNarrative: battlefield.historicalEvolution.evolutionSummaryText,
    citedMetricsSnapshot: {
      rating: raw.rating, totalReviews: raw.totalReviews, ownerResponseRatePercent: raw.ownerResponseRatePercent, interactionsLast30Days: raw.interactionsLast30Days,
      totalPhotosCount: raw.totalPhotosCount, averageGridPosition: raw.averageGridPosition, top3Percentage: raw.top3Percentage, top7Percentage: raw.top7Percentage,
      invisibilityPercentage: raw.invisibilityPercentage, overallJudgeScore: raw.overallJudgeScore,
    },
    tacticalWaves: [
      wave('P0', [act('P0_ACT_01', 'Zerar Passivo de Avaliações Sem Resposta', 'Sinal imediato de gestão ativa.'), act('P0_ACT_02', 'Padronização de Link Direto WhatsApp com UTM', 'Aumento de 25% a 40% na taxa de cliques em solicitações de orçamento.'), act('P0_ACT_03', 'Reativação do Mural de Atualizações (Google Posts)', 'Recuperação de sinais de frescor.')]),
      wave('P1', [act('P1_ACT_01', 'Expansão da Árvore de Serviços e Categorias Secundárias', 'Ampliação da cobertura.'), act('P1_ACT_02', 'Injeção de Vitrine Visual Proprietária e Vídeos', 'Aumento do tempo de retenção.')]),
      wave('P2', [act('P2_ACT_01', 'Automação de Coleta Pós-Atendimento (Meta 12 Reviews/Mês)', 'Ganho de autoridade competitiva direta.'), act('P2_ACT_02', 'Implementação de Dados Estruturados LocalBusiness no Site', 'Validação cruzada de autoridade.')]),
      wave('P3', [act('P3_ACT_01', 'Campanha de Avaliações Georreferenciadas por Bairro', 'Expansão do raio de alcance.'), act('P3_ACT_02', 'Monitoramento Mensal Comparativo na Grade de 49 Pontos', 'Defesa preventiva.')]),
    ],
    generatedAt: new Date().toISOString(),
  };
}
