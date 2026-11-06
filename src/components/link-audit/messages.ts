import type { MapsLinkParseResult } from '@/lib/link-audit/maps-link';

/*
 * Textos da tela de Auditoria por Link (Fase 6, Onda 3). Módulo puro e seguro para o navegador:
 * só importa TIPOS do módulo de domínio (o parser usa módulos do Node e roda apenas no servidor).
 */

export type ParseStatus = MapsLinkParseResult['status'];
export type ParseCode = MapsLinkParseResult['code'];
export type ViewTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface StatusView {
  readonly label: string;
  readonly tone: ViewTone;
  readonly summary: string;
}

export const STATUS_VIEW: Readonly<Record<ParseStatus, StatusView>> = {
  IDENTIFIED: {
    label: 'Identificado',
    tone: 'success',
    summary: 'O link contém um identificador do perfil. Ele ainda não prova qual empresa é: confirme abaixo.',
  },
  RESOLUTION_PENDING: {
    label: 'Resolução pendente',
    tone: 'warning',
    summary: 'Link curto. Nada foi acessado e nenhum mecanismo autorizado de resolução existe nesta etapa.',
  },
  AMBIGUOUS: {
    label: 'Ambíguo',
    tone: 'warning',
    summary: 'O link não identifica uma empresa de forma única. Nenhum estabelecimento foi escolhido.',
  },
  UNSUPPORTED: {
    label: 'Não suportado',
    tone: 'neutral',
    summary: 'Este tipo de link não representa o perfil de uma empresa no Google Maps.',
  },
  INVALID: {
    label: 'Inválido',
    tone: 'danger',
    summary: 'O texto informado não é um link utilizável.',
  },
  REJECTED: {
    label: 'Rejeitado',
    tone: 'danger',
    summary: 'O link foi rejeitado por segurança e não será usado.',
  },
};

/** Um texto por código: se o parser ganhar um código novo, o typecheck exige a mensagem correspondente. */
export const CODE_MESSAGES: Readonly<Record<ParseCode, string>> = {
  IDENTIFIED: 'Identificador do perfil encontrado no link.',
  SHORT_LINK_REQUIRES_RESOLUTION:
    'Para descobrir o perfil seria preciso seguir o redirecionamento do link curto, e isso não é feito nesta etapa. Abra o perfil no Google Maps e cole o link completo da barra do navegador.',
  NAME_OR_SEARCH_ONLY:
    'O link traz só um nome ou uma busca, e um nome não identifica uma empresa de forma única. Abra a página da empresa no Google Maps e copie o link completo.',
  COORDINATES_ONLY: 'O link traz apenas coordenadas de um ponto do mapa, não o perfil de uma empresa.',
  GENERIC_MAPS_LINK: 'O link abre o Google Maps sem indicar uma empresa.',
  CONFLICTING_IDENTIFIERS:
    'O link contém identificadores diferentes entre si e não é possível escolher uma empresa. Copie o link direto da página do perfil.',
  UNSUPPORTED_HOST:
    'Endereço não suportado: só são aceitos links do Google Maps (google.com, google.com.br) e os links curtos maps.app.goo.gl, goo.gl/maps e g.page.',
  UNSUPPORTED_PATH:
    'Esta página do Google (rota, mapa incorporado, busca etc.) não representa o perfil de uma empresa.',
  UNSUPPORTED_SHORT_LINK_PATH: 'O formato deste link curto não é reconhecido.',
  NOT_A_STRING: 'Cole o link do perfil da empresa no Google Maps.',
  EMPTY: 'Cole o link do perfil da empresa no Google Maps.',
  TOO_LONG: 'O link é longo demais (máximo de 2048 caracteres).',
  WHITESPACE_OR_CONTROL: 'O texto contém espaços ou caracteres invisíveis. Cole apenas o link, sem o nome da empresa ao lado.',
  MALFORMED_PERCENT_ENCODING: 'O link tem uma codificação de caracteres (%) inválida; ele parece cortado ou alterado.',
  MISSING_SCHEME: 'O link precisa começar com https://.',
  NON_CANONICAL_URL: 'O link não está no formato https://endereço. Copie-o novamente da barra do navegador.',
  UNPARSEABLE: 'Não foi possível interpretar este texto como um link.',
  INVALID_IDENTIFIER_FORMAT: 'Um identificador do link (cid, ftid ou place_id) tem formato inválido ou é nulo.',
  BACKSLASH: 'Contém barra invertida (\\), o que pode fazer o mesmo texto apontar para dois destinos.',
  INSECURE_SCHEME: 'Só links https:// são aceitos; http:// não é.',
  UNSAFE_SCHEME: 'Este tipo de endereço (javascript:, file:, data:, ftp: etc.) não é permitido.',
  UNSAFE_URL: 'O link contém credenciais, porta ou endereço interno que não são permitidos.',
  IP_LITERAL_HOST: 'Endereços IP não são aceitos; use o link do Google Maps.',
  IDN_LOOKALIKE_HOST: 'O endereço usa caracteres especiais que podem imitar o Google.',
};

const HIDDEN_DISPLAY_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

/** Texto vindo do link ou do operador, pronto para exibir: sem controle, bidi nem invisíveis. */
export function displayText(value: string): string {
  return value.replace(HIDDEN_DISPLAY_CHARACTERS, '').trim();
}

export const IDENTIFIER_LABELS = {
  cid: 'CID',
  placeId: 'Place ID',
  featureId: 'Feature ID (fid)',
} as const;

export const SOURCE_FORM_LABELS: Readonly<Record<string, string>> = {
  DATA_SEGMENT: 'trecho data=!1s… do endereço',
  FTID_PARAM: 'parâmetro ftid',
  CID_PARAM: 'parâmetro cid',
  PLACE_ID_PARAM: 'parâmetro place_id',
  QUERY_PLACE_ID_PARAM: 'parâmetro query_place_id',
  Q_PLACE_ID: 'parâmetro q=place_id:',
};

export const LIMITS_NOTICE = [
  'Nenhuma consulta ao Google ou a outro serviço foi feita: a análise do link é local e só olha o texto do endereço.',
  'Nada é salvo. A confirmação vale apenas nesta tela e some ao recarregar a página.',
  'A gravação de snapshots pela interface está desligada até a estratégia de gravação segura em /mnt/d ser validada.',
  'Esta tela não coleta, não pontua, não gera PDF nem usa IA. A pontuação, as decisões humanas e o registro de resultados ficam na auditoria Lumos de cada empresa armazenada (botão “Abrir auditoria Lumos”).',
] as const;
