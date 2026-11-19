import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runSealCli } from '../../scripts/link-audit-seal';
import { exportArgs, makeAudit, NOW } from './link-audit-seal-export-fixtures';

/*
 * FILHO do teste IA-13 do `export` (`link-audit-seal-export-safety.test.ts`): roda num processo à parte porque, num leitor vulnerável, o `open()`
 * de um FIFO nunca retorna e prende o processo; o pai o mata por tempo (SIGKILL). Cada cenário imprime UMA linha JSON e sai com 0.
 * Só dados sintéticos numa pasta temporária recebida por argumento.
 */
const [workDir, scenario, legacyDir] = process.argv.slice(2) as [string, string, string | undefined];
const MIB = 1024 * 1024;
const MAX_CAPTURE_BYTES = 6 * MIB;

(async () => {
  const started = Date.now();
  const base = path.join(workDir, 'evidencias');
  fs.mkdirSync(base);
  let argv: string[];
  if (scenario === 'fifo-legacy') {
    // a réplica legada é criada (e apagada) pelo pai; aqui só é copiada para a pasta deste filho
    if (!legacyDir) throw new Error('fifo-legacy exige a pasta legada do pai');
    const dir = path.join(base, 'auditoria-teste-0001');
    fs.cpSync(legacyDir, dir, { recursive: true });
    fs.rmSync(path.join(dir, 'serper-status.json'));
    execFileSync('mkfifo', [path.join(dir, 'serper-status.json')]);
    argv = ['export', '--evidence-dir', base, '--audit', 'auditoria-teste-0001', '--out', path.join(workDir, 'pacote.json'), '--json'];
  } else {
    const audit = await makeAudit([{}], { base });
    const capture = path.join(audit.dir, 'c0001.capture.json');
    if (scenario === 'fifo-capture') execFileSync('mkfifo', [path.join(audit.dir, 'c0002.capture.json')]);
    if (scenario === 'fifo-report') execFileSync('mkfifo', [path.join(audit.dir, 'c0001.report-r0002.json')]);
    if (scenario === 'fifo-unlisted') execFileSync('mkfifo', [path.join(audit.dir, 'lixo.fifo')]);
    if (scenario === 'symlink-capture') {
      const copy = path.join(workDir, 'copia.json');
      fs.copyFileSync(capture, copy);
      fs.rmSync(capture);
      fs.symlinkSync(copy, capture);
    }
    if (scenario === 'symlink-dir') {
      const real = path.join(workDir, 'real-auditoria');
      fs.renameSync(audit.dir, real);
      fs.symlinkSync(real, audit.dir);
    }
    if (scenario === 'oversize-capture') {
      const big = path.join(audit.dir, 'c0002.capture.json');
      fs.writeFileSync(big, '');
      fs.truncateSync(big, MAX_CAPTURE_BYTES + 1); // esparso: rápido, mas declarado acima do limite
    }
    argv = [...exportArgs(audit, ['--json'], path.join(workDir, 'pacote.json'))];
  }
  const out: string[] = [];
  const exit = await runSealCli(argv, (line) => out.push(line), () => undefined, () => new Date(NOW.getTime()));
  const result = JSON.parse(out[0] ?? '{}') as { code?: string | null };
  console.log(JSON.stringify({ scenario, exit, code: result.code ?? null, wrote: fs.existsSync(path.join(workDir, 'pacote.json')), ms: Date.now() - started }));
})().catch((error: unknown) => {
  console.log(JSON.stringify({ scenario, crashed: error instanceof Error ? error.name : 'erro' }));
});
