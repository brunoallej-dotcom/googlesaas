# Spec: Portões de produção da Auditoria por Link (Fase 6) fora do Produtor P1

> **Status: PROPOSTA (20/11/2026). Nada disto está implementado.** Redigida pelo manager a partir dos "Bloqueadores de
> produção" e dos "Riscos residuais" do encerramento da Onda 6C (`NOTES.md`, rodada de 16/11/2026). As decisões são do
> responsável (§11); o plano de ondas está em `docs/plan/implementation-waves.md`, seção "Portões de produção da Fase 6
> (fora do P1)".
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
  `onda6c-checklist-producao.md` e entram no portão só por referência (§10.1, item P-10).

## 3. Atores

| Ator | Papel nesta spec |
|---|---|
| **Responsável** | Decide as questões da §11, aplica migrações e cria secrets em produção, autoriza deploy, custo e consultas pagas; hoje é a única pessoa que opera |
| **Manager** | Escreve e mantém esta spec e o plano; implementa e revisa o código das ondas G1 e G2 (autonomia de 19/11/2026) |
| **Operador** | Usuário autenticado (sessão HMAC + `GMN_OPERATOR_EMAILS`); grava decisões e resultados |
| **Servidor web** | Único processo que lê e escreve as pastas da Fase 6 e publica na guarda |
| **Provedor da guarda** | Testemunha imutável fora da VPS (a escolher, §5.1.6) |
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
  - nova operação, novo `RUN_INTENT` e `ENROLL` exigem publicar a cabeça antes (`service.ts:763`, `:893`, `:972`).
  - O limite travado em teste está em `tests/link-audit-ledger-guard.test.ts:56`: sem guarda, o rollback coordenado
    **não** é detectado.
- **Lacunas do contrato R6-10 no código de hoje:**
  - **GE-R3/GE-R6:** com a guarda lida, `head: null` diante de um livro de qualquer tamanho vira só `BEHIND`, e a vista
    continua `PROTECTED` (`model.ts:577-582`). "Nunca publicou" e "esqueceu" saem iguais.
  - **GE-R4:** `BEHIND` não tem limite. Qualquer atraso continua `PROTECTED` (`model.ts:577`).
  - **GE-R5:** depois de um fecho ou de uma receita, o retorno booleano de `publishGuard` é **ignorado**
    (`service.ts:555`, `:590`, `:671`, `:690`, `:710`, `:732`, `:806`, `:829`, `:923`). Só as chamadas *antes* de uma
    operação nova o conferem (`:763`, `:893`, `:972`).
  - O adaptador sintético não tem prazo de resposta. Um adaptador de rede vai precisar de um (§5.1.4, regra 5).

#### 5.1.3 Entregas

| ID | Entrega | Tipo |
|---|---|---|
| GE-E1 | Adaptador real atrás de `ExternalGuardPort`, para o provedor escolhido (Q1): prazo de resposta, respostas validadas com zod e erro ⇒ `{ ok: false }`, nunca "nenhuma cabeça" | código |
| GE-E2 | Ligação em `ledgerForRoutes()`. A credencial da guarda é lida só pelo módulo do livro, como as chaves (`ledger/config.ts:26-27`). Sem credencial, o estado continua `NOT_CONFIGURED`, que **não passa no portão** (§10.1, G-1) | código |
| GE-E3 | Contrato R6-10 no modelo e no serviço: regras 1 a 4 da §5.1.4 | código |
| GE-E4 | Se Q1 = opção 1: migração versionada em `supabase/proposed/`, com conferência de privilégios no próprio SQL, como a `003` faz (`supabase/proposed/003_rls_hardening.sql:34-43`), e o rollback correspondente. O responsável a aplica em produção | código + ação do responsável |
| GE-E5 | Reconciliação externa: um CLI somente leitura (nome proposto `scripts/link-audit-guard-reconcile.ts`) que compara as cabeças da guarda com uma cópia de backup do livro e com o registro anterior da própria reconciliação. Usa uma **credencial só de leitura que não fica na VPS**. Saída `--json` estável, com divergência ⇒ código de saída ≠ 0 | código + rotina do responsável (Q2) |
| GE-E6 | Eventos de alarme: guarda indisponível, `MISMATCH`, atraso acima do limite e falha de publicação depois do fecho. Usam o envelope da spec de observabilidade (§9) | código |
| GE-E7 | Runbook da guarda: ativação, rotação da credencial, indisponibilidade, restauração com conferência da guarda e reconciliação | documentação |
| GE-E8 | Ensaio em homologação: rollback coordenado ⇒ `GUARD_MISMATCH`; restauração dos pares do mesmo instante ⇒ consistente; queda do provedor ⇒ falha fechada; falha de publicação depois de `CONFIRMED` ⇒ `BEHIND` + alarme + a próxima operação recusa | onda G2 |

#### 5.1.4 Regras do contrato da guarda real (fecham GE-R3 a GE-R6)

1. **Ativação antes da primeira inscrição.** Em produção, a guarda tem de estar operante antes do primeiro `ENROLL`. Uma
   auditoria inscrita sem guarda não tem cabeças publicadas, e publicar "a cabeça de hoje" para ela seria uma adoção (o
   histórico anterior valeria o que vale no instante da publicação, como o L4 da spec do livro §13). Isso exige o papel
   administrativo (§5.2). Consequência: nenhuma auditoria inscrita sem guarda entra no uso de produção.
2. **Primeira cabeça.** `head: null` é aceito só com o livro em `ledgerSeq ≤ 1`, que é o caso do `GENESIS` gravado com a
   publicação interrompida (`service.ts:972`). Com dois ou mais registros, `head: null` ⇒ `HISTORY_UNRESOLVED`, com uma
   razão nova (nome proposto `GUARD_HEAD_MISSING`).
3. **Atraso máximo.**
   - `L_max` é o maior número de registros que o protocolo grava entre duas publicações obrigatórias, contando as famílias
     de decisão e de resultado (`RUN_*`) e as receitas do `RECOVER`. É contado na G1 e travado em teste.
   - Atraso ≤ `L_max` ⇒ a vista mostra `BEHIND`, e o alarme dispara se o atraso durar mais que `T` (Q4).
   - Atraso > `L_max` ⇒ `HISTORY_UNRESOLVED` (nome proposto `GUARD_LAGGING`). Um fluxo legítimo não chega lá, porque
     toda operação nova publica antes de começar.
   - **Janela residual declarada:** a guarda detecta o retrocesso a qualquer ponto **anterior à última cabeça
     publicada**. Um retrocesso dentro da última operação ainda não publicada passa (no máximo `L_max` registros).
4. **Falha de publicação depois do fecho.** A operação já está durável no livro. A resposta é de **sucesso**, com
   `externalGuard: BEHIND` na vista e um evento de alarme. Responder falha levaria o cliente a reenviar uma decisão já
   confirmada. A próxima operação continua recusando enquanto não conseguir publicar (`service.ts:763`, `:893`, `:972`).
5. **Indisponibilidade.** Erro ou prazo esgotado no `latest` ⇒ `GUARD_UNAVAILABLE` ⇒ `HISTORY_UNRESOLVED`
   (`model.ts:489`). A falha é fechada **também nas leituras**: com o provedor fora do ar, nenhuma decisão aparece como
   vigente e nada é finalizável. O prazo de resposta e a política ficam para a Q3.
6. **"Esqueceu".** O servidor não guarda estado entre requisições, então não percebe sozinho uma guarda que regrediu. Ser
   append-only e monotônica torna essa regressão impossível sem comprometer o provedor. Quem detecta é a reconciliação
   externa (GE-E5), que compara com o próprio registro anterior.
7. **Inserção forjada.** Quem tem a credencial de escrita consegue inserir registros. Para que isso nunca esconda um
   retrocesso:
   - `latest` devolve o **maior** `ledgerSeq`;
   - toda inserção exige `ledgerSeq` maior que o maior já gravado para a auditoria.
   - Assim, inserir só **congela** a auditoria (DoS, a mesma classe do L6 da spec do livro §13).
8. **Formato do registro:** `{auditId, ledgerSeq, sha256}` mais a hora do provedor, que é só informativa (a ordem vale
   pelo `ledgerSeq`). O `auditId` vai em claro ou como HMAC com chave própria (Q5).

#### 5.1.5 Casos de borda

- **Auditoria nova:** o `GENESIS` publica; se a publicação falhar, o `ENROLL` responde `LEDGER_GUARD_UNAVAILABLE`
  (`service.ts:972`), o livro fica com 1 registro e `head: null`, que a regra 2 aceita. A próxima operação publica antes.
- **Corrida entre processos:** a publicação do mesmo par é idempotente; um par diferente na mesma posição falha
  (`guard.ts:13`). O provedor tem de garantir isso de forma atômica (restrição única `(auditId, ledgerSeq)`).
- **Resultados:** os registros `RUN_*` estão no mesmo livro, então a guarda cobre também a confirmação de resultados
  (ADR-0002) sem trabalho a mais.
- **Restauração de backup mais velho que a guarda:** a guarda fica à frente do livro restaurado ⇒ `GUARD_MISMATCH` e a
  auditoria congela. É o comportamento correto. Só que, sem o papel administrativo (§5.2), não existe `RESTORE_ACK`, e
  toda auditoria com atividade depois do backup fica congelada pela aplicação. **Consequência prática:** a frequência do
  backup do livro e dos recibos define quanto se perde (Q9).
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
| Imutabilidade | Por gatilho e privilégios do Postgres; quebrável por quem é dono do projeto | Por regra de proteção (histórico sem push forçado); quebrável pelo dono do repositório | Modo *compliance*: nem a conta raiz encurta a retenção (**a confirmar** por fornecedor) |
| Domínio de falha | Fora da VPS; mesmo projeto dos dados de prospecção | Fora da VPS; mesma conta do código, do CI e do deploy | Fora da VPS; conta separada |
| Credencial na VPS | Papel Postgres dedicado: só `INSERT` e `SELECT` na tabela | Token fine-grained: só `contents:write` nesse repositório | Chave só com `PutObject` (sem apagar, sem contornar a retenção) |
| Dependência nova | Cliente Postgres (`pg`) para conexão direta; revisão de cadeia de suprimento | Nenhuma (API REST) | SDK S3 ou assinatura manual |
| Disponibilidade | Toda leitura da Fase 6 depende do Supabase | Toda leitura depende da API do GitHub | Toda leitura depende do fornecedor |

**Opção (1): Supabase, desenho mínimo.** Tudo por migração versionada (GE-E4); nada no console.

- Tabela num **esquema dedicado, não exposto pela API REST** do Supabase, com dono `postgres`.
- Papel de login dedicado (nome proposto `gmn_guard_writer`) com `USAGE` no esquema e só `INSERT` e `SELECT` na tabela.
- Papel separado só de leitura para a reconciliação (`gmn_guard_reader`), cuja credencial **não** fica na VPS.
- `REVOKE ALL` de `PUBLIC`, `anon`, `authenticated` e `service_role` na tabela e no esquema. É necessário porque os
  privilégios padrão de `postgres` em `public` ainda concedem tudo à `service_role` e os de `supabase_admin` não foram
  alterados (`NOTES.md:140`). Num esquema novo, os padrões que se aplicam são **a confirmar** no laboratório.
- Gatilhos:
  - `BEFORE UPDATE OR DELETE` que recusa sempre;
  - `BEFORE TRUNCATE` de instrução que recusa sempre;
  - gatilho de inserção que exige `ledgerSeq` maior que o maior da auditoria, sob trava consultiva por auditoria, mais a
    restrição única `(audit_id, ledger_seq)`.
- Toda função criada sai sem `EXECUTE` para `PUBLIC`, porque o Postgres concede esse privilégio por padrão
  (`trigger_set_updated_at` está assim, `NOTES.md:140`).
- Conexão direta ou pelo *pooler*. Se a VPS tem IPv6 e se a conexão direta do plano exige IPv4 pago fica **a confirmar**.

*O que um atacante com a VPS consegue fazer, sendo honesto:*

- **Com a `service_role`:** nada na tabela, se o esquema não está exposto e os privilégios foram revogados. Se a migração
  esquecer o `REVOKE`, a `service_role` (que tem BYPASSRLS) ainda esbarra nos gatilhos, que valem com ou sem RLS. O
  `TRUNCATE` não é exposto pela API REST. A migração confere tudo isso com `has_table_privilege` e aborta se divergir.
  Os outros dados do projeto continuam expostos à `service_role` como hoje: está fora do escopo desta spec.
- **Com a credencial do `gmn_guard_writer`:**
  - insere registros, o que só serve para congelar auditorias (§5.1.4, regra 7);
  - lê as cabeças (`auditId` e frequência de atividade, ver Q5).
  - **Não** consegue alterar, apagar, desligar o gatilho nem mudar privilégios: isso exige ser dono da tabela.
- **Com controle do processo:** a ameaça comum acima.
- **O que não consegue:** restaurar o banco do Supabase a um ponto anterior. Isso exige o dono do projeto, pelo painel.

*Ameaças que sobram:*

- conta do Supabase comprometida (o dono apaga o gatilho e as linhas);
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

> **Recomendação do manager, a decidir pelo responsável (Q1):** opção **(1) Supabase** na primeira implantação, nas
> condições acima (esquema não exposto, `REVOKE` conferido no SQL, gatilhos, papel só `INSERT`/`SELECT`, leitura da
> reconciliação fora da VPS). Motivo: não há serviço novo nem custo, e o domínio de falha é separado da VPS. A opção
> **(3)** fica como reforço quando houver uso com clientes ou mais de um operador, se o responsável autorizar o custo. A
> opção **(2)** não é recomendada: depende de plano pago ou de repositório público e concentra poder na conta que já
> controla código, CI e deploy.

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

#### 5.2.5 Entregas (só se Q6 = 1 ou 2)

A opção escolhida ganha antes uma **emenda à spec do livro (§16.8)**, porque muda o formato do livro (registros `*_ACK` e
de pedido) e o contrato da API. As entregas, todas de código e testadas sem rede:

- fonte de identidade e atribuição do papel, separada de `GMN_OPERATOR_EMAILS`;
- pedido e aprovações com as identidades conferidas: o solicitante nunca aprova, e uma identidade só é recusada (critério
  A-L2 do modelo de ameaças do livro);
- verificação integral antes de gravar;
- registro com justificativa, fonte, cabeças e aprovadores;
- área de custódia para os arquivos afastados;
- interface.

Com Q6 = 3, a única entrega é documental: o aceite formal e o texto da tela, que já diz que a ação não existe.

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
| credencial da guarda | segredo | não existe (GE-E2) | Swarm secret; nome conforme o provedor (Q1) |

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
- **Em aberto:** o destino dos logs fora da VPS (Q8). Até lá, os logs ficam no `json-file` rotativo da VPS, sem retenção
  de 90 dias e sem cópia externa.

### 5.4 (d) D5: coleta ampliada (consequência; não especificada aqui)

- **Números conferidos no código:**
  - A régua soma **200 meios-pontos** (as 35 linhas de `src/lib/link-audit-scoring-runs/criteria-sources.ts:55-91`;
    conferido também em `onda6c-integracao-orquestracao.md` §21.2).
  - Com a coleta atual, o máximo avaliável é:
    - **22** meios-pontos automáticos;
    - **26** com o UTM comprovado (X5);
    - **34** com o juízo humano C2 (`criteria-sources.ts:11-12`, `:106-112`).
  - 34 em 200 dá **17 %**. Com o N/A de S4 o denominador cai para 196 e dá cerca de 17,3 %.
  - O mínimo para publicar é **40 %** (`src/lib/link-audit/scoring/ruler.ts:142`, portão `COVERAGE_MIN` em
    `scoring/publication.ts:17`; a constante de exibição está em `link-audit-scoring-runs/outcome.ts:11`).
  - O portão que falha leva a `INCONCLUSIVO` (`outcome.ts:29-31`).
- **Para o produto:** todo resultado real sai **INCONCLUSIVO**, sem índice Lumos, classificação nem pontos obtidos. A tela
  diz "Auditoria inconclusiva" (checklist §9). Isso vale também para o piloto e para a coleta nova da TUVAPLAST (W6). O
  primeiro resultado de produção seria um **registro técnico**, não uma nota para o cliente.
- **Mesmo com a D5:** sem custo de API (D5-0, parsers e site), o teto sobe a 27 %. Os 40 % exigem `/reviews`, de custo
  desconhecido e com decisão de LGPD pendente, ou o painel anexado pelo operador, que é upload de arquivos e nova
  superfície de segurança (`onda6c-integracao-orquestracao.md` §21.3, §21.6).
- **Decisão do responsável (Q10):** autorizar o planejamento da D5, no documento próprio, ou registrar o aceite formal de
  que a produção começa só com resultados INCONCLUSIVOS. A D5 continua **não autorizada**.

## 6. Critérios de aceite (cada um vira ao menos um teste com o identificador no nome)

**Guarda (G1.b):**

- [ ] **PG-G01** Com a guarda configurada, `head: null` e livro com ≥ 2 registros ⇒ `HISTORY_UNRESOLVED` (`GUARD_HEAD_MISSING`); com 1 registro ⇒ aceito.
- [ ] **PG-G02** Atraso > `L_max` ⇒ `HISTORY_UNRESOLVED` (`GUARD_LAGGING`); atraso ≤ `L_max` ⇒ `PROTECTED` com `externalGuard: BEHIND`. `L_max` é igual à contagem do protocolo, travada em teste.
- [ ] **PG-G03** A publicação falha depois de `CONFIRMED`, `ABORTED`, `RUN_CONFIRMED` ou `RUN_ABORTED` ⇒ resposta de sucesso, vista `BEHIND`, evento de alarme emitido; a próxima operação recusa com `LEDGER_GUARD_UNAVAILABLE` até publicar.
- [ ] **PG-G04** Rollback coordenado de decisões, recibos e livro (e de resultados) com a guarda real atrás da porta ⇒ `GUARD_MISMATCH`. O teste "LIMITE DECLARADO" continua valendo para a configuração **sem** guarda.
- [ ] **PG-G05** Inserção forjada com `ledgerSeq` maior ⇒ congela (`GUARD_MISMATCH`), nunca esconde retrocesso; inserção com `ledgerSeq` ≤ o maior ⇒ recusada pelo provedor (contrato do adaptador, com o provedor simulado sem rede).
- [ ] **PG-G06** `latest` com erro, resposta fora do esquema ou prazo esgotado ⇒ `GUARD_UNAVAILABLE` (nunca "nenhuma cabeça").
- [ ] **PG-G07** Sem credencial da guarda ⇒ `externalGuard: NOT_CONFIGURED`, e o verificador do portão (§10.1, G-1) acusa.
- [ ] **PG-G08** (opção 1) A migração aborta se `service_role`, `anon`, `authenticated` ou `PUBLIC` tiver qualquer privilégio na tabela, ou se `UPDATE`, `DELETE` ou `TRUNCATE` não forem recusados. É conferido no laboratório antes de produção.
- [ ] **PG-G09** A reconciliação acusa: cabeça da guarda ausente do backup; guarda que regrediu em relação ao registro anterior; backup à frente da guarda além de `L_max`. Saída `--json` estável; não escreve na guarda.

**Papel administrativo (G1.c, só se Q6 = 1 ou 2):**

- [ ] **PG-A01** Uma identidade só, ou o solicitante como aprovador, ⇒ recusado e nada gravado.
- [ ] **PG-A02** Sem fonte independente conferida ⇒ recusado.
- [ ] **PG-A03** O ACK grava justificativa, fonte, cabeças antes e depois e aprovadores; os arquivos afastados vão para a custódia com o hash citado e nunca são apagados.
- [ ] **PG-A04** (opção 2) Confirmação antes do fim da espera, assinatura de outro domínio ou chave diferente da fixada ⇒ recusado.

**Volumes e chaves (G1.a):**

- [ ] **PG-V01** `tests/deploy-config.test.ts`: sete pastas no web; evidências e manifestos só leitura; o Worker sem `GMN_LINK_AUDIT_*` nem bind novo; os nomes novos na lista do entrypoint; `stop-first` no web; nenhum valor literal.
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
| Chave de log (PG-L01) | **T-A01 / A-R1** e **D-R1** (rotas sem log; INDEX, risco nº 3) na parte de identificar o operador sem PII; T-D01 (revogação cruzada sem trilha fora das pastas) só quando o destino externo dos logs existir (Q8) |

**Ameaças novas trazidas por esta spec** (a superfície muda com a integração de um terceiro; o modelo STRIDE próprio é
entrega da G0, em `docs/security/threats/link-audit-portoes-producao.md`):

- **Credencial da guarda na VPS:** permite congelar auditorias por inserção (DoS) e ler cabeças. Mitigação: regra 7 da
  §5.1.4 e Q5.
- **Disponibilidade acoplada ao provedor da guarda** em toda leitura. Mitigação: prazo de resposta curto e falha fechada
  declarada (Q3).
- **Caminho administrativo:** é uma elevação de privilégio nova, se a opção for 1 ou 2. Mitigação: §5.2.4 e PG-A01–A04.
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

Os alertas dependem do destino dos logs (Q8). Até ele existir, valem a vista do livro na tela, que já mostra
`externalGuard`, e a reconciliação externa (GE-E5).

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
| G-1 | **Guarda operante**: provedor decidido (Q1); GE-E1–E7 na `main`; migração aplicada (opção 1); `externalGuard` = `CONSISTENT` em homologação; reconciliação rodando (Q2) | §5.1 | código + responsável (Q1, migração, credenciais) |
| G-2 | **Papel administrativo**: implementado (Q6 = 1 ou 2, PG-A01–A04) **ou** aceite formal de manter o 403 (Q6 = 3) | §5.2 | responsável (decisão) + código, se 1 ou 2 |
| G-3 | **Volumes e chaves**: VC-E1–E7 na `main`; secrets criados; pastas no host com dono e modo conferidos (VC-E8); backups independentes configurados (Q9) | §5.3 | código + responsável (secrets, host, destinos) |
| G-4 | **Chave de log** usada pelo código (PG-L01) e provisionada; destino dos logs decidido (Q8) ou aceite de que, por ora, ficam só na VPS | §5.3.4 | código + responsável |
| G-5 | **D5**: autorizada no documento próprio **ou** aceite formal de que todo resultado sai INCONCLUSIVO, comunicado à equipe (checklist §0 e §9) | §5.4 | responsável |
| G-6 | **Ensaio da G2 aprovado** (rollback coordenado, restauração, rollback de imagem com `stop-first`, queda do provedor, falha de publicação depois do fecho), com relatório | §5.1.3 GE-E8; checklist §10 itens 4–5 | código + responsável (homologação) |
| P-10 | **Demais itens do checklist de produção**: autorização escrita da implantação (§0); P-1 a P-4 decididos (§12); ensaio de queda de energia (R6-07, P-4); fatias de log da spec de observabilidade que o responsável exigir; revisão independente sem BLOCKER; plano de teste do §10 | `onda6c-checklist-producao.md` | código + responsável |
| P-11 | **Deploy pelo CI**, por decisão do responsável, com verificação pós-deploy e o primeiro teste de escrita só numa auditoria sintética combinada (checklist §10 item 6) | `CLAUDE.md` (deploy só por CI) | responsável |

O portão só abre com **todas** as linhas atendidas. A única exceção prevista é o piloto da §10.2, que é declarada e tem
prazo.

### 10.2 (f) Piloto mínimo: exceção declarada, não encerramento

Um piloto pode rodar **antes** de G-2 e G-5 estarem resolvidos no sentido forte (papel administrativo implementado e D5),
desde que **todas** as condições abaixo valham e fiquem escritas:

1. **Uma auditoria nova e vazia**, inscrita depois da guarda ativa. Nunca uma auditoria legada nem a pasta antiga da
   TUVAPLAST. A coleta da W6 entra numa auditoria nova.
2. **Guarda, volumes e chaves operantes:** G-1, G-3 e G-4 atendidos, e `externalGuard` = `CONSISTENT` na tela antes da
   primeira decisão.
3. **Ações administrativas continuam em 403** (Q6 = 3 durante o piloto).
4. **Aceite formal e escrito do responsável** cobrindo:
   - o congelamento sem recuperação pela aplicação: auditoria congelada é abandonada, a evidência é preservada e se abre
     uma nova;
   - todo resultado INCONCLUSIVO, sem nota ao cliente;
   - o prazo e o escopo do piloto.
5. **Os portões do P1 continuam obrigatórios** (P-1 a P-7): sem eles, a finalização segue `NOT_FINALIZABLE` e não há
   resultado.
6. **Deploy só pelo CI**, por decisão do responsável (P-11).

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

## 11. Questões abertas para o responsável

Cada questão traz a recomendação do manager. Nenhuma está decidida.

1. **Provedor da guarda.** Recomendação: **opção (1) Supabase**, com o desenho da §5.1.6. Opção (3) como reforço futuro,
   com custo autorizado. Opção (2) não.
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
    única pilha isolada, sem dados reais e sem Serper, usada pelos dois ensaios, com o laboratório Supabase descartável
    que o G5 já previa (`NOTES.md:140`).

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
- Ameaças: `docs/security/threats/INDEX.md`, `link-audit-ledger-e-resultados.md`, `link-audit-decisoes-e-recibos.md`,
  `link-audit-api-e-interface.md`; `docs/phase6-auditoria-link/onda6c-modelo-de-ameacas-recuperacao.md`.
- ADR a escrever na G0: escolha do provedor da guarda (`docs/adr/0003-…`).
