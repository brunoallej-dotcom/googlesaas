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
const FIXTURE = path.join(__dirname, 'fixtures', 'link-audit-storage', 'protocol-conformance-v1.json');
const FIXTURE_SHA256 = '17dda7f947065b9c249f18118dc5e0a08f7bce3d9d7204e1490edd591c6a877f';

test('a referência de conformidade gravada antes da refatoração não foi alterada', () => {
  assert.equal(createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex'), FIXTURE_SHA256);
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
