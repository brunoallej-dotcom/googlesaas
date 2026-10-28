import type { CriterionId } from '../methodology';
import type { ProviderId } from './types';

/*
 * O que cada fonte comprovadamente entrega (Onda 4A). `confirmed` = o campo existe no formato já usado em
 * produção pelo projeto (Serper /maps na prospecção) ou é observável por requisição pública (site).
 * Campos que a fonte NÃO entrega ficam "NOT_VERIFIED com limitação": nada é inventado nem inferido.
 */

export interface FieldCapability {
  readonly source: ProviderId;
  readonly field: string;
  readonly criterion: CriterionId;
  readonly confirmed: boolean;
  readonly note: string;
}

export const FIELD_CAPABILITIES: readonly FieldCapability[] = [
  { source: 'serper-maps', field: 'nome (title)', criterion: 'NAP', confirmed: true, note: 'campo usado na prospecção' },
  { source: 'serper-maps', field: 'endereço (address)', criterion: 'NAP', confirmed: true, note: 'pode vir curto/oculto em negócios de área de atendimento' },
  { source: 'serper-maps', field: 'telefone (phoneNumber)', criterion: 'NAP', confirmed: true, note: 'pode faltar' },
  { source: 'serper-maps', field: 'horários (openingHours)', criterion: 'NAP', confirmed: true, note: 'pode faltar' },
  { source: 'serper-maps', field: 'categoria principal (type)', criterion: 'CATEGORIES', confirmed: true, note: 'só a principal é tratada como comprovada' },
  { source: 'serper-maps', field: 'categorias secundárias (types)', criterion: 'CATEGORIES', confirmed: false, note: 'completude não comprovada' },
  { source: 'serper-maps', field: 'nota (rating) e quantidade (ratingCount)', criterion: 'REVIEWS', confirmed: true, note: 'valor do momento da coleta, sem datas' },
  { source: 'serper-maps', field: 'site (website)', criterion: 'CONVERSION', confirmed: true, note: 'pode ser rede social ou agregador' },
  { source: 'serper-maps', field: 'cid, fid e placeId', criterion: 'NAP', confirmed: true, note: 'usados só para casar o perfil, nunca o nome' },
  { source: 'serper-maps', field: 'busca por parâmetros cid/placeId', criterion: 'NAP', confirmed: false, note: 'parâmetros do /maps não confirmados; estratégia desligada' },
  { source: 'serper-maps', field: 'Google Posts', criterion: 'POSTS_ACTIVITY', confirmed: false, note: 'o /maps não entrega' },
  { source: 'serper-maps', field: 'fotos e vídeos do perfil', criterion: 'VISUALS', confirmed: false, note: 'o /maps não entrega' },
  { source: 'serper-maps', field: 'serviços, atributos e produtos nativos', criterion: 'SERVICES', confirmed: false, note: 'o /maps não entrega' },
  { source: 'serper-reviews', field: 'avaliações datadas e respostas do dono', criterion: 'REVIEW_REPLIES', confirmed: false, note: 'formato da resposta NÃO confirmado; nada é usado como evidência' },
  { source: 'site-check', field: 'resposta HTTP, redirecionamentos, noindex, robots', criterion: 'CONVERSION', confirmed: true, note: 'observável por requisição pública, sem API paga' },
  { source: 'site-check', field: 'links de telefone, WhatsApp e e-mail', criterion: 'CONVERSION', confirmed: true, note: 'só links presentes na página inicial' },
  { source: 'site-check', field: 'dados estruturados LocalBusiness', criterion: 'SERVICES', confirmed: true, note: 'tipos declarados pelo site; não são serviços cadastrados no Google' },
];

/** Texto fixo anexado a toda evidência vinda do Serper /maps (decisão: origem GOOGLE_NATIVE com limitação). */
export const MAPS_ORIGIN_LIMITATION =
  'Obtido via Serper /maps, intermediário de coleta da listagem pública do Google Maps; não é a API oficial do Google Business Profile e o perfil não foi aberto diretamente no Google.';

export interface LookupStrategy {
  readonly id: 'TEXT_SEARCH_THEN_MATCH' | 'IDENTIFIER_PARAMS';
  readonly enabled: boolean;
  readonly confirmed: boolean;
  readonly note: string;
}

/** Estratégias para localizar o perfil no /maps. Só a confirmada está ligada. */
export const LOOKUP_STRATEGIES: readonly LookupStrategy[] = [
  {
    id: 'TEXT_SEARCH_THEN_MATCH',
    enabled: true,
    confirmed: true,
    note: 'busca por texto (nome + cidade/UF + ll do link), depois casamento por identificador exato; formato usado na prospecção',
  },
  {
    id: 'IDENTIFIER_PARAMS',
    enabled: false,
    confirmed: false,
    note: 'envio de cid/placeId como parâmetros de ENTRADA do /maps: não confirmado em nenhuma fonte (o adaptador aceita o cid, mas o coletor não o envia). A SAÍDA traz cid e fid (observado em respostas antigas do projeto); a confirmação do perfil é feita sobre a saída',
  },
];

/** Orçamento padrão conservador; o chamador sempre informa o seu. */
export const DEFAULT_CALL_BUDGET = { maps: 1, reviews: 0, site: 1 } as const;
