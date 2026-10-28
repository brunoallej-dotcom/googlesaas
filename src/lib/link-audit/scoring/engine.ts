import { canonicalJson } from '../canonical';
import { aggregate, computeIndex, computeNaSensitivity } from './aggregate';
import { computeConfidence } from './confidence';
import { ScoringContext } from './context';
import { evalC1, evalC2, evalC3, evalN1, evalN2, evalN3, evalN4, evalN5, evalS1, evalS2, evalS3, evalS4 } from './eval-profile';
import { evalP1, evalP2, evalP3, evalR1, evalR2, evalR3 } from './eval-reputation';
import { evalA1, evalA2, evalA3, evalV1, evalV2, evalV3, evalV4 } from './eval-visuals-posts';
import { evalS5, evalV5, evalX2, evalX4 } from './eval-site';
import { evalX1, evalX3, evalX5 } from './eval-conversion';
import { evalL1, evalL2, evalL3 } from './eval-authority';
import { RULER_FINGERPRINT, sha256OfCanonical } from './fingerprint';
import { parseScoringInput, type ScoringInput } from './input';
import { checkCore, checkResult } from './integrity';
import { computeNa } from './na';
import { buildPublication } from './publication';
import { notApplicable } from './results';
import { buildLimitations, NOTICE_NOT_GOOGLE, NOTICE_NV, NOTICE_RECONSTRUCTED } from './report-text';
import { SUBCRITERIA } from './ruler';
import type { NaRegistryEntry, ScoreOutcome, ScoreResult, SubcriterionId, SubcriterionResult } from './types';
import { SCORE_MODEL_VERSION, SCORE_RESULT_KIND, METHODOLOGY_VERSION } from './versions';

type Evaluator = (ctx: ScoringContext) => SubcriterionResult;

const EVALUATORS: Readonly<Record<SubcriterionId, Evaluator>> = {
  N1: evalN1, N2: evalN2, N3: evalN3, N4: evalN4, N5: evalN5,
  C1: evalC1, C2: evalC2, C3: evalC3,
  S1: evalS1, S2: evalS2, S3: evalS3, S4: evalS4, S5: evalS5,
  R1: evalR1, R2: evalR2, R3: evalR3,
  P1: evalP1, P2: evalP2, P3: evalP3,
  V1: evalV1, V2: evalV2, V3: evalV3, V4: evalV4, V5: evalV5,
  A1: evalA1, A2: evalA2, A3: evalA3,
  X1: evalX1, X2: evalX2, X3: evalX3, X4: evalX4, X5: evalX5,
  L1: evalL1, L2: evalL2, L3: evalL3,
};

/** Resultados criados por este motor (um JSON clonado ou forjado NÃO está aqui; use `verifyScoreResult`). */
const ENGINE_RESULTS = new WeakSet<object>();
export function isEngineResult(value: unknown): value is ScoreResult {
  return typeof value === 'object' && value !== null && ENGINE_RESULTS.has(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function compute(parsed: ScoringInput): ScoreOutcome {
  const ctx = new ScoringContext(parsed);
  const na = computeNa(ctx);
  const subcriteria = SUBCRITERIA.map((def) => {
    const info = na.get(def.id);
    return info ? notApplicable(def.id, info.code, info.justification, info.basis) : EVALUATORS[def.id](ctx);
  });
  if (ctx.issues.length > 0) return { ok: false, issues: [...new Set(ctx.issues)] };

  const conflicts = [...ctx.conflicts].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  const { criteria, totals } = aggregate(subcriteria);
  const coreIssues = checkCore(subcriteria, criteria, totals);
  if (coreIssues.length > 0) return { ok: false, issues: coreIssues.map((issue) => `integridade interna: ${issue}`) };

  const publication = buildPublication(totals, true);
  const index = publication.status === 'PROVISIONAL' || publication.status === 'PUBLISHED' ? computeIndex(totals) : null;
  const confidence = index ? computeConfidence(subcriteria, criteria, totals, conflicts) : null;

  const naRegistry: NaRegistryEntry[] = [];
  for (const def of SUBCRITERIA) {
    const info = na.get(def.id);
    if (!info) continue;
    naRegistry.push({
      subcriterionId: def.id,
      code: info.code,
      justification: info.justification,
      causeEvidenceIds: info.causeEvidenceIds,
      recordedBy: info.recordedBy,
      recordedAt: info.recordedAt,
      operatorRecordId: info.operatorRecordId,
    });
  }

  const reviews = ctx.resolve('reviews');
  const site = parsed.site;
  const siteSummary = site
    ? `Site: escopo ${site.scope.kind}, ${site.scope.pagesRead.length} página(s) lida(s)${site.scope.blockers.length > 0 ? `, ${site.scope.blockers.length} bloqueio(s) registrado(s)` : ''}; os achados valem para o escopo lido, não para o domínio inteiro.`
    : null;
  const notices = [NOTICE_NOT_GOOGLE, NOTICE_RECONSTRUCTED, NOTICE_NV, publication.statusText];

  const body = {
    kind: SCORE_RESULT_KIND,
    methodologyVersion: METHODOLOGY_VERSION,
    scoreModelVersion: SCORE_MODEL_VERSION,
    rulerFingerprint: RULER_FINGERPRINT,
    auditId: parsed.auditId,
    referenceDate: parsed.referenceDate,
    inputSha256: sha256OfCanonical(parsed),
    subcriteria,
    criteria,
    totals,
    publication,
    index,
    confidence,
    naSensitivity: index ? computeNaSensitivity(totals) : null,
    conflicts,
    naRegistry,
    displayData: { reviews: reviews.status === 'OK' ? { ratingShown: reviews.value.ratingShown, reviewCount: reviews.value.reviewCount } : null },
    limitations: buildLimitations(subcriteria, conflicts, naRegistry, totals, siteSummary),
    notices,
  };
  const result = deepFreeze(JSON.parse(canonicalJson({ ...body, resultSha256: sha256OfCanonical(body) }))) as ScoreResult;
  const finalIssues = checkResult(result);
  if (finalIssues.length > 0) return { ok: false, issues: finalIssues.map((issue) => `integridade interna: ${issue}`) };
  ENGINE_RESULTS.add(result);
  return { ok: true, result };
}

export interface ScoreModel {
  readonly version: string;
  readonly fingerprint: string;
  readonly compute: (input: ScoringInput) => ScoreOutcome;
}

/**
 * Modelos de pontuação conhecidos. Uma revisão futura da régua ADICIONA um modelo com nova versão; o antigo permanece
 * para reproduzir resultados históricos (nunca se altera um modelo publicado).
 */
export const SCORE_MODELS: Readonly<Record<string, ScoreModel>> = Object.freeze({
  [SCORE_MODEL_VERSION]: Object.freeze({ version: SCORE_MODEL_VERSION, fingerprint: RULER_FINGERPRINT, compute }),
});

export interface ScoreOptions {
  readonly scoreModelVersion?: string;
}

/** Único caminho que produz pontos: recebe fatos e evidências (nunca pontos), valida, calcula e congela. Nunca lança. */
export function scoreAudit(raw: unknown, options: ScoreOptions = {}): ScoreOutcome {
  const wanted = options.scoreModelVersion ?? SCORE_MODEL_VERSION;
  const model = Object.hasOwn(SCORE_MODELS, wanted) ? SCORE_MODELS[wanted] : undefined;
  if (!model) return { ok: false, issues: [`scoreModelVersion desconhecida: ${String(options.scoreModelVersion)}`] };
  const parsed = parseScoringInput(raw);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  try {
    return model.compute(parsed.input);
  } catch (error) {
    return { ok: false, issues: [`erro interno ao pontuar: ${error instanceof Error ? error.message : 'desconhecido'}`] };
  }
}

export type VerifyOutcome = { readonly ok: true; readonly result: ScoreResult } | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Um resultado vindo de fora (arquivo, rede, cliente) só vale se, recalculado com a MESMA versão e o MESMO conjunto de
 * evidências, produzir exatamente o mesmo conteúdo. Resultados históricos de modelos antigos continuam verificáveis
 * enquanto o modelo permanecer registrado.
 */
export function verifyScoreResult(resultRaw: unknown, inputRaw: unknown): VerifyOutcome {
  if (typeof resultRaw !== 'object' || resultRaw === null) return { ok: false, issues: ['resultado inválido'] };
  const claimed = resultRaw as { scoreModelVersion?: unknown; methodologyVersion?: unknown };
  if (typeof claimed.scoreModelVersion !== 'string') return { ok: false, issues: ['resultado sem scoreModelVersion'] };
  if (claimed.methodologyVersion !== METHODOLOGY_VERSION) return { ok: false, issues: ['methodologyVersion do resultado não é a conhecida'] };
  const model = Object.hasOwn(SCORE_MODELS, claimed.scoreModelVersion) ? SCORE_MODELS[claimed.scoreModelVersion] : undefined;
  if (!model) return { ok: false, issues: [`modelo ${claimed.scoreModelVersion} não está registrado: o resultado não pode ser reproduzido`] };
  const recomputed = scoreAudit(inputRaw, { scoreModelVersion: claimed.scoreModelVersion });
  if (!recomputed.ok) return { ok: false, issues: recomputed.issues };
  let identical: boolean;
  try {
    identical = canonicalJson(resultRaw) === canonicalJson(recomputed.result);
  } catch {
    identical = false;
  }
  return identical ? { ok: true, result: recomputed.result } : { ok: false, issues: ['o resultado não é reproduzível a partir das evidências e da versão informadas'] };
}
