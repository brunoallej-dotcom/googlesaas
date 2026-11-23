# Plano de rollback

**Princípio:** voltar sem apagar dados. Volumes (`/srv/gmn/*`), segredos e as evidências **nunca** são removidos num rollback.

## 1. Atualização que falhou (automático e manual)
- `update_config` do web usa `stop-first` (G1.a, R6-09: nunca dois processos web gravando nas pastas da Fase 6 durante a troca; custo: breve indisponibilidade) com `failure_action: rollback` e monitoramento de 60 s: se a nova tarefa não ficar saudável, o Swarm volta sozinho, também com `stop-first`.
- **Fase 6:** depois do primeiro `ENROLL`, **não** voltar a uma imagem anterior ao livro de cabeças (ela grava decisões sem o livro: `UNLEDGERED_ENTRY`); rollback só para imagem posterior ao livro, sobre os mesmos volumes, sem apagar nada (checklist de produção §8; ensaio EN-04 da G2).
- Manual: `docker service rollback gmn_gmn-web` (ou `gmn_gmn-worker`).
- Por tag: carregar a imagem anterior (`docker load`), ajustar `GMN_IMAGE_TAG` e repetir `docker stack deploy --resolve-image never -c stack.yml gmn`. **Mantenha pelo menos a tag anterior carregada** na VPS (`docker image ls | grep ^gmn-`).

## 2. Worker com comportamento inesperado (custo!)
1. `docker service scale gmn_gmn-worker=0` **imediatamente** (o job ativo recebe SIGTERM e tem até 30 min para terminar; se for morto, a auditoria vira `FAILED` e pode ser retomada pela interface).
2. Pausar a fila, se necessário: com `docker exec` no `gmn-redis`, `redis-cli` (autenticado) — não apague chaves `bull:*` sem conferir.
3. Revisar `docker service logs gmn_gmn-worker` e o painel do Serper.

## 3. Reverter a publicação (tirar a GMN do ar)
**Primeiro, sem nada destrutivo:** `docker service scale gmn_gmn-web=0 gmn_gmn-worker=0` (o Traefik deixa de rotear; dados, segredos e Redis ficam intactos) e, se preciso, remover o registro DNS.

**Remoção da stack** (`docker stack rm gmn`) é destrutiva para os serviços da GMN e **só com autorização expressa e separada do dono**; ela não faz parte da implantação. Não apaga bind mounts nem docker secrets:
```bash
docker stack rm gmn
```
Depois remova o registro DNS (ou aponte para outro lugar) e, se for o caso, `docker secret rm gmn_*` (somente com a stack removida). O Traefik e os demais serviços não são afetados; confirme com `docker service ls`.

## 4. Dados corrompidos ou apagados por engano
Parar o web e o worker, restaurar conforme `PLANO-DE-BACKUP-E-RESTAURACAO.md` e validar por SHA-256.

## 5. O que nunca fazer num rollback
- `docker system prune`/`volume prune` na VPS (afetaria serviços de terceiros).
- Alterar a rede `automacaotrafegopagoredeinterna` ou o serviço `traefik_traefik`.
- Reabilitar o bypass `GMN_AUTH_DISABLED`.
