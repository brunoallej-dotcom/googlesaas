# Plano de backup externo e restauração

**O que proteger e onde está**
| Dado | Local na VPS | Criticidade |
|---|---|---|
| Evidências (coletas existentes e futuras) | `/srv/gmn/evidence` | **Alta** — a consulta paga não pode ser refeita |
| PDFs gerados | `/srv/gmn/audits` | Média (regeneráveis a partir do banco/bucket) |
| Snapshots da Auditoria por Link | `/srv/gmn/link-audits` | Alta |
| Fila/estado do Redis | `/srv/gmn/redis` | Baixa (jobs e batimento; auditorias ficam no Supabase) |
| Segredos | Swarm secrets (não legíveis) | **Alta** — guardar os valores fora da VPS |
| Configuração | `stack.yml`, `.env.production` | Média |
| Banco e buckets do Supabase | Supabase (fora da VPS) | Alta — backup do próprio Supabase; exportar periodicamente |
| **Fase 6**: decisões, recibos, resultados, livro e manifestos | seis pastas por marcador (§ Fase 6 abaixo) | **Máxima** — insubstituíveis; a perda de um par congela as auditorias |

**Regra:** backup **fora da VPS e fora do mesmo disco** (a cópia em `C:` e `D:` do Windows é o mesmo disco físico). Ao menos uma cópia em outro dispositivo/provedor.

## Opção A — Windows (já é a origem das evidências)
Rotina semanal, a partir do WSL (puxa da VPS; a VPS não precisa de credenciais do Windows):
```bash
# NUNCA grave em D:\gmn-evidencias-privadas (é o ORIGINAL da migração): o destino é uma pasta de backup separada.
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

## Fase 6 — decisões, recibos, resultados, livro de cabeças e manifestos (G1.a)

> Spec dos portões de produção §5.3.3 (VC-E6, critério PG-V02) e decisões da G0 de 20/11/2026 (Q8 e Q9). **Nada disto foi executado.**
> Os caminhos e destinos reais ficam **fora do repositório** (arquivo de variáveis da implantação e registro do responsável); aqui só há
> marcadores. As pastas são do serviço **web** (o Worker não monta nenhuma) e os arquivos gravados são imutáveis por convenção (`0444`).

| Pasta | Variável no web (alvo) | Origem no host (marcador) | Destino do backup (marcador) |
|---|---|---|---|
| Decisões | `GMN_LINK_AUDIT_DECISIONS_DIR` (`/data/decisions`) | `GMN_RAIZ_DADOS_DECISOES` | `<DESTINO_BACKUP_DADOS_FASE6>/decisions` |
| Recibos das decisões | `GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR` (`/data/decision-anchors`) | `GMN_RAIZ_DADOS_RECIBOS_DECISOES` | `<DESTINO_BACKUP_RECIBOS_DECISOES>` |
| Resultados | `GMN_LINK_AUDIT_RESULTS_DIR` (`/data/results`) | `GMN_RAIZ_DADOS_RESULTADOS` | `<DESTINO_BACKUP_DADOS_FASE6>/results` |
| Recibos dos resultados | `GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR` (`/data/result-anchors`) | `GMN_RAIZ_DADOS_RECIBOS_RESULTADOS` | `<DESTINO_BACKUP_RECIBOS_RESULTADOS>` |
| Livro de cabeças | `GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR` (`/data/decisions-ledger`) | `GMN_RAIZ_DADOS_LIVRO` | `<DESTINO_BACKUP_LIVRO>` |
| Manifestos de coleta (só leitura no web) | `GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR` (`/data/evidence-seals`) | `GMN_RAIZ_DADOS_MANIFESTOS` | `<DESTINO_BACKUP_MANIFESTOS>` |

**Destinos independentes (Q9).** `<DESTINO_BACKUP_RECIBOS_DECISOES>`, `<DESTINO_BACKUP_RECIBOS_RESULTADOS>` e `<DESTINO_BACKUP_LIVRO>` são **três
destinos distintos entre si e distintos de `<DESTINO_BACKUP_DADOS_FASE6>`**, todos **fora da VPS e fora do disco dos dados que ancoram**: o recibo
é a prova do dado; no mesmo disco, a perda leva os dois juntos. A cópia do livro também guarda as cabeças contra as quais a reconciliação da
guarda compara (G1.b). Os manifestos têm destino próprio (`<DESTINO_BACKUP_MANIFESTOS>`), além do original que fica com quem atesta, fora da VPS.

**Frequência e retenção.** Cópia **diária** (Q9) e, além dela, logo depois de cada resultado finalizado. Retenção mínima igual à das
evidências (7 diárias, 8 semanais, 12 mensais), **sem expurgo** de cópias que sejam a única referência de uma auditoria. Ensaio de
restauração antes da produção (onda G2, ensaios EN-02a a EN-03) e a cada trimestre.

### Rotina diária: pares do mesmo instante, `sha256sum` por arquivo, cabeças junto, nunca `--delete`
O web é o **único** processo que grava as pastas; parar o web (com `stop-first`, réplica única) congela as seis no mesmo instante. A janela é
curta (arquivos pequenos) e é combinada com quem opera (ninguém gravando). Os destinos `<…>` são pastas **já existentes**, montadas de outro
disco/provedor. Cada rodada cria, em cada destino, a pasta `<RODADA>/` (exclusiva: falha se já existir) com `dados/` (a cópia),
`SHA256SUMS` (hashes da **origem**, calculados com o web parado) e `CABECAS.json` (as cabeças da rodada).

**Antes da rodada (GE-R9):** com o web no ar e ninguém gravando, registrar para cada auditoria em uso o `head` (`seq` + `sha256`) que a API
de decisões e a de resultados devolvem e a vista do livro, num arquivo local `<ARQUIVO_DAS_CABECAS>` (pela sessão autenticada de um
operador, mesmo site; nunca pelo console do banco).
```bash
set -euo pipefail                                        # qualquer falha aborta a rodada
RODADA="$(date -u +%Y%m%d-%H%M%S)"                       # o MESMO rótulo em todas as pastas (pares do mesmo instante)
CABECAS="<ARQUIVO_DAS_CABECAS>"
[ -s "$CABECAS" ] || { echo "cabeças da rodada ausentes: nada foi feito" >&2; exit 1; }
religar() {                                              # roda SEMPRE na saída (sucesso ou falha): o web volta, e a falha fica registrada
  status=$?
  docker service scale gmn_gmn-web=1 >/dev/null
  if [ "$status" -ne 0 ]; then echo "BACKUP DA FASE 6 FALHOU (rodada $RODADA, saída $status): rodada INVÁLIDA; web religado" >&2; fi
}
trap religar EXIT
docker service scale gmn_gmn-web=0                       # congela as gravações
copia() {
  origem="$1"; rodada="$2/$RODADA"
  mkdir -- "$rodada"                                     # exclusivo: nunca reaproveita nem sobrescreve uma rodada
  ( cd -- "$origem" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum ) > "$rodada/SHA256SUMS"
  rsync -a -- "$origem"/ "$rodada/dados"/                # pasta nova: nada a sobrescrever; nunca --delete
  ( cd -- "$rodada/dados" && sha256sum --quiet --strict -c ../SHA256SUMS )    # a cópia confere, arquivo a arquivo, com a origem
  [ "$(find "$origem" -type f | wc -l)" -eq "$(find "$rodada/dados" -type f | wc -l)" ]   # e não tem arquivo a mais nem a menos
  cp -- "$CABECAS" "$rodada/CABECAS.json"                # as cabeças ficam DENTRO da rodada, em todas as cópias (inclusive a do livro)
}
copia "$GMN_RAIZ_DADOS_DECISOES"           "<DESTINO_BACKUP_DADOS_FASE6>/decisions"
copia "$GMN_RAIZ_DADOS_RESULTADOS"         "<DESTINO_BACKUP_DADOS_FASE6>/results"
copia "$GMN_RAIZ_DADOS_RECIBOS_DECISOES"   "<DESTINO_BACKUP_RECIBOS_DECISOES>"
copia "$GMN_RAIZ_DADOS_RECIBOS_RESULTADOS" "<DESTINO_BACKUP_RECIBOS_RESULTADOS>"
copia "$GMN_RAIZ_DADOS_LIVRO"              "<DESTINO_BACKUP_LIVRO>"
copia "$GMN_RAIZ_DADOS_MANIFESTOS"         "<DESTINO_BACKUP_MANIFESTOS>"
echo "rodada $RODADA válida nos seis destinos"
```
- **Depois:** com o web de volta, as cabeças lidas pela API precisam ser **iguais** às de `<ARQUIVO_DAS_CABECAS>`. Se mudaram, alguém gravou
  durante a janela: registrar a rodada como inválida e fazer outra (com outro rótulo; a inválida nunca é apagada nem reaproveitada).
- Uma rodada só vale se o bloco terminou com "rodada … válida". Falha em qualquer cópia ⇒ o `trap` religa o web e registra a falha; as
  pastas parciais dessa rodada ficam como estão, marcadas como inválidas no registro, e nunca são usadas numa restauração.
- Envio remoto (`rsync` para outra máquina ou `restic` com um repositório **por destino**): as mesmas regras, ou seja, rodada nova e
  exclusiva, hashes da origem conferidos na cópia, **nunca `--delete`**, nunca sobrescrever, nunca `restic forget` de uma rodada que seja a
  única referência.
- Conferência no destino, a qualquer momento: `( cd <destino>/<RODADA>/dados && sha256sum --strict -c ../SHA256SUMS )`.
- Nada é copiado para **dentro** das pastas vivas fora do código (o leitor recusa arquivo criado à mão; checklist de produção §9).

### Restauração da Fase 6 (sempre os pares do mesmo instante, em pasta nova irmã da viva)
1. Consultar a guarda e a reconciliação externa **antes** (G1.b; spec dos portões Q2): restaurar backup mais velho que a guarda congela as
   auditorias afetadas (`GUARD_MISMATCH`), e sem papel administrativo elas não reabrem pela aplicação.
2. Escolher **uma** rodada válida e restaurar, **dessa mesma rodada**, decisões + recibos das decisões, resultados + recibos dos resultados e
   o livro (e os manifestos, se preciso). Para cada pasta viva `P` (o caminho de um marcador `GMN_RAIZ_DADOS_*`) e a cópia
   `C=<destino>/<RODADA>`, a restaurada nasce como **irmã** de `P`, nunca dentro dela, e só com o conteúdo de `dados/`:
   ```bash
   set -euo pipefail
   N="$P.restaurado-<RODADA>"
   mkdir -m 0700 -- "$N"                                   # exclusivo: falha se já existir
   rsync -a -- "$C/dados"/ "$N"/                            # só os dados: SHA256SUMS e CABECAS.json ficam no backup
   ( cd -- "$N" && sha256sum --quiet --strict -c "$C/SHA256SUMS" )
   ```
3. Com **todas** as pastas da rodada restauradas e conferidas, parar o web e trocar cada uma, guardando a viva como irmã (nunca apagar):
   ```bash
   docker service scale gmn_gmn-web=0
   mv -- "$P" "$P.antigo-$(date -u +%Y%m%d-%H%M%S)"        # a viva sai para um caminho IRMÃO (nunca para dentro de si mesma)
   mv -- "$P.restaurado-<RODADA>" "$P"                     # a restaurada volta para a origem
   chown -R 10001:10001 -- "$P" && chmod 0700 -- "$P"
   stat -c '%u:%g %a %n' -- "$P"                           # esperado: 10001:10001 700
   ( cd -- "$P" && sha256sum --quiet --strict -c "$C/SHA256SUMS" )   # confere de novo no lugar, ANTES de religar
   ```
   Repetir para cada pasta da rodada; se alguma conferência falhar, **não** religar: desfazer a troca daquela pasta com os dois `mv` ao
   contrário e investigar.
4. Conferir as seis pastas com `deploy/hostinger/verificar-pastas-fase6.sh` (distintas, nenhuma dentro de outra, recibos e livro em
   dispositivos independentes), `docker service scale gmn_gmn-web=1` e ler pela API: histórico que não confere devolve 409 e nenhum dado;
   comparar as cabeças com o `CABECAS.json` da rodada. **Nunca** apagar arquivos para "destravar" uma auditoria.
5. Registrar data, rodada restaurada, resultado das conferências e o estado `externalGuard` da tela.

### Logs do contêiner (Q8, G0 de 20/11/2026): exportação diária e cifrada, expurgo aos 90 dias
Sem ferramenta paga. O driver `json-file` da stack guarda só 3 × 10 MB por serviço e roda sozinho: a exportação é **diária**, antes que a
rotação descarte linhas. O destino `<DESTINO_LOGS>` fica no **mesmo destino independente dos backups** (fora da VPS), numa pasta própria.
```bash
set -euo pipefail                                        # falha no docker, no gzip ou no gpg aborta (nada de arquivo cifrado incompleto)
DIA="$(date -u +%Y%m%d)"
for svc in gmn_gmn-web gmn_gmn-worker; do
  final="<DESTINO_LOGS>/$svc-$DIA.log.gz.gpg"
  [ ! -e "$final" ] || { echo "já exportado: $final (não sobrescreve)" >&2; exit 1; }
  parcial="$final.parcial"
  docker service logs --no-trunc --timestamps --since 24h "$svc" 2>&1 \
    | gzip -9 | gpg --batch --encrypt --recipient "<ID_DA_CHAVE_PUBLICA_DOS_LOGS>" > "$parcial"
  mv -- "$parcial" "$final"                              # só depois do sucesso de toda a cadeia o arquivo ganha o nome final
done
# expurgo SÓ dos arquivos de LOG exportados com mais de 90 dias (nunca de dados da Fase 6 nem de backups)
find "<DESTINO_LOGS>" -maxdepth 1 -type f -name 'gmn_gmn-*.log.gz.gpg' -mtime +90 -exec rm -- {} +
```
- Um `*.parcial` que sobrar indica exportação que falhou: registrar a falha e exportar de novo (o arquivo parcial não vale como log).
- Cifra com a chave **pública** de um par cuja privada fica **fora da VPS**, só com o responsável e quem opera o servidor (acesso decidido
  em 16/11/2026). O `operatorRef` dos eventos é pseudônimo (HMAC com `GMN_LINK_AUDIT_LOG_KEY`), não anônimo: o log continua dado pessoal.
- Hoje a Fase 6 ainda não emite eventos (fatias 2 a 7 da spec de observabilidade); a exportação já cobre o que o contêiner registra.
