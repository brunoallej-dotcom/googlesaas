import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { computePackageSha256 } from '../src/lib/link-audit-attestation/package-hash';
import { candidatePackageSchema, type CandidatePackage } from '../src/lib/link-audit-attestation/schemas';
import { parseSignArgs } from '../src/lib/link-audit-attestation/sign-args';
import { terminalConfirm } from '../src/lib/link-audit-attestation/sign-terminal';
import { registerCleanup } from './helpers/link-audit-evidence-fixtures';
import { cliWorld, E1, jsonOut, makePackage, runSign } from './helpers/link-audit-seal-sign-cli-fixtures';

/*
 * W5.2b, revisão do PR #62 (decisão do manager): a marca da coleta SIMULADA ENTRA no pacote (`simulated: true`, só no simulado, coberta pelo
 * `packageSha256`) e o `sign` só assina pacote simulado com a opção própria `--simulated` (o `sign` roda com `env -i`: nada de variável de
 * ambiente), mostrando "SIMULADA — ensaio" na confirmação humana. Pacote real com `--simulated` também é recusado. Dados 100% FICTÍCIOS: pacote
 * de teste, chave gerada em memória e gravada cifrada em pasta temporária, terminal falso.
 */
registerCleanup();

/** O pacote de teste da W4.4 com a marca da coleta simulada, hash refeito sobre o corpo COM a marca. */
function simulatedPackage(): CandidatePackage {
  const { packageSha256: _old, ...rest } = makePackage(E1);
  void _old;
  const body = { ...rest, simulated: true as const };
  return candidatePackageSchema.parse({ ...body, packageSha256: computePackageSha256(body) });
}

const sealsIn = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((name) => name.endsWith('.json')) : []);

test('pacote (1): o esquema aceita simulated:true SÓ como literal; ausente nos reais, e o hash muda com a marca', () => {
  const real = makePackage(E1);
  const simulated = simulatedPackage();
  assert.ok(!('simulated' in real));
  assert.equal(simulated.simulated, true);
  assert.notEqual(simulated.packageSha256, real.packageSha256, 'a marca está dentro do hash');
  assert.equal(candidatePackageSchema.safeParse({ ...real, simulated: false }).success, false, 'simulated:false não existe');
  assert.equal(candidatePackageSchema.safeParse({ ...real, simulated: 'sim' }).success, false);
});

test('sign (1): --simulated é uma opção booleana própria do sign (sem valor, sem variável de ambiente); ausente = false', () => {
  const world = cliWorld();
  const plain = parseSignArgs(world.argv());
  const flagged = parseSignArgs(world.argv({}, ['--simulated']));
  assert.ok(!('ok' in plain) && !('ok' in flagged));
  assert.equal(plain.simulated, false);
  assert.equal(flagged.simulated, true);
  const repeated = parseSignArgs(world.argv({}, ['--simulated', '--simulated']));
  assert.ok('ok' in repeated && repeated.code === 'USAGE');
});

test('sign (1): pacote SIMULADO sem --simulated ⇒ SIGN_SIMULATED_PACKAGE (código 3), ANTES da confirmação e da frase; nada assinado', async () => {
  const world = cliWorld({ pkg: simulatedPackage() });
  for (const extra of [[], ['--json']]) {
    const run = await runSign(world.argv({}, extra), { typed: world.typed() });
    assert.equal(run.code, 3, run.stderr);
    if (extra.length > 0) assert.equal(jsonOut(run).code, 'SIGN_SIMULATED_PACKAGE');
    else assert.match(run.stderr, /RECUSADO.*SIMULAD/);
    assert.equal(run.terminal.reads, 0, 'nem a confirmação nem a frase foram lidas');
    assert.deepEqual(sealsIn(world.sealsDir), []);
  }
});

test('sign (1): pacote SIMULADO com --simulated ⇒ a confirmação humana mostra "SIMULADA — ensaio" antes da digitação, e o manifesto é gravado', async () => {
  const world = cliWorld({ pkg: simulatedPackage() });
  const run = await runSign(world.argv({}, ['--simulated']), { typed: world.typed() });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.terminal.deliveries[0]?.screen ?? '', /SIMULADA — ensaio/, 'o aviso estava na tela quando a confirmação foi digitada');
  assert.deepEqual(sealsIn(world.sealsDir).map((name) => path.basename(name)), ['seal-0001.json']);
});

test('sign (1): pacote REAL com --simulated ⇒ SIGN_SIMULATED_PACKAGE (a opção afirma que o pacote é simulado), antes da confirmação e da frase', async () => {
  const world = cliWorld();
  const run = await runSign(world.argv({}, ['--simulated', '--json']), { typed: world.typed() });
  assert.equal(run.code, 3);
  assert.equal(jsonOut(run).code, 'SIGN_SIMULATED_PACKAGE');
  assert.equal(run.terminal.reads, 0);
  assert.deepEqual(sealsIn(world.sealsDir), []);
  // controle: o mesmo pacote real, sem a opção, assina como antes e a tela não fala em SIMULADA
  const plain = await runSign(world.argv(), { typed: world.typed() });
  assert.equal(plain.code, 0, plain.stderr);
  assert.doesNotMatch(plain.terminal.deliveries[0]?.screen ?? '', /SIMULADA/);
});

test('sign (1): a tela da confirmação só fala em SIMULADA quando o pacote é simulado (porta do terminal, isolada)', async () => {
  const say: string[] = [];
  const input = { hideEcho: (): void => undefined, readLine: async (): Promise<Buffer> => Buffer.from('abc', 'utf8'), close: (): void => undefined };
  const confirm = terminalConfirm(input as never, (line) => say.push(line));
  await confirm({ auditId: 'auditoria-teste-0001', seq: 1, entries: 2, simulated: true });
  assert.ok(say.some((line) => /SIMULADA — ensaio/.test(line) && /nunca/.test(line)));
  say.length = 0;
  await confirm({ auditId: 'auditoria-teste-0001', seq: 1, entries: 2, simulated: false });
  assert.ok(!say.some((line) => /SIMULADA/.test(line)));
});
