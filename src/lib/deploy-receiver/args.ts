import nodePath from 'node:path';
import type { DeployEnvironment } from './grammar';

/*
 * P9.3a — os parâmetros FIXOS do receptor, escritos pelo responsável no wrapper do comando forçado (spec §5.6, "Instalação"). Não vêm do CI:
 * qualquer defeito aqui é erro de instalação e sai como `E_INTERNAL` (falha fechada). Puro.
 *   --env producao|homologacao   --stack-name <nome>   --stack <arquivo>   --overlay <arquivo> (só homologação)
 *   --host-vars <arquivo>   --folders-check <script>   --state <pasta>   --log <arquivo>
 *   --data-prefix <pasta/> (só homologação)   --forbid-supabase <12 hex> (só homologação: a impressão do projeto de PRODUÇÃO)
 */

export interface ReceiverConfig {
  readonly env: DeployEnvironment;
  readonly stackName: string;
  readonly stackFile: string;
  /** Sobreposição de homologação (`stack-hml.yml`); `null` em produção. */
  readonly overlayFile: string | null;
  readonly hostVarsFile: string;
  readonly foldersCheck: string;
  readonly stateDir: string;
  readonly logFile: string;
  /** Prefixo das pastas de homologação, com `/` no fim; `null` em produção. */
  readonly dataPrefix: string | null;
  /** Impressão (12 hex) do projeto Supabase de produção, proibida na homologação; `null` em produção. */
  readonly forbidSupabase: string | null;
}

const FLAGS = ['--env', '--stack-name', '--stack', '--overlay', '--host-vars', '--folders-check', '--state', '--log', '--data-prefix', '--forbid-supabase'] as const;
type Flag = (typeof FLAGS)[number];
const HOMOLOGATION_ONLY: readonly Flag[] = ['--overlay', '--data-prefix', '--forbid-supabase'];
const ALWAYS: readonly Flag[] = ['--env', '--stack-name', '--stack', '--host-vars', '--folders-check', '--state', '--log'];
const STACK_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const FP12 = /^[0-9a-f]{12}$/;

/** Caminho absoluto já normalizado, sem `/` no fim (e não a raiz). */
export const isCleanAbsolutePath = (value: string): boolean => value.length > 1 && nodePath.posix.isAbsolute(value) && nodePath.posix.normalize(value) === value && !value.endsWith('/') && !value.includes('\0');

/** Prefixo de pastas: absoluto, normalizado, com `/` no fim, nunca a raiz. */
const isCleanPrefix = (value: string): boolean => value.endsWith('/') && isCleanAbsolutePath(value.slice(0, -1));

function collectFlags(argv: readonly string[]): Map<Flag, string> | null {
  const values = new Map<Flag, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] as Flag;
    const value = argv[index + 1];
    if (!FLAGS.includes(flag) || values.has(flag) || value === undefined || value.startsWith('--')) return null;
    values.set(flag, value);
  }
  return values;
}

function environmentFlagsOk(env: DeployEnvironment, values: ReadonlyMap<Flag, string>): boolean {
  if (ALWAYS.some((flag) => !values.has(flag))) return false;
  const wantsHomologation = env === 'homologacao';
  return HOMOLOGATION_ONLY.every((flag) => values.has(flag) === wantsHomologation);
}

/** Os parâmetros do wrapper, ou `null` (= `E_INTERNAL`): flag desconhecida, repetida, ausente, sem valor ou com valor fora do formato. */
export function parseReceiverArgs(argv: readonly string[]): ReceiverConfig | null {
  const values = collectFlags(argv);
  if (values === null) return null;
  const env = values.get('--env');
  if (env !== 'producao' && env !== 'homologacao') return null;
  if (!environmentFlagsOk(env, values)) return null;
  const paths = ['--stack', '--overlay', '--host-vars', '--folders-check', '--state', '--log'] as const;
  if (paths.some((flag) => values.has(flag) && !isCleanAbsolutePath(values.get(flag) as string))) return null;
  const stackName = values.get('--stack-name') as string;
  const dataPrefix = values.get('--data-prefix') ?? null;
  const forbidSupabase = values.get('--forbid-supabase') ?? null;
  if (!STACK_NAME.test(stackName) || (dataPrefix !== null && !isCleanPrefix(dataPrefix)) || (forbidSupabase !== null && !FP12.test(forbidSupabase))) return null;
  return {
    env,
    stackName,
    stackFile: values.get('--stack') as string,
    overlayFile: values.get('--overlay') ?? null,
    hostVarsFile: values.get('--host-vars') as string,
    foldersCheck: values.get('--folders-check') as string,
    stateDir: values.get('--state') as string,
    logFile: values.get('--log') as string,
    dataPrefix,
    forbidSupabase,
  };
}
