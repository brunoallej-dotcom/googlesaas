# GMN Intelligence Platform — imagens de produção (web e worker).
# Contexto de build = RAIZ do projeto:  docker build -f deploy/hostinger/Dockerfile --target web -t gmn-web:<tag> .
ARG NODE_IMAGE=node:22.23.2-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# ---------------------------------------------------------------- dependências (tudo instalado DENTRO da imagem)
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------- build do Next (saída standalone)
FROM base AS build
# Valores PÚBLICOS (URL e chave anônima do Supabase) são incorporados ao bundle pelo Next; nenhum segredo entra aqui.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY} \
    GMN_BUILD_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json next.config.ts postcss.config.mjs tailwind.config.ts ./
COPY src ./src
COPY public ./public
COPY assets ./assets
RUN npm run build

# ---------------------------------------------------------------- base de execução (não-root, init)
FROM base AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 gmn \
 && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin gmn \
 && mkdir -p /app/.data/audits /app/.data/link-audits /data/evidence \
 && chown -R 10001:10001 /app /data
COPY deploy/hostinger/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENV NODE_ENV=production

# ---------------------------------------------------------------- WEB
FROM runtime AS web
ENV PORT=3000 HOSTNAME=0.0.0.0 GMN_ROLE=web
COPY --from=build --chown=10001:10001 /app/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/.next/static ./.next/static
COPY --from=build --chown=10001:10001 /app/public ./public
COPY --from=build --chown=10001:10001 /app/assets ./assets
USER 10001:10001
EXPOSE 3000
# /login é público; /api/system/health exige sessão e responde 200 mesmo degradado, então não serve de healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/docker-entrypoint.sh"]
CMD ["node","server.js"]

# ---------------------------------------------------------------- WORKER (BullMQ; usa tsx em tempo de execução)
FROM runtime AS worker-deps
USER 0
COPY package.json package-lock.json ./
# `tsx` é devDependency no lockfile (npm o omitiria em produção): instala a MESMA versão do lockfile num projeto
# temporário e copia (sem sobrescrever nada) para o node_modules de produção.
RUN npm ci --omit=dev --no-audit --no-fund \
 && TSX_VERSION="$(node -p "require('./package-lock.json').packages['node_modules/tsx'].version")" \
 && mkdir /tmp/tsx-install && cd /tmp/tsx-install \
 && npm init -y >/dev/null \
 && npm install --no-audit --no-fund --ignore-scripts "tsx@${TSX_VERSION}" \
 && cp -rn node_modules/. /app/node_modules/ \
 && cd /app && rm -rf /tmp/tsx-install \
 && npm cache clean --force

FROM runtime AS worker
ENV GMN_ROLE=worker
COPY --from=worker-deps --chown=10001:10001 /app/node_modules ./node_modules
COPY --chown=10001:10001 package.json tsconfig.json ./
COPY --chown=10001:10001 src ./src
COPY --chown=10001:10001 assets ./assets
USER 10001:10001
# Sem servidor HTTP: o estado do Worker é o batimento no Redis (visível em /api/system/health, autenticado).
HEALTHCHECK NONE
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/docker-entrypoint.sh"]
# `node` direto (não `npm run`): o SIGTERM chega ao processo e o encerramento gracioso funciona.
CMD ["node","--import","tsx","src/workers/audit-worker.ts"]
