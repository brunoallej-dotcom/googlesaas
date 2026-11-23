import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/*
 * G1.a (spec dos portões §5.3, VC-E1/VC-E8; ensaio EN-12): o caminho REAL das seis pastas da Fase 6 só existe no host, então o teste estático
 * do `stack.yml` só confere marcadores distintos. O pré-requisito executável é `deploy/hostinger/verificar-pastas-fase6.sh`: recebe os seis
 * caminhos e FALHA se dois resolvem para a mesma pasta, se uma está dentro de outra, se o modo de uma das cinco pastas de dados não é 0700, se a
 * de manifestos não é 2750 com o grupo 10001 e um dono que não é 10001 nem 0 (P9.3b, P9-F01) ou se recibos e livro não estão em dispositivos
 * independentes. Aqui ele roda sobre diretórios temporários (sem rede, sem Docker, sem tocar em nada fora deles). O teste não pode dar o dono e o
 * grupo 10001 a uma pasta (sem root): um `stat` FALSO no PATH responde SÓ a consulta de dono/grupo/modo da pasta de manifestos (o modo vem do
 * `stat` real) e repassa todo o resto ao `stat` real; sem ele, o `stat` real mostra o grupo do usuário do teste e a pasta é recusada.
 */
const SCRIPT = path.join(__dirname, '..', 'deploy', 'hostinger', 'verificar-pastas-fase6.sh');
const ORDER = ['decisoes', 'recibos-decisoes', 'resultados', 'recibos-resultados', 'livro', 'manifestos'] as const;
type Role = (typeof ORDER)[number];
/** Um uid de usuário de receptor de manifestos (nem 10001 nem 0) e o grupo do web. */
const SEALS_UID = '1500';
const APP_GID = '10001';
const REAL_STAT = ['/usr/bin/stat', '/bin/stat'].find((file) => fs.existsSync(file)) as string;

interface Identity {
  readonly owner: string;
  readonly group: string;
}

/** Um `stat` falso que responde com `identity` à consulta `-c '%u %g %a' -- <manifestos>`; `null` = só o `stat` real. */
function statShim(manifests: string, identity: Identity | null): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gmn-p6-bin-'));
  const real = fs.realpathSync(manifests);
  const answer = identity === null ? '' : `if [ "$1" = "-c" ] && [ "$2" = "%u %g %a" ] && [ "$3" = "--" ] && [ "$4" = '${real}' ]; then\n  printf '%s %s %s\\n' '${identity.owner}' '${identity.group}' "$('${REAL_STAT}' -c %a -- "$4")"\n  exit 0\nfi\n`;
  fs.writeFileSync(path.join(bin, 'stat'), `#!/bin/bash\n${answer}exec '${REAL_STAT}' "$@"\n`, { mode: 0o755 });
  return bin;
}

const run = (args: readonly string[], identity: Identity | null = { owner: SEALS_UID, group: APP_GID }): { status: number | null; stderr: string; stdout: string } => {
  const manifests = args[ORDER.indexOf('manifestos')];
  const bin = manifests !== undefined && fs.existsSync(manifests) ? statShim(manifests, identity) : null;
  const env = { PATH: `${bin === null ? '' : `${bin}:`}/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv;
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env });
  if (bin !== null) fs.rmSync(bin, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
};
const mkdirMode = (dir: string, mode: number): string => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, mode);
  return dir;
};
const mkdir700 = (dir: string): string => mkdirMode(dir, 0o700);
/** A pasta de manifestos como no host: 2750 (o setgid e o grupo vêm do `stat` falso, na consulta de dono/grupo). */
const mkdirManifests = (dir: string): string => mkdirMode(dir, 0o2750);
function sandbox(t: { after: (fn: () => void) => void }, base: string = os.tmpdir()): string {
  const root = fs.mkdtempSync(path.join(base, 'gmn-p6-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const sameFs = (root: string): Record<Role, string> => Object.fromEntries(ORDER.map((role) => [role, role === 'manifestos' ? mkdirManifests(path.join(root, role)) : mkdir700(path.join(root, role))])) as Record<Role, string>;
const argsOf = (dirs: Record<Role, string>): string[] => ORDER.map((role) => dirs[role]);

test('PG-V04 verificar-pastas: número errado de argumentos ou pasta inexistente ⇒ recusa', (t) => {
  assert.equal(run([]).status, 1);
  const dirs = sameFs(sandbox(t));
  assert.equal(run(argsOf(dirs).slice(0, 5)).status, 1);
  const missing = run(argsOf({ ...dirs, livro: path.join(path.dirname(dirs.livro), 'nao-existe') }));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /livro: não é um diretório existente/);
});

test('PG-V04 verificar-pastas: duas origens na MESMA pasta (inclusive por link simbólico) ⇒ recusa', (t) => {
  const root = sandbox(t);
  const dirs = sameFs(root);
  const colocated = run(argsOf({ ...dirs, 'recibos-decisoes': dirs.decisoes }));
  assert.equal(colocated.status, 1);
  assert.match(colocated.stderr, /recibos-decisoes e decisoes são a mesma pasta|decisoes e recibos-decisoes são a mesma pasta/);
  const alias = path.join(root, 'apelido');
  fs.symlinkSync(dirs.resultados, alias);
  const linked = run(argsOf({ ...dirs, 'recibos-resultados': alias }));
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /a mesma pasta/);
});

test('PG-V04 verificar-pastas: uma pasta dentro de outra ⇒ recusa', (t) => {
  const dirs = sameFs(sandbox(t));
  const nested = run(argsOf({ ...dirs, livro: mkdir700(path.join(dirs.decisoes, 'livro')) }));
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /livro está dentro de decisoes/);
});

test('PG-V04 verificar-pastas: uma das cinco pastas de dados com modo diferente de 0700 (inclusive 2750, o da de manifestos) ⇒ recusa', (t) => {
  const dirs = sameFs(sandbox(t));
  fs.chmodSync(dirs.decisoes, 0o755);
  const loose = run(argsOf(dirs));
  assert.equal(loose.status, 1);
  assert.match(loose.stderr, /decisoes: modo 755/);
  fs.chmodSync(dirs.decisoes, 0o700);
  fs.chmodSync(dirs.livro, 0o2750);
  const asManifests = run(argsOf(dirs));
  assert.equal(asManifests.status, 1);
  assert.match(asManifests.stderr, /livro: modo 2750 \(exigido 0700\)/);
});

test('P9-F01 verificar-pastas: manifestos com 0700 ⇒ recusa; com 2750, grupo 10001 e dono ≠ 10001 ⇒ aceito (a recusa que sobra é a dos dispositivos); com dono 10001 ou 0, outro grupo ou outro modo ⇒ recusa; as outras cinco continuam exigindo 0700', (t) => {
  const dirs = sameFs(sandbox(t));
  fs.chmodSync(dirs.manifestos, 0o700);
  const old = run(argsOf(dirs));
  assert.equal(old.status, 1);
  assert.match(old.stderr, /manifestos: modo 700 \(exigido 2750/, 'o modo antigo (0700) da pasta de manifestos não vale mais');
  fs.chmodSync(dirs.manifestos, 0o2750);
  const accepted = run(argsOf(dirs));
  assert.equal(accepted.status, 1, 'mesmo disco: ainda recusa, mas pelos volumes independentes');
  assert.match(accepted.stderr, /recibos-decisoes no mesmo dispositivo que decisoes/);
  assert.ok(!/manifestos/.test(accepted.stderr), 'a pasta de manifestos passou');
  for (const [label, identity, message] of [
    ['dono 10001 (o mesmo poder do web)', { owner: APP_GID, group: APP_GID }, /manifestos: dono 10001/],
    ['dono 0 (root)', { owner: '0', group: APP_GID }, /manifestos: dono 0/],
    ['grupo do próprio usuário', { owner: SEALS_UID, group: '1000' }, /manifestos: grupo 1000 \(exigido 10001/],
    ['grupo 0', { owner: SEALS_UID, group: '0' }, /manifestos: grupo 0/],
  ] as const) {
    const refused = run(argsOf(dirs), identity);
    assert.equal(refused.status, 1, label);
    assert.match(refused.stderr, message, label);
  }
  const realStat = run(argsOf(dirs), null);
  assert.equal(realStat.status, 1, 'sem o stat falso: o grupo real é o do usuário do teste');
  assert.match(realStat.stderr, /manifestos: grupo \d+ \(exigido 10001/);
  for (const mode of [0o750, 0o2770, 0o2755, 0o2700, 0o6750, 0o3750]) {
    fs.chmodSync(dirs.manifestos, mode);
    const refused = run(argsOf(dirs));
    assert.equal(refused.status, 1, mode.toString(8));
    assert.match(refused.stderr, new RegExp(`manifestos: modo ${mode.toString(8)} \\(exigido 2750`), mode.toString(8));
  }
  fs.chmodSync(dirs.manifestos, 0o2750);
  for (const role of ORDER.filter((name) => name !== 'manifestos')) {
    fs.chmodSync(dirs[role], 0o2750);
    const refused = run(argsOf(dirs));
    assert.equal(refused.status, 1, role);
    assert.match(refused.stderr, new RegExp(`${role}: modo 2750 \\(exigido 0700\\)`), role);
    fs.chmodSync(dirs[role], 0o700);
  }
});

test('PG-V04 verificar-pastas: seis pastas distintas no MESMO dispositivo ⇒ recusa pelos volumes independentes (recibos e livro)', (t) => {
  const result = run(argsOf(sameFs(sandbox(t))));
  assert.equal(result.status, 1, 'mesmo disco não é backup independente');
  assert.match(result.stderr, /recibos-decisoes no mesmo dispositivo que decisoes/);
});

/** Raízes graváveis em sistemas de arquivos diferentes (tmpdir, /dev/shm, /run/user/<uid>, o próprio repositório). */
function distinctDeviceRoots(): string[] {
  const candidates = [os.tmpdir(), '/dev/shm', `/run/user/${process.getuid?.() ?? -1}`, path.join(__dirname, '..')];
  const byDevice = new Map<number, string>();
  for (const dir of candidates) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      const device = fs.statSync(dir).dev;
      if (!byDevice.has(device)) byDevice.set(device, dir);
    } catch {
      continue; // raiz indisponível neste ambiente: só reduz as combinações possíveis
    }
  }
  return [...byDevice.values()];
}

test('PG-V04 verificar-pastas: dados, recibos e livro em três dispositivos ⇒ aceita; livro no disco de um recibo ⇒ recusa', (t) => {
  const roots = distinctDeviceRoots();
  if (roots.length < 3) {
    t.skip(`só ${roots.length} sistema(s) de arquivos gravável(is) distinto(s) neste ambiente`);
    return;
  }
  const [dataRoot, receiptsRoot, ledgerRoot] = roots.slice(0, 3).map((base) => sandbox(t, base)) as [string, string, string];
  const dirs: Record<Role, string> = {
    decisoes: mkdir700(path.join(dataRoot, 'decisoes')),
    resultados: mkdir700(path.join(dataRoot, 'resultados')),
    manifestos: mkdirManifests(path.join(dataRoot, 'manifestos')),
    'recibos-decisoes': mkdir700(path.join(receiptsRoot, 'recibos-decisoes')),
    'recibos-resultados': mkdir700(path.join(receiptsRoot, 'recibos-resultados')),
    livro: mkdir700(path.join(ledgerRoot, 'livro')),
  };
  const ok = run(argsOf(dirs));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /OK/);
  const ledgerWithReceipts = run(argsOf({ ...dirs, livro: mkdir700(path.join(receiptsRoot, 'livro')) }));
  assert.equal(ledgerWithReceipts.status, 1);
  assert.match(ledgerWithReceipts.stderr, /livro no mesmo dispositivo que recibos-decisoes/);
});

test('PG-V04 verificar-pastas: matriz completa — recibo de decisões no disco dos RESULTADOS, ou recibo de resultados no das DECISÕES ⇒ recusa', (t) => {
  const roots = distinctDeviceRoots();
  if (roots.length < 3) {
    t.skip(`só ${roots.length} sistema(s) de arquivos gravável(is) distinto(s) neste ambiente`);
    return;
  }
  const [a, b, c] = roots.slice(0, 3).map((base) => sandbox(t, base)) as [string, string, string];
  // decisões no dispositivo A e resultados no B: cada recibo fica longe dos PRÓPRIOS dados, mas no disco dos OUTROS dados
  const receiptsOfDecisionsOnResultsDisk = run(argsOf({
    decisoes: mkdir700(path.join(a, 'decisoes')),
    manifestos: mkdirManifests(path.join(a, 'manifestos')),
    resultados: mkdir700(path.join(b, 'resultados')),
    'recibos-decisoes': mkdir700(path.join(b, 'recibos-decisoes')),
    'recibos-resultados': mkdir700(path.join(c, 'recibos-resultados')),
    livro: mkdir700(path.join(c, 'livro')),
  }));
  assert.equal(receiptsOfDecisionsOnResultsDisk.status, 1);
  assert.match(receiptsOfDecisionsOnResultsDisk.stderr, /recibos-decisoes no mesmo dispositivo que resultados/);
  const receiptsOfResultsOnDecisionsDisk = run(argsOf({
    decisoes: mkdir700(path.join(a, 'decisoes-2')),
    manifestos: mkdirManifests(path.join(a, 'manifestos-2')),
    resultados: mkdir700(path.join(b, 'resultados-2')),
    'recibos-decisoes': mkdir700(path.join(c, 'recibos-decisoes-2')),
    'recibos-resultados': mkdir700(path.join(a, 'recibos-resultados-2')),
    livro: mkdir700(path.join(c, 'livro-2')),
  }));
  assert.equal(receiptsOfResultsOnDecisionsDisk.status, 1);
  assert.match(receiptsOfResultsOnDecisionsDisk.stderr, /recibos-resultados no mesmo dispositivo que decisoes/);
});
