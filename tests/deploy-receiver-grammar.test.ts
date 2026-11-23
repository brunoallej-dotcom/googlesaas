import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseReceiverArgs } from '../src/lib/deploy-receiver/args';
import { HOST_CONFIG_NAMES, POSTDEPLOY_CHECK_IDS, publicErrorLine, RECEIVER_EXIT_CODES } from '../src/lib/deploy-receiver/codes';
import { MAX_BUNDLE_BYTES, MAX_COMMAND_BYTES, parseReceiverCommand } from '../src/lib/deploy-receiver/grammar';
import { runDeployReceiver } from '../src/lib/deploy-receiver/receiver';
import { registerCleanup } from './helpers/link-audit-evidence-fixtures';
import { FakeStdin, publicText, runReceiver, SHA40, world, wrapperArgs } from './helpers/deploy-receiver-fakes';

/*
 * P9.3a — gramática FECHADA do `SSH_ORIGINAL_COMMAND` (spec §5.6), parâmetros fixos do wrapper e o conjunto fechado de códigos e detalhes (§5.8),
 * conferido contra o lado do workflow (`deploy/ci/receiver-call.sh`, P9.4). Puro, em processo; nada lido do stdin numa recusa da gramática.
 */
registerCleanup();

const H64 = 'f'.repeat(64);
const H64B = 'e'.repeat(64);
const FP = '0123456789ab';
const UPLOAD_OK = `upload ${SHA40} ${H64} 1048576`;
const DEPLOY_PROD = `deploy ${SHA40} ${H64} ${H64} - ${H64B} ${FP}`;
const DEPLOY_HML = `deploy ${SHA40} ${H64} ${H64} ${H64B} ${H64B} ${FP}`;
const RECEIVER_CALL = path.join(__dirname, '..', 'deploy', 'ci', 'receiver-call.sh');

test('P9-D01 gramática: upload e deploy válidos são aceitos com os campos certos', () => {
  assert.deepEqual(parseReceiverCommand(UPLOAD_OK, 'producao'), { verb: 'upload', sha40: SHA40, bundleSha256: H64, bytes: 1048576 });
  assert.deepEqual(parseReceiverCommand(DEPLOY_PROD, 'producao'), { verb: 'deploy', sha40: SHA40, bundleSha256: H64, stackSha256: H64, overlaySha256: null, trustSha256: H64B, supabaseFp12: FP });
  assert.equal(parseReceiverCommand(DEPLOY_HML, 'homologacao')?.verb, 'deploy');
  assert.equal(parseReceiverCommand(`upload ${SHA40} ${H64} ${MAX_BUNDLE_BYTES}`, 'producao')?.verb, 'upload', 'exatamente 3 GiB passa');
});

test('P9-D01 gramática: cada campo fora do padrão, overlay presente em produção ou ausente em homologação ⇒ E_COMMAND', () => {
  const refused: ReadonlyArray<readonly [string, string, 'producao' | 'homologacao']> = [
    ['vazio', '', 'producao'],
    ['verbo desconhecido', `put ${SHA40} ${H64} 10`, 'producao'],
    ['verbo em maiúsculas', `UPLOAD ${SHA40} ${H64} 10`, 'producao'],
    ['sha40 curto', `upload ${'a'.repeat(39)} ${H64} 10`, 'producao'],
    ['sha40 maiúsculo', `upload ${'A'.repeat(40)} ${H64} 10`, 'producao'],
    ['sha256 do pacote curto', `upload ${SHA40} ${'f'.repeat(63)} 10`, 'producao'],
    ['bytes zero', `upload ${SHA40} ${H64} 0`, 'producao'],
    ['bytes com zero à esquerda', `upload ${SHA40} ${H64} 010`, 'producao'],
    ['bytes acima de 3 GiB', `upload ${SHA40} ${H64} ${MAX_BUNDLE_BYTES + 1}`, 'producao'],
    ['bytes negativo', `upload ${SHA40} ${H64} -1`, 'producao'],
    ['bytes não decimal', `upload ${SHA40} ${H64} 0x10`, 'producao'],
    ['campo a mais no upload', `${UPLOAD_OK} extra`, 'producao'],
    ['campo a menos no upload', `upload ${SHA40} ${H64}`, 'producao'],
    ['dois espaços', `upload  ${SHA40} ${H64} 10`, 'producao'],
    ['espaço no fim', `${UPLOAD_OK} `, 'producao'],
    ['espaço no início', ` ${UPLOAD_OK}`, 'producao'],
    ['tab', UPLOAD_OK.replace(' ', '\t'), 'producao'],
    ['quebra de linha', `${UPLOAD_OK}\n`, 'producao'],
    ['não ASCII', UPLOAD_OK.replace('upload', 'uplóad'), 'producao'],
    ['injeção de shell', `${UPLOAD_OK};id`, 'producao'],
    ['overlay em produção', DEPLOY_HML, 'producao'],
    ['overlay ausente em homologação', DEPLOY_PROD, 'homologacao'],
    ['fp12 curto', `deploy ${SHA40} ${H64} ${H64} - ${H64B} ${FP.slice(1)}`, 'producao'],
    ['fp12 maiúsculo', `deploy ${SHA40} ${H64} ${H64} - ${H64B} ${FP.toUpperCase()}`, 'producao'],
    ['stack sha curto', `deploy ${SHA40} ${H64} ${'f'.repeat(63)} - ${H64B} ${FP}`, 'producao'],
    ['trust sha com caractere fora', `deploy ${SHA40} ${H64} ${H64} - ${'g'.repeat(64)} ${FP}`, 'producao'],
    ['deploy com campo a mais', `${DEPLOY_PROD} x`, 'producao'],
    ['deploy com campo a menos', `deploy ${SHA40} ${H64} ${H64} - ${H64B}`, 'producao'],
    ['acima de 512 bytes', `${UPLOAD_OK}${' '.repeat(MAX_COMMAND_BYTES)}`, 'producao'],
    ['caminho no lugar do hash', `upload ${SHA40} ../../etc/passwd 10`, 'producao'],
  ];
  for (const [label, command, env] of refused) assert.equal(parseReceiverCommand(command, env), null, label);
  assert.equal(parseReceiverCommand(undefined, 'producao'), null, 'ausente');
});

/** Gerador determinístico (sem Math.random): as mutações são reproduzíveis. */
function* mutations(seed: string): Generator<string> {
  const alphabet = ['', ' ', '  ', '-', '0', 'f', 'F', 'g', '\t', '\n', '\u0000', ';', '$(id)', '`id`', '/', '..', 'é', '‮'];
  let state = 2166136261;
  const next = (): number => {
    state = Math.imul(state ^ 0x9e3779b9, 16777619) >>> 0;
    return state;
  };
  for (let round = 0; round < 3000; round += 1) {
    const position = next() % (seed.length + 1);
    const remove = next() % 3;
    const insert = alphabet[next() % alphabet.length] as string;
    yield seed.slice(0, position) + insert + seed.slice(Math.min(seed.length, position + remove));
  }
}

test('P9-D01 gramática (mutações determinísticas): toda mutação de um comando válido ou é rejeitada ou é ela mesma um comando válido da gramática', () => {
  const strict = [/^upload [0-9a-f]{40} [0-9a-f]{64} [1-9][0-9]{0,9}$/, /^deploy [0-9a-f]{40} [0-9a-f]{64} [0-9a-f]{64} - [0-9a-f]{64} [0-9a-f]{12}$/];
  let rejected = 0;
  for (const seed of [UPLOAD_OK, DEPLOY_PROD]) {
    for (const mutated of mutations(seed)) {
      const parsed = parseReceiverCommand(mutated, 'producao');
      if (parsed === null) rejected += 1;
      else assert.ok(strict.some((pattern) => pattern.test(mutated)), `aceito fora da gramática: ${JSON.stringify(mutated)}`);
    }
  }
  assert.ok(rejected > 4000, `a maioria das mutações recusa (${rejected})`);
});

test('P9-D01 em processo: comando fora da gramática ⇒ ERRO E_COMMAND (saída 10), nada lido do stdin, nenhum programa chamado, nenhuma trava criada', async () => {
  for (const command of [undefined, '', 'ls -la', `upload ${SHA40} ${H64} 0`, 'deploy', 'qualquer-coisa', `${DEPLOY_PROD}\nrm -rf /`]) {
    const w = world();
    const stdin = FakeStdin.of(Buffer.from('nao deve ser lido'));
    const run = await runReceiver(w, command, stdin);
    assert.deepEqual(run.outcome, { exitCode: 10, stdout: null, stderr: 'ERRO E_COMMAND' }, String(command));
    assert.equal(stdin.reads, 0, 'stdin intocado');
    assert.equal(run.runner.calls.length, 0);
    assert.ok(!fs.existsSync(path.join(w.stateDir, 'deploy.lock')));
  }
});

test('parâmetros do wrapper: completos por ambiente são aceitos; flag desconhecida, repetida, ausente, sem valor, caminho relativo ou não normalizado, flag de homologação em produção (e o contrário), prefixo sem barra final ou impressão fora do formato ⇒ null (E_INTERNAL)', () => {
  const prod = world();
  const hml = world({ env: 'homologacao' });
  const prodArgs = wrapperArgs(prod);
  const hmlArgs = wrapperArgs(hml);
  assert.equal(parseReceiverArgs(prodArgs)?.overlayFile, null);
  assert.equal(parseReceiverArgs(hmlArgs)?.dataPrefix, hml.dataPrefix);
  const replace = (args: readonly string[], flag: string, value: string): string[] => args.map((arg, index) => (args[index - 1] === flag ? value : arg));
  const refused: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['flag desconhecida', [...prodArgs, '--prune', 'x']],
    ['flag repetida', [...prodArgs, '--env', 'producao']],
    ['sem --log', prodArgs.slice(0, -2)],
    ['flag sem valor', [...prodArgs.slice(0, -1)]],
    ['valor que parece flag', replace(prodArgs, '--log', '--state')],
    ['ambiente desconhecido', replace(prodArgs, '--env', 'staging')],
    ['caminho relativo', replace(prodArgs, '--stack', 'stack.yml')],
    ['caminho não normalizado', replace(prodArgs, '--stack', '/opt/gmn/../gmn/stack.yml')],
    ['barra no fim', replace(prodArgs, '--state', `${prod.stateDir}/`)],
    ['nome de stack inválido', replace(prodArgs, '--stack-name', 'gmn;id')],
    ['overlay em produção', [...prodArgs, '--overlay', '/opt/gmn/stack-hml.yml']],
    ['forbid-supabase em produção', [...prodArgs, '--forbid-supabase', '0123456789ab']],
    ['homologação sem overlay', hmlArgs.filter((_, index) => hmlArgs[index] !== '--overlay' && hmlArgs[index - 1] !== '--overlay')],
    ['homologação sem data-prefix', hmlArgs.filter((_, index) => hmlArgs[index] !== '--data-prefix' && hmlArgs[index - 1] !== '--data-prefix')],
    ['homologação sem forbid-supabase', hmlArgs.filter((_, index) => hmlArgs[index] !== '--forbid-supabase' && hmlArgs[index - 1] !== '--forbid-supabase')],
    ['prefixo sem barra final', replace(hmlArgs, '--data-prefix', (hml.dataPrefix as string).slice(0, -1))],
    ['prefixo raiz', replace(hmlArgs, '--data-prefix', '/')],
    ['impressão placeholder', replace(hmlArgs, '--forbid-supabase', '<IMPRESSAO_SUPABASE_PRODUCAO>')],
    ['posicional', ['extra', ...prodArgs]],
  ];
  for (const [label, args] of refused) assert.equal(parseReceiverArgs(args), null, label);
});

test('parâmetros do wrapper em processo: parâmetro inválido, ambiente além de PATH e SSH_ORIGINAL_COMMAND (sem env -i), PATH relativo ou log que não abre ⇒ ERRO E_INTERNAL (saída 29), nada lido', async () => {
  const w = world();
  const stdin = FakeStdin.of(w.trust);
  const bad = await runReceiver(w, `upload ${SHA40} ${H64} 10`, stdin, ['--env', 'producao']);
  assert.deepEqual(bad.outcome, { exitCode: 29, stdout: null, stderr: 'ERRO E_INTERNAL' });
  assert.equal(stdin.reads, 0);
  const neverBuilt = (): never => assert.fail('as portas não podem ser montadas');
  for (const env of [
    { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: `upload ${SHA40} ${H64} 10`, NODE_OPTIONS: '--require /tmp/x.js' },
    { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: `upload ${SHA40} ${H64} 10`, HOME: '/home/gmn-deploy' },
    { SSH_ORIGINAL_COMMAND: `upload ${SHA40} ${H64} 10` },
    { PATH: 'bin:/usr/bin', SSH_ORIGINAL_COMMAND: `upload ${SHA40} ${H64} 10` },
  ]) {
    assert.deepEqual(await runDeployReceiver({ argv: wrapperArgs(w), env }, neverBuilt), { exitCode: 29, stdout: null, stderr: 'ERRO E_INTERNAL' }, Object.keys(env).join(','));
  }
  const throwing = (): never => {
    throw new Error('log inacessível');
  };
  assert.deepEqual(await runDeployReceiver({ argv: wrapperArgs(w), env: { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: `upload ${SHA40} ${H64} 10` } }, throwing), { exitCode: 29, stdout: null, stderr: 'ERRO E_INTERNAL' }, 'log que não abre');
});

test('§5.8: saídas numéricas e conjunto fechado de detalhes iguais aos do job (deploy/ci/receiver-call.sh, P9.4); detalhe fora da lista nunca sai', () => {
  const script = fs.readFileSync(RECEIVER_CALL, 'utf8');
  const exitBlock = /declare -rA RECEIVER_EXIT_CODES=\(([\s\S]*?)\n\)/.exec(script)?.[1] ?? '';
  const fromScript = Object.fromEntries([...exitBlock.matchAll(/\[(E_[A-Z_]+)\]=(\d+)/g)].map((match) => [match[1], Number(match[2])]));
  assert.deepEqual(fromScript, { ...RECEIVER_EXIT_CODES }, 'mesmos códigos e mesmas saídas numéricas');
  const namesBlock = /readonly HOST_CONFIG_NAMES="([\s\S]*?)"/.exec(script)?.[1] ?? '';
  const namesFromScript = namesBlock.replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
  assert.deepEqual([...namesFromScript].sort(), [...HOST_CONFIG_NAMES].sort(), 'mesma lista fechada de nomes do E_HOST_CONFIG');
  assert.match(script, /\^PD-0\[1-8\]\$/, 'o job aceita PD-01..PD-08');
  assert.deepEqual([...POSTDEPLOY_CHECK_IDS], ['PD-01', 'PD-02', 'PD-03', 'PD-04', 'PD-05', 'PD-06', 'PD-07', 'PD-08']);
  const publicLine = /^ERRO E_[A-Z0-9_]+( [A-Za-z0-9_-]{1,64})?$/;
  assert.equal(publicErrorLine('E_HOST_CONFIG', 'GMN_HOST'), 'ERRO E_HOST_CONFIG GMN_HOST');
  assert.equal(publicErrorLine('E_POSTDEPLOY_CHECK', 'PD-07'), 'ERRO E_POSTDEPLOY_CHECK PD-07');
  assert.equal(publicErrorLine('E_HOST_CONFIG', 'PD-01'), 'ERRO E_HOST_CONFIG', 'detalhe de outro código não sai');
  assert.equal(publicErrorLine('E_STACK_DEPLOY', 'GMN_HOST'), 'ERRO E_STACK_DEPLOY', 'código sem detalhe');
  for (const code of Object.keys(RECEIVER_EXIT_CODES) as Array<keyof typeof RECEIVER_EXIT_CODES>) assert.match(publicErrorLine(code, null), publicLine);
});

test('E_LOCKED (defesa do lado do Node; a trava de verdade é o flock do wrapper): trava existente, de processo vivo OU morto, ⇒ ERRO E_LOCKED (16), nada lido e a trava alheia nunca é apagada; sem trava, a execução segue e libera só a própria', async () => {
  const w = world();
  const lock = path.join(w.stateDir, 'deploy.lock');
  const deadPid = 2 ** 22 + 12345; // acima do pid_max padrão: nunca é um processo vivo
  for (const owner of [`${process.pid}\n`, `${deadPid}\n`, 'ilegível']) {
    fs.writeFileSync(lock, owner);
    const stdin = FakeStdin.of(w.trust);
    const locked = await runReceiver(w, `upload ${SHA40} ${H64} 10`, stdin);
    assert.deepEqual(locked.outcome, { exitCode: 16, stdout: null, stderr: 'ERRO E_LOCKED' }, owner);
    assert.equal(stdin.reads, 0);
    assert.equal(fs.readFileSync(lock, 'utf8'), owner, 'sem retomada por nome: a trava alheia fica');
  }
  fs.rmSync(lock);
  const bytes = Buffer.from('dez bytes!');
  const free = await runReceiver(w, `upload ${SHA40} ${'0'.repeat(64)} ${bytes.length}`, FakeStdin.of(bytes));
  assert.equal(free.outcome.stderr, 'ERRO E_HASH_MISMATCH', 'passou da trava (e recusou adiante, pelo hash)');
  assert.ok(!fs.existsSync(lock), 'a trava própria é liberada no fim');
  assert.match(publicText(free.outcome), /^ERRO E_[A-Z_]+$/);
});
