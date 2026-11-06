import { LEDGER_NOT_REQUIRED } from '../../src/lib/link-audit-decisions/ledger-port';
import { WITNESS_NOT_REQUIRED } from '../../src/lib/link-audit-decisions/witness';
import fs from 'node:fs';
import path from 'node:path';
import { createDecisionService, type EvidenceLookup } from '../../src/lib/link-audit-decisions';
import { assertBase, hashOk, locateIn, scrubPaths, splitNames } from '../../src/lib/link-audit-decisions/files';
import { clearStorageFatal, readLog, seal, serialize } from '../../src/lib/link-audit-decisions/store';
import { ANCHOR_FILE, ENTRY_FILE } from '../../src/lib/link-audit-decisions/types';
import { canonicalJson, sha256Hex } from '../../src/lib/link-audit/canonical';
import { nodeFsOps, type FsOps } from '../../src/lib/link-audit/snapshot-store';
import { errno, faulty } from './link-audit-evidence-fixtures';
import { ANA, BIA, rec, tmpDir } from './link-audit-decisions-fixtures';
import { TEST_ORIGIN } from './link-audit-origin-fixtures';

/*
 * Cenário de CONFORMIDADE do protocolo de armazenamento da 6B. Usa só a API pública da 6B (serviço, `readLog` e as primitivas
 * reexportadas), com relógio determinístico, e devolve um relatório 100 % reprodutível: respostas completas (códigos,
 * mensagens, `head`, `pending`), árvores de arquivos (SHA-256 de cada arquivo) e as saídas das primitivas puras.
 *
 * O relatório foi GRAVADO ANTES da extração das primitivas para `link-audit-storage` (Onda 6C, I0) em
 * `tests/fixtures/link-audit-storage/protocol-conformance-v1.json`. O teste de conformidade exige que ele seja idêntico
 * depois da refatoração: nenhum byte de arquivo, código de erro ou mensagem pode mudar.
 */
export const AUDIT = 'auditoria-conformidade-01';
const REASON = 'Informação conferida e incorreta; decisão desfeita.';

const evidence: EvidenceLookup = {
  async getIntegrity() {
    return { state: 'COMPLETE', integrity: { status: 'OK' } };
  },
  async listVersions() {
    return [{ capture: 1, collectedAt: '2026-10-22T12:54:48.079Z', reportRevisions: [{ revision: 1 }] }];
  },
};

type Json = Record<string, unknown>;
const plain = (value: unknown): unknown => JSON.parse(canonicalJson(value));

/** Resposta do serviço em forma estável (sucesso completo ou falha com código, detalhes, head e pendente). */
function outcome(result: { ok: boolean } & Json): unknown {
  if (result.ok) return plain({ ok: true, value: result.value });
  return plain({ ok: false, code: result.code, issues: result.issues, head: result.head ?? null, pending: result.pending ?? null });
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const folder of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, folder);
    if (!fs.lstatSync(full).isDirectory()) continue;
    for (const name of fs.readdirSync(full).sort()) {
      if (name.startsWith('.tmp-')) continue;
      out[`${folder}/${name}`] = sha256Hex(fs.readFileSync(path.join(full, name)).toString('utf8'));
    }
  }
  return out;
}

const snapshot = (dir: string): Map<string, Buffer> => new Map(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name))]));
function restore(dir: string, files: Map<string, Buffer>): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  for (const [name, data] of files) fs.writeFileSync(path.join(dir, name), data, { mode: 0o444 });
}
const unlock = (file: string): void => {
  fs.chmodSync(file, 0o644);
};

export interface ConformanceReport {
  readonly steps: Array<{ readonly step: string; readonly result: unknown }>;
  readonly trees: { readonly afterWrites: unknown; readonly afterTamperRestore: unknown };
  readonly primitives: unknown;
  readonly storeNegatives: unknown;
}

export async function runConformanceScenario(): Promise<ConformanceReport> {
  clearStorageFatal();
  const decisionsDir = tmpDir('cf-d-');
  const anchorDir = tmpDir('cf-a-');
  let tick = 0;
  const clock = (): string => new Date(Date.UTC(2026, 9, 21, 12, 0, tick++)).toISOString();
  const service = (ops?: FsOps) => createDecisionService({ ledger: LEDGER_NOT_REQUIRED, knownHeads: WITNESS_NOT_REQUIRED, origin: TEST_ORIGIN, baseDir: decisionsDir, anchorDir, evidence, ...(ops ? { fs: ops } : {}) });
  const healthy = service();
  const steps: Array<{ step: string; result: unknown }> = [];
  const note = (step: string, result: unknown): void => void steps.push({ step, result });

  const empty = await healthy.list(ANA, AUDIT);
  note('list vazio', outcome(empty as never));

  const c1 = await healthy.create(ANA, AUDIT, { record: rec.c2(), expectedHead: null }, clock);
  note('cria C2 (histórico vazio)', outcome(c1 as never));
  const h1 = c1.ok ? c1.value.head : null;
  const c2 = await healthy.create(ANA, AUDIT, { record: rec.c3(), expectedHead: h1 }, clock);
  note('cria C3', outcome(c2 as never));
  const h2 = c2.ok ? c2.value.head : null;
  const c3 = await healthy.create(ANA, AUDIT, { record: rec.c2('PARTIAL'), supersedes: 'op-0001', expectedHead: h2 }, clock);
  note('substitui op-0001', outcome(c3 as never));
  const h3 = c3.ok ? c3.value.head : null;
  const c4 = await healthy.revoke(ANA, AUDIT, { revokes: 'op-0002', reason: REASON, expectedHead: h3 }, clock);
  note('revoga op-0002', outcome(c4 as never));
  const h4 = c4.ok ? c4.value.head : null;

  note('visão velha → HEAD_MISMATCH', outcome((await healthy.create(BIA, AUDIT, { record: rec.p3(), expectedHead: h1 }, clock)) as never));
  note('visão à frente → HISTORY_REGRESSED', outcome((await healthy.create(BIA, AUDIT, { record: rec.p3(), expectedHead: { seq: 99, sha256: 'a'.repeat(64) } }, clock)) as never));
  note('sem expectedHead → INVALID_BODY', outcome((await healthy.create(BIA, AUDIT, { record: rec.p3() }, clock)) as never));
  note('campo de pontuação → FORBIDDEN_FIELDS', outcome((await healthy.create(BIA, AUDIT, { record: rec.p3(), expectedHead: h4, points: 10 }, clock)) as never));
  note('auditId inválido', outcome((await healthy.list(ANA, 'curto')) as never));
  note('reenvio de confirmada', outcome((await healthy.create(ANA, AUDIT, { record: rec.c3(), expectedHead: h1 }, clock)) as never));

  // recibo que falha DEPOIS da decisão (ENOSPC no número 5) → pendente
  const noSpace = faulty({
    async writeExclusive(target, data, mode) {
      if (target.startsWith(anchorDir) && target.includes('.tmp-a0005')) throw errno('ENOSPC', 'sem espaço /mnt/secreto/ancora');
      return nodeFsOps.writeExclusive(target, data, mode);
    },
  });
  const pendingBody = { record: rec.p3(), expectedHead: h4 };
  note('recibo falha → ANCHOR_PENDING', outcome((await service(noSpace).create(ANA, AUDIT, pendingBody, clock)) as never));
  note('lista com pendente', outcome((await healthy.list(ANA, AUDIT)) as never));
  note('outro operador sobre a pendente', outcome((await healthy.create(BIA, AUDIT, { record: rec.naModel(), expectedHead: h4 }, clock)) as never));
  note('autor com outro pedido sobre a pendente', outcome((await healthy.create(ANA, AUDIT, { record: rec.naModel(), expectedHead: h4 }, clock)) as never));
  note('revogação alheia sobre a pendente', outcome((await healthy.revoke(BIA, AUDIT, { revokes: 'op-0003', reason: REASON, expectedHead: h4 }, clock)) as never));
  const resent = await healthy.create(ANA, AUDIT, pendingBody, clock);
  note('reenvio conclui a pendente', outcome(resent as never));
  note('reenvio repetido', outcome((await healthy.create(ANA, AUDIT, pendingBody, clock)) as never));
  const h5 = resent.ok ? resent.value.head : null;
  const c6 = await healthy.create(ANA, AUDIT, { record: rec.naModel(), expectedHead: h5 }, clock);
  note('cria N/A', outcome(c6 as never));
  const h6 = c6.ok ? c6.value.head : null;

  // erro fatal de disco (EIO) na pasta de âncoras: pendente, bloqueio, leitura continua, recuperação
  const eio = faulty({
    async link(from, to) {
      if (to.startsWith(anchorDir) && path.basename(to) === 'a0007.json') throw errno('EIO');
      return nodeFsOps.link(from, to);
    },
  });
  const fatalBody = { record: rec.nameEquivalence('Padaria Exemplo Ltda', 'Padaria Exemplo'), expectedHead: h6 };
  note('EIO no recibo → ANCHOR_PENDING', outcome((await service(eio).create(ANA, AUDIT, fatalBody, clock)) as never));
  note('escrita seguinte bloqueada', outcome((await healthy.create(BIA, AUDIT, { record: rec.p3(), expectedHead: h6 }, clock)) as never));
  note('leitura continua', outcome((await healthy.list(ANA, AUDIT)) as never));
  clearStorageFatal();
  const done = await healthy.create(ANA, AUDIT, fatalBody, clock);
  note('depois de reiniciar: reenvio conclui', outcome(done as never));

  const afterWrites = { decisions: tree(decisionsDir), anchors: tree(anchorDir) };
  note('lista final', outcome((await healthy.list(ANA, AUDIT)) as never));

  // adulterações: cada uma parte do estado íntegro e restaura no fim
  const dDir = path.join(decisionsDir, AUDIT);
  const aDir = path.join(anchorDir, AUDIT);
  const goodD = snapshot(dDir);
  const goodA = snapshot(aDir);
  const reset = (): void => {
    restore(dDir, goodD);
    restore(aDir, goodA);
  };
  const listNow = async (step: string): Promise<void> => note(step, outcome((await healthy.list(ANA, AUDIT)) as never));

  unlock(path.join(dDir, 'd0007.json'));
  fs.rmSync(path.join(dDir, 'd0007.json'));
  await listNow('adulteração: último arquivo apagado');
  reset();
  fs.rmSync(dDir, { recursive: true, force: true });
  await listNow('adulteração: pasta de decisões inteira apagada');
  reset();
  {
    const file = path.join(dDir, 'd0007.json');
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
    delete body.contentSha256;
    unlock(file);
    fs.writeFileSync(file, serialize(seal({ ...body, recordedBy: 'intruso@empresa.com' })));
    await listNow('adulteração: último arquivo re-selado');
  }
  reset();
  unlock(path.join(aDir, 'a0004.json'));
  fs.rmSync(path.join(aDir, 'a0004.json'));
  await listNow('adulteração: recibo do meio apagado');
  reset();
  for (const name of ['a0006.json', 'a0007.json']) {
    unlock(path.join(aDir, name));
    fs.rmSync(path.join(aDir, name));
  }
  await listNow('adulteração: dois últimos recibos apagados');
  reset();
  unlock(path.join(aDir, 'a0007.json'));
  fs.rmSync(path.join(aDir, 'a0007.json'));
  await listNow('último recibo apagado → pendente');
  reset();
  fs.writeFileSync(path.join(dDir, 'd0008.json.bak'), 'resto');
  await listNow('nome suspeito na pasta de decisões');
  reset();
  fs.writeFileSync(path.join(aDir, 'a0008.json.orig'), 'resto');
  await listNow('nome suspeito na pasta de recibos');
  reset();
  fs.writeFileSync(path.join(dDir, 'desktop.ini'), 'x');
  fs.writeFileSync(path.join(aDir, '.tmp-a0008.json-abc'), 'resto');
  await listNow('ruído comum e temporário órfão são ignorados');
  reset();
  {
    const file = path.join(aDir, 'a0002.json');
    unlock(file);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"anchoredAt"', '"anchoredAt "'));
    await listNow('adulteração: bytes do recibo alterados');
  }
  reset();
  await listNow('lista em estado íntegro depois de restaurar');
  const afterTamperRestore = { decisions: tree(decisionsDir), anchors: tree(anchorDir) };

  // primitivas puras (reexportadas pela 6B)
  const sample = { schemaVersion: 1, kind: 'AMOSTRA', auditId: AUDIT, seq: 1, texto: 'ação — acentuação', z: 1, a: [3, 2, 1] };
  const sealed = seal(sample);
  const tampered = { ...sealed, z: 2 };
  const primitives = plain({
    seal: sealed,
    serialize: serialize(sealed),
    hashOk: [hashOk(sealed), hashOk(tampered)],
    scrubPaths: [
      scrubPaths('erro em /srv/dados/privado/arquivo.json agora'),
      scrubPaths('falhou C:\\gmn\\segredo\\x.json'),
      scrubPaths('sem caminho nenhum'),
    ],
    splitNames: [
      splitNames(['d0003.json', 'd0001.json', 'd0002.json', 'D0004.JSON', 'd0005.json.bak', '.tmp-d0006.json-ab', 'desktop.ini', 'leia-me.txt'], ENTRY_FILE, 'd'),
      splitNames(['a0002.json', 'a0001.json', 'A0003.json', 'a0004.json.orig', '.tmp-a0005.json-ab', 'notas.txt'], ANCHOR_FILE, 'a'),
    ],
    assertBase: [
      assertBase('relativo/dir', '/srv/app', 'decisões'),
      assertBase('', '/srv/app', 'decisões'),
      assertBase('/srv/app/public/x', '/srv/app', 'decisões'),
      assertBase('/SRV/APP/SRC', '/srv/app', 'âncoras'),
      assertBase('/srv/dados/decisoes', '/srv/app', 'decisões'),
      assertBase('/srv/dados/\u0000x', '/srv/app', 'decisões'),
      assertBase(42, '/srv/app', 'decisões'),
    ],
    locateIn: [
      locateIn('/srv/dados/decisoes', AUDIT, '/srv/app', 'decisões'),
      locateIn('/srv/dados/decisoes', 'curto', '/srv/app', 'decisões'),
      locateIn('/srv/dados/decisoes', '../escape-01', '/srv/app', 'decisões'),
      locateIn('/srv/dados/decisoes', 'Auditoria-Maiuscula', '/srv/app', 'decisões'),
      locateIn('relativo', AUDIT, '/srv/app', 'âncoras'),
    ],
  });

  // leitura direta (nível do armazenamento): erros de configuração e de localização
  const missing = path.join(tmpDir('cf-miss-'), 'nao-existe');
  const storeNegatives = plain({
    anchorBaseMissing: await readLog(decisionsDir, AUDIT, { anchorDir: missing }),
    decisionsBaseMissing: await readLog(missing, AUDIT, { anchorDir }),
    invalidId: await readLog(decisionsDir, 'x', { anchorDir }),
    relativeBase: await readLog('relativo/dir', AUDIT, { anchorDir }),
    relativeAnchors: await readLog(decisionsDir, AUDIT, { anchorDir: 'relativo/ancoras' }),
    emptyAudit: await readLog(decisionsDir, 'auditoria-sem-nada-01', { anchorDir }),
  });
  clearStorageFatal();
  return { steps, trees: { afterWrites, afterTamperRestore }, primitives, storeNegatives };
}
