import { isCleanAbsolutePath } from './args';
import { isHostConfigName, ReceiverError, type HostConfigName } from './codes';
import type { DeployEnvironment } from './grammar';

/*
 * P9.3a — o arquivo de variáveis do host (spec §5.6 passo 4), lido como DADO por um parser estrito e nunca executado como shell:
 *   - uma atribuição por linha, `NOME=valor`, com o valor sem aspas, entre aspas duplas ou entre aspas simples, SEM expansão;
 *   - `$`, crase e barra invertida são recusados em qualquer valor (com ou sem aspas), como a conferência do runbook (`grep '\$|`|^export '`);
 *   - linhas vazias e linhas que começam com `#` são ignoradas; qualquer outra coisa (espaço antes ou depois do `=`, `export`, aspas abertas,
 *     comentário no fim da linha, caractere de controle, CRLF, BOM, UTF-8 inválido, nome repetido) recusa.
 * Recusa ⇒ `E_HOST_CONFIG <NOME>` com o nome só se ele for da lista fechada (§5.8; `HOST_CONFIG_NAMES`), senão sem detalhe; o valor NUNCA sai.
 * Puro (bytes de entrada; a conferência do caminho real das pastas fica no passo do deploy, pela porta de disco).
 */

/** Teto do arquivo (o modelo do runbook tem ~1 KiB). */
export const MAX_HOST_VARS_BYTES = 64 * 1024;
const NAME_AT_START = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const DOUBLE_QUOTED = /^"([^"$`\\]*)"$/;
const SINGLE_QUOTED = /^'([^'$`\\]*)'$/;
const UNQUOTED = /^[^\s"'$`\\]*$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const BOM = [0xef, 0xbb, 0xbf] as const;
/** Nomes que mudariam o processo filho (`docker`) ou o daemon que ele alcança: o receptor nunca os repassa. */
const RESERVED_EXACT: ReadonlySet<string> = new Set(['PATH', 'HOME']);
const RESERVED_PREFIXES = ['DOCKER_', 'LD_'] as const;

/** Definidas pelo próprio receptor ou perigosas: proibidas nos dois ambientes. */
export const FORBIDDEN_EVERYWHERE: readonly HostConfigName[] = ['GMN_IMAGE_TAG', 'GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS', 'GMN_AUTH_DISABLED', 'GMN_DEMO_MODE'];
export const FORBIDDEN_IN_PRODUCTION: readonly HostConfigName[] = ['GMN_LINK_AUDIT_HOMOLOGATION'];
/** Obrigatórias e não vazias (a stack as exige: `${…:?}`, ou a aplicação falha fechada sem elas; a URL dá a impressão do passo 5). */
export const REQUIRED_NON_EMPTY: readonly HostConfigName[] = ['NEXT_PUBLIC_SUPABASE_URL', 'GMN_HOST', 'GMN_NODE_HOSTNAME', 'GMN_OPERATOR_EMAILS'];
/** As seis pastas da Fase 6, na ordem dos argumentos do `verificar-pastas-fase6.sh`. */
export const DATA_FOLDER_NAMES = [
  'GMN_RAIZ_DADOS_DECISOES',
  'GMN_RAIZ_DADOS_RECIBOS_DECISOES',
  'GMN_RAIZ_DADOS_RESULTADOS',
  'GMN_RAIZ_DADOS_RECIBOS_RESULTADOS',
  'GMN_RAIZ_DADOS_LIVRO',
  'GMN_RAIZ_DADOS_MANIFESTOS',
] as const satisfies readonly HostConfigName[];
const WORKER_REPLICAS = /^(0|[1-9][0-9]?)$/;
const PRODUCTION_TRAEFIK_NAME = 'gmn';

export type HostVarsIssue = 'TOO_LARGE' | 'BOM' | 'NOT_UTF8' | 'CONTROL_CHARACTER' | 'SYNTAX' | 'DUPLICATE' | 'RESERVED' | 'FORBIDDEN' | 'MISSING' | 'INVALID';

/** Recusa do arquivo: o nome (só da lista fechada vai à saída), a linha e o motivo (só ao log local). Nunca o valor. */
function hostConfigError(issue: HostVarsIssue, name: string | null, line: number | null = null): ReceiverError {
  const detail = name !== null && isHostConfigName(name) ? name : null;
  const where = line === null ? '' : ` line=${line}`;
  // o log local leva o motivo, a linha e só um nome da lista fechada: um "nome" fora dela pode ser pedaço de um valor
  return new ReceiverError('E_HOST_CONFIG', detail, `host-vars ${issue}${where}${detail === null ? '' : ` name=${detail}`}`);
}

const isReserved = (name: string): boolean => RESERVED_EXACT.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));

function decodeStrict(raw: Uint8Array): string {
  if (raw.byteLength > MAX_HOST_VARS_BYTES) throw hostConfigError('TOO_LARGE', null);
  if (BOM.every((byte, index) => raw[index] === byte)) throw hostConfigError('BOM', null);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw hostConfigError('NOT_UTF8', null);
  }
}

/** O valor de uma atribuição, sem expansão; `null` se fora do subconjunto aceito. */
function parseValue(rawValue: string): string | null {
  const quoted = DOUBLE_QUOTED.exec(rawValue) ?? SINGLE_QUOTED.exec(rawValue);
  if (quoted) return quoted[1] as string;
  return UNQUOTED.test(rawValue) ? rawValue : null;
}

function parseLine(line: string, lineNumber: number): readonly [string, string] | null {
  if (line === '' || line.startsWith('#')) return null;
  const nameAtStart = NAME_AT_START.exec(line)?.[1] ?? null;
  if (CONTROL_CHARACTER.test(line)) throw hostConfigError('CONTROL_CHARACTER', nameAtStart, lineNumber);
  const match = ASSIGNMENT.exec(line);
  const value = match ? parseValue(match[2] as string) : null;
  if (!match || value === null) throw hostConfigError('SYNTAX', nameAtStart, lineNumber);
  return [match[1] as string, value];
}

/** O arquivo como mapa NOME → valor. Lança `ReceiverError('E_HOST_CONFIG', …)` na primeira linha fora do subconjunto. */
export function parseHostVarsFile(raw: Uint8Array): ReadonlyMap<string, string> {
  const text = decodeStrict(raw);
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const vars = new Map<string, string>();
  lines.forEach((line, index) => {
    const parsed = parseLine(line, index + 1);
    if (parsed === null) return;
    const [name, value] = parsed;
    if (vars.has(name)) throw hostConfigError('DUPLICATE', name, index + 1);
    if (isReserved(name)) throw hostConfigError('RESERVED', name, index + 1);
    vars.set(name, value);
  });
  return vars;
}

/** O que o deploy usa do arquivo, já conferido pelas regras do passo 4. */
export interface HostConfig {
  readonly vars: ReadonlyMap<string, string>;
  readonly supabaseUrl: string;
  /** `GMN_WORKER_REPLICAS` (padrão 0). */
  readonly workerReplicas: number;
  /** Os seis `GMN_RAIZ_DADOS_*`, na ordem do `verificar-pastas-fase6.sh`. */
  readonly dataFolders: readonly string[];
  /** As pastas que, em homologação, têm de ficar sob `--data-prefix` (`GMN_DATA_ROOT` e as seis). */
  readonly prefixedFolders: readonly string[];
}

function requireNames(vars: ReadonlyMap<string, string>, env: DeployEnvironment): void {
  const forbidden = env === 'producao' ? [...FORBIDDEN_EVERYWHERE, ...FORBIDDEN_IN_PRODUCTION] : FORBIDDEN_EVERYWHERE;
  for (const name of forbidden) if (vars.has(name)) throw hostConfigError('FORBIDDEN', name);
  for (const name of REQUIRED_NON_EMPTY) if (!vars.get(name)) throw hostConfigError('MISSING', name);
  for (const name of DATA_FOLDER_NAMES) {
    const value = vars.get(name);
    if (value === undefined) throw hostConfigError('MISSING', name);
    if (!isCleanAbsolutePath(value)) throw hostConfigError('INVALID', name);
  }
}

function workerReplicasOf(vars: ReadonlyMap<string, string>, env: DeployEnvironment): number {
  const raw = vars.get('GMN_WORKER_REPLICAS');
  if (raw === undefined) return 0;
  if (!WORKER_REPLICAS.test(raw) || (env === 'homologacao' && raw !== '0')) throw hostConfigError('INVALID', 'GMN_WORKER_REPLICAS');
  return Number(raw);
}

function dataRootOf(vars: ReadonlyMap<string, string>, env: DeployEnvironment): string | null {
  const dataRoot = vars.get('GMN_DATA_ROOT');
  if (dataRoot === undefined) {
    if (env === 'homologacao') throw hostConfigError('MISSING', 'GMN_DATA_ROOT');
    return null;
  }
  if (!isCleanAbsolutePath(dataRoot)) throw hostConfigError('INVALID', 'GMN_DATA_ROOT');
  return dataRoot;
}

function homologationRules(vars: ReadonlyMap<string, string>): void {
  const traefikName = vars.get('GMN_TRAEFIK_NAME');
  if (traefikName === undefined) throw hostConfigError('MISSING', 'GMN_TRAEFIK_NAME');
  if (traefikName === '' || traefikName === PRODUCTION_TRAEFIK_NAME) throw hostConfigError('INVALID', 'GMN_TRAEFIK_NAME');
}

/** `value` sob `prefix` (com `/` no fim): o próprio prefixo sem a barra ou algo dentro dele. Só texto; o caminho real é conferido à parte. */
export const isUnderPrefix = (value: string, prefix: string): boolean => value === prefix.slice(0, -1) || value.startsWith(prefix);

/**
 * Regras do passo 4 sobre o arquivo já analisado: proibidas (as duas que o receptor define, `GMN_AUTH_DISABLED`, `GMN_DEMO_MODE`; em produção
 * também `GMN_LINK_AUDIT_HOMOLOGATION`), obrigatórias, réplicas do Worker, e em homologação `GMN_TRAEFIK_NAME` (≠ `gmn`), `GMN_WORKER_REPLICAS`
 * ausente ou `0`, `GMN_DATA_ROOT` e as seis pastas sob `--data-prefix` (texto; `E_DATA_PREFIX`).
 */
export function checkHostConfig(vars: ReadonlyMap<string, string>, env: DeployEnvironment, dataPrefix: string | null): HostConfig {
  requireNames(vars, env);
  const workerReplicas = workerReplicasOf(vars, env);
  const dataRoot = dataRootOf(vars, env);
  const dataFolders = DATA_FOLDER_NAMES.map((name) => vars.get(name) as string);
  const prefixedFolders = env === 'homologacao' ? [dataRoot as string, ...dataFolders] : [];
  if (env === 'homologacao') {
    homologationRules(vars);
    if (dataPrefix === null || prefixedFolders.some((folder) => !isUnderPrefix(folder, dataPrefix))) throw new ReceiverError('E_DATA_PREFIX', null, 'host-vars folder outside --data-prefix');
  }
  return { vars, supabaseUrl: vars.get('NEXT_PUBLIC_SUPABASE_URL') as string, workerReplicas, dataFolders, prefixedFolders };
}
