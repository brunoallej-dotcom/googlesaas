# Onda 6C — ESPECIFICAÇÃO do Livro de Cabeças independente (§1–§15: proposta; §16: contrato do incremento v1, implementado localmente SEM commit)

> **Status:** especificação para decisão do responsável (01/11/2026). O responsável aprovou a **direção** "livro de cabeças independente" para a 6B (ADR 6C-02 §4.6) e pediu **apenas a especificação**. Este documento **não altera** código, `stack.yml`, `Dockerfile`, `docker-entrypoint.sh`, o coletor, volumes de produção nem a VPS, e **não** acrescenta variáveis a `deploy/hostinger/.env.production.example`. Nenhum nome de variável, pasta ou formato abaixo existe ainda. Valores sempre `<placeholder>`; nenhum segredo.
>
> **O que ele resolve:** o **BLOQUEADOR PARA PRODUÇÃO "janela sem testemunha"** (`onda6c-checklist-producao.md` §12, ADR 6C-02 §4.5): hoje a testemunha do histórico de decisões são os resultados selados; uma revogação/substituição **sem resultado selado POSTERIOR** não tem testemunha: a janela abre nela e só fecha no próximo resultado selado; perdendo o recibo dela e movendo o arquivo (duas pastas) — mesmo com o resultado anterior intacto — a decisão revogada volta, e no extremo (todos os vestígios removidos) a auditoria fica igual a uma sem resultados. Reproduzido nos testes "LIMITE DECLARADO" (`link-audit-decisions-revocation-receipt`, `link-audit-decisions-witness-rotation`).
> **O que ele NÃO resolve** está em §13 (limitações sem solução segura). Nenhuma garantia abaixo vale contra quem controla o processo web em execução ou todos os volumes **e** a guarda externa.

## 1. Objetivo e princípio

**Princípio:** o histórico de decisões é verdadeiro **se e somente se** *duas fontes que não compartilham pasta* concordam, e a segunda fonte (o livro) é **escrita antes de qualquer resposta de sucesso** e **conferida antes de qualquer decisão ser tratada como vigente**. A perda de qualquer das duas, a divergência ou a impossibilidade de ler uma delas é **integridade NÃO resolvida** (`DECISIONS_HISTORY_UNRESOLVED`: nenhuma decisão vigente, nenhuma escrita, nada finalizável) — **nunca** "sem inconsistência".

Requisitos (todos do pedido do responsável): (R1) registrar cada cabeça confirmada e cada transição relevante; (R2) separado das pastas comprometíveis da 6B; (R3) autenticar a origem do histórico; (R4) detectar rollback e truncamento; (R5) tratar pendentes e revogações; (R6) recuperar após falha de disco/`SIGKILL`; (R7) impedir que exclusão/quarentena reative decisões antigas; (R8) volumes e permissões futuros; (R9) compatibilidade com histórico existente; (R10) um atacante com acesso a **uma única pasta** não falsifica nem apaga a garantia sem ser detectado.

## 2. Vocabulário

- **Cabeça (`head`)** = `{ auditId, seq, sha256 }` da última entrada **confirmada** da cadeia de decisões (o mesmo `head` que a 6B já calcula; `sha256` = `contentSha256` da entrada).
- **Transição relevante** = toda entrada de decisão (criação, revogação, substituição) **e** os eventos de recuperação (§6, §8). Marca `affectsPrior` quando revoga ou substitui outra decisão (a perda dela reativaria algo).
- **Livro (`ledger`)** = registro **append-only, encadeado e autenticado**, por auditoria, em armazenamento **próprio** (§4).
- **Intenção (`INTENT`)** = registro de que o servidor **vai** publicar a entrada `seq`/`sha256`; **Confirmação (`CONFIRMED`)** = o servidor publicou a entrada **e** o recibo.
- **Guarda externa** = cópia periódica da cabeça do livro em local **sem escrita a partir da VPS** (§9, fase 4).

## 3. Atacantes considerados (modelo de ameaça)

| # | Capacidade | Garantia buscada |
|---|---|---|
| A1 | Escreve **só** em `decisions/` | Não apaga/restaura/forja decisão sem divergir do livro |
| A2 | Escreve **só** em `anchors/` (recibos) | Remover um recibo é distinguível de gravação interrompida (§6) |
| A3 | Escreve **só** em `results/` ou `resanchors/` | Não consegue nem reativar decisão nem apagar o livro; pode **congelar** (DoS, falha fechada, declarado) |
| A4 | Escreve **só** no livro | Truncar/forjar o livro diverge das decisões e dos resultados |
| A5 | Operador bem-intencionado que move arquivos para "quarentena" | O sistema **não** é reativado; o ato legítimo é uma ação registrada (§8) |
| A6 | Obtém a **chave de origem** (HMAC) | Forja de eventos **desde** o comprometimento; detectável só com guarda externa (L3) |
| A2b | Escreve em **decisões + recibos** (as duas pastas da 6B, sem tocar o livro) | Forjar entrada **e** recibo encadeados é detectado: sem `INTENT` casando e sem a etiqueta `DECISION` válida o servidor **não** os "abençoa" no livro (§6) |
| A7 | Escreve em **duas ou mais** pastas **incluindo o livro** (decisões + livro, ou livro + resultados) | **Não coberto** sem guarda externa (L1) |
| A8 | Controla o processo web / root da VPS | **Fora de escopo** (L8) |

## 4. Onde vive (separação)

- **Pasta própria**, distinta das **seis** da 6B/6C (`decisions`, `anchors`, `results`, `resanchors`, `evidence`, `seals`), **sem sobreposição nem aninhamento** (mesma verificação léxica + `realpath` já usada em `evidenceProvenanceFromConfig` e em `createResultsKnownHeads`). Sobreposição ⇒ `NOT_CONFIGURED` (falha fechada).
- **Escritor único:** o processo **web** (serviços de decisões e de resultados, no mesmo processo, sob a trava por auditoria existente). Nenhum outro serviço (coletor, Worker, jobs) monta o volume em escrita. Cópias de segurança usam **instantâneo somente leitura**.
- **Módulo neutro** `link-audit-head-ledger` (regras puras: formato, encadeamento, avaliação) + adaptador de sistema de arquivos reutilizando as primitivas já testadas (`link()` exclusivo, `fsync` do arquivo e do diretório, recusa de FIFO/symlink/dispositivo, limites de tamanho). **A 6B não importa o módulo**: continua recebendo uma *fonte de cabeças* injetada (a interface `KnownHeadsProvider` de hoje é estendida, ver §10).

## 5. Formato do registro (proposto)

`ledger/<auditId>/lNNNNNN.json`, imutável depois de publicado (modo `0444`), canônico (`canonicalJson`), tamanho máximo fixo (≈ 4 KiB), `schemaVersion: 1`, `kind: "link-audit-head-ledger"`.

```
{ schemaVersion, kind, auditId,
  ledgerSeq,                // 1, 2, 3… contíguo
  prevSha256,               // contentSha256 do registro anterior (null no primeiro)
  event,                    // INTENT | CONFIRMED | ABORTED | QUARANTINE_ACK | RESTORE_ACK | CHECKPOINT | ADOPTED
  decisions: { seq, sha256, affectsPrior },   // a cabeça a que o evento se refere
  subject: { action, decisionId?, revokes?, supersedes? },  // QUEM a entrada afeta (ids públicos): sem isso, depois que a entrada sai da cadeia nada identificaria o alvo EM DÚVIDA (§8)
  results:   { ledgerRef?: …  },               // só em CHECKPOINT/ADOPTED (§9, §11)
  recordedAt,               // relógio do SERVIDOR (ISO UTC)
  origin: { v, kid, tag },  // HMAC-SHA-256 com domínio "LEDGER" (§7)
  contentSha256 }
```

- **Por que um registro por evento:** `link()` exclusivo + sequência contígua + encadeamento dão detecção de lacuna, duplicata e reordenação sem arquivo mutável.
- **Cabeça do livro** = `{ ledgerSeq, contentSha256 }` do último registro. Os **resultados selados** passam a gravar a cabeça do livro vigente no momento da finalização (campo opcional `ledgerHead`, **só em resultados novos**; ver §11): o livro é, por sua vez, **testemunhado** por outra pasta.

## 6. Protocolo de escrita (ordem, e por que ela resolve a ambiguidade do recibo)

Para cada escrita de decisão (criar, revogar, substituir), **sob a trava por auditoria**:

1. Conferir a integridade (decisões × recibos × livro × resultados) — se `NÃO resolvida`, recusar (`DECISIONS_HISTORY_UNRESOLVED`).
2. **`INTENT`** no livro: `seq`/`sha256` da entrada **que vai** ser publicada. Se falhar ⇒ recusar, **nada** foi gravado.
3. Publicar a entrada de decisão (`link()` exclusivo) — comportamento atual da 6B.
4. Gravar o **recibo** (pasta `anchors/`) — comportamento atual.
5. **`CONFIRMED`** no livro. **Só então** responder sucesso.

**Consequência central (fecha MINOR-2):** "recibo removido" e "gravação interrompida" **deixam de ser iguais** no disco:

| Estado observado | Interpretação | Tratamento |
|---|---|---|
| Entrada **sem recibo** e livro só com `INTENT` | gravação **interrompida** antes do recibo | pendente legítima: o **autor** conclui (reenvio idêntico) ⇒ escreve recibo e `CONFIRMED`; ou `ABORTED` (§8) se a entrada nunca chegou a ser publicada |
| Entrada **sem recibo** e livro com `CONFIRMED` | **recibo removido** (a gravação havia terminado) | **incidente**: `NÃO resolvido`; o autor recria o recibo do **mesmo conteúdo** (recuperação legítima); a quarentena **não** apaga o `CONFIRMED` ⇒ a posição continua exigida |
| Recibo e entrada presentes, livro **sem** `CONFIRMED` (queda entre 4 e 5) | livro **atrasado de um** | recuperação: o próximo acesso de escrita, sob a trava, acrescenta o `CONFIRMED` faltante **somente se** (i) existe no livro um `INTENT` com o **mesmo** `seq`/`sha256`, (ii) a entrada traz etiqueta `DECISION` **verificável com a chave em vigor** e (iii) entrada, recibo e encadeamento conferem. Qualquer condição ausente (inclusive entrada assinada por chave aposentada vencida ou revogada, que não é mais verificável) ⇒ **não recupera**: `NÃO resolvido` até conciliação humana com a fonte independente. Leitura apenas informa `LEDGER_BEHIND`. **Enquanto não recuperado, o ALVO de uma revogação/substituição publicada sem `CONFIRMED` fica EM DÚVIDA (`AMBIGUOUS`, fora do motor), exatamente como a pendente de hoje — nunca vigente.** "Não vigente" jamais significa "a revogação não vale": uma falha de escrita do livro não pode reativar a decisão a cada leitura |
| Livro com `CONFIRMED` além do que as decisões têm | **truncamento/quarentena** | `HISTORY_REGRESSED` ⇒ `NÃO resolvido` |
| Livro com registro diferente na mesma posição | **divergência** | `HISTORY_DIVERGES` |

### 6.1 Premissas do protocolo (declaradas)
- **Uma única réplica do web (`replicas: 1`) e trava por auditoria em processo** (a mesma premissa do checklist §7). Com mais de uma réplica, `INTENT`/`CONFIRMED` de processos diferentes podem se intercalar e produzir falso `LEDGER_BEHIND`; suportar réplicas exigiria trava entre processos (fora desta proposta).
- **Leitura do livro e das cabeças fora da trava de escrita:** na **escrita**, o livro e as cabeças são lidos **dentro** da trava da auditoria (evita a janela hoje registrada como INFO: escrita com cabeças desatualizadas); nas **consultas** (GET) a leitura é sem trava e pode, durante uma escrita concorrente, ver o livro um registro à frente ou atrás — o estado transitório correto é `LEDGER_BEHIND`/releitura, **nunca** `HISTORY_REGRESSED` por uma única leitura: a consulta repete a leitura uma vez antes de concluir regressão (mesma técnica da leitura dupla já usada na 6B).

## 7. Autenticar a origem do histórico

- Cada registro leva `origin` = HMAC-SHA-256 com **domínio `LEDGER`** (separado de `DECISION` e `RUN`), derivado por HKDF da **chave de origem** já existente (`GMN_LINK_AUDIT_ORIGIN_KEY`; mesmo formato `<id>:<64 hex>`, mesmo `kid` público). **Nenhum segredo novo é criado** (decisão a confirmar, §14-Q3).
- **Mesma regra de chaves da 6C:** atual assina/verifica; aposentada só verifica (teto de 93 dias); revogada ⇒ `KEY_REVOKED`; **reassinar não torna confiável** nenhum registro.
- **Problema honesto — vida útil da verificação:** um registro assinado por uma chave que já passou da janela de aposentadoria (93 dias) não pode mais ter a etiqueta verificada. A proposta usa **pontos de verificação (`CHECKPOINT`)** gravados **periodicamente** (a cada N eventos e pelo menos diariamente, **não só na rotação**), cada um sob a chave **vigente** e declarando a cabeça do livro já verificada; o histórico anterior a um checkpoint é confiável **por encadeamento + checkpoint**, e só o trecho **posterior** ao último precisa de etiqueta verificável. **Precondição da rotação planejada:** só retirar a chave antiga depois de existir um `CHECKPOINT` recente sob a chave nova para **todas** as auditorias (o runbook ganha esse passo); perder a janela de 93 dias sem checkpoint deixaria a cauda do livro **não verificável para todas as auditorias** ⇒ `NÃO resolvido`. Na **rotação por comprometimento**, os registros posteriores ao comprometimento **não são confiáveis** (L3): sem guarda externa **não há procedimento automático** — o livro fica `UNTRUSTED` (congelamento) até uma **re-adoção explícita a partir de backup independente**, comparando as cabeças com o último relatório confiável; a re-adoção às cegas é exatamente o risco L4 e deve ser decisão humana registrada.
- A chave de origem **autentica que o servidor escreveu**; **não** prova que o conteúdo da decisão é verdadeiro.

## 8. Pendentes, revogações, quarentena e recuperação como **ações registradas**

Mover arquivos à mão deixa de ser um procedimento: continua possível no disco, mas **não reativa nada** (R7). O que era feito por "quarentena manual" vira ação do sistema:

- **`ABORTED`**: o autor (ou um administrador) declara que uma `INTENT` **sem** entrada publicada nunca será concluída. O servidor confere que **nem a entrada nem o recibo existem** e que o livro só tem a `INTENT` (não há `CONFIRMED`); só então grava `ABORTED`. Não distingue "nunca publicada" de "removida" por si: por isso a condição é **entrada ausente E recibo ausente E nenhum `CONFIRMED`**.
- **`QUARANTINE_ACK`**: para uma entrada **publicada, nunca confirmada** (só `INTENT`, **sem recibo**), cuja origem **não é comprovável**: registro **explícito** com motivo e operador autenticado, **dupla aprovação** (Q5) e **sem efeito de reativação**: se a entrada era uma revogação/substituição, o alvo **continua EM DÚVIDA** até uma **nova decisão humana explícita** (nova revogação ou nova decisão) ser gravada; o `QUARANTINE_ACK` **nunca** devolve silenciosamente o alvo a `ACTIVE`. **Não** pode ser aplicado a entrada com `CONFIRMED`.
- **`RESTORE_ACK`**: depois de restaurar, **fora do sistema**, um par decisões+recibos de um backup independente, o responsável registra o evento (motivo, referência do backup, cabeça restaurada) — passo humano, de **dupla assinatura de procedimento** (§14-Q5). Sem ele a divergência continua `NÃO resolvida`.
- **Revogação/substituição:** o `CONFIRMED` carrega `affectsPrior`. Depois da adoção (§11) **toda** revogação confirmada tem testemunha **no momento da confirmação**; o contador `unwitnessedAffecting` da interface passa a ser **0** por construção (a nota "sem testemunha para N revogações" some só nesse caso).
- **Chave comprometida:** nenhuma ação acima pode ser **autorizada** por uma etiqueta de chave revogada; `QUARANTINE_ACK` de uma pendência assinada por chave comprometida exige a conciliação externa do §7.

## 9. Detecção de rollback e de truncamento

Camadas, da mais barata à mais forte (cada uma **falha fechada**):

1. **Encadeamento + sequência contígua** no livro: lacuna, duplicata, reordenação ⇒ `UNTRUSTED`.
2. **Cruzamento livro × decisões**: a cabeça `CONFIRMED` do livro tem de existir na cadeia de decisões com o mesmo `sha256` (±1 durante a recuperação do §6). Falta ⇒ `HISTORY_REGRESSED`; hash diferente ⇒ `HISTORY_DIVERGES`.
3. **Cruzamento livro × resultados**: cada resultado novo grava `ledgerHead`; o livro tem de conter essa posição com o mesmo hash (**truncar o livro contradiz uma pasta que o atacante A4 não controla**).
4. **Cruzamento resultados × decisões** (já existe: `decisions.head` de cada resultado).
5. **Guarda externa (fase 4, requer decisão e infraestrutura fora da VPS):** resumo periódico `{auditId, ledgerSeq, contentSha256}` assinado e enviado a um destino **sem escrita a partir da VPS** (e-mail do responsável, objeto com retenção, cofre). É o **único** mecanismo que detecta o *rollback consistente de todos os volumes* e a escrita em **duas ou mais** pastas (A7). Sem ela, L1 e L2 permanecem **declarados**.

## 10. Integração (sem mudar o formato da 6B)

- `KnownHeadsProvider` é estendido para devolver, além de `heads`/`unverifiedHeads`, o **estado do livro** (`ledger: { status: ABSENT | OK | BEHIND | UNTRUSTED | UNAVAILABLE, confirmedHead, pendingIntent }`). O módulo `witness.ts` continua **neutro** e ganha os estados `LEDGER_ABSENT` e `LEDGER_BEHIND` (ambos `NÃO resolvidos`, exceto `ABSENT` durante o modo de transição da fase 2).
- A 6B **não** muda o formato das suas entradas; `INTENT`/`CONFIRMED` ficam na **camada de serviço** (mesmo ponto de `appendEntry`), logo `protocol-conformance-v2.json` e as referências não mudam por causa do livro.
- As rotas de decisões e de prévia montam o provedor do livro como hoje montam o dos resultados; **sem a pasta do livro configurada ⇒ `NOT_CONFIGURED`** (falha fechada), exatamente como as pastas de resultados.
- Os resultados novos acrescentam `ledgerHead` (campo opcional; resultados antigos continuam válidos; `results-types` ganha versão **minor** compatível — a decidir, §14-Q4).

## 11. Compatibilidade com o histórico existente (adoção)

- **`LEDGER_ABSENT` tem dois significados que NÃO podem se confundir:** (i) auditoria **nova**, sem nenhuma entrada de decisão nem resultado ⇒ **permitido** (o livro nasce com o primeiro `INTENT`); (ii) auditoria com **histórico não vazio** (decisões ou resultados) e **sem** registros no livro, ou pasta/volume do livro apagado ou vazio ⇒ **bloqueia** (`NÃO resolvido`) — e uma adoção posterior a um volume perdido **compara** com fonte independente (backup/relatório), nunca adota às cegas.
- **Auditoria sem livro (histórico anterior à ativação):** estado `LEDGER_ABSENT` no sentido (ii) na fase 3. Na **fase 2 (observação)** o livro é escrito mas **não bloqueia**; vale a testemunha atual (resultados) com o limite declarado. Na **fase 3 (obrigatório)** `LEDGER_ABSENT` passa a **falhar fechado**, e a auditoria só volta a operar depois da **adoção**.
- **Adoção (`ADOPTED`)**, por auditoria, ato **explícito** do responsável: o servidor verifica a cadeia de decisões (regras atuais), a cadeia de resultados e as cabeças, e grava `ADOPTED` com `{decisions head, results heads}` sob a chave vigente. **Limite declarado (L4):** o histórico **anterior** à adoção é tão confiável quanto era **no instante dela**; a adoção de um histórico **já adulterado** o legitima. Mitigação: antes de ativar, o responsável confere as cabeças atuais contra **backup/relatório independente** (o relatório do dossiê de produção) e registra a referência.
- **Nada é migrado ou reescrito:** arquivos de decisão, recibos e resultados existentes permanecem **byte a byte** como estão.

## 12. Volumes, permissões e requisitos (futuros — nada disto foi aplicado)

| Item | Proposta |
|---|---|
| Volume | **novo**, dedicado ao livro (nome e caminho a definir pelo responsável da implantação) |
| Escrita | **somente** o contêiner `web`; **nenhum** outro serviço o monta; coletor, Worker e jobs sem acesso |
| Permissões | diretório `0700` e dono = usuário do processo web; registros publicados `0444` |
| Backup | instantâneo **somente leitura**, **com o mesmo instante** dos volumes de decisões, recibos, resultados e recibos de resultados (pares de mesmo instante) |
| Sistema de arquivos | **local ext4/xfs** (mesmo requisito de P-4): sem NFS/SMB/overlay não validado; `fsync` do arquivo **e** do diretório tratados como falha de durabilidade quando falham |
| Variável | **uma** nova, com caminho absoluto (nome a decidir, §14-Q2); ausente/relativa/sobreposta ⇒ `NOT_CONFIGURED` |
| Tamanho | ≈ 2 registros por decisão + 1 por resultado; limite por auditoria e total (fail closed ao atingir) |
| Monitoramento | alerta em `LEDGER_BEHIND`, `UNTRUSTED`, `UNAVAILABLE`, `HISTORY_*` e na idade do último resumo externo |

## 13. O que o livro NÃO resolve (limitações **sem solução segura** declaradas)

- **L1 — Escrita em duas ou mais pastas** (decisões **e** livro **e** resultados): sem guarda externa não é detectada.
- **L2 — Rollback consistente de todos os volumes** a um instante anterior (restauração de um instantâneo completo): indistinguível de uma restauração legítima; só a guarda externa detecta, e só quanto à idade da última cabeça enviada.
- **L3 — Chave de origem comprometida:** quem a tem e escreve no livro forja eventos **a partir** do comprometimento. O sistema recusa (`KEY_REVOKED`) o que vier depois da revogação, mas o trecho entre o comprometimento e a revogação só se concilia com fonte externa. **Os `CHECKPOINT` periódicos gravados sob a chave vigente nesse intervalo também são suspeitos** (tornam irreversível a confiança em registros forjados antes da revogação): a **re-adoção descarta todos os checkpoints posteriores à data suspeita** e recomeça a confiança do último ponto confirmado por fonte independente.
- **L4 — Histórico anterior à adoção:** tão confiável quanto na adoção (§11).
- **L5 — Durabilidade (P-4):** queda de energia pode produzir falso `TRUNCATED`/`LEDGER_BEHIND` (falha **fechada**); o requisito de FS e o ensaio de queda continuam necessários.
- **L6 — Disponibilidade:** quem escreve **só** em uma pasta consegue **congelar** a auditoria (falha fechada intencional); a recuperação exige o procedimento humano do §8.
- **L7 — Tempo:** `recordedAt` é o relógio do servidor; não prova quando algo aconteceu.
- **L8 — Processo web comprometido / root da VPS:** fora de escopo.
- **L9 — Verdade do conteúdo:** o livro prova que o **servidor** confirmou uma decisão, não que o juízo humano esteja correto.

## 14. Decisões abertas ao responsável

Q1. Aprova o **modo de transição** (fase 2 observando, fase 3 obrigatório) ou prefere obrigatório desde a primeira implantação em produção?
Q2. Nome e local do novo volume/variável (a decidir junto com a revisão de `stack.yml`, **sem alterá-lo agora**).
Q3. O livro usa a **mesma chave de origem** (sem segredo novo, mas a mesma superfície de comprometimento) ou uma **chave própria**?
Q4. Aceita o campo opcional `ledgerHead` nos resultados novos (mudança **minor** em `results-types`)?
Q5. Quem pode registrar `RESTORE_ACK`/`QUARANTINE_ACK` (um administrador? dupla aprovação)?
Q6. Há destino para a **guarda externa** (§9.5) e quem é o responsável pela conferência periódica?
Q7. Para as auditorias **já existentes** (TUVAPLAST etc.): adoção imediata ou apenas as novas?

## 15. Plano de entrega e aceite (quando aprovado — nada disto foi feito)

1. **E0 — esta especificação** e as respostas do §14.
2. **E1 — módulo puro** `link-audit-head-ledger` + testes (formato, encadeamento, avaliação, chaves/`CHECKPOINT`, atacantes A1–A5), **sem** integrar.
3. **E2 — integração em modo observação** (escreve `INTENT`/`CONFIRMED`; não bloqueia): varredura de `SIGKILL` em **cada** etapa do §6, falha de disco (`ENOSPC`, `EIO`, `EROFS`) em cada etapa, concorrência (processos em corrida), recuperação do atraso de um.
4. **E3 — obrigatório:** `LEDGER_ABSENT`/`BEHIND` falham fechado; testes: **os testes "LIMITE DECLARADO" passam a exigir o oposto** (a decisão revogada **não** volta nem com todos os vestígios removidos) e são reescritos.
5. **E4 — guarda externa** (depende do §14-Q6).
6. Revisão independente **focalizada** antes de cada etapa; nenhuma etapa declara a 6C encerrada.

---

# §16 — CONTRATO DO INCREMENTO v1 DO LIVRO DE CABEÇAS (decisões Q1–Q7 de 01/11/2026; IMPLEMENTADO localmente, SEM commit)

> **Precedência.** Este §16 é **normativo** e **prevalece** sobre os §1–§15 onde houver diferença (os §1–§15 permanecem como histórico do desenho). Cada divergência está listada em §16.1; nenhuma contradiz o princípio do §1.
> **O que continua valendo sem mudança:** princípio do §1, atacantes do §3, separação do §4, ordem de durabilidade do §6 (`INTENT → entrada + recibo → CONFIRMED → sucesso`), detecção do §9 (1–4), limitações do §13, **a dependência das pastas de resultados e recibos** (INFO-1/Etapa 5: sem elas nenhuma decisão nova é gravada — **não enfraquecida**).

## 16.1 Confronto das decisões com o contrato anterior

| # | Decisão do responsável | Contrato anterior (§) | Resolução |
|---|---|---|---|
| Q1 | Transição **explícita por auditoria**, estados `LEGACY_READ_ONLY`, `ENROLLMENT_PENDING`, `PROTECTED`, `HISTORY_UNRESOLVED`; nunca inicializar cabeça vazia quando histórico some; sem migração/autenticação retroativa; não adotadas não fazem operações que dependam da proteção | §11 (livro nasce com o 1º `INTENT`; fases 2 observação/3 obrigatório), §14-Q1, §15 E2/E3 | **Substitui.** Não há modo de observação; o livro só escreve para auditoria **inscrita**. Auditoria nova também exige inscrição explícita |
| Q2 | Volume `gmn-link-audit-ledger`; variável `GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR`; separado de decisões, recibos e resultados; backup próprio; sem alterar Swarm/VPS | §12 (nome a decidir) | Fecha o §14-Q2. Nenhum arquivo de implantação alterado |
| Q3 | Chave HMAC **exclusiva** do livro, separada da chave de origem; entropia, comprimento, id, domínio, rotação; chave comprometida não autentica novas operações | §7 (derivada da chave de origem, "sem segredo novo") | **Substitui o §7.** Variáveis `GMN_LINK_AUDIT_LEDGER_KEY`, `…_RETIRED_KEYS`, `…_REVOKED_KEY_IDS`; HKDF com rótulo/salt **próprios** (`ledger`); a configuração é **recusada** se id ou material coincidirem com os da chave de origem. Injeção por arquivo (`*_FILE`) é do entrypoint (lista fixa), **não alterado** |
| Q4 | `ledgerHead` nos resultados novos, formato versionado, leitura dos antigos preservada, hashes históricos intactos | §10, §14-Q4 | Aprovado: `schemaVersion` 2 **só** em resultados novos com `ledgerHead`; v1 continua legível e inalterado |
| Q5 | `RESTORE_ACK` nunca automático nem por API comum; operação administrativa (identidade verificável, justificativa, dupla aprovação, auditoria); sem infraestrutura de privilégio ⇒ **bloquear e especificar**; restauração não apaga evidência | §8 (`RESTORE_ACK`, `QUARANTINE_ACK` "dupla aprovação") | **Não existe papel administrativo** no sistema (só `GMN_OPERATOR_EMAILS`). Logo `RESTORE_ACK`, `QUARANTINE_ACK` e a **adoção de histórico não vazio** (mesma natureza: conceder confiança) ficam **bloqueados** (`ADMIN_APPROVAL_UNAVAILABLE`), com procedimento em §16.8. **Interpretação CONFIRMADA pelo responsável em 03/11/2026:** a regra mais restritiva do Q5 vale para a adoção de histórico não vazio, para o `QUARANTINE_ACK` e para o `RESTORE_ACK` (autorização administrativa explícita, auditável e com dupla aprovação); enquanto o mecanismo completo não existir as três permanecem indisponíveis. A **inscrição de auditoria comprovadamente vazia** continua pelo fluxo implementado, desde que a ausência de histórico seja realmente verificável (§16.2) |
| Q6 | Testemunha imutável em domínio de falha separado da VPS como **requisito de produção**; só adaptador sintético local; sem provedor externo; não afirmar proteção contra rollback coordenado sem ela | §9.5 (fase 4 opcional) | Eleva a **requisito de produção** (checklist: bloqueador). Porta `ExternalGuardPort` + adaptador sintético; sem guarda configurada o estado diz `NOT_CONFIGURED` e a tela **não** afirma proteção contra rollback coordenado |
| Q7 | Adoção por auditoria com verificação integral + procedimento explícito de confiança; legado sem garantia retroativa; incertas consultáveis em modo restrito; TUVAPLAST intocada | §11 | Auditoria **vazia**: inscrição por operador (verificável). Auditoria **com histórico**: `LEGACY_READ_ONLY` (consulta restrita, integridade NÃO resolvida) até a adoção administrativa (bloqueada, §16.8) |
| — | Concorrência **entre processos**, não só mutex em memória | §6.1 (premissa `replicas: 1`, trava em processo) | **Estende:** a exclusão mútua vem do `link()` exclusivo do `INTENT` no livro (um vencedor por posição) e do `link()` exclusivo da entrada; o mutex em memória é só otimização. Premissa de réplica única **removida** (§16.5) |
| — | Registrar auditId, seq da decisão, cabeça anterior/nova, identidade, id da operação, estado, recibos, autenticação | §5 (formato) | **Estende** o formato (§16.3) |

## 16.2 Estados por auditoria (`ledger.state`)

| Estado | Quando | Efeito |
|---|---|---|
| `ENROLLMENT_PENDING` | Livro **configurado e legível**, auditoria **sem registros no livro** **e** sem nenhum histórico (nenhuma decisão, recibo, resultado nem recibo de resultado; guarda externa, se houver, sem registro dela) | Consulta normal (vazia). Nenhuma decisão até a **inscrição explícita** (`ENROLL`, operador) |
| `LEGACY_READ_ONLY` | Sem registros no livro **e** com histórico (decisões ou resultados) **sem** evidência de que já foi protegida | **Modo restrito**: consultável; integridade **NÃO resolvida** (nenhuma decisão vigente, motor sem decisões, nada finalizável, nenhuma escrita). Sai por **adoção administrativa** (bloqueada) |
| `PROTECTED` | Livro íntegro, autenticado, sem lacuna, consistente com decisões e recibos, e (se houver) com os resultados (`ledgerHead`) e a guarda externa | Operação normal. Operação aberta (`openOperation`) é informada; `finalizable=false` enquanto houver |
| `HISTORY_UNRESOLVED` | Qualquer inconsistência, indisponibilidade ou desconfiança: livro **não configurado**/ilegível/não confiável (cadeia, etiqueta, chave vencida/revogada), **livro removido** com testemunha (resultado com `ledgerHead` ou guarda), retrocesso, divergência, entrada ou pendente **sem `INTENT`** (fora do livro), entrada publicada **depois de `ABORTED`**, `ledgerHead` de resultado incompatível, guarda divergente | **Falha fechada** (como `DECISIONS_HISTORY_UNRESOLVED`): nenhuma decisão vigente, nenhuma escrita, nada finalizável. A razão vem em `ledger.reason` |

**Razões de `HISTORY_UNRESOLVED`** (`ledger.reason`; texto fixo na tela, nunca eco de dado): `NOT_CONFIGURED`, `UNAVAILABLE`, `UNTRUSTED`, `KEY_REVOKED`, `KEY_EXPIRED`, `KEY_UNKNOWN`, `LIMIT_REACHED`, `LEDGER_REMOVED_WITNESSED`, `HISTORY_REGRESSED`, `HISTORY_DIVERGES`, `RECEIPT_REMOVED`, `UNLEDGERED_ENTRY`, `UNLEDGERED_PENDING`, `PUBLISHED_AFTER_ABORT`, `LEDGER_BEHIND` (recuperável **se** a origem da decisão for comprovada), `BEHIND_UNVERIFIABLE`, `RESULT_LEDGER_MISMATCH`, `RESULTS_EVIDENCE_UNAVAILABLE`, `GUARD_MISMATCH`, `GUARD_UNAVAILABLE`. `LEDGER_ABSENT_WITH_HISTORY` é a razão informativa de `LEGACY_READ_ONLY`. `externalGuard`: `NOT_CONFIGURED` \| `CONSISTENT` \| `BEHIND` \| `MISMATCH` \| `UNAVAILABLE`.

**Vacuidade verificável (Q5, 03/11/2026).** `ENROLLMENT_PENDING` e a inscrição só existem quando a ausência de histórico é POSITIVAMENTE verificada: pasta de decisões e de recibos da auditoria ausentes ou legíveis e vazias (um recibo órfão é histórico), nenhum resultado nem resultado pendente (a testemunha dos resultados precisa estar configurada e legível), nenhum registro da guarda externa e a pasta do livro ausente ou sem nome que pareça registro. Qualquer fonte ilegível, indeterminável (`EACCES`/`EIO` ao estabelecer a existência de uma pasta), não configurada ou não confiável ⇒ NÃO há inscrição (`RESULTS_EVIDENCE_UNAVAILABLE`, `UNAVAILABLE`, `NOT_CONFIGURED`, `UNTRUSTED`) e nenhum `GENESIS` é gravado. Travado em `link-audit-ledger-q5`.

Regra de ouro (Q1): **ausência do livro nunca vira "cabeça vazia"**. Livro ausente com histórico ⇒ `LEGACY_READ_ONLY`; ausente **e** com testemunha de que já existiu ⇒ `HISTORY_UNRESOLVED`.

## 16.3 Formato do registro (v1)

`<LEDGER_DIR>/<auditId>/lNNNNNN.json` (6 dígitos), imutável (`0444`), publicado por `link()` exclusivo, JSON canônico, ≤ 4 KiB (`MAX_LEDGER_RECORD_BYTES`), limite de **4000** registros por auditoria (`MAX_LEDGER_RECORDS`; ao atingi-lo as escritas falham fechado com `LIMIT_REACHED`).
```
{ schemaVersion:1, kind:'link-audit-decisions-ledger', auditId, ledgerSeq, prevSha256|null,
  event: 'GENESIS' | 'INTENT' | 'CONFIRMED' | 'ABORTED' | 'RECEIPT_REISSUED' | 'CHECKPOINT',
  recordedAt (relógio do servidor, ISO ms), actor (operador autenticado ou 'system'),
  op?: {                      // INTENT | CONFIRMED | ABORTED | RECEIPT_REISSUED
    opId (128 bits hex), decisionSeq, prevDecisionsHead:{seq,sha256}|null, newDecisionsHead:{seq,sha256},
    action:'RECORD'|'REVOKE', author, decisionId?|revokes?, supersedes?, affectsPrior,
    intentSeq? (CONFIRMED/ABORTED/RECEIPT_REISSUED), anchorRef?:{name,headSha256} (CONFIRMED/RECEIPT_REISSUED), observed? (ABORTED) },
  genesis?: { mode:'EMPTY' },        // 'ADOPTED' reservado e bloqueado
  checkpoint?: { throughSeq, throughSha256 },
  origin:{v:1,kid,tag},       // HMAC-SHA-256, domínio "LEDGER", chave EXCLUSIVA do livro
  contentSha256 }
```
- **Cabeça do livro** = `{ledgerSeq, sha256}` do último registro. **Cabeça das decisões confirmadas pelo livro** = `newDecisionsHead` do último `CONFIRMED`.
- **`RECEIPT_REISSUED`** (autor da decisão): registra, **antes** de o recibo ser gravado de novo, que o recibo de uma entrada **já confirmada** foi removido e vai ser reemitido com o MESMO conteúdo (`anchorRef` igual ao do `CONFIRMED`). É a única forma de o estado `RECEIPT_REMOVED` (`receiptReissuable`) voltar a `PROTECTED`; não concede confiança nova e não toca a cabeça das decisões.
- Invariantes da cadeia: `GENESIS` primeiro e único; `ledgerSeq` contíguo e `prevSha256` encadeado; **no máximo uma operação aberta** (`INTENT` sem `CONFIRMED`/`ABORTED`); `INTENT.decisionSeq = confirmadas + 1` e `prevDecisionsHead` = cabeça do último `CONFIRMED`; `CONFIRMED`/`ABORTED` repetem os campos do `INTENT` que fecham.

## 16.4 Protocolo de escrita e recuperação (por operação de decisão, dentro de `appendEntry`)

0. **Leitura em ordem:** o livro é lido **antes** das decisões e dos recibos (uma escrita concorrente só pode deixar as decisões à frente do livro, nunca atrás de um `CONFIRMED` já lido).
1. **`prepare`:** avalia a proteção (§16.2). Não `PROTECTED` ⇒ recusa (nada gravado). Operação aberta:
   - **fase A** — entrada ausente e recibo ausente: se a idade < limite (padrão 120 s) ⇒ **espera limitada** e depois `LEDGER_OPERATION_IN_PROGRESS`; se vencida ⇒ `ABORTED` com o observado (única recuperação automática, só quando **verificável**);
   - **fase B** — entrada presente igual ao `INTENT` e sem recibo: é a pendente de sempre (o **autor** conclui; os demais recebem `PENDING_UNCONFIRMED`);
   - **fase C** — entrada e recibo presentes, `CONFIRMED` ausente: conclui-se o `CONFIRMED` **somente se** o `INTENT` casa (seq/hash/prev), a etiqueta de **origem da decisão** está `PROVEN`, entrada, recibo e encadeamento conferem **e quem escreve é o AUTOR da entrada** (e-mail da sessão == `op.author`; §16.16); senão `HISTORY_UNRESOLVED` (casamento/origem) ou `PENDING_UNCONFIRMED` (não é o autor).
2. **`INTENT`** (`link()` exclusivo da posição). `EEXIST` ⇒ outro processo venceu: relê e reavalia. Falha ⇒ recusa, **nada** foi publicado.
3. Publicar a entrada (`link()` exclusivo) e 4. gravar o **recibo** — comportamento da 6B.
5. **`CONFIRMED`** (com `anchorRef`). **Só então** a resposta de sucesso. Falha aqui ⇒ resposta de erro (`LEDGER_UNAVAILABLE`); o estado é "fase C", recuperável **só pelo autor** (reenvio do mesmo pedido ou `RECOVER` dele; §16.16).
Idempotência: o reenvio de um pedido já confirmado devolve o mesmo resultado (sem novo `INTENT`). **Concorrência no `CONFIRMED` (R6-04):** se outro processo completar, antes do dono, o MESMO `CONFIRMED` (fase C), o dono relê o livro e recebe sucesso quando o registro concorrente casa com a operação e a cadeia continua autêntica; o `actor` desse registro é o de quem o gravou (a autoria da decisão está em `op.author`).
**Testemunhas antes de qualquer receita (R6-05):** `evaluateProtection` confere as citações de resultado (`ledgerHead`) e a guarda externa **antes** de oferecer ou aplicar `COMPLETE_CONFIRMED`, `ABORT` ou `REISSUE_RECEIPT`: uma recuperação grava um registro NOVO (outra hora, outro hash) e tornaria a citação irrecuperável; desacordo ⇒ `RESULT_LEDGER_MISMATCH` (ou `GUARD_MISMATCH`/`UNTRUSTED`), `recoverable: false`, nada é gravado em canal algum (travado em `link-audit-ledger-results-mismatch`: serviço, rotas, prévia, finalização, pendência, 4 processos concorrentes).
**Durabilidade (R6-07):** com o livro, a falha do `fsync` do **diretório** da entrada, do recibo ou de um registro do livro NÃO é engolida: a operação não devolve sucesso, a base trava até o reinício e o texto de erro não cita caminhos (`watchDurability`). **Limite:** sem o livro (6B isolada) e nos resultados/recibos de resultados e evidências o `fsync` de diretório segue melhor-esforço (risco P-4, sem aceite).

## 16.5 Concorrência entre processos
A exclusão mútua **não** depende de memória compartilhada: duas escritas simultâneas só podem anexar a mesma posição do livro por `link()` exclusivo; o perdedor relê e vê a operação aberta do vencedor. Um processo que morre deixa a operação em fase A/B/C, recuperável como em §16.4. **Residual declarado:** um dono muito lento (além do limite de 120 s) cuja operação foi abortada por outro processo e que depois publica a entrada produz `entrada publicada depois de ABORTED` ⇒ `HISTORY_UNRESOLVED` (falha fechada, por desenho).

## 16.6 Chave do livro, rotação e pontos de verificação
- Mesmo regime da chave de origem (atual assina; aposentada só verifica, ≤ 93 dias, relógio injetado; revogada ⇒ `KEY_REVOKED`; id público independente; material de 32 bytes), **com chave e id diferentes** dos da chave de origem.
- **Época de chave (R6-06, 03/11/2026).** A referência é a **ORDEM da cadeia** (encadeada por hash), nunca `recordedAt` (que quem forja escolhe) nem a validade da aposentada (que só diz até quando ela ainda VERIFICA). Regra: a partir do primeiro registro assinado por OUTRA chave, a anterior **não pode reaparecer** (`keyEpochViolation` ⇒ `UNTRUSTED`); uma chave aposentada verifica o passado, não autoriza registros novos. Vale também para a chave **atual**: se ela já foi substituída neste livro (reversão de configuração, chave antiga reposta) a auditoria fica não resolvida em vez de abrir uma segunda linha de assinatura. **Janela residual declarada (travada em teste):** entre a rotação e o PRIMEIRO registro da chave nova, quem tem a chave antiga e escrita no livro anexa registros que o sistema não distingue dos legítimos; o `CHECKPOINT` da chave nova os cobre e depois dele a antiga fica inutilizável. Só a revogação do id (ou a guarda externa) fecha essa janela; por isso o runbook manda gravar o ponto de verificação (`RECOVER`) em cada auditoria logo após a rotação.
- **`CHECKPOINT`** (`throughSeq`, `throughSha256`) é gravado automaticamente pela primeira escrita depois de uma rotação (**qualquer registro não coberto por ponto de verificação da chave atual e assinado por outra chave, inclusive o último ponto de verificação antigo** — R6-02) e a cada 64 registros; cobre a verificação de etiqueta dos registros anteriores **por encadeamento**. Registro com `kid` aposentado **vencido** só é aceito se coberto por `CHECKPOINT` válido; com `kid` **revogado** ⇒ `UNTRUSTED` **sempre** (comprometimento: nenhuma etiqueta dela autentica; recuperação = readoção administrativa, bloqueada). Chave desconhecida ⇒ `UNTRUSTED`.

## 16.7 Resultados (`ledgerHead`) e guarda externa
- Resultado novo grava `ledgerHead:{ledgerSeq,sha256}` (cabeça do livro no instante da finalização; exige `PROTECTED` e sem operação aberta). A leitura confere: o registro daquela posição tem de existir com o mesmo hash; senão `HISTORY_UNRESOLVED` (`RESULT_LEDGER_MISMATCH`). Livro **ausente** com resultado que o cita ⇒ `HISTORY_UNRESOLVED` (`LEDGER_REMOVED_WITNESSED`).
- **`ExternalGuardPort`**: `publish({auditId, ledgerSeq, sha256})` e `latest(auditId)`. Configurada: a cabeça publicada tem de ser prefixo do livro; e o livro não avança sobre uma guarda atrasada (a escrita seguinte publica antes; se não consegue ⇒ `LEDGER_GUARD_UNAVAILABLE`). Só existe o adaptador **sintético** (testes). Em produção o estado é `externalGuard: NOT_CONFIGURED` e **nada** afirma proteção contra rollback coordenado.

## 16.8 Operações administrativas bloqueadas (especificação do procedimento)
`RESTORE_ACK`, `QUARANTINE_ACK` e `ADOPT` (histórico não vazio) respondem `ADMIN_APPROVAL_UNAVAILABLE`. **Procedimento futuro** (precisa de papel administrativo verificável **e** de aprovação por dois administradores distintos, nenhum deles o solicitante): (1) congelar a auditoria; (2) obter fonte independente (backup de mesmo instante / guarda externa); (3) verificação integral automatizada (cadeias, recibos, etiquetas, resultados, livro); (4) registro `*_ACK` com justificativa, referência da fonte, cabeças antes/depois e identidade dos aprovadores; (5) **a evidência da inconsistência anterior é preservada** (registros e arquivos movidos para área de custódia, nunca apagados; o ACK referencia o hash do que foi afastado). Sem (1)–(5) nada é gravado.

## 16.9 Limitações que permanecem (declaradas)
Rollback **coordenado** de todos os volumes e escrita em ≥ 2 pastas incluindo o livro **sem** guarda externa operante; chave do livro comprometida entre o comprometimento e a revogação; histórico anterior à inscrição só é tão bom quanto na inscrição (e hoje **só auditorias vazias** podem ser inscritas); durabilidade (P-4); qualquer controle do processo web ou do host; verdade do conteúdo humano.

## 16.10 Como ficou implementado (local, SEM commit) e como provar

**Código.** Módulo `src/lib/link-audit-ledger/` (`types.ts` schema; `model.ts` **puro** — replay, etiquetas, avaliação de proteção e plano de recuperação; `store.ts` único a tocar o disco, só por `link()` exclusivo; `guard.ts` porta + adaptador **sintético** (só testes); `config.ts` único a ler `process.env`; `service.ts` coordena; `index.ts`). A 6B só conhece o livro pela **porta** `src/lib/link-audit-decisions/ledger-port.ts` (`LedgerPort`, `LEDGER_NOT_REQUIRED` — só para os testes da 6B isolada). `appendEntry` chama `begin → prepare → intent → (entrada, recibo) → confirmed` (`reissue` para o recibo reemitido). A chave do livro é derivada com **finalidade** `ledger` (`KeyPurpose`, domínio `LEDGER`, HKDF próprio) em `link-audit-origin`, que não muda para a origem.

**Rotas.** `POST /api/link-audit/decisions/{auditId}/ledger` com `{action}`: `ENROLL` (auditoria **vazia**), `RECOVER` (recuperação verificável, não grava decisão); `ADOPT`, `RESTORE_ACK`, `QUARANTINE_ACK` ⇒ **403 `ADMIN_APPROVAL_UNAVAILABLE`** em qualquer estado. A listagem (`GET`) traz `ledger` e a prévia traz `decisions.ledger`; `finalizable` exige livro `PROTECTED` e sem operação aberta. Códigos novos: `LEDGER_ENROLLMENT_REQUIRED` (409), `LEDGER_LEGACY_READ_ONLY` (409), `LEDGER_NOT_CONFIGURED` (503), `LEDGER_OPERATION_IN_PROGRESS` (409), `LEDGER_UNAVAILABLE` (503), `LEDGER_GUARD_UNAVAILABLE` (503), `ADMIN_APPROVAL_UNAVAILABLE` (403), `LEDGER_ACTION_INVALID` (400). Sem pasta/chave do livro configuradas **nenhuma** decisão é gravada (falha fechada).

**Resultados.** `RUN_SCHEMA_VERSION_LEDGER = 2` carrega `ledgerHead`; v1 permanece legível e inalterado; a testemunha de resultados informa ao livro `hasResults`, `ledgerHeads` (resultado confirmado/pendente **comprovado**) e `unverifiedLedgerHeads` (indício: só pode **contradizer**, nunca provar).

**Tela.** Painel do livro em Decisões: inscrição explícita (botão), recuperação verificável (botão só quando há receita), modo restrito (legada), razão por estado; **nunca** botão de adoção/restauração; sem guarda externa a tela diz que o retrocesso coordenado **não** é detectado.

**Provas (testes).** `link-audit-ledger-model` (puro), `-protocol` (ordem, recusas, idempotência, ações administrativas), `-attacks` (adulteração, truncamento, rollback parcial, chave revogada, reordenação), `-crash` (SIGKILL real antes/depois de cada etapa), `-concurrency` (5 processos reais), `-keys` (rotação, revogação, CHECKPOINT), `-results` (`ledgerHead`, v1/v2, livro truncado/removido), `-guard` (**limite travado**: sem guarda o rollback coordenado NÃO é detectado; com guarda é), `-api` (rota), `-isolation` (estática); mais UI (`render`, `validators`, `controller`) e o navegador (I5/I6/I7).

## 16.11 Revisão independente nº 6 (02/11/2026) — veredito do revisor: APROVADO COM RESSALVAS; classificação individual (03/11/2026)

Relatório verbatim em `onda6c-revisao-adversarial-6.md`. Sem BLOCKER de integridade: o revisor não quebrou a autenticidade (126 folhas re-seladas, todas detectadas), nem a ordem de durabilidade (SIGKILL antes de cada uma das 20 chamadas de escrita de uma revogação). Só a reversão **coordenada** de decisões + recibos + livro, sem resultado e sem guarda, reativa uma revogação — limite declarado. **Nenhum achado foi aceito automaticamente**: cada um foi relido na definição do relatório, reproduzido ou refutado por teste NOSSO e classificado em uma das quatro categorias abaixo (a gravidade MINOR/INFO do revisor não foi presumida).

Categorias: **Corrigido** (código + teste que falha sem a correção, verificado por mutação) · **Risco residual documentado** (limite conhecido, travado em teste quando possível, sem impedir o encerramento da 6C) · **Bloqueador de encerramento** (impede declarar a 6C encerrada) · **Bloqueador de produção** (a 6C pode encerrar, mas nada vai à VPS sem isto).

| Achado | Classificação | Disposição |
|---|---|---|
| R6-01 limite de 4000 registros: INTENT no 4000, CONFIRMED impossível, resposta "nada gravado" falsa | **Corrigido** | Reserva de 4 registros; recusa **antes** de publicar (razão `LIMIT_REACHED`); `link-audit-ledger-review6` nos três totais coerentes (3998–4000) — nada muda em decisões, recibos ou livro |
| R6-02 `needsCheckpoint` não gravava o CHECKPOINT da chave nova quando o último era da chave antiga | **Corrigido** | `model.ts`; testes de rotação (RECOVER e escrita) e do modelo puro |
| R6-03 503 vazava caminho do disco | **Corrigido** | Mensagem fixa (só o código do erro); teste |
| R6-04 fase C "roubada" de um dono vivo: erro falso ao dono; `actor` do CONFIRMED é o de quem o gravou | **Corrigido** (erro falso) + **Risco residual documentado** (atribuição) | `confirmed()` relê e devolve sucesso se o MESMO CONFIRMED já existe e a cadeia é autêntica (teste com 2 processos reais). A autoria da decisão está em `op.author`; o `actor` do registro é de quem o gravou. ~~A fase C continua sendo completada por qualquer escrita seguinte (imediatamente)~~ **Substituído pela §16.16 (16/11/2026):** a fase C só é concluída pelo autor |
| R6-05 recuperação ignorava as citações de resultado e tornava o `ledgerHead` irrecuperável | **Corrigido** (confirmado e **mais grave do que o relatado**: processos reais gravavam no livro contra a testemunha) | Citações e guarda conferidas **antes** de qualquer receita (§16.4); `link-audit-ledger-results-mismatch` (5 testes, 5 canais) reprova 5/5 com o modelo anterior |
| R6-06 aposentada ainda autentica registros NOVOS | **Corrigido** (registros posteriores à chave nova) + **Risco residual documentado** (janela até o 1º registro da chave nova; comprometimento até a revogação) | Época de chave pela ORDEM da cadeia (§16.6); testes com retrodatação, todos os tipos de evento, reversão de configuração e a janela residual travada |
| R6-07 falha de `fsync` de diretório engolida | **Corrigido** (livro + entrada + recibo quando há livro) + **Risco residual documentado** (sem livro e resultados: P-4, sem aceite) | `watchDurability`; EIO, EINVAL e ENOTSUP; base trava; reinício com disco saudável conclui o MESMO pedido sem duplicar. Ensaio de queda de energia continua pré-requisito de homologação |
| R6-08 livro removido sem testemunha aparece como "nunca adotada" | **Risco residual documentado** (texto **corrigido**) | A tela e a mensagem passaram a dizer que o livro pode nunca ter existido ou ter sido removido e que não há como distinguir sem fonte independente. Distinguir exige a guarda externa (item abaixo) |
| R6-09 versão antiga (rollback de imagem, réplica antiga) congela a auditoria inscrita | **Risco residual documentado** + **pré-requisito de produção** (plano de rollback) | Depois do primeiro `ENROLL` não se volta à imagem pré-livro nem se admite réplica antiga; atualizar com `stop-first`. Entra no checklist |
| R6-10 contrato da guarda frouxo (`head:null` = "atrasada"; atraso sem limite; resultado do `publishGuard` ignorado após CONFIRMED) | **Bloqueador de produção** (junto da guarda externa) | Só existe o adaptador sintético; o contrato da porta do adaptador REAL precisa fechar isto (`head:null` só com livro em `ledgerSeq ≤ 1`; limite de atraso; distinguir "nunca publicou" de "esqueceu") |
| R6-11 documentação ora sub-, ora superdeclara; apagar CHECKPOINT/ABORTED/RECEIPT_REISSUED da cauda não gera alarme | **Risco residual documentado** (documentação **corrigida**) | Pares de pastas (decisões+livro, recibos+livro, decisões+recibos) SÃO detectados; só livro+decisões+recibos reativa. Perda silenciosa de registros de cauda que não são CONFIRMED: inofensiva para decisões, perda de evidência (parte do rollback sem guarda) |
| R6-12 obrigatoriedade do livro é por convenção em `appendEntry` | **Risco residual documentado** | `DecisionService` exige `ledger` na construção; `LEDGER_NOT_REQUIRED` não é alcançável por configuração (31 configurações defeituosas recusam); teste estático novo proíbe chamar `appendEntry` fora do serviço |
| R6-13 incidente de chave congela TODAS as auditorias protegidas, sem saída administrativa | **Bloqueador de produção** | A operação administrativa real (identidade verificável, justificativa, dupla aprovação, auditoria) é pré-requisito de produção, junto da guarda externa |

**Testes fracos apontados** (39 mutações, 33 mortas, 6 sobreviventes): **M29, M25 e M38 foram FECHADOS** em 03/11/2026 (`link-audit-ledger-results-mismatch`, `-hkdf`, `-names`; as três mutações EXATAS do revisor agora são derrubadas). M10, M22 e M34 sobrevivem por **defesa em profundidade** (o esquema e `replayLedger` já impedem o que a mutação tenta; são mutantes equivalentes a menos que a outra camada seja removida). O teste de 5 processos tem **falsos alarmes de leitura sob carga** (item abaixo) e agora os conta e confere o estado final.

**Falso alarme transitório de leitura sob carga (medido em 02/11/2026).** Como o livro é lido **antes** das decisões, uma escrita concorrente de OUTRO processo pode fazer um leitor ver, por instantes, `UNLEDGERED_ENTRY`/`UNLEDGERED_PENDING` (`DECISIONS_HISTORY_UNRESOLVED`). A consulta relê uma vez e a escrita relê até 3 vezes (25–30 ms). Em 15 execuções do teste de 5 processos sob carga paralela (3 laços), 4 viram uma dessas corridas e **todas** terminaram com o estado FINAL íntegro (`PROTECTED`, 30 confirmadas, 61 registros, 0 `ABORTED`). **Consequência declarada:** sob carga um operador pode ver, e uma escrita pode receber, `DECISIONS_HISTORY_UNRESOLVED` espúrio e transitório (disponibilidade, falha fechada; reenviar resolve); **não** foi observada perda de integridade.

**Limites da revisão nº 6:** o revisor não rodou `tsc`, build, suíte completa nem navegador. A revisão nº 7 (03/11/2026), específica das correções desta rodada, está em `onda6c-revisao-adversarial-7.md`.

## 16.12 Capacidade do livro e reserva real (revisão nº 7, R7-01/R7-02 — corrigido em 04/11/2026)

**Causa-raiz de R7-01.** A correção de R6-01 reservou 4 registros *antes* do limite de 4000, mas a reserva era **da operação**, não **da classe**: qualquer `CREATE` podia consumir todo o espaço até quase 4000, deixando as revogações (e o `CHECKPOINT` da rotação) sem lugar. A "reserva de 100 revogações" da 6B (`RESERVED_FOR_REVOCATIONS`) era anunciada como constante, embora 100 *entradas* de ledger sejam 50 operações, não 100. O limite de 4000 é a capacidade **total**, inclusive os registros que concluem operações já iniciadas.

**Registros DURÁVEIS por operação, no pior caso** (todos em `types.ts`, `LEDGER_CAPACITY_POLICY`):

| Operação | Registros | Observação |
|---|---|---|
| `CREATE` / substituição (`RECORD`) | `INTENT` + `CONFIRMED` = **2** (+1 `CHECKPOINT` antes, quando devido) ⇒ até **3** | `CHECKPOINT` devido a cada 64 registros ou na 1ª escrita depois de rotação |
| `REVOKE` | idem: **2** (+1) ⇒ até **3** | |
| operação que **falha** | `INTENT` + `ABORTED` = **2** | a nova tentativa paga de novo |
| `INTENT` (fase A) / pendente (fase B) → recuperação | `ABORTED` = **1**; a fase B é concluída pelo autor com o `CONFIRMED` = **1** | a `INTENT` já pagou o fecho |
| recuperação da fase C | só o `CONFIRMED` que faltou = **1** | |
| reemissão de recibo | `RECEIPT_REISSUED` = **1** | manutenção |
| rotação de chave | `CHECKPOINT` = **1 por auditoria** | manutenção |

**Três classes, limites sobre o total de registros DEPOIS de concluída a operação** (`MAX` = 4000, `MANUTENÇÃO` = 8, `RESERVA DE REVOGAÇÃO` = **307** = 100 revogações × **3** (INTENT + CONFIRMED + até 1 reemissão de recibo, D3) + 5 pontos de verificação no pior alinhamento + 2 de folga (era 206 = 100 × 2 + 4 + 2, antes do D3)):

| Classe | Limite | Valor |
|---|---|---|
| `RECORD` (decisão nova) | `MAX − MANUTENÇÃO − RESERVA DE REVOGAÇÃO` | **3685** |
| `REVOKE` | `MAX − MANUTENÇÃO` | **3992** |
| manutenção (`CHECKPOINT`, `ABORTED`, reemissão, `CONFIRMED` que conclui o iniciado) | `MAX` | **4000** |

Uma `INTENT` só é aceita se ela **e o registro que a fecha** cabem no limite da CLASSE (`prepare` e `intent` usam a MESMA função, `operationCost`/`simulateOperations`, que a vista também usa para ANUNCIAR): **toda operação iniciada consegue terminar**, e **o que a vista anuncia é exatamente o que o livro executa** (`capacity.decisionsAvailable`, `capacity.revocationsAvailable`, `limits.reservedForRevocations = min(100, revocationsAvailable)`, `limits.maxEntries = entradas existentes + revogações que cabem`).

**Limites reais** (calculados, não supostos — pisos do PIOR CASO, com 1 reemissão de recibo após cada operação): de um livro recém-inscrito a vista anuncia **≥ 1210 decisões novas** e, ao todo, **≥ 1311 entradas** (decisões + revogações) — e **não** as 9999 do `MAX_SEQ` da 6B; sem remoção de recibos o escritor admite mais (1814 decisões e 1965 entradas: crescimento real de 2 registros por operação; medido com a mesma regra de admissão). Depois da última decisão nova restam **exatamente ≥ 100 revogações completas** em qualquer alinhamento, **mesmo com uma reemissão após cada uma** (propriedade conferida por exaustão sobre ~650 mil estados). `RESERVED_FOR_REVOCATIONS = 100` continua sendo **operações** de revogação, não entradas de ledger. Antes do D3 os números eram 1863 / 1965 / ≥ 101 e a garantia de 100 caía para ~68 sob a reemissão por operação (reproduzido: com 5 revogações reservadas só 4 cabiam).

**Níveis e sinalização.** `OK` (cabem decisões novas) → `REVOKE_ONLY` (decisões novas encerradas; só revogações) → `EXHAUSTED` (nem revogações cabem; só manutenção). Em `REVOKE_ONLY`/`EXHAUSTED` as operações não essenciais são recusadas **antes de gravar qualquer coisa** (`LEDGER_CAPACITY_EXHAUSTED`, razão `LIMIT_REACHED`), a tela exibe alerta e, em `EXHAUSTED`, o texto diz que **a auditoria precisa de INTERVENÇÃO** (a reabertura administrativa não existe — §16.8).

**Coordenação entre processos.** Toda verificação de capacidade ocorre na posição que o registro vai ocupar e é **autoritativa pelo `link()` exclusivo**: se outro processo ocupar a posição, o `link()` falha (`CONFLICT`), a avaliação recomeça com o livro novo e a capacidade é recalculada. Provado com 5 processos reais na fronteira (`link-audit-ledger-capacity`): exatamente as operações que cabem terminam, as demais recebem a recusa, nada fica pela metade.

**Rotação (R7-02).** O `CHECKPOINT` da chave nova é **manutenção** (limite 4000, com 8 registros que decisões e revogações nunca consomem) e o `RECOVER` deixa sempre **1 registro livre para fechar** uma operação aberta; uma `CREATE` não consegue consumir o espaço dele. Sucesso do `RECOVER` ⇒ `CHECKPOINT` autenticado (chave atual) **e** pasta do livro sincronizada.

**Limitação que permanece e estratégia de continuidade (NÃO implementada).** O livro é **fixo em 4000** (o esquema e as pastas assumem `l000001…l004000`) e **não se compacta** (compactar enfraqueceria o histórico). Uma auditoria que chega a `EXHAUSTED` — ou cujo livro está *inteiramente* cheio no momento em que uma rotação precisaria do `CHECKPOINT` — **não consegue** gravar mais nada e, se a chave antiga vencer, fica `HISTORY_UNRESOLVED`. As 8 posições de manutenção cobrem rotações e recuperações normais; a reemissão de recibo (no máximo 1 por entrada confirmada) está CONTADA na reserva de cada operação (D3), então recibos removidos não esgotam a reserva de revogação; abortos por tentativa falha são freados por `staleOperationMs` (1 tentativa por 120 s). **Estratégia segura proposta:** *segmentação por época* — um registro de FECHAMENTO assinado (cabeça final do segmento) e um novo livro `E+1` cujo `GENESIS` cita a cabeça de fechamento do anterior, sempre sob **aprovação administrativa dupla** (§16.8); o segmento antigo permanece **intacto, somente leitura e verificável**. Exige o papel administrativo que não existe: **pré-requisito de produção** para auditorias longas; hoje ≥ 1311 entradas por auditoria (até 1965) são mais de **6× o limite de 200 decisões vigentes** (`MAX_EFFECTIVE_RECORDS`), então a limitação só alcança auditorias com histórico muito longo de substituições/revogações.

## 16.13 Durabilidade (R7-04 — corrigido em 04/11/2026)

Três resultados DISTINTOS, nunca confundidos: **durável** (sucesso: entrada, recibo e livro sincronizados — diretórios e, na criação, o diretório-**pai**); **recuperável e pendente** (`ANCHOR_PENDING`: recibo não gravado; o reenvio conclui); **durabilidade desconhecida** (`DECISIONS_DURABILITY_UNKNOWN`: nunca sucesso, a base trava, e depois do reinício o MESMO pedido só conclui **depois de sincronizar de novo**). Correção no protocolo de escrita, não só na resposta: (1) o fsync da pasta da auditoria **não** persiste o nome dela — pasta criada agora ⇒ sincroniza também o pai (livro, decisões, recibos); (2) retomadas (reenvio de pendente, fase C, recibo adotado) sincronizam decisões e recibos antes de concluir; (3) o `RECOVER` só responde sucesso depois de sincronizar o livro, **mesmo quando nada foi gravado** (o registro pode existir e não ser durável); (5) o dono que **adota** o `CONFIRMED` gravado por outro processo sincroniza o livro antes do sucesso; (6) o diretório-**pai** é sincronizado em TODA gravação e retomada (um fsync de pai que falhou numa criação anterior não pode ficar sem prova depois do reinício) — **no livro, `publishLedgerRecord` sincroniza a RAIZ em TODA publicação, ANTES de gravar** (revisão 7b, M2: antes só na criação da pasta; custo medido ≈ 0,25 ms por registro contra ≈ 10 ms para publicar em ext4, ≈ 2,5 %), e `syncLedgerDirectory` (RECOVER, reenvio de confirmada, adoção) inclui a raiz; (4) **resíduo fechado nesta rodada:** o reenvio de uma entrada que o livro **já confirmou** sincroniza decisões, recibos e livro antes do sucesso (antes devolvia sucesso sem sincronizar nada, e o `CONFIRMED` podia ter ficado com o fsync incerto antes do reinício). **Plataforma:** o ext4 do WSL usado nos testes suporta `fsync` de diretório; o volume de produção **precisa ser conferido** no ensaio de homologação; sistemas de arquivos que não suportam (`EINVAL`/`ENOTSUP`/`ENOSYS`/`EPERM`) fazem **toda** gravação do livro responder "durabilidade desconhecida" — a limitação aparece, não é escondida (as leituras continuam). **Sem o livro** (6B isolada, só testes) o fsync de diretório segue melhor-esforço (P-4 histórico, sem aceite). Ensaio de queda de energia/`fsync` real continua pré-requisito de homologação.

## 16.14 Consistência de leitura e recuperação com evidência desatualizada (R7-05/R7-06 — corrigido em 04/11/2026)

**Ordem de leitura única** (cada fonte só cresce e cita a anterior, então ler primeiro a citada nunca produz desacordo FALSO por corrida): resultados (testemunha) → guarda → livro → decisões e recibos; **relida a cada tentativa**, nunca fixa durante esperas. Concorrência legítima ⇒ leitura consistente ou releitura **limitada** (3 releituras na escrita, 1 na consulta); adulteração ⇒ bloqueio de integridade; inconsistência **persistente** ⇒ falha fechada (nenhuma releitura a mascara). **RECOVER/recuperação (TOCTOU):** antes de **cada** gravação de recuperação (`ABORTED`, `CONFIRMED` da fase C, `CHECKPOINT`) o serviço (1) confere que a testemunha das **decisões** (6B) está resolvida, (2) **relê** a testemunha dos **resultados** depois de ler o livro e reavalia sobre a MESMA leitura do livro (resultado selado entre a leitura e a gravação que contradiz o livro ⇒ recusa sem gravar; mudança benigna ⇒ releitura limitada; releitura que falha ⇒ recusa), (3) exige a **origem comprovada** da entrada (fase C), (4) exige entrada e recibo comprovadamente **duráveis**. Em divergência o registro pendente (`INTENT`) **não é removido nem reescrito**: fica para investigação e a recuperação segura continua possível depois. (`expectedInputSha256`/`expectedHead` pertencem à **finalização** de resultados e continuam conferidos lá, dentro da trava; o `RECOVER` não recebe corpo além da ação.)

## 16.15 Relógio adiantado: `INTENT` com hora no futuro (R7-09 — corrigido em 04/11/2026)

Uma `INTENT` gravada com o relógio adiantado tem idade **negativa**: antes, nunca vencia até o relógio real alcançá-la (centenas de dias), a recuperação não a abortava e toda escrita respondia "operação em andamento" — **negação de serviço persistente** sem saída (a reabertura administrativa não existe). Agora, quando a hora gravada está no futuro, a idade vem do tempo **monotônico** que o processo observa a operação aberta (`observed.ts`, independente do relógio de parede e de `recordedAt`); passou `staleOperationMs` (padrão 120 s) de observação contínua ⇒ vence como qualquer outra e o `RECOVER` ou a própria escrita a abortam (`ABORTED` com a idade observada). Hora gravada normal: nada muda (a idade de parede manda). Memória limitada (256 operações; esquecer só ADIA o vencimento). Um dono vivo conclui em milissegundos; uma operação parada por `staleOperationMs` sem progresso é tratada como vencida, igual à de idade normal (o risco de "dono lento que perde a corrida" é o mesmo já declarado: `PUBLISHED_AFTER_ABORT`, falha fechada).

### 16.13.1 Precedência da falha de fsync e estado `DURABILITY_UNKNOWN` (M2 — corrigido em 05/11/2026)
Uma falha de fsync observada em QUALQUER ponto de uma publicação do livro (raiz, pasta da auditoria) vale mais do que qualquer outro resultado, inclusive outro erro simultâneo (ENOSPC, conflito): a resposta é "durabilidade desconhecida" (`DECISIONS_DURABILITY_UNKNOWN`, 503), **nada é publicado** quando a falha é a da raiz (fail-fast) e a base trava até reiniciar (depois de um erro de fsync não se presume nada, mesmo que o disco "volte"). Enquanto a base estiver travada **o livro não é lido como protegido**: `ledger.state = HISTORY_UNRESOLVED`, `reason = DURABILITY_UNKNOWN` (nenhuma decisão vigente, nada finalizável — um resultado selado nessa janela citaria uma cabeça talvez não durável); a leitura continua **respondendo** (nunca "livro vazio"). **Reinício NÃO é comprovação (fechado em 05/11/2026, §16.13.2):** o processo novo começa sem nenhuma prova de durabilidade; a PRIMEIRA leitura de cada auditoria sincroniza a pasta da auditoria e a raiz e só então o livro é lido como protegido — se o fsync ainda falha, a leitura fica `DURABILITY_UNKNOWN`. **Granularidade:** o bloqueio é do VOLUME (a raiz do livro), não de uma auditoria: um erro de fsync/EIO/EROFS reflete o estado do dispositivo ou do sistema de arquivos compartilhado e não se pode provar que as outras auditorias da mesma base não foram afetadas (depois de um fsync falho o kernel pode ter descartado páginas sujas de outros arquivos); por isso todas as auditorias daquela base ficam não resolvidas até reiniciar e revalidar. **Plataforma:** o livro exige um sistema de arquivos Linux que suporte `fsync` de diretório (ext4/xfs/volume Docker); em drvfs (`/mnt/d`) toda gravação responde "durabilidade desconhecida".

### 16.12.1 Reemissão de recibo e consumo da reserva (corrigido em 05/11/2026)
**Reproduzido antes da correção** (política de 40 registros, recibo removido e gravação de recibos falhando com ENOSPC, autor reenviando): cada reenvio gravava um `RECEIPT_REISSUED` — com 33 reenvios o livro chegava a `EXHAUSTED` (0 revogações), com ~39 nem o próprio reenvio cabia e **a auditoria ficava presa em `RECEIPT_REMOVED` mesmo depois de o disco voltar**. Correção: a reemissão já registrada para o mesmo recibo (mesma operação e mesmo hash de entrada, depois do `CONFIRMED`) **não grava outro registro**; sobra no máximo 1 `RECEIPT_REISSUED` por entrada confirmada, e o reenvio conclui mesmo com o livro cheio. **Custo declarado:** remoções repetidas do MESMO recibo ficam registradas uma vez só no livro (a evidência de que o recibo foi recriado existe; a contagem de remoções não). Demais consumidores: tentativas que falham depois da `INTENT` custam 2 registros (INTENT + ABORTED), mas a `INTENT` fica aberta até `staleOperationMs` (120 s) e toda outra tentativa recebe "em andamento" sem gravar — ritmo máximo de 1 tentativa falha por período; esvaziar a reserva de 100 revogações exigiria ≈ 100 períodos (≈ 3,3 h) de falha contínua do disco de decisões com retentativas automáticas. Não é bloqueio reproduzível em condições normais; fica como risco residual com monitoração de `capacity.level`.

### 16.13.2 D1, revalidação depois do reinício e granularidade (corrigido em 05/11/2026)
**D1 (MAJOR, regressão):** a reemissão de recibo "já registrada" era PULADA e devolvia sucesso sem sincronizar o livro; depois de uma falha de fsync na publicação do `RECEIPT_REISSUED` e de um reinício (ou se OUTRO processo o publicou), o reenvio concluía sem nunca provar o registro. **Correção:** o caminho de reuso sincroniza o livro (pasta da auditoria e raiz) AGORA e recusa com `DECISIONS_DURABILITY_UNKNOWN` se não provar; nenhum registro novo e nenhum consumo de capacidade. Provado com reinício REAL (T3), entre PROCESSOS (outro processo publicou a reemissão com o fsync falho) e com falha de fsync no próprio caminho (a base trava). **Revalidação depois do reinício:** `begin()` do livro só lê uma auditoria como protegida depois de a durabilidade ter sido PROVADA neste processo (fsync da pasta da auditoria e da raiz DEPOIS de os registros existirem; uma vez por processo e auditoria; custo medido: 2 fsyncs na primeira leitura; publicações e `RECOVER`/replay bem-sucedidos também provam). O armazenamento (leitura e esquema), o histórico autenticado (cadeia + etiquetas, `verifyTags`/`replayLedger`) e as barreiras de durabilidade são revalidados antes de voltar a `PROTECTED`. **Falha de fsync em RECOVER, replay, adoção e reemissão trava a base** (nunca sucesso, nem na 2ª tentativa com o disco "saudável"); provado por teste (MB2b).

### 16.14.1 Barreira de durabilidade ANTES de selar resultado (aprovada e implementada em 05/11/2026)
Um resultado só é selado — e um resultado pendente só é concluído — quando `durabilityBarrier` (serviço de decisões; chamada pela finalização DENTRO da trava de resultados, depois da última releitura e antes de montar o registro) confirma: (1) livro `PROTECTED`, sem operação aberta nem pendente, e com EXATAMENTE as cabeças que a finalização avaliou (`decisionsHead` e `ledgerHead`); (2) o livro (pasta + raiz), as decisões, os recibos e os diretórios-pai foram sincronizados DEPOIS de lidas essas cabeças; (3) uma releitura mostra as MESMAS cabeças e o livro ainda `PROTECTED` (nenhuma gravação concorrente mudou o estado nem travou a base). Mudança ⇒ `INPUT_CHANGED` (409, tente de novo); durabilidade não comprovada ⇒ `RESULT_DURABILITY_UNKNOWN` (503); qualquer dúvida ⇒ nada é selado. **Sem janela TOCTOU:** o que o resultado cita é exatamente o que foi lido, sincronizado e relido; uma gravação que chegue depois da releitura só acrescenta registros APÓS a cabeça citada (o livro só cresce e o citado já está sincronizado). Se a barreira não existir (dependência ausente) a finalização que cita o livro é recusada (falha fechada). Não altera o Motor Lumos nem a régua D3B.

## 16.16 Emenda — fase C só pelo autor (16/11/2026)

**Decisão do responsável (16/11/2026): "fase C só pelo autor".** Fecha o achado M-1 da revisão adversarial 3A (teste RV3A-1).

**Problema.** Os recibos das decisões não são autenticados (só SHA-256). Quem escreve apenas na pasta de recibos podia fabricar o recibo de uma pendente LEGÍTIMA de outro operador (entrada publicada, recibo falhou ⇒ `ANCHOR_PENDING`, fase B). A auditoria passava a parecer em fase C e a escrita seguinte, ou um `RECOVER`, de QUALQUER operador gravava o `CONFIRMED` e a decisão virava `ACTIVE` sem o autor reenviar. Era limitação declarada (ADR da prova de origem §8; modelo de ameaças §6.2).

**Regra (negar por padrão, espelho da fase B).** A `CONFIRMED` da fase C só é gravada quando o e-mail da sessão autenticada é IGUAL ao autor da entrada (`op.author`, normalizado), com a origem da entrada `PROVEN` e as demais condições da §16.4. Vale para a escrita (`create`/`revoke`) e para o `RECOVER`. Quem não é o autor recebe **409 `PENDING_UNCONFIRMED`** (código existente, tabela HTTP inalterada; sem `pending` no corpo), nada é gravado no livro nem nas decisões, e a pendente segue bloqueando a auditoria (nada vigente, não finalizável), como na fase B. A conclusão pelo autor é o reenvio do mesmo pedido (replay idempotente) ou o `RECOVER` dele.

**Fica como estava.** (1) Fases A e B: o `RECOVER` de qualquer operador continua abortando a `INTENT` vencida (120 s) da fase A; a fase B continua só do autor. (2) R6-04: outro PROCESSO do MESMO autor que complete a fase C antes do dono continua válido (o dono relê e recebe sucesso). O que muda: o `actor` do `CONFIRMED` da fase C agora é sempre o próprio autor. Outros autores NÃO concluem mais. (3) Formatos persistidos, recibos, capacidade e durabilidade: inalterados.

**Consequências.** Custo de disponibilidade, já aceito para a fase B: se o autor sair, perder o acesso ou deixar de constar em `GMN_OPERATOR_EMAILS`, a fase C fica sem quem a conclua e a auditoria fica bloqueada até a intervenção administrativa (a adoção/restauração segue bloqueada, §16.8). Em troca, quem tem escrita só na pasta de recibos deixa de poder promover pendente alheia a confirmada. **Continua possível** para esse atacante: remover recibo (disponibilidade) e forjar o recibo de pendente legítima, que apenas a faz parecer em fase C (bloqueada) até o autor reenviar. **Concorrência:** se o processo do autor está vivo e no meio da gravação (recibo gravado, `CONFIRMED` ainda não), a escrita simultânea de OUTRO operador recebe 409 `PENDING_UNCONFIRMED` em vez de concluir pelo autor (antes ela concluía). A janela é de milissegundos (um fsync) e a tela trata esse 409 recarregando a vista; nenhuma espera foi acrescentada (observado no teste `link-audit-ledger-concurrency`, que continua verde). Recibos de RESULTADOS (6C) não fazem parte desta emenda.
