import nodePath from 'node:path';
import type { ChannelEnvironment } from '../link-audit-seals-channel/paths';

/*
 * P9.3b — os parâmetros FIXOS do receptor de manifestos, escritos pelo responsável no wrapper do comando forçado (spec §5.7, "Instalação"). Não vêm
 * do CI: qualquer defeito aqui é erro de instalação e sai como `E_INTERNAL` (falha fechada). Puro.
 *   --env producao|homologacao   --seals-root <pasta de manifestos>   --trust-list <lista INSTALADA pelo receptor de deploy>
 *   --lock <arquivo da trava de defesa>   --log <arquivo do log local>
 */

export interface SealReceiverConfig {
  readonly env: ChannelEnvironment;
  /** A pasta de manifestos do ambiente (`GMN_RAIZ_DADOS_MANIFESTOS`); tem de ser o próprio caminho real. */
  readonly sealsRoot: string;
  /** A lista INSTALADA (`<estado do deploy>/trust-keys.txt`); a pendente (`trust-keys.pending`) nunca é lida. */
  readonly trustList: string;
  readonly lockFile: string;
  readonly logFile: string;
}

const FLAGS = ['--env', '--seals-root', '--trust-list', '--lock', '--log'] as const;
type Flag = (typeof FLAGS)[number];

/** Caminho absoluto já normalizado, sem `/` no fim (e não a raiz). */
export const isCleanAbsolutePath = (value: string): boolean => value.length > 1 && nodePath.posix.isAbsolute(value) && nodePath.posix.normalize(value) === value && !value.endsWith('/') && !value.includes('\0');

/** `inner` é `outer` ou está dentro dela (só texto: os dois já são caminhos limpos). */
const isWithin = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(`${outer}/`);

function collectFlags(argv: readonly string[]): Map<Flag, string> | null {
  const values = new Map<Flag, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] as Flag;
    const value = argv[index + 1];
    if (!FLAGS.includes(flag) || values.has(flag) || value === undefined || value.startsWith('--')) return null;
    values.set(flag, value);
  }
  return FLAGS.every((flag) => values.has(flag)) ? values : null;
}

/**
 * Os parâmetros do wrapper, ou `null` (= `E_INTERNAL`): flag desconhecida, repetida, ausente ou sem valor, ambiente desconhecido, caminho relativo ou
 * não normalizado, e lista, trava ou log dentro da pasta de manifestos (ou ela dentro deles): nada do receptor mora na pasta que o web lê.
 */
export function parseSealReceiverArgs(argv: readonly string[]): SealReceiverConfig | null {
  const values = collectFlags(argv);
  if (values === null) return null;
  const env = values.get('--env');
  if (env !== 'producao' && env !== 'homologacao') return null;
  const sealsRoot = values.get('--seals-root') as string;
  const others = [values.get('--trust-list'), values.get('--lock'), values.get('--log')] as string[];
  if (![sealsRoot, ...others].every(isCleanAbsolutePath)) return null;
  if (others.some((other) => isWithin(other, sealsRoot) || isWithin(sealsRoot, other)) || new Set(others).size !== others.length) return null;
  return { env, sealsRoot, trustList: others[0] as string, lockFile: others[1] as string, logFile: others[2] as string };
}
