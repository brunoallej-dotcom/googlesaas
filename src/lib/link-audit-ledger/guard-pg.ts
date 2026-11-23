import { Client, type ClientConfig } from 'pg';
import { GUARD_RESPONSE_TIMEOUT_MS } from './guard';
import { createPostgresGuard, type GuardDbConnect } from './guard-postgres';
import type { GuardPseudonyms } from './guard-pseudonym';
import type { ExternalGuardPort } from './guard';

/*
 * CONECTOR `pg` da guarda externa (G1.b.2a). ÚNICO arquivo do projeto que importa `pg` (teste de isolamento). Um `Client` por chamada (sem pool: as
 * rotas montam o livro por requisição e um pool por requisição vazaria conexões), sempre encerrado pelo adaptador.
 *
 * TLS OBRIGATÓRIO E VERIFICADO (o `verify-full` do libpq): `ssl.rejectUnauthorized: true` com a CA FORNECIDA (`GMN_LINK_AUDIT_GUARD_DB_CA`; o Supabase
 * assina os certificados do banco com a CA própria dele, que não está no repositório de CAs do sistema) e conferência do nome do host pelo Node.
 * Servidor que recusa TLS, certificado de outra CA ou de outro nome ⇒ a conexão falha e nada da sessão sai em claro (o `pg` só envia o pedido de TLS
 * antes do aperto de mão). Nunca existe caminho sem verificação: não há `rejectUnauthorized: false`, `sslmode=no-verify` nem fallback.
 *
 * CONFIGURAÇÃO EXPLÍCITA: host, porta, banco, usuário, senha, TLS e prazos vêm do destino validado em `config.ts`; nada de string de conexão
 * (a semântica de `sslmode` do `pg-connection-string` não entra) e os campos da conexão nunca caem para as variáveis `PG*` do ambiente nem para o
 * `.pgpass` (a senha é sempre explícita). PRAZOS no driver (D-G0-3): 3 s para conectar e 3 s de leitura por consulta; o servidor tem os seus pelo
 * papel (`statement_timeout`/`lock_timeout` de 3 s na migração 004) e o adaptador encerra a conexão no prazo de 3 s da chamada.
 */
export const GUARD_DB_APPLICATION_NAME = 'gmn-link-audit-guard';

/** Destino validado da guarda (montado por `config.ts`). A senha é propriedade NÃO enumerável (não aparece num JSON nem num `inspect`). */
export interface GuardDbTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  /** CA (PEM, pública) que ancora a verificação do certificado do servidor. */
  readonly caPem: string;
}
/** O que o resto do livro recebe da configuração para montar a guarda. */
export interface GuardSettings {
  readonly target: GuardDbTarget;
  readonly pseudonyms: GuardPseudonyms;
}

const MAX_PORT = 65_535;

/** Recusa (lança sem citar segredo) um destino que a configuração nunca deveria produzir: defesa em profundidade. */
function assertTarget(target: GuardDbTarget): void {
  if (!target.caPem) throw new Error('guarda: destino sem CA (TLS verificado é obrigatório)');
  if (!target.host || target.host.startsWith('/')) throw new Error('guarda: host inválido (soquete Unix não tem TLS)');
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > MAX_PORT) throw new Error('guarda: porta inválida');
  if (!target.user || !target.password || !target.database) throw new Error('guarda: usuário, senha ou banco ausentes');
}

/** Configuração do `Client` (exportada para o teste conferir o TLS e os prazos). */
export function pgClientConfig(target: GuardDbTarget): ClientConfig {
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    ssl: { rejectUnauthorized: true, ca: target.caPem, minVersion: 'TLSv1.2' },
    connectionTimeoutMillis: GUARD_RESPONSE_TIMEOUT_MS,
    query_timeout: GUARD_RESPONSE_TIMEOUT_MS,
    application_name: GUARD_DB_APPLICATION_NAME,
    keepAlive: false,
  };
}

/** Abre uma conexão por chamada. `factory` é injetável só em teste. */
export function pgGuardConnector(target: GuardDbTarget, factory: (config: ClientConfig) => Client = (config) => new Client(config)): GuardDbConnect {
  assertTarget(target);
  return async () => {
    const client = factory(pgClientConfig(target));
    // Erro de soquete depois da conexão: a consulta em curso já rejeita (e o adaptador responde indisponível); sem ouvinte, o `pg` emitiria
    // `error` sem tratamento e derrubaria o processo.
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (error) {
      void client.end().catch(() => undefined); // o pg já destruiu o soquete na maioria dos casos; garante o encerramento nos outros
      throw error; // o adaptador transforma em indisponível (nunca "nenhuma cabeça")
    }
    return {
      async query(text, values) {
        const result = await client.query({ text, values: [...values] });
        return { rows: result.rows };
      },
      end: () => client.end(),
    };
  };
}

/** A guarda real das rotas: o adaptador Postgres sobre o conector TLS. */
export function postgresGuardFor(settings: GuardSettings): ExternalGuardPort {
  return createPostgresGuard({ pseudonyms: settings.pseudonyms, connect: pgGuardConnector(settings.target) });
}
