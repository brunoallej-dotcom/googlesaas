import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/*
 * G1.a (spec dos portões §5.3, VC-E1/VC-E8; ensaio EN-12): o caminho REAL das seis pastas da Fase 6 só existe no host, então o teste estático
 * do `stack.yml` só confere marcadores distintos. O pré-requisito executável é `deploy/hostinger/verificar-pastas-fase6.sh`: recebe os seis
 * caminhos e FALHA se dois resolvem para a mesma pasta, se uma está dentro de outra, se o modo não é 0700 ou se recibos e livro não estão em
 * dispositivos independentes. Aqui ele roda sobre diretórios temporários (sem rede, sem Docker, sem tocar em nada fora deles).
 */
const SCRIPT = path.join(__dirname, '..', 'deploy', 'hostinger', 'verificar-pastas-fase6.sh');
const ORDER = ['decisoes', 'recibos-decisoes', 'resultados', 'recibos-resultados', 'livro', 'manifestos'] as const;
type Role = (typeof ORDER)[number];

const run = (args: readonly string[]): { status: number | null; stderr: string; stdout: string } => {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
};
const mkdir700 = (dir: string): string => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
};
function sandbox(t: { after: (fn: () => void) => void }, base: string = os.tmpdir()): string {
  const root = fs.mkdtempSync(path.join(base, 'gmn-p6-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const sameFs = (root: string): Record<Role, string> => Object.fromEntries(ORDER.map((role) => [role, mkdir700(path.join(root, role))])) as Record<Role, string>;
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

test('PG-V04 verificar-pastas: modo diferente de 0700 ⇒ recusa', (t) => {
  const dirs = sameFs(sandbox(t));
  fs.chmodSync(dirs.manifestos, 0o755);
  const loose = run(argsOf(dirs));
  assert.equal(loose.status, 1);
  assert.match(loose.stderr, /manifestos: modo 755/);
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
    manifestos: mkdir700(path.join(dataRoot, 'manifestos')),
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
    manifestos: mkdir700(path.join(a, 'manifestos')),
    resultados: mkdir700(path.join(b, 'resultados')),
    'recibos-decisoes': mkdir700(path.join(b, 'recibos-decisoes')),
    'recibos-resultados': mkdir700(path.join(c, 'recibos-resultados')),
    livro: mkdir700(path.join(c, 'livro')),
  }));
  assert.equal(receiptsOfDecisionsOnResultsDisk.status, 1);
  assert.match(receiptsOfDecisionsOnResultsDisk.stderr, /recibos-decisoes no mesmo dispositivo que resultados/);
  const receiptsOfResultsOnDecisionsDisk = run(argsOf({
    decisoes: mkdir700(path.join(a, 'decisoes-2')),
    manifestos: mkdir700(path.join(a, 'manifestos-2')),
    resultados: mkdir700(path.join(b, 'resultados-2')),
    'recibos-decisoes': mkdir700(path.join(c, 'recibos-decisoes-2')),
    'recibos-resultados': mkdir700(path.join(a, 'recibos-resultados-2')),
    livro: mkdir700(path.join(c, 'livro-2')),
  }));
  assert.equal(receiptsOfResultsOnDecisionsDisk.status, 1);
  assert.match(receiptsOfResultsOnDecisionsDisk.stderr, /recibos-resultados no mesmo dispositivo que decisoes/);
});
