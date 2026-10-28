import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as store from '../src/lib/link-audit/snapshot-store';
import {
  cleanupOrphanTempFiles,
  defaultLinkAuditDirectory,
  freezeSnapshot,
  listSnapshotVersions,
  nodeFsOps,
  readLatestSnapshot,
  readSnapshot,
  verifySnapshotChain,
  type FsOps,
} from '../src/lib/link-audit/snapshot-store';
import {
  clone,
  directDraft,
  FID,
  FID_OTHER,
  SNAPSHOT_ID,
  T_FROZEN_LATER,
  type Mutable,
} from './helpers/link-audit-fixtures';

/* Dados fictícios, gravados em diretórios temporários. Nenhuma pasta de histórico é tocada. */

async function tempBase(t: test.TestContext): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'link-audit-store-'));
  t.after(() => removeTree(base));
  return base;
}

async function removeTree(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await removeTree(full);
    else if (entry.isFile()) await fs.chmod(full, 0o644).catch(() => undefined); // nunca segue symlinks
  }
  await fs.rm(dir, { recursive: true, force: true });
}

async function names(dir: string): Promise<string[]> {
  return (await fs.readdir(dir).catch(() => [])).sort();
}

const sha = async (file: string): Promise<string> => createHash('sha256').update(await fs.readFile(file)).digest('hex');

function nextDraft(): Mutable {
  const draft = directDraft({ frozenAt: T_FROZEN_LATER });
  draft.limitations = [...draft.limitations, 'Revisão posterior: nenhuma novidade (fictício).'];
  return draft;
}

function ops(overrides: Partial<FsOps>): FsOps {
  return { ...nodeFsOps, ...overrides };
}

const SIMULATED = (message: string, code?: string): Error => Object.assign(new Error(message), code ? { code } : {});

test('primeira versão: grava em <base>/<id>/v0001.json, relê verificada e fica somente leitura', async (t) => {
  const base = await tempBase(t);
  const draft = directDraft();
  const frozen = await freezeSnapshot(base, draft, { expectedPreviousVersion: null });
  assert.ok(frozen.ok, frozen.ok ? '' : frozen.issues.join(' | '));
  assert.equal(frozen.value.version, 1);
  assert.equal(frozen.value.filePath, path.join(base, SNAPSHOT_ID, 'v0001.json'));
  assert.deepEqual(await names(path.join(base, SNAPSHOT_ID)), ['v0001.json'], 'sem temporários sobrando');

  const mode = (await fs.stat(frozen.value.filePath)).mode & 0o777;
  assert.equal(mode & 0o222, 0, 'o arquivo fechado não deve ser gravável');

  const latest = await readLatestSnapshot(base, SNAPSHOT_ID);
  assert.ok(latest.ok);
  assert.deepEqual(latest.value, frozen.value.snapshot);
  assert.deepEqual(latest.value.content.evidences, draft.evidences, 'fontes nativas e externas preservadas');
  assert.deepEqual(latest.value.content.identity, draft.identity, 'identidade confirmada preservada');
  assert.deepEqual(latest.value.content.link, draft.link);
});

test('nova versão é um arquivo novo, encadeado ao hash anterior; a versão antiga não muda um byte', async (t) => {
  const base = await tempBase(t);
  const first = await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null });
  assert.ok(first.ok);
  const v1Before = await sha(first.value.filePath);

  const second = await freezeSnapshot(base, nextDraft(), { expectedPreviousVersion: 1 });
  assert.ok(second.ok, second.ok ? '' : second.issues.join(' | '));
  assert.equal(second.value.version, 2);
  assert.deepEqual(second.value.snapshot.content.previous, { version: 1, hash: first.value.snapshot.hash.value });
  assert.equal(await sha(first.value.filePath), v1Before, 'v0001.json permanece idêntico');
  assert.deepEqual(await names(path.join(base, SNAPSHOT_ID)), ['v0001.json', 'v0002.json']);

  const chain = await verifySnapshotChain(base, SNAPSHOT_ID);
  assert.ok(chain.ok);
  assert.deepEqual(chain.value.map((s) => s.content.version), [1, 2]);
  const latest = await readLatestSnapshot(base, SNAPSHOT_ID);
  assert.ok(latest.ok && latest.value.content.version === 2);
  const old = await readSnapshot(base, SNAPSHOT_ID, 1);
  assert.ok(old.ok && old.value.hash.value === first.value.snapshot.hash.value);
});

test('não existe como editar um snapshot fechado: repetir a versão é conflito e nada é sobrescrito', async (t) => {
  const base = await tempBase(t);
  const first = await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null });
  assert.ok(first.ok);
  const before = await sha(first.value.filePath);

  for (const expected of [null, 0, 2, 5]) {
    const again = await freezeSnapshot(base, nextDraft(), { expectedPreviousVersion: expected });
    assert.ok(!again.ok && again.code === 'CONFLICT', `esperado ${String(expected)}`);
  }
  assert.equal(await sha(first.value.filePath), before);
  assert.deepEqual(await names(path.join(base, SNAPSHOT_ID)), ['v0001.json']);

  const forbiddenApi = Object.keys(store).filter((name) => /update|edit|overwrite|replace|delete|remove|patch/i.test(name));
  assert.deepEqual(forbiddenApi, [], 'o armazenamento não pode expor operação de edição');
});

test('duas gravações simultâneas da mesma versão: exatamente uma vence', async (t) => {
  const base = await tempBase(t);
  const results = await Promise.all([
    freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null }),
    freezeSnapshot(base, directDraft({ frozenAt: T_FROZEN_LATER }), { expectedPreviousVersion: null }),
    freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.deepEqual(
    results.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.code)),
    ['CONFLICT', 'CONFLICT'],
  );
  assert.deepEqual(await names(path.join(base, SNAPSHOT_ID)), ['v0001.json']);
});

test('uma nova versão não pode trocar a empresa nem voltar no tempo', async (t) => {
  const base = await tempBase(t);
  assert.ok((await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null })).ok);

  const otherLink = `https://www.google.com/maps/place/Outra/data=!1s${FID_OTHER}`;
  const otherCompany = nextDraft();
  otherCompany.link.originalLink = otherLink;
  otherCompany.identity.originalLink = otherLink;
  otherCompany.identity.identifiers = { featureId: FID_OTHER };
  otherCompany.evidences[0].sourceUrl = `https://www.google.com/maps?ftid=${FID_OTHER}`;
  const changed = await freezeSnapshot(base, otherCompany, { expectedPreviousVersion: 1 });
  assert.ok(!changed.ok && changed.code === 'IDENTITY_CHANGED');

  const earlier = directDraft({ frozenAt: '2026-10-20T12:45:00.000Z' }); // antes do v1 (13:00), depois da confirmação
  const back = await freezeSnapshot(base, earlier, { expectedPreviousVersion: 1 });
  assert.ok(!back.ok && /frozenAt/.test(back.issues.join(' ')));
  assert.deepEqual(await names(path.join(base, SNAPSHOT_ID)), ['v0001.json']);
});

test('rascunhos inválidos não deixam nada no disco', async (t) => {
  const base = await tempBase(t);
  const noConfirmation = directDraft();
  delete noConfirmation.identity.confirmation;
  const withScore = directDraft({ points: 10 });
  const external = directDraft();
  external.evidences[0].origin = 'OFFICIAL_SITE';
  external.evidences[0].sourceUrl = 'https://www.padaria-exemplo.example/avaliacoes';
  for (const draft of [noConfirmation, withScore, external]) {
    const result = await freezeSnapshot(base, draft, { expectedPreviousVersion: null });
    assert.equal(result.ok, false);
  }
  const listing = await listSnapshotVersions(base, SNAPSHOT_ID);
  assert.ok(listing.ok && listing.value.versions.length === 0 && listing.value.orphanTempFiles.length === 0);
});

test('identificadores e caminhos perigosos são recusados sem tocar no disco', async (t) => {
  // O pai da base é um diretório PRIVADO deste teste: listar o /tmp inteiro era intermitente (outros testes em
  // paralelo e processos do sistema criam e removem entradas ali). A asserção continua a mesma: nada é criado fora da base.
  const parent = await tempBase(t);
  const base = path.join(parent, 'base');
  await fs.mkdir(base);
  const before = await names(parent);
  const badIds = ['', '../escape-xxxxxxxx', 'a/b/cccccccc', '..', '.oculto-snap', 'x'.repeat(65), 'curto', 'com espaco 1', 'snap\u0000exemplo1', `${SNAPSHOT_ID}/..`, 'snap-exemplo\\0001'];
  for (const id of badIds) {
    const read = await readLatestSnapshot(base, id);
    assert.ok(!read.ok && read.code === 'INVALID_ID', `read ${JSON.stringify(id)}`);
    const one = await readSnapshot(base, id, 1);
    assert.ok(!one.ok && one.code === 'INVALID_ID');
    const frozen = await freezeSnapshot(base, directDraft({ snapshotId: id }), { expectedPreviousVersion: null });
    assert.ok(!frozen.ok && frozen.code === 'INVALID_ID', `freeze ${JSON.stringify(id)}`);
  }
  assert.ok(!(await freezeSnapshot(base, null, { expectedPreviousVersion: null })).ok);
  assert.deepEqual(await names(parent), before, 'nada foi criado fora do diretório base');
  assert.deepEqual(await names(base), []);
  for (const version of [0, -1, 10000, 1.5, Number.NaN]) {
    const result = await readSnapshot(base, SNAPSHOT_ID, version);
    assert.ok(!result.ok && result.code === 'NOT_FOUND');
  }
});

test('symlinks são recusados: diretório do snapshot e arquivo de versão', async (t) => {
  const base = await tempBase(t);
  const elsewhere = await tempBase(t);
  await fs.symlink(elsewhere, path.join(base, SNAPSHOT_ID));
  const frozen = await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null });
  assert.ok(!frozen.ok && frozen.code === 'UNSAFE_PATH');
  assert.deepEqual(await names(elsewhere), [], 'nada foi gravado através do symlink');
  const read = await readLatestSnapshot(base, SNAPSHOT_ID);
  assert.ok(!read.ok && read.code === 'UNSAFE_PATH');

  const base2 = await tempBase(t);
  const real = await freezeSnapshot(base2, directDraft(), { expectedPreviousVersion: null });
  assert.ok(real.ok);
  const outside = path.join(elsewhere, 'externo.json');
  await fs.copyFile(real.value.filePath, outside);
  await fs.chmod(real.value.filePath, 0o644);
  await fs.rm(real.value.filePath);
  await fs.symlink(outside, real.value.filePath);
  const viaLink = await readSnapshot(base2, SNAPSHOT_ID, 1);
  assert.ok(!viaLink.ok && viaLink.code === 'UNSAFE_PATH');
});

test('arquivo adulterado, truncado, copiado com outro nome ou com lacuna é detectado e bloqueia novas versões', async (t) => {
  // adulterado
  const tampered = await tempBase(t);
  const a = await freezeSnapshot(tampered, directDraft(), { expectedPreviousVersion: null });
  assert.ok(a.ok);
  await fs.chmod(a.value.filePath, 0o644);
  const edited = (await fs.readFile(a.value.filePath, 'utf8')).replace('Nota e quantidade', 'Nota ALTERADA e quantidade');
  await fs.writeFile(a.value.filePath, edited);
  const readTampered = await readLatestSnapshot(tampered, SNAPSHOT_ID);
  assert.ok(!readTampered.ok && readTampered.code === 'HASH_MISMATCH');
  const blockedTampered = await freezeSnapshot(tampered, nextDraft(), { expectedPreviousVersion: 1 });
  assert.ok(!blockedTampered.ok && blockedTampered.code === 'HASH_MISMATCH');
  assert.deepEqual(await names(path.join(tampered, SNAPSHOT_ID)), ['v0001.json'], 'o arquivo adulterado não é apagado nem corrigido');

  // truncado
  const truncated = await tempBase(t);
  const b = await freezeSnapshot(truncated, directDraft(), { expectedPreviousVersion: null });
  assert.ok(b.ok);
  await fs.chmod(b.value.filePath, 0o644);
  const whole = await fs.readFile(b.value.filePath, 'utf8');
  await fs.writeFile(b.value.filePath, whole.slice(0, Math.floor(whole.length / 2)));
  const readTruncated = await readLatestSnapshot(truncated, SNAPSHOT_ID);
  assert.ok(!readTruncated.ok && readTruncated.code === 'CORRUPT');
  const blockedTruncated = await freezeSnapshot(truncated, nextDraft(), { expectedPreviousVersion: 1 });
  assert.ok(!blockedTruncated.ok && blockedTruncated.code === 'CORRUPT');
  const asNew = await freezeSnapshot(truncated, directDraft(), { expectedPreviousVersion: null });
  assert.ok(!asNew.ok, 'um arquivo corrompido não pode ser "reiniciado" como versão nova');

  // copiado com outro nome (v1 → v2) e de outro snapshot
  const copied = await tempBase(t);
  const c = await freezeSnapshot(copied, directDraft(), { expectedPreviousVersion: null });
  assert.ok(c.ok);
  await fs.copyFile(c.value.filePath, path.join(copied, SNAPSHOT_ID, 'v0002.json'));
  const readCopy = await readSnapshot(copied, SNAPSHOT_ID, 2);
  assert.ok(!readCopy.ok && readCopy.code === 'CORRUPT');
  const chainCopy = await verifySnapshotChain(copied, SNAPSHOT_ID);
  assert.ok(!chainCopy.ok);
  const otherId = 'snap-exemplo-0002';
  await fs.mkdir(path.join(copied, otherId));
  await fs.copyFile(c.value.filePath, path.join(copied, otherId, 'v0001.json'));
  const readOther = await readSnapshot(copied, otherId, 1);
  assert.ok(!readOther.ok && readOther.code === 'CORRUPT');

  // lacuna
  const gap = await tempBase(t);
  assert.ok((await freezeSnapshot(gap, directDraft(), { expectedPreviousVersion: null })).ok);
  assert.ok((await freezeSnapshot(gap, nextDraft(), { expectedPreviousVersion: 1 })).ok);
  const third = nextDraft();
  third.frozenAt = '2026-10-22T09:00:00.000Z';
  assert.ok((await freezeSnapshot(gap, third, { expectedPreviousVersion: 2 })).ok);
  await fs.rm(path.join(gap, SNAPSHOT_ID, 'v0002.json'));
  const listing = await listSnapshotVersions(gap, SNAPSHOT_ID);
  assert.ok(listing.ok && listing.value.gaps.join() === '2');
  const readGap = await readLatestSnapshot(gap, SNAPSHOT_ID);
  assert.ok(!readGap.ok && readGap.code === 'CHAIN_BROKEN');
  const blockedGap = await freezeSnapshot(gap, third, { expectedPreviousVersion: 3 });
  assert.ok(!blockedGap.ok && blockedGap.code === 'CHAIN_BROKEN');
});

test('encadeamento: trocar o hash da versão anterior (com hashes recalculados) quebra a cadeia', async (t) => {
  const base = await tempBase(t);
  assert.ok((await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null })).ok);
  assert.ok((await freezeSnapshot(base, nextDraft(), { expectedPreviousVersion: 1 })).ok);
  // Reescreve a v1 com conteúdo coerente e hash correto: a v2 deixa de apontar para ela.
  const { canonicalJson, sha256Hex } = await import('../src/lib/link-audit/canonical');
  const v1Path = path.join(base, SNAPSHOT_ID, 'v0001.json');
  const v1 = JSON.parse(await fs.readFile(v1Path, 'utf8')) as Mutable;
  v1.content.limitations = ['Reescrita posterior, coerente e com hash recalculado'];
  v1.hash.value = sha256Hex(canonicalJson(v1.content));
  await fs.chmod(v1Path, 0o644);
  await fs.writeFile(v1Path, `${canonicalJson(v1)}\n`);
  const chain = await verifySnapshotChain(base, SNAPSHOT_ID);
  assert.ok(!chain.ok && chain.code === 'CHAIN_BROKEN', chain.ok ? '' : chain.issues.join(' '));
});

test('queda durante a escrita: nenhuma versão válida, temporário ignorado, nova tentativa funciona, limpeza só toca temporários', async (t) => {
  const base = await tempBase(t);
  const dir = path.join(base, SNAPSHOT_ID);
  const crashing = ops({
    async writeExclusive(target, data) {
      await nodeFsOps.writeExclusive(target, data.slice(0, Math.floor(data.length / 2)));
      throw SIMULATED('queda simulada durante a escrita');
    },
    async unlink() {
      throw SIMULATED('queda simulada: limpeza não executada');
    },
  });
  const crashed = await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null, fs: crashing });
  assert.ok(!crashed.ok && crashed.code === 'WRITE_FAILED');
  const afterCrash = await listSnapshotVersions(base, SNAPSHOT_ID);
  assert.ok(afterCrash.ok);
  assert.deepEqual(afterCrash.value.versions, []);
  assert.equal(afterCrash.value.orphanTempFiles.length, 1);
  const missing = await readLatestSnapshot(base, SNAPSHOT_ID);
  assert.ok(!missing.ok && missing.code === 'NOT_FOUND', 'meio arquivo nunca é tratado como snapshot');

  const retry = await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null });
  assert.ok(retry.ok, retry.ok ? '' : retry.issues.join(' | '));
  assert.equal((await names(dir)).filter((n) => n.startsWith('.tmp-')).length, 1, 'o órfão continua lá até a limpeza');

  const orphan = (await names(dir)).find((n) => n.startsWith('.tmp-'))!;
  const fresh = await cleanupOrphanTempFiles(base, SNAPSHOT_ID, { now: new Date(), olderThanMs: 3_600_000 });
  assert.ok(fresh.ok && fresh.value.length === 0, 'temporário recente não é removido');
  const old = new Date(Date.now() - 2 * 3_600_000);
  await fs.utimes(path.join(dir, orphan), old, old);
  const cleaned = await cleanupOrphanTempFiles(base, SNAPSHOT_ID, { now: new Date(), olderThanMs: 3_600_000 });
  assert.ok(cleaned.ok && cleaned.value.join() === orphan);
  assert.deepEqual(await names(dir), ['v0001.json'], 'a versão fechada nunca é removida');
});

test('queda antes de publicar: o link falha e nada vira versão', async (t) => {
  const base = await tempBase(t);
  const crashing = ops({
    async link() {
      throw SIMULATED('queda simulada antes da publicação');
    },
    async unlink() {
      throw SIMULATED('limpeza também interrompida');
    },
  });
  const result = await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null, fs: crashing });
  assert.ok(!result.ok && result.code === 'WRITE_FAILED');
  const listing = await listSnapshotVersions(base, SNAPSHOT_ID);
  assert.ok(listing.ok && listing.value.versions.length === 0 && listing.value.orphanTempFiles.length === 1);
  assert.ok((await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null })).ok);
});

test('queda depois de publicar e antes de limpar: a versão é válida e o temporário sobra sem efeito', async (t) => {
  const base = await tempBase(t);
  const dir = path.join(base, SNAPSHOT_ID);
  const result = await freezeSnapshot(base, directDraft(), {
    expectedPreviousVersion: null,
    fs: ops({
      async unlink() {
        throw SIMULATED('queda simulada depois do link');
      },
    }),
  });
  assert.ok(result.ok, result.ok ? '' : result.issues.join(' | '));
  const listing = await listSnapshotVersions(base, SNAPSHOT_ID);
  assert.ok(listing.ok && listing.value.versions.join() === '1' && listing.value.orphanTempFiles.length === 1);
  assert.ok((await readLatestSnapshot(base, SNAPSHOT_ID)).ok);
  const old = new Date(Date.now() - 7_200_000);
  const orphan = listing.value.orphanTempFiles[0]!;
  await fs.utimes(path.join(dir, orphan), old, old);
  assert.ok((await cleanupOrphanTempFiles(base, SNAPSHOT_ID, { now: new Date(), olderThanMs: 1000 })).ok);
  assert.deepEqual(await names(dir), ['v0001.json']);
  assert.ok((await readLatestSnapshot(base, SNAPSHOT_ID)).ok, 'remover o temporário não afeta a versão publicada');
});

test('sem suporte a hard link: publica com rename; se a versão apareceu no meio, é conflito e nada é sobrescrito', async (t) => {
  const base = await tempBase(t);
  const fallback = await freezeSnapshot(base, directDraft(), {
    expectedPreviousVersion: null,
    fs: ops({
      async link() {
        throw SIMULATED('hard link não suportado', 'EPERM');
      },
    }),
  });
  assert.ok(fallback.ok, fallback.ok ? '' : fallback.issues.join(' | '));
  assert.deepEqual(await names(path.join(base, SNAPSHOT_ID)), ['v0001.json']);

  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
    const raced = await tempBase(t);
    const intruder = 'conteúdo de outro processo\n';
    const result = await freezeSnapshot(raced, directDraft(), {
      expectedPreviousVersion: null,
      fs: ops({
        async link(_from, to) {
          await fs.writeFile(to, intruder); // outro processo publicou a v1 primeiro
          throw SIMULATED('hard link não suportado', code);
        },
      }),
    });
    assert.ok(!result.ok && result.code === 'CONFLICT', code);
    assert.equal(await fs.readFile(path.join(raced, SNAPSHOT_ID, 'v0001.json'), 'utf8'), intruder, 'o arquivo existente não foi sobrescrito');
    assert.deepEqual(await names(path.join(raced, SNAPSHOT_ID)), ['v0001.json']);
  }

  const exists = await tempBase(t);
  const eexist = await freezeSnapshot(exists, directDraft(), {
    expectedPreviousVersion: null,
    fs: ops({
      async link(_from, to) {
        await fs.writeFile(to, 'x');
        throw SIMULATED('já existe', 'EEXIST');
      },
    }),
  });
  assert.ok(!eexist.ok && eexist.code === 'CONFLICT');
  assert.equal(await fs.readFile(path.join(exists, SNAPSHOT_ID, 'v0001.json'), 'utf8'), 'x');
});

test('erros de disco (EIO, EROFS) interrompem sem nova tentativa e não deixam versão válida', async (t) => {
  type Scenario = { label: string; code: string; build: (calls: { count: number }) => Partial<FsOps> };
  const scenarios: Scenario[] = [
    {
      label: 'escrita do temporário',
      code: 'EIO',
      build: (calls) => ({
        async writeExclusive() {
          calls.count += 1;
          throw SIMULATED('falha simulada', 'EIO');
        },
      }),
    },
    {
      label: 'publicação (link)',
      code: 'EROFS',
      build: (calls) => ({
        async link() {
          calls.count += 1;
          throw SIMULATED('falha simulada', 'EROFS');
        },
      }),
    },
    {
      label: 'criação exclusiva sem hard link',
      code: 'EIO',
      build: (calls) => ({
        async link() {
          throw SIMULATED('hard link não suportado', 'EPERM');
        },
        async writeExclusive(target, data, mode) {
          if (path.basename(target).startsWith('.tmp-')) return nodeFsOps.writeExclusive(target, data, mode);
          calls.count += 1;
          throw SIMULATED('falha simulada', 'EIO');
        },
      }),
    },
  ];
  for (const { label, code, build } of scenarios) {
    const base = await tempBase(t);
    const calls = { count: 0 };
    const result = await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null, fs: ops(build(calls)) });
    assert.ok(!result.ok && result.code === 'WRITE_FAILED', label);
    assert.match(result.issues.join(' '), new RegExp(code), label);
    assert.equal(calls.count, 1, `${label}: sem nova tentativa`);
    const read = await readLatestSnapshot(base, SNAPSHOT_ID);
    assert.ok(!read.ok, `${label}: nada pode ser lido como snapshot válido`);
  }
});

test('o caminho sem hard link nunca substitui uma versão que apareceu a qualquer momento', async (t) => {
  const base = await tempBase(t);
  const intruder = 'versão publicada por outro processo\n';
  const result = await freezeSnapshot(base, directDraft(), {
    expectedPreviousVersion: null,
    fs: ops({
      async link() {
        throw SIMULATED('hard link não suportado', 'EPERM');
      },
      async writeExclusive(target, data, mode) {
        if (!path.basename(target).startsWith('.tmp-')) await fs.writeFile(target, intruder); // aparece logo antes da criação exclusiva
        return nodeFsOps.writeExclusive(target, data, mode);
      },
    }),
  });
  assert.ok(!result.ok && result.code === 'CONFLICT');
  assert.equal(await fs.readFile(path.join(base, SNAPSHOT_ID, 'v0001.json'), 'utf8'), intruder);
  assert.deepEqual(await names(path.join(base, SNAPSHOT_ID)), ['v0001.json']);
});

test('nenhum chmod toca o caminho final (o modo somente leitura vai no temporário, antes do link)', async (t) => {
  const base = await tempBase(t);
  const chmodTargets: string[] = [];
  const result = await freezeSnapshot(base, directDraft(), {
    expectedPreviousVersion: null,
    fs: ops({
      async chmod(target, mode) {
        chmodTargets.push(path.basename(target));
        return nodeFsOps.chmod(target, mode);
      },
    }),
  });
  assert.ok(result.ok);
  assert.ok(chmodTargets.every((name) => name.startsWith('.tmp-')), chmodTargets.join());
  assert.equal((await fs.stat(result.value.filePath)).mode & 0o222, 0);
});

test('os bytes do arquivo precisam ser a serialização canônica (uma versão = uma sequência de bytes)', async (t) => {
  const { serializeSnapshot } = await import('../src/lib/link-audit/snapshot');
  const variants: Array<[string, (text: string, parsed: Mutable) => string]> = [
    ['indentado', (_t, parsed) => `${JSON.stringify(parsed, null, 2)}\n`],
    ['linha em branco a mais', (text) => `${text}\n`],
    ['sem quebra de linha final', (text) => text.trimEnd()],
    ['chave duplicada', (text) => text.replace('"limitations":', '"limitations":["PRIMEIRA"],"limitations":')],
    ['BOM', (text) => `\uFEFF${text}`],
  ];
  for (const [label, transform] of variants) {
    const base = await tempBase(t);
    const frozen = await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null });
    assert.ok(frozen.ok);
    const text = serializeSnapshot(frozen.value.snapshot);
    await fs.chmod(frozen.value.filePath, 0o644);
    await fs.writeFile(frozen.value.filePath, transform(text, JSON.parse(text) as Mutable));
    const read = await readSnapshot(base, SNAPSHOT_ID, 1);
    assert.ok(!read.ok && read.code === 'CORRUPT', `${label}: ${read.ok ? 'aceito' : read.code}`);
  }
});

test('rascunho inválido não cria diretório, e a causa não é escondida', async (t) => {
  const base = await tempBase(t);
  const early = directDraft({ frozenAt: '2026-10-20T11:59:59.000Z' }); // antes de collectedAt
  const invalid = await freezeSnapshot(base, early, { expectedPreviousVersion: null });
  assert.ok(!invalid.ok && invalid.code === 'INVALID', invalid.ok ? '' : invalid.code);
  const schema = await freezeSnapshot(base, directDraft({ points: 1 }), { expectedPreviousVersion: null });
  assert.ok(!schema.ok && schema.code === 'SCHEMA');
  const noId = await freezeSnapshot(base, directDraft({ snapshotId: 'x' }), { expectedPreviousVersion: null });
  assert.ok(!noId.ok && noId.code === 'INVALID_ID');
  assert.deepEqual(await names(base), [], 'nenhum diretório foi criado');
});

test('o rascunho é lido uma única vez: getters instáveis ou hostis não gravam em lugar errado nem lançam', async (t) => {
  const base = await tempBase(t);
  let reads = 0;
  const unstable = directDraft();
  Object.defineProperty(unstable, 'snapshotId', {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? 'snap-aaaaaaaa' : 'snap-bbbbbbbb';
    },
  });
  const result = await freezeSnapshot(base, unstable, { expectedPreviousVersion: null });
  if (result.ok) {
    assert.equal(result.value.snapshot.content.snapshotId, path.basename(path.dirname(result.value.filePath)));
  } else {
    assert.deepEqual(await names(base), [], 'se falhou, nada ficou no disco');
  }
  assert.deepEqual((await names(base)).filter((n) => n !== 'snap-aaaaaaaa' && n !== 'snap-bbbbbbbb'), []);
  for (const dirName of await names(base)) {
    const latest = await readLatestSnapshot(base, dirName);
    assert.ok(latest.ok, `${dirName} deve continuar íntegro`);
  }

  const hostile = {};
  Object.defineProperty(hostile, 'snapshotId', {
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });
  const thrown = await freezeSnapshot(base, hostile, { expectedPreviousVersion: null });
  assert.equal(thrown.ok, false);
});

test('a mesma pasta por caminhos diferentes (barra final, ./, .., symlink) continua com um único vencedor', async (t) => {
  const base = await tempBase(t);
  const alias = `${await tempBase(t)}-alias`;
  await fs.symlink(base, alias);
  t.after(() => fs.rm(alias, { force: true }));
  const spellings = [base, `${base}${path.sep}`, path.join(base, '.', 'x', '..'), alias];
  const results = await Promise.all(spellings.map((spelling) => freezeSnapshot(spelling, directDraft(), { expectedPreviousVersion: null })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'CONFLICT'));
  assert.deepEqual(await names(path.join(base, SNAPSHOT_ID)), ['v0001.json']);
});

test('expectedPreviousVersion fora do tipo nunca grava', async (t) => {
  const base = await tempBase(t);
  for (const expected of [undefined, '0', 0, -1, Number.NaN, {}] as unknown[]) {
    const result = await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: expected as null });
    assert.ok(!result.ok && result.code === 'CONFLICT', String(expected));
  }
  assert.deepEqual(await names(base), []);
});

test('nada é gravado fora do diretório base, em public/ nem em .data/audits', async (t) => {
  const watched = [path.join(process.cwd(), 'public'), path.join(process.cwd(), '.data', 'audits'), path.join(process.cwd(), 'src')];
  const snapshotOf = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (current: string): Promise<void> => {
      for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else out.push(`${full}:${(await fs.stat(full)).mtimeMs}`);
      }
    };
    await walk(dir);
    return out.sort();
  };
  const before = await Promise.all(watched.map(snapshotOf));
  const base = await tempBase(t);
  assert.ok((await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null })).ok);
  assert.ok((await freezeSnapshot(base, nextDraft(), { expectedPreviousVersion: 1 })).ok);
  assert.deepEqual(await Promise.all(watched.map(snapshotOf)), before);
  assert.deepEqual(await names(base), [SNAPSHOT_ID]);
});

test('a pasta padrão é .data/link-audits, privada e fora de public/', () => {
  const dir = defaultLinkAuditDirectory('/projeto/exemplo');
  assert.equal(dir, path.join('/projeto/exemplo', '.data', 'link-audits'));
  assert.ok(!dir.split(path.sep).includes('public'));
  assert.equal(defaultLinkAuditDirectory(), path.join(process.cwd(), '.data', 'link-audits'));
});

test('sistema de arquivos real do projeto: grava, encadeia, detecta adulteração e limpa o que criou', async () => {
  const base = path.join(process.cwd(), '.data', `link-audits-teste-${randomBytes(6).toString('hex')}`);
  try {
    const first = await freezeSnapshot(base, directDraft(), { expectedPreviousVersion: null });
    assert.ok(first.ok, first.ok ? '' : first.issues.join(' | '));
    const second = await freezeSnapshot(base, nextDraft(), { expectedPreviousVersion: 1 });
    assert.ok(second.ok, second.ok ? '' : second.issues.join(' | '));
    const chain = await verifySnapshotChain(base, SNAPSHOT_ID);
    assert.ok(chain.ok && chain.value.length === 2);
    assert.deepEqual(await names(path.join(base, SNAPSHOT_ID)), ['v0001.json', 'v0002.json']);

    const copy = clone(chain.value[0]) as Mutable;
    assert.equal(copy.content.identity.identifiers.featureId, FID);
    await fs.chmod(first.value.filePath, 0o644);
    await fs.writeFile(first.value.filePath, (await fs.readFile(first.value.filePath, 'utf8')).replace('Nota e quantidade', 'Nota X'));
    const tampered = await readSnapshot(base, SNAPSHOT_ID, 1);
    assert.ok(!tampered.ok && tampered.code === 'HASH_MISMATCH');
  } finally {
    await removeTree(base);
  }
  assert.equal(
    (await fs.readdir(path.join(process.cwd(), '.data'))).some((name) => name.startsWith('link-audits-teste-')),
    false,
    'o diretório de teste foi removido',
  );
});
