import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { registerCleanup } from './helpers/link-audit-evidence-fixtures';
import {
  baseService,
  CONFIG_DIGEST_WEB,
  CONFIG_DIGEST_WORKER,
  CONTAINERD_ID_WEB,
  CONTAINERD_ID_WORKER,
  containerdImages,
  DERIVED_BIND_FOLDERS,
  listingFor,
  listLine,
  WEB_CONFIG,
  WEB_CONFIG_PATH,
  WEB_DIFF_IDS,
  WORKER_CONFIG_PATH,
  type LoadedImage,
  deployCommand,
  DOCKER_NOISE,
  FakeStdin,
  fp12,
  manifestFor,
  OTHER_SHA40,
  PRODUCTION_URL,
  publicText,
  runReceiver,
  SENTINEL_EMAIL,
  SENTINEL_HOST,
  SENTINEL_URL,
  SHA40,
  sha256,
  testKey,
  trustFile,
  trustLine,
  validHostVars,
  world,
  type Run,
  type World,
} from './helpers/deploy-receiver-fakes';

/*
 * P9.3a — o receptor de deploy de ponta a ponta, em processo (spec §5.6, §5.8; critérios P9-D02 a P9-D14): pastas temporárias reais, disco real
 * do adaptador e `docker`, `tar`, `gzip` e o script de pastas FALSOS (nenhum Docker, ssh ou rede). Cada execução tem de produzir exatamente uma
 * linha pública da gramática do §5.8, sem caminho, saída do Docker ou valor do arquivo de variáveis (conferido em todas, no fim).
 */
registerCleanup();

const PUBLIC_LINE = /^(?:OK UPLOADED [0-9a-f]{40} [0-9a-f]{64}|OK DEPLOYED (?:producao|homologacao)-[0-9a-f]{40} sha256:[0-9a-f]{64} sha256:[0-9a-f]{64} [0-9a-f]{64} (?:[0-9a-f]{64}|-) [0-9a-f]{64}|ERRO E_[A-Z_]+(?: [A-Z0-9_-]+)?)$/;
const NEVER_PUBLIC = [DOCKER_NOISE, SENTINEL_URL, SENTINEL_EMAIL, SENTINEL_HOST, '/srv/', '/var/', '/tmp'];
const allRuns: Run[] = [];

async function run(w: World, command: string | undefined, stdin?: FakeStdin): Promise<Run> {
  const result = await runReceiver(w, command, stdin);
  allRuns.push(result);
  return result;
}
const deploy = (w: World, over: Parameters<typeof deployCommand>[1] = {}, stdin?: FakeStdin): Promise<Run> => run(w, deployCommand(w, over), stdin);
const installedPath = (w: World): string => path.join(w.stateDir, 'trust-keys.txt');
const bundlePath = (w: World, sha = SHA40): string => path.join(w.stateDir, 'incoming', `bundle-${sha}.tar.gz`);
const refusedWith = (r: Run, line: string): void => {
  assert.equal(r.outcome.stdout, null, `nada no stdout (${line})`);
  assert.equal(r.outcome.stderr, line);
};
const loaded = (r: Run): boolean => r.runner.called(['load']);
const stackDeployed = (r: Run): boolean => r.runner.called(['stack', 'deploy']);

/* ===================================================================================================================== sucesso */

test('P9-D11 produção: sucesso ⇒ uma linha OK DEPLOYED (forma que o job aceita) com o sha256 da lista INSTALADA (relido, = recebido); lista 0644; pacote apagado', async () => {
  const w = world();
  const r = await deploy(w);
  const expected = new RegExp(`^OK DEPLOYED producao-${SHA40} (sha256:[0-9a-f]{64}) (sha256:[0-9a-f]{64}) ${w.stackSha256} - ([0-9a-f]{64})$`);
  const match = expected.exec(r.outcome.stdout ?? '');
  assert.ok(match, String(r.outcome.stdout ?? r.outcome.stderr));
  assert.equal(r.outcome.exitCode, 0);
  assert.equal(r.outcome.stderr, null);
  assert.equal(match[3], sha256(fs.readFileSync(installedPath(w))), 'o hash da linha é o do arquivo instalado');
  assert.equal(match[3], sha256(w.trust), 'igual ao recebido');
  assert.deepEqual(fs.readFileSync(installedPath(w)), w.trust);
  assert.equal(fs.statSync(installedPath(w)).mode & 0o777, 0o644, 'o receptor de manifestos (outro usuário) lê a lista');
  assert.ok(!fs.existsSync(bundlePath(w)), 'pacote apagado');
  assert.deepEqual(fs.readdirSync(w.stateDir).sort(), ['incoming', 'trust-keys.txt'], 'sem temporário nem trava sobrando');
  assert.ok(r.log.entries.some((entry) => entry.event === 'trust.installed' && entry.fields.sha256 === match[3]), 'o log local registra o hash da lista instalada (conferência do livro)');
});

test('P9-D11 homologação: sucesso com a sobreposição; o OK DEPLOYED traz o hash da sobreposição; lista ensaio- instalada', async () => {
  const w = world({ env: 'homologacao' });
  const r = await deploy(w);
  assert.match(r.outcome.stdout ?? String(r.outcome.stderr), new RegExp(`^OK DEPLOYED homologacao-${SHA40} sha256:[0-9a-f]{64} sha256:[0-9a-f]{64} ${w.stackSha256} ${w.overlaySha256} ${sha256(w.trust)}$`));
  assert.deepEqual(fs.readFileSync(installedPath(w)), w.trust);
});

test('P9-D11: lista vazia (política fechada) é instalada como arquivo de 0 bytes e a variável vai vazia', async () => {
  const w = world({ trust: Buffer.alloc(0) });
  const r = await deploy(w);
  assert.equal(r.outcome.exitCode, 0, String(r.outcome.stderr));
  assert.equal(fs.statSync(installedPath(w)).size, 0);
  const stackCall = r.runner.calls.find((call) => call.args[0] === 'stack' && call.args[1] === 'deploy');
  assert.equal(stackCall?.env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS, '');
});

/* ===================================================================================================================== upload */

test('P9-D02 upload: pacote exato ⇒ OK UPLOADED; arquivo 0600 com o nome final; pacotes antigos do PRÓPRIO receptor apagados, o resto da pasta intacto', async () => {
  const w = world();
  const incoming = path.join(w.stateDir, 'incoming');
  fs.writeFileSync(path.join(incoming, `bundle-${OTHER_SHA40}.tar.gz`), 'velho');
  fs.writeFileSync(path.join(incoming, `.bundle-${OTHER_SHA40}.partial-0123456789abcdef`), 'temporário velho');
  fs.writeFileSync(path.join(incoming, 'nao-e-do-receptor.txt'), 'fica');
  const bundle = Buffer.from('pacote novo '.repeat(1000));
  const r = await run(w, `upload ${OTHER_SHA40} ${sha256(bundle)} ${bundle.length}`, FakeStdin.of(bundle, 333));
  assert.equal(r.outcome.stdout, `OK UPLOADED ${OTHER_SHA40} ${sha256(bundle)}`);
  assert.deepEqual(fs.readdirSync(incoming).sort(), [`bundle-${OTHER_SHA40}.tar.gz`, 'nao-e-do-receptor.txt'], `o pacote do sha antigo (${SHA40}) também é apagado: só um pacote por vez`);
  assert.deepEqual(fs.readFileSync(bundlePath(w, OTHER_SHA40)), bundle);
  assert.equal(fs.statSync(bundlePath(w, OTHER_SHA40)).mode & 0o777, 0o600);
  assert.equal(r.runner.calls.length, 0, 'o upload não chama programa nenhum');
});

test('P9-D02 upload: bytes a mais ⇒ E_INPUT_TOO_LARGE; a menos ou prazo sem dados ⇒ E_INPUT_TRUNCATED; hash diferente ⇒ E_HASH_MISMATCH; o arquivo parcial é apagado em todos', async () => {
  const bundle = Buffer.from('0123456789'.repeat(100));
  const cases: ReadonlyArray<readonly [string, string, FakeStdin, string]> = [
    ['a mais', `upload ${OTHER_SHA40} ${sha256(bundle)} ${bundle.length - 1}`, FakeStdin.of(bundle, 100), 'ERRO E_INPUT_TOO_LARGE'],
    ['a menos', `upload ${OTHER_SHA40} ${sha256(bundle)} ${bundle.length + 1}`, FakeStdin.of(bundle, 100), 'ERRO E_INPUT_TRUNCATED'],
    ['prazo sem dados', `upload ${OTHER_SHA40} ${sha256(bundle)} ${bundle.length}`, new FakeStdin([bundle.subarray(0, 10)], 'hang'), 'ERRO E_INPUT_TRUNCATED'],
    ['hash diferente', `upload ${OTHER_SHA40} ${'0'.repeat(64)} ${bundle.length}`, FakeStdin.of(bundle, 100), 'ERRO E_HASH_MISMATCH'],
  ];
  for (const [label, command, stdin, line] of cases) {
    const w = world();
    const r = await run(w, command, stdin);
    refusedWith(r, line);
    assert.equal(r.outcome.exitCode, { 'ERRO E_INPUT_TOO_LARGE': 11, 'ERRO E_INPUT_TRUNCATED': 12, 'ERRO E_HASH_MISMATCH': 13 }[line], label);
    assert.deepEqual(fs.readdirSync(path.join(w.stateDir, 'incoming')), [], `${label}: nem parcial nem final`);
  }
});

test('P9-D02 upload: o primeiro byte além do declarado recusa sem ler o resto do stdin', async () => {
  const w = world();
  const chunks = Array.from({ length: 50 }, () => Buffer.alloc(100, 0x61));
  const stdin = new FakeStdin(chunks);
  const r = await run(w, `upload ${OTHER_SHA40} ${'0'.repeat(64)} 150`, stdin);
  refusedWith(r, 'ERRO E_INPUT_TOO_LARGE');
  assert.equal(stdin.reads, 2, 'parou no segundo pedaço');
});

/* ===================================================================================================================== passos 1 a 3 */

test('passo 1: sem pacote recebido para o commit ⇒ E_NOT_STAGED; pacote alterado depois do upload ⇒ E_HASH_MISMATCH; nada lido do stdin, nenhum programa chamado', async () => {
  const w = world();
  const stdin = FakeStdin.of(w.trust);
  refusedWith(await deploy(w, { sha40: OTHER_SHA40 }, stdin), 'ERRO E_NOT_STAGED');
  fs.appendFileSync(bundlePath(w), 'x');
  const altered = await deploy(w, {}, stdin);
  refusedWith(altered, 'ERRO E_HASH_MISMATCH');
  assert.equal(stdin.reads, 0);
  assert.equal(altered.runner.calls.length, 0);
});

test('P9-D03 stack ou sobreposição do host com outro hash (ou ausente) ⇒ E_STACK_FILE_MISMATCH, sem chamar docker nem ler a lista', async () => {
  const prod = world();
  const stdin = FakeStdin.of(prod.trust);
  const r = await deploy(prod, { stack: '0'.repeat(64) }, stdin);
  refusedWith(r, 'ERRO E_STACK_FILE_MISMATCH');
  assert.equal(r.outcome.exitCode, 51);
  assert.equal(r.runner.calls.length, 0);
  assert.equal(stdin.reads, 0);
  fs.rmSync(prod.stackFile);
  refusedWith(await deploy(prod), 'ERRO E_STACK_FILE_MISMATCH');
  const hml = world({ env: 'homologacao' });
  const overlay = await deploy(hml, { overlay: '0'.repeat(64) });
  refusedWith(overlay, 'ERRO E_STACK_FILE_MISMATCH');
  assert.equal(overlay.runner.calls.length, 0);
  fs.writeFileSync(hml.overlayFile as string, 'services: {} # sobreposição trocada\n');
  refusedWith(await deploy(hml), 'ERRO E_STACK_FILE_MISMATCH');
});

test('passo 3: lista com hash ≠ declarado ⇒ E_TRUST_LIST_MISMATCH; fora do formato ou da regra de ambiente ⇒ E_TRUST_LIST_INVALID; acima de 8 KiB ⇒ E_INPUT_TOO_LARGE; nenhum programa chamado, nada instalado', async () => {
  const w = world();
  const mismatch = await deploy(w, { trust: '0'.repeat(64) });
  refusedWith(mismatch, 'ERRO E_TRUST_LIST_MISMATCH');
  assert.equal(mismatch.runner.calls.length, 0);
  const rehearsal = trustFile([trustLine(testKey('ensaio-chave-x'))]);
  const invalidLists: ReadonlyArray<readonly [string, Buffer]> = [
    ['CRLF', Buffer.from(`${trustLine(w.keys.a)}\r\n`)],
    ['sem \\n final', Buffer.from(trustLine(w.keys.a))],
    ['ensaio- em produção', rehearsal],
    ['três active', trustFile([trustLine(w.keys.a), trustLine(w.keys.b), trustLine(testKey('chave-prod-c'))])],
  ];
  for (const [label, list] of invalidLists) {
    const x = world();
    x.trust = list;
    const r = await deploy(x);
    refusedWith(r, 'ERRO E_TRUST_LIST_INVALID');
    assert.equal(r.runner.calls.length, 0, label);
    assert.ok(!fs.existsSync(installedPath(x)), label);
  }
  const hml = world({ env: 'homologacao' });
  hml.trust = trustFile([trustLine(testKey('chave-sem-prefixo'))]);
  refusedWith(await deploy(hml), 'ERRO E_TRUST_LIST_INVALID');
  const big = world();
  big.trust = Buffer.alloc(8 * 1024 + 1, 0x61);
  refusedWith(await deploy(big), 'ERRO E_INPUT_TOO_LARGE');
});

test('P9-D14 contra a lista INSTALADA: revoked → outro, retired → active, hash fixado trocado ou tirado, chave ou id trocados, item removido (inclusive voltar à vazia) ⇒ E_TRUST_LIST_TRANSITION, sem docker load e sem instalar', async () => {
  const a = testKey('chave-prod-a');
  const b = testKey('chave-prod-b');
  const pinned = `retired:${'1'.repeat(64)}`;
  const cases: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
    ['revoked → active', [trustLine(a, 'revoked')], [trustLine(a, 'active')]],
    ['revoked → retired', [trustLine(a, 'revoked')], [trustLine(a, 'retired')]],
    ['retired → active', [trustLine(a, 'retired'), trustLine(b)], [trustLine(a, 'active'), trustLine(b)]],
    ['hash fixado trocado', [trustLine(a, pinned)], [trustLine(a, `retired:${'2'.repeat(64)}`)]],
    ['hash fixado tirado', [trustLine(a, pinned)], [trustLine(a, 'retired')]],
    ['chave pública trocada', [trustLine(a)], [trustLine({ id: a.id, pub: b.pub })]],
    ['id trocado', [trustLine(a)], [trustLine({ id: 'chave-prod-renomeada', pub: a.pub })]],
    ['item removido', [trustLine(a), trustLine(b, 'retired')], [trustLine(a)]],
    ['volta à lista vazia', [trustLine(a)], []],
  ];
  for (const [label, before, after] of cases) {
    const installed = trustFile(before);
    const w = world({ installed, trust: trustFile(after) });
    const r = await deploy(w);
    refusedWith(r, 'ERRO E_TRUST_LIST_TRANSITION');
    assert.equal(r.outcome.exitCode, 66, label);
    assert.ok(!loaded(r) && !stackDeployed(r), `${label}: sem docker load nem deploy`);
    assert.equal(r.runner.calls.length, 0, `${label}: nem consulta ao Docker`);
    assert.deepEqual(fs.readFileSync(installedPath(w)), installed, `${label}: a instalada fica`);
    assert.ok(fs.existsSync(bundlePath(w)), `${label}: o pacote fica`);
  }
});

test('P9-D14: instalada ausente ou vazia ⇒ qualquer lista válida passa; igual à instalada passa; transições permitidas (item novo, qualquer → revoked, fixação nova sem prova do fecho) passam; instalada ilegível ⇒ E_TRUST_LIST_TRANSITION', async () => {
  const a = testKey('chave-prod-a');
  const b = testKey('chave-prod-b');
  const accepted: ReadonlyArray<readonly [string, Buffer | null, readonly string[]]> = [
    ['instalada ausente', null, [trustLine(a), trustLine(b, 'revoked')]],
    ['instalada vazia', Buffer.alloc(0), [trustLine(a)]],
    ['igual à instalada', trustFile([trustLine(a)]), [trustLine(a)]],
    ['item novo', trustFile([trustLine(a)]), [trustLine(a), trustLine(b)]],
    ['active → revoked', trustFile([trustLine(a)]), [trustLine(a, 'revoked')]],
    ['active → retired:<hash> (o host não vê fechos; a prova é do CI)', trustFile([trustLine(a)]), [trustLine(a, `retired:${'3'.repeat(64)}`)]],
  ];
  for (const [label, installed, next] of accepted) {
    const w = world({ installed, trust: trustFile(next) });
    const r = await deploy(w);
    assert.equal(r.outcome.exitCode, 0, `${label}: ${r.outcome.stderr}`);
    assert.deepEqual(fs.readFileSync(installedPath(w)), trustFile(next), label);
  }
  const corrupt = world({ installed: Buffer.from('nao-e-uma-lista\n') });
  refusedWith(await deploy(corrupt), 'ERRO E_TRUST_LIST_TRANSITION');
  const linked = world();
  fs.symlinkSync('/etc/hostname', installedPath(linked));
  refusedWith(await deploy(linked), 'ERRO E_TRUST_LIST_TRANSITION');
});

/* ===================================================================================================================== passos 4 a 8 */

test('P9-D04 em processo: variável proibida ⇒ E_HOST_CONFIG <NOME>; linha fora do parser sem nome da lista ⇒ E_HOST_CONFIG; o valor nunca aparece; nenhum programa chamado', async () => {
  const base = world();
  const valid = validHostVars('producao', base.dataFolders, path.dirname(base.dataFolders[0] as string));
  const cases: ReadonlyArray<readonly [string, string]> = [
    [`${valid}GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS=${SENTINEL_URL}\n`, 'ERRO E_HOST_CONFIG GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS'],
    [`${valid}GMN_IMAGE_TAG=${SENTINEL_HOST}\n`, 'ERRO E_HOST_CONFIG GMN_IMAGE_TAG'],
    [`${valid}GMN_LINK_AUDIT_HOMOLOGATION=1\n`, 'ERRO E_HOST_CONFIG GMN_LINK_AUDIT_HOMOLOGATION'],
    [`${valid}export SEGREDO=${SENTINEL_EMAIL}\n`, 'ERRO E_HOST_CONFIG'],
    [valid.replace('GMN_HOST=', 'GMN_HOST=$'), 'ERRO E_HOST_CONFIG GMN_HOST'],
  ];
  for (const [hostVars, line] of cases) {
    const w = world({ hostVars });
    const r = await deploy(w);
    refusedWith(r, line);
    assert.equal(r.outcome.exitCode, 52);
    assert.equal(r.runner.calls.length, 0);
    assert.ok(!r.log.text().includes(SENTINEL_URL) && !r.log.text().includes(SENTINEL_EMAIL) && !r.log.text().includes(SENTINEL_HOST), 'nem no log local');
  }
  const missing = world();
  fs.rmSync(missing.hostVarsFile);
  refusedWith(await deploy(missing), 'ERRO E_HOST_CONFIG');
});

test('P9-D04 homologação em processo: pasta fora do prefixo ⇒ E_DATA_PREFIX; pasta que é link para fora do prefixo (caminho real) ⇒ E_DATA_PREFIX', async () => {
  const w = world({ env: 'homologacao' });
  const dataRoot = (w.dataPrefix as string).slice(0, -1);
  fs.writeFileSync(w.hostVarsFile, validHostVars('homologacao', w.dataFolders.map((folder, index) => (index === 5 ? '/srv/gmn/manifestos' : folder)), dataRoot));
  refusedWith(await deploy(w), 'ERRO E_DATA_PREFIX');
  const linkedTarget = fs.mkdtempSync(path.join(w.root, 'fora-'));
  const linkedFolder = path.join(dataRoot, 'manifestos-link');
  fs.symlinkSync(linkedTarget, linkedFolder);
  fs.writeFileSync(w.hostVarsFile, validHostVars('homologacao', w.dataFolders.map((folder, index) => (index === 5 ? linkedFolder : folder)), dataRoot));
  const r = await deploy(w);
  refusedWith(r, 'ERRO E_DATA_PREFIX');
  assert.equal(r.outcome.exitCode, 65);
  assert.equal(r.runner.calls.length, 0);
});

test('P9-D05 impressão do Supabase (origem canônica) diferente ⇒ E_SUPABASE_MISMATCH; homologação com a impressão de produção (no arquivo, em qualquer forma aceita, ou declarada) ⇒ E_HML_PRODUCTION_PROJECT; URL com caminho ⇒ E_HOST_CONFIG NEXT_PUBLIC_SUPABASE_URL; nenhum programa chamado', async () => {
  const prod = world();
  const mismatch = await deploy(prod, { fp: fp12('https://outro-projeto.supabase.invalid') });
  refusedWith(mismatch, 'ERRO E_SUPABASE_MISMATCH');
  assert.equal(mismatch.outcome.exitCode, 54);
  assert.equal(mismatch.runner.calls.length, 0);
  const hml = world({ env: 'homologacao' });
  const dataRoot = (hml.dataPrefix as string).slice(0, -1);
  fs.writeFileSync(hml.hostVarsFile, validHostVars('homologacao', hml.dataFolders, dataRoot, PRODUCTION_URL));
  const fromFile = await deploy(hml, { fp: fp12(PRODUCTION_URL) });
  refusedWith(fromFile, 'ERRO E_HML_PRODUCTION_PROJECT');
  assert.equal(fromFile.outcome.exitCode, 55);
  const declared = world({ env: 'homologacao' });
  refusedWith(await deploy(declared, { fp: fp12(PRODUCTION_URL) }), 'ERRO E_HML_PRODUCTION_PROJECT');
  assert.equal((await deploy(world({ env: 'homologacao' }))).outcome.exitCode, 0, 'laboratório ≠ produção passa');
  // revisão do PR #70 (item 6): a impressão é a da ORIGEM CANÔNICA, dos dois lados
  const sloppy = world();
  fs.writeFileSync(sloppy.hostVarsFile, validHostVars('producao', sloppy.dataFolders, path.dirname(sloppy.dataFolders[0] as string), `${SENTINEL_URL.toUpperCase().replace('HTTPS://', 'https://')}:443/`));
  assert.equal((await deploy(sloppy)).outcome.exitCode, 0, 'maiúsculas, :443 e barra no arquivo do host: mesma impressão');
  const hmlSloppy = world({ env: 'homologacao' });
  fs.writeFileSync(hmlSloppy.hostVarsFile, validHostVars('homologacao', hmlSloppy.dataFolders, (hmlSloppy.dataPrefix as string).slice(0, -1), `${PRODUCTION_URL}/`));
  refusedWith(await deploy(hmlSloppy, { fp: fp12(PRODUCTION_URL) }), 'ERRO E_HML_PRODUCTION_PROJECT');
  const pathUrl = world();
  fs.writeFileSync(pathUrl.hostVarsFile, validHostVars('producao', pathUrl.dataFolders, path.dirname(pathUrl.dataFolders[0] as string), `${SENTINEL_URL}/rest/v1`));
  refusedWith(await deploy(pathUrl), 'ERRO E_HOST_CONFIG NEXT_PUBLIC_SUPABASE_URL');
});

test('P9-D12 pastas recusadas pelo script ⇒ E_HOST_FOLDERS (script chamado com as seis pastas, na ordem, só com PATH); espaço insuficiente ⇒ E_DISK_LOW; nada carregado', async () => {
  const w = world();
  w.scenario.foldersOk = false;
  const folders = await deploy(w);
  refusedWith(folders, 'ERRO E_HOST_FOLDERS');
  assert.equal(folders.outcome.exitCode, 53);
  const call = folders.runner.calls.find((item) => typeof item.program !== 'string');
  assert.deepEqual(call?.program, { script: w.foldersCheck });
  assert.deepEqual(call?.args, w.dataFolders);
  assert.deepEqual(call?.env, { PATH: '/usr/bin:/bin' });
  assert.ok(!loaded(folders));
  const gone = world();
  fs.rmSync(gone.foldersCheck);
  refusedWith(await deploy(gone), 'ERRO E_HOST_FOLDERS');
  const disk = world({ freeBytes: 10 * 1024 ** 3 - 1 });
  const low = await deploy(disk);
  refusedWith(low, 'ERRO E_DISK_LOW');
  assert.equal(low.outcome.exitCode, 57);
  assert.ok(!loaded(low));
  assert.equal((await deploy(world({ freeBytes: 10 * 1024 ** 3 }))).outcome.exitCode, 0, 'exatamente 10 GiB passa (pacote pequeno)');
});

test('P9-D06 réplicas do Worker diferentes do arquivo ⇒ E_WORKER_REPLICAS_DRIFT, sem docker load nem stack deploy; Worker ausente (primeiro deploy) passa', async () => {
  const w = world();
  w.scenario.services.set('gmn_gmn-worker', baseService('gmn_gmn-worker', 'gmn-worker:anterior', 1));
  const r = await deploy(w);
  refusedWith(r, 'ERRO E_WORKER_REPLICAS_DRIFT');
  assert.equal(r.outcome.exitCode, 56);
  assert.ok(!loaded(r) && !stackDeployed(r));
  const aligned = world();
  aligned.scenario.services.set('gmn_gmn-worker', baseService('gmn_gmn-worker', 'gmn-worker:anterior', 0));
  assert.equal((await deploy(aligned)).outcome.exitCode, 0);
});

test('§5.6: até o passo 8 o Docker só é CONSULTADO (service inspect, info) e o pacote só é LISTADO (tar -tvzf); a leitura e a carga vêm no passo 9, depois de todas as conferências', async () => {
  const w = world();
  const r = await deploy(w);
  assert.equal(r.outcome.exitCode, 0, String(r.outcome.stderr));
  const calls = r.runner.calls.map((call) => (typeof call.program === 'string' ? [call.program, ...call.args.slice(0, 2)].join(' ') : 'folders-check'));
  const firstLoadStep = calls.findIndex((call) => call.startsWith('gzip'));
  assert.ok(firstLoadStep > 0);
  for (const call of calls.slice(0, firstLoadStep)) assert.match(call, /^(docker service inspect|docker info|folders-check|tar -tvzf)/, call);
  const listedAt = calls.indexOf(`tar -tvzf ${bundlePath(w)}`);
  assert.ok(listedAt >= 0 && listedAt < calls.findIndex((call) => call.startsWith('docker info')), 'a listagem do pacote vem antes do espaço livre (que usa o total descompactado)');
  assert.deepEqual(calls.slice(firstLoadStep, firstLoadStep + 3), ['gzip -t ' + bundlePath(w), `tar -xzOf ${bundlePath(w)}`, 'docker load -i']);
});

/* ===================================================================================================================== passo 9 */

test('P9-D07 pacote com tag de outro ambiente, de outro commit, imagem a mais ou a menos, gzip ou manifest ilegível ⇒ E_BUNDLE_TAGS, sem docker load', async () => {
  const tag = `producao-${SHA40}`;
  const manifests: ReadonlyArray<readonly [string, string]> = [
    ['outro ambiente', manifestFor(`homologacao-${SHA40}`)],
    ['outro commit', manifestFor(`producao-${OTHER_SHA40}`)],
    ['web de outro commit só', manifestFor(tag, { web: `gmn-web:producao-${OTHER_SHA40}` })],
    ['imagem a mais', manifestFor(tag, { extra: true })],
    ['imagem a menos', manifestFor(tag, { drop: true })],
    ['tag duplicada', manifestFor(tag, { worker: `gmn-web:${tag}` })],
    ['duas tags numa imagem', JSON.stringify([{ Config: `${'c'.repeat(64)}.json`, RepoTags: [`gmn-web:${tag}`, 'gmn-web:latest'], Layers: [] }, { Config: `${'d'.repeat(64)}.json`, RepoTags: [`gmn-worker:${tag}`], Layers: [] }])],
    ['sem tag', JSON.stringify([{ Config: `${'c'.repeat(64)}.json`, RepoTags: null, Layers: [] }, { Config: `${'d'.repeat(64)}.json`, RepoTags: [`gmn-worker:${tag}`], Layers: [] }])],
    ['Config fora do formato', manifestFor(tag).replace(WEB_CONFIG_PATH, '../../etc/passwd')],
    ['Config com caminho de outro formato', manifestFor(tag).replace(WEB_CONFIG_PATH, `sha256/${CONFIG_DIGEST_WEB}`)],
    ['não JSON', `${manifestFor(tag)}${manifestFor(tag)}`],
  ];
  for (const [label, manifest] of manifests) {
    const w = world();
    w.scenario.manifest = manifest;
    const r = await deploy(w);
    refusedWith(r, 'ERRO E_BUNDLE_TAGS');
    assert.equal(r.outcome.exitCode, 58, label);
    assert.ok(!loaded(r), `${label}: sem docker load`);
  }
  for (const flag of ['gzipOk', 'tarOk'] as const) {
    const w = world();
    w.scenario[flag] = false;
    const r = await deploy(w);
    refusedWith(r, 'ERRO E_BUNDLE_TAGS');
    assert.ok(!loaded(r), flag);
  }
});

test('revisão do PR #70 (item 8): antes de qualquer carga, a listagem do pacote (tar -tvzf) recusa caminho absoluto, .., link simbólico, link físico, dispositivo, FIFO, nome inesperado, pasta sem barra, membro repetido e expansão acima de 8 GiB; camada ou Config do manifesto fora da gramática ou fora da listagem ⇒ E_BUNDLE_TAGS sem docker load', async () => {
  const tag = `producao-${SHA40}`;
  const base = (w: World): string => listingFor(w.scenario.manifest, w.scenario.configs);
  const hex = 'a'.repeat(64);
  const listings: ReadonlyArray<readonly [string, (w: World) => string]> = [
    ['caminho absoluto', (w) => `${base(w)}${listLine('-', 10, '/etc/cron.d/x')}\n`],
    ['..', (w) => `${base(w)}${listLine('-', 10, `blobs/sha256/../../${hex}`)}\n`],
    ['.. no começo', (w) => `${base(w)}${listLine('-', 10, '../manifest.json')}\n`],
    ['link simbólico', (w) => `${base(w)}lrwxrwxrwx 0/0            0 1970-01-01 00:00 blobs/sha256/${hex} -> /etc/shadow\n`],
    ['link simbólico com nome aceito', (w) => `${base(w)}${listLine('l', 0, `blobs/sha256/${hex}`)}\n`],
    ['link físico', (w) => `${base(w)}hrw-r--r-- 0/0            0 1970-01-01 00:00 blobs/sha256/${hex} link to manifest.json\n`],
    ['dispositivo', (w) => `${base(w)}${listLine('c', 0, `blobs/sha256/${hex}`)}\n`],
    ['FIFO', (w) => `${base(w)}${listLine('p', 0, `blobs/sha256/${hex}`)}\n`],
    ['nome inesperado', (w) => `${base(w)}${listLine('-', 10, 'run.sh')}\n`],
    ['pasta sem barra', (w) => `${base(w)}${listLine('d', 0, hex)}\n`],
    ['arquivo com nome de pasta', (w) => `${base(w)}${listLine('-', 10, 'blobs/')}\n`],
    ['membro repetido', (w) => `${base(w)}${listLine('-', 10, 'manifest.json')}\n`],
    ['expansão acima de 8 GiB', (w) => `${base(w)}${listLine('-', 8 * 1024 ** 3, `blobs/sha256/${hex}`)}\n`],
    ['linha fora do formato', (w) => `${base(w)}lixo sem formato\n`],
    ['vazio', () => ''],
  ];
  for (const [label, listing] of listings) {
    const w = world();
    w.scenario.listing = listing(w);
    const r = await deploy(w);
    refusedWith(r, 'ERRO E_BUNDLE_TAGS');
    assert.ok(!loaded(r) && !r.runner.called(['info']), `${label}: nem docker load nem o espaço livre`);
  }
  const manifests: ReadonlyArray<readonly [string, (w: World) => void]> = [
    ['camada fora da gramática', (w) => void (w.scenario.manifest = manifestFor(tag).replace(`blobs/sha256/${'1'.repeat(64)}`, '../../etc/passwd'))],
    ['camada que não está no tar', (w) => {
      w.scenario.listing = listingFor(w.scenario.manifest, w.scenario.configs).split('\n').filter((line) => !line.endsWith(`blobs/sha256/${'2'.repeat(64)}`)).join('\n');
    }],
    ['Config que não está no tar', (w) => {
      w.scenario.listing = listingFor(w.scenario.manifest, w.scenario.configs).split('\n').filter((line) => !line.endsWith(WORKER_CONFIG_PATH)).join('\n');
    }],
    ['imagem sem camadas', (w) => void (w.scenario.manifest = JSON.stringify((JSON.parse(manifestFor(tag)) as Array<Record<string, unknown>>).map((entry, index) => (index === 0 ? { ...entry, Layers: [] } : entry))))],
  ];
  for (const [label, breaker] of manifests) {
    const w = world();
    breaker(w);
    const r = await deploy(w);
    refusedWith(r, 'ERRO E_BUNDLE_TAGS');
    assert.ok(!loaded(r), `${label}: sem docker load`);
  }
});

test('revisão do PR #70 (item 8): o espaço livre do passo 8 usa o total DESCOMPACTADO da listagem (≥ max(10 GiB, 2 × total))', async () => {
  const big = (w: World): string => `${listingFor(w.scenario.manifest, w.scenario.configs)}${listLine('-', 6 * 1024 ** 3, `blobs/sha256/${'b'.repeat(64)}`)}\n`;
  const low = world({ freeBytes: 12 * 1024 ** 3 });
  low.scenario.listing = big(low);
  refusedWith(await deploy(low), 'ERRO E_DISK_LOW');
  const enough = world({ freeBytes: 13 * 1024 ** 3 });
  enough.scenario.listing = big(enough);
  const ok = await deploy(enough);
  assert.equal(ok.outcome.exitCode, 0, String(ok.outcome.stderr));
});

test('passo 9: docker load que falha, imagem que não aparece depois do load, ou id ≠ digest do Config com camadas diferentes ⇒ E_DOCKER_LOAD, sem stack deploy nem lista instalada', async () => {
  const failed = world();
  failed.scenario.loadOk = false;
  const r = await deploy(failed);
  refusedWith(r, 'ERRO E_DOCKER_LOAD');
  assert.equal(r.outcome.exitCode, 59);
  assert.ok(!stackDeployed(r));
  const missing = world();
  missing.scenario.loadedImages.delete(`gmn-web:producao-${SHA40}`);
  refusedWith(await deploy(missing), 'ERRO E_DOCKER_LOAD');
  const otherId = world();
  otherId.scenario.loadedImages.set(`gmn-worker:producao-${SHA40}`, { Id: `sha256:${'9'.repeat(64)}`, RepoTags: [`gmn-worker:producao-${SHA40}`], Layers: [`sha256:${'8'.repeat(64)}`] });
  const wrong = await deploy(otherId);
  refusedWith(wrong, 'ERRO E_DOCKER_LOAD');
  assert.ok(!stackDeployed(wrong));
  assert.ok(!fs.existsSync(installedPath(otherId)));
});

const tarMembers = (r: Run): string[] => r.runner.calls.filter((call) => call.program === 'tar' && call.args[0] === '-xzOf').map((call) => call.args[2] as string);

test('passo 9, armazenamento CLÁSSICO: id da tag = sha256 do Config ⇒ aceito sem ler o Config do pacote (só o manifest.json)', async () => {
  const w = world();
  const r = await deploy(w);
  assert.match(r.outcome.stdout ?? String(r.outcome.stderr), new RegExp(`^OK DEPLOYED producao-${SHA40} sha256:${CONFIG_DIGEST_WEB} sha256:${CONFIG_DIGEST_WORKER} `));
  assert.deepEqual(tarMembers(r), ['manifest.json']);
  assert.ok(r.log.entries.some((entry) => entry.event === 'bundle.loaded' && entry.fields.webVerification === 'config-digest' && entry.fields.workerVerification === 'config-digest'));
});

test('passo 9, armazenamento CONTAINERD (id = digest do manifesto): tag exata, Config do pacote íntegro e diff_ids iguais ⇒ aceito, e o OK DEPLOYED leva os ids do containerd', async () => {
  for (const env of ['producao', 'homologacao'] as const) {
    const w = world({ env });
    w.scenario.loadedImages = containerdImages(`${env}-${SHA40}`);
    const r = await deploy(w);
    assert.equal(r.outcome.exitCode, 0, String(r.outcome.stderr));
    assert.match(r.outcome.stdout ?? '', new RegExp(`^OK DEPLOYED ${env}-${SHA40} ${CONTAINERD_ID_WEB} ${CONTAINERD_ID_WORKER} `));
    assert.deepEqual(tarMembers(r), ['manifest.json', WEB_CONFIG_PATH, WORKER_CONFIG_PATH], 'o Config de cada imagem lido do pacote pelo caminho do manifesto');
    for (const call of r.runner.calls.filter((item) => item.program === 'tar')) assert.ok(['-xzOf', '-tvzf'].includes(call.args[0] as string), 'só listagem e leitura para o stdout, nada extraído');
    assert.ok(r.log.entries.some((entry) => entry.event === 'bundle.loaded' && entry.fields.webVerification === 'diff-ids' && entry.fields.workerVerification === 'diff-ids'));
  }
});

test('passo 9, armazenamento CONTAINERD, divergências ⇒ E_DOCKER_LOAD (sem stack deploy, lista não instalada): camadas a mais, a menos ou em outra ordem; tag a mais, ausente ou outra; Config do pacote alterado, ausente ou sem rootfs', async () => {
  const tag = `producao-${SHA40}`;
  const web = `gmn-web:${tag}`;
  type Breaker = (w: World) => void;
  const setWeb = (w: World, over: Partial<LoadedImage>): void => void w.scenario.loadedImages.set(web, { ...(w.scenario.loadedImages.get(web) as LoadedImage), ...over });
  const cases: ReadonlyArray<readonly [string, Breaker]> = [
    ['camada a mais', (w) => setWeb(w, { Layers: [...WEB_DIFF_IDS, `sha256:${'4'.repeat(64)}`] })],
    ['camada a menos', (w) => setWeb(w, { Layers: WEB_DIFF_IDS.slice(0, 1) })],
    ['camadas em outra ordem', (w) => setWeb(w, { Layers: [...WEB_DIFF_IDS].reverse() })],
    ['sem camadas', (w) => setWeb(w, { Layers: [] })],
    ['tag a mais', (w) => setWeb(w, { RepoTags: [web, 'gmn-web:latest'] })],
    ['sem tag', (w) => setWeb(w, { RepoTags: null })],
    ['outra tag', (w) => setWeb(w, { RepoTags: [`gmn-web:producao-${OTHER_SHA40}`] })],
    ['Config do pacote com outros bytes', (w) => void w.scenario.configs.set(WEB_CONFIG_PATH, Buffer.concat([WEB_CONFIG, Buffer.from(' ')]))],
    ['Config ausente do pacote', (w) => void w.scenario.configs.delete(WORKER_CONFIG_PATH)],
    ['Config sem rootfs', (w) => {
      const bare = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux' }));
      w.scenario.manifest = manifestFor(tag).replace(WEB_CONFIG_PATH, `blobs/sha256/${sha256(bare)}`);
      w.scenario.configs.set(`blobs/sha256/${sha256(bare)}`, bare);
    }],
  ];
  for (const [label, breaker] of cases) {
    const w = world();
    w.scenario.loadedImages = containerdImages(tag);
    breaker(w);
    const r = await deploy(w);
    refusedWith(r, 'ERRO E_DOCKER_LOAD');
    assert.ok(!stackDeployed(r), `${label}: sem stack deploy`);
    assert.ok(!fs.existsSync(installedPath(w)), `${label}: lista não instalada`);
  }
});

/* ===================================================================================================================== passos 10 a 12 */

test('P9-D08 argv exato: stack config e stack deploy com os -c das CÓPIAS PRIVADAS dos bytes conferidos, --resolve-image never, o nome da stack do wrapper, sem --prune; GMN_IMAGE_TAG e a lista no AMBIENTE do filho, nunca na linha de comando', async () => {
  for (const env of ['producao', 'homologacao'] as const) {
    const w = world({ env });
    const r = await deploy(w);
    assert.equal(r.outcome.exitCode, 0, String(r.outcome.stderr));
    const config = r.runner.calls.find((call) => call.args[0] === 'stack' && call.args[1] === 'config');
    const deployed = r.runner.calls.find((call) => call.args[0] === 'stack' && call.args[1] === 'deploy');
    const compose = (config?.args ?? []).slice(2);
    const names = env === 'producao' ? ['stack.yml'] : ['stack.yml', 'stack-hml.yml'];
    assert.equal(compose.length, names.length * 2);
    compose.forEach((arg, index) => {
      if (index % 2 === 0) assert.equal(arg, '-c');
      else assert.match(arg, new RegExp(`^${w.stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.stack-[0-9a-f]+/${names[(index - 1) / 2]?.replace('.', '\\.')}$`));
    });
    assert.deepEqual(deployed?.args, ['stack', 'deploy', '--resolve-image', 'never', ...compose, w.stackName]);
    assert.ok(!r.runner.dockerCalls().some((args) => args.includes('--prune')));
    for (const call of [config, deployed]) {
      assert.equal(call?.env.GMN_IMAGE_TAG, `${env}-${SHA40}`);
      assert.equal(call?.env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS, w.trust.toString('ascii').slice(0, -1).split('\n').join(','));
      assert.equal(call?.env.NEXT_PUBLIC_SUPABASE_URL, SENTINEL_URL, 'o arquivo do host vai no ambiente, sem expansão nem aspas');
      assert.equal(call?.env.GMN_OPERATOR_EMAILS, SENTINEL_EMAIL);
      assert.equal(call?.env.PATH, '/usr/bin:/bin');
      assert.ok(!call?.args.some((arg) => arg.includes(SHA40) || arg.includes(w.keys.a.pub) || arg.includes(SENTINEL_URL)), 'nada disso na linha de comando');
    }
    const queries = r.runner.calls.filter((call) => call.program === 'docker' && !(call.args[0] === 'stack'));
    for (const call of queries) assert.deepEqual(call.env, { PATH: '/usr/bin:/bin' }, `consulta só com PATH: ${call.args.join(' ')}`);
  }
});

test('revisão do PR #70 (item 3): os dois docker stack recebem cópias PRIVADAS (pasta 0700 do estado, arquivos 0600) dos bytes conferidos no passo 2; trocar a stack instalada depois da conferência não muda o que é implantado; as cópias somem no fim (sucesso e falha)', async () => {
  const w = world({ env: 'homologacao' });
  const verified = fs.readFileSync(w.stackFile);
  const verifiedOverlay = fs.readFileSync(w.overlayFile as string);
  const modes: string[] = [];
  w.scenario.beforeCall = (request) => {
    // depois do passo 2 (a primeira consulta ao Docker é o passo 7): o arquivo instalado vira outro
    if (request.program === 'docker' && request.args[0] === 'service' && request.args[1] === 'inspect') {
      fs.writeFileSync(w.stackFile, 'services: { atacante: { image: alpine } }\n');
      fs.writeFileSync(w.overlayFile as string, 'services: {}\n');
    }
    if (request.program === 'docker' && request.args[0] === 'stack') {
      const file = request.args[request.args.indexOf('-c') + 1] as string;
      modes.push(`${(fs.statSync(path.dirname(file)).mode & 0o777).toString(8)} ${(fs.statSync(file).mode & 0o777).toString(8)}`);
    }
  };
  const r = await deploy(w);
  assert.equal(r.outcome.exitCode, 0, String(r.outcome.stderr));
  assert.equal(r.runner.composeCalls.length, 2);
  for (const call of r.runner.composeCalls) {
    assert.deepEqual(call.files.map((file) => file.bytes), [verified, verifiedOverlay], `${call.sub}: os bytes conferidos, não os do arquivo trocado`);
    for (const file of call.files) assert.ok(!fs.existsSync(path.dirname(file.path)), `${call.sub}: a pasta privada foi apagada`);
  }
  assert.deepEqual(modes, ['700 600', '700 600']);
  const failing = world();
  failing.scenario.stackDeployOk = false;
  refusedWith(await deploy(failing), 'ERRO E_STACK_DEPLOY');
  assert.deepEqual(fs.readdirSync(failing.stateDir).filter((name) => name.startsWith('.stack-')), [], 'sem cópia sobrando na falha');
  const stale = world();
  fs.mkdirSync(path.join(stale.stateDir, '.stack-00000000deadbeef'), { mode: 0o700 });
  fs.writeFileSync(path.join(stale.stateDir, '.stack-00000000deadbeef', 'stack.yml'), 'velha');
  fs.writeFileSync(path.join(stale.stateDir, 'nao-e-do-receptor'), 'fica');
  assert.equal((await deploy(stale)).outcome.exitCode, 0);
  assert.deepEqual(fs.readdirSync(stale.stateDir).sort(), ['incoming', 'nao-e-do-receptor', 'trust-keys.txt'], 'cópia velha de um receptor morto apagada; o resto fica');
});

test('revisão do PR #70 (item 9): o filho docker stack recebe SÓ as variáveis que a stack conferida interpola (definidas no arquivo do host), a tag, a lista e o PATH fixo — nada além (GODEBUG, variável não usada)', async () => {
  const w = world({ env: 'homologacao' });
  fs.appendFileSync(w.hostVarsFile, 'GODEBUG=x509ignoreCN=0\nGMN_NAO_USADA_NA_STACK=1\nSUPABASE_PRIVATE_AUDIT_BUCKET=balde-ficticio\n');
  const r = await deploy(w);
  assert.equal(r.outcome.exitCode, 0, String(r.outcome.stderr));
  const expectedKeys = ['GMN_DATA_ROOT', 'GMN_HOST', 'GMN_HTTP_ENTRYPOINT', 'GMN_IMAGE_TAG', 'GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS', 'GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS', 'GMN_NODE_HOSTNAME', 'GMN_OPERATOR_EMAILS', 'GMN_RAIZ_DADOS_DECISOES', 'GMN_RAIZ_DADOS_LIVRO', 'GMN_RAIZ_DADOS_MANIFESTOS', 'GMN_RAIZ_DADOS_RECIBOS_DECISOES', 'GMN_RAIZ_DADOS_RECIBOS_RESULTADOS', 'GMN_RAIZ_DADOS_RESULTADOS', 'GMN_TRAEFIK_NAME', 'GMN_WORKER_REPLICAS', 'NEXT_PUBLIC_SUPABASE_URL', 'PATH', 'SUPABASE_PRIVATE_AUDIT_BUCKET'];
  for (const call of r.runner.calls.filter((item) => item.program === 'docker' && item.args[0] === 'stack')) {
    assert.deepEqual(Object.keys(call.env).sort(), expectedKeys, call.args[1]);
    assert.equal(call.env.PATH, '/usr/bin:/bin');
  }
});

test('revisão do PR #70 (item 7): em homologação, TODA origem de bind efetiva da stack conferida fica sob o prefixo pelo caminho real, inclusive as derivadas de GMN_DATA_ROOT; um link numa pasta derivada (redis, audits…) apontando para fora ⇒ E_DATA_PREFIX sem chamar o Docker', async () => {
  for (const derived of DERIVED_BIND_FOLDERS) {
    const w = world({ env: 'homologacao' });
    const dataRoot = (w.dataPrefix as string).slice(0, -1);
    const outside = fs.mkdtempSync(path.join(w.root, 'fora-'));
    fs.rmSync(path.join(dataRoot, derived), { recursive: true });
    fs.symlinkSync(outside, path.join(dataRoot, derived));
    const r = await deploy(w);
    refusedWith(r, 'ERRO E_DATA_PREFIX');
    assert.equal(r.runner.calls.length, 0, derived);
  }
  const missing = world({ env: 'homologacao' });
  fs.rmSync(path.join((missing.dataPrefix as string).slice(0, -1), 'redis'), { recursive: true });
  refusedWith(await deploy(missing), 'ERRO E_DATA_PREFIX');
  const production = world();
  const prodRoot = path.dirname(production.dataFolders[0] as string);
  fs.rmSync(path.join(prodRoot, 'redis'), { recursive: true });
  fs.symlinkSync(fs.mkdtempSync(path.join(production.root, 'fora-')), path.join(prodRoot, 'redis'));
  assert.equal((await deploy(production)).outcome.exitCode, 0, 'em produção não há prefixo a conferir');
});

test('passos 10 e 11: docker stack config recusado ⇒ E_STACK_CONFIG (sem stack deploy); stack deploy que falha ⇒ E_STACK_DEPLOY; lista não instalada', async () => {
  const config = world();
  config.scenario.stackConfigOk = false;
  const r = await deploy(config);
  refusedWith(r, 'ERRO E_STACK_CONFIG');
  assert.equal(r.outcome.exitCode, 60);
  assert.ok(!stackDeployed(r));
  const deployFails = world();
  deployFails.scenario.stackDeployOk = false;
  const d = await deploy(deployFails);
  refusedWith(d, 'ERRO E_STACK_DEPLOY');
  assert.equal(d.outcome.exitCode, 61);
  assert.ok(!fs.existsSync(installedPath(deployFails)));
});

test('P9-D09 convergência em rollback_completed (ou rollback_started) ⇒ E_ROLLED_BACK, a lista NÃO é instalada (a anterior fica) e o pacote fica', async () => {
  for (const states of [['updating', 'rollback_started', 'rollback_completed'], ['rollback_completed']]) {
    const before = trustFile([trustLine(testKey('chave-prod-a'))]);
    const w = world({ installed: before });
    w.trust = trustFile([before.toString('ascii').trim(), trustLine(testKey('chave-prod-b'))]);
    w.scenario.updateStates = states;
    const r = await deploy(w);
    refusedWith(r, 'ERRO E_ROLLED_BACK');
    assert.equal(r.outcome.exitCode, 62);
    assert.deepEqual(fs.readFileSync(installedPath(w)), before, 'a lista anterior continua instalada');
    assert.ok(fs.existsSync(bundlePath(w)));
    assert.ok(!r.runner.dockerCalls().some((args) => args.includes('rollback')), 'o receptor nunca faz rollback');
  }
});

test('passo 12: um rollback_completed ANTIGO (de antes do deploy) não vira E_ROLLED_BACK; serviço criado agora (sem UpdateStatus) converge pelas tarefas; prazo de 10 min (inclusive tarefas que nunca rodam a tag nova) ⇒ E_CONVERGE_TIMEOUT sem instalar', async () => {
  const stale = world();
  stale.scenario.services.set('gmn_gmn-web', { ...baseService('gmn_gmn-web', 'gmn-web:anterior', 1), UpdateStatus: { State: 'rollback_completed', StartedAt: '2026-11-01T00:00:00Z' } });
  stale.scenario.updateStates = ['stale', 'stale', 'updating', 'completed'];
  const r = await deploy(stale);
  assert.equal(r.outcome.exitCode, 0, String(r.outcome.stderr));
  const created = world();
  created.scenario.updateStates = ['none'];
  assert.equal((await deploy(created)).outcome.exitCode, 0);
  const slow = world();
  slow.scenario.updateStates = ['updating'];
  const timeout = await deploy(slow);
  refusedWith(timeout, 'ERRO E_CONVERGE_TIMEOUT');
  assert.equal(timeout.outcome.exitCode, 63);
  assert.ok(timeout.clock.slept >= 10 * 60_000, 'esperou o prazo inteiro');
  assert.ok(!fs.existsSync(installedPath(slow)));
  const paused = world();
  paused.scenario.updateStates = ['updating', 'paused'];
  refusedWith(await deploy(paused), 'ERRO E_CONVERGE_TIMEOUT');
  const otherImage = world();
  otherImage.scenario.afterDeploy = (services) => void (services.get('gmn_gmn-web')!.Spec.TaskTemplate.ContainerSpec.Image = 'gmn-web:latest');
  refusedWith(await deploy(otherImage), 'ERRO E_CONVERGE_TIMEOUT');
});

test('revisão do PR #70 (item 4a): com a especificação mudada pelo deploy, só vale um estado TERMINAL completed da atualização começada por ESTE deploy — updating (mesmo com as tarefas já na imagem nova) ou um UpdateStatus anterior (updating ou completed) nunca valem ⇒ E_CONVERGE_TIMEOUT', async () => {
  const cases: ReadonlyArray<readonly [string, string, string[]]> = [
    ['retomada durante um updating anterior', 'updating', ['stale-new-image']],
    ['completed anterior com as tarefas já na imagem nova', 'completed', ['stale-new-image']],
    ['updating novo com as tarefas já na imagem nova', 'completed', ['updating-new-image']],
    ['paused novo', 'completed', ['updating-new-image', 'paused']],
  ];
  for (const [label, previousState, states] of cases) {
    const w = world();
    w.scenario.services.set('gmn_gmn-web', { ...baseService('gmn_gmn-web', 'gmn-web:anterior', 1), UpdateStatus: { State: previousState, StartedAt: '2026-11-01T00:00:00Z' } });
    w.scenario.updateStates = states;
    const r = await deploy(w);
    refusedWith(r, 'ERRO E_CONVERGE_TIMEOUT');
    assert.ok(!fs.existsSync(installedPath(w)), `${label}: lista não instalada`);
  }
  const resumed = world();
  resumed.scenario.services.set('gmn_gmn-web', { ...baseService('gmn_gmn-web', 'gmn-web:anterior', 1), UpdateStatus: { State: 'updating', StartedAt: '2026-11-01T00:00:00Z' } });
  resumed.scenario.updateStates = ['stale-new-image', 'updating-new-image', 'completed'];
  assert.equal((await deploy(resumed)).outcome.exitCode, 0, 'só depois do completed da atualização nova');
});

test('revisão do PR #70 (item 4a): especificação igual (o mesmo commit de novo): não há atualização a esperar; com as tarefas no id carregado, converge mesmo com o UpdateStatus antigo', async () => {
  const w = world();
  const value = w.trust.toString('ascii').slice(0, -1).split('\n').join(',');
  w.scenario.services.set('gmn_gmn-web', { ...baseService('gmn_gmn-web', `gmn-web:producao-${SHA40}`, 1, { Env: [`GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS=${value}`] }), UpdateStatus: { State: 'completed', StartedAt: '2026-11-01T00:00:00Z' } });
  w.scenario.specUnchanged = true;
  w.scenario.updateStates = ['stale-new-image'];
  const r = await deploy(w);
  assert.equal(r.outcome.exitCode, 0, String(r.outcome.stderr));
});

test('revisão do PR #70 (item 4b): a mesma TAG com outro id de imagem no contêiner das tarefas não conta como convergência (web ⇒ E_CONVERGE_TIMEOUT) nem passa no PD-06 (Worker ligado ⇒ E_POSTDEPLOY_CHECK PD-06); a identidade vem do contêiner de cada tarefa', async () => {
  const web = world();
  web.scenario.runningImageIds = new Map([['gmn_gmn-web', `sha256:${'7'.repeat(64)}`]]);
  refusedWith(await deploy(web), 'ERRO E_CONVERGE_TIMEOUT');
  const worker = world();
  fs.writeFileSync(worker.hostVarsFile, fs.readFileSync(worker.hostVarsFile, 'utf8').replace('GMN_WORKER_REPLICAS=0', 'GMN_WORKER_REPLICAS=1'));
  worker.scenario.runningImageIds = new Map([['gmn_gmn-worker', `sha256:${'7'.repeat(64)}`]]);
  refusedWith(await deploy(worker), 'ERRO E_POSTDEPLOY_CHECK PD-06');
  const workerOk = world();
  fs.writeFileSync(workerOk.hostVarsFile, fs.readFileSync(workerOk.hostVarsFile, 'utf8').replace('GMN_WORKER_REPLICAS=0', 'GMN_WORKER_REPLICAS=1'));
  const ok = await deploy(workerOk);
  assert.equal(ok.outcome.exitCode, 0, String(ok.outcome.stderr));
  const identity = ok.runner.dockerCalls().filter((args) => args[0] === 'inspect' && args[1] === '--type');
  assert.ok(identity.some((args) => args[2] === 'task') && identity.some((args) => args[2] === 'container'), 'tarefa ⇒ contêiner ⇒ id da imagem');
});

/* ===================================================================================================================== passo 13 */

test('P9-D10 cada PD-01 a PD-08 reprovado ⇒ E_POSTDEPLOY_CHECK <PD-xx> (saída 64), e a lista não é instalada', async () => {
  type Breaker = (services: Map<string, import('./helpers/deploy-receiver-fakes').FakeService>, w: World) => void;
  const web = (w: World) => `${w.stackName}_gmn-web`;
  const worker = (w: World) => `${w.stackName}_gmn-worker`;
  const cases: ReadonlyArray<readonly [string, 'producao' | 'homologacao', Breaker]> = [
    ['PD-01', 'producao', (s, w) => void ((s.get(web(w)) as { running: string }).running = 'down')],
    ['PD-02', 'producao', (s, w) => void ((s.get(`${w.stackName}_gmn-redis`) as { running: string }).running = 'down')],
    ['PD-03', 'producao', (s, w) => void (s.get(worker(w))!.Spec.Mode = { Replicated: { Replicas: 2 } })],
    ['PD-03', 'homologacao', (s, w) => void (s.get(worker(w))!.Spec.Mode = { Replicated: { Replicas: 1 } })],
    ['PD-04', 'producao', (s, w) => void (s.get(web(w))!.Spec.EndpointSpec = { Ports: [{ PublishedPort: 3000 }] })],
    ['PD-04', 'producao', (s, w) => void (s.get(`${w.stackName}_gmn-redis`)!.Endpoint = { Ports: [{ PublishedPort: 6379 }] })],
    ['PD-05', 'producao', (s, w) => void s.get(worker(w))!.Spec.TaskTemplate.ContainerSpec.Mounts!.push({ Type: 'bind', Target: '/data/decisions' })],
    ['PD-05', 'producao', (s, w) => void (s.get(worker(w))!.Spec.TaskTemplate.ContainerSpec.Mounts = [{ Type: 'tmpfs', Target: '/tmp' }])],
    ['PD-06', 'producao', (s, w) => void (s.get(worker(w))!.Spec.TaskTemplate.ContainerSpec.Image = `gmn-worker:producao-${OTHER_SHA40}`)],
    ['PD-07', 'producao', (s, w) => void (s.get(web(w))!.Spec.TaskTemplate.ContainerSpec.Env = ['GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS=outra'])],
    ['PD-07', 'producao', (s, w) => void (s.get(web(w))!.Spec.TaskTemplate.ContainerSpec.Env = [])],
    ['PD-08', 'producao', (s, w) => void s.get(web(w))!.Spec.TaskTemplate.ContainerSpec.Env!.push('GMN_LINK_AUDIT_HOMOLOGATION=1')],
    ['PD-08', 'homologacao', (s, w) => void (s.get(web(w))!.Spec.TaskTemplate.ContainerSpec.Env = s.get(web(w))!.Spec.TaskTemplate.ContainerSpec.Env!.filter((entry) => !entry.startsWith('GMN_LINK_AUDIT_HOMOLOGATION=')))],
    ['PD-08', 'homologacao', (s, w) => void (s.get(web(w))!.Spec.TaskTemplate.ContainerSpec.Env = [...s.get(web(w))!.Spec.TaskTemplate.ContainerSpec.Env!.filter((entry) => !entry.startsWith('GMN_LINK_AUDIT_HOMOLOGATION=')), 'GMN_LINK_AUDIT_HOMOLOGATION=true'])],
  ];
  for (const [id, env, breaker] of cases) {
    const w = world({ env });
    w.scenario.afterDeploy = (services) => breaker(services, w);
    const r = await deploy(w);
    refusedWith(r, `ERRO E_POSTDEPLOY_CHECK ${id}`);
    assert.equal(r.outcome.exitCode, 64, id);
    assert.ok(!fs.existsSync(installedPath(w)), `${id}: lista não instalada`);
  }
  const listFails = world();
  listFails.scenario.afterDeploy = () => {
    listFails.scenario.serviceLsFails = true;
  };
  refusedWith(await deploy(listFails), 'ERRO E_POSTDEPLOY_CHECK PD-01');
});

/* ===================================================================================================================== saída pública */

test('P9-D13 e §5.8: em TODAS as execuções deste arquivo, exatamente uma linha pública da gramática; nenhuma saída do docker, caminho ou valor do arquivo de variáveis chega ao stdout/stderr', () => {
  assert.ok(allRuns.length > 60, `execuções conferidas: ${allRuns.length}`);
  for (const r of allRuns) {
    const text = publicText(r.outcome);
    assert.ok((r.outcome.stdout === null) !== (r.outcome.stderr === null), 'uma linha, num só canal');
    assert.match(text, PUBLIC_LINE);
    assert.ok(!text.includes('\n'));
    for (const forbidden of NEVER_PUBLIC) assert.ok(!text.includes(forbidden), `${forbidden} em ${text}`);
    assert.equal(r.outcome.exitCode === 0, r.outcome.stdout !== null);
  }
  const noisy = allRuns.filter((r) => r.runner.calls.length > 0);
  assert.ok(noisy.length > 20, 'o docker falso (que imprime caminhos) rodou em boa parte delas');
  for (const r of allRuns) {
    const log = r.log.text();
    for (const sentinel of [SENTINEL_URL, SENTINEL_EMAIL, SENTINEL_HOST]) assert.ok(!log.includes(sentinel), `${sentinel} no log local`);
  }
});
