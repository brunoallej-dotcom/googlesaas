/*
 * Coleta SIMULADA do ensaio da W5 (W5.2b, spec do P1 §5.7). Puro: sem disco, rede nem ambiente implícito (o `env` vem de quem chama).
 * Uma evidência simulada NUNCA passa por real: a marca é gravada na captura (dentro do hash) e todo consumidor que a encontra recusa ou
 * rotula, salvo com a trava explícita de homologação.
 */

/** Provedor gravado na captura simulada (o real é `serper-maps`). */
export const SIMULATED_PROVIDER = 'SIMULATED' as const;

/** Variável de ambiente da trava de homologação. Só o valor exato `1` liga a trava; qualquer outro valor (ou ausência) a mantém desligada. */
export const HOMOLOGATION_LOCK_ENV = 'GMN_LINK_AUDIT_HOMOLOGATION' as const;
const HOMOLOGATION_LOCK_ON = '1';

/** Rótulo curto, igual em todas as saídas (coletor, export, leitor, interface e prévia). */
export const SIMULATED_LABEL = 'SIMULADA — ensaio' as const;
export const SIMULATED_SOURCE_LABEL = `${SIMULATED_LABEL} (dados sintéticos de homologação; nenhuma consulta foi feita; nunca é evidência real)`;

export type EnvReader = Readonly<Record<string, string | undefined>>;

export const isHomologationLockOn = (env: EnvReader): boolean => env[HOMOLOGATION_LOCK_ENV] === HOMOLOGATION_LOCK_ON;

/**
 * Prefixo RESERVADO do id das chaves de ensaio (W5.2b, revisão do PR #62): o modo fica visível no próprio manifesto assinado (o `keyId`). O `sign
 * --simulated` só assina com chave `ensaio-…`, o `sign` real recusa essa chave, e o servidor sem a trava de homologação recusa a lista que a contém.
 */
export const REHEARSAL_KEY_PREFIX = 'ensaio-' as const;
export const isRehearsalKeyId = (keyId: string): boolean => keyId.startsWith(REHEARSAL_KEY_PREFIX);

/**
 * A lista de chaves PÚBLICAS de confiança como o servidor a usa: com qualquer id `ensaio-` e SEM a trava de homologação, a lista inteira é recusada
 * (`undefined` ⇒ política fechada: nada autentica, nada é finalizável). Com a trava (pilha de homologação), passa como está. Só os ids são olhados.
 */
export function trustKeysForServer(raw: string | undefined, homologation: boolean): string | undefined {
  if (raw === undefined || homologation) return raw;
  const ids = raw.split(',').map((item) => item.trim().split(':')[0] ?? '');
  return ids.some(isRehearsalKeyId) ? undefined : raw;
}

/** Marca de uma captura (qualquer uma das duas basta para tratá-la como simulada: na dúvida, simulada). */
export const isSimulatedCapture = (file: { readonly provider: string; readonly simulated?: boolean }): boolean => file.simulated === true || file.provider === SIMULATED_PROVIDER;
