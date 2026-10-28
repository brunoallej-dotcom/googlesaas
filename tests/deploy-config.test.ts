import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Teste ESTÁTICO dos arquivos de implantação (deploy/hostinger): nada aqui sobe container, abre rede ou lê segredos.
 * Garante as regras de isolamento e segurança combinadas para a stack Swarm.
 */
const ROOT = path.join(__dirname, '..');
const DEPLOY = path.join(ROOT, 'deploy', 'hostinger');
const read = (name: string): string => fs.readFileSync(path.join(DEPLOY, name), 'utf8');
const stack = read('stack.yml');
const dockerfile = read('Dockerfile');
const entrypoint = read('docker-entrypoint.sh');
const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
const stripComments = (text: string): string => text.replace(/^\s*#.*$/gm, '').replace(/\s+#\s.*$/gm, '');

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
  const labels = web.slice(labelsAt);
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
  assert.deepEqual(names.sort(), ['gmn_redis_conf', 'gmn_redis_password', 'gmn_redis_url', 'gmn_serper_api_key', 'gmn_supabase_anon', 'gmn_supabase_service_role']);
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
  assert.ok(!/\/mnt\/d\/gmn-evidencias-privadas\/link-audit\/\s*$/m.test(backup), 'o backup nunca grava no diretório do original');
  assert.match(backup, /\/mnt\/d\/gmn-backups\/vps\/evidence\//);
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
