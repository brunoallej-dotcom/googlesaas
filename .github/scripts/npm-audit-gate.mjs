// Gate de SCA: lê a saída de `npm audit --json` e falha se houver aviso
// high/critical sem exceção válida. Falha fechada em qualquer formato inesperado.
// Sem dependências; roda em Node >= 22.
// Uso: node npm-audit-gate.mjs <audit.json> [exceptions.json] [package-lock.json] [AAAA-MM-DD]
import { readFileSync } from 'node:fs';

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const BLOCK_FROM = 'high';
const MAX_REVIEW_DAYS = 90;
const MS_PER_DAY = 86_400_000;
const REQUIRED_FIELDS = ['name', 'version', 'max_severity', 'reason', 'reference', 'review_by'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const [auditPath, excPath = '.github/security/npm-audit-exceptions.json', lockPath = 'package-lock.json', todayArg] =
  process.argv.slice(2);

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}
function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return fail(`${what} ilegível em ${path}: ${e.message}`);
  }
}
const isPlainObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const hasRank = (s) => typeof s === 'string' && Object.hasOwn(RANK, s);

// Retorna o instante UTC (ms) de uma data AAAA-MM-DD real, ou null.
function parseIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== s) return null;
  return ms;
}

function checkException(e, i, todayMs, today) {
  if (!isPlainObject(e)) return [`exceção #${i} inválida: deve ser um objeto, veio ${JSON.stringify(e)}`];
  const id = typeof e.name === 'string' ? e.name : `#${i}`;
  const out = [];
  for (const k of REQUIRED_FIELDS) {
    if (typeof e[k] !== 'string' || !e[k].trim()) out.push(`exceção inválida (${id}): campo "${k}" ausente ou não é texto`);
  }
  if (e.advisory !== undefined && (typeof e.advisory !== 'string' || !e.advisory.trim())) {
    out.push(`exceção inválida (${id}): "advisory" deve ser texto não vazio quando presente`);
  }
  if (typeof e.max_severity === 'string' && !hasRank(e.max_severity)) {
    out.push(`exceção inválida (${id}): max_severity "${e.max_severity}" desconhecida`);
  }
  if (typeof e.review_by === 'string' && e.review_by.trim()) {
    const ms = parseIsoDate(e.review_by);
    if (ms === null) {
      out.push(`exceção inválida (${id}): review_by "${e.review_by}" não é data AAAA-MM-DD válida`);
    } else if (ms < todayMs) {
      out.push(`exceção EXPIRADA: ${id}@${e.version} (review_by ${e.review_by}); reavalie ou renove com justificativa`);
    } else if (ms > todayMs + MAX_REVIEW_DAYS * MS_PER_DAY) {
      out.push(`exceção inválida (${id}): review_by ${e.review_by} passa de ${MAX_REVIEW_DAYS} dias à frente de ${today}`);
    }
  }
  return out;
}

// Confere as contagens high/critical declaradas em metadata com as entradas analisadas.
function checkMetadata(audit, vulns) {
  const meta = audit.metadata?.vulnerabilities;
  if (!isPlainObject(meta)) return ['npm audit sem "metadata.vulnerabilities" válido; não dá para conferir a contagem'];
  const out = [];
  for (const sev of ['high', 'critical']) {
    const declared = meta[sev];
    if (!Number.isInteger(declared) || declared < 0) {
      out.push(`metadata.vulnerabilities.${sev} ausente ou malformado: ${JSON.stringify(declared)}`);
      continue;
    }
    const found = Object.values(vulns).filter((v) => isPlainObject(v) && v.severity === sev).length;
    if (found < declared) out.push(`metadata declara ${declared} ${sev}, mas só ${found} entrada(s) analisada(s)`);
  }
  return out;
}

function installedVersions(v, lock) {
  const nodes = Array.isArray(v.nodes) ? v.nodes : [];
  const versions = nodes.map((n) => lock[n]?.version);
  const ok = nodes.length > 0 && versions.every((x) => typeof x === 'string');
  return { ok, versions: versions.filter((x) => typeof x === 'string') };
}

// URLs dos avisos de origem de um pacote: as do próprio `via` e, para cada NOME em `via` (aviso herdado de outro
// pacote do relatório), as daquele pacote, recursivamente. `unresolved` = um elo não se prova (nome ausente do
// relatório, item sem URL): uma exceção com `advisory` não cobre o pacote. Ciclos não acrescentam URL.
function rootAdvisories(name, vulns, seen = new Set()) {
  if (seen.has(name)) return { urls: [], unresolved: false };
  seen.add(name);
  const v = vulns[name];
  if (!isPlainObject(v)) return { urls: [], unresolved: true };
  const urls = [];
  let unresolved = false;
  for (const x of Array.isArray(v.via) ? v.via : []) {
    if (typeof x === 'string') {
      const r = rootAdvisories(x, vulns, seen);
      urls.push(...r.urls);
      unresolved ||= r.unresolved;
    } else if (isPlainObject(x) && typeof x.url === 'string') urls.push(x.url);
    else unresolved = true;
  }
  return { urls: [...new Set(urls)], unresolved };
}

function coversAdvisory(e, roots) {
  if (e.advisory === undefined) return true;
  return !roots.unresolved && roots.urls.length > 0 && roots.urls.every((u) => u.includes(e.advisory));
}

if (!auditPath) fail('uso: npm-audit-gate.mjs <audit.json>');

const audit = readJson(auditPath, 'saída do npm audit (pode ter falhado por rede)');
const excDoc = readJson(excPath, 'lista de exceções');
const lockDoc = readJson(lockPath, 'lockfile');
if (!isPlainObject(audit)) fail('saída do npm audit deve ser um objeto JSON');
if (audit.error) fail(`npm audit sem resultado válido: ${JSON.stringify(audit.error)}`);
if (!isPlainObject(audit.vulnerabilities)) fail('npm audit: "vulnerabilities" ausente ou não é um objeto');
if (!isPlainObject(excDoc) || !Array.isArray(excDoc.exceptions)) fail('"exceptions" deve ser uma lista');
if (!isPlainObject(lockDoc) || !isPlainObject(lockDoc.packages)) fail('lockfile sem "packages" válido');
const exc = excDoc.exceptions;
const lock = lockDoc.packages;

const today = todayArg ?? new Date().toISOString().slice(0, 10);
const todayMs = parseIsoDate(today);
if (todayMs === null) fail(`data de referência inválida: ${today}`);

const problems = [...checkMetadata(audit, audit.vulnerabilities)];
exc.forEach((e, i) => problems.push(...checkException(e, i, todayMs, today)));

for (const [name, v] of Object.entries(audit.vulnerabilities)) {
  if (!isPlainObject(v)) {
    problems.push(`entrada de aviso malformada: ${name}`);
    continue;
  }
  const { ok, versions } = installedVersions(v, lock);
  const roots = rootAdvisories(name, audit.vulnerabilities);
  const label = `${name}@${versions.join(',') || '?'} [${v.severity}] ${roots.urls.join(' ')}`.trim();
  if (hasRank(v.severity) && RANK[v.severity] < RANK[BLOCK_FROM]) {
    console.log(`info   ${label}`);
    continue;
  }
  const isCovered =
    hasRank(v.severity) &&
    ok &&
    versions.every((ver) =>
      exc.some(
        (e) =>
          isPlainObject(e) &&
          e.name === name &&
          e.version === ver &&
          hasRank(e.max_severity) &&
          RANK[v.severity] <= RANK[e.max_severity] &&
          coversAdvisory(e, roots),
      ),
    );
  if (isCovered) console.log(`aceito ${label}`);
  else problems.push(`aviso SEM exceção${ok ? '' : ' (nó ausente do lockfile)'}: ${label}`);
}
if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log('SCA ok: nenhum aviso high/critical fora da lista de exceções.');
