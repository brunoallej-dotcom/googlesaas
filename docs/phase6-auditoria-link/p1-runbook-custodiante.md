# P1 — Runbook do custodiante (estação de assinatura, chave K1, `sign`, `close-key`, suplente)

> **Status:** procedimento escrito na fatia **W5.1** (22/11/2026), **ainda não ensaiado**. O ensaio em homologação com chave
> descartável é a W5.3 (roteiro em `p1-relatorio-ensaio-modelo.md`). Só documentação: nenhum código mudou. Decisões aplicadas:
> D4, D10–D14 e **D15.1–D15.7** da spec `docs/specs/link-audit-p1-attestation.md` (§13.1 e tabela §13.4).
>
> **Repositório público.** Este documento **nunca** tem valor real: nada de nome de pessoa, e-mail, host, IP, caminho de
> produção, local físico ou material de chave. Onde há valor, há marcador (`<PASTA_DA_CHAVE>`, `<MIDIA_1>`). Os valores reais
> ficam só no dossiê offline (`p1-modelo-dossie.md`) e no livro de manifestos (`p1-livro-de-manifestos.md`).
>
> **Não duplica:** a lista de chaves com estado, a rotação planejada, o comprometimento e o fecho de aposentadoria do lado do
> servidor estão no `onda6c-runbook-chaves.md` §4. Aqui fica o lado da estação.

## 0. Papéis e rótulos

| Rótulo | Papel | Hoje (D15.1) |
|---|---|---|
| `CUST-01` | Custodiante titular: guarda a chave K1 e roda o `sign` e o `close-key` | o responsável |
| `CONF-01` | Conferente: confere a procedência e aprova (`p1-runbook-conferente.md`) | não há pessoa distinta: o próprio titular, **marcado** |
| `<OPERADOR>` | Operador da coleta: roda a coleta LIVE com `--json` e registra o hash em canal separado | o responsável |
| suplente | Segundo custodiante, com **par próprio** | **não existe** (§12) |

A regra padrão é conferente ≠ custodiante (D4). Enquanto não houver segunda pessoa, toda assinatura real sai com
`--risk-acceptance` e com `requiresLaterReview: true` (§8). **Ações exclusivas do responsável (D15.7, não delegáveis):** a
cerimônia da chave REAL (§4.2), a assinatura do aceite formal de risco, a escolha dos locais físicos das cópias e todo deploy
de produção.

## 1. Estação de assinatura (D15.3)

Conferir antes de cada sessão de assinatura e registrar no livro (seção "Sessões"):

| # | Requisito | Como conferir |
|---|---|---|
| E1 | Linux dedicado (o `sign` prova a custódia pelo descritor em `/proc/self/fd`; fora do Linux, recusa) | `uname -s` mostra `Linux` |
| E2 | **Sem rede durante a assinatura** | desligar cabo e Wi-Fi fisicamente; `ip -brief address` só mostra `lo` com endereço |
| E3 | Node da **linha 22**, por caminho absoluto, versão anotada no livro (o Node 24.22 em diante bloqueia `fsync` sob `--permission` e o artefato recusa com `SIGN_RUNTIME_NO_FSYNC`) | `<NODE22> --version` começa com `v22.`; anotar a saída exata |
| E4 | Sem clone do repositório (a custódia recusa chave sob árvore com `.git`) | `find <ESTACAO> <PASTA_DA_CHAVE> -name .git` não lista nada |
| E5 | Pasta da chave em `0700`, arquivo da chave em `0600` com um só nome; pastas ACIMA não graváveis por outros | `stat -c '%a %U' <PASTA_DA_CHAVE>` = `700 <usuário>`; `stat -c '%a %h %U' <PASTA_DA_CHAVE>/<ARQUIVO_DA_CHAVE>` = `600 1 <usuário>`; `namei -m <PASTA_DA_CHAVE>/<ARQUIVO_DA_CHAVE>`: nenhuma pasta com `w` para grupo ou outros, salvo `t` (sticky) |
| E6 | Ambiente sem variáveis de segredo e sem `NODE_*` (salvo `NODE_ENV`) | a linha do §3 usa `env -i`: o artefato só roda com o ambiente **vazio** (`SIGN_RUNTIME_UNSAFE` se não estiver) |
| E7 | Pasta de recibos do custodiante, sem escrita para grupo e outros; pastas acima do custodiante ou do root | `stat -c '%a %U' <PASTA_DE_RECIBOS>`; `namei -m <PASTA_DE_RECIBOS>` |
| E8 | Nenhuma pasta da estação dentro de `/tmp`, `/var/tmp` ou `/dev/shm` (o artefato recusa manifestos em pasta temporária) | caminhos de §1.1 fora dessas raízes |

Recomendado, fora da D15.3: disco cifrado, swap e hibernação desligados, sem navegador nem IDE na estação.

**Node 22 da estação.** Baixar o pacote oficial da linha 22 numa máquina com rede, conferir o `SHASUMS256.txt` publicado pelo
projeto Node.js, levar por mídia e instalar numa pasta do custodiante ou do root, fora de `/tmp`. Usar sempre o caminho
absoluto (`<NODE22>`); nunca o `node` do `PATH` (um `node` trocado no `PATH` já seria código arbitrário, e o artefato não
confere o caminho, spec §5.5.1, notas da W4.6).

### 1.1 Pastas da estação (marcadores)

Todas por caminho real (sem link simbólico em nenhum componente: o artefato recusa grant que não seja o próprio caminho real),
sem barra final, e **nenhum caminho pode ser prefixo de texto de outro** (o Node nega o grant mais curto nesse caso; spec
§5.5.1, notas da W4.6). Por exemplo, não use `…/manifestos` e `…/manifestos-velhos` ao mesmo tempo.

| Marcador | Conteúdo | Modo |
|---|---|---|
| `<PASTA_DO_ARTEFATO>` | `link-audit-sign.cjs` e a cópia conferida de `p1-sign-artifact.sha256` | pasta sem escrita para grupo/outros; artefato `0444`, do custodiante ou do root |
| `<PASTA_DAS_ENTRADAS>` | pacote, `approval.json`, dossiê parte A e aceite de risco da sessão | `0700` |
| `<PASTA_DE_MANIFESTOS>` | cópia da pasta de manifestos do servidor (`<auditId>/seal-NNNN.json` e `_closures/`) | `0700` |
| `<PASTA_DE_RECIBOS>` | um recibo de assinatura por arquivo `*.json` (registro externo do `close-key`) | `0700` |
| `<PASTA_DE_SAIDA>` | saída bruta do `--json` antes de virar recibo (§3.2) | `0700` |
| `<PASTA_DA_CHAVE>` | só o arquivo da chave cifrada | `0700` |

## 2. Artefato do `sign`: obter e conferir

1. Numa máquina com rede, baixar o artefato `link-audit-sign-artifact` do job `sign-artifact` do CI (`.github/workflows/ci.yml`)
   da `main`. Ele traz `link-audit-sign.cjs` e `p1-sign-artifact.sha256` lado a lado.
2. Conferir que o `p1-sign-artifact.sha256` baixado é **idêntico** ao versionado em
   `docs/phase6-auditoria-link/p1-sign-artifact.sha256` no mesmo commit da `main` (os dois lugares da spec §5.5.1 item 6).
   Limite declarado: os dois estão sob a mesma conta do GitHub.
3. Levar os dois arquivos por mídia para `<PASTA_DO_ARTEFATO>`; `chmod 0444` nos dois.
4. Anotar no livro o hash vigente e o commit de origem.

**Imediatamente antes de cada execução** (a mesma linha do §3, revisão independente da W4.6):

```
namei -m <PASTA_DO_ARTEFATO>/link-audit-sign.cjs
stat -c '%a %U' <PASTA_DO_ARTEFATO>/link-audit-sign.cjs
( cd <PASTA_DO_ARTEFATO> && sha256sum -c p1-sign-artifact.sha256 )
```

Esperado: nenhuma pasta do caminho com escrita para grupo ou outros (salvo sticky); `444` e dono = custodiante ou root;
`link-audit-sign.cjs: OK`. Qualquer outra saída: **não execute**. O `artifactSha256` do recibo é anotação do próprio processo,
não prova (decisão da W4.6); o controle é esta conferência.

## 3. Linha exata de execução do `sign` (spec §5.5.1, notas da W4.6)

```
namei -m <PASTA_DO_ARTEFATO>/link-audit-sign.cjs
( cd <PASTA_DO_ARTEFATO> && sha256sum -c p1-sign-artifact.sha256 ) && \
env -i <NODE22> --disable-sigusr1 --permission \
  --allow-fs-read=<PASTA_DO_ARTEFATO> --allow-fs-read=<PASTA_DAS_ENTRADAS> \
  --allow-fs-read=<PASTA_DE_MANIFESTOS> --allow-fs-write=<PASTA_DE_MANIFESTOS> \
  --allow-fs-read=<PASTA_DA_CHAVE> <um --allow-fs-read=<pasta>/.git para CADA pasta acima de <PASTA_DA_CHAVE>, até /.git> \
  --allow-fs-read=/tmp --allow-fs-read=/var/tmp --allow-fs-read=/dev/shm \
  --allow-fs-read=/proc/self/cmdline --allow-fs-read=/proc/self/environ --allow-fs-read=/proc/self/fd \
  <PASTA_DO_ARTEFATO>/link-audit-sign.cjs sign \
  --audit <AUDITORIA> --package <PASTA_DAS_ENTRADAS>/<PACOTE>.json --approval <PASTA_DAS_ENTRADAS>/approval.json \
  --dossier <PASTA_DAS_ENTRADAS>/<DOSSIE_PARTE_A> --risk-acceptance <PASTA_DAS_ENTRADAS>/<ACEITE_DE_RISCO> \
  --seals-dir <PASTA_DE_MANIFESTOS> --expect-seq <N> [--first] \
  --key-id <KEY_ID> --key-source file:<PASTA_DA_CHAVE>/<ARQUIVO_DA_CHAVE> --custodian CUST-01 \
  --trust-keys '<LISTA_DE_CHAVES_COM_ESTADO>' --json > <PASTA_DE_SAIDA>/<AUDITORIA>-seal-<NNNN>.json
```

- Opções do `sign`: `src/lib/link-audit-attestation/sign-args.ts:33-34` e `sign-cli.ts:28-35`. `--first` só com
  `--expect-seq 1` (`sign-args.ts:144`). `--risk-acceptance` só quando conferente e custodiante coincidem (hoje, sempre; §8).
- Os `.git` de cima: com a chave em `/a/b/c/<ARQUIVO_DA_CHAVE>`, conceda `/a/b/.git`, `/a/.git` e `/.git` (o `.git` da
  própria `<PASTA_DA_CHAVE>` já está dentro do grant dela). A custódia faz `lstat` desses caminhos (`sign-key.ts:167-178`); eles
  podem não existir, desde que a pasta-mãe seja caminho real.
- `--expect-seq` vem do **livro de manifestos** (registro externo), nunca da pasta (§5.5 passo 7). `--trust-keys` é a lista
  **pública** com estado, a mesma do servidor de destino, com `<KEY_ID>` como `active` (senão `SIGN_KEY_NOT_ACTIVE`).
- A saída padrão vai para arquivo porque, com `--json`, ela é **um único objeto**: o recibo (sucesso) ou `{ok:false,…}`
  (recusa). As telas da confirmação e da frase saem na saída de erro (`sign-cli.ts:232,246`), e o terminal continua o mesmo.
  Com `--json`, a pública derivada (`<KEY_ID>:<pública>`) também sai na saída de erro.

### 3.1 O que o custodiante faz durante a execução

1. Confere na tela só `auditId`, `seq` e número de entradas.
2. Digita, sem eco, os **12 primeiros caracteres de `packageSha256` lidos no dossiê parte A** (papel ou arquivo fora desta
   tela), nunca da saída do `export` nesta estação.
3. Digita a frase da chave, sem eco, uma vez (errou: rode de novo).
4. Confere que a pública impressa é a da lista para `<KEY_ID>` (o `sign` já recusa a diferença com `SIGN_KEY_MISMATCH`).

### 3.2 Recibo de assinatura (parte B do dossiê)

Código de saída `0` e o arquivo começando por `{"ok":true` ⇒ o manifesto foi gravado em
`<PASTA_DE_MANIFESTOS>/<AUDITORIA>/seal-<NNNN>.json`. Então:

```
chmod 0444 <PASTA_DE_SAIDA>/<AUDITORIA>-seal-<NNNN>.json
mv <PASTA_DE_SAIDA>/<AUDITORIA>-seal-<NNNN>.json <PASTA_DE_RECIBOS>/
```

O recibo vai para a pasta de recibos **só** no sucesso: o `close-key` recusa a pasta inteira se houver um arquivo que não seja
recibo válido (`sign-receipts.ts:12-19`, nada é ignorado em silêncio), inclusive oculto, temporário ou `{ok:false}`. Copiar o
recibo também para o dossiê parte B e registrar a linha no livro. Código `3` (`RECUSADO`) ou `4`: nada foi assinado; apagar a
saída bruta e seguir o §11.

## 4. Chave K1: gerar, cifrar e conferir o perfil (D11, D15.4)

### 4.1 Parâmetros fixados (D15.4)

| Item | Valor obrigatório |
|---|---|
| Recipiente | PKCS#8 cifrado (PEM "ENCRYPTED PRIVATE KEY"), PBES2; o `sign` recusa texto claro (`SECRET_NOT_ENCRYPTED`) e PBES1 (`SIGN_KEY_UNPROTECTED`) |
| KDF | **scrypt, N = 2^17 (131072), r = 8, p = 1** (`MIN_SCRYPT_COST`, `sign-key.ts:314`) |
| Cifra | **AES-256-CBC** |
| Alternativa (só se o scrypt não estiver disponível) | PBKDF2 com PRF **HMAC-SHA256** e **≥ 600 000** iterações (`MIN_PBKDF2_ITERATIONS`, `sign-key.ts:312`) |
| Frase | **diceware de 7 ou mais palavras**, sorteadas com dados físicos numa lista diceware publicada; escrita só em papel, guardada longe das mídias |

O aviso `Aviso (KDF): …` do `sign` (`sign-key.ts:354-360`) confere só o custo N ou as iterações; **não** confere `r`, `p`,
PRF nem cifra. Por isso a conferência completa do §4.4 é obrigatória antes de qualquer uso.

### 4.2 Duas cerimônias, separadas

| | Chave do ENSAIO (W5.3) | Chave REAL |
|---|---|---|
| Quem | quem conduz o ensaio | **somente o responsável (D15.7)** |
| Quando | no ensaio em homologação | depois do relatório do ensaio aprovado e do aceite formal de risco assinado (D15.1) |
| `keyId` | `<KEY_ID_ENSAIO>`, que nunca será reutilizado | `<KEY_ID_REAL>`, formato `ek-AAAAMM-a` (contrato P1 §2) |
| Lista de chaves | só a da pilha de homologação | a de produção, por deploy do responsável |
| Cópias | nenhuma além da estação (pode ensaiar o §5 com mídias descartáveis) | duas mídias offline (§5) |
| Fim | destruída no fim do ensaio, com registro (§10) | aposentada a cada 12 meses (§9) ou revogada por comprometimento |

A chave do ensaio **nunca** vira a real, e a real **nunca** entra na pilha de homologação.

### 4.3 Geração (mesmos comandos nas duas cerimônias, na estação, sem rede)

```
umask 077
mkdir -m 0700 <PASTA_DA_CHAVE>
openssl genpkey -algorithm ed25519 | \
  openssl pkcs8 -topk8 -v2 aes-256-cbc -scrypt -scrypt_N 131072 -scrypt_r 8 -scrypt_p 1 \
  -out <PASTA_DA_CHAVE>/<ARQUIVO_DA_CHAVE>
chmod 0600 <PASTA_DA_CHAVE>/<ARQUIVO_DA_CHAVE>
```

- A chave em claro só passa pelo pipe (memória), nunca por disco. A frase é pedida pelo `openssl pkcs8` no terminal, duas vezes.
  **Nunca** use `-passout` nem `-passin` com valor: ficaria em `ps`, no histórico e em `/proc`.
- Alternativa PBKDF2 (§4.1): troque `-scrypt -scrypt_N 131072 -scrypt_r 8 -scrypt_p 1` por `-v2prf hmacWithSHA256 -iter 600000`
  (ou mais).
- Pública para a lista (32 bytes em base64url; a frase é pedida de novo):

```
openssl pkey -in <PASTA_DA_CHAVE>/<ARQUIVO_DA_CHAVE> -pubout -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '='
```

  O item da lista fica `<KEY_ID>:<pública>:active` (`onda6c-runbook-chaves.md` §4). A pública não é segredo e vai para o livro.

### 4.4 Conferir o perfil completo do arquivo ANTES do uso

```
openssl asn1parse -in <PASTA_DA_CHAVE>/<ARQUIVO_DA_CHAVE> | grep -E 'OBJECT|INTEGER'
```

Não pede a frase: os parâmetros do PBES2 ficam em claro no `EncryptedPrivateKeyInfo`. O filtro esconde o sal, o IV e a chave
cifrada (o `[HEX DUMP]` dos `OCTET STRING`), que não devem ser copiados para lugar nenhum. O `asn1parse` mostra os INTEGER em
**hexadecimal**. Esperado, nesta ordem:

| Linha | Perfil scrypt (obrigatório) | Perfil PBKDF2 (alternativa) |
|---|---|---|
| esquema | `OBJECT :PBES2` | `OBJECT :PBES2` |
| KDF | `OBJECT :id-scrypt` | `OBJECT :PBKDF2` |
| custo | `INTEGER :020000` (N = 0x020000 = 131072 = 2^17) | `INTEGER :0927C0` ou maior (0x0927C0 = 600 000 iterações) |
| depois do custo | `INTEGER :08` (r = 8) e `INTEGER :01` (p = 1) | — |
| PRF | — | `OBJECT :hmacWithSHA256` (**ausente = HMAC-SHA1 padrão: recusar**) |
| cifra | `OBJECT :aes-256-cbc` | `OBJECT :aes-256-cbc` |

Um INTEGER a mais logo depois de r/p ou das iterações é o `keyLength` opcional (para AES-256, `:20` = 32 bytes). Qualquer outra
coisa (outro OID, N menor, r ≠ 8, p ≠ 1, PRF ausente ou SHA-1, outra cifra): **não use a chave**; cifre de novo pelo §4.3 e
confira outra vez. Registrar no livro só as linhas de OID e de INTEGER.

> **Ponto a confirmar no ensaio (W5.3).** Esta fatia não executou os comandos acima: é só documentação, e o ambiente de
> desenvolvimento bloqueia arquivos de chave, como deve ser. O formato exato das linhas do `asn1parse` (rótulos dos OIDs, forma
> dos INTEGER) fica confirmado no ensaio com a chave descartável, e a saída filtrada vai para o relatório. Se divergir desta
> tabela, o relatório registra a forma real e este runbook é corrigido antes da cerimônia real.

## 5. Cópias da chave real (D15.2)

1. **Duas mídias offline** (`<MIDIA_1>`, `<MIDIA_2>`), cada uma com uma cópia do arquivo cifrado tal como gerado (mesmo
   `sha256sum`, anotado no livro). Nunca VPS, nuvem, e-mail, chat, repositório ou pasta de evidências, manifestos ou recibos.
2. **Dois locais físicos distintos** (`<LOCAL_1>`, `<LOCAL_2>`) sob controle do titular. Os locais ficam **só no dossiê
   offline**.
3. **A frase nunca fica junto de uma mídia** (nem no mesmo local físico, nem escrita nela).
4. **Teste de restauração na cerimônia e a cada 6 meses**, uma mídia por vez, na estação sem rede, sem copiar a chave para
   disco:
   - `sha256sum <ponto de montagem da mídia>/<ARQUIVO_DA_CHAVE>` igual ao anotado;
   - `openssl asn1parse -in <ponto de montagem da mídia>/<ARQUIVO_DA_CHAVE> | grep -E 'OBJECT|INTEGER'` com o perfil do §4.4;
   - o comando da pública do §4.3 apontando para a mídia: a frase abre a chave, e a pública é igual à da lista.

   Registrar no livro: data, mídia, resultado das três conferências e quem fez (rótulo). Falha numa mídia: refazer a cópia a
   partir da outra e registrar. Falha nas duas: perda da chave (D10). Os manifestos já assinados continuam verificando; novas
   atestações param até um par novo ser gerado (§4) e registrado na lista.

## 6. Fluxo de uma atestação

```
coleta LIVE --json ─► export ─► conferência + dossiê A + approval.json ─► sign ─► recibo (dossiê B) ─► entrega pelo CI ─► verificação
```

1. **Coleta** (operador): a coleta autorizada roda com `--json`; o operador registra `source.capture.sha256` em canal separado,
   antes de qualquer outra coisa (spec §3). Detalhe do comando e da autorização: `onda4b-integracao-provedores.md`.
2. **Export** (conferente, na máquina dele, com o repositório e sem rede; nunca na estação de assinatura, que não tem clone):

   ```
   npm run link-audit:seal -- export --evidence-dir <COPIA_DAS_EVIDENCIAS> --audit <AUDITORIA> \
     --collector-hash c0001=<HASH_DO_COLETOR> --max-gap-hours 24 \
     --seals-dir <COPIA_DOS_MANIFESTOS> --out <FORA_DO_PROJETO>/<PACOTE>.json
   ```

   Opções em `scripts/link-audit-seal.ts:31-46`. Um `--collector-hash` por captura nova; `--max-gap-hours 24` (D13); `--out` fora
   da árvore do projeto e da pasta de evidências (`EXPORT_OUT_UNSAFE`). Detalhe da conferência no `p1-runbook-conferente.md`.
3. **Conferência e aprovação** (conferente): dossiê parte A congelado (o SHA-256 dos bytes vai para `approval.json`) e
   `approval.json` (§5.4 da spec).
4. **Transporte para a estação:** pacote, `approval.json`, dossiê A e aceite de risco por mídia, para `<PASTA_DAS_ENTRADAS>`.
   Conferir `sha256sum` do arquivo do pacote contra o anotado no dossiê A.
5. **Sign** (§3), **recibo** (§3.2), **entrega** (`p1-canal-de-entrega-manifestos.md`) e **verificação pós-entrega**: a prévia da
   auditoria passa a mostrar a origem da coleta autenticada; o resultado anota no dossiê B.

> **Nunca reexporte depois da conferência.** `gap.observedHours` está DENTRO do `packageSha256`, arredondado para cima à hora
> (spec §5.3.2): duas exportações em horas diferentes dão hashes diferentes. O `sign` assina exatamente os bytes do pacote
> aprovado e recusa um pacote que não é o aprovado (`SIGN_PACKAGE_MISMATCH`). Conferir, aprovar e assinar sempre os **mesmos
> bytes**. Se o pacote se perder ou mudar: novo `export`, nova conferência, novo dossiê A, nova aprovação.

## 7. Cópia da pasta de manifestos na estação

O `sign` lê a cadeia na cópia da estação para calcular o `seq`, verificar a cadeia e fazer o autoteste. Antes de cada sessão,
trazer do servidor (homologação ou produção) uma cópia somente leitura da pasta de manifestos (`<auditId>/` e `_closures/`) e
conferi-la contra o livro (último `seq` e `sealSha256` de cada auditoria). Divergência (manifesto a mais, a menos ou com outro
hash) é incidente: não assine. Um temporário `.seal-NNNN.json.tmp-<hex>` deixado por queda pode ser apagado (spec §5.5.1
item 4); um `seal-NNNN.json`, nunca.

## 8. Aceite de risco e revisão posterior (D15.1, D15.6)

- Enquanto não houver conferente distinto, `approvedBy` = `CUST-01` = `--custodian`. O `sign` só assina com
  `approval.riskAcceptance` = `{id, sha256}` do arquivo do aceite formal e com `--risk-acceptance` apontando para os **mesmos
  bytes** (senão `SIGN_ROLE_SEPARATION`). O recibo sai com `roleException: true` e `requiresLaterReview: true`.
- O aceite formal é do responsável (D15.7): modelo no `p1-modelo-dossie.md` §3. Um arquivo vazio não é aceite.
- `operator = approvedBy` também marca `requiresLaterReview` (§5.5 passo 9). **`operator = custodiante` (D15.6(d)) ainda NÃO
  marca no código** (pendência da W5.2). Hoje isso não muda nada, porque com uma só pessoa a marca já vem do aceite de risco. A
  marca faz diferença quando houver conferente distinto e o operador continuar sendo o custodiante.
- Toda atestação com `requiresLaterReview: true` entra na revisão amostral trimestral do livro (D15.6(b)).

## 9. Aposentadoria e fecho (`close-key`)

Quando: rotação planejada a cada 12 meses (D12) ou descomissionamento do suplente. Comprometimento **não** usa fecho: a chave vira
`revoked` na lista (`onda6c-runbook-chaves.md` §4). Pré-requisitos: a chave a aposentar (`R`) já parou de assinar; existe outra
chave `active` (`S ≠ R`) na estação; a pasta de recibos tem todos os recibos de `R` (o registro externo); a cópia da pasta de
manifestos está atualizada.

**Decisão do manager sob a delegação D15 (22/11/2026): linha larga de LEITURA para o `close-key`.** A conferência dos recibos
faz `lstat` de cada pasta ACIMA da pasta de recibos e da cópia do servidor, até `/` (`sign-receipts.ts:224-241`). Sob
`--permission`, o `lstat` de uma pasta exige grant de leitura nela, e o grant do Node vale para a subárvore inteira. Por isso o
`close-key` usa `--allow-fs-read=/` e escreve **só** em `<PASTA_DE_MANIFESTOS>/_closures`:

```
mkdir -p <PASTA_DE_MANIFESTOS>/_closures
namei -m <PASTA_DO_ARTEFATO>/link-audit-sign.cjs
( cd <PASTA_DO_ARTEFATO> && sha256sum -c p1-sign-artifact.sha256 ) && \
env -i <NODE22> --disable-sigusr1 --permission \
  --allow-fs-read=/ --allow-fs-write=<PASTA_DE_MANIFESTOS>/_closures \
  <PASTA_DO_ARTEFATO>/link-audit-sign.cjs close-key \
  --retired-key-id <R> --seals-dir <PASTA_DE_MANIFESTOS> --receipts-dir <PASTA_DE_RECIBOS> \
  --key-id <S> --key-source file:<PASTA_DA_CHAVE_S>/<ARQUIVO_DA_CHAVE_S> --custodian CUST-01 \
  --trust-keys '<LISTA_DE_CHAVES_COM_ESTADO>' --json > <PASTA_DE_SAIDA>/fecho-<R>.json
```

- Opções: `sign-args.ts:35-36` e `sign-cli.ts:37-42`. A escrita só em `_closures` é a regra do código para o `close-key`
  (`sign-args.ts:531-532`).
- **A leitura é um grant só (`/`).** Nenhum outro `--allow-fs-read` na linha: `/` é prefixo de texto de qualquer caminho, e o
  Node nega o grant mais curto quando um é prefixo de outro (notas da W4.6).
- **Limite declarado:** a leitura larga **não amplia a escrita** (só `_closures`). Ela deixa o processo ler qualquer arquivo
  que o usuário da estação lê, o que é aceitável porque a estação é dedicada e sem rede (D15.3) e o artefato não carrega módulo
  de rede (guarda de imports da W4.6). No Node 22, o modelo de permissões não restringe rede; o que fecha esse lado é a estação
  desligada da rede.
- **Hoje o artefato recusa esta linha:** o código não aceita `/` como grant em nenhum subcomando (`isNarrowPath`,
  `sign-args.ts:493`, aplicado em `:510`, recusa `SIGN_RUNTIME_UNSAFE`). Aceitar `--allow-fs-read=/` só no `close-key`, como o
  único grant de leitura, e exercitar o `close-key` completo sob `--permission` no CI é **pendência de código da W5.2**. Até lá,
  o `close-key` não completa pelo artefato.

Depois do fecho (o resto é o `onda6c-runbook-chaves.md` §4, passos 4 a 6):

1. conferir na saída: `heads` (as auditorias cobertas), `unknownSealsOnServer` e `receiptedHeadsNotOnServer`. Qualquer dúvida ⇒
   `revoked`, nunca `retired`;
2. entregar `_closures/<R>.json` **byte a byte** pelo canal (`p1-canal-de-entrega-manifestos.md`);
3. o responsável fixa `<R>:<pública>:retired:<closureSha256>` na lista do servidor (deploy dele);
4. destruir **todas** as cópias da privada de `R`, inclusive as duas mídias (§5), e registrar no livro.

## 10. Destruição da chave do ensaio (com registro)

No fim do ensaio da W5.3, antes de arquivar o relatório:

1. marcar `<KEY_ID_ENSAIO>:<pública>:revoked` na lista da pilha de homologação (nunca remover o item; `onda6c-runbook-chaves.md`
   §4). Assim, mesmo que reste uma cópia, nada novo que ela assine autentica ali;
2. apagar o arquivo da chave da estação (`shred -u <PASTA_DA_CHAVE>/<ARQUIVO_DA_CHAVE>`) e de qualquer mídia usada no ensaio; em
   memória flash, apagar não garante destruição física (limite declarado): mídia descartável do ensaio é formatada ou destruída;
3. apagar a frase do ensaio (papel destruído);
4. registrar no livro (seção "Destruição de chaves de ensaio") e no relatório do ensaio: data, `keyId`, método, mídias,
   estado na lista (`revoked`) e quem fez (rótulo).

## 11. Recusas mais prováveis e o que fazer

| Código | O que fazer |
|---|---|
| `SIGN_RUNTIME_NO_FSYNC` | o node não é da linha 22: use `<NODE22>` (§1, E3) |
| `SIGN_RUNTIME_UNSAFE` | linha fora do §3: `env -i`, opções extras do node, grant largo, link simbólico ou pasta temporária num grant |
| `SIGN_ARTIFACT_UNSAFE` / `SIGN_ARTIFACT_UNREADABLE` | modo ou dono do artefato ou da pasta dele (§2) |
| `SECRET_PATH_UNSAFE` | §1, E4/E5: `.git` acima, pasta da chave ≠ `0700`, arquivo ≠ `0600`, mais de um nome, pasta temporária |
| `SIGN_KEY_NOT_ACTIVE` / `SIGN_KEY_MISMATCH` | `--key-id` não está `active` na lista, ou a chave aberta não é a da lista |
| `SIGN_SEQ_MISMATCH` / `SIGN_SEAL_CHAIN_INVALID` | cópia da pasta divergente do livro: §7, incidente; nunca "recomeçar do 1" |
| `SIGN_PACKAGE_MISMATCH` / `SIGN_DOSSIER_MISMATCH` | bytes diferentes dos aprovados: volte à conferência; nunca reexporte para "acertar" |
| `SIGN_ROLE_SEPARATION` | falta o aceite de risco, ou os bytes de `--risk-acceptance` não batem com a aprovação (§8) |
| `SIGN_WRITE_UNCONFIRMED` | o manifesto foi gravado, mas sem prova de durabilidade: **não entregue, não emita recibo**, não apague; registre incidente no livro e leve ao responsável |
| `SIGN_SEQ_CONFLICT` | já existe `seal-NNNN.json` na cópia: incidente (§7) |

## 12. Suplente (D15.1, D10)

**Hoje não há suplente.** Vale a cláusula da D10: titular sem suplente, com o aceite formal do responsável no dossiê antes da
cerimônia da chave real (`p1-modelo-dossie.md` §3).

**Risco declarado e aceito:** se o titular ficar indisponível ou perder as duas cópias da chave, as **novas** atestações
congelam (nenhuma finalização nova até haver par novo registrado). O histórico não é afetado: as públicas continuam verificando
os manifestos já assinados.

**Quando houver uma segunda pessoa:**

1. ela gera o **próprio par** na própria estação (§1 e §4), nunca uma cópia da chave do titular (RS-16; a mesma pública sob dois
   ids invalida a lista inteira);
2. o responsável registra a pública dela como segunda `active` (no máximo 2, D12) e anota no livro;
3. a substituição troca de chave, não copia: em caso de ausência do titular, o suplente assina com a própria chave, e as duas
   se intercalam livremente na mesma cadeia (contrato do verificador `v2`, V2-21);
4. se ela for também conferente distinta: as aprovações passam a ter `approvedBy ≠ custodian`, o `--risk-acceptance` sai do
   fluxo e `requiresLaterReview` volta a ser exceção. A aprovação assinada pelo conferente (RS-03) volta à mesa (D15.6(a));
5. quando o suplente sai: fecho de aposentadoria da chave dele assinado pelo titular (§9).
