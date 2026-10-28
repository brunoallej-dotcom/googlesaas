/**
 * Preservação e relatório OFFLINE de capturas da Auditoria por Link (Fase 6, Onda 4D).
 *
 *   npm run link-audit:evidence -- persist --from <pasta da captura> --to <pasta nova e privada>
 *   npm run link-audit:evidence -- verify  --dir <pasta persistida>
 *   npm run link-audit:evidence -- report  --dir <pasta persistida> --link <link> --operator <e-mail> [--name … --city … --uf …]
 *
 * Nada aqui usa rede, Serper, Google nem o .env.local. `persist` NUNCA sobrescreve (a pasta destino tem de ser
 * nova, os arquivos são criados com `wx`) e recusa copiar qualquer coisa que contenha chave ou cabeçalho de
 * autenticação. A cópia fica no mesmo disco: não é um backup independente.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { companyIdentitySchema, confirmIdentity } from '@/lib/link-audit/audit';
import { buildReportFromCapture, type CaptureFileRef, type OriginalSiteObservation } from '@/lib/link-audit/collector/capture-report';
import { LEGACY_RESTRICTED_MESSAGE } from '@/lib/link-audit/collector/site-access';
import { parseGoogleMapsLink } from '@/lib/link-audit/maps-link';
import { toSafeJson } from '@/lib/link-audit/url-redaction';
import { redactSecrets } from '@/lib/redact';

export const CAPTURE_FILES = ['serper-body.json', 'serper-status.json', 'serper-attempts.json', 'summary.json', 'run-stdout.txt', 'run-stderr.txt'] as const;

const PURPOSES: Readonly<Record<(typeof CAPTURE_FILES)[number], string>> = {
  'serper-body.json': 'Corpo ORIGINAL da resposta HTTP do Serper /maps. Evidência primária; não editar.',
  'serper-status.json': 'Status HTTP da chamada ao Serper.',
  'serper-attempts.json': 'Contador de tentativas HTTP ao Serper e horário.',
  'summary.json': 'Resumo do driver da coleta: código de saída, tentativas ao Serper, requisições ao site.',
  'run-stdout.txt': 'Saída original do comando, guardada como veio (pode conter JSON corrompido pela redação antiga).',
  'run-stderr.txt': 'Erros do comando.',
};

/** Padrões de chave/cabeçalho/token da base do projeto (`redactSecrets`): se a redação mudaria o texto, há segredo. */
function containsSecret(text: string, apiKey: string | undefined): boolean {
  return SECRET_PATTERNS.test(text) || redactSecrets(text, {}) !== text || Boolean(apiKey && apiKey.length > 10 && text.includes(apiKey));
}

const SECRET_PATTERNS = /x-api-key|set-cookie|["']?\b(?:authorization|cookie|api[-_]?key|apikey)\b["']?\s*[:=]|bearer\s+[a-z0-9._~+/=-]{8,}/i;

const sha256 = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');
const isoOrNull = (value: string | undefined): string | null => (value && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : null);

export interface PersistOptions {
  readonly from: string;
  readonly to: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  readonly meta?: Readonly<Record<string, unknown>>;
}
export type StepResult<T = object> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

export function persistCapture(options: PersistOptions): StepResult<{ readonly manifest: unknown }> {
  const from = path.resolve(options.from);
  const to = path.resolve(options.to);
  if (fs.existsSync(to)) return { ok: false, reason: 'A pasta de destino já existe; nada é sobrescrito.' };
  const sources: Array<{ name: (typeof CAPTURE_FILES)[number]; bytes: Buffer }> = [];
  const apiKey = options.env?.SERPER_API_KEY?.trim();
  for (const name of CAPTURE_FILES) {
    const file = path.join(from, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      return { ok: false, reason: `Arquivo de origem ausente: ${name}. Nada foi copiado (e a API NÃO deve ser repetida para recuperá-lo).` };
    }
    if (!stat.isFile()) return { ok: false, reason: `${name} não é um arquivo comum.` };
    const bytes = fs.readFileSync(file);
    const text = bytes.toString('utf8');
    // O corpo do provedor é a evidência original e pode ter URLs/textos legítimos: só chave e cabeçalhos de autenticação o barram.
    // Os demais arquivos (saídas do nosso comando) passam também pela varredura ampla de segredos do projeto.
    const leaks = name === 'serper-body.json' ? SECRET_PATTERNS.test(text) || Boolean(apiKey && apiKey.length > 10 && text.includes(apiKey)) : containsSecret(text, apiKey);
    if (leaks) {
      return { ok: false, reason: `${name} parece conter chave ou cabeçalho de autenticação; nada foi copiado.` };
    }
    sources.push({ name, bytes });
  }
  try {
    JSON.parse(sources[0]?.bytes.toString('utf8') ?? '');
  } catch {
    return { ok: false, reason: 'serper-body.json não é JSON válido; nada foi copiado.' };
  }

  const staging = `${to}.incomplete`;
  if (fs.existsSync(staging)) return { ok: false, reason: `Existe uma cópia incompleta anterior (${path.basename(staging)}); verifique-a manualmente. Nada foi sobrescrito.` };
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.mkdirSync(staging);
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'A pasta de trabalho já existe; nada é sobrescrito.' : 'Não foi possível criar a pasta de trabalho.' };
  }
  const files: Array<CaptureFileRef & { readonly purpose: string; readonly sourceMtimeUtc: string }> = [];
  for (const { name, bytes } of sources) {
    fs.writeFileSync(path.join(staging, name), bytes, { flag: 'wx', mode: 0o600 });
    const back = fs.readFileSync(path.join(staging, name));
    if (sha256(back) !== sha256(bytes)) return { ok: false, reason: `Releitura de ${name} não confere com a origem.` };
    files.push({ name, bytes: bytes.length, sha256: sha256(bytes), purpose: PURPOSES[name], sourceMtimeUtc: fs.statSync(path.join(from, name)).mtime.toISOString() });
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'LINK_AUDIT_CAPTURE_MANIFEST',
    ...(options.meta ?? {}),
    copiedAtUtc: options.now().toISOString(),
    storageWarning: 'Cópia no MESMO disco do projeto: NÃO é um backup independente.',
    secretsPolicy: 'Varredura por padrões de chave/cabeçalho/token (e pelo valor literal da SERPER_API_KEY quando presente no ambiente do comando). As URLs da resposta original foram preservadas como vieram.',
    files,
  };
  fs.writeFileSync(path.join(staging, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(staging, 'SHA256SUMS'), files.map((entry) => `${entry.sha256}  ${entry.name}\n`).join(''), { flag: 'wx', mode: 0o600 });
  const verified = verifyCapture(staging);
  if (!verified.ok) return { ok: false, reason: `${verified.reason} A cópia incompleta ficou em ${path.basename(staging)} para inspeção.` };
  try {
    fs.renameSync(staging, to); // só aparece com o nome final depois de completa e verificada
  } catch {
    return { ok: false, reason: `Não foi possível concluir a cópia; ela ficou em ${path.basename(staging)}.` };
  }
  return { ok: true, manifest };
}

export function verifyCapture(dir: string): StepResult<{ readonly files: readonly CaptureFileRef[] }> {
  const root = path.resolve(dir);
  let sums: string;
  try {
    sums = fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8');
  } catch {
    return { ok: false, reason: 'SHA256SUMS ausente.' };
  }
  const checked: CaptureFileRef[] = [];
  const listed = new Set<string>();
  for (const line of sums.split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
    if (!match) return { ok: false, reason: 'SHA256SUMS malformado.' };
    const [, expected, name] = match as unknown as [string, string, string];
    if (!(CAPTURE_FILES as readonly string[]).includes(name)) return { ok: false, reason: `Nome inesperado em SHA256SUMS: ${name}.` };
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(root, name));
    } catch {
      return { ok: false, reason: `Arquivo listado ausente: ${name}.` };
    }
    if (sha256(bytes) !== expected) return { ok: false, reason: `SHA-256 divergente: ${name}.` };
    listed.add(name);
    checked.push({ name, sha256: expected, bytes: bytes.length });
  }
  for (const name of CAPTURE_FILES) if (!listed.has(name)) return { ok: false, reason: `Arquivo esperado fora da lista de hashes: ${name}.` };
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST.json'), 'utf8')) as { files?: Array<{ name: string; sha256: string; bytes?: number }> };
    for (const entry of manifest.files ?? []) {
      const found = checked.find((c) => c.name === entry.name);
      if (found?.sha256 !== entry.sha256 || (typeof entry.bytes === 'number' && found.bytes !== entry.bytes)) return { ok: false, reason: `MANIFEST.json diverge de SHA256SUMS: ${entry.name}.` };
    }
    JSON.parse(fs.readFileSync(path.join(root, 'serper-body.json'), 'utf8'));
    const reportSums = path.join(root, 'report.json.sha256');
    if (fs.existsSync(reportSums)) {
      const declared = /^([0-9a-f]{64}) {2}report\.json$/m.exec(fs.readFileSync(reportSums, 'utf8'))?.[1];
      if (!declared || sha256(fs.readFileSync(path.join(root, 'report.json'))) !== declared) return { ok: false, reason: 'report.json não confere com report.json.sha256.' };
    }
  } catch {
    return { ok: false, reason: 'MANIFEST.json ou serper-body.json inválido.' };
  }
  return { ok: true, files: checked };
}

export interface ReportOptions {
  readonly dir: string;
  readonly link: string;
  readonly operator: string;
  readonly name?: string;
  readonly city?: string;
  readonly uf?: string;
  readonly now: () => Date;
}

export async function generateReport(options: ReportOptions): Promise<StepResult<{ readonly path: string; readonly sha256: string; readonly report: unknown }>> {
  const dir = path.resolve(options.dir);
  const verified = verifyCapture(dir);
  if (!verified.ok) return verified;
  const read = (name: string): string => fs.readFileSync(path.join(dir, name), 'utf8');
  const stdout = read('run-stdout.txt');
  const grab = (re: RegExp): string | undefined => re.exec(stdout)?.[1];
  let status: { status?: number };
  let attempts: { attempts?: number };
  let summary: { siteHttpRequests?: number };
  try {
    status = (JSON.parse(read('serper-status.json')) as { status?: number } | null) ?? {};
    attempts = (JSON.parse(read('serper-attempts.json')) as { attempts?: number } | null) ?? {};
    summary = (JSON.parse(read('summary.json')) as { siteHttpRequests?: number } | null) ?? {};
  } catch {
    return { ok: false, reason: 'serper-status.json, serper-attempts.json ou summary.json não é JSON válido.' };
  }
  if (fs.existsSync(path.join(dir, 'report.json')) || fs.existsSync(path.join(dir, 'report.json.sha256'))) {
    return { ok: false, reason: 'report.json já existe nesta pasta; nada é sobrescrito (renomeie o anterior para gerar outro).' };
  }
  const collectedAt = isoOrNull(grab(/"queriedAt":\s*"([^"]+)"/));
  const confirmedAt = isoOrNull(grab(/"confirmedAt":\s*"([^"]+)"/));
  const snapshotId = grab(/"snapshotId":\s*"([A-Za-z0-9_-]+)"/);
  if (!collectedAt || !confirmedAt || !snapshotId || typeof status.status !== 'number' || typeof attempts.attempts !== 'number') {
    return { ok: false, reason: 'Não foi possível recuperar data da coleta, confirmação, snapshotId, status HTTP ou tentativas da captura.' };
  }

  const link = parseGoogleMapsLink(options.link);
  if (link.status !== 'IDENTIFIED') return { ok: false, reason: 'O link informado não identifica uma empresa.' };
  const confirmed = confirmIdentity(link, { confirmedBy: options.operator, confirmedAt });
  if (!confirmed.ok) return { ok: false, reason: `Identidade não confirmada: ${confirmed.issues.join(' ')}` };
  const parsedIdentity = companyIdentitySchema.safeParse({
    ...confirmed.value,
    ...(options.name ? { name: options.name } : {}),
    ...(options.city ? { city: options.city } : {}),
    ...(options.uf ? { stateCode: options.uf.toUpperCase() } : {}),
  });
  if (!parsedIdentity.success) return { ok: false, reason: 'Nome, cidade ou UF inválidos.' };

  let site: OriginalSiteObservation | null = null;
  const siteUrl = /"site":\s*\{[\s\S]*?"requestedUrl":\s*"(https?:\/\/[^"]+)"/.exec(stdout)?.[1];
  const siteChecked = isoOrNull(/"site":\s*\{[\s\S]*?"checkedAt":\s*"([^"]+)"/.exec(stdout)?.[1]);
  if (siteUrl && siteChecked) {
    const reason = /(Consulta bloqueada por segurança: [^"\\\n]*)/.exec(stdout)?.[1] ?? '';
    // Só se reproduz o que a captura comprova: o único motivo reconhecido é o da coleta original (resposta restrita).
    if (reason.includes(LEGACY_RESTRICTED_MESSAGE)) {
      site = {
        requestedUrl: siteUrl,
        checkedAt: siteChecked,
        originalFailureReason: reason,
        httpRequests: typeof summary.siteHttpRequests === 'number' ? summary.siteHttpRequests : null,
      };
    }
  }
  const body = verified.files.find((entry) => entry.name === 'serper-body.json') as CaptureFileRef;
  const built = await buildReportFromCapture({
    rawBody: read('serper-body.json'),
    body,
    otherFiles: verified.files.filter((entry) => entry.name !== 'serper-body.json'),
    httpStatus: status.status,
    httpAttempts: attempts.attempts,
    collectedAt,
    input: { snapshotId, link: { originalLink: link.originalInput, resolved: null }, identity: parsedIdentity.data },
    site,
    generatedAt: options.now().toISOString(),
  });
  if (!built.ok) return built;

  const json = `${toSafeJson(built.report)}\n`;
  const target = path.join(dir, 'report.json');
  fs.writeFileSync(target, json, { flag: 'wx' });
  const hash = sha256(fs.readFileSync(target));
  fs.writeFileSync(path.join(dir, 'report.json.sha256'), `${hash}  report.json\n`, { flag: 'wx' });
  JSON.parse(fs.readFileSync(target, 'utf8'));
  return { ok: true, path: target, sha256: hash, report: built.report };
}

// ------------------------------------------------------------------------------------------ comando
function parseFlags(argv: readonly string[]): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i] ?? '';
    const value = argv[i + 1];
    if (!key.startsWith('--') || value === undefined || value.startsWith('--')) return `Argumento inválido: ${key.slice(0, 30)}`;
    out[key.slice(2)] = value;
  }
  return out;
}

export async function runEvidenceCli(argv: readonly string[], out: (line: string) => void, err: (line: string) => void, now: () => Date = () => new Date()): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (typeof flags === 'string') {
    err(flags);
    return 1;
  }
  if (command === 'persist' && flags.from && flags.to) {
    const result = persistCapture({ from: flags.from, to: flags.to, env: process.env, now });
    if (!result.ok) return err(`RECUSADO: ${result.reason}`), 3;
    out(`Cópia criada e verificada por releitura em ${path.resolve(flags.to)} (mesmo disco: não é backup independente).`);
    return 0;
  }
  if (command === 'verify' && flags.dir) {
    const result = verifyCapture(flags.dir);
    if (!result.ok) return err(`FALHA: ${result.reason}`), 3;
    out(`Integridade confirmada (${result.files.length} arquivos, SHA-256 conferido por releitura).`);
    return 0;
  }
  if (command === 'report' && flags.dir && flags.link && flags.operator) {
    const result = await generateReport({ dir: flags.dir, link: flags.link, operator: flags.operator, ...(flags.name ? { name: flags.name } : {}), ...(flags.city ? { city: flags.city } : {}), ...(flags.uf ? { uf: flags.uf } : {}), now });
    if (!result.ok) return err(`RECUSADO: ${result.reason}`), 3;
    out(`Relatório gravado em ${result.path} (SHA-256 ${result.sha256}). Nenhuma chamada externa foi feita.`);
    return 0;
  }
  err('Uso: persist --from <pasta> --to <pasta nova> | verify --dir <pasta> | report --dir <pasta> --link <link> --operator <e-mail> [--name --city --uf]');
  return 1;
}

if (process.argv[1] && /link-audit-evidence\.ts$/.test(process.argv[1])) {
  runEvidenceCli(process.argv.slice(2), (line) => console.log(line), (line) => console.error(line)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error('Falha inesperada.');
      process.exitCode = 4;
    },
  );
}
