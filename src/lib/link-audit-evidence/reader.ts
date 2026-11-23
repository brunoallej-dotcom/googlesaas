import path from 'node:path';
import { HASH_DISCLAIMER } from '../link-audit/snapshot';
import { nodeFsOps, errorCode, type FsOps } from '../link-audit/snapshot-store';
import { sanitizeForOutput } from '../link-audit/url-redaction';
import { AUDIT_ID_PATTERN } from './types';
import { readLegacyAudit } from './legacy';
import { isSimulatedCapture, SIMULATED_SOURCE_LABEL } from './simulated';
import { assertAllowedBase, listAuditFiles, locate, readCapture, readReport, verifyAudit, type AuditState } from './store';

/*
 * Leitor server-side das evidências para a futura interface (Onda 5A). NÃO existe endpoint: uma rota futura
 * deve autenticar com `requireOperator`, passar o e-mail como `actor` e injetar `authorize` (ex.: `isOperatorAllowed`).
 * Regras: toda leitura exige autorização; o corpo bruto do provedor NUNCA sai daqui (nem existe nos tipos de
 * visão); tudo passa por `sanitizeForOutput`; cada leitura verifica os hashes; nada é escrito.
 */

export interface EvidenceActor {
  readonly email: string;
}

/** A pasta da auditoria não existe ou não é um diretório comum (ex.: symlink): tratada como "não encontrada". */
class AuditNotFoundError extends Error {
  constructor() {
    super('Auditoria não encontrada.');
    this.name = 'AuditNotFoundError';
  }
}

export class EvidenceAccessError extends Error {
  readonly code = 'NOT_AUTHORIZED' as const;
  constructor() {
    super('Acesso às evidências não autorizado.');
    this.name = 'EvidenceAccessError';
  }
}

export type AuditLayout = 'VERSIONED' | 'LEGACY';
export type ViewState = AuditState | 'LEGACY';

export interface IntegrityInfo {
  readonly status: 'OK' | 'MISMATCH' | 'INCOMPLETE';
  readonly algorithm: 'SHA-256';
  readonly checkedFiles: number;
  readonly issues: readonly string[];
  /** Aviso fixo: o hash detecta alteração acidental; não é assinatura de autenticidade. */
  readonly note: string;
}

export interface AuditSummary {
  readonly auditId: string;
  readonly layout: AuditLayout;
  readonly state: ViewState;
  readonly company: { readonly name: string | null; readonly city: string | null; readonly stateCode: string | null };
  readonly confirmedCid: string | null;
  readonly located: string | null;
  readonly collectedAt: string | null;
  readonly captureCount: number;
  readonly reportRevisions: number;
  readonly integrity: IntegrityInfo;
  /** Coleta SIMULADA do ensaio (W5.2b, spec do P1 §5.7): presente só quando alguma captura tem a marca. */
  readonly simulated?: true;
}

export interface EvidenceItem {
  readonly id: string;
  readonly criterionId: string;
  readonly attribute: string;
  readonly claim: string;
  readonly status: string;
  readonly origin: string;
  readonly consultedAt: string | null;
  readonly limitation: string | null;
}

export interface VersionEntry {
  readonly capture: number | null;
  readonly collectedAt: string | null;
  readonly httpStatus: number | null;
  readonly reportRevisions: readonly { readonly revision: number; readonly generatedAt: string | null; readonly superseded: boolean }[];
}

/** Visão para a interface. Não contém corpo bruto, cabeçalhos, chaves nem caminhos do disco. */
export interface AuditView {
  readonly auditId: string;
  readonly layout: AuditLayout;
  readonly selected: { readonly capture: number | null; readonly revision: number };
  readonly state: ViewState;
  readonly company: AuditSummary['company'] & { readonly originalLink: string | null };
  readonly collectedAt: string | null;
  readonly methodologyVersion: string | null;
  readonly source: {
    readonly provider: string;
    readonly officialGoogleApi: false;
    readonly description: string | null;
    readonly httpStatus: number | null;
    readonly httpAttempts: number | null;
    readonly creditsReportedByApi: number | null;
    readonly resultCount: number | null;
  };
  readonly located: string | null;
  /** Coordenadas devolvidas pelo provedor (texto; nenhum mapa é carregado). */
  readonly location: { readonly latitude: number; readonly longitude: number } | null;
  readonly identifiers: unknown;
  readonly identityBasis: unknown;
  readonly data: { readonly googleMaps: unknown; readonly site: unknown };
  readonly evidences: { readonly verified: readonly EvidenceItem[]; readonly unverified: readonly EvidenceItem[]; readonly other: readonly EvidenceItem[] };
  readonly limitations: readonly string[];
  readonly divergences: unknown;
  readonly calls: unknown;
  readonly scoring: 'NOT_AVAILABLE_PENDING_D3';
  readonly integrity: IntegrityInfo;
  readonly versions: readonly VersionEntry[];
  /** Coleta SIMULADA do ensaio (W5.2b): presente só quando alguma captura tem a marca; a fonte vira "SIMULADA — ensaio". */
  readonly simulated?: true;
}

export interface EvidenceReaderOptions {
  readonly baseDir: string;
  readonly authorize: (actor: EvidenceActor) => boolean | Promise<boolean>;
  readonly fs?: FsOps;
  readonly projectRoot?: string;
  readonly maxAudits?: number;
}

const rec = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const strs = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

function integrity(status: IntegrityInfo['status'], checkedFiles: number, issues: readonly string[]): IntegrityInfo {
  return { status, algorithm: 'SHA-256', checkedFiles, issues, note: HASH_DISCLAIMER };
}

function items(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const e = rec(entry);
    return { id: str(e.id) ?? '', criterionId: str(e.criterionId) ?? '', attribute: str(e.attribute) ?? '', claim: str(e.claim) ?? '', status: str(e.status) ?? '', origin: str(e.origin) ?? '', consultedAt: str(e.consultedAt), limitation: str(e.limitation) };
  });
}

function locationOf(report: Record<string, unknown>): { latitude: number; longitude: number } | null {
  const result = rec(report.providerResult);
  const latitude = num(result.latitude);
  const longitude = num(result.longitude);
  return latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}

function companyOf(report: Record<string, unknown>): AuditSummary['company'] {
  const given = rec(rec(report.identity).operatorProvided);
  return { name: str(given.name), city: str(given.city), stateCode: str(given.stateCode) };
}

function confirmedCidOf(report: Record<string, unknown>): string | null {
  const confirmed = rec(report.identifiers).confirmed;
  if (!Array.isArray(confirmed)) return null;
  const cid = confirmed.map(rec).find((c) => c.type === 'cid');
  return cid ? str(cid.value) : null;
}

export function createEvidenceReader(options: EvidenceReaderOptions) {
  const ops = options.fs ?? nodeFsOps;
  const projectRoot = options.projectRoot ?? process.cwd();
  const storeOptions = { fs: ops, projectRoot };

  async function guard(actor: EvidenceActor): Promise<void> {
    let allowed = false;
    try {
      allowed = Boolean(actor && typeof actor.email === 'string' && actor.email.length > 0 && (await options.authorize(actor)));
    } catch {
      allowed = false; // falha fechada
    }
    if (!allowed) throw new EvidenceAccessError();
  }

  async function isLegacy(dir: string): Promise<boolean> {
    try {
      return (await ops.lstat(path.join(dir, 'MANIFEST.json'))).isFile();
    } catch {
      return false;
    }
  }

  /** Legado: delega a `legacy.ts` (a mesma verificação é usada pelo leitor de pontuação). */
  const readLegacy = (dir: string): ReturnType<typeof readLegacyAudit> => readLegacyAudit(ops, dir);

  /** Alguma captura da auditoria tem a marca SIMULADA (captura ilegível não decide nada aqui: a verificação de integridade já a trata). */
  async function hasSimulatedCapture(auditId: string, captures: readonly number[]): Promise<boolean> {
    for (const n of captures) {
      const capture = await readCapture(options.baseDir, auditId, n, storeOptions);
      if (capture.ok && isSimulatedCapture(capture.value)) return true;
    }
    return false;
  }

  function summarize(auditId: string, layout: AuditLayout, state: ViewState, report: Record<string, unknown> | null, counts: { captures: number; revisions: number }, info: IntegrityInfo, simulated = false): AuditSummary {
    // Conteúdo de arquivo que não confere nunca é exibido: só o estado e a integridade.
    const r = info.status === 'MISMATCH' ? {} : (report ?? {});
    return {
      auditId,
      layout,
      state,
      company: companyOf(r),
      confirmedCid: confirmedCidOf(r),
      located: str(r.located),
      collectedAt: str(rec(r.source).collectedAt),
      captureCount: counts.captures,
      reportRevisions: counts.revisions,
      integrity: info,
      ...(simulated ? { simulated: true as const } : {}),
    };
  }

  function buildView(params: {
    auditId: string;
    layout: AuditLayout;
    state: ViewState;
    capture: number | null;
    revision: number;
    report: Record<string, unknown>;
    methodologyVersion: string | null;
    info: IntegrityInfo;
    versions: VersionEntry[];
    simulated?: boolean;
  }): AuditView {
    const { report } = params;
    const source = rec(report.source);
    const evidences = items(report.evidences);
    const view: AuditView = {
      auditId: params.auditId,
      layout: params.layout,
      selected: { capture: params.capture, revision: params.revision },
      state: params.state,
      company: { ...companyOf(report), originalLink: str(rec(report.identity).originalLink) },
      collectedAt: str(source.collectedAt),
      methodologyVersion: params.methodologyVersion,
      source: {
        provider: params.simulated ? SIMULATED_SOURCE_LABEL : 'Serper /maps (intermediário; não é a API oficial do Google Business Profile)',
        officialGoogleApi: false,
        description: str(source.description),
        httpStatus: num(source.httpStatus),
        httpAttempts: num(source.httpAttempts),
        creditsReportedByApi: num(source.creditsReportedByApi),
        resultCount: num(source.resultCount),
      },
      located: str(report.located),
      location: locationOf(report),
      identifiers: report.identifiers ?? null,
      identityBasis: report.identityBasis ?? null,
      data: { googleMaps: rec(report.data).googleMaps ?? null, site: rec(report.data).site ?? null },
      evidences: {
        verified: evidences.filter((e) => e.status === 'VERIFIED'),
        unverified: evidences.filter((e) => e.status === 'NOT_VERIFIED'),
        other: evidences.filter((e) => e.status !== 'VERIFIED' && e.status !== 'NOT_VERIFIED'),
      },
      limitations: strs(report.limitations),
      divergences: report.divergences ?? [],
      calls: report.calls ?? null,
      scoring: 'NOT_AVAILABLE_PENDING_D3',
      integrity: params.info,
      versions: params.versions,
      ...(params.simulated ? { simulated: true as const } : {}),
    };
    return sanitizeForOutput(view) as AuditView;
  }

  async function auditDir(auditId: string): Promise<{ root: string; dir: string }> {
    const located = locate(options.baseDir, auditId, projectRoot);
    if (!located.ok) throw new Error(located.issues.join(' '));
    try {
      const info = await ops.lstat(located.value.dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new AuditNotFoundError();
    } catch (error) {
      if (error instanceof AuditNotFoundError) throw error;
      // pasta inexistente: os métodos tratam como "não encontrada"
    }
    return located.value;
  }

  async function versionsOf(auditId: string): Promise<VersionEntry[]> {
      let dir: string;
      try {
        ({ dir } = await auditDir(auditId));
      } catch (error) {
        if (error instanceof AuditNotFoundError) return [];
        throw error;
      }
      if (await isLegacy(dir)) {
        const legacy = await readLegacy(dir);
        if (legacy.integrity.status === 'MISMATCH') return []; // metadados de arquivo que não confere não são exibidos
        return sanitizeForOutput([
          {
            capture: 1,
            collectedAt: str(rec(legacy.reports[legacy.reports.length - 1]?.report?.source).collectedAt),
            httpStatus: num(legacy.status?.status),
            reportRevisions: legacy.reports.map((r) => ({ revision: r.revision, generatedAt: str(r.report?.generatedAt), superseded: r.superseded })),
          },
        ]) as VersionEntry[];
      }
      const listing = await listAuditFiles(ops, dir);
      if (!listing.ok) throw new AuditNotFoundError();
      const check = await verifyAudit(options.baseDir, auditId, storeOptions);
      if (check.ok && check.value.state === 'CORRUPT') return [];
      const versions: VersionEntry[] = [];
      for (const n of listing.value.captures) {
        const capture = await readCapture(options.baseDir, auditId, n, storeOptions);
        const revisions = listing.value.reports.filter((r) => r.capture === n);
        const entries: VersionEntry['reportRevisions'][number][] = [];
        for (const r of revisions) {
          const file = await readReport(options.baseDir, auditId, n, r.revision, storeOptions);
          entries.push({ revision: r.revision, generatedAt: file.ok ? file.value.generatedAt : null, superseded: r.revision < Math.max(...revisions.map((x) => x.revision)) });
        }
        versions.push({ capture: n, collectedAt: capture.ok ? capture.value.collectedAt : null, httpStatus: capture.ok ? capture.value.response.httpStatus : null, reportRevisions: entries });
      }
      return sanitizeForOutput(versions) as VersionEntry[];
  }

  return {
    /** Diagnóstico controlado do armazenamento (sem caminhos nem mensagens do sistema). */
    async storageStatus(actor: EvidenceActor): Promise<'READY' | 'MISSING' | 'DENIED' | 'FORBIDDEN' | 'ERROR'> {
      await guard(actor);
      if (!assertAllowedBase(options.baseDir, projectRoot).ok) return 'FORBIDDEN';
      try {
        await ops.readdir(path.resolve(options.baseDir));
        return 'READY';
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') return 'MISSING';
        if (code === 'EACCES' || code === 'EPERM') return 'DENIED';
        return 'ERROR';
      }
    },

    async listAudits(actor: EvidenceActor): Promise<AuditSummary[]> {
      await guard(actor);
      let names: string[] = [];
      try {
        names = await ops.readdir(path.resolve(options.baseDir));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return [];
        throw new Error('Não foi possível listar as auditorias armazenadas.');
      }
      const out: AuditSummary[] = [];
      for (const name of names.filter((n) => AUDIT_ID_PATTERN.test(n)).sort().slice(0, options.maxAudits ?? 100)) {
        let dir: string;
        try {
          ({ dir } = await auditDir(name));
          const info = await ops.lstat(dir);
          if (!info.isDirectory() || info.isSymbolicLink()) continue;
        } catch {
          continue; // symlink, arquivo ou pasta ilegível: ignorada, nunca derruba a lista
        }
        if (await isLegacy(dir)) {
          const legacy = await readLegacy(dir);
          const latest = [...legacy.reports].reverse().find((r) => r.report !== null)?.report ?? null;
          out.push(summarize(name, 'LEGACY', 'LEGACY', latest, { captures: 1, revisions: legacy.reports.length }, legacy.integrity));
          continue;
        }
        const verification = await verifyAudit(options.baseDir, name, storeOptions);
        if (!verification.ok) continue;
        const latestReport = verification.value.reports[verification.value.reports.length - 1];
        const report = latestReport && verification.value.state !== 'CORRUPT' ? await readReport(options.baseDir, name, latestReport.capture, latestReport.revision, storeOptions) : null;
        out.push(
          summarize(
            name,
            'VERSIONED',
            verification.value.state,
            report?.ok ? rec(report.value.report) : null,
            { captures: verification.value.captures.length, revisions: verification.value.reports.length },
            integrity(verification.value.state === 'CORRUPT' ? 'MISMATCH' : verification.value.state === 'COMPLETE' ? 'OK' : 'INCOMPLETE', verification.value.captures.length + verification.value.reports.length, verification.value.issues),
            verification.value.state !== 'CORRUPT' && (await hasSimulatedCapture(name, verification.value.captures)),
          ),
        );
      }
      return sanitizeForOutput(out) as AuditSummary[];
    },

    async listVersions(actor: EvidenceActor, auditId: string): Promise<VersionEntry[]> {
      await guard(actor);
      return versionsOf(auditId);
    },

    /** Estado e integridade SEM montar a visão (para explicar por que uma auditoria não pode ser exibida). */
    async getIntegrity(actor: EvidenceActor, auditId: string): Promise<{ state: ViewState; integrity: IntegrityInfo } | null> {
      await guard(actor);
      let dir: string;
      try {
        ({ dir } = await auditDir(auditId));
      } catch (error) {
        if (error instanceof AuditNotFoundError) return null;
        throw error;
      }
      if (await isLegacy(dir)) {
        const legacy = await readLegacy(dir);
        return { state: 'LEGACY', integrity: legacy.integrity };
      }
      const verification = await verifyAudit(options.baseDir, auditId, storeOptions);
      if (!verification.ok) return null;
      return {
        state: verification.value.state,
        integrity: integrity(verification.value.state === 'CORRUPT' ? 'MISMATCH' : verification.value.state === 'COMPLETE' ? 'OK' : 'INCOMPLETE', verification.value.captures.length + verification.value.reports.length, verification.value.issues),
      };
    },

    async getAudit(actor: EvidenceActor, auditId: string, select: { capture?: number; revision?: number } = {}): Promise<AuditView | null> {
      await guard(actor);
      let dir: string;
      try {
        ({ dir } = await auditDir(auditId));
      } catch (error) {
        if (error instanceof AuditNotFoundError) return null;
        throw error;
      }
      const versions = await versionsOf(auditId).catch(() => [] as VersionEntry[]);
      if (await isLegacy(dir)) {
        const legacy = await readLegacy(dir);
        const wanted = select.revision ?? Math.max(...legacy.reports.map((r) => r.revision));
        const chosen = legacy.reports.find((r) => r.revision === wanted && r.report !== null);
        if (!chosen || !chosen.report || legacy.integrity.status === 'MISMATCH') return null; // dados de arquivo que não confere não são exibidos
        return buildView({ auditId, layout: 'LEGACY', state: 'LEGACY', capture: 1, revision: chosen.revision, report: chosen.report, methodologyVersion: str(chosen.report.methodologyVersion), info: legacy.integrity, versions });
      }
      const verification = await verifyAudit(options.baseDir, auditId, storeOptions);
      if (!verification.ok || verification.value.state === 'CORRUPT') return null; // nada é exibido se QUALQUER arquivo da coleta não confere
      const reports = verification.value.reports.filter((r) => select.capture === undefined || r.capture === select.capture);
      const target = select.revision !== undefined ? reports.find((r) => r.revision === select.revision) : reports[reports.length - 1];
      if (!target) return null;
      const file = await readReport(options.baseDir, auditId, target.capture, target.revision, storeOptions);
      if (!file.ok) return null;
      return buildView({
        auditId,
        layout: 'VERSIONED',
        state: verification.value.state,
        capture: target.capture,
        revision: target.revision,
        report: rec(file.value.report),
        methodologyVersion: file.value.methodologyVersion,
        info: integrity(verification.value.state === 'COMPLETE' ? 'OK' : 'INCOMPLETE', verification.value.captures.length + verification.value.reports.length, verification.value.issues),
        versions,
        simulated: await hasSimulatedCapture(auditId, verification.value.captures),
      });
    },
  };
}

export type EvidenceReader = ReturnType<typeof createEvidenceReader>;
