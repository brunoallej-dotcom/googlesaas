import type { SealReceiverConfig } from './args';
import { inputCapOf, judgeCandidate } from './candidate';
import { SealReceiverError } from './codes';
import type { PutCommand } from './grammar';
import { readCandidateInput } from './input';
import { existingDestination, requireSafeLayout } from './layout';
import type { SealReceiverDeps } from './ports';
import { readInstalledTrustList } from './trust';
import { verifyAfterWrite, verifyOnHost } from './verify';
import { writeExclusively } from './write';

/*
 * P9.3b — `put <relpath> <sha256> <trust-sha256>` de ponta a ponta (spec §5.7, passos 1 a 9), já debaixo da trava do ambiente:
 *  1. stdin com teto e prazo, sha256 = declarado (`E_HASH_MISMATCH`);
 *  2. lista INSTALADA: sha256 = `trust-sha256`, formato e regra de ambiente;
 *  3. formato estrito, forma canônica e nome (`E_FORMAT`);
 *  4. raiz e subpasta reais (`E_UNSAFE_PATH`);
 *  5. destino existente: idêntico ⇒ `OK ALREADY_PRESENT`, outro ⇒ `E_EXISTS_DIFFERENT`, outro tipo ⇒ `E_UNSAFE_PATH`;
 *  6. verificação v2 no host (`E_V2_REFUSED`, `E_CLOSURE_REFUSED`);
 *  7. gravação exclusiva e durável; `EEXIST` no `link()` ⇒ de volta ao passo 5;
 *  8. releitura e nova classificação (`E_POSTWRITE_VERIFY`);
 *  9. `OK WRITTEN <relpath> <sha256>`.
 * Os bytes verificados nos passos 3 e 6 são os MESMOS que o passo 7 grava (nenhuma releitura do stdin nem do disco entre eles).
 */

/** Rodadas do passo 5 ao 7: a primeira e, depois de um `EEXIST` (corrida), uma volta ao passo 5. */
const MAX_WRITE_ROUNDS = 2;

/** Roda o `put`; devolve a linha pública de sucesso. Lança `SealReceiverError` com o código fixo. */
export async function runPut(command: PutCommand, config: SealReceiverConfig, deps: SealReceiverDeps): Promise<string> {
  const { target } = command;
  const cap = inputCapOf(target, config.env);
  const input = await readCandidateInput(deps.stdin, deps.clock, cap);
  if (input.sha256 !== command.sha256) throw new SealReceiverError('E_HASH_MISMATCH', null, 'stdin sha256 differs from the declared one');
  const trust = await readInstalledTrustList(config.trustList, command.trustSha256, config.env, deps.fs);
  const candidate = judgeCandidate(target, config.env, input.bytes, input.sha256);
  await requireSafeLayout(deps.fs, config.sealsRoot, target);
  for (let round = 1; round <= MAX_WRITE_ROUNDS; round += 1) {
    if ((await existingDestination(deps.fs, config.sealsRoot, target, candidate.bytes, cap)) === 'identical') {
      deps.log.write('put.already_present', { relpath: target.relpath, sha256: candidate.sha256, round });
      return `OK ALREADY_PRESENT ${target.relpath} ${candidate.sha256}`;
    }
    await verifyOnHost(deps.fs, config.sealsRoot, trust, candidate);
    const written = await writeExclusively(deps.fs, config.sealsRoot, target, candidate.text, () => deps.tempSuffix());
    if (written.outcome === 'conflict') {
      deps.log.write('put.link_conflict', { relpath: target.relpath, round, tempLeft: written.tempLeft });
      continue;
    }
    await verifyAfterWrite(deps.fs, config.sealsRoot, target, trust, candidate, cap);
    deps.log.write('put.written', { relpath: target.relpath, sha256: candidate.sha256, trustSha256: trust.sha256 });
    return `OK WRITTEN ${target.relpath} ${candidate.sha256}`;
  }
  throw new SealReceiverError('E_WRITE_FAILED', null, 'destination kept appearing and disappearing around the link');
}
