import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { quarantineDirOf, registerCleanup, world } from './link-audit-decisions-fixtures';

/*
 * Processo FILHO de tests/link-audit-quarantine-isolation.test.ts: cria um ambiente de teste e o diretório de quarentena, grava um arquivo nele e
 * informa os caminhos num arquivo de relatório. Ao sair, o `registerCleanup()` deve apagar tudo; quem confere é o processo pai.
 * Dados fictícios; nenhuma rede.
 */
registerCleanup();

test('filho: cria um ambiente e uma quarentena, informa os caminhos e deixa a limpeza para o registerCleanup', async () => {
  const w = await world({ seed: false });
  const quarantine = quarantineDirOf(w, w.auditId);
  if (!fs.statSync(quarantine).isDirectory()) throw new Error('a quarentena deveria existir como diretório');
  fs.writeFileSync(path.join(quarantine, 'd0002.json'), '{}');
  const report = process.env.QUARANTINE_REPORT;
  if (!report) throw new Error('QUARANTINE_REPORT ausente');
  fs.writeFileSync(report, JSON.stringify({ quarantine, decisions: w.decisionsDir, anchors: w.anchorDir, evidence: w.evidenceDir }));
});
