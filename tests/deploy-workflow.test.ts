import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isYamlMap, parseYamlSubset, YamlSubsetError, type YamlMap, type YamlValue } from './helpers/yaml-subset';

/*
 * P9.4 e P9.5: teste ESTÁTICO do workflow de deploy pelo CI (.github/workflows/deploy.yml; spec docs/specs/ci-deploy-and-seal-delivery.md
 * §5.5, §5.5.1 e §5.5.2; critérios P9-W01 a P9-W09 e P9-W11), dos scripts que ele chama (deploy/ci/) e do runbook do responsável. Nada aqui
 * dispara workflow, abre rede ou lê segredo. A estrutura vem do leitor de YAML restrito dos testes (tests/helpers/yaml-subset.ts), que recusa
 * o que não cobre. A execução dos scripts com comandos falsos fica em tests/deploy-ci-scripts.test.ts e tests/deploy-seals-delivery.test.ts.
 */
const ROOT = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const workflowText = read('.github/workflows/deploy.yml');
const ciText = read('.github/workflows/ci.yml');
const CI_SCRIPTS = fs.readdirSync(path.join(ROOT, 'deploy', 'ci')).filter((name) => name.endsWith('.sh')).sort();
const scriptText = (name: string): string => read(`deploy/ci/${name}`);
/** Todo o código dos jobs do deploy.yml: o workflow e os scripts de deploy/ci/. */
const jobCode = (): Array<[string, string]> => [['deploy.yml', workflowText], ...CI_SCRIPTS.map((name): [string, string] => [name, scriptText(name)])];
const withoutComments = (text: string): string => text.replace(/^\s*#.*$/gm, '');

const mapAt = (value: YamlValue | undefined, label: string): YamlMap => {
  assert.ok(isYamlMap(value), `${label}: mapa`);
  return value;
};
const listAt = (value: YamlValue | undefined, label: string): YamlValue[] => {
  assert.ok(Array.isArray(value), `${label}: lista`);
  return value;
};
const workflow = mapAt(parseYamlSubset(workflowText), 'deploy.yml');
const jobs = mapAt(workflow.jobs, 'jobs');
const deployJob = mapAt(jobs.deploy, 'jobs.deploy');
const verifyJob = mapAt(jobs['seals-verify'], 'jobs.seals-verify');
const deliverJob = mapAt(jobs['seals-deliver'], 'jobs.seals-deliver');
const stepsOfJob = (job: YamlMap, label: string): YamlMap[] => listAt(job.steps, `${label}.steps`).map((step, i) => mapAt(step, `${label}.steps[${i}]`));
const steps = stepsOfJob(deployJob, 'deploy');
const verifySteps = stepsOfJob(verifyJob, 'seals-verify');
const deliverSteps = stepsOfJob(deliverJob, 'seals-deliver');
const deliverStep = (id: string): YamlMap => {
  const step = deliverSteps.find((item) => item.id === id);
  assert.ok(step, `seals-deliver: passo ${id} ausente`);
  return step;
};
const stepIndex = (id: string): number => {
  const index = steps.findIndex((step) => step.id === id);
  assert.ok(index >= 0, `passo ${id} ausente`);
  return index;
};
const stepById = (id: string): YamlMap => steps[stepIndex(id)] as YamlMap;
const runOf = (step: YamlMap): string => (typeof step.run === 'string' ? step.run : '');
const allSteps = (): YamlMap[] =>
  Object.entries(jobs).flatMap(([name, job]) => (Array.isArray(mapAt(job, name).steps) ? listAt(mapAt(job, name).steps, name).map((step) => mapAt(step, name)) : []));
/** As actions do ci.yml (o conjunto permitido, SHA a SHA). */
const ciActions = new Set([...ciText.matchAll(/uses: (\S+@[0-9a-f]{40})\b/g)].map((m) => m[1] ?? ''));

/** Segredos por job e por passo (spec §5.5): só de ambiente, só no `env:` do passo que os usa, e nada além disto. */
const SECRETS_BY_STEP: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  deploy: {
    build: { NEXT_PUBLIC_SUPABASE_URL: 'GMN_BUILD_SUPABASE_URL', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'GMN_BUILD_SUPABASE_ANON_KEY' },
    ssh: { GMN_DEPLOY_SSH_KEY: 'GMN_DEPLOY_SSH_KEY', GMN_SSH_KNOWN_HOSTS: 'GMN_SSH_KNOWN_HOSTS', GMN_SSH_HOST: 'GMN_SSH_HOST', GMN_SSH_PORT: 'GMN_SSH_PORT' },
    deploy: { GMN_BUILD_SUPABASE_URL: 'GMN_BUILD_SUPABASE_URL' },
    external: { GMN_PUBLIC_HOST: 'GMN_PUBLIC_HOST' },
  },
  // §5.5: o seals-verify não tem segredo nenhum; o seals-deliver, só a chave de manifestos e os de conexão
  'seals-verify': {},
  'seals-deliver': {
    ssh: { GMN_SEALS_SSH_KEY: 'GMN_SEALS_SSH_KEY', GMN_SSH_KNOWN_HOSTS: 'GMN_SSH_KNOWN_HOSTS', GMN_SSH_HOST: 'GMN_SSH_HOST', GMN_SSH_PORT: 'GMN_SSH_PORT' },
  },
};
/** Os scripts que cada job chama (P9-W09: os do seals-deliver não podem rodar npm, node nem npx). */
const scriptsOf = (jobSteps: readonly YamlMap[]): string[] =>
  [...new Set(jobSteps.map(runOf).flatMap((run) => [...run.matchAll(/^bash deploy\/ci\/([a-z-]+\.sh)(?: [a-z]+)?$/gm)].map((m) => m[1] ?? '')))].sort();
/** Opções fixas do ssh (spec §5.5.1 passo 7), escritas na configuração privada do `ssh-setup.sh` (o `ssh -F` ignora qualquer outra). */
const SSH_CONFIG_OPTIONS = [
  'IdentitiesOnly yes',
  'BatchMode yes',
  'StrictHostKeyChecking yes',
  'UserKnownHostsFile "${GMN_CI_SSH_DIR}/known_hosts"',
  'GlobalKnownHostsFile /dev/null',
  'LogLevel ERROR',
  'ConnectTimeout 20',
  'ServerAliveInterval 15',
  'RequestTTY no',
];

test('yaml-subset: o leitor dos testes recusa o que não cobre (âncora, alias, tag, chave repetida, tabulação, bloco dobrado, vários documentos)', () => {
  for (const bad of ['a: &x 1\nb: *x\n', 'a: !tag 1\n', 'a: 1\na: 2\n', 'a:\n\tb: 1\n', 'a: >\n  x\n', '---\na: 1\n', 'a: b: c\n', 'a: [x, [y]]\n']) {
    assert.throws(() => parseYamlSubset(bad), YamlSubsetError, JSON.stringify(bad));
  }
  assert.deepEqual(parseYamlSubset('a:\n  - b: 1\n    c: "x # y"\n  - [p, \'q\']\nd: |\n  l1\n  # l2\ne: { f: false }\n'), {
    a: [{ b: 1, c: 'x # y' }, ['p', 'q']],
    d: 'l1\n# l2\n',
    e: { f: false },
  });
});

test('P9-W01 gatilhos e permissões: exatamente os do §5.5 (dispatch com ambiente e ação; push na main só no caminho dos manifestos); topo contents: read; todo job declara permissões, deploy = contents + actions de leitura, seals-verify e seals-deliver = contents de leitura; nenhum write', () => {
  const on = mapAt(workflow.on, 'on');
  assert.deepEqual(Object.keys(on), ['workflow_dispatch', 'push']);
  assert.deepEqual(on.push, { branches: ['main'], paths: ['link-audit-seals/*/seals/**'] }, 'push só na main e só no caminho dos manifestos (nunca trust-keys.txt)');
  assert.deepEqual(Object.keys(jobs), ['deploy', 'seals-verify', 'seals-deliver'], 'os três jobs do §5.5');
  const inputs = mapAt(mapAt(on.workflow_dispatch, 'workflow_dispatch').inputs, 'inputs');
  assert.deepEqual(Object.keys(inputs), ['ambiente', 'acao']);
  const { description: _ambiente, ...ambiente } = mapAt(inputs.ambiente, 'ambiente');
  assert.deepEqual(ambiente, { type: 'choice', required: true, options: ['homologacao', 'producao'] });
  const { description: _acao, ...acao } = mapAt(inputs.acao, 'acao');
  assert.deepEqual(acao, { type: 'choice', required: true, default: 'deploy', options: ['deploy', 'entregar-selos'] });
  assert.deepEqual(workflow.permissions, { contents: 'read' }, 'o topo fica só como padrão');
  const expectedPermissions: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    deploy: { contents: 'read', actions: 'read' },
    'seals-verify': { contents: 'read' },
    'seals-deliver': { contents: 'read' },
  };
  for (const [name, job] of Object.entries(jobs)) {
    const permissions = mapAt(mapAt(job, name).permissions, `${name}.permissions`);
    assert.deepEqual(permissions, expectedPermissions[name], `${name}: permissões efetivas exatamente ${JSON.stringify(expectedPermissions[name])}`);
  }
  assert.ok(!/:\s*write\b|write-all|read-all/.test(withoutComments(workflowText)), 'nenhuma permissão de escrita');
  for (const forbidden of [/pull_request_target/, /^\s*workflow_run:/m, /^\s*schedule:/m, /repository_dispatch/, /id-token/]) assert.ok(!forbidden.test(withoutComments(workflowText)), `${forbidden}`);
});

test('P9-W02 deploy só por dispatch na main, com acao = deploy, no ambiente da entrada; nenhum segredo de repositório lido fora de um passo', () => {
  const condition = String(deployJob.if);
  for (const part of ["github.event_name == 'workflow_dispatch'", "inputs.acao == 'deploy'", "github.ref == 'refs/heads/main'"]) assert.ok(condition.includes(part), part);
  assert.ok(!/\|\|/.test(condition), 'condição só com &&');
  assert.equal(deployJob.environment, '${{ inputs.ambiente }}');
  assert.equal(deployJob['runs-on'], 'ubuntu-latest');
  assert.equal(deployJob['timeout-minutes'], 60, 'spec §5.5: 60 min no deploy');
  assert.deepEqual(deployJob.env, { GMN_AMB: '${{ inputs.ambiente }}', GMN_SHA: '${{ github.sha }}' }, 'o env do job não leva segredo');
  assert.equal(workflow.env, undefined, 'sem env no topo');
});

test('P9-W02 (P9.5) seals-verify sem ambiente nem segredo, só na main, no push ou no dispatch com acao = entregar-selos; seals-deliver na main, depois do seals-verify verde, no ambiente da matriz, e a matriz só com os nomes do conjunto fechado', () => {
  assert.equal(verifyJob.if, "github.ref == 'refs/heads/main' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.acao == 'entregar-selos'))");
  assert.equal(verifyJob.environment, undefined, 'seals-verify sem ambiente (sem segredo)');
  assert.equal(verifyJob['timeout-minutes'], 15);
  assert.deepEqual(verifyJob.outputs, { ambientes: '${{ steps.verify.outputs.ambientes }}' });
  assert.equal(deliverJob.needs, 'seals-verify');
  assert.equal(deliverJob.environment, '${{ matrix.ambiente }}');
  assert.equal(deliverJob['timeout-minutes'], 20, 'spec §5.5: 20 min no seals-deliver');
  assert.equal(deliverJob['runs-on'], 'ubuntu-latest');
  assert.deepEqual(deliverJob.strategy, { 'fail-fast': false, matrix: { ambiente: '${{ fromJSON(needs.seals-verify.outputs.ambientes) }}' } });
  const allowed = ['["homologacao"]', '["producao"]', '["homologacao","producao"]'];
  assert.equal(
    deliverJob.if,
    `github.ref == 'refs/heads/main' && needs.seals-verify.result == 'success' && (${allowed.map((value) => `needs.seals-verify.outputs.ambientes == '${value}'`).join(' || ')})`,
    'o consumidor só aceita a matriz do conjunto fechado (nunca [] nem outro nome: um ambiente desconhecido seria criado sem proteção)',
  );
  assert.deepEqual(deliverJob.env, { GMN_AMB: '${{ matrix.ambiente }}', GMN_SHA: '${{ github.sha }}' }, 'o env do job não leva segredo');
  assert.ok(!JSON.stringify(verifyJob).includes('secrets.'), 'seals-verify sem segredo');
});

test('P9-W03 toda action fixada por SHA de 40 hex e só entre as do ci.yml; checkout do SHA exato sem credencial persistida', () => {
  const uses = allSteps().filter((step) => step.uses !== undefined).map((step) => String(step.uses));
  assert.ok(uses.length > 0);
  for (const action of uses) {
    assert.match(action, /^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/, `${action} fixada por SHA`);
    assert.ok(ciActions.has(action), `${action} é uma das actions do ci.yml`);
  }
  assert.equal([...workflowText.matchAll(/^\s*(?:-\s+)?uses:/gm)].length, uses.length, 'toda uses: foi lida pela estrutura');
  const checkout = stepById('checkout');
  assert.match(String(checkout.uses), /^actions\/checkout@/);
  assert.deepEqual(checkout.with, { ref: '${{ github.sha }}', 'persist-credentials': false });
  const verifyCheckout = verifySteps.find((step) => step.id === 'checkout');
  assert.match(String(verifyCheckout?.uses), /^actions\/checkout@/);
  assert.deepEqual(verifyCheckout?.with, { ref: '${{ github.sha }}', 'fetch-depth': 0, 'persist-credentials': false }, 'seals-verify: histórico completo (base = before no push)');
  assert.match(String(deliverStep('checkout').uses), /^actions\/checkout@/);
  assert.deepEqual(deliverStep('checkout').with, { ref: '${{ github.sha }}', 'persist-credentials': false });
  assert.equal(allSteps().filter((step) => String(step.uses ?? '').startsWith('actions/checkout@')).length, 3, 'um checkout por job');
});

test('P9-W04 nenhum artefato, registry, login ou cache do GitHub no workflow nem nos scripts do job; o pacote só em $RUNNER_TEMP', () => {
  for (const [name, text] of jobCode()) {
    const code = withoutComments(text);
    for (const forbidden of [/upload-artifact/, /download-artifact/, /docker push/, /docker login/, /actions\/cache/, /type=gha/, /--cache-(?:to|from)/, /docker tag\b/, /\bscp\b/]) {
      assert.ok(!forbidden.test(code), `${name}: ${forbidden}`);
    }
  }
  for (const step of allSteps()) {
    if (String(step.uses ?? '').startsWith('actions/setup-node@')) assert.ok(!isYamlMap(step.with) || step.with.cache === undefined, 'setup-node sem cache:');
  }
  assert.match(scriptText('lib.sh'), /readonly GMN_CI_BUNDLE_DIR="\$\{RUNNER_TEMP\}\/gmn-bundle"/);
  assert.match(scriptText('bundle.sh'), /docker save "gmn-web:\$\{tag\}" "gmn-worker:\$\{tag\}" 2>"\$\{GMN_CI_BUILD_DIR\}\/save\.log" \| gzip -n >"\$GMN_CI_BUNDLE_FILE"/);
});

test('P9-W05 nenhuma expressão ${{ }} dentro de run:, sem rastreamento do shell nem ssh verboso; segredos só no env: do passo que os usa (lista fechada por passo)', () => {
  for (const step of allSteps()) assert.ok(!runOf(step).includes('${{'), `${String(step.name)}: expressão dentro de run:`);
  for (const [name, text] of jobCode()) {
    const code = withoutComments(text);
    for (const forbidden of [/set -[a-wyz]*x/, /set -o xtrace/, /bash -[a-z]*x/, /ssh -v/, /\s-vvv?\b/, /StrictHostKeyChecking=no/, /accept-new/, /::add-mask::/]) {
      assert.ok(!forbidden.test(code), `${name}: ${forbidden}`);
    }
  }
  let declared = 0;
  for (const [jobName, jobSteps] of [['deploy', steps], ['seals-verify', verifySteps], ['seals-deliver', deliverSteps]] as const) {
    for (const step of jobSteps) {
      const env = isYamlMap(step.env) ? step.env : {};
      const secrets = Object.fromEntries(Object.entries(env).filter(([, value]) => String(value).includes('secrets.')).map(([key, value]) => [key, String(value)]));
      const expected = SECRETS_BY_STEP[jobName]?.[String(step.id)] ?? {};
      assert.deepEqual(secrets, Object.fromEntries(Object.entries(expected).map(([key, secret]) => [key, `\${{ secrets.${secret} }}`])), `${jobName}.${String(step.id)}: segredos do passo`);
      declared += Object.keys(secrets).length;
      for (const field of ['run', 'with', 'if', 'name']) assert.ok(!JSON.stringify(step[field] ?? '').includes('secrets.'), `${jobName}.${String(step.id)}: segredo em ${field}`);
    }
  }
  assert.equal(workflowText.split('${{ secrets.').length - 1, declared, 'nenhum segredo fora do env: de um passo');
  assert.ok(!workflowText.includes('secrets.GITHUB_TOKEN'), 'o token do job entra como github.token, só onde é usado');
  const inputUses = [...withoutComments(workflowText).matchAll(/\$\{\{ inputs\.[a-z]+ \}\}/g)].length;
  assert.equal(inputUses, 5, 'inputs só no nome, ambiente, grupo de concorrência e env do job deploy e no env do passo do seals-verify (e nas condições sem ${{ }})');
  assert.deepEqual(verifySteps.find((step) => step.id === 'verify')?.env, {
    GMN_SHA: '${{ github.sha }}',
    GMN_EVENT: '${{ github.event_name }}',
    GMN_BEFORE: '${{ github.event.before }}',
    GMN_DISPATCH_AMB: '${{ inputs.ambiente }}',
  }, 'seals-verify: as entradas do evento só pelo ambiente do passo');
  assert.deepEqual(deliverStep('deliver').env, { GMN_TRUST_SHA256: '${{ steps.files.outputs.trust_sha256 }}' });
});

test('P9-W06 concorrência por operação e ambiente (gmn-<amb>-deploy no deploy, gmn-<amb>-seals no seals-deliver), sem cancelar o que está em andamento; nenhum grupo comum nem no topo', () => {
  assert.deepEqual(deployJob.concurrency, { group: 'gmn-${{ inputs.ambiente }}-deploy', 'cancel-in-progress': false });
  assert.deepEqual(deliverJob.concurrency, { group: 'gmn-${{ matrix.ambiente }}-seals', 'cancel-in-progress': false });
  assert.equal(verifyJob.concurrency, undefined, 'seals-verify sem segredo nem efeito: sem fila');
  assert.equal(workflow.concurrency, undefined, 'um grupo no topo juntaria deploy e entrega');
  assert.ok(!/cancel-in-progress: true/.test(workflowText));
  const groups = Object.entries(jobs).map(([name, job]) => mapAt(job, name).concurrency).filter(isYamlMap).map((item) => String(item.group));
  assert.equal(new Set(groups).size, groups.length, 'nenhum grupo comum às duas operações');
});

test('P9-W07 todo ssh pela configuração privada com as opções fixas (StrictHostKeyChecking yes, UserKnownHostsFile explícito, GlobalKnownHostsFile /dev/null); host e porta fora da linha de comando; nenhum ssh fora do script do receptor', () => {
  const setup = scriptText('ssh-setup.sh');
  const config = /cat >"\$GMN_CI_SSH_CONFIG" <<EOF\n([\s\S]*?)\nEOF/.exec(setup)?.[1];
  assert.ok(config, 'a configuração privada é escrita pelo ssh-setup.sh');
  const lines = config.split('\n').map((line) => line.trim());
  assert.deepEqual(lines.slice(0, 4), ['Host ${GMN_CI_SSH_ALIAS}', 'HostName ${GMN_SSH_HOST}', 'Port ${ssh_port}', 'User ${ssh_user}']);
  for (const option of SSH_CONFIG_OPTIONS) assert.ok(lines.includes(option), `opção fixa ${option}`);
  // P9.5: um apelido, uma chave e um usuário por papel (deploy / seals), só literais fixos em lib.sh
  const lib = scriptText('lib.sh');
  assert.match(lib, /deploy\)\n\s+GMN_CI_SSH_KEY_VAR=GMN_DEPLOY_SSH_KEY\n\s+GMN_CI_SSH_KEY_NAME=id_deploy\n\s+GMN_CI_SSH_ALIAS=gmn-receiver\n\s+case "\$\{GMN_AMB:-\}" in producao\) GMN_CI_SSH_USER=gmn-deploy ;; homologacao\) GMN_CI_SSH_USER=gmn-hml-deploy ;;/);
  assert.match(lib, /seals\)\n\s+GMN_CI_SSH_KEY_VAR=GMN_SEALS_SSH_KEY\n\s+GMN_CI_SSH_KEY_NAME=id_seals\n\s+GMN_CI_SSH_ALIAS=gmn-seal-receiver\n\s+case "\$\{GMN_AMB:-\}" in producao\) GMN_CI_SSH_USER=gmn-seals ;; homologacao\) GMN_CI_SSH_USER=gmn-hml-seals ;;/);
  // a ÚNICA chamada ssh dos jobs fica em lib.sh (gmn_receiver_ssh), só pela configuração privada
  const invocations = CI_SCRIPTS.flatMap((name) => [...withoutComments(scriptText(name)).matchAll(/(?:^|[\s(])ssh (.+?)$/gm)].map((m) => `${name}: ${m[1] ?? ''}`));
  assert.deepEqual(invocations, ['lib.sh: -F "$GMN_CI_SSH_CONFIG" -T "$GMN_CI_SSH_ALIAS" "$1" <"$2" 2>"$GMN_SSH_STDERR")"'], 'uma chamada, só pela configuração privada');
  for (const name of ['receiver-call.sh', 'seals-deliver.sh']) {
    assert.ok(!/GMN_SSH_HOST|GMN_SSH_PORT/.test(withoutComments(scriptText(name))), `${name}: o script do receptor não vê host nem porta`);
    assert.ok(scriptText(name).includes('gmn_receiver_ssh "$remote_command"'), `${name}: chama o receptor só pela chamada única`);
  }
  assert.ok(!/(?:^|[\s(;|&])(?:ssh|scp|sftp)\s/m.test(withoutComments(allSteps().map(runOf).join('\n'))), 'deploy.yml (run:): nenhum ssh');
  assert.match(scriptText('lib.sh'), /readonly GMN_CI_SSH_DIR="\$\{RUNNER_TEMP:\?RUNNER_TEMP ausente\}\/gmn-ssh"/);
});

test('P9-W08 a chave só é escrita depois do build e do pacote, e a limpeza com if: always() apaga a chave, o pacote e a saída do Docker', () => {
  const ssh = stepIndex('ssh');
  assert.ok(ssh > stepIndex('build') && ssh > stepIndex('bundle'), 'chave depois do build');
  assert.equal(runOf(stepById('ssh')), 'bash deploy/ci/ssh-setup.sh deploy');
  const keySteps = steps.filter((step) => JSON.stringify(step.env ?? {}).includes('GMN_DEPLOY_SSH_KEY')).map((step) => step.id);
  assert.deepEqual(keySteps, ['ssh'], 'a chave privada só entra no passo que a escreve');
  const cleanup = steps.findIndex((step) => step.name === 'Limpeza da chave, do pacote e da saída do Docker');
  assert.ok(cleanup > stepIndex('external'), 'limpeza depois do último passo que usa a chave');
  assert.equal(steps[cleanup]?.if, 'always()');
  assert.equal(runOf(steps[cleanup] as YamlMap), 'rm -rf -- "$RUNNER_TEMP/gmn-ssh" "$RUNNER_TEMP/gmn-bundle" "$RUNNER_TEMP/gmn-build"');
  assert.match(scriptText('lib.sh'), /readonly GMN_CI_BUILD_DIR="\$\{RUNNER_TEMP\}\/gmn-build"/);
  for (const [name, condition] of [['Resumo do job', "always() && steps.checkout.outcome == 'success'"], ['Resumo do job (recusado antes do checkout)', "always() && steps.checkout.outcome != 'success'"]]) {
    assert.equal(steps.find((step) => step.name === name)?.if, condition, `${name} sempre roda`);
  }
});

test('P9-W08 (P9.5) seals-deliver: a chave de manifestos só entra no passo que a escreve (ssh-setup.sh seals), depois do cálculo da lista; limpeza da chave com if: always() logo depois da entrega; resumo e limpeza da lista sempre', () => {
  const ids = deliverSteps.map((step) => step.id ?? step.name);
  assert.deepEqual(ids, ['checkout', 'files', 'ssh', 'head', 'deliver', 'Limpeza da chave', 'Resumo da entrega (RC-08)', 'Resumo da entrega (checkout falhou)', 'Limpeza da lista de arquivos']);
  assert.equal(runOf(deliverStep('ssh')), 'bash deploy/ci/ssh-setup.sh seals');
  const keySteps = deliverSteps.filter((step) => JSON.stringify(step.env ?? {}).includes('GMN_SEALS_SSH_KEY')).map((step) => step.id);
  assert.deepEqual(keySteps, ['ssh'], 'a chave privada só entra no passo que a escreve');
  assert.ok(!JSON.stringify(deliverSteps).includes('GMN_DEPLOY_SSH_KEY'), 'a chave de deploy nunca no seals-deliver');
  assert.ok(!JSON.stringify(steps).includes('GMN_SEALS_SSH_KEY'), 'a chave de manifestos nunca no deploy');
  const byName = (name: string): YamlMap | undefined => deliverSteps.find((step) => step.name === name);
  assert.equal(byName('Limpeza da chave')?.if, 'always()');
  assert.equal(runOf(byName('Limpeza da chave') as YamlMap), 'rm -rf -- "$RUNNER_TEMP/gmn-ssh"');
  assert.equal(byName('Resumo da entrega (RC-08)')?.if, "always() && steps.checkout.outcome == 'success'");
  assert.equal(runOf(byName('Resumo da entrega (RC-08)') as YamlMap), 'bash deploy/ci/seals-summary.sh');
  assert.equal(byName('Resumo da entrega (checkout falhou)')?.if, "always() && steps.checkout.outcome != 'success'");
  assert.equal(byName('Limpeza da lista de arquivos')?.if, 'always()');
  assert.equal(runOf(byName('Limpeza da lista de arquivos') as YamlMap), 'rm -rf -- "$RUNNER_TEMP/gmn-seals"');
  assert.match(scriptText('lib.sh'), /readonly GMN_CI_SEALS_DIR="\$\{RUNNER_TEMP\}\/gmn-seals"/);
});

test('P9-W09 seals-deliver não roda npm, node nem npx: nem no workflow (sem setup-node), nem nos scripts que chama; só git, sha256sum e ssh', () => {
  const called = scriptsOf(deliverSteps);
  assert.deepEqual(called, ['seals-deliver.sh', 'seals-files.sh', 'seals-summary.sh', 'ssh-setup.sh']);
  const forbidden = /(?:^|[^A-Za-z0-9_.\/-])(?:npm|npx|node|tsx|corepack|yarn|pnpm)(?=$|[^A-Za-z0-9_-])/m;
  for (const step of deliverSteps) {
    assert.ok(!String(step.uses ?? '').startsWith('actions/setup-node@'), 'nenhum setup-node no seals-deliver');
    assert.ok(!forbidden.test(withoutComments(runOf(step))), `${String(step.name)}: npm/node/npx no run:`);
  }
  for (const name of [...called, 'lib.sh']) assert.ok(!forbidden.test(withoutComments(scriptText(name))), `${name}: npm/node/npx no script do seals-deliver`);
  assert.ok(/git -c core\.quotePath=false ls-tree -r -z HEAD -- /.test(scriptText('seals-files.sh')) && /git hash-object --no-filters/.test(scriptText('seals-files.sh')), 'a lista sai do git');
  assert.ok(/sha256sum/.test(scriptText('lib.sh')), 'sha256sum de cada arquivo');
});

test('P9.5 NOT_MAIN_HEAD no seals-deliver: o commit ainda é a cabeça da main imediatamente antes do primeiro put, com o MESMO texto do deploy (spec omissa, decisão da P9.5)', () => {
  const head = deliverStep('head');
  assert.equal(runOf(head), runOf(stepById('head')), 'o mesmo código do deploy');
  assert.deepEqual(head.env, { GH_TOKEN: '${{ github.token }}' }, 'só o token do job (leitura, contents: read)');
  const ids = deliverSteps.map((step) => step.id);
  assert.equal(ids.indexOf('head'), ids.indexOf('deliver') - 1, 'imediatamente antes da entrega');
  assert.equal(deliverSteps.filter((step) => runOf(step).includes('fail NOT_MAIN_HEAD')).length, 1);
});

test('P9.5 seals-verify: sem segredo, Node 22 sem cache, npm ci do commit e o script do passo; nada de artefato nem de escrita', () => {
  assert.deepEqual(verifySteps.map((step) => step.id ?? step.name), ['checkout', 'Node 22 (sem cache)', 'install', 'verify']);
  const setup = verifySteps[1] as YamlMap;
  assert.match(String(setup.uses), /^actions\/setup-node@[0-9a-f]{40}$/);
  assert.deepEqual(setup.with, { 'node-version': '22' }, 'sem cache:');
  assert.equal(runOf(verifySteps[2] as YamlMap), 'npm ci');
  assert.equal(runOf(verifySteps[3] as YamlMap), 'bash deploy/ci/seals-verify.sh');
  assert.deepEqual(scriptsOf(verifySteps), ['seals-verify.sh']);
  const verify = scriptText('seals-verify.sh');
  assert.ok(verify.includes('bash .github/scripts/seals-prepare.sh'), 'push: o mesmo preparo do job seals do ci.yml');
  assert.ok(verify.includes('npm run --silent link-audit:seals-check -- "$@" | tee -a "$GITHUB_STEP_SUMMARY"'), 'o mesmo comando da P9.2');
  assert.ok(verify.includes('seals_check --tree "$env" --modes'), 'o modo árvore por ambiente');
  assert.match(verify, /readonly ALLOWED_MATRICES=' \[\] \["homologacao"\] \["producao"\] \["homologacao","producao"\] '/);
});

test('P9-W11 NOT_MAIN_HEAD (cabeça da main pela API, só leitura) no início, antes do checkout e do build, e de novo imediatamente antes do deploy por SSH, com o mesmo texto; CI verde conferido primeiro', () => {
  assert.equal(stepIndex('ci'), 0, 'CI verde no SHA é o primeiro passo');
  assert.equal(stepIndex('head'), 1);
  assert.ok(stepIndex('head') < stepIndex('checkout') && stepIndex('checkout') < stepIndex('build'));
  assert.ok(stepIndex('upload') < stepIndex('head2'));
  assert.equal(stepIndex('head2'), stepIndex('deploy') - 1, 'a segunda conferência é o passo imediatamente anterior ao deploy');
  assert.equal(runOf(stepById('head2')), runOf(stepById('head')), 'as duas conferências são o mesmo código');
  const head = runOf(stepById('head'));
  for (const part of ['gh api --method GET "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha', '|| fail NOT_MAIN_HEAD', '[ "$head" = "$GMN_SHA" ] || fail NOT_MAIN_HEAD']) {
    assert.ok(head.includes(part), part);
  }
  assert.ok(!/git ls-remote|GIT_CONFIG_|base64|add-mask/.test(head), 'nada montado nem mascarado: o gh autentica pelo GH_TOKEN');
  assert.equal(steps.filter((step) => runOf(step).includes('fail NOT_MAIN_HEAD')).length, 2);
  const ci = runOf(stepById('ci'));
  for (const part of ['actions/workflows/ci.yml/runs', 'head_sha="$GMN_SHA"', 'event=push', 'fail CI_PENDING', 'fail CI_NOT_GREEN']) assert.ok(ci.includes(part), part);
  for (const id of ['ci', 'head', 'head2']) assert.deepEqual(stepById(id).env, { GH_TOKEN: '${{ github.token }}' }, `${id}: só o token do job (leitura)`);
});

test('P9.4 os passos com script chamam deploy/ci/<script>.sh existente; todo script de deploy/ci/ é usado; scripts com bash estrito e sem valor por argumento (só os literais fixos de verbo e papel)', () => {
  const invoked = allSteps().map(runOf).flatMap((run) => [...run.matchAll(/^bash deploy\/ci\/([a-z-]+\.sh)(?: (?:upload|deploy|seals))?$/gm)].map((m) => m[1] ?? ''));
  assert.deepEqual([...new Set(invoked)].sort(), CI_SCRIPTS.filter((name) => name !== 'lib.sh'));
  assert.deepEqual(steps.filter((step) => runOf(step).includes('receiver-call.sh')).map((step) => runOf(step)), ['bash deploy/ci/receiver-call.sh upload', 'bash deploy/ci/receiver-call.sh deploy']);
  assert.deepEqual(allSteps().filter((step) => runOf(step).includes('ssh-setup.sh')).map((step) => runOf(step)), ['bash deploy/ci/ssh-setup.sh deploy', 'bash deploy/ci/ssh-setup.sh seals']);
  for (const step of allSteps()) assert.ok(!/^bash deploy\/ci\//m.test(runOf(step)) || /^bash deploy\/ci\/[a-z-]+\.sh(?: (?:upload|deploy|seals))?$/.test(runOf(step)), `${String(step.name)}: script chamado sem argumento variável`);
  for (const name of CI_SCRIPTS.filter((item) => item !== 'lib.sh')) {
    const text = scriptText(name);
    assert.match(text, /^#!\/usr\/bin\/env bash\n/, `${name}: bash`);
    assert.match(text, /\nset -euo pipefail\n/, `${name}: modo estrito`);
  }
  assert.equal(new Set(steps.map((step) => step.id).filter((id) => id !== undefined)).size, steps.filter((step) => step.id !== undefined).length, 'ids únicos');
  assert.ok(steps.every((step) => typeof step.name === 'string' && step.name.length > 0), 'todo passo tem nome');
});

test('P9.4 build pelo commit exato: --build-arg sem =valor, linux/amd64, tag <amb>-<sha40>; impressão do Supabase só no passo do deploy, nunca nas saídas', () => {
  const build = scriptText('build-images.sh');
  assert.ok(!/--build-arg [A-Z_]+=/.test(build), 'o valor nunca na linha de comando');
  assert.match(build, /--build-arg NEXT_PUBLIC_SUPABASE_URL \\\n\s+--build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY \\/);
  assert.match(build, /--platform linux\/amd64 -f deploy\/hostinger\/Dockerfile --target "\$target"/);
  assert.match(build, /-t "gmn-\$\{target\}:\$\{tag\}" \. >"\$\{GMN_CI_BUILD_DIR\}\/build-\$\{target\}\.log" 2>&1 \|\| gmn_fail BUILD_FAILED "\$target"/, 'saída do build só no arquivo');
  assert.match(scriptText('lib.sh'), /gmn_image_tag\(\) \{ printf '%s-%s' "\$GMN_AMB" "\$GMN_SHA"; \}/);
  assert.match(build, /\[ "\$\(git rev-parse HEAD\)" = "\$GMN_SHA" \] \|\| gmn_fail CHECKOUT_MISMATCH/);
  const hashes = scriptText('declared-hashes.sh');
  assert.ok(!/SUPABASE/.test(withoutComments(hashes)), 'o passo dos hashes não toca no Supabase');
  for (const name of CI_SCRIPTS) assert.ok(!/gmn_output [a-z_]*fp|gmn_output [a-z_]*supabase/i.test(scriptText(name)), `${name}: impressão do Supabase nas saídas do passo`);
  const fp12Lines = withoutComments(scriptText('receiver-call.sh')).split('\n').filter((line) => line.includes('fp12')).map((line) => line.trim());
  assert.equal(fp12Lines.length, 4, 'a impressão só é declarada, calculada, validada e posta no comando remoto');
  assert.ok(fp12Lines.every((line) => !/^(?:echo|printf)\b|>&2|gmn_output/.test(line)), 'a impressão nunca é impressa');
});

/* ------------------------------------------------------------------------------------------------ runbook e emendas (P9.4) */

const runbookText = (): string => read('deploy/hostinger/RUNBOOK-DEPLOY-PELO-CI.md');

test('P9.4 runbook do responsável: H-01 a H-10, primeiro deploy, produção, rotação, incidente e rollback; conferências P9-O registradas', () => {
  const runbook = runbookText();
  for (let i = 1; i <= 10; i++) assert.match(runbook, new RegExp(`^### H-${String(i).padStart(2, '0')}\\b`, 'm'), `H-${i}`);
  for (const section of ['Primeiro deploy de homologação', 'Produção', 'Rotação das chaves SSH', 'Incidente', 'Rollback']) {
    assert.match(runbook, new RegExp(`^## \\d+\\. ${section}`, 'm'), section);
  }
  for (const check of ['P9-O01', 'P9-O02', 'P9-O03', 'P9-O04', 'P9-O05', 'P9-O06', 'P9-O07', 'P9-O08', 'P9-H06', 'P9-H07']) assert.ok(runbook.includes(check), check);
  for (const code of ['CI_PENDING', 'CI_NOT_GREEN', 'NOT_MAIN_HEAD', 'SSH_CONNECT_FAILED', 'TRUST_LIST_INSTALLED_MISMATCH', 'EX_CHECK_FAILED']) assert.ok(runbook.includes(code), code);
  assert.match(runbook, /SHASUMS256\.txt/);
  assert.match(runbook, /node-v22\.23\.2-linux-x64\.tar\.xz/);
  assert.match(runbook, /restrict,command=/);
  assert.match(runbook, /Match User/);
  assert.match(runbook, /ssh-keygen -lf/);
});

test('P9.4 runbook: repositório público, só marcadores (sem IP, e-mail ou domínio real); segredos por read -rs para arquivo 0600 ou stdin, nunca na linha de comando', () => {
  const runbook = runbookText();
  const withoutLoopback = runbook.replace(/\b(?:127\.0\.0\.1|0\.0\.0\.0)\b/g, '');
  assert.ok(!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(withoutLoopback), 'nenhum endereço IP');
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(runbook.replace(/`[^`\n]*`/g, '')), 'nenhum e-mail fora de código');
  for (const url of runbook.match(/https?:\/\/[^\s)`'"]+/g) ?? []) {
    assert.ok(/^https:\/\/(?:nodejs\.org|github\.com|docs\.github\.com)\//.test(url) || url.includes('<'), `URL fora dos marcadores: ${url}`);
  }
  assert.match(runbook, /read -rs/);
  const commands = (runbook.match(/```bash[\s\S]*?```/g) ?? []).join('\n');
  assert.ok(commands.length > 0);
  for (const line of commands.split('\n')) {
    if (/gh secret set/.test(line)) assert.ok(!/--body|\s-b\s/.test(line), `gh secret set sem --body: ${line}`);
    if (/docker secret create/.test(line)) assert.match(line, /docker secret create \S+ -(?:;|\s|$)/, `docker secret create pelo stdin: ${line}`);
  }
  for (const forbidden of [/StrictHostKeyChecking=no/, /accept-new/, /set -x/, /docker stack rm/, /docker system prune/, /rm -rf \/srv/]) assert.ok(!forbidden.test(commands), `${forbidden}`);
});

test('P9.4 runbook (revisão do PR #69): blocos privilegiados param no erro, o arquivo de variáveis nunca é executado, P9-O03 estrito depois do H-09, H-06 idempotente, impressão de produção no H-04 e rollback com a lista conferida', () => {
  const runbook = runbookText();
  const section = (from: string, to: string): string => runbook.slice(runbook.indexOf(from), runbook.indexOf(to));
  const h04 = section('### H-04', '### H-05');
  assert.match(h04, /\( set -euo pipefail[\s\S]*sha256sum -c -[\s\S]*sudo tar -xJf/, 'Node só instalado depois do sha256sum -c, num subshell que para no erro');
  assert.match(h04, /--forbid-supabase/);
  // revisão do PR #70 (item 6): a impressão é a da ORIGEM CANÔNICA, pelo mesmo script do job, no clone limpo
  assert.match(h04, /read -rsp 'URL do Supabase de PRODUÇÃO: ' U; echo; printf '%s' "\$U" \| bash deploy\/hostinger\/supabase-fp12\.sh; unset U/);
  assert.ok(!/printf '%s' "\$U" \| sha256sum/.test(h04), 'nunca o sha256 dos bytes crus da URL');
  assert.ok(!/forbid-supabase[\s\S]*```bash[\s\S]*read -rsp 'URL do Supabase de produção/.test(section('## 3. Produção', '## 4.')), 'a impressão de produção não fica para a seção de produção');
  assert.ok(!/^\s*(?:sudo\s+)?(?:sh -c ')?[^#\n]*(?:\bsource\b|\s\.\s+\/opt\/gmn-hml)/m.test((runbook.match(/```bash[\s\S]*?```/g) ?? []).join('\n')), 'o arquivo de variáveis nunca é carregado como shell');
  const h06 = section('### H-06', '### H-07');
  assert.match(h06, /if ! sudo test -e "\$img"; then\n\s+sudo fallocate[^\n]*\n\s+sudo mkfs\.ext4 -q -F "\$img"/, 'mkfs só na imagem recém-criada');
  assert.equal((h06.match(/```bash[\s\S]*?```/g) ?? []).join('\n').split('mkfs.ext4').length - 1, 1, 'um só mkfs nos comandos');
  assert.match(h06, /blkid -o value -s TYPE/);
  assert.match(h06, /\[ -e "\$log" \] \|\| sudo install -m 0600/, 'log existente nunca truncado');
  const h09 = section('### H-09', '### H-10');
  assert.match(h09, /P9-O03[\s\S]*StrictHostKeyChecking yes[\s\S]*UserKnownHostsFile[\s\S]*ssh -F/, 'P9-O03 com as opções estritas, depois do H-09');
  assert.match(h09, /if \[ "\$dr" -eq 10 \] && \[ "\$sr" -eq 10 \][^\n]*grep -qx 'ERRO E_COMMAND'[^\n]*grep -qx 'ERRO E_COMMAND'; then\n[^\n]*\n\s+shred -u/, 'shred só com as duas recusas');
  assert.ok(!(section('### H-05', '### H-06').match(/```bash[\s\S]*?```/g) ?? []).join('\n').includes('shred'), 'nenhum comando apaga a chave antes da prova');
  const rollback = section('## 6. Rollback', '## 7.');
  assert.match(rollback, /PreviousSpec/);
  assert.match(rollback, /paste -sd, "\/var\/lib\/gmn-deploy\/\$\{AMB\}\/trust-keys\.txt" \| sha256sum/);
  assert.match(rollback, /docker service update --no-resolve-image --image/);
});

test('P9.5 runbook §8 e emendas do canal e do livro: primeira entrega em homologação com GMN_SEALS_SSH_KEY, códigos da entrega, incidentes E_WRITE_UNCONFIRMED e E_EXISTS_DIFFERENT; procedimento final do p1-canal §3; junção verificação × entrega e hash da lista no livro', () => {
  const runbook = runbookText();
  const section8 = runbook.slice(runbook.indexOf('## 8. Entrega de manifestos pelo CI'));
  assert.ok(section8.startsWith('## 8. Entrega de manifestos pelo CI (P9.5)'), 'seção 8 no fim do runbook');
  for (const sub of ['### 8.1 O que precisa existir antes', '### 8.2 Primeira entrega em homologação (G2, P9-O06)', '### 8.3 Códigos da entrega', '### 8.4 Incidentes da entrega']) assert.ok(section8.includes(sub), sub);
  for (const code of ['GMN_SEALS_SSH_KEY', 'NOT_MAIN_HEAD', 'E_TRUST_LIST_MISMATCH', 'E_WRITE_UNCONFIRMED', 'E_EXISTS_DIFFERENT', 'E_POSTWRITE_VERIFY', 'SEALS_REFUSED', 'SEALS_NO_BASE', 'RECEIVER_UNKNOWN_ERROR EXIT_<n>']) assert.ok(section8.includes(code), code);
  assert.match(section8, /gh workflow run deploy\.yml --repo <DONO>\/<REPO> --ref main -f ambiente=homologacao -f acao=entregar-selos/);
  assert.match(section8, /conteúdo idêntico já presente/);
  assert.match(section8, /\*\*sem\*\* o passo 7 \(nunca se escreve à mão na pasta de\nmanifestos de produção\)/);
  assert.ok(!/ALREADY_PRESENT[^\n]*verificado no host/.test(section8.replace(/\*\*não\*\* é uma verificação no host/g, '')), 'ALREADY_PRESENT nunca como verificado no host');
  assert.ok(!runbook.includes('O que ainda não existe'), 'o cabeçalho não diz mais que a entrega não existe');
  const canal = read('docs/phase6-auditoria-link/p1-canal-de-entrega-manifestos.md');
  const procedure = canal.slice(canal.indexOf('## 3. Procedimento (final, P9.5)'), canal.indexOf('## 4.'));
  const order = ['**PR:**', 'job `seals` do `ci.yml`', '**Merge**', '**`seals-verify`**', '**Aprovação do `seals-deliver`**', '**Resumo do job (RC-08):**', '**Livro:**'];
  const positions = order.map((item) => procedure.indexOf(item));
  assert.ok(positions.every((at) => at >= 0), `procedimento final: ${JSON.stringify(positions)}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'PR → check → merge → seals-verify → aprovação → resumo → livro');
  assert.match(canal, /## 5\. Pendências de código \(W5\.2\) — resolvidas na P-9/);
  const livro = read('docs/phase6-auditoria-link/p1-livro-de-manifestos.md');
  assert.match(livro, /### 2\.1 Verificação e entrega pelo canal \(P9\.5\)/);
  assert.match(livro, /\*\*pela execução, pelo caminho e pelo `sha256sum`\*\*/);
  assert.match(livro, /\| data \| execução \(`run_id`\) \| tentativa \| commit \| ambiente \| caminho relativo \|/);
  assert.match(livro, /\*\*sha256 da lista instalada\*\*[\s\S]*\*\*sha256 do `trust-keys\.txt` no commit implantado\*\*/);
});

test('P9.4 emendas: guia, plano de rollback, verificação pós-deploy e CLAUDE.md apontam para o deploy.yml (homologacao/producao) e o caminho manual é só histórico', () => {
  const guide = read('deploy/hostinger/GUIA-DE-IMPLANTACAO.md');
  assert.match(guide, /\.github\/workflows\/deploy\.yml/);
  assert.match(guide, /(?:proibido|PROIBIDO)[^\n]*produção/);
  assert.match(guide, /link-audit-seals\/<amb>\/trust-keys\.txt/, '§3.4: a lista de confiança vem do repositório');
  const rollback = read('deploy/hostinger/PLANO-DE-ROLLBACK.md');
  assert.match(rollback, /commit de reversão/i);
  assert.match(rollback, /deploy\.yml/);
  assert.match(rollback, /docker service rollback "\$\{STACK\}_gmn-web"/);
  const verification = read('deploy/hostinger/VERIFICACAO-POS-DEPLOY.md');
  assert.match(verification, /STACK=gmn\b/);
  assert.match(verification, /STACK=gmn-hml\b/);
  assert.ok(!/docker stack services gmn\b|gmn_gmn-web/.test(verification), 'nome da stack sempre pelo parâmetro');
  const claude = read('CLAUDE.md');
  assert.match(claude, /^- Deploy staging: .*\.github\/workflows\/deploy\.yml.*`homologacao`/m);
  assert.match(claude, /^- Deploy prod: \*\*CI only\*\*.*\.github\/workflows\/deploy\.yml.*`producao`/m);
});
