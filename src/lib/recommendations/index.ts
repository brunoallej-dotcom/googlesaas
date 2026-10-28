import type {
  BattlefieldMetrics,
  FrontierLead,
  JudgeChecklistItem,
  JudgeTechnicalSheet,
  RivalsMetrics,
  TacticalWavePriority,
} from '@/types/gmn';
import { computeTerritoryRankMetrics } from '@/lib/battlefield-metrics';

/**
 * Recomendações ancoradas em evidência (Fase 4).
 *
 * Cada recomendação nasce de um critério do Juiz e do status da sua evidência:
 *  - PROVEN_ACTION: evidência VERIFICADA mostra o problema ou a oportunidade;
 *  - HYPOTHESIS: depende de dado ausente, parcial ou simulado; validar antes de executar;
 *  - NOT_APPLICABLE: o critério provavelmente não se aplica ao negócio.
 *
 * Nada aqui promete posição, vendas ou ganho percentual, nem atribui causalidade de ranking a
 * fatores apenas correlacionados. Critérios já atendidos viram notas de "manter", não ações.
 */
export type RecommendationClass = 'PROVEN_ACTION' | 'HYPOTHESIS' | 'NOT_APPLICABLE';

export interface EvidenceRecommendation {
  readonly code: string;
  readonly wave: TacticalWavePriority;
  readonly title: string;
  readonly problem: string;
  readonly evidenceSummary: string;
  readonly evidenceCriteria: readonly number[];
  readonly justification: string;
  readonly priority: string;
  readonly timeframe: string;
  readonly action: string;
  readonly objective: string;
  readonly indicator: string;
  readonly confidence: number;
  readonly classification: RecommendationClass;
  readonly effort: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface RecommendationSet {
  readonly recommendations: readonly EvidenceRecommendation[];
  readonly maintain: readonly string[];
}

export const WAVE_META: Record<TacticalWavePriority, { readonly title: string; readonly timeframe: string; readonly priority: string; readonly objective: string }> = {
  P0: { title: 'Onda P0 — Correções críticas e oportunidades imediatas', timeframe: 'Dias 1 a 7', priority: 'Imediata', objective: 'Tratar o que a evidência mostra de mais urgente e confirmar o que ainda não foi comprovado.' },
  P1: { title: 'Onda P1 — Perfil, serviços, conteúdo e conversão', timeframe: 'Dias 8 a 30', priority: 'Alta', objective: 'Otimizar o perfil e atuar onde a presença territorial já existe.' },
  P2: { title: 'Onda P2 — Reputação, presença digital e expansão', timeframe: 'Dias 31 a 60', priority: 'Média', objective: 'Consolidar a reputação e a presença digital com base nos dados comprovados.' },
  P3: { title: 'Onda P3 — Monitoramento e evolução competitiva', timeframe: 'Dias 61 a 90', priority: 'Contínua', objective: 'Acompanhar a evolução e reagir às mudanças do território.' },
};

export const RECOMMENDATION_DISCLAIMER =
  'Recomendações de trabalho, não garantias: o ranking no Google depende de fatores que a plataforma não controla.';

/** Termos que nunca devem aparecer em recomendações. */
const PROMISE_PATTERNS: readonly RegExp[] = [
  /\bgarant(?:ia|imos|ido|ida|idos|idas|e|em)\b/i,
  /\d+\s*%\s*(a|ate|até|-|–)\s*\d+\s*%/i,
  /aumento de \d+/i,
  /triplicar/i,
  /dobrar/i,
  /score global/i,
];

export function recommendationContainsPromise(text: string): boolean {
  return PROMISE_PATTERNS.some((pattern) => pattern.test(text));
}

interface Ctx {
  readonly lead: FrontierLead;
  readonly judge: JudgeTechnicalSheet;
  readonly battlefield: BattlefieldMetrics;
  readonly rivals: RivalsMetrics;
}

const item = (ctx: Ctx, n: number): JudgeChecklistItem | undefined => ctx.judge.checklist21Items.find((entry) => entry.itemNumber === n);
const status = (entry: JudgeChecklistItem | undefined): 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'NOT_VERIFIED' | 'SIMULATED' =>
  entry?.evidence?.status ?? 'NOT_VERIFIED';
const passed = (entry: JudgeChecklistItem | undefined): boolean => entry?.status === 'PASS' || entry?.status === 'EXEMPT_BY_CONTEXT_RULE';

type Draft = Omit<EvidenceRecommendation, 'priority' | 'timeframe'>;

function make(draft: Draft): EvidenceRecommendation {
  const meta = WAVE_META[draft.wave];
  return { ...draft, priority: meta.priority, timeframe: meta.timeframe };
}

/** Texto padrão para o que não pôde ser comprovado. */
const UNPROVEN = 'Não foi possível comprovar esta informação nesta auditoria.';

export function buildRecommendations(ctx: Ctx): RecommendationSet {
  const out: EvidenceRecommendation[] = [];
  const maintain: string[] = [];

  /** Cria a recomendação de um critério: verificado e não atendido vira ação; o resto, hipótese. */
  const fromCriterion = (
    n: number,
    base: Omit<Draft, 'classification' | 'confidence' | 'evidenceSummary' | 'evidenceCriteria' | 'justification'> & { readonly justify: (observed: string) => string; readonly hypothesis: string }
  ): void => {
    const entry = item(ctx, n);
    const st = status(entry);
    if (st === 'VERIFIED' && passed(entry)) {
      maintain.push(`${entry?.title ?? `Critério ${n}`}: ${entry?.evidenceObserved ?? ''} Manter.`.trim());
      return;
    }
    const { justify, hypothesis, ...rest } = base;
    if (st === 'VERIFIED') {
      out.push(make({ ...rest, classification: 'PROVEN_ACTION', confidence: entry?.evidence?.confidence ?? 0.7, evidenceSummary: entry?.evidenceObserved ?? '', evidenceCriteria: [n], justification: justify(entry?.evidenceObserved ?? '') }));
      return;
    }
    const observed = st === 'PARTIALLY_VERIFIED' ? `${entry?.evidenceObserved ?? ''} ${(entry?.evidence?.limitations ?? [])[0] ?? ''}`.trim() : UNPROVEN;
    out.push(make({ ...rest, classification: 'HYPOTHESIS', confidence: st === 'PARTIALLY_VERIFIED' ? (entry?.evidence?.confidence ?? 0.4) : 0.2, evidenceSummary: observed, evidenceCriteria: [n], justification: hypothesis }));
  };

  fromCriterion(13, {
    code: 'P0_ACT_01', wave: 'P0', effort: 'LOW',
    title: 'Responder as avaliações pendentes',
    problem: 'Respostas do proprietário às avaliações.',
    action: 'Responder as avaliações sem resposta com atenção ao que o cliente relatou, sem expor dados pessoais.',
    objective: 'Mostrar gestão ativa do perfil e atender os clientes que avaliaram.',
    indicator: 'Percentual de avaliações respondidas (painel do perfil).',
    justify: (o) => `${o} Responder as pendentes é a ação mais rápida para melhorar este indicador.`,
    hypothesis: 'Conferir no painel quantas avaliações estão sem resposta e, havendo pendências, respondê-las.',
  });

  // WhatsApp: nunca é "verificado"; o link público não comprova atendimento.
  {
    const entry = item(ctx, 4);
    if (status(entry) === 'PARTIALLY_VERIFIED') {
      out.push(make({
        code: 'P0_ACT_02', wave: 'P0', effort: 'LOW', classification: 'HYPOTHESIS', confidence: entry?.evidence?.confidence ?? 0.4,
        title: 'Confirmar que o canal de WhatsApp atende mensagens',
        problem: 'Existe um número ou link de WhatsApp, mas o atendimento não foi confirmado.',
        evidenceSummary: entry?.evidenceObserved ?? '', evidenceCriteria: [4],
        justification: 'A existência do link ou do número não comprova uma conta ativa que responda mensagens.',
        action: 'Testar o número, confirmar o atendimento e padronizar o link com mensagem inicial.',
        objective: 'Facilitar o contato direto de quem encontra o perfil.',
        indicator: 'Contatos recebidos por WhatsApp (com link rastreável).',
      }));
    } else {
      out.push(make({
        code: 'P0_ACT_02', wave: 'P0', effort: 'LOW', classification: 'HYPOTHESIS', confidence: 0.2,
        title: 'Confirmar o canal de WhatsApp do perfil',
        problem: 'Nenhuma fonte desta auditoria indica um canal de WhatsApp.',
        evidenceSummary: UNPROVEN, evidenceCriteria: [4],
        justification: 'A ausência do dado na coleta não prova que o canal não exista.',
        action: 'Conferir com o proprietário se há WhatsApp de atendimento e, se houver, vinculá-lo ao perfil.',
        objective: 'Facilitar o contato direto de quem encontra o perfil.',
        indicator: 'Contatos recebidos por WhatsApp (com link rastreável).',
      }));
    }
  }

  fromCriterion(18, {
    code: 'P0_ACT_03', wave: 'P0', effort: 'LOW',
    title: 'Retomar as publicações do perfil (Google Posts)',
    problem: 'Frequência de publicações do perfil.',
    action: 'Publicar atualizações com foto original e botão de contato, em ritmo que a equipe consiga manter.',
    objective: 'Manter o perfil com informações recentes para quem o visita.',
    indicator: 'Data da última publicação e número de publicações por mês.',
    justify: (o) => `${o} Retomar as publicações mantém o perfil atualizado.`,
    hypothesis: 'Conferir no painel a data da última publicação e, se o perfil estiver inativo, retomar as publicações.',
  });

  // Ponto central da grade
  {
    const geo = item(ctx, 19);
    const center = ctx.battlefield.points?.find((p) => p.rowIndex === 3 && p.colIndex === 3);
    if (status(geo) !== 'NOT_VERIFIED' && status(geo) !== 'SIMULATED' && center?.readStatus === 'VALID' && center.targetRank === null) {
      out.push(make({
        code: 'TERR_COMPANY_POINT', wave: 'P0', effort: 'MEDIUM', classification: 'HYPOTHESIS', confidence: 0.5,
        title: 'Entender a posição no ponto onde a empresa está localizada',
        problem: 'No ponto central da grade a empresa não aparece entre as 20 primeiras posições.',
        evidenceSummary: 'Leitura do ponto central da grade: fora do Top 20 (coletado).', evidenceCriteria: [19, 21],
        justification: 'A causa não foi determinada; conferir no Google Maps, para a mesma palavra-chave, a categoria principal, o número de concorrentes e o aparecimento do perfil.',
        action: 'Repetir a busca no local, comparar com os líderes e registrar as diferenças observadas.',
        objective: 'Esclarecer por que a empresa não aparece no próprio endereço.',
        indicator: 'Posição lida no ponto central na próxima medição.',
      }));
    }
  }

  // Serviços e categorias
  {
    const sec = item(ctx, 7);
    const serv = item(ctx, 8);
    const allOk = passed(sec) && status(sec) !== 'NOT_VERIFIED';
    if (allOk && status(serv) === 'NOT_VERIFIED') {
      // serviços seguem não verificados: hipótese
    }
    out.push(make({
      code: 'P1_ACT_01', wave: 'P1', effort: 'MEDIUM', classification: 'HYPOTHESIS', confidence: 0.3,
      title: 'Revisar serviços e categorias do perfil',
      problem: 'Serviços cadastrados e categorias secundárias.',
      evidenceSummary: status(sec) === 'NOT_VERIFIED' ? UNPROVEN : `${sec?.evidenceObserved ?? ''} A lista de serviços não foi coletada.`.trim(),
      evidenceCriteria: [7, 8],
      justification: 'A lista de serviços não pôde ser comprovada e a de categorias vem da listagem pública, sem confirmação de que esteja completa.',
      action: 'Conferir no painel os serviços e categorias e completar o que faltar, com descrições fiéis ao que a empresa faz.',
      objective: 'Garantir que o perfil descreva todos os serviços prestados.',
      indicator: 'Número de serviços e categorias cadastrados (painel do perfil).',
    }));
  }

  fromCriterion(15, {
    code: 'P1_ACT_02', wave: 'P1', effort: 'MEDIUM',
    title: 'Atualizar fotos e vídeos do perfil',
    problem: 'Acervo e recência de fotos e vídeos.',
    action: 'Complementar o acervo com imagens autênticas do local, da equipe e dos serviços.',
    objective: 'Apresentar o negócio com imagens reais e recentes.',
    indicator: 'Total de fotos e vídeos e data da última mídia (perfil).',
    justify: (o) => `${o} Ampliar o acervo com imagens autênticas.`,
    hypothesis: 'Conferir no perfil o acervo de fotos e vídeos e complementar com imagens próprias e recentes.',
  });

  // Categoria principal x líderes
  {
    const entry = item(ctx, 6);
    if (status(entry) === 'VERIFIED' && !passed(entry)) {
      out.push(make({
        code: 'P1_ACT_03', wave: 'P1', effort: 'LOW', classification: 'PROVEN_ACTION', confidence: entry?.evidence?.confidence ?? 0.7,
        title: 'Comparar a categoria principal com a dos líderes do território',
        problem: 'A categoria principal difere da usada pela maioria dos líderes da grade.',
        evidenceSummary: entry?.evidenceObserved ?? '', evidenceCriteria: [6],
        justification: `${entry?.evidenceObserved ?? ''} A categoria deve refletir o negócio real; mudanças exigem análise antes.`,
        action: 'Listar as categorias dos três principais líderes e avaliar, com o proprietário, se a categoria atual descreve melhor o negócio.',
        objective: 'Alinhar a categoria principal ao que o negócio realmente é.',
        indicator: 'Categoria principal e secundárias revisadas e registradas.',
      }));
    }
  }

  // Territorial: priorizar pontos em que já aparece
  {
    const m = computeTerritoryRankMetrics(ctx.battlefield.points ?? []);
    const geo = item(ctx, 19);
    const reachable = m.top20Points - m.top3Points;
    if (status(geo) === 'VERIFIED' && reachable > 0) {
      out.push(make({
        code: 'TERR_FOCUS_PRESENCE', wave: 'P1', effort: 'MEDIUM', classification: 'PROVEN_ACTION', confidence: 0.8,
        title: 'Priorizar os pontos em que a empresa já aparece',
        problem: 'Pontos com presença fora do Top 3.',
        evidenceSummary: `${reachable} ${reachable === 1 ? 'ponto tem' : 'pontos têm'} a empresa entre as posições 4 e 20 (coletado, ${m.validPoints} pontos válidos).`,
        evidenceCriteria: [19, 20],
        justification: 'Onde a empresa já aparece, o esforço para subir de posição tende a ser menor do que onde não aparece. É uma priorização de trabalho, não uma promessa de resultado.',
        action: 'Concentrar o trabalho de reputação e de conteúdo local nas regiões desses pontos.',
        objective: 'Converter presença existente em posições melhores.',
        indicator: 'Número de pontos entre as posições 4 e 20 que passam ao Top 7 ou ao Top 3.',
      }));
    }
  }

  // Endereço
  {
    const entry = item(ctx, 3);
    if (entry?.status === 'EXEMPT_BY_CONTEXT_RULE') {
      out.push(make({
        code: 'P1_ACT_04', wave: 'P1', effort: 'LOW', classification: 'NOT_APPLICABLE', confidence: entry.evidence?.confidence ?? 0.4,
        title: 'Exibir o endereço público do perfil',
        problem: 'A listagem não traz endereço e o perfil foi tratado como atendimento no local do cliente (inferência).',
        evidenceSummary: entry.evidenceObserved, evidenceCriteria: [3],
        justification: 'Se o negócio atende apenas no local do cliente, ocultar o endereço segue as diretrizes do Google. A condição foi inferida, não confirmada.',
        action: 'Confirmar com o proprietário se o negócio recebe clientes no endereço; só então decidir.',
        objective: 'Evitar uma correção desnecessária.',
        indicator: 'Confirmação do modelo de atendimento registrada.',
      }));
    } else if (status(entry) === 'PARTIALLY_VERIFIED' && entry?.status === 'PARTIAL') {
      out.push(make({
        code: 'P1_ACT_04', wave: 'P1', effort: 'LOW', classification: 'HYPOTHESIS', confidence: entry.evidence?.confidence ?? 0.4,
        title: 'Conferir a consistência do endereço entre os canais',
        problem: 'A consistência do endereço entre perfil, site e cadastros não foi comprovada.',
        evidenceSummary: entry.evidenceObserved, evidenceCriteria: [3],
        justification: 'A existência de endereço público não prova que ele seja igual em todos os canais.',
        action: 'Comparar rua, número e CEP no perfil, no site e nos cadastros, e padronizar.',
        objective: 'Manter o mesmo endereço em todos os canais.',
        indicator: 'Endereço idêntico no perfil, no site e nos cadastros principais.',
      }));
    } else if (passed(entry) && status(entry) === 'VERIFIED') {
      maintain.push(`${entry?.title ?? 'Endereço'}: ${entry?.evidenceObserved ?? ''} Manter.`);
    }
  }

  // Avaliações: volume x líder e nota
  {
    const vol = item(ctx, 11);
    const rating = item(ctx, 10);
    if (status(vol) === 'VERIFIED' && !passed(vol)) {
      out.push(make({
        code: 'P2_ACT_01', wave: 'P2', effort: 'MEDIUM', classification: 'PROVEN_ACTION', confidence: vol?.evidence?.confidence ?? 0.8,
        title: 'Criar uma rotina para pedir avaliações a clientes reais',
        problem: 'Volume de avaliações abaixo do líder do território.',
        evidenceSummary: vol?.evidenceObserved ?? '', evidenceCriteria: [11, 10],
        justification: `${vol?.evidenceObserved ?? ''} Ambos os valores foram coletados na listagem pública. O pedido deve ser feito a clientes reais, sem incentivo nem texto induzido (políticas do Google).`,
        action: 'Incluir o pedido de avaliação no fim do atendimento, com link direto para avaliar.',
        objective: 'Aproximar o volume de avaliações do líder do território.',
        indicator: 'Novas avaliações por mês e total de avaliações em relação ao líder.',
      }));
    } else if (status(vol) !== 'VERIFIED') {
      out.push(make({
        code: 'P2_ACT_01', wave: 'P2', effort: 'MEDIUM', classification: 'HYPOTHESIS', confidence: 0.2,
        title: 'Comparar o volume de avaliações com o líder antes de definir uma meta',
        problem: 'A comparação com o líder não pôde ser comprovada.',
        evidenceSummary: UNPROVEN, evidenceCriteria: [11],
        justification: 'Faltam valores reais de avaliações do perfil ou do líder.',
        action: 'Conferir no Google Maps o total de avaliações do perfil e dos líderes do território.',
        objective: 'Definir uma meta com base em números reais.',
        indicator: 'Total de avaliações do perfil e do líder, com data da conferência.',
      }));
    } else {
      maintain.push(`${vol?.title ?? 'Volume de avaliações'}: ${vol?.evidenceObserved ?? ''} Manter o ritmo de pedidos.`);
    }
    if (status(rating) === 'VERIFIED' && !passed(rating)) {
      out.push(make({
        code: 'P2_ACT_03', wave: 'P2', effort: 'MEDIUM', classification: 'PROVEN_ACTION', confidence: rating?.evidence?.confidence ?? 0.8,
        title: 'Entender os motivos das avaliações de menor nota',
        problem: 'Nota pública abaixo da faixa de alta conversão considerada pelo Juiz.',
        evidenceSummary: rating?.evidenceObserved ?? '', evidenceCriteria: [10],
        justification: `${rating?.evidenceObserved ?? ''} A nota é arredondada pelo Google; ler as avaliações indica o que pode ser melhorado no atendimento.`,
        action: 'Ler as avaliações de menor nota, identificar padrões e tratá-los no atendimento; responder com cordialidade.',
        objective: 'Tratar as causas recorrentes de insatisfação.',
        indicator: 'Nota pública e nº de avaliações de 1 a 3 estrelas na próxima conferência.',
      }));
    } else if (status(rating) === 'VERIFIED') {
      maintain.push(`${rating?.title ?? 'Nota'}: ${rating?.evidenceObserved ?? ''} Manter.`);
    }
  }

  // Site
  {
    const entry = item(ctx, 5);
    const st = status(entry);
    if (st === 'VERIFIED' && passed(entry)) {
      maintain.push(`${entry?.title ?? 'Site'}: ${entry?.evidenceObserved ?? ''} Manter e conferir periodicamente.`);
    } else if (st === 'VERIFIED' && ctx.lead.websiteStatus === 'SOCIAL_LINK_ONLY') {
      out.push(make({
        code: 'P2_ACT_02', wave: 'P2', effort: 'HIGH', classification: 'PROVEN_ACTION', confidence: 0.7,
        title: 'Publicar um site em domínio próprio',
        problem: 'O link do perfil aponta para rede social ou agregador.',
        evidenceSummary: entry?.evidenceObserved ?? '', evidenceCriteria: [5],
        justification: 'Um site em domínio próprio permite vincular dados estruturados LocalBusiness ao perfil.',
        action: 'Publicar um site simples com nome, endereço, telefone e serviços, e vinculá-lo ao perfil.',
        objective: 'Ter uma presença digital própria e consistente com o perfil.',
        indicator: 'Site publicado, vinculado ao perfil e com dados estruturados validados.',
      }));
    } else if (st === 'VERIFIED') {
      out.push(make({
        code: 'P2_ACT_02', wave: 'P2', effort: 'MEDIUM', classification: 'PROVEN_ACTION', confidence: 0.8,
        title: 'Remover o bloqueio de indexação do site',
        problem: 'O site bloqueia a indexação (noindex ou robots.txt).',
        evidenceSummary: entry?.evidenceObserved ?? '', evidenceCriteria: [5],
        justification: entry?.evidenceObserved ?? '',
        action: 'Revisar a diretiva noindex e o robots.txt das páginas que devem aparecer no Google.',
        objective: 'Permitir que as páginas do negócio possam ser indexadas.',
        indicator: 'Resultado da inspeção da URL no Search Console do proprietário.',
      }));
    } else {
      out.push(make({
        code: 'P2_ACT_02', wave: 'P2', effort: 'MEDIUM', classification: 'HYPOTHESIS', confidence: st === 'PARTIALLY_VERIFIED' ? (entry?.evidence?.confidence ?? 0.4) : 0.2,
        title: 'Verificar os dados estruturados e a indexação do site',
        problem: 'Dados estruturados LocalBusiness e indexação não comprovados.',
        evidenceSummary: st === 'NOT_VERIFIED' ? UNPROVEN : (entry?.evidenceObserved ?? ''), evidenceCriteria: [5],
        justification: 'Dados injetados por JavaScript podem não aparecer na verificação, e a indexação efetiva só é confirmada no Search Console.',
        action: 'Testar a página na ferramenta de resultados avançados do Google e conferir a inspeção de URL no Search Console.',
        objective: 'Reforçar a ligação entre o site e o perfil do negócio.',
        indicator: 'Resultado do teste de resultados avançados do Google para o site.',
      }));
    }
  }

  // Invisibilidade territorial
  {
    const entry = item(ctx, 21);
    const m = computeTerritoryRankMetrics(ctx.battlefield.points ?? []);
    if (status(entry) === 'VERIFIED' && (m.outsideTop20Percent ?? 0) >= 50) {
      out.push(make({
        code: 'P3_ACT_01', wave: 'P3', effort: 'MEDIUM', classification: 'PROVEN_ACTION', confidence: 0.75,
        title: 'Manter uma campanha contínua de avaliações espontâneas',
        problem: 'A maior parte da grade não mostra a empresa entre as 20 primeiras posições.',
        evidenceSummary: entry?.evidenceObserved ?? '', evidenceCriteria: [21],
        justification: `${entry?.evidenceObserved ?? ''} Avaliações reais que descrevem o serviço fazem parte dos sinais de relevância local; sem incentivos, compra de avaliações ou texto induzido.`,
        action: 'Pedir avaliações a clientes atendidos nas regiões com baixa presença, convidando-os a descrever o serviço realizado.',
        objective: 'Ampliar os sinais de relevância nas áreas em que a empresa ainda não aparece.',
        indicator: 'Percentual de pontos fora das 20 primeiras posições na próxima medição comparável.',
      }));
    } else if (status(entry) === 'VERIFIED') {
      maintain.push('A invisibilidade territorial não é predominante nesta auditoria: manter o acompanhamento.');
    }
  }

  out.push(make({
    code: 'P3_ACT_02', wave: 'P3', effort: 'LOW', classification: 'PROVEN_ACTION', confidence: 0.9,
    title: 'Repetir a medição territorial todo mês',
    problem: 'A evolução só pode ser medida com medições repetidas e comparáveis.',
    evidenceSummary: `Medição de ${new Date(ctx.battlefield.executedAt).toLocaleDateString('pt-BR')} com ${ctx.battlefield.validPointsCount} pontos válidos.`,
    evidenceCriteria: [19, 20, 21],
    justification: 'A comparação histórica exige a mesma empresa, a mesma palavra-chave e a mesma grade (centro, passo e zoom).',
    action: 'Repetir a medição com os mesmos parâmetros a cada 30 dias.',
    objective: 'Acompanhar a evolução e reagir às mudanças dos concorrentes.',
    indicator: 'Pontos no Top 3 e no Top 7 e índice de posição, comparados à medição anterior comparável.',
  }));

  for (const rec of out) {
    const text = [rec.title, rec.problem, rec.justification, rec.action, rec.objective].join(' ');
    if (recommendationContainsPromise(text)) {
      throw new Error(`Recomendação ${rec.code} contém promessa ou termo proibido.`);
    }
  }
  return { recommendations: out, maintain };
}
