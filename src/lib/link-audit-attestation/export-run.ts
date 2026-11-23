import path from 'node:path';
import { z } from 'zod';
import { errorCode, nodeFsOps, type FsOps } from '../link-audit/snapshot-store';
import { MAX_SEAL_BYTES, SEAL_FILE, SEAL_KIND } from '../link-audit-evidence/provenance';
import { createEvidenceReader } from '../link-audit-evidence/reader';
import { createScoringBasisReader } from '../link-audit-evidence/scoring-basis';
import { assertAllowedBase } from '../link-audit-evidence/store';
import { basisIsSimulated, buildCandidatePackage, computeDelta, refuse, type CandidateDelta, type CandidateInput, type ExportRefusal } from './export';
import { candidatePackageSchema, entryRef, MAX_PACKAGE_ENTRIES, type CandidatePackage } from './schemas';

/*
 * P1 W2 — adaptador de DISCO do `export` (spec §5.3): resolve as pastas, lê a evidência SÓ pelos leitores existentes (base de pontuação e
 * leitor de evidências, com `FsOps` injetado e abertura `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`), monta o pacote pela função pura e grava, no máximo,
 * o arquivo `--out` (criação exclusiva, 0600, fora da pasta de evidências por caminho real). Nunca escreve na pasta de evidências, nunca apaga
 * nada, sem rede, sem ambiente, sem Supabase. O instante vem de quem chama.
 */
export type { FsOps };

/** O leitor exige autorização: no CLI local e offline não há sessão (spec §10); nunca `requireOperator`/Supabase. */
const LOCAL_ACTOR = { email: 'p1-export-local' } as const;
const allowLocal = (): boolean => true;

export interface ExportOptions {
  readonly evidenceDir: string;
  readonly auditId: string;
  readonly collectorHashes: ReadonlyMap<number, string>;
  readonly maxGapHours: number | null;
  readonly gapJustification: string | null;
  readonly sealsDir: string | null;
  readonly out: string | null;
  /** Raiz do projeto: a pasta de evidências não pode estar em `public/`, `src/`, `.next/` nem `node_modules/` dela. */
  readonly projectRoot: string;
  readonly now: () => Date;
  /** `--simulated` (W5.2b, spec §5.7): afirma que a auditoria é a coleta SIMULADA do ensaio. */
  readonly allowSimulated?: boolean;
  /** Trava de homologação lida pelo CLI; ausente = desligada. A montagem pura a confere de novo (segunda camada). */
  readonly homologationLock?: boolean;
}
export interface ExportDeps {
  /** Leitura das evidências e dos manifestos (nunca escreve). */
  readonly fs?: FsOps;
  /** Só para o `--out`. */
  readonly outFs?: FsOps;
}
export type DeltaStatus = 'NOT_REQUESTED' | 'NO_SEALS' | 'COMPUTED' | 'UNREADABLE';
export type ExportOutcome = { readonly ok: true; readonly package: CandidatePackage; readonly deltaStatus: DeltaStatus; readonly output: 'FILE' | 'STDOUT'; readonly simulated: boolean } | ExportRefusal;

/** Bytes exatos do arquivo do pacote (e da saída padrão, quando não há `--out`). */
export const serializePackage = (pkg: CandidatePackage): string => `${JSON.stringify(pkg, null, 2)}\n`;

const OUT_UNSAFE = refuse('EXPORT_OUT_UNSAFE', '--out tem de ser um arquivo NOVO, numa pasta existente, fora da pasta de evidências e fora da árvore do projeto (o pacote tem nome/cidade/UF). Nada foi gravado.');
const OUT_WRITE_FAILED = refuse(
  'EXPORT_OUT_WRITE_FAILED',
  'Falha ao gravar o pacote em --out (sem espaço, erro de disco, permissão ou um arquivo surgiu no mesmo caminho durante a gravação). Pode ter ficado um arquivo parcial no caminho informado em --out: ele NÃO é um pacote válido; confira e apague-o antes de exportar de novo (o export nunca apaga nada).',
);
const FORBIDDEN_BASE = refuse('USAGE', 'A pasta de evidências não pode ficar na área pública ou de código do projeto.');
const BASE_NOT_FOUND = refuse('EXPORT_NOT_FOUND', 'Pasta de evidências não encontrada ou não é um diretório.');

export async function exportCandidatePackage(options: ExportOptions, deps: ExportDeps = {}): Promise<ExportOutcome> {
  const fs = deps.fs ?? nodeFsOps;
  const outFs = deps.outFs ?? nodeFsOps;
  const base = await resolveEvidenceDir(fs, options.evidenceDir, options.projectRoot);
  if (!base.ok) return base;
  const target = options.out === null ? null : await checkOutTarget(outFs, options.out, base.real, options.projectRoot);
  if (target !== null && !target.ok) return target;
  const facts = await readEvidence(fs, base.real, options);
  if (!facts.ok) return facts;
  const built = buildCandidatePackage({ ...facts.value, auditId: options.auditId, collectorHashes: options.collectorHashes, maxGapHours: options.maxGapHours, gapJustification: options.gapJustification, now: options.now(), allowSimulated: options.allowSimulated === true, homologationLock: options.homologationLock === true });
  if (!built.ok) return built;
  const delta = options.sealsDir === null ? { status: 'NOT_REQUESTED' as const, delta: null } : await readDelta(fs, options.sealsDir, options.auditId, built.package.entries);
  const pkg = candidatePackageSchema.parse({ ...built.package, delta: delta.delta });
  if (target !== null) {
    const written = await writeOut(outFs, target.value, serializePackage(pkg));
    if (written !== null) return written;
  }
  return { ok: true, package: pkg, deltaStatus: delta.status, output: target === null ? 'STDOUT' : 'FILE', simulated: basisIsSimulated(facts.value.basis) };
}

async function resolveEvidenceDir(fs: FsOps, dir: string, projectRoot: string): Promise<{ readonly ok: true; readonly real: string } | ExportRefusal> {
  const allowed = assertAllowedBase(dir, projectRoot);
  if (!allowed.ok) return FORBIDDEN_BASE;
  let real: string;
  try {
    real = await fs.realpath(allowed.value);
    if (!(await fs.lstat(real)).isDirectory()) return BASE_NOT_FOUND;
  } catch {
    return BASE_NOT_FOUND;
  }
  // de novo pelo caminho REAL: um link simbólico não leva a pasta para dentro do projeto
  return assertAllowedBase(real, projectRoot).ok ? { ok: true, real } : FORBIDDEN_BASE;
}

interface OutTarget {
  readonly file: string;
  /** Caminho pedido, sem resolver links: também não pode cair numa área proibida (ex.: link em `public/` apontando para fora). */
  readonly lexical: string;
  readonly requestedParent: string;
  readonly parentReal: string;
  readonly evidenceReal: string;
  readonly projectRoot: string;
}

/** Inclusão por prefixo, sem diferenciar caixa (drvfs/Windows ignoram a caixa): na dúvida, recusa. */
const isInside = (candidate: string, root: string): boolean => {
  const c = candidate.toLowerCase();
  const r = root.toLowerCase();
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};

/** Destino proibido para o pacote: a própria raiz ou qualquer descendente de uma das raízes (pasta de evidências, árvore do projeto). */
export const isForbiddenOutPath = (file: string, roots: readonly string[]): boolean => roots.some((root) => isInside(file, root));

/** Raízes proibidas para o `--out`, pelo caminho informado e pelo REAL (a árvore do projeto inteira: o pacote tem nome/cidade/UF). */
async function forbiddenRoots(outFs: FsOps, evidenceReal: string, projectRoot: string): Promise<string[]> {
  const project = path.resolve(projectRoot);
  const roots = [evidenceReal, project];
  try {
    roots.push(await outFs.realpath(project));
  } catch {
    // projeto inexistente: vale a regra pelo caminho informado
  }
  return roots;
}

async function checkOutTarget(outFs: FsOps, out: string, evidenceReal: string, projectRoot: string): Promise<{ readonly ok: true; readonly value: OutTarget } | ExportRefusal> {
  const resolved = path.resolve(out);
  try {
    await outFs.lstat(resolved);
    return OUT_UNSAFE; // já existe (arquivo, pasta ou link, mesmo quebrado): nada é sobrescrito
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return OUT_UNSAFE;
  }
  const requestedParent = path.dirname(resolved);
  let parentReal: string;
  try {
    parentReal = await outFs.realpath(requestedParent);
    if (!(await outFs.lstat(parentReal)).isDirectory()) return OUT_UNSAFE;
  } catch {
    return OUT_UNSAFE;
  }
  const file = path.join(parentReal, path.basename(resolved));
  const roots = await forbiddenRoots(outFs, evidenceReal, projectRoot);
  if (isForbiddenOutPath(file, roots) || isForbiddenOutPath(resolved, roots)) return OUT_UNSAFE;
  return { ok: true, value: { file, lexical: resolved, requestedParent, parentReal, evidenceReal, projectRoot } };
}

/**
 * Reconfere o destino IMEDIATAMENTE antes de gravar (TOCTOU: a pasta pode ter virado link para as evidências ou o projeto) e grava pelo
 * caminho REAL conferido, com criação exclusiva (`wx`, 0600). Nunca sobrescreve nem apaga: falha depois da criação deixa o parcial e avisa.
 */
async function writeOut(outFs: FsOps, target: OutTarget, data: string): Promise<ExportRefusal | null> {
  let freshParent: string;
  let roots: string[];
  try {
    freshParent = await outFs.realpath(target.requestedParent);
    roots = [...new Set([...(await forbiddenRoots(outFs, target.evidenceReal, target.projectRoot)), target.evidenceReal, path.resolve(target.projectRoot)])];
  } catch {
    return OUT_UNSAFE;
  }
  const freshFile = path.join(freshParent, path.basename(target.file));
  if (freshParent !== target.parentReal || [freshFile, target.file, target.lexical].some((file) => isForbiddenOutPath(file, roots))) return OUT_UNSAFE;
  try {
    await outFs.writeExclusive(target.file, data);
    return null;
  } catch {
    return OUT_WRITE_FAILED;
  }
}

async function readEvidence(fs: FsOps, baseReal: string, options: ExportOptions): Promise<{ readonly ok: true; readonly value: Pick<CandidateInput, 'basis' | 'captureFacts' | 'company'> } | ExportRefusal> {
  const readerOptions = { baseDir: baseReal, authorize: allowLocal, fs, projectRoot: options.projectRoot };
  const outcome = await createScoringBasisReader(readerOptions).readScoringBasis(LOCAL_ACTOR, options.auditId);
  if (outcome.status === 'NOT_FOUND') return refuse('EXPORT_NOT_FOUND', 'Auditoria não encontrada, ou a pasta dela não é um diretório comum (link simbólico?).');
  if (outcome.status !== 'READY') return refuse('EXPORT_INTEGRITY_NOT_OK', 'A integridade local não está OK (arquivo alterado, ausente, especial ou grande demais, ou coleta incompleta). Nada foi exportado.');
  // status HTTP e collectedAt por captura e nome/cidade/UF informados pelo operador: o que o leitor de evidências JÁ expõe (não é ampliado)
  const view = await createEvidenceReader(readerOptions).getAudit(LOCAL_ACTOR, options.auditId);
  if (view === null) return refuse('EXPORT_INTEGRITY_NOT_OK', 'A pasta mudou entre as leituras ou não pôde ser relida. Nada foi exportado.');
  return {
    ok: true,
    value: {
      basis: outcome.basis,
      captureFacts: view.versions.map((v) => ({ capture: v.capture, collectedAt: v.collectedAt, httpStatus: v.httpStatus })),
      company: { name: view.company.name, city: view.company.city, stateCode: view.company.stateCode },
    },
  };
}

/** Só o que o delta usa; a assinatura NÃO é conferida aqui (informativo, não decide nada: spec §5.3). Aceita `v1` e o futuro `v2`. */
const sealForDeltaSchema = z.object({
  kind: z.literal(SEAL_KIND),
  auditId: z.string(),
  seq: z.number().int(),
  entries: z.array(z.object({ ref: entryRef, contentSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).min(1).max(MAX_PACKAGE_ENTRIES),
});

async function readDelta(fs: FsOps, sealsDir: string, auditId: string, entries: CandidatePackage['entries']): Promise<{ readonly status: DeltaStatus; readonly delta: CandidateDelta | null }> {
  const unreadable = { status: 'UNREADABLE' as const, delta: null };
  const noSeals = { status: 'NO_SEALS' as const, delta: computeDelta(entries, []) };
  let dir: string;
  try {
    const root = await fs.realpath(path.resolve(sealsDir));
    if (!(await fs.lstat(root)).isDirectory()) return unreadable;
    dir = path.join(root, auditId);
  } catch {
    return unreadable; // pasta de manifestos inexistente não é "nenhum manifesto" (provável erro de digitação)
  }
  let names: string[];
  try {
    const info = await fs.lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return unreadable;
    names = await fs.readdir(dir);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? noSeals : unreadable;
  }
  const seals = names.flatMap((name) => {
    const match = SEAL_FILE.exec(name);
    return match ? [{ name, seq: Number(match[1]) }] : [];
  });
  if (seals.length === 0) return noSeals;
  const latest = seals.reduce((best, item) => (item.seq > best.seq ? item : best));
  try {
    const parsed = sealForDeltaSchema.safeParse(JSON.parse(await fs.readFile(path.join(dir, latest.name), MAX_SEAL_BYTES)));
    if (!parsed.success || parsed.data.auditId !== auditId || parsed.data.seq !== latest.seq) return unreadable;
    return { status: 'COMPUTED', delta: computeDelta(entries, parsed.data.entries) };
  } catch {
    return unreadable;
  }
}
