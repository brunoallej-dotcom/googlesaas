import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { GUARD_KEY_ENV, GUARD_MAX_LAG, GUARD_READER_DB_CA_ENV, GUARD_READER_DB_URL_ENV, GUARD_RETIRED_KEYS_ENV, guardReaderConfigFromEnv, pgGuardReaderConnector, type GuardDbConnect, type GuardDbTarget, type GuardSettings, type GuardTimer } from '../link-audit-ledger';
import { readLedgerBackup, type BackupRefusalCode, type LedgerBackup } from './backup';
import { analyzeReconciliation, gateVerdict, type Analysis, type AuditOutcome, type Finding } from './model';
import { readGuard, type GuardReading, type ReaderRefusal } from './reader';
import { buildRecord, readRecords, writeRecord, type RecordsDirOptions, type RecordsRefusal, type StoredRecord } from './records';

/*
 * CLI da RECONCILIAÇÃO EXTERNA da guarda e do VERIFICADOR DO PORTÃO G-1 (G1.b.2b; spec `link-audit-production-gates.md` GE-E5, PG-G09, PG-G07 e
 * §10.1 linha G-1; D-G0-2). Entrega: `scripts/link-audit-guard-reconcile.ts` (`npm run link-audit:guard-reconcile -- …`).
 *
 * RODA FORA DA VPS, na máquina do responsável: usa a credencial do papel de LEITURA `gmn_guard_reader` (nunca fica na VPS) e a chave do pseudônimo
 * sob custódia dele. Dentro da pilha (`GMN_ROLE` no ambiente) ou com a credencial de ESCRITA no ambiente, recusa. Somente leitura sobre a guarda e
 * sobre o backup; o único arquivo gravado é o registro novo da reconciliação (criação exclusiva). Nunca lê arquivo de ambiente: os valores vêm do
 * ambiente do processo (ou de arquivos próprios, `*_FILE`). Nenhuma mensagem cita caminho, URL, senha ou material.
 *
 *   reconcile --backup <rodada do livro> --records-dir <pasta dos registros> [--first] [--json]
 *     compara guarda × backup × registro anterior; achado ⇒ código 2; grava `reconcile-NNNNNN.json` (também com achado: marca d'água).
 *   gate [--backup <rodada do livro>] [--json]
 *     portão G-1: configuração completa, leitor e TLS ok e TODA auditoria da rodada `CONSISTENT` ⇒ operante (código 0); senão código 2, com o motivo
 *     (`NOT_CONFIGURED`, `CONFIG_INVALID`, `GUARD_UNAVAILABLE`, `GUARD_DUPLICATE_HEAD`, `EXTERNAL_GUARD_NOT_VERIFIED`, `NO_AUDITS`, `STACK_NOT_PUBLISHING`,
 *     `NOT_CONSISTENT`).
 *     Não grava nada (nem registro).
 *
 * DECISÃO (G1.b.2b): o verificador do portão roda FORA da VPS, com o leitor. Motivos: a imagem do web é o `standalone` do Next (sem `tsx` nem
 * `scripts/`), esta etapa não cria contrato HTTP novo, a credencial de escrita não sai da VPS, e o resultado que vale para o portão é o de fora (um
 * web comprometido mentiria a um verificador dentro dele). A configuração da PILHA aparece pelo efeito: sem guarda, com outra chave do pseudônimo ou
 * sem conseguir publicar, as auditorias da rodada não têm cabeça sob a chave de custódia (`STACK_NOT_PUBLISHING` / `NOT_CONSISTENT`); a tela da
 * pilha continua dizendo "Guarda externa NÃO configurada" (`externalGuard: NOT_CONFIGURED`) no próprio servidor.
 *
 * Códigos de saída: 0 sem divergência / portão operante; 1 uso; 2 divergência (reconcile) ou portão não operante (gate); 3 recusa (entrada inválida,
 * sem configuração ou registro anterior, credencial que não é do leitor, guarda indisponível na reconciliação, registro não gravado); 4 inesperado.
 */
export const RECONCILE_SCHEMA = 'gmn.link-audit.guard-reconcile.v1';
export const GATE_SCHEMA = 'gmn.link-audit.guard-gate.v1';
export const EXIT = { OK: 0, USAGE: 1, FINDINGS: 2, REFUSED: 3, UNEXPECTED: 4 } as const;
export const USAGE = [
  'Uso (FORA da VPS, com a credencial do papel de leitura gmn_guard_reader):',
  '  npm run link-audit:guard-reconcile -- reconcile --backup <rodada do livro> --records-dir <pasta dos registros> [--first] [--json]',
  '  npm run link-audit:guard-reconcile -- gate [--backup <rodada do livro>] [--json]',
  `Ambiente (valor ou arquivo próprio com o sufixo _FILE): ${GUARD_READER_DB_URL_ENV}, ${GUARD_READER_DB_CA_ENV}, ${GUARD_KEY_ENV} e, com rotação, ${GUARD_RETIRED_KEYS_ENV} (toda chave já usada).`,
  '  --first: só na PRIMEIRA reconciliação (pasta de registros vazia). Sem ele, o registro anterior é obrigatório.',
];
const UNEXPECTED_MESSAGE = 'Falha inesperada.';
const MAX_SECRET_FILE_BYTES = 1024 * 1024;
const READER_VARIABLES = [GUARD_READER_DB_URL_ENV, GUARD_READER_DB_CA_ENV, GUARD_KEY_ENV, GUARD_RETIRED_KEYS_ENV] as const;
/** Variáveis cujo arquivo é lido como linha (o fim de linha sai, como no `$(cat …)` do entrypoint); a CA (PEM) vai como está. */
const LINE_VARIABLES: ReadonlySet<string> = new Set([GUARD_READER_DB_URL_ENV, GUARD_KEY_ENV, GUARD_RETIRED_KEYS_ENV]);
const ECHOABLE_FLAG = /^--[a-z][a-z-]*$/;
const MAX_ECHOED_FLAG = 20;

type Env = Readonly<Record<string, string | undefined>>;
type Line = (line: string) => void;
export interface GuardReconcileCliDeps {
  /** Ambiente do processo (o script passa `process.env`; os testes, um objeto). */
  readonly env: Env;
  /** Raiz do repositório (o leitor do livro recusa pastas dentro dela). */
  readonly projectRoot: string;
  readonly now?: () => Date;
  /** Conector da guarda (padrão: `pgGuardReaderConnector`, TLS `verify-full`). Só testes injetam outro. */
  readonly connectFor?: (target: GuardDbTarget) => GuardDbConnect;
  readonly timer?: GuardTimer;
  /** Ajustes da conferência da pasta dos registros (dono esperado, donos aceitos nos ancestrais, gancho da gravação). Só testes passam. */
  readonly recordsDir?: Omit<RecordsDirOptions, 'projectRoot'>;
}
const recordsOptions = (deps: GuardReconcileCliDeps): RecordsDirOptions => ({ ...deps.recordsDir, projectRoot: deps.projectRoot });

type RefusalCode = BackupRefusalCode | RecordsRefusal | ReaderRefusal | 'NOT_CONFIGURED' | 'INSIDE_THE_STACK' | 'READER_ENV_INVALID' | 'NO_PREVIOUS_RECORD' | 'PREVIOUS_RECORD_EXISTS' | 'RECORDS_DIR_NOT_EMPTY' | 'GUARD_KEY_DROPPED' | string;
const MESSAGES: Readonly<Record<string, string>> = {
  NOT_CONFIGURED: 'Guarda não configurada para a reconciliação: defina a credencial do leitor, a CA e a chave do pseudônimo.',
  INSIDE_THE_STACK: 'A reconciliação roda FORA da VPS (este ambiente tem GMN_ROLE, da pilha).',
  READER_ENV_INVALID: 'Variável do leitor inválida: valor e arquivo (_FILE) ao mesmo tempo, ou arquivo ilegível ou grande demais.',
  NO_PREVIOUS_RECORD: 'A pasta de registros está vazia: na primeira reconciliação use --first; nas seguintes, aponte a pasta com os registros anteriores.',
  PREVIOUS_RECORD_EXISTS: 'Já existe registro anterior nesta pasta: --first só vale na primeira reconciliação.',
  RECORDS_DIR_NOT_EMPTY: 'A pasta de registros não está vazia: --first só vale numa pasta TOTALMENTE vazia (nem temporário órfão).',
  RECORDS_DIR_UNSAFE: 'A pasta de registros é insegura: fica dentro do repositório (público), não é do seu usuário, tem escrita para grupo ou outros, tem um ancestral que outro usuário pode alterar, não dá para verificar dono e modo nesta plataforma, ou mudou durante a gravação (o registro não vale).',
  GUARD_KEY_DROPPED: 'Uma chave do pseudônimo usada no registro anterior não está na lista desta reconciliação: a reconciliação guarda TODA chave já usada.',
  GUARD_WRITER_CREDENTIAL_PRESENT: 'A credencial de ESCRITA da guarda está neste ambiente: a reconciliação usa só a do papel de leitura e nunca a do escritor.',
  GUARD_READER_ROLE_REQUIRED: 'A URL do leitor precisa ser do papel gmn_guard_reader (direto) ou gmn_guard_reader.<projeto> (pooler).',
  GUARD_CONFIG_PARTIAL: 'Configuração do leitor parcial: a URL, a CA e a chave do pseudônimo vão juntas.',
  GUARD_DB_URL_INVALID: 'URL do leitor inválida (só postgres(ql)://usuário:senha@host[:porta]/banco?sslmode=verify-full).',
  GUARD_DB_TLS_REQUIRED: 'A URL do leitor precisa de sslmode=verify-full.',
  GUARD_DB_CA_INVALID: 'CA do leitor inválida (PEM com certificado X.509, sem chave privada).',
  GUARD_KEY_WEAK: 'Chave do pseudônimo fora do formato <id>:<64 hex> (lista de aposentadas separada por vírgula, sem espaço).',
  GUARD_CONFIG_INVALID: 'Chaves do pseudônimo repetidas (mesmo id ou mesmo material).',
  GUARD_UNAVAILABLE: 'Guarda indisponível (conexão, TLS, autenticação, prazo ou erro de consulta). Nada foi concluído.',
  GUARD_RESPONSE_INVALID: 'A guarda respondeu fora do esquema esperado. Nada foi concluído.',
  GUARD_DUPLICATE_HEAD: 'Duas linhas na mesma posição de um pseudônimo na guarda (restrição única ausente ou alterada no provedor): incidente no provedor, runbook da guarda §10. Nenhum hash foi escolhido; nada foi concluído.',
  TOO_MANY_GUARD_HEADS: 'A guarda tem pseudônimos demais para uma leitura só.',
  NOT_READER_ROLE: 'A sessão não é do papel gmn_guard_reader: credencial errada. Nada foi lido.',
  SESSION_NOT_READ_ONLY: 'A sessão não é somente leitura por padrão (o papel de leitura da migração 004 é). Nada foi lido.',
  READER_CAN_PUBLISH: 'A sessão consegue executar a função de publicação: não é a credencial do leitor. Nada foi lido.',
  RECORDS_DIR_INVALID: 'A pasta de registros não existe ou não é um diretório comum.',
  RECORDS_INVALID: 'A pasta de registros tem lacuna, encadeamento quebrado, registro alterado ou um nome que não é reconcile-NNNNNN.json (nem o temporário órfão do gravador).',
  RECORD_EXISTS: 'O registro novo já existe (outra reconciliação gravou antes): nada foi sobrescrito; rode de novo.',
  RECORD_WRITE_FAILED: 'O registro novo não pôde ser gravado com durabilidade comprovada.',
  BACKUP_NOT_A_ROUND: 'A pasta informada não é uma rodada de backup do livro.',
  BACKUP_ROUND_NOT_VALID: 'A rodada não está marcada como válida (sem RODADA-VALIDA ou com RODADA-INCOMPLETA).',
  BACKUP_MANIFEST_INVALID: 'O SHA256SUMS da rodada está ausente ou malformado.',
  BACKUP_MANIFEST_MISMATCH: 'A cópia da rodada não confere com o SHA256SUMS.',
  BACKUP_UNEXPECTED_ENTRY: 'A cópia do livro tem algo que não é pasta de auditoria nem arquivo regular.',
};
const FINDING_TEXT: Readonly<Record<Finding['code'], string>> = {
  GUARD_REGRESSED: 'a guarda REGREDIU em relação ao registro anterior (linha sumiu ou mudou)',
  GUARD_HEAD_NOT_IN_BACKUP: 'a cabeça da guarda está ALÉM do backup (backup mais velho que a guarda)',
  GUARD_HEAD_WITHOUT_LEDGER: 'cabeça da guarda sem livro no backup',
  GUARD_HEAD_UNKNOWN_KEY: 'cabeça sob uma chave do pseudônimo que esta reconciliação não tem',
  HASH_MISMATCH: 'na posição da cabeça, o backup tem OUTRO registro',
  BACKUP_AHEAD_BEYOND_L_MAX: `o backup passa da cabeça da guarda por mais de L_max = ${GUARD_MAX_LAG} registros`,
  GUARD_HEAD_MISSING: 'livro com 2 ou mais registros e nenhuma cabeça na guarda',
  BACKUP_LEDGER_UNREADABLE: 'o livro desta auditoria no backup não passou na leitura',
};

/* ------------------------------------------------------------------ argumentos */

interface ParsedArgs {
  readonly command: 'reconcile' | 'gate';
  readonly backup: string | null;
  readonly recordsDir: string | null;
  readonly first: boolean;
  readonly json: boolean;
}
const FLAGS: Readonly<Record<ParsedArgs['command'], { readonly values: readonly string[]; readonly booleans: readonly string[] }>> = {
  reconcile: { values: ['backup', 'records-dir'], booleans: ['first', 'json'] },
  gate: { values: ['backup'], booleans: ['json'] },
};
const unknownFlag = (token: string): string => {
  const flag = token.split('=')[0] ?? '';
  return ECHOABLE_FLAG.test(flag) ? `Opção desconhecida: ${flag.slice(0, MAX_ECHOED_FLAG)}` : 'Opção desconhecida.';
};

/** Analisador ESTRITO: subcomando conhecido; opção desconhecida, repetida ou sem valor ⇒ uso. Valores nunca são ecoados. */
function parseArgs(argv: readonly string[]): ParsedArgs | string {
  const [command, ...rest] = argv;
  if (command !== 'reconcile' && command !== 'gate') return 'Informe o subcomando: reconcile ou gate.';
  const spec = FLAGS[command];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (!token.startsWith('--')) return `Argumento inesperado na posição ${index + 2} (as opções começam com --).`;
    const name = token.slice(2);
    if (spec.booleans.includes(name)) {
      if (booleans.has(name)) return `Opção repetida: --${name}.`;
      booleans.add(name);
      continue;
    }
    if (!spec.values.includes(name)) return unknownFlag(token);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--') || value === '' || value.includes('\0')) return `A opção --${name} exige um valor.`;
    if (values.has(name)) return `Opção repetida: --${name}.`;
    values.set(name, value);
    index += 1;
  }
  if (command === 'reconcile' && (!values.has('backup') || !values.has('records-dir'))) return 'reconcile exige --backup <rodada do livro> e --records-dir <pasta dos registros>.';
  return { command, backup: values.get('backup') ?? null, recordsDir: values.get('records-dir') ?? null, first: booleans.has('first'), json: booleans.has('json') };
}

/* ------------------------------------------------------------------ ambiente do leitor (valor ou arquivo próprio) */

async function readSecretFile(file: string): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SECRET_FILE_BYTES) return null;
    return (await handle.readFile()).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Resolve `X` / `X_FILE` das variáveis do leitor numa CÓPIA do ambiente (o resto passa como está, para a recusa da credencial de escrita). */
async function readerEnv(env: Env): Promise<Env | null> {
  const resolved: Record<string, string | undefined> = { ...env };
  for (const name of READER_VARIABLES) {
    const file = env[`${name}_FILE`];
    if (file === undefined || file === '') continue;
    if (env[name] !== undefined && env[name] !== '') return null;
    const content = await readSecretFile(file);
    if (content === null) return null;
    resolved[name] = LINE_VARIABLES.has(name) ? content.replace(/\r?\n+$/, '') : content;
    delete resolved[`${name}_FILE`];
  }
  return resolved;
}

/* ------------------------------------------------------------------ saída */

class Refusal extends Error {
  constructor(readonly code: RefusalCode) {
    super(code);
  }
}

const findingJson = (item: Finding): Record<string, unknown> => ({ code: item.code, auditRef: item.auditRef, auditId: item.auditId, backupSeq: item.backupSeq, guardSeq: item.guardSeq, recordedSeq: item.recordedSeq });
const outcomeJson = (audit: AuditOutcome): Record<string, unknown> => ({ auditId: audit.auditId, auditRef: audit.auditRef, status: audit.status, backupSeq: audit.backupSeq, guardSeq: audit.guardSeq, lag: audit.lag });
const seqText = (label: string, value: number | null): string => (value === null ? '' : ` · ${label} ${value}`);
const findingLine = (item: Finding): string =>
  `  ${item.code}: ${FINDING_TEXT[item.code]} — ${item.auditId === null ? 'sem auditoria no backup' : `auditoria ${item.auditId}`} (pseudônimo ${item.auditRef})${seqText('guarda', item.guardSeq)}${seqText('backup', item.backupSeq)}${seqText('registro anterior', item.recordedSeq)}`;

function refusalOutput(schema: string, command: string, code: RefusalCode, json: boolean, out: Line, err: Line): number {
  const message = MESSAGES[code] ?? UNEXPECTED_MESSAGE;
  if (json) out(JSON.stringify({ schema, command, ok: false, code, message }));
  else err(`RECUSADO (${code}): ${message}`);
  return EXIT.REFUSED;
}

/* ------------------------------------------------------------------ reconcile */

interface ReconcileContext {
  readonly settings: GuardSettings;
  readonly previous: StoredRecord | null;
  readonly backup: LedgerBackup;
  readonly reading: GuardReading;
  readonly analysis: Analysis;
  readonly record: { readonly fileName: string; readonly sha256: string; readonly sequence: number };
}

function settingsOrRefuse(env: Env): GuardSettings {
  const config = guardReaderConfigFromEnv(env);
  if (config.status === 'NOT_CONFIGURED') throw new Refusal('NOT_CONFIGURED');
  if (config.status === 'INVALID') throw new Refusal(config.code);
  return config.settings;
}

async function previousOrRefuse(args: ParsedArgs, settings: GuardSettings, deps: GuardReconcileCliDeps): Promise<StoredRecord | null> {
  const records = await readRecords(path.resolve(args.recordsDir as string), recordsOptions(deps));
  if (!records.ok) throw new Refusal(records.code);
  const previous = records.value.last;
  if (args.first) {
    if (previous !== null) throw new Refusal('PREVIOUS_RECORD_EXISTS');
    if (records.value.entries > 0) throw new Refusal('RECORDS_DIR_NOT_EMPTY'); // nem um temporário órfão: a primeira cadeia nasce numa pasta vazia
  } else if (previous === null) throw new Refusal('NO_PREVIOUS_RECORD');
  if (previous && previous.record.keyIds.some((id) => !settings.pseudonyms.keyIds.includes(id))) throw new Refusal('GUARD_KEY_DROPPED');
  return previous;
}

async function backupOrRefuse(dir: string, deps: GuardReconcileCliDeps): Promise<LedgerBackup> {
  const backup = await readLedgerBackup(dir, deps.projectRoot);
  if (!backup.ok) throw new Refusal(backup.code);
  return backup.value;
}

async function reconcile(args: ParsedArgs, env: Env, deps: GuardReconcileCliDeps): Promise<ReconcileContext> {
  const settings = settingsOrRefuse(env);
  const previous = await previousOrRefuse(args, settings, deps);
  const backup = await backupOrRefuse(args.backup as string, deps);
  const connect = (deps.connectFor ?? pgGuardReaderConnector)(settings.target);
  const read = await readGuard(connect, previous?.record.heads ?? [], deps.timer ? { timer: deps.timer } : {});
  if (!read.ok) throw new Refusal(read.code);
  const analysis = analyzeReconciliation({ backup, pseudonyms: settings.pseudonyms, guardHeads: read.value.heads, previous: previous?.record.heads ?? null, previousNow: read.value.previousNow });
  const record = buildRecord({ previous, createdAt: (deps.now ?? (() => new Date()))(), backup: { round: backup.round, manifestSha256: backup.manifestSha256 }, keyIds: settings.pseudonyms.keyIds, analysis });
  const written = await writeRecord(path.resolve(args.recordsDir as string), recordsOptions(deps), record);
  if (!written.ok) throw new Refusal(written.code);
  return { settings, previous, backup, reading: read.value, analysis, record: { fileName: written.fileName, sha256: written.sha256, sequence: record.sequence } };
}

function reconcileOutput(context: ReconcileContext, json: boolean, out: Line): number {
  const { analysis, backup, settings, previous, record, reading } = context;
  const clean = analysis.findings.length === 0;
  if (json) {
    out(
      JSON.stringify({
        schema: RECONCILE_SCHEMA,
        command: 'reconcile',
        ok: clean,
        code: clean ? null : 'DIVERGENT',
        backup: { round: backup.round, manifestSha256: backup.manifestSha256 },
        reader: { role: reading.role, readOnly: true },
        keys: { current: settings.pseudonyms.currentKeyId, all: [...settings.pseudonyms.keyIds] },
        lMax: GUARD_MAX_LAG,
        summary: analysis.summary,
        findings: analysis.findings.map(findingJson),
        record: { file: record.fileName, sequence: record.sequence, sha256: record.sha256, previous: previous?.fileName ?? null },
      }),
    );
  } else {
    const { summary } = analysis;
    [
      'RECONCILIAÇÃO DA GUARDA (somente leitura: nada foi escrito na guarda nem no backup)',
      `Rodada do backup: ${backup.round} · auditorias no backup: ${summary.audits} · cabeças na guarda: ${summary.guardHeads}`,
      `Leitor: ${reading.role}, sessão somente leitura · chave atual do pseudônimo: ${settings.pseudonyms.currentKeyId} (${settings.pseudonyms.keyIds.length} no total)`,
      `Situação: CONSISTENT ${summary.consistent} · BEHIND ${summary.behind} (até L_max = ${GUARD_MAX_LAG}) · NO_HEAD ${summary.noHead} · DIVERGENT ${summary.divergent}`,
      `Auditorias com a maior cabeça só sob chave aposentada: ${summary.headsOnRetiredKey}${summary.headsOnRetiredKey === 0 ? '' : ' (a aposentada NÃO pode sair da lista do web)'}`,
      ...(clean ? ['Divergências: nenhuma'] : [`DIVERGÊNCIAS (${analysis.findings.length}):`, ...analysis.findings.map(findingLine)]),
      `Registro novo: ${record.fileName} (sha256 ${record.sha256})${previous ? `, anterior ${previous.fileName}` : ', primeiro registro'}`,
      clean ? 'Resultado: SEM DIVERGÊNCIA' : `Resultado: DIVERGÊNCIA ENCONTRADA (código de saída ${EXIT.FINDINGS}); siga o runbook da guarda`,
    ].forEach((line) => out(line));
  }
  return clean ? EXIT.OK : EXIT.FINDINGS;
}

/* ------------------------------------------------------------------ gate (portão G-1) */

type ConfigCheck = 'READY' | 'NOT_CONFIGURED' | 'INVALID';
interface GateState {
  code: string | null;
  configuration: ConfigCheck;
  configurationCode: string | null;
  connection: 'OK' | 'FAILED' | 'NOT_ATTEMPTED';
  reader: 'OK' | 'NOT_VERIFIED';
  externalGuard: 'CONSISTENT' | 'NOT_CONSISTENT' | 'NOT_VERIFIED';
  backup: LedgerBackup | null;
  analysis: Analysis | null;
}
/** Recusas de mau uso do verificador (não dizem nada sobre a guarda): código 3. */
const GATE_MISUSE: ReadonlySet<string> = new Set(['GUARD_WRITER_CREDENTIAL_PRESENT', 'GUARD_READER_ROLE_REQUIRED', 'NOT_READER_ROLE', 'SESSION_NOT_READ_ONLY', 'READER_CAN_PUBLISH']);

async function gate(args: ParsedArgs, env: Env, deps: GuardReconcileCliDeps): Promise<GateState> {
  const state: GateState = { code: null, configuration: 'NOT_CONFIGURED', configurationCode: null, connection: 'NOT_ATTEMPTED', reader: 'NOT_VERIFIED', externalGuard: 'NOT_VERIFIED', backup: null, analysis: null };
  const config = guardReaderConfigFromEnv(env);
  if (config.status === 'INVALID' && GATE_MISUSE.has(config.code)) throw new Refusal(config.code);
  if (config.status !== 'READY') return { ...state, code: config.status === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'CONFIG_INVALID', configuration: config.status, configurationCode: config.status === 'INVALID' ? config.code : null };
  state.configuration = 'READY';
  if (args.backup !== null) state.backup = await backupOrRefuse(args.backup, deps);
  const read = await readGuard((deps.connectFor ?? pgGuardReaderConnector)(config.settings.target), [], deps.timer ? { timer: deps.timer } : {});
  if (!read.ok && GATE_MISUSE.has(read.code)) throw new Refusal(read.code);
  if (!read.ok && read.code === 'GUARD_DUPLICATE_HEAD') return { ...state, code: 'GUARD_DUPLICATE_HEAD', connection: 'OK', reader: 'OK' };
  if (!read.ok) return { ...state, code: 'GUARD_UNAVAILABLE', connection: 'FAILED' };
  state.connection = 'OK';
  state.reader = 'OK';
  if (state.backup === null) return { ...state, code: 'EXTERNAL_GUARD_NOT_VERIFIED' };
  const analysis = analyzeReconciliation({ backup: state.backup, pseudonyms: config.settings.pseudonyms, guardHeads: read.value.heads, previous: null, previousNow: [] });
  const verdict = gateVerdict(analysis);
  return { ...state, analysis, code: verdict.code, externalGuard: verdict.operational ? 'CONSISTENT' : 'NOT_CONSISTENT' };
}

function gateOutput(state: GateState, json: boolean, out: Line): number {
  const operational = state.code === null;
  const notConsistent = state.analysis?.audits.filter((audit) => audit.status !== 'CONSISTENT') ?? [];
  const findings = state.analysis?.findings ?? [];
  if (json) {
    out(
      JSON.stringify({
        schema: GATE_SCHEMA,
        command: 'gate',
        ok: operational,
        code: state.code,
        gate: 'G-1',
        operational,
        checks: { configuration: state.configuration, configurationCode: state.configurationCode, connection: state.connection, reader: state.reader, externalGuard: state.externalGuard },
        backup: state.backup ? { round: state.backup.round, manifestSha256: state.backup.manifestSha256 } : null,
        lMax: GUARD_MAX_LAG,
        summary: state.analysis?.summary ?? null,
        notConsistent: notConsistent.map(outcomeJson),
        findings: findings.map(findingJson),
      }),
    );
  } else {
    [
      `PORTÃO G-1 (guarda operante): ${operational ? 'OPERANTE' : `NÃO OPERANTE (${state.code})`}`,
      `Configuração do leitor: ${state.configuration}${state.configurationCode ? ` (${state.configurationCode})` : ''} · conexão TLS: ${state.connection} · leitor: ${state.reader} · externalGuard: ${state.externalGuard}`,
      ...(state.backup ? [`Rodada do backup: ${state.backup.round} · auditorias: ${state.analysis?.summary.audits ?? 0}`] : ['Sem rodada de backup: a situação das auditorias NÃO foi verificada (NOT_VERIFIED).']),
      ...notConsistent.map((audit) => `  ${audit.status}: auditoria ${audit.auditId} (pseudônimo ${audit.auditRef})${seqText('guarda', audit.guardSeq)}${seqText('backup', audit.backupSeq)}`),
      ...findings.map(findingLine),
      'Somente leitura: nada foi gravado (nem na guarda, nem no backup, nem registro).',
    ].forEach((line) => out(line));
  }
  return operational ? EXIT.OK : EXIT.FINDINGS;
}

/* ------------------------------------------------------------------ entrada */

export async function runGuardReconcileCli(argv: readonly string[], out: Line, err: Line, deps: GuardReconcileCliDeps): Promise<number> {
  const json = argv.includes('--json');
  const command = argv[0] === 'gate' ? 'gate' : 'reconcile';
  const schema = command === 'gate' ? GATE_SCHEMA : RECONCILE_SCHEMA;
  try {
    const args = parseArgs(argv);
    if (typeof args === 'string') {
      if (json) out(JSON.stringify({ schema, command, ok: false, code: 'USAGE', message: args }));
      else [args, ...USAGE].forEach((line) => err(line));
      return EXIT.USAGE;
    }
    if (deps.env.GMN_ROLE !== undefined && deps.env.GMN_ROLE !== '') throw new Refusal('INSIDE_THE_STACK');
    const env = await readerEnv(deps.env);
    if (env === null) throw new Refusal('READER_ENV_INVALID');
    if (args.command === 'gate') return gateOutput(await gate(args, env, deps), args.json, out);
    return reconcileOutput(await reconcile(args, env, deps), args.json, out);
  } catch (error) {
    if (error instanceof Refusal) return refusalOutput(schema, command, error.code, json, out, err);
    // nunca a mensagem do erro: pode trazer caminho de disco ou conteúdo lido
    if (json) out(JSON.stringify({ schema, command, ok: false, code: 'UNEXPECTED', message: UNEXPECTED_MESSAGE }));
    err(UNEXPECTED_MESSAGE);
    return EXIT.UNEXPECTED;
  }
}
