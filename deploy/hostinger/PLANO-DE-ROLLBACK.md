# Plano de rollback

**Princípio:** voltar sem apagar dados. Volumes (`/srv/gmn/*`, `/srv/gmn-hml/*`), segredos e as evidências **nunca** são removidos num
rollback.

**Parâmetro:** defina antes `STACK=gmn` (produção) ou `STACK=gmn-hml` (homologação, P9.4). Os serviços são `${STACK}_gmn-web`,
`${STACK}_gmn-worker` e `${STACK}_gmn-redis`.

**Deploy pelo CI (P-9, desde a P9.4):** a implantação normal é só pelo workflow `.github/workflows/deploy.yml`, aprovado pelo
responsável (`RUNBOOK-DEPLOY-PELO-CI.md`). Recolocar uma versão anterior à mão (`docker load` + `docker stack deploy`) **não** é opção em
produção.

## 1. Atualização que falhou (automático, normal e emergência)
- `update_config` do web usa `stop-first` (G1.a, R6-09: nunca dois processos web gravando nas pastas da Fase 6 durante a troca; custo: breve indisponibilidade) com `failure_action: rollback` e monitoramento de 60 s: se a nova tarefa não ficar saudável, o Swarm volta sozinho, também com `stop-first`. Num deploy pelo CI, o job falha com `E_ROLLED_BACK` e a lista de confiança **não** é instalada.
- **Fase 6:** depois do primeiro `ENROLL`, **não** voltar a uma imagem anterior ao livro de cabeças (ela grava decisões sem o livro: `UNLEDGERED_ENTRY`); rollback só para imagem posterior ao livro, sobre os mesmos volumes, sem apagar nada (checklist de produção §8; ensaio EN-04 da G2). O receptor de deploy não sabe disso: a regra é do responsável e da revisão do PR de reversão.
- **Normal: commit de reversão + workflow.** PR com o commit de reversão na `main`, CI verde e deploy pelo `.github/workflows/deploy.yml` no ambiente afetado. É o único caminho que mantém o host igual à `main` (a imagem nova leva a tag do commit de reversão).
- **Emergência, só pelo responsável, no host:** `docker service rollback "${STACK}_gmn-web"` (ou `"${STACK}_gmn-worker"`), registrado como desvio no relatório da implantação; depois, o commit de reversão e o deploy normal. Nunca para imagem anterior ao livro (acima).
- **Imagens anteriores:** cada deploy carrega a tag `<amb>-<sha40>` e as anteriores continuam no host (`docker image ls | grep ^gmn-`), o que permite o `docker service rollback`. A limpeza das tags antigas (mantendo a atual e a anterior) é do responsável; disco cheio faz o receptor recusar antes de carregar (`E_DISK_LOW`).
- **Histórico (proibido em produção):** "carregar a imagem anterior com `docker load`, ajustar `GMN_IMAGE_TAG` e repetir o `docker stack deploy`" era o rollback por tag antes da P9.4. O receptor só implanta o pacote do commit aprovado, e o arquivo de variáveis do host não define mais `GMN_IMAGE_TAG`.

## 2. Worker com comportamento inesperado (custo!)
1. `docker service scale "${STACK}_gmn-worker=0"` **imediatamente** (o job ativo recebe SIGTERM e tem até 30 min para terminar; se for morto, a auditoria vira `FAILED` e pode ser retomada pela interface). Depois, registre `GMN_WORKER_REPLICAS=0` no arquivo de variáveis do host: o receptor recusa o próximo deploy se as réplicas divergirem do arquivo (`E_WORKER_REPLICAS_DRIFT`). Em homologação o Worker já fica sempre em 0.
2. Pausar a fila, se necessário: com `docker exec` no `gmn-redis`, `redis-cli` (autenticado) — não apague chaves `bull:*` sem conferir.
3. Revisar `docker service logs "${STACK}_gmn-worker"` e o painel do Serper.

## 3. Reverter a publicação (tirar a GMN do ar)
**Primeiro, sem nada destrutivo:** `docker service scale "${STACK}_gmn-web=0" "${STACK}_gmn-worker=0"` (o Traefik deixa de rotear; dados, segredos e Redis ficam intactos) e, se preciso, remover o registro DNS.

**Remoção da stack** (`docker stack rm "$STACK"`) é destrutiva para os serviços da GMN e **só com autorização expressa e separada do dono**; ela não faz parte da implantação. Não apaga bind mounts nem docker secrets:
```bash
docker stack rm "$STACK"
```
Depois remova o registro DNS (ou aponte para outro lugar) e, se for o caso, `docker secret rm gmn_*` (produção) ou `gmn-hml_*` (homologação), somente com a stack removida. O Traefik, os demais serviços e a outra stack da GMN não são afetados; confirme com `docker service ls`.

## 4. Pipeline de deploy comprometido ou com defeito
- **Cortar o acesso do CI:** esvaziar a linha do `authorized_keys` do usuário afetado (corta novas conexões na hora) e apagar os segredos do ambiente do GitHub (`RUNBOOK-DEPLOY-PELO-CI.md` §5). Nada é apagado no host; a aplicação continua rodando como está. Sem o pipeline, a produção fica parada até ele voltar: o deploy manual **não** é opção em produção.
- **Receptor com defeito:** o responsável reinstala a versão anterior (hash do commit anterior, `sha256sum -c`); o CI nunca atualiza receptor.

## 5. Dados corrompidos ou apagados por engano
Parar o web e o worker, restaurar conforme `PLANO-DE-BACKUP-E-RESTAURACAO.md` e validar por SHA-256.

## 6. O que nunca fazer num rollback
- `docker system prune`/`volume prune` na VPS (afetaria serviços de terceiros).
- Alterar a rede `automacaotrafegopagoredeinterna` ou o serviço `traefik_traefik`.
- Reabilitar o bypass `GMN_AUTH_DISABLED`.
- Implantar à mão em produção (fora do workflow), ou voltar a uma imagem anterior ao livro depois do primeiro `ENROLL`.
