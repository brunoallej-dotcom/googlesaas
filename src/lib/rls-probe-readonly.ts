/**
 * Modo SOMENTE LEITURA do rls:probe (spec: docs/specs/g5-homologacao-funcional.md).
 *
 * Prova o bloqueio de acesso às 5 tabelas da GMN usando apenas leituras (método GET), para poder ser
 * usado também contra a produção. Todo acesso à rede passa por `createGetOnlyFetch`, que LANÇA antes de
 * enviar qualquer coisa que não seja uma das 15 leituras fixas (5 tabelas, 3 papéis).
 *
 * Fora do escopo de propósito: Storage, RPC, login e qualquer escrita (o probe completo, só para o
 * laboratório, cobre o resto). O relatório traz apenas status, códigos e contagens: nunca corpo de
 * resposta, mensagem de erro, chave, JWT ou token.
 */
import { classifyRead, forgedToken, TABLES } from './rls-probe';
import type { Verdict } from './rls-probe';

export type ReadOnlyRole = 'anon' | 'forged' | 'service_role';
export type ReadOnlyVerdict = Verdict | 'INCONCLUSIVE_EMPTY';

export interface ReadOnlyResult {
  readonly role: ReadOnlyRole;
  readonly table: string;
  readonly status: number;
  /** Código de erro do PostgREST (ex.: 42501); nunca a mensagem. */
  readonly code: string | null;
  readonly verdict: ReadOnlyVerdict;
  /** `true` quando a única barreira é o RLS (o papel tem privilégio). */
  readonly singleBarrier: boolean;
  /** Quantidade de linhas visíveis ao papel (só a contagem, nunca o conteúdo). */
  readonly visibleRows: number | null;
  /** Quantidade real de linhas, medida pela service_role. */
  readonly realRows: number | null;
}

export class ReadOnlyViolationError extends Error {
  constructor(reason: string) {
    super(`modo somente leitura violado: ${reason}`);
    this.name = 'ReadOnlyViolationError';
  }
}

const QUERY = 'select=id&limit=1';
const ALLOWED_HEADERS = new Set(['apikey', 'authorization', 'prefer', 'accept']);
const ALLOWED_INIT_KEYS = new Set(['method', 'headers', 'signal', 'redirect']);
const ERROR_CODE = /^[A-Za-z0-9_]{3,12}$/;
const DEFAULT_TIMEOUT_MS = 20_000;
/** SQLSTATE de "permission denied": só ele prova que o papel está sem GRANT (401/403 pode ser JWT expirado, chave ruim, etc.). */
const NO_PRIVILEGE_CODE = '42501';
const KNOWN_FLAGS = ['--read-only', '--authenticated', '--expect-hardened'] as const;

/** Mostra um argumento rejeitado só se parecer uma opção curta e inofensiva; qualquer outra coisa (texto solto, algo longo) não é repetida. */
const describeArg = (arg: string): string => (/^-{1,2}[A-Za-z0-9_-]{1,30}$/.test(arg) ? arg : '(argumento posicional ou inválido)');

/**
 * Valida os argumentos do script ANTES de qualquer rede. O modo completo (que escreve) é o padrão, então QUALQUER argumento que
 * não seja exatamente um dos documentados (opção com um ou dois hífens, texto solto, `--` sozinho, texto vazio, `--opção=valor`)
 * é erro de uso: nada pode cair no modo completo em silêncio. O npm engolindo a opção (`npm run rls:probe --read-only`, sem o "--")
 * também é recusado. Devolve a mensagem de erro, ou `null` se estiver tudo certo.
 */
export function validateProbeArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): string | null {
  const known: readonly string[] = KNOWN_FLAGS;
  const unknown = argv.filter((arg) => !known.includes(arg));
  if (unknown.length > 0) return `Argumento não reconhecido: ${unknown.map(describeArg).join(', ')}. Só são aceitos: ${KNOWN_FLAGS.join(', ')} (--expect-hardened só com --read-only).`;
  for (const flag of KNOWN_FLAGS) {
    const swallowed = env[`npm_config_${flag.slice(2).replace(/-/g, '_')}`];
    if (swallowed !== undefined && !argv.includes(flag)) return `O npm engoliu a opção ${flag}. Use: npm run rls:probe -- ${flag} (com o "--" antes).`;
  }
  if (argv.includes('--expect-hardened') && !argv.includes('--read-only')) return '--expect-hardened só existe junto com --read-only.';
  return null;
}

/** Só `https://host` (ou loopback), sem credenciais, caminho, consulta nem fragmento. Devolve a origem normalizada, ou `null`. */
export function parseBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') return null;
  return url.origin;
}

/**
 * `fetch` que só aceita GET, sem corpo, na URL exata de uma das 5 tabelas, com cabeçalhos conhecidos e
 * `Prefer: count=exact`. Qualquer outra coisa lança `ReadOnlyViolationError` e o `fetch` interno nunca é chamado.
 */
export function createGetOnlyFetch(baseUrl: string, inner: typeof fetch): typeof fetch {
  const prefix = `${baseUrl.replace(/\/+$/, '')}/rest/v1/`;
  const tables: readonly string[] = TABLES;
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (typeof input !== 'string') throw new ReadOnlyViolationError('entrada de requisição não textual');
    if ((init?.method ?? 'GET') !== 'GET') throw new ReadOnlyViolationError('método diferente de GET');
    for (const key of Object.keys(init ?? {})) {
      if (!ALLOWED_INIT_KEYS.has(key)) throw new ReadOnlyViolationError('opção de requisição não permitida');
    }
    if (init?.body !== undefined && init.body !== null) throw new ReadOnlyViolationError('corpo de requisição');
    if (init?.redirect !== undefined && init.redirect !== 'error') throw new ReadOnlyViolationError('redirecionamento não permitido');
    const rest = input.startsWith(prefix) ? input.slice(prefix.length).split('?') : [];
    if (rest.length !== 2 || !tables.includes(rest[0] ?? '') || rest[1] !== QUERY) throw new ReadOnlyViolationError('URL fora da lista fixa de leituras');
    const headers = init?.headers;
    if (headers !== undefined && (typeof headers !== 'object' || Array.isArray(headers) || headers instanceof Headers)) throw new ReadOnlyViolationError('cabeçalhos em formato não aceito');
    for (const [name, value] of Object.entries((headers ?? {}) as Record<string, string>)) {
      const key = name.toLowerCase();
      if (!ALLOWED_HEADERS.has(key)) throw new ReadOnlyViolationError('cabeçalho não permitido');
      if (key === 'prefer' && value !== 'count=exact') throw new ReadOnlyViolationError('Prefer diferente de count=exact');
    }
    return inner(input, init);
  };
  return guarded as typeof fetch;
}

export interface ReadOnlyProbeConfig {
  readonly baseUrl: string;
  readonly anonKey: string;
  readonly serviceKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface Reading {
  readonly status: number;
  readonly code: string | null;
  readonly rows: number | null;
}

const totalFromRange = (header: string | null): number | null => {
  const total = header?.split('/')[1];
  return total !== undefined && /^\d+$/.test(total) ? Number(total) : null;
};

/** Leitura vazia numa tabela vazia não prova nada: não é sucesso nem falha, é inconclusivo. */
function classify(status: number, visible: number, real: number): Pick<ReadOnlyResult, 'verdict' | 'singleBarrier'> {
  const base = classifyRead(status, visible, real);
  if (base.verdict === 'UNEXPECTED' && status >= 200 && status < 300 && visible === 0 && real === 0) return { verdict: 'INCONCLUSIVE_EMPTY', singleBarrier: false };
  return base;
}

export async function runReadOnlyProbe(config: ReadOnlyProbeConfig): Promise<ReadOnlyResult[]> {
  const baseUrl = parseBaseUrl(config.baseUrl);
  if (baseUrl === null) throw new ReadOnlyViolationError('URL do projeto inválida');
  const get = createGetOnlyFetch(baseUrl, config.fetchImpl ?? fetch);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const read = async (bearer: string, table: string): Promise<Reading> => {
    try {
      const response = await get(`${baseUrl}/rest/v1/${table}?${QUERY}`, {
        headers: { apikey: config.anonKey, Authorization: `Bearer ${bearer}`, Prefer: 'count=exact' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      const body = (await response.json().catch(() => null)) as unknown;
      const ok = response.status >= 200 && response.status < 300;
      const total = totalFromRange(response.headers.get('content-range'));
      const rows = ok ? total ?? (Array.isArray(body) ? body.length : 0) : null;
      const rawCode = !ok && body !== null && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
      return { status: response.status, code: typeof rawCode === 'string' && ERROR_CODE.test(rawCode) ? rawCode : null, rows };
    } catch (error) {
      if (error instanceof ReadOnlyViolationError) throw error;
      return { status: 0, code: 'NETWORK_ERROR', rows: null };
    }
  };

  const results: ReadOnlyResult[] = [];
  const real: Record<string, number> = {};
  for (const table of TABLES) {
    const reading = await read(config.serviceKey, table);
    real[table] = reading.rows ?? 0;
    const ok = reading.status >= 200 && reading.status < 300;
    results.push({ role: 'service_role', table, status: reading.status, code: reading.code, verdict: ok ? 'SERVICE_ACCESS_OK' : 'SERVICE_ACCESS_LOST', singleBarrier: false, visibleRows: reading.rows, realRows: reading.rows });
  }
  const bearers: ReadonlyArray<readonly [ReadOnlyRole, string]> = [['anon', config.anonKey], ['forged', forgedToken()]];
  for (const [role, bearer] of bearers) {
    for (const table of TABLES) {
      const reading = await read(bearer, table);
      const base = classify(reading.status, reading.rows ?? 0, real[table] ?? 0);
      // 401/403 do anon só vale como "sem privilégio" com o SQLSTATE 42501; outro código (JWT expirado, chave ruim) não prova nada.
      const unproven = role === 'anon' && base.verdict === 'BLOCKED_BY_PRIVILEGE' && reading.code !== NO_PRIVILEGE_CODE;
      const classified: Pick<ReadOnlyResult, 'verdict' | 'singleBarrier'> = unproven ? { verdict: 'UNEXPECTED', singleBarrier: false } : base;
      results.push({ role, table, status: reading.status, code: reading.code, ...classified, visibleRows: reading.rows, realRows: real[table] ?? 0 });
    }
  }
  return results;
}

export interface ReadOnlySummary {
  readonly exposed: number;
  readonly singleBarrier: number;
  readonly inconclusive: number;
  readonly unexpected: number;
  readonly serviceLost: number;
  /** 0 = tudo certo; 1 = exposição, service_role sem acesso ou inesperado; 3 = sem exposição, mas inconclusivo. */
  readonly exitCode: 0 | 1 | 3;
}

/**
 * `expectHardened` é o critério do G5: com ele, "só o RLS barra" (o papel ainda tem privilégio) também reprova.
 * Sem ele (linha de base de um banco ainda sem a `003`), isso é só um aviso.
 */
export function summarizeReadOnly(results: readonly ReadOnlyResult[], options: { readonly expectHardened?: boolean } = {}): ReadOnlySummary {
  const count = (verdict: ReadOnlyVerdict): number => results.filter((r) => r.verdict === verdict).length;
  const exposed = count('EXPOSED');
  const unexpected = count('UNEXPECTED');
  const serviceLost = count('SERVICE_ACCESS_LOST');
  const inconclusive = count('INCONCLUSIVE_EMPTY');
  const singleBarrier = results.filter((r) => r.singleBarrier).length;
  const failed = exposed > 0 || unexpected > 0 || serviceLost > 0 || (options.expectHardened === true && singleBarrier > 0);
  const exitCode = failed ? 1 : inconclusive > 0 ? 3 : 0;
  return { exposed, singleBarrier, inconclusive, unexpected, serviceLost, exitCode };
}

export function formatReadOnlyReport(results: readonly ReadOnlyResult[]): string[] {
  return results.map((r) => {
    const code = r.code === null ? '' : ` código=${r.code}`;
    return `${r.verdict.padEnd(20)} ${r.role.padEnd(13)} GET ${r.table.padEnd(24)} HTTP ${String(r.status).padStart(3)}${code}  visíveis=${r.visibleRows ?? 'n/d'} reais=${r.realRows ?? 'n/d'}`;
  });
}

export interface ReadOnlyCliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly write: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
}

/** Corpo do modo `--read-only` do script. Devolve o código de saída; nunca chama `process.exit`. */
export async function runReadOnlyCli(io: ReadOnlyCliIo): Promise<number> {
  const problem = validateProbeArgs(io.argv, io.env);
  if (problem !== null) {
    io.write(problem);
    return 2;
  }
  if (io.argv.includes('--authenticated')) {
    io.write('--read-only não aceita --authenticated: o login do operador exige envio de dados. Use o probe completo, só no laboratório.');
    return 2;
  }
  const rawUrl = io.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = io.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const serviceKey = io.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const missing = [['NEXT_PUBLIC_SUPABASE_URL', rawUrl], ['NEXT_PUBLIC_SUPABASE_ANON_KEY', anonKey], ['SUPABASE_SERVICE_ROLE_KEY', serviceKey]].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0 || !rawUrl || !anonKey || !serviceKey) {
    io.write(`Variáveis ausentes: ${missing.join(', ')}.`);
    return 2;
  }
  const baseUrl = parseBaseUrl(rawUrl);
  if (baseUrl === null) {
    io.write('NEXT_PUBLIC_SUPABASE_URL inválida: use https://<projeto>.supabase.co, sem caminho, consulta nem credenciais.');
    return 2;
  }
  const expectHardened = io.argv.includes('--expect-hardened');
  io.write(`alvo (host): ${new URL(baseUrl).host}`);
  io.write('modo: somente leitura (apenas leituras nas 5 tabelas; nenhuma escrita e nenhum outro serviço)');
  let results: ReadOnlyResult[];
  try {
    results = await runReadOnlyProbe({ baseUrl, anonKey, serviceKey, ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) });
  } catch (error) {
    if (error instanceof ReadOnlyViolationError) {
      io.write(`ABORTADO: ${error.message}`);
      return 2;
    }
    throw error;
  }
  for (const line of formatReadOnlyReport(results)) io.write(line);
  const summary = summarizeReadOnly(results, { expectHardened });
  io.write('');
  io.write(`EXPOSTO: ${summary.exposed} | só RLS como barreira: ${summary.singleBarrier} | inconclusivo (tabela vazia): ${summary.inconclusive} | inesperado: ${summary.unexpected} | service_role sem acesso: ${summary.serviceLost}`);
  if (summary.serviceLost > 0) io.write('ALERTA: a service_role não conseguiu ler alguma tabela (perda de acesso ou falha de rede; veja os códigos).');
  if (summary.exposed > 0) io.write('ATENÇÃO: há dado exposto a um papel sem privilégio (veja as linhas acima).');
  if (summary.unexpected > 0) io.write('Atenção: resposta inesperada (401 ou 403 sem o código 42501, status fora do esperado ou falha de rede).');
  if (summary.singleBarrier > 0) io.write(expectHardened ? 'FALHA (--expect-hardened): o papel ainda tem privilégio e só o RLS barra; o G5 não está efetivo neste ambiente.' : 'Aviso: o papel tem privilégio e só o RLS barra (o G5 não está efetivo neste ambiente).');
  if (summary.inconclusive > 0) io.write('Inconclusivo: há tabela vazia, e vazio não prova segurança. No laboratório, rode o seed fictício antes.');
  if (summary.exitCode === 0) io.write('Nenhuma exposição encontrada e a service_role mantém o acesso.');
  return summary.exitCode;
}
