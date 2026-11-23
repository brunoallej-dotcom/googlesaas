import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { createPostgresGuard } from '../src/lib/link-audit-ledger/guard-postgres';
import { GUARD_DB_APPLICATION_NAME, pgClientConfig, pgGuardConnector, type GuardDbTarget } from '../src/lib/link-audit-ledger/guard-pg';
import { registerCleanup, tmpDir } from './helpers/link-audit-decisions-fixtures';
import { PSEUDONYMS_A } from './helpers/link-audit-guard-db-fixtures';

/*
 * G1.b.2a — CONECTOR `pg` da guarda (`guard-pg.ts`): TLS OBRIGATÓRIO e VERIFICADO (cadeia até a CA fornecida E nome do host, o `verify-full` do
 * libpq), prazos de 3 s no driver, `Client` por chamada (sem pool), configuração explícita (sem string de conexão, sem `PG*` do ambiente para os
 * campos da conexão). Os servidores destes testes são LOCAIS (loopback; sob `scripts/run-isolated.sh`, o do namespace sem rede) e não falam
 * Postgres de verdade: só o suficiente para provar que nada sai em claro e que um certificado não confiável é recusado. Certificados de teste
 * gerados na hora com o `openssl` do sistema (pasta temporária; nenhuma chave no repositório); sem `openssl`, os testes de TLS são pulados.
 */
registerCleanup();
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
const USER = 'gmn_guard_writer';
const SENTINELA = 'sentinela-de-teste';

interface TestPki {
  readonly caPem: string;
  readonly otherCaPem: string;
  /** certificado do servidor 127.0.0.1 assinado pela CA confiável */
  readonly good: { readonly key: string; readonly cert: string };
  /** assinado pela CA confiável, mas para OUTRO nome (verify-full recusa) */
  readonly wrongHost: { readonly key: string; readonly cert: string };
  /** 127.0.0.1, mas de OUTRA CA (cadeia não confere) */
  readonly untrusted: { readonly key: string; readonly cert: string };
}
function makePki(): TestPki | null {
  if (spawnSync('openssl', ['version']).status !== 0) return null;
  const dir = tmpDir('lad-pki-');
  const run = (...args: string[]): void => {
    const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`openssl ${args[0]}: ${result.stderr}`);
  };
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  const ca = (name: string): void => run('req', '-x509', ...ec, '-keyout', `${name}.key`, '-out', `${name}.pem`, '-days', '1', '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  const leaf = (name: string, issuer: string, san: string): { key: string; cert: string } => {
    run('req', ...ec, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
    fs.writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=${san}\n`);
    run('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-CAcreateserial', '-out', `${name}.pem`, '-days', '1', '-extfile', `${name}.ext`);
    return { key: fs.readFileSync(path.join(dir, `${name}.key`), 'utf8'), cert: fs.readFileSync(path.join(dir, `${name}.pem`), 'utf8') };
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
const PKI = makePki();

const targetOf = (port: number, caPem: string): GuardDbTarget => Object.defineProperty({ host: '127.0.0.1', port, database: 'postgres', user: USER, caPem }, 'password', { value: SENTINELA, enumerable: false }) as GuardDbTarget;

/** Servidor local que responde ao SSLRequest com `reply` e, com 'S', faz o TLS do lado do servidor; registra tudo o que chega (em claro e decifrado). */
async function fakeServer(reply: 'N' | 'S', cert?: { key: string; cert: string }) {
  const raw: Buffer[] = [];
  const decrypted: Buffer[] = [];
  const state = { tlsEstablished: false, connections: 0 };
  const server = net.createServer((socket) => {
    state.connections += 1;
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => raw.push(chunk));
    socket.once('data', () => {
      socket.write(reply);
      if (reply === 'N' || !cert) return;
      socket.pause();
      const secure = new tls.TLSSocket(socket, { isServer: true, key: cert.key, cert: cert.cert });
      secure.on('error', () => undefined);
      secure.on('secure', () => {
        state.tlsEstablished = true;
      });
      secure.on('data', (chunk) => {
        decrypted.push(chunk);
        secure.destroy(); // não é um Postgres: encerra depois de ver a mensagem de início, já DENTRO do TLS
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, raw, decrypted, state, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/* ============================================================================ configuração do cliente */

test('TLS obrigatório na configuração do cliente: ssl sempre com rejectUnauthorized e a CA fornecida; prazos de 3 s no driver; nada de string de conexão, pool ou keepAlive', () => {
  const caPem = PKI?.caPem ?? 'ca';
  const config = pgClientConfig(targetOf(5432, caPem));
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, ca: caPem, minVersion: 'TLSv1.2' });
  assert.equal(config.connectionTimeoutMillis, 3_000);
  assert.equal(config.query_timeout, 3_000);
  assert.equal(config.keepAlive, false);
  assert.equal(config.application_name, GUARD_DB_APPLICATION_NAME);
  assert.equal(config.password, SENTINELA, 'a senha vai explícita (o pg nunca cai para PGPASSWORD nem para o .pgpass)');
  assert.deepEqual([config.host, config.port, config.database, config.user], ['127.0.0.1', 5432, 'postgres', USER]);
  assert.ok(!('connectionString' in config), 'sem string de conexão (a interpretação de sslmode do pg-connection-string não entra)');
  assert.equal(JSON.stringify(targetOf(5432, caPem)).includes(SENTINELA), false, 'a senha do destino não é enumerável (não vaza num JSON)');
});

test('o conector recusa (lança, sem citar segredo) destino sem CA, com soquete Unix, sem senha, sem usuário ou com porta inválida', () => {
  const good = targetOf(5432, 'ca');
  const variants: Array<[string, GuardDbTarget]> = [
    ['sem CA', { ...good, caPem: '', password: SENTINELA } as GuardDbTarget],
    ['soquete Unix', { ...good, host: '/var/run/postgresql', password: SENTINELA } as GuardDbTarget],
    ['sem senha', { ...good, password: '' } as GuardDbTarget],
    ['sem usuário', { ...good, user: '', password: SENTINELA } as GuardDbTarget],
    ['porta inválida', { ...good, port: 0, password: SENTINELA } as GuardDbTarget],
  ];
  for (const [label, target] of variants) {
    assert.throws(() => pgGuardConnector(target), (error: unknown) => error instanceof Error && !error.message.includes(SENTINELA), label);
  }
});

test('o conector registra o ouvinte de erro ANTES de conectar (erro de soquete depois da conexão nunca derruba o processo) e encerra o cliente que falhou ao conectar', async () => {
  const calls: string[] = [];
  const fakeClient = {
    on(event: string) {
      calls.push(`on:${event}`);
      return fakeClient;
    },
    async connect() {
      calls.push('connect');
      throw new Error('sentinela: recusada');
    },
    async end() {
      calls.push('end');
    },
    async query() {
      calls.push('query');
      return { rows: [] };
    },
  };
  // o tipo do Client do pg é largo; o teste injeta só o que o conector usa
  const connect = pgGuardConnector(targetOf(5432, 'ca'), () => fakeClient as unknown as import('pg').Client);
  await assert.rejects(connect());
  assert.deepEqual(calls, ['on:error', 'connect', 'end']);
});

/* ============================================================================ o driver de verdade contra servidores locais */

test('TLS obrigatório no driver real: servidor que RECUSA TLS (responde N ao SSLRequest) ⇒ conexão recusada, nada em claro além do pedido de TLS — nem o usuário; o adaptador responde indisponível', async () => {
  const server = await fakeServer('N');
  try {
    const connect = pgGuardConnector(targetOf(server.port, PKI?.caPem ?? 'ca'));
    await assert.rejects(connect(), /does not support SSL/);
    const guard = createPostgresGuard({ pseudonyms: PSEUDONYMS_A, connect });
    assert.deepEqual(await guard.latest('auditoria-guarda-07'), { ok: false });
    assert.deepEqual(await guard.publish({ auditId: 'auditoria-guarda-07', ledgerSeq: 1, sha256: 'a'.repeat(64) }), { ok: false, reason: 'UNAVAILABLE' });
    const sent = Buffer.concat(server.raw);
    assert.equal(sent.length % SSL_REQUEST.length, 0);
    for (let offset = 0; offset < sent.length; offset += SSL_REQUEST.length) assert.deepEqual(sent.subarray(offset, offset + SSL_REQUEST.length), SSL_REQUEST, 'só o SSLRequest');
    assert.ok(!sent.includes(USER) && !sent.includes(SENTINELA) && !sent.includes('auditoria-'), 'nada da sessão em claro');
  } finally {
    await server.close();
  }
});

test('TLS verificado no driver real (verify-full): certificado de OUTRA CA ⇒ recusado; certificado da CA confiável para OUTRO nome ⇒ recusado; nenhum dos dois recebe a mensagem de início', { skip: PKI === null ? 'openssl ausente' : false }, async () => {
  const pki = PKI as TestPki;
  for (const [label, cert] of [['outra CA', pki.untrusted], ['outro nome', pki.wrongHost]] as const) {
    const server = await fakeServer('S', cert);
    try {
      await assert.rejects(pgGuardConnector(targetOf(server.port, pki.caPem))(), (error: unknown) => error instanceof Error && /certificate|altnames|Hostname|IP: 127\.0\.0\.1/i.test(error.message), label);
      assert.equal(server.decrypted.length, 0, `${label}: a mensagem de início nunca chegou`);
      assert.ok(!Buffer.concat(server.raw).includes(USER), `${label}: o usuário nunca saiu em claro`);
    } finally {
      await server.close();
    }
  }
  assert.ok(new X509Certificate(pki.caPem).ca, 'a CA de teste é uma CA');
});

test('TLS verificado no driver real: com o certificado da CA fornecida para 127.0.0.1, o TLS fecha e só DEPOIS a mensagem de início (com o usuário) é enviada — cifrada', { skip: PKI === null ? 'openssl ausente' : false }, async () => {
  const pki = PKI as TestPki;
  const server = await fakeServer('S', pki.good);
  try {
    await assert.rejects(pgGuardConnector(targetOf(server.port, pki.caPem))()); // o servidor de teste não é um Postgres: encerra depois da mensagem de início
    assert.equal(server.state.tlsEstablished, true, 'TLS estabelecido contra a CA fornecida');
    assert.ok(Buffer.concat(server.decrypted).includes(USER), 'a mensagem de início chegou DENTRO do TLS');
    assert.ok(!Buffer.concat(server.raw).includes(USER), 'e nunca em claro no fio');
    assert.ok(Buffer.concat(server.decrypted).includes(GUARD_DB_APPLICATION_NAME));
  } finally {
    await server.close();
  }
});
