/* Rótulos e formatações da página da auditoria (I5). Texto fixo em português; nada aqui calcula pontuação. */
export { formatDateTime, placeLine, pluralize } from '../evidence-labels';

export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  AUTOMATICO: 'Automático',
  DECISAO_HUMANA: 'Decisão humana',
  BLOQUEADO: 'Bloqueado',
  SEM_DADO: 'Sem dado coletado',
};

export const STATE_LABELS: Readonly<Record<string, string>> = {
  SCORED: 'Avaliado',
  ABSENCE_PROVEN: 'Ausência comprovada',
  NOT_VERIFIED: 'Não verificado',
  NOT_APPLICABLE: 'Não aplicável',
  SAMPLE_INSUFFICIENT: 'Amostra insuficiente',
};

export const REASON_LABELS: Readonly<Record<string, string>> = {
  M4A_EXCLUDED: 'Nota e volume de avaliações: fora do cálculo por política (M-4a)',
  NOT_COLLECTED: 'Ainda não coletado',
  SITE_NOT_READ: 'Leitura verificável do site ausente',
  ADDRESS_NOT_STRUCTURED: 'Endereço sem decomposição validada',
  HOURS_NOT_STRUCTURED: 'Horários sem estruturação validada',
  NO_EXTERNAL_SOURCE: 'Sem fonte externa verificada para comparação',
  COMPLETENESS_NOT_PROVEN: 'Completude da lista não comprovada',
  COMPETITORS_NOT_COLLECTED: 'Concorrentes não coletados',
  AUTHORITY_NOT_COLLECTED: 'Prova externa de autoridade ausente',
  AWAITING_OPERATOR_DECISION: 'Aguardando decisão do operador',
  UTM_NOT_PROVEN: 'UTM completo não comprovado no website',
  NO_STORED_CAPTURE: 'Sem captura armazenada e íntegra',
  PRESENT: 'Presente na captura',
  TIER_MATCHED: 'Faixa atingida',
};
export const reasonLabel = (code: string | null): string => (code === null ? '' : (REASON_LABELS[code] ?? 'Dado automático indisponível nesta coleta'));

export const PREVIEW_STATE_LABELS: Readonly<Record<string, string>> = {
  SEM_EVIDENCIA: 'Sem evidência armazenada',
  DECISAO_PENDENTE: 'Decisão pendente',
  ENTRADA_RECUSADA: 'Entrada recusada pelo motor',
  CALCULADO_NAO_FINALIZAVEL: 'Calculado — não finalizável',
  CALCULADO_FINALIZAVEL: 'Calculado — pode ser registrado',
};

export const GATE_LABELS: Readonly<Record<string, string>> = {
  EVALUATED_DATA: 'Há dados avaliados',
  COVERAGE_MIN: 'Cobertura mínima',
  CRITERIA_MIN: 'Critérios com pontos suficientes',
  NAP_OR_REVIEWS: 'NAP ou Avaliações avaliados',
  INTEGRITY: 'Integridade',
};

export const INCONCLUSIVE_HEADLINE = 'Auditoria inconclusiva — evidências insuficientes para gerar o índice Lumos.';

export const DECISION_KIND_LABELS: Readonly<Record<string, string>> = {
  JUDGEMENT: 'Juízo do operador',
  NOT_APPLICABLE: 'Não aplicável',
  SITE_SCOPE_ATTESTATION: 'Atestação de escopo do site',
  IMAGES_CONFIRMATION: 'Confirmação de imagens',
  OBSERVATION_CONFIRMATION: 'Confirmação de observação',
  NAME_EQUIVALENCE: 'Equivalência de nomes',
};

export const JUDGEMENT_C2_VALUES: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: 'COMPATIBLE', label: 'Compatível com a atividade' },
  { value: 'PARTIAL', label: 'Parcialmente compatível' },
  { value: 'INCOMPATIBLE', label: 'Incompatível' },
];

export const OPTION_UNAVAILABLE_LABELS: Readonly<Record<string, string>> = {
  BASIS_MISSING: 'Sem captura íntegra que fundamente a categoria.',
  EXISTING_DECISION_REPLACE: 'Já existe uma decisão vigente: a nova a substituirá (a anterior permanece no histórico).',
};

/** Por que a coleta NÃO é tratada como autêntica (códigos fixos do servidor). */
export const PROVENANCE_REASON_LABELS: Readonly<Record<string, string>> = {
  PROOF_NOT_CONFIGURED: 'este servidor não tem prova de coleta configurada',
  NO_SEAL: 'não há manifesto assinado desta coleta',
  LEGACY_NO_SEAL: 'coleta legada, sem manifesto assinado (nada é atribuído a ela sem prova independente)',
  SEAL_INVALID: 'o manifesto assinado não confere (ausente de chave de confiança, adulterado ou de outra auditoria)',
  EVIDENCE_NOT_SEALED: 'há evidência que o manifesto assinado não cobre (por exemplo, captura adicionada depois)',
  EVIDENCE_MISSING: 'o manifesto assinado atesta evidência que NÃO existe mais na coleta (captura, relatório ou arquivo removido): os dados exibidos podem ser de uma coleta ANTERIOR e não devem ser tomados como a situação atual',
  EVIDENCE_HASH_MISMATCH: 'o conteúdo de uma evidência difere do que o manifesto assinado atesta',
  VERIFICATION_ERROR: 'a verificação não pôde ser concluída (tratada como não comprovada)',
};

export const DECISION_STATUS_LABELS: Readonly<Record<string, string>> = { ACTIVE: 'Vigente', SUPERSEDED: 'Substituída', REVOKED: 'Revogada', AMBIGUOUS: 'Em dúvida (operação pendente)' };

/** Meios-pontos do motor exibidos em pontos (só conversão de unidade para leitura; nada é somado nem recalculado no navegador). */
export function formatHalfPoints(halfPoints: number | null | undefined): string {
  if (typeof halfPoints !== 'number' || !Number.isFinite(halfPoints)) return '—';
  const value = halfPoints / 2;
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace('.', ',');
}

export const shortHash = (hash: string | null | undefined): string => (typeof hash === 'string' && hash.length >= 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : (hash ?? '—'));

const HIDDEN = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;
/** Texto vindo da API/operador, pronto para exibir como TEXTO (nunca HTML): sem controle, bidi nem invisíveis. */
export const safeText = (value: unknown, max = 600): string => (typeof value === 'string' ? value.replace(HIDDEN, '').trim().slice(0, max) : '');

export const OUTCOME_LABELS = { PONTUADO: 'Pontuado', INCONCLUSIVO: 'Inconclusivo' } as const;
export const LEVEL_LABELS: Readonly<Record<string, string>> = { PROVISORIO: 'Provisório', PUBLICAVEL: 'Publicável' };
