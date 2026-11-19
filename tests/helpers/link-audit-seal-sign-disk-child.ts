import { nodeFsOps } from '../../src/lib/link-audit/snapshot-store';
import { signSealManifest } from '../../src/lib/link-audit-attestation/sign-chain';
import { publishSeal, runSign, type SignRunInput } from '../../src/lib/link-audit-attestation/sign-run';
import { AUD, KEY_ID, NOW, planFor, testKey } from './link-audit-seal-sign-disk-fixtures';

/*
 * FILHO das corridas da W4.3 (`link-audit-seal-sign-disk.test.ts`, IA-12): vários processos Node DISTINTOS disputam o MESMO `seq` na MESMA pasta. Largada
 * sincronizada (`startAt`) para sobrepor a execução apesar da partida lenta de cada processo. Modos:
 *  - `publish`: só a gravação (temporário + `link()` exclusivo) de um manifesto próprio (`variant` muda o `sealedAt`): a disputa é toda no `link()`;
 *  - `run`: o `sign` inteiro (leitura única → cadeia → núcleo → assinatura → gravação).
 * Imprime UMA linha JSON começando por `{"ok":` e sai com 0. Só dados sintéticos e a chave de TESTE; pastas recebidas do pai.
 */
interface Payload {
  readonly mode: 'publish' | 'run';
  readonly startAt: number;
  readonly sealsDir: string;
  readonly variant: number;
  readonly input?: SignRunInput;
}
const payload = JSON.parse(process.argv[2] ?? '{}') as Payload;

async function waitStart(): Promise<void> {
  const early = payload.startAt - Date.now() - 20;
  if (early > 0) await new Promise((resolve) => setTimeout(resolve, early));
  while (Date.now() < payload.startAt) {
    // espera ativa nos últimos milissegundos: todos saem juntos
  }
}

async function main(): Promise<Record<string, unknown>> {
  if (payload.mode === 'publish') {
    const signed = signSealManifest(planFor(payload.variant), KEY_ID, testKey());
    if (!signed.ok) return { ok: false, code: `PREPARE_${signed.code}` };
    await waitStart();
    const written = await publishSeal(nodeFsOps, { sealsDir: payload.sealsDir, auditId: AUD, seal: signed.seal });
    return written.ok ? { ok: true, seq: written.seq, sealedAt: signed.seal.sealedAt } : { ok: false, code: written.code };
  }
  if (!payload.input) return { ok: false, code: 'NO_INPUT' };
  await waitStart();
  const result = await runSign(payload.input, { fs: nodeFsOps, now: () => new Date(Date.parse(NOW) + payload.variant), openKey: testKey });
  return result.ok ? { ok: true, seq: result.seq, sealedAt: result.seal.sealedAt } : { ok: false, code: result.code };
}

main()
  .then((line) => console.log(JSON.stringify({ ok: false, ...line })))
  .catch((error: unknown) => console.log(JSON.stringify({ ok: false, code: `CRASH_${error instanceof Error ? error.name : 'erro'}` })));
