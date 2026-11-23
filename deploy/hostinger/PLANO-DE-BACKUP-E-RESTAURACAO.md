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
`SHA256SUMS` (manifesto: hashes e lista de arquivos da **origem**, calculados com o web parado e confirmado), `CABECAS.json` (as cabeças da
rodada) e **um marcador persistente**: `RODADA-VALIDA` (gravado nas seis pastas só depois de as seis cópias conferirem) ou
`RODADA-INCOMPLETA` (gravado pelo `trap` em toda pasta já criada, com data e hora UTC, o passo que falhou e o código de saída). A
restauração só aceita rodada com `RODADA-VALIDA` e sem `RODADA-INCOMPLETA`.

**Uma rodada por vez (trava global).** A rodada (e a restauração) roda sob `flock -n` num arquivo de trava `<ARQUIVO_DE_TRAVA_DO_BACKUP>`,
**fora** das pastas de dados e dos destinos (por exemplo, em `/run/lock`). A trava é pega **antes** de tocar no web e fica com o processo
até ele religar o web. Quem não pega a trava sai na hora, **sem** parar nem religar o web e sem `trap`. O `trap` só religa o web se **esta**
execução o parou, e devolve o número de réplicas que ele tinha antes.

**Antes da rodada (GE-R9):** com o web no ar e ninguém gravando, registrar para cada auditoria em uso o `head` (`seq` + `sha256`) que a API
de decisões e a de resultados devolvem e a vista do livro, num arquivo local `<ARQUIVO_DAS_CABECAS>` (pela sessão autenticada de um
operador, mesmo site; nunca pelo console do banco).
```bash
set -euo pipefail                                        # qualquer falha aborta a rodada
exec 9>"<ARQUIVO_DE_TRAVA_DO_BACKUP>"                    # trava GLOBAL, fora das pastas de dados
flock -n 9 || { echo "outra rodada (ou restauração) da Fase 6 em andamento: nada foi feito; o web não foi tocado" >&2; exit 1; }
RODADA="$(date -u +%Y%m%d-%H%M%S)-$$"                    # o MESMO rótulo nas seis pastas (pares do mesmo instante), único por execução
CABECAS="<ARQUIVO_DAS_CABECAS>"
[ -s "$CABECAS" ] || { echo "cabeças da rodada ausentes: nada foi feito" >&2; exit 1; }
PASSO="preparação"; CRIADAS=(); PAREI=0                  # passo corrente, pastas de rodada já criadas, e se ESTA execução parou o web
ANTES="$(docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' gmn_gmn-web)"
religar() {                                              # roda SEMPRE na saída: marca a falha; religa SÓ se esta execução parou o web
  status=$?
  if [ "$status" -ne 0 ]; then
    for r in "${CRIADAS[@]}"; do
      printf 'rodada %s INCOMPLETA\nquando (UTC): %s\npasso que falhou: %s\nsaída: %s\n' "$RODADA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        "$PASSO" "$status" > "$r/RODADA-INCOMPLETA" || echo "não foi possível marcar $r como incompleta" >&2
    done
    echo "BACKUP DA FASE 6 FALHOU (rodada $RODADA, passo: $PASSO, saída $status): rodada INVÁLIDA" >&2
  fi
  if [ "$PAREI" -eq 1 ]; then docker service scale "gmn_gmn-web=$ANTES" >/dev/null; fi
}
trap religar EXIT
if [ "$ANTES" != 0 ]; then PASSO="parar o web"; PAREI=1; docker service scale gmn_gmn-web=0; fi
PASSO="confirmar o web parado"                           # réplicas 0 E nenhum contêiner do serviço rodando neste nó (o web é fixado nele)
[ "$(docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' gmn_gmn-web)" = 0 ]
[ -z "$(docker ps -q --filter label=com.docker.swarm.service.name=gmn_gmn-web)" ]
lista() { ( cd -- "$1" && find . -type f -print0 | LC_ALL=C sort -z | tr '\0' '\n' ); }          # lista exata de arquivos de uma pasta
manifesto() { ( cd -- "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum ); }   # hashes de cada arquivo
so_regulares() {                                         # nada além de arquivo regular e pasta (link, FIFO, socket… ⇒ falha)
  local achados; achados="$(find "$1" ! -type f ! -type d -print -quit)"   # find que falha (pasta ilegível) também aborta
  [ -z "$achados" ]
}
ORIGENS=()
copia() {
  nome="$1"; origem="$2"; rodada="$3/$RODADA"
  PASSO="$nome: criar a rodada"; mkdir -- "$rodada"      # exclusivo: nunca reaproveita nem sobrescreve uma rodada
  CRIADAS+=("$rodada"); ORIGENS+=("$origem")
  PASSO="$nome: origem só com arquivos regulares"; so_regulares "$origem"   # um link simbólico entraria na cópia sem conferência
  PASSO="$nome: manifesto da origem"; manifesto "$origem" > "$rodada/SHA256SUMS"
  PASSO="$nome: cópia"; rsync -a -- "$origem"/ "$rodada/dados"/            # pasta nova: nada a sobrescrever; nunca --delete
  PASSO="$nome: conferência"
  so_regulares "$rodada/dados"                                                 # a cópia também só tem arquivos regulares e pastas
  ( cd -- "$rodada/dados" && sha256sum --quiet --strict -c ../SHA256SUMS )    # cada arquivo do manifesto confere na cópia
  diff -- <(cut -c67- "$rodada/SHA256SUMS") <(lista "$rodada/dados")          # e a cópia tem EXATAMENTE os arquivos do manifesto
  diff -- "$rodada/SHA256SUMS" <(manifesto "$origem")                          # e a origem não mudou (nomes E conteúdo) durante a cópia
  PASSO="$nome: cabeças"; cp -- "$CABECAS" "$rodada/CABECAS.json"          # as cabeças ficam DENTRO da rodada (inclusive na do livro)
}
copia decisoes           "$GMN_RAIZ_DADOS_DECISOES"           "<DESTINO_BACKUP_DADOS_FASE6>/decisions"
copia resultados         "$GMN_RAIZ_DADOS_RESULTADOS"         "<DESTINO_BACKUP_DADOS_FASE6>/results"
copia recibos-decisoes   "$GMN_RAIZ_DADOS_RECIBOS_DECISOES"   "<DESTINO_BACKUP_RECIBOS_DECISOES>"
copia recibos-resultados "$GMN_RAIZ_DADOS_RECIBOS_RESULTADOS" "<DESTINO_BACKUP_RECIBOS_RESULTADOS>"
copia livro              "$GMN_RAIZ_DADOS_LIVRO"              "<DESTINO_BACKUP_LIVRO>"
copia manifestos         "$GMN_RAIZ_DADOS_MANIFESTOS"         "<DESTINO_BACKUP_MANIFESTOS>"
PASSO="rechecar as seis origens"                         # antes de validar: hashes da ORIGEM de novo, contra o manifesto de cada rodada
for i in "${!CRIADAS[@]}"; do so_regulares "${ORIGENS[$i]}"; diff -- "${CRIADAS[$i]}/SHA256SUMS" <(manifesto "${ORIGENS[$i]}"); done
PASSO="marcar a rodada como válida"                      # só depois de as SEIS cópias conferirem e as origens seguirem iguais
for r in "${CRIADAS[@]}"; do printf 'rodada %s VALIDA\nquando (UTC): %s\n' "$RODADA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$r/RODADA-VALIDA"; done
echo "rodada $RODADA válida nos seis destinos"
```
- **Morte abrupta do script** (`SIGKILL`, queda do host ou da sessão): o `trap` pode **não** rodar. Então o web pode ficar parado e a rodada
  fica sem marcador nenhum. Depois de qualquer interrupção, conferir `docker service ls` (o `gmn_gmn-web` precisa estar em `1/1`) e, se
  estiver em `0/0`, religar à mão com `docker service scale gmn_gmn-web=1`; a trava global é liberada sozinha quando o processo morre. Se
  a morte acontecer **durante** o laço que grava `RODADA-VALIDA`, podem sobrar marcadores **parciais** (algumas das seis pastas com
  `RODADA-VALIDA`, outras sem). Por isso uma pasta isolada com `RODADA-VALIDA` nunca basta: a rodada só vale com a pré-conferência das
  **seis** cópias (item seguinte e passo 2 da restauração). A rodada interrompida fica como está (nunca apagada).
- **Depois:** com o web de volta, as cabeças lidas pela API precisam ser **iguais** às de `<ARQUIVO_DAS_CABECAS>`. Se mudaram, alguém gravou
  durante a janela: marcar a rodada como incompleta nas seis pastas (`printf 'rodada <RODADA> INCOMPLETA\nmotivo: cabeças mudaram durante a
  janela\n' > <destino>/<RODADA>/RODADA-INCOMPLETA`) e fazer outra, com outro rótulo; a incompleta nunca é apagada nem reaproveitada.
- Uma rodada só vale com `RODADA-VALIDA` e sem `RODADA-INCOMPLETA` nas seis pastas. Falha em qualquer passo ⇒ o `trap` grava
  `RODADA-INCOMPLETA` (data e hora UTC, passo, código de saída) em toda pasta da rodada já criada, religa o web e avisa no stderr; as pastas
  parciais ficam como estão e a restauração as recusa.
- Envio remoto (`rsync` para outra máquina ou `restic` com um repositório **por destino**): as mesmas regras, ou seja, rodada nova e
  exclusiva, hashes da origem conferidos na cópia, **nunca `--delete`**, nunca sobrescrever, nunca `restic forget` de uma rodada que seja a
  única referência.
- **Reconciliação da guarda logo depois da rodada** (D-G0-2; G1.b.2b), fora da VPS, sobre a cópia do livro desta rodada:
  `npm run -s link-audit:guard-reconcile -- reconcile --backup <DESTINO_BACKUP_LIVRO>/<RODADA> --records-dir <PASTA_DOS_REGISTROS>`
  (runbook da guarda §2). Código ≠ 0 é divergência a tratar; o registro novo fica na pasta dos registros do responsável.
- Conferência no destino, a qualquer momento: `test -f <destino>/<RODADA>/RODADA-VALIDA && test ! -e <destino>/<RODADA>/RODADA-INCOMPLETA && ( cd <destino>/<RODADA>/dados && sha256sum --strict -c ../SHA256SUMS )`.
- Nada é copiado para **dentro** das pastas vivas fora do código (o leitor recusa arquivo criado à mão; checklist de produção §9).

### Restauração da Fase 6 (sempre os pares do mesmo instante, em pasta nova irmã da viva)
1. Consultar a guarda e a reconciliação externa **antes** (G1.b; spec dos portões Q2): restaurar backup mais velho que a guarda congela as
   auditorias afetadas (`GUARD_MISMATCH`), e sem papel administrativo elas não reabrem pela aplicação. Fora da VPS, contra a rodada
   candidata do livro: `npm run -s link-audit:guard-reconcile -- reconcile --backup <DESTINO_BACKUP_LIVRO>/<RODADA> --records-dir
   <PASTA_DOS_REGISTROS>` (G1.b.2b); `GUARD_HEAD_NOT_IN_BACKUP` numa auditoria = essa rodada a congelaria (runbook da guarda,
   `docs/phase6-auditoria-link/producao-g1b-runbook-guarda.md` §9).
2. **Pré-conferência da rodada inteira, antes de restaurar qualquer pasta:** para a rodada escolhida, as **seis** cópias precisam ter
   `RODADA-VALIDA`, nenhuma pode ter `RODADA-INCOMPLETA`, e cada uma confere contra o próprio `SHA256SUMS`. Uma única falha recusa a rodada
   inteira (marcadores parciais de uma morte abrupta caem aqui):
   ```bash
   set -euo pipefail
   for C in "<DESTINO_BACKUP_DADOS_FASE6>/decisions/<RODADA>" "<DESTINO_BACKUP_DADOS_FASE6>/results/<RODADA>" \
            "<DESTINO_BACKUP_RECIBOS_DECISOES>/<RODADA>" "<DESTINO_BACKUP_RECIBOS_RESULTADOS>/<RODADA>" \
            "<DESTINO_BACKUP_LIVRO>/<RODADA>" "<DESTINO_BACKUP_MANIFESTOS>/<RODADA>"; do
     [ -f "$C/RODADA-VALIDA" ] && [ ! -e "$C/RODADA-INCOMPLETA" ] || { echo "rodada recusada: $C" >&2; exit 1; }
     ( cd -- "$C/dados" && sha256sum --quiet --strict -c ../SHA256SUMS )
   done
   ```
   Depois, restaurar **dessa mesma rodada**, decisões + recibos das decisões, resultados + recibos dos resultados e
   o livro (e os manifestos, se preciso). Para cada pasta viva `P` (o caminho de um marcador `GMN_RAIZ_DADOS_*`) e a cópia
   `C=<destino>/<RODADA>`, a restaurada nasce como **irmã** de `P`, nunca dentro dela, e só com o conteúdo de `dados/`:
   ```bash
   set -euo pipefail
   [ -f "$C/RODADA-VALIDA" ] && [ ! -e "$C/RODADA-INCOMPLETA" ] \
     || { echo "rodada sem RODADA-VALIDA ou com RODADA-INCOMPLETA: recusada" >&2; exit 1; }
   N="$P.restaurado-<RODADA>"
   mkdir -m 0700 -- "$N"                                   # exclusivo: falha se já existir
   rsync -a -- "$C/dados"/ "$N"/                            # só os dados: SHA256SUMS, CABECAS.json e marcadores ficam no backup
   ( cd -- "$N" && sha256sum --quiet --strict -c "$C/SHA256SUMS" )
   ```
3. Com **todas** as pastas da rodada restauradas e conferidas, parar o web e trocar cada uma, guardando a viva como irmã (nunca apagar):
   ```bash
   exec 9>"<ARQUIVO_DE_TRAVA_DO_BACKUP>"; flock -n 9 || { echo "rodada de backup em andamento: não restaurar agora" >&2; exit 1; }
   docker service scale gmn_gmn-web=0                      # a trava fica com esta sessão até religar o web (passo 4)
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
