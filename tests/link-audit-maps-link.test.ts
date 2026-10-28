import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import test, { mock } from 'node:test';
import { parseGoogleMapsLink, type MapsLinkParseResult } from '../src/lib/link-audit/maps-link';

/*
 * Todos os links abaixo são FICTÍCIOS (identificadores inventados para teste). Nenhuma chamada real é feita.
 */
const FID = '0x935ef1a2b3c4d5e6:0x1234567890abcdef';
const FID_2 = '0x935ef1a2b3c4d5e6:0x00000000000000ff';
const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const LONG_LINK =
  `https://www.google.com/maps/place/Padaria+Exemplo/@-16.6869,-49.2648,17z/data=!3m1!4b1!4m6!3m5!1s${FID}!8m2!3d-16.6869!4d-49.2648!16s%2Fg%2F11abcdefg`;

function expectResult(
  input: unknown,
  status: MapsLinkParseResult['status'],
  code: MapsLinkParseResult['code'],
): MapsLinkParseResult {
  const result = parseGoogleMapsLink(input);
  assert.equal(result.status, status, `${String(input).slice(0, 80)} → ${result.status}/${result.code}`);
  assert.equal(result.code, code, `${String(input).slice(0, 80)} → ${result.code}`);
  return result;
}

test('link completo com segmento !1s0x…:0x… identifica pelo featureId e guarda o nome só como dica', () => {
  const result = expectResult(LONG_LINK, 'IDENTIFIED', 'IDENTIFIED');
  assert.ok(result.status === 'IDENTIFIED');
  assert.deepEqual(result.identifiers, { featureId: FID });
  assert.deepEqual(result.sourceForms, ['DATA_SEGMENT']);
  assert.equal(result.canonicalHost, 'www.google.com');
  assert.equal(result.untrustedLabelHint, 'Padaria Exemplo');
});

test('formatos com identificador explícito: cid, ftid, place_id, query_place_id e q=place_id:', () => {
  const cid = expectResult('https://maps.google.com/?cid=12345678901234567890', 'IDENTIFIED', 'IDENTIFIED');
  assert.ok(cid.status === 'IDENTIFIED');
  assert.deepEqual(cid.identifiers, { cid: '12345678901234567890' });

  const cidMaps = parseGoogleMapsLink('https://www.google.com/maps?cid=987654321');
  assert.ok(cidMaps.status === 'IDENTIFIED' && cidMaps.identifiers.cid === '987654321');

  const ftid = parseGoogleMapsLink(`https://www.google.com/maps?ftid=${FID.toUpperCase().replace('0X', '0x')}`);
  assert.ok(ftid.status === 'IDENTIFIED' && ftid.identifiers.featureId === FID, 'fid é normalizado em minúsculas');

  const placeIdParam = parseGoogleMapsLink(`https://www.google.com/maps/place/?place_id=${PLACE_ID}`);
  assert.ok(placeIdParam.status === 'IDENTIFIED' && placeIdParam.identifiers.placeId === PLACE_ID);
  assert.deepEqual(placeIdParam.status === 'IDENTIFIED' && placeIdParam.sourceForms, ['PLACE_ID_PARAM']);

  const qPlace = parseGoogleMapsLink(`https://www.google.com/maps/place/?q=place_id:${PLACE_ID}`);
  assert.ok(qPlace.status === 'IDENTIFIED' && qPlace.identifiers.placeId === PLACE_ID);
  assert.deepEqual(qPlace.status === 'IDENTIFIED' && qPlace.sourceForms, ['Q_PLACE_ID']);

  const queryPlace = parseGoogleMapsLink(`https://www.google.com/maps/search/?api=1&query=Padaria&query_place_id=${PLACE_ID}`);
  assert.ok(queryPlace.status === 'IDENTIFIED' && queryPlace.identifiers.placeId === PLACE_ID);
  assert.deepEqual(queryPlace.status === 'IDENTIFIED' && queryPlace.sourceForms, ['QUERY_PLACE_ID_PARAM']);
});

test('domínio brasileiro, esquema/host em maiúsculas, porta 443 e ponto final são normalizados', () => {
  for (const link of [
    'https://www.google.com.br/maps?cid=42',
    'HTTPS://WWW.GOOGLE.COM/maps?cid=42',
    'https://www.google.com:443/maps?cid=42',
    'https://www.google.com./maps?cid=42',
    'https://maps.google.com.br/?cid=42',
  ]) {
    const result = parseGoogleMapsLink(link);
    assert.ok(result.status === 'IDENTIFIED' && result.identifiers.cid === '42', link);
  }
});

test('host com caracteres invisíveis, de largura total ou não ASCII é rejeitado, não normalizado em silêncio', () => {
  for (const link of [
    'https://ｇｏｏｇｌｅ.com/maps?cid=42',
    'https://ｗｗｗ.google.com/maps?cid=42',
    'https://www。google。com/maps?cid=42',
    'https://www.google.com\u200b/maps?cid=42',
    'https://www.google\u00ad.com/maps?cid=42',
  ]) {
    expectResult(link, 'REJECTED', 'IDN_LOOKALIKE_HOST');
  }
});

test('formas não canônicas de https são inválidas (https:host, https:/host, https:///host)', () => {
  for (const link of [
    'https:www.google.com/maps?cid=1',
    'https:/www.google.com/maps?cid=1',
    'https:///www.google.com/maps?cid=1',
  ]) {
    expectResult(link, 'INVALID', 'NON_CANONICAL_URL');
  }
});

test('credenciais nunca são repetidas, em nenhuma forma aceita pelo parser WHATWG', () => {
  for (const link of [
    'https://user:SEGREDO9@www.google.com/maps?cid=1',
    'https:user:SEGREDO9@www.google.com/maps?cid=1',
    'https:/user:SEGREDO9@www.google.com/maps?cid=1',
    'https:///user:SEGREDO9@www.google.com/maps?cid=1',
    'https:////user:SEGREDO9@www.google.com/maps?cid=1',
    'http:user:SEGREDO9@www.google.com/maps?cid=1',
    'ftp://user:SEGREDO9@www.google.com/',
  ]) {
    const result = parseGoogleMapsLink(link);
    assert.notEqual(result.status, 'IDENTIFIED', link);
    assert.ok(!JSON.stringify(result).includes('SEGREDO9'), `credencial vazou: ${link} → ${JSON.stringify(result)}`);
  }
});

test('o id do segmento data= só vale em segmento próprio, nunca no nome do lugar', () => {
  for (const link of [
    'https://www.google.com/maps/place/Foo%20!1s0x1:0x2/',
    'https://www.google.com/maps/place/Foo/!1s0x1:0x2',
    'https://www.google.com/maps/search/!1s0x1:0x2',
    'https://www.google.com/maps/place/Foo%2Fdata=!1s0x1:0x2',
    'https://www.google.com/maps/place/data=!1s0x1:0x2',
  ]) {
    const result = parseGoogleMapsLink(link);
    assert.equal(result.status, 'AMBIGUOUS', `${link} → ${result.status}`);
    assert.equal('identifiers' in result, false, link);
  }
  // E continua funcionando no formato real, com ou sem coordenadas.
  const withoutCoordinates = parseGoogleMapsLink(`https://www.google.com/maps/place/Padaria+Exemplo/data=!4m2!3m1!1s${FID}`);
  assert.ok(withoutCoordinates.status === 'IDENTIFIED' && withoutCoordinates.identifiers.featureId === FID);
});

test('identificadores nulos (cid=0, 0x0:0x0) não são identificadores', () => {
  expectResult('https://www.google.com/maps?cid=0', 'INVALID', 'INVALID_IDENTIFIER_FORMAT');
  expectResult('https://www.google.com/maps?ftid=0x0:0x0', 'INVALID', 'INVALID_IDENTIFIER_FORMAT');
  expectResult('https://www.google.com/maps/place/X/@-16.6,-49.2,17z/data=!1s0x0:0x0', 'INVALID', 'INVALID_IDENTIFIER_FORMAT');
});

test('mais de um tipo de identificador é preservado; o mesmo identificador repetido não é conflito', () => {
  const both = parseGoogleMapsLink(`https://www.google.com/maps?cid=77&ftid=${FID}`);
  assert.ok(both.status === 'IDENTIFIED');
  assert.deepEqual(both.identifiers, { cid: '77', featureId: FID });

  const repeated = parseGoogleMapsLink(`${LONG_LINK}?ftid=${FID}`);
  assert.ok(repeated.status === 'IDENTIFIED');
  assert.deepEqual(repeated.identifiers, { featureId: FID });
});

test('links curtos ficam com resolução pendente e nunca são identificados nem acessados', () => {
  for (const [link, host] of [
    ['https://maps.app.goo.gl/AbCd1234', 'maps.app.goo.gl'],
    ['https://goo.gl/maps/Xyz987_-Qw', 'goo.gl'],
    ['https://g.page/padaria-exemplo', 'g.page'],
    ['https://g.page/r/CabcDEF123', 'g.page'],
  ] as const) {
    const result = expectResult(link, 'RESOLUTION_PENDING', 'SHORT_LINK_REQUIRES_RESOLUTION');
    assert.ok(result.status === 'RESOLUTION_PENDING' && result.shortHost === host);
    assert.equal('identifiers' in result, false);
  }
  expectResult('https://maps.app.goo.gl/', 'UNSUPPORTED', 'UNSUPPORTED_SHORT_LINK_PATH');
  expectResult('https://goo.gl/abc1234', 'UNSUPPORTED', 'UNSUPPORTED_SHORT_LINK_PATH');
  expectResult('https://g.page/a/b/c', 'UNSUPPORTED', 'UNSUPPORTED_SHORT_LINK_PATH');
});

test('links ambíguos nunca escolhem um estabelecimento (nome e coordenadas não identificam)', () => {
  const nameAndCoordinates = expectResult(
    'https://www.google.com/maps/place/Padaria+Exemplo/@-16.6869,-49.2648,17z',
    'AMBIGUOUS',
    'NAME_OR_SEARCH_ONLY',
  );
  assert.ok(nameAndCoordinates.status === 'AMBIGUOUS' && nameAndCoordinates.untrustedLabelHint === 'Padaria Exemplo');

  const cases: ReadonlyArray<readonly [string, MapsLinkParseResult['code']]> = [
    ['https://www.google.com/maps/search/padaria+goiania', 'NAME_OR_SEARCH_ONLY'],
    ['https://www.google.com/maps?q=padaria+goiania', 'NAME_OR_SEARCH_ONLY'],
    ['https://www.google.com/maps/@-16.6869,-49.2648,15z', 'COORDINATES_ONLY'],
    ['https://www.google.com/maps/place/@-16.6869,-49.2648,15z', 'COORDINATES_ONLY'],
    ['https://www.google.com/maps', 'GENERIC_MAPS_LINK'],
    ['https://maps.google.com/', 'GENERIC_MAPS_LINK'],
  ];
  for (const [link, code] of cases) {
    const result = expectResult(link, 'AMBIGUOUS', code);
    assert.equal('identifiers' in result, false, `${link} não pode produzir identidade`);
  }
});

test('identificadores conflitantes tornam o link ambíguo', () => {
  expectResult('https://www.google.com/maps?cid=1&cid=2', 'AMBIGUOUS', 'CONFLICTING_IDENTIFIERS');
  expectResult(`${LONG_LINK}?ftid=${FID_2}`, 'AMBIGUOUS', 'CONFLICTING_IDENTIFIERS');
  expectResult(
    `https://www.google.com/maps?place_id=${PLACE_ID}&query_place_id=ChIJ_outroPlaceId_9999999`,
    'AMBIGUOUS',
    'CONFLICTING_IDENTIFIERS',
  );
});

test('hosts e caminhos que não são perfil de empresa são não suportados', () => {
  expectResult('https://www.google.com/maps/dir/Goiania/Anapolis', 'UNSUPPORTED', 'UNSUPPORTED_PATH');
  expectResult('https://www.google.com/maps/embed?pb=!1s0x1:0x2', 'UNSUPPORTED', 'UNSUPPORTED_PATH');
  expectResult('https://www.google.com/maps/d/u/0/viewer?mid=abc', 'UNSUPPORTED', 'UNSUPPORTED_PATH');
  expectResult('https://www.google.com/search?q=padaria', 'UNSUPPORTED', 'UNSUPPORTED_PATH');
  expectResult('https://www.google.com/', 'UNSUPPORTED', 'UNSUPPORTED_PATH');
  expectResult('https://example.com/maps?cid=1', 'UNSUPPORTED', 'UNSUPPORTED_HOST');
  expectResult('https://google.com.evil.com/maps?cid=1', 'UNSUPPORTED', 'UNSUPPORTED_HOST');
  expectResult('https://maps.google.com.evil.com/?cid=1', 'UNSUPPORTED', 'UNSUPPORTED_HOST');
  expectResult('https://evil-google.com/maps?cid=1', 'UNSUPPORTED', 'UNSUPPORTED_HOST');
  expectResult('https://evil.com/?u=https://www.google.com/maps?cid=1', 'UNSUPPORTED', 'UNSUPPORTED_HOST');
  expectResult('https://www.facebook.com/padaria', 'UNSUPPORTED', 'UNSUPPORTED_HOST');
});

test('entradas malformadas são inválidas, com motivo explícito', () => {
  expectResult(undefined, 'INVALID', 'NOT_A_STRING');
  expectResult(null, 'INVALID', 'NOT_A_STRING');
  expectResult(123, 'INVALID', 'NOT_A_STRING');
  expectResult('', 'INVALID', 'EMPTY');
  expectResult('    ', 'INVALID', 'EMPTY');
  expectResult('Padaria Exemplo Goiânia', 'INVALID', 'WHITESPACE_OR_CONTROL');
  expectResult('https://www.google.com/maps/place/Padaria Exemplo', 'INVALID', 'WHITESPACE_OR_CONTROL');
  expectResult('https://www.google.com/maps?cid=1\u0000', 'INVALID', 'WHITESPACE_OR_CONTROL');
  expectResult('padaria', 'INVALID', 'MISSING_SCHEME');
  expectResult('maps.app.goo.gl/AbCd1234', 'INVALID', 'MISSING_SCHEME');
  expectResult('//evil.com/maps?cid=1', 'INVALID', 'MISSING_SCHEME');
  expectResult('https://www.google.com/maps?cid=%ZZ', 'INVALID', 'MALFORMED_PERCENT_ENCODING');
  expectResult(`https://www.google.com/maps?cid=1&x=${'a'.repeat(3000)}`, 'INVALID', 'TOO_LONG');
  expectResult('https://', 'INVALID', 'NON_CANONICAL_URL'); // sem host
  expectResult('https://[', 'INVALID', 'UNPARSEABLE');
  expectResult('https://www.google.com/maps?cid=abc', 'INVALID', 'INVALID_IDENTIFIER_FORMAT');
  expectResult('https://www.google.com/maps?cid=18446744073709551616', 'INVALID', 'INVALID_IDENTIFIER_FORMAT');
  expectResult('https://www.google.com/maps?ftid=0xZZ:0x1', 'INVALID', 'INVALID_IDENTIFIER_FORMAT');
  expectResult('https://www.google.com/maps?place_id=curto', 'INVALID', 'INVALID_IDENTIFIER_FORMAT');
});

test('entradas perigosas são rejeitadas (esquema, credenciais, porta, IP, host interno, homógrafos)', () => {
  const rejected: ReadonlyArray<readonly [string, MapsLinkParseResult['code']]> = [
    ['http://www.google.com/maps?cid=1', 'INSECURE_SCHEME'],
    ['javascript:alert(1)', 'UNSAFE_SCHEME'],
    ['data:text/html,<script>alert(1)</script>', 'UNSAFE_SCHEME'],
    ['file:///etc/passwd', 'UNSAFE_SCHEME'],
    ['ftp://www.google.com/maps?cid=1', 'UNSAFE_SCHEME'],
    ['localhost:3000/x', 'UNSAFE_SCHEME'],
    ['https://user:senha@www.google.com/maps?cid=1', 'UNSAFE_URL'],
    ['https://www.google.com@evil.com/maps?cid=1', 'UNSAFE_URL'],
    ['https://www.google.com:8443/maps?cid=1', 'UNSAFE_URL'],
    ['https://localhost/maps?cid=1', 'UNSAFE_URL'],
    ['https://localhost./maps?cid=1', 'UNSAFE_URL'],
    ['https://servidor.internal/maps?cid=1', 'UNSAFE_URL'],
    ['https://metadata.google.internal/', 'UNSAFE_URL'],
    ['https://127.0.0.1/maps?cid=1', 'UNSAFE_URL'],
    ['https://2130706433/maps?cid=1', 'UNSAFE_URL'],
    ['https://0x7f.1/maps?cid=1', 'UNSAFE_URL'],
    ['https://[::1]/maps?cid=1', 'UNSAFE_URL'],
    ['https://10.0.0.1/maps?cid=1', 'UNSAFE_URL'],
    ['https://169.254.169.254/latest/meta-data/', 'UNSAFE_URL'],
    ['https://142.250.1.1/maps?cid=1', 'IP_LITERAL_HOST'],
    ['https://[2606:4700:4700::1111]/maps?cid=1', 'IP_LITERAL_HOST'],
    ['https://evil.com\\@www.google.com/maps?cid=1', 'BACKSLASH'],
    ['https://www.xn--ggle-0nda.com/maps?cid=1', 'IDN_LOOKALIKE_HOST'],
    ['https://www.ɡoogle.com/maps?cid=1', 'IDN_LOOKALIKE_HOST'],
  ];
  for (const [link, code] of rejected) expectResult(link, 'REJECTED', code);
});

test('credenciais embutidas não são repetidas no resultado', () => {
  const result = parseGoogleMapsLink('https://usuario:segredo123@www.google.com/maps?cid=1');
  assert.equal(result.status, 'REJECTED');
  assert.ok(!JSON.stringify(result).includes('segredo123'));
  assert.ok(!JSON.stringify(result).includes('usuario'));
});

test('a dica de nome é sanitizada, limitada e nunca é identidade', () => {
  const html = parseGoogleMapsLink(`https://www.google.com/maps/place/%3Cscript%3Ealert(1)%3C%2Fscript%3E/data=!1s${FID}`);
  assert.ok(html.status === 'IDENTIFIED');
  assert.ok(html.untrustedLabelHint && !/[<>]/.test(html.untrustedLabelHint));

  const long = parseGoogleMapsLink(`https://www.google.com/maps/place/${'A'.repeat(500)}/data=!1s${FID}`);
  assert.ok(long.status === 'IDENTIFIED' && (long.untrustedLabelHint?.length ?? 0) <= 120);

  const nameOnly = parseGoogleMapsLink('https://www.google.com/maps/place/Padaria+Exemplo');
  assert.equal(nameOnly.status, 'AMBIGUOUS');
  assert.equal('identifiers' in nameOnly, false);
});

test('entradas adversariais longas são processadas rapidamente (sem backtracking catastrófico)', () => {
  const inputs = [
    `https://www.google.com/maps/place/${'a'.repeat(1900)}`,
    `https://www.google.com/maps/data=${'!1s0x'.repeat(380)}`,
    `https://www.google.com/maps?q=${'place_id:'.repeat(200)}`,
    `https://www.google.com/maps?cid=${'1'.repeat(1900)}`,
    `https://www.google.com/maps/${'%41'.repeat(600)}`,
    `https://www.google.com/maps?${'cid=1&'.repeat(300)}`,
  ];
  const started = Date.now();
  for (const input of inputs) parseGoogleMapsLink(input);
  assert.ok(Date.now() - started < 500, 'o parser deve ser linear no tamanho da entrada');
});

test('o parser é offline: nenhuma chamada de rede, DNS ou fetch em nenhum formato', () => {
  const trap = (name: string) => () => {
    throw new Error(`rede proibida: ${name}`);
  };
  const guards = [
    mock.method(globalThis, 'fetch', trap('fetch')),
    mock.method(dns, 'lookup', trap('dns.lookup') as never),
    mock.method(dns.promises, 'lookup', trap('dns.promises.lookup') as never),
    mock.method(net, 'connect', trap('net.connect') as never),
    mock.method(http, 'request', trap('http.request') as never),
    mock.method(https, 'request', trap('https.request') as never),
  ];
  try {
    const inputs = [
      LONG_LINK,
      'https://maps.app.goo.gl/AbCd1234',
      'https://goo.gl/maps/Xyz987_-Qw',
      'https://g.page/padaria-exemplo',
      'https://www.google.com/maps?cid=1',
      'https://example.com/',
      'https://127.0.0.1/',
      'http://localhost/',
      'javascript:alert(1)',
      '',
    ];
    for (const input of inputs) parseGoogleMapsLink(input);
    for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
  } finally {
    for (const guard of guards) guard.mock.restore();
  }
});
