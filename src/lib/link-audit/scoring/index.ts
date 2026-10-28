/**
 * Motor de pontuação da metodologia Lumos RECONSTRUÍDA (Fase 6, Onda 6A). Módulo puro: sem rede, disco, ambiente ou
 * relógio; independente de prospecção, Juiz, interface e PDF. Ainda NÃO conectado a nenhum consumidor.
 */
export { scoreAudit, verifyScoreResult, isEngineResult, SCORE_MODELS } from './engine';
export type { ScoreModel, ScoreOptions, VerifyOutcome } from './engine';
export { parseScoringInput, scoringInputSchema, findClientProvidedScoreKeys } from './input';
export type { ScoringInput, OperatorRecord, ScoredDate } from './input';
/** Confere só a coerência interna dos campos derivados; NÃO é verificação de autenticidade (use `verifyScoreResult`). */
export { checkResult as checkResultConsistency } from './integrity';
export { RULER_FINGERPRINT } from './fingerprint';
export { SUBCRITERIA, TIERS, RULES, NA_RULES } from './ruler';
export { SCORE_MODEL_VERSION, METHODOLOGY_VERSION, SCORING_INPUT_SCHEMA_VERSION, SCORE_RESULT_KIND } from './versions';
export * from './types';
