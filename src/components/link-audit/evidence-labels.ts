/* Vocabulário e formatação da área "Auditorias armazenadas" (Onda 5B). Texto puro, sem efeitos. */

/** Coleta SIMULADA do ensaio da W5 (W5.2b): o mesmo rótulo do servidor (`SIMULATED_LABEL`, conferido por teste). */
export const SIMULATED_BADGE = 'SIMULADA — ensaio';
export const SIMULATED_NOTICE = 'Dados sintéticos gravados na homologação pelo modo SIMULATED: nenhuma consulta foi feita e nada disto é evidência real de empresa nenhuma.';

export const COLLECTION_NOTICE = {
  title: 'Coleta de evidências — não é uma auditoria estratégica finalizada',
  lines: [
    'Aqui estão apenas dados e evidências coletados e preservados. Não há pontuação, índice, classificação ou diagnóstico.',
    'A régua de pontos da metodologia (decisão D3) ainda não foi aprovada, e nenhum número desta tela deve ser lido como nota.',
  ],
} as const;

export const EVIDENCE_LABELS: Readonly<Record<string, string>> = {
  'maps-name': 'Nome do estabelecimento',
  'maps-address': 'Endereço',
  'maps-phone': 'Telefone',
  'maps-hours': 'Horário de funcionamento',
  'maps-category': 'Categoria principal',
  'maps-secondary-categories': 'Categorias adicionais',
  'maps-rating': 'Nota média',
  'maps-review-count': 'Quantidade de avaliações',
  'maps-website': 'Site informado no perfil',
  'phone-consistency': 'Telefone: perfil × site',
  'site-reachable': 'Acesso ao site oficial',
  'site-contact-channels': 'Canais de contato no site',
  'site-indexing': 'Indexação do site',
  'site-declared-types': 'Tipo de negócio declarado no site',
  'external-presence': 'Presença digital externa',
  'unavailable-review-recency': 'Recência das avaliações',
  'unavailable-review-replies': 'Respostas do dono às avaliações',
  'unavailable-posts': 'Google Posts e atividade',
  'unavailable-photos': 'Fotos do perfil',
  'unavailable-videos': 'Vídeos do perfil',
  'unavailable-services': 'Serviços cadastrados',
  'unavailable-attributes': 'Atributos do perfil',
  'unavailable-products': 'Produtos do perfil',
};

export const ORIGIN_LABELS: Readonly<Record<string, string>> = {
  GOOGLE_NATIVE: 'Perfil do Google (via Serper)',
  OFFICIAL_SITE: 'Site oficial',
  OFFICIAL_SOCIAL: 'Rede social oficial',
  EXTERNAL: 'Fonte externa',
};

export const STATE_LABELS: Readonly<Record<string, string>> = {
  COMPLETE: 'Completa',
  INCOMPLETE: 'Incompleta',
  CORRUPT: 'Integridade comprometida',
  LEGACY: 'Coleta preservada (formato inicial)',
};

/** Na lista o selo diz só o que foi feito (hashes conferidos); a ressalva "hash não é assinatura" está no detalhe. */
export const LIST_INTEGRITY_LABELS: Readonly<Record<string, string>> = {
  OK: 'Hashes conferem (SHA-256)',
  MISMATCH: 'Integridade comprometida',
  INCOMPLETE: 'Coleta incompleta',
};

export const INTEGRITY_LABELS: Readonly<Record<string, string>> = {
  OK: 'Integridade confirmada',
  MISMATCH: 'Integridade comprometida',
  INCOMPLETE: 'Coleta incompleta',
};

export const ACCESS_CLASS_LABELS: Readonly<Record<string, string>> = {
  REACHABLE: 'Site acessado',
  NOT_ATTEMPTED: 'Não consultado',
  UNREACHABLE: 'Site inacessível',
  BLOCKED_BY_SAFETY: 'Bloqueado por regra de segurança',
  LOGIN_PATH_BLOCKED: 'Página de login não coletada',
  REQUEST_LIMIT: 'Limite de requisições atingido',
  HTTP_401: 'Resposta HTTP 401',
  HTTP_403: 'Resposta HTTP 403',
  AUTH_REQUIRED_EVIDENCED: 'Autenticação exigida (comprovada)',
  HTTP_OTHER: 'Resposta HTTP de erro',
  NOT_HTML: 'Resposta não é uma página HTML',
  RESTRICTED_RESPONSE_UNSPECIFIED: 'Resposta restrita (código não registrado)',
};

export const IDENTIFIER_TYPE_LABELS: Readonly<Record<string, string>> = { cid: 'CID', placeId: 'Place ID', featureId: 'FID' };

export const PROVIDER_FIELD_LABELS: Readonly<Record<string, string>> = {
  cid: 'campo cid',
  'fid (2ª metade)': '2ª metade do fid',
  fid: 'fid inteiro',
  placeId: 'placeId',
};

export function evidenceLabel(id: string, attribute: string): string {
  return EVIDENCE_LABELS[id] ?? (attribute ? attribute.replace(/[_-]+/g, ' ') : id);
}

const TIME_ZONE = 'America/Sao_Paulo';

/** Data e hora de Brasília, igual no servidor e no navegador (evita divergência na hidratação). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: TIME_ZONE }).format(date)} (Brasília)`;
}

export function formatRating(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

export function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('pt-BR').format(value);
}

export function formatCoordinate(value: number): string {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 5, maximumFractionDigits: 5 }).format(value);
}

/** "Cidade/UF" (vazio se nenhum dos dois foi informado). */
export function placeLine(city: string | null, stateCode: string | null): string {
  return [city, stateCode].filter(Boolean).join('/');
}

export const pluralize = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
