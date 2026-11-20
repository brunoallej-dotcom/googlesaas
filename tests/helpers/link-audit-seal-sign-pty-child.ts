import { runSealCli } from '../../scripts/link-audit-seal';

/*
 * FILHO do teste em PSEUDO-TERMINAL da W4.4 (`link-audit-seal-sign-pty.test.ts`): roda o `sign` com o terminal, o ambiente e os relatórios de
 * diagnóstico REAIS do processo (`process.stdin` é o pseudo-terminal criado pelo `script`). Só a lista de pastas temporárias proibidas é trocada
 * (a chave de teste está numa pasta temporária, que a custódia recusa por padrão). Recebe a lista de argumentos do `sign` e as pastas no argv
 * (nenhum segredo: a frase é digitada no terminal pelo pai). No fim imprime se o terminal ficou em modo bruto.
 */
interface Payload {
  readonly argv: readonly string[];
  readonly tempRoots: readonly string[];
  readonly now: string;
}
const payload = JSON.parse(process.argv[2] ?? '{}') as Payload;

runSealCli(['sign', ...payload.argv], (line) => console.log(line), (line) => console.error(line), () => new Date(payload.now), { sign: { tempRoots: payload.tempRoots } }).then(
  (code) => {
    console.error(`MODO_BRUTO_NO_FIM=${String(process.stdin.isRaw)}`);
    process.exitCode = code;
  },
  () => {
    console.error('FALHA_DO_FILHO');
    process.exitCode = 9;
  },
);
