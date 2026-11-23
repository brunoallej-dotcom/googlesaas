import fs from 'node:fs';
import { writeCapture } from '../../src/lib/link-audit-evidence/store';
import { bodyText, captureInput } from './link-audit-evidence-fixtures';

/*
 * FILHO do teste de concorrência da reserva de modo (W5.2b, revisão do PR #62): grava UMA captura (real ou simulada) na auditoria recebida,
 * depois de esperar o arquivo de largada do pai (os dois filhos começam juntos). Imprime UMA linha JSON e sai com 0. Dados 100% SINTÉTICOS
 * numa pasta temporária recebida por argumento.
 */
const [base, auditId, mode, index, go] = process.argv.slice(2) as [string, string, 'LIVE' | 'SIMULATED', string, string];
const POLL_MS = 2;
const MAX_WAIT_MS = 20_000;

(async () => {
  const started = Date.now();
  while (!fs.existsSync(go) && Date.now() - started < MAX_WAIT_MS) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  const input = captureInput({ auditId, body: bodyText({ fixtureIndex: Number(index) }) });
  const written = await writeCapture(base, mode === 'SIMULATED' ? { ...input, simulated: true } : input);
  process.stdout.write(`${JSON.stringify(written.ok ? { ok: true, captureNumber: written.value.captureNumber } : { ok: false, code: written.code })}\n`);
})().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, code: 'CHILD_FAILED' })}\n`);
});
