// Gate de SCA: lê a saída de `npm audit --json` e falha se houver aviso
// high/critical sem exceção válida. Sem dependências; roda em Node >= 22.
// Uso: node npm-audit-gate.mjs <audit.json> [exceptions.json] [package-lock.json] [AAAA-MM-DD]
import { readFileSync } from 'node:fs';

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const BLOCK_FROM = 'high';
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
if (!auditPath) fail('uso: npm-audit-gate.mjs <audit.json>');

const audit = readJson(auditPath, 'saída do npm audit (pode ter falhado por rede)');
const exc = readJson(excPath, 'lista de exceções').exceptions;
const lock = readJson(lockPath, 'lockfile').packages ?? {};
if (audit.error || !audit.vulnerabilities) {
  fail(`npm audit sem resultado válido: ${JSON.stringify(audit.error ?? 'campo vulnerabilities ausente')}`);
}
if (!Array.isArray(exc)) fail('"exceptions" deve ser uma lista');

const today = todayArg ?? new Date().toISOString().slice(0, 10);
const problems = [];
for (const e of exc) {
  for (const k of ['name', 'version', 'max_severity', 'reason', 'reference', 'review_by']) {
    if (!e[k]) problems.push(`exceção inválida (${e.name ?? '?'}): campo "${k}" ausente`);
  }
  if (e.review_by && e.review_by < today) {
    problems.push(`exceção EXPIRADA: ${e.name}@${e.version} (review_by ${e.review_by}); reavalie ou renove com justificativa`);
  }
}

const installedVersions = (v) => (v.nodes ?? []).map((n) => lock[n]?.version).filter(Boolean);
for (const [name, v] of Object.entries(audit.vulnerabilities)) {
  const versions = installedVersions(v);
  const urls = (v.via ?? []).filter((x) => typeof x === 'object').map((x) => x.url).filter(Boolean);
  const label = `${name}@${versions.join(',') || '?'} [${v.severity}] ${urls.join(' ')}`.trim();
  if (RANK[v.severity] < RANK[BLOCK_FROM]) {
    console.log(`info   ${label}`);
    continue;
  }
  const isCovered =
    versions.length > 0 &&
    versions.every((ver) =>
      exc.some((e) => e.name === name && e.version === ver && RANK[v.severity] <= RANK[e.max_severity]),
    );
  if (isCovered) console.log(`aceito ${label}`);
  else problems.push(`aviso SEM exceção: ${label}`);
}
if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log('SCA ok: nenhum aviso high/critical fora da lista de exceções.');
