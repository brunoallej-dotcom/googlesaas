import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps, type BytesFsOps } from '../src/lib/link-audit/snapshot-store';
import { computePackageSha256, type CandidatePackage } from '../src/lib/link-audit-attestation';
import { nodeKeyFileOps, type KeyFileOps } from '../src/lib/link-audit-attestation/sign-key';
import { createSealedEvidenceProvenance, parseEvidenceSealV2Text, parseTrustKeyring, sealSha256, type TrustKeyring } from '../src/lib/link-audit-evidence/provenance';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { AUD, cliWorld, CUSTODIAN, FakeTerminal, jsonOut, makePackage, runSign, sealFile, type CliWorld, type SignCliRun, type Typed } from './helpers/link-audit-seal-sign-cli-fixtures';
import { DOSSIER, E1, E2, makeApproval, NOW, RISK_ACCEPTANCE, sha256, writeStation } from './helpers/link-audit-seal-sign-disk-fixtures';

/*
 * P1 W4.4 — o CLI do `sign` (spec §5.5 inteiro, §5.5.1 itens 1, 2 e 8, §8, §8.1; IA-01 e IA-02 (5) na parte do CLI, IA-14, IA-15, IA-16, IA-23).
 * Em processo, com o terminal FALSO das fixtures (o custodiante "digita" a confirmação e a frase), ambiente vazio, relatórios de diagnóstico
 * falsos e a chave de teste gerada em memória, gravada CIFRADA numa pasta temporária. Dados 100% FICTÍCIOS. A custódia do arquivo de chave,
 * as sentinelas da IA-04 e o terminal real (pseudo-terminal) estão em `link-audit-seal-sign-key.test.ts` e `link-audit-seal-sign-pty.test.ts`.
 */
registerCleanup();

type Call = { readonly op: string; readonly args: readonly unknown[] };

/** Espião de um objeto de operações de disco: registra nome e argumentos e delega ao original. */
function spyOps<T extends object>(ops: T): { readonly ops: T; readonly calls: Call[] } {
  const calls: Call[] = [];
  const source = ops as unknown as Record<string, (...args: unknown[]) => unknown>;
  const proxy = Object.fromEntries(Object.keys(source).map((name) => [name, (...args: unknown[]) => (calls.push({ op: name, args }), (source[name] as (...a: unknown[]) => unknown)(...args))]));
  return { ops: proxy as unknown as T, calls };
}
const spyData = (): { readonly ops: BytesFsOps; readonly calls: Call[] } => spyOps<BytesFsOps>(nodeFsOps);
const spyKey = (): { readonly ops: KeyFileOps; readonly calls: Call[] } => spyOps<KeyFileOps>(nodeKeyFileOps);

const sealsIn = (sealsDir: string): string[] => (fs.existsSync(path.join(sealsDir, AUD)) ? fs.readdirSync(path.join(sealsDir, AUD)).sort() : []);
const PASS_PROMPT = /Frase-senha/;
const CONFIRM_PROMPT = /12 primeiros caracteres/;

/** A linha da recusa (as telas da confirmação e da frase, quando houve, vêm antes, na mesma saída de erro). */
const refusalLine = (run: SignCliRun): string => run.err.find((line) => line.startsWith('RECUSADO: ')) ?? '';
/** Recusa do `sign` pelo CLI: código 3, uma linha com o prefixo `RECUSADO:` e o código fixo na seguinte. */
function refusedCli(run: SignCliRun, code: string, label = code): void {
  assert.equal(run.code, 3, `${label}: código de saída 3 (veio ${run.code}): ${run.stderr}`);
  const at = run.err.findIndex((line) => line.startsWith('RECUSADO: '));
  assert.ok(at >= 0, `${label}: prefixo RECUSADO: (${run.stderr})`);
  assert.equal(run.err[at + 1], `Código: ${code}`, `${label}: código ${code} logo depois (${run.stderr})`);
  assert.ok(run.err.slice(0, at).every((line) => /^(Confirmação humana|Digite os|Frase-senha|Aviso \(KDF\))/.test(line)), `${label}: antes da recusa, só as telas do terminal (e o aviso do KDF)`);
}
function usageCli(run: SignCliRun, label: string): void {
  assert.equal(run.code, 1, `${label}: USAGE (veio ${run.code}): ${run.stderr}`);
  assert.ok(run.stderr.includes('Uso: npm run link-audit:seal -- sign'), `${label}: texto de uso do sign`);
}
/** O terminal nunca foi tocado: modo bruto nunca ligado e nada lido. */
function terminalUntouched(run: SignCliRun, label: string): void {
  assert.deepEqual(run.terminal.rawCalls, [], `${label}: modo bruto nunca ligado`);
  assert.equal(run.terminal.reads, 0, `${label}: nada lido do terminal`);
}
/** O terminal voltou ao modo de antes (eco ligado). */
function terminalRestored(run: SignCliRun, label: string): void {
  assert.equal(run.terminal.isRaw, false, `${label}: eco restaurado`);
  if (run.terminal.rawCalls.length > 0) assert.equal(run.terminal.rawCalls.at(-1), false, `${label}: a última mudança restaura o modo`);
}

/** Pacote com o corpo alterado e o hash refeito (o `export` o entregaria assim). */
function rehashed(pkg: CandidatePackage, change: (body: Record<string, unknown>) => Record<string, unknown>): CandidatePackage {
  const { packageSha256: _old, ...body } = pkg;
  const changed = change(body as unknown as Record<string, unknown>);
  return { ...(changed as unknown as CandidatePackage), packageSha256: computePackageSha256(changed) };
}

/* =============================================================================================================== IA-15: parser estrito */

test('IA-15: flag desconhecida, repetida ou sem valor ⇒ USAGE (código 1) antes de ler qualquer arquivo; terminal e chave nem são tocados', async () => {
  const world = cliWorld();
  const base = world.argv();
  const cases: Array<[string, string[]]> = [
    ['desconhecida', [...base, '--foo', 'x']],
    ['repetida (com valor)', [...base, '--audit', AUD]],
    ['repetida (booleana --first)', [...base, '--first']],
    ['repetida (--json)', [...base, '--json', '--json']],
    ['sem valor no fim', [...world.argv({ 'trust-keys': null }), '--trust-keys']],
    ['sem valor (seguida de outra opção)', ['--package', ...world.argv({ package: null })]],
    ['argumento posicional', [...base, 'extra']],
    ['forma --x=valor', [...world.argv({ audit: null }), `--audit=${AUD}`]],
  ];
  for (const [label, argv] of cases) {
    for (const json of [false, true]) {
      const data = spyData();
      const key = spyKey();
      const tokens = json && !argv.includes('--json') ? [...argv, '--json'] : argv;
      const run = await runSign(tokens, { typed: world.typed(), fs: data.ops, keyFs: key.ops });
      assert.equal(run.code, 1, `${label}: código 1`);
      if (tokens.includes('--json')) assert.equal(jsonOut(run).code, 'USAGE', label);
      else usageCli(run, label);
      assert.equal(data.calls.length, 0, `${label}: nenhum arquivo lido`);
      assert.equal(key.calls.length, 0, `${label}: chave nem inspecionada`);
      terminalUntouched(run, label);
    }
  }
  assert.deepEqual(sealsIn(world.sealsDir), []);
});

test('IA-15: obrigatórios e formatos ⇒ USAGE (código 1), sem ecoar valores: --audit, --package, --approval, --dossier, --seals-dir, --expect-seq (1 a 256), --first só com 1, --key-id, --key-source file:, --custodian (rótulo curto) e --trust-keys (lista com estado)', async () => {
  const world = cliWorld();
  const echo = 'VALOR-SENTINELA-ECO';
  const missing = ['audit', 'package', 'approval', 'dossier', 'seals-dir', 'expect-seq', 'key-id', 'key-source', 'custodian', 'trust-keys'];
  const invalid: Array<[string, Record<string, string | null>]> = [
    ['--audit fora do padrão', { audit: `${echo}-MAIUSCULO` }],
    ['--package vazio', { package: '' }],
    ['--expect-seq 0', { 'expect-seq': '0', first: null }],
    ['--expect-seq 257', { 'expect-seq': '257', first: null }],
    ['--expect-seq 01', { 'expect-seq': '01' }],
    ['--expect-seq 1.5', { 'expect-seq': '1.5' }],
    ['--expect-seq texto', { 'expect-seq': echo }],
    ['--first com --expect-seq 2', { 'expect-seq': '2' }],
    ['--key-id curto', { 'key-id': 'k' }],
    ['--key-id com maiúscula', { 'key-id': `${echo}-k` }],
    ['--key-source file: sem caminho', { 'key-source': 'file:' }],
    ['--custodian com e-mail', { custodian: 'custodiante@exemplo.invalid' }],
    ['--custodian com telefone', { custodian: '11 98765 4321' }],
    ['--trust-keys lixo', { 'trust-keys': echo }],
    ['--trust-keys pública curta', { 'trust-keys': `ek-teste-cli-a:${echo}:active` }],
  ];
  const cases: Array<[string, string[]]> = [...missing.map((name): [string, string[]] => [`sem --${name}`, world.argv({ [name]: null })]), ...invalid.map(([label, over]): [string, string[]] => [label, world.argv(over)])];
  for (const [label, argv] of cases) {
    const data = spyData();
    const run = await runSign(argv, { typed: world.typed(), fs: data.ops });
    usageCli(run, label);
    assert.ok(!run.stderr.includes(echo) && !run.stderr.includes('exemplo.invalid') && !run.stderr.includes('98765'), `${label}: valor nunca ecoado`);
    assert.equal(data.calls.length, 0, `${label}: nada lido`);
    terminalUntouched(run, label);
  }
});

test('IA-15: opções com nome de senha, chave, PIN ou segredo ⇒ SECRET_VIA_ARGV_FORBIDDEN (código 3, RECUSADO:), sem ecoar o valor, antes de qualquer outra análise', async () => {
  const world = cliWorld();
  const sentinela = 'valor-secreto-sentinela-9d2e';
  const flags = ['--passphrase', '--password', '--senha', '--frase-senha', '--pin', '--PIN', '--private-key', '--key', '--key-file', '--secret', '--segredo', '--chave', '--token', '--pwd'];
  for (const flag of flags) {
    for (const argv of [[...world.argv(), flag, sentinela], [flag, sentinela], [`${flag}=${sentinela}`, '--foo'], [...world.argv({ audit: null }), flag, sentinela, '--json']]) {
      const data = spyData();
      const key = spyKey();
      const run = await runSign(argv, { typed: world.typed(), fs: data.ops, keyFs: key.ops });
      assert.equal(run.code, 3, `${flag}: código 3`);
      if (argv.includes('--json')) assert.equal(jsonOut(run).code, 'SECRET_VIA_ARGV_FORBIDDEN', flag);
      else refusedCli(run, 'SECRET_VIA_ARGV_FORBIDDEN', flag);
      assert.ok(!run.stdout.includes(sentinela) && !run.stderr.includes(sentinela), `${flag}: valor nunca ecoado`);
      assert.equal(data.calls.length + key.calls.length, 0, `${flag}: nada lido`);
      terminalUntouched(run, flag);
    }
  }
});

test('IA-15: --key-source com o VALOR da chave (PEM, base64, hex) ou fora de file:/external: ⇒ SECRET_VIA_ARGV_FORBIDDEN sem eco; material de chave em QUALQUER argumento também', async () => {
  const world = cliWorld();
  const pem = String(world.key.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const der = world.key.privateKey.export({ format: 'der', type: 'pkcs8' });
  const cases: Array<[string, Record<string, string | null>]> = [
    ['PEM em --key-source', { 'key-source': pem }],
    ['PKCS#8 base64 em --key-source', { 'key-source': der.toString('base64') }],
    ['PKCS#8 hex em --key-source', { 'key-source': der.toString('hex') }],
    ['semente hex em --key-source', { 'key-source': der.subarray(-32).toString('hex') }],
    ['erro de digitação em --key-source (fle:)', { 'key-source': `fle:${world.key.keyPath}` }],
    ['PEM em --custodian', { custodian: pem }],
    ['PKCS#8 base64 em --dossier', { dossier: der.toString('base64') }],
    ['PKCS#8 base64url em --package', { package: der.toString('base64url') }],
  ];
  for (const [label, over] of cases) {
    const key = spyKey();
    const run = await runSign(world.argv(over), { typed: world.typed(), keyFs: key.ops });
    refusedCli(run, 'SECRET_VIA_ARGV_FORBIDDEN', label);
    for (const sentinel of [...world.key.sentinels, der.subarray(-32).toString('hex'), world.key.keyPath]) assert.ok(!run.stdout.includes(sentinel) && !run.stderr.includes(sentinel), `${label}: nada da chave ecoado`);
    assert.equal(key.calls.length, 0, label);
    terminalUntouched(run, label);
  }
});

test('IA-15 (§8.1): variável de ambiente com nome de segredo ⇒ SECRET_VIA_ENV_FORBIDDEN (código 3), lendo só os NOMES (nunca os valores), antes de qualquer arquivo; nomes comuns passam', async () => {
  const world = cliWorld();
  const sentinela = 'valor-de-ambiente-sentinela-41ac';
  const recording = (values: Record<string, string>): { readonly env: Record<string, string>; readonly reads: string[] } => {
    const reads: string[] = [];
    const env = new Proxy(values, { get: (target, prop) => (typeof prop === 'string' && reads.push(prop), Reflect.get(target, prop)) });
    return { env, reads };
  };
  const names = [
    ...['GMN_LINK_AUDIT_SIGN_PASSPHRASE', 'GMN_SEAL_KEY', 'GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS', 'gmn_seal_pin', 'GMN_SECRET', 'GMN_TOKEN_X', 'MY_PASSPHRASE', 'KEY_PASSWORD', 'SENHA_DA_CHAVE', 'LINK_AUDIT_SIGNING_KEY', 'SEAL_PASS'],
    // revisão da W4.4 (MINOR): nomes GENÉRICOS de segredo, sem diferenciar caixa
    ...['PRIVATE_KEY', 'MY_SECRET', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'DB_PASSWD', 'SSH_PASSPHRASE', 'my_privatekey', 'SERVICE_CREDENTIAL', 'SERVICE_API_KEY', 'service_apikey', 'npm_token', 'Client_Secret'],
  ];
  for (const name of names) {
    const { env, reads } = recording({ PATH: '/usr/bin', [name]: sentinela });
    const data = spyData();
    const run = await runSign(world.argv(), { typed: world.typed(), env, fs: data.ops });
    refusedCli(run, 'SECRET_VIA_ENV_FORBIDDEN', name);
    assert.ok(run.stderr.includes(name), `${name}: o NOME (não secreto) é citado para o custodiante limpar o ambiente`);
    assert.ok(!run.stdout.includes(sentinela) && !run.stderr.includes(sentinela), `${name}: valor nunca ecoado`);
    assert.deepEqual(reads, [], `${name}: nenhum VALOR de variável lido`);
    assert.equal(data.calls.length, 0, `${name}: nada lido`);
    terminalUntouched(run, name);
  }
  const benign = recording({ PATH: '/usr/bin', HOME: '/home/custodiante', LANG: 'pt_BR.UTF-8', GIT_ASKPASS: 'x', SSH_AUTH_SOCK: 'x', npm_config_cache: 'x', TERM: 'xterm', KEYBOARD_LAYOUT: 'br', XDG_SESSION_TYPE: 'tty', SHELL: '/bin/bash', USER: 'custodiante' });
  const run = await runSign(world.argv(), { typed: world.typed(), env: benign.env });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(benign.reads, [], 'com as pastas temporárias injetadas, nenhum valor de ambiente é lido');
});

test('§5.5.1 item 1: --key-source external:<id> (K2) com id público válido ⇒ SIGN_KEY_SOURCE_UNSUPPORTED (código 3) antes de qualquer abertura: nada lido, terminal e chave intocados', async () => {
  const world = cliWorld();
  for (const value of ['external:token-piv-01', 'external:yubikey-5c']) {
    for (const json of [false, true]) {
      const data = spyData();
      const key = spyKey();
      const run = await runSign(world.argv({ 'key-source': value }, json ? ['--json'] : []), { typed: world.typed(), fs: data.ops, keyFs: key.ops });
      if (json) assert.deepEqual([run.code, jsonOut(run).code], [3, 'SIGN_KEY_SOURCE_UNSUPPORTED']);
      else refusedCli(run, 'SIGN_KEY_SOURCE_UNSUPPORTED', value);
      assert.equal(data.calls.length + key.calls.length, 0, `${value}: nada lido`);
      terminalUntouched(run, value);
    }
  }
  assert.deepEqual(sealsIn(world.sealsDir), []);
});

test('revisão da W4.4 (MAJOR): external: com sufixo fora do padrão de id público ⇒ SECRET_VIA_ARGV_FORBIDDEN (código 3), sem ecoar, com o aviso de exposição; nada lido', async () => {
  const world = cliWorld();
  const pem = String(world.key.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  for (const value of ['external:frase secreta da chave', 'external:', 'external:abc', 'external:Token-PIV', 'external:token_piv', `external:${'a'.repeat(33)}`, 'external:-token', `external:${world.key.passphrase}`, `external:${pem}`]) {
    for (const json of [false, true]) {
      const data = spyData();
      const key = spyKey();
      const run = await runSign(world.argv({ 'key-source': value }, json ? ['--json'] : []), { typed: world.typed(), fs: data.ops, keyFs: key.ops });
      if (json) assert.deepEqual([run.code, jsonOut(run).code], [3, 'SECRET_VIA_ARGV_FORBIDDEN'], value);
      else refusedCli(run, 'SECRET_VIA_ARGV_FORBIDDEN', value);
      const shown = `${run.stdout}\n${run.stderr}`;
      assert.match(shown, /expost[oa]/, `${value}: aviso de exposição (histórico do shell)`);
      const suffix = value.slice('external:'.length);
      if (suffix.length > 0) assert.ok(!shown.includes(suffix.slice(0, 12)), `${value}: valor nunca ecoado`);
      for (const sentinel of world.key.sentinels) assert.ok(!shown.includes(sentinel), `${value}: nada da chave nem da frase na saída`);
      assert.equal(data.calls.length + key.calls.length, 0, `${value}: nada lido`);
      terminalUntouched(run, value);
    }
  }
});

/* =============================================================================================================== IA-23: confirmação humana */

test('IA-23: sem TTY (stdin não interativo, sem setRawMode, ou modo bruto que não liga) ⇒ SIGN_CONFIRMATION_FAILED (código 3) depois das recusas 1–10; nada lido do terminal, chave fechada, nada gravado', async () => {
  const world = cliWorld();
  const variants: Array<[string, ConstructorParameters<typeof FakeTerminal>[2]]> = [
    ['stdin não-TTY', { isTTY: false }],
    ['TTY sem setRawMode', { rawMode: 'missing' }],
    ['modo bruto que não liga (o eco continuaria)', { rawMode: 'ignored' }],
  ];
  for (const [label, options] of variants) {
    const key = spyKey();
    const terminal = new FakeTerminal(world.typed(), () => '', options);
    const run = await runSign(world.argv(), { terminal, keyFs: key.ops });
    refusedCli(run, 'SIGN_CONFIRMATION_FAILED', label);
    assert.match(run.stderr, /sem terminal interativo/, label);
    assert.equal(terminal.reads, 0, `${label}: nada lido (nem com eco)`);
    assert.deepEqual(terminal.echoed, [], label);
    assert.equal(key.calls.length, 0, `${label}: chave nem inspecionada`);
    assert.ok(!PASS_PROMPT.test(run.stderr), `${label}: frase nunca pedida`);
    assert.equal(terminal.isRaw, false, label);
    assert.deepEqual(sealsIn(world.sealsDir), [], label);
  }
});

test('IA-23: prefixo errado ⇒ SIGN_CONFIRMATION_FAILED; a tela mostra auditId, seq e número de entradas, NUNCA o hash do pacote nem parte dele; a frase nunca é pedida e a chave não é aberta', async () => {
  const world = cliWorld({ entries: E2 });
  const wrong = [`${'0'.repeat(12)}\r`, `${world.confirmation} \r`, `${world.confirmation.toUpperCase().replace(/[a-f]/g, (c) => c.toUpperCase())}X\r`, `${world.confirmation.slice(0, 11)}\r`, `${world.confirmation}0\r`];
  for (const typed of wrong) {
    const key = spyKey();
    const run = await runSign(world.argv(), { typed: [typed, `${world.key.passphrase}\r`], keyFs: key.ops });
    refusedCli(run, 'SIGN_CONFIRMATION_FAILED', JSON.stringify(typed));
    assert.equal(run.terminal.reads, 1, 'uma leitura só: a frase nunca é pedida');
    const screen = run.terminal.deliveries[0]?.screen ?? '';
    assert.match(screen, CONFIRM_PROMPT);
    assert.ok(screen.includes(AUD) && /seq 1\b/.test(screen) && /4 entradas/.test(screen), `a tela mostra auditId, seq e entradas: ${screen}`);
    for (const shown of [run.stdout, run.stderr, screen]) {
      assert.ok(!shown.includes(world.pkg.packageSha256.slice(0, 6)), 'nenhum pedaço do hash do pacote na tela');
      assert.ok(!shown.includes(typed.trim()), 'nem o que foi digitado');
    }
    assert.ok(!PASS_PROMPT.test(run.stderr));
    assert.equal(key.calls.length, 0, 'chave nem inspecionada');
    assert.equal(run.terminal.deliveries[0]?.raw, true, 'digitação lida sem eco');
    terminalRestored(run, 'confirmação errada');
    assert.deepEqual(sealsIn(world.sealsDir), []);
  }
});

test('IA-23: prefixo certo ⇒ prossegue: a frase é pedida DEPOIS (passo 12), tudo lido sem eco numa só sessão do terminal, e seal-0001.json é gravado', async () => {
  const world = cliWorld();
  const run = await runSign(world.argv(), { typed: world.typed() });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.terminal.reads, 2);
  assert.deepEqual(run.terminal.deliveries.map((d) => d.raw), [true, true], 'confirmação e frase lidas com o eco desligado');
  assert.deepEqual(run.terminal.echoed, [], 'nada ecoado');
  assert.deepEqual(run.terminal.rawCalls, [true, false], 'modo bruto ligado uma vez e restaurado no fim');
  const confirmAt = run.err.findIndex((line) => CONFIRM_PROMPT.test(line));
  const passAt = run.err.findIndex((line) => PASS_PROMPT.test(line));
  assert.ok(confirmAt >= 0 && passAt > confirmAt, 'frase pedida depois da confirmação');
  assert.match(run.terminal.deliveries[1]?.screen ?? '', PASS_PROMPT, 'a frase é lida depois do pedido');
  assert.deepEqual(sealsIn(world.sealsDir), ['seal-0001.json']);
  terminalRestored(run, 'sucesso');
});

test('IA-23 (revisão da W4.4, achado no pseudo-terminal sob carga): o eco é desligado ANTES de mostrar as telas da confirmação e da frase; o que for digitado assim que a tela aparece nunca ecoa', async () => {
  const world = cliWorld();
  const run = await runSign(world.argv(), { typed: world.typed() });
  assert.equal(run.code, 0, run.stderr);
  const prompts = run.err.map((line, index) => [line, run.rawAtErr[index]] as const).filter(([line]) => /^(Confirmação humana|Digite os|Frase-senha)/.test(line));
  assert.equal(prompts.length, 3, 'as duas linhas da confirmação e a da frase');
  for (const [line, raw] of prompts) assert.equal(raw, true, `eco ainda ligado quando a tela foi mostrada: ${line}`);
  assert.equal(run.terminal.isRaw, false, 'e restaurado no fim');
});

test('IA-23: Ctrl-C, Ctrl-D, fim de entrada, erro do terminal, texto longo demais ou tecla de controle na confirmação ⇒ SIGN_CONFIRMATION_FAILED, eco restaurado, chave fechada', async () => {
  const world = cliWorld();
  const cases: Array<[string, Typed[]]> = [
    ['Ctrl-C', ['\x03']],
    ['Ctrl-D', ['\x04']],
    ['fim de entrada', [{ kind: 'end' }]],
    ['erro do terminal', [{ kind: 'error', message: `falha simulada ${world.key.passphrase}` }]],
    ['longo demais', [`${'a'.repeat(200)}\r`]],
    ['tecla de controle (seta)', ['\x1b[A\r']],
  ];
  for (const [label, typed] of cases) {
    const key = spyKey();
    const run = await runSign(world.argv(), { typed, keyFs: key.ops });
    refusedCli(run, 'SIGN_CONFIRMATION_FAILED', label);
    assert.ok(!run.stderr.includes(world.key.passphrase), `${label}: a mensagem do erro do terminal nunca sai`);
    assert.equal(key.calls.length, 0, label);
    terminalRestored(run, label);
    assert.deepEqual(sealsIn(world.sealsDir), [], label);
  }
});

/* =============================================================================================================== IA-14: recibo e saída */

const RECEIPT_KEYS = ['ok', 'auditId', 'seq', 'schemaVersion', 'keyId', 'sealedAt', 'sealSha256', 'prevSealSha256', 'packageSha256', 'dossierSha256', 'entries', 'approvedBy', 'operator', 'custodian', 'roleException', 'requiresLaterReview', 'artifactSha256'];

test('IA-14 (passo 16): --json imprime UM objeto, o recibo com exatamente os campos do §5.5 passo 16; a pública vai ao stderr como <keyId>:<base64url>; o manifesto gravado é AUTENTICADO pelo verificador v2', async () => {
  const world = cliWorld({ entries: E2 });
  const run = await runSign(world.argv({}, ['--json']), { typed: world.typed() });
  assert.equal(run.code, 0, run.stderr);
  const receipt = jsonOut(run);
  assert.deepEqual(Object.keys(receipt), RECEIPT_KEYS, 'campos e ordem do §5.5 passo 16');
  const bytes = fs.readFileSync(sealFile(world.sealsDir));
  const parsed = parseEvidenceSealV2Text(bytes);
  assert.ok(parsed.ok);
  const seal = parsed.value;
  assert.deepEqual(receipt, {
    ok: true,
    auditId: AUD,
    seq: 1,
    schemaVersion: 2,
    keyId: world.key.keyId,
    sealedAt: NOW,
    sealSha256: sealSha256(seal),
    prevSealSha256: null,
    packageSha256: world.pkg.packageSha256,
    dossierSha256: sha256(DOSSIER),
    entries: 4,
    approvedBy: 'CONF-01',
    operator: 'OPER-01',
    custodian: CUSTODIAN,
    roleException: false,
    requiresLaterReview: false,
    artifactSha256: null,
  });
  assert.ok(run.stderr.includes(`${world.key.keyId}:${world.key.publicRaw}`), 'pública derivada impressa (não secreta)');
  assert.ok(!run.stdout.includes(seal.signature) && !run.stderr.includes(seal.signature), 'nunca a assinatura completa');
  const keyring = parseTrustKeyring(world.key.ring) as TrustKeyring;
  const evidences = seal.entries.map(({ ref, contentSha256 }) => ({ ref, contentSha256, legacy: false }));
  const verdict = await createSealedEvidenceProvenance({ sealsDir: world.sealsDir, keyring, acceptedVersions: [2] }).classify(AUD, evidences);
  assert.deepEqual(verdict, { status: 'AUTHENTICATED', headSeq: 1, headSealSha256: sealSha256(seal), keyIds: [world.key.keyId] });
});

test('IA-14 (RS-21): nenhuma saída do sign (humana, --json, recusa) contém nome/cidade da empresa, caminho de disco (nem o arquivo interno gravado), assinatura ou chave; só auditId, seq, códigos, rótulos e hashes', async () => {
  const pkg = rehashed(makePackage(E1), (body) => ({ ...body, summary: { ...(body.summary as Record<string, unknown>), company: { name: 'Empresa FICTÍCIA Sentinela Ltda', city: 'Cidade Sentinela', stateCode: 'GO' } } }));
  const forbiddenIn = (world: CliWorld, run: SignCliRun, label: string): void => {
    const shown = `${run.stdout}\n${run.stderr}`;
    const realSeals = fs.realpathSync(world.sealsDir);
    for (const fragment of ['Empresa FICTÍCIA', 'Cidade Sentinela', os.tmpdir() + path.sep, realSeals, world.sealsDir, path.dirname(world.station.packagePath), world.key.dir, sealFile(world.sealsDir), 'BEGIN', ...world.key.sentinels]) {
      assert.ok(!shown.includes(fragment), `${label}: "${fragment.slice(0, 40)}" na saída`);
    }
  };
  for (const json of [false, true]) {
    const world = cliWorld({ pkg });
    const run = await runSign(world.argv({}, json ? ['--json'] : []), { typed: world.typed() });
    assert.equal(run.code, 0, run.stderr);
    forbiddenIn(world, run, json ? 'sucesso --json' : 'sucesso');
    const seal = parseEvidenceSealV2Text(fs.readFileSync(sealFile(world.sealsDir)));
    assert.ok(seal.ok && !`${run.stdout}${run.stderr}`.includes(seal.value.signature));
    if (!json) {
      assert.ok(run.stdout.includes('seal-0001.json'), 'o NOME do arquivo (sem pasta) é informado');
      assert.match(run.stdout, /seq: 1\b/);
    }
    const again = await runSign(world.argv({}, json ? ['--json'] : []), { typed: world.typed() });
    assert.equal(again.code, 3, 'segunda assinatura do mesmo seq é recusada');
    forbiddenIn(world, again, 'recusa');
  }
});

test('IA-14: saída humana do sucesso: arquivo (só o nome), pública, recibo legível e em JSON, autoteste do passo 14 registrado (W4.5) e aviso do artifactSha256 nulo (artefato da W4.6)', async () => {
  const world = cliWorld();
  const run = await runSign(world.argv(), { typed: world.typed() });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /MANIFESTO v2 ASSINADO/);
  assert.ok(run.stdout.includes(`${world.key.keyId}:${world.key.publicRaw}`), 'pública derivada na saída padrão');
  const jsonLine = run.out.find((line) => line.startsWith('Recibo (JSON): '));
  assert.ok(jsonLine, 'recibo em JSON numa linha, para a pasta de recibos');
  const receipt = JSON.parse(jsonLine.slice('Recibo (JSON): '.length)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(receipt), RECEIPT_KEYS);
  assert.equal(receipt.artifactSha256, null);
  assert.match(run.stdout, /Autoteste \(passo 14\)/, 'o autoteste do passo 14 (W4.5) é registrado na saída');
  assert.doesNotMatch(run.stderr, /ainda não existe/, 'o aviso do autoteste ausente saiu (W4.5)');
  assert.match(run.stderr, /artifactSha256 é nulo/, 'o aviso do artefato único (W4.6) continua');
});

test('saída das recusas: RECUSADO: + código (código 3); --json com {ok:false, code, message} e, quando houver, refs e chainReason; nada gravado', async () => {
  const world = cliWorld();
  const other = makePackage(E2);
  writeStation(path.dirname(world.station.packagePath), { pkg: world.pkg, approval: makeApproval(other) });
  const human = await runSign(world.argv(), { typed: world.typed() });
  refusedCli(human, 'SIGN_PACKAGE_MISMATCH');
  assert.match(refusalLine(human), /^RECUSADO: o pacote a assinar não é o aprovado/i);
  const json = await runSign(world.argv({}, ['--json']), { typed: world.typed() });
  assert.equal(json.code, 3);
  assert.deepEqual(Object.keys(jsonOut(json)), ['ok', 'code', 'message']);
  assert.equal(jsonOut(json).code, 'SIGN_PACKAGE_MISMATCH');
  const chain = cliWorld();
  const empty = await runSign(chain.argv({ 'expect-seq': '2', first: null }, ['--json']), { typed: chain.typed() });
  assert.deepEqual([empty.code, jsonOut(empty).code, jsonOut(empty).chainReason], [3, 'SIGN_SEAL_CHAIN_INVALID', 'NO_SEAL_EXPECTED_SEQ']);
  assert.deepEqual(sealsIn(world.sealsDir), []);
});

/* =============================================================================================================== IA-01 (parte do CLI) */

test('IA-01 (CLI): recusas (a)–(d) pelo CLI ⇒ código 3 com RECUSADO:, nenhum manifesto novo, terminal intocado e chave não aberta', async () => {
  const first = cliWorld({ entries: E2 });
  assert.equal((await runSign(first.argv(), { typed: first.typed() })).code, 0, 'seal-0001.json da cadeia');
  const sealBefore = fs.readFileSync(sealFile(first.sealsDir));
  const legacy = rehashed(makePackage(E1), (body) => ({
    ...body,
    layout: 'LEGACY',
    attestable: false,
    gap: null,
    summary: { ...(body.summary as Record<string, unknown>), containsLegacy: true },
    entries: (body.entries as Array<Record<string, unknown>>).map((entry) => ({ ...entry, legacy: true })),
  }));
  const failed = rehashed(makePackage(E1), (body) => ({ ...body, checks: (body.checks as Array<{ id: string; status: string }>).map((check) => (check.id === 'HTTP_2XX_AND_COLLECTED_AT' ? { ...check, status: 'FAIL' } : check)) }));
  const stationFor = (files: Parameters<typeof writeStation>[1]): Record<string, string> => {
    const station = writeStation(tmpDir('lasc-st-'), files);
    return { package: station.packagePath, approval: station.approvalPath, dossier: station.dossierPath };
  };
  const shrunk = makePackage(E2.filter((entry) => entry.ref !== 'capture:c0002'));
  const cases: Array<[string, string, Record<string, string | null>]> = [
    ['(a) evidência atestada sumiu', 'SIGN_EVIDENCE_CHANGED', { ...stationFor({ pkg: shrunk }), 'expect-seq': '2', first: null }],
    ['(b) coleta legada', 'SIGN_LEGACY_NOT_ATTESTABLE', { ...stationFor({ pkg: legacy }), 'expect-seq': '2', first: null }],
    ['(c) pacote ≠ aprovado', 'SIGN_PACKAGE_MISMATCH', { ...stationFor({ pkg: makePackage(E2), approval: makeApproval(makePackage(E1)) }), 'expect-seq': '2', first: null }],
    ['(d) verificação FAIL', 'SIGN_INTEGRITY_NOT_OK', { ...stationFor({ pkg: failed }), 'expect-seq': '2', first: null }],
  ];
  for (const [label, code, over] of cases) {
    const key = spyKey();
    const run = await runSign(first.argv(over), { typed: first.typed(), keyFs: key.ops });
    refusedCli(run, code, label);
    if (code === 'SIGN_EVIDENCE_CHANGED') assert.match(refusalLine(run), /capture:c0002/);
    assert.equal(key.calls.length, 0, `${label}: chave não aberta (nem inspecionada)`);
    terminalUntouched(run, label);
    assert.deepEqual(sealsIn(first.sealsDir), ['seal-0001.json'], `${label}: nenhum manifesto novo`);
    assert.deepEqual(fs.readFileSync(sealFile(first.sealsDir)), sealBefore, `${label}: o anterior intacto`);
  }
});

/* =============================================================================================================== IA-16: separação de papéis */

const withRoles = (pkg: CandidatePackage, over: Partial<ReturnType<typeof makeApproval>>): ReturnType<typeof makeApproval> => ({ ...makeApproval(pkg), ...over });
const ACCEPTANCE_REF = { id: 'aceite-risco-0001', sha256: sha256(RISK_ACCEPTANCE) };

test('IA-16: conferente = custodiante sem --risk-acceptance ⇒ SIGN_ROLE_SEPARATION (código 3) antes da confirmação e da chave, com e sem aceite citado na aprovação', async () => {
  const pkg = makePackage(E1);
  for (const [label, approval, message] of [
    ['sem aceite na aprovação', withRoles(pkg, { approvedBy: 'CONF-01' }), /sem aceite formal de risco/],
    ['aceite citado, arquivo não indicado', withRoles(pkg, { riskAcceptance: ACCEPTANCE_REF }), /não foi fornecido/],
  ] as const) {
    const world = cliWorld({ pkg, approval });
    const key = spyKey();
    const run = await runSign(world.argv({ custodian: 'conf 01' }), { typed: world.typed(), keyFs: key.ops });
    refusedCli(run, 'SIGN_ROLE_SEPARATION', label);
    assert.match(run.stderr, message, label);
    assert.equal(key.calls.length, 0, label);
    terminalUntouched(run, label);
    assert.deepEqual(sealsIn(world.sealsDir), [], label);
  }
});

test('IA-16: conferente = custodiante COM aceite formal (--risk-acceptance com o hash citado) ⇒ assina; o recibo marca roleException e requiresLaterReview', async () => {
  const pkg = makePackage(E1);
  const world = cliWorld({ pkg, approval: withRoles(pkg, { riskAcceptance: ACCEPTANCE_REF }), riskAcceptance: RISK_ACCEPTANCE });
  assert.ok(world.argv().includes('--risk-acceptance'));
  const run = await runSign(world.argv({ custodian: 'conf 01' }, ['--json']), { typed: world.typed() });
  assert.equal(run.code, 0, run.stderr);
  const receipt = jsonOut(run);
  assert.deepEqual([receipt.approvedBy, receipt.custodian, receipt.roleException, receipt.requiresLaterReview], ['CONF-01', 'conf 01', true, true]);
});

test('IA-16: --risk-acceptance com bytes que não conferem ⇒ SIGN_ROLE_SEPARATION; indicado e ilegível ⇒ SIGN_INPUT_UNREADABLE nomeando --risk-acceptance, mesmo com papéis distintos', async () => {
  const pkg = makePackage(E1);
  const mismatched = cliWorld({ pkg, approval: withRoles(pkg, { riskAcceptance: ACCEPTANCE_REF }), riskAcceptance: Buffer.from('outro aceite (fictício)\n') });
  const run = await runSign(mismatched.argv({ custodian: 'CONF-01' }), { typed: mismatched.typed() });
  refusedCli(run, 'SIGN_ROLE_SEPARATION');
  assert.match(run.stderr, /não confere/);
  terminalUntouched(run, 'aceite que não confere');
  const distinct = cliWorld({ pkg });
  const missing = await runSign(distinct.argv({ 'risk-acceptance': path.join(distinct.key.dir, 'nao-existe.pdf') }), { typed: distinct.typed() });
  refusedCli(missing, 'SIGN_INPUT_UNREADABLE');
  assert.match(refusalLine(missing), /--risk-acceptance/);
  assert.ok(!missing.stderr.includes(distinct.key.dir), 'sem caminho de disco');
  terminalUntouched(missing, 'aceite ilegível');
});

test('IA-16: operador = conferente ⇒ assina com requiresLaterReview (sem roleException); papéis distintos com --risk-acceptance ⇒ o aceite é ignorado e o recibo sai sem marcas', async () => {
  const pkg = makePackage(E1);
  const sameOperator = cliWorld({ pkg, approval: withRoles(pkg, { operator: 'conf.01' }) });
  const run = await runSign(sameOperator.argv({}, ['--json']), { typed: sameOperator.typed() });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual([jsonOut(run).roleException, jsonOut(run).requiresLaterReview], [false, true]);
  const distinct = cliWorld({ pkg, riskAcceptance: RISK_ACCEPTANCE });
  const plain = await runSign(distinct.argv({}, ['--json']), { typed: distinct.typed() });
  assert.equal(plain.code, 0, plain.stderr);
  assert.deepEqual([jsonOut(plain).roleException, jsonOut(plain).requiresLaterReview], [false, false]);
});

/* =============================================================================================================== IA-02 (5) */

test('IA-02 (5): pelo CLI, o sign só toca pacote, aprovação, dossiê, aceite de risco, a pasta de manifestos e o arquivo de chave (e, pela custódia da IA-22, só METADADOS dos .git ancestrais e das raízes proibidas)', async () => {
  const pkg = makePackage(E1);
  const world = cliWorld({ pkg, approval: withRoles(pkg, { riskAcceptance: ACCEPTANCE_REF }), riskAcceptance: RISK_ACCEPTANCE });
  const forbiddenTemp = tmpDir('lasc-proibida-');
  const data = spyData();
  const key = spyKey();
  const run = await runSign(world.argv({ custodian: 'CONF-01' }), { typed: world.typed(), fs: data.ops, keyFs: key.ops, tempRoots: [forbiddenTemp] });
  assert.equal(run.code, 0, run.stderr);
  const realSeals = fs.realpathSync(world.sealsDir);
  const inputs = new Set([world.station.packagePath, world.station.approvalPath, world.station.dossierPath, world.station.riskAcceptancePath]);
  const underSeals = (target: string): boolean => [world.sealsDir, realSeals].some((root) => target === root || target.startsWith(root + path.sep));
  for (const call of data.calls) {
    const targets = call.op === 'link' ? call.args.slice(0, 2) : call.args.slice(0, 1);
    for (const target of targets) assert.ok(typeof target === 'string' && (inputs.has(target) || underSeals(target)), `${call.op}(${String(target)}) fora da lista`);
  }
  const keyReal = fs.realpathSync(world.key.keyPath);
  const keyDirs = new Set([path.dirname(world.key.keyPath), path.dirname(keyReal)]);
  for (const call of key.calls) {
    const target = String(call.args[0]);
    if (call.op === 'openKeyFile') assert.equal(target, world.key.keyPath, 'só o arquivo de chave é ABERTO (e lido pelo mesmo descritor)');
    else if (call.op === 'lstat') assert.ok(keyDirs.has(target) || path.basename(target) === '.git', `lstat(${target}) fora da custódia`);
    else if (call.op === 'realpath') assert.ok([path.join(__dirname, '..'), forbiddenTemp].includes(target), `realpath(${target}) fora da custódia`);
    else assert.fail(`operação inesperada na chave: ${call.op}`);
  }
  assert.equal(key.calls.filter((call) => call.op === 'openKeyFile').length, 1, 'arquivo de chave aberto uma vez');
});

/* =============================================================================================================== o script entrega o sign */

test('o script entrega sign ao CLI do sign com a raiz do PROJETO: chave dentro do repositório ⇒ SECRET_PATH_UNSAFE depois da confirmação, sem pedir a frase', async () => {
  const world = cliWorld();
  const inside = path.join(__dirname, '..', 'chave-de-teste-inexistente.pem');
  const run = await runSign(world.argv({ 'key-source': `file:${inside}` }), { typed: world.typed(), projectRoot: null });
  refusedCli(run, 'SECRET_PATH_UNSAFE');
  assert.match(run.stderr, /projeto/);
  assert.ok(!run.stderr.includes(inside), 'sem caminho de disco');
  assert.ok(!PASS_PROMPT.test(run.stderr), 'frase nunca pedida');
  assert.equal(run.terminal.reads, 1, 'só a confirmação foi lida');
  terminalRestored(run, 'chave no projeto');
});
