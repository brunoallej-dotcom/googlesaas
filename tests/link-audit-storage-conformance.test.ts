import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/lib/link-audit/canonical';
import { registerCleanup } from './helpers/link-audit-decisions-fixtures';
import { runConformanceScenario } from './helpers/storage-conformance-scenario';

registerCleanup();

/*
 * Conformidade do protocolo de armazenamento da 6B (Onda 6C, I0). A referência foi GRAVADA ANTES de extrair as primitivas
 * para `link-audit-storage` (commit-base d7b0eec). Este teste reexecuta o mesmo cenário e exige resultado IDÊNTICO: nenhum
 * byte de arquivo (decisões e recibos), código de erro, mensagem, `head`, `pending` ou saída de primitiva pode mudar.
 * Regenerar a referência é mudar o protocolo da 6B: exige decisão deliberada (por isso o hash abaixo está fixado).
 */
/*
 * v1 = referência gravada ANTES da refatoração do I0 (protocolo sem prova de origem), CONGELADA como evidência histórica.
 * v2 = a mesma cena sobre o protocolo COM prova de origem (remediação do MAJOR-1, decisão deliberada): as entradas passam a levar a etiqueta
 * `origin` (todo hash/head muda) e a pendente exibida a OUTRO operador deixa de revelar o conteúdo do registro. O teste "v2 difere de v1 só
 * no que foi decidido" prova que nada além disso mudou (códigos, mensagens, ordem, recuperação, primitivas).
 * A v2 foi REGENERADA em 01/11/2026 por duas decisões deliberadas do responsável: política de chaves (identificador independente do segredo ⇒ `kid` e
 * etiquetas mudam) e os campos `ambiguousDecisionIds` e `witness` na listagem (1ª regeneração: ambiguidade; 2ª, R3-MINOR-2: testemunha do histórico; 4ª, livro de cabeças (02/11/2026): a listagem ganhou o campo `ledger` (neste cenário, 6B isolada com `LEDGER_NOT_REQUIRED`: `NOT_REQUIRED`); 3ª, R4-MINOR-1/INFO-1 em 01/11/2026: a testemunha passou a ser OBRIGATÓRIA e ganhou `coveredSeq` e `unwitnessedAffecting`; neste cenário
 * (6B isolada, `WITNESS_NOT_REQUIRED`) o estado é `NOT_REQUIRED`, antes `NOT_CONFIGURED`, que agora significa FALHA FECHADA).
 * Conferido por máscara: fora hashes, `kid` e esses campos, o conteúdo é idêntico ao da v2 anterior (verificado removendo `witness` e `ledger` das duas versões).
 * 5ª regeneração (19/11/2026, onda R1.2, emenda §16.17 do livro aceita pelo responsável no ADR-0002): a vista do livro ganhou `decisionHead` (cabeça de decisões
 * separada da cauda, D-6), também no estado `NOT_REQUIRED`. Conferido campo a campo contra a v2 anterior: a única diferença são 7 acréscimos de `decisionHead: null`.
 */
const FIXTURE_V1 = path.join(__dirname, 'fixtures', 'link-audit-storage', 'protocol-conformance-v1.json');
const FIXTURE_V1_SHA256 = '17dda7f947065b9c249f18118dc5e0a08f7bce3d9d7204e1490edd591c6a877f';
const FIXTURE = path.join(__dirname, 'fixtures', 'link-audit-storage', 'protocol-conformance-v2.json');
const FIXTURE_SHA256 = 'def83f23c0701ca88684b04d4e4ac6e5cc72b21b1ae0e5b7c99f053c638bf42c';

test('a referência v1 (anterior à prova de origem) não foi alterada', () => {
  assert.equal(createHash('sha256').update(fs.readFileSync(FIXTURE_V1)).digest('hex'), FIXTURE_V1_SHA256);
});

test('a referência v2 (com prova de origem) não foi alterada', () => {
  assert.equal(createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex'), FIXTURE_SHA256);
});

test('v2 difere de v1 SÓ no que foi decidido: hashes (campo origin nos arquivos) e o conteúdo da pendente escondido de outro operador', () => {
  const NEW = new Set(['origin', 'originDetail', 'isMine', 'ambiguousDecisionIds', 'witness', 'ledger']);
  const norm = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(norm);
    if (typeof value === 'string') return value.replace(/[0-9a-f]{64}/g, '<h64>');
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !NEW.has(key)).map(([key, v]) => [key, norm(v)]));
    return value;
  };
  const v1 = norm(JSON.parse(fs.readFileSync(FIXTURE_V1, 'utf8'))) as { steps: Array<{ step: string; result: any }>; primitives: unknown; storeNegatives: unknown };
  const v2 = norm(JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))) as typeof v1;
  assert.deepEqual(v2.primitives, v1.primitives);
  assert.deepEqual(v2.storeNegatives, v1.storeNegatives);
  assert.equal(v2.steps.length, v1.steps.length);
  const different = v1.steps.flatMap((step, index) => (JSON.stringify(step) === JSON.stringify(v2.steps[index]) ? [] : [index]));
  assert.deepEqual(different.map((index) => v1.steps[index]?.step), ['outro operador sobre a pendente', 'revogação alheia sobre a pendente']);
  for (const index of different) {
    const before = v1.steps[index]?.result;
    const after = v2.steps[index]?.result;
    assert.notEqual(before.pending.record, null, 'na v1 o conteúdo da pendente aparecia para outro operador');
    assert.equal(after.pending.record, null, 'na v2 só o autor com origem comprovada vê o conteúdo');
    assert.deepEqual({ ...after, pending: { ...after.pending, record: before.pending.record } }, before);
  }
});

test('CONFORMIDADE — o protocolo da 6B reproduz exatamente a referência (arquivos, códigos, mensagens, head, pendente, primitivas)', async () => {
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Awaited<ReturnType<typeof runConformanceScenario>>;
  const actual = JSON.parse(canonicalJson(await runConformanceScenario())) as typeof expected;
  assert.equal(actual.steps.length, expected.steps.length);
  for (const [index, step] of expected.steps.entries()) assert.deepEqual(actual.steps[index], step, `passo ${index + 1}: ${step.step}`);
  assert.deepEqual(actual.trees.afterWrites, expected.trees.afterWrites, 'árvore de arquivos depois das gravações');
  assert.deepEqual(actual.trees.afterTamperRestore, expected.trees.afterTamperRestore, 'árvore depois de adulterar e restaurar');
  assert.deepEqual(actual.primitives, expected.primitives, 'primitivas puras');
  assert.deepEqual(actual.storeNegatives, expected.storeNegatives, 'erros de configuração e localização');
  assert.deepEqual(actual, expected);
});
