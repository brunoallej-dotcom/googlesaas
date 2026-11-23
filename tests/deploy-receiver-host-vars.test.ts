import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { HOST_CONFIG_NAMES, ReceiverError } from '../src/lib/deploy-receiver/codes';
import { canonicalSupabaseOrigin, supabaseFp12 } from '../src/lib/deploy-receiver/supabase';
import { checkHostConfig, DATA_FOLDER_NAMES, FORBIDDEN_EVERYWHERE, FORBIDDEN_IN_PRODUCTION, MAX_HOST_VARS_BYTES, parseHostVarsFile, REQUIRED_NON_EMPTY } from '../src/lib/deploy-receiver/host-vars';

/*
 * P9.3a — parser ESTRITO do arquivo de variáveis do host e regras do passo 4 (spec §5.6; P9-D04). Puro: bytes de entrada. Todo valor usado aqui é
 * uma sentinela fictícia que nunca pode aparecer na mensagem pública (só o NOME, e só da lista fechada).
 */

const SENTINELA = 'valor-sentinela-nunca-publico';
const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');
const FOLDERS = ['/srv/gmn-hml/decisoes', '/srv/gmn-hml/vol-recibos/decisoes', '/srv/gmn-hml/resultados', '/srv/gmn-hml/vol-recibos/resultados', '/srv/gmn-hml/vol-livro/livro', '/srv/gmn-hml/manifestos'];
const PREFIX = '/srv/gmn-hml/';

function baseLines(env: 'producao' | 'homologacao'): string[] {
  const lines = [
    `GMN_HOST=${SENTINELA}.invalid`,
    'GMN_NODE_HOSTNAME=no-1',
    `NEXT_PUBLIC_SUPABASE_URL="https://${SENTINELA}.supabase.invalid"`,
    `GMN_OPERATOR_EMAILS='${SENTINELA}@exemplo.invalid'`,
    ...DATA_FOLDER_NAMES.map((name, index) => `${name}=${FOLDERS[index]}`),
  ];
  if (env === 'homologacao') lines.push('GMN_DATA_ROOT=/srv/gmn-hml', 'GMN_TRAEFIK_NAME=gmn-hml');
  return lines;
}
const file = (lines: readonly string[]): Uint8Array => bytes(`${lines.join('\n')}\n`);

/** A recusa: código e detalhe públicos; a mensagem e a nota do log nunca levam a sentinela. */
function refusal(action: () => unknown): { code: string; detail: string | null } {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof ReceiverError, 'recusa tipada');
    assert.ok(!error.message.includes(SENTINELA) && !(error.logNote ?? '').includes(SENTINELA), 'o valor nunca aparece');
    return { code: error.code, detail: error.detail };
  }
  return assert.fail('devia recusar');
}
const parseAndCheck = (raw: Uint8Array, env: 'producao' | 'homologacao' = 'producao') => checkHostConfig(parseHostVarsFile(raw), env, env === 'homologacao' ? PREFIX : null);

test('P9-D04 parser: NOME=valor sem aspas, entre aspas duplas ou simples (sem expansão), valor vazio, comentários e linhas vazias; sem \\n final também passa', () => {
  const vars = parseHostVarsFile(bytes(['# comentário', '', 'A=1', 'B="dois com espaço"', "C='três # não é comentário'", 'D=', 'E=""', "F=''", 'G=https://x.invalid/a#frag', 'lower_case=ok', 'LAST=fim'].join('\n')));
  assert.deepEqual(Object.fromEntries(vars), { A: '1', B: 'dois com espaço', C: 'três # não é comentário', D: '', E: '', F: '', G: 'https://x.invalid/a#frag', lower_case: 'ok', LAST: 'fim' });
});

test('P9-D04 parser: aspas, $, crase, barra invertida, export, espaços, comentário no fim, duplicata, CRLF, BOM, NUL, controle e UTF-8 inválido ⇒ E_HOST_CONFIG (nome só da lista fechada, nunca o valor)', () => {
  const cases: ReadonlyArray<readonly [string, string | Uint8Array, string | null]> = [
    ['$ sem aspas', `GMN_HOST=${SENTINELA}$HOME`, 'GMN_HOST'],
    ['${} entre aspas duplas', `GMN_HOST="${SENTINELA}\${X}"`, 'GMN_HOST'],
    ['$ entre aspas simples (também recusado)', `GMN_HOST='${SENTINELA}$X'`, 'GMN_HOST'],
    ['$() ', `GMN_HOST=$(cat /etc/${SENTINELA})`, 'GMN_HOST'],
    ['crase', `GMN_HOST=\`id ${SENTINELA}\``, 'GMN_HOST'],
    ['crase entre aspas simples', `GMN_HOST='\`${SENTINELA}\`'`, 'GMN_HOST'],
    ['barra invertida', `GMN_HOST=${SENTINELA}\\n`, 'GMN_HOST'],
    ['aspas abertas', `GMN_HOST="${SENTINELA}`, 'GMN_HOST'],
    ['aspas misturadas', `GMN_HOST="${SENTINELA}'`, 'GMN_HOST'],
    ['texto depois das aspas', `GMN_HOST="${SENTINELA}"x`, 'GMN_HOST'],
    ['espaço sem aspas', `GMN_HOST=${SENTINELA} x`, 'GMN_HOST'],
    ['comentário no fim', `GMN_HOST=${SENTINELA} # comentário`, 'GMN_HOST'],
    ['espaço antes do =', `GMN_HOST =${SENTINELA}`, null],
    ['espaço depois do =', `GMN_HOST= ${SENTINELA}`, 'GMN_HOST'],
    ['export', `export GMN_HOST=${SENTINELA}`, null],
    ['indentado', `  GMN_HOST=${SENTINELA}`, null],
    ['comentário indentado', `  # ${SENTINELA}`, null],
    ['linha só com espaços', '   ', null],
    ['sem =', SENTINELA, null],
    ['nome inválido', `1GMN=${SENTINELA}`, null],
    ['nome fora da lista com valor inválido', `OUTRA_VAR=$${SENTINELA}`, null],
    ['tab', `GMN_HOST=\t${SENTINELA}`, 'GMN_HOST'],
    ['CRLF', `GMN_HOST=${SENTINELA}\r`, 'GMN_HOST'],
    ['NUL', `GMN_HOST=${SENTINELA}\u0000`, 'GMN_HOST'],
    ['DEL', `GMN_HOST=${SENTINELA}\u007f`, 'GMN_HOST'],
    ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(`GMN_HOST=${SENTINELA}`)]), null],
    ['UTF-8 inválido', Buffer.concat([bytes('GMN_HOST='), Buffer.from([0xc3, 0x28])]), null],
    ['acima do teto', bytes(`A=${'x'.repeat(MAX_HOST_VARS_BYTES)}`), null],
    ['PATH reservado', `PATH=/tmp/${SENTINELA}`, null],
    ['HOME reservado', `HOME=/tmp/${SENTINELA}`, null],
    ['DOCKER_HOST reservado', `DOCKER_HOST=tcp://${SENTINELA}:2375`, null],
    ['LD_PRELOAD reservado', `LD_PRELOAD=/tmp/${SENTINELA}.so`, null],
  ];
  for (const [label, line, detail] of cases) {
    const raw = typeof line === 'string' ? bytes(`GMN_NODE_HOSTNAME=no-1\n${line}\n`) : line;
    assert.deepEqual(refusal(() => parseHostVarsFile(raw)), { code: 'E_HOST_CONFIG', detail }, label);
  }
  assert.deepEqual(refusal(() => parseHostVarsFile(bytes(`GMN_HOST=a\nGMN_NODE_HOSTNAME=b\nGMN_HOST=${SENTINELA}\n`))), { code: 'E_HOST_CONFIG', detail: 'GMN_HOST' }, 'duplicata');
  assert.deepEqual(refusal(() => parseHostVarsFile(bytes('OUTRA=a\nOUTRA=b\n'))), { code: 'E_HOST_CONFIG', detail: null }, 'duplicata de nome fora da lista: sem detalhe');
});

test('P9-D04 regras: cada variável proibida do passo 4 (nos dois ambientes, e GMN_LINK_AUDIT_HOMOLOGATION em produção) ⇒ E_HOST_CONFIG <NOME>, mesmo com valor vazio', () => {
  for (const env of ['producao', 'homologacao'] as const) {
    for (const name of FORBIDDEN_EVERYWHERE) {
      assert.deepEqual(refusal(() => parseAndCheck(file([...baseLines(env), `${name}=${SENTINELA}`]), env)), { code: 'E_HOST_CONFIG', detail: name }, `${env} ${name}`);
      assert.deepEqual(refusal(() => parseAndCheck(file([...baseLines(env), `${name}=`]), env)), { code: 'E_HOST_CONFIG', detail: name }, `${env} ${name} vazio`);
    }
  }
  for (const name of FORBIDDEN_IN_PRODUCTION) assert.deepEqual(refusal(() => parseAndCheck(file([...baseLines('producao'), `${name}=1`]))), { code: 'E_HOST_CONFIG', detail: name });
  assert.equal(parseAndCheck(file([...baseLines('homologacao'), 'GMN_LINK_AUDIT_HOMOLOGATION=1']), 'homologacao').workerReplicas, 0, 'a trava no arquivo de homologação não é proibida (vem da sobreposição)');
});

test('P9-D04 regras: obrigatórias ausentes ou vazias, pasta não absoluta, réplicas fora do formato ⇒ E_HOST_CONFIG <NOME>; arquivo válido passa', () => {
  assert.equal(parseAndCheck(file(baseLines('producao'))).workerReplicas, 0);
  for (const name of [...REQUIRED_NON_EMPTY, ...DATA_FOLDER_NAMES]) {
    const without = baseLines('producao').filter((line) => !line.startsWith(`${name}=`));
    assert.deepEqual(refusal(() => parseAndCheck(file(without))), { code: 'E_HOST_CONFIG', detail: name }, `${name} ausente`);
  }
  for (const name of REQUIRED_NON_EMPTY) {
    const empty = baseLines('producao').map((line) => (line.startsWith(`${name}=`) ? `${name}=` : line));
    assert.deepEqual(refusal(() => parseAndCheck(file(empty))), { code: 'E_HOST_CONFIG', detail: name }, `${name} vazio`);
  }
  const relative = baseLines('producao').map((line) => (line.startsWith('GMN_RAIZ_DADOS_LIVRO=') ? 'GMN_RAIZ_DADOS_LIVRO=srv/livro' : line));
  assert.deepEqual(refusal(() => parseAndCheck(file(relative))), { code: 'E_HOST_CONFIG', detail: 'GMN_RAIZ_DADOS_LIVRO' });
  for (const value of ['-1', '01', 'um', '100', ' 1']) assert.deepEqual(refusal(() => parseAndCheck(file([...baseLines('producao'), `GMN_WORKER_REPLICAS=${value}`]))), { code: 'E_HOST_CONFIG', detail: 'GMN_WORKER_REPLICAS' }, value);
  assert.equal(parseAndCheck(file([...baseLines('producao'), 'GMN_WORKER_REPLICAS=1'])).workerReplicas, 1, 'produção pode ter o Worker ligado (o receptor só confere o desvio)');
  assert.deepEqual(refusal(() => parseAndCheck(file([...baseLines('producao'), 'GMN_DATA_ROOT=relativo']))), { code: 'E_HOST_CONFIG', detail: 'GMN_DATA_ROOT' });
});

test('P9-D04 homologação: GMN_TRAEFIK_NAME obrigatória e ≠ gmn, GMN_WORKER_REPLICAS ausente ou 0, GMN_DATA_ROOT obrigatória, pastas sob --data-prefix (senão E_DATA_PREFIX)', () => {
  const hml = (lines: readonly string[]) => parseAndCheck(file(lines), 'homologacao');
  const base = baseLines('homologacao');
  assert.deepEqual(hml(base).prefixedFolders, ['/srv/gmn-hml', ...FOLDERS]);
  assert.deepEqual(refusal(() => hml(base.filter((line) => !line.startsWith('GMN_TRAEFIK_NAME=')))), { code: 'E_HOST_CONFIG', detail: 'GMN_TRAEFIK_NAME' });
  for (const value of ['gmn', '']) assert.deepEqual(refusal(() => hml(base.map((line) => (line.startsWith('GMN_TRAEFIK_NAME=') ? `GMN_TRAEFIK_NAME=${value}` : line)))), { code: 'E_HOST_CONFIG', detail: 'GMN_TRAEFIK_NAME' }, value);
  assert.equal(hml([...base, 'GMN_WORKER_REPLICAS=0']).workerReplicas, 0);
  assert.deepEqual(refusal(() => hml([...base, 'GMN_WORKER_REPLICAS=1'])), { code: 'E_HOST_CONFIG', detail: 'GMN_WORKER_REPLICAS' });
  assert.deepEqual(refusal(() => hml(base.filter((line) => !line.startsWith('GMN_DATA_ROOT=')))), { code: 'E_HOST_CONFIG', detail: 'GMN_DATA_ROOT' });
  const outside: ReadonlyArray<readonly [string, string]> = [
    ['GMN_DATA_ROOT', '/srv/gmn'],
    ['GMN_DATA_ROOT', '/srv/gmn-hml-irma'],
    ['GMN_RAIZ_DADOS_MANIFESTOS', '/srv/gmn/manifestos'],
    ['GMN_RAIZ_DADOS_LIVRO', '/srv/gmn-hmlx/livro'],
    ['GMN_RAIZ_DADOS_DECISOES', '/srv'],
  ];
  for (const [name, value] of outside) {
    const lines = base.map((line) => (line.startsWith(`${name}=`) ? `${name}=${value}` : line));
    assert.deepEqual(refusal(() => hml(lines)), { code: 'E_DATA_PREFIX', detail: null }, `${name}=${value}`);
  }
  assert.deepEqual(refusal(() => hml(base.map((line) => (line.startsWith('GMN_RAIZ_DADOS_LIVRO=') ? 'GMN_RAIZ_DADOS_LIVRO=/srv/gmn-hml/../gmn/livro' : line)))), { code: 'E_HOST_CONFIG', detail: 'GMN_RAIZ_DADOS_LIVRO' }, '.. no caminho: não normalizado');
});

test('P9-D04: todo detalhe que o parser e as regras podem produzir é um nome da lista fechada do job (HOST_CONFIG_NAMES)', () => {
  const named = [...FORBIDDEN_EVERYWHERE, ...FORBIDDEN_IN_PRODUCTION, ...REQUIRED_NON_EMPTY, ...DATA_FOLDER_NAMES, 'GMN_WORKER_REPLICAS', 'GMN_TRAEFIK_NAME', 'GMN_DATA_ROOT'];
  for (const name of named) assert.ok((HOST_CONFIG_NAMES as readonly string[]).includes(name), name);
});

const FP12_SCRIPT = path.join(__dirname, '..', 'deploy', 'hostinger', 'supabase-fp12.sh');
const scriptFp12 = (url: string): string | null => {
  const run = spawnSync('bash', [FP12_SCRIPT], { input: url, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
};

test('revisão do PR #70 (item 6): impressão do Supabase = 12 hex do sha256 da ORIGEM CANÔNICA https://<host em minúsculas>; barra final, maiúsculas e :443 não mudam a impressão; caminho, porta, http, usuário, consulta ⇒ fora da regra; o receptor e deploy/hostinger/supabase-fp12.sh (job e runbook) concordam em todos os casos', () => {
  const canonical = 'https://abcdefghijklmnop.supabase.co';
  const expected = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  for (const url of [canonical, `${canonical}/`, 'https://ABCDEFGHIJKLMNOP.Supabase.Co', `${canonical}:443`, `${canonical}:443/`]) {
    assert.equal(canonicalSupabaseOrigin(url), canonical, url);
    assert.equal(supabaseFp12(url), expected, url);
    assert.equal(scriptFp12(url), expected, `script: ${url}`);
  }
  const refused = [`${canonical}/rest/v1`, `${canonical}//`, `${canonical}:8443`, `${canonical}:80`, 'http://abcdefghijklmnop.supabase.co', 'https://user:pass@abcdefghijklmnop.supabase.co', `${canonical}?a=1`, `${canonical}/#x`, 'HTTPS://abcdefghijklmnop.supabase.co', ' https://abcdefghijklmnop.supabase.co', 'https://localhost', 'https://-abc.supabase.co', 'https://abc..supabase.co', 'https://abc_def.supabase.co', 'https://xn--bcher-kva.example/x', 'https://ábc.supabase.co', ''];
  for (const url of refused) {
    assert.equal(supabaseFp12(url), null, url);
    assert.equal(scriptFp12(url), null, `script: ${url}`);
  }
});

test('revisão do PR #70 (item 6): NEXT_PUBLIC_SUPABASE_URL fora da origem canônica no arquivo do host ⇒ E_HOST_CONFIG NEXT_PUBLIC_SUPABASE_URL (sem o valor); na forma não canônica aceita, a impressão é a da origem canônica', () => {
  const withUrl = (url: string): Uint8Array => file(baseLines('producao').map((line) => (line.startsWith('NEXT_PUBLIC_SUPABASE_URL=') ? `NEXT_PUBLIC_SUPABASE_URL=${url}` : line)));
  for (const url of [`https://${SENTINELA}.supabase.invalid/rest`, `https://${SENTINELA}.supabase.invalid:8443`, `http://${SENTINELA}.supabase.invalid`]) {
    assert.deepEqual(refusal(() => parseAndCheck(withUrl(url))), { code: 'E_HOST_CONFIG', detail: 'NEXT_PUBLIC_SUPABASE_URL' }, url);
  }
  const canonicalFp = createHash('sha256').update(`https://${SENTINELA}.supabase.invalid`).digest('hex').slice(0, 12);
  assert.equal(parseAndCheck(withUrl(`https://${SENTINELA.toUpperCase()}.Supabase.invalid/`)).supabaseFp12, canonicalFp);
});
