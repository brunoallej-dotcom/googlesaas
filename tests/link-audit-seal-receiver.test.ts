import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps } from '../src/lib/link-audit/node-fs-ops';
import type { BytesFsOps } from '../src/lib/link-audit/fs-ops';
import { classifyChannelPath } from '../src/lib/link-audit-seals-channel/paths';
import { CLOSURE_REFUSAL_DETAILS, publicErrorLine, SEAL_RECEIVER_EXIT_CODES, V2_REFUSAL_DETAILS } from '../src/lib/seal-receiver/codes';
import { RECEIVER_EXIT_CODES } from '../src/lib/deploy-receiver/codes';
import { MAX_COMMAND_BYTES, parseRelpath, parseSealCommand } from '../src/lib/seal-receiver/grammar';
import { nodeLock, openReceiverLog, RECEIVER_UMASK, sealReceiverFs } from '../src/lib/seal-receiver/node-adapters';
import { runSealReceiver } from '../src/lib/seal-receiver/receiver';
import { parseSealReceiverArgs } from '../src/lib/seal-receiver/args';
import { STDIN_DEADLINE_MS } from '../src/lib/seal-receiver/input';
import { registerCleanup } from './helpers/link-audit-evidence-fixtures';
import { E1, E2, signer } from './helpers/link-audit-seal-close-key-fixtures';
import { AUD_A, AUD_B, canonicalText, closureFor, listItem } from './helpers/link-audit-seals-fixtures';
import {
  chainOf,
  deliverOnHost,
  errno,
  FakeClock,
  FakeStdin,
  faultyFs,
  installTrust,
  listTree,
  MemoryLog,
  putLine,
  putOnly,
  runReceiver,
  sealRelpath,
  sealWorld,
  sha256,
  wrapperPermission,
  type SealWorld,
} from './helpers/seal-receiver-fakes';

/*
 * P9.3b — o receptor de manifestos em processo (spec `docs/specs/ci-deploy-and-seal-delivery.md` §5.7, §5.8; critérios P9-R01 a P9-R10, P9-R12 e
 * P9-R13; o P9-R11 está em `link-audit-seal-receiver-artifact.test.ts`). Pastas temporárias reais com o disco do adaptador de produção, cadeias v2
 * REAIS assinadas por chaves de TESTE geradas em memória e verificadas pelo VERIFICADOR v2 REAL; falhas injetadas pela porta de disco. Sem ssh, sem
 * Docker, sem rede. O `umask` do processo é o do receptor (027), como o wrapper deixa.
 */
registerCleanup();
process.umask(RECEIVER_UMASK);

const KEY_A = signer('ek-host-a');
const KEY_B = signer('ek-host-b');
const KEY_R = signer('ek-host-revogada');
const KEY_T = signer('ek-host-aposentada');
const KEY_X = signer('ek-host-fora');
const KEY_H = signer('ensaio-host-a');

/** Host com a lista instalada (A e B ativas) e a cadeia de AUD_A com o manifesto 1 de A. Devolve o próximo manifesto (2) pronto para entregar. */
function hostWithChain(extra: readonly string[] = []) {
  const w = sealWorld();
  const trust = installTrust(w, [listItem(KEY_A), listItem(KEY_B), ...extra]);
  const [first, second] = chainOf(AUD_A, [{ signer: KEY_A }, { signer: KEY_B, entries: E2 }]) as [ReturnType<typeof chainOf>[number], ReturnType<typeof chainOf>[number]];
  deliverOnHost(w, first);
  const text = canonicalText(second);
  return { w, trust, first, second, text, command: putLine(sealRelpath(second), text, trust) };
}

/** Disco cuja releitura do destino (passo 8) devolve `bytes` depois do link: o arquivo "mudou" no disco. */
function rereadReturns(w: SealWorld, seal: { readonly auditId: string; readonly seq: number }, bytes: Buffer): BytesFsOps {
  const dest = path.join(w.sealsRoot, sealRelpath(seal));
  let linked = false;
  return faultyFs({
    link: async (from, to) => {
      await sealReceiverFs.link(from, to);
      if (to === dest) linked = true;
    },
    readFileBytes: async (file, max) => (linked && file === dest ? bytes : sealReceiverFs.readFileBytes(file, max)),
  });
}

/** O receptor com uma fábrica de portas própria (para a fábrica que lança). */
async function runSealReceiverWith(w: SealWorld, command: string, text: string, makeLog: () => ReturnType<typeof openReceiverLog>) {
  return runSealReceiver({ argv: w.argv, env: { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: command }, permission: wrapperPermission(w) }, () => ({ fs: sealReceiverFs, stdin: FakeStdin.of(text), clock: new FakeClock(), lock: nodeLock, log: makeLog(), tempSuffix: () => '0'.repeat(32) }));
}

const stderrOf = (result: { outcome: { stderr: string | null } }): string | null => result.outcome.stderr;
const stdoutOf = (result: { outcome: { stdout: string | null } }): string | null => result.outcome.stdout;

/* ===================================================================================================================== P9-R01 */

test('P9-R01 comando fora da gramática (verbo desconhecido, `..`, `/` a mais, campo a mais ou a menos, não ASCII, acima de 256 bytes, caixa, espaço) ⇒ E_COMMAND (10), nada lido do stdin e nada criado', async () => {
  const w = sealWorld();
  const relpath = `${AUD_A}/seal-0001.json`;
  const h = 'a'.repeat(64);
  const outside = [
    undefined,
    '',
    `get ${relpath} ${h} ${h}`,
    `PUT ${relpath} ${h} ${h}`,
    `put ${relpath} ${h}`,
    `put ${relpath} ${h} ${h} ${h}`,
    `put  ${relpath} ${h} ${h}`,
    `put ${relpath} ${h} ${h} `,
    ` put ${relpath} ${h} ${h}`,
    `put\t${relpath} ${h} ${h}`,
    `put ../${relpath} ${h} ${h}`,
    `put ${AUD_A}/../${AUD_B}/seal-0001.json ${h} ${h}`,
    `put /${relpath} ${h} ${h}`,
    `put ./${relpath} ${h} ${h}`,
    `put ${AUD_A}//seal-0001.json ${h} ${h}`,
    `put ${AUD_A}/sub/seal-0001.json ${h} ${h}`,
    `put ${AUD_A}/seal-0000.json ${h} ${h}`,
    `put ${AUD_A}/seal-0257.json ${h} ${h}`,
    `put ${AUD_A}/seal-1.json ${h} ${h}`,
    `put ${AUD_A}/SEAL-0001.json ${h} ${h}`,
    `put AUD-0123456789ABCDEF/seal-0001.json ${h} ${h}`,
    `put aud-002-autorizacao-01/seal-0001.json ${h} ${h}`,
    `put _closures/EK-A.json ${h} ${h}`,
    `put _closures/abc.json ${h} ${h}`,
    `put _closures/ek-a.json.tmp ${h} ${h}`,
    `put trust-keys.txt ${h} ${h}`,
    `put ${relpath} ${'A'.repeat(64)} ${h}`,
    `put ${relpath} ${h.slice(1)} ${h}`,
    `put ${relpath} ${h} ${h}x`,
    `put ${relpath} ${h} ${h};id`,
    `put ${relpath} $(id) ${h}`,
    `put ${AUD_A}/seal-0001.json ${h} ${h}\n`,
    `put ${AUD_A}/seal-0001.jsón ${h} ${h}`,
    `put ${relpath} ${h} ${h}${' '.repeat(MAX_COMMAND_BYTES)}`,
  ];
  for (const command of outside) {
    assert.equal(parseSealCommand(command), null, JSON.stringify(command));
    const run = await runReceiver(w, command, FakeStdin.of('nunca lido'));
    assert.equal(run.outcome.exitCode, 10, JSON.stringify(command));
    assert.equal(stderrOf(run), 'ERRO E_COMMAND');
    assert.equal((run.stdin as FakeStdin).reads, 0, 'nada lido do stdin');
    assert.ok(!fs.existsSync(w.lockFile), 'nenhuma trava criada');
  }
  assert.deepEqual(listTree(w.sealsRoot), [], 'nada criado na pasta de manifestos');
  assert.ok(parseSealCommand(`put ${relpath} ${h} ${h}`), 'o comando certo passa');
  assert.ok(parseSealCommand(`put _closures/${'a'.repeat(32)}.json ${h} ${h}`), 'o id de fecho mais longo cabe nos 256 bytes');
});

test('P9-R01 gramática: paridade com a do canal (`classifyChannelPath` da P9.2) numa varredura de nomes; os limites 0001, 0256, 3 e 31 caracteres do id', () => {
  const ids = ['0123456789abcdef', 'fedcba9876543210', '0123456789abcde', '0123456789abcdefa', '0123456789ABCDEF', '0123456789abcdeg'];
  const seqs = ['0000', '0001', '0009', '0010', '0099', '0100', '0199', '0200', '0249', '0250', '0255', '0256', '0257', '0300', '1000', '9999', '001', '00001'];
  const keyIds = ['ek-a', 'ek-', 'abc', 'abcd', 'a'.repeat(32), 'a'.repeat(33), '-abc', 'ek_a', 'EK-A', 'ensaio-chave-01', '0abc'];
  const relpaths = [
    ...ids.flatMap((id) => seqs.map((seq) => `aud-${id}/seal-${seq}.json`)),
    ...keyIds.map((id) => `_closures/${id}.json`),
    `${AUD_A}/seal-0001.JSON`,
    `${AUD_A}/seal-0001.json.tmp-${'0'.repeat(32)}`,
    `${AUD_A}/.seal-0001.json.tmp-${'0'.repeat(32)}`,
    '_closures/.ek-a.json.tmp-0',
    `${AUD_A}`,
    '_closures',
  ];
  for (const relpath of relpaths) {
    const channel = classifyChannelPath(`link-audit-seals/producao/seals/${relpath}`);
    const target = parseRelpath(relpath);
    assert.equal(target !== null, channel !== null && channel.kind !== 'unexpected', relpath);
    if (target?.kind === 'seal') assert.deepEqual(channel, { kind: 'seal', env: 'producao', auditId: target.auditId, seq: target.seq }, relpath);
    if (target?.kind === 'closure') assert.deepEqual(channel, { kind: 'closure', env: 'producao', keyId: target.keyId }, relpath);
  }
  assert.deepEqual(parseRelpath(`${AUD_A}/seal-0256.json`), { kind: 'seal', relpath: `${AUD_A}/seal-0256.json`, auditId: AUD_A, seq: 256, dirName: AUD_A, fileName: 'seal-0256.json' });
  assert.deepEqual(parseRelpath('_closures/ensaio-chave-01.json'), { kind: 'closure', relpath: '_closures/ensaio-chave-01.json', keyId: 'ensaio-chave-01', dirName: '_closures', fileName: 'ensaio-chave-01.json' });
});

/* ===================================================================================================================== P9-R02 */

test('P9-R02 stdin acima do teto ⇒ E_INPUT_TOO_LARGE (11) sem ler o resto; vazio, parado ou além do prazo ⇒ E_INPUT_TRUNCATED (12); cortado ou com outro hash ⇒ E_HASH_MISMATCH (13); nada gravado', async () => {
  const { w, text, command, trust, second } = hostWithChain();
  const before = listTree(w.sealsRoot);
  const huge = new FakeStdin([Buffer.alloc(200 * 1024, 0x20), Buffer.alloc(57 * 1024, 0x20), Buffer.alloc(10, 0x20), Buffer.alloc(10, 0x20)]);
  const tooLarge = await runReceiver(w, command, huge);
  assert.equal(tooLarge.outcome.exitCode, 11);
  assert.equal(stderrOf(tooLarge), 'ERRO E_INPUT_TOO_LARGE');
  assert.equal(huge.remaining, 3, 'parou no primeiro pedaço além do teto, sem ler o resto');
  const exact = Buffer.alloc(256 * 1024, 0x20);
  const atCap = await runReceiver(w, putLine(sealRelpath(second), exact, trust), exact);
  assert.equal(stderrOf(atCap), 'ERRO E_FORMAT', 'exatamente 256 KiB passa do teto (e cai no formato)');
  for (const [label, stdin, clock] of [
    ['vazio', new FakeStdin([]), new FakeClock()],
    ['parado (sem fim)', new FakeStdin([Buffer.from(text.slice(0, 10))], 'hang'), new FakeClock()],
    ['gotejando além do prazo do stdin inteiro', new FakeStdin([...Buffer.from(text)].map((byte) => Buffer.from([byte]))), new FakeClock(STDIN_DEADLINE_MS / 100)],
  ] as const) {
    const truncated = await runReceiver(w, command, stdin, { clock });
    assert.equal(truncated.outcome.exitCode, 12, label);
    assert.equal(stderrOf(truncated), 'ERRO E_INPUT_TRUNCATED', label);
  }
  const cut = await runReceiver(w, command, text.slice(0, -5));
  assert.equal(cut.outcome.exitCode, 13);
  assert.equal(stderrOf(cut), 'ERRO E_HASH_MISMATCH');
  const other = await runReceiver(w, putLine(sealRelpath(second), `${text} `, trust), text);
  assert.equal(stderrOf(other), 'ERRO E_HASH_MISMATCH');
  assert.deepEqual(listTree(w.sealsRoot), before, 'nada gravado');
  assert.ok(!fs.existsSync(w.lockFile), 'a trava é liberada em toda recusa');
});

test('P9-R02 (revisão do PR #72, item 10) o prazo é conferido DEPOIS de cada espera: o fim (EOF) ou um pedaço que chega aos 30 001 ms ⇒ E_INPUT_TRUNCATED; aos 30 000 ms ainda vale', async () => {
  const { w, text, command } = hostWithChain();
  const late = (lastAtMs: number, lastIsData: boolean) => {
    const clock = new FakeClock();
    const events = [{ kind: 'data' as const, chunk: Buffer.from(lastIsData ? text.slice(0, 10) : text) }, lastIsData ? { kind: 'data' as const, chunk: Buffer.from(text.slice(10)) } : { kind: 'end' as const }, { kind: 'end' as const }];
    let index = 0;
    const stdin = {
      next: async () => {
        if (index === 1) clock.now = lastAtMs;
        index += 1;
        return events[index - 1] ?? ({ kind: 'end' } as const);
      },
    };
    return { stdin, clock };
  };
  for (const lastIsData of [false, true]) {
    const tooLate = late(STDIN_DEADLINE_MS + 1, lastIsData);
    const refused = await runReceiver(w, command, tooLate.stdin, { clock: tooLate.clock });
    assert.equal(stderrOf(refused), 'ERRO E_INPUT_TRUNCATED', lastIsData ? 'pedaço tardio' : 'EOF tardio');
  }
  const onTime = late(STDIN_DEADLINE_MS, false);
  assert.match(stdoutOf(await runReceiver(w, command, onTime.stdin, { clock: onTime.clock })) ?? '', /^OK WRITTEN /, 'no limite exato, aceito');
});

/* ===================================================================================================================== P9-R03 */

test('P9-R03 lista instalada com outro hash (inclusive a pendente com o hash pedido) ou ausente ⇒ E_TRUST_LIST_MISMATCH (14); inválida, link, acima do teto ou fora da regra de ambiente ⇒ E_TRUST_LIST_INVALID (15); nada gravado', async () => {
  const { w, text, second, trust } = hostWithChain();
  const relpath = sealRelpath(second);
  // a lista NOVA está só na pendente (deploy em andamento): o receptor lê SÓ a instalada
  const newer = Buffer.from(`${listItem(KEY_A)}\n${listItem(KEY_B)}\n${listItem(KEY_X)}\n`, 'ascii');
  fs.writeFileSync(w.pendingFile, newer, { mode: 0o644 });
  const spy: string[] = [];
  const spyFs: BytesFsOps = { ...sealReceiverFs, readFileBytes: (file, max) => (spy.push(file), sealReceiverFs.readFileBytes(file, max)) };
  const pending = await runReceiver(w, putLine(relpath, text, newer), text, { fs: spyFs });
  assert.equal(pending.outcome.exitCode, 14);
  assert.equal(stderrOf(pending), 'ERRO E_TRUST_LIST_MISMATCH');
  assert.ok(!spy.includes(w.pendingFile), 'a pendente nunca é lida');
  assert.deepEqual(spy.filter((file) => file === w.trustFile).length, 1, 'a instalada é lida uma vez');
  fs.rmSync(w.trustFile);
  assert.equal(stderrOf(await runReceiver(w, putLine(relpath, text, trust), text)), 'ERRO E_TRUST_LIST_MISMATCH', 'instalada ausente (falta o deploy)');
  const invalid: Array<[string, () => Buffer]> = [
    ['gramática', () => Buffer.from(`${KEY_A.keyId}:curta\n`, 'ascii')],
    ['linha vazia', () => Buffer.from(`${listItem(KEY_A)}\n\n`, 'ascii')],
    ['sem quebra final', () => Buffer.from(listItem(KEY_A), 'ascii')],
    ['ensaio- em produção', () => Buffer.from(`${listItem(KEY_A)}\n${listItem(KEY_H)}\n`, 'ascii')],
  ];
  for (const [label, make] of invalid) {
    const bytes = make();
    fs.writeFileSync(w.trustFile, bytes);
    const run = await runReceiver(w, putLine(relpath, text, bytes), text);
    assert.equal(run.outcome.exitCode, 15, label);
    assert.equal(stderrOf(run), 'ERRO E_TRUST_LIST_INVALID', label);
  }
  const big = Buffer.alloc(8 * 1024 + 1, 0x61);
  fs.writeFileSync(w.trustFile, big);
  assert.equal(stderrOf(await runReceiver(w, putLine(relpath, text, big), text)), 'ERRO E_TRUST_LIST_INVALID', 'acima de 8 KiB');
  const real = path.join(w.stateDir, 'lista-real.txt');
  fs.writeFileSync(real, trust);
  fs.rmSync(w.trustFile);
  fs.symlinkSync(real, w.trustFile);
  assert.equal(stderrOf(await runReceiver(w, putLine(relpath, text, trust), text)), 'ERRO E_TRUST_LIST_INVALID', 'link simbólico no lugar da instalada');
  assert.deepEqual(listTree(w.sealsRoot), [AUD_A, `${AUD_A}/seal-0001.json`], 'nada gravado');
});

test('P9-R03 homologação: só ids `ensaio-` na lista instalada; uma chave de produção nela ⇒ E_TRUST_LIST_INVALID; com a lista de ensaio, grava', async () => {
  const w = sealWorld('homologacao');
  const [seal] = chainOf(AUD_A, [{ signer: KEY_H }]) as [ReturnType<typeof chainOf>[number]];
  const text = canonicalText(seal);
  const mixed = installTrust(w, [listItem(KEY_H), listItem(KEY_A)]);
  assert.equal(stderrOf(await runReceiver(w, putLine(sealRelpath(seal), text, mixed), text)), 'ERRO E_TRUST_LIST_INVALID');
  const rehearsal = installTrust(w, [listItem(KEY_H)]);
  assert.equal(stdoutOf(await runReceiver(w, putLine(sealRelpath(seal), text, rehearsal), text)), `OK WRITTEN ${sealRelpath(seal)} ${sha256(text)}`);
});

/* ===================================================================================================================== P9-R04 */

test('P9-R04 destino com bytes idênticos ⇒ OK ALREADY_PRESENT (idempotente, sem nova verificação: vale mesmo com a chave agora revogada); com outros bytes ⇒ E_EXISTS_DIFFERENT (31) e o arquivo existente intacto (sha256, modo e mtime antes e depois)', async () => {
  const { w, first, trust } = hostWithChain();
  const file = path.join(w.sealsRoot, sealRelpath(first));
  const text = canonicalText(first);
  const again = await runReceiver(w, putLine(sealRelpath(first), text, trust), text);
  assert.equal(again.outcome.exitCode, 0);
  assert.equal(stdoutOf(again), `OK ALREADY_PRESENT ${sealRelpath(first)} ${sha256(text)}`);
  // a chave de A revogada na instalada: a cadeia não autenticaria mais, mas o idêntico não é reverificado (passo 5 antes do 6)
  const revoked = installTrust(w, [listItem(KEY_A, 'revoked'), listItem(KEY_B)]);
  assert.equal(stdoutOf(await runReceiver(w, putLine(sealRelpath(first), text, revoked), text)), `OK ALREADY_PRESENT ${sealRelpath(first)} ${sha256(text)}`);
  const before = { sha: sha256(fs.readFileSync(file)), stat: fs.statSync(file) };
  const [otherFirst] = chainOf(AUD_A, [{ signer: KEY_B, entries: E2 }]) as [ReturnType<typeof chainOf>[number]];
  const otherText = canonicalText(otherFirst);
  const different = await runReceiver(w, putLine(sealRelpath(otherFirst), otherText, revoked), otherText);
  assert.equal(different.outcome.exitCode, 31);
  assert.equal(stderrOf(different), 'ERRO E_EXISTS_DIFFERENT');
  const after = fs.statSync(file);
  assert.equal(sha256(fs.readFileSync(file)), before.sha, 'bytes intactos');
  assert.equal(after.mode, before.stat.mode);
  assert.equal(after.mtimeMs, before.stat.mtimeMs);
  assert.equal(after.ino, before.stat.ino, 'o mesmo arquivo (nada trocado)');
});

/* ===================================================================================================================== P9-R05 */

test('P9-R05 manifesto com assinatura forjada, de chave fora da lista, revogada ou aposentada sem fecho, ou com `seq` que não é o último + 1 do host ⇒ E_V2_REFUSED <RAZÃO> (32), nada gravado', async () => {
  const cases: Array<[string, (setup: ReturnType<typeof hostWithChain>) => { text: string; relpath: string; trust: Buffer }, string]> = [
    ['assinatura forjada', ({ second, trust }) => {
      const forged = { ...second, signature: chainOf(AUD_B, [{ signer: KEY_A }])[0]?.signature as string };
      return { text: canonicalText(forged), relpath: sealRelpath(second), trust };
    }, 'SEAL_INVALID'],
    ['chave fora da lista', ({ trust }) => {
      const outsider = chainOf(AUD_A, [{ signer: KEY_A }, { signer: KEY_X, entries: E2 }])[1] as ReturnType<typeof chainOf>[number];
      return { text: canonicalText(outsider), relpath: sealRelpath(outsider), trust };
    }, 'SEAL_INVALID'],
    ['chave revogada', ({ w, second }) => ({ text: canonicalText(second), relpath: sealRelpath(second), trust: installTrust(w, [listItem(KEY_A), listItem(KEY_B, 'revoked')]) }), 'SEAL_KEY_REVOKED'],
    ['chave aposentada sem fecho', ({ w, second }) => ({ text: canonicalText(second), relpath: sealRelpath(second), trust: installTrust(w, [listItem(KEY_A), listItem(KEY_B, 'retired')]) }), 'SEAL_KEY_RETIRED_UNCOVERED'],
    ['seq com buraco no host (3 sobre 1)', ({ trust }) => {
      const third = chainOf(AUD_A, [{ signer: KEY_A }, { signer: KEY_B, entries: E2 }, { signer: KEY_A, entries: E2 }])[2] as ReturnType<typeof chainOf>[number];
      return { text: canonicalText(third), relpath: sealRelpath(third), trust };
    }, 'SEAL_CHAIN_BROKEN'],
    ['lista instalada vazia (política fechada)', ({ w, second }) => ({ text: canonicalText(second), relpath: sealRelpath(second), trust: installTrust(w, []) }), 'PROOF_NOT_CONFIGURED'],
  ];
  for (const [label, build, reason] of cases) {
    const setup = hostWithChain();
    const before = listTree(setup.w.sealsRoot);
    const { text, relpath, trust } = build(setup);
    const run = await runReceiver(setup.w, putLine(relpath, text, trust), text);
    assert.equal(run.outcome.exitCode, 32, label);
    assert.equal(stderrOf(run), `ERRO E_V2_REFUSED ${reason}`, label);
    assert.deepEqual(listTree(setup.w.sealsRoot), before, `${label}: nada gravado (nem a subpasta, nem temporário)`);
  }
});

test('P9-R05 a cadeia do host com o candidato autentica, mas a cabeça é outra (o host já tem o 3 e falta o 2) ⇒ E_V2_REFUSED HEAD_MISMATCH; um seq 1 numa auditoria nova grava', async () => {
  const w = sealWorld();
  const trust = installTrust(w, [listItem(KEY_A), listItem(KEY_B)]);
  const [first, second, third] = chainOf(AUD_A, [{ signer: KEY_A }, { signer: KEY_B, entries: E2 }, { signer: KEY_A, entries: E2 }]) as [ReturnType<typeof chainOf>[number], ReturnType<typeof chainOf>[number], ReturnType<typeof chainOf>[number]];
  deliverOnHost(w, first);
  deliverOnHost(w, third);
  const text = canonicalText(second);
  assert.equal(stderrOf(await runReceiver(w, putLine(sealRelpath(second), text, trust), text)), 'ERRO E_V2_REFUSED HEAD_MISMATCH');
  assert.ok(!fs.existsSync(path.join(w.sealsRoot, sealRelpath(second))));
  const [fresh] = chainOf(AUD_B, [{ signer: KEY_A }]) as [ReturnType<typeof chainOf>[number]];
  const freshText = canonicalText(fresh);
  assert.equal(stdoutOf(await runReceiver(w, putLine(sealRelpath(fresh), freshText, trust), freshText)), `OK WRITTEN ${sealRelpath(fresh)} ${sha256(freshText)}`);
});

test('passo 3: formato fora do v2 estrito, bytes não canônicos ou nome incoerente ⇒ E_FORMAT (30), antes de olhar o disco', async () => {
  const { w, second, trust, text } = hostWithChain();
  const relpath = sealRelpath(second);
  const value = JSON.parse(text) as Record<string, unknown>;
  const bad: Array<[string, string, string]> = [
    ['não é JSON', 'isto não é um manifesto\n', relpath],
    ['com BOM', `﻿${text}`, relpath],
    ['espaços (não canônico)', `${JSON.stringify(value, null, 1)}\n`, relpath],
    ['sem \\n final', text.slice(0, -1), relpath],
    ['CRLF', `${text.slice(0, -1)}\r\n`, relpath],
    ['outra ordem de chaves', `${JSON.stringify(Object.fromEntries(Object.entries(value).reverse()))}\n`, relpath],
    ['campo extra', `${JSON.stringify({ ...value, extra: 1 })}\n`, relpath],
    ['seq do corpo ≠ nome', text, `${AUD_A}/seal-0003.json`],
    ['auditId do corpo ≠ pasta', text, `${AUD_B}/seal-0002.json`],
    ['manifesto no lugar de um fecho', text, '_closures/ek-host-a.json'],
  ];
  for (const [label, body, target] of bad) {
    const run = await runReceiver(w, putLine(target, body, trust), body);
    assert.equal(run.outcome.exitCode, 30, label);
    assert.equal(stderrOf(run), 'ERRO E_FORMAT', label);
  }
  assert.deepEqual(listTree(w.sealsRoot), [AUD_A, `${AUD_A}/seal-0001.json`]);
});

/* ===================================================================================================================== P9-R06 */

test('P9-R06 raiz como link simbólico ou arquivo, subpasta como link ou arquivo, `_closures` como link, destino FIFO, link ou pasta ⇒ E_UNSAFE_PATH (34); nada seguido nem gravado', { timeout: 30_000 }, async () => {
  const { w, second, text, command, first } = hostWithChain();
  // raiz = link para a pasta real
  const alias = path.join(w.root, 'manifestos-apelido');
  fs.symlinkSync(w.sealsRoot, alias);
  const grantRoot = (other: string) => ({ has: (scope: 'fs.read' | 'fs.write' | 'child' | 'worker', ref?: string) => (scope === 'fs.write' && ref === other) || wrapperPermission(w).has(scope, ref) });
  const viaLink = await runReceiver(w, command, text, { argv: w.argv.map((arg) => (arg === w.sealsRoot ? alias : arg)), permission: grantRoot(alias) });
  assert.equal(viaLink.outcome.exitCode, 34);
  assert.equal(stderrOf(viaLink), 'ERRO E_UNSAFE_PATH');
  // raiz que é um arquivo
  const rootFile = path.join(w.root, 'manifestos-arquivo');
  fs.writeFileSync(rootFile, 'x');
  assert.equal(stderrOf(await runReceiver(w, command, text, { argv: w.argv.map((arg) => (arg === w.sealsRoot ? rootFile : arg)), permission: grantRoot(rootFile) })), 'ERRO E_UNSAFE_PATH');
  // subpasta da auditoria como link (para uma pasta real fora) e como arquivo
  const outside = path.join(w.root, 'fora');
  fs.mkdirSync(outside);
  fs.renameSync(path.join(w.sealsRoot, AUD_A), path.join(outside, AUD_A));
  fs.symlinkSync(path.join(outside, AUD_A), path.join(w.sealsRoot, AUD_A));
  assert.equal(stderrOf(await runReceiver(w, command, text)), 'ERRO E_UNSAFE_PATH', 'subpasta link');
  assert.deepEqual(fs.readdirSync(path.join(outside, AUD_A)), ['seal-0001.json'], 'nada gravado pelo link');
  fs.rmSync(path.join(w.sealsRoot, AUD_A));
  fs.writeFileSync(path.join(w.sealsRoot, AUD_A), 'x');
  assert.equal(stderrOf(await runReceiver(w, command, text)), 'ERRO E_UNSAFE_PATH', 'subpasta arquivo');
  fs.rmSync(path.join(w.sealsRoot, AUD_A));
  deliverOnHost(w, first);
  // destino FIFO, link e pasta
  const dest = path.join(w.sealsRoot, sealRelpath(second));
  const fifo = spawnSync('mkfifo', [dest]);
  assert.equal(fifo.status, 0, 'mkfifo disponível');
  const started = Date.now();
  assert.equal(stderrOf(await runReceiver(w, command, text)), 'ERRO E_UNSAFE_PATH', 'destino FIFO');
  assert.ok(Date.now() - started < 10_000, 'o FIFO nunca é aberto (nada trava)');
  fs.rmSync(dest);
  fs.symlinkSync(path.join(w.sealsRoot, sealRelpath(first)), dest);
  assert.equal(stderrOf(await runReceiver(w, command, text)), 'ERRO E_UNSAFE_PATH', 'destino link');
  fs.rmSync(dest);
  fs.mkdirSync(dest);
  assert.equal(stderrOf(await runReceiver(w, command, text)), 'ERRO E_UNSAFE_PATH', 'destino pasta');
  fs.rmdirSync(dest);
  // `_closures` como link
  const closureDir = path.join(outside, '_closures');
  fs.mkdirSync(closureDir);
  fs.symlinkSync(closureDir, path.join(w.sealsRoot, '_closures'));
  const closure = closureFor(KEY_B, KEY_A, [first]);
  const closureText = canonicalText(closure);
  const trust = installTrust(w, [listItem(KEY_A), listItem(KEY_B)]);
  assert.equal(stderrOf(await runReceiver(w, putLine(`_closures/${KEY_B.keyId}.json`, closureText, trust), closureText)), 'ERRO E_UNSAFE_PATH', '_closures link');
  assert.deepEqual(fs.readdirSync(closureDir), []);
});

/* ===================================================================================================================== P9-R07 */

test('P9-R07 falha injetada no fsync do arquivo (ou na escrita, no mkdir, no link) ⇒ E_WRITE_FAILED (35) sem nome final nem temporário; no fsync da pasta ou na remoção do temporário ⇒ E_WRITE_UNCONFIRMED (36), arquivo final presente e nunca apagado; a entrega seguinte acha ALREADY_PRESENT', async () => {
  const { w, second, text, command } = hostWithChain();
  const dest = path.join(w.sealsRoot, sealRelpath(second));
  const auditDir = path.join(w.sealsRoot, AUD_A);
  const failedBeforeLink: Array<[string, Partial<BytesFsOps>]> = [
    ['fsync do arquivo', { writeExclusive: async (target, data, mode) => { await sealReceiverFs.writeExclusive(target, data, mode); throw errno('EIO'); } }],
    ['escrita (sem espaço)', { writeExclusive: async () => { throw errno('ENOSPC'); } }],
    ['link (EPERM)', { link: async () => { throw errno('EPERM'); } }],
  ];
  for (const [label, overrides] of failedBeforeLink) {
    const run = await runReceiver(w, command, text, { fs: faultyFs(overrides) });
    assert.equal(run.outcome.exitCode, 35, label);
    assert.equal(stderrOf(run), 'ERRO E_WRITE_FAILED', label);
    assert.deepEqual(fs.readdirSync(auditDir), ['seal-0001.json'], `${label}: nem nome final nem temporário`);
  }
  // auditoria nova: o mkdir falha ⇒ nada; o fsync da raiz (pasta nova) falha ⇒ ainda antes do link
  const [fresh] = chainOf(AUD_B, [{ signer: KEY_A }]) as [ReturnType<typeof chainOf>[number]];
  const freshText = canonicalText(fresh);
  const freshCommand = putLine(sealRelpath(fresh), freshText, installTrust(w, [listItem(KEY_A), listItem(KEY_B)]));
  assert.equal(stderrOf(await runReceiver(w, freshCommand, freshText, { fs: faultyFs({ mkdir: async () => { throw errno('EACCES'); } }) })), 'ERRO E_WRITE_FAILED');
  assert.ok(!fs.existsSync(path.join(w.sealsRoot, AUD_B)));
  assert.equal(stderrOf(await runReceiver(w, freshCommand, freshText, { fs: faultyFs({ syncDirectory: async (dir) => { if (dir === w.sealsRoot) throw errno('EIO'); return sealReceiverFs.syncDirectory(dir); } }) })), 'ERRO E_WRITE_FAILED');
  assert.deepEqual(fs.readdirSync(path.join(w.sealsRoot, AUD_B)), [], 'pasta criada, nenhum arquivo');
  // depois do link
  const unconfirmedDir = await runReceiver(w, command, text, { fs: faultyFs({ syncDirectory: async (dir) => { if (dir === auditDir) throw errno('EIO'); return sealReceiverFs.syncDirectory(dir); } }) });
  assert.equal(unconfirmedDir.outcome.exitCode, 36);
  assert.equal(stderrOf(unconfirmedDir), 'ERRO E_WRITE_UNCONFIRMED');
  assert.equal(fs.readFileSync(dest, 'utf8'), text, 'o arquivo final existe e não foi apagado');
  assert.equal(stdoutOf(await runReceiver(w, command, text)), `OK ALREADY_PRESENT ${sealRelpath(second)} ${sha256(text)}`, 'a próxima entrega acha ALREADY_PRESENT');
  // remoção do temporário falha (outra auditoria nova, para gravar de novo)
  const [freshC] = chainOf('aud-00000000000000c1', [{ signer: KEY_A }]) as [ReturnType<typeof chainOf>[number]];
  const freshCText = canonicalText(freshC);
  const trust = fs.readFileSync(w.trustFile);
  const noUnlink = await runReceiver(w, putLine(sealRelpath(freshC), freshCText, trust), freshCText, { fs: faultyFs({ unlink: async () => { throw errno('EIO'); } }) });
  assert.equal(stderrOf(noUnlink), 'ERRO E_WRITE_UNCONFIRMED');
  const names = fs.readdirSync(path.join(w.sealsRoot, freshC.auditId)).sort();
  assert.equal(names.length, 2);
  assert.equal(names[1], 'seal-0001.json', 'o final ficou');
  assert.match(names[0] as string, /^\.seal-0001\.json\.tmp-[0-9a-f]{32}$/, 'o temporário que sobrou está fora do nome de manifesto');
});

/* ===================================================================================================================== P9-R08 */

test('P9-R08 duas entregas concorrentes do mesmo arquivo ⇒ uma WRITTEN e a outra ALREADY_PRESENT; de bytes diferentes no mesmo nome ⇒ uma WRITTEN e a outra E_EXISTS_DIFFERENT', async () => {
  const { w, second, text, command } = hostWithChain();
  const same = await Promise.all([putOnly(w, command, text), putOnly(w, command, text)]);
  assert.deepEqual(same.map((line) => line.split(' ')[1]).sort(), ['ALREADY_PRESENT', 'WRITTEN']);
  assert.equal(fs.readFileSync(path.join(w.sealsRoot, sealRelpath(second)), 'utf8'), text);
  const other = hostWithChain();
  const [, rival] = chainOf(AUD_A, [{ signer: KEY_A }, { signer: KEY_A, entries: E1 }]) as [unknown, ReturnType<typeof chainOf>[number]];
  const rivalText = canonicalText(rival);
  assert.notEqual(rivalText, other.text);
  const mixed = await Promise.all([putOnly(other.w, other.command, other.text), putOnly(other.w, putLine(sealRelpath(rival), rivalText, other.trust), rivalText)]);
  assert.deepEqual(mixed.map((line) => line.split(' ').slice(0, 2).join(' ')).sort(), ['ERRO E_EXISTS_DIFFERENT', 'OK WRITTEN']);
});

test('P9-R08 corrida determinística no link(): outro processo grava o MESMO nome entre o passo 5 e o link ⇒ EEXIST ⇒ volta ao passo 5: bytes iguais ⇒ ALREADY_PRESENT, outros ⇒ E_EXISTS_DIFFERENT; o temporário é removido e o arquivo do outro fica intacto', async () => {
  for (const [label, rivalBytes, expected] of [['iguais', null, 'ALREADY_PRESENT'], ['diferentes', 'outros bytes\n', 'E_EXISTS_DIFFERENT']] as const) {
    const { w, second, text, command } = hostWithChain();
    const dest = path.join(w.sealsRoot, sealRelpath(second));
    let raced = 0;
    const racing = faultyFs({
      link: async (from, to) => {
        if (to === dest && raced === 0) {
          raced += 1;
          fs.writeFileSync(dest, rivalBytes ?? text, { mode: 0o444 });
        }
        return sealReceiverFs.link(from, to);
      },
    });
    const log = new MemoryLog();
    const run = await runReceiver(w, command, text, { fs: racing, log });
    assert.equal(raced, 1, label);
    if (expected === 'ALREADY_PRESENT') assert.equal(stdoutOf(run), `OK ALREADY_PRESENT ${sealRelpath(second)} ${sha256(text)}`, label);
    else assert.equal(stderrOf(run), 'ERRO E_EXISTS_DIFFERENT', label);
    assert.ok(log.entries.some((entry) => entry.event === 'put.link_conflict'), `${label}: a corrida fica no log`);
    assert.equal(fs.readFileSync(dest, 'utf8'), rivalBytes ?? text, `${label}: o arquivo do outro intacto`);
    assert.deepEqual(fs.readdirSync(path.join(w.sealsRoot, AUD_A)).sort(), ['seal-0001.json', 'seal-0002.json'], `${label}: sem temporário`);
  }
});

test('trava de DEFESA: arquivo de trava existente (outra execução, ou uma morta por SIGKILL) ⇒ E_LOCKED (16) sem ler o stdin, e o arquivo alheio nunca é apagado; duas execuções simultâneas do receptor ⇒ uma recusa com E_LOCKED', { timeout: 30_000 }, async () => {
  const { w, text, command } = hostWithChain();
  fs.writeFileSync(w.lockFile, '999999\n', { mode: 0o600 });
  const locked = await runReceiver(w, command, text);
  assert.equal(locked.outcome.exitCode, 16);
  assert.equal(stderrOf(locked), 'ERRO E_LOCKED');
  assert.equal((locked.stdin as FakeStdin).reads, 0, 'stdin não lido');
  assert.equal(fs.readFileSync(w.lockFile, 'utf8'), '999999\n', 'a trava alheia fica');
  fs.rmSync(w.lockFile);
  // a primeira execução avisa quando chega ao stdin (já com a trava) e só segue quando o teste a solta: sem corrida de tempo
  let releaseFirst: () => void = () => undefined;
  let reachedStdin: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reachedStdin = resolve;
  });
  const firstStdin = {
    next: async () => {
      reachedStdin();
      await gate;
      return { kind: 'end' as const };
    },
  };
  const first = runReceiver(w, command, firstStdin);
  await reached;
  assert.ok(fs.existsSync(w.lockFile), 'a primeira execução segura a trava');
  const second = await runReceiver(w, command, text);
  assert.equal(stderrOf(second), 'ERRO E_LOCKED');
  releaseFirst();
  assert.equal(stderrOf(await first), 'ERRO E_INPUT_TRUNCATED');
  assert.ok(!fs.existsSync(w.lockFile), 'a trava própria é liberada');
});

test('trava de DEFESA, liberação: só apaga o arquivo que ainda é o MESMO que este processo criou (dispositivo e inode); um arquivo trocado no meio fica, e a liberação não lê o arquivo (sob --permission só há escrita na pasta da trava)', async () => {
  const w = sealWorld();
  const release = await nodeLock.tryAcquire(w.lockFile);
  assert.ok(release);
  assert.equal(await nodeLock.tryAcquire(w.lockFile), null, 'a segunda aquisição recusa');
  fs.rmSync(w.lockFile);
  fs.writeFileSync(w.lockFile, '424242\n', { mode: 0o600 });
  await release();
  assert.equal(fs.readFileSync(w.lockFile, 'utf8'), '424242\n', 'a trava alheia (outro inode) fica');
  fs.rmSync(w.lockFile);
  const own = await nodeLock.tryAcquire(w.lockFile);
  assert.ok(own);
  assert.equal(fs.readFileSync(w.lockFile, 'utf8'), `${process.pid}\n`, 'o pid fica no arquivo para o responsável');
  await own();
  assert.ok(!fs.existsSync(w.lockFile), 'a própria é apagada');
});

/* ===================================================================================================================== P9-R09 */

test('P9-R09 fecho: as regras do S-11 contra as cadeias DO HOST (signatário fora da lista ou não `active`, assinatura forjada, aposentada fora da lista, cabeça ausente do host, com outro sealSha256 ou numa pasta de auditoria que é link) ⇒ E_CLOSURE_REFUSED <MOTIVO> (33); válido ⇒ OK WRITTEN em _closures', async () => {
  const w = sealWorld();
  const trust = installTrust(w, [listItem(KEY_A), listItem(KEY_T), listItem(KEY_B, 'retired'), listItem(KEY_R, 'revoked')]);
  const [onHost] = chainOf(AUD_A, [{ signer: KEY_T }]) as [ReturnType<typeof chainOf>[number]];
  deliverOnHost(w, onHost);
  const [notOnHost] = chainOf(AUD_B, [{ signer: KEY_T }]) as [ReturnType<typeof chainOf>[number]];
  const [otherOnHostSha] = chainOf(AUD_A, [{ signer: KEY_T, entries: E2 }]) as [ReturnType<typeof chainOf>[number]];
  const relpath = `_closures/${KEY_T.keyId}.json`;
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['signatário fora da lista', closureFor(KEY_T, KEY_X, [onHost]), 'SIGNER_NOT_LISTED'],
    ['signatário aposentado na lista instalada', closureFor(KEY_T, KEY_B, [onHost]), 'SIGNER_NOT_ACTIVE'],
    ['signatário revogado na lista instalada', closureFor(KEY_T, KEY_R, [onHost]), 'SIGNER_NOT_ACTIVE'],
    ['assinatura forjada', { ...closureFor(KEY_T, KEY_A, [onHost]), signature: closureFor(KEY_T, KEY_A, [notOnHost]).signature }, 'SIGNATURE_INVALID'],
    ['cabeça ausente do host', closureFor(KEY_T, KEY_A, [onHost, notOnHost]), 'HEAD_NOT_IN_REPO'],
    ['cabeça com outro sealSha256 no host', closureFor(KEY_T, KEY_A, [otherOnHostSha]), 'HEAD_NOT_IN_REPO'],
  ];
  for (const [label, closure, motive] of cases) {
    const text = canonicalText(closure);
    const run = await runReceiver(w, putLine(relpath, text, trust), text);
    assert.equal(run.outcome.exitCode, 33, label);
    assert.equal(stderrOf(run), `ERRO E_CLOSURE_REFUSED ${motive}`, label);
  }
  const outsiderRetired = canonicalText(closureFor(KEY_X, KEY_A, [onHost]));
  assert.equal(stderrOf(await runReceiver(w, putLine(`_closures/${KEY_X.keyId}.json`, outsiderRetired, trust), outsiderRetired)), 'ERRO E_CLOSURE_REFUSED RETIRED_NOT_LISTED');
  assert.ok(!fs.existsSync(path.join(w.sealsRoot, '_closures')), 'nada gravado: nem a pasta dos fechos');
  const named = canonicalText(closureFor(KEY_T, KEY_A, [onHost]));
  assert.equal(stderrOf(await runReceiver(w, putLine(`_closures/${KEY_A.keyId}.json`, named, trust), named)), 'ERRO E_FORMAT', 'nome ≠ retiredKeyId');
  assert.equal(stderrOf(await runReceiver(w, putLine(relpath, '{"kind":"x"}\n', trust), '{"kind":"x"}\n')), 'ERRO E_FORMAT', 'fecho fora do esquema');
  // revisão do PR #72, item 3: a cabeça numa pasta de auditoria que é link (para fora da raiz, com o manifesto certo lá) não conta
  const outside = path.join(w.root, 'fora-da-raiz');
  fs.mkdirSync(outside);
  fs.renameSync(path.join(w.sealsRoot, AUD_A), path.join(outside, AUD_A));
  fs.symlinkSync(path.join(outside, AUD_A), path.join(w.sealsRoot, AUD_A));
  assert.equal(stderrOf(await runReceiver(w, putLine(relpath, named, trust), named)), 'ERRO E_CLOSURE_REFUSED HEAD_NOT_IN_REPO', 'pasta da auditoria como link');
  fs.rmSync(path.join(w.sealsRoot, AUD_A));
  fs.renameSync(path.join(outside, AUD_A), path.join(w.sealsRoot, AUD_A));
  const ok = await runReceiver(w, putLine(relpath, named, trust), named);
  assert.equal(stdoutOf(ok), `OK WRITTEN ${relpath} ${sha256(named)}`);
  assert.equal(fs.readFileSync(path.join(w.sealsRoot, relpath), 'utf8'), named);
  assert.equal(stdoutOf(await runReceiver(w, putLine(relpath, named, trust), named)), `OK ALREADY_PRESENT ${relpath} ${sha256(named)}`);
});

/* ===================================================================================================================== P9-R10 */

test('P9-R10 toda saída é exatamente uma linha da gramática do §5.8, com a saída numérica da tabela; nenhum caminho absoluto, conteúdo de arquivo ou valor (teste sobre todas as recusas); o log local leva códigos e campos públicos, nunca o conteúdo', async () => {
  const seen = new Map<string, number>();
  const record = (run: Awaited<ReturnType<typeof runReceiver>>): void => {
    const line = run.outcome.stdout ?? run.outcome.stderr ?? '';
    const code = line.startsWith('OK') ? 'OK' : (line.split(' ')[1] as string);
    seen.set(code, run.outcome.exitCode);
    for (const entry of run.log.entries) {
      const text = JSON.stringify(entry);
      assert.ok(!text.includes('"signature"') && !text.includes('LINK_AUDIT_EVIDENCE_SEAL') && !text.includes('contentSha256'), `conteúdo no log: ${text}`);
    }
  };
  const base = hostWithChain();
  record(await runReceiver(base.w, 'qualquer-coisa; id', ''));
  record(await runReceiver(base.w, base.command, new FakeStdin([Buffer.alloc(300 * 1024)])));
  record(await runReceiver(base.w, base.command, new FakeStdin([], 'hang')));
  record(await runReceiver(base.w, base.command, 'x'));
  record(await runReceiver(base.w, putLine(sealRelpath(base.second), base.text, 'outra lista'), base.text));
  fs.writeFileSync(base.w.lockFile, '1\n');
  record(await runReceiver(base.w, base.command, base.text));
  fs.rmSync(base.w.lockFile);
  record(await runReceiver(base.w, base.command, base.text, { env: { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: base.command, NODE_OPTIONS: '--require /tmp/x.js' } }));
  record(await runReceiver(base.w, putLine(sealRelpath(base.second), 'x\n', base.trust), 'x\n'));
  const forged = canonicalText({ ...base.second, signature: base.first.signature });
  record(await runReceiver(base.w, putLine(sealRelpath(base.second), forged, base.trust), forged));
  const closure = canonicalText(closureFor(KEY_B, KEY_X, [base.first]));
  record(await runReceiver(base.w, putLine(`_closures/${KEY_B.keyId}.json`, closure, base.trust), closure));
  record(await runReceiver(base.w, base.command, base.text, { fs: faultyFs({ link: async () => { throw errno('EXDEV'); } }) }));
  record(await runReceiver(base.w, base.command, base.text, { fs: faultyFs({ syncDirectory: async (dir) => { if (dir === path.join(base.w.sealsRoot, AUD_A)) throw errno('EIO'); return sealReceiverFs.syncDirectory(dir); } }) }));
  record(await runReceiver(base.w, base.command, base.text));
  const [, rival] = chainOf(AUD_A, [{ signer: KEY_A }, { signer: KEY_A, entries: E1 }]) as [unknown, ReturnType<typeof chainOf>[number]];
  const rivalText = canonicalText(rival);
  record(await runReceiver(base.w, putLine(sealRelpath(rival), rivalText, base.trust), rivalText));
  fs.symlinkSync(path.join(base.w.sealsRoot, AUD_A), path.join(base.w.sealsRoot, AUD_B));
  const [onB] = chainOf(AUD_B, [{ signer: KEY_A }]) as [ReturnType<typeof chainOf>[number]];
  record(await runReceiver(base.w, putLine(sealRelpath(onB), canonicalText(onB), base.trust), canonicalText(onB)));
  const invalid = hostWithChain();
  const badList = Buffer.from('lista fora da gramática\n', 'ascii');
  fs.writeFileSync(invalid.w.trustFile, badList);
  record(await runReceiver(invalid.w, putLine(sealRelpath(invalid.second), invalid.text, badList), invalid.text));
  const post = hostWithChain();
  record(await runReceiver(post.w, post.command, post.text, { fs: rereadReturns(post.w, post.second, Buffer.from('trocado\n')) }));
  const expected = new Map<string, number>([['OK', 0], ...Object.entries(SEAL_RECEIVER_EXIT_CODES).filter(([code]) => code !== 'E_ARTIFACT')]);
  for (const [code, exit] of expected) assert.equal(seen.get(code), exit, `${code}: produzido, com a saída ${exit}`);
});

test('P9-R10 o conjunto fechado: detalhe só em E_V2_REFUSED (razões do verificador + HEAD_MISMATCH) e E_CLOSURE_REFUSED (motivos do S-11); os códigos comuns têm os MESMOS números do receptor de deploy', () => {
  assert.equal(publicErrorLine('E_V2_REFUSED', 'SEAL_KEY_REVOKED'), 'ERRO E_V2_REFUSED SEAL_KEY_REVOKED');
  assert.equal(publicErrorLine('E_V2_REFUSED', 'HEAD_MISMATCH'), 'ERRO E_V2_REFUSED HEAD_MISMATCH');
  assert.equal(publicErrorLine('E_CLOSURE_REFUSED', 'HEAD_NOT_IN_REPO'), 'ERRO E_CLOSURE_REFUSED HEAD_NOT_IN_REPO');
  assert.equal(publicErrorLine('E_CLOSURE_REFUSED', 'SEAL_KEY_REVOKED'), 'ERRO E_CLOSURE_REFUSED', 'detalhe fora do conjunto do código some');
  assert.equal(publicErrorLine('E_FORMAT', 'SEAL_INVALID'), 'ERRO E_FORMAT');
  assert.deepEqual([...V2_REFUSAL_DETAILS], ['PROOF_NOT_CONFIGURED', 'NO_SEAL', 'LEGACY_NO_SEAL', 'SEAL_INVALID', 'EVIDENCE_NOT_SEALED', 'EVIDENCE_MISSING', 'EVIDENCE_HASH_MISMATCH', 'VERIFICATION_ERROR', 'SEAL_CHAIN_BROKEN', 'SEAL_NOT_CUMULATIVE', 'SEAL_DOWNGRADE', 'SEAL_VERSION_NOT_ALLOWED', 'SEAL_KEY_RETIRED_UNCOVERED', 'SEAL_KEY_REVOKED', 'HEAD_MISMATCH']);
  assert.deepEqual([...CLOSURE_REFUSAL_DETAILS], ['SIGNER_NOT_LISTED', 'SIGNER_NOT_ACTIVE', 'SIGNATURE_INVALID', 'RETIRED_NOT_LISTED', 'HEAD_NOT_IN_REPO']);
  for (const code of ['E_COMMAND', 'E_INPUT_TOO_LARGE', 'E_INPUT_TRUNCATED', 'E_HASH_MISMATCH', 'E_TRUST_LIST_MISMATCH', 'E_TRUST_LIST_INVALID', 'E_LOCKED', 'E_ARTIFACT', 'E_INTERNAL'] as const) {
    assert.equal(SEAL_RECEIVER_EXIT_CODES[code], RECEIVER_EXIT_CODES[code], code);
  }
  assert.deepEqual(Object.values(SEAL_RECEIVER_EXIT_CODES).filter((exit) => exit >= 30), [30, 31, 32, 33, 34, 35, 36, 37]);
});

test('E_INTERNAL (29): ambiente além de PATH e SSH_ORIGINAL_COMMAND, PATH relativo, parâmetro fixo inválido, modelo de permissões desligado, filho ou worker permitidos, grant global de disco, lista instalada gravável ou log que não é privado ⇒ recusa da instalação, sem ler o stdin', async () => {
  const { w, text, command } = hostWithChain();
  const cases: Array<[string, Parameters<typeof runReceiver>[3]]> = [
    ['ambiente a mais', { env: { PATH: '/usr/bin:/bin', SSH_ORIGINAL_COMMAND: command, HOME: '/root' } }],
    ['PATH relativo', { env: { PATH: 'bin:/usr/bin', SSH_ORIGINAL_COMMAND: command } }],
    ['sem PATH', { env: { SSH_ORIGINAL_COMMAND: command } }],
    ['flag desconhecida', { argv: [...w.argv, '--extra', 'x'] }],
    ['flag ausente', { argv: w.argv.slice(0, -2) }],
    ['caminho relativo', { argv: w.argv.map((arg) => (arg === w.sealsRoot ? 'srv/manifestos' : arg)) }],
    ['caminho não normalizado', { argv: w.argv.map((arg) => (arg === w.trustFile ? `${w.stateDir}/./trust-keys.txt` : arg)) }],
    ['ambiente desconhecido', { argv: w.argv.map((arg) => (arg === 'producao' ? 'staging' : arg)) }],
    ['log dentro da pasta de manifestos', { argv: w.argv.map((arg) => (arg === w.logFile ? path.join(w.sealsRoot, 'log') : arg)) }],
    ['modelo de permissões desligado', { permission: null }],
    ['filho permitido', { permission: { has: (scope, ref) => scope === 'child' || wrapperPermission(w).has(scope, ref) } }],
    ['worker permitido', { permission: { has: (scope, ref) => scope === 'worker' || wrapperPermission(w).has(scope, ref) } }],
    ['lista instalada gravável', { permission: { has: (scope, ref) => (scope === 'fs.write' && ref === w.trustFile) || wrapperPermission(w).has(scope, ref) } }],
    ['leitura global (--allow-fs-read=*)', { permission: { has: (scope, ref) => (scope === 'fs.read' && ref === undefined) || wrapperPermission(w).has(scope, ref) } }],
    ['escrita global (--allow-fs-write=*)', { permission: { has: (scope, ref) => (scope === 'fs.write' && ref === undefined) || wrapperPermission(w).has(scope, ref) } }],
    ['pasta de manifestos sem escrita', { permission: { has: (scope, ref) => !(scope === 'fs.write' && ref === w.sealsRoot) && wrapperPermission(w).has(scope, ref) } }],
  ];
  for (const [label, options] of cases) {
    const stdin = FakeStdin.of(text);
    const run = await runReceiver(w, command, stdin, options);
    assert.equal(run.outcome.exitCode, 29, label);
    assert.equal(stderrOf(run), 'ERRO E_INTERNAL', label);
    assert.equal(stdin.reads, 0, `${label}: stdin não lido`);
  }
  fs.chmodSync(w.logFile, 0o644);
  assert.throws(() => openReceiverLog(w.logFile, new FakeClock()), /private regular file/, 'log legível por grupo ou outros: a fábrica lança (E_INTERNAL)');
  const throwing = await runSealReceiverWith(w, command, text, () => openReceiverLog(w.logFile, new FakeClock()));
  assert.equal(throwing.exitCode, 29);
  assert.equal(throwing.stderr, 'ERRO E_INTERNAL');
  assert.equal(parseSealReceiverArgs(w.argv)?.sealsRoot, w.sealsRoot);
});

test('passo 8: a releitura do arquivo gravado acha outros bytes, ou a cadeia relida do disco não fecha no candidato ⇒ E_POSTWRITE_VERIFY (37); o arquivo gravado nunca é apagado', async () => {
  const { w, second, text, command } = hostWithChain();
  const run = await runReceiver(w, command, text, { fs: rereadReturns(w, second, Buffer.from('trocado\n')) });
  assert.equal(run.outcome.exitCode, 37);
  assert.equal(stderrOf(run), 'ERRO E_POSTWRITE_VERIFY');
  assert.equal(fs.readFileSync(path.join(w.sealsRoot, sealRelpath(second)), 'utf8'), text, 'o arquivo fica');
  const other = hostWithChain();
  const dest = path.join(other.w.sealsRoot, sealRelpath(other.second));
  let linked = false;
  const brokenChain = faultyFs({
    link: async (from, to) => {
      await sealReceiverFs.link(from, to);
      if (to === dest) linked = true;
    },
    readFile: async (file, max) => (linked && file === dest ? 'não é mais um manifesto\n' : sealReceiverFs.readFile(file, max)),
  });
  assert.equal(stderrOf(await runReceiver(other.w, other.command, other.text, { fs: brokenChain })), 'ERRO E_POSTWRITE_VERIFY');
  assert.ok(fs.existsSync(dest));
});

/* ===================================================================================================================== P9-R12 */

test('P9-R12 depois da gravação: o arquivo é 0444 (mesmo com umask 027) e a pasta nova (auditoria e _closures) herda o grupo e o setgid da raiz (2750)', async () => {
  const w = sealWorld();
  const trust = installTrust(w, [listItem(KEY_A), listItem(KEY_T)]);
  const [seal] = chainOf(AUD_A, [{ signer: KEY_T }]) as [ReturnType<typeof chainOf>[number]];
  const text = canonicalText(seal);
  assert.equal(stdoutOf(await runReceiver(w, putLine(sealRelpath(seal), text, trust), text)), `OK WRITTEN ${sealRelpath(seal)} ${sha256(text)}`);
  const closure = canonicalText(closureFor(KEY_T, KEY_A, [seal]));
  assert.equal(stdoutOf(await runReceiver(w, putLine(`_closures/${KEY_T.keyId}.json`, closure, trust), closure)), `OK WRITTEN _closures/${KEY_T.keyId}.json ${sha256(closure)}`);
  const root = fs.statSync(w.sealsRoot);
  for (const dir of [AUD_A, '_closures']) {
    const info = fs.statSync(path.join(w.sealsRoot, dir));
    assert.equal(info.mode & 0o7777, 0o2750, `${dir}: 2750 (setgid herdado, umask 027)`);
    assert.equal(info.gid, root.gid, `${dir}: grupo da raiz`);
  }
  for (const file of [sealRelpath(seal), `_closures/${KEY_T.keyId}.json`]) {
    const info = fs.statSync(path.join(w.sealsRoot, file));
    assert.equal(info.mode & 0o7777, 0o444, `${file}: 0444`);
    assert.equal(info.gid, root.gid, `${file}: grupo da raiz`);
    assert.equal(info.nlink, 1, `${file}: o temporário foi removido (um nome só)`);
  }
});

/* ===================================================================================================================== P9-R13 */

test('P9-R13 lista instalada trocada (rename atômico) no meio de uma sequência de put: os seguintes recusam com E_TRUST_LIST_MISMATCH e nada gravam; cada put lê a lista UMA vez e usa esses bytes para o hash, o formato e a verificação (nunca um arquivo parcial); repetidos com o hash novo, gravam', async () => {
  const w = sealWorld();
  const oldList = installTrust(w, [listItem(KEY_A), listItem(KEY_B)]);
  const seals = chainOf(AUD_A, [{ signer: KEY_A }, { signer: KEY_B, entries: E2 }, { signer: KEY_A, entries: E2 }]);
  const texts = seals.map((seal) => canonicalText(seal));
  const [first, second, third] = seals as [(typeof seals)[number], (typeof seals)[number], (typeof seals)[number]];
  const newLines = [listItem(KEY_A), listItem(KEY_B), listItem(KEY_X, 'revoked')];
  const newBytes = Buffer.from(newLines.map((line) => `${line}\n`).join(''), 'ascii');
  // o primeiro put lê a lista antiga; logo depois da leitura (dentro do mesmo put) o deploy troca a instalada: o put segue com os bytes que leu
  let swapped = false;
  const reads: string[] = [];
  const swapping = faultyFs({
    readFileBytes: async (file, max) => {
      const bytes = await sealReceiverFs.readFileBytes(file, max);
      if (file === w.trustFile) {
        reads.push(file);
        if (!swapped) {
          swapped = true;
          installTrust(w, newLines);
        }
      }
      return bytes;
    },
  });
  assert.equal(stdoutOf(await runReceiver(w, putLine(sealRelpath(first), texts[0] as string, oldList), texts[0] as string, { fs: swapping })), `OK WRITTEN ${sealRelpath(first)} ${sha256(texts[0] as string)}`);
  assert.equal(reads.length, 1, 'uma leitura da lista por put');
  for (const seal of [second, third]) {
    const text = canonicalText(seal);
    const run = await runReceiver(w, putLine(sealRelpath(seal), text, oldList), text, { fs: swapping });
    assert.equal(stderrOf(run), 'ERRO E_TRUST_LIST_MISMATCH');
  }
  assert.equal(reads.length, 3);
  assert.deepEqual(fs.readdirSync(path.join(w.sealsRoot, AUD_A)), ['seal-0001.json'], 'nada gravado com a lista velha');
  for (const seal of [second, third]) {
    const text = canonicalText(seal);
    assert.equal(stdoutOf(await runReceiver(w, putLine(sealRelpath(seal), text, newBytes), text)), `OK WRITTEN ${sealRelpath(seal)} ${sha256(text)}`);
  }
  assert.deepEqual(fs.readdirSync(path.join(w.sealsRoot, AUD_A)).sort(), ['seal-0001.json', 'seal-0002.json', 'seal-0003.json']);
});

test('log local real: 0600, uma linha JSON por evento, com o pedido (comando da gramática), o código e a nota; nunca o conteúdo do manifesto', async () => {
  const { w, text, command, second } = hostWithChain();
  const log = openReceiverLog(w.logFile, new FakeClock());
  const ok = await runReceiver(w, command, text, { log });
  assert.equal(stdoutOf(ok), `OK WRITTEN ${sealRelpath(second)} ${sha256(text)}`);
  await runReceiver(w, 'put x', '', { log });
  const lines = fs.readFileSync(w.logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(fs.statSync(w.logFile).mode & 0o777, 0o600);
  assert.deepEqual(lines.map((line) => line.event), ['request', 'put.written', 'result', 'request', 'result']);
  assert.equal(lines[0]?.command, command);
  assert.equal(lines[3]?.command, null, 'comando fora da gramática não vai ao log');
  assert.equal(lines[4]?.code, 'E_COMMAND');
  const raw = fs.readFileSync(w.logFile, 'utf8');
  for (const forbidden of [second.signature, 'contentSha256', 'LINK_AUDIT_EVIDENCE_SEAL']) assert.ok(!raw.includes(forbidden), `${forbidden} no log`);
});

test('adaptador de disco: a escrita exclusiva grava o modo pedido mesmo com umask 027, recusa nome existente (EEXIST) e não segue link; a leitura não segue link nem trava em FIFO', async () => {
  const dir = sealWorld().root;
  const file = path.join(dir, 'novo');
  await sealReceiverFs.writeExclusive(file, 'abc', 0o444);
  assert.equal(fs.statSync(file).mode & 0o777, 0o444);
  await assert.rejects(sealReceiverFs.writeExclusive(file, 'x', 0o444), (error: unknown) => (error as { code?: string }).code === 'EEXIST');
  const link = path.join(dir, 'link');
  fs.symlinkSync(path.join(dir, 'alvo-inexistente'), link);
  await assert.rejects(sealReceiverFs.writeExclusive(link, 'x', 0o444), (error: unknown) => (error as { code?: string }).code === 'EEXIST');
  assert.ok(!fs.existsSync(path.join(dir, 'alvo-inexistente')), 'o link nunca é seguido');
  assert.equal(sealReceiverFs.readFileBytes, nodeFsOps.readFileBytes, 'a leitura é a do adaptador padrão da Fase 6');
});
