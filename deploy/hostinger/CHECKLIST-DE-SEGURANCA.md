# Checklist de segurança — GMN na VPS (marque antes de liberar o acesso público)

## Autenticação e exposição
- [ ] `GMN_AUTH_DISABLED` **não existe** em nenhum serviço (o entrypoint recusa iniciar se existir). `docker service inspect gmn_gmn-web --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}' | grep -c AUTH_DISABLED` → `0`.
- [ ] `NODE_ENV=production` (o build de produção também desliga o bypass: `NODE_ENV` é fixado em tempo de build).
- [ ] O Next.js **não publica porta** (`docker service inspect gmn_gmn-web --format '{{json .Endpoint.Ports}}'` → `null`/`[]`) e o Redis também não.
- [ ] Router do Traefik com regra `Host(...)` exata e `passhostheader=true` (a checagem de origem do login usa o Host). Sem router "pega-tudo" na stack.
- [ ] Nenhum `forwardedHeaders.insecure`/`trustedIPs` aberto no Traefik. O app usa **somente o último salto** de `X-Forwarded-For` (o IP que o Traefik viu); `X-Real-IP` e os itens anteriores (enviados pelo cliente) são **ignorados** por desenho e por teste.
- [ ] **Provar na VPS qual IP o app enxerga:** logado, abrir `https://HOST/api/system/client-address`. Esperado: `address` = seu IP público, `shared: false`, `source: x-forwarded-for:last-hop`. Repetir enviando `X-Real-IP`/`X-Forwarded-For` forjados (ver VERIFICACAO §5): `address` não pode mudar. Se vier `shared: true` (IP 10.x/172.x: NAT do ingress do Swarm), o limite de login passa a um balde global (100/15 min) e o limite por e-mail (15/15 min) continua valendo; **decisão do dono antes de abrir ao público** (ex.: publicar 80/443 do Traefik em modo `host` — mudança no Traefik, fora desta etapa).
- [ ] Aceito: a rede `automacaotrafegopagoredeinterna` é plana; um web comprometido alcançaria n8n, PostgreSQL e Redis do VRA. Mitigação: sem portas extras, `read_only`, `cap_drop ALL`, atualização das imagens.
- [ ] HTTPS ativo com certificado Let's Encrypt; HTTP redireciona para HTTPS; HSTS presente (`curl -sI https://HOST/login`).
- [ ] Sem cadastro público no Supabase Auth (já validado na Fase 5); `GMN_OPERATOR_EMAILS` só com os operadores reais.
- [ ] `/dev/*` responde 404 em produção; `/api/*` sem sessão responde 401; `/login` é a única página pública.
- [ ] Uma réplica do web (limitadores de login/enfileiramento são por processo).

## Segredos
- [ ] Service role, anon, Serper, senha e URL do Redis só como `docker secret` (nunca em `.env`, imagem, stack ou Git); `docker history gmn-web:TAG` sem segredos.
- [ ] `.env.production` com `chmod 600` e sem segredos; fora de qualquer repositório.
- [ ] Nenhuma chave no navegador (`NEXT_PUBLIC_*` = só URL e anon key públicas).
- [ ] Segredos guardados em gerenciador de senhas; rotação planejada (girar a service role derruba as sessões, pois assina o cookie).

## Isolamento de dados e custos
- [ ] Redis exclusivo (`gmn-redis`, rede `gmn_internal`), com senha, `noeviction`, sem porta; nenhuma fila compartilhada com n8n/Evolution/VRA.
- [ ] Worker com `replicas: 0` até a validação; fila vazia antes de ativar; `GMN_WORKER_CONCURRENCY=1`.
- [ ] Nenhuma API paga **automática**: sem `GMN_REVIEWS_PROVIDER`, sem DataForSEO/LLM, mapa-base `none`. Atenção: o web tem a chave Serper e `/api/prospect` consome crédito **por ação do operador autenticado**; enfileirar auditorias com o Worker desligado só acumula jobs (consumidos ao ligar o Worker).
- [ ] Sessão sem revogação individual: remover o e-mail da lista revoga o acesso; girar a service role derruba todas as sessões.
- [ ] Evidências montadas **somente leitura** no web; dados em `/srv/gmn` com 0700 e dono uid 10001.
- [ ] Containers não-root, `read_only`, `cap_drop: ALL`, logs com rotação, limites de CPU/memória.

## Serviços existentes
- [ ] `docker service ls` antes e depois: Traefik, n8n, Evolution, Portainer, PostgreSQL e VRA Worker com as mesmas réplicas/versões; a GMN só adicionou `gmn_*`.
- [ ] Backup externo configurado e **restauração testada** (`PLANO-DE-BACKUP-E-RESTAURACAO.md`).
