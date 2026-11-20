import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import { cliWorld, NOW, sealFile, treeOf, type CliWorld } from './helpers/link-audit-seal-sign-cli-fixtures';

/*
 * P1 W4.4 — o `sign` num PSEUDO-TERMINAL de verdade (§5.5.1 item 8: "execução em pseudo-terminal no CI se for viável sem dependência nova"). O
 * `script` do util-linux (já presente no Linux e no runner do CI; nenhuma dependência npm) cria o terminal; o pai "digita" a confirmação e a frase
 * só depois de ver cada pedido na tela. Um terminal com o ECO ligado devolveria o que foi digitado na saída: a frase (e a confirmação) não podem
 * aparecer, e o terminal tem de terminar fora do modo bruto (eco restaurado). Sem `script` no sistema, o teste é pulado (registrado).
 */
registerCleanup();

const ROOT = path.join(__dirname, '..');
const REGISTER = path.join(ROOT, 'tests', 'register-typescript.cjs');
const CHILD = path.join(ROOT, 'tests', 'helpers', 'link-audit-seal-sign-pty-child.ts');
const LIMIT_MS = 60_000;
const hasScript = ((): boolean => {
  try {
    execFileSync('script', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

interface PtyRun {
  readonly code: number | null;
  /** Tudo o que o terminal MOSTROU (saída padrão e de erro do filho, mais o eco, se houvesse). */
  readonly screen: string;
  /** O que a tela mostrava quando a frase foi digitada. */
  readonly screenBeforePassphrase: string;
}

/** Roda o `sign` no pseudo-terminal e digita `confirmation` e `passphrase` quando os pedidos aparecem. */
function runInPty(world: CliWorld, confirmation: string, passphrase: string): Promise<PtyRun> {
  const temp = tmpDir('lasc-pty-tmp-');
  const payload = JSON.stringify({ argv: world.argv(), tempRoots: [temp], now: NOW });
  const command = [process.execPath, '--require', REGISTER, CHILD, payload].map(quote).join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: temp, LANG: 'C.UTF-8' } as unknown as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let screen = '';
    let screenBeforePassphrase = '';
    let step = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`pseudo-terminal sem resposta: ${screen}`));
    }, LIMIT_MS);
    const onOutput = (chunk: Buffer): void => {
      screen += chunk.toString('utf8');
      if (step === 0 && /12 primeiros caracteres/.test(screen)) {
        step = 1;
        child.stdin.write(`${confirmation}\r`);
      } else if (step === 1 && /Frase-senha/.test(screen)) {
        step = 2;
        screenBeforePassphrase = screen;
        child.stdin.write(`${passphrase}\r`);
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      child.stdin.end();
      resolve({ code, screen, screenBeforePassphrase });
    });
  });
}

test('§5.5.1 item 8 / IA-04 / IA-23 (pseudo-terminal real): confirmação e frase digitadas SEM eco; assina; a frase nunca aparece na tela e o terminal termina fora do modo bruto', { skip: hasScript ? false : 'script (util-linux) indisponível', timeout: LIMIT_MS + 10_000 }, async () => {
  const world = cliWorld();
  const run = await runInPty(world, world.confirmation, world.key.passphrase);
  assert.equal(run.code, 0, run.screen);
  assert.match(run.screen, /MANIFESTO v2 ASSINADO/);
  assert.match(run.screen, /MODO_BRUTO_NO_FIM=false/, 'eco restaurado no fim');
  for (const sentinel of world.key.sentinels) assert.ok(!run.screen.includes(sentinel), 'a frase (ou a chave) apareceu na tela: eco ligado?');
  assert.ok(!run.screenBeforePassphrase.includes(world.confirmation), 'a confirmação digitada não é ecoada (nem o hash é mostrado antes da assinatura)');
  assert.ok(fs.existsSync(sealFile(world.sealsDir)));
});

test('§5.5.1 item 8 (pseudo-terminal real): frase errada ⇒ SIGN_KEY_REJECTED (código 3), frase fora da tela, eco restaurado e nada gravado', { skip: hasScript ? false : 'script (util-linux) indisponível', timeout: LIMIT_MS + 10_000 }, async () => {
  const world = cliWorld();
  const wrong = 'frase-errada-sentinela-pty-5b1e';
  const run = await runInPty(world, world.confirmation, wrong);
  assert.equal(run.code, 3, run.screen);
  assert.match(run.screen, /SIGN_KEY_REJECTED/);
  assert.match(run.screen, /MODO_BRUTO_NO_FIM=false/);
  assert.ok(!run.screen.includes(wrong), 'a frase digitada apareceu na tela');
  assert.deepEqual(treeOf(world.sealsDir), []);
});
