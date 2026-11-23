# Portões de produção da Fase 6 — runbook da guarda externa (GE-E7)

> Spec: `docs/specs/link-audit-production-gates.md` §5.1.3 (GE-E5, GE-E7), §5.1.4 (regras 1 a 8), §5.1.5, §5.1.6, §5.1.7 (números,
> rotação da chave do pseudônimo, "Nota da G1.b.2a" e "Nota da G1.b.2b") e §10.1 (linha G-1); decisões D-G0-1 a D-G0-6 (§11); ADR-0003.
> Ameaças: `docs/security/threats/link-audit-portoes-producao.md`. Laboratório: `producao-g1b-laboratorio-pg-g08.md`. Backup:
> `deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md`. Chaves do livro: `onda6c-runbook-chaves.md` §7. Escrito na G1.b.2b (22/11/2026).
>
> **Nada disto foi executado.** Aplicar a migração, criar secrets, implantar (só pelo CI) e reconciliar são ações do **responsável**.
> Repositório público: só marcadores; nenhum host, ref de projeto, IP, chave ou senha.

## 0. As peças e onde cada uma fica

| Peça | Onde fica | Quem tem | Observação |
|---|---|---|---|
| `GMN_LINK_AUDIT_GUARD_DB_URL` (papel `gmn_guard_writer`) | Swarm secret `gmn_link_audit_guard_db_url`, **só no web** | VPS e o cofre do responsável | Só `EXECUTE` na publicação e `SELECT`; `sslmode=verify-full` |
| `GMN_LINK_AUDIT_GUARD_DB_CA` | Swarm secret `gmn_link_audit_guard_db_ca` | VPS e responsável | Pública, mas trocá-la permite interceptar: integridade |
| `GMN_LINK_AUDIT_GUARD_KEY` (+ `…_RETIRED_KEYS` na rotação) | Swarm secret `gmn_link_audit_guard_key` | VPS e o cofre do responsável | Pseudônimo `audit_ref` (D-G0-5) |
| `GMN_LINK_AUDIT_GUARD_READER_DB_URL` (papel `gmn_guard_reader`) e `…_READER_DB_CA` | **Só fora da VPS**, na máquina do responsável (valor ou arquivo `*_FILE`) | Responsável | **Nunca** na VPS (D-G0-2); nenhum arquivo de implantação a cita (teste) |
| Registros da reconciliação `reconcile-NNNNNN.json` | Pasta **dedicada** do responsável, fora da VPS e fora do repositório (caminho real), dona do usuário, `chmod 700`, com backup próprio | Responsável | Encadeados; só os registros na pasta; nunca editar, renomear nem apagar |
| CLI `npm run link-audit:guard-reconcile -- reconcile\|gate` | Máquina do responsável (este repositório) | — | Recusa rodar com `GMN_ROLE` (dentro da pilha) e com a credencial de escrita no ambiente |

**Ambiente da reconciliação** (um shell só para isto, `bash --norc --noprofile`; nada em arquivo de ambiente versionado). Nenhum segredo
em argumento, URL de comando, histórico ou log (revisão do PR #64): os valores são digitados sem eco e vão para arquivos `0600` de uma
pasta temporária da sessão, que o CLI lê pelas variáveis `*_FILE`:

```bash
set +x
umask 077
SESSAO="$(mktemp -d)"; GMN_SESSOES+=("$SESSAO")
# o MESMO trap no runbook e no roteiro do laboratório: apaga TODAS as pastas de sessão deste shell, em qualquer ordem
trap 'rm -rf -- "${GMN_SESSOES[@]}"' EXIT
# TLS obrigatório em TODA conexão psql deste runbook (\password, conferências): cadeia até a CA do projeto E nome do host
export PGSSLMODE=verify-full PGSSLROOTCERT=<ARQUIVO_CA_DO_PROJETO> PGDATABASE=postgres PGPASSFILE="$SESSAO/pgpass"
: > "$PGPASSFILE"
# pg_como <usuário> <host> <porta>: pede a senha sem eco, guarda no PGPASSFILE 0600 da sessão e aponta PGHOST/PGPORT/PGUSER
pg_como() {
  local senha
  read -rsp "senha de $1 em $2:$3: " senha; echo
  printf '%s:%s:*:%s:%s\n' "$2" "$3" "$1" "$(printf '%s' "$senha" | sed 's/[\\:]/\\&/g')" >> "$PGPASSFILE"
  unset senha
  export PGHOST="$2" PGPORT="$3" PGUSER="$1"
}
read -rsp 'URL do leitor (postgresql://gmn_guard_reader[.<REF>]:<senha com escape>@<HOST>:<PORTA>/postgres?sslmode=verify-full): ' V; echo
printf '%s' "$V" > "$SESSAO/reader-url"; unset V
read -rsp 'chave ATUAL do pseudônimo (<id>:<64 hex>): ' K; echo
printf '%s' "$K" > "$SESSAO/guard-key"; unset K
export GMN_LINK_AUDIT_GUARD_READER_DB_URL_FILE="$SESSAO/reader-url" GMN_LINK_AUDIT_GUARD_KEY_FILE="$SESSAO/guard-key"
export GMN_LINK_AUDIT_GUARD_READER_DB_CA_FILE=<ARQUIVO_CA_DO_PROJETO>
# só depois de uma rotação da chave do pseudônimo: TODA chave já usada, separadas por vírgula (a lista da reconciliação nunca encolhe)
read -rsp 'chaves aposentadas (ou Enter): ' R; echo
if [ -n "$R" ]; then printf '%s' "$R" > "$SESSAO/retired-keys"; export GMN_LINK_AUDIT_GUARD_RETIRED_KEYS_FILE="$SESSAO/retired-keys"; fi; unset R
```

Ao terminar: `exit` (o `trap` apaga os arquivos da sessão).

**Conexões `psql` deste runbook** (`\password` nos §4 e §5, conferências): o bloco acima já basta — `PGSSLMODE=verify-full` e
`PGSSLROOTCERT=<ARQUIVO_CA_DO_PROJETO>` exportados, e `pg_como <usuário> <host> <porta>` (igual à do roteiro do laboratório) pede a senha
sem eco e a guarda só no `PGPASSFILE` `0600` da sessão; **nunca** uma URL com senha no comando. Se a sessão do roteiro do laboratório
também for aberta neste shell, em qualquer ordem, as duas usam o mesmo `trap` sobre `GMN_SESSOES` e o `exit` apaga as duas pastas.

## 1. Ativação (antes do primeiro `ENROLL` — regra 1)

Uma auditoria inscrita sem guarda não tem cabeça publicada, e publicar "a de hoje" seria uma adoção que não existe (D-G0-6). Ordem
obrigatória (spec §7; `PROVA-DE-ORIGEM-E-DE-COLETA.md` §3b):

1. **Volumes e chaves da G1.a** prontos e conferidos.
2. **Laboratório do PG-G08** concluído e registrado (`producao-g1b-laboratorio-pg-g08.md`), com o host e o modo de conexão escolhidos
   para a VPS e o prazo de 3 s confirmado (ou o número novo registrado na spec §5.1.7).
3. **Migração em produção**, com autorização própria: `004_link_audit_guard.sql` aplicada como `postgres`; senhas do
   `gmn_guard_writer` e do `gmn_guard_reader` definidas por `\password`; §2 a §5 e §7 a §8 do roteiro do laboratório repetidos em
   produção (só leitura; nenhuma linha de teste).
4. **Secrets na VPS** (`PROVA-DE-ORIGEM-E-DE-COLETA.md` §2): `gmn_link_audit_guard_db_url` (escritor), `gmn_link_audit_guard_db_ca` e
   `gmn_link_audit_guard_key`. A chave do pseudônimo também vai ao cofre do responsável (a reconciliação a usa fora da VPS).
5. **Deploy pelo CI** (a partir da G1.b.2a a stack exige os três secrets). Conferir no log `[gmn-entrypoint] papel=web ok` e nenhum
   `link_audit.guard.unavailable`.
6. **Verificador do portão, sem rodada:** `npm run -s link-audit:guard-reconcile -- gate --json` ⇒ esperado código 2 com
   `EXTERNAL_GUARD_NOT_VERIFIED` e `connection: OK`, `reader: OK` (TLS e leitor provados; ainda não há auditoria para conferir).
7. **Primeiro `ENROLL`** numa auditoria nova e sintética combinada (checklist de produção §10 item 6); a tela deve mostrar
   `externalGuard` = `CONSISTENT` (texto "Guarda externa em dia.").
8. **Primeira rodada de backup** (plano de backup, "Rotina diária") e **primeira reconciliação** com `--first` (§2).
9. **Portão G-1:** `gate --backup <rodada> --json` ⇒ código 0, `operational: true` (em homologação, com as auditorias da G2; em
   produção, antes do primeiro uso real).

Sem a guarda (nenhum dos três secrets), a tela diz "Guarda externa NÃO configurada" (`externalGuard: NOT_CONFIGURED`) e o portão G-1
fica fechado; configuração **parcial ou inválida** deixa o livro inteiro não configurado (escritas 503 `LEDGER_NOT_CONFIGURED`).

## 2. Rotina da reconciliação (D-G0-2): semanal, depois de cada backup do livro e antes de qualquer restauração

Sempre **fora da VPS**, sobre a pasta da rodada do livro (`<DESTINO_BACKUP_LIVRO>/<RODADA>`, com `RODADA-VALIDA`), **logo depois da
rodada** (a rodada é tirada com o web parado; uma escrita entre a rodada e a reconciliação põe a guarda à frente da cópia e aparece como
`GUARD_HEAD_NOT_IN_BACKUP`):

**A pasta dos registros** é dedicada e estrita (revisão do PR #64): fora do repositório pelo caminho real (o repositório é público),
dona do seu usuário e sem escrita para grupo ou outros (`mkdir -m 700 <PASTA_DOS_REGISTROS>`), e **cada pasta acima dela até `/`** do seu
usuário ou do root, sem escrita para grupo ou outros (a menos que tenha o sticky bit, como `/tmp`) — a regra do StrictModes do ssh, que
impede outro usuário de trocar a pasta por um link no meio da gravação. Senão `RECORDS_DIR_UNSAFE`; também numa plataforma em que não dá
para verificar dono e modo. Na gravação, a pasta é conferida de novo antes de publicar e, depois, o registro publicado precisa ser o
mesmo arquivo (mesmo `dev`/`ino`) no mesmo caminho real; qualquer troca no meio ⇒ `RECORDS_DIR_UNSAFE` (código 3), nunca sucesso. Dentro dela só
cabem os `reconcile-NNNNNN.json` e, depois de uma execução interrompida, o temporário órfão do gravador (`.tmp-reconcile-NNNNNN-<16
hex>.json`, arquivo regular — link simbólico ou pasta com esse nome é recusado — que não conta como registro). **Qualquer outro nome** — um LEIA-ME, um registro renomeado — é recusado (`RECORDS_INVALID`):
anotações ficam em outra pasta. A primeira reconciliação (`--first`) só é aceita com a pasta **totalmente vazia**
(`RECORDS_DIR_NOT_EMPTY`), para que renomear os registros nunca faça a cadeia recomeçar.

```bash
# primeira vez (pasta de registros TOTALMENTE vazia)
npm run -s link-audit:guard-reconcile -- reconcile --backup <DESTINO_BACKUP_LIVRO>/<RODADA> --records-dir <PASTA_DOS_REGISTROS> --first
# todas as seguintes (o registro anterior é obrigatório; sem --first)
npm run -s link-audit:guard-reconcile -- reconcile --backup <DESTINO_BACKUP_LIVRO>/<RODADA> --records-dir <PASTA_DOS_REGISTROS>
```

O que ela faz: confere a rodada (marcador e `SHA256SUMS` exatos), lê a guarda **como leitor** (identidade conferida antes de ler,
transação somente leitura, prazo total), compara cabeça a cabeça com o livro da cópia e com as linhas que o registro anterior viu, e
grava `reconcile-NNNNNN.json` novo (criação exclusiva; nunca sobrescreve). `--json` dá a saída estável `gmn.link-audit.guard-reconcile.v1`.

| Código de saída | Significado | O que fazer |
|---|---|---|
| 0 | Sem divergência (`CONSISTENT`, `BEHIND` até `L_max` = 5, ou `NO_HEAD` com 1 registro) | Arquivar a saída junto do registro |
| 2 | Divergência (`findings`), registro novo gravado | §10, achado a achado |
| 3 | Recusa da rodada de backup (`BACKUP_NOT_A_ROUND`, `BACKUP_ROUND_NOT_VALID`, `BACKUP_MANIFEST_INVALID`, `BACKUP_MANIFEST_MISMATCH`, `BACKUP_UNEXPECTED_ENTRY`) | Apontar a pasta `<DESTINO_BACKUP_LIVRO>/<RODADA>` certa; rodada sem `RODADA-VALIDA`, com `RODADA-INCOMPLETA` ou que não confere com o `SHA256SUMS` não serve: usar outra rodada válida e investigar o destino (plano de backup) |
| 3 | Recusa da pasta dos registros: `RECORDS_DIR_INVALID` (não existe, não é diretório comum), `RECORDS_DIR_UNSAFE` (dentro do repositório, de outro dono ou com escrita de grupo/outros), `RECORDS_INVALID` (lacuna, encadeamento quebrado, registro alterado ou nome fora do padrão), `NO_PREVIOUS_RECORD`, `PREVIOUS_RECORD_EXISTS` ou `RECORDS_DIR_NOT_EMPTY` (`--first` indevido), `RECORD_EXISTS` / `RECORD_WRITE_FAILED` | Usar a pasta dedicada certa (`chmod 700`, fora do repositório); nome estranho: tirá-lo da pasta (sem apagar registro); registro renomeado: devolver o nome original; cadeia quebrada: restaurar a pasta do backup dela; `RECORD_EXISTS`: rodar de novo |
| 3 | Demais recusas: sem configuração (`NOT_CONFIGURED`), chave retirada da lista (`GUARD_KEY_DROPPED`), credencial que não é do leitor, guarda indisponível ou duplicata na posição máxima (`GUARD_DUPLICATE_HEAD`) | Corrigir a entrada; guarda indisponível ⇒ §8; duplicata ⇒ §10 (incidente no provedor) |
| 1 / 4 | Uso errado / falha inesperada | Repetir com a sintaxe certa; persistindo, levar ao manager |

- A saída lista o **pseudônimo** e, só quando a rodada tem a auditoria, o **`auditId`** (o necessário para agir). Auditoria sem
  problema só entra nas contagens. O registro nunca guarda `auditId`.
- Uma regressão da guarda **continua** acusada em toda rodada seguinte (o registro guarda a marca d'água); uma auditoria congelada e
  abandonada (§10) também continua aparecendo: anote no registro local que é a mesma, conhecida.
- A pasta dos registros é a cópia própria das cabeças (spec §5.1.5): faça backup dela fora da VPS; **nunca** edite, renomeie ou apague
  um registro (a cadeia quebrada, o nome trocado e o arquivo estranho são recusados: `RECORDS_INVALID`). O temporário órfão do
  gravador (`.tmp-reconcile-NNNNNN-<16 hex>.json`, de uma execução interrompida) não conta como registro e pode ser removido; até lá ele
  só impede um `--first` (`RECORDS_DIR_NOT_EMPTY`).

## 3. Verificador do portão G-1 (PG-G07)

`npm run -s link-audit:guard-reconcile -- gate [--backup <rodada>] [--json]` — somente leitura, não grava nada (nem registro). Roda
**fora da VPS**, com o leitor (decisão da G1.b.2b, spec §5.1.7): a imagem do web não traz o CLI, não há contrato HTTP novo nesta etapa,
a credencial de escrita não sai da VPS e o resultado que vale é o de fora.

| `code` (saída 2, não operante) | Significa |
|---|---|
| `NOT_CONFIGURED` | Sem configuração do leitor neste ambiente |
| `CONFIG_INVALID` | Configuração do leitor inválida (`checks.configurationCode` diz o motivo) |
| `GUARD_UNAVAILABLE` | Conexão, TLS, senha ou prazo |
| `GUARD_DUPLICATE_HEAD` | Duas linhas na posição máxima de um pseudônimo (restrição única ausente ou alterada): incidente no provedor (§10) |
| `EXTERNAL_GUARD_NOT_VERIFIED` | Sem `--backup`: TLS e leitor ok, auditorias não conferidas |
| `NO_AUDITS` | A rodada não tem auditoria (o portão exige ao menos uma) |
| `STACK_NOT_PUBLISHING` | Nenhuma auditoria da rodada tem cabeça sob a chave de custódia: a pilha está sem a guarda, publica com outra chave do pseudônimo ou não consegue publicar |
| `NOT_CONSISTENT` | Alguma auditoria não está `CONSISTENT` (listadas em `notConsistent`) ou há achado |

Código 0 = `operational: true`. Código 3 = recusa de entrada do verificador, em duas categorias:

| Código 3 | Ação |
|---|---|
| Mau uso: credencial de escrita no ambiente (`GUARD_WRITER_CREDENTIAL_PRESENT`), URL de outro papel (`GUARD_READER_ROLE_REQUIRED`), sessão que não é do leitor (`NOT_READER_ROLE`, `SESSION_NOT_READ_ONLY`, `READER_CAN_PUBLISH`), dentro da pilha (`INSIDE_THE_STACK`), variável e arquivo juntos (`READER_ENV_INVALID`) | Refazer o ambiente da reconciliação (§0) só com a credencial do leitor, fora da VPS |
| Rodada de backup recusada (`--backup`): `BACKUP_NOT_A_ROUND`, `BACKUP_ROUND_NOT_VALID`, `BACKUP_MANIFEST_INVALID`, `BACKUP_MANIFEST_MISMATCH`, `BACKUP_UNEXPECTED_ENTRY` | Apontar a pasta `<DESTINO_BACKUP_LIVRO>/<RODADA>` de uma rodada **válida** (com `RODADA-VALIDA`, sem `RODADA-INCOMPLETA`, conferindo com o `SHA256SUMS`); se nenhuma serve, tirar uma rodada nova pelo plano de backup e investigar o destino |

## 4. Rotação da credencial do ESCRITOR (`gmn_guard_writer`)

Planejada ou por suspeita. A troca da senha vale na hora e o secret do Swarm é imutável, então há uma janela curta com o web parado
(falha fechada; ninguém gravando):

1. Avisar quem opera; conferir que não há operação aberta na tela.
2. `docker service scale gmn_gmn-web=0` (a mesma mecânica do `PROVA-DE-ORIGEM-E-DE-COLETA.md` §3 item 5).
3. No `psql` como `postgres`, pela sessão segura (§0: `verify-full`, senha do `PGPASSFILE` temporário ou do prompt, nunca URL com
   senha no comando): `\password gmn_guard_writer` (senha nova do cofre, gerada na hora).
4. Recriar o secret `gmn_link_audit_guard_db_url` com a URL nova, a partir do cofre (`read -rs`, `set +x`), e implantar pelo CI.
5. Com o web de volta: a tela mostra `externalGuard` sem `UNAVAILABLE`; nenhum `link_audit.guard.unavailable` no log.
6. **Por suspeita de vazamento:** reconciliar logo depois (§2). Quem tinha a credencial antiga só consegue **congelar** (sequência falsa
   acima da real ⇒ `GUARD_MISMATCH` e alarme `link_audit.guard.conflict`), nunca esconder retrocesso (regra 7). Auditorias congeladas
   assim seguem o §10.

## 5. Rotação da credencial do LEITOR (`gmn_guard_reader`)

Só fora da VPS, sem parar nada: `\password gmn_guard_reader` como `postgres` pela sessão segura (§0: `verify-full`, sem URL com senha
no comando), atualizar o cofre e o arquivo `*_FILE` da sessão da reconciliação, rodar `gate --json` (esperado `connection: OK`). O leitor só lê (pseudônimos e frequência de atividade): vazamento é de confidencialidade, não de integridade.

## 6. Rotação da chave do PSEUDÔNIMO (`GMN_LINK_AUDIT_GUARD_KEY`; spec §5.1.7)

**Sem rotação periódica**; só por comprometimento ou decisão do responsável.

1. Gerar a chave nova na hora, com **id novo e nunca reutilizado** e material diferente de todas as outras chaves da Fase 6 (o servidor
   recusa repetição de id ou material).
2. **Web** (mudança própria pelo CI): a nova como `GMN_LINK_AUDIT_GUARD_KEY`; a antiga em `GMN_LINK_AUDIT_GUARD_RETIRED_KEYS`
   (`<id>:<64 hex>`, **sem data**), entregue por secret só durante a rotação (`PROVA-DE-ORIGEM-E-DE-COLETA.md` §3 item 5). O `latest` lê os
   pseudônimos das duas e fica com a maior posição; a publicação usa só a nova. A primeira publicação de cada auditoria com a chave nova
   acontece na próxima operação dela (a cabeça daquele instante). Nada fica `GUARD_HEAD_MISSING` por causa da troca.
3. **Reconciliação:** a nova como atual e **toda** chave já usada como aposentada — para sempre (as cabeças antigas continuam na
   guarda, que é append-only). Tirar da lista da reconciliação uma chave que o registro anterior usou é recusado (`GUARD_KEY_DROPPED`).
4. **Quando a aposentada sai da lista do WEB:** só quando a reconciliação mostrar `summary.headsOnRetiredKey` = 0 (toda auditoria com
   cabeça tem a maior também sob a chave atual). Auditoria ociosa fica com a cabeça só sob a aposentada até a próxima operação: enquanto
   houver alguma, a aposentada fica no web (ela só lê; não vence).
5. Se a antiga vazou, quem a tem só reverte o pseudônimo por dicionário de `auditId` (confidencialidade); a integridade não depende dela.

## 7. Rotação da chave do LIVRO só com `externalGuard` = `CONSISTENT`

O procedimento é o do `onda6c-runbook-chaves.md` §7 (`RECOVER` em cada auditoria). Com a guarda configurada, o **código recusa** o
`CHECKPOINT` da rotação quando não consegue deixar a guarda em dia: publica a cabeça atual antes e, se não conseguir, responde **503
`LEDGER_GUARD_UNAVAILABLE`** sem gravar nada (spec §5.1.7, G1.b.1). Antes de começar: reconciliar (§2) ou ver na tela `CONSISTENT` em
cada auditoria; se o `RECOVER` for recusado, resolver a guarda (§8) e repetir. Nunca duas rotações na mesma janela sem a guarda em dia:
cada uma soma 1 ao atraso, e acima de `L_max` = 5 a auditoria congela (`GUARD_LAGGING`, sem reabertura).

## 8. Indisponibilidade (falha fechada, D-G0-3)

**Sinais:** `link_audit.guard.unavailable` (ERROR) no log, sem `auditId`; tela "Guarda externa indisponível."; leituras
`HISTORY_UNRESOLVED` com `GUARD_UNAVAILABLE` (nada vigente, nada finalizável); escritas 409 `DECISIONS_HISTORY_UNRESOLVED` ou 503
`LEDGER_GUARD_UNAVAILABLE`. É o comportamento decidido: **sem modo degradado**.

1. De fora: `gate --json`. `GUARD_UNAVAILABLE` também de fora ⇒ provedor, pausa por inatividade, rede ou certificado; `connection: OK` de
   fora ⇒ o problema é do lado da VPS (rede/IPv6 da VPS, secret, CA trocada).
2. Conferir no painel do provedor: projeto pausado (reativar), incidente, certificado novo (CA nova ⇒ novo secret
   `gmn_link_audit_guard_db_ca`, impressão digital conferida, deploy pelo CI).
3. Senha expirada ou trocada por engano ⇒ §4.
4. **Nunca** tirar a configuração da guarda para "destravar": sem ela a vista volta a `NOT_CONFIGURED` (um retrocesso coordenado deixa
   de ser detectado), o portão G-1 fecha, e a stack desta versão nem implanta sem os secrets.
5. Avisos relacionados: `link_audit.guard.publish_failed_after_record` (WARN; a resposta foi de sucesso com `BEHIND`, a próxima operação
   recusa até publicar) e `link_audit.guard.behind_prolonged` (WARN; `BEHIND` há mais de `T` = 15 min).

## 9. Restauração: conferir a guarda e reconciliar ANTES

Nenhuma restauração da Fase 6 começa sem isto (plano de backup, "Restauração da Fase 6", passo 1):

1. Escolher a rodada candidata e rodar a reconciliação **contra ela** (§2). O registro gravado é sobre a guarda; vale normalmente.
2. Ler os achados por auditoria:
   - `GUARD_HEAD_NOT_IN_BACKUP`: a guarda está à frente dessa rodada. Restaurá-la **congela** a auditoria (`GUARD_MISMATCH`) e, sem papel
     administrativo (D-G0-6), ela não reabre pela aplicação. Procure uma rodada mais nova; se não houver, a decisão é do responsável
     (aceitar perder aquela auditoria: abandonar, preservar a evidência, abrir uma nova);
   - `BACKUP_AHEAD_BEYOND_L_MAX` ou `HASH_MISMATCH`: a rodada não é o histórico testemunhado; não restaurar dela;
   - sem achado (`CONSISTENT` ou `BEHIND` até 5): pode restaurar.
3. Restaurar pelo plano de backup (pares do mesmo instante, pasta irmã, conferência por `SHA256SUMS`).
4. Depois: a tela deve mostrar `PROTECTED` com `CONSISTENT` (ou `BEHIND`, que a próxima escrita resolve publicando); registrar o estado
   `externalGuard` (plano de backup, passo 5) e reconciliar de novo depois da rodada de backup seguinte.

## 10. Divergências e estados ruins: o que fazer

Lembrete que vale para todos: **sem papel administrativo (D-G0-6), uma auditoria em `HISTORY_UNRESOLVED` não reabre pela aplicação.** A
saída é abandonar a auditoria, **preservar** a evidência e abrir uma nova. **Nunca** apagar, mover ou copiar arquivos nos volumes para
"destravar" (a edição vira `GUARD_MISMATCH` ou `UNTRUSTED` e fica registrada pela divergência).

| Sinal | Causas prováveis | Ação |
|---|---|---|
| `GUARD_MISMATCH` (tela; alarme `link_audit.guard.mismatch`) | Restauração de backup mais velho que a guarda; rollback coordenado dos volumes; sequência falsa publicada com a credencial de escrita (alarme `conflict` junto) | Reconciliar contra a rodada mais nova. Volumes voltaram no tempo ⇒ incidente na VPS (§4 por suspeita; investigar o host). Sequência falsa ⇒ VPS comprometida: §4, investigação. A auditoria fica congelada (lembrete acima) |
| `GUARD_LAGGING` (alarme `lagging`) | Publicação desligada ou falhando por mais de `L_max` = 5 registros (fluxo legítimo não chega lá); duas rotações da chave do livro sem a guarda em dia | Ver `publish_failed_after_record` no log; resolver a guarda (§8). A auditoria fica congelada |
| `GUARD_HEAD_MISSING` (alarme `head_missing`) | Auditoria inscrita sem guarda (regra 1 violada); chave do pseudônimo do web trocada sem pôr a antiga nas aposentadas | Se foi a chave: devolver a antiga como aposentada no web (§6, passo 2) e o `latest` volta a achar as cabeças. Se foi inscrição sem guarda: congelada |
| `GUARD_REGRESSED` (reconciliação) | Linha da guarda apagada ou alterada: só o dono ou administrador do projeto Supabase, a conta tomada, ou alguém com `session_replication_role` (limite declarado, §11) | **Incidente no provedor:** MFA e acessos da conta, histórico de ações do projeto, comparar com os próprios registros (eles guardam as cabeças); considerar a revisão para Object Lock (ADR-0003). Reconciliar de novo: o achado continua até ser tratado |
| `GUARD_HEAD_NOT_IN_BACKUP` (reconciliação) | A guarda andou depois da rodada (houve escrita depois do backup) ou a cópia perdeu registros | Antes de restaurar: §9. Na rotina: se houve escrita entre a rodada e a reconciliação, o achado é esperado — tire uma rodada nova e reconcilie logo depois dela; só é divergência real se persistir numa rodada sem escrita depois |
| `GUARD_HEAD_WITHOUT_LEDGER` | Livro inteiro de uma auditoria ausente da rodada (ou removido do volume vivo: a tela diz `LEDGER_REMOVED_WITNESSED`) | Conferir a rodada e o volume vivo; livro removido no vivo ⇒ incidente |
| `GUARD_HEAD_UNKNOWN_KEY` | O web publica com chave do pseudônimo fora da custódia; aposentada retirada da lista da reconciliação; lixo publicado com a credencial de escrita | Conferir a chave do web contra o cofre; repor a aposentada na lista da reconciliação; lixo ⇒ §4 por suspeita |
| `HASH_MISMATCH` / `BACKUP_AHEAD_BEYOND_L_MAX` | A cópia não é o histórico testemunhado (adulterada, de outra origem) ou a publicação parou | Não restaurar dessa rodada; investigar o destino do backup e o log de publicação |
| `BACKUP_LEDGER_UNREADABLE` | O livro daquela auditoria na cópia não passa na leitura (lacuna, hash, encadeamento) | Outra rodada; investigar o destino |

## 11. Limites declarados (o que a guarda e a reconciliação NÃO resolvem)

- **Dono ou administrador do projeto Supabase** (ou a conta tomada) altera ou remove gatilhos, privilégios e linhas e restaura o banco
  (D-G0-1, ADR-0003). Em particular, com **`session_replication_role = replica`** os gatilhos não disparam: um `DELETE` ou `UPDATE` direto
  passa (o teste local da G1.b.2a mostra que o próprio superusuário é barrado **sem** esse ajuste, e o da G1.b.2b mostra o `DELETE` com
  ele). A aplicação não percebe; **só a reconciliação acusa** (`GUARD_REGRESSED`), e só para as linhas que ela já viu (a cabeça de cada
  pseudônimo e as linhas do registro anterior). Linhas antigas abaixo da cabeça não são cobradas (o protocolo só usa a maior).
- **Web comprometido** mente sobre o `latest` para a própria tela: detecção só depois do fato, na reconciliação semanal (PP-T1).
- **Janela residual** de até `L_max` = 5 registros: o retrocesso dentro da última operação ainda não publicada passa (regra 3).
- **Corrida na pasta dos registros feita pelo próprio usuário dono dela (ou pelo root):** fora do escopo. A conferência de ancestrais,
  a reconferência antes de publicar e a conferência de `dev`/`ino` depois barram outro usuário; quem já é dono da pasta pode alterá-la de
  qualquer forma (o Node não tem operações relativas a um descritor de diretório, e não se tenta imitar o `openat`).
- A reconciliação **não confere as etiquetas HMAC** do livro (a chave do livro não sai da VPS); o que a guarda testemunha é o
  `contentSha256`, e um registro forjado na cópia não bate com a cabeça publicada.
- Uma pessoa só reconcilia (PP-R1): sem a rotina, nada fora da VPS percebe a guarda que regrediu.
