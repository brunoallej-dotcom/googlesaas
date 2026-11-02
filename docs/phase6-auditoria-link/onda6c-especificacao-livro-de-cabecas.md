# Onda 6C — ESPECIFICAÇÃO do Livro de Cabeças independente (proposta de arquitetura — NADA DISTO FOI IMPLEMENTADO)

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
