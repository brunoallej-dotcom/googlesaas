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
 * A trava lida do ambiente do PROCESSO: só esta variável, nunca um arquivo de ambiente. É o único acesso ao ambiente de que o `export --simulated`
 * precisa (o CLI do P1 e os módulos do `export` continuam sem olhar o ambiente; spec do P1 §5.7).
 */
export const homologationLockFromProcess = (): boolean => isHomologationLockOn({ [HOMOLOGATION_LOCK_ENV]: process.env[HOMOLOGATION_LOCK_ENV] });

/** Marca de uma captura (qualquer uma das duas basta para tratá-la como simulada: na dúvida, simulada). */
export const isSimulatedCapture = (file: { readonly provider: string; readonly simulated?: boolean }): boolean => file.simulated === true || file.provider === SIMULATED_PROVIDER;
