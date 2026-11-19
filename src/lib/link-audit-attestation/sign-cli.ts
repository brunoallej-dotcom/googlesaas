import { nodeFsOps, type BytesFsOps } from '../link-audit/snapshot-store';
import { parseSignArgs, secretArgvRefusal, secretEnvRefusal, type SignArgs } from './sign-args';
import { sealDigest } from './sign-chain';
import type { SignRefusal } from './sign-core';
import { defaultTempRoots, nodeKeyFileOps, openK1Key, publicKeyText, type KeyFileOps } from './sign-key';
import { runSign, type SignRunDeps, type SignRunResult } from './sign-run';
import { openHiddenInput, terminalConfirm, terminalPassphrase, type HiddenInput, type SignTerminal } from './sign-terminal';

/*
 * P1 W4.4 — o comando `sign` (spec §5.5 inteiro e §5.5.1; §8; IA-01 e IA-02 (5) na parte do CLI, IA-04, IA-14, IA-15, IA-16, IA-22, IA-23).
 * `scripts/link-audit-seal.ts` entrega aqui o subcomando; este arquivo é o ponto de entrada do caminho de assinatura (o artefato único da W4.6 parte
 * dele, sem o `export`). Ordem: relatórios de diagnóstico do Node desligados (RS-13) → segredo em argv ou ambiente (passo 1, §8.1) → argumentos
 * estritos (USAGE) → `external:` recusado (§5.5.1 item 1) → `runSign` (leitura única, cadeia, recusas 1–10, `--key-id` ativo, confirmação humana no
 * terminal sem eco, chave K1 com custódia e frase no terminal, `SIGN_KEY_MISMATCH`, assinatura, gravação) → recibo (passo 16).
 * Sem logger (exceção registrada no §5.2: objetos de erro podem carregar material secreto): códigos FIXOS na saída de erro e código de saída
 * 0/1/3/4. Nunca imprime caminho de disco (nem o `file` gravado), dado da empresa, assinatura completa, chave ou frase.
 * Os padrões (`process.stdin`, `process.env`, `process.report`, disco real) são injetáveis; o ambiente é olhado só pelos NOMES (e TMPDIR/TMP/TEMP).
 */

export const SIGN_USAGE: readonly string[] = [
  'Uso: npm run link-audit:seal -- sign --audit <auditId> --package <pacote.json> --approval <approval.json> --dossier <arquivo>',
  '       [--risk-acceptance <arquivo>] --seals-dir <pasta de manifestos> --expect-seq <N> [--first] --key-id <id>',
  '       --key-source file:<caminho> --custodian <rótulo> --trust-keys <lista com estado> [--json]',
  '  A frase da chave é pedida SÓ no terminal, sem eco, depois da confirmação dos 12 caracteres; nunca por opção nem por variável de ambiente.',
  '  --key-source external:<id> (token K2) ainda não é suportado. --risk-acceptance: só quando conferente e custodiante coincidem (aceite formal).',
];

/** Os interruptores de `process.report` que este comando desliga (RS-13: um relatório de diagnóstico copiaria memória e ambiente). */
export interface DiagnosticReportSwitches {
  reportOnFatalError: boolean;
  reportOnSignal: boolean;
  reportOnUncaughtException: boolean;
}

export interface SignCliDeps {
  /** Raiz do projeto (a chave nunca pode estar dentro dela, IA-22). O script passa a do repositório. */
  readonly projectRoot: string;
  /** Leitura das entradas e da cadeia, e a gravação do manifesto (padrão: disco real). */
  readonly fs?: BytesFsOps;
  /** Leitura do arquivo de chave e a custódia (padrão: disco real, só leitura). */
  readonly keyFs?: KeyFileOps;
  /** O terminal herdado (padrão: `process.stdin`). */
  readonly terminal?: SignTerminal;
  /** O ambiente (padrão: `process.env`); a barreira do §8.1 olha só os nomes. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly report?: DiagnosticReportSwitches;
  /** Pastas temporárias proibidas para a chave (padrão: `defaultTempRoots(env)`). */
  readonly tempRoots?: readonly string[];
  /** Só para teste: o sufixo do temporário do manifesto. */
  readonly tempSuffix?: () => string;
}

type Line = (line: string) => void;
const EXIT = { OK: 0, USAGE: 1, REFUSED: 3, UNEXPECTED: 4 } as const;
const UNEXPECTED_MESSAGE = 'Falha inesperada.';
const KEY_SOURCE_UNSUPPORTED: SignRefusal = {
  ok: false,
  code: 'SIGN_KEY_SOURCE_UNSUPPORTED',
  message: '--key-source external:<id> (token de hardware, K2) ainda não é suportado nesta versão (D11): use file:<caminho> com a chave PKCS#8 cifrada. Nada foi lido, assinado nem gravado.',
};

/** RS-13: nenhum relatório de diagnóstico do Node (que despeja memória, pilha e ambiente) num erro fatal, sinal ou exceção não tratada. */
function disableDiagnosticReports(report: DiagnosticReportSwitches | undefined): void {
  if (typeof report !== 'object' || report === null) return;
  report.reportOnFatalError = false;
  report.reportOnSignal = false;
  report.reportOnUncaughtException = false;
}

/** Recusa na saída: USAGE (1), falha inesperada (4) ou `RECUSADO:` + código fixo (3). Mensagens fixas, sem caminho nem conteúdo. */
function refusalOut(result: SignRefusal, json: boolean, out: Line, err: Line): number {
  if (json) {
    const extra = { ...(result.refs ? { refs: result.refs } : {}), ...(result.chainReason ? { chainReason: result.chainReason } : {}) };
    out(JSON.stringify({ ok: false, code: result.code, message: result.message, ...extra }));
  } else if (result.code === 'USAGE') [result.message, ...SIGN_USAGE].forEach((line) => err(line));
  else if (result.code === 'UNEXPECTED') err(`${UNEXPECTED_MESSAGE} ${result.message}`);
  else {
    err(`RECUSADO: ${result.message}`);
    err(`Código: ${result.code}${result.chainReason ? ` (${result.chainReason})` : ''}`);
  }
  if (result.code === 'USAGE') return EXIT.USAGE;
  return result.code === 'UNEXPECTED' ? EXIT.UNEXPECTED : EXIT.REFUSED;
}

/** Recibo de assinatura (§5.5 passo 16): exatamente estes campos, nesta ordem. Nunca a assinatura completa, a chave, caminho ou dado da empresa. */
export interface SignReceipt {
  readonly ok: true;
  readonly auditId: string;
  readonly seq: number;
  readonly schemaVersion: 2;
  readonly keyId: string;
  readonly sealedAt: string;
  readonly sealSha256: string;
  readonly prevSealSha256: string | null;
  readonly packageSha256: string;
  readonly dossierSha256: string;
  readonly entries: number;
  readonly approvedBy: string;
  readonly operator: string;
  readonly custodian: string;
  readonly roleException: boolean;
  readonly requiresLaterReview: boolean;
  /** SHA-256 do artefato único do `sign` (W4.6). Até lá `null`: o comando roda do código-fonte, sem artefato conferido (NOT_VERIFIED). */
  readonly artifactSha256: string | null;
}

type Signed = Extract<SignRunResult, { readonly ok: true }>;

function receiptOf(signed: Signed): SignReceipt {
  const { seal, plan } = signed;
  return {
    ok: true,
    auditId: seal.auditId,
    seq: seal.seq,
    schemaVersion: 2,
    keyId: seal.keyId,
    sealedAt: seal.sealedAt,
    sealSha256: sealDigest(seal),
    prevSealSha256: seal.prevSealSha256,
    packageSha256: plan.packageSha256,
    dossierSha256: seal.dossier.sha256,
    entries: seal.entries.length,
    approvedBy: plan.approvedBy,
    operator: plan.operator,
    custodian: plan.custodian,
    roleException: plan.roleException,
    requiresLaterReview: plan.requiresLaterReview,
    artifactSha256: null,
  };
}

const SELFTEST_NOTICE = 'Aviso: o autoteste do passo 14 (onda W4.5) ainda não existe e artifactSha256 é nulo (artefato único da W4.6): não entregue este manifesto ao servidor antes deles.';

/** Saída do sucesso: com --json, UM objeto (o recibo); sem, o nome do arquivo (nunca a pasta), o recibo legível e o recibo em JSON numa linha. */
function successOut(signed: Signed, json: boolean, out: Line, err: Line): number {
  const receipt = receiptOf(signed);
  err(SELFTEST_NOTICE);
  if (json) {
    out(JSON.stringify(receipt));
    return EXIT.OK;
  }
  out(`MANIFESTO v2 ASSINADO: ${signed.fileName} gravado na pasta da auditoria em --seals-dir (criação exclusiva; nada sobrescrito).`);
  out('Recibo de assinatura (anexe ao registro de assinatura do dossiê, §9):');
  for (const [field, value] of Object.entries(receipt)) if (field !== 'ok') out(`  ${field}: ${value === null ? 'null' : String(value)}`);
  out(`Recibo (JSON): ${JSON.stringify(receipt)}`);
  return EXIT.OK;
}

/** Passo 12 (§8 K1): custódia, frase no terminal (mesma sessão sem eco da confirmação) e a chave; a pública derivada é impressa (não secreta). */
function keyOpener(args: SignArgs, input: HiddenInput, deps: SignCliDeps, env: Readonly<Record<string, string | undefined>>, show: { readonly out: Line; readonly err: Line }) {
  return async (): Promise<Awaited<ReturnType<SignRunDeps['openKey']>>> => {
    if (args.keySource.kind !== 'file') return KEY_SOURCE_UNSUPPORTED;
    const custody = { projectRoot: deps.projectRoot, tempRoots: deps.tempRoots ?? defaultTempRoots(env) };
    const opened = await openK1Key(args.keySource.path, args.keyId, { fs: deps.keyFs ?? nodeKeyFileOps, custody, passphrase: terminalPassphrase(input, show.err), warn: show.err });
    if ('ok' in opened) return opened;
    (args.json ? show.err : show.out)(`Chave aberta; pública derivada (não secreta): ${publicKeyText(args.keyId, opened)}`);
    return opened;
  };
}

/** `runSign` com a confirmação e a frase no terminal herdado; o eco é restaurado em `finally`, qualquer que seja o resultado. */
async function signWithTerminal(args: SignArgs, out: Line, err: Line, now: () => Date, deps: SignCliDeps, env: Readonly<Record<string, string | undefined>>): Promise<SignRunResult> {
  const input = openHiddenInput(deps.terminal ?? process.stdin);
  try {
    const { auditId, custodian, packagePath, approvalPath, dossierPath, riskAcceptancePath, sealsDir, trustKeys, expectSeq, first, keyId } = args;
    return await runSign(
      { auditId, custodian, packagePath, approvalPath, dossierPath, riskAcceptancePath, sealsDir, trustKeys, expectSeq, first, keyId },
      { fs: deps.fs ?? nodeFsOps, now, confirm: terminalConfirm(input, err), openKey: keyOpener(args, input, deps, env, { out, err }), ...(deps.tempSuffix ? { tempSuffix: deps.tempSuffix } : {}) },
    );
  } finally {
    input.close();
  }
}

/** Subcomando `sign`: devolve o código de saída (0 assinado, 1 uso, 3 recusa, 4 falha inesperada). Nunca lança. */
export async function runSignCli(tokens: readonly string[], out: Line, err: Line, now: () => Date, deps: SignCliDeps): Promise<number> {
  const json = tokens.includes('--json');
  try {
    disableDiagnosticReports(deps.report ?? process.report);
    const env = deps.env ?? process.env;
    const early = secretArgvRefusal(tokens) ?? secretEnvRefusal(Object.keys(env));
    if (early) return refusalOut(early, json, out, err);
    const args = parseSignArgs(tokens);
    if ('ok' in args) return refusalOut(args, json, out, err);
    if (args.keySource.kind === 'external') return refusalOut(KEY_SOURCE_UNSUPPORTED, args.json, out, err);
    const result = await signWithTerminal(args, out, err, now, deps, env);
    return result.ok ? successOut(result, args.json, out, err) : refusalOut(result, args.json, out, err);
  } catch {
    // nunca a mensagem nem o objeto do erro: pode carregar caminho, conteúdo lido ou material da chave (RS-13)
    if (json) out(JSON.stringify({ ok: false, code: 'UNEXPECTED', message: UNEXPECTED_MESSAGE }));
    else err(UNEXPECTED_MESSAGE);
    return EXIT.UNEXPECTED;
  }
}
