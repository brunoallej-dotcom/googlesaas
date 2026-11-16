import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { quarantineDirOf, registerCleanup, tmpDir, world } from './helpers/link-audit-decisions-fixtures';

/*
 * Os testes de decisões simulam uma "quarentena" movendo arquivos para fora da pasta de decisões. O caminho dessa quarentena era
 * `join(decisionsDir, '..', 'quarentena-<auditId>')`: como cada ambiente é um mkdtemp direto em /tmp, isso era um caminho FIXO e COMPARTILHADO
 * (/tmp/quarentena-auditoria-teste-0001), e arquivos de teste que rodam em paralelo colidiam (ENOENT no rename; cadeia "não encadeada").
 * Aqui fica o contrato do diretório novo (único por ambiente, fora das pastas de dados, limpo ao final) e a guarda contra a volta do padrão.
 */
registerCleanup();

const ROOT = path.join(__dirname, '..');
const AUDIT = 'auditoria-teste-0001';

test('a quarentena é única por ambiente, fora das pastas de dados, direto em os.tmpdir() e estável para as mesmas entradas', async () => {
  const a = await world({ seed: false });
  const b = await world({ seed: false });
  const qa = quarantineDirOf(a, AUDIT);
  const qb = quarantineDirOf(b, AUDIT);
  assert.notEqual(qa, qb, 'dois ambientes nunca compartilham a quarentena');
  assert.equal(quarantineDirOf(a, AUDIT), qa, 'a mesma chamada devolve o mesmo diretório');
  assert.notEqual(quarantineDirOf(a, AUDIT, 'quarentena-fiacao'), qa, 'rótulo diferente, diretório diferente');
  assert.notEqual(quarantineDirOf(a, 'outra-auditoria'), qa, 'auditoria diferente, diretório diferente');
  for (const dir of [qa, qb]) {
    assert.ok(fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0, 'existe e começa vazio');
    assert.equal(path.dirname(dir), os.tmpdir(), 'direto em os.tmpdir()');
    assert.match(path.basename(dir), /^lad-quarentena-[A-Za-z0-9]{6}$/, 'prefixo conhecido + sufixo aleatório (mkdtemp)');
    assert.ok(dir !== os.tmpdir() && dir !== path.parse(dir).root, 'nunca a raiz nem o próprio os.tmpdir() (a limpeza apaga o diretório)');
  }
  for (const [env, dir] of [[a, qa], [b, qb]] as const) {
    for (const data of [env.decisionsDir, env.anchorDir, env.evidenceDir]) {
      const relative = path.relative(data, dir);
      assert.ok(relative.startsWith('..') && !path.isAbsolute(relative), `a quarentena não pode ficar dentro de ${path.basename(data)}`);
      const inverse = path.relative(dir, data);
      assert.ok(inverse.startsWith('..'), 'e as pastas de dados não ficam dentro da quarentena');
    }
  }
  const legacy = path.join(os.tmpdir(), `quarentena-${AUDIT}`);
  assert.ok(qa !== legacy && qb !== legacy, 'nunca o caminho fixo antigo');
});

test('dois ambientes movendo "d0002.json" ao mesmo tempo não se atrapalham (cada quarentena guarda só o arquivo do seu ambiente)', async () => {
  const environments = await Promise.all([world({ seed: false }), world({ seed: false }), world({ seed: false })]);
  await Promise.all(
    environments.map(async (w, index) => {
      const decisions = path.join(w.decisionsDir, AUDIT);
      fs.mkdirSync(decisions, { recursive: true });
      fs.writeFileSync(path.join(decisions, 'd0002.json'), `ambiente ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 5 * (3 - index)));
      fs.renameSync(path.join(decisions, 'd0002.json'), path.join(quarantineDirOf(w, AUDIT), 'd0002.json'));
    })
  );
  environments.forEach((w, index) => {
    const dir = quarantineDirOf(w, AUDIT);
    assert.deepEqual(fs.readdirSync(dir), ['d0002.json']);
    assert.equal(fs.readFileSync(path.join(dir, 'd0002.json'), 'utf8'), `ambiente ${index}`, 'o arquivo é o do próprio ambiente');
    assert.ok(!fs.existsSync(path.join(w.decisionsDir, AUDIT, 'd0002.json')), 'saiu da pasta de decisões');
  });
});

test('a limpeza é registrada: ao fim do processo, a quarentena e os demais diretórios do ambiente são apagados, inclusive com arquivo dentro', async () => {
  const report = path.join(tmpDir('lad-quar-relatorio-'), 'caminhos.json');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const STDERR_TAIL_CHARS = 4_000;
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const proc = spawn(process.execPath, ['--require', path.join(ROOT, 'tests', 'register-typescript.cjs'), path.join(ROOT, 'tests', 'helpers', 'quarantine-cleanup-child.ts')], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...env, QUARANTINE_REPORT: report },
    });
    let errText = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      errText = (errText + chunk).slice(-STDERR_TAIL_CHARS);
    });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
    proc.on('error', reject);
    proc.on('close', (exit) => {
      clearTimeout(timer);
      resolve({ code: exit, stderr: errText });
    });
  });
  assert.equal(code, 0, `o processo filho terminou sem erro (code=${String(code)}; null = morto por tempo). stderr:\n${stderr}`);
  const paths = JSON.parse(fs.readFileSync(report, 'utf8')) as Record<'quarantine' | 'decisions' | 'anchors' | 'evidence', string>;
  assert.match(path.basename(paths.quarantine), /^lad-quarentena-/);
  for (const [name, dir] of Object.entries(paths)) {
    assert.ok(path.dirname(dir) === os.tmpdir(), `${name} foi criado direto em os.tmpdir()`);
    assert.ok(!fs.existsSync(dir), `${name} deveria ter sido apagado pela limpeza registrada: ${dir}`);
  }
});

test('guarda estática: nenhum teste monta a quarentena fora da pasta do ambiente nem com nome fixo em /tmp (o padrão que colidia não volta)', () => {
  const files = [...fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.ts')).map((f) => path.join('tests', f)), ...fs.readdirSync(path.join(ROOT, 'tests', 'helpers')).filter((f) => f.endsWith('.ts')).map((f) => path.join('tests', 'helpers', f))];
  assert.ok(files.length > 100, 'varre os testes e os helpers');
  const offenders: string[] = [];
  for (const file of files) {
    if (file === path.join('tests', 'link-audit-quarantine-isolation.test.ts')) continue;
    // sem comentários: o próprio helper explica, em comentário, o padrão antigo
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (/(decisionsDir|anchorDir|evidenceDir)[^\n]*,\s*'\.\.'/.test(source)) offenders.push(`${file}: caminho irmão da pasta de dados (join(..., '..'))`);
    if (/join\([^)\n]*'\.\.'[^)\n]*quarentena/.test(source) || /join\(os\.tmpdir\(\)[^)\n]*quarentena/.test(source)) offenders.push(`${file}: quarentena com nome fixo em /tmp`);
  }
  assert.deepEqual(offenders, []);
});
