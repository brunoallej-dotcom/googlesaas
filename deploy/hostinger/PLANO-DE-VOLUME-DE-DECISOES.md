# Plano: volumes graváveis dedicados para as decisões humanas e suas âncoras (Onda 6B)

> **Status: SOMENTE PLANO. Nada deste documento foi aplicado.** O `stack.yml`, o `Dockerfile` e o `docker-entrypoint.sh` **não foram alterados**; nada foi feito na VPS; nenhuma imagem foi construída. A execução exige autorização específica, em uma etapa de implantação própria (sugestão: "H2"), com leitura primeiro e um bloco por vez, como no `ROTEIRO-H1-SUPERVISIONADO.md`.

## Por que é necessário
A Onda 6B grava decisões humanas (`GMN_LINK_AUDIT_DECISIONS_DIR/<auditId>/dNNNN.json`) e, para cada uma, um **recibo imutável** em **outra pasta** (`GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR/<auditId>/aNNNN.json`). O recibo é o que torna detectável a perda do FIM do histórico (arquivo(s) apagado(s), hash do último refeito, backup antigo restaurado); veja `docs/phase6-auditoria-link/onda6b-adr-ancora-externa.md`. **Uma decisão só é confirmada quando o arquivo E o recibo estão gravados** (Emenda 1 do ADR): se o volume de âncoras falhar depois da decisão, a resposta é 503 `ANCHOR_PENDING` (nunca sucesso) e a decisão fica PENDENTE até o autor reenviar o mesmo pedido. **Os dois locais precisam ser independentes** (volume/disco e backup distintos): se ficarem no mesmo disco e no mesmo backup, a proteção cai para a de uma pasta só. Hoje, na v1.0.1, o serviço web:
- monta as evidências em `/data/evidence` com `read_only: true` (**e deve continuar assim**: as evidências são imutáveis e as decisões não podem ir para lá);
- tem o sistema de arquivos raiz `read_only: true` e só dois binds graváveis (`/app/.data/audits` e `/app/.data/link-audits`), que **não** são o lugar das decisões (misturariam dados de naturezas e backups diferentes).
Sem um volume próprio, as rotas de decisões respondem **503** (`DECISIONS_NOT_CONFIGURED`/`DECISIONS_STORAGE_UNAVAILABLE`) e **nada é gravado**: o comportamento é falha fechada, então publicar o código da 6B sem o volume é seguro, apenas inoperante.

## Desenho
| Item | Valor proposto |
|---|---|
| Pastas no host | `${GMN_DATA_ROOT:-/srv/gmn}/decisions` **e** `${GMN_ANCHOR_ROOT}/decision-anchors` (esta, de preferência em **outro disco/volume**, com backup próprio; separadas de `evidence`, `audits` e `link-audits`) |
| Dono e modo | uid/gid `10001`, `0700` nas duas (o mesmo usuário não-root do contêiner) |
| Montagem | somente no serviço **web**, **leitura e escrita**, em `/data/decisions` e `/data/decision-anchors`; **não** montar no Worker |
| Variáveis | `GMN_LINK_AUDIT_DECISIONS_DIR=/data/decisions` e `GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR=/data/decision-anchors` (valores não secretos, podem ficar no `environment` do web) |
| Evidências | continuam em `/data/evidence`, `read_only: true`, **sem nenhuma mudança** |
| Rede / portas | nenhuma mudança (sem portas publicadas) |
| Raiz do contêiner | continua `read_only: true`; `cap_drop: ALL` e demais endurecimentos inalterados |

Trecho ilustrativo para o serviço `gmn-web` (**não aplicado**):
```yaml
    environment:
      GMN_LINK_AUDIT_DECISIONS_DIR: /data/decisions
      GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR: /data/decision-anchors
    volumes:
      - type: bind
        source: ${GMN_DATA_ROOT:-/srv/gmn}/decisions
        target: /data/decisions        # leitura e escrita (propositalmente SEM read_only)
      - type: bind
        source: ${GMN_ANCHOR_ROOT}/decision-anchors   # OUTRO local de gravação (outro disco/volume e backup)
        target: /data/decision-anchors
```
Regras que o código já impõe e que a configuração não pode violar: as pastas de decisões, de âncoras e de evidências **não podem ser a mesma, nem estar uma dentro da outra**, nem estar em `public/`, `src/`, `.next/` ou `node_modules/` do aplicativo, e precisa ser um caminho absoluto de uma pasta **existente** (o módulo não cria a base). Qualquer violação → 503 `DECISIONS_MISCONFIGURED` ou `DECISIONS_STORAGE_UNAVAILABLE`.

## Passos futuros (cada um com autorização; leitura primeiro)
1. **Leitura (VPS)**: confirmar espaço em disco, dono de `${GMN_DATA_ROOT}`, o local escolhido para as âncoras (outro disco/volume) e que as duas pastas ainda não existem. Nenhuma escrita.
2. **Preparar o host**: `sudo install -d -o 10001 -g 10001 -m 0700 /srv/gmn/decisions` e o mesmo para a pasta de âncoras no outro local. Conferir `stat` das duas.
3. **Código**: na pasta local, alterar `stack.yml` (bind + variável), `Dockerfile` (`mkdir -p /data/decisions` e `chown`, como já é feito para `/data/evidence`) e o teste estático `tests/deploy-config.test.ts` (os volumes de decisões e de âncoras são graváveis **somente** no web, o de evidências continua `:ro`, o Worker não monta nenhum dos três, nenhum valor secreto em arquivo). Nova imagem com nova tag (ex.: `1.0.2`); `verify-local.sh` e `npm test` no ambiente isolado (`scripts/run-isolated.sh`).
4. **Implantar** a nova tag seguindo `GUIA-DE-IMPLANTACAO.md` e `PLANO-DE-ROLLBACK.md` (começa por `scale ...=0`; `docker stack rm` só com autorização separada).
5. **Verificar** (`VERIFICACAO-POS-DEPLOY.md` + itens abaixo). **Não** criar decisões de teste sobre uma auditoria real: a leitura (`GET`) de uma auditoria existente deve responder 200 vazio; qualquer teste de escrita deve usar uma auditoria sintética criada para isso, combinada antes.

## Verificações pós-implantação (propostas)
- `GET /api/link-audit/decisions/<auditId>` autenticado → 200 com `decisions: []`, `head: null` e `anchors: { count: 0, … }`; sem sessão → 401. Sem a variável de âncoras → 503 `ANCHOR_NOT_CONFIGURED`.
- Dentro do contêiner web: `/data/evidence` continua somente leitura (`touch` falha); `/data/decisions` e `/data/decision-anchors` aceitam escrita **apenas** pelo uid 10001; o Worker não enxerga nenhum dos três.
- No host: `stat -c '%u:%g %a'` das duas pastas → `10001:10001 700`; as duas em locais de backup distintos.
- Nenhuma porta nova publicada; nenhum segredo novo.
- **Monitorar o volume de âncoras** (espaço e erros de escrita): se ele falhar, as escritas respondem 503 `ANCHOR_PENDING` e a auditoria fica com uma decisão pendente — as leituras continuam e nada é perdido, mas **ninguém consegue gravar nessa auditoria** até o volume voltar e o autor reenviar (procedimento em `onda6b-decisoes-humanas.md` §15). Alertar quando houver 503 repetido nas rotas de decisões.

## Backup e restauração
As decisões são **dados de auditoria que não podem ser refeitos** (decisões humanas com autoria e data), e as âncoras são a sua prova de integridade. Incluí-las no `PLANO-DE-BACKUP-E-RESTAURACAO.md` quando os volumes existirem — **cada pasta com o seu próprio backup, em destinos independentes** (restaurar as duas do mesmo instante só esconde um retrocesso se ambas vierem do mesmo backup antigo; o `head` guardado fora e o `expectedHead` dos operadores o acusam):
- cópia periódica **fora do disco da VPS** (o mesmo princípio das evidências: "mesmo disco não é backup independente"), com `sha256sum` por arquivo e hash agregado, sem `--delete` e sem sobrescrever;
- guardar, junto, o `head` (`seq` + `sha256`) de cada auditoria devolvido pela API (a 6C deve fixá-lo em cada resultado): é a referência que detecta o retrocesso **coordenado** das duas pastas;
- restaurar sempre as DUAS pastas do mesmo instante, em pasta nova, conferir lendo pela API (um histórico que não confere devolve 409 e nenhum dado) e só então trocar os volumes; **nunca** apagar arquivos para "destravar" uma auditoria (procedimento de quarentena em `onda6b-decisoes-humanas.md` §15).

## Riscos e observações
- **Imutabilidade é por convenção e por modo de arquivo (0444)**, não por assinatura: quem tem acesso root à VPS pode alterar arquivos; a cadeia de hashes e as âncoras detectam a alteração na leitura (409), não a impedem. **Quem altera as duas pastas de forma coordenada não é detectado** (por isso os locais independentes).
- **Sem o volume** nada quebra: as rotas ficam em 503. Com o volume **cheio** ou com erro de disco (`ENOSPC`/`EIO`/`EROFS`), as escritas falham sem publicar arquivos parciais; após `EIO`/`EROFS` as escritas ficam bloqueadas até reiniciar o serviço.
- **Uma única réplica do web** hoje. Mesmo com mais de uma, a gravação é segura entre processos (`link()` exclusivo + releitura em conflito), desde que o volume seja um único diretório compartilhado e com semântica POSIX local; **não usar NFS/SMB** sem validar `link()` e `fsync`.
- O código não faz migração entre volumes nem remove arquivos; qualquer limpeza é manual e exige autorização.
