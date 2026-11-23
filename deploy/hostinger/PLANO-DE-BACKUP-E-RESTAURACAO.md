# Plano de backup externo e restauração

**O que proteger e onde está**
| Dado | Local na VPS | Criticidade |
|---|---|---|
| Evidências (AUD-001 e futuras) | `/srv/gmn/evidence` | **Alta** — a consulta paga não pode ser refeita |
| PDFs gerados | `/srv/gmn/audits` | Média (regeneráveis a partir do banco/bucket) |
| Snapshots da Auditoria por Link | `/srv/gmn/link-audits` | Alta |
| Fila/estado do Redis | `/srv/gmn/redis` | Baixa (jobs e batimento; auditorias ficam no Supabase) |
| Segredos | Swarm secrets (não legíveis) | **Alta** — guardar os valores fora da VPS |
| Configuração | `stack.yml`, `.env.production` | Média |
| Banco e buckets do Supabase | Supabase (fora da VPS) | Alta — backup do próprio Supabase; exportar periodicamente |

**Regra:** backup **fora da VPS e fora do mesmo disco** (a cópia em `C:` e `D:` do Windows é o mesmo disco físico). Ao menos uma cópia em outro dispositivo/provedor.

## Opção A — Windows (já é a origem das evidências)
Rotina semanal, a partir do WSL (puxa da VPS; a VPS não precisa de credenciais do Windows):
```bash
# NUNCA grave em <EVIDENCIAS_PRIVADAS> (é o ORIGINAL da migração): o destino é uma pasta de backup separada.
rsync -a --checksum --rsync-path='sudo rsync' USUARIO@IP_DA_VPS:/srv/gmn/evidence/   /mnt/d/gmn-backups/vps/evidence/
rsync -a --checksum --rsync-path='sudo rsync' USUARIO@IP_DA_VPS:/srv/gmn/link-audits/ /mnt/d/gmn-backups/vps/link-audits/
rsync -a --checksum --rsync-path='sudo rsync' USUARIO@IP_DA_VPS:/srv/gmn/audits/      /mnt/d/gmn-backups/vps/audits/
```
Copie depois para um **segundo dispositivo** (HD externo/armazenamento de objetos).

## Opção B — `restic` para armazenamento de objetos S3-compatível (cifrado, versionado)
```bash
restic -r s3:https://ENDPOINT/BUCKET init
restic -r s3:https://ENDPOINT/BUCKET backup /srv/gmn/evidence /srv/gmn/link-audits /srv/gmn/audits --tag gmn
restic -r s3:https://ENDPOINT/BUCKET forget --keep-daily 7 --keep-weekly 8 --keep-monthly 12 --prune
```
Guarde a senha do repositório e as credenciais S3 **fora** da VPS.

## Frequência e retenção
Evidências: após cada nova coleta e semanalmente. Demais: semanalmente. Retenção: 7 diárias, 8 semanais, 12 mensais (opção B).

## Restauração (testar a cada trimestre)
1. Parar o consumo: `docker service scale gmn_gmn-worker=0`.
2. Restaurar para um diretório temporário (`restic restore latest --target /tmp/restore` ou `rsync` inverso) — **nunca por cima** do diretório vivo.
3. Conferir `sha256sum -c SHA256SUMS` em cada pasta de evidência restaurada e comparar o hash agregado com o registrado.
4. Substituir o diretório: `mv` do atual para `/srv/gmn/_antigo-AAAAMMDD` e mover o restaurado; `chown -R 10001:10001`, `chmod -R u=rwX,go=`.
5. `docker service update --force gmn_gmn-web` e verificar `/auditoria-por-link` (integridade OK).
6. Segredos: recriar com `docker secret create` a partir do gerenciador de senhas (remover o secret antigo exige remover/atualizar os serviços que o usam).
7. Registrar data, origem do backup e resultado da verificação.
