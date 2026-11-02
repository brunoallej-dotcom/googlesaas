import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/*
 * MINOR-1 da revisão adversarial (arquivo FIFO): quem escreve numa pasta de dados pode deixar um FIFO com nome válido (`d0001.json`,
 * `a0001.json`, `s0001.json`, uma captura). Um `open()` bloqueante nunca retorna, prende uma thread do pool de I/O do libuv e, com
 * poucos, TODO o I/O de arquivo do processo web para (o processo nem encerra). O leitor compartilhado (`nodeFsOps.readFile`) agora abre com
 * O_NONBLOCK|O_NOFOLLOW, confere o tipo no DESCRITOR (fstat) e lê com limite. Cada cenário roda num processo filho com SIGKILL externo: se
 * a correção regredir, ESTE teste falha (não trava a suíte).
 */
const ROOT = path.resolve(__dirname, '..');
const CHILD = path.join(ROOT, 'tests', 'helpers', 'special-files-child.ts');
const REGISTER = path.join(ROOT, 'tests', 'register-typescript.cjs');
const LIMIT_MS = 20_000;

const hasMkfifo = ((): boolean => {
  try {
    execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function runChild(scenario: string): { timedOut: boolean; status: number | null; line: Record<string, unknown> | null; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmn-special-'));
  try {
    const run = spawnSync(process.execPath, ['--require', REGISTER, CHILD, dir, scenario], { cwd: ROOT, encoding: 'utf8', timeout: LIMIT_MS, killSignal: 'SIGKILL', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } as unknown as NodeJS.ProcessEnv });
    const timedOut = run.error !== undefined && (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const last = run.stdout?.trim().split('\n').pop() ?? '';
    return { timedOut, status: run.status, line: last.startsWith('{') ? (JSON.parse(last) as Record<string, unknown>) : null, stderr: run.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // FIFOs também (unlink); nada fica para trás nem se o filho foi morto
  }
}

test('leitor compartilhado: 8 FIFOs (mais que as threads do libuv) são recusados na hora (ENOTFILE) e o I/O do processo continua vivo; link simbólico e arquivo grande demais também falham', { skip: !hasMkfifo && 'mkfifo indisponível' }, () => {
  const r = runChild('reader');
  assert.equal(r.timedOut, false, 'o filho travou: um FIFO bloqueou o processo');
  assert.equal(r.status, 0, r.stderr.slice(0, 300));
  assert.ok(r.line, 'o filho devolveu o resultado');
  assert.equal(r.line.allRejected, true);
  assert.deepEqual(r.line.codes, Array(8).fill('ENOTFILE'));
  assert.equal(r.line.stillWorks, true, 'um arquivo comum continua legível pelo leitor');
  assert.equal(r.line.independent, true, 'o I/O de arquivo do processo continua funcionando');
  assert.deepEqual(r.line.tooBig, { ok: false, code: 'ETOOBIG' });
  assert.deepEqual(r.line.viaLink, { ok: false, code: 'ELOOP' }, 'O_NOFOLLOW: link simbólico recusado');
  assert.ok(Number(r.line.ms) < 5000, `lento demais: ${String(r.line.ms)} ms`);
});

for (const [scenario, label] of [['decisions', 'decisões (d0001.json)'], ['results', 'resultados (s0001.json)'], ['receipts', 'recibos das decisões (a0001.json)'], ['result-receipts', 'recibos dos RESULTADOS (a0001.json)'], ['evidence', 'evidência (c0001.capture.json)'], ['seals', 'manifesto de proveniência (seal-0001.json)']] as const) {
  test(`FIFO no lugar de um arquivo de ${label}: a leitura da auditoria falha fechada (integridade) em menos de 5 s, sem travar o processo`, { skip: !hasMkfifo && 'mkfifo indisponível' }, () => {
    const r = runChild(scenario);
    assert.equal(r.timedOut, false, `${scenario}: o filho travou`);
    assert.equal(r.status, 0, r.stderr.slice(0, 300));
    assert.ok(r.line);
    assert.equal(r.line.ok, false, 'um FIFO nunca pode ser lido como dado');
    assert.ok(['CORRUPT', 'ANCHOR_INTEGRITY', 'SEAL_INVALID', 'VERIFICATION_ERROR', 'NO_SEAL', 'HASH_MISMATCH', 'SCHEMA', 'NOT_FOUND', 'WRITE_FAILED'].includes(String(r.line.code)), `código fail-closed esperado, veio ${String(r.line.code)}`);
    assert.ok(Number(r.line.ms) < 5000);
  });
}
