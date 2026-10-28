import type { BattlefieldMetrics, ReputationMetrics, VitrineMetrics } from '@/types/gmn';
import { detectBattlefieldOrigin, detectReputationOrigin, detectVitrineOrigin } from './origins';
import { isDemoMode } from './types';

/**
 * Salvaguarda contra dado simulado em auditorias NOVAS.
 *
 * Os agentes de coleta já não geram simulação fora do modo demonstração. Esta verificação é a rede de
 * segurança: se, por defeito, uma coleta trouxer marcadores de dado simulado e o modo demonstração
 * NÃO estiver ligado, a auditoria é interrompida em vez de apresentar o dado como evidência real.
 * Auditorias históricas e reavaliações não passam por aqui e continuam legíveis.
 */
export function findSimulatedCollections(params: {
  readonly placeId: string;
  readonly reputation: ReputationMetrics;
  readonly vitrine: VitrineMetrics;
  readonly battlefield: BattlefieldMetrics;
}): readonly string[] {
  const found: string[] = [];
  if (detectReputationOrigin(params.reputation, params.placeId) === 'SIMULATED') found.push('reputação (avaliações)');
  if (detectVitrineOrigin(params.vitrine, params.placeId) === 'SIMULATED') found.push('vitrine (mídias e publicações)');
  if (detectBattlefieldOrigin(params.battlefield) === 'SIMULATED' || params.battlefield.dataOrigin === 'SIMULATED') {
    found.push('campo de batalha (posições e líderes)');
  }
  return found;
}

export function assertNoSimulatedDataOutsideDemo(
  params: Parameters<typeof findSimulatedCollections>[0],
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  if (isDemoMode(env)) return;
  const found = findSimulatedCollections(params);
  if (found.length > 0) {
    throw new Error(
      `Dados simulados detectados fora do modo demonstração (${found.join(', ')}). A auditoria foi interrompida para que nenhum dado simulado entre como evidência real.`
    );
  }
}
