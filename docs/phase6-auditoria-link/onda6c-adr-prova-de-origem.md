# ADR 6C-02 — Prova de ORIGEM das operações pendentes (remediação do MAJOR-1)

> **Status:** implementado na árvore de trabalho, **sem commit** (aguarda a revisão independente da rodada e a autorização do responsável). Revisado em 01/11/2026 após a 2ª revisão independente (`onda6c-revisao-adversarial-2.md`) e as decisões do responsável. Complementa o ADR da âncora externa da 6B (`onda6b-adr-ancora-externa.md`, Emenda 1), o ADR 6C-03 (`onda6c-adr-proveniencia-evidencias.md`), o modelo de ameaças (`onda6c-modelo-de-ameacas-recuperacao.md`) e o runbook de chaves (`onda6c-runbook-chaves.md`).
>
> **Regra deste documento:** nenhuma garantia aqui escrita supera o comportamento **demonstrado por teste**. Onde o sistema **não** garante algo, está dito.

## 1. Contexto e causa-raiz

Uma decisão (6B) ou um resultado (6C) só é **confirmado** quando o arquivo de dados **e** o recibo (pasta separada) existem. Entre os dois ele é **pendente**: existe, não vale, bloqueia a auditoria. O protocolo previa que "só o autor, reenviando o mesmo pedido, o conclui" (grava o recibo). Os documentos da 6B diziam que uma pendente forjada "só consegue **bloquear**, nunca valer".

A 1ª revisão reproduziu o contrário (RV-01, RV-04): quem escreve **numa única pasta** forja uma pendente citando um operador real; quando ele usa "Concluir/Reenviar", o servidor grava o recibo e o registro vira ACTIVE/PONTUADO. Causas: (1) **confiança circular** — "mesmo autor + mesmo pedido" é avaliado sobre dados da pasta comprometível, e o pedido é montado pela interface a partir do próprio arquivo; (2) **hash ≠ autenticação** — SHA-256, encadeamento e `verifyRunRecord` provam autoconsistência, não procedência; (3) o **recibo é um "cartório"**; (4) a interface dizia "foi você quem gravou" a partir de um `isMine` derivado do arquivo.

## 2. Decisão

O servidor **comprova a origem** de toda entrada/resultado que ele grava com uma **etiqueta HMAC-SHA-256** cuja chave **não está em nenhuma pasta de dados**. A **conclusão de uma pendente exige a etiqueta válida**; sem ela (arquivo anterior à proteção, forjado, adulterado, chave desconhecida/revogada/vencida, servidor sem chave) a conclusão é **recusada** (`PENDING_ORIGIN_UNPROVEN` / `RESULT_PENDING_ORIGIN_UNPROVEN`, 409) e **nada é gravado**.

**Invariante demonstrada (atacante A1):** uma operação criada ou adulterada **somente numa pasta de dados**, por quem não tem a sessão do operador nem a chave do servidor, **nunca** se torna CONFIRMADA/ACTIVE/PONTUADA porque um operador legítimo acionou a recuperação.

**O que a etiqueta NÃO garante:** que os **fatos** usados num resultado sejam verdadeiros (isso é a **proveniência da evidência**, ADR 6C-03); que um registro **já confirmado** continue o mesmo (§5); que uma pendência legítima não seja, na verdade, um recibo removido (§7).

## 3. Alternativas avaliadas

| # | Alternativa | Veredito |
|---|---|---|
| A | **HMAC por chave do servidor fora das pastas** | **Escolhida.** Impede a forja por quem só escreve em pasta; um segredo; verificação local. Custo: gestão da chave (runbook). |
| B | Intenção durável em armazenamento independente (grava, **antes** do dado, o hash do que vai gravar) | Equivalente contra quem escreve **uma** pasta e sem segredo, mas exige outro volume e mais uma fase do protocolo. **Base recomendada para a "testemunha externa"** (§6), não substitui o HMAC. |
| C | Estado no banco (Supabase) | Rejeitada: acopla a um serviço externo, fora do escopo e das restrições. |
| D | Assinatura assimétrica **para a origem** | Desnecessária: quem assina e quem verifica é o mesmo servidor. (Para a **coleta** sim — ADR 6C-03.) |
| E | Re-derivar a entrada (mapeador + motor) e comparar | **Mantida como defesa em profundidade (6C)**; insuficiente sozinha (a 6B não é derivável; o estado de hoje pode legitimamente diferir). |
| F | "Mesmo autor + mesmo pedido" | Reprovada (MAJOR-1). |
| G | Operador redigita o conteúdo | Não prova origem. |

## 4. Desenho

### 4.1 Etiqueta
`origin = { v:1, kid, tag }` dentro do arquivo selado. `tag = HMAC-SHA-256(chaveDerivada, DOMÍNIO + "\n" + JSON-canônico(corpo))`. O **corpo** é a entrada **sem** `origin` e **sem** `contentSha256` e já contém `auditId`, `seq`, `prevSha256`, autor, hora e conteúdo; os domínios `DECISION`/`RUN` separam decisão de resultado; comparação em tempo constante; `chaveDerivada` por **HKDF-SHA-256** a partir do material da chave. A etiqueta **não pode ser copiada** para outra posição, auditoria, autor ou conteúdo (testado).

### 4.2 Chaves (política verificável; detalhes no runbook)
- **Material:** exatamente **32 bytes de CSPRNG em 64 hex minúsculos**; senha humana, base64, espaço/quebra de linha e material degenerado são **rejeitados** (as escritas respondem 503). O filtro é de **sanidade**; **não prova entropia**.
- **Identificador (`kid`):** rótulo **público escolhido por quem provisiona e independente do segredo** — nada gravado em arquivo permite testar palpites do segredo offline (a versão anterior derivava o id do segredo; corrigido).
- **Rotação PLANEJADA:** a chave antiga entra em `…_RETIRED_KEYS` **com data de validade obrigatória**; só **verifica**, nunca assina; depois da data o veredito é `KEY_EXPIRED`.
- **Rotação por COMPROMETIMENTO:** a chave vazada é **removida** e seu **id** entra em `…_REVOKED_KEY_IDS`; etiquetas dela dão `KEY_REVOKED` e **nenhuma pendência dela é concluída** (inclusive as legítimas — custo declarado). Manter o material de um id revogado é **erro de configuração** (falha fechada). A antiga variável `…_PREVIOUS` **não existe mais**.
- **Reassinar não reabilita:** não há ferramenta de reassinatura, de propósito (runbook §3).

### 4.3 Onde assina e onde exige
- **Assina:** em `appendEntry` (6B) e `appendRun` (6C), no instante em que `seq` e `prevSha256` são atribuídos. Sem autenticador, o **serviço** responde `ORIGIN_KEY_NOT_CONFIGURED` e as **rotas**, 503, sem gravar (testado). A primitiva de armazenamento tem uma **trava adicional** que também recusa gravar sem autenticador; ela é defesa em profundidade e **não tem teste isolado** (só é alcançada se o serviço for contornado).
- **Exige `PROVEN`:** ao dar o **recibo a uma pendente** (store) e, no serviço de resultados, **antes** de qualquer avaliação.
- **Defesa em profundidade na conclusão de resultado (6C):** origem → o registro **se explica** (motor reexecutado) → **a coleta é autêntica** (ADR 6C-03) → as evidências citadas existem **com os mesmos hashes** → o histórico de decisões **não regrediu** → recibo.

### 4.4 Projeção segura com operação pendente (R2-MINOR-2 / RV2-A3b)
Quando há uma operação **pendente** que **revoga ou substitui** uma decisão, o sistema **não** projeta a anterior como vigente: ela sai de `decisions` e de `operatorRecords` (logo, **do motor e da prévia**), aparece como `AMBIGUOUS` em `allDecisions`, o id vai em `ambiguousDecisionIds` e `finalizable` é `false`. Vale para pendente de origem comprovada **e** não comprovada. Todos os operadores autorizados veem **qual** decisão está em dúvida e **por quê** (apenas ids e rótulos; o motivo/conteúdo privado só vai ao autor com origem comprovada).

### 4.5 TESTEMUNHA do histórico e falha fechada (R3-MINOR-2, R4-MINOR-1, INFO-1; 01/11/2026)
**Problema (R3-MINOR-2, reproduzido pelo revisor 3):** a regra do §4.4 só valia **enquanto o arquivo pendente existia**. Mover a pendente para a quarentena (como mandava o §15 item 3 da 6B), uma falha de leitura da testemunha ou uma restauração parcial devolvia a decisão revogada ao estado ACTIVE e ao motor.
**Problema (R4-MINOR-1, revisor 4 — causa-raiz):** o provedor só contava o resultado **pendente** como testemunha se a origem fosse `PROVEN` **no momento da leitura**. A origem depende da **configuração de chaves de hoje**; logo uma rotação (aposentada vencida, REVOGADA, desconhecida) ou uma configuração de origem inválida (as rotas montavam o provedor **sem autenticador**) fazia a testemunha **sumir sem aviso** e a lista de cabeças ficar vazia. Removidos os recibos do resultado e da revogação e posto `d0002` em quarentena, a decisão revogada voltava a ACTIVE e era FINALIZADA (reprodução RV4-A7). **A ausência de uma testemunha foi tratada como "nenhuma testemunha existe", e isso virou "nada a contestar".**
**Problema (INFO-1):** sem `GMN_LINK_AUDIT_RESULTS_DIR`/`…_ANCHOR_DIR` o serviço recebia `knownHeads` indefinido ⇒ `NOT_CONFIGURED`, que **não** era bloqueante (falha ABERTO), e o campo era **opcional** no tipo: esquecê-lo compilava.

**Correção (regras):**
1. **A testemunha é OBRIGATÓRIA por construção.** `DecisionServiceOptions.knownHeads` não é opcional; a dispensa é o símbolo explícito `WITNESS_NOT_REQUIRED` (só testes da 6B isolada; teste estático garante que nada em `src/` além do serviço e do módulo da testemunha o referencia). As duas composições de rotas **sempre** passam uma fonte: sem as duas pastas de resultados ela responde `NOT_CONFIGURED`.
2. **Três classes de informação, que nunca se misturam** (`createResultsKnownHeads`, `witness.ts`):
   - **testemunhas (`heads`)**: o `decisions.head` de cada resultado **confirmado** e o do **pendente cuja origem o servidor comprova HOJE** (chave atual, ou aposentada dentro da validade);
   - **indícios (`unverifiedHeads`)**: o head de um resultado **pendente de origem NÃO comprovada** (chave aposentada vencida, **revogada**, desconhecida; etiqueta ausente/inválida; servidor sem autenticador). **Nunca** é promovido a resultado selado e **uma chave comprometida nunca o torna confiável**. Serve só para **denunciar**: se afirma uma posição/hash que o histórico de hoje **não** tem, a testemunha é `UNTRUSTED` (não resolvido); se confere, é ignorado;
   - **falha explícita**, nunca lista vazia: `NOT_CONFIGURED` (dependência ausente, relativa, ou pastas sobrepostas/iguais — inclusive por link simbólico), `STORAGE_UNAVAILABLE` (EIO, EACCES, pasta inexistente, provedor que lança), `UNTRUSTED` (cadeia adulterada/truncada/recibos incoerentes, resposta malformada, cabeças em excesso).
3. **Todo estado não resolvido falha fechado** (abaixo). Só `UNWITNESSED` (fonte **legível e configurada, sem nenhuma cabeça**) é não bloqueante — é o estado de **toda auditoria nova** antes do primeiro resultado (sem ele a primeira finalização seria impossível, pois o resultado É a testemunha) — e **declara** o que não cobre (`unwitnessedAffecting`: nº de revogações/substituições após a última cobertura), nunca "consistente".

| `witness.status` | Significado | Efeito |
|---|---|---|
| `NOT_REQUIRED` | `WITNESS_NOT_REQUIRED` (só testes da 6B isolada) | nenhum; **nunca em produção** |
| `UNWITNESSED` | fonte legível e configurada, **sem cabeça**: a testemunha ainda não existe | normal, **com a contagem do que não cobre** e nota na tela; **não é garantia** |
| `CONSISTENT` | toda cabeça (≥ 1) confere | normal |
| `RECEIPT_LOST_WITNESSED` | uma cabeça é exatamente a entrada **pendente**: já estava confirmada | decisão alvo EM DÚVIDA (§4.4); o **autor** recupera |
| `HISTORY_REGRESSED` | uma cabeça está **além** do histórico de hoje (arquivos removidos/movidos/restaurados de cópia antiga) | **NÃO RESOLVIDO** |
| `HISTORY_DIVERGES` | uma cabeça difere da entrada que ocupa hoje a mesma posição | **NÃO RESOLVIDO** |
| `UNTRUSTED` | cadeia de resultados que não confere, **ou** indício não verificado que contradiz o histórico de hoje, **ou** resposta malformada | **NÃO RESOLVIDO** |
| `UNAVAILABLE` | o armazenamento da testemunha não pôde ser lido (EIO, EACCES, pasta ausente, provedor que lança) | **NÃO RESOLVIDO** |
| `NOT_CONFIGURED` | pastas de resultados/recibos ausentes, relativas, iguais ou sobrepostas | **NÃO RESOLVIDO** (**antes era não bloqueante: INFO-1**) |

**Integridade NÃO resolvida ⇒ falha fechada:** `decisions` e `operatorRecords` **vazios** (o motor não recebe nenhuma decisão, inclusive as que estavam ativas), toda decisão antes vigente aparece `AMBIGUOUS` (as já revogadas seguem `REVOKED`: **nenhuma volta a ACTIVE**), `finalizable:false`, a prévia ganha o bloqueio `DECISIONS_HISTORY_UNRESOLVED` (com o estado em `reasonCode`), a finalização responde `NOT_FINALIZABLE` e a conclusão de resultado pendente é recusada (`NOT_FINALIZABLE` pelo autor com origem comprovada; `RESULT_PENDING_ORIGIN_UNPROVEN` sem origem comprovada; `RESULT_PENDING_UNCONFIRMED` por outro operador), **nenhuma escrita** (nem decisão nova, nem revogação, nem o "reenvio" do autor) é aceita (`409 DECISIONS_HISTORY_UNRESOLVED`), e a interface mostra um aviso estruturado, **com o motivo próprio de cada estado**, a **todos** os operadores, sem botão de concluir. A **consulta continua** (informativa, rotulada), sem falsa garantia de integridade. Remover ou mover um arquivo **não** é autorização implícita para retroceder o histórico. Demonstrado em `link-audit-decisions-revocation-receipt`, `link-audit-decisions-witness-rotation` (matriz perda de prova × rotação), `link-audit-decisions-api`, `link-audit-scoring-preview-api` e navegador B16/B17.

**Consequência declarada (disponibilidade, não integridade):** como o indício denuncia, **quem escreve só na pasta de resultados** (A3) consegue **congelar** uma auditoria ao plantar um resultado pendente que contradiz o histórico. É falha fechada intencional. O destravamento é um ato **humano com fonte independente** (comparar com backup/relatório), registrado fora do sistema — **não** "mover o pendente de resultado para a quarentena" sem essa conferência, pois isso apaga o indício e, se ele era real, reabre a janela abaixo.

**LIMITE — BLOQUEADOR PARA PRODUÇÃO (declarado, não resolvido; reproduzido no teste "LIMITE DECLARADO" de `link-audit-decisions-witness-rotation`):** a testemunha **só cobre o que um resultado selado já registrou**. Forma exata do limite: **a janela abre na REVOGAÇÃO (ou SUBSTITUIÇÃO) e só fecha no PRÓXIMO resultado selado**: uma revogação/substituição confirmada sem resultado selado **posterior** (cobertura < posição dela; a tela já declara `unwitnessedAffecting > 0`) pode ser desfeita perdendo o recibo dela **e** movendo o arquivo — **dois arquivos, em duas pastas** — mesmo com o resultado ANTERIOR e o recibo dele intactos (prova da 5ª revisão, travada em teste). Caso extremo da mesma família: se **todos** os vestígios somem (arquivo da decisão, seu recibo, o resultado e o recibo dele), a auditoria fica idêntica a uma que nunca teve resultado (`UNWITNESSED`). Em ambos a decisão revogada volta a ser vigente e **o sistema não detecta**. A regra de **procedimento** (nunca mover pendente de revogação/substituição, **de qualquer origem** — inclusive chave revogada —; nunca mover resultado pendente sem fonte independente; finalizar logo após revogar/substituir, **quando a finalização estiver habilitada**) cobre a janela, mas **o sistema não a impõe**. Fechar exige o **livro de cabeças independente** (§4.6; especificação em `onda6c-especificacao-livro-de-cabecas.md`).

### 4.6 Marcador durável — avaliação
| Opção | Cobre a janela sem resultado? | Custo / risco | Veredito |
|---|---|---|---|
| Resultados selados (**implementado**) | Não | nenhum novo | Cobre o pós-finalização |
| **Livro de cabeças** em pasta própria, escrito pelo servidor após cada decisão confirmada (3ª etapa do protocolo, com recibo próprio) | **Sim** (contra quem escreve **uma** pasta) | novo volume, nova fase do protocolo, nova forma de pendência (livro atrás do histórico), backup próprio | **Recomendado** (mesma interface `KnownHeadsProvider`; nenhum consumidor muda) |
| **Guarda externa do `head`** (fora da VPS), registrada a cada confirmação | Sim, inclusive contra quem escreve **duas** pastas | dependência operacional/externa; latência; custódia | **Recomendado a médio prazo** (mesma interface) |
| Memória do processo (maior `head` visto) | Só enquanto o processo vive | falso positivo em restauração legítima; perde-se no reinício | Rejeitado como garantia |
| `expectedHead` guardado no navegador | Só no mesmo navegador | não é autoridade | Rejeitado |

## 5. Momentos em que a origem é autenticada

| Momento | Autentica a origem? | Observação |
|---|---|---|
| Gravação (decisão, revogação, resultado) | **Assina** | Sem autenticador: recusa |
| Conclusão de pendente (dar o recibo) | **Sim — obrigatório** | `PROVEN` ou nada é gravado |
| DTO da pendente (listagens) | **Sim, para exibir** | Define `origin`, `isMine`, o que é revelado |
| Leitura/listagem de registros **CONFIRMADOS** | **NÃO** | Valem o recibo e o encadeamento; a etiqueta **não é reverificada** |
| Prévia / pontuação | Não usa a etiqueta | Usa o conjunto de confirmados (e a prova de coleta, ADR 6C-03) |
| Reenvio de um resultado já confirmado | Não grava; só devolve o que **se explica** | Sem etiqueta nova |

**Consequência declarada (RV2-W1, RV2-A7):** quem escreve as **duas** pastas (dados + recibos) de uma auditoria pode criar um registro **confirmado sem etiqueta** que a leitura aceita, sem alarme — limite histórico da 6B/6C, só mitigado por backup independente e pela guarda externa do `head`. **Recomendado (não implementado):** verificar a origem dos confirmados de modo **não bloqueante** (indicador), barato porque nada da 6B/6C foi implantado e toda entrada de produção já nascerá assinada. A Onda 7 (PDF) **deve** exigir `PROVEN` antes de consumir.

## 6. Testemunhas independentes (e seus limites)

| Testemunha | Onde vive | O que atesta | Quando existe | Limite |
|---|---|---|---|---|
| **Recibo** | Pasta de recibos (outra pasta) | Que a entrada N foi confirmada | Sempre, após confirmar | Quem escreve só nos recibos pode **removê-lo** (o último) ou criar o de uma pendente legítima |
| **`decisionsHead` gravado em resultado (confirmado, ou pendente de origem comprovada; o pendente de origem NÃO comprovada é só INDÍCIO, §4.5)** | Pasta de resultados (+ seus recibos) | Qual era o último item **confirmado** das decisões quando o resultado foi finalizado | **Só se algum resultado foi finalizado depois da decisão** | Não cobre decisões sem resultado posterior (**limite BLOQUEADOR**, §4.5). Verificado **na 6B**, em toda leitura/escrita (`witness.status`) |
| **Etiqueta de origem** | Dentro do arquivo | Que o servidor gravou **aquele** conteúdo | Em registros novos | Não distingue "interrompida" de "recibo removido" (vale nos dois) |
| **Manifesto de coleta** | Pasta de manifestos | Autenticidade das evidências | Se atestado | ADR 6C-03 |
| **`head` guardado fora do servidor** (checklist de produção) | **Não existe** | Distinguiria tudo acima | — | **Recomendado**, não implementado |
| **Backups independentes** | Fora da VPS | Restaurar o recibo | Se existirem | Ainda não definidos nem ensaiados |

## 7. Remoção de recibos: o que é detectável e o que não é

| Situação | Detectável? | Como / por quê |
|---|---|---|
| Recibo de uma entrada do **meio** da cadeia removido | **Sim** | Leitura falha (`ANCHOR_INTEGRITY`/`MISMATCH`/`TRUNCATED`), nenhum dado devolvido (teste) |
| Recibos de **duas ou mais** entradas removidos | **Sim** | Idem |
| Recibo da **última** entrada removido | **Não, universalmente.** Parece gravação interrompida | A decisão afetada fica **EM DÚVIDA**, o motor/prévia a ignoram, nada é finalizável, todos veem o problema; o **autor** (origem comprovada) pode concluir recriando o recibo do **mesmo** conteúdo, com confirmação explícita |
| Idem, **havendo resultado selado depois** | **Sim, por testemunha** | `decisionsHead == entrada pendente` ⇒ `RECEIPT_LOST_WITNESSED`; **se a pendente for movida, `HISTORY_REGRESSED` ⇒ falha fechada** |
| Idem, **com resultado pendente de origem NÃO comprovada** (rotação de chave, chave revogada, servidor sem autenticador) | **Sim, por indício** | O indício afirma uma posição que o histórico de hoje não tem ⇒ `UNTRUSTED` ⇒ falha fechada (R4-MINOR-1; matriz em `link-audit-decisions-witness-rotation`) |
| Idem, **SEM nenhum vestígio de resultado** (nenhum resultado, ou o pendente e seu recibo também removidos), e a pendente é **movida para a quarentena** | **NÃO** | **LIMITE BLOQUEADOR:** a decisão revogada volta a valer (travado em teste). O procedimento proíbe; o sistema não impede. Só o livro de cabeças fecha |
| Idem, com a entrada **adulterada** além disso | **Sim** | Origem `INVALID` (e, com testemunha, `HISTORY_DIVERGES`) |
| Pasta inteira de recibos/dados da auditoria apagada (as **duas**) | **Não** | Sem guarda externa do `head` (RV-03b) |

**Risco residual aceito (decisão do responsável):** a impossibilidade de distinguir *universalmente* uma gravação interrompida de um recibo removido, **desde que a ambiguidade falhe de forma segura e nunca reative** uma decisão revogada. **Essa condição só está demonstrada enquanto existe testemunha ou a pendente permanece no lugar**; a janela sem testemunha com quarentena manual é um **BLOQUEADOR** (§4.5), não um risco aceito.

## 8. Limites do modelo de UM diretório comprometido

| Quem escreve só em… | Consegue | NÃO consegue | Detecção |
|---|---|---|---|
| **Decisões** | Criar pendente forjada (bloqueia a auditoria); adulterar confirmadas | Fazer a forja virar confirmada; reviver revogada | Selo/encadeamento/recibo (confirmadas); etiqueta (pendentes) |
| **Recibos das decisões** | Remover o último recibo (cria ambiguidade); criar o recibo de uma pendente **legítima** (**desde 16/11/2026** isso só a leva à fase C, que **só o autor conclui**: escrita ou `RECOVER` de outro operador recebe `PENDING_UNCONFIRMED` — spec do livro §16.16) | Forjar conteúdo; reviver revogada (a decisão fica EM DÚVIDA); **promover pendente alheia a confirmada** | Testemunha (se houver); etiqueta |
| **Resultados** | Criar pendente forjada (bloqueia) | Torná-la confirmada | Etiqueta; `explains`; hashes |
| **Recibos dos resultados** | Remover o último; confirmar uma pendente **legítima** sem ação do operador (pula as reconferências da conclusão) | Forjar conteúdo | Etiqueta; recibo ausente |
| **Evidências** | Fabricar fatos com integridade "OK" | Fazê-los **autênticos** ou finalizáveis | Manifesto assinado (ADR 6C-03) |
| **Manifestos** | Apagar (disponibilidade) | Criar/alterar (sem a privada) | Assinatura |
| **Duas pastas de dados + recibos** | Reescrever o histórico confirmado coerentemente | — | **Não detectado** sem guarda externa do `head` |

## 9. Formato persistido, compatibilidade e rollback

- Campo **aditivo e opcional** `origin` nos esquemas estritos; `schemaVersion` permanece 1; `origin.v` versiona a etiqueta. O formato da etiqueta mudou **dentro desta mesma remediação** (id independente do segredo, HKDF): **não existe nenhum arquivo com o formato anterior fora da árvore de trabalho**.
- **Dados legados** (sem `origin`): continuam legíveis e valem quando **confirmados**. Se pendentes, **não são concluídos automaticamente** (`originDetail: MISSING`; quarentena).
- **Retrocesso de versão:** arquivos **com** `origin` **não são aceitos** pela imagem anterior (esquema estrito). Como a 6B/6C **não foram implantadas**, a **primeira implantação deve ser já com esta versão**.
- **Conformidade da 6B** versionada: v1 congelada; v2 **regenerada em 01/11/2026** (id de chave independente + `ambiguousDecisionIds`), com teste de que a diferença para a v1 se limita ao decidido.

## 10. Garantia × teste que a demonstra

| Garantia | Teste |
|---|---|
| RV-01/RV-04 e 14+ variantes de forja recusadas | `link-audit-origin-protocol`, `link-audit-decisions-api`, `link-audit-scoring-results-api`, navegador B13 |
| Política de chaves (fraca, id independente, planejada, comprometimento, ambiente) | `link-audit-origin-keys` |
| Remoção do recibo de revogação / substituição / meio da cadeia / testemunha / recuperação legítima | `link-audit-decisions-revocation-receipt`, `link-audit-decisions-recovery` |
| Revogação nunca reativada: com a pendente no lugar (EM DÚVIDA) **e** com ela removida/movida quando há resultado selado depois (histórico NÃO resolvido); **sem** resultado selado depois e pendente movida, **NÃO** (limite BLOQUEADOR, §4.5) | `…revocation-receipt`, `link-audit-scoring-preview-service` |
| FIFO e arquivos especiais em todos os leitores (decisões, recibos, resultados, recibos de resultados, evidências, manifestos) | `link-audit-special-files` |
| Serviço e rotas recusam gravar/concluir sem autenticador (a trava da primitiva não tem teste isolado) | `link-audit-origin-protocol`, `link-audit-decisions-api`, `link-audit-scoring-results-api` |
| Interface: sem botão sem origem comprovada; ambiguidade e estado estruturado da testemunha a **todos** os perfis, nas decisões **e** nos resultados (R3-MINOR-5) | `link-audit-audit-page-render/validators/controller` |
| Testemunha: quarentena, restauração parcial, reinício, falha de leitura, concorrência, recuperação legítima, API com operador diferente do autor, navegador | `link-audit-decisions-revocation-receipt`, `link-audit-decisions-api`, I7 B16 |

## 11. Adendo (02/11/2026) — LIVRO DE CABEÇAS: fecha a janela sem testemunha para auditorias INSCRITAS (decisões Q1–Q7)

> **Status:** implementado localmente, **sem commit**; contrato normativo em `onda6c-especificacao-livro-de-cabecas.md` §16. Este adendo **não altera** nada do que os §1–§10 afirmam; acrescenta uma segunda testemunha e **delimita o que ela não cobre**.

**Problema que ficou aberto (BLOQUEADOR do §4.5).** A testemunha de resultados só conhece o que um resultado selado já registrou: a janela abre na revogação/substituição e só fecha no próximo resultado. Quem escreve em duas pastas (recibo + arquivo) reativa uma decisão revogada sem que o sistema perceba.

**Decisão.** Um **livro de cabeças** por auditoria, em pasta e **chave exclusivas** (`GMN_LINK_AUDIT_DECISIONS_LEDGER_DIR`, `GMN_LINK_AUDIT_LEDGER_KEY`; domínio `LEDGER`, HKDF próprio; a configuração é recusada se id ou material coincidirem com os da chave de origem). Cada operação de decisão passa a ter `INTENT` (antes de publicar a entrada) e `CONFIRMED` (depois do recibo), publicados por `link()` exclusivo: **a exclusão mútua entre processos vem do disco, não de memória**. Quem apaga o recibo, move a entrada ou trunca o histórico produz uma contradição com o livro (`HISTORY_REGRESSED`, `RECEIPT_REMOVED`, `HISTORY_DIVERGES`…) mesmo **sem nenhum resultado selado**.

**Alternativas avaliadas e descartadas.** (a) Derivar a chave do livro da de origem ("sem segredo novo"): descartada por decisão Q3 — o comprometimento de uma não pode autenticar a outra. (b) Livro com cabeça vazia quando o histórico some: descartada por decisão Q1 — ausência jamais vira "nada aconteceu". (c) Adoção automática do histórico existente: descartada por Q1/Q7 — conceder confiança a histórico de proveniência desconhecida é decisão **administrativa**, e o sistema **não tem** papel administrativo (Q5); fica bloqueada (`ADMIN_APPROVAL_UNAVAILABLE`) e **especificada** (§16.8). (d) Mutex em memória: insuficiente entre processos.

**Consequências.**
- Auditorias **inscritas** (hoje: só **vazias**) ganham a proteção; **legadas** ficam `LEGACY_READ_ONLY` (nenhuma decisão vigente) — a janela **continua aberta para elas** e para qualquer ambiente em que o livro esteja `NOT_REQUIRED` (apenas a 6B isolada, nos testes).
- Resultados novos carregam `ledgerHead` (v2); resultado e livro se testemunham mutuamente. O livro **informa** à testemunha de resultados se a auditoria já teve resultado, para que o livro removido que um resultado cita seja `LEDGER_REMOVED_WITNESSED` e nunca "legada".
- **Não detecta** rollback coordenado de todos os volumes nem escrita simultânea em ≥ 2 pastas incluindo o livro: isso exige a **guarda externa** (Q6), cuja porta existe, o adaptador é só sintético, e que é **BLOQUEADOR de produção**.
- Quem tem a chave do livro **e** escrita na pasta do livro forja registros até a revogação do id (limite declarado; runbook §7).
- O livro é um **segundo ponto de congelamento**: quem só escreve no livro pode tornar uma auditoria `HISTORY_UNRESOLVED` (disponibilidade, não falsificação) — falha fechada por desenho, sem reabertura pela aplicação enquanto a operação administrativa não existir.

### 11.1 Atualização (03/11/2026) — revisão nº 6 e decisões de rigor

- **Época de chave pela ordem da cadeia (R6-06).** A decisão original deixava a chave aposentada verificar qualquer posição enquanto válida; isso permitia que quem a possuía anexasse registros NOVOS. Passou a valer: depois que outra chave assina, a anterior não reaparece (`keyEpochViolation`). Alternativa descartada: usar a hora gravada (`recordedAt`) — quem forja a escolhe. Alternativa descartada: invalidar a aposentada por data de rotação configurada — é dado do operador, não da cadeia, e a janela até a 1ª operação existiria igual. **Limite que permanece:** a janela entre a rotação e o primeiro registro da chave nova.
- **Testemunhas antes das receitas (R6-05).** Uma recuperação grava um registro novo; se um resultado (ou a guarda) cita uma posição que o livro perdeu, recuperar apagaria a possibilidade de restaurar o original. Agora o desacordo bloqueia qualquer receita.
- **Durabilidade observada (R6-07).** Com o livro, o `fsync` de diretório deixa de ser melhor-esforço na entrada, no recibo e nos registros do livro. Alternativa descartada: mudar `publishExclusive` para todos (quebraria o contrato diferencial da 6B e das evidências); a observação é opt-in por `watchDurability`. **Limite:** sem o livro e nos resultados o risco P-4 permanece.
- **Q5 (03/11/2026).** Adoção de histórico não vazio, `QUARANTINE_ACK` e `RESTORE_ACK` exigem autorização administrativa com dupla aprovação; indisponíveis até o mecanismo existir. Inscrição de auditoria vazia continua, com vacuidade verificável.

### 11.2 Atualização (04/11/2026) — revisão nº 7 (R7-01 a R7-11)

Decisões: (a) a capacidade do livro é política por **classe** (decisão nova ≤ MAX−manutenção−reserva; revogação ≤ MAX−manutenção; manutenção ≤ MAX) e a vista anuncia só o que a mesma função executa; (b) `CHECKPOINT` de rotação é manutenção com reserva própria e o `RECOVER` o grava também com operação aberta; (c) durabilidade faz parte do protocolo: sucesso só com decisões, recibos e livro sincronizados (inclusive o pai da pasta nova e o reenvio de entrada já confirmada); (d) `RECOVER`/recuperações relêem a testemunha antes de cada gravação e nunca removem a pendência; (e) a idade de uma operação aberta com hora gravada no futuro vem do tempo monotônico observado. **Não** foi criada ação administrativa nova; a reabertura/segmentação por época continua pendente de papel administrativo (§16.8/§16.12). Ver `onda6c-relatorio-remediacao-7.md`.
