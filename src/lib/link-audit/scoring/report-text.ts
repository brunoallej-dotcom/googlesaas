import { formatHalfPoints } from './math';
import type { ConflictRecord, Limitation, NaRegistryEntry, SubcriterionResult, Totals } from './types';

export const NOTICE_NOT_GOOGLE = 'O Índice Lumos não é uma nota oficial do Google.';
export const NOTICE_RECONSTRUCTED =
  'Metodologia reconstruída (lumos-reconstruida-v1, régua regua-d3b-r2): não é o agente original recuperado nem garante comportamento idêntico a ele.';
export const NOTICE_NV = 'Itens Não verificados ficam fora do denominador: ausência de evidência nunca vira nota zero.';

/** Limitações derivadas dos estados (texto de modelo fixo; nada de texto livre nem IA). */
export function buildLimitations(subs: readonly SubcriterionResult[], conflicts: readonly ConflictRecord[], na: readonly NaRegistryEntry[], totals: Totals, siteSummary: string | null): Limitation[] {
  const limitations: Limitation[] = [];
  const nv = subs.filter((sub) => sub.state === 'NOT_VERIFIED');
  if (nv.length > 0) {
    limitations.push({
      code: 'NOT_VERIFIED',
      text: `Não verificados (${nv.length}; ${formatHalfPoints(totals.notVerifiedHalfPoints)} pontos fora do denominador): ${nv.map((sub) => sub.id).join(', ')}.`,
    });
  }
  for (const entry of na) {
    limitations.push({ code: `NOT_APPLICABLE:${entry.subcriterionId}`, text: `${entry.subcriterionId} não aplicável (${entry.code}): ${entry.justification}` });
  }
  for (const sub of subs.filter((item) => item.state === 'SAMPLE_INSUFFICIENT')) {
    limitations.push({ code: `SAMPLE_INSUFFICIENT:${sub.id}`, text: `${sub.id}: ${sub.reason}` });
  }
  for (const conflict of conflicts) {
    limitations.push({ code: `CONFLICT:${conflict.field}`, text: `Conflito aberto em ${conflict.field}: ${conflict.observations.length} valores distintos na mesma data; subcritérios afetados ficam Não verificados.` });
  }
  if (siteSummary) limitations.push({ code: 'SITE_SCOPE', text: siteSummary });
  const x5 = subs.find((sub) => sub.id === 'X5');
  if (x5 && (x5.state === 'SCORED' || x5.state === 'ABSENCE_PROVEN')) {
    limitations.push({ code: 'X5_CAVEAT', text: 'X5 avalia apenas o uso de UTM na URL de destino do website do perfil; a ausência de UTM não comprova ausência de rastreamento em geral.' });
  }
  return limitations;
}
