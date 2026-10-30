import { canonicalJson, sha256Hex } from '../link-audit/canonical';
import { parseScoringInput, SCORE_MODELS, verifyScoreResult, type ScoreResult } from '../link-audit/scoring/index';
import { verifyAuditIdAlias } from './audit-id-alias';
import { deriveOutcome, MINIMUM_COVERAGE_PERCENT, toPublicView, type OutcomePreview } from './outcome';
import type { ScoreRun } from './results-types';
import { MAPPER_VERSION } from './types';

/*
 * Verificação SEMÂNTICA de um registro finalizado (Onda 6C, I4), usada ANTES de gravar e em TODA leitura. O selo e o encadeamento
 * (camada de arquivos) provam que os bytes são os gravados; aqui se prova que o conteúdo ainda se explica: a entrada é aceita pelo
 * contrato, o resultado é REPRODUZIDO pelo motor a partir da entrada (`verifyScoreResult`), os hashes batem, o desfecho deriva do
 * resultado, o alias é reproduzível, a proveniência da entrada coincide com a base de evidências gravada e a política M-4a vale.
 * Devolve problemas com TEXTO FIXO (nunca valores do registro). Lista vazia = íntegro.
 */
export function verifyRunRecord(run: ScoreRun): string[] {
  const problems: string[] = [];
  const add = (text: string): void => void problems.push(text);

  const parsed = parseScoringInput(run.input);
  if (!parsed.ok) return ['A entrada gravada não é aceita pelo contrato do motor.'];
  const input = parsed.input;
  if (canonicalJson(input) !== canonicalJson(run.input)) add('A entrada gravada não está na forma normalizada do motor.');
  const inputSha256 = sha256Hex(canonicalJson(input));
  if (inputSha256 !== run.inputSha256) add('O hash da entrada gravada não confere.');

  const verified = verifyScoreResult(run.result, run.input);
  if (!verified.ok) return [...problems, 'O resultado gravado não é reproduzível pelo motor a partir da entrada gravada.'];
  const result: ScoreResult = verified.result;
  if (result.inputSha256 !== run.inputSha256) add('O hash da entrada do resultado difere do gravado.');
  if (result.resultSha256 !== run.resultSha256) add('O hash do resultado gravado não confere.');

  // versões: o modelo gravado precisa existir no registro de modelos e a impressão digital da régua ser a dele
  if (run.methodologyVersion !== result.methodologyVersion || run.scoreModelVersion !== result.scoreModelVersion || run.rulerFingerprint !== result.rulerFingerprint) add('As versões da régua gravadas diferem do resultado.');
  const model = Object.hasOwn(SCORE_MODELS, run.scoreModelVersion) ? SCORE_MODELS[run.scoreModelVersion] : undefined;
  if (!model || model.fingerprint !== run.rulerFingerprint) add('A régua gravada não é a de nenhum modelo conhecido.');
  if (run.mapperVersion !== MAPPER_VERSION) add('A versão do mapeador gravada não é conhecida.');

  // identidade: o alias é reproduzível e a entrada/resultado usam o alias, nunca o id de origem sem passar por ele
  const alias = run.auditIdAlias;
  if (!verifyAuditIdAlias({ applied: alias.applied, rule: alias.rule, reason: alias.reason, sourceAuditId: alias.sourceAuditId, scoringAuditId: run.scoringAuditId })) add('O alias do identificador da auditoria não é reproduzível.');
  if (alias.sourceAuditId !== run.auditId) add('O identificador de origem do alias difere do da auditoria.');
  if (input.auditId !== run.scoringAuditId || result.auditId !== run.scoringAuditId) add('O identificador usado pelo motor difere do gravado.');

  // desfecho: DERIVA do resultado (nunca é informado)
  const outcome = deriveOutcome(result);
  if (run.outcome !== outcome.outcome) add('O desfecho gravado não corresponde ao resultado.');
  if (outcome.outcome === 'PONTUADO') {
    if (run.scored?.level !== outcome.level || run.inconclusive !== null) add('O nível do resultado pontuado não corresponde ao resultado.');
    if (result.index === null) add('Um resultado PONTUADO precisa ter índice.');
  } else {
    const inc = run.inconclusive;
    if (!inc || run.scored !== null || inc.reasonCode !== outcome.reasonCode || inc.coveragePercent !== outcome.coveragePercent || inc.minimumCoveragePercent !== MINIMUM_COVERAGE_PERCENT || canonicalJson(inc.failedGates) !== canonicalJson(outcome.failedGates)) {
      add('O motivo do resultado inconclusivo não corresponde ao resultado.');
    }
    if (result.index !== null || result.confidence !== null) add('Um resultado INCONCLUSIVO não pode ter índice nem confiança.');
  }

  // data de referência e proveniência: a entrada e a base de evidências gravada são a MESMA coisa
  if (run.referenceDate !== input.referenceDate || run.referenceDate !== result.referenceDate) add('A data de referência gravada difere da usada pelo motor.');
  if (run.referenceDateSource.observedAt.slice(0, 10) !== run.referenceDate) add('A fonte da data de referência não corresponde à data.');
  const basisByRef = new Map(run.evidenceBasis.map((item) => [item.ref, item]));
  if (basisByRef.size !== run.evidenceBasis.length) add('A base de evidências tem referências repetidas.');
  const dateSource = basisByRef.get(run.referenceDateSource.ref);
  if (!dateSource) add('A fonte da data de referência não está na base de evidências.');
  else if (dateSource.observedAt !== run.referenceDateSource.observedAt) add('A data da fonte da data de referência difere da base de evidências.');
  if (input.evidences.length !== run.evidenceBasis.length) add('A base de evidências gravada difere das evidências da entrada.');
  for (const evidence of input.evidences) {
    const item = basisByRef.get(evidence.id);
    if (!item || item.contentSha256 !== evidence.contentSha256 || item.observedAt !== evidence.observedAt) add('Uma evidência da entrada difere da base de evidências gravada.');
    if (evidence.observedAt.slice(0, 10) > run.referenceDate) add('Há evidência posterior à data de referência.');
  }
  if (run.profileSource) {
    const item = basisByRef.get(run.profileSource.ref);
    if (!item) add('A fonte do perfil não está na base de evidências.');
    else if (item.contentSha256 !== run.profileSource.contentSha256 || item.observedAt !== run.profileSource.observedAt || (item.bodySha256 !== null && item.bodySha256 !== run.profileSource.bodySha256)) add('A fonte do perfil difere da base de evidências.');
  }

  // decisões: exatamente as aplicadas
  const inputRecordIds = (input.operatorRecords ?? []).map((record) => record.id).sort();
  if (canonicalJson(inputRecordIds) !== canonicalJson([...run.decisions.appliedIds].sort())) add('As decisões aplicadas gravadas diferem das da entrada.');
  if (run.decisions.count < run.decisions.appliedIds.length) add('A contagem de decisões é menor que a das aplicadas.');
  if (run.decisions.applied.length !== run.decisions.appliedIds.length || run.decisions.applied.some((item, index) => item.decisionId !== run.decisions.appliedIds[index])) add('O carimbo das decisões aplicadas não confere.');

  // M-4a estrita e website: nada de avaliações na entrada; `complete:true` só com a prova de UTM registrada
  if (Object.hasOwn(input.profile ?? {}, 'reviews')) add('A entrada contém avaliações, o que a política M-4a proíbe.');
  const completeFields = Object.entries(input.profile ?? {}).filter(([, list]) => (list as Array<{ complete: boolean }>).some((item) => item.complete)).map(([field]) => field);
  const proof = run.websiteDerivation;
  if (completeFields.some((field) => field !== 'website')) add('Um campo foi enviado como completo sem prova.');
  if (completeFields.includes('website') && !(proof && proof.x5Proof === 'PROVEN' && proof.utmLevel === 'COMPLETE')) add('O website foi enviado como completo sem a prova de UTM registrada.');
  if (proof) {
    const item = basisByRef.get(proof.sourceEvidence.ref);
    if (!item) add('A origem da derivação do website não está na base de evidências.');
    else if (item.contentSha256 !== proof.sourceEvidence.contentSha256 || (item.bodySha256 !== null && item.bodySha256 !== proof.sourceEvidence.bodySha256)) add('A origem da derivação do website difere da base de evidências.');
  }
  return problems;
}

/** Desfecho e projeção PÚBLICA de um registro (já verificado): sem entrada, sem e-mail de decisões, sem justificativas, sem pontos suprimidos. */
export function toPublicRun(run: ScoreRun): { outcomePreview: OutcomePreview; detail: Record<string, unknown> } {
  const result = run.result as unknown as ScoreResult;
  const outcomePreview = deriveOutcome(result);
  return {
    outcomePreview,
    detail: {
      definitive: true,
      seq: run.seq,
      auditId: run.auditId,
      scoringAuditId: run.scoringAuditId,
      auditIdAlias: { applied: run.auditIdAlias.applied, rule: run.auditIdAlias.rule, reason: run.auditIdAlias.reason },
      finalizedAt: run.finalizedAt,
      finalizedBy: run.finalizedBy,
      outcome: run.outcome,
      level: run.scored?.level ?? null,
      inconclusive: run.inconclusive,
      decisions: { head: run.decisions.head, count: run.decisions.count, appliedIds: run.decisions.appliedIds },
      evidence: {
        layout: run.layout,
        referenceDate: run.referenceDate,
        referenceDateSource: { ref: run.referenceDateSource.ref, observedAt: run.referenceDateSource.observedAt },
        profileSource: run.profileSource ? { ref: run.profileSource.ref, observedAt: run.profileSource.observedAt } : null,
        bases: run.evidenceBasis.map((item) => ({ ref: item.ref, kind: item.kind, observedAt: item.observedAt, contentSha256: item.contentSha256, legacy: item.legacy, superseded: item.superseded })),
      },
      website: run.websiteDerivation ? { rule: run.websiteDerivation.rule, utmLevel: run.websiteDerivation.utmLevel, x5Proof: run.websiteDerivation.x5Proof } : null,
      versions: { mapper: run.mapperVersion, methodology: run.methodologyVersion, scoreModel: run.scoreModelVersion, rulerFingerprint: run.rulerFingerprint },
      hashes: { inputSha256: run.inputSha256, resultSha256: run.resultSha256, contentSha256: run.contentSha256, prevSha256: run.prevSha256 },
      result: toPublicView(result, outcomePreview),
    },
  };
}
