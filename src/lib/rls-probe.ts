/**
 * Sondas de acesso ao Supabase por PAPEL (anon, operador autenticado, token forjado), sem criar
 * nem alterar dados. Um resultado vazio NÃO prova segurança: ele só mostra que o RLS filtrou. A
 * classificação separa "sem privilégio" de "privilégio presente, barrado apenas pelo RLS".
 */
export type Verdict =
  | 'BLOCKED_BY_PRIVILEGE' // 401/403 (42501): o papel nem tem permissão
  | 'FILTERED_BY_RLS' // 200 com 0 linhas, mas a tabela TEM linhas: o papel tem privilégio e só o RLS barra
  | 'EXPOSED' // dados ou efeito visíveis ao papel
  | 'NOT_EXPOSED' // recurso inexistente/negado de forma explícita (ex.: bucket privado)
  | 'SERVICE_ACCESS_OK' // service_role mantém o acesso que o app precisa
  | 'SERVICE_ACCESS_LOST' // service_role perdeu acesso: o app quebraria
  | 'UNEXPECTED';

export interface ProbeResult {
  readonly role: 'anon' | 'authenticated' | 'forged' | 'service_role';
  readonly resource: string;
  readonly operation: string;
  readonly status: number;
  readonly verdict: Verdict;
  /** `true` quando a única barreira é o RLS (defesa em profundidade ausente). */
  readonly singleBarrier: boolean;
  readonly detail: string;
}

export const TABLES = ['prospecting_campaigns', 'gmn_leads', 'gmn_audits', 'gmn_battlefield_rounds', 'gmn_battlefield_points'] as const;
const IMPOSSIBLE_ID = '00000000-0000-0000-0000-000000000000';

export function classifyRead(status: number, rows: number, controlRows: number): Pick<ProbeResult, 'verdict' | 'singleBarrier'> {
  if (status === 401 || status === 403) return { verdict: 'BLOCKED_BY_PRIVILEGE', singleBarrier: false };
  if (status >= 200 && status < 300) {
    if (rows > 0) return { verdict: 'EXPOSED', singleBarrier: false };
    return controlRows > 0 ? { verdict: 'FILTERED_BY_RLS', singleBarrier: true } : { verdict: 'UNEXPECTED', singleBarrier: false };
  }
  return { verdict: 'UNEXPECTED', singleBarrier: false };
}

/** Escrita com filtro IMPOSSÍVEL: nunca altera linha alguma; só revela se o papel tem privilégio. */
export function classifyWrite(status: number, affectedRows: number): Pick<ProbeResult, 'verdict' | 'singleBarrier'> {
  if (status === 401 || status === 403) return { verdict: 'BLOCKED_BY_PRIVILEGE', singleBarrier: false };
  if (status >= 200 && status < 300) return affectedRows > 0 ? { verdict: 'EXPOSED', singleBarrier: false } : { verdict: 'FILTERED_BY_RLS', singleBarrier: true };
  return { verdict: 'UNEXPECTED', singleBarrier: false };
}

export interface ProbeConfig {
  readonly baseUrl: string;
  readonly anonKey: string;
  readonly serviceKey: string;
  readonly fetchImpl?: typeof fetch;
  /** Token de operador autenticado (opcional). */
  readonly userToken?: string;
  readonly knownObjectKey?: string;
  readonly bucket?: string;
}

const countFromRange = (header: string | null): number => {
  const total = header?.split('/')[1];
  return total && total !== '*' ? Number(total) : 0;
};

export async function runRlsProbe(config: ProbeConfig): Promise<ProbeResult[]> {
  const f = config.fetchImpl ?? fetch;
  const results: ProbeResult[] = [];
  const headers = (role: ProbeResult['role'], extra: Record<string, string> = {}): Record<string, string> => {
    const bearer = role === 'authenticated' ? config.userToken ?? config.anonKey : role === 'forged' ? forgedToken() : config.anonKey;
    return { apikey: config.anonKey, Authorization: `Bearer ${bearer}`, ...extra };
  };
  const roles: ProbeResult['role'][] = config.userToken ? ['anon', 'authenticated', 'forged'] : ['anon', 'forged'];

  // Controle: contagem real com a service role (para distinguir "vazio" de "filtrado")
  const control: Record<string, number> = {};
  for (const table of TABLES) {
    const res = await f(`${config.baseUrl}/rest/v1/${table}?select=id&limit=1`, { headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}`, Prefer: 'count=exact' } });
    control[table] = countFromRange(res.headers.get('content-range'));
  }

  // O app depende da service_role: SELECT real e escritas com filtro IMPOSSÍVEL (0 linhas, nenhum efeito)
  // precisam ser ACEITOS. 401/403 aqui significaria que o app perdeu acesso.
  for (const table of TABLES) {
    const svc = { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` };
    const read = await f(`${config.baseUrl}/rest/v1/${table}?select=id&limit=1`, { headers: { ...svc, Prefer: 'count=exact' } });
    results.push({ role: 'service_role', resource: table, operation: 'SELECT', status: read.status, verdict: read.status >= 200 && read.status < 300 && countFromRange(read.headers.get('content-range')) === (control[table] ?? 0) ? 'SERVICE_ACCESS_OK' : 'SERVICE_ACCESS_LOST', singleBarrier: false, detail: `linhas reais: ${control[table]}` });
    const patch = await f(`${config.baseUrl}/rest/v1/${table}?id=eq.${IMPOSSIBLE_ID}`, { method: 'PATCH', headers: { ...svc, 'content-type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ id: IMPOSSIBLE_ID }) });
    results.push({ role: 'service_role', resource: table, operation: 'UPDATE (filtro impossível)', status: patch.status, verdict: patch.status >= 200 && patch.status < 300 ? 'SERVICE_ACCESS_OK' : 'SERVICE_ACCESS_LOST', singleBarrier: false, detail: 'privilégio de escrita presente, 0 linhas afetadas' });
    const del = await f(`${config.baseUrl}/rest/v1/${table}?id=eq.${IMPOSSIBLE_ID}`, { method: 'DELETE', headers: { ...svc, Prefer: 'return=representation' } });
    results.push({ role: 'service_role', resource: table, operation: 'DELETE (filtro impossível)', status: del.status, verdict: del.status >= 200 && del.status < 300 ? 'SERVICE_ACCESS_OK' : 'SERVICE_ACCESS_LOST', singleBarrier: false, detail: 'privilégio de escrita presente, 0 linhas afetadas' });
  }

  for (const role of roles) {
    for (const table of TABLES) {
      const read = await f(`${config.baseUrl}/rest/v1/${table}?select=id&limit=5`, { headers: headers(role, { Prefer: 'count=exact' }) });
      const body = (await read.json().catch(() => null)) as unknown;
      const rows = Array.isArray(body) ? body.length : 0;
      results.push({ role, resource: table, operation: 'SELECT', status: read.status, ...classifyRead(read.status, rows, control[table] ?? 0), detail: `linhas visíveis: ${rows}; linhas reais: ${control[table]}` });

      const patch = await f(`${config.baseUrl}/rest/v1/${table}?id=eq.${IMPOSSIBLE_ID}`, { method: 'PATCH', headers: headers(role, { 'content-type': 'application/json', Prefer: 'return=representation' }), body: JSON.stringify({ id: IMPOSSIBLE_ID }) });
      const patched = (await patch.json().catch(() => null)) as unknown;
      results.push({ role, resource: table, operation: 'UPDATE (filtro impossível)', status: patch.status, ...classifyWrite(patch.status, Array.isArray(patched) ? patched.length : 0), detail: 'nenhuma linha pode ser afetada' });

      const del = await f(`${config.baseUrl}/rest/v1/${table}?id=eq.${IMPOSSIBLE_ID}`, { method: 'DELETE', headers: headers(role, { Prefer: 'return=representation' }) });
      const deleted = (await del.json().catch(() => null)) as unknown;
      results.push({ role, resource: table, operation: 'DELETE (filtro impossível)', status: del.status, ...classifyWrite(del.status, Array.isArray(deleted) ? deleted.length : 0), detail: 'nenhuma linha pode ser afetada' });
    }

    const rpc = await f(`${config.baseUrl}/rest/v1/rpc/trigger_set_updated_at`, { method: 'POST', headers: headers(role, { 'content-type': 'application/json' }), body: '{}' });
    results.push({ role, resource: 'rpc/trigger_set_updated_at', operation: 'EXECUTE', status: rpc.status, verdict: rpc.status === 200 ? 'EXPOSED' : rpc.status === 401 || rpc.status === 403 || rpc.status === 404 ? 'NOT_EXPOSED' : 'UNEXPECTED', singleBarrier: false, detail: 'função de trigger não deve ser chamável' });

    const buckets = await f(`${config.baseUrl}/storage/v1/bucket`, { headers: headers(role) });
    const bucketList = (await buckets.json().catch(() => null)) as unknown;
    results.push({ role, resource: 'storage/buckets', operation: 'LIST', status: buckets.status, verdict: Array.isArray(bucketList) && bucketList.length > 0 ? 'EXPOSED' : 'NOT_EXPOSED', singleBarrier: false, detail: `buckets visíveis: ${Array.isArray(bucketList) ? bucketList.length : 'n/d'}` });

    if (config.bucket) {
      const objects = await f(`${config.baseUrl}/storage/v1/object/list/${config.bucket}`, { method: 'POST', headers: headers(role, { 'content-type': 'application/json' }), body: JSON.stringify({ prefix: '', limit: 5 }) });
      const objectList = (await objects.json().catch(() => null)) as unknown;
      results.push({ role, resource: `storage/${config.bucket}`, operation: 'LIST objetos', status: objects.status, verdict: Array.isArray(objectList) && objectList.length > 0 ? 'EXPOSED' : 'NOT_EXPOSED', singleBarrier: false, detail: `objetos visíveis: ${Array.isArray(objectList) ? objectList.length : 'n/d'}` });
      if (config.knownObjectKey) {
        const direct = await f(`${config.baseUrl}/storage/v1/object/authenticated/${config.bucket}/${config.knownObjectKey}`, { method: 'HEAD', headers: headers(role) });
        results.push({ role, resource: `storage/${config.bucket}/<objeto>`, operation: 'GET autenticado de objeto conhecido', status: direct.status, verdict: direct.status === 200 ? 'EXPOSED' : 'NOT_EXPOSED', singleBarrier: false, detail: 'quem conhece o caminho não deve conseguir ler' });
      }
    }

    const admin = await f(`${config.baseUrl}/auth/v1/admin/users?per_page=1`, { headers: headers(role) });
    results.push({ role, resource: 'auth/admin/users', operation: 'LIST', status: admin.status, verdict: admin.status === 200 ? 'EXPOSED' : 'NOT_EXPOSED', singleBarrier: false, detail: 'somente a service role pode listar usuários' });
  }

  if (config.bucket && config.knownObjectKey) {
    const publicHead = await f(`${config.baseUrl}/storage/v1/object/public/${config.bucket}/${config.knownObjectKey}`, { method: 'HEAD' });
    results.push({ role: 'anon', resource: `storage/${config.bucket}/<objeto>`, operation: 'GET público SEM credencial', status: publicHead.status, verdict: publicHead.status === 200 ? 'EXPOSED' : 'NOT_EXPOSED', singleBarrier: false, detail: 'bucket público ignora o RLS' });
  }
  return results;
}

/** JWT sem assinatura válida que se diz service_role: o servidor TEM de recusar (401). */
export function forgedToken(): string {
  const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', iss: 'supabase', exp: 4102444800 })}.assinatura-falsa`;
}

export function summarize(results: readonly ProbeResult[]): { exposed: ProbeResult[]; singleBarrier: ProbeResult[]; unexpected: ProbeResult[]; serviceLost: ProbeResult[]; ok: boolean } {
  const exposed = results.filter((r) => r.verdict === 'EXPOSED');
  const singleBarrier = results.filter((r) => r.singleBarrier);
  const unexpected = results.filter((r) => r.verdict === 'UNEXPECTED');
  const serviceLost = results.filter((r) => r.verdict === 'SERVICE_ACCESS_LOST');
  return { exposed, singleBarrier, unexpected, serviceLost, ok: exposed.length === 0 && serviceLost.length === 0 };
}
