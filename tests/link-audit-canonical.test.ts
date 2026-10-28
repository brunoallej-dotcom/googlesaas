import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, CanonicalizationError, sha256Hex } from '../src/lib/link-audit/canonical';

test('SHA-256: vetor de teste conhecido', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('a ordem das chaves não muda o resultado, em qualquer profundidade', () => {
  const a = { b: 1, a: { y: [1, 2], x: 'v' }, c: null };
  const b = { c: null, a: { x: 'v', y: [1, 2] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"x":"v","y":[1,2]},"b":1,"c":null}');
  assert.equal(sha256Hex(canonicalJson(a)), sha256Hex(canonicalJson(b)));
});

test('propriedade undefined equivale a ausente; null não', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  assert.notEqual(canonicalJson({ a: 1, b: null }), canonicalJson({ a: 1 }));
});

test('a ordem dos elementos de um array é parte do conteúdo', () => {
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
});

test('texto equivalente em NFC e NFD tem o mesmo resultado (valores e chaves)', () => {
  const nfc = 'Padaria Pão de Açúcar'.normalize('NFC');
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd);
  assert.equal(canonicalJson({ nome: nfc }), canonicalJson({ nome: nfd }));
  assert.equal(canonicalJson({ ['ação'.normalize('NFC')]: 1 }), canonicalJson({ ['ação'.normalize('NFD')]: 1 }));
});

test('qualquer mudança de valor muda o hash', () => {
  const base = { id: 'x', n: 1, ok: true, s: 'texto', list: ['a', 'b'] };
  const reference = sha256Hex(canonicalJson(base));
  for (const changed of [
    { ...base, id: 'y' },
    { ...base, n: 2 },
    { ...base, ok: false },
    { ...base, s: 'texto ' },
    { ...base, list: ['a', 'c'] },
    { ...base, extra: 1 },
  ]) {
    assert.notEqual(sha256Hex(canonicalJson(changed)), reference);
  }
});

test('-0 e números normais seguem o JSON', () => {
  assert.equal(canonicalJson({ n: -0 }), '{"n":0}');
  assert.equal(canonicalJson([1.5, 10, -3]), '[1.5,10,-3]');
});

test('valores sem representação inequívoca são recusados, não convertidos', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  // eslint-disable-next-line no-sparse-arrays
  const sparse = [1, , 3];
  let deep: unknown = 'fim';
  for (let i = 0; i < 70; i++) deep = { n: deep };

  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Infinity }],
    ['bigint', { n: 10n }],
    ['função', { f: () => 1 }],
    ['symbol', { s: Symbol('x') }],
    ['chave symbol', { [Symbol('k')]: 1 }],
    ['undefined no topo', undefined],
    ['undefined em array', [1, undefined]],
    ['array esparso', sparse],
    ['Date', { d: new Date(0) }],
    ['Map', { m: new Map() }],
    ['Set', { s: new Set() }],
    ['classe', { c: new (class Foo {})() }],
    ['ciclo', cycle],
    ['profundidade', deep],
    ['chaves iguais após NFC', { ['é'.normalize('NFC')]: 1, ['é'.normalize('NFD')]: 2 }],
  ];
  for (const [label, value] of invalid) {
    assert.throws(() => canonicalJson(value), CanonicalizationError, label);
  }
});

test('objeto de JSON.parse com chaves especiais é serializado como dado, sem poluir protótipos', () => {
  const parsed = JSON.parse('{"__proto__":{"admin":true},"constructor":1,"a":2}') as Record<string, unknown>;
  const text = canonicalJson(parsed);
  assert.equal(text, '{"__proto__":{"admin":true},"a":2,"constructor":1}');
  assert.equal(({} as Record<string, unknown>).admin, undefined);
});
