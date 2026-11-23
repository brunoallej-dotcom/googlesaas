import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isYamlMap, parseYamlSubset, type YamlMap, type YamlValue } from './helpers/yaml-subset';

/**
 * Teste ESTÁTICO dos arquivos de implantação (deploy/hostinger): nada aqui sobe container, abre rede ou lê segredos.
 * Garante as regras de isolamento e segurança combinadas para a stack Swarm.
 */
const ROOT = path.join(__dirname, '..');
const DEPLOY = path.join(ROOT, 'deploy', 'hostinger');
const read = (name: string): string => fs.readFileSync(path.join(DEPLOY, name), 'utf8');
/** Pastas de dados privados declaradas no .gitignore (a seção "dados privados"), lidas da própria regra. */
const gitignorePrivateDirs = (): string[] => {
  const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n');
  const start = lines.findIndex((line) => /^#.*dados privados/i.test(line));
  const dirs: string[] = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (line.startsWith('#') || line.trim() === '') break;
    const rule = /^\/([^/*]+)\/$/.exec(line.trim());
    if (rule?.[1]) dirs.push(rule[1]);
  }
  return dirs;
};
const stack = read('stack.yml');
const dockerfile = read('Dockerfile');
const entrypoint = read('docker-entrypoint.sh');
const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
const stripComments = (text: string): string => text.replace(/^\s*#.*$/gm, '').replace(/\s+#\s.*$/gm, '');
/** P9.4: os nomes do Traefik são `${GMN_TRAEFIK_NAME:-gmn}`; com o padrão (produção), viram `gmn`. */
const TRAEFIK_NAME_VAR = '${GMN_TRAEFIK_NAME:-gmn}';
const renderTraefikName = (text: string, name = 'gmn'): string => text.split(TRAEFIK_NAME_VAR).join(name);

/** Bloco de um serviço da stack (do cabeçalho `  nome:` até o próximo serviço ou seção de topo). */
function serviceBlock(name: string): string {
  const lines = stripComments(stack).split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start >= 0, `serviço ${name} ausente`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i] ?? '') || /^[A-Za-z]/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const EXTERNAL_NETWORK = 'automacaotrafegopagoredeinterna';

test('stack: nomes de serviço com prefixo gmn (o alias DNS na rede compartilhada não pode colidir com "web"/"worker" de outras stacks)', () => {
  const services = [...stripComments(stack).matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((m) => m[1]).filter((n) => ['gmn-web', 'gmn-worker', 'gmn-redis', 'web', 'worker', 'redis'].includes(n ?? ''));
  assert.deepEqual(services.sort(), ['gmn-redis', 'gmn-web', 'gmn-worker']);
});

test('stack: só imagens pré-construídas, nenhuma porta publicada e nenhum bypass de autenticação', () => {
  const code = stripComments(stack);
  assert.ok(!/^\s*build:/m.test(code), 'sem build: dentro do stack deploy');
  assert.ok(!/^\s*ports:/m.test(code), 'nenhum serviço publica porta (nem Next.js nem Redis)');
  assert.ok(!/GMN_AUTH_DISABLED|GMN_DEMO_MODE/.test(code));
  assert.match(code, /image: gmn-web:\$\{GMN_IMAGE_TAG(?::\?[^}]*)?\}/);
  assert.match(code, /image: gmn-worker:\$\{GMN_IMAGE_TAG(?::\?[^}]*)?\}/);
  assert.match(code, /image: redis:\d+\.\d+\.\d+-alpine/, 'versão do Redis fixada');
  assert.ok(!/:latest\b/.test(code), 'nenhuma imagem :latest');
});

test('redes: só o serviço web entra na rede externa do Traefik; Redis e Worker ficam na rede privada', () => {
  assert.match(serviceBlock('gmn-web'), new RegExp(`- ${EXTERNAL_NETWORK}`));
  assert.ok(!serviceBlock('gmn-worker').includes(EXTERNAL_NETWORK), 'worker fora da rede externa');
  assert.ok(!serviceBlock('gmn-redis').includes(EXTERNAL_NETWORK), 'redis fora da rede externa');
  for (const name of ['gmn-web', 'gmn-worker', 'gmn-redis']) assert.match(serviceBlock(name), /- gmn_internal/);
  const code = stripComments(stack);
  assert.match(code, new RegExp(`${EXTERNAL_NETWORK}:\\n\\s+external: true`), 'rede existente: external, nunca criada nem alterada');
  assert.match(code, /gmn_internal:\n\s+driver: overlay/);
  assert.ok(!/internal: true/.test(code), 'a rede privada precisa de saída (Supabase/Serper); isolamento vem do Redis só nela');
});

test('Traefik: labels exclusivas em deploy.labels, TLS, resolver, rede e porta corretos', () => {
  const web = serviceBlock('gmn-web');
  const labelsAt = web.indexOf('labels:');
  const deployAt = web.indexOf('\n    deploy:');
  assert.ok(deployAt >= 0 && labelsAt > deployAt, 'labels dentro de deploy');
  const labels = renderTraefikName(web.slice(labelsAt));
  for (const expected of [
    'traefik.enable=true',
    `traefik.swarm.network=${EXTERNAL_NETWORK}`,
    'traefik.http.routers.gmn.rule=Host(`${GMN_HOST}`)',
    'traefik.http.routers.gmn.entrypoints=websecure',
    'traefik.http.routers.gmn.tls=true',
    'traefik.http.routers.gmn.tls.certresolver=letsencryptresolver',
    'traefik.http.services.gmn.loadbalancer.server.port=3000',
    'traefik.http.services.gmn.loadbalancer.passhostheader=true',
    'traefik.http.middlewares.gmn-headers.headers.stsSeconds=31536000',
  ]) assert.ok(labels.includes(expected), `label ausente: ${expected}`);
  // nenhum nome genérico que pudesse colidir com roteadores de outras stacks
  const names = [...labels.matchAll(/traefik\.http\.(?:routers|services|middlewares)\.([a-z0-9-]+)\./g)].map((m) => m[1]);
  assert.ok(names.every((name) => name?.startsWith('gmn')), `nomes Traefik fora do prefixo gmn: ${[...new Set(names)].join(',')}`);
  assert.ok(!/passhostheader=false/i.test(labels), 'Host original preservado (a checagem de origem do login depende dele)');
  assert.ok(!/forwardedHeaders\.insecure/i.test(labels));
  assert.ok(!/^\s*- traefik\.docker\./m.test(labels), 'sem labels do provider Docker (o Traefik usa o provider Swarm)');
  assert.ok(!web.slice(0, deployAt).includes('traefik.'), 'labels de serviço não ficam no nível do container');
});

test('Worker: nasce desligado, encerra com calma, isolado e sem credenciais de outros provedores', () => {
  const worker = serviceBlock('gmn-worker');
  assert.match(worker, /replicas: \$\{GMN_WORKER_REPLICAS:-0\}/, 'trava de ativação: o padrão é 0 réplicas');
  assert.match(read('.env.production.example'), /^GMN_WORKER_REPLICAS=0$/m, 'o exemplo de produção nasce com o Worker desligado');
  assert.match(worker, /NODE_OPTIONS: --max-old-space-size=768/);
  assert.match(worker, /stop_grace_period: 30m/);
  assert.match(worker, /GMN_ROLE: worker/);
  assert.match(worker, /GMN_WORKER_CONCURRENCY: \$\{GMN_WORKER_CONCURRENCY:-1\}/);
  assert.ok(!/DATAFORSEO|LLM_API_KEY|GMN_REVIEWS_PROVIDER/.test(worker), 'nenhum provedor pago extra habilitado');
  assert.match(worker, /read_only: true/);
});

test('Redis exclusivo: senha só por arquivo de secret, usuário não-root, noeviction, persistência, sem porta, rede privada', () => {
  const redis = serviceBlock('gmn-redis');
  assert.match(redis, /user: "999:1000"/, 'não roda como root');
  assert.match(redis, /- \/run\/secrets\/gmn_redis_conf/, 'senha vem de arquivo de configuração entregue por secret');
  assert.ok(!/--requirepass/.test(redis), 'senha nunca na linha de comando (visível em ps)');
  assert.match(redis, /REDISCLI_AUTH=/, 'healthcheck sem -a na linha de comando');
  assert.match(redis, /- noeviction/);
  assert.match(redis, /- "yes"/);
  assert.match(redis, /cap_drop:\n\s+- ALL/);
  assert.match(redis, /hostname: gmn-redis/);
  assert.ok(!/^\s*ports:/m.test(redis));
  assert.match(redis, /memory: 512M/, 'folga para o fork do AOF dentro do limite');
});

test('web e worker: somente leitura, sem capacidades, tmpfs em forma longa, healthcheck e política de reinício', () => {
  const web = serviceBlock('gmn-web');
  assert.match(web, /read_only: true/);
  assert.match(web, /cap_drop:\n\s+- ALL/);
  assert.match(web, /- type: tmpfs\n\s+target: \/tmp/, 'tmpfs em forma longa (a curta pode ser ignorada pelo Swarm)');
  assert.match(web, /- type: tmpfs\n\s+target: \/app\/\.next\/cache/);
  assert.ok(!/^\s{4}tmpfs:/m.test(web), 'sem a forma curta tmpfs:');
  assert.match(web, /healthcheck:[\s\S]*\/login/);
  assert.match(web, /restart_policy:\n\s+condition: any/);
  assert.match(web, /failure_action: rollback/);
  assert.match(web, /NODE_OPTIONS: --max-old-space-size=768/);
  assert.match(web, /GMN_HOST: \$\{GMN_HOST:\?/, 'variáveis obrigatórias com mensagem clara');
  const worker = serviceBlock('gmn-worker');
  assert.match(worker, /cap_drop:\n\s+- ALL/);
  assert.match(worker, /- type: tmpfs\n\s+target: \/tmp/);
  assert.match(worker, /restart_policy:\n\s+condition: on-failure/);
  assert.match(stack, /GMN_NODE_HOSTNAME:\?/);
});

test('segredos: todos externos (docker secret), nenhum valor em arquivo de implantação', () => {
  const code = stripComments(stack);
  const section = code.slice(code.indexOf('\nsecrets:'));
  const names = [...section.matchAll(/^ {2}(gmn_[a-z_]+):\n\s+external: true/gm)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ['gmn_link_audit_guard_db_ca', 'gmn_link_audit_guard_db_url', 'gmn_link_audit_guard_key', 'gmn_link_audit_ledger_key', 'gmn_link_audit_log_key', 'gmn_link_audit_origin_key', 'gmn_redis_conf', 'gmn_redis_password', 'gmn_redis_url', 'gmn_serper_api_key', 'gmn_supabase_anon', 'gmn_supabase_service_role']);
  for (const file of ['stack.yml', 'Dockerfile', 'docker-entrypoint.sh', '.env.production.example']) {
    const text = read(file);
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(text), `${file}: parece conter um JWT`);
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(text), `${file}: parece conter uma chave`);
    assert.ok(!/(?:SERVICE_ROLE|SERPER_API_KEY|REDIS_PASSWORD)\s*[=:]\s*['"]?[A-Za-z0-9+/_-]{16,}/.test(stripComments(text)), `${file}: segredo literal`);
  }
  const web = serviceBlock('gmn-web');
  for (const variable of ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SERPER_API_KEY', 'REDIS_URL']) {
    assert.match(web, new RegExp(`${variable}_FILE: /run/secrets/`), `${variable} por arquivo`);
  }
});

test('volumes: dados fora da imagem, evidências somente leitura, nada de Docker socket', () => {
  const web = serviceBlock('gmn-web');
  assert.match(web, /target: \/data\/evidence\n\s+read_only: true/);
  assert.match(web, /target: \/app\/\.data\/audits/);
  assert.match(web, /target: \/app\/\.data\/link-audits/);
  assert.match(serviceBlock('gmn-worker'), /target: \/app\/\.data\/audits/);
  assert.ok(!/docker\.sock/.test(stack));
  assert.match(web, /GMN_LINK_AUDIT_EVIDENCE_DIR: \/data\/evidence/);
});

test('recursos: soma dos limites compatível com a VPS de 7,8 GB (que já abriga outros serviços)', () => {
  const limits = [...stripComments(stack).matchAll(/limits:\n\s+cpus: "([\d.]+)"\n\s+memory: (\d+)M/g)].map((m) => ({ cpus: Number(m[1]), mem: Number(m[2]) }));
  assert.equal(limits.length, 3);
  assert.ok(limits.reduce((s, l) => s + l.mem, 0) <= 2560, 'memória total até 2,5 GB');
  assert.ok(limits.reduce((s, l) => s + l.cpus, 0) <= 2.5);
  assert.ok(stripComments(stack).split('json-file').length - 1 >= 3, 'logs com rotação em todos os serviços');
  assert.ok((stripComments(stack).match(/max-size: "10m"/g) ?? []).length >= 3);
});

test('Dockerfile: multi-stage, não-root, versões fixas, sem segredos e sem copiar o projeto inteiro', () => {
  const code = stripComments(dockerfile);
  assert.match(code, /ARG NODE_IMAGE=node:22\.\d+\.\d+-bookworm-slim/);
  assert.ok(!/^COPY \. /m.test(code), 'nunca COPY . .');
  assert.ok(!/^FROM .*:latest/m.test(code));
  assert.match(code, /AS web[\s\S]*USER 10001:10001[\s\S]*AS worker[\s\S]*USER 10001:10001/);
  assert.match(code, /HEALTHCHECK[\s\S]*\/login/);
  assert.match(code, /CMD \["node","server\.js"\]/);
  assert.match(code, /CMD \["node","--import","tsx","src\/workers\/audit-worker\.ts"\]/, 'worker chama node direto (sem npm run)');
  assert.ok(!/npm run worker/.test(code));
  assert.match(code, /npm ci --omit=dev/);
  assert.match(code, /tini/);
  const envLines = code.split('\n').filter((line) => /^\s*(ENV|ARG)\b/.test(line)).join('\n');
  assert.ok(!/SERVICE_ROLE|SERPER|PASSWORD|REDIS_URL|OPERATOR/.test(envLines), 'nenhum segredo como ENV/ARG de build');
  assert.match(envLines, /NEXT_PUBLIC_SUPABASE_URL/);
});

test('.dockerignore: .env, dados, testes, docs e node_modules do host ficam fora do contexto', () => {
  for (const entry of ['.env', '.env.*', '.data', 'node_modules', '.next', 'tests', 'docs', 'scripts', '*.pdf', 'deploy/*', '!deploy/hostinger/docker-entrypoint.sh']) {
    assert.ok(dockerignore.split('\n').includes(entry), `.dockerignore sem ${entry}`);
  }
  assert.ok(dockerignore.split('\n').includes('!.env.example'));
});

test('entrypoint: falha fechada (produção, sem bypass, sem demo, sem .env, REDIS exclusivo)', () => {
  assert.match(entrypoint, /set -eu/);
  assert.match(entrypoint, /NODE_ENV:-\}" = "production"/);
  assert.match(entrypoint, /GMN_AUTH_DISABLED/);
  assert.match(entrypoint, /GMN_DEMO_MODE/);
  assert.match(entrypoint, /find \/app -maxdepth 1 -name '\.env\*'/);
  assert.match(entrypoint, /gmn-redis/);
  assert.match(entrypoint, /exec "\$@"/);
  assert.match(entrypoint, /exit 78/);
});

test('guia e planos de implantação existem e cobrem rollback, backup, migração por SHA-256 e verificação', () => {
  for (const file of ['GUIA-DE-IMPLANTACAO.md', 'CHECKLIST-DE-SEGURANCA.md', 'PLANO-DE-MIGRACAO-DE-EVIDENCIAS.md', 'PLANO-DE-BACKUP-E-RESTAURACAO.md', 'PLANO-DE-ROLLBACK.md', 'VERIFICACAO-POS-DEPLOY.md']) {
    assert.ok(fs.existsSync(path.join(DEPLOY, file)), `${file} ausente`);
  }
  assert.match(read('PLANO-DE-MIGRACAO-DE-EVIDENCIAS.md'), /sha256sum -c/);
  assert.match(read('GUIA-DE-IMPLANTACAO.md'), /docker service scale gmn_gmn-worker=1/);
  assert.match(read('PLANO-DE-ROLLBACK.md'), /docker service rollback/);
});

test('bundle de produção (quando existe um build): o bypass GMN_AUTH_DISABLED não está no código do servidor', (t2) => {
  const server = path.join(ROOT, '.next', 'server');
  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID')) || !fs.existsSync(server)) {
    t2.skip('sem build de produção em .next (rode npm run build)');
    return;
  }
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.js$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('GMN_AUTH_DISABLED')) hits.push(path.relative(ROOT, full));
    }
  };
  walk(server);
  assert.deepEqual(hits, [], 'o build de produção fixa NODE_ENV e elimina o código do bypass');
});

test('guias: permissões de /srv/gmn, backup fora do original e hash agregado independente do idioma', () => {
  const guide = read('GUIA-DE-IMPLANTACAO.md');
  assert.match(guide, /install -d -m 0755 -o root -g root \/srv\/gmn \/opt\/gmn/);
  assert.match(guide, /\/opt\/gmn\/\.env\.production/);
  assert.match(guide, /GMN_WORKER_REPLICAS=1/);
  const migration = read('PLANO-DE-MIGRACAO-DE-EVIDENCIAS.md');
  assert.ok(!/(?<!LC_ALL=C )sort -z/.test(migration), 'sempre LC_ALL=C sort -z');
  assert.match(migration, /--rsync-path='sudo rsync'/);
  const backup = read('PLANO-DE-BACKUP-E-RESTAURACAO.md');
  // Repositório público: os destinos locais são marcadores, nunca caminhos reais da máquina do responsável.
  assert.ok(!/\/(?:mnt\/[a-z]|home|Users|media|root)\/|\b[A-Za-z]:\\[^\\\s`]/.test(backup), 'nenhum caminho local real versionado no plano de backup (/mnt, /home, /Users, /media, /root ou unidade do Windows)');
  const destinations = [...backup.matchAll(/^rsync\b.*[ \t](\S+)[ \t]*$/gm)].map((m) => m[1] ?? '');
  assert.equal(destinations.length, 3, 'rotina semanal: evidence, link-audits e audits');
  // A pasta privada original vem da regra do próprio .gitignore (o teste não repete o nome dela).
  const privateDirs = gitignorePrivateDirs();
  assert.ok(privateDirs.length > 0, 'o .gitignore declara as pastas de dados privados');
  for (const dest of destinations) {
    assert.match(dest, /^<DESTINO_BACKUP_LOCAL>\/vps\/[a-z-]+\/$/, `destino ${dest}: marcador do backup local`);
    const localRoot = dest.split('/vps/')[0] ?? '';
    for (const dir of privateDirs) assert.ok(!localRoot.split(/[\\/]/).includes(dir), 'o backup nunca grava no diretório do original');
    assert.ok(!/<EVIDENCIAS_PRIVADAS(_WSL)?>/.test(dest), 'o backup nunca grava no diretório do original');
  }
});

test('roteiro H1: etapas de leitura primeiro, Worker em 0, sem comandos destrutivos fora do rollback autorizado', () => {
  const roteiro = read('ROTEIRO-H1-SUPERVISIONADO.md');
  assert.ok(roteiro.indexOf('## P1') < roteiro.indexOf('## P2') && roteiro.indexOf('## P2') < roteiro.indexOf('## P3'));
  assert.match(roteiro, /GMN_WORKER_REPLICAS=0/);
  assert.match(roteiro, /traefik\.swarm\.network/);
  assert.ok(!/traefik\.docker\.network/.test(roteiro));
  const commands = roteiro.match(/```bash[\s\S]*?```/g)?.join('\n') ?? '';
  for (const forbidden of [/docker system prune/, /volume prune/, /docker stack rm/, /docker secret rm/, /docker service (rm|update)/, /--delete/, /rm -rf/]) {
    assert.ok(!forbidden.test(commands), `comando proibido no roteiro: ${forbidden}`);
  }
  assert.ok(!/docker service scale gmn_gmn-worker=[1-9]/.test(commands), 'o roteiro nunca liga o Worker');
  for (const doc of ['GUIA-DE-IMPLANTACAO.md', 'CHECKLIST-DE-SEGURANCA.md', 'VERIFICACAO-POS-DEPLOY.md']) {
    assert.ok(!/traefik\.docker\.network/.test(read(doc).replace(/não há labels `traefik\.docker\.\*`/g, '')), `${doc} cita a label do provider Docker`);
  }
  assert.ok(!/vem de `X-Real-IP`/.test(read('CHECKLIST-DE-SEGURANCA.md')));
});

/*
 * G1.a (spec dos portões de produção §5.3, VC-E1 a VC-E5; critério PG-V01). O serviço web recebe TUDO o que o código da Fase 6 lê, e só ele:
 *  - as sete pastas, cada uma com alvo próprio no contêiner (nenhuma dentro de outra) e, as seis novas, com origem por MARCADOR obrigatório
 *    (`${GMN_RAIZ_DADOS_*:?…}`, sem caminho padrão: o caminho real fica no arquivo de variáveis da implantação, fora do repositório);
 *  - evidências e manifestos só leitura; decisões, recibos, resultados e livro graváveis;
 *  - as chaves só por Swarm secret externo (`*_FILE: /run/secrets/<secret>`), nunca valor no YAML; as listas de aposentadas NÃO ficam
 *    declaradas (entram só durante uma rotação), mas os nomes estão na lista fixa do entrypoint;
 *  - as listas públicas (ids revogados e chaves públicas de atestação) só por interpolação do arquivo de variáveis;
 *  - `stop-first` no web (R6-09); o Worker sem nada da Fase 6.
 */
interface Phase6Dir {
  readonly env: string;
  readonly target: string;
  readonly readOnly: boolean;
  /** Marcador da origem no host (`null` = a pasta de evidências, que já existia antes da G1.a). */
  readonly hostMarker: string | null;
}
const PHASE6_DIRS: readonly Phase6Dir[] = [
  { env: 'GMN_LINK_AUDIT_EVIDENCE_DIR', target: '/data/evidence', readOnly: true, hostMarker: null },
  { env: 'GMN_LINK_AUDIT_DECISIONS_DIR', target: '/data/decisions', readOnly: false, hostMarker: 'GMN_RAIZ_DADOS_DECISOES' },
  { env: 'GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR', target: '/data/decision-anchors', readOnly: false, hostMarker: 'GMN_RAIZ_DADOS_RECIBOS_DECISOES' },
  { env: 'GMN_LINK_AUDIT_RESULTS_DIR', target: '/data/results', readOnly: false, hostMarker: 'GMN_RAIZ_DADOS_RESULTADOS' },
  { env: 'GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR', target: '/data/result-anchors', readOnly: false, hostMarker: 'GMN_RAIZ_DADOS_RECIBOS_RESULTADOS' },
  { env: 'GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR', target: '/data/decisions-ledger', readOnly: false, hostMarker: 'GMN_RAIZ_DADOS_LIVRO' },
  { env: 'GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR', target: '/data/evidence-seals', readOnly: true, hostMarker: 'GMN_RAIZ_DADOS_MANIFESTOS' },
];
/**
 * Segredos da Fase 6 entregues por arquivo: variável → nome do Swarm secret (a stack só declara o que o código lê). G1.b.2a: os três da guarda externa
 * (credencial do papel de escrita, CA que ancora o TLS verificado e chave do pseudônimo), lidos só pelo módulo do livro.
 */
const PHASE6_SECRETS: Readonly<Record<string, string>> = {
  GMN_LINK_AUDIT_ORIGIN_KEY: 'gmn_link_audit_origin_key',
  GMN_LINK_AUDIT_LEDGER_KEY: 'gmn_link_audit_ledger_key',
  GMN_LINK_AUDIT_LOG_KEY: 'gmn_link_audit_log_key',
  GMN_LINK_AUDIT_GUARD_DB_URL: 'gmn_link_audit_guard_db_url',
  GMN_LINK_AUDIT_GUARD_DB_CA: 'gmn_link_audit_guard_db_ca',
  GMN_LINK_AUDIT_GUARD_KEY: 'gmn_link_audit_guard_key',
};
/** Só durante uma rotação (spec VC-E2, §5.1.7): na lista do entrypoint, mas NÃO declaradas no `stack.yml` permanente. */
const ROTATION_ONLY_SECRETS = ['GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS', 'GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS', 'GMN_LINK_AUDIT_GUARD_RETIRED_KEYS'] as const;
/** Listas PÚBLICAS (sem material de chave), do arquivo de variáveis da implantação (spec VC-E3). */
const PHASE6_PUBLIC_LISTS = ['GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS', 'GMN_LINK_AUDIT_LEDGER_REVOKED_KEY_IDS', 'GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS'] as const;
const ORIGINAL_SECRET_VARS = ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SERPER_API_KEY', 'REDIS_URL'] as const;
const ORIGINAL_SECRETS = ['gmn_serper_api_key', 'gmn_redis_url', 'gmn_supabase_anon', 'gmn_supabase_service_role'] as const;

interface BindMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}
/** Binds (forma longa) de um bloco de serviço já sem comentários. */
function bindMounts(block: string): BindMount[] {
  return [...block.matchAll(/- type: bind\n\s+source: ([^\n]+)\n\s+target: (\S+)(\n\s+read_only: true)?/g)].map((m) => ({ source: m[1] ?? '', target: m[2] ?? '', readOnly: m[3] !== undefined }));
}
/**
 * Secrets de um serviço, na sintaxe longa da P9.4 (`- source: X` + `target: X`): devolve as origens e exige `target` igual à origem,
 * para o caminho no contêiner continuar /run/secrets/<nome> (spec P-9 §5.11).
 */
function serviceSecrets(block: string): string[] {
  const match = block.match(/\n {4}secrets:\n((?: {6}- source: [^\n]+\n {8}target: [^\n]+\n?)+)/);
  return match
    ? [...(match[1] ?? '').matchAll(/- source: (\S+)\n\s+target: (\S+)/g)].map((m) => {
        assert.equal(m[2], m[1], `secret ${m[1]}: target igual à origem`);
        return m[1] ?? '';
      })
    : [];
}
/** Lista fixa do entrypoint (`for name in … ; do`, com continuação de linha). */
function entrypointSecretNames(): string[] {
  const loop = entrypoint.match(/for name in ([\s\S]*?); do/);
  assert.ok(loop, 'o entrypoint perdeu a lista fixa de segredos');
  return (loop[1] ?? '').replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
}
const isInside = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(`${outer}/`);

test('PG-V01 stack: as sete pastas da Fase 6 no web, cada uma com alvo dedicado e nenhuma dentro de outra (VC-E1)', () => {
  const web = serviceBlock('gmn-web');
  const mounts = bindMounts(web);
  for (const dir of PHASE6_DIRS) {
    assert.match(web, new RegExp(`\\n {6}${dir.env}: ${dir.target.replace(/\//g, '\\/')}\\n`), `${dir.env} aponta para ${dir.target}`);
    assert.equal(mounts.filter((mount) => mount.target === dir.target).length, 1, `um bind (e só um) para ${dir.target}`);
  }
  const targets = PHASE6_DIRS.map((dir) => dir.target);
  for (const a of targets) for (const b of targets) if (a !== b) assert.ok(!isInside(a, b), `${a} está dentro de ${b} (o código recusa)`);
  for (const mount of mounts) for (const target of targets) if (mount.target !== target) assert.ok(!isInside(target, mount.target) && !isInside(mount.target, target), `${target} sobreposta a ${mount.target}`);
});

test('PG-V01 stack: as seis pastas novas têm origem por marcador obrigatório, distinto e sem caminho padrão (VC-E1, VC-E6)', () => {
  const mounts = bindMounts(serviceBlock('gmn-web'));
  const markers = new Set<string>();
  for (const dir of PHASE6_DIRS.filter((item) => item.hostMarker !== null)) {
    const mount = mounts.find((item) => item.target === dir.target);
    assert.ok(mount, `bind ausente: ${dir.target}`);
    assert.equal(mount.source, `\${${dir.hostMarker}:?defina ${dir.hostMarker}}`, `${dir.target}: origem só pelo marcador obrigatório ${dir.hostMarker}, sem caminho padrão`);
    markers.add(dir.hostMarker as string);
  }
  assert.equal(markers.size, 6, 'um marcador por pasta: recibos e livro podem ficar em outro disco que os dados');
  assert.ok(!/GMN_RAIZ_DADOS_[A-Z_]+:-/.test(stack), 'nenhum caminho padrão de host para as pastas novas');
});

test('PG-V01 stack: evidências e manifestos só leitura; decisões, recibos, resultados e livro graváveis (VC-E1)', () => {
  const mounts = bindMounts(serviceBlock('gmn-web'));
  for (const dir of PHASE6_DIRS) {
    const mount = mounts.find((item) => item.target === dir.target);
    assert.ok(mount, `bind ausente: ${dir.target}`);
    assert.equal(mount.readOnly, dir.readOnly, `${dir.target}: read_only ${dir.readOnly}`);
  }
  assert.match(serviceBlock('gmn-web'), /target: \/data\/evidence-seals\n\s+read_only: true/, 'manifestos: escrita só pelo canal do CI (D15.5)');
});

test('PG-V01 stack: chaves da Fase 6 só por Swarm secret externo, com *_FILE; nenhum valor no YAML (VC-E2)', () => {
  const code = stripComments(stack);
  const web = serviceBlock('gmn-web');
  const webSecrets = serviceSecrets(web);
  const section = code.slice(code.indexOf('\nsecrets:'));
  for (const [variable, secret] of Object.entries(PHASE6_SECRETS)) {
    assert.match(web, new RegExp(`\\n {6}${variable}_FILE: /run/secrets/${secret}\\n`), `${variable} por arquivo de secret`);
    assert.ok(webSecrets.includes(secret), `o web monta o secret ${secret}`);
    assert.match(section, new RegExp(`\\n {2}${secret}:\\n {4}external: true`), `${secret} externo (criado pelo responsável, fora do repositório)`);
    assert.ok(!new RegExp(`${variable}\\s*[:=]`).test(code), `${variable} nunca recebe valor no YAML`);
  }
  for (const variable of ROTATION_ONLY_SECRETS) assert.ok(!code.includes(variable), `${variable} só entra durante uma rotação (VC-E2)`);
});

test('G1.b.2a stack: os três segredos da guarda (credencial, CA e chave do pseudônimo) SÓ no web, por arquivo; a aposentada da guarda só na rotação; nenhuma variável PG* que mudaria a conexão por fora do código', () => {
  const code = stripComments(stack);
  const guard = Object.entries(PHASE6_SECRETS).filter(([variable]) => variable.startsWith('GMN_LINK_AUDIT_GUARD_'));
  assert.equal(guard.length, 3);
  for (const [variable, secret] of guard) {
    assert.equal(code.split(`${variable}_FILE: /run/secrets/${secret}`).length - 1, 1, `${variable}: uma declaração, no web`);
    assert.ok(!serviceBlock('gmn-worker').includes(secret) && !serviceBlock('gmn-redis').includes(secret), `${secret} fora do Worker e do Redis`);
  }
  assert.ok(!/GMN_LINK_AUDIT_GUARD_RETIRED_KEYS/.test(code), 'a lista de aposentadas da guarda só entra durante uma rotação');
  for (const name of ['gmn-web', 'gmn-worker']) assert.ok(!/^\s+PG[A-Z_]+:/m.test(serviceBlock(name)), `${name}: nenhuma variável PG* (o conector usa só a configuração explícita)`);
  assert.ok(!entrypointSecretNames().some((name) => name.startsWith('PG')), 'nenhuma variável PG* na lista do entrypoint');
});

test('PG-V01 stack: nenhum valor literal nas variáveis da Fase 6 nem material de chave nos arquivos de implantação (VC-E1, VC-E3)', () => {
  const web = serviceBlock('gmn-web');
  const allowed = new Set<string>([
    ...PHASE6_DIRS.map((dir) => `${dir.env}: ${dir.target}`),
    ...Object.entries(PHASE6_SECRETS).map(([variable, secret]) => `${variable}_FILE: /run/secrets/${secret}`),
    ...PHASE6_PUBLIC_LISTS.map((variable) => `${variable}: \${${variable}:-}`),
  ]);
  const lines = web.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('GMN_LINK_AUDIT_'));
  assert.deepEqual([...lines].sort(), [...allowed].sort(), 'cada variável da Fase 6 é um alvo fixo, um arquivo de secret ou uma interpolação do arquivo de variáveis');
  for (const file of ['stack.yml', 'docker-entrypoint.sh', 'Dockerfile', 'verify-local.sh', 'verificar-pastas-fase6.sh']) {
    const text = read(file);
    assert.ok(!/[0-9a-f]{64}/i.test(text), `${file}: material hexadecimal de chave`);
    assert.ok(!/[a-z0-9][a-z0-9-]{3,31}:[A-Za-z0-9_-]{43}\b/.test(text), `${file}: chave pública/ID com material`);
    const withoutLocal = stripComments(text).replace(/\b(?:0\.0\.0\.0|127\.0\.0\.1)\b/g, ''); // escuta em todas as interfaces e loopback: não são hosts reais
    assert.ok(!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(withoutLocal), `${file}: endereço IP real`);
  }
});

test('PG-V01 stack: o web atualiza com stop-first (R6-09, VC-E4)', () => {
  const web = serviceBlock('gmn-web');
  assert.match(web, /update_config:\n\s+order: stop-first/, 'nunca dois processos web gravando nas pastas da Fase 6 durante a troca');
  assert.match(web, /rollback_config:\n\s+order: stop-first/);
  assert.ok(!/start-first/.test(stripComments(stack)), 'nenhum start-first na stack');
});

test('PG-V01 Worker: nenhuma variável GMN_LINK_AUDIT_*, nenhum secret e nenhum bind novos (VC-E4)', () => {
  const worker = serviceBlock('gmn-worker');
  assert.ok(!/GMN_LINK_AUDIT_|GMN_RAIZ_DADOS_|gmn_link_audit_/.test(worker), 'o Worker não recebe nada da Fase 6');
  assert.deepEqual(bindMounts(worker).map((mount) => mount.target), ['/app/.data/audits'], 'o Worker só monta a pasta de PDFs');
  assert.deepEqual(serviceSecrets(worker).sort(), [...ORIGINAL_SECRETS].sort(), 'o Worker continua só com os quatro secrets originais (a service_role grava as auditorias no Supabase)');
  for (const variable of ORIGINAL_SECRET_VARS) assert.match(worker, new RegExp(`${variable}_FILE: /run/secrets/`));
});

test('PG-V01 entrypoint: a lista fixa inclui os nomes da Fase 6, continua fixa e não passa a exigi-los (VC-E2)', () => {
  assert.deepEqual(entrypointSecretNames(), [...ORIGINAL_SECRET_VARS, 'GMN_LINK_AUDIT_ORIGIN_KEY', 'GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS', 'GMN_LINK_AUDIT_LEDGER_KEY', 'GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS', 'GMN_LINK_AUDIT_LOG_KEY', 'GMN_LINK_AUDIT_GUARD_DB_URL', 'GMN_LINK_AUDIT_GUARD_DB_CA', 'GMN_LINK_AUDIT_GUARD_KEY', 'GMN_LINK_AUDIT_GUARD_RETIRED_KEYS']);
  const code = stripComments(entrypoint);
  assert.ok(!/\benv\b\s*\||printenv|compgen|\bset\b\s*\||export -p|\/proc\/self\/environ/.test(code), 'nada de varrer o ambiente');
  const required = code.match(/for required in ([^;]+); do/);
  assert.ok(required, 'lista de variáveis obrigatórias ausente');
  assert.ok(!/GMN_LINK_AUDIT_/.test(required[1] ?? ''), 'sem as chaves a aplicação já falha fechada (503): o entrypoint não as exige');
  assert.match(code, /\[ -r "\$file" \] \|\| fail/, 'secret ilegível recusa');
  assert.match(code, /\[ -n "\$value" \] \|\| fail/, 'secret vazio recusa');
  assert.match(code, /unset "\$\{name\}_FILE"/, 'o caminho do arquivo não fica no ambiente');
});

test('PG-V01 Dockerfile: alvos de montagem da Fase 6 só na imagem web, dono 10001:10001 e modo 0700 (raiz só leitura)', () => {
  const code = stripComments(dockerfile);
  const web = code.slice(code.indexOf('AS web'), code.indexOf('AS worker-deps'));
  const worker = code.slice(code.indexOf('AS worker-deps'));
  const install = web.match(/install -d -m 0700 -o 10001 -g 10001((?: \\\n\s*| )\/data\/[a-z-]+)+/);
  assert.ok(install, 'o estágio web cria os alvos com dono e modo explícitos');
  const created = [...(install[0] ?? '').matchAll(/\/data\/[a-z-]+/g)].map((m) => m[0]).sort();
  assert.deepEqual(created, PHASE6_DIRS.filter((dir) => dir.hostMarker !== null).map((dir) => dir.target).sort());
  assert.ok(web.indexOf('install -d -m 0700') < web.indexOf('USER 10001:10001'), 'criados como root, antes de baixar o privilégio');
  for (const dir of PHASE6_DIRS.filter((item) => item.hostMarker !== null)) assert.ok(!worker.includes(dir.target), `a imagem do Worker não ganha ${dir.target}`);
});

test('PG-V01 verify-local: a renderização local da stack define os seis marcadores com valores fictícios', () => {
  const script = read('verify-local.sh');
  for (const dir of PHASE6_DIRS.filter((item) => item.hostMarker !== null)) {
    assert.match(script, new RegExp(`${dir.hostMarker}=/tmp/gmn-verify/`), `${dir.hostMarker} fictício (sem caminho real)`);
  }
});

test('PG-V04 guia: a conferência executável das seis pastas é pré-requisito do deploy, com os seis marcadores na ordem do script', () => {
  const guide = read('GUIA-DE-IMPLANTACAO.md');
  assert.ok(fs.existsSync(path.join(DEPLOY, 'verificar-pastas-fase6.sh')), 'script de conferência versionado');
  assert.match(guide, /cp deploy\/hostinger\/verificar-pastas-fase6\.sh \/opt\/gmn\/verificar-pastas-fase6\.sh/);
  const call = guide.match(/bash \/opt\/gmn\/verificar-pastas-fase6\.sh ([^\n]+\\\n[^\n]+)/);
  assert.ok(call, 'o guia chama o script');
  const markers = [...(call[1] ?? '').matchAll(/\$(GMN_RAIZ_DADOS_[A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(markers, ['GMN_RAIZ_DADOS_DECISOES', 'GMN_RAIZ_DADOS_RECIBOS_DECISOES', 'GMN_RAIZ_DADOS_RESULTADOS', 'GMN_RAIZ_DADOS_RECIBOS_RESULTADOS', 'GMN_RAIZ_DADOS_LIVRO', 'GMN_RAIZ_DADOS_MANIFESTOS']);
  assert.match(guide, /NÃO implantar[\s\S]{0,80}EN-12/, 'saída diferente de 0 bloqueia a implantação e fica registrada no EN-12');
});

/*
 * P9.4 (spec docs/specs/ci-deploy-and-seal-delivery.md §5.11; critérios P9-H01 a P9-H05 e P9-H09): nomes do Traefik parametrizados com o
 * padrão de produção (`gmn`), secrets em sintaxe longa com `target` explícito e a sobreposição de homologação `stack-hml.yml` (stack
 * gmn-hml) só com o permitido. A estrutura vem do leitor de YAML restrito dos testes (tests/helpers/yaml-subset.ts; sem dependência nova).
 */
const overlayText = read('stack-hml.yml');
const mapAt = (value: YamlValue | undefined, label: string): YamlMap => {
  assert.ok(isYamlMap(value), `${label}: mapa`);
  return value;
};
const listAt = (value: YamlValue | undefined, label: string): YamlValue[] => {
  assert.ok(Array.isArray(value), `${label}: lista`);
  return value;
};
const stackDoc = mapAt(parseYamlSubset(stack), 'stack.yml');
const overlayDoc = mapAt(parseYamlSubset(overlayText), 'stack-hml.yml');
const stackServices = mapAt(stackDoc.services, 'services');
const stackSecretNames = Object.keys(mapAt(stackDoc.secrets, 'secrets'));

/** As labels do Traefik de ANTES da P9.4, na ordem. Com o padrão de GMN_TRAEFIK_NAME, a produção fica exatamente assim (P9-H03). */
const PRODUCTION_TRAEFIK_LABELS = [
  'traefik.enable=true',
  `traefik.swarm.network=${EXTERNAL_NETWORK}`,
  'traefik.http.routers.gmn.rule=Host(`${GMN_HOST}`)',
  'traefik.http.routers.gmn.entrypoints=websecure',
  'traefik.http.routers.gmn.tls=true',
  'traefik.http.routers.gmn.tls.certresolver=letsencryptresolver',
  'traefik.http.routers.gmn.service=gmn',
  'traefik.http.routers.gmn.middlewares=gmn-headers',
  'traefik.http.services.gmn.loadbalancer.server.port=3000',
  'traefik.http.services.gmn.loadbalancer.passhostheader=true',
  'traefik.http.middlewares.gmn-headers.headers.stsSeconds=31536000',
  'traefik.http.middlewares.gmn-headers.headers.stsIncludeSubdomains=false',
  'traefik.http.middlewares.gmn-headers.headers.stsPreload=false',
  'traefik.http.middlewares.gmn-headers.headers.contentTypeNosniff=true',
  'traefik.http.routers.gmn-http.rule=Host(`${GMN_HOST}`)',
  'traefik.http.routers.gmn-http.entrypoints=${GMN_HTTP_ENTRYPOINT:-web}',
  'traefik.http.routers.gmn-http.middlewares=gmn-redirect-https',
  'traefik.http.routers.gmn-http.service=gmn',
  'traefik.http.middlewares.gmn-redirect-https.redirectscheme.scheme=https',
  'traefik.http.middlewares.gmn-redirect-https.redirectscheme.permanent=true',
] as const;
/** Nomes de router, serviço e middleware de uma label (na chave e nos valores `service=`/`middlewares=`). */
const traefikNames = (label: string): string[] => {
  const names = [...label.matchAll(/^traefik\.http\.(?:routers|services|middlewares)\.([^.]+)\./g)].map((m) => m[1] ?? '');
  const value = /\.(?:service|middlewares)=(.+)$/.exec(label)?.[1];
  return value === undefined ? names : [...names, value];
};
const webLabels = (): string[] => listAt(mapAt(mapAt(stackServices['gmn-web'], 'gmn-web').deploy, 'gmn-web.deploy').labels, 'labels').map(String);
const containsKey = (value: YamlValue, key: string): boolean =>
  Array.isArray(value) ? value.some((item) => containsKey(item, key)) : isYamlMap(value) && Object.entries(value).some(([k, v]) => k === key || containsKey(v, key));

test('P9-H01 stack: produção nunca declara GMN_LINK_AUDIT_HOMOLOGATION; a trava "1" existe só no web da sobreposição de homologação', () => {
  assert.ok(!stack.includes('GMN_LINK_AUDIT_HOMOLOGATION'), 'stack.yml de produção sem a trava (o teste da 2c continua)');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith('.md') && fs.readFileSync(full, 'utf8').includes('GMN_LINK_AUDIT_HOMOLOGATION')) offenders.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, 'deploy'));
  assert.deepEqual(offenders, ['deploy/hostinger/stack-hml.yml'], 'nenhum outro arquivo de implantação liga a trava');
  const webEnv = mapAt(mapAt(mapAt(overlayDoc.services, 'services')['gmn-web'], 'gmn-web').environment, 'environment');
  assert.equal(webEnv.GMN_LINK_AUDIT_HOMOLOGATION, '1');
});

test('P9-H02 stack-hml.yml: só a trava no web, Serper desligado no web e no Worker, Worker em 0 e os nomes dos secrets; nada de porta, bind, rede ou imagem', () => {
  assert.deepEqual(Object.keys(overlayDoc).sort(), ['secrets', 'services']);
  assert.deepEqual(overlayDoc.services, {
    'gmn-web': { environment: { GMN_LINK_AUDIT_HOMOLOGATION: '1', SERPER_API_KEY_FILE: '' } },
    'gmn-worker': { environment: { SERPER_API_KEY_FILE: '' }, deploy: { replicas: 0 } },
  });
  for (const service of ['gmn-web', 'gmn-worker']) {
    const env = mapAt(mapAt(stackServices[service], service).environment, `${service}.environment`);
    assert.equal(env.SERPER_API_KEY_FILE, '/run/secrets/gmn_serper_api_key', `${service}: a sobreposição sobrescreve uma variável existente`);
  }
  const code = stripComments(overlayText);
  for (const forbidden of [/^\s*ports:/m, /^\s*volumes:/m, /^\s*networks:/m, /^\s*image:/m, /^\s*build:/m, /type: bind/, /^\s*configs:/m, /^\s*labels:/m, /privileged|cap_add|pid:|network_mode|docker\.sock/]) {
    assert.ok(!forbidden.test(code), `a sobreposição não pode ter ${forbidden}`);
  }
});

test('P9-H03 stack: labels do Traefik com ${GMN_TRAEFIK_NAME:-gmn}; com o padrão, exatamente as de antes; em homologação, nomes que não colidem com os de produção', () => {
  const labels = webLabels();
  assert.deepEqual(labels.map((label) => renderTraefikName(label)), [...PRODUCTION_TRAEFIK_LABELS], 'produção inalterada com o padrão');
  const names = labels.flatMap(traefikNames);
  assert.ok(names.length > 0 && names.every((name) => name.startsWith(TRAEFIK_NAME_VAR)), 'todo nome de router, serviço e middleware parametrizado');
  const production = new Set(PRODUCTION_TRAEFIK_LABELS.flatMap(traefikNames));
  const homologation = labels.map((label) => renderTraefikName(label, 'gmn-hml')).flatMap(traefikNames);
  assert.ok(homologation.every((name) => name.startsWith('gmn-hml') && !production.has(name)), 'gmn-hml não redefine nenhum router de produção');
  const code = stripComments(stack);
  const occurrences = code.split('GMN_TRAEFIK_NAME').length - 1;
  assert.equal(occurrences, code.split(TRAEFIK_NAME_VAR).length - 1, 'a variável só aparece na forma com o padrão gmn');
  assert.equal(occurrences, labels.join('\n').split(TRAEFIK_NAME_VAR).length - 1, 'e só nas labels do Traefik');
});

test('P9-H04 stack: secrets na sintaxe longa, target = origem = nome lido pelo *_FILE (/run/secrets/gmn_*), e todo target usado', () => {
  for (const [name, value] of Object.entries(stackServices)) {
    const service = mapAt(value, name);
    const targets = listAt(service.secrets, `${name}.secrets`).map((item) => {
      const entry = mapAt(item, `${name}.secrets[]`);
      assert.deepEqual(Object.keys(entry).sort(), ['source', 'target'], `${name}: sintaxe longa com target explícito`);
      assert.equal(entry.target, entry.source, `${name}: target igual à origem`);
      assert.match(String(entry.source), /^gmn_[a-z_]+$/);
      assert.ok(stackSecretNames.includes(String(entry.source)), `${name}: ${String(entry.source)} declarado no topo`);
      return String(entry.target);
    });
    const env = isYamlMap(service.environment) ? service.environment : {};
    for (const [variable, file] of Object.entries(env).filter(([variable]) => variable.endsWith('_FILE'))) {
      const target = /^\/run\/secrets\/(gmn_[a-z_]+)$/.exec(String(file))?.[1];
      assert.ok(target !== undefined && targets.includes(target), `${name}: ${variable} lê um target montado no serviço`);
    }
    const serialized = JSON.stringify(service);
    for (const target of targets) assert.ok(serialized.includes(`/run/secrets/${target}`), `${name}: o target ${target} é lido pelo serviço`);
  }
});

test('P9-H05 stack: a lista de confiança continua vindo da variável GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS (o receptor de deploy a define) e a tag pela GMN_IMAGE_TAG', () => {
  const env = mapAt(mapAt(stackServices['gmn-web'], 'gmn-web').environment, 'environment');
  assert.equal(env.GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS, '${GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS:-}');
  for (const service of ['gmn-web', 'gmn-worker']) assert.match(String(mapAt(stackServices[service], service).image), /:\$\{GMN_IMAGE_TAG:\?[^}]+\}$/);
  assert.ok(!overlayText.includes('GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS') && !overlayText.includes('GMN_IMAGE_TAG'), 'a sobreposição não mexe na lista nem na tag');
});

test('P9-H09 stack-hml.yml: nenhuma rede (topo ou serviço) e TODO secret de topo do stack.yml mapeado para gmn-hml_*, nenhum para nome de produção', () => {
  assert.ok(!containsKey(overlayDoc, 'networks'), 'a sobreposição não declara networks');
  const productionSecrets = mapAt(stackDoc.secrets, 'stack.secrets');
  for (const [name, value] of Object.entries(productionSecrets)) assert.deepEqual(value, { external: true }, `produção: ${name} externo, com o próprio nome`);
  const overlaySecrets = mapAt(overlayDoc.secrets, 'stack-hml.secrets');
  assert.deepEqual(Object.keys(overlaySecrets).sort(), [...stackSecretNames].sort(), 'as duas listas de secrets de topo são as mesmas');
  const names = Object.entries(overlaySecrets).map(([key, value]) => {
    const secret = mapAt(value, key);
    assert.deepEqual(secret, { external: true, name: `gmn-hml_${key.slice('gmn_'.length)}` }, `${key}: só o nome de homologação (e external repetido)`);
    return String(secret.name);
  });
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((name) => !stackSecretNames.includes(name) && !name.startsWith('gmn_')), 'nenhum secret de homologação aponta para um nome de produção');
});
