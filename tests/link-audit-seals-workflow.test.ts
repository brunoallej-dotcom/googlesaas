import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps } from '../src/lib/link-audit/node-fs-ops';
import { runSealsCheckCli, SEALS_CHECK_EXIT } from '../src/lib/link-audit-seals-channel/cli';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { signer } from './helpers/link-audit-seal-close-key-fixtures';
import { AUD_A, canonicalText, listFile, listItem, nextSeal, sealRepoPath } from './helpers/link-audit-seals-fixtures';

/*
 * P9.2 — o job `seals` do `ci.yml` (spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.4; P9-S10, P9-W10, P9-H08). Teste ESTÁTICO do
 * workflow (texto do YAML) e teste FUNCIONAL do passo de preparação (`.github/scripts/seals-prepare.sh`) num repositório git LOCAL temporário,
 * com commit de merge como o do `pull_request` e o `before` do `push`: a saída real de `git diff -z`/`git ls-tree -r -z` alimenta o comando.
 * Nenhuma rede; o git roda só sobre a pasta temporária.
 */
registerCleanup();

const ROOT = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CI = read('.github/workflows/ci.yml');
const PREPARE = path.join(ROOT, '.github', 'scripts', 'seals-prepare.sh');
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1';
const CHANGED = "if: steps.prepare.outputs.changed == 'true'";

/** O bloco do job `seals` (do `  seals:` até o próximo job de dois espaços). */
function sealsJob(): string {
  const start = CI.indexOf('\n  seals:\n');
  assert.ok(start > 0, 'job seals no ci.yml');
  const rest = CI.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
/** O texto de cada `run:` (linha única ou bloco `|` com as linhas mais indentadas que a chave). */
function runBlocks(job: string): string[] {
  const lines = job.split('\n');
  const blocks: string[] = [];
  lines.forEach((line, index) => {
    const match = /^(\s*)(?:- )?run: (.*)$/.exec(line);
    if (!match) return;
    const indent = (match[1] ?? '').length;
    if (match[2] !== '|' && match[2] !== '>') return void blocks.push(match[2] ?? '');
    const body: string[] = [];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== '' && next.length - next.trimStart().length <= indent) break;
      body.push(next);
    }
    blocks.push(body.join('\n'));
  });
  return blocks;
}
/** Os passos do job, cada um do `      - ` até o próximo. */
const stepsOf = (job: string): string[] => job.split('\n      - ').slice(1).map((step) => `- ${step}`);

/* ------------------------------------------------------------------------------------------------------------------- P9-S10 / P9-W10 estático */

test('P9-S10 (estático) PR sem nada sob link-audit-seals/ ⇒ job verde SEM `npm ci`: setup-node, `npm ci` e o comando só rodam com `changed == true`; o preparo não instala nada', () => {
  const steps = stepsOf(sealsJob());
  assert.equal(steps.length, 5, 'checkout, preparo, setup-node, install, verificação');
  const [checkout, prepare, ...gated] = steps as [string, string, ...string[]];
  assert.ok(checkout.startsWith(`- uses: ${CHECKOUT}`));
  assert.match(prepare, /id: prepare\n/);
  assert.match(prepare, /run: SEALS_OUT="\$RUNNER_TEMP\/seals" bash \.github\/scripts\/seals-prepare\.sh/);
  assert.ok(!/npm|node /.test(prepare), 'o preparo não chama npm nem node');
  for (const step of gated) assert.ok(step.includes(CHANGED), `passo condicionado: ${step.split('\n')[0]}`);
  assert.ok(gated.some((step) => step.startsWith(`- uses: ${SETUP_NODE}`)));
  assert.ok(gated.some((step) => /run: npm ci\n/.test(`${step}\n`)), 'npm ci só com mudança');
  assert.ok(gated.some((step) => step.includes('npm run --silent link-audit:seals-check -- \\') && step.includes('| tee -a "$GITHUB_STEP_SUMMARY"') && step.includes('set -o pipefail')), 'o comando escreve o resumo e propaga a falha');
  assert.equal((sealsJob().match(/npm ci/g) ?? []).length, 1);
});

test('P9-W10 `ci.yml`: job `seals (append-only, v2)` em todo pull_request e push na main sem filtro de caminho, sem segredo, `contents: read`, checkout sem credencial e com histórico completo, ações pelos SHAs do ci.yml, nada de `${{ }}` no `run:`, base = HEAD^1 no PR', () => {
  const job = sealsJob();
  assert.match(CI, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}branches: \[main\]\n\n/m, 'gatilhos sem paths');
  assert.ok(!/\bpaths(-ignore)?:/.test(CI), 'nenhum filtro de caminho no ci.yml');
  assert.match(job, /^ {4}name: seals \(append-only, v2\)$/m);
  assert.match(job, /^ {4}permissions:\n {6}contents: read\n {4}steps:/m, 'permissões exatamente contents: read');
  assert.ok(!/secrets\.|GITHUB_TOKEN|write/.test(job), 'sem segredo e sem escrita');
  assert.match(job, /with:\n {10}fetch-depth: 0\n {10}persist-credentials: false\n/);
  const uses = [...job.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
  assert.deepEqual(uses, [CHECKOUT, SETUP_NODE], 'só as ações já fixadas no ci.yml');
  for (const action of uses) assert.equal(CI.split(`uses: ${action}`).length - 1 > 1, true, `${action} igual ao dos outros jobs`);
  assert.ok(!/cache:/.test(job), 'sem cache restaurado no job de verificação');
  const runs = runBlocks(job);
  assert.equal(runs.length, 3, 'preparo, install e verificação');
  for (const run of runs) assert.ok(!run.includes('${{'), `nenhum \${{ }} dentro de run: ${run.split('\n')[0]}`);
  assert.match(job, /env:\n {10}SEALS_EVENT: \$\{\{ github\.event_name \}\}\n {10}SEALS_BEFORE: \$\{\{ github\.event\.before \}\}\n/, 'entradas do evento pelo ambiente');
  const script = fs.readFileSync(PREPARE, 'utf8');
  assert.ok(script.includes("base=\"$(git rev-parse --verify --quiet 'HEAD^1^{commit}')\" || refuse SEALS_NO_BASE"), 'base = HEAD^1 no pull_request');
  assert.ok(script.includes('git diff --name-status --no-renames -z "$base" HEAD -- "$SEALS_PATH"'));
  assert.ok(script.includes('git ls-tree -r -z HEAD -- "$SEALS_PATH"'));
  assert.ok(!/curl|wget|ssh|npm|node|git (fetch|push|pull|clone)/.test(script.replace(/^\s*#.*$/gm, '')), 'o preparo não usa rede nem instala nada');
});

test('P9-H08 `.dockerignore` exclui link-audit-seals; `.gitattributes` tem `link-audit-seals/** -text` DEPOIS de toda regra de texto que casaria (a última vale); as duas listas existem vazias', () => {
  assert.ok(read('.dockerignore').split('\n').includes('link-audit-seals'));
  const lines = read('.gitattributes').split('\n');
  const at = lines.indexOf('link-audit-seals/** -text');
  assert.ok(at > 0, 'a linha exata');
  const laterText = lines.slice(at + 1).filter((line) => /^\S+\s.*\btext\b/.test(line) && !line.startsWith('#'));
  assert.deepEqual(laterText, [], 'nenhuma regra de texto depois dela');
  assert.ok(lines.slice(0, at).some((line) => line.startsWith('*.json')) && lines.slice(0, at).some((line) => line.startsWith('*.txt')), 'vale sobre *.json e *.txt');
  for (const env of ['producao', 'homologacao']) assert.equal(fs.statSync(path.join(ROOT, 'link-audit-seals', env, 'trust-keys.txt')).size, 0, `${env}: lista vazia (política fechada)`);
});

/* ------------------------------------------------------------------------------------------------------------------- P9-S10 funcional */

const GIT_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'teste', GIT_AUTHOR_EMAIL: 'teste@exemplo.invalid', GIT_COMMITTER_NAME: 'teste', GIT_COMMITTER_EMAIL: 'teste@exemplo.invalid' };

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: { ...GIT_ENV, HOME: cwd } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

function put(repo: string, repoPath: string, content: string): void {
  const file = path.join(repo, ...repoPath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

interface Prepared {
  readonly status: number | null;
  readonly stderr: string;
  readonly output: string;
  readonly summary: string;
  readonly out: string;
}

function prepare(repo: string, event: string, before = ''): Prepared {
  const out = tmpDir('p92-prep-');
  const outputFile = path.join(out, 'github-output');
  const summaryFile = path.join(out, 'summary.md');
  const result = spawnSync('bash', [PREPARE], { cwd: repo, env: { ...GIT_ENV, HOME: repo, SEALS_EVENT: event, SEALS_BEFORE: before, SEALS_OUT: path.join(out, 'seals'), GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });
  const readOr = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  return { status: result.status, stderr: result.stderr, output: readOr(outputFile), summary: readOr(summaryFile), out: path.join(out, 'seals') };
}

const KEY = signer('ek-fluxo-a');

/** Base na `main` (lista com a chave, cadeia de AUD_A com um manifesto) e um PR em cima; devolve o commit-base. */
function repoWithBase(): { readonly repo: string; readonly base: string } {
  const repo = tmpDir('p92-git-');
  git(repo, 'init', '-q', '-b', 'main');
  fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(repo, '.gitattributes'));
  put(repo, 'README.md', 'repositório de teste\n');
  put(repo, 'link-audit-seals/producao/trust-keys.txt', listFile([listItem(KEY)]));
  put(repo, 'link-audit-seals/homologacao/trust-keys.txt', '');
  put(repo, sealRepoPath(AUD_A, 1), canonicalText(nextSeal(AUD_A, [], { signer: KEY })));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

/** Simula o `refs/pull/N/merge` do GitHub: o PR num ramo e um commit de merge na `main` (HEAD^1 = base). */
function mergePr(repo: string, change: (repo: string) => void): void {
  git(repo, 'checkout', '-q', '-b', 'pr');
  change(repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'pr');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr');
}

async function runCheck(repo: string, out: string): Promise<{ readonly exit: number; readonly lines: string[]; readonly errors: string[] }> {
  const lines: string[] = [];
  const errors: string[] = [];
  const argv = ['--changes', path.join(out, 'changes'), '--modes', path.join(out, 'modes'), '--base-trust', path.join(out, 'base-trust'), '--repo', repo];
  const exit = await runSealsCheckCli(argv, (line) => lines.push(line), (line) => errors.push(line), { fs: nodeFsOps });
  return { exit, lines, errors };
}

test('P9-S10 (funcional) PR sem nada sob link-audit-seals/ ⇒ `changed=false`, nenhuma entrada gerada e o resumo diz que nada foi verificado', () => {
  const { repo, base } = repoWithBase();
  mergePr(repo, (dir) => put(dir, 'README.md', 'outra coisa\n'));
  const result = prepare(repo, 'pull_request');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'changed=false\n');
  assert.ok(!fs.existsSync(path.join(result.out, 'modes')), 'nenhum modo calculado');
  assert.ok(result.summary.includes(`Nada mudou sob \`link-audit-seals/\` desde \`${base}\``));
});

test('P9-S10 (funcional) PR com manifesto novo: base = HEAD^1 do merge, `changed=true`, e a saída REAL do git alimenta o comando (verde; resumo com a linha do manifesto)', async () => {
  const { repo, base } = repoWithBase();
  const first = nextSeal(AUD_A, [], { signer: KEY });
  mergePr(repo, (dir) => put(dir, sealRepoPath(AUD_A, 2), canonicalText(nextSeal(AUD_A, [first], { signer: KEY }))));
  const result = prepare(repo, 'pull_request');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'changed=true\n');
  assert.equal(git(repo, 'rev-parse', 'HEAD^1'), base);
  assert.equal(fs.readFileSync(path.join(result.out, 'changes'), 'utf8'), `A\0${sealRepoPath(AUD_A, 2)}\0`);
  assert.equal(fs.readFileSync(path.join(result.out, 'base-trust', 'producao', 'trust-keys.txt'), 'utf8'), listFile([listItem(KEY)]));
  assert.equal(fs.readFileSync(path.join(result.out, 'base-trust', 'homologacao', 'trust-keys.txt'), 'utf8'), '', 'a lista vazia do commit-base também vai');
  const checked = await runCheck(repo, result.out);
  assert.equal(checked.exit, SEALS_CHECK_EXIT.OK, checked.errors.join('\n'));
  assert.ok(checked.lines.some((line) => line.startsWith(`| \`${AUD_A}/seal-0002.json\` |`)));
});

test('P9-S10 (funcional) modos reais do git: link simbólico e executável sob link-audit-seals/ ⇒ SEALS_BAD_MODE pelo comando', async () => {
  const { repo } = repoWithBase();
  mergePr(repo, (dir) => {
    const link = path.join(dir, ...sealRepoPath(AUD_A, 2).split('/'));
    fs.symlinkSync('seal-0001.json', link);
    const exec = path.join(dir, ...sealRepoPath('aud-00000000000000e1', 1).split('/'));
    fs.mkdirSync(path.dirname(exec), { recursive: true });
    fs.writeFileSync(exec, canonicalText(nextSeal('aud-00000000000000e1', [], { signer: KEY })));
    fs.chmodSync(exec, 0o755);
  });
  const result = prepare(repo, 'pull_request');
  assert.equal(result.output, 'changed=true\n');
  const checked = await runCheck(repo, result.out);
  assert.equal(checked.exit, SEALS_CHECK_EXIT.REFUSED);
  assert.deepEqual(checked.errors, ['ERRO SEALS_BAD_MODE']);
  assert.equal(checked.lines.filter((line) => line.includes('`SEALS_BAD_MODE`')).length, 2);
});

test('push: base = `before`; `before` todo zero (branch novo), fora do histórico ou evento desconhecido ⇒ falha FECHADA SEALS_NO_BASE (spec omissa, decisão da P9.2)', () => {
  const { repo, base } = repoWithBase();
  put(repo, 'README.md', 'mudança direta\n');
  git(repo, 'commit', '-q', '-am', 'push');
  const pushed = prepare(repo, 'push', base);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(pushed.output, 'changed=false\n');
  for (const [event, before] of [['push', '0'.repeat(40)], ['push', 'f'.repeat(40)], ['push', ''], ['push', 'HEAD~1'], ['merge_group', base], ['', base]] as const) {
    const refused = prepare(repo, event, before);
    assert.equal(refused.status, 2, `${event} ${before}`);
    assert.equal(refused.stderr, 'ERRO SEALS_NO_BASE\n');
    assert.equal(refused.output, '', 'nada dado como "sem mudança"');
    assert.ok(refused.summary.includes('Resultado: `ERRO SEALS_NO_BASE`'));
  }
});
