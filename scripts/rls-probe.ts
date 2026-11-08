/**
 * Sondas de acesso por papel (somente leitura/sem efeito): anon, token forjado e, opcionalmente,
 * o operador autenticado. Não cria, altera nem apaga dados (escritas usam filtro impossível).
 *
 *   npm run rls:probe                      (anon + token forjado)
 *   npm run rls:probe -- --authenticated   (inclui o operador; a senha é pedida no terminal)
 *   npm run rls:probe -- --read-only       (SOMENTE leituras nas 5 tabelas: seguro também para a produção;
 *                                           ver docs/specs/g5-homologacao-funcional.md)
 *   npm run rls:probe -- --read-only --expect-hardened   (idem, e "só o RLS barra" também reprova: critério do G5)
 *
 * Use SEMPRE o "--" antes das opções. Opção desconhecida, ou o npm engolindo --read-only, encerra com erro (2).
 *
 * ATENÇÃO: o modo completo (sem --read-only) envia escritas com filtro impossível, uma chamada de função e
 * listagens do Storage: use-o só no laboratório ou com autorização escrita.
 */
import { Writable } from 'node:stream';
import readline from 'node:readline';
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

async function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    muted = true;
  });
}

async function main(): Promise<void> {
  // Argumentos primeiro: o modo completo (que escreve) é o padrão, então opção desconhecida, erro de digitação ou o npm
  // engolindo `--read-only` (sem o "--") NÃO podem cair nele em silêncio.
  const { validateProbeArgs } = await import('@/lib/rls-probe-readonly');
  const problem = validateProbeArgs(process.argv.slice(2), process.env);
  if (problem !== null) {
    console.error(problem);
    process.exit(2);
  }
  // O modo somente leitura vem ANTES de qualquer rede, senha ou leitura de variável do probe completo.
  if (process.argv.includes('--read-only')) {
    const { runReadOnlyCli } = await import('@/lib/rls-probe-readonly');
    process.exit(await runReadOnlyCli({ env: process.env, argv: process.argv.slice(2), write: (line) => console.log(line) }));
  }
  const { runRlsProbe, summarize } = await import('@/lib/rls-probe');
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !anonKey || !serviceKey) throw new Error('Variáveis do Supabase ausentes.');

  let userToken: string | undefined;
  if (process.argv.includes('--authenticated')) {
    const email = process.env.GMN_OPERATOR_EMAILS?.split(/[,;\s]+/)[0];
    if (!email) throw new Error('GMN_OPERATOR_EMAILS vazio.');
    const password = process.env.GMN_PROBE_PASSWORD ?? (await askHidden(`Senha do operador ${email}: `));
    const res = await fetch(`${baseUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anonKey, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new Error('Login do operador recusado; sondagem autenticada cancelada.');
    userToken = body.access_token;
  }

  const bucket = process.env.SUPABASE_AUDIT_BUCKET?.trim() || 'gmn-audit-pdfs';
  const list = await fetch(`${baseUrl}/storage/v1/object/list/${bucket}`, { method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ prefix: 'audits', limit: 1 }) });
  const folders = (await list.json().catch(() => [])) as { name?: string }[];
  let knownObjectKey: string | undefined;
  if (folders[0]?.name) {
    const inner = await fetch(`${baseUrl}/storage/v1/object/list/${bucket}`, { method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ prefix: `audits/${folders[0].name}`, limit: 1 }) });
    const files = (await inner.json().catch(() => [])) as { name?: string }[];
    if (files[0]?.name) knownObjectKey = `audits/${folders[0].name}/${files[0].name}`;
  }

  const results = await runRlsProbe({ baseUrl, anonKey, serviceKey, bucket, ...(knownObjectKey ? { knownObjectKey } : {}), ...(userToken ? { userToken } : {}) });
  for (const r of results) console.log(`${r.verdict.padEnd(22)} ${r.role.padEnd(13)} ${r.operation.padEnd(34)} ${r.resource.padEnd(34)} HTTP ${r.status}  ${r.detail}`);
  const summary = summarize(results);
  console.log(`\nEXPOSTO: ${summary.exposed.length} | só RLS como barreira: ${summary.singleBarrier.length} | inesperado: ${summary.unexpected.length} | service_role sem acesso: ${summary.serviceLost.length}`);
  if (summary.serviceLost.length > 0) console.log('ALERTA: a service_role perdeu acesso a alguma tabela; o app deixaria de funcionar. Reverta (supabase/proposed/003_rls_hardening.rollback.sql).');
  console.log(summary.ok ? 'Nenhum dado exposto aos papéis testados e a service_role mantém o acesso.' : 'ATENÇÃO: há exposição ou perda de acesso (veja as linhas acima).');
  if (summary.singleBarrier.length > 0) console.log('Aviso: o papel tem privilégio e só o RLS barra. Recomenda-se revogar privilégios (supabase/proposed/003_rls_hardening.sql).');
  process.exit(summary.ok ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
