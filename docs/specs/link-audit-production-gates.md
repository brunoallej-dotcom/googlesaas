# Spec: Portões de produção da Auditoria por Link (Fase 6) fora do Produtor P1

> **Status: APROVADA na onda G0 (20/11/2026). Nada disto está implementado.** Proposta pelo manager em 20/11/2026 a
> partir dos "Bloqueadores de produção" e dos "Riscos residuais" do encerramento da Onda 6C (`NOTES.md`, rodada de
> 16/11/2026). As doze questões foram decididas na G0 (registro D-G0-1 a D-G0-12 na §11); o provedor da guarda está no
> ADR-0003 (`docs/adr/0003-supabase-external-ledger-guard.md`) e as ameaças novas em
> `docs/security/threats/link-audit-portoes-producao.md`. O plano de ondas está em `docs/plan/implementation-waves.md`,
> seção "Portões de produção da Fase 6 (fora do P1)".
>
> **Números de linha.** As citações `arquivo:linha` das §5.1 e §10.4 foram conferidas em `a506ffd` (PR #51). A R1.6
> (`3899a67`) deslocou as de `src/lib/link-audit-ledger/service.ts` e `model.ts`; a tabela de correspondência está na
> §5.1.7. O texto da G0 (§5.1.7 e §11) cita `3899a67`.
>
> **Repositório público.** Nenhum nome de pessoa, e-mail, host, IP, caminho real de produção ou valor de chave entra aqui.
> Onde for preciso, valem marcadores como `<RAIZ_DADOS_RECIBOS>` ou `<NOME_DO_SECRET>`.
>
> **Escopo.** Esta spec trata quatro frentes: (a) a guarda externa, (b) o papel administrativo, (c) os volumes e as chaves
> no `stack.yml` e (d) a D5. Depois consolida o portão de produção (e) e define o piloto mínimo como exceção (f). Ela **não**
> repete o P1 (`docs/specs/link-audit-p1-attestation.md`), **não** especifica a D5 (`onda6c-integracao-orquestracao.md`
> §21) e **não** repete a observabilidade (`docs/specs/link-audit-observability.md`): só referencia o que cada uma exige.
>
> Usa a estrutura de `docs/specs/_template.md`, adaptada: não há contrato HTTP novo nesta etapa, e cada frente tem
> requisitos, estado atual, entregas e casos de borda próprios.

## 1. Objetivo

A Onda 6C foi encerrada com seis bloqueadores de produção (`NOTES.md`, "Bloqueadores de produção, inalterados pelo
encerramento"). Dois são do P1 e já têm plano próprio: a implementação do P1 e o ADR-0002 (onda R1). Esta spec cobre os
outros quatro:

- **guarda externa imutável:** sem ela, o rollback coordenado dos volumes passa por legítimo;
- **papel administrativo com dupla aprovação:** sem ele, uma auditoria congelada não reabre pela aplicação;
- **volumes e chaves no `stack.yml`:** sem eles, a produção falha fechada em tudo;
- **D5:** sem ela, todo resultado real sai INCONCLUSIVO.

Para cada frente, a spec diz o que é exigido, o que existe, o que falta, quais opções existem e qual é a recomendação do
manager. Depois junta tudo, com os portões do P1, numa lista única do que precisa estar pronto antes do **primeiro
resultado de produção**, separando o que é código, que o manager faz sozinho, do que é decisão ou ação do responsável.

## 2. Fora de escopo

- Especificar a D5 (coleta ampliada). Ela tem documento próprio e não está autorizada; aqui só entra a consequência dela
  para o produto (§5.4).
- Repetir requisitos do P1 (W4.6, R1.6, R2, W5, W6). Eles aparecem no portão consolidado (§10.1) só por referência.
- Implementar a observabilidade. Aqui entra só a chave de log, porque ela é um segredo do `stack.yml` e uma entrega de
  código pendente (§5.3.4).
- Deploy, alteração na VPS, criação de secrets reais, aplicação de migração no Supabase e contratação de serviço. Tudo
  isso é ação do responsável, fora do código (§10.1).
- Mudar o motor (`src/lib/link-audit/scoring/`), a régua D3B ou o mínimo de 40 % de cobertura.
- Os demais itens do checklist de produção (P-1 a P-4, ensaio de queda de energia, CSP, testes em staging): continuam no
  `onda6c-checklist-producao.md` e entram no portão só por referência (§10.1, item P-8).

## 3. Atores

| Ator | Papel nesta spec |
|---|---|
| **Responsável** | Decide as questões da §11, aplica migrações e cria secrets em produção, autoriza deploy, custo e consultas pagas; hoje é a única pessoa que opera |
| **Manager** | Escreve e mantém esta spec e o plano; implementa e revisa o código das ondas G1 e G2 (autonomia de 19/11/2026) |
| **Operador** | Usuário autenticado (sessão HMAC + `GMN_OPERATOR_EMAILS`); grava decisões e resultados |
| **Servidor web** | Único processo que lê e escreve as pastas da Fase 6 e publica na guarda |
| **Provedor da guarda** | Testemunha imutável fora da VPS: **Supabase**, tabela append-only (D-G0-1, §5.1.6, ADR-0003) |
| **Reconciliador externo** | Pessoa ou rotina **fora da VPS** que compara a guarda com os backups (§5.1.3, GE-E5) |
| **Administrador da VPS** | Opera o host. Continua fora da garantia "web comprometido não falsifica" (P1, D15.5) |
| **Pipeline de CI** | Única via de deploy e de entrega de manifestos (D7, D15.5) |

## 4. Histórias

- Como responsável, quero que um rollback coordenado de todos os volumes seja **detectado**, para que uma revogação não
  volte a valer em silêncio depois de uma restauração errada ou de uma adulteração no host.
- Como responsável, quero decidir com clareza o que fazer com auditorias congeladas quando só existe uma pessoa operando,
  sabendo o que cada opção protege e o que não protege.
- Como manager, quero uma lista única e verificável do que falta antes do primeiro resultado de produção, para não
  liberar nada por esquecimento.
- Como equipe, quero saber antes do uso que todo resultado real sai INCONCLUSIVO enquanto a D5 não existir, para não
  prometer nota a cliente.

## 5. Frentes

### 5.1 (a) Guarda externa imutável do `head`

#### 5.1.1 Requisitos (origem)

| ID | Requisito | Origem |
|---|---|---|
| GE-R1 | Testemunha **imutável** da cabeça do livro em **domínio de falha separado da VPS**. É a única defesa contra o rollback coordenado de todos os volumes e contra quem escreve em duas ou mais pastas, incluindo o livro | spec do livro §9 (camada 5), §13 L1/L2, §16.7, §16.9; checklist l.15 |
| GE-R2 | A cabeça publicada é **prefixo** do livro, e o livro **não avança** sobre uma guarda atrasada: a escrita seguinte publica antes | spec do livro §16.7 |
| GE-R3 | `head: null` só é aceitável com o livro em `ledgerSeq ≤ 1` | R6-10 (spec do livro §16.11; checklist l.20) |
| GE-R4 | O atraso da guarda tem **limite** | R6-10 |
| GE-R5 | A falha de `publishGuard` depois de `CONFIRMED`/`ABORTED` é **tratada** | R6-10 |
| GE-R6 | Distinguir "nunca publicou" de "esqueceu"; livro removido sem testemunha deixa de parecer "nunca adotado" | R6-10, R6-08 |
| GE-R7 | Alerta nos estados ruins do livro e na **idade** do último resumo externo | spec do livro §12 (monitoramento) |
| GE-R8 | Alguém responde pela **conferência periódica** da guarda | spec do livro §14 Q6 |
| GE-R9 | Guardar o `head` de cada auditoria junto do backup, depois de cada resultado | checklist §4 l.76 |
| GE-R10 | Testes de rollback e de restauração **executados**, não só escritos | checklist l.29 e §10 itens 4–5 |

#### 5.1.2 Estado atual (conferido no código em 20/11/2026)

- **Porta:** `ExternalGuardPort` tem dois métodos, `publish({auditId, ledgerSeq, sha256})` e `latest(auditId)`
  (`src/lib/link-audit-ledger/guard.ts:12-17`). O mesmo par publicado de novo é idempotente; um par diferente na mesma
  posição falha (`:13`).
- **Só existe o adaptador sintético** (`createSyntheticGuard`, `guard.ts:21-25`), uma pasta local tratada pelos testes
  como outro domínio de falha. O comentário do próprio arquivo diz que isso não é proteção de produção (`guard.ts:6-11`).
- **As rotas não ligam a guarda.** `ledgerForRoutes()` cria o livro sem a opção `guard`
  (`src/app/api/link-audit/decisions/ledger-wiring.ts:18-21`, com o comentário em `:7-8`). As duas montagens passam por
  ela: decisões em `decisions/shared.ts:110` e pontuação/finalização em `scoring/shared.ts:110`. A sessão começa com
  `guard: { status: 'NOT_CONFIGURED' }` (`src/lib/link-audit-ledger/service.ts:239`) e a vista mostra
  `externalGuard: 'NOT_CONFIGURED'` (`src/lib/link-audit-ledger/model.ts:454`).
- **O que já funciona quando há guarda** (só com o adaptador sintético, nos testes):
  - leitura na ordem guarda → livro (`service.ts:244-248`);
  - `latest` indisponível ⇒ `HISTORY_UNRESOLVED` com `GUARD_UNAVAILABLE` (`model.ts:489`);
  - cabeça da guarda ausente do livro ⇒ `GUARD_MISMATCH` (`model.ts:517-519`);
  - livro ausente com registro na guarda ⇒ `LEDGER_REMOVED_WITNESSED` (`model.ts:493-494`);
  - uma nova operação de decisão (`prepare`) e um novo `RUN_INTENT` publicam a cabeça **anterior** antes de começar e
    recusam com `LEDGER_GUARD_UNAVAILABLE` se não conseguirem (`service.ts:763`, `:893`);
  - o `ENROLL` é diferente: grava o `GENESIS` primeiro e publica **depois**. Se a publicação falhar, ele recusa com
    `LEDGER_GUARD_UNAVAILABLE`, mas o `GENESIS` já está no livro (`service.ts:969-972`).
  - O limite travado em teste está em `tests/link-audit-ledger-guard.test.ts:56`: sem guarda, o rollback coordenado
    **não** é detectado.
- **Lacunas do contrato R6-10 no código de hoje:**
  - **GE-R3/GE-R6:** com a guarda lida, `head: null` diante de um livro de qualquer tamanho vira só `BEHIND`, e a vista
    continua `PROTECTED` (`model.ts:577-582`). "Nunca publicou" e "esqueceu" saem iguais.
  - **GE-R4:** `BEHIND` não tem limite. Qualquer atraso continua `PROTECTED` (`model.ts:577`).
  - **GE-R5:** em nove pontos, o retorno booleano de `publishGuard` é **ignorado** depois de um registro já gravado no
    livro (tabela abaixo). Só conferem o retorno as publicações de `prepare` e `RUN_INTENT`, antes de uma operação nova
    (`:763`, `:893`), e a do `ENROLL`, depois do `GENESIS` (`:972`).

    | # | `service.ts` | Função | Registro já gravado | Fluxo |
    |---|---|---|---|---|
    | S1 | `:555` | `closeRun` (de `runConfirmed` e `runConclude`) | `RUN_CONFIRMED` | fecho de resultado; a resposta é final |
    | S2 | `:590` | `abortStaleRun` (de `runPrepare`) | `RUN_ABORTED` (fase A vencida) | segue para uma finalização nova |
    | S3 | `:671` | `prepare`, receita da fase C | `CONFIRMED` de decisão | segue para a operação pedida ou termina (`RECOVER`) |
    | S4 | `:690` | `prepare`, receita de aborto | `ABORTED` de decisão | idem |
    | S5 | `:710` | `prepare`, `RECOVER` | `RUN_ABORTED` (fase A vencida) | idem |
    | S6 | `:732` | `prepare`, `RECOVER` | `CHECKPOINT` da chave atual | termina (manutenção) |
    | S7 | `:806` | `reissue` | `RECEIPT_REISSUED` | a resposta é final |
    | S8 | `:829` | `confirmed` | `CONFIRMED` de decisão | a resposta é final |
    | S9 | `:923` | `runGate`, prazo do dono vencido | `RUN_ABORTED` próprio | a resposta é sempre `RUN_DEADLINE` |
  - O adaptador sintético não tem prazo de resposta. Um adaptador de rede vai precisar de um (§5.1.4, regra 5).

#### 5.1.3 Entregas

| ID | Entrega | Tipo |
|---|---|---|
| GE-E1 | Adaptador real atrás de `ExternalGuardPort`, para o provedor escolhido (Supabase, D-G0-1): prazo de resposta de 3 s (D-G0-3, §5.1.7), respostas validadas com zod, erro ⇒ indisponível (nunca "nenhuma cabeça"), e `publish` com o motivo da recusa (`CONFLICT`, `STALE`, indisponível) conforme a regra 7 da §5.1.4. A porta muda junto, com o adaptador sintético ajustado | código |
| GE-E2 | Ligação em `ledgerForRoutes()`. A credencial da guarda é lida só pelo módulo do livro, como as chaves (`ledger/config.ts:26-27`). Sem credencial, o estado continua `NOT_CONFIGURED`, que **não passa no portão** (§10.1, G-1) | código |
| GE-E3 | Contrato R6-10 no modelo e no serviço: regras 1 a 4 da §5.1.4 | código |
| GE-E4 | Com a Q1 = opção 1 (D-G0-1): migração versionada em `supabase/proposed/`, com conferência de privilégios no próprio SQL, como a `003` faz (`supabase/proposed/003_rls_hardening.sql:34-43`), e o rollback correspondente. O responsável a aplica em produção | código + ação do responsável |
| GE-E5 | Reconciliação externa: um CLI somente leitura (nome proposto `scripts/link-audit-guard-reconcile.ts`) que compara as cabeças da guarda com uma cópia de backup do livro e com o registro anterior da própria reconciliação. Usa uma **credencial só de leitura que não fica na VPS**. Saída `--json` estável, com divergência ⇒ código de saída ≠ 0. Rotina: D-G0-2 (semanal, depois de cada backup do livro e antes de qualquer restauração) | código + rotina do responsável (D-G0-2) |
| GE-E6 | Eventos de alarme: guarda indisponível, `MISMATCH`, atraso acima do limite e falha de publicação depois do fecho. Usam o envelope da spec de observabilidade (§9) | código |
| GE-E7 | Runbook da guarda: ativação, rotação da credencial, indisponibilidade, restauração com conferência da guarda e reconciliação | documentação |
| GE-E8 | Ensaio em homologação, depois da W5: o roteiro EN-01 a EN-12 da §10.4, com o EN-02 dividido em a, b, c, d e e (rollback coordenado, restaurações, rollback de imagem, queda do provedor, falha de publicação depois do fecho, sequência falsa, reconciliação) | onda G2 |

#### 5.1.4 Regras do contrato da guarda real (fecham GE-R3 a GE-R6)

1. **Ativação antes da primeira inscrição.** Em produção, a guarda tem de estar operante antes do primeiro `ENROLL`. Uma
   auditoria inscrita sem guarda não tem cabeças publicadas, e publicar "a cabeça de hoje" para ela seria uma adoção (o
   histórico anterior valeria o que vale no instante da publicação, como o L4 da spec do livro §13). Isso exige o papel
   administrativo (§5.2). Consequência: nenhuma auditoria inscrita sem guarda entra no uso de produção.
2. **Primeira cabeça.** `head: null` é aceito só com o livro em `ledgerSeq ≤ 1`, que é o caso do `GENESIS` gravado com a
   publicação interrompida (o `ENROLL` publica **depois** do `GENESIS`, `service.ts:969-972`). Com dois ou mais registros, `head: null` ⇒ `HISTORY_UNRESOLVED`, com uma
   razão nova (nome proposto `GUARD_HEAD_MISSING`).
3. **Atraso máximo.**
   - `L_max` é o maior número de registros que o protocolo grava entre duas publicações obrigatórias, contando as famílias
     de decisão e de resultado (`RUN_*`) e as receitas do `RECOVER`. **Contado na G0: `L_max` = 5** (D-G0-4; contagem e
     condição de validade na §5.1.7). A G1.b o trava em teste (PG-G02).
   - Atraso ≤ `L_max` ⇒ a vista mostra `BEHIND`, e o alarme dispara se o atraso durar mais que **`T` = 15 min** (D-G0-4).
   - Atraso > `L_max` ⇒ `HISTORY_UNRESOLVED` (nome proposto `GUARD_LAGGING`). Um fluxo legítimo não chega lá, porque
     toda operação nova de decisão ou de resultado publica antes de começar. A exceção é o `RECOVER` da rotação, que grava
     o `CHECKPOINT` sem publicação obrigatória antes (`service.ts:731-746`); por isso a G1.b recusa no código a rotação
     com `externalGuard` = `BEHIND` (§5.1.7).
   - **Janela residual declarada:** a guarda detecta o retrocesso a qualquer ponto **anterior à última cabeça
     publicada**. Um retrocesso dentro da última operação ainda não publicada passa (no máximo `L_max` registros).
4. **Falha de publicação depois de um registro gravado** (os nove pontos S1–S9 da §5.1.2). O registro já está durável no
   livro, então nunca se responde como se nada tivesse sido gravado: o cliente reenviaria uma decisão já confirmada.
   Por ponto:
   - **S1, S7, S8** (resposta final) e **S6** (manutenção que termina): a resposta é de **sucesso**, com
     `externalGuard: BEHIND` na vista e o evento de alarme;
   - **S3, S4, S5** quando a sessão termina num `RECOVER`: igual a S6;
   - **S2, S3, S4, S5** quando a sessão segue para uma operação nova: a publicação obrigatória seguinte (`:763` ou
     `:893`) recusa com `LEDGER_GUARD_UNAVAILABLE`, e o alarme é emitido no ponto da falha;
   - **S9:** a resposta continua `RUN_DEADLINE`, com `BEHIND` na vista e o alarme.

   Em todos os casos, a próxima operação continua recusando enquanto não conseguir publicar (`:763`, `:893`).
5. **Indisponibilidade.** Erro ou prazo esgotado no `latest` ⇒ `GUARD_UNAVAILABLE` ⇒ `HISTORY_UNRESOLVED`
   (`model.ts:489`). A falha é fechada **também nas leituras**: com o provedor fora do ar, nenhuma decisão aparece como
   vigente e nada é finalizável. **Decidido (D-G0-3):** essa é a política, sem modo degradado, com prazo de resposta de
   **3 s** por chamada à guarda (`latest` e `publish`), a confirmar na G1 pela latência medida (§5.1.7).
6. **"Esqueceu".** O servidor não guarda estado entre requisições, então não percebe sozinho uma guarda que regrediu. Ser
   append-only e monotônica torna essa regressão impossível sem comprometer o provedor. Quem detecta é a reconciliação
   externa (GE-E5), que compara com o próprio registro anterior.
7. **Publicação: idempotência e monotonia.** A porta já trata como idempotente a republicação do mesmo par
   (`guard.ts:13`; o adaptador sintético aceita o par que já existe em qualquer posição, `guard.ts:35-36`). O provedor
   real decide, de forma atômica por auditoria:
   - **o mesmo trio** `(auditId, ledgerSeq, sha256)` já gravado ⇒ **aceito**, sem registro novo (idempotente), em
     qualquer posição;
   - **mesmo `ledgerSeq` com outro `sha256`** ⇒ **recusado** (conflito);
   - **`ledgerSeq` novo e menor que o maior já gravado** ⇒ **recusado** (atrasado);
   - **`ledgerSeq` maior que o maior** ⇒ gravado.

   `latest` devolve o **maior** `ledgerSeq`. Com essas regras, quem tem a credencial de escrita não consegue esconder um
   retrocesso: só consegue **congelar** a auditoria, por exemplo publicando uma sequência falsa acima da real (DoS, a
   mesma classe do L6 da spec do livro §13).

   A porta passa a devolver o motivo da recusa (`CONFLICT`, `STALE` ou indisponível) em vez de só `{ ok: false }`. Isso
   evita um falso alarme numa corrida legítima: o processo A grava o registro 5 e, antes de publicá-lo, o processo B
   grava 6 e 7 e publica 7; a publicação atrasada de A é recusada como `STALE`. Nesse caso, o serviço relê o `latest`, e
   se a cabeça maior da guarda está no livro (é prefixo), a publicação está coberta e não há alarme. `CONFLICT` sempre
   gera alarme.
8. **Formato do registro:** `{auditId, ledgerSeq, sha256}` mais a hora do provedor, que é só informativa (a ordem vale
   pelo `ledgerSeq`). **Decidido (D-G0-5):** o `auditId` **não** vai em claro. O provedor guarda o pseudônimo
   `audit_ref` = HMAC-SHA-256 do `auditId` com a chave própria da guarda (`GMN_LINK_AUDIT_GUARD_KEY`), mais o id dessa
   chave. Onde esta spec escreve `auditId` ou `audit_id` do lado do provedor (regra 7, §5.1.5, §5.1.6), vale o
   `audit_ref`: a restrição única e a trava por auditoria usam o pseudônimo. A porta continua recebendo o `auditId`; o
   adaptador calcula o pseudônimo. Rotação da chave: §5.1.7.

#### 5.1.5 Casos de borda

- **Auditoria nova:** o `ENROLL` grava o `GENESIS` e só então publica. Se a publicação falhar, ele responde
  `LEDGER_GUARD_UNAVAILABLE` (`service.ts:969-972`), o livro fica com 1 registro e `head: null`, que a regra 2 aceita. A
  primeira operação seguinte (`prepare` ou `RUN_INTENT`) publica antes de começar.
- **Corrida entre processos:** regra 7. O mesmo trio é idempotente; um par diferente na mesma posição é conflito; a
  publicação atrasada de um processo, já coberta por uma cabeça maior, não gera alarme. O provedor garante isso de forma
  atômica (restrição única `(auditId, ledgerSeq)` e trava por auditoria).
- **Resultados:** os registros `RUN_*` estão no mesmo livro, então a guarda cobre também a confirmação de resultados
  (ADR-0002) sem trabalho a mais.
- **Restauração de backup mais velho que a guarda:** a guarda fica à frente do livro restaurado ⇒ `GUARD_MISMATCH` e a
  auditoria congela. É o comportamento correto. Só que, sem o papel administrativo (§5.2), não existe `RESTORE_ACK`, e
  toda auditoria com atividade depois do backup fica congelada pela aplicação. **Consequência prática:** a frequência do
  backup do livro e dos recibos define quanto se perde. Decidido (D-G0-9): cópia **diária**, destino independente por
  volume.
- **Rollback de imagem:** depois do primeiro `ENROLL`, nunca se volta a uma imagem anterior ao livro (R6-09) e o web
  atualiza com `stop-first` (§5.3.3).
- **Queda longa do provedor:** a Fase 6 inteira fica sem decisão vigente (falha fechada). É um acoplamento de
  disponibilidade aceito por desenho.
- **Rotação ou perda da credencial da guarda:** a publicação falha ⇒ as escritas recusam; a leitura também, se a
  credencial de leitura for a mesma. O runbook (GE-E7) trata a troca sem perder cabeças.
- **Conta do provedor comprometida:** fica fora do que a guarda resolve. A mitigação é a reconciliação externa guardar a
  própria cópia das cabeças (GE-E5) e a conta ter MFA, com dono diferente de quem administra a VPS.

#### 5.1.6 Opções de provedor

Regra do projeto: serviço pago novo só com autorização do responsável (`CLAUDE.md`, "Architecture rules").

**O que a VPS guarda hoje, relevante para a análise:** o serviço web **e** o Worker recebem a `service_role` do Supabase
como secret (`deploy/hostinger/stack.yml:27`, `:32`, `:134`, `:139`), além da chave anônima e da URL. Pelo arquivo de
implantação, **não** estão na VPS a senha do papel `postgres`, o segredo ou as chaves de assinatura de JWT do projeto, o
token da API de gestão nem o acesso ao painel. Isso é **a confirmar na VPS**: é um dos itens "NÃO VERIFICADO" do índice
de ameaças (`docs/security/threats/INDEX.md`, "Ações transversais").

**Ameaça comum às três opções:** quem controla o processo web consegue ignorar a guarda ou mentir para a própria
aplicação sobre o `latest` (L8 da spec do livro §13). A imutabilidade protege o **registro**, não quem confere. Contra
root na VPS, a guarda só gera **detecção depois do fato**, pela reconciliação externa (GE-E5) com credencial fora da
VPS. Contra restauração errada de backup e contra quem só escreve nos volumes, a detecção é imediata.

| | (1) Tabela append-only no **Supabase** | (2) Repositório **GitHub privado** separado | (3) Armazenamento com **Object Lock** |
|---|---|---|---|
| Custo e serviço | Nenhum serviço novo (o projeto já usa o Supabase); custo zero no plano atual (**a confirmar** o plano) | Conta existente; regra de proteção em repositório privado exige plano pago (ver abaixo) | **Pago e fornecedor novo: exige autorização** |
| Imutabilidade | Por gatilho e privilégios do Postgres; **quebrável pelo dono ou administrador do projeto** | Por regra de proteção (histórico sem push forçado); quebrável pelo dono do repositório | Modo *compliance*: nem a conta raiz encurta a retenção (**a confirmar** por fornecedor) |
| Domínio de falha | Fora da VPS, mas **dentro do projeto Supabase**, o mesmo dos dados de prospecção | Fora da VPS; mesma conta do código, do CI e do deploy | Fora da VPS; conta separada |
| Independência contra o dono da conta | **Não** | **Não** | **Sim** (retenção que nem o dono encurta) |
| Credencial na VPS | Papel Postgres dedicado: só executa a função de publicação e lê; sem `INSERT` direto, `UPDATE`, `DELETE` ou `TRUNCATE` | Token fine-grained: só `contents:write` nesse repositório | Chave só com `PutObject` (sem apagar, sem contornar a retenção) |
| Dependência nova | Cliente Postgres (`pg`) para conexão direta; revisão de cadeia de suprimento | Nenhuma (API REST) | SDK S3 ou assinatura manual |
| Disponibilidade | Toda leitura da Fase 6 depende do Supabase | Toda leitura depende da API do GitHub | Toda leitura depende do fornecedor |

**Opção (1): Supabase, desenho mínimo.** Tudo por migração versionada (GE-E4); nada no console.

- Tabela num **esquema dedicado, não exposto pela Data API (REST)** do Supabase. O estado atual de
  *Exposed schemas* do projeto **não está verificado** no repositório (`docs/phase5/g5-s0-relatorio-2026-11-07.md:82`),
  por isso o PG-G08 exige a prova de que a tabela não responde pela API.
- **Dono definido:** um papel dedicado **sem login** (nome proposto `gmn_guard_owner`; `NOLOGIN`, `NOSUPERUSER`,
  `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`, sem associação a papéis privilegiados) é dono do esquema,
  da tabela e da função. A migração roda como `postgres` e transfere a posse. Assim, a função `SECURITY DEFINER` roda
  com os privilégios desse dono, e não com os do `postgres`.
- Escrita só por uma **função de publicação** `SECURITY DEFINER` com **`SET search_path = ''`**: todo objeto dentro dela
  é qualificado pelo esquema (`<esquema_da_guarda>.<tabela>`, `pg_catalog.pg_advisory_xact_lock`), então nenhum esquema
  gravável por outro papel entra na resolução de nomes. Ela toma uma trava consultiva por auditoria, aplica a regra 7
  da §5.1.4 e devolve "gravado" ou "já gravado", ou recusa com `CONFLICT` ou `STALE`.
- Papel de login dedicado (nome proposto `gmn_guard_writer`) com `USAGE` no esquema, `EXECUTE` só nessa função e
  `SELECT` na tabela. Sem `INSERT` direto, `UPDATE`, `DELETE`, `TRUNCATE` nem `CREATE` no esquema; sem associação a
  papéis privilegiados (`postgres`, `service_role`, `authenticated`, `anon`, `authenticator`, `supabase_admin` e afins);
  atributos `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`.
- Papel separado só de leitura para a reconciliação (`gmn_guard_reader`), cuja credencial **não** fica na VPS.
- `REVOKE ALL` de `PUBLIC`, `anon`, `authenticated` e `service_role` na tabela e no esquema. É necessário porque os
  privilégios padrão de `postgres` em `public` ainda concedem tudo à `service_role` e os de `supabase_admin` não foram
  alterados (`NOTES.md:140`). Num esquema novo, os padrões que se aplicam são **a confirmar** no laboratório.
- Defesa em profundidade, para o caso de algum privilégio escapar:
  - restrição única `(audit_id, ledger_seq)`;
  - gatilho `BEFORE UPDATE OR DELETE` que recusa sempre;
  - gatilho `BEFORE TRUNCATE`, de instrução, que recusa sempre;
  - gatilho `BEFORE INSERT` com a mesma regra 7, para que nem um `INSERT` direto contorne a monotonia.
- **Privilégios, explícitos na migração:**
  - `REVOKE ALL ON FUNCTION <publicação> FROM PUBLIC, anon, authenticated, service_role`, porque o Postgres concede
    `EXECUTE` a `PUBLIC` por padrão (`trigger_set_updated_at` está assim, `NOTES.md:140`);
  - `REVOKE ALL ON TABLE <guarda> FROM PUBLIC, anon, authenticated, service_role` e o mesmo no esquema;
  - `GRANT EXECUTE ON FUNCTION <publicação> TO gmn_guard_writer`, e a ninguém mais;
  - `GRANT USAGE ON SCHEMA` e `GRANT SELECT ON TABLE` só ao `gmn_guard_writer` e ao `gmn_guard_reader`;
  - as funções dos gatilhos também saem sem `EXECUTE` para `PUBLIC`.
- Conexão direta ou pelo *pooler*. Se a VPS tem IPv6 e se a conexão direta do plano exige IPv4 pago fica **a confirmar**.

*O que um atacante com a VPS consegue fazer, sendo honesto:*

- **Com a `service_role`:** nada na tabela, **desde que** o esquema não esteja exposto e os privilégios tenham sido
  revogados. Os gatilhos **não substituem** isso. Eles barram `UPDATE`, `DELETE`, `TRUNCATE` e sequência fora da regra 7,
  mas aceitam uma sequência monotônica válida. Então, sem o `REVOKE`, a `service_role` ou qualquer credencial com
  `INSERT` publicaria uma cabeça falsa crescente e congelaria a auditoria (DoS). A aprovação da opção depende do
  `REVOKE` conferido no SQL e da prova pela Data API (PG-G08). Os outros dados do projeto continuam expostos à
  `service_role` como hoje: está fora do escopo desta spec.
- **Com a credencial do `gmn_guard_writer`:**
  - publica uma **sequência falsa** acima da real para uma auditoria: a cabeça da guarda deixa de estar no livro
    (`GUARD_MISMATCH`) e as publicações legítimas passam a ser `STALE`. É **DoS**: a auditoria congela e, sem o papel
    administrativo, não reabre pela aplicação (§5.2);
  - lê as cabeças: pseudônimo e frequência de atividade (D-G0-5). Com a `GMN_LINK_AUDIT_GUARD_KEY`, que também está na
    VPS, reverte o pseudônimo por dicionário de `auditId`;
  - **não** consegue alterar nem apagar registros, desligar gatilhos ou mudar privilégios: isso exige ser dono da tabela.
- **Com controle do processo web:** a ameaça comum acima. O web comprometido pode **mentir sobre o `latest`** para a
  própria aplicação e esconder um retrocesso das telas; só a reconciliação externa detecta, e só **depois**.
- **O que não consegue:** restaurar o banco do Supabase a um ponto anterior. Isso exige o dono do projeto, pelo painel.

*Ameaças que sobram:*

- **a guarda fica fora da VPS, mas dentro do projeto Supabase.** O dono ou um administrador do projeto pode alterar ou
  remover gatilhos, privilégios e linhas, e restaurar o banco. É um risco declarado: se a exigência for independência
  também contra o dono do projeto, só a opção (3) atende;
- conta do Supabase comprometida (o mesmo efeito do item anterior);
- raio de impacto: o projeto é o mesmo dos dados de prospecção, cujo RLS (G5) ainda está "pendente de homologação
  funcional" (`NOTES.md:140`);
- pausa do projeto por inatividade, conforme o plano (**a confirmar**), que vira indisponibilidade com falha fechada.

**Opção (2): GitHub privado.**

- Repositório separado, só para a guarda.
- Regra de proteção na branch: sem push forçado e sem exclusão. O registro é o **histórico**; a leitura reconstrói as
  cabeças pelos commits, nunca pela árvore.
- Token fine-grained só com `contents:write` nesse repositório. Sem `administration`, o token não mexe nas regras.

*Problemas:*

- No plano gratuito de conta pessoal, a proteção de branch em repositório privado **não estava disponível**: "GitHub
  exige Pro ou repositório público" (`NOTES.md:137`). Então a opção depende de plano pago (autorização) ou de repositório
  **público** com `auditId` pseudonimizado, que ainda expõe datas e frequência de atividade.
- Concentração: a conta dona do repositório é a mesma do código, do CI e do canal de manifestos (D7). Comprometê-la
  derruba a guarda junto com o resto.
- Um commit por escrita da Fase 6, com latência da API e limites de criação de conteúdo (**a confirmar**).

*O que um atacante com a VPS consegue fazer:* com o token, criar commits (congela, como na regra 7), mas não reescrever o
histórico, se a regra de proteção estiver valendo. Mais a ameaça comum.

**Opção (3): Object Lock.**

- Bucket com versionamento e retenção em modo *compliance*.
- Um objeto por `(auditId, ledgerSeq)`.
- Credencial da VPS só com `PutObject`.
- A credencial de leitura da reconciliação fica fora da VPS.

*Prós:* a imutabilidade mais forte das três; domínio separado de verdade.

*Contras:*

- fornecedor e custo novos (pequenos, mas exigem autorização);
- mais uma custódia de credenciais;
- o encerramento da conta por falta de pagamento interromperia o serviço (**a confirmar** por fornecedor).

*O que um atacante com a VPS consegue fazer:* gravar objetos novos (congela, como na regra 7). Não apaga nem sobrescreve.
Mais a ameaça comum.

> **Recomendação do manager, a decidir pelo responsável (Q1):** opção **(1) Supabase** na primeira implantação, **para o
> risco definido nesta spec: a VPS comprometida** (e a restauração errada de backup). Vale nas condições acima: esquema
> não exposto e provado pelo PG-G08, `REVOKE` conferido no SQL, escrita só pela função de publicação, gatilhos e leitura da
> reconciliação fora da VPS. Motivo: não há serviço novo nem custo, e o domínio de falha é separado da VPS. Ela **não**
> protege contra o dono ou administrador do projeto Supabase. Se o responsável exigir essa independência também, a
> resposta é a opção **(3)**, com custo autorizado. A opção **(3)** também é o reforço natural quando houver uso com
> clientes ou mais de um operador. A opção **(2)** não é recomendada: depende de plano pago ou de repositório público e
> concentra poder na conta que já controla código, CI e deploy.
>
> **Decidido pelo responsável em 20/11/2026 (D-G0-1, §11): opção (1) Supabase**, com este desenho e para o risco "VPS
> comprometida". O limite contra o dono ou administrador do projeto Supabase fica declarado. A opção (3) só entra com
> custo autorizado e é a revisão futura registrada no ADR-0003. O critério do provedor é o **PG-G08**; o PG-G10 e o
> PG-G11 não se aplicam.

#### 5.1.7 Números do contrato da guarda (G0, 20/11/2026)

Conferidos no código em `3899a67`. São os números que a G1.b implementa e trava em teste; a regra de cada um é a decisão
da §11, e o valor só muda com registro aqui (número novo e motivo).

| Número | Valor | Decisão | Quem confirma |
|---|---|---|---|
| `L_max` (atraso máximo aceito como `BEHIND`) | **5 registros** | D-G0-4 (regra); contagem abaixo | G1.b, por teste que enumera os fluxos do protocolo (PG-G02) |
| `T` (alarme de `BEHIND` prolongado) | **15 min** | D-G0-4 | G1.b (evento GE-E6) |
| Prazo de resposta da guarda | **3 s** por chamada (`latest` e `publish`); esgotado ⇒ indisponível | D-G0-3 | G1.b, pela latência medida no laboratório (PG-G08) |
| Chave do pseudônimo `audit_ref` | `GMN_LINK_AUDIT_GUARD_KEY`, formato `<id>:<64 hex>` | D-G0-5 | G1.b (secret e uso) |
| Credencial de escrita da guarda | `GMN_LINK_AUDIT_GUARD_DB_URL` (papel `gmn_guard_writer`) | D-G0-1 | G1.b (secret e uso) |

**Contagem de `L_max`.** Publicações **obrigatórias** (falha ⇒ recusa, nada novo começa): a do `prepare`, antes da
`INTENT` (`src/lib/link-audit-ledger/service.ts:774`); a do `runIntent`, antes do `RUN_INTENT` (`:904`); e a do `ENROLL`,
depois do `GENESIS` (`:1022`). As outras nove são de melhor esforço (S1–S9, §5.1.2). `L_max` é o maior número de
registros que entram no livro depois da última publicação aceita pela guarda, num fluxo legítimo em que **todas** as
publicações de melhor esforço falham:

| Parcela | Registros | Por que no máximo isso (código em `3899a67`) |
|---|---|---|
| Uma operação de decisão iniciada logo depois da publicação obrigatória | 2: `INTENT` + o fecho dela (`CONFIRMED`; `ABORTED` da receita; ou `CONFIRMED` da fase C) | Outra operação nova exige outra publicação obrigatória: aceita, recomeça a conta; recusada, nada novo entra (`service.ts:774`, `:904`) |
| O fecho do resultado que já estava aberto antes da publicação | 1: `RUN_CONFIRMED` ou `RUN_ABORTED` | Cai entre a `INTENT` e o fecho da decisão pela regra dos fechos intercalados (`service.ts:453-461`). Um `RUN_INTENT` novo não entra com decisão aberta (`:892`) nem sem publicação obrigatória (`:904`) |
| Uma reemissão de recibo de decisão | 1: `RECEIPT_REISSUED` | Só do último confirmado e sem decisão aberta (`model.ts:556`); no máximo uma por entrada confirmada (`service.ts:805`). A reemissão do recibo de **resultado** não grava no livro (`service.ts:968-1002`) |
| Um ponto de verificação | 1: `CHECKPOINT` | O automático (a cada 64 registros, `types.ts:26`; `model.ts:276-278`) é gravado **antes** da publicação obrigatória (`service.ts:767-774`) e fica no livro se ela falhar. O da rotação vem do `RECOVER` (`service.ts:731-746`), também com operação aberta. Depois de um, o próximo só é devido 64 registros adiante ou noutra rotação |
| **Total** | **5** | Quando a janela começa no `runIntent`, o total é 4 (`RUN_INTENT` + fecho + reemissão + `CHECKPOINT`); quando começa no `ENROLL`, a janela começa vazia |

**Nota da G1.b.1 (21/11/2026), sem mudar o número:** a publicação obrigatória do `prepare` passou para **antes** do `CHECKPOINT` automático, e o `RECOVER` da rotação publica a cabeça atual antes do `CHECKPOINT` dele (recusa se não conseguir). O `CHECKPOINT` continua sendo uma das cinco parcelas, logo depois de uma publicação aceita. Com a ordem de `3899a67`, uma segunda rotação dentro da janela somava 1 pelo caminho do `prepare` (`CHECKPOINT` gravado e a publicação recusada), que a recusa do `RECOVER` sozinha não cobria. O teste que enumera os fluxos (PG-G02) trava as duas coisas.

**Condição de validade:** cada **rotação da chave do livro** concluída dentro da mesma janela soma 1 (um novo
`CHECKPOINT` de rotação, `model.ts:262-266`). Por isso o runbook da guarda (GE-E7) exige `externalGuard` = `CONSISTENT`
na auditoria antes do `RECOVER` da rotação; com essa regra, o total não passa de 5. Sem ela, um atraso de 6 vira
`GUARD_LAGGING` e congela a auditoria sem reabertura pela aplicação (D-G0-6). Como o serviço em `3899a67` aceita o
`RECOVER` sem conferir a guarda (`service.ts:731-744`), a regra do runbook sozinha não basta: **a G1.b é obrigada a
impô-la no código**, recusando o `RECOVER` de rotação (e o `CHECKPOINT` dele) quando `externalGuard` ≠ `CONSISTENT`, com
teste da recusa e mutação que a remove (revisão do PR #53).

**Idade do atraso (`T`).** O servidor não guarda estado entre requisições (regra 6). Proposta para a G1.b: a idade do
`BEHIND` é a distância entre o relógio do servidor e o `recordedAt` do primeiro registro do livro ainda não publicado.

**Rotação da `GMN_LINK_AUDIT_GUARD_KEY` (D-G0-5).** O pseudônimo é a chave de busca na guarda: trocar a chave troca o
pseudônimo, e uma auditoria com dois ou mais registros sem cabeça sob o pseudônimo novo cairia em `GUARD_HEAD_MISSING`
(regra 2). Por isso:

- **sem rotação periódica.** A chave protege só a confidencialidade do `auditId` (quem lê a tabela não liga cabeça a
  auditoria). A integridade é da imutabilidade e da regra 7;
- **rotação por comprometimento** (ou por decisão do responsável), no padrão das outras chaves da Fase 6: chave nova
  como atual e a antiga em `GMN_LINK_AUDIT_GUARD_RETIRED_KEYS`. O `latest` consulta o pseudônimo de cada chave (atual e
  aposentadas) e fica com o maior `ledgerSeq`; a publicação usa só a atual; a primeira publicação com a chave nova é a
  cabeça do livro naquele instante. A aposentada só sai da lista quando toda auditoria protegida tiver cabeça publicada
  com a atual, conferido pela reconciliação;
- cada registro guarda o **id** da chave que gerou o pseudônimo;
- a chave fica no web e com o responsável, que a usa na reconciliação fora da VPS (GE-E5);
- o procedimento detalhado vai no runbook GE-E7, e a G1.b trava em teste que a rotação não produz
  `GUARD_HEAD_MISSING` nem esconde retrocesso.

**Correspondência de linhas `a506ffd` → `3899a67`** (a R1.6 deslocou as citações das §5.1.2, §5.1.4, §5.1.5 e §10.4):

| Arquivo | Em `a506ffd` (texto da spec) | Em `3899a67` |
|---|---|---|
| `src/lib/link-audit-ledger/service.ts` | `:239`, `:244-248`, `:342-347`, `:404-408` | `:250`, `:255-259`, `:353-358`, `:415-419` |
| idem, S1–S9 | `:555`, `:590`, `:671`, `:690`, `:710`, `:732`, `:806`, `:829`, `:923` | `:566`, `:601`, `:682`, `:701`, `:721`, `:743`, `:817`, `:840`, `:934` |
| idem, publicações obrigatórias e `ENROLL` | `:763`, `:893`, `:969-972` | `:774`, `:904`, `:1019-1022` |
| `src/lib/link-audit-ledger/model.ts` | `:454`, `:489`, `:493-494`, `:517-519`, `:577-582` | `:460`, `:495`, `:499-500`, `:523-525`, `:583-588` |

### 5.2 (b) Papel administrativo com dupla aprovação

#### 5.2.1 Requisitos (origem)

O procedimento está na spec do livro §16.8. A interpretação mais restritiva da Q5 foi **confirmada pelo responsável em
03/11/2026** (checklist l.16). Para `ADOPT` de histórico não vazio, `RESTORE_ACK` e `QUARANTINE_ACK`, ele exige:

- papel administrativo verificável;
- aprovação por **dois administradores distintos, nenhum deles o solicitante**;
- (1) congelar a auditoria;
- (2) fonte independente (backup do mesmo instante ou guarda);
- (3) verificação integral automatizada;
- (4) registro `*_ACK` com justificativa, referência da fonte, cabeças antes e depois e identidade dos aprovadores;
- (5) preservação da evidência afastada (movida para uma área de custódia, nunca apagada, e citada pelo hash).

Também é bloqueador de produção pelo R6-13: um incidente de chave congela **todas** as auditorias protegidas.

#### 5.2.2 Estado atual (conferido)

- A rota aceita as cinco ações (`src/lib/link-audit-decisions/types.ts:119`) e documenta o 403
  (`src/app/api/link-audit/decisions/[auditId]/ledger/route.ts:11`).
- O serviço recusa `ADOPT`, `RESTORE_ACK` e `QUARANTINE_ACK` antes de tocar no livro
  (`src/lib/link-audit-decisions/service.ts:1029-1031`), com `ADMIN_APPROVAL_UNAVAILABLE` ⇒ 403 (`:119`) e mensagem fixa
  (`:162`). A inscrição de auditoria legada também cai nesse código (`src/lib/link-audit-ledger/service.ts:966`,
  estado `LEGACY_READ_ONLY`).
- **Não há papel administrativo.** A autorização é "operador autenticado": sessão HMAC própria, só com o e-mail, e a lista
  `GMN_OPERATOR_EMAILS` (`src/lib/auth/guard.ts:24-27`). Não existe id de usuário nem papel (spec de observabilidade
  §1, tabela de fatos).
- Teste que trava a recusa: `tests/link-audit-ledger-q5.test.ts`.

#### 5.2.3 O problema de uma pessoa só

Hoje só o responsável opera (P1, D15.1). Pela letra da §16.8, a regra precisa de **três identidades**: quem pede e dois
aprovadores distintos dela. Com uma pessoa, é impossível; com duas, também. A exceção de uma pessoa do P1 (D15.1, aceite
formal com `requiresLaterReview`) trata a separação entre conferente e custodiante e **não cobre** esta regra. Mudá-la é
mudança formal de política, decisão do responsável.

#### 5.2.4 Opções

| Opção | Como funciona | O que protege | O que **não** protege |
|---|---|---|---|
| **(1) Nomear outras pessoas** | Pela letra da §16.8: mais duas pessoas além de quem pede. Ou, com uma emenda formal da regra para "quatro olhos" (quem pede ≠ quem aprova), uma segunda pessoa | Erro e abuso de uma pessoa só; sessão roubada de um operador; dá revisão humana independente da fonte de restauração | Conluio; VPS comprometida (quem administra o host edita a configuração de papéis); exige identidade verificável por pessoa, além do e-mail na lista |
| **(2) Mudança formal para operação de uma pessoa** | (i) o operador pede na aplicação, e o pedido fica registrado, sem efeito; (ii) **espera obrigatória** (proposta: 72 h) com aviso num canal fora da VPS; (iii) **confirmação assinada offline**, verificada pelo servidor contra uma chave pública fixada. O briefing propõe a K1 da custódia do P1. O manager recomenda uma **chave administrativa própria sob a mesma custódia** | Sessão ou processo web comprometido **sem** a chave offline não conclui a ação; ação impulsiva ou por engano (a espera); um pedido forjado fica visível durante a espera, **se** o aviso chegar a um canal que o atacante não controla (hoje não existe: o destino dos logs e dos alertas está em aberto) | Erro, engano ou coação **do próprio responsável** (não há segundo olhar); comprometimento da chave offline; quem administra a VPS e troca a chave pública fixada (o mesmo limite da D15.5); continua exigindo fonte independente (guarda ou backup). Usar a **K1** amplia a exposição da chave de atestação (mais cerimônias) e mistura finalidades: exige separação de domínio na mensagem assinada, por isso a recomendação de chave própria |
| **(3) Manter as ações em 403** | Nada muda no código; aceite formal e escrito do risco | Ninguém concede confiança a um histórico sem a regra completa: falha fechada, sem nova superfície de ataque | Disponibilidade: auditoria congelada (`HISTORY_UNRESOLVED`, `UNTRUSTED`, `EXHAUSTED`, `LEGACY_READ_ONLY`) fica **perdida para a aplicação**. A recuperação é humana, fora do sistema, preservando a evidência, e na prática se abre auditoria nova. Um incidente de chave congela todas as auditorias protegidas (R6-13) |

> **Recomendação do manager, a decidir pelo responsável (Q6):** **(3)** durante o piloto (§10.2), com aceite formal
> escrito. **(1)** assim que houver uma segunda pessoa, com a emenda formal para "quatro olhos" decidida junto. **(2)** só
> se for preciso recuperar uma auditoria antes de existir outra pessoa, e então com mudança de política assinada, chave
> administrativa própria (não a K1) e o canal de aviso fora da VPS já funcionando.
>
> **Decidido pelo responsável em 20/11/2026 (D-G0-6, §11): opção (3) no piloto**, com o aceite formal escrito da §10.2
> (condição 4). As opções (1) e (2) ficam nas condições acima, para o futuro. A Q7 não se aplica (D-G0-7).

#### 5.2.5 Entregas (só se Q6 = 1 ou 2; com a D-G0-6, nenhuma de código)

A opção escolhida ganha antes uma **emenda à spec do livro (§16.8)**, porque muda o formato do livro (registros `*_ACK` e
de pedido) e o contrato da API. As entregas, todas de código e testadas sem rede:

- fonte de identidade e atribuição do papel, separada de `GMN_OPERATOR_EMAILS`;
- pedido e aprovações com as identidades conferidas: o solicitante nunca aprova, e uma identidade só é recusada (critério
  A-L2 do modelo de ameaças do livro);
- verificação integral antes de gravar;
- registro com justificativa, fonte, cabeças e aprovadores;
- área de custódia para os arquivos afastados;
- interface.

Com Q6 = 3, que é a decisão vigente (D-G0-6), a única entrega é documental: o aceite formal e o texto da tela, que já
diz que a ação não existe (`src/lib/link-audit-decisions/service.ts:162`).

### 5.3 (c) Volumes e chaves no `stack.yml`

#### 5.3.1 O que o código lê (conferido por busca em `src/` e `scripts/`)

| Variável | Natureza | Lida em | Montagem / entrega |
|---|---|---|---|
| `GMN_LINK_AUDIT_EVIDENCE_DIR` | pasta | `scoring/shared.ts:83`, `decisions/shared.ts:93`, `evidence/shared.ts:43` | só leitura (já existe) |
| `GMN_LINK_AUDIT_DECISIONS_DIR` | pasta | `scoring/shared.ts:85`, `decisions/shared.ts:89` | leitura e escrita |
| `GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR` | pasta (recibos) | `scoring/shared.ts:87`, `decisions/shared.ts:91` | leitura e escrita, **outro volume e outro backup** |
| `GMN_LINK_AUDIT_RESULTS_DIR` | pasta | `scoring/shared.ts:106`, `decisions/shared.ts:107` | leitura e escrita |
| `GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR` | pasta (recibos) | `scoring/shared.ts:107`, `decisions/shared.ts:108` | leitura e escrita, **outro volume e outro backup** |
| `GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR` | pasta (livro) | `ledger-wiring.ts:15`, `ledger/config.ts:9` | leitura e escrita, **outro volume e outro backup** |
| `GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR` | pasta (manifestos) | `ledger-wiring.ts:16`, `scoring/shared.ts:100` | **só leitura**; escrita só pelo canal do CI (D15.5) |
| `GMN_LINK_AUDIT_ORIGIN_KEY` | segredo | `link-audit-origin/index.ts:40` | Swarm secret |
| `GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS` | segredo (só na rotação) | `link-audit-origin/index.ts:41` | Swarm secret |
| `GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS` | ids públicos | `link-audit-origin/index.ts:42` | variável comum |
| `GMN_LINK_AUDIT_LEDGER_KEY` | segredo | `ledger/config.ts:10` | Swarm secret |
| `GMN_LINK_AUDIT_LEDGER_RETIRED_KEYS` | segredo (só na rotação) | `ledger/config.ts:11` | Swarm secret |
| `GMN_LINK_AUDIT_LEDGER_REVOKED_KEY_IDS` | ids públicos | `ledger/config.ts:12` | variável comum |
| `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` | lista **pública** de chaves com estado | `scoring/shared.ts:101` | variável comum (formato no runbook de chaves §4) |
| `GMN_OPERATOR_EMAILS` | lista | `auth/guard.ts:25` | já existe (`stack.yml:24`) |
| `GMN_LINK_AUDIT_LOG_KEY` | segredo | **não é lida pelo código** (busca vazia) | Swarm secret, depois da entrega de código (§5.3.4) |
| `GMN_LINK_AUDIT_GUARD_DB_URL` | segredo: credencial de conexão do papel `gmn_guard_writer` (D-G0-1) | não existe (GE-E2) | Swarm secret, só no web |
| `GMN_LINK_AUDIT_GUARD_KEY` | segredo: chave do pseudônimo `audit_ref` (D-G0-5), formato `<id>:<64 hex>` | não existe (GE-E1) | Swarm secret, só no web |
| `GMN_LINK_AUDIT_GUARD_RETIRED_KEYS` | segredo (só na rotação da chave do pseudônimo, §5.1.7) | não existe | Swarm secret |

Ficam fora do serviço web as variáveis do coletor (`GMN_LINK_AUDIT_LIVE`, `GMN_LINK_AUDIT_AUTH_ID`,
`GMN_LINK_AUDIT_MAX_MAPS_CALLS`, lidas em `src/lib/link-audit-runtime/config.ts:16-36` e em `scripts/link-audit-collect.ts`).
São do CLI de coleta; onde ele roda em produção é **a confirmar**.

#### 5.3.2 Estado do deploy (conferido)

- `stack.yml` declara, das sete pastas, só `GMN_LINK_AUDIT_EVIDENCE_DIR` (`:26`), com bind só leitura (`:43-46`).
- Os secrets do web são quatro (`:27-35`). O entrypoint converte `*_FILE` em variáveis a partir de uma **lista fixa** com
  esses mesmos quatro nomes (`deploy/hostinger/docker-entrypoint.sh:13-23`). Nenhuma chave da Fase 6 está na lista.
- O `Dockerfile` cria só `/app/.data/audits`, `/app/.data/link-audits` e `/data/evidence` (`deploy/hostinger/Dockerfile:36`).
  Se os alvos novos de montagem precisam existir na imagem, com a raiz só leitura, fica **a confirmar** na G1. O Docker
  normalmente cria o ponto de montagem.
- O web atualiza com `order: start-first` (`stack.yml:87-88`). O R6-09 e o checklist §7 pedem `stop-first` depois do
  primeiro `ENROLL`.
- Os logs usam `json-file` com 10 MB × 3 arquivos por serviço (`stack.yml:59-63`): ficam na VPS e não implementam a
  retenção de 90 dias decidida (spec de observabilidade, Q3, `:436`).
- O web tem restrição de *placement* a um nó (`stack.yml:73-75`), o que o checklist §7 exige para binds.
- O Worker recebe a `service_role` (`:134`, `:139`), mas não precisa de nada da Fase 6 e não deve montar nenhuma pasta
  nova (checklist §7, l.100).
- O plano de backup lista evidências, PDFs, snapshots, Redis, secrets, configuração e Supabase. **Não** cobre decisões,
  recibos, resultados, livro nem manifestos (`deploy/hostinger/PLANO-DE-BACKUP-E-RESTAURACAO.md:3-12`).
- `deploy/hostinger/PROVA-DE-ORIGEM-E-DE-COLETA.md` (§3) já descreve a parte da chave de origem e dos manifestos; não
  cobre o livro, a chave de log nem a guarda.

#### 5.3.3 Entregas (código de implantação; o deploy é do responsável, pelo CI)

| ID | Entrega |
|---|---|
| VC-E1 | Serviço web com as seis pastas que faltam, por bind com origem em marcador (`<RAIZ_DADOS_DECISOES>`, `<RAIZ_DADOS_RECIBOS_DECISOES>`, `<RAIZ_DADOS_RESULTADOS>`, `<RAIZ_DADOS_RECIBOS_RESULTADOS>`, `<RAIZ_DADOS_LIVRO>`, `<RAIZ_DADOS_MANIFESTOS>`). Manifestos `read_only: true`. Os alvos no contêiner seguem o checklist §1. Nenhuma pasta dentro de outra (o código recusa) |
| VC-E2 | Secrets externos novos, só no web, com `<NOME>_FILE: /run/secrets/<NOME_DO_SECRET>`: chave de origem, chave do livro, chave de log, credencial da guarda e, só durante uma rotação, as duas listas de aposentadas. Os nomes entram na **lista fixa do entrypoint**. A lista continua fixa (nada de varrer o ambiente) e o entrypoint não passa a exigir as chaves: a aplicação já falha fechada sem elas (503) |
| VC-E3 | Variáveis comuns, só no web, vindas do arquivo de variáveis da implantação (fora do repositório): as duas listas de ids revogados e a lista pública `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` |
| VC-E4 | O web passa a `update_config.order: stop-first` (R6-09). O Worker não recebe nenhuma variável `GMN_LINK_AUDIT_*` e não monta pasta nova |
| VC-E5 | `tests/deploy-config.test.ts` estendido (teste estático): as sete pastas no web; evidências e manifestos só leitura; nenhuma variável `GMN_LINK_AUDIT_*` nem bind novo no Worker; os nomes novos na lista do entrypoint; `stop-first` no web; nenhum valor literal (a regra atual, `:134-143`) |
| VC-E6 | Backups: o plano de backup cobre as cinco pastas graváveis e a de manifestos, com **destinos independentes** para os recibos e para o livro (fora do disco dos dados que eles ancoram; checklist §1 l.55, spec do livro §12), pares do mesmo instante, `sha256sum` por arquivo, nunca `--delete`, e as cabeças guardadas junto (GE-R9). Destinos em marcador; os reais ficam fora do repositório |
| VC-E7 | Documentos de implantação atualizados (`PROVA-DE-ORIGEM-E-DE-COLETA.md`, checklist de produção) com os nomes novos e a ordem de ativação: volumes e chaves ⇒ guarda ⇒ só então o primeiro `ENROLL` |
| VC-E8 | Pastas criadas no host com dono `10001:10001` e modo `0700`, conferidos por `stat` (checklist l.54). É ação do responsável na implantação |

#### 5.3.4 A chave de log `GMN_LINK_AUDIT_LOG_KEY`

- **Decidida em 16/11/2026** (spec de observabilidade, Q1, `:431`): `operatorRef` = HMAC do e-mail normalizado com chave
  exclusiva no formato `<id>:<64 hex>`, diferente das chaves de origem e do livro. Sem a chave, `operatorRef:
  "UNAVAILABLE"`, sem nunca cair para o e-mail (§7.2 daquela spec).
- **Não é lida pelo código.** A busca por `LOG_KEY` em `src/`, `scripts/` e `deploy/` não acha nada. O logger comum
  (`src/lib/logger.ts:33-57`) só redige segredos, não redige e-mail e não pseudonimiza. Pela spec de observabilidade, o
  HMAC fica no módulo novo da Fase 6 (`link-audit-observability`, fatia 1 do §12 daquela spec), sem mudar
  `src/lib/logger.ts`.
- **Entrega de código (G1):** a fatia 1 da spec de observabilidade, no mínimo `operatorRef` com a chave e a recusa de
  chave igual às outras, mais o secret no `stack.yml` (VC-E2). As fatias 2 a 7 continuam com a spec de observabilidade e
  entram no portão como itens próprios (§10.1).
- **Destino dos logs fora da VPS, decidido (D-G0-8):** sem ferramenta paga; exportação **diária e cifrada** do log do
  contêiner para o **mesmo destino independente dos backups** (D-G0-9), com expurgo aos 90 dias. Isso fecha o "onde" da
  Q3 da spec de observabilidade. A exportação é entrega da G1.a. Até ela existir, os logs ficam no `json-file` rotativo
  da VPS, sem retenção de 90 dias e sem cópia externa.

### 5.4 (d) D5: coleta ampliada (consequência; não especificada aqui)

- **Números conferidos no código:**
  - A régua soma **200 meios-pontos** (as 35 linhas de `src/lib/link-audit-scoring-runs/criteria-sources.ts:55-91`;
    conferido também em `onda6c-integracao-orquestracao.md` §21.2).
  - Com a coleta atual, o máximo avaliável é:
    - **22** meios-pontos automáticos;
    - **26** com o UTM comprovado (X5);
    - **34** com o juízo humano C2 (`criteria-sources.ts:11-12`, `:106-112`).
  - 34 em 200 dá **17 %**. N/A não aumenta a cobertura: o denominador da publicação é fixo
    (`onda6c-integracao-orquestracao.md` §21.4).
  - O mínimo para publicar é **40 %** (`src/lib/link-audit/scoring/ruler.ts:142`, portão `COVERAGE_MIN` em
    `scoring/publication.ts:17`; a constante de exibição está em `link-audit-scoring-runs/outcome.ts:11`).
  - O portão que falha leva a `INCONCLUSIVO` (`outcome.ts:29-31`).
- **Para o produto:** todo resultado real sai **INCONCLUSIVO**, sem índice Lumos, classificação nem pontos obtidos. A tela
  diz "Auditoria inconclusiva" (checklist §9). Isso vale também para o piloto e para a coleta nova da auditoria-alvo da W6. O
  primeiro resultado de produção seria um **registro técnico**, não uma nota para o cliente.
- **Mesmo com a D5:** sem custo de API (D5-0, parsers e site), o teto sobe a 27 %. Os 40 % exigem `/reviews`, de custo
  desconhecido e com decisão de LGPD pendente, ou o painel anexado pelo operador, que é upload de arquivos e nova
  superfície de segurança (`onda6c-integracao-orquestracao.md` §21.3, §21.6).
- **Decisão do responsável (D-G0-10, 20/11/2026):** **aceite formal de que a produção começa só com resultados
  INCONCLUSIVOS.** A D5 continua **não autorizada para implementação**. A D5-0 (sem custo de API) será avaliada à parte,
  no documento próprio; a D5-1 (`/reviews`) só com custo e LGPD decididos.

## 6. Critérios de aceite (cada um vira ao menos um teste com o identificador no nome)

Os critérios de provedor (PG-G08, PG-G10, PG-G11) e os de implantação (PG-V02, PG-V03) são conferências documentadas, não
testes automatizados: chamar o Supabase, o GitHub ou um fornecedor de armazenamento é chamada externa real, que só
acontece num laboratório autorizado pelo responsável ou pelo próprio responsável (`CLAUDE.md`, "Anti-patterns").

**Depois da G0:** com a D-G0-1 (Supabase), só o **PG-G08** vale; o **PG-G10** e o **PG-G11** ficam **NÃO APLICÁVEIS** e
são mantidos abaixo só como registro, para o caso de a decisão ser revista (ADR-0003). Com a D-G0-6 (opção 3), os
**PG-A01 a PG-A04** também ficam **NÃO APLICÁVEIS**; a G1.c é só o aceite formal.

**Guarda (G1.b):**

- [x] **PG-G01** Com a guarda configurada, `head: null` e livro com ≥ 2 registros ⇒ `HISTORY_UNRESOLVED` (`GUARD_HEAD_MISSING`); com 1 registro ⇒ aceito. *(G1.b.1, 21/11/2026: `tests/link-audit-guard-contract.test.ts`.)*
- [x] **PG-G02** Atraso > `L_max` ⇒ `HISTORY_UNRESOLVED` (`GUARD_LAGGING`); atraso ≤ `L_max` ⇒ `PROTECTED` com `externalGuard: BEHIND`. `L_max` é igual à contagem do protocolo, travada em teste: **5** (§5.1.7), com um teste que enumera os fluxos legítimos e mostra que nenhum passa de 5 com a regra da rotação. *(G1.b.1, 21/11/2026: `tests/link-audit-guard-contract.test.ts`; o pior caso da tabela da §5.1.7 dá atraso 5 e um registro a mais dá `GUARD_LAGGING`.)*
- [x] **PG-G03** Para **cada um dos nove pontos S1–S9** (§5.1.2), um teste faz a publicação falhar logo depois do registro gravado e confere o desfecho da regra 4 da §5.1.4: (i) a resposta nunca diz que nada foi gravado; (ii) a vista mostra `BEHIND` (S1, S6, S7, S8, S9, e S3–S5 quando a sessão termina num `RECOVER`), ou a publicação obrigatória seguinte recusa com `LEDGER_GUARD_UNAVAILABLE` (S2–S5 quando a sessão segue para uma operação nova); (iii) o evento de alarme é emitido; (iv) a operação nova seguinte recusa até conseguir publicar. São nove testes, cada um com `PG-G03` e o ponto (`S1`…`S9`) no nome, incluindo o `CHECKPOINT` (S6) e o `RECEIPT_REISSUED` (S7). *(G1.b.1, 21/11/2026: `tests/link-audit-guard-publish-failures.test.ts`.)*
- [ ] **PG-G04** Rollback coordenado de decisões, recibos e livro (e de resultados) com a guarda real atrás da porta ⇒ `GUARD_MISMATCH`. O teste "LIMITE DECLARADO" continua valendo para a configuração **sem** guarda.
- [ ] **PG-G05** Contrato da publicação (regra 7 da §5.1.4), no adaptador e no provedor simulado, sem rede:
  - o mesmo trio republicado ⇒ aceito sem registro novo, também numa posição abaixo do maior;
  - mesmo `ledgerSeq` com outro `sha256` ⇒ `CONFLICT`;
  - `ledgerSeq` novo menor que o maior ⇒ `STALE`;
  - `ledgerSeq` maior que o maior ⇒ gravado.
  - Sequência falsa acima da real ⇒ a auditoria congela (`GUARD_MISMATCH`) e nunca esconde retrocesso.
  - `STALE` coberto por uma cabeça maior que está no livro ⇒ sem alarme; `CONFLICT` ⇒ alarme.
  - *Parte do adaptador sintético e do serviço atendida na G1.b.1 (21/11/2026, `tests/link-audit-guard-contract.test.ts`); o provedor simulado do adaptador real fica para a G1.b.2.*
- [x] **PG-G06** `latest` com erro, resposta fora do esquema ou prazo esgotado ⇒ `GUARD_UNAVAILABLE` (nunca "nenhuma cabeça"). *(G1.b.1, 21/11/2026: na porta, `boundGuard`, e no serviço; o adaptador real passa pela mesma porta.)*
- [ ] **PG-G07** Sem credencial da guarda ⇒ `externalGuard: NOT_CONFIGURED`, e o verificador do portão (§10.1, G-1) acusa.
- [ ] **PG-G08** (aplicável: Q1 = opção 1, Supabase, D-G0-1), com evidência registrada no laboratório e depois em produção:
  - **`PUBLIC` pelo ACL:** `PUBLIC` é pseudopapel, então a conferência é no ACL e não por `has_*_privilege`. `proacl` da função de publicação (e das funções dos gatilhos), `relacl` da tabela e `nspacl` do esquema são **não nulos** (nulo é o padrão, que nas funções dá `EXECUTE` a `PUBLIC`), e nenhum item de `aclexplode(...)` tem grantee `0` (`PUBLIC`);
  - **papéis reais:** `has_table_privilege`, `has_schema_privilege` e `has_function_privilege` dão falso para `anon`, `authenticated` e `service_role` na tabela, no esquema e na função; o `gmn_guard_writer` só tem `USAGE` no esquema, `EXECUTE` na função e `SELECT` na tabela (`has_table_privilege` falso para `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`); a migração aborta se divergir;
  - **função `SECURITY DEFINER`:** em `pg_proc`, `proowner` = o dono dedicado (`gmn_guard_owner`), `prosecdef` = verdadeiro e `proconfig` contém `search_path=""`;
  - **papéis:** `has_schema_privilege(gmn_guard_writer, <esquema>, 'CREATE')` falso; `rolcanlogin` = falso para o `gmn_guard_owner`; o `gmn_guard_writer` e o dono não são membros de nenhum papel privilegiado (`pg_auth_members`) e não têm `rolsuper`, `rolcreaterole`, `rolcreatedb`, `rolreplication` nem `rolbypassrls`;
  - **gatilhos:** `UPDATE`, `DELETE`, `TRUNCATE` e um `INSERT` direto fora da regra 7 são recusados mesmo para um papel com o privilégio concedido. Isso é defesa em profundidade e **não** substitui o `REVOKE` nem a prova pela Data API: um `INSERT` direto com sequência válida passaria;
  - **Data API (REST):** requisições de leitura e de escrita à tabela e à função, com as chaves `anon`, `authenticated` (sessão de teste) e `service_role`, falham sem expor dados; e *Exposed schemas* não inclui o esquema da guarda, registrado com data. Hoje o estado de *Exposed schemas* não está verificado (`docs/phase5/g5-s0-relatorio-2026-11-07.md:82`);
  - no laboratório, com autorização; em produção, pelo responsável, só leitura, depois de aplicar a migração.
- [ ] **PG-G09** A reconciliação acusa: cabeça da guarda ausente do backup; guarda que regrediu em relação ao registro anterior; backup à frente da guarda além de `L_max`. Saída `--json` estável; não escreve na guarda.
- [ ] **PG-G10** — **NÃO APLICÁVEL (D-G0-1: a opção 2 não foi escolhida).** Texto mantido como registro. (Só se Q1 = opção 2, GitHub), com evidência registrada:
  - regra de proteção ativa na branch do repositório da guarda, sem push forçado e sem exclusão, com a lista de exceções vazia ou só com o dono, declarado;
  - token fine-grained restrito a esse repositório, só com `contents: write` (mais o `metadata: read` obrigatório), sem `administration`, com a expiração anotada;
  - com o token, um push forçado e a exclusão da branch são recusados;
  - a leitura reconstrói as cabeças pelo histórico de commits;
  - o plano pago (repositório privado) está autorizado, ou o repositório é público com `auditId` pseudonimizado (Q5).
- [ ] **PG-G11** — **NÃO APLICÁVEL (D-G0-1: a opção 3 só com custo autorizado; revisão futura no ADR-0003).** Texto mantido como registro. (Só se Q1 = opção 3, Object Lock), com evidência registrada:
  - bucket com versionamento e Object Lock em modo *compliance*, com retenção padrão decidida na G0;
  - a credencial da VPS só tem `PutObject` (nada de apagar objeto ou versão, contornar ou alterar retenção, nem mudar a política ou a configuração de Object Lock do bucket);
  - com essa credencial, apagar uma versão e encurtar a retenção falham;
  - a gravação não sobrescreve chave existente (escrita condicional) ou o leitor considera todas as versões;
  - o custo está autorizado.

**Papel administrativo (G1.c, só se Q6 = 1 ou 2; NÃO APLICÁVEIS com a D-G0-6, mantidos como registro):**

- [ ] **PG-A01** Uma identidade só, ou o solicitante como aprovador, ⇒ recusado e nada gravado.
- [ ] **PG-A02** Sem fonte independente conferida ⇒ recusado.
- [ ] **PG-A03** O ACK grava justificativa, fonte, cabeças antes e depois e aprovadores; os arquivos afastados vão para a custódia com o hash citado e nunca são apagados.
- [ ] **PG-A04** (opção 2) Confirmação antes do fim da espera, assinatura de outro domínio ou chave diferente da fixada ⇒ recusado.

**Volumes e chaves (G1.a):**

- [ ] **PG-V01** `tests/deploy-config.test.ts`: sete pastas no web; evidências e manifestos só leitura; o Worker sem `GMN_LINK_AUDIT_*` nem bind novo; os nomes novos na lista do entrypoint; `stop-first` no web; nenhum valor literal.
- [ ] **PG-V02** (VC-E6) O plano de backup cita as seis variáveis de pasta da Fase 6, com destinos independentes (em marcador) para os dois volumes de recibos e para o livro, pares do mesmo instante, `sha256sum` por arquivo, sem `--delete`, e as cabeças guardadas junto.
- [ ] **PG-V03** (VC-E7) `PROVA-DE-ORIGEM-E-DE-COLETA.md` e o checklist de produção citam a chave do livro, a chave de log, a credencial da guarda e a ordem de ativação (volumes e chaves ⇒ guarda ⇒ primeiro `ENROLL`).
- [ ] **PG-V04** (VC-E8) O runbook traz o procedimento de criação e conferência das pastas no host (dono `10001:10001`, modo `0700`, conferido por `stat`). A conferência executada fica registrada no relatório da G2 (homologação, ensaio EN-12) e na tabela do portão (produção, G-3).
- [ ] **PG-L01** `operatorRef` determinístico com `GMN_LINK_AUDIT_LOG_KEY`; chave ausente ou fraca ⇒ `UNAVAILABLE`; chave igual à de origem ou à do livro ⇒ recusada; e-mail nunca no log (critérios §10.2 da spec de observabilidade).

## 7. Casos-limite transversais

- **Ordem de ativação:** volumes e chaves ⇒ guarda ⇒ `ENROLL`. Inverter cria auditoria sem cabeça publicada (§5.1.4,
  regra 1).
- **Sem as pastas de resultados, as decisões também não gravam** (testemunha obrigatória, checklist §1). A ativação liga
  tudo junto.
- **Chave do livro igual à de origem:** a configuração é recusada (`ledger/config.ts:35-38`). Vale o mesmo para a chave
  de log (PG-L01).
- **Restauração:** sem o papel administrativo, restaurar backup mais velho que a guarda congela as auditorias afetadas
  (§5.1.5). O ensaio da G2 mede isso antes de produção.

## 8. Segurança e ameaças

Modelos existentes: `docs/security/threats/link-audit-ledger-e-resultados.md` (lacunas do livro, que remete ao
normativo `docs/phase6-auditoria-link/onda6c-modelo-de-ameacas-recuperacao.md`),
`docs/security/threats/link-audit-decisoes-e-recibos.md`, `docs/security/threats/link-audit-api-e-interface.md` e o
índice `docs/security/threats/INDEX.md`.

| Entrega | Ameaças que fecha ou reduz |
|---|---|
| Guarda (GE-E1–E8) | **T-L01 / L-T2** (rollback coordenado sem guarda; INDEX, risco nº 1; ação A-L1); recuperação §6.3 e §8b (linha "livro + decisões + recibos, com guarda externa"); spec do livro §13 **L1/L2** e R6-08/R6-10; checklist MINOR-2 (distinguir recibo removido de gravação interrompida, com o `head` fora) |
| Papel administrativo (opção 1 ou 2) | **T-L02 / L-D2** (congelamento sem reabertura; INDEX, risco nº 2; ação A-L2); R6-13; L6 da spec do livro. Com a opção 3: **nada é fechado**, o risco é aceito formalmente |
| Volumes e chaves (VC-E1–E8) | Falha fechada por configuração ausente (checklist §1–§2); R6-09 (`stop-first`); colocalização de dados e recibos (checklist l.55); hipótese de confiança "chaves só no ambiente" (recuperação §9) |
| Chave de log (PG-L01) | **T-A01 / A-R1** e **D-R1** (rotas sem log; INDEX, risco nº 3) na parte de identificar o operador sem PII; T-D01 (revogação cruzada sem trilha fora das pastas) só quando a exportação externa dos logs existir (D-G0-8) |

**Ameaças novas trazidas por esta spec** (a superfície muda com a integração de um terceiro). O modelo STRIDE próprio,
entregue na G0, é `docs/security/threats/link-audit-portoes-producao.md`: ele lista cada item abaixo com status, mais as
ameaças das decisões D-G0-x (configuração do Supabase, pseudônimo, falso `GUARD_LAGGING`, reconciliação, exportação de
logs, backups e homologação).

- **Credencial da guarda na VPS:** permite congelar auditorias publicando uma sequência falsa acima da real (DoS) e ler
  cabeças. Mitigação: regra 7 da §5.1.4 (nunca esconde retrocesso), alarme de `CONFLICT` e o pseudônimo da D-G0-5. Sem
  papel administrativo (D-G0-6), a auditoria congelada não reabre.
- **Web comprometido mente sobre o `latest`:** esconde um retrocesso das telas. Só a reconciliação externa detecta, e
  depois do fato (GE-E5).
- **Dono ou administrador do provedor** (opções 1 e 2): altera ou remove a guarda. Risco declarado; só a opção 3
  oferece independência contra o dono da conta.
- **Disponibilidade acoplada ao provedor da guarda** em toda leitura. Mitigação: prazo de resposta de 3 s e falha fechada
  declarada (D-G0-3).
- **Caminho administrativo:** seria uma elevação de privilégio nova com a opção 1 ou 2. Com a D-G0-6 (opção 3) não há
  superfície nova; fica o congelamento sem reabertura, aceito para o piloto. Para o futuro: §5.2.4 e PG-A01–A04.
- **Chave de log vazada:** com poucos e-mails, o pseudônimo é revertido por dicionário. Mitigação: chave exclusiva, acesso
  aos logs só do responsável e de quem opera o servidor (decisão de 16/11/2026).

## 9. Observabilidade

Os eventos novos seguem o envelope e a proibição de PII da spec de observabilidade (§5.2 e §10.2 daquela spec):

- guarda indisponível;
- `GUARD_MISMATCH`;
- `GUARD_HEAD_MISSING` e `GUARD_LAGGING`;
- falha de publicação depois do fecho;
- atraso `BEHIND` acima de `T`;
- tentativa de ação administrativa (com `operatorRef`, nunca o e-mail).

Os alertas dependem do destino dos logs, decidido na D-G0-8 (exportação diária e cifrada para o destino dos backups).
Até a exportação existir (G1.a), valem a vista do livro na tela, que já mostra `externalGuard`, e a reconciliação
externa (GE-E5). A exportação diária não é canal de alerta em tempo real: o alarme de `T` = 15 min (D-G0-4) só chega a
alguém de fora da VPS quando existir um canal de alertas (Q8 da spec de observabilidade, ainda aberta).

## 10. Portão de produção, piloto e rollout

### 10.1 (e) Portão consolidado: tudo o que precisa estar pronto antes do primeiro resultado de produção

Legenda do tipo: **código** = o manager faz sozinho (autonomia de 19/11/2026), com testes, revisão independente e CI
verde; **responsável** = decisão ou ação que não se delega (deploy só pelo CI e por decisão dele, cerimônia da chave,
consultas pagas, custo, aplicação de migração em produção, secrets reais).

| # | Item | Origem | Tipo |
|---|---|---|---|
| P-1 | **R1 completa** (R1.6: reemissão do recibo de resultado e sync estrito). Nada da R1 vai para produção antes da R1.5 e da R1.6 | plano, onda R1; `NOTES.md` (R1.3) | código |
| P-2 | **R2**: o resultado registra a proveniência que o atestou | plano, onda R2; P1 D14 (O6) | código |
| P-3 | **W4.6**: artefato único do `sign`, com hash versionado conferido pelo CI | plano, onda W4 | código |
| P-4 | **W5**: runbooks, dossiê, ensaio em homologação com chave descartável e relatório; mudança de código da D15.6(d); fase 2 do ADR 6C-03 (volume de manifestos); canal de entrega pelo CI (D7, D15.5) | plano, onda W5; P1 §13.4 | código + responsável (homologação) |
| P-5 | **Aceite formal de risco assinado** (D15.1) e **cerimônia da chave real** (D15.7) | P1 §13.4 | responsável |
| P-6 | **W6**: uma coleta LIVE nova, atestada com a chave real. Autorizada (D16) para depois do ensaio da W5; o responsável executa a consulta paga | plano, onda W6; P1 D16 | responsável |
| P-7 | Chave pública ativa na lista `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` e verificador `v2` implantado com `acceptedVersions: [2]` (`scoring/shared.ts:99-104`) | P1 §12; runbook de chaves §4 | responsável (configuração e deploy) |
| G-1 | **Guarda operante**: provedor decidido (Supabase, D-G0-1); GE-E1–E7 na `main`; PG-G08 atendido com evidência; migração aplicada; `externalGuard` = `CONSISTENT` em homologação; reconciliação rodando (D-G0-2) | §5.1 | código + responsável (migração, credenciais) |
| G-2 | **Papel administrativo**: decidido manter o 403 (D-G0-6, opção 3); falta o **aceite formal escrito** do risco. (Com a opção 1 ou 2 no futuro: implementado, PG-A01–A04) | §5.2 | responsável (aceite) |
| G-3 | **Volumes e chaves**: VC-E1–E7 na `main` (PG-V01 a PG-V03); secrets criados; pastas no host com dono e modo conferidos e registrados (VC-E8, PG-V04); backups independentes configurados (D-G0-9: um destino por volume de recibos e um para o livro, cópia diária) | §5.3 | código + responsável (secrets, host, destinos) |
| G-4 | **Chave de log** usada pelo código (PG-L01) e provisionada; destino dos logs decidido (D-G0-8) e exportação diária cifrada funcionando, ou aceite de que, por ora, ficam só na VPS | §5.3.4 | código + responsável |
| G-5 | **D5**: aceite formal de que todo resultado sai INCONCLUSIVO (D-G0-10, 20/11/2026), **comunicado à equipe** (checklist §0 e §9). A D5 segue não autorizada | §5.4 | responsável (comunicação) |
| G-6 | **Ensaio da G2 aprovado**: os 16 ensaios da §10.4 (EN-01, EN-02a a EN-02e, EN-03 a EN-12) e as atestações AT-G2-01 e AT-G2-02 com resultado e evidência no relatório, executados **depois** do ensaio da W5 (ou em ambiente totalmente isolado, §10.4) | §5.1.3 GE-E8; §10.4; checklist §10 itens 4–5 | código + responsável (homologação) |
| P-8 | **Demais itens do checklist de produção**: autorização escrita da implantação (§0); os riscos P-1 a P-4 **do checklist** decididos (§12; não confundir com as linhas P-1 a P-4 desta tabela); ensaio de queda de energia (R6-07; risco P-4 do checklist); fatias de log da spec de observabilidade que o responsável exigir; revisão independente sem BLOCKER; plano de teste do §10 | `onda6c-checklist-producao.md` | código + responsável |
| P-9 | **Deploy pelo CI**, por decisão do responsável, com verificação pós-deploy e o primeiro teste de escrita só numa auditoria sintética combinada (checklist §10 item 6) | `CLAUDE.md` (deploy só por CI) | responsável |

Numeração: **P-1 a P-9** são os portões do P1 e da implantação; **G-1 a G-6** são os desta spec. São 15 linhas ao todo.
O portão só abre com **todas** atendidas. A única exceção prevista é o piloto da §10.2, que é declarada e tem prazo.

### 10.2 (f) Piloto mínimo: exceção declarada, não encerramento

> **Decidido (D-G0-11, 20/11/2026):** piloto aceito **em princípio**, depois da G2, limitado a **uma auditoria nova**,
> com prazo de **30 dias**. O aceite escrito específico da condição 4 abaixo é dado pelo responsável **na hora, antes do
> deploy**; sem ele o piloto não começa.

Um piloto pode rodar **antes** de G-2 e G-5 estarem resolvidos no sentido forte (papel administrativo implementado e D5).
São as **duas únicas dispensas**, e as duas são declaradas: as ações administrativas ficam em 403, com o congelamento
aceito, e todo resultado sai INCONCLUSIVO, sem nota. Todo o resto do portão continua obrigatório:

| Linha do portão (§10.1) | No piloto |
|---|---|
| P-1 a P-7 (portões do P1) | **Obrigatórias**: sem elas, a finalização segue `NOT_FINALIZABLE` |
| P-8 (demais itens do checklist de produção) | **Obrigatória** |
| P-9 (deploy pelo CI, por decisão do responsável) | **Obrigatória** |
| G-1 (guarda operante) | **Obrigatória** |
| G-2 (papel administrativo) | **Dispensável**, com o aceite formal de manter o 403 (Q6 = 3, D-G0-6) e o congelamento sem recuperação pela aplicação |
| G-3 (volumes e chaves) | **Obrigatória** |
| G-4 (chave de log) | **Obrigatória**: a própria linha já admite o aceite de logs só na VPS |
| G-5 (D5) | **Dispensável**, com o aceite formal de que todo resultado sai INCONCLUSIVO |
| G-6 (ensaio integrado da G2) | **Obrigatória**: o piloto só começa depois da G2 aprovada (D-G0-11) |

Além da tabela, **todas** as condições abaixo valem e ficam escritas:

1. **Uma auditoria nova e vazia**, inscrita depois da guarda ativa. Nunca uma auditoria legada nem a pasta antiga da
   auditoria-alvo da W6. A coleta da W6 entra numa auditoria nova.
2. **Guarda, volumes e chaves operantes e ensaiados:** G-1, G-3, G-4 e G-6 atendidos, e `externalGuard` = `CONSISTENT`
   na tela antes da primeira decisão.
3. **Ações administrativas continuam em 403** (Q6 = 3 durante o piloto, D-G0-6).
4. **Aceite formal e escrito do responsável** cobrindo:
   - o congelamento sem recuperação pela aplicação: auditoria congelada é abandonada, a evidência é preservada e se abre
     uma nova;
   - todo resultado INCONCLUSIVO, sem nota ao cliente;
   - o prazo e o escopo do piloto.
5. **Os portões do P1 e da implantação continuam obrigatórios** (P-1 a P-9): sem os do P1, a finalização segue
   `NOT_FINALIZABLE` e não há resultado.
6. **Deploy só pelo CI**, por decisão do responsável (P-9).

O piloto **não encerra** os bloqueadores. Termina com um relatório (`docs/phase6-auditoria-link/` ou a seção da G3 no
plano) e com a decisão de seguir para o portão completo ou parar.

### 10.3 Rollout e reversão

- Sem *feature flag*. A ordem é a da §7: o código chega primeiro sem configuração e falha fechado (503 ou
  `NOT_CONFIGURED`), depois vêm volumes e chaves, depois a guarda, e por último o uso.
- **Reversão:** depois do primeiro `ENROLL`, não se volta à imagem anterior ao livro (R6-09). Uma reversão de imagem
  posterior acontece com `stop-first` e sem apagar nada. Desligar a guarda (tirar a credencial) volta a vista a
  `NOT_CONFIGURED`, o que fecha o portão, mas não apaga dados.
- **Migração do Supabase (opção 1):** só em `supabase/proposed/` até o responsável aplicar; o rollback acompanha a
  migração e **não** apaga linhas da guarda.

### 10.4 Ensaio da G2: sequência em relação à W5 e roteiro verificável

**Sequência.** A G2 faz rollback de volumes, restaurações e derruba o provedor da guarda. A W5 grava e finaliza um
resultado de ensaio com chave descartável. Na mesma pilha e ao mesmo tempo, uma corromperia a prova da outra. Regra:

- **padrão: a G2 roda depois do relatório da W5 aprovado.** A W5 fecha antes (chave do ensaio destruída e registrada,
  relatório arquivado), e a G2 começa com **auditorias novas** inscritas depois de ligar a guarda (§5.1.4, regra 1); as da
  W5 não são reaproveitadas. Justificativa:
  - a G3 já depende das duas, então a ordem não atrasa o portão;
  - um ambiente basta;
  - com a W5 pronta, a G2 também consegue ensaiar o retrocesso de um livro com registros `RUN_*`, o caso mais
    realista;
- **paralelo, só com isolamento total:** pilhas separadas, volumes separados, projeto ou esquema de laboratório da guarda
  separado e credenciais separadas (nenhum segredo, chave descartável ou credencial em comum). O isolamento fica
  registrado nos dois relatórios.

**Roteiro.** O relatório (`docs/phase6-auditoria-link/producao-relatorio-ensaio-g2.md`) traz duas tabelas:

- uma linha por ensaio, no formato `| EN-xx | PASSOU ou FALHOU | resultado observado | evidência |`, para os 16
  ensaios abaixo (EN-01, EN-02a a EN-02e, EN-03 a EN-12). A evidência é a vista do livro, o código da resposta,
  a saída da reconciliação ou do `stat`;
- uma linha por atestação, no formato `| AT-G2-xx | SIM | evidência |`:
  - **AT-G2-01**, nada em produção: nenhum deploy, migração, secret, chamada ou dado de produção durante o ensaio;
  - **AT-G2-02**, chaves e credenciais do ensaio (chaves descartáveis, credenciais da guarda de laboratório) destruídas
    ou revogadas, com data.

A G2 só fecha com todos os ensaios em `PASSOU`, as duas atestações em `SIM` e nenhuma célula de resultado ou evidência
vazia.

| Ensaio | O que se faz | Resultado esperado |
|---|---|---|
| EN-01 | Rollback coordenado de decisões, recibos e livro (e de resultados com `RUN_*`) a um instante anterior à última cabeça publicada | `GUARD_MISMATCH`; nada vigente; escrita recusada |
| EN-02a | Restauração dos pares do mesmo instante cuja cabeça do livro é **exatamente** a última cabeça publicada | `PROTECTED` com `externalGuard` = `CONSISTENT`; leituras normais; a escrita seguinte publica e prossegue; reconciliação sem divergência |
| EN-02b | Restauração dos pares do mesmo instante com o livro **à frente** da guarda por até `L_max` registros, com o provedor no ar | Leitura: `PROTECTED` com `externalGuard` = `BEHIND`, decisões vigentes. A escrita seguinte publica a cabeça atual antes de começar (`service.ts:763`/`:893`) e prossegue. O `CONSISTENT` é conferido numa **leitura nova**, porque o `publishGuard` não atualiza a cabeça da guarda guardada na sessão (`service.ts:404-408`). Alarme se o atraso passar de `T` |
| EN-02d | Como o EN-02b, com o provedor **já fora do ar quando a sessão lê a guarda** (bloqueio de rede ou credencial inválida antes da leitura) | O `latest` falha (`service.ts:246-248`) ⇒ `HISTORY_UNRESOLVED` com razão `GUARD_UNAVAILABLE` (`model.ts:489`); nada vigente; a escrita recusa com `DECISIONS_HISTORY_UNRESOLVED` (mapeamento de estado em `service.ts:342-347`); nada gravado; alarme |
| EN-02e | Como o EN-02b, com o provedor caindo **depois do `latest` e antes do `publish`** (no laboratório, revogar o `EXECUTE` da função de publicação: o `latest` continua lendo) | Leitura: `BEHIND`. A escrita recusa com `LEDGER_GUARD_UNAVAILABLE` na publicação obrigatória (`service.ts:763` ou `:893`); nada gravado; alarme |
| EN-02c | Livro à frente da guarda por **mais** de `L_max` registros (produzido no ensaio desligando a publicação, porque o fluxo legítimo não chega lá) | `HISTORY_UNRESOLVED` com `GUARD_LAGGING`; nada vigente; nada finalizável; toda escrita recusada; alarme; sem reabertura pela aplicação enquanto o papel administrativo não existir |
| EN-03 | Restauração de backup mais velho que a guarda | Auditoria congelada (`GUARD_MISMATCH`), com o efeito sem papel administrativo descrito |
| EN-04 | Rollback para a imagem anterior (posterior ao livro) com `stop-first`, sobre os mesmos volumes | Dados íntegros; nunca dois processos web gravando ao mesmo tempo |
| EN-05 | Provedor da guarda fora do ar (bloqueio de rede ou credencial inválida) numa auditoria sem atraso | `GUARD_UNAVAILABLE`; nada vigente; escrita recusada com `DECISIONS_HISTORY_UNRESOLVED`; alarme |
| EN-06 | Publicação falha depois de um `CONFIRMED` de decisão (S8) | Sucesso com `BEHIND`; alarme; a próxima operação recusa até publicar |
| EN-07 | Sequência falsa publicada com a credencial de escrita | Auditoria congelada (`GUARD_MISMATCH`); a reconciliação acusa |
| EN-08 | Reconciliação contra um backup atrasado e contra uma guarda à frente do backup | Divergência acusada nos dois casos, com código de saída ≠ 0 |
| EN-09 | Volume de recibos só leitura (força `ANCHOR_PENDING`) e depois a recuperação | Pendência visível; o autor conclui; nada é perdido |
| EN-10 | Disco cheio (`ENOSPC`) num volume gravável | Escrita recusada, sem sucesso falso; alarme |
| EN-11 | `ADOPT`, `RESTORE_ACK` e `QUARANTINE_ACK` | Com a D-G0-6 (opção 3): 403 `ADMIN_APPROVAL_UNAVAILABLE`, nada gravado. (Se a Q6 for revista: opção 1 ⇒ o fluxo decidido, com PG-A01 a PG-A03; opção 2 ⇒ com PG-A01 a PG-A04) |
| EN-12 | Conferência das pastas no host (dono `10001:10001`, modo `0700`, por `stat`) e do Worker sem montagem nova | Saída do `stat` e de `docker service inspect` anexadas (VC-E8, PG-V04) |

## 11. Decisões da onda G0 (20/11/2026)

**Registro.** Em 20/11/2026 o manager propôs ao responsável seguir as doze recomendações desta seção (texto original na
§11.2). Resposta do responsável: **"tudo aprovado"**. A recomendação da Q5 deixava dois caminhos (em claro, se a Q4 da
spec de observabilidade confirmasse que o `auditId` não deriva do nome da empresa nem do link, ou HMAC com chave
própria). Como aquela Q4 continua aberta, a escolha entre os dois foi do **manager**, pelo lado fechado: HMAC. A coluna
"Quem" diz quem decidiu cada item.

| ID | Questão | Decisão | Quem | Onde vale |
|---|---|---|---|---|
| D-G0-1 | Q1 Provedor da guarda | Opção **(1) Supabase**, com o desenho da §5.1.6, para o risco "VPS comprometida" (e restauração errada de backup). **Limite declarado:** não protege contra o dono ou administrador do projeto Supabase. Object Lock (opção 3) só com custo autorizado pelo responsável: é a revisão futura do ADR-0003. Critério do provedor: PG-G08; PG-G10 e PG-G11 não se aplicam | Responsável | §5.1.6; ADR-0003; G1.b |
| D-G0-2 | Q2 Reconciliação | O **responsável** reconcilia, com credencial **só de leitura fora da VPS** (`gmn_guard_reader`): **toda semana**, **depois de cada backup do livro** e **obrigatoriamente antes de qualquer restauração** | Responsável | GE-E5; GE-E7 |
| D-G0-3 | Q3 Indisponibilidade | **Falha fechada também na leitura** (o comportamento de hoje, `src/lib/link-audit-ledger/model.ts:495` em `3899a67`). Prazo de resposta de **3 s** por chamada à guarda, a confirmar na G1 pela latência medida. **Nada de modo degradado** | Responsável | §5.1.4 regra 5; §5.1.7 |
| D-G0-4 | Q4 Atraso máximo | `L_max` = a contagem do protocolo, travada em teste. Alarme se `BEHIND` durar mais de **`T` = 15 min**. A contagem do manager dá **`L_max` = 5** (§5.1.7), a travar na G1.b (PG-G02) | Responsável (regra); manager (contagem) | §5.1.4 regra 3; §5.1.7 |
| D-G0-5 | Q5 `auditId` na guarda | **Pseudonimizado por HMAC-SHA-256** com chave própria da guarda, **`GMN_LINK_AUDIT_GUARD_KEY`** (formato `<id>:<64 hex>`, distinta das chaves de origem, do livro e de log). Motivo: o "em claro" ficaria condicionado à Q4 da observabilidade, ainda aberta; o `auditId` nasce do id da autorização escrito pelo responsável (`src/lib/link-audit-runtime/run.ts:181`) e, no único caso real registrado no `NOTES.md`, começa pelo nome da empresa. Rotação: §5.1.7 | Manager (lado fechado), dentro da recomendação aprovada | §5.1.4 regra 8; §5.1.7; §5.3.1 |
| D-G0-6 | Q6 Papel administrativo | Opção **(3), manter o 403 no piloto**, com o aceite formal escrito (§10.2, condição 4). Opção (1) quando houver segunda pessoa, com a emenda "quatro olhos" decidida junto. Opção (2) só sob necessidade real, com chave administrativa própria (não a K1) e canal de aviso fora da VPS | Responsável | §5.2; G1.c (só o aceite); G-2 |
| D-G0-7 | Q7 Espera e canal da opção (2) | **Não se aplica**, porque a D-G0-6 é a opção (3). Recomendação registrada para o futuro: espera de 72 h e aviso pelo destino externo dos logs e alertas (D-G0-8 e um canal de alerta); sem esse canal funcionando, a opção (2) não é adotada | Responsável | §5.2.4 |
| D-G0-8 | Q8 Logs fora da VPS | **Sem ferramenta paga.** Exportação **diária e cifrada** do log do contêiner para o **mesmo destino independente dos backups**, com **expurgo aos 90 dias**. Fecha o "onde" da Q3 da spec de observabilidade | Responsável | §5.3.4; G1.a; G-4 |
| D-G0-9 | Q9 Backups dos recibos e do livro | **Um destino independente para cada volume de recibos e para o livro**, fora do disco dos dados; **cópia diária**; **ensaio de restauração na G2 e a cada trimestre** | Responsável | VC-E6; G1.a; G2; G-3 |
| D-G0-10 | Q10 D5 | **Aceite formal de que a produção começa só com resultados INCONCLUSIVOS.** A D5 **não** fica autorizada para implementação: a D5-0 (sem custo de API) será avaliada à parte, no documento próprio, e a D5-1 (`/reviews`) só com custo e LGPD decididos | Responsável | §5.4; G-5 |
| D-G0-11 | Q11 Piloto mínimo | Aceito **em princípio**, depois da G2, limitado a **uma auditoria nova**, com prazo de **30 dias**. O aceite escrito específico do responsável é dado **na hora, antes do deploy** | Responsável | §10.2; G3 |
| D-G0-12 | Q12 Homologação | **Uma pilha isolada**, sem dados reais e sem Serper, com **laboratório Supabase descartável**, usada **em sequência**: primeiro a W5, depois a G2, com auditorias novas (§10.4). Criar a pilha e o laboratório continua ação do responsável. O custo (plano do Supabase, recursos da pilha) **não foi confirmado**: se houver qualquer custo novo, ele depende de aprovação própria do responsável antes da criação | Responsável | §10.4; W5; G2 |

### 11.1 O que continua aberto depois da G0

- **Números a confirmar na G1.b:** o prazo de 3 s (pela latência medida no laboratório) e `L_max` = 5 (travado em teste
  que enumera os fluxos do protocolo). Se a medida ou o teste pedirem outro valor, a G1.b registra o número novo e o
  motivo na §5.1.7, sem mudar a regra decidida.
- **A confirmar no laboratório (G1.b, PG-G08):** *Exposed schemas* do projeto (`docs/phase5/g5-s0-relatorio-2026-11-07.md:82`),
  privilégios padrão num esquema novo, pausa por inatividade do plano e se a conexão direta exige IPv4 pago (§5.1.6).
- **Aceites escritos do responsável:** o do piloto (D-G0-11, condição 4 da §10.2), que cobre também o 403 (D-G0-6) e o
  INCONCLUSIVO (D-G0-10); e a comunicação à equipe de que todo resultado sai INCONCLUSIVO (G-5).
- **Spec de observabilidade:** a Q4 (`auditId` derivado do nome da empresa) segue aberta, mas não bloqueia a guarda (D-G0-5);
  a Q8 (quem recebe os alertas e por qual canal) segue aberta e limita o alarme de `T` (§9).
- **D5-0:** avaliação à parte, no documento próprio (`onda6c-integracao-orquestracao.md` §21). Nada autorizado.

### 11.2 Texto original das questões (proposta de 20/11/2026, antes da G0)

Cada questão trazia a recomendação do manager. O texto abaixo é o que foi aprovado; as decisões valem pela tabela acima.

1. **Provedor da guarda.** Recomendação: **opção (1) Supabase**, com o desenho da §5.1.6, para o risco "VPS
   comprometida". Ela não protege contra o dono ou administrador do projeto Supabase. Se essa independência também for
   exigida, a resposta é a opção (3), com custo autorizado. Opção (2) não. Critério de cada opção: PG-G08, PG-G10 ou
   PG-G11.
2. **Quem reconcilia e com que frequência.** Recomendação: o responsável, com credencial só de leitura fora da VPS,
   **toda semana**, **depois de cada backup do livro** e **obrigatoriamente antes de qualquer restauração**.
3. **Política de indisponibilidade da guarda.** Recomendação: **falha fechada também na leitura** (é o comportamento de
   hoje, `model.ts:489`), com prazo de resposta de 3 s, a confirmar na G1 pela latência medida. Nada de modo degradado.
4. **Atraso máximo.** Recomendação: `L_max` = a contagem do protocolo, travada em teste; alarme se `BEHIND` durar mais de
   **15 min** (o mesmo prazo que o checklist §5 sugere para pendências).
5. **`auditId` na guarda: em claro ou pseudonimizado.** Recomendação: em claro **só** se a Q4 da spec de observabilidade
   confirmar que o `auditId` não deriva do nome da empresa nem do link; senão, HMAC com chave própria da guarda.
6. **Papel administrativo.** Recomendação: **(3) manter o 403 no piloto**; **(1)** quando houver segunda pessoa, com a
   emenda "quatro olhos" decidida junto; **(2)** só sob necessidade real, com chave administrativa própria (não a K1) e
   canal de aviso fora da VPS.
7. **Se a Q6 for (2): espera e canal de aviso.** Recomendação: espera de **72 h**; o canal é o mesmo destino externo dos
   logs e alertas (Q8). Sem esse canal, a opção (2) não deve ser adotada.
8. **Destino dos logs fora da VPS** (Q3 da spec de observabilidade, ainda aberta). Recomendação: sem ferramenta paga;
   exportação diária, cifrada, do log do contêiner para o mesmo destino independente dos backups, com expurgo aos 90 dias.
9. **Backups dos recibos e do livro: destinos e frequência.** Recomendação: um destino independente para cada volume de
   recibos e para o livro, fora do disco dos dados; cópia **diária**; ensaio de restauração antes da produção (G2) e a
   cada trimestre (como o plano de backup atual já pede).
10. **D5.** Recomendação: **aceite formal de que a produção começa só com INCONCLUSIVO**. Avaliar a D5-0 (sem custo de
    API) à parte, no documento próprio. A D5-1 (`/reviews`) só com custo e LGPD decididos.
11. **Piloto mínimo (§10.2).** Recomendação: **aceitar a exceção** depois da G2, limitada a uma auditoria nova, com aceite
    escrito e prazo (proposta: 30 dias).
12. **Ambiente de homologação para a G2 e a W5.** Hoje "Deploy staging: not defined" (`CLAUDE.md`). Recomendação: uma
    pilha isolada, sem dados reais e sem Serper, com o laboratório Supabase descartável que o G5 já previa
    (`NOTES.md:140`), usada **em sequência**: primeiro a W5, depois a G2, com auditorias novas (§10.4). **Nunca os dois
    ensaios ao mesmo tempo na mesma pilha.** Rodar em paralelo só com pilhas, volumes, guarda e credenciais totalmente
    separados.

## 12. Referências

- `NOTES.md`: encerramento da 6C ("Riscos residuais" e "Bloqueadores de produção"), rodadas de 17/11 a 20/11.
- Spec do livro: `docs/phase6-auditoria-link/onda6c-especificacao-livro-de-cabecas.md` (§9, §12, §13, §14, §16.7, §16.8,
  §16.9, §16.11).
- Checklist de produção: `docs/phase6-auditoria-link/onda6c-checklist-producao.md`.
- Spec do P1: `docs/specs/link-audit-p1-attestation.md` (§12, §13.1, §13.4); plano: `docs/plan/implementation-waves.md`.
- Spec de observabilidade: `docs/specs/link-audit-observability.md` (§7, §12, §14).
- D5: `docs/phase6-auditoria-link/onda6c-integracao-orquestracao.md` §21.
- Runbook de chaves: `docs/phase6-auditoria-link/onda6c-runbook-chaves.md` (§1, §4, §7).
- Implantação: `deploy/hostinger/stack.yml`, `docker-entrypoint.sh`, `Dockerfile`, `PROVA-DE-ORIGEM-E-DE-COLETA.md`,
  `PLANO-DE-BACKUP-E-RESTAURACAO.md`.
- Ameaças: `docs/security/threats/INDEX.md`, `link-audit-portoes-producao.md` (G0), `link-audit-ledger-e-resultados.md`,
  `link-audit-decisoes-e-recibos.md`, `link-audit-api-e-interface.md`;
  `docs/phase6-auditoria-link/onda6c-modelo-de-ameacas-recuperacao.md`.
- ADR-0003, provedor da guarda (G0): `docs/adr/0003-supabase-external-ledger-guard.md`.
