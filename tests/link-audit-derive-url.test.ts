import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { deriveWebsite, MAX_WEBSITE_LENGTH, URL_DERIVATION_RULE } from '../src/lib/link-audit-evidence/derive-url';
import { obs, run, sub } from './helpers/link-audit-scoring-fixtures';

/* Dados 100% FICTÍCIOS. A derivação é pura: nenhum teste toca rede, disco ou ambiente. */
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

test('UTM: completo, parcial, ausente, vazio, só espaços, maiúsculas e duplicado', () => {
  const level = (url: string) => {
    const d = deriveWebsite(url);
    assert.equal(d.state, 'DERIVED', url);
    return d.state === 'DERIVED' ? [d.utm.level, d.utm.names.join(',')] : null;
  };
  assert.deepEqual(level('https://exemplo.com.br/?utm_source=google&utm_medium=gbp'), ['COMPLETE', 'utm_medium,utm_source']);
  assert.deepEqual(level('https://exemplo.com.br/?UTM_Source=g&Utm_Medium=gbp'), ['COMPLETE', 'utm_medium,utm_source'], 'nomes sem diferenciar caixa, como no motor');
  assert.deepEqual(level('https://exemplo.com.br/?utm_source=google'), ['PARTIAL', 'utm_source']);
  assert.deepEqual(level('https://exemplo.com.br/?utm_source=google&utm_campaign=x&utm_term=y&utm_content=z&utm_id=1'), ['PARTIAL', 'utm_campaign,utm_content,utm_id,utm_source,utm_term']);
  assert.deepEqual(level('https://exemplo.com.br/'), ['NOT_OBSERVED', '']);
  assert.deepEqual(level('https://exemplo.com.br/?utm_source=&utm_medium='), ['NOT_OBSERVED', ''], 'valor vazio não conta');
  assert.deepEqual(level('https://exemplo.com.br/?utm_source=%20%20&utm_medium=+'), ['NOT_OBSERVED', ''], 'valor só de espaços não conta');
  assert.deepEqual(level('https://exemplo.com.br/?utm_source=a&utm_source=b&utm_medium=c'), ['COMPLETE', 'utm_medium,utm_source'], 'repetido conta uma vez');
  assert.deepEqual(level('https://exemplo.com.br/?utm_foo=bar&utm_bar=baz'), ['PARTIAL', ''], 'utm_* desconhecido conta como no motor (PARTIAL), mas não vai para `names` nem para a derivada');
  assert.deepEqual(level('https://exemplo.com.br/#utm_source=a&utm_medium=b'), ['NOT_OBSERVED', ''], 'UTM só no fragmento não é lido (o motor só lê a query)');
});

test('a URL derivada mantém scheme://host[:porta]/path e só utm_* com valor "x": credenciais, fragmento e demais parâmetros somem', () => {
  const raw = 'https://usuario:SENHA-SECRETA@Exemplo.com.br:8443/loja/centro?token=TOKEN-SECRETO&utm_source=ORIGEM-SECRETA&igsh=IG-SECRETO&utm_medium=MEIO-SECRETO&sessao=SESSAO#ancora-secreta';
  const d = deriveWebsite(raw);
  assert.equal(d.state, 'DERIVED');
  if (d.state !== 'DERIVED') return;
  assert.equal(d.derived, 'https://exemplo.com.br:8443/?utm_medium=x&utm_source=x');
  for (const secret of ['SENHA-SECRETA', 'usuario', 'TOKEN-SECRETO', 'ORIGEM-SECRETA', 'IG-SECRETO', 'MEIO-SECRETO', 'SESSAO', 'sessao', 'ancora-secreta', 'igsh']) {
    assert.ok(!JSON.stringify(d).includes(secret), `a derivada não pode conter ${secret}`);
  }
  assert.equal(d.rawSha256, sha(raw), 'o hash é do bruto: permite conferir sem guardar a URL');
  assert.equal(d.rule, URL_DERIVATION_RULE);
  assert.equal(deriveWebsite('http://exemplo.com.br').state === 'DERIVED' && (deriveWebsite('http://exemplo.com.br') as { derived: string }).derived, 'http://exemplo.com.br/');
});

test('o CAMINHO é descartado: segredos no path (token, chave, Bearer, ;jsessionid) nunca chegam à derivada', () => {
  const raw = 'https://loja.example/p/SEGREDO8/sk-abcdefghijklmnopqrstuvwxyz0123/Bearer%20abcdefgh12345678;jsessionid=SEGREDO9?utm_source=S10&utm_medium=S11#f';
  const d = deriveWebsite(raw);
  assert.equal(d.state === 'DERIVED' && d.derived, 'https://loja.example/?utm_medium=x&utm_source=x');
  for (const secret of ['SEGREDO', 'sk-', 'Bearer', 'jsessionid', 'S10', 'S11']) assert.ok(!JSON.stringify(d).includes(secret), secret);
});

test('o hash é do texto após trim; espaços ao redor não alteram a derivação', () => {
  const clean = 'https://exemplo.com.br/a?utm_source=g&utm_medium=m';
  const padded = `  \n${clean}\t `;
  assert.deepEqual(deriveWebsite(padded), deriveWebsite(clean));
  assert.equal(deriveWebsite(padded).rawSha256, sha(clean));
});

test('sem esquema, malformado, não-http, vazio ou longo demais: UNPARSABLE, sem URL derivada e sem UTM inventado', () => {
  const cases: Array<[string, string]> = [
    ['www.exemplo.com.br/?utm_source=a&utm_medium=b', 'MALFORMED'],
    ['exemplo.com.br', 'MALFORMED'],
    ['http://', 'MALFORMED'],
    ['https://', 'MALFORMED'],
    ['ftp://exemplo.com.br/?utm_source=a&utm_medium=b', 'NOT_HTTP'],
    ['mailto:contato@exemplo.com.br', 'NOT_HTTP'],
    ['javascript:alert(1)', 'NOT_HTTP'],
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    [`https://exemplo.com.br/${'a'.repeat(MAX_WEBSITE_LENGTH)}`, 'TOO_LONG'],
  ];
  for (const [raw, reason] of cases) {
    const d = deriveWebsite(raw);
    assert.equal(d.state, 'UNPARSABLE', raw.slice(0, 40));
    if (d.state === 'UNPARSABLE') assert.deepEqual([d.reason, d.derived, d.utm], [reason, null, null], raw.slice(0, 40));
  }
  assert.equal(deriveWebsite(undefined as unknown as string).state, 'UNPARSABLE', 'valor que não é texto');
});

test('idempotência: derivar a derivada não muda nada (mesma classificação e mesmo texto)', () => {
  for (const raw of [
    'https://a.example/?utm_source=g&utm_medium=m',
    'https://a.example:8080/x/y?utm_source=g&k=v',
    'https://a.example/x?q=1',
    'http://a.example',
    'https://u:p@a.example/?UTM_MEDIUM=m&utm_source=s&z=1#f',
  ]) {
    const first = deriveWebsite(raw);
    assert.equal(first.state, 'DERIVED');
    if (first.state !== 'DERIVED') continue;
    const second = deriveWebsite(first.derived);
    assert.equal(second.state === 'DERIVED' && second.derived, first.derived, raw);
    assert.deepEqual(second.state === 'DERIVED' && second.utm, first.utm, raw);
  }
});

test('PROVA COM O MOTOR: o X5 do bruto e o X5 da derivada dão o mesmo resultado (estado, pontos, faixa, motivo)', () => {
  const x5 = (url: string) => {
    const result = sub(
      run((draft) => {
        (draft.profile as { website: unknown }).website = [obs(url, { complete: true })];
      }),
      'X5',
    );
    return [result.state, result.obtainedHalfPoints, result.evaluatedHalfPoints, result.tier, result.reasonCode];
  };
  for (const raw of [
    'https://exemplo.com.br/?utm_source=google&utm_medium=gbp',
    'https://exemplo.com.br/?UTM_Source=g&Utm_Medium=gbp&gclid=ABC',
    'https://exemplo.com.br/?utm_source=google',
    'https://exemplo.com.br/?utm_medium=gbp&utm_campaign=x',
    'https://exemplo.com.br/',
    'https://exemplo.com.br/?utm_source=&utm_medium=',
    'https://exemplo.com.br/#utm_source=a&utm_medium=b',
    'https://u:p@exemplo.com.br:8443/p?token=T&utm_source=a&utm_medium=b#f',
  ]) {
    const d = deriveWebsite(raw);
    assert.equal(d.state, 'DERIVED');
    if (d.state === 'DERIVED') assert.deepEqual(x5(d.derived), x5(raw), raw);
  }
});
