/**
 * Coleta da Auditoria por Link, por COMANDO deliberado do operador (Fase 6, Onda 4B).
 *
 *   npm run link-audit:collect -- --link "<link completo do perfil>" --name "<nome>" --operator voce@empresa.com
 *
 * Padrão: DRY_RUN. Só analisa o link, confirma a identidade com o contrato da Onda 1 e imprime o PLANO e a
 * ESTIMATIVA DE CUSTO. Não lê `.env.local`, não cria provedores e não faz nenhum tráfego externo.
 *
 * Modo LIVE (uma única auditoria real, só com autorização escrita): exige `--live --authorization-id <id>
 * --max-maps-calls 1 --ack-cost` MAIS `GMN_LINK_AUDIT_LIVE=on`, `GMN_LINK_AUDIT_MAX_MAPS_CALLS=1` e
 * `GMN_LINK_AUDIT_AUTH_ID=<mesmo id>` no ambiente daquele comando. Faz no máximo UMA chamada ao Serper /maps,
 * nenhuma ao /reviews, e marca a autorização como usada antes de chamar (repetir o comando é recusado).
 * Nada é gravado além desse marcador. Este arquivo nunca altera o `.env.local`.
 *
 * Modo SIMULATED (SÓ o ensaio da W5 em homologação; W5.2b, spec do P1 §5.7): `--simulated --audit <auditId> --operator <e-mail>
 * --evidence-dir <pasta>` MAIS `GMN_LINK_AUDIT_HOMOLOGATION=1` no ambiente do comando. Link, identificadores e empresa são fixos e sintéticos;
 * nenhuma rede, nenhum arquivo de ambiente lido, nenhum provedor real. Grava a captura e o relatório MARCADOS como SIMULADA (dentro do hash).
 */
import path from 'node:path';
import { loadEnvConfig } from '@next/env';
import { companyIdentitySchema, confirmIdentity, type CompanyIdentity } from '@/lib/link-audit/audit';
import { formatCostEstimate } from '@/lib/link-audit/collector/cost';
import type { CollectorProviders } from '@/lib/link-audit/collector/types';
import { parseGoogleMapsLink } from '@/lib/link-audit/maps-link';
import { identifiersFingerprint, MAX_AUTHORIZATION_WINDOW_MS, type ConsumptionAuthorization } from '@/lib/link-audit/collector/budget';
import { redactUrlsInText, toSafeJson } from '@/lib/link-audit/url-redaction';
import type { FsOps } from '@/lib/link-audit/snapshot-store';
import type { ProviderCaptureInfo } from '@/lib/link-audit-runtime/serper-maps-provider';
import { describeRuntimeConfig, readRuntimeConfig, type EnvLike, type RuntimeConfig } from '@/lib/link-audit-runtime/config';
import { runLinkAuditCollection, type RunOutcome } from '@/lib/link-audit-runtime/run';
import { assertSerperMapsUrl, createSerperMapsProvider } from '@/lib/link-audit-runtime/serper-maps-provider';
import { SITE_MAX_HTTP_REQUESTS, createSiteProvider } from '@/lib/link-audit-runtime/site-provider';
import { simulatedCollectionInput } from '@/lib/link-audit-runtime/simulated-provider';
import { HOMOLOGATION_LOCK_ENV, isHomologationLockOn, SIMULATED_LABEL } from '@/lib/link-audit-evidence/simulated';
import { AUDIT_ID_PATTERN } from '@/lib/link-audit-evidence/types';
import {
  createFileUsedStore,
  defaultUsedAuthorizationDirectory,
  type UsedAuthorizationStore,
} from '@/lib/link-audit-runtime/used-authorizations';

export interface CliDeps {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly now: () => Date;
  /** Só é chamado no modo LIVE. */
  readonly loadEnv: () => void;
  readonly getEnv: () => EnvLike;
  readonly usedStore: () => UsedAuthorizationStore;
  readonly createLiveProviders: (config: RuntimeConfig, hooks: { readonly onCapture: (info: ProviderCaptureInfo) => Promise<void> }) => CollectorProviders;
  /** Testes: sistema de arquivos e raiz do projeto do armazenamento de evidências. */
  readonly evidenceOptions?: { readonly fs?: FsOps; readonly projectRoot?: string };
}

const VALUE_FLAGS = new Set(['link', 'name', 'city', 'uf', 'operator', 'snapshot-id', 'authorization-id', 'max-maps-calls', 'expires-in-minutes', 'evidence-dir', 'audit']);
const BOOLEAN_FLAGS = new Set(['live', 'ack-cost', 'json', 'help', 'simulated']);
/** Opções que NÃO existem no modo SIMULATED: as do LIVE e as que poriam dado de empresa (link, nome, cidade, UF são fixos e sintéticos). */
const NOT_IN_SIMULATED = ['live', 'ack-cost', 'authorization-id', 'max-maps-calls', 'expires-in-minutes', 'link', 'name', 'city', 'uf'] as const;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const USAGE = [
  'Uso: npm run link-audit:collect -- --link <link> --operator <e-mail> [--name <nome>] [--city <cidade>] [--uf <UF>] [--json]',
  'Padrão: DRY_RUN (plano e custo, sem tráfego externo e sem ler .env.local).',
  'LIVE (somente com autorização escrita): --live --authorization-id <id> --max-maps-calls 1 --ack-cost --evidence-dir <pasta privada>',
  '  --evidence-dir é OBRIGATÓRIO no LIVE: a resposta paga é gravada automaticamente (e o LIVE é bloqueado se o armazenamento não estiver pronto).',
  '  + no ambiente do comando: GMN_LINK_AUDIT_LIVE=on GMN_LINK_AUDIT_MAX_MAPS_CALLS=1 GMN_LINK_AUDIT_AUTH_ID=<mesmo id>',
  'SIMULATED (SÓ o ensaio em homologação; dados sintéticos fixos, sem rede): --simulated --audit <auditId> --operator <e-mail> --evidence-dir <pasta> [--snapshot-id <id>] [--json]',
  `  + no ambiente do comando: ${HOMOLOGATION_LOCK_ENV}=1 (sem a trava, recusado). Não aceita --link, --name, --city, --uf nem as opções do LIVE.`,
];

interface ParsedArgs {
  readonly values: Readonly<Record<string, string>>;
  readonly flags: ReadonlySet<string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs | string {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) return `Argumento inesperado: ${token.slice(0, 40)}`;
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) flags.add(name);
    else if (VALUE_FLAGS.has(name)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return `A opção --${name} exige um valor.`;
      values[name] = value;
      index += 1;
    } else return `Opção desconhecida: --${name}`;
  }
  return { values, flags };
}

function print(deps: CliDeps, outcome: RunOutcome, asJson: boolean): void {
  if (outcome.ok && outcome.kind === 'PLAN') {
    const plan = outcome.plan;
    if (asJson) return deps.out(toSafeJson(plan));
    deps.out('PLANO (DRY_RUN) — nenhuma chamada foi feita');
    const id = plan.expectedIdentity;
    deps.out(`Identidade esperada: fid original ${id.featureId ?? '—'}; CID ${id.cid ?? '—'}${id.cidOrigin ? ` (${id.cidOrigin})` : ''}${id.conflict ? `; CONFLITO: ${id.conflict}` : ''}`);
    if (plan.request) deps.out(`Requisição prevista: ${plan.request.method} ${plan.request.url} ${JSON.stringify(plan.request.body)} (chave não exibida)`);
    plan.confirmationCriterion.forEach((line) => deps.out(`Critério: ${line}`));
    deps.out(`Busca: ${plan.search.canSearch ? `"${plan.search.query}" (nome: ${plan.search.nameSource})` : 'sem nome, não há como buscar'}`);
    for (const call of plan.calls) deps.out(`- ${call.provider}: até ${call.maxCalls} — ${call.description}`);
    deps.out('CUSTO ESTIMADO');
    for (const line of formatCostEstimate(plan.cost)) deps.out(`- ${line}`);
    for (const note of plan.notes) deps.out(note);
    return;
  }
  if (outcome.ok) {
    const report = outcome.report;
    if (asJson) {
      deps.out(toSafeJson(outcome.persisted?.storedReport ?? report));
      outcome.persisted?.errors.forEach((error) => deps.err(`ATENÇÃO: ${redactUrlsInText(error)}`));
      outcome.persisted?.warnings.forEach((warning) => deps.err(`AVISO: ${redactUrlsInText(warning)}`));
      return;
    }
    if (outcome.persisted) {
      const p = outcome.persisted;
      deps.out(`EVIDÊNCIAS: auditoria ${p.auditId} · captura ${p.captureNumber ?? 'não gravada'} · relatório r${p.revision ?? '—'} (a cópia fica no mesmo disco; não é backup independente; o hash não é assinatura)`);
      p.errors.forEach((error) => deps.err(`ATENÇÃO: ${redactUrlsInText(error)}`));
      p.warnings.forEach((warning) => deps.err(`AVISO: ${redactUrlsInText(warning)}`));
    }
    deps.out(`RELATÓRIO (${report.mode}) — tráfego externo: ${report.externalTraffic ? 'SIM' : 'não'}`);
    deps.out(`Perfil localizado: ${report.located}; identificadores comparados com o retorno do provedor e confirmados (o CID pode ser derivado do FID; ver identifiers.confirmed): ${JSON.stringify(report.provenIdentifiers)}; base da identidade: ${JSON.stringify(report.identityBasis)}`);
    deps.out(`Evidências: ${report.evidences.length}; não verificadas: ${report.unverified.length}; divergências: ${report.divergences.length}`);
    deps.out(`Chamadas: enviadas ${report.calls.sent}, simuladas ${report.calls.simulated}, negadas ${report.calls.denied}`);
    for (const limitation of report.limitations) deps.out(`- limitação: ${redactUrlsInText(limitation)}`);
    return;
  }
  deps.err(`${outcome.persisted ? 'FALHA APÓS A CONSULTA' : 'RECUSADO'} (${outcome.code}): ${redactUrlsInText(outcome.reason)}`);
}

/** Código de saída: 0 ok · 1 uso · 2 link/identidade · 3 recusado ANTES de qualquer chamada · 4 falha na coleta ou relatório não gerado · 5 resposta paga NÃO totalmente persistida. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    deps.err(parsed);
    USAGE.forEach(deps.err);
    return 1;
  }
  const { values, flags } = parsed;
  if (flags.has('help')) {
    USAGE.forEach(deps.out);
    return 0;
  }
  if (flags.has('simulated')) return runSimulated(values, flags, deps);
  if (values.audit !== undefined) {
    deps.err('--audit só existe no modo --simulated (no LIVE, o id da auditoria é o da autorização).');
    return 1;
  }
  const operator = values.operator?.trim() ?? '';
  if (!values.link || !EMAIL.test(operator)) {
    deps.err('Informe --link e --operator (e-mail de quem está executando).');
    USAGE.forEach(deps.err);
    return 1;
  }

  const link = parseGoogleMapsLink(values.link);
  if (link.status !== 'IDENTIFIED') {
    deps.err(`O link não identifica uma empresa (${link.status}/${link.code}). Use o link completo do perfil; links curtos não são resolvidos.`);
    return 2;
  }
  const confirmed = confirmIdentity(link, { confirmedBy: operator, confirmedAt: deps.now().toISOString() });
  if (!confirmed.ok) {
    deps.err(`Não foi possível confirmar a identidade: ${confirmed.issues.join(' ')}`);
    return 2;
  }
  const operatorProvided = {
    ...(values.name ? { name: values.name } : {}),
    ...(values.city ? { city: values.city } : {}),
    ...(values.uf ? { stateCode: values.uf.toUpperCase() } : {}),
  };
  const identity = companyIdentitySchema.safeParse({ ...confirmed.value, ...operatorProvided });
  if (!identity.success) {
    deps.err('Nome, cidade ou UF informados são inválidos (caracteres de controle, tamanho ou UF com 2 letras).');
    return 2;
  }
  const company: CompanyIdentity = identity.data;
  const stamp = deps.now().toISOString().replace(/\D/g, '').slice(0, 14);
  const snapshotId = values['snapshot-id'] ?? `audit-${stamp}`;
  const input = { snapshotId, link: { originalLink: link.originalInput, resolved: null }, identity: company };
  const asJson = flags.has('json');

  if (!flags.has('live')) {
    const outcome = await runLinkAuditCollection({ mode: 'DRY_RUN', input }, { now: deps.now });
    print(deps, outcome, asJson);
    return outcome.ok ? 0 : 3;
  }

  // ---- LIVE: tudo é conferido ANTES de ler o ambiente completo ou criar qualquer provedor ------------
  const authorizationId = values['authorization-id'];
  const maxMaps = Number(values['max-maps-calls']);
  const problems: string[] = [];
  if (!authorizationId) problems.push('falta --authorization-id');
  if (!Number.isInteger(maxMaps) || maxMaps < 1 || maxMaps > 1) problems.push('--max-maps-calls deve ser 1');
  if (!values['evidence-dir']) problems.push('falta --evidence-dir (pasta privada, fora do projeto, onde a resposta paga é gravada automaticamente)');
  if (!flags.has('ack-cost')) problems.push('falta --ack-cost (confirma que você conferiu no painel do Serper o saldo e os créditos cobrados por chamada do /maps)');
  if (problems.length > 0) {
    deps.err(`LIVE recusado: ${problems.join('; ')}.`);
    return 3;
  }

  // As travas GMN_LINK_AUDIT_* valem só se vierem do ambiente DESTE comando; valores vindos do .env.local são ignorados.
  const before = deps.getEnv();
  const gateEnv = { GMN_LINK_AUDIT_LIVE: before.GMN_LINK_AUDIT_LIVE, GMN_LINK_AUDIT_MAX_MAPS_CALLS: before.GMN_LINK_AUDIT_MAX_MAPS_CALLS, GMN_LINK_AUDIT_AUTH_ID: before.GMN_LINK_AUDIT_AUTH_ID };
  deps.loadEnv();
  const config = readRuntimeConfig({ ...deps.getEnv(), ...gateEnv });
  const gates: string[] = [];
  if (!config.live.enabled) gates.push('GMN_LINK_AUDIT_LIVE não está "on"');
  if (config.live.authorizationId === null || config.live.authorizationId !== authorizationId) gates.push('GMN_LINK_AUDIT_AUTH_ID ausente ou diferente de --authorization-id');
  if (config.live.maxMapsCalls < maxMaps) gates.push('GMN_LINK_AUDIT_MAX_MAPS_CALLS menor que o pedido');
  if (config.apiKey === null) gates.push('chave do Serper ausente ou inválida');
  try {
    assertSerperMapsUrl(config.mapsUrl);
  } catch {
    gates.push('SERPER_MAPS_URL inválida (somente https://*.serper.dev/maps)');
  }
  if (gates.length > 0) {
    deps.err(`LIVE recusado: ${gates.join('; ')}.`);
    deps.err(`Configuração (sem valores): ${JSON.stringify(describeRuntimeConfig(config))}`);
    return 3;
  }

  const minutes = Math.min(Math.max(1, Number(values['expires-in-minutes'] ?? '30') || 30), MAX_AUTHORIZATION_WINDOW_MS / 60_000);
  const authorization: ConsumptionAuthorization = {
    authorizationId: authorizationId as string,
    snapshotId,
    identifiersFingerprint: identifiersFingerprint(company.identifiers),
    maxMapsCalls: maxMaps,
    maxSiteHttpRequests: SITE_MAX_HTTP_REQUESTS,
    expiresAt: new Date(deps.now().getTime() + minutes * 60_000).toISOString(),
    costAcknowledged: true,
    operator,
  };

  const planned = await runLinkAuditCollection({ mode: 'DRY_RUN', input }, { now: deps.now });
  if (!asJson) print(deps, planned, false); // com --json a saída tem de ser UM único JSON
  const outcome = await runLinkAuditCollection(
    { mode: 'LIVE', input, authorization },
    {
      now: deps.now,
      liveEnabled: config.live.enabled,
      usedStore: deps.usedStore(),
      createLiveProviders: (hooks) => deps.createLiveProviders(config, hooks),
      // projectRoot fixo na raiz do projeto (não no diretório atual): a proibição de public/, src/ etc. vale de qualquer pasta.
      evidence: { baseDir: path.resolve(values['evidence-dir'] as string), projectRoot: path.resolve(__dirname, '..'), ...(config.apiKey ? { apiKey: config.apiKey } : {}), ...(deps.evidenceOptions ?? {}) },
    },
  );
  print(deps, outcome, asJson);
  return persistedExit(outcome, deps); // depois de consumida a autorização, nunca "recusado antes de qualquer chamada"
}

/** Código de saída de uma coleta que GRAVA (LIVE ou SIMULATED): 5 = resposta não totalmente persistida; 4 = relatório não gerado. */
function persistedExit(outcome: RunOutcome, deps: CliDeps): number {
  if (!outcome.ok) {
    if (outcome.persisted) {
      outcome.persisted.errors.forEach((error) => deps.err(`ATENÇÃO: ${redactUrlsInText(error)}`));
      return outcome.persisted.errors.length > 0 ? 5 : 4;
    }
    return outcome.code === 'PROVIDER_SETUP_FAILED' ? 4 : 3;
  }
  if (outcome.kind === 'REPORT' && outcome.persisted) {
    if (outcome.persisted.errors.length > 0) return 5;
    if (!outcome.persisted.storedReport) return 4;
  }
  return 0;
}

/**
 * SIMULATED gravado (ensaio da W5 em homologação, spec do P1 §5.7). A trava vem SÓ do ambiente deste comando: o arquivo de ambiente nunca é
 * lido aqui (nem a chave do Serper), nenhum provedor real é criado e o registro de autorizações não é tocado.
 */
async function runSimulated(values: Readonly<Record<string, string>>, flags: ReadonlySet<string>, deps: CliDeps): Promise<number> {
  const conflicts = NOT_IN_SIMULATED.filter((name) => flags.has(name) || values[name] !== undefined);
  if (conflicts.length > 0) {
    deps.err(`O modo SIMULATED (ensaio) não aceita ${conflicts.map((name) => `--${name}`).join(', ')}: link, empresa e identificadores são fixos e sintéticos, e não há consulta paga.`);
    USAGE.forEach(deps.err);
    return 1;
  }
  const operator = values.operator?.trim() ?? '';
  const auditId = values.audit ?? '';
  if (!EMAIL.test(operator) || !AUDIT_ID_PATTERN.test(auditId) || !values['evidence-dir']) {
    deps.err('No modo SIMULATED informe --audit <auditId> (8 a 64 caracteres: minúsculas, números, _ e -), --operator <e-mail> e --evidence-dir <pasta>.');
    USAGE.forEach(deps.err);
    return 1;
  }
  const env = deps.getEnv();
  if (!isHomologationLockOn(env)) {
    const production = env.NODE_ENV === 'production' ? ' NODE_ENV=production sem a trava de homologação.' : '';
    deps.err(`SIMULATED recusado: falta a trava de homologação (${HOMOLOGATION_LOCK_ENV}=1 no ambiente deste comando).${production} Nada foi gravado.`);
    return 3;
  }
  const asJson = flags.has('json');
  const stamp = deps.now().toISOString().replace(/\D/g, '').slice(0, 14);
  const input = simulatedCollectionInput({ operator, confirmedAt: deps.now().toISOString(), snapshotId: values['snapshot-id'] ?? `ensaio-${stamp}` });
  if (!asJson) deps.out(`${SIMULATED_LABEL}: coleta SINTÉTICA de homologação; nenhuma consulta foi feita e nada disto é evidência real.`);
  const outcome = await runLinkAuditCollection(
    { mode: 'SIMULATED', input, auditId },
    {
      now: deps.now,
      homologation: true,
      // projectRoot fixo na raiz do projeto, como no LIVE: a proibição de public/, src/ etc. vale de qualquer pasta
      evidence: { baseDir: path.resolve(values['evidence-dir'] as string), projectRoot: path.resolve(__dirname, '..'), ...(deps.evidenceOptions ?? {}) },
    },
  );
  print(deps, outcome, asJson);
  return persistedExit(outcome, deps);
}

function defaultDeps(): CliDeps {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    now: () => new Date(),
    loadEnv: () => {
      loadEnvConfig(process.cwd());
    },
    getEnv: () => process.env,
    usedStore: () => createFileUsedStore(defaultUsedAuthorizationDirectory(path.resolve(__dirname, '..'))),
    createLiveProviders: (config, hooks) => ({
      maps: createSerperMapsProvider({ apiKey: config.apiKey as string, url: config.mapsUrl, onCapture: hooks.onCapture }),
      site: createSiteProvider(),
    }),
  };
}

if (process.argv[1] && /link-audit-collect\.ts$/.test(process.argv[1])) {
  runCli(process.argv.slice(2), defaultDeps()).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`Falha inesperada: ${redactUrlsInText(error instanceof Error ? error.message : 'erro desconhecido')}`);
      process.exitCode = 4;
    },
  );
}
