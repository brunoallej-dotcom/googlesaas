import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScoringInput } from '../src/lib/link-audit/scoring';
import { AUDIT_ID_PATTERN } from '../src/lib/link-audit-evidence/types';
import {
  AUDIT_ID_ALIAS_RULE,
  deriveAuditIdAlias,
  ENGINE_AUDIT_ID,
  RESERVED_ALIAS_SHAPE,
  STORE_AUDIT_ID,
  verifyAuditIdAlias,
  type AuditIdAlias,
} from '../src/lib/link-audit-scoring-runs/audit-id-alias';
import { AUDIT } from './helpers/link-audit-mapper-fixtures';

/*
 * Onda 6C, I2 (M-10): `auditId` com `_`. O armazenamento aceita `_`; o motor só `[a-z0-9-]`. O alias é determinístico,
 * auditável (regra, motivo e id de origem gravados) e SEM colisão por construção: o conjunto dos ids inalterados e o dos
 * aliases são disjuntos, e ids distintos só coincidiriam por colisão de 128 bits do SHA-256.
 */
const alias = (id: string): AuditIdAlias => {
  const result = deriveAuditIdAlias(id);
  assert.ok(result, `id inválido: ${id}`);
  return result;
};
const scoringId = (id: string): string => alias(id).scoringAuditId;

/** PRNG determinístico (sem Math.random): xorshift32. */
function prng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789-_';
function randomId(random: () => number): string {
  const length = 8 + Math.floor(random() * 57);
  let id = ALPHABET[Math.floor(random() * 36)] as string; // começa alfanumérico
  while (id.length < length) id += ALPHABET[Math.floor(random() * ALPHABET.length)] as string;
  return id;
}

test('os padrões locais são IGUAIS aos reais: armazenamento (AUDIT_ID_PATTERN) e contrato do motor (testado contra o schema)', () => {
  assert.equal(STORE_AUDIT_ID.source, AUDIT_ID_PATTERN.source);
  const accepts = (auditId: string): boolean =>
    parseScoringInput({ schemaVersion: 1, auditId, referenceDate: '2026-10-22', evidences: [] }).ok;
  for (const candidate of ['abcdef', 'a-b-c-d', 'a'.repeat(64), 'abc_def', '-abcdef', 'ABCDEF', 'abcde', 'a'.repeat(65), 'abc def', 'ab.cdef', '1bcdef', 'ux' + 'a'.repeat(32)]) {
    assert.equal(ENGINE_AUDIT_ID.test(candidate), accepts(candidate), `padrão do motor ≠ schema para "${candidate}"`);
  }
});

test('id comum (sem "_", válido no motor, fora da forma reservada) passa INALTERADO e sem alias aplicado', () => {
  for (const id of [AUDIT, 'tuvaplast-20261022-maps01', 'a1b2c3d4', 'x'.repeat(64), '9-9-9-9-9-9']) {
    assert.deepEqual(alias(id), { applied: false, rule: 'IDENTITY', reason: null, sourceAuditId: id, scoringAuditId: id });
  }
});

test('id com "_" recebe alias aceito pelo motor: determinístico, legível, até 64 caracteres, com regra, motivo e id de origem', () => {
  const id = 'tuvaplast_20261022_maps01';
  const result = alias(id);
  assert.equal(result.applied, true);
  assert.equal(result.rule, AUDIT_ID_ALIAS_RULE);
  assert.equal(result.reason, 'CONTAINS_UNDERSCORE');
  assert.equal(result.sourceAuditId, id);
  assert.match(result.scoringAuditId, /^tuvaplast-20261022-maps01-ux[0-9a-f]{32}$/);
  assert.ok(ENGINE_AUDIT_ID.test(result.scoringAuditId) && result.scoringAuditId.length <= 64);
  assert.deepEqual(alias(id), result, 'determinístico');
  assert.equal(parseScoringInput({ schemaVersion: 1, auditId: result.scoringAuditId, referenceDate: '2026-10-22', evidences: [] }).ok, true, 'o motor aceita o alias');
});

test('o alias NÃO colide com o id que só troca "_" por "-" (a armadilha do alias ingênuo)', () => {
  const underscore = 'padaria_exemplo_01';
  const hyphen = 'padaria-exemplo-01';
  assert.notEqual(scoringId(underscore), scoringId(hyphen));
  assert.equal(scoringId(hyphen), hyphen, 'o id comum continua inalterado');
  assert.notEqual(scoringId(underscore), hyphen);
});

test('ids que diferem só na posição do "_" ou na troca "_"/"-" geram aliases distintos', () => {
  const family = ['ab_cd_ef_gh', 'ab_cd-ef_gh', 'ab-cd_ef_gh', 'ab_cd_ef-gh', 'ab_cd_ef_gh_', 'ab__cd_ef_gh', 'ab_cd__ef_gh', 'ab-cd-ef_gh', 'ab_cd_ef_g-h'];
  const aliases = family.map(scoringId);
  assert.equal(new Set(aliases).size, family.length);
  for (const [index, id] of family.entries()) assert.ok(verifyAuditIdAlias(alias(id)), family[index]);
});

test('um id comum IGUAL ao alias de outro id não colide: a forma reservada força o alias também nele (disjunção por construção)', () => {
  const underscore = 'padaria_exemplo_01';
  const forged = scoringId(underscore); // alguém cria um auditId comum copiando o alias
  assert.ok(STORE_AUDIT_ID.test(forged), 'é um auditId válido no armazenamento');
  assert.ok(RESERVED_ALIAS_SHAPE.test(forged));
  const forgedAlias = alias(forged);
  assert.equal(forgedAlias.applied, true, 'não passa inalterado');
  assert.equal(forgedAlias.reason, 'RESERVED_SHAPE');
  assert.notEqual(forgedAlias.scoringAuditId, forged);
  assert.notEqual(forgedAlias.scoringAuditId, scoringId(underscore));
  assert.equal(scoringId(forgedAlias.scoringAuditId) === forgedAlias.scoringAuditId, false, 'o alias do alias também é aliasado (nunca inalterado)');
});

test('forma reservada: só "-ux"+32 hex ao FIM, depois de um trecho legível, é reservada; "ux"+32 hex sozinho ou parecido é um id comum', () => {
  const reserved = `padaria-ux${'a'.repeat(32)}`;
  assert.equal(alias(reserved).applied, true);
  assert.equal(alias(reserved).reason, 'RESERVED_SHAPE');
  const bare = `ux${'a'.repeat(32)}`;
  assert.equal(alias(bare).applied, false, 'sem "-" antes de "ux" não é a forma de um alias (todo alias tem trecho legível + "-ux")');
  assert.ok(!RESERVED_ALIAS_SHAPE.test(bare));
  const short = `padaria-ux${'a'.repeat(31)}`;
  assert.equal(alias(short).applied, false, '31 hex não é a forma reservada');
  const longer = `padaria-ux${'a'.repeat(33)}`;
  assert.equal(alias(longer).applied, false, '33 hex: o sufixo de 32 não está ancorado depois de "-"');
  const upperTail = `padaria-ux${'a'.repeat(31)}g`;
  assert.equal(alias(upperTail).applied, false, 'só hexadecimais minúsculos');
  // nenhum alias é igual a um id comum, inclusive o "ux"+32 hex sozinho
  for (const source of ['a_b_c_d_e_f', bare, reserved]) assert.ok(RESERVED_ALIAS_SHAPE.test(alias(source).scoringAuditId) || !alias(source).applied);
  assert.notEqual(alias('a_b_c_d_e_f').scoringAuditId, bare);
});

test('propriedade: 20.000 ids válidos (aleatórios determinísticos + armadilhas) ⇒ saída sempre aceita pelo motor e NENHUMA colisão entre ids distintos', () => {
  const random = prng(20261029);
  const ids = new Set<string>();
  for (let i = 0; i < 20_000; i += 1) {
    const id = randomId(random);
    if (STORE_AUDIT_ID.test(id)) ids.add(id);
  }
  // armadilhas: aliases de ids existentes viram ids comuns; "_" vs "-"; comprimentos-limite
  for (const id of [...ids].slice(0, 2_000)) {
    ids.add(scoringId(id));
    ids.add(id.replace(/_/g, '-'));
    ids.add(id.replace(/-/g, '_'));
  }
  for (const length of [8, 9, 63, 64]) ids.add(`a_${'b'.repeat(length - 2)}`);
  ids.add(`${'a_'.repeat(32)}`);
  const seen = new Map<string, string>();
  for (const id of ids) {
    if (!STORE_AUDIT_ID.test(id)) continue;
    const result = alias(id);
    assert.ok(ENGINE_AUDIT_ID.test(result.scoringAuditId) && result.scoringAuditId.length <= 64, `fora do contrato do motor: ${id}`);
    assert.equal(verifyAuditIdAlias(result), true, id);
    const previous = seen.get(result.scoringAuditId);
    assert.ok(previous === undefined || previous === id, `colisão: "${previous}" e "${id}" → "${result.scoringAuditId}"`);
    seen.set(result.scoringAuditId, id);
    // disjunção: inalterado ⇔ fora da forma reservada e sem "_"
    assert.equal(result.applied, id.includes('_') || RESERVED_ALIAS_SHAPE.test(id));
    assert.equal(RESERVED_ALIAS_SHAPE.test(result.scoringAuditId), result.applied, 'só os aliases têm a forma reservada');
  }
  assert.ok(seen.size > 20_000, `amostra pequena: ${seen.size}`);
});

test('ids longos: o trecho legível é truncado, o resumo é preservado e o total nunca passa de 64', () => {
  const id = `${'a_'.repeat(31)}ab`; // 64 caracteres
  assert.equal(id.length, 64);
  const result = alias(id);
  assert.equal(result.scoringAuditId.length, 64);
  assert.match(result.scoringAuditId, /-ux[0-9a-f]{32}$/);
  assert.notEqual(scoringId(`${id.slice(0, -1)}c`), result.scoringAuditId, 'a diferença no fim (truncada do legível) continua no resumo');
});

test('o alias é auditável: quem adultera qualquer campo (regra, motivo, id de origem, alias) é detectado', () => {
  const good = alias('padaria_exemplo_01');
  assert.equal(verifyAuditIdAlias(good), true);
  const tampered: Array<Partial<AuditIdAlias>> = [
    { scoringAuditId: alias('padaria_exemplo_02').scoringAuditId },
    { scoringAuditId: 'padaria-exemplo-01' },
    { sourceAuditId: 'padaria_exemplo_02' },
    { rule: 'IDENTITY' },
    { applied: false },
    { reason: 'RESERVED_SHAPE' },
    { reason: null },
  ];
  for (const change of tampered) assert.equal(verifyAuditIdAlias({ ...good, ...change }), false, JSON.stringify(change));
  for (const junk of [null, undefined, 'x', 7, [], {}, { sourceAuditId: 5 }]) assert.equal(verifyAuditIdAlias(junk), false);
  assert.equal(verifyAuditIdAlias(alias(AUDIT)), true, 'a identidade também é verificável');
  assert.equal(verifyAuditIdAlias({ ...alias(AUDIT), scoringAuditId: 'outro-id-qualquer' }), false);
});

test('ids inválidos para o armazenamento não geram alias (nada é "consertado" a partir de lixo)', () => {
  for (const junk of ['', 'curto', 'ABC_DEF_GHI', 'abc def ghi', '../abc_defgh', '-abc_defgh', '_abc_defgh', 'a'.repeat(65), 'abc.defgh', 'ábc_defgh', null, undefined, 42, {}, []]) {
    assert.equal(deriveAuditIdAlias(junk), null, String(junk));
  }
});
