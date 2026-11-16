import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/stub-lucide';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { POST as confirmRoute } from '../src/app/api/link-audit/confirm/route';
import { POST as parseRoute } from '../src/app/api/link-audit/parse/route';
import { ParseResultPanel } from '../src/components/link-audit/parse-result-panel';
import { confirmIdentity, identityFromParse } from '../src/lib/link-audit/audit';
import { validateEvidence } from '../src/lib/link-audit/evidence';
import { parseGoogleMapsLink } from '../src/lib/link-audit/maps-link';
import { isSanitizedUrl, MAX_OUTPUT_STRING_LENGTH, redactFreeText, redactUrlsInText, safeFailureReason, sanitizeForOutput, sanitizeUrl } from '../src/lib/link-audit/url-redaction';
import { redactSecrets } from '../src/lib/redact';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/auth/session';

/* Identificadores, tokens e chaves FICTÍCIOS. */
const FID = '0x935ef1a2b3c4d5e6:0x1234567890abcdef';
const CID = '12345678901234567890';
const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const JUNK = 'token=SEGREDO-TOKEN-9&access_token=SEGREDO-ACESSO&key=AIzaSySEGREDO-CHAVE&api_key=SEGREDO-API&utm_source=newsletter&igsh=SEGREDO-IG';
const SECRETS = ['SEGREDO-TOKEN-9', 'SEGREDO-ACESSO', 'SEGREDO-CHAVE', 'SEGREDO-API', 'SEGREDO-IG', 'newsletter', 'SEGREDO-FRAGMENTO'];
const leaks = (text: string): string[] => SECRETS.filter((secret) => text.includes(secret));

/** Formatos aceitos pelo parser, cada um com lixo sensível no meio e no fim e um fragmento. */
const IDENTIFIED_LINKS: Record<string, string> = {
  'data=!1s': `https://www.google.com/maps/place/Padaria+Exemplo/@-16.6869,-49.2648,17z/data=!3m1!4b1!1s${FID}!8m2?${JUNK}#SEGREDO-FRAGMENTO`,
  cid: `https://maps.google.com/?${JUNK}&cid=${CID}&utm_medium=x#SEGREDO-FRAGMENTO`,
  'cid em /maps': `https://www.google.com/maps?cid=${CID}&${JUNK}`,
  ftid: `https://www.google.com/maps?ftid=${FID}&${JUNK}#SEGREDO-FRAGMENTO`,
  place_id: `https://www.google.com/maps/place/?${JUNK}&place_id=${PLACE_ID}`,
  'q=place_id:': `https://www.google.com/maps/place/?q=place_id:${PLACE_ID}&${JUNK}`,
  query_place_id: `https://www.google.com/maps/search/?api=1&query=Padaria&query_place_id=${PLACE_ID}&${JUNK}`,
  'misto cid+ftid': `https://www.google.com/maps?cid=${CID}&${JUNK}&ftid=${FID}`,
  'com.br': `https://www.google.com.br/maps?cid=${CID}&${JUNK}`,
};

test('sanitizeUrl: remove credenciais, fragmento e todo parâmetro fora dos identificadores', () => {
  const cases: Array<[string, string]> = [
    ['https://www.google.com/maps?cid=1&token=abc#frag', 'https://www.google.com/maps?cid=1'],
    ['https://u:senha@www.google.com/maps?cid=1', 'https://www.google.com/maps?cid=1'],
    ['https://example.com/pagina?utm_source=x&id=7#topo', 'https://example.com/pagina'],
    ['https://maps.app.goo.gl/AbCd1234?g_st=ic&token=1', 'https://maps.app.goo.gl/AbCd1234'],
    [`https://www.google.com/maps?q=place_id:${PLACE_ID}&token=1`, `https://www.google.com/maps?q=place_id%3A${PLACE_ID}`],
    ['https://www.google.com/maps?q=padaria+goiania&key=1', 'https://www.google.com/maps'],
    ['https://example.com', 'https://example.com/'],
  ];
  for (const [input, expected] of cases) assert.equal(sanitizeUrl(input), expected, input);
});

test('sanitizeUrl: texto que não é URL válida também perde segredos, consulta e fragmento', () => {
  assert.equal(sanitizeUrl('maps.app.goo.gl/AbCd1234?token=SEGREDO-TOKEN-9#SEGREDO-FRAGMENTO'), 'maps.app.goo.gl/AbCd1234');
  assert.equal(sanitizeUrl('https:user:SEGREDO-TOKEN-9@www.google.com/maps?cid=1'), 'https://www.google.com/maps?cid=1');
  assert.doesNotMatch(sanitizeUrl('https:///user:SEGREDO-TOKEN-9@www.google.com/maps?cid=1'), /SEGREDO/);
  assert.doesNotMatch(sanitizeUrl('Padaria Exemplo token=SEGREDO-TOKEN-9 api_key=SEGREDO-API'), /SEGREDO/);
  assert.equal(sanitizeUrl('Padaria Exemplo Goiânia'), 'Padaria Exemplo Goiânia', 'texto comum não é alterado');
  assert.equal(sanitizeUrl('x'.repeat(5000)).length, 2048);
});

test('sanitizeUrl é idempotente e isSanitizedUrl reconhece a forma segura', () => {
  for (const link of Object.values(IDENTIFIED_LINKS)) {
    const once = sanitizeUrl(link);
    assert.equal(sanitizeUrl(once), once, link);
    assert.ok(isSanitizedUrl(once), once);
    assert.equal(isSanitizedUrl(link), false, 'o original com lixo não é seguro');
  }
  assert.equal(isSanitizedUrl('https://www.google.com/maps?cid=1#x'), false);
  assert.equal(isSanitizedUrl('https://u:p@www.google.com/maps'), false);
  assert.equal(isSanitizedUrl('https://www.google.com/maps?utm_source=x'), false);
  assert.equal(isSanitizedUrl('não é url'), false);
});

test('INTEGRIDADE DOS IDENTIFICADORES: o link saneado devolve exatamente os mesmos identificadores', () => {
  for (const [name, link] of Object.entries(IDENTIFIED_LINKS)) {
    const original = parseGoogleMapsLink(link);
    assert.equal(original.status, 'IDENTIFIED', name);
    if (original.status !== 'IDENTIFIED') continue;
    const again = parseGoogleMapsLink(original.originalInput);
    assert.equal(again.status, 'IDENTIFIED', `${name}: o saneado ainda identifica`);
    if (again.status !== 'IDENTIFIED') continue;
    assert.deepEqual(again.identifiers, original.identifiers, name);
    assert.equal(again.canonicalHost, original.canonicalHost, name);
    assert.equal(original.originalInput, sanitizeUrl(link), name);
    assert.deepEqual(leaks(original.originalInput), [], name);
  }
});

test('o parser nunca devolve tokens em nenhum estado (originalInput saneado)', () => {
  const links = [
    ...Object.values(IDENTIFIED_LINKS),
    `https://maps.app.goo.gl/AbCd1234?${JUNK}#SEGREDO-FRAGMENTO`,
    `https://www.google.com/maps/search/padaria+goiania?${JUNK}`,
    `https://www.google.com/maps/dir/a/b?${JUNK}`,
    `https://example.com/?${JUNK}`,
    `http://www.google.com/maps?cid=1&${JUNK}`,
    `https://user:SEGREDO-TOKEN-9@www.google.com/maps?${JUNK}`,
    `https:user:SEGREDO-TOKEN-9@www.google.com/maps?cid=1&${JUNK}`,
    `https://www.google.com/maps?cid=abc&${JUNK}`,
    `https://www.google.com/maps?cid=%ZZ&${JUNK}`,
    `javascript:alert(1)//?${JUNK}`,
    `texto livre ${JUNK}`,
  ];
  for (const link of links) {
    const result = parseGoogleMapsLink(link);
    assert.deepEqual(leaks(JSON.stringify(result)), [], `${result.status}/${result.code}: ${link.slice(0, 60)}`);
  }
});

test('identidade confirmada guarda o link saneado e continua com os mesmos identificadores', () => {
  const parse = parseGoogleMapsLink(IDENTIFIED_LINKS['cid em /maps'] ?? '');
  const identity = identityFromParse(parse);
  assert.ok(identity);
  assert.deepEqual(identity.identifiers, { cid: CID });
  assert.deepEqual(leaks(JSON.stringify(identity)), []);
  const confirmed = confirmIdentity(parse, { confirmedBy: 'ana@empresa.com', confirmedAt: '2026-10-20T15:00:00.000Z' });
  assert.ok(confirmed.ok);
  assert.deepEqual(leaks(JSON.stringify(confirmed.value)), []);
});

test('redactUrlsInText e safeFailureReason: URLs reduzidas, chaves e tokens redigidos, tamanho limitado', () => {
  const text = `Falha ao acessar https://google.serper.dev/maps?api_key=SEGREDO-API&token=SEGREDO-TOKEN-9#SEGREDO-FRAGMENTO, tente depois.`;
  const redacted = redactUrlsInText(text);
  assert.deepEqual(leaks(redacted), []);
  assert.match(redacted, /https:\/\/google\.serper\.dev\/maps,/, 'pontuação final é preservada');

  const error = Object.assign(new Error(`connect ECONNREFUSED https://api.exemplo.com/v1?key=AIzaSySEGREDO-CHAVE&x=1 Authorization: Bearer abcdef1234567890SEGREDO-API`), { code: 'ECONNREFUSED' });
  const reason = safeFailureReason(error);
  assert.deepEqual(leaks(reason), []);
  assert.doesNotMatch(reason, /abcdef1234567890/);
  assert.match(reason, /ECONNREFUSED/);
  assert.ok(safeFailureReason(new Error('x'.repeat(5000))).length <= 300);
  assert.equal(typeof safeFailureReason({ qualquer: 'coisa' }), 'string');
  assert.deepEqual(leaks(safeFailureReason(`https://a.com/?token=SEGREDO-TOKEN-9`)), []);
});

test('segredos do ambiente (chave do Serper) também são redigidos nas mensagens de erro', () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = env.SERPER_API_KEY;
  env.SERPER_API_KEY = 'serper-chave-ficticia-0123456789abcdef';
  try {
    const reason = safeFailureReason(new Error('HTTP 403 com a chave serper-chave-ficticia-0123456789abcdef no cabeçalho'));
    assert.doesNotMatch(reason, /serper-chave-ficticia/);
    assert.match(reason, /\[REDACTED\]/);
  } finally {
    if (previous === undefined) delete env.SERPER_API_KEY;
    else env.SERPER_API_KEY = previous;
  }
});

test('evidência: fonte com credenciais, fragmento ou parâmetros fora da lista é recusada; a saneada é aceita', () => {
  const base = {
    id: 'ev-site', attribute: 'site_reachable', criterionId: 'CONVERSION', claim: 'O site respondeu.', status: 'VERIFIED',
    origin: 'OFFICIAL_SITE', consultedAt: '2026-10-20T12:00:00.000Z',
  };
  for (const sourceUrl of [
    'https://www.padaria-exemplo.example/?token=SEGREDO-TOKEN-9',
    'https://www.padaria-exemplo.example/pagina#SEGREDO-FRAGMENTO',
    'https://www.padaria-exemplo.example/?utm_source=x',
    'https://www.google.com/maps?cid=1&key=AIzaSySEGREDO-CHAVE',
  ]) {
    const result = validateEvidence({ ...base, sourceUrl });
    assert.equal(result.ok, false, sourceUrl);
    assert.match(result.ok ? '' : result.issues.join(' '), /credenciais, fragmento nem parâmetros/);
  }
  assert.equal(validateEvidence({ ...base, sourceUrl: sanitizeUrl('https://www.padaria-exemplo.example/?token=SEGREDO-TOKEN-9#x') }).ok, true);
  assert.equal(validateEvidence({ ...base, origin: 'GOOGLE_NATIVE', attribute: 'profile_name', criterionId: 'NAP', sourceUrl: `https://www.google.com/maps?cid=${CID}` }).ok, true);
});

const SECRET = 'service-role-key-de-teste-0123456789';
const env = process.env as Record<string, string | undefined>;

test('API e tela: tokens do link não voltam na resposta da análise, da confirmação nem na renderização', async () => {
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = 'ana@empresa.com';
  delete env.GMN_AUTH_DISABLED;
  const cookie = `${SESSION_COOKIE}=${await createSessionToken('ana@empresa.com', SECRET)}`;
  const send = (path: string, body: unknown) =>
    new Request(`http://app.local${path}`, { method: 'POST', headers: { host: 'app.local', 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

  const link = IDENTIFIED_LINKS['cid em /maps'] ?? '';
  const parsed = await parseRoute(send('/api/link-audit/parse', { link }));
  const parsedText = await parsed.text();
  assert.equal(parsed.status, 200);
  assert.deepEqual(leaks(parsedText), []);

  const confirmed = await confirmRoute(send('/api/link-audit/confirm', { link, acknowledged: true }));
  const confirmedText = await confirmed.text();
  assert.equal(confirmed.status, 200);
  assert.deepEqual(leaks(confirmedText), []);
  assert.deepEqual((JSON.parse(confirmedText) as { identity: { identifiers: unknown } }).identity.identifiers, { cid: CID }, 'identificador preservado');

  const html = renderToStaticMarkup(createElement(ParseResultPanel, { result: JSON.parse(parsedText).result, loading: false }));
  assert.deepEqual(leaks(html), []);
  assert.ok(html.includes(CID));

  for (const rejected of [`https://user:SEGREDO-TOKEN-9@www.google.com/maps?${JUNK}`, `https://example.com/?${JUNK}`, `texto ${JUNK}`]) {
    const response = await parseRoute(send('/api/link-audit/parse', { link: rejected }));
    assert.deepEqual(leaks(await response.text()), [], rejected.slice(0, 40));
  }
});

test('rotas: falha inesperada devolve resposta genérica, sem mensagem interna nem o link', async () => {
  env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
  env.GMN_OPERATOR_EMAILS = 'ana@empresa.com';
  const cookie = `${SESSION_COOKIE}=${await createSessionToken('ana@empresa.com', SECRET)}`;
  // Corpo cujo leitor falha no meio do fluxo (erro inesperado de infraestrutura).
  const broken = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error('falha interna com token=SEGREDO-TOKEN-9 em https://x.example/?key=SEGREDO-CHAVE'));
    },
  });
  const request = new Request('http://app.local/api/link-audit/parse', {
    method: 'POST',
    headers: { host: 'app.local', 'content-type': 'application/json', cookie },
    body: broken,
    duplex: 'half',
  } as RequestInit);
  const response = await parseRoute(request);
  const text = await response.text();
  assert.ok(response.status === 400 || response.status === 500);
  assert.deepEqual(leaks(text), []);
  assert.doesNotMatch(text, /falha interna|x\.example/);
});

test('valores de parâmetros de identificador só sobrevivem se tiverem a forma do identificador', () => {
  assert.equal(sanitizeUrl('https://www.google.com/maps?cid=1234567890123456789?token=SEGREDO-TOKEN-9'), 'https://www.google.com/maps');
  assert.equal(sanitizeUrl('https://www.google.com/maps?cid=abc&ftid=xyz&place_id=curto'), 'https://www.google.com/maps');
  assert.equal(sanitizeUrl(`https://www.google.com/maps?cid=${CID}`), `https://www.google.com/maps?cid=${CID}`);
  assert.equal(sanitizeUrl(`https://www.google.com/maps?ftid=${FID}`), `https://www.google.com/maps?ftid=${encodeURIComponent(FID)}`);
  assert.equal(sanitizeUrl('https://www.google.com/maps?q=place_id:segredo-curto'), 'https://www.google.com/maps');
  // um segredo do ambiente colado como valor de cid não é repetido
  const env = process.env as Record<string, string | undefined>;
  const previous = env.SERPER_API_KEY;
  env.SERPER_API_KEY = 'LITERALSECRETVALUE123';
  try {
    for (const host of ['www.google.com/maps', 'maps.app.goo.gl', 'g.page']) {
      const out = parseGoogleMapsLink(`https://${host}?cid=LITERALSECRETVALUE123`).originalInput;
      assert.doesNotMatch(out, /LITERALSECRETVALUE123/, host);
    }
    assert.doesNotMatch(sanitizeUrl('https://g.page/LITERALSECRETVALUE123'), /LITERALSECRETVALUE123/, 'segredo literal no caminho');
  } finally {
    if (previous === undefined) delete env.SERPER_API_KEY;
    else env.SERPER_API_KEY = previous;
  }
});

test('tokens no caminho e na dica de nome são redigidos quando reconhecíveis', () => {
  for (const segment of ['token=SEGREDO-TOKEN-9', 'sk-abcdefghijklmnopqrstuvwxyz1234', 'api_key=SEGREDO-CHAVE']) {
    const parsed = parseGoogleMapsLink(`https://www.google.com/maps/place/${segment}/?cid=${CID}`);
    assert.ok(parsed.status === 'IDENTIFIED');
    assert.deepEqual(parsed.identifiers, { cid: CID }, 'o identificador é preservado');
    assert.deepEqual(leaks(JSON.stringify(parsed)), [], segment);
    assert.doesNotMatch(JSON.stringify(parsed), /sk-abcdefghijklmnopqrstuvwxyz1234/);
  }
});

test('esquemas que não são http(s) não ecoam conteúdo; texto com consulta sem esquema é cortado', () => {
  assert.equal(sanitizeUrl('javascript:alert("SEGREDO-TOKEN-9")'), 'javascript:[conteúdo omitido]');
  assert.equal(parseGoogleMapsLink('javascript:alert("SEGREDO-TOKEN-9")').originalInput, 'javascript:[conteúdo omitido]');
  assert.equal(sanitizeUrl('data:text/html,<b>SEGREDO-TOKEN-9</b>'), 'data:[conteúdo omitido]');
  assert.equal(sanitizeUrl('Padaria: Exemplo e Cia'), 'Padaria: Exemplo e Cia', 'texto comum com dois-pontos não é alterado');
  const reasons = [
    'fetch failed for site.com/x?key=SEGREDOKEY1234 depois',
    'erro em wss://h.example/p?auth=SEGREDOAUTH12 fim',
    'url https://a.example/p%3Ftoken%3DSEGREDOENC1 fim',
    'sessao ;jsessionid=SEGREDOSESS99 fim',
    'assinatura sig=SEGREDOSIG123 fim',
  ];
  for (const reason of reasons) {
    const out = safeFailureReason(new Error(reason));
    assert.doesNotMatch(out, /SEGREDOKEY1234|SEGREDOAUTH12|SEGREDOENC1|SEGREDOSESS99|SEGREDOSIG123/, reason);
  }
});

test('isSanitizedUrl rejeita URLs com segredos reconhecíveis no caminho', () => {
  assert.equal(isSanitizedUrl('https://www.padaria-exemplo.example/token=SEGREDO-TOKEN-9'), false);
  assert.equal(isSanitizedUrl('https://www.padaria-exemplo.example/pagina'), true);
});

/* Revisão adversarial (16/11/2026): negação de serviço por regex quadrática no saneamento de saída. */

test('sanitizeForOutput: texto acima do teto é truncado com marca explícita e o trecho mantido continua saneado', () => {
  const secret = 'password=SEGREDO-SENHA-77';
  const text = `${secret} ${'a'.repeat(MAX_OUTPUT_STRING_LENGTH)} cauda-descartada`;
  const out = sanitizeForOutput(text) as string;
  assert.ok(out.length <= MAX_OUTPUT_STRING_LENGTH + 64, `tamanho ${out.length}`);
  assert.ok(out.endsWith('[truncado]'));
  assert.ok(!out.includes('SEGREDO-SENHA-77') && !out.includes('cauda-descartada'));
  assert.equal(sanitizeForOutput('curto'), 'curto');
  assert.equal((sanitizeForOutput('x'.repeat(MAX_OUTPUT_STRING_LENGTH)) as string).length, MAX_OUTPUT_STRING_LENGTH, 'exatamente no teto: intacto');
});

test('sanitizeForOutput: segredo que cruza a posição do teto não vaza nenhum trecho (sanear o texto inteiro, depois cortar a saída)', () => {
  const jwtHeader = 'eyJhbGciOiJIUzI1NiJ9';
  const jwtPayload = 'eyJzdWIiOiJqb2FvQGV4YW1wbGUuY29tIn0';
  const jwtSignature = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
  const cases: { secret: string; fragments: string[] }[] = [
    { secret: `${jwtHeader}.${jwtPayload}.${jwtSignature}`, fragments: [jwtHeader, jwtPayload, 'SflKxw'] },
    { secret: 'https://joao:S3nh4-Longa-99@host.example.com/', fragments: ['joao', 'S3nh4', 'senha'] },
    { secret: 'Bearer abcdefghijklmnop1234', fragments: ['abcdefg', 'Bearer abc'] },
    { secret: 'sk-abcdefghijklmnop1234567890', fragments: ['sk-abc', 'abcdefghij'] },
    { secret: 'password=SEGREDO-SENHA-77', fragments: ['SEGREDO', 'SENHA'] },
  ];
  for (const { secret, fragments } of cases) {
    for (const cut of [1, 3, 8, Math.floor(secret.length / 2), secret.length - 1]) {
      const text = `${'a'.repeat(MAX_OUTPUT_STRING_LENGTH - cut - 1)} ${secret} ${'b'.repeat(50)}`;
      const out = sanitizeForOutput(text) as string;
      for (const fragment of fragments) assert.ok(!out.includes(fragment), `vazou "${fragment}" (corte ${cut}) em ${secret.slice(0, 12)}…`);
      assert.ok(out.length <= MAX_OUTPUT_STRING_LENGTH + 16, `tamanho ${out.length}`);
    }
  }
});

test('sanitizeForOutput: a marca de truncamento só entra quando a SAÍDA saneada passa do teto', () => {
  const longSecret = `password=${'S'.repeat(MAX_OUTPUT_STRING_LENGTH * 2)}`;
  assert.equal(sanitizeForOutput(longSecret), 'password=[REDACTED]', 'o valor enorme encolhe ao ser redigido: sem marca');
  const out = sanitizeForOutput(`${'a'.repeat(MAX_OUTPUT_STRING_LENGTH + 10)}`) as string;
  assert.equal(out, `${'a'.repeat(MAX_OUTPUT_STRING_LENGTH)}…[truncado]`);
});

test('saneamento de texto é linear: entradas adversariais de 200 mil caracteres terminam rápido', { timeout: 20_000 }, () => {
  const inputs = ['a.'.repeat(100_000), 'a-'.repeat(100_000), 'a.b'.repeat(66_000), 'http://'.repeat(28_000), 'a.com/'.repeat(33_000)];
  const start = process.hrtime.bigint();
  for (const input of inputs) {
    redactFreeText(input);
    redactSecrets(input, {});
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 1500, `levou ${ms.toFixed(0)} ms (quadrático levaria dezenas de segundos)`);
});

test('scrubFreeText: consulta de link sem esquema continua cortada (comportamento preservado)', () => {
  assert.equal(redactFreeText('veja www.exemplo.com.br/loja?token=abc&x=1 agora'), 'veja www.exemplo.com.br/loja agora');
  assert.equal(redactFreeText('veja exemplo.com.br?abc agora'), 'veja exemplo.com.br agora');
  assert.equal(redactFreeText('x exemplo.com.br/a%3Fsegredo y'), 'x exemplo.com.br/a y');
  assert.equal(redactFreeText('-exemplo.com.br?abc'), '-exemplo.com.br');
  assert.equal(redactSecrets('1-redis://u:senha1234@host', {}), '1-redis://[REDACTED]@host');
});

/*
 * Oráculo: as expressões ANTIGAS (quadráticas), copiadas da versão anterior, para provar que as novas devolvem
 * EXATAMENTE o mesmo texto. Entradas curtas (o oráculo é lento só com textos longos), geradas de forma
 * determinística a partir de peças que exercitam os casos-limite (pontos duplos, hífen, %3F, caminho, @, eyJ…).
 */
const ORACLE_REDACTED = '[REDACTED]';
function oracleRedactSecrets(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi, `$1${ORACLE_REDACTED}@`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${ORACLE_REDACTED}`)
    .replace(/\b(api[-_]?key|apikey|x-api-key|token|access[-_]?token|refresh[-_]?token|password|passwd|senha|secret)(["']?\s*[:=]\s*["']?)[^\s"',;&]{3,}/gi, `$1$2${ORACLE_REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, ORACLE_REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, ORACLE_REDACTED);
}
function oracleKeepParameter(name: string, value: string): boolean {
  if (name === 'cid') return /^\d{1,20}$/.test(value);
  if (name === 'ftid') return /^0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16}$/i.test(value);
  if (name === 'place_id' || name === 'query_place_id') return /^[A-Za-z0-9_-]{20,255}$/.test(value);
  if (name === 'q') return value.toLowerCase().startsWith('place_id:') && /^[A-Za-z0-9_-]{20,255}$/.test(value.slice('place_id:'.length));
  return false;
}
function oracleRedactFreeText(text: string): string {
  const withoutQueries = text.replace(/\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s?#]*)?)(?:\?|%3[Ff])[^\s]*/gi, '$1').replace(/%3[Ff][^\s]*/g, '');
  const scrubbed = withoutQueries.replace(/([A-Za-z0-9_.-]{1,40})=([^\s&#]+)/g, (pair, name: string, value: string) => (oracleKeepParameter(name, value) ? pair : `${name}=${ORACLE_REDACTED}`));
  return oracleRedactSecrets(scrubbed);
}

test('as expressões lineares devolvem EXATAMENTE o mesmo texto que as antigas (comparação diferencial determinística)', () => {
  const pieces = ['a', 'b', 'Z', '1', '-', '.', '/', '?', '#', '%3F', '%3f', ' ', '_', ':', '//', '@', '=', '&', 'eyJ', 'abcdefgh', 'com', 'br', 'x', '..', 'http://', 'redis://', 'u:p@', ',', ')', '+', 'é', 'A.', 'co.', '-.', 'token=', 'Bearer ', 'sk-', 'cid=123'];
  let seed = 20261116;
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const ITERATIONS = 20_000;
  for (let i = 0; i < ITERATIONS; i++) {
    let input = '';
    const length = 1 + next(i % 3 === 0 ? 40 : 14);
    for (let j = 0; j < length; j++) input += pieces[next(pieces.length)];
    assert.equal(redactSecrets(input, {}), oracleRedactSecrets(input), `redactSecrets divergiu para ${JSON.stringify(input)}`);
    assert.equal(redactFreeText(input), oracleRedactFreeText(input), `redactFreeText divergiu para ${JSON.stringify(input)}`);
  }
});
