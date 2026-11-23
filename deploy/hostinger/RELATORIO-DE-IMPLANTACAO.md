# Relatório de implantação — GMN na VPS Hostinger (modelo)

Preencha durante a execução do `ROTEIRO-H1-SUPERVISIONADO.md`. Não registre chaves, senhas nem conteúdo das evidências.

| Campo | Valor |
|---|---|
| Data/hora (início–fim) | |
| Executado por / supervisionado por | |
| Versão das imagens (`GMN_IMAGE_TAG`) | |
| ID `gmn-web` / `gmn-worker` (build) | |
| SHA-256 do pacote (origem = VPS) | |
| SHA-256 `stack.yml` (origem = VPS) | |
| Nó Swarm / Traefik (versão, provider, entrypoints) | |
| Domínio / DNS (A, AAAA) / certificado (emissor, validade) | |
| Hash agregado das evidências AUD-001 (origem = backup = VPS) | |

## Resultado das verificações
| Verificação | Resultado |
|---|---|
| HTTPS acessível; HTTP redireciona; HSTS | |
| Login real de operador; cookie HttpOnly/Secure/SameSite=Strict | |
| APIs sem sessão → 401; `/dev` → 404 | |
| `/api/system/client-address`: IP real, `shared`, cabeçalhos forjados ignorados | |
| Evidências AUD-001 legíveis (integridade OK, CID) | |
| 3000/6379 não expostas; sem `ports:` | |
| Serviços existentes idênticos ao "antes" (`diff`) | |
| Worker em 0 réplicas / 0 logs | |
| Saldo Serper antes = depois | |

## Desvios e decisões
(Liste qualquer divergência, parada ou decisão do dono.)

## Rollback aplicável
1. Imediato (sem apagar nada): `docker service scale gmn_gmn-web=0 gmn_gmn-worker=0`; remover o registro DNS `gmn` se for tirar do ar.
2. Versão anterior: recarregar a tag anterior, ajustar `GMN_IMAGE_TAG` e repetir `docker stack deploy` (ou `docker service rollback gmn_gmn-web`).
3. Dados: restaurar de `/mnt/d/gmn-backups/` conforme `PLANO-DE-BACKUP-E-RESTAURACAO.md`; validar por SHA-256.
4. `docker stack rm gmn` **somente** com autorização expressa e separada. Nunca `docker system prune`/`volume prune`.
