import type {
  AgentName,
  AuditPipelineStage,
  WebsitePresenceStatus,
} from '@/types/gmn';

export const WEBSITE_STATUS_LABEL: Record<WebsitePresenceStatus, string> = {
  OWN_DOMAIN: 'Domínio próprio',
  SOCIAL_LINK_ONLY: 'Apenas rede social',
  MISSING: 'Sem site',
};

export const AGENT_LABEL: Record<AgentName, string> = {
  HEAD_PROSPECTOR: 'Prospecção',
  MAESTRO: 'Maestro',
  REPUTATION: 'Reputação',
  VITRINE: 'Vitrine',
  BATTLEFIELD: 'Campo de Batalha',
  RIVALS: 'Rivais',
  JUDGE: 'Juiz',
  STRATEGIST: 'Estrategista',
  REVIEWER: 'Revisor',
  DIAGRAMMER: 'Diagramador',
};

export const STAGE_LABEL: Record<AuditPipelineStage, string> = {
  QUEUED: 'Na fila',
  RUNNING_EXTRACTION: 'Extraindo dados',
  RUNNING_RIVALS_AND_JUDGE: 'Analisando rivais e checklist',
  RUNNING_STRATEGIST: 'Montando estratégia',
  RUNNING_REVIEWER: 'Revisando números',
  RUNNING_DIAGRAMMER: 'Gerando PDF',
  COMPLETED: 'Concluída',
  FAILED: 'Falhou',
};

/** Estados mostrados ao operador (derivados do servidor; nunca inventam progresso). */
export const PHASE_LABEL = {
  WAITING: 'Aguardando',
  RUNNING: 'Em execução',
  COMPLETED: 'Concluída',
  FAILED: 'Falhou',
  INTERRUPTED: 'Interrompida',
} as const;

export const RECOVERED_LABEL = 'Resultado histórico recuperado';

export const NOT_AVAILABLE = 'Não disponível';
