import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readLog } from '../../src/lib/link-audit-decisions/store';
import { nodeFsOps } from '../../src/lib/link-audit/snapshot-store';
import { readRunLog } from '../../src/lib/link-audit-scoring-runs/results-store';
import { createSealedEvidenceProvenance, parseTrustKeys } from '../../src/lib/link-audit-evidence/provenance';
import { readCapture, verifyAudit } from '../../src/lib/link-audit-evidence/store';
import { evidenceKeys } from './link-audit-evidence-provenance-fixtures';

/*
 * FILHO do teste de arquivos especiais (`link-audit-special-files.test.ts`): roda num processo à parte porque, num leitor vulnerável, o `open()`
 * de um FIFO NUNCA retorna e prende o processo; o pai o mata por tempo (SIGKILL). Cada cenário imprime UMA linha JSON e sai com 0.
 * Só dados sintéticos em pasta temporária recebida por argumento; nada fora dela é tocado.
 */
const [dir, scenario] = process.argv.slice(2) as [string, string];
const AUDIT = 'auditoria-especial-01';
const fifo = (target: string): void => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync('mkfifo', [target]);
};
const settle = async <T>(promise: Promise<T>): Promise<{ ok: boolean; code: string }> =>
  promise.then(
    () => ({ ok: true, code: '' }),
    (error: NodeJS.ErrnoException) => ({ ok: false, code: String(error?.code ?? error) }),
  );

(async () => {
  const started = Date.now();
  if (scenario === 'reader') {
    // MAIS FIFOs que threads do pool de I/O do libuv (4): num leitor bloqueante, todo o I/O de arquivo do processo pararia
    const targets = Array.from({ length: 8 }, (_, i) => path.join(dir, `f${i}.json`));
    for (const target of targets) fifo(target);
    const results = await Promise.all(targets.map((target) => settle(nodeFsOps.readFile(target, 1024))));
    const normal = path.join(dir, 'normal.json');
    fs.writeFileSync(normal, '{"ok":true}');
    const stillWorks = (await nodeFsOps.readFile(normal, 1024)) === '{"ok":true}';
    const independent = (await fs.promises.readFile(normal, 'utf8')) === '{"ok":true}'; // I/O qualquer do processo continua vivo
    const tooBig = await settle(nodeFsOps.readFile(normal, 3));
    const symlink = path.join(dir, 'link.json');
    fs.symlinkSync(normal, symlink);
    const viaLink = await settle(nodeFsOps.readFile(symlink, 1024));
    console.log(JSON.stringify({ scenario, codes: results.map((r) => r.code), allRejected: results.every((r) => !r.ok), stillWorks, independent, tooBig, viaLink, ms: Date.now() - started }));
    return;
  }
  if (scenario === 'decisions' || scenario === 'results' || scenario === 'receipts') {
    const data = path.join(dir, 'data');
    const anchors = path.join(dir, 'anchors');
    fs.mkdirSync(data);
    fs.mkdirSync(anchors);
    const options = { anchorDir: anchors, projectRoot: path.join(dir, 'projeto') };
    if (scenario === 'decisions') fifo(path.join(data, AUDIT, 'd0001.json'));
    if (scenario === 'results') fifo(path.join(data, AUDIT, 's0001.json'));
    if (scenario === 'receipts') {
      fs.mkdirSync(path.join(data, AUDIT), { recursive: true });
      fifo(path.join(anchors, AUDIT, 'a0001.json'));
    }
    const read = scenario === 'results' ? await readRunLog(data, AUDIT, options) : await readLog(data, AUDIT, options);
    console.log(JSON.stringify({ scenario, ok: read.ok, code: read.ok ? null : read.code, ms: Date.now() - started }));
    return;
  }
  if (scenario === 'result-receipts') {
    // o recibo de um RESULTADO (6C) como FIFO — o revisor apontou que o teste do implementador não cobria esta pasta
    const data = path.join(dir, 'data');
    const anchors = path.join(dir, 'anchors');
    fs.mkdirSync(path.join(data, AUDIT), { recursive: true });
    fifo(path.join(anchors, AUDIT, 'a0001.json'));
    const read = await readRunLog(data, AUDIT, { anchorDir: anchors, projectRoot: path.join(dir, 'projeto') });
    console.log(JSON.stringify({ scenario, ok: read.ok, code: read.ok ? null : read.code, ms: Date.now() - started }));
    return;
  }
  if (scenario === 'evidence') {
    // captura de EVIDÊNCIA como FIFO: a leitura e a verificação da auditoria falham fechado
    const base = path.join(dir, 'evidence');
    fifo(path.join(base, AUDIT, 'c0001.capture.json'));
    const one = await readCapture(base, AUDIT, 1, { projectRoot: path.join(dir, 'projeto') });
    const all = await verifyAudit(base, AUDIT, { projectRoot: path.join(dir, 'projeto') });
    console.log(JSON.stringify({ scenario, ok: one.ok || (all.ok && all.value.state !== 'CORRUPT'), code: one.ok ? null : one.code, verify: all.ok ? all.value.state : all.code, ms: Date.now() - started }));
    return;
  }
  if (scenario === 'seals') {
    // o MANIFESTO de proveniência como FIFO: não autentica e não trava
    const keys = evidenceKeys();
    fifo(path.join(dir, 'seals', AUDIT, 'seal-0001.json'));
    const verdict = await createSealedEvidenceProvenance({ sealsDir: path.join(dir, 'seals'), trustedKeys: parseTrustKeys(keys.trustKeys) as never }).classify(AUDIT, [{ ref: 'capture:c0001', contentSha256: 'a'.repeat(64), legacy: false }]);
    console.log(JSON.stringify({ scenario, ok: verdict.status === 'AUTHENTICATED', code: verdict.status === 'UNAUTHENTICATED' ? verdict.reason : null, ms: Date.now() - started }));
    return;
  }
  throw new Error(`cenário desconhecido: ${scenario}`);
})().then(
  () => process.exit(0),
  (error) => {
    console.error(String(error));
    process.exit(2);
  },
);
