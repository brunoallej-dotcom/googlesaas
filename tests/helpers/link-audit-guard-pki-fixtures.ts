import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './link-audit-decisions-fixtures';

/*
 * G1.b.2a — PKI DE TESTE da guarda, gerada NA HORA com o `openssl` do sistema numa pasta temporária (apagada pelo `registerCleanup` dos testes):
 * nenhum certificado nem chave entra no repositório. Duas CAs (a "fornecida" e outra) e três certificados de servidor. Sem `openssl`, `makeTestPki`
 * devolve `null` e os testes que precisam de TLS ou de uma CA válida são pulados.
 */
export interface TestPki {
  readonly caPem: string;
  readonly otherCaPem: string;
  /** certificado do servidor 127.0.0.1 assinado pela CA fornecida */
  readonly good: { readonly key: string; readonly cert: string };
  /** assinado pela CA fornecida, mas para OUTRO nome (verify-full recusa) */
  readonly wrongHost: { readonly key: string; readonly cert: string };
  /** 127.0.0.1, mas de OUTRA CA (a cadeia não confere) */
  readonly untrusted: { readonly key: string; readonly cert: string };
}

export function makeTestPki(): TestPki | null {
  if (spawnSync('openssl', ['version']).status !== 0) return null;
  const dir = tmpDir('lad-pki-');
  const run = (...args: string[]): void => {
    const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`openssl ${args[0]}: ${result.stderr}`);
  };
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  const ca = (name: string): void => run('req', '-x509', ...ec, '-keyout', `${name}.priv.pem`, '-out', `${name}.pem`, '-days', '1', '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  const leaf = (name: string, issuer: string, san: string): { key: string; cert: string } => {
    run('req', ...ec, '-keyout', `${name}.priv.pem`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
    fs.writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=${san}\n`);
    run('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.priv.pem`, '-CAcreateserial', '-out', `${name}.pem`, '-days', '1', '-extfile', `${name}.ext`);
    return { key: fs.readFileSync(path.join(dir, `${name}.priv.pem`), 'utf8'), cert: fs.readFileSync(path.join(dir, `${name}.pem`), 'utf8') };
  };
  ca('gmn-teste-ca');
  ca('outra-ca');
  return {
    caPem: fs.readFileSync(path.join(dir, 'gmn-teste-ca.pem'), 'utf8'),
    otherCaPem: fs.readFileSync(path.join(dir, 'outra-ca.pem'), 'utf8'),
    good: leaf('servidor', 'gmn-teste-ca', 'IP:127.0.0.1'),
    wrongHost: leaf('outro-nome', 'gmn-teste-ca', 'DNS:outro-nome.invalid'),
    untrusted: leaf('intruso', 'outra-ca', 'IP:127.0.0.1'),
  };
}
