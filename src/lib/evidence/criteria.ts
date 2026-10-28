import type {
  BattlefieldMetrics,
  FrontierLead,
  JudgeCategoryKey,
  JudgeItemStatus,
  ReputationMetrics,
  RivalsMetrics,
  VitrineMetrics,
} from '@/types/gmn';
import { computeTerritoryRankMetrics } from '@/lib/battlefield-metrics';
import type { SiteCheckResult } from '@/lib/site-check';
import type { AuditEvidence, EvidenceStatus } from './types';
import {
  detectBattlefieldOrigin,
  detectReputationOrigin,
  detectVitrineOrigin,
  leaderValuesAreDefault,
  leadRatingIsDefault,
} from './origins';

/**
 * Avaliação dos 21 critérios do Juiz com evidência explícita (Fase 4).
 *
 * Princípios:
 *  - A pontuação (`score`) segue a metodologia original quando existe dado observado. Sem dado, o
 *    critério fica SEM pontuação (`null`): nem aprovado nem reprovado, nem zero nem 100.
 *  - O status da evidência é independente da pontuação. Heurística e valor padrão nunca são VERIFIED.
 *  - Ausência de informação não significa ausência de funcionalidade (regra 15 do escopo).
 *  - Dados simulados (modo demonstração ou resíduos de auditorias antigas) são SIMULATED e sem pontuação.
 */
export interface CriterionMeta {
  readonly itemNumber: number;
  readonly code: string;
  readonly category: JudgeCategoryKey;
  readonly title: string;
  readonly maxWeight: number;
}

export const CRITERIA_META: readonly CriterionMeta[] = [
  { itemNumber: 1, code: 'NAP_01_CLAIMED', category: 'IDENTITY_AND_NAP', title: 'Propriedade Reivindicada e Verificada no GBP', maxWeight: 6 },
  { itemNumber: 2, code: 'NAP_02_NAME_SEMANTICS', category: 'IDENTITY_AND_NAP', title: 'Otimização Semântica do Nome Comercial (Sem Keyword Stuffing)', maxWeight: 5 },
  { itemNumber: 3, code: 'NAP_03_ADDRESS_CONTEXT', category: 'IDENTITY_AND_NAP', title: 'Consistência de Endereço Físico vs. Área de Cobertura (Regra SAB)', maxWeight: 6 },
  { itemNumber: 4, code: 'NAP_04_WHATSAPP_CONVERSION', category: 'IDENTITY_AND_NAP', title: 'Canal de WhatsApp Habilitado para Conversão Direta', maxWeight: 5 },
  { itemNumber: 5, code: 'NAP_05_OWN_WEBSITE', category: 'IDENTITY_AND_NAP', title: 'Domínio Próprio Indexável Vinculado com LocalBusiness Schema', maxWeight: 6 },
  { itemNumber: 6, code: 'CAT_06_PRIMARY_MATCH', category: 'CATEGORIZATION_AND_SERVICES', title: 'Aderência da Categoria Principal ao Dominador #1 da Grade', maxWeight: 6 },
  { itemNumber: 7, code: 'CAT_07_SECONDARY_DEPTH', category: 'CATEGORIZATION_AND_SERVICES', title: 'Densidade de Categorias Secundárias Complementares', maxWeight: 4 },
  { itemNumber: 8, code: 'CAT_08_SERVICES_CATALOG', category: 'CATEGORIZATION_AND_SERVICES', title: 'Catálogo Estruturado de Serviços com Descrição Semântica', maxWeight: 5 },
  { itemNumber: 9, code: 'CAT_09_ATTRIBUTES_HOURS', category: 'CATEGORIZATION_AND_SERVICES', title: 'Horário de Funcionamento, Feriados e Atributos Operacionais', maxWeight: 3 },
  { itemNumber: 10, code: 'REP_10_RATING_HEALTH', category: 'REPUTATION_AND_CONVERSION', title: 'Nota Média de Estrelas na Zona de Alta Conversão (4.6 a 4.9)', maxWeight: 5 },
  { itemNumber: 11, code: 'REP_11_VOLUME_VS_LEADER', category: 'REPUTATION_AND_CONVERSION', title: 'Volume Total de Avaliações vs. Dominador #1 do Território', maxWeight: 6 },
  { itemNumber: 12, code: 'REP_12_VELOCITY_30D', category: 'REPUTATION_AND_CONVERSION', title: 'Ritmo de Novas Avaliações nos Últimos 30 Dias (Recência)', maxWeight: 6 },
  { itemNumber: 13, code: 'REP_13_OWNER_RESPONSE_RATE', category: 'REPUTATION_AND_CONVERSION', title: 'Taxa de Resposta do Proprietário às Avaliações (>90%)', maxWeight: 5 },
  { itemNumber: 14, code: 'REP_14_KEYWORD_RICHTEXT_REVIEWS', category: 'REPUTATION_AND_CONVERSION', title: 'Presença de Termos de Serviços nos Depoimentos de Clientes', maxWeight: 4 },
  { itemNumber: 15, code: 'VIT_15_PHOTO_VOLUME', category: 'VITRINE_AND_CONTENT', title: 'Acervo Total de Fotografias Proprietárias e de Clientes', maxWeight: 4 },
  { itemNumber: 16, code: 'VIT_16_VIDEO_ASSETS', category: 'VITRINE_AND_CONTENT', title: 'Presença de Vídeos Nativos Demonstrativos (<30s)', maxWeight: 3 },
  { itemNumber: 17, code: 'VIT_17_MEDIA_FRESHNESS', category: 'VITRINE_AND_CONTENT', title: 'Recência da Última Mídia Publicada (<14 Dias)', maxWeight: 4 },
  { itemNumber: 18, code: 'VIT_18_GOOGLE_POSTS_CADENCE', category: 'VITRINE_AND_CONTENT', title: 'Cadência de Publicações no Mural de Atualizações (Google Posts)', maxWeight: 4 },
  { itemNumber: 19, code: 'GEO_19_TOP3_SHARE', category: 'GEOGRAPHIC_AUTHORITY', title: 'Taxa de Domínio no Local Pack (Top 3 na Grade de 49 Coordenadas)', maxWeight: 6 },
  { itemNumber: 20, code: 'GEO_20_TOP7_PRESENCE', category: 'GEOGRAPHIC_AUTHORITY', title: 'Densidade de Presença Competitiva até o Top 7 Regional', maxWeight: 4 },
  { itemNumber: 21, code: 'GEO_21_INVISIBILITY_SHIELD', category: 'GEOGRAPHIC_AUTHORITY', title: 'Controle de Zonas de Invisibilidade (>20 na Grade)', maxWeight: 5 },
];

export interface CriteriaContext {
  readonly lead: FrontierLead;
  readonly reputation: ReputationMetrics;
  readonly vitrine: VitrineMetrics;
  readonly battlefield: BattlefieldMetrics;
  readonly rivals: RivalsMetrics;
  /** Resultado da verificação técnica do site; `null` quando não foi executada. */
  readonly siteCheck: SiteCheckResult | null;
  readonly isAddressHidden: boolean;
  readonly addressExceptionRuleTriggered: boolean;
  /**
   * Dados de teste (fixtures). As evidências saem identificadas como sintéticas: nunca atribuídas a
   * uma consulta real do Serper nem a uma data de coleta real.
   */
  readonly syntheticTestData?: boolean;
}

export const SYNTHETIC_PROVIDER = 'Dados sintéticos de teste (fixture)';

export interface CriterionOutcome {
  readonly itemNumber: number;
  readonly status: JudgeItemStatus;
  readonly score: number | null;
  readonly observed: string;
  readonly recommendation: string;
  readonly evidence: AuditEvidence;
}

const PROVIDER_MAPS = 'Serper.dev (Google Maps)';
const PROVIDER_REVIEWS = 'Serper.dev (Google Reviews)';
const PROVIDER_SITE = 'Verificação técnica do site (HTTP)';

interface Build {
  readonly status: JudgeItemStatus;
  readonly score: number | null;
  readonly observed: string;
  readonly recommendation: string;
  readonly evidenceStatus: EvidenceStatus;
  readonly value?: unknown;
  readonly provider?: string;
  readonly sourceType?: string;
  readonly reference?: string;
  readonly collectedAt?: string;
  readonly explanation: string;
  readonly limitations?: readonly string[];
  readonly confidence?: number;
}

function outcome(itemNumber: number, build: Build): CriterionOutcome {
  return {
    itemNumber,
    status: build.status,
    score: build.score,
    observed: build.observed,
    recommendation: build.recommendation,
    evidence: {
      criterionId: itemNumber,
      status: build.evidenceStatus,
      value: build.value ?? null,
      ...(build.provider ? { sourceProvider: build.provider } : {}),
      ...(build.sourceType ? { sourceType: build.sourceType } : {}),
      ...(build.reference ? { sourceReference: build.reference } : {}),
      ...(build.collectedAt ? { collectedAt: build.collectedAt } : {}),
      explanation: build.explanation,
      limitations: build.limitations ?? [],
      ...(build.confidence !== undefined ? { confidence: build.confidence } : {}),
    },
  };
}

/** Critério sem evidência utilizável: não é aprovado, reprovado nem pontuado. */
function notVerified(itemNumber: number, observed: string, explanation: string, recommendation: string, limitations: readonly string[] = []): CriterionOutcome {
  return outcome(itemNumber, {
    status: 'NOT_EVALUATED',
    score: null,
    observed,
    recommendation,
    evidenceStatus: 'NOT_VERIFIED',
    explanation,
    limitations,
  });
}

function simulated(itemNumber: number, what: string): CriterionOutcome {
  return outcome(itemNumber, {
    status: 'NOT_EVALUATED',
    score: null,
    observed: `${what}: conjunto simulado pelo sistema, sem relação com o perfil real.`,
    recommendation: 'Descartar este dado e coletar de uma fonte real antes de qualquer conclusão.',
    evidenceStatus: 'SIMULATED',
    explanation: 'Os valores deste critério foram gerados pelo sistema e não representam o perfil auditado.',
    limitations: ['Dado simulado: nunca é usado em pontuação verificada.'],
  });
}

const band = (value: number, high: number, mid: number, scores: readonly [number, number, number]): { score: number; status: JudgeItemStatus } =>
  value >= high ? { score: scores[0], status: 'PASS' } : value >= mid ? { score: scores[1], status: 'PARTIAL' } : { score: scores[2], status: 'FAIL' };

/** Número no formato brasileiro (vírgula decimal), para os textos de evidência. */
const fmt = (value: number): string => value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

const stripAccents = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const ADDRESS_STOP = new Set(['rua', 'avenida', 'av', 'r', 'travessa', 'alameda', 'praca', 'rodovia', 'de', 'da', 'do', 'das', 'dos', 'e', 'brasil', 'br', 'sala', 'loja', 'bloco', 'quadra', 'lote', 'qd', 'lt', 'setor']);

function addressTokens(raw: string): { tokens: Set<string>; number: string | null; zip: string | null } {
  const normalized = stripAccents(raw).replace(/[.,;]/g, ' ').replace(/\s+/g, ' ');
  const zip = /\b(\d{5})-?(\d{3})\b/.exec(normalized);
  const withoutZip = zip ? normalized.replace(zip[0], ' ') : normalized;
  const number = /\b(\d{1,5})\b/.exec(withoutZip);
  const tokens = new Set(
    withoutZip
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !ADDRESS_STOP.has(token))
  );
  return { tokens, number: number?.[1] ?? null, zip: zip ? `${zip[1]}${zip[2]}` : null };
}

export type AddressComparison = 'MATCH' | 'MISMATCH' | 'INSUFFICIENT';

/** Compara o endereço da listagem com o endereço estruturado do site. */
export function compareAddresses(listing: string, site: { streetAddress: string | null; locality: string | null; postalCode: string | null }): AddressComparison {
  const a = addressTokens(listing);
  const siteText = [site.streetAddress, site.locality, site.postalCode].filter(Boolean).join(' ');
  if (!site.streetAddress && !site.postalCode) return 'INSUFFICIENT';
  const b = addressTokens(siteText);

  if (a.zip && b.zip) return a.zip === b.zip && (!a.number || !b.number || a.number === b.number) ? 'MATCH' : 'MISMATCH';
  if (b.tokens.size === 0 || a.tokens.size === 0) return 'INSUFFICIENT';
  const shared = [...b.tokens].filter((token) => a.tokens.has(token)).length;
  const overlap = shared / b.tokens.size;
  if (a.number && b.number && a.number !== b.number) return 'MISMATCH';
  if (overlap >= 0.6 && a.number && b.number) return 'MATCH';
  return overlap < 0.3 ? 'MISMATCH' : 'INSUFFICIENT';
}

function categoriesMatch(a: string, b: string): boolean {
  const x = stripAccents(a).trim();
  const y = stripAccents(b).trim();
  return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
}

/* -------------------------------------------------------------------------- */

const ratingCollected = (lead: FrontierLead): boolean =>
  lead.rating > 0 &&
  lead.totalReviews > 0 &&
  !leadRatingIsDefault(lead) &&
  lead.provenance?.rating !== 'UNKNOWN' &&
  lead.provenance?.totalReviews !== 'UNKNOWN';

function geoMetrics(battlefield: BattlefieldMetrics) {
  return computeTerritoryRankMetrics(Array.isArray(battlefield.points) ? battlefield.points : []);
}

function geoCoverage(battlefield: BattlefieldMetrics): { status: EvidenceStatus; note: string | null } {
  const origin = detectBattlefieldOrigin(battlefield);
  if (battlefield.dataOrigin === 'SIMULATED' || origin === 'SIMULATED') return { status: 'SIMULATED', note: null };
  const metrics = geoMetrics(battlefield);
  if (metrics.validPoints === 0) return { status: 'NOT_VERIFIED', note: 'Nenhum ponto da grade teve leitura válida.' };
  if (metrics.validPoints < 40) {
    return { status: 'PARTIALLY_VERIFIED', note: `Grade parcial: ${metrics.validPoints} de ${metrics.totalPoints} pontos com leitura válida.` };
  }
  return { status: 'VERIFIED', note: metrics.unreadablePoints > 0 ? `${metrics.unreadablePoints} pontos sem leitura ficaram fora das médias.` : null };
}

function geoOutcome(itemNumber: number, ctx: CriteriaContext, compute: (m: ReturnType<typeof geoMetrics>) => { score: number; status: JudgeItemStatus; observed: string; recommendation: string }): CriterionOutcome {
  const coverage = geoCoverage(ctx.battlefield);
  if (coverage.status === 'SIMULATED') return simulated(itemNumber, 'Medição territorial');
  if (coverage.status === 'NOT_VERIFIED') {
    return notVerified(itemNumber, 'Sem leituras válidas na grade.', coverage.note ?? 'Sem leitura territorial.', 'Repetir a medição territorial.');
  }
  const metrics = geoMetrics(ctx.battlefield);
  const result = compute(metrics);
  return outcome(itemNumber, {
    ...result,
    evidenceStatus: coverage.status,
    value: {
      validPoints: metrics.validPoints,
      unreadablePoints: metrics.unreadablePoints,
      top3Points: metrics.top3Points,
      top7Points: metrics.top7Points,
      outsideTop20Points: metrics.outsideTop20Points,
    },
    provider: PROVIDER_MAPS,
    sourceType: 'BUSCA_TERRITORIAL_49_PONTOS',
    reference: ctx.battlefield.roundId,
    collectedAt: ctx.battlefield.executedAt,
    explanation: `Posições lidas em ${metrics.validPoints} coordenadas da grade 7×7 (denominador dos percentuais).`,
    limitations: [
      'Posições refletem buscas por coordenada em um instante; variam com o tempo e o dispositivo.',
      ...(coverage.note ? [coverage.note] : []),
    ],
    confidence: coverage.status === 'VERIFIED' ? 0.9 : 0.6,
  });
}

/* -------------------------------------------------------------------------- */

export function assessCriterion(itemNumber: number, ctx: CriteriaContext): CriterionOutcome {
  const result = assessCriterionInner(itemNumber, ctx);
  return ctx.syntheticTestData ? markSynthetic(result) : result;
}

/** Evidência de fixture: provedor identificado como teste e sem data de coleta real. */
function markSynthetic(result: CriterionOutcome): CriterionOutcome {
  const { collectedAt: _collectedAt, sourceReference: _sourceReference, ...rest } = result.evidence;
  void _collectedAt;
  void _sourceReference;
  const evidence: AuditEvidence = {
    ...rest,
    ...(result.evidence.sourceProvider ? { sourceProvider: SYNTHETIC_PROVIDER } : {}),
    limitations: [...result.evidence.limitations, 'Dado sintético de teste: não vem de nenhuma consulta real.'],
  };
  return { ...result, evidence };
}

function assessCriterionInner(itemNumber: number, ctx: CriteriaContext): CriterionOutcome {
  const { lead, reputation, vitrine, rivals, siteCheck } = ctx;

  switch (itemNumber) {
    case 1: {
      if (lead.provenance?.claimedByOwner === 'COLLECTED') {
        return outcome(1, {
          status: lead.claimedByOwner ? 'PASS' : 'FAIL',
          score: lead.claimedByOwner ? 100 : 0,
          observed: lead.claimedByOwner ? 'Perfil informado como reivindicado pela fonte de dados.' : 'Perfil informado como não reivindicado pela fonte de dados.',
          recommendation: lead.claimedByOwner ? 'Manter a verificação em duas etapas na conta proprietária.' : 'Reivindicar o perfil pelo processo oficial do Google.',
          evidenceStatus: 'VERIFIED',
          value: { claimedByOwner: lead.claimedByOwner },
          provider: PROVIDER_MAPS,
          sourceType: 'LISTAGEM_PUBLICA',
          collectedAt: lead.createdAt,
          explanation: 'A fonte de dados informou explicitamente o estado de reivindicação.',
          limitations: ['A reivindicação só é plenamente confirmada com acesso autorizado ao painel do proprietário.'],
          confidence: 0.7,
        });
      }
      return notVerified(1, 'Reivindicação não comprovada: nenhuma fonte desta auditoria informa esse estado.', 'A coleta pública não informa se o perfil é reivindicado (o valor antes assumido como "sim" era um padrão do sistema).', 'Confirmar no painel do perfil (acesso do proprietário) se a propriedade está verificada.', ['Exige acesso autorizado do proprietário ou um provedor que exponha o campo.']);
    }

    case 2:
      return notVerified(2, `Nome registrado na listagem: "${lead.businessName}".`, 'A conformidade do nome com as diretrizes do Google não pode ser comprovada por análise automática do texto.', 'Conferir se o nome comercial corresponde ao nome real do negócio, sem palavras-chave ou bairros extras.', ['Análise textual automática é heurística, não evidência.']);

    case 3: {
      if (ctx.addressExceptionRuleTriggered) {
        return outcome(3, {
          status: 'EXEMPT_BY_CONTEXT_RULE',
          score: null,
          observed: 'Listagem sem endereço público: o perfil foi tratado como prestador de serviço em área de cobertura (inferência, não confirmada).',
          recommendation: 'Confirmar no painel se o negócio atende em área de cobertura e oculta o endereço.',
          evidenceStatus: 'PARTIALLY_VERIFIED',
          value: { addressPublic: false, serviceAreaInferred: true },
          provider: PROVIDER_MAPS,
          sourceType: 'LISTAGEM_PUBLICA',
          collectedAt: lead.createdAt,
          explanation: 'A listagem não traz endereço e a coleta trata esses perfis como atendimento no local do cliente; a condição de área de serviço é inferida, não confirmada.',
          limitations: ['A ausência de endereço na coleta não prova que ele esteja oculto no perfil.'],
          confidence: 0.4,
        });
      }
      if (!lead.addressRaw || ctx.isAddressHidden) {
        return notVerified(3, 'Endereço não informado na coleta.', 'A coleta não trouxe endereço; isso não prova que ele esteja oculto no perfil.', 'Conferir no perfil se o endereço está público e coerente com os demais canais.');
      }
      const site = siteCheck?.status === 'OK' ? siteCheck.localBusiness?.address ?? null : null;
      const comparison = site ? compareAddresses(lead.addressRaw, site) : 'INSUFFICIENT';
      if (comparison === 'MATCH') {
        // Dois canais concordam (listagem e site), mas o critério também exige avaliar a regra SAB e
        // a área de cobertura, o que só o painel do perfil permite. Evidência parcial, sem pontuação.
        return outcome(3, {
          status: 'PARTIAL', score: null,
          observed: `Endereço da listagem coincide com o endereço estruturado do site: ${lead.addressRaw}.`,
          recommendation: 'Confirmar no painel se o endereço está público e se há área de cobertura coerente; manter o mesmo endereço em site, perfil e cadastros.',
          evidenceStatus: 'PARTIALLY_VERIFIED',
          value: { listing: lead.addressRaw, site, channelsCompared: 2, serviceAreaEvaluated: false },
          provider: `${PROVIDER_MAPS} + ${PROVIDER_SITE}`, sourceType: 'COMPARACAO_LISTAGEM_X_SITE',
          reference: siteCheck?.finalUrl ?? undefined, collectedAt: siteCheck?.checkedAt,
          explanation: 'O endereço público da listagem coincide com o endereço do dado estruturado do site (consistência entre dois canais).',
          limitations: [
            'A regra SAB e a área de cobertura do perfil não foram avaliadas (dependem do painel do proprietário).',
            'Só foram comparados dois canais (listagem e site); CNPJ e outros cadastros não foram verificados.',
          ],
          confidence: 0.6,
        });
      }
      if (comparison === 'MISMATCH') {
        return outcome(3, {
          status: 'PARTIAL', score: 40,
          observed: 'O endereço da listagem difere do endereço estruturado do site.',
          recommendation: 'Padronizar o endereço (rua, número e CEP) entre o perfil e o site.',
          evidenceStatus: 'PARTIALLY_VERIFIED',
          value: { listing: lead.addressRaw, site },
          provider: `${PROVIDER_MAPS} + ${PROVIDER_SITE}`, sourceType: 'COMPARACAO_LISTAGEM_X_SITE',
          reference: siteCheck?.finalUrl ?? undefined, collectedAt: siteCheck?.checkedAt,
          explanation: 'Há divergência entre os dois endereços; a diferença pode ser de formatação.',
          limitations: ['Comparação automática de texto: conferir manualmente antes de agir.'],
          confidence: 0.5,
        });
      }
      return outcome(3, {
        status: 'PARTIAL', score: null,
        observed: `Endereço público na listagem: ${lead.addressRaw}.`,
        recommendation: 'Conferir se o mesmo endereço aparece no site, no CNPJ e nos cadastros.',
        evidenceStatus: 'PARTIALLY_VERIFIED',
        value: { listing: lead.addressRaw },
        provider: PROVIDER_MAPS, sourceType: 'LISTAGEM_PUBLICA', collectedAt: lead.createdAt,
        explanation: 'Existe endereço público na listagem, mas sua consistência com outros canais não foi comprovada.',
        limitations: ['A existência de endereço não prova consistência com site, CNPJ ou outros cadastros.'],
        confidence: 0.4,
      });
    }

    case 4: {
      const siteLink = siteCheck?.status === 'OK' && siteCheck.whatsappLinks.length > 0;
      const listingLink = lead.whatsappStatus === 'VERIFIED_WHATSAPP' && Boolean(lead.whatsappUrl);
      if (listingLink || siteLink) {
        return outcome(4, {
          status: 'PARTIAL', score: 100,
          observed: listingLink ? 'Link público de WhatsApp encontrado na listagem.' : 'Link público de WhatsApp encontrado no site.',
          recommendation: 'Confirmar que o número atende mensagens e padronizar o link com mensagem inicial.',
          evidenceStatus: 'PARTIALLY_VERIFIED',
          value: { source: listingLink ? 'LISTAGEM' : 'SITE' },
          provider: listingLink ? PROVIDER_MAPS : PROVIDER_SITE, sourceType: 'LINK_PUBLICO',
          collectedAt: listingLink ? lead.createdAt : siteCheck?.checkedAt,
          explanation: 'Existe um link público de WhatsApp.',
          limitations: ['A existência do link não comprova uma conta ativa que responda mensagens.'],
          confidence: 0.5,
        });
      }
      if (lead.whatsappStatus === 'LIKELY_MOBILE_WHATSAPP') {
        return outcome(4, {
          status: 'PARTIAL', score: 75,
          observed: 'Telefone em formato de celular na listagem; WhatsApp não confirmado.',
          recommendation: 'Confirmar se o número tem WhatsApp ativo e publicar o link de contato.',
          evidenceStatus: 'PARTIALLY_VERIFIED',
          value: { formato: 'CELULAR_PROVAVEL' },
          provider: PROVIDER_MAPS, sourceType: 'FORMATO_DO_TELEFONE', collectedAt: lead.createdAt,
          explanation: 'O formato do número é compatível com celular.',
          limitations: ['O formato do número não prova que há WhatsApp ativo.'],
          confidence: 0.3,
        });
      }
      return notVerified(4, lead.phoneRaw ? 'Telefone fixo na listagem; canal de WhatsApp não informado.' : 'Sem telefone na listagem.', 'Nenhuma fonte indica um canal de WhatsApp para este perfil.', 'Conferir com o proprietário se há WhatsApp de atendimento e publicá-lo no perfil.', ['Ausência de link na coleta não prova ausência do canal.']);
    }

    case 5: {
      if (lead.websiteStatus === 'SOCIAL_LINK_ONLY') {
        return outcome(5, {
          status: 'PARTIAL', score: 35,
          observed: `A listagem aponta para rede social ou agregador (${lead.websiteUrl}), não para domínio próprio.`,
          recommendation: 'Publicar um site em domínio próprio com dados estruturados LocalBusiness.',
          evidenceStatus: 'VERIFIED',
          value: { websiteUrl: lead.websiteUrl, tipo: 'REDE_SOCIAL_OU_AGREGADOR' },
          provider: PROVIDER_MAPS, sourceType: 'LISTAGEM_PUBLICA', collectedAt: lead.createdAt,
          explanation: 'O campo de site da listagem pública aponta para rede social ou agregador.',
          limitations: ['O perfil pode ter outro endereço de site que a coleta não trouxe.'],
          confidence: 0.7,
        });
      }
      if (lead.websiteStatus !== 'OWN_DOMAIN' || !lead.websiteUrl) {
        return notVerified(5, 'Nenhum site informado na coleta.', 'A coleta não trouxe site; isso não prova que o perfil não tenha um.', 'Conferir no perfil se há site e, se não houver, publicar um domínio próprio.');
      }
      if (!siteCheck || siteCheck.status === 'SKIPPED') {
        return outcome(5, {
          status: 'PARTIAL', score: null,
          observed: `Domínio próprio informado na listagem (${lead.websiteUrl}); verificação técnica não executada.`,
          recommendation: 'Executar a verificação técnica (resposta, indexabilidade e dados estruturados).',
          evidenceStatus: 'PARTIALLY_VERIFIED',
          value: { websiteUrl: lead.websiteUrl },
          provider: PROVIDER_MAPS, sourceType: 'LISTAGEM_PUBLICA', collectedAt: lead.createdAt,
          explanation: 'Há domínio próprio na listagem, mas nada foi verificado no site.',
          limitations: ['A presença de um domínio não comprova que ele é indexável nem que tem LocalBusiness.'],
          confidence: 0.3,
        });
      }
      if (siteCheck.status !== 'OK') {
        return outcome(5, {
          status: 'PARTIAL', score: null,
          observed: `Domínio próprio informado (${lead.websiteUrl}); a verificação técnica não obteve a página: ${siteCheck.failureReason ?? 'sem resposta'}.`,
          recommendation: 'Conferir se o site está no ar e acessível publicamente.',
          evidenceStatus: 'PARTIALLY_VERIFIED',
          value: { status: siteCheck.status, httpStatus: siteCheck.httpStatus },
          provider: PROVIDER_SITE, sourceType: 'VERIFICACAO_HTTP', reference: siteCheck.requestedUrl ?? undefined, collectedAt: siteCheck.checkedAt,
          explanation: 'A página não pôde ser lida; o resultado pode ser transitório ou bloqueio do servidor.',
          limitations: ['Uma falha pontual de acesso não prova que o site esteja fora do ar.'],
          confidence: 0.3,
        });
      }
      const blocked = siteCheck.noindex === true || siteCheck.robotsTxt === 'DISALLOWED';
      const schema = siteCheck.localBusiness;
      const base = {
        value: { finalUrl: siteCheck.finalUrl, noindex: siteCheck.noindex, robotsTxt: siteCheck.robotsTxt, localBusinessTypes: schema?.types ?? [] },
        provider: PROVIDER_SITE, sourceType: 'VERIFICACAO_HTTP', reference: siteCheck.finalUrl ?? undefined, collectedAt: siteCheck.checkedAt,
      };
      const indexNote = 'A indexação efetiva no Google não foi verificada (exige o Search Console do proprietário); só a possibilidade técnica de indexar.';
      if (blocked) {
        return outcome(5, {
          ...base, status: 'FAIL', score: 20,
          observed: 'O site bloqueia a indexação (noindex ou robots.txt).',
          recommendation: 'Remover o bloqueio de indexação das páginas que devem aparecer no Google.',
          evidenceStatus: 'VERIFIED', explanation: 'A página respondeu e traz diretiva que impede a indexação.', limitations: [indexNote], confidence: 0.8,
        });
      }
      if (schema && siteCheck.robotsTxt !== 'UNKNOWN') {
        return outcome(5, {
          ...base, status: 'PASS', score: 100,
          observed: `Site respondeu, sem bloqueio de indexação, com dados estruturados ${schema.types.join(', ')}.`,
          recommendation: 'Manter os dados estruturados e conferir periodicamente com a ferramenta de resultados avançados do Google.',
          evidenceStatus: 'VERIFIED',
          explanation: 'Resposta HTTP 2xx, sem noindex, robots.txt sem bloqueio e JSON-LD LocalBusiness lido no HTML.',
          limitations: [indexNote, 'A validade completa do schema não foi testada na ferramenta oficial do Google.'], confidence: 0.8,
        });
      }
      return outcome(5, {
        ...base, status: 'PARTIAL', score: schema ? null : 60,
        observed: schema
          ? 'Site respondeu e traz LocalBusiness, mas o robots.txt não pôde ser verificado.'
          : 'Site respondeu e não bloqueia indexação, mas nenhum dado estruturado LocalBusiness foi encontrado no HTML inicial.',
        recommendation: schema ? 'Conferir o robots.txt do site.' : 'Publicar JSON-LD LocalBusiness e testá-lo na ferramenta de resultados avançados do Google.',
        evidenceStatus: 'PARTIALLY_VERIFIED',
        explanation: schema ? 'Componentes do critério comprovados parcialmente.' : 'O site está no ar e é indexável tecnicamente; o schema não foi encontrado.',
        limitations: [indexNote, ...(schema ? [] : ['Dados estruturados injetados por JavaScript não aparecem no HTML inicial e podem existir.'])], confidence: 0.5,
      });
    }

    case 6: {
      const origin = geoCoverage(ctx.battlefield);
      if (origin.status === 'SIMULATED') return simulated(6, 'Líderes do território');
      const leaders = (ctx.battlefield.points ?? []).filter((p) => p.readStatus === 'VALID' && p.pointLeader && p.pointLeader.placeId !== lead.placeId);
      if (leaders.length < 10 || !lead.primaryCategory) {
        return notVerified(6, 'Poucos líderes identificados na grade para comparar a categoria.', 'Não há base suficiente de líderes territoriais para comparar a categoria principal.', 'Comparar a categoria principal com a dos líderes após uma medição com mais leituras.');
      }
      const same = leaders.filter((p) => categoriesMatch(p.pointLeader?.primaryCategory ?? '', lead.primaryCategory)).length;
      const share = same / leaders.length;
      const result = share >= 0.5 ? { status: 'PASS' as const, score: 100 } : share >= 0.2 ? { status: 'PARTIAL' as const, score: 60 } : { status: 'FAIL' as const, score: 25 };
      return outcome(6, {
        ...result,
        observed: `Categoria "${lead.primaryCategory}" coincide com a categoria do líder em ${same} de ${leaders.length} pontos com líder identificado (${Math.round(share * 100)}%).`,
        recommendation: result.status === 'PASS' ? 'Preservar a categoria principal.' : 'Avaliar a categoria principal à luz das categorias dos líderes do território.',
        evidenceStatus: 'VERIFIED',
        value: { leaderPointsCompared: leaders.length, sameCategoryPoints: same },
        provider: PROVIDER_MAPS, sourceType: 'COMPARACAO_COM_LIDERES', reference: ctx.battlefield.roundId, collectedAt: ctx.battlefield.executedAt,
        explanation: 'A categoria principal do lead foi comparada à categoria do líder de cada ponto da grade.',
        limitations: ['Categorias dos líderes vêm da listagem pública; mudar de categoria exige análise do negócio.'], confidence: 0.7,
      });
    }

    case 7: {
      const count = lead.secondaryCategories.length;
      if (count === 0) {
        return notVerified(7, 'Nenhuma categoria secundária informada na coleta.', 'A coleta não trouxe categorias adicionais; isso não prova que o perfil não as tenha.', 'Conferir no painel as categorias adicionais do perfil.');
      }
      const result = count >= 3 ? { status: 'PASS' as const, score: 100 } : { status: 'PARTIAL' as const, score: 55 };
      return outcome(7, {
        ...result,
        observed: `${count} categorias secundárias na listagem.`,
        recommendation: count >= 3 ? 'Manter as categorias secundárias coerentes com os serviços.' : 'Avaliar categorias secundárias presentes nos líderes do território.',
        evidenceStatus: 'PARTIALLY_VERIFIED',
        value: { secondaryCategories: lead.secondaryCategories.slice(0, 8) },
        provider: PROVIDER_MAPS, sourceType: 'LISTAGEM_PUBLICA', collectedAt: lead.createdAt,
        explanation: 'Categorias lidas da listagem pública.',
        limitations: ['Não foi confirmado que a lista pública está completa em relação ao painel do proprietário.'], confidence: 0.5,
      });
    }

    case 8:
      return notVerified(8, 'Catálogo de serviços não coletado.', 'Nenhuma fonte desta auditoria informa os serviços cadastrados no perfil.', 'Conferir no painel o catálogo de serviços e suas descrições.', ['Exige acesso do proprietário (Business Profile API) ou um provedor que exponha os serviços.']);

    case 9: {
      if (lead.businessHoursConfigured && lead.provenance?.businessHoursConfigured !== 'UNKNOWN') {
        return outcome(9, {
          status: 'PARTIAL', score: 85,
          observed: 'Horário de funcionamento presente na listagem.',
          recommendation: 'Conferir horários especiais de feriados e os atributos operacionais.',
          evidenceStatus: 'PARTIALLY_VERIFIED',
          value: { hoursPresent: true },
          provider: PROVIDER_MAPS, sourceType: 'LISTAGEM_PUBLICA', collectedAt: lead.createdAt,
          explanation: 'Há horário na listagem pública.',
          limitations: ['Feriados e atributos operacionais não foram coletados.'], confidence: 0.5,
        });
      }
      return notVerified(9, 'Horário e atributos não informados na coleta.', 'A coleta não trouxe horários; isso não prova que não estejam configurados.', 'Conferir no painel os horários, feriados e atributos.');
    }

    case 10: {
      if (!ratingCollected(lead)) {
        return notVerified(10, 'Nota pública não comprovada para este perfil.', 'A nota e o total de avaliações estão ausentes ou coincidem com valores padrão do sistema.', 'Conferir a nota diretamente no perfil.');
      }
      const result = band(lead.rating, 4.6, 4.2, [100, 65, 25]);
      return outcome(10, {
        ...result,
        observed: `Nota ${fmt(lead.rating)} com ${lead.totalReviews} avaliações na listagem pública.`,
        recommendation: result.status === 'PASS' ? 'Manter o padrão de atendimento e o pedido espontâneo de avaliações.' : 'Entender os motivos das avaliações mais baixas e responder aos clientes.',
        evidenceStatus: 'VERIFIED',
        value: { rating: lead.rating, totalReviews: lead.totalReviews },
        provider: PROVIDER_MAPS, sourceType: 'LISTAGEM_PUBLICA', collectedAt: lead.createdAt,
        explanation: 'Nota e total de avaliações lidos da listagem pública.',
        limitations: ['A nota pública é arredondada pelo Google.'], confidence: 0.9,
      });
    }

    case 11: {
      const top = rivals.topDominators?.[0];
      const territory = geoCoverage(ctx.battlefield);
      if (territory.status === 'SIMULATED') return simulated(11, 'Líder do território');
      if (!ratingCollected(lead) || !top || top.totalReviews === null || leaderValuesAreDefault(top.rating, top.totalReviews)) {
        return notVerified(11, 'Comparação com o líder não comprovada.', 'Faltam avaliações reais do próprio perfil ou do líder (valores ausentes ou padrão do sistema).', 'Comparar o volume de avaliações diretamente com o líder do território.');
      }
      const result = lead.totalReviews >= top.totalReviews * 0.7 ? { status: 'PASS' as const, score: 100 } : lead.totalReviews >= top.totalReviews * 0.25 ? { status: 'PARTIAL' as const, score: 45 } : { status: 'FAIL' as const, score: 15 };
      return outcome(11, {
        ...result,
        observed: `${lead.totalReviews} avaliações contra ${top.totalReviews} do líder territorial (${top.businessName}).`,
        recommendation: result.status === 'PASS' ? 'Manter o ritmo de avaliações.' : 'Criar uma rotina de pedido de avaliações a clientes reais, sem incentivo.',
        evidenceStatus: 'VERIFIED',
        value: { own: lead.totalReviews, leader: top.totalReviews, leaderName: top.businessName },
        provider: PROVIDER_MAPS, sourceType: 'LISTAGEM_PUBLICA', reference: ctx.battlefield.roundId, collectedAt: ctx.battlefield.executedAt,
        explanation: 'Totais de avaliações lidos da listagem pública do perfil e do líder do território.',
        limitations: ['Volume de avaliações não implica, sozinho, a posição no ranking.'], confidence: 0.85,
      });
    }

    case 12: {
      if (detectReputationOrigin(reputation, lead.placeId) === 'SIMULATED') return simulated(12, 'Avaliações recentes');
      const analysis = reputation.reviewsAvailability?.analysis ?? null;
      if (!analysis || analysis.sampleSize === 0) {
        return notVerified(12, 'Ritmo de novas avaliações não comprovado.', reputation.reviewsAvailability?.reason ?? 'Nenhuma fonte de avaliações datadas foi usada nesta auditoria.', 'Obter avaliações com data (fonte autorizada) ou conferir no painel do perfil.', ['O total de avaliações não permite inferir o ritmo dos últimos 30 dias.']);
      }
      if (!analysis.windowCovered || analysis.countLast30Days === null) {
        return notVerified(12, `Amostra de ${analysis.sampleSize} avaliações não cobre os 30 dias com datas confiáveis.`, 'Sem cobertura completa da janela, o número de novas avaliações seria apenas um mínimo.', 'Ampliar a amostra de avaliações ou conferir no painel do perfil.', analysis.limitations);
      }
      const result = band(analysis.countLast30Days, 8, 3, [100, 55, 15]);
      return outcome(12, {
        ...result,
        observed: `${analysis.countLast30Days} novas avaliações nos últimos 30 dias (amostra de ${analysis.sampleSize}).`,
        recommendation: result.status === 'PASS' ? 'Manter o ritmo de avaliações espontâneas.' : 'Criar uma rotina para pedir avaliações a clientes reais, sem incentivo.',
        evidenceStatus: 'VERIFIED',
        value: { countLast30Days: analysis.countLast30Days, sampleSize: analysis.sampleSize },
        provider: reputation.reviewsAvailability?.provider ?? PROVIDER_REVIEWS, sourceType: 'AVALIACOES_DATADAS', collectedAt: reputation.reviewsAvailability?.collectedAt ?? reputation.extractedAt,
        explanation: 'Avaliações datadas cobrem integralmente a janela de 30 dias.',
        limitations: analysis.limitations, confidence: 0.75,
      });
    }

    case 13: {
      if (detectReputationOrigin(reputation, lead.placeId) === 'SIMULATED') return simulated(13, 'Respostas às avaliações');
      const analysis = reputation.reviewsAvailability?.analysis ?? null;
      if (!analysis || analysis.sampleSize === 0 || analysis.ownerResponseRatePercent === null) {
        return notVerified(13, 'Taxa de resposta do proprietário não comprovada.', reputation.reviewsAvailability?.reason ?? 'Nenhuma fonte com respostas do proprietário foi usada nesta auditoria.', 'Conferir no painel a taxa de resposta às avaliações.', analysis?.limitations ?? []);
      }
      const rate = analysis.ownerResponseRatePercent;
      const result = band(rate, 90, 50, [100, 50, 10]);
      return outcome(13, {
        ...result,
        observed: `${fmt(rate)}% das ${analysis.sampleSize} avaliações da amostra têm resposta do proprietário.`,
        recommendation: result.status === 'PASS' ? 'Manter a resposta a todas as avaliações.' : 'Responder às avaliações sem resposta, com cordialidade e sem dados pessoais.',
        evidenceStatus: analysis.sampleIsComplete ? 'VERIFIED' : 'PARTIALLY_VERIFIED',
        value: { ownerResponseRatePercent: rate, sampleSize: analysis.sampleSize, sampleIsComplete: analysis.sampleIsComplete },
        provider: reputation.reviewsAvailability?.provider ?? PROVIDER_REVIEWS, sourceType: 'AVALIACOES_DATADAS', collectedAt: reputation.reviewsAvailability?.collectedAt ?? reputation.extractedAt,
        explanation: analysis.sampleIsComplete ? 'A amostra contém todas as avaliações do perfil.' : 'Taxa calculada sobre uma amostra, não sobre todas as avaliações do perfil.',
        limitations: analysis.limitations, confidence: analysis.sampleIsComplete ? 0.8 : 0.5,
      });
    }

    case 14: {
      if (detectReputationOrigin(reputation, lead.placeId) === 'SIMULATED') return simulated(14, 'Textos de avaliações');
      const analysis = reputation.reviewsAvailability?.analysis ?? null;
      if (!analysis || analysis.textsAvailable < 5 || analysis.reviewsMentioningTerms === null) {
        return notVerified(14, 'Termos de serviço nas avaliações não comprovados.', 'Não há textos reais de avaliações em quantidade suficiente (mínimo de 5).', 'Ler as avaliações do perfil e verificar se citam o serviço realizado.', analysis?.limitations ?? []);
      }
      const share = analysis.reviewsMentioningTerms / analysis.textsAvailable;
      const result = share >= 0.5 ? { status: 'PASS' as const, score: 100 } : share >= 0.2 ? { status: 'PARTIAL' as const, score: 60 } : { status: 'FAIL' as const, score: 30 };
      return outcome(14, {
        ...result,
        observed: `${analysis.reviewsMentioningTerms} de ${analysis.textsAvailable} avaliações com texto citam termos do serviço.`,
        recommendation: 'Ao pedir avaliações, convidar o cliente a descrever o serviço realizado, sem induzir o texto.',
        evidenceStatus: analysis.sampleIsComplete ? 'VERIFIED' : 'PARTIALLY_VERIFIED',
        value: { mentioning: analysis.reviewsMentioningTerms, texts: analysis.textsAvailable },
        provider: reputation.reviewsAvailability?.provider ?? PROVIDER_REVIEWS, sourceType: 'TEXTO_DE_AVALIACOES', collectedAt: reputation.reviewsAvailability?.collectedAt ?? reputation.extractedAt,
        explanation: 'Textos reais da amostra foram comparados a termos derivados da categoria e da palavra-chave.',
        limitations: [...analysis.limitations, 'A correspondência é por palavras; não mede relevância semântica.'], confidence: analysis.sampleIsComplete ? 0.6 : 0.4,
      });
    }

    case 15:
    case 16:
    case 17:
    case 18: {
      const labels: Record<number, string> = { 15: 'Fotos', 16: 'Vídeos', 17: 'Última mídia', 18: 'Publicações' };
      if (detectVitrineOrigin(vitrine, lead.placeId) === 'SIMULATED') return simulated(itemNumber, labels[itemNumber] as string);
      const provided = vitrine.availability?.fieldsProvided ?? [];
      const meta = { provider: vitrine.availability?.provider ?? undefined, sourceType: 'PERFIL_PUBLICO', collectedAt: vitrine.availability?.collectedAt ?? undefined };
      const unavailable = (what: string, field: string): CriterionOutcome =>
        notVerified(itemNumber, `${what} não coletados.`, vitrine.availability?.reason ?? 'Nenhuma fonte pública desta auditoria informa este dado.', `Conferir no painel do perfil (${what.toLowerCase()}).`, [`Campo "${field}" não fornecido pela fonte; exige acesso do proprietário ou provedor específico.`]);

      if (itemNumber === 15) {
        if (!provided.includes('totalPhotosCount') || vitrine.totalPhotosCount === null) return unavailable('Fotos', 'totalPhotosCount');
        const result = band(vitrine.totalPhotosCount, 40, 15, [100, 55, 20]);
        return outcome(15, { ...result, ...meta, observed: `${vitrine.totalPhotosCount} fotos no perfil.`, recommendation: 'Publicar fotos autênticas do local, da equipe e dos serviços.', evidenceStatus: 'VERIFIED', value: { totalPhotosCount: vitrine.totalPhotosCount }, explanation: 'Contagem de fotos informada pela fonte de dados.', limitations: ['A contagem não distingue qualidade nem origem (proprietário x clientes).'], confidence: 0.7 });
      }
      if (itemNumber === 16) {
        if (!provided.includes('totalVideosCount') || vitrine.totalVideosCount === null) return unavailable('Vídeos', 'totalVideosCount');
        const result = band(vitrine.totalVideosCount, 3, 1, [100, 50, 0]);
        return outcome(16, { ...result, ...meta, observed: `${vitrine.totalVideosCount} vídeo(s) no perfil.`, recommendation: 'Publicar vídeos curtos e autênticos.', evidenceStatus: 'VERIFIED', value: { totalVideosCount: vitrine.totalVideosCount }, explanation: 'Contagem de vídeos informada pela fonte de dados.', limitations: [], confidence: 0.7 });
      }
      if (itemNumber === 17) {
        if (!provided.includes('lastMediaUploadedAt') || vitrine.daysSinceLastMedia === null) return unavailable('Data da última mídia', 'lastMediaUploadedAt');
        const result = band(-vitrine.daysSinceLastMedia, -14, -45, [100, 50, 15]);
        return outcome(17, { ...result, ...meta, observed: `Última mídia publicada há ${vitrine.daysSinceLastMedia} dias.`, recommendation: 'Manter uma rotina de novas fotos.', evidenceStatus: 'VERIFIED', value: { daysSinceLastMedia: vitrine.daysSinceLastMedia }, explanation: 'Data da mídia mais recente informada pela fonte.', limitations: [], confidence: 0.7 });
      }
      if (!provided.includes('lastPostPublishedAt') || vitrine.daysSinceLastPost === null) return unavailable('Publicações (Google Posts)', 'lastPostPublishedAt');
      const result = band(-vitrine.daysSinceLastPost, -7, -30, [100, 45, 10]);
      return outcome(18, { ...result, ...meta, observed: `Última publicação há ${vitrine.daysSinceLastPost} dias.`, recommendation: 'Manter uma rotina de publicações.', evidenceStatus: 'VERIFIED', value: { daysSinceLastPost: vitrine.daysSinceLastPost }, explanation: 'Data da publicação mais recente informada pela fonte.', limitations: [], confidence: 0.7 });
    }

    case 19:
      return geoOutcome(19, ctx, (m) => {
        const percent = m.top3Percent ?? 0;
        const r = band(percent, 35, 10, [100, 50, 15]);
        return { ...r, observed: `${m.top3Points} pontos no Top 3 (${fmt(percent)}% de ${m.validPoints} pontos válidos).`, recommendation: 'Converter pontos entre as posições 4 e 20 em Top 3 com reputação e relevância locais.' };
      });
    case 20:
      return geoOutcome(20, ctx, (m) => {
        const percent = m.top7Percent ?? 0;
        const r = band(percent, 55, 20, [100, 55, 20]);
        return { ...r, observed: `${fmt(percent)}% dos ${m.validPoints} pontos válidos até a 7ª posição.`, recommendation: 'Priorizar os pontos entre as posições 4 e 7 para entrar no Top 3.' };
      });
    case 21:
      return geoOutcome(21, ctx, (m) => {
        const percent = m.outsideTop20Percent ?? 0;
        const r = percent <= 20 ? { score: 100, status: 'PASS' as const } : percent <= 50 ? { score: 45, status: 'PARTIAL' as const } : { score: 10, status: 'FAIL' as const };
        return { ...r, observed: `${m.outsideTop20Points} pontos fora do Top 20 (${fmt(percent)}% dos ${m.validPoints} pontos válidos).`, recommendation: 'Atuar nas regiões em que a empresa não aparece, com prova de atendimento real na área.' };
      });
    default:
      throw new Error(`Critério inexistente: ${itemNumber}`);
  }
}

export function assessAllCriteria(ctx: CriteriaContext): readonly CriterionOutcome[] {
  return CRITERIA_META.map((meta) => assessCriterion(meta.itemNumber, ctx));
}
