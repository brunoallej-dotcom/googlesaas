/*
 * P9.3a — códigos de saída e saída PÚBLICA do receptor de deploy (spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.8). A saída do receptor
 * vai ao log do Actions, que é público: no sucesso, uma linha `OK …` no stdout; na falha, uma linha `ERRO <CÓDIGO>[ <DETALHE>]` no stderr. O
 * detalhe só pode ser um id `PD-xx` ou o NOME de uma variável da lista fechada abaixo; nunca conteúdo de arquivo, caminho, host, valor de
 * variável ou saída do Docker. O job remonta a linha e só aceita esse conjunto fechado (`deploy/ci/receiver-call.sh`, P9.4).
 */

/** Saída numérica de cada código (§5.8): os comuns aos dois receptores e os do receptor de deploy. */
export const RECEIVER_EXIT_CODES = {
  E_COMMAND: 10,
  E_INPUT_TOO_LARGE: 11,
  E_INPUT_TRUNCATED: 12,
  E_HASH_MISMATCH: 13,
  E_TRUST_LIST_MISMATCH: 14,
  E_TRUST_LIST_INVALID: 15,
  E_LOCKED: 16,
  E_ARTIFACT: 17,
  E_INTERNAL: 29,
  E_NOT_STAGED: 50,
  E_STACK_FILE_MISMATCH: 51,
  E_HOST_CONFIG: 52,
  E_HOST_FOLDERS: 53,
  E_SUPABASE_MISMATCH: 54,
  E_HML_PRODUCTION_PROJECT: 55,
  E_WORKER_REPLICAS_DRIFT: 56,
  E_DISK_LOW: 57,
  E_BUNDLE_TAGS: 58,
  E_DOCKER_LOAD: 59,
  E_STACK_CONFIG: 60,
  E_STACK_DEPLOY: 61,
  E_ROLLED_BACK: 62,
  E_CONVERGE_TIMEOUT: 63,
  E_POSTDEPLOY_CHECK: 64,
  E_DATA_PREFIX: 65,
  E_TRUST_LIST_TRANSITION: 66,
} as const;

export type ReceiverCode = keyof typeof RECEIVER_EXIT_CODES;
export const EXIT_OK = 0;

/**
 * Nomes que o `E_HOST_CONFIG` pode trazer: as variáveis proibidas, as obrigatórias e as pastas de homologação (§5.6 passo 4). É a MESMA lista
 * fechada do job (`HOST_CONFIG_NAMES` em `deploy/ci/receiver-call.sh`, P9.4): um nome novo entra nas duas no mesmo PR. Um defeito sem nome desta
 * lista (linha ilegível, nome reservado) sai como `E_HOST_CONFIG` sem detalhe, e o valor nunca aparece.
 */
export const HOST_CONFIG_NAMES = [
  'GMN_IMAGE_TAG',
  'GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS',
  'GMN_AUTH_DISABLED',
  'GMN_DEMO_MODE',
  'GMN_LINK_AUDIT_HOMOLOGATION',
  'GMN_TRAEFIK_NAME',
  'GMN_WORKER_REPLICAS',
  'GMN_DATA_ROOT',
  'GMN_RAIZ_DADOS_DECISOES',
  'GMN_RAIZ_DADOS_RECIBOS_DECISOES',
  'GMN_RAIZ_DADOS_RESULTADOS',
  'GMN_RAIZ_DADOS_RECIBOS_RESULTADOS',
  'GMN_RAIZ_DADOS_LIVRO',
  'GMN_RAIZ_DADOS_MANIFESTOS',
  'NEXT_PUBLIC_SUPABASE_URL',
  'GMN_HOST',
  'GMN_NODE_HOSTNAME',
  'GMN_OPERATOR_EMAILS',
] as const;
export type HostConfigName = (typeof HOST_CONFIG_NAMES)[number];
const HOST_CONFIG_NAME_SET: ReadonlySet<string> = new Set(HOST_CONFIG_NAMES);
export const isHostConfigName = (name: string): name is HostConfigName => HOST_CONFIG_NAME_SET.has(name);

/** As verificações pós-deploy (§5.6 passo 13), na ordem em que rodam. */
export const POSTDEPLOY_CHECK_IDS = ['PD-01', 'PD-02', 'PD-03', 'PD-04', 'PD-05', 'PD-06', 'PD-07', 'PD-08'] as const;
export type PostdeployCheckId = (typeof POSTDEPLOY_CHECK_IDS)[number];

export type ReceiverDetail = HostConfigName | PostdeployCheckId;

/**
 * Recusa com código fixo. `detail` é tipado: só um nome da lista fechada (com `E_HOST_CONFIG`) ou um id `PD-xx` (com `E_POSTDEPLOY_CHECK`).
 * `logNote` vai SÓ ao log local (nunca à saída pública) e nunca leva valor de variável.
 */
export class ReceiverError extends Error {
  readonly code: ReceiverCode;
  readonly detail: ReceiverDetail | null;
  readonly logNote: string | null;
  constructor(code: ReceiverCode, detail: ReceiverDetail | null = null, logNote: string | null = null) {
    super(detail === null ? code : `${code} ${detail}`);
    this.name = 'ReceiverError';
    this.code = code;
    this.detail = detail;
    this.logNote = logNote;
  }
}

/** O único formato de recusa pública: `ERRO <CÓDIGO>[ <DETALHE>]`, com detalhe só onde a lista fechada permite. */
export function publicErrorLine(code: ReceiverCode, detail: ReceiverDetail | null): string {
  const allowed = (code === 'E_HOST_CONFIG' && detail !== null && isHostConfigName(detail)) || (code === 'E_POSTDEPLOY_CHECK' && detail !== null && (POSTDEPLOY_CHECK_IDS as readonly string[]).includes(detail));
  return allowed ? `ERRO ${code} ${detail}` : `ERRO ${code}`;
}

/** Resultado de uma execução: exatamente UMA linha pública (stdout no sucesso, stderr na falha) e a saída numérica. */
export interface ReceiverOutcome {
  readonly exitCode: number;
  readonly stdout: string | null;
  readonly stderr: string | null;
}

export const okOutcome = (line: string): ReceiverOutcome => ({ exitCode: EXIT_OK, stdout: line, stderr: null });
export const errorOutcome = (code: ReceiverCode, detail: ReceiverDetail | null = null): ReceiverOutcome => ({ exitCode: RECEIVER_EXIT_CODES[code], stdout: null, stderr: publicErrorLine(code, detail) });
