/**
 * Produtor P1 da Auditoria por Link: atestação OFFLINE da coleta (spec `docs/specs/link-audit-p1-attestation.md` §5.3).
 *
 *   npm run link-audit:seal -- export --evidence-dir <base> --audit <auditId> --collector-hash cNNNN=<hex64> [...] \
 *       --max-gap-hours <N> [--gap-justification <texto curto>] [--seals-dir <pasta>] [--out <arquivo novo>] [--show-summary] [--json]
 *
 * `export` é SOMENTE LEITURA sobre a pasta de evidências; o único arquivo gravado é `--out` (criação exclusiva, fora da pasta de evidências).
 * Sem rede, sem Supabase/Serper/Redis e sem ler arquivos de ambiente. Hash não é assinatura: a conferência de procedência continua humana.
 *
 *   npm run link-audit:seal -- sign --audit <auditId> --package <pacote.json> --approval <approval.json> --dossier <arquivo> [--risk-acceptance <arquivo>] \
 *       --seals-dir <pasta> --expect-seq <N> [--first] --key-id <id> --key-source file:<caminho> --custodian <rótulo> --trust-keys <lista> [--json]
 *
 * `sign` (spec §5.5, W4.4): todo o comando está em `src/lib/link-audit-attestation/sign-cli.ts`; aqui só a entrega do subcomando, com a raiz do
 * projeto (a chave nunca pode estar dentro dela). A frase da chave é pedida só no terminal, sem eco. W4.5: antes de gravar, o `sign` autotesta o
 * manifesto novo com o verificador v2 (lista completa com estado, fechos da pasta, só v2; passo 14).
 *
 *   npm run link-audit:seal -- close-key --retired-key-id <R> --seals-dir <pasta> --receipts-dir <pasta de recibos> --key-id <S> \
 *       --key-source file:<caminho> --custodian <rótulo> --trust-keys <lista> [--json]
 *
 * `close-key` (spec §5.5.1 item 9, W4.5; contrato do verificador v2 §6): fecho de aposentadoria da chave R, assinado pela chave ATIVA S ≠ R, com as
 * cabeças tiradas SÓ dos recibos (registro externo); cadeia de R no servidor sem recibo sai como UNKNOWN_SEAL_ON_SERVER e fica fora. Grava
 * `<seals-dir>/_closures/<R>.json` (criação exclusiva) e mostra o `closureSha256`, que o runbook fixa na lista (`R:<pública>:retired:<hash>`);
 * sem essa fixação, R não conta. Também em `sign-cli.ts` (mesmas barreiras, terminal sem eco e chave K1 do `sign`).
 */
import path from 'node:path';
import { captureLabel, isValidAuditId, MAX_GAP_HOURS, type ExportRefusal } from '@/lib/link-audit-attestation/export';
import { exportCandidatePackage, serializePackage, type DeltaStatus, type FsOps } from '@/lib/link-audit-attestation/export-run';
import { isSafeText, type CandidatePackage } from '@/lib/link-audit-attestation/schemas';
import { HOMOLOGATION_LOCK_ENV, homologationLockFromProcess, isHomologationLockOn, SIMULATED_LABEL, type EnvReader } from '@/lib/link-audit-evidence/simulated';
import { CLOSE_KEY_USAGE, runCloseKeyCli, runSignCli, SIGN_USAGE, type SignCliDeps } from '@/lib/link-audit-attestation/sign-cli';

export const USAGE = [
  'Uso: npm run link-audit:seal -- export --evidence-dir <base> --audit <auditId> --collector-hash cNNNN=<hex64> [...] --max-gap-hours <N>',
  '       [--gap-justification <texto curto>] [--seals-dir <pasta>] [--out <arquivo novo>] [--show-summary] [--json]',
  '  --collector-hash: uma por captura nova (o hash que o operador registrou do coletor em --json); é a única opção repetível.',
  '  --max-gap-hours: obrigatório para captura nova, sem valor padrão. Sem --out, o pacote só vai para a saída padrão com --show-summary.',
  `  --simulated: SÓ o ensaio em homologação, com ${HOMOLOGATION_LOCK_ENV}=1 no ambiente; sem os dois, captura simulada é recusada (EXPORT_SIMULATED_CAPTURE).`,
  ...SIGN_USAGE,
  ...CLOSE_KEY_USAGE,
];
const HASH_NOTICE = 'Hash não é assinatura; a conferência de procedência (contrato §4) ainda é necessária.';
const UNEXPECTED_MESSAGE = 'Falha inesperada.';
const EXIT = { OK: 0, USAGE: 1, REFUSED: 3, UNEXPECTED: 4 } as const;

const VALUE_FLAGS: ReadonlySet<string> = new Set(['evidence-dir', 'audit', 'collector-hash', 'max-gap-hours', 'gap-justification', 'seals-dir', 'out']);
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['show-summary', 'json', 'simulated']);
const REPEATABLE_FLAG = 'collector-hash';
const COLLECTOR_HASH = /^c(\d{4})=([0-9a-f]{64})$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const MAX_JUSTIFICATION_LENGTH = 280;
/** Só o NOME da opção desconhecida é ecoado (nunca o valor da forma `--x=valor`, que pode trazer caminho ou nome de empresa). */
const MAX_ECHOED_FLAG = 20;
const ECHOABLE_FLAG = /^--[a-z][a-z-]*$/;

export interface ExportArgs {
  readonly evidenceDir: string;
  readonly auditId: string;
  readonly collectorHashes: ReadonlyMap<number, string>;
  readonly maxGapHours: number | null;
  readonly gapJustification: string | null;
  readonly sealsDir: string | null;
  readonly out: string | null;
  readonly showSummary: boolean;
  readonly json: boolean;
  /** Afirma que a auditoria é a coleta SIMULADA do ensaio (exige a trava de homologação). */
  readonly simulated: boolean;
}

function unknownFlag(token: string): string {
  const flag = token.split('=')[0] ?? '';
  return ECHOABLE_FLAG.test(flag) ? `Opção desconhecida: ${flag.slice(0, MAX_ECHOED_FLAG)}` : 'Opção desconhecida.';
}

const pathValue = (value: string | undefined): string | null | false => (value === undefined ? null : value.length > 0 && !value.includes('\0') ? value : false);

/** Analisador ESTRITO (spec §5.2): flag desconhecida, repetida ou sem valor ⇒ uso. Valores de opção nunca são ecoados. */
export function parseExportArgs(tokens: readonly string[]): ExportArgs | string {
  const values = new Map<string, string>();
  const hashes: string[] = [];
  const flags = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (!token.startsWith('--')) return `Argumento inesperado na posição ${index + 2} (as opções começam com --).`;
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      if (flags.has(name)) return `Opção repetida: --${name}.`;
      flags.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) return unknownFlag(token);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) return `A opção --${name} exige um valor.`;
    index += 1;
    if (name === REPEATABLE_FLAG) hashes.push(value);
    else if (values.has(name)) return `Opção repetida: --${name}.`;
    else values.set(name, value);
  }
  return validateExportArgs(values, hashes, flags);
}

function validateExportArgs(values: ReadonlyMap<string, string>, hashes: readonly string[], flags: ReadonlySet<string>): ExportArgs | string {
  const evidenceDir = pathValue(values.get('evidence-dir'));
  const auditId = values.get('audit');
  if (!evidenceDir) return 'Informe --evidence-dir <pasta> (cópia ou montagem somente leitura da base de evidências).';
  if (auditId === undefined || !isValidAuditId(auditId)) return 'Informe --audit <auditId> válido (8 a 64 caracteres: minúsculas, números, _ e -).';
  const collectorHashes = new Map<number, string>();
  for (const raw of hashes) {
    const match = COLLECTOR_HASH.exec(raw);
    const n = Number(match?.[1]);
    if (!match || n < 1) return 'Formato de --collector-hash: cNNNN=<64 hex minúsculos> (uma por captura nova).';
    if (collectorHashes.has(n)) return `--collector-hash repetido para ${captureLabel(n)}.`;
    collectorHashes.set(n, match[2] as string);
  }
  const gapRaw = values.get('max-gap-hours');
  const maxGapHours = gapRaw === undefined ? null : POSITIVE_INTEGER.test(gapRaw) && Number(gapRaw) <= MAX_GAP_HOURS ? Number(gapRaw) : Number.NaN;
  if (Number.isNaN(maxGapHours)) return `--max-gap-hours deve ser um inteiro de 1 a ${MAX_GAP_HOURS} (horas; não há valor padrão).`;
  const gapJustification = values.get('gap-justification') ?? null;
  if (gapJustification !== null && (gapJustification.length < 1 || gapJustification.length > MAX_JUSTIFICATION_LENGTH || !isSafeText(gapJustification))) {
    return `--gap-justification deve ser um texto curto (até ${MAX_JUSTIFICATION_LENGTH} caracteres) sem e-mail, telefone nem caracteres de controle.`;
  }
  if (gapJustification !== null && maxGapHours === null) return '--gap-justification só vale junto com --max-gap-hours.';
  const sealsDir = pathValue(values.get('seals-dir'));
  const out = pathValue(values.get('out'));
  if (sealsDir === false) return '--seals-dir inválido.';
  if (out === false) return '--out inválido.';
  const showSummary = flags.has('show-summary');
  if (out === null && !showSummary) return 'Sem --out, o pacote vai para a saída padrão e contém nome/cidade/UF da empresa: informe --out <arquivo novo> ou, para imprimir mesmo assim, --show-summary.';
  return { evidenceDir, auditId, collectorHashes, maxGapHours, gapJustification, sealsDir, out, showSummary, json: flags.has('json'), simulated: flags.has('simulated') };
}

export interface SealCliDeps {
  /** Leitura das evidências e dos manifestos (testes: proxy que falha em qualquer escrita). */
  readonly fs?: FsOps;
  /** Gravação do `--out`. */
  readonly outFs?: FsOps;
  readonly projectRoot?: string;
  /** Dependências do `sign` e do `close-key` (terminal, ambiente, disco, pastas temporárias proibidas; testes). A raiz do projeto vem de `projectRoot`. */
  readonly sign?: Omit<SignCliDeps, 'projectRoot'>;
  /** Ambiente do comando (testes), só para a trava de homologação do `export --simulated`. Padrão: a variável da trava no processo; nunca um arquivo de ambiente. */
  readonly getEnv?: () => EnvReader;
}

type Line = (line: string) => void;

function usage(message: string, json: boolean, out: Line, err: Line): number {
  if (json) out(JSON.stringify({ ok: false, code: 'USAGE', message }));
  else [message, ...USAGE].forEach((line) => err(line));
  return EXIT.USAGE;
}

function refusal(result: ExportRefusal, json: boolean, out: Line, err: Line): number {
  if (result.code === 'USAGE') return usage(result.message, json, out, err);
  if (json) out(JSON.stringify({ ok: false, code: result.code, message: result.message }));
  else err(`RECUSADO (${result.code}): ${result.message}`);
  return result.code === 'UNEXPECTED' ? EXIT.UNEXPECTED : EXIT.REFUSED;
}

const yesNo = (value: boolean): string => (value ? 'sim' : 'não');
const orNotVerified = (value: string | null): string => value ?? 'NOT_VERIFIED';

/** Saída humana (pt-BR): só auditId, contagens, hashes e códigos; nome/cidade/UF somente com --show-summary (RS-21). Nunca caminhos. */
function humanLines(pkg: CandidatePackage, deltaStatus: DeltaStatus, output: 'FILE' | 'STDOUT', showSummary: boolean, simulated: boolean): string[] {
  const { summary, gap, delta } = pkg;
  const lines = [
    'PACOTE CANDIDATO P1 (somente leitura: nada foi gravado na pasta de evidências)',
    ...(simulated ? [`ATENÇÃO: ${SIMULATED_LABEL} — captura SINTÉTICA de homologação; este pacote nunca atesta evidência real.`] : []),
    `Auditoria: ${pkg.auditId}`,
    `Camada: ${pkg.layout} · atestável: ${pkg.attestable ? 'sim' : 'NÃO ATESTÁVEL (coleta legada: serve só como relatório; o sign recusa)'}`,
    `Capturas: ${summary.captures} · revisões de relatório: ${summary.reportRevisions} · artefatos: ${summary.artifacts} · entradas: ${pkg.entries.length} · contém legado: ${yesNo(summary.containsLegacy)}`,
    `Integridade local: ${pkg.integrity.status} (${pkg.integrity.algorithm}, ${pkg.integrity.checkedFiles} arquivos)`,
    gap === null ? 'Intervalo coleta→exportação: não se aplica (legado)' : `Intervalo coleta→exportação: ${gap.observedHours} h (limite ${gap.maxHours} h)${gap.observedHours > gap.maxHours ? ' ACIMA DO LIMITE' : ''}${gap.justification === null ? '' : '; justificativa registrada no pacote'}`,
    'Verificações mecânicas (NOT_EXECUTED = conferência humana registrada no approval.json):',
    ...pkg.checks.map((check) => `  ${check.id}: ${check.status}`),
  ];
  if (deltaStatus !== 'NOT_REQUESTED') {
    lines.push(delta === null ? 'Delta (informativo): indisponível (pasta de manifestos ilegível ou manifesto malformado)' : `Delta (informativo; assinatura dos manifestos não conferida): ${delta.added.length} novas, ${delta.changed.length} com hash diferente, ${delta.missing.length} ausentes`);
  }
  if (showSummary) lines.push(`Empresa: ${orNotVerified(summary.company.name)} · ${orNotVerified(summary.company.city)}/${orNotVerified(summary.company.stateCode)}`);
  lines.push(
    'Não cobertos pelo pacote: observações do site, tentativas, resumos e saídas da execução (fora do conjunto atestado).',
    `Pacote: ${pkg.packageSha256}`,
    `Saída: ${output === 'FILE' ? 'arquivo --out (criado agora, modo 0600)' : 'saída padrão'}`,
    HASH_NOTICE,
  );
  return lines;
}

/** `--json`: um único objeto, forma estável. Justificativa (texto livre) nunca é ecoada; a empresa só com --show-summary. */
function jsonResult(pkg: CandidatePackage, deltaStatus: DeltaStatus, output: 'FILE' | 'STDOUT', showSummary: boolean, simulated: boolean): Record<string, unknown> {
  return {
    ok: true,
    code: null,
    auditId: pkg.auditId,
    // só na coleta SIMULADA do ensaio: a forma estável das exportações reais não muda
    ...(simulated ? { simulated: true } : {}),
    layout: pkg.layout,
    attestable: pkg.attestable,
    packageSha256: pkg.packageSha256,
    counts: { captures: pkg.summary.captures, reportRevisions: pkg.summary.reportRevisions, artifacts: pkg.summary.artifacts, entries: pkg.entries.length },
    integrity: pkg.integrity,
    checks: pkg.checks,
    gap: pkg.gap === null ? null : { maxHours: pkg.gap.maxHours, observedHours: pkg.gap.observedHours, justified: pkg.gap.justification !== null },
    delta: pkg.delta,
    deltaStatus,
    output,
    ...(showSummary ? { company: pkg.summary.company } : {}),
    ...(output === 'STDOUT' ? { package: pkg } : {}),
  };
}

const SIMULATED_WITHOUT_LOCK = refuseSimulated(`--simulated só vale no ensaio em homologação, com ${HOMOLOGATION_LOCK_ENV}=1 no ambiente deste comando. Nada foi exportado.`);
function refuseSimulated(message: string): ExportRefusal {
  return { ok: false, code: 'EXPORT_SIMULATED_CAPTURE', message };
}

async function runExport(args: ExportArgs, out: Line, err: Line, now: () => Date, deps: SealCliDeps): Promise<number> {
  // a trava é conferida ANTES de ler a pasta; sem `--simulated` + trava, o `export` recusa a captura simulada que encontrar
  const lockOn = deps.getEnv ? isHomologationLockOn(deps.getEnv()) : homologationLockFromProcess();
  if (args.simulated && !lockOn) return refusal(SIMULATED_WITHOUT_LOCK, args.json, out, err);
  const outcome = await exportCandidatePackage(
    { evidenceDir: args.evidenceDir, auditId: args.auditId, collectorHashes: args.collectorHashes, maxGapHours: args.maxGapHours, gapJustification: args.gapJustification, sealsDir: args.sealsDir, out: args.out, projectRoot: deps.projectRoot ?? path.resolve(__dirname, '..'), now, allowSimulated: args.simulated && lockOn },
    { ...(deps.fs ? { fs: deps.fs } : {}), ...(deps.outFs ? { outFs: deps.outFs } : {}) },
  );
  if (!outcome.ok) return refusal(outcome, args.json, out, err);
  if (args.json) {
    out(JSON.stringify(jsonResult(outcome.package, outcome.deltaStatus, outcome.output, args.showSummary, outcome.simulated)));
    return EXIT.OK;
  }
  const lines = humanLines(outcome.package, outcome.deltaStatus, outcome.output, args.showSummary, outcome.simulated);
  if (outcome.output === 'FILE') lines.forEach((line) => out(line));
  else {
    // a saída padrão é o PACOTE (mesmos bytes do --out, redirecionável); o resumo humano vai para stderr
    out(serializePackage(outcome.package).trimEnd());
    lines.forEach((line) => err(line));
  }
  return EXIT.OK;
}

export async function runSealCli(argv: readonly string[], out: Line, err: Line, now: () => Date = () => new Date(), deps: SealCliDeps = {}): Promise<number> {
  const json = argv.includes('--json');
  try {
    const [command, ...rest] = argv;
    if (command === 'sign') return await runSignCli(rest, out, err, now, { ...deps.sign, projectRoot: deps.projectRoot ?? path.resolve(__dirname, '..') });
    if (command === 'close-key') return await runCloseKeyCli(rest, out, err, now, { ...deps.sign, projectRoot: deps.projectRoot ?? path.resolve(__dirname, '..') });
    if (command !== 'export') return usage('Informe o subcomando: export, sign ou close-key.', json, out, err);
    const args = parseExportArgs(rest);
    if (typeof args === 'string') return usage(args, json, out, err);
    return await runExport(args, out, err, now, deps);
  } catch {
    // nunca a mensagem do erro: pode trazer caminho de disco ou conteúdo lido
    if (json) out(JSON.stringify({ ok: false, code: 'UNEXPECTED', message: UNEXPECTED_MESSAGE }));
    err(UNEXPECTED_MESSAGE);
    return EXIT.UNEXPECTED;
  }
}

if (process.argv[1] && /link-audit-seal\.ts$/.test(process.argv[1])) {
  runSealCli(process.argv.slice(2), (line) => console.log(line), (line) => console.error(line)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error(UNEXPECTED_MESSAGE);
      process.exitCode = EXIT.UNEXPECTED;
    },
  );
}
