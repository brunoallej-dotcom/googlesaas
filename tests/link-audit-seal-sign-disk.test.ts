import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nodeFsOps, type BytesFsOps } from '../src/lib/link-audit/snapshot-store';
import { candidatePackageSchema, CHECK_IDS, computePackageSha256, type Approval } from '../src/lib/link-audit-attestation';
import { serializePackage } from '../src/lib/link-audit-attestation/export-run';
import { approvalSchema } from '../src/lib/link-audit-attestation/schemas';
import { signSealManifest, type SealManifest } from '../src/lib/link-audit-attestation/sign-chain';
import { runSignCore } from '../src/lib/link-audit-attestation/sign-core';
import { MAX_APPROVAL_BYTES, MAX_DOSSIER_BYTES, MAX_PACKAGE_BYTES, MAX_RISK_ACCEPTANCE_BYTES, publishSeal, runSign, type SealWriteResult, type SignRunResult } from '../src/lib/link-audit-attestation/sign-run';
import { createSealedEvidenceProvenance, parseEvidenceSealV2Text, parseTrustKeyring, sealSha256, type TrustKeyring } from '../src/lib/link-audit-evidence/provenance';
import { errno, registerCleanup, tmpDir } from './helpers/link-audit-evidence-fixtures';
import {
  AUD,
  CONFIRM_LENGTH,
  custodianOf,
  DOSSIER,
  DOSSIER_ID,
  E1,
  E2,
  h,
  jsonBytes,
  KEY_ID,
  makeApproval,
  makePackage,
  NOW,
  planFor,
  RING,
  RISK_ACCEPTANCE,
  sha256,
  signDeps,
  signInput,
  TEMP_NAME,
  testKey,
  typing,
  writeStation,
  type Entries,
  type StationFiles,
} from './helpers/link-audit-seal-sign-disk-fixtures';

/*
 * P1 W4.3 — DISCO e CONCORRÊNCIA do `sign` (spec §5.5 preâmbulo e passo 15; §5.5.1 item 4; IA-12, IA-18; RS-04, RS-12). Leitura ÚNICA de `--package`,
 * `--approval` e `--dossier` pelo `FsOps` injetado (bytes exatos, sem seguir link, com limite) e gravação à prova de queda: temporário não secreto na
 * pasta da auditoria + fsync + `link()` exclusivo + remoção do temporário + fsync da pasta. Corridas REAIS (no `link()` do disco e entre processos).
 * Dados 100% FICTÍCIOS em pastas temporárias; a chave é a de TESTE `a` dos vetores-ouro, em memória. Sem CLI, TTY, chave real, recibo nem autoteste.
 * Revisão da W4.1: a confirmação humana (passo 11) é a porta injetada `confirm` (espião nas fixtures) e o aceite de risco é lido UMA vez, como as outras.
 */
registerCleanup();

const ROOT = path.join(__dirname, '..');
const REGISTER = path.join(ROOT, 'tests', 'register-typescript.cjs');
const CHILD = path.join(ROOT, 'tests', 'helpers', 'link-audit-seal-sign-disk-child.ts');
const KEYRING = parseTrustKeyring(RING) as TrustKeyring;
const WRITE_OPS: ReadonlySet<string> = new Set(['mkdir', 'writeExclusive', 'link', 'unlink', 'chmod', 'syncDirectory']);

type Written = Extract<SignRunResult, { readonly ok: true }>;
type Refusal = Extract<SignRunResult, { readonly ok: false }>;
type Call = { readonly op: string; readonly args: readonly unknown[] };

/** Estação nova: pasta com pacote, aprovação e dossiê + pasta de manifestos vazia (existente, como a cópia da estação). */
function world(files: Parameters<typeof writeStation>[1] = {}): { readonly station: StationFiles; readonly sealsDir: string } {
  return { station: writeStation(tmpDir('lasd-st-'), files), sealsDir: tmpDir('lasd-seals-') };
}
const real = (dir: string): string => fs.realpathSync(dir);
const sealPath = (sealsDir: string, seq = 1, auditId = AUD): string => path.join(sealsDir, auditId, `seal-${String(seq).padStart(4, '0')}.json`);
const listing = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const sealText = (seal: SealManifest): string => `${JSON.stringify(seal)}\n`;
const plainEntries = (entries: Entries): Array<{ ref: string; contentSha256: string }> => makePackage(entries).entries.map(({ ref, contentSha256 }) => ({ ref, contentSha256 }));

function written(result: SignRunResult | SealWriteResult): asserts result is Extract<SignRunResult | SealWriteResult, { readonly ok: true }> {
  if (!result.ok) assert.fail(`esperava gravação, veio ${result.code}: ${result.message}`);
}
function refused(result: SignRunResult | SealWriteResult, code: string, label = code): Refusal {
  assert.equal(result.ok ? 'GRAVOU' : result.code, code, label);
  if (result.ok) assert.fail(label);
  assert.ok(result.message.length > 0 && !result.message.includes(os.tmpdir()) && !result.message.includes('FICTÍCIO'), `${label}: mensagem sem caminho de disco nem conteúdo de arquivo`);
  return result as Refusal;
}
async function signed(input = signInput(writeStation(tmpDir('lasd-st-')), tmpDir('lasd-seals-')), deps = signDeps()): Promise<Written> {
  const result = await runSign(input, deps);
  written(result);
  return result as Written;
}
/** Manifesto v2 assinado com a chave de TESTE para o MESMO seq 1 (`variant` muda só o `sealedAt`). */
function sealOf(variant: number, auditId = AUD): SealManifest {
  const result = signSealManifest(planFor(variant, E1, auditId), KEY_ID, testKey());
  if (!result.ok) assert.fail(result.code);
  return result.seal;
}

/** O arquivo gravado é exatamente o texto do manifesto, que o parser estrito do verificador lê de volta e o verificador v2 real AUTENTICA. */
async function assertSealOnDisk(sealsDir: string, seal: SealManifest): Promise<void> {
  const bytes = fs.readFileSync(sealPath(sealsDir, seal.seq));
  assert.equal(bytes.toString('utf8'), sealText(seal));
  const parsed = parseEvidenceSealV2Text(bytes);
  assert.ok(parsed.ok && sealSha256(parsed.value) === sealSha256(seal), 'texto gravado = manifesto assinado');
  const evidences = seal.entries.map(({ ref, contentSha256 }) => ({ ref, contentSha256, legacy: false }));
  const verdict = await createSealedEvidenceProvenance({ sealsDir, keyring: KEYRING, acceptedVersions: [2] }).classify(AUD, evidences);
  assert.deepEqual(verdict, { status: 'AUTHENTICATED', headSeq: seal.seq, headSealSha256: sealSha256(seal), keyIds: [KEY_ID] });
}

/** Espião do `FsOps`: registra cada chamada (nome e argumentos) e delega ao disco real ou ao substituto. */
function spyFs(over: Partial<BytesFsOps> = {}): { readonly fs: BytesFsOps; readonly calls: Call[] } {
  const calls: Call[] = [];
  const base = { ...nodeFsOps, ...over } as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const proxy = Object.fromEntries(Object.keys(nodeFsOps).map((name) => [name, (...args: unknown[]) => (calls.push({ op: name, args }), (base[name] as (...a: unknown[]) => Promise<unknown>)(...args))]));
  return { fs: proxy as unknown as BytesFsOps, calls };
}
const writesOf = (calls: readonly Call[]): Call[] => calls.filter((call) => WRITE_OPS.has(call.op));
const tempsIn = (dir: string): string[] => listing(dir).filter((name) => name.startsWith('.'));

/* =============================================================================================================== IA-18 */

test('IA-18: --package, --approval e --dossier são lidos do disco UMA vez cada, pelo FsOps injetado (bytes exatos, com limite), e o manifesto gravado sai desses bytes (dossiê binário inclusive)', async () => {
  const { station, sealsDir } = world({ entries: E2 });
  const spy = spyFs();
  const deps = signDeps({ fs: spy.fs, confirm: custodianOf(makePackage(E2)) });
  const result = await signed(signInput(station, sealsDir), deps);
  assert.deepEqual(deps.order(), ['confirm', 'openKey'], 'confirmação humana uma vez, depois de todas as recusas; a chave depois dela');
  const inputs = new Set<unknown>(Object.values(station));
  const reads = spy.calls.filter((call) => (call.op === 'readFileBytes' || call.op === 'readFile') && inputs.has(call.args[0]));
  assert.deepEqual(
    reads.map((call) => [call.op, call.args[0], call.args[1]]),
    [
      ['readFileBytes', station.packagePath, MAX_PACKAGE_BYTES],
      ['readFileBytes', station.approvalPath, MAX_APPROVAL_BYTES],
      ['readFileBytes', station.dossierPath, MAX_DOSSIER_BYTES],
    ],
    'uma leitura de bytes por entrada, nesta ordem, nunca por readFile (texto)',
  );
  assert.equal(deps.keyCalls(), 1, 'a chave é aberta uma vez, depois de todas as recusas');
  const pkg = makePackage(E2);
  assert.deepEqual(result.seal.entries, plainEntries(E2), 'entries = exatamente as do pacote lido');
  assert.deepEqual(result.seal.dossier, { id: DOSSIER_ID, sha256: sha256(DOSSIER) }, 'hash dos BYTES do dossiê (não UTF-8)');
  assert.notEqual(sha256(DOSSIER), sha256(Buffer.from(DOSSIER.toString('utf8'), 'utf8')), 'o dossiê do teste muda de hash se decodificado como texto');
  assert.deepEqual([result.plan.packageSha256, result.seq, result.fileName, result.file], [pkg.packageSha256, 1, 'seal-0001.json', path.join(real(sealsDir), AUD, 'seal-0001.json')]);
  await assertSealOnDisk(sealsDir, result.seal);
});

test('IA-18: um fs que devolveria OUTROS bytes numa 2ª leitura (pacote, aprovação e dossiê válidos, mas outros) não altera o que é assinado: a 2ª leitura nunca acontece', async () => {
  const { station, sealsDir } = world({ entries: E1 });
  const otherPkg = makePackage(E2);
  const otherDossier = Buffer.from('outro dossiê', 'utf8');
  const second = new Map<string, Uint8Array>([
    [station.packagePath, jsonBytes(otherPkg)],
    [station.approvalPath, jsonBytes(makeApproval(otherPkg, otherDossier))],
    [station.dossierPath, otherDossier],
  ]);
  const count = new Map<string, number>();
  const twice: BytesFsOps = {
    ...nodeFsOps,
    readFileBytes: async (target, maxBytes) => {
      const n = (count.get(target) ?? 0) + 1;
      count.set(target, n);
      return n > 1 && second.has(target) ? (second.get(target) as Uint8Array) : nodeFsOps.readFileBytes(target, maxBytes);
    },
  };
  const result = await signed(signInput(station, sealsDir), signDeps({ fs: twice }));
  assert.deepEqual([...count.entries()], [[station.packagePath, 1], [station.approvalPath, 1], [station.dossierPath, 1]]);
  assert.deepEqual(result.seal.entries, plainEntries(E1));
  assert.deepEqual([result.plan.packageSha256, result.seal.dossier.sha256], [makePackage(E1).packageSha256, sha256(DOSSIER)]);
  await assertSealOnDisk(sealsDir, result.seal);
});

test('IA-18: mutar pacote, aprovação e dossiê ENTRE a leitura e a assinatura (no disco e no próprio buffer que o fs devolveu) não altera o que é assinado', async () => {
  const { station, sealsDir } = world({ entries: E1 });
  const handed: Uint8Array[] = [];
  let mutated = false;
  const mutateAll = (): void => {
    if (mutated || handed.length < 3) return;
    mutated = true;
    for (const bytes of handed) bytes.fill(0x20); // o buffer devolvido pela fonte vira lixo (só espaços)
    writeStation(path.dirname(station.packagePath), { entries: E2, dossier: Buffer.from('dossiê trocado', 'utf8') }); // e o disco também muda
  };
  const sneaky: BytesFsOps = {
    ...nodeFsOps,
    readFileBytes: async (target, maxBytes) => {
      const bytes = await nodeFsOps.readFileBytes(target, maxBytes);
      handed.push(bytes);
      return bytes;
    },
    // a cadeia é lida DEPOIS das três entradas: é a janela entre a leitura e a assinatura
    realpath: async (target) => (mutateAll(), nodeFsOps.realpath(target)),
  };
  const result = await signed(signInput(station, sealsDir), signDeps({ fs: sneaky }));
  assert.ok(mutated, 'a mutação aconteceu antes do núcleo');
  assert.deepEqual(result.seal.entries, plainEntries(E1));
  assert.deepEqual([result.plan.packageSha256, result.seal.dossier.sha256], [makePackage(E1).packageSha256, sha256(DOSSIER)]);
  await assertSealOnDisk(sealsDir, result.seal);
});

test('IA-18: trocar 1 byte do pacote depois da aprovação ⇒ recusa em TODA posição coberta pelo hash (núcleo, sobre os bytes lidos) e, pelo disco, numa amostra (nada gravado, chave não aberta); só generatedAt, fora do hash (§5.3), pode mudar sem mudar o que é assinado', async () => {
  const pkg = makePackage(E1);
  const approved = jsonBytes(pkg);
  const text = approved.toString('utf8');
  const generatedAt = [text.indexOf(pkg.generatedAt), text.indexOf(pkg.generatedAt) + pkg.generatedAt.length] as const;
  const outsideHash = (at: number): boolean => at >= generatedAt[0] && at < generatedAt[1];
  const flip = (at: number): Buffer => {
    const flipped = Buffer.from(approved);
    flipped[at] = (flipped[at] as number) ^ 0x01;
    return flipped;
  };
  const REFUSED = ['SIGN_PACKAGE_INVALID', 'SIGN_PACKAGE_MISMATCH', 'SIGN_AUDIT_MISMATCH'];
  // toda posição, pelo núcleo: é ele quem julga os bytes que a leitura única entrega (os testes acima provam que são esses bytes)
  const approvalBytes = jsonBytes(makeApproval(pkg));
  for (let at = 0; at < approved.length; at += 1) {
    let keyCalls = 0;
    const result = await runSignCore(
      { auditId: AUD, custodian: 'CUST-01', packageBytes: flip(at), approvalBytes, dossierBytes: DOSSIER, riskAcceptanceBytes: null, chain: { status: 'EMPTY' }, expectSeq: 1, first: true },
      { now: () => new Date(NOW), confirm: custodianOf(pkg), openKey: () => (keyCalls += 1) },
    );
    if (result.ok) {
      assert.ok(outsideHash(at), `posição ${at} (${JSON.stringify(text[at])}) foi aceita`);
      assert.deepEqual([result.plan.packageSha256, result.plan.entries], [pkg.packageSha256, plainEntries(E1)], 'fora do hash: o plano é o aprovado');
      continue;
    }
    assert.ok(REFUSED.includes(result.code), `posição ${at}: ${result.code}`);
    assert.equal(keyCalls, 0, `posição ${at}: chave aberta numa recusa`);
  }
  // amostra pelo sign inteiro, com o pacote lido do DISCO: recusa, nada gravado, chave não aberta
  const station = writeStation(tmpDir('lasd-1b-'), { pkg });
  let sealsDir = tmpDir('lasd-1b-seals-');
  const sample = [...Array.from({ length: approved.length }, (_, at) => at).filter((at) => at % 29 === 0), text.indexOf(pkg.packageSha256) + 63, text.indexOf('"capture:c0001"') + 10, generatedAt[0] + 3];
  for (const at of sample) {
    fs.writeFileSync(station.packagePath, flip(at));
    const deps = signDeps();
    const result = await runSign(signInput(station, sealsDir), deps);
    if (result.ok) {
      assert.ok(outsideHash(at), `posição ${at} foi assinada`);
      assert.deepEqual([result.plan.packageSha256, result.seal.entries], [pkg.packageSha256, plainEntries(E1)]);
      sealsDir = tmpDir('lasd-1b-seals-');
      continue;
    }
    assert.ok(REFUSED.includes(result.code), `posição ${at}: ${result.code}`);
    assert.equal(deps.keyCalls(), 0);
    assert.deepEqual(listing(sealsDir), [], `posição ${at}: algo foi gravado`);
  }
});

test('IA-18: entrada que é link simbólico, diretório, FIFO, inexistente ou acima do limite ⇒ SIGN_INPUT_UNREADABLE (nomeia o argumento, sem caminho), sem seguir o link nem travar; nada gravado e a chave não é aberta', async () => {
  const cases: ReadonlyArray<readonly [string, (station: StationFiles) => void, string]> = [
    ['pacote por link simbólico (para um pacote válido)', (s) => (fs.renameSync(s.packagePath, `${s.packagePath}.real`), fs.symlinkSync(`${s.packagePath}.real`, s.packagePath)), '--package'],
    ['aprovação por link simbólico', (s) => (fs.renameSync(s.approvalPath, `${s.approvalPath}.real`), fs.symlinkSync(`${s.approvalPath}.real`, s.approvalPath)), '--approval'],
    ['aprovação é diretório', (s) => (fs.rmSync(s.approvalPath), fs.mkdirSync(s.approvalPath)), '--approval'],
    ['dossiê inexistente', (s) => fs.rmSync(s.dossierPath), '--dossier'],
    ['dossiê é FIFO', (s) => (fs.rmSync(s.dossierPath), execFileSync('mkfifo', [s.dossierPath])), '--dossier'],
    ['pacote acima do limite', (s) => fs.truncateSync(s.packagePath, MAX_PACKAGE_BYTES + 1), '--package'],
    ['aprovação acima do limite', (s) => fs.truncateSync(s.approvalPath, MAX_APPROVAL_BYTES + 1), '--approval'],
    ['dossiê acima do limite', (s) => fs.truncateSync(s.dossierPath, MAX_DOSSIER_BYTES + 1), '--dossier'],
  ];
  for (const [label, damage, argument] of cases) {
    const { station, sealsDir } = world();
    damage(station);
    const deps = signDeps();
    const started = Date.now();
    const refusal = refused(await runSign(signInput(station, sealsDir), deps), 'SIGN_INPUT_UNREADABLE', label);
    assert.ok(refusal.message.includes(argument), `${label}: a mensagem nomeia ${argument}`);
    assert.ok(Date.now() - started < 10_000, `${label}: não travou`);
    assert.equal(deps.keyCalls(), 0, label);
    assert.deepEqual(listing(sealsDir), [], label);
  }
});

test('IA-18: os limites de leitura cobrem com folga o maior pacote e a maior aprovação válidos (2000 entradas, delta cheio, textos no máximo, caracteres de 3 bytes)', () => {
  const refs = [...Array.from({ length: 1000 }, (_, i) => `capture:c${String(i + 1).padStart(4, '0')}`), ...Array.from({ length: 1000 }, (_, i) => `report:c${String(i + 1).padStart(4, '0')}-r0001`)];
  const entries = refs.map((ref) => ({ ref, contentSha256: h('f'), legacy: false }));
  const wide = '漢'.repeat(200);
  const body = {
    schemaVersion: 1 as const,
    kind: 'LINK_AUDIT_P1_CANDIDATE' as const,
    auditId: AUD,
    layout: 'VERSIONED' as const,
    attestable: true,
    summary: { company: { name: wide, city: wide, stateCode: 'GO' }, firstCollectedAt: '2026-11-18T09:00:00.000Z', lastCollectedAt: '2026-11-18T09:00:00.000Z', captures: 1000, reportRevisions: 1000, artifacts: 0, containsLegacy: false },
    integrity: { status: 'OK' as const, algorithm: 'SHA-256' as const, checkedFiles: 2000 },
    checks: CHECK_IDS.map((id) => ({ id, status: 'NOT_EXECUTED' as const })),
    gap: { maxHours: 8760, observedHours: 8760, justification: '漢'.repeat(280) },
    entries,
  };
  const biggest = candidatePackageSchema.parse({ ...body, delta: { added: refs, changed: refs, missing: refs }, packageSha256: computePackageSha256(body), generatedAt: '2026-11-18T13:00:00.000Z' });
  const packageBytes = Buffer.byteLength(serializePackage(biggest), 'utf8');
  assert.ok(packageBytes * 2 < MAX_PACKAGE_BYTES, `maior pacote ${packageBytes} B: folga de 2× sob ${MAX_PACKAGE_BYTES} B`);
  const pkg = makePackage(E1);
  const approval: Approval = approvalSchema.parse({
    ...makeApproval(pkg),
    approvedBy: '漢'.repeat(64),
    operator: '字'.repeat(64),
    humanChecks: (['AUTHORIZATION_CONSUMED', 'PROVIDER_PANEL_CREDITS', 'URL_QUERY_COHERENCE', 'REPORT_REPRODUCES'] as const).map((id) => ({ id, result: 'PASS' as const, note: '漢'.repeat(280) })),
    riskAcceptance: { id: '漢'.repeat(64), sha256: h('e') },
  });
  const approvalBytes = jsonBytes(approval).byteLength;
  assert.ok(approvalBytes * 4 < MAX_APPROVAL_BYTES, `maior aprovação ${approvalBytes} B: folga de 4× sob ${MAX_APPROVAL_BYTES} B`);
});

test('RS-04 / IA-02 (5): o sign só toca os arquivos de entrada (três, ou quatro com o aceite de risco) e a pasta de manifestos (fs que falha em qualquer outro caminho) e só escreve em <seals-dir>/<auditId>/', async () => {
  const pkg = makePackage(E1);
  const withRisk = { pkg, approval: { ...makeApproval(pkg), riskAcceptance: { id: 'aceite-disco-0001', sha256: sha256(RISK_ACCEPTANCE) } }, riskAcceptance: RISK_ACCEPTANCE };
  for (const [files, custodian] of [[{}, 'CUST-01'], [withRisk, 'CONF-01']] as const) {
    await onlyAllowedPaths(world(files), custodian);
  }
});

async function onlyAllowedPaths({ station, sealsDir }: ReturnType<typeof world>, custodian: string): Promise<void> {
  const root = real(sealsDir);
  const inputs = new Set<string>(Object.values(station));
  const inside = (target: string): boolean => inputs.has(target) || target === sealsDir || target === root || target.startsWith(root + path.sep);
  const touched: string[] = [];
  const guarded = Object.fromEntries(
    Object.entries(nodeFsOps).map(([name, impl]) => [
      name,
      (...args: unknown[]) => {
        const paths = (name === 'link' ? args.slice(0, 2) : args.slice(0, 1)) as string[];
        for (const target of paths) {
          touched.push(`${name}:${target}`);
          if (!inside(target)) throw Object.assign(new Error('caminho fora do permitido (RS-04)'), { code: 'EACCES' });
        }
        return (impl as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    ]),
  ) as unknown as BytesFsOps;
  const result = await signed(signInput(station, sealsDir, { custodian }), signDeps({ fs: guarded }));
  const dir = path.join(root, AUD);
  for (const entry of touched.filter((item) => WRITE_OPS.has(item.slice(0, item.indexOf(':'))))) {
    const target = entry.slice(entry.indexOf(':') + 1);
    assert.ok(target === dir || target === root || target.startsWith(dir + path.sep), `escrita fora de <seals-dir>/<auditId>/: ${entry}`);
  }
  if (station.riskAcceptancePath) assert.ok(touched.includes(`readFileBytes:${station.riskAcceptancePath}`) && result.plan.roleException, 'o aceite de risco foi lido e valeu');
  await assertSealOnDisk(sealsDir, result.seal);
}

/* =============================================================================================================== IA-12 */

test('IA-12 (§5.5.1 item 4): grava por temporário .seal-NNNN.json.tmp-<aleatório> NA pasta da auditoria (criada se ausente) + fsync + link() exclusivo + remoção do temporário + fsync da pasta, nesta ordem', async () => {
  const { station, sealsDir } = world();
  const spy = spyFs();
  const result = await signed(signInput(station, sealsDir), signDeps({ fs: spy.fs }));
  const root = real(sealsDir);
  const dir = path.join(root, AUD);
  const final = path.join(dir, 'seal-0001.json');
  const writes = writesOf(spy.calls);
  const temp = writes[2]?.args[0] as string;
  assert.ok(typeof temp === 'string' && path.dirname(temp) === dir && TEMP_NAME.test(path.basename(temp)), `temporário na pasta da auditoria: ${temp}`);
  assert.deepEqual(
    writes.map((call) => [call.op, ...call.args.filter((_arg, index) => !(call.op === 'writeExclusive' && index === 1))]),
    [
      ['mkdir', dir],
      ['syncDirectory', root], // a subpasta nova também é durável
      ['writeExclusive', temp, 0o444], // FsOps.writeExclusive: criação exclusiva + escrita + fsync do arquivo
      ['link', temp, final],
      ['unlink', temp],
      ['syncDirectory', dir],
    ],
  );
  assert.equal(writes[2]?.args[1], sealText(result.seal), 'o temporário recebe exatamente o texto do manifesto');
  assert.equal(result.file, final);
  assert.equal(fs.statSync(final).mode & 0o777, 0o444, 'somente leitura');
  assert.deepEqual(listing(dir), ['seal-0001.json'], 'nenhum temporário sobra');
  await assertSealOnDisk(sealsDir, result.seal);
  // subpasta já existente: nada de mkdir nem de fsync da raiz; outro temporário (aleatório)
  const again = spyFs();
  const second = await signed(signInput(writeStation(tmpDir('lasd-st-'), { entries: E2 }), sealsDir, { expectSeq: 2, first: false }), signDeps({ fs: again.fs, now: () => new Date(Date.parse(NOW) + 60_000), confirm: custodianOf(makePackage(E2)) }));
  const secondWrites = writesOf(again.calls);
  assert.deepEqual(secondWrites.map((call) => call.op), ['writeExclusive', 'link', 'unlink', 'syncDirectory']);
  assert.notEqual(secondWrites[0]?.args[0], temp);
  assert.ok(TEMP_NAME.test(path.basename(secondWrites[0]?.args[0] as string)) && (secondWrites[0]?.args[0] as string).includes('.seal-0002.json.tmp-'));
  assert.equal(second.seq, 2);
});

test('IA-12: com o FsOps de disco real, o temporário recebe fsync (FileHandle.sync) ANTES do link(), e a pasta da auditoria DEPOIS da remoção do temporário', async () => {
  type Open = typeof import('node:fs/promises').open;
  const promises = require('node:fs/promises') as { open: Open };
  const original = promises.open;
  const events: string[] = [];
  promises.open = (async (...args: Parameters<Open>) => {
    const handle = await original(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => (events.push(`sync:${path.basename(String(args[0]))}`), sync());
    return handle;
  }) as Open;
  let result: Written;
  try {
    const observed: BytesFsOps = {
      ...nodeFsOps,
      link: async (from, to) => (events.push(`link:${path.basename(to)}`), nodeFsOps.link(from, to)),
      unlink: async (target) => (events.push(`unlink:${path.basename(target)}`), nodeFsOps.unlink(target)),
    };
    result = await signed(signInput(writeStation(tmpDir('lasd-st-')), tmpDir('lasd-seals-')), signDeps({ fs: observed }));
  } finally {
    promises.open = original;
  }
  const temp = events.find((event) => event.startsWith('sync:.seal-0001.json.tmp-'))?.slice('sync:'.length) ?? '';
  assert.ok(TEMP_NAME.test(temp), `fsync do temporário: ${events.join(' ')}`);
  const at = (event: string): number => events.indexOf(event);
  assert.ok(at(`sync:${temp}`) < at('link:seal-0001.json') && at('link:seal-0001.json') < at(`unlink:${temp}`) && at(`unlink:${temp}`) < at(`sync:${AUD}`), events.join(' '));
  assert.equal(result.seq, 1);
});

test('IA-12: a subpasta <seals-dir>/<auditId>/ deriva só do --audit validado; link simbólico, arquivo, --seals-dir ausente, auditId fora do padrão ou manifesto de outra auditoria ⇒ recusa, sem seguir o link e sem criar nada', async () => {
  const seal = sealOf(0);
  const symlinked = tmpDir('lasd-w-');
  const elsewhere = tmpDir('lasd-alvo-');
  fs.symlinkSync(elsewhere, path.join(symlinked, AUD));
  refused(await publishSeal(nodeFsOps, { sealsDir: symlinked, auditId: AUD, seal }), 'SIGN_WRITE_FAILED', 'subpasta é link simbólico');
  assert.deepEqual(listing(elsewhere), [], 'o link não foi seguido');

  const asFile = tmpDir('lasd-w-');
  fs.writeFileSync(path.join(asFile, AUD), 'não é pasta');
  refused(await publishSeal(nodeFsOps, { sealsDir: asFile, auditId: AUD, seal }), 'SIGN_WRITE_FAILED', 'subpasta é arquivo');
  assert.equal(fs.readFileSync(path.join(asFile, AUD), 'utf8'), 'não é pasta');

  const missing = path.join(tmpDir('lasd-w-'), 'nao-existe');
  refused(await publishSeal(nodeFsOps, { sealsDir: missing, auditId: AUD, seal }), 'SIGN_WRITE_FAILED', '--seals-dir ausente');
  assert.equal(fs.existsSync(missing), false, '--seals-dir nunca é recriado');

  const clean = tmpDir('lasd-w-');
  for (const bad of ['../fora-da-pasta', 'Auditoria-Maiuscula', 'curto', `${AUD}/sub`, `${AUD}\u0000`]) {
    refused(await publishSeal(nodeFsOps, { sealsDir: clean, auditId: bad, seal }), 'USAGE', `auditId ${JSON.stringify(bad)}`);
  }
  refused(await publishSeal(nodeFsOps, { sealsDir: clean, auditId: AUD, seal: sealOf(0, 'auditoria-disco-sign-02') }), 'UNEXPECTED', 'manifesto de outra auditoria');
  assert.deepEqual(listing(clean), [], 'nada criado (nem subpasta)');
  assert.deepEqual(listing(path.dirname(clean)).filter((name) => name === 'fora-da-pasta'), []);

  // --seals-dir por link simbólico (a cópia da estação): o sign fixa a raiz REAL uma vez, lê a cadeia e grava nela, na subpasta do --audit
  const realRoot = tmpDir('lasd-raiz-');
  const viaLink = path.join(tmpDir('lasd-w-'), 'manifestos');
  fs.symlinkSync(realRoot, viaLink);
  refused(await publishSeal(nodeFsOps, { sealsDir: viaLink, auditId: AUD, seal }), 'SIGN_WRITE_FAILED', 'a gravação só aceita a raiz pelo caminho real');
  assert.deepEqual(listing(realRoot), []);
  // e trocar o link DEPOIS de fixada a raiz (entre a leitura da cadeia e a gravação) não desvia a gravação para outra pasta
  const decoy = tmpDir('lasd-isca-');
  let swapped = false;
  const swapping: BytesFsOps = {
    ...nodeFsOps,
    readdir: async (dir) => {
      if (!swapped) {
        swapped = true;
        fs.unlinkSync(viaLink);
        fs.symlinkSync(decoy, viaLink);
      }
      return nodeFsOps.readdir(dir);
    },
  };
  fs.mkdirSync(path.join(realRoot, AUD)); // a cadeia é listada (readdir) antes da gravação
  const result = await runSign(signInput(writeStation(tmpDir('lasd-st-')), viaLink), signDeps({ fs: swapping }));
  written(result);
  assert.ok(swapped, 'o link mudou no meio');
  assert.deepEqual([result.file, result.seq, result.fileName], [path.join(real(realRoot), AUD, 'seal-0001.json'), 1, 'seal-0001.json']);
  assert.deepEqual(listing(decoy), [], 'nada foi para a pasta nova do link');
  await assertSealOnDisk(realRoot, result.seal);
});

test('IA-12: seal-NNNN.json que já existe nunca é alterado ⇒ SIGN_SEQ_CONFLICT (bytes, modo e inode iguais; link simbólico no lugar não é seguido) e o temporário é removido', async () => {
  // (a) outro processo grava o mesmo seq entre a leitura da cadeia e o link() deste
  const { station, sealsDir } = world();
  const intruder = '{"intruso":"fictício"}\n';
  let inode = -1;
  const late: BytesFsOps = {
    ...nodeFsOps,
    link: async (from, to) => {
      fs.writeFileSync(to, intruder, { flag: 'wx', mode: 0o444 });
      inode = fs.statSync(to).ino;
      return nodeFsOps.link(from, to);
    },
  };
  const deps = signDeps({ fs: late });
  refused(await runSign(signInput(station, sealsDir), deps), 'SIGN_SEQ_CONFLICT');
  const final = sealPath(sealsDir);
  assert.deepEqual([fs.readFileSync(final, 'utf8'), fs.statSync(final).ino, fs.statSync(final).mode & 0o777], [intruder, inode, 0o444]);
  assert.deepEqual(listing(path.join(sealsDir, AUD)), ['seal-0001.json'], 'temporário removido');

  // (b) link simbólico pendente no lugar do manifesto: link() não o segue
  const dangling = tmpDir('lasd-w-');
  fs.mkdirSync(path.join(dangling, AUD));
  const target = path.join(tmpDir('lasd-alvo-'), 'alvo.json');
  fs.symlinkSync(target, sealPath(dangling));
  refused(await publishSeal(nodeFsOps, { sealsDir: dangling, auditId: AUD, seal: sealOf(1) }), 'SIGN_SEQ_CONFLICT');
  assert.equal(fs.existsSync(target), false, 'o alvo do link nunca é criado');
  assert.ok(fs.lstatSync(sealPath(dangling)).isSymbolicLink());
  assert.deepEqual(tempsIn(path.join(dangling, AUD)), []);

  // (c) publicar de novo sobre um manifesto gravado (mesmo seq, outro conteúdo) ⇒ conflito; o gravado fica idêntico
  const kept = tmpDir('lasd-w-');
  const first = sealOf(2);
  written(await publishSeal(nodeFsOps, { sealsDir: kept, auditId: AUD, seal: first }));
  const before = fs.statSync(sealPath(kept));
  refused(await publishSeal(nodeFsOps, { sealsDir: kept, auditId: AUD, seal: sealOf(3) }), 'SIGN_SEQ_CONFLICT');
  refused(await publishSeal(nodeFsOps, { sealsDir: kept, auditId: AUD, seal: first }), 'SIGN_SEQ_CONFLICT', 'nem o mesmo manifesto é regravado');
  assert.deepEqual([fs.statSync(sealPath(kept)).ino, fs.statSync(sealPath(kept)).mtimeMs], [before.ino, before.mtimeMs]);
  await assertSealOnDisk(kept, first);
  assert.deepEqual(listing(path.join(kept, AUD)), ['seal-0001.json']);
});

test('IA-12: falha de gravação ou de sync nunca vira sucesso; antes do link() nada fica (nem o temporário), depois do link() o manifesto nunca é apagado', async () => {
  type Fault = { readonly name: string; readonly fs: (dir: () => string) => Partial<BytesFsOps>; readonly code: string; readonly final: boolean; readonly temp: boolean; readonly suffix?: string; readonly setup?: (dir: string) => void };
  const partial = (keep: (data: string) => string, code: string) => async (target: string, data: string, mode?: number): Promise<void> => {
    fs.writeFileSync(target, keep(data), { flag: 'wx', mode: mode ?? 0o600 });
    throw errno(code);
  };
  const faults: readonly Fault[] = [
    { name: 'escrita do temporário falha no meio (EIO com parte gravada)', fs: () => ({ writeExclusive: partial((data) => data.slice(0, 10), 'EIO') }), code: 'SIGN_WRITE_FAILED', final: false, temp: false },
    { name: 'fsync do temporário falha (EIO com tudo gravado)', fs: () => ({ writeExclusive: partial((data) => data, 'EIO') }), code: 'SIGN_WRITE_FAILED', final: false, temp: false },
    { name: 'sem espaço antes de criar o temporário (ENOSPC)', fs: () => ({ writeExclusive: async () => { throw errno('ENOSPC'); } }), code: 'SIGN_WRITE_FAILED', final: false, temp: false },
    ...['EIO', 'EPERM', 'EXDEV', 'ENOSYS', 'ENOTSUP', 'EROFS'].map((errnoCode) => ({ name: `link() falha com ${errnoCode} (sem recurso a escrita direta não atômica)`, fs: () => ({ link: async () => { throw errno(errnoCode); } }), code: 'SIGN_WRITE_FAILED', final: false, temp: false })),
    { name: 'link() falha e a limpeza do temporário também', fs: () => ({ link: async () => { throw errno('EIO'); }, unlink: async () => { throw errno('EIO'); } }), code: 'SIGN_WRITE_FAILED', final: false, temp: true },
    { name: 'criação da subpasta falha (EACCES)', fs: () => ({ mkdir: async () => { throw errno('EACCES'); } }), code: 'SIGN_WRITE_FAILED', final: false, temp: false },
    { name: 'fsync da raiz depois de criar a subpasta falha', fs: (dir) => ({ syncDirectory: async (target) => { if (target !== dir()) throw errno('EIO'); return nodeFsOps.syncDirectory(target); } }), code: 'SIGN_WRITE_FAILED', final: false, temp: false },
    { name: 'temporário com o mesmo nome já existe (não é deste processo: não é apagado)', fs: () => ({}), suffix: 'ab'.repeat(16), setup: (dir) => (fs.mkdirSync(dir), fs.writeFileSync(path.join(dir, `.seal-0001.json.tmp-${'ab'.repeat(16)}`), 'de outro processo')), code: 'SIGN_WRITE_FAILED', final: false, temp: true },
    { name: 'remoção do temporário falha depois do link()', fs: () => ({ unlink: async () => { throw errno('EIO'); } }), code: 'SIGN_WRITE_UNCONFIRMED', final: true, temp: true },
    { name: 'fsync da pasta da auditoria falha depois do link()', fs: (dir) => ({ syncDirectory: async (target) => { if (target === dir()) throw errno('EIO'); return nodeFsOps.syncDirectory(target); } }), code: 'SIGN_WRITE_UNCONFIRMED', final: true, temp: false },
  ];
  for (const fault of faults) {
    const sealsDir = tmpDir('lasd-f-');
    const dir = path.join(real(sealsDir), AUD);
    fault.setup?.(dir);
    const seal = sealOf(4);
    const result = await publishSeal({ ...nodeFsOps, ...fault.fs(() => dir) }, { sealsDir, auditId: AUD, seal }, fault.suffix ? { tempSuffix: () => fault.suffix as string } : {});
    refused(result, fault.code, fault.name);
    assert.equal(fs.existsSync(sealPath(sealsDir)), fault.final, `${fault.name}: manifesto ${fault.final ? 'mantido' : 'ausente'}`);
    if (fault.final) assert.equal(fs.readFileSync(sealPath(sealsDir), 'utf8'), sealText(seal), `${fault.name}: o manifesto ligado nunca é apagado nem alterado`);
    assert.equal(tempsIn(dir).length > 0, fault.temp, `${fault.name}: temporário ${fault.temp ? 'restante' : 'removido'} (${tempsIn(dir).join(',')})`);
    if (fault.setup) assert.equal(fs.readFileSync(path.join(dir, `.seal-0001.json.tmp-${'ab'.repeat(16)}`), 'utf8'), 'de outro processo');
  }
  // pela orquestração: a falha do fsync da pasta também nunca vira sucesso
  const { station, sealsDir } = world();
  const failing: BytesFsOps = { ...nodeFsOps, syncDirectory: async (target) => { if (target.endsWith(AUD)) throw errno('EIO'); return nodeFsOps.syncDirectory(target); } };
  refused(await runSign(signInput(station, sealsDir), signDeps({ fs: failing })), 'SIGN_WRITE_UNCONFIRMED');
  // sufixo do temporário fora de forma (não hexadecimal) nunca vira caminho
  const odd = tmpDir('lasd-f-');
  refused(await publishSeal(nodeFsOps, { sealsDir: odd, auditId: AUD, seal: sealOf(5) }, { tempSuffix: () => '../../fora' }), 'UNEXPECTED');
  assert.deepEqual(listing(odd), []);
});

test('§7.1 / IA-12: manifesto com mais de 2000 entradas ou acima de 256 KiB ⇒ SIGN_TOO_MANY_ENTRIES antes de tocar o disco (nem a subpasta é criada)', async () => {
  const seal = sealOf(6);
  const many = { ...seal, entries: Array.from({ length: 2001 }, (_, i) => ({ ref: `capture:c${String(i + 1).padStart(4, '0')}`, contentSha256: h('a') })) };
  const huge = { ...seal, signature: 'A'.repeat(256 * 1024) };
  for (const [label, forged] of [['2001 entradas', many], ['> 256 KiB', huge]] as const) {
    const sealsDir = tmpDir('lasd-big-');
    const spy = spyFs();
    refused(await publishSeal(spy.fs, { sealsDir, auditId: AUD, seal: forged as SealManifest }), 'SIGN_TOO_MANY_ENTRIES', label);
    assert.deepEqual(writesOf(spy.calls), [], label);
    assert.deepEqual(listing(sealsDir), [], label);
  }
});

test('IA-12: corrida REAL pelo link() no mesmo processo: 8 gravações simultâneas do MESMO seq ⇒ exatamente uma grava, as demais SIGN_SEQ_CONFLICT; o arquivo é o do vencedor e nenhum temporário sobra', async () => {
  const sealsDir = tmpDir('lasd-race-');
  const seals = Array.from({ length: 8 }, (_, i) => sealOf(10 + i));
  const results = await Promise.all(seals.map((seal) => publishSeal(nodeFsOps, { sealsDir, auditId: AUD, seal })));
  const winners = results.flatMap((result, index) => (result.ok ? [index] : []));
  assert.equal(winners.length, 1, `vencedores: ${winners.join(',')}`);
  for (const result of results) if (!result.ok) assert.equal(result.code, 'SIGN_SEQ_CONFLICT');
  await assertSealOnDisk(sealsDir, seals[winners[0] as number] as SealManifest);
  assert.deepEqual(listing(path.join(sealsDir, AUD)), ['seal-0001.json']);
});

/** O executor de testes injeta NODE_TEST_CONTEXT nos filhos: o filho é um programa comum, sem isso. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}
type ChildOutcome = { readonly ok: boolean; readonly code?: string; readonly seq?: number; readonly sealedAt?: string };
function runChild(payload: Record<string, unknown>): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--require', REGISTER, CHILD, JSON.stringify(payload)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
    proc.on('error', reject);
    proc.on('close', (_code, signal) => {
      clearTimeout(timer);
      const line = out.split('\n').find((candidate) => candidate.startsWith('{"ok":'));
      resolve(line ? (JSON.parse(line) as ChildOutcome) : { ok: false, code: signal ? `KILLED_${signal}` : `NO_OUTPUT:${err.slice(0, 300)}` });
    });
  });
}
const PROCESSES = 4;
/** Largada sincronizada: a partida de cada filho (transpilar o TypeScript) leva segundos; todos esperam o mesmo instante. */
const startAt = (): number => Date.now() + 6000;

test('IA-12: corrida entre PROCESSOS só pela gravação: 4 processos publicam o MESMO seq ao mesmo tempo ⇒ exatamente um grava, os demais SIGN_SEQ_CONFLICT (link() exclusivo)', { timeout: 180_000 }, async () => {
  const sealsDir = tmpDir('lasd-proc-');
  const at = startAt();
  const outcomes = await Promise.all(Array.from({ length: PROCESSES }, (_, variant) => runChild({ mode: 'publish', startAt: at, sealsDir, variant: 100 + variant })));
  const winners = outcomes.filter((outcome) => outcome.ok);
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.deepEqual(outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.code), Array.from({ length: PROCESSES - 1 }, () => 'SIGN_SEQ_CONFLICT'), JSON.stringify(outcomes));
  const onDisk = JSON.parse(fs.readFileSync(sealPath(sealsDir), 'utf8')) as SealManifest;
  assert.equal(onDisk.sealedAt, winners[0]?.sealedAt, 'o arquivo é o do vencedor');
  await assertSealOnDisk(sealsDir, onDisk);
  assert.deepEqual(listing(path.join(sealsDir, AUD)), ['seal-0001.json'], 'nenhum temporário sobra');
});

test('IA-12: corrida entre PROCESSOS pelo sign inteiro (leitura única → cadeia → assinatura → gravação) com o MESMO --expect-seq ⇒ exatamente um grava; os demais SIGN_SEQ_CONFLICT ou SIGN_SEQ_MISMATCH', { timeout: 180_000 }, async () => {
  const { station, sealsDir } = world();
  const at = startAt();
  const outcomes = await Promise.all(Array.from({ length: PROCESSES }, (_, variant) => runChild({ mode: 'run', startAt: at, sealsDir, variant, input: signInput(station, sealsDir) })));
  const winners = outcomes.filter((outcome) => outcome.ok);
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  for (const outcome of outcomes.filter((item) => !item.ok)) assert.ok(outcome.code === 'SIGN_SEQ_CONFLICT' || outcome.code === 'SIGN_SEQ_MISMATCH', JSON.stringify(outcomes));
  const onDisk = JSON.parse(fs.readFileSync(sealPath(sealsDir), 'utf8')) as SealManifest;
  assert.equal(onDisk.sealedAt, winners[0]?.sealedAt);
  await assertSealOnDisk(sealsDir, onDisk);
  assert.deepEqual(listing(path.join(sealsDir, AUD)), ['seal-0001.json']);
});

test('IA-12: o manifesto gravado é a cabeça do próximo sign (seq 2, prev = sealSha256 do gravado); o temporário de uma queda anterior é ignorado e nunca tocado; seal-0001 fica idêntico', async () => {
  const { station, sealsDir } = world({ entries: E1 });
  const first = await signed(signInput(station, sealsDir));
  const firstBytes = fs.readFileSync(sealPath(sealsDir));
  const crashTemp = path.join(sealsDir, AUD, `.seal-0002.json.tmp-${'cd'.repeat(16)}`);
  fs.writeFileSync(crashTemp, 'parcial de uma queda');
  const second = await signed(signInput(writeStation(tmpDir('lasd-st-'), { entries: E2 }), sealsDir, { expectSeq: 2, first: false }), signDeps({ now: () => new Date(Date.parse(NOW) + 60_000), confirm: custodianOf(makePackage(E2)) }));
  assert.deepEqual([second.seq, second.seal.prevSealSha256, second.seal.entries], [2, sealSha256(first.seal), plainEntries(E2)]);
  assert.equal(fs.readFileSync(crashTemp, 'utf8'), 'parcial de uma queda');
  assert.deepEqual(fs.readFileSync(sealPath(sealsDir)), firstBytes);
  assert.deepEqual(listing(path.join(sealsDir, AUD)), [path.basename(crashTemp), 'seal-0001.json', 'seal-0002.json']);
  await assertSealOnDisk(sealsDir, second.seal);
});

test('recusas do núcleo e da cadeia (passos 1–10) não escrevem nada (nem temporário nem subpasta) e não abrem a chave', async () => {
  const { station, sealsDir } = world();
  const otherDossier = writeStation(tmpDir('lasd-st-'), { dossier: Buffer.from('outro dossiê', 'utf8') });
  const cases: ReadonlyArray<readonly [string, ReturnType<typeof signInput>, string, string?]> = [
    ['--expect-seq 2 com a pasta vazia', signInput(station, sealsDir, { expectSeq: 2, first: false }), 'SIGN_SEAL_CHAIN_INVALID'],
    ['--audit de outra auditoria', signInput(station, sealsDir, { auditId: 'auditoria-disco-sign-02' }), 'SIGN_AUDIT_MISMATCH'],
    ['dossiê que não é o aprovado', signInput({ ...station, dossierPath: otherDossier.dossierPath }, sealsDir), 'SIGN_DOSSIER_MISMATCH'],
    ['relógio antes da coleta', signInput(station, sealsDir), 'SIGN_CLOCK_REGRESSION', '2026-11-18T08:59:59.999Z'],
    ['--audit fora do padrão', signInput(station, sealsDir, { auditId: '../fora-da-pasta' }), 'USAGE'],
  ];
  for (const [label, input, code, now] of cases) {
    const spy = spyFs();
    const deps = signDeps({ fs: spy.fs, ...(now ? { now: () => new Date(now) } : {}) });
    refused(await runSign(input, deps), code, label);
    assert.deepEqual(writesOf(spy.calls), [], label);
    assert.equal(deps.keyCalls(), 0, label);
    assert.deepEqual(listing(sealsDir), [], label);
  }
});

/* =============================================================================================================== revisão da W4.1: passos 9 e 11 no disco */

test('passo 11 no disco (revisão da W4.1): confirmação errada ou porta que falha ⇒ SIGN_CONFIRMATION_FAILED; nenhum arquivo gravado, nem temporário nem subpasta, e a chave não é aberta', async () => {
  const right = makePackage(E1).packageSha256.slice(0, CONFIRM_LENGTH);
  const wrong = [typing(right.toUpperCase()), typing(right.slice(1)), typing(`${right}\n`), typing(makePackage(E2).packageSha256.slice(0, CONFIRM_LENGTH)), async (): Promise<string> => Promise.reject(new Error('sem TTY'))];
  for (const [index, confirm] of wrong.entries()) {
    const { station, sealsDir } = world();
    const spy = spyFs();
    const deps = signDeps({ fs: spy.fs, confirm });
    refused(await runSign(signInput(station, sealsDir), deps), 'SIGN_CONFIRMATION_FAILED', `caso ${index}`);
    assert.deepEqual(deps.order(), ['confirm'], `caso ${index}: confirmação perguntada uma vez, chave não aberta`);
    assert.deepEqual(writesOf(spy.calls), [], `caso ${index}: nenhuma escrita (nem mkdir, temporário, link ou fsync)`);
    assert.deepEqual(listing(sealsDir), [], `caso ${index}: nem a subpasta da auditoria`);
  }
  // com cadeia: a pasta da auditoria já existe e fica byte a byte igual (nenhum temporário)
  const { station, sealsDir } = world({ entries: E1 });
  await signed(signInput(station, sealsDir));
  const dir = path.join(sealsDir, AUD);
  const before = listing(dir).map((name) => [name, sha256(fs.readFileSync(path.join(dir, name)))]);
  const next = writeStation(tmpDir('lasd-st-'), { entries: E2 });
  const deps = signDeps({ confirm: custodianOf(makePackage(E1)), now: () => new Date(Date.parse(NOW) + 60_000) });
  refused(await runSign(signInput(next, sealsDir, { expectSeq: 2, first: false }), deps), 'SIGN_CONFIRMATION_FAILED', 'digitou o hash do pacote ANTERIOR');
  assert.equal(deps.keyCalls(), 0);
  assert.deepEqual(listing(dir).map((name) => [name, sha256(fs.readFileSync(path.join(dir, name)))]), before);
  assert.deepEqual(tempsIn(dir), []);
});

test('passo 9 no disco (revisão da W4.1): o arquivo do aceite de risco é lido UMA vez, depois do dossiê, pelo FsOps injetado e com limite; com os papéis coincidindo, vale só com o hash citado', async () => {
  const pkg = makePackage(E1);
  const approval = { ...makeApproval(pkg), riskAcceptance: { id: 'aceite-disco-0001', sha256: sha256(RISK_ACCEPTANCE) } };
  const { station, sealsDir } = world({ pkg, approval, riskAcceptance: RISK_ACCEPTANCE });
  const spy = spyFs();
  const result = await signed(signInput(station, sealsDir, { custodian: 'conf 01' }), signDeps({ fs: spy.fs }));
  const inputs = new Set<unknown>(Object.values(station));
  assert.deepEqual(
    spy.calls.filter((call) => (call.op === 'readFileBytes' || call.op === 'readFile') && inputs.has(call.args[0])).map((call) => [call.op, call.args[0], call.args[1]]),
    [
      ['readFileBytes', station.packagePath, MAX_PACKAGE_BYTES],
      ['readFileBytes', station.approvalPath, MAX_APPROVAL_BYTES],
      ['readFileBytes', station.dossierPath, MAX_DOSSIER_BYTES],
      ['readFileBytes', station.riskAcceptancePath, MAX_RISK_ACCEPTANCE_BYTES],
    ],
  );
  assert.deepEqual([result.plan.roleException, result.plan.requiresLaterReview], [true, true]);
  // aceite citado, mas o arquivo é outro, ou não foi indicado ⇒ SIGN_ROLE_SEPARATION, nada gravado
  const other = world({ pkg, approval, riskAcceptance: Buffer.concat([RISK_ACCEPTANCE, Buffer.from('x')]) });
  const missing = world({ pkg, approval });
  for (const [label, scenario] of [['outro arquivo', other], ['sem --risk-acceptance', missing]] as const) {
    const deps = signDeps();
    refused(await runSign(signInput(scenario.station, scenario.sealsDir, { custodian: 'CONF-01' }), deps), 'SIGN_ROLE_SEPARATION', label);
    assert.deepEqual([deps.confirmCalls(), deps.keyCalls(), listing(scenario.sealsDir)], [0, 0, []], label);
  }
});

test('passo 9 no disco: --risk-acceptance que é link, diretório, inexistente ou acima do limite ⇒ SIGN_INPUT_UNREADABLE (nomeia o argumento, sem caminho), mesmo com papéis distintos; nada gravado', async () => {
  const cases: ReadonlyArray<readonly [string, (file: string) => void]> = [
    ['link simbólico', (file) => (fs.renameSync(file, `${file}.real`), fs.symlinkSync(`${file}.real`, file))],
    ['diretório', (file) => (fs.rmSync(file), fs.mkdirSync(file))],
    ['inexistente', (file) => fs.rmSync(file)],
    ['acima do limite', (file) => fs.truncateSync(file, MAX_RISK_ACCEPTANCE_BYTES + 1)],
  ];
  for (const [label, damage] of cases) {
    const { station, sealsDir } = world({ riskAcceptance: RISK_ACCEPTANCE });
    damage(station.riskAcceptancePath as string);
    const deps = signDeps();
    const refusal = refused(await runSign(signInput(station, sealsDir), deps), 'SIGN_INPUT_UNREADABLE', label);
    assert.ok(refusal.message.includes('--risk-acceptance'), `${label}: a mensagem nomeia o argumento`);
    assert.deepEqual([deps.confirmCalls(), deps.keyCalls(), listing(sealsDir)], [0, 0, []], label);
  }
});
