import { METHODOLOGY_VERSION } from '../methodology';

/**
 * Versionamento do motor de pontuação (Fase 6, Onda 6A).
 *
 * - `methodologyVersion`: a metodologia RECONSTRUÍDA (não é o agente original recuperado).
 * - `scoreModelVersion`: a régua de pontos homologada em 22/10/2026 (D3B). Uma revisão futura da régua exige uma NOVA
 *   versão aqui e um novo modelo em `SCORE_MODELS`; o modelo antigo permanece para reproduzir resultados históricos.
 */
export { METHODOLOGY_VERSION };
export const SCORE_MODEL_VERSION = 'regua-d3b-r2' as const;
export const SCORING_INPUT_SCHEMA_VERSION = 1 as const;
export const SCORE_RESULT_KIND = 'LUMOS_SCORE_RESULT' as const;
