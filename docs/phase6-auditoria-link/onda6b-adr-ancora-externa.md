# ADR — Âncora externa e `expectedHead` para o histórico de decisões (Onda 6B)

Status: **aceita pelo usuário em 28/10/2026** (opção "expectedHead obrigatório + pasta de âncoras separada"); escrita **antes** da implementação, conforme o plano da revisão adversarial. Nada neste ADR altera a régua de pontuação (D3B) nem o motor.

> **Emenda 1 (28/10/2026, ao final deste documento):** a revisão do código achou uma janela residual — uma decisão publicada cujo recibo falhou era devolvida como sucesso (201 `anchored:false`) e a sua perda não era detectada. O protocolo de publicação foi alterado: **uma decisão só é confirmada com o recibo; entre os dois ela é PENDENTE**. Onde este texto original diz que a próxima escrita "repara" a âncora e que a resposta é 201 com `anchored: false`, vale a Emenda 1.

## 1. Problema
O histórico de decisões é uma cadeia de arquivos `dNNNN.json` (cada um com o SHA-256 do anterior). Uma cadeia detecta alteração **no meio**, mas **não** detecta a perda do **fim**, porque nenhum arquivo posterior o referencia. A revisão adversarial confirmou, no código, que todos estes casos terminavam com `integrity: OK`:
1. apagar o último arquivo (ou vários sufixos);
2. alterar o último arquivo e recalcular o seu `contentSha256`;
3. **apagar a última revogação**: a decisão revogada volta a `ACTIVE` e entra em `operatorRecords`;
4. restaurar um backup antigo da pasta de decisões (erro operacional, não malícia).
Isso contradiz a decisão aprovada "sem alteração ou exclusão silenciosa de decisões anteriores".

## 2. Decisão
Duas defesas complementares, ambas testáveis e compatíveis com o armazenamento em arquivos:

**(A) `expectedHead` obrigatório nas escritas.** Todo `POST` (criar/revogar) envia o `head` que o operador viu: `{ "seq": n, "sha256": "…" }`, ou `null` quando o histórico estava vazio. A comparação ocorre **dentro da trava**, com o estado relido do disco:
- igual ⇒ segue; diferente ⇒ **409 `HEAD_MISMATCH`** (alguém gravou, ou a visão do operador está velha);
- `expectedHead.seq` maior que o `seq` atual ⇒ **409 `HISTORY_REGRESSED`** (o histórico "andou para trás": truncamento ou backup antigo);
- ausente ⇒ 400. A resposta de erro traz o `head` atual (o operador é autenticado).
Efeito colateral útil: elimina "escrita às cegas" sobre uma visão desatualizada.

**(B) Pasta de âncoras separada** (`GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR`, **obrigatória**, fail-closed). Para cada entrada `dNNNN.json` existe um recibo imutável `<âncoras>/<auditId>/aNNNN.json` com `{ auditId, seq, headSha256, anchoredAt, prevAnchorSha256 }`, selado e encadeado, escrito **depois** da entrada. As âncoras devem ficar em **outro local de gravação** (outro volume/disco e, idealmente, outro backup) — ver `deploy/hostinger/PLANO-DE-VOLUME-DE-DECISOES.md`.

Verificação em **toda** leitura e escrita:
- cada âncora precisa apontar uma entrada existente **com o mesmo hash** ⇒ âncora à frente do histórico = **409 `DECISIONS_TRUNCATED`**; hash diferente = **409 `ANCHOR_MISMATCH`**;
- as âncoras têm o mesmo rigor das decisões (sequência sem lacunas, `auditId`, número = nome, encadeamento, bytes canônicos, sem symlinks);
- **no máximo 1** entrada pode estar sem âncora (janela de queda entre gravar a entrada e gravar a âncora); mais que isso é falha de integridade;
- ~~na **escrita**, a âncora faltante é **reparada antes** de gravar a decisão nova~~ **SUBSTITUÍDO pela Emenda 1:** uma pendente não é "reparada" por um pedido qualquer (isso a legitimaria); nada novo é gravado sobre ela (409 `PENDING_UNCONFIRMED`) e só o reenvio do mesmo pedido pelo autor conclui o recibo;
- ~~se a âncora falhar **depois** da decisão ter sido publicada, a resposta é 201 com `anchored: false` (a decisão existe) e a próxima escrita repara.~~ **SUBSTITUÍDO pela Emenda 1:** a resposta é 503 `ANCHOR_PENDING` (nunca sucesso), a decisão fica PENDENTE e só o reenvio idêntico do autor a conclui.
`GET` devolve `anchors: { count, lastSeq, unanchored }`.

## 3. O que passa a ser detectado
| Cenário | Antes | Depois |
|---|---|---|
| Apagar o último arquivo / vários sufixos de decisões | não | **sim** (`DECISIONS_TRUNCATED`) |
| Refazer o hash do último arquivo | não | **sim** (`ANCHOR_MISMATCH`) |
| Apagar a última revogação (ressuscita decisão) | não | **sim** |
| Restaurar backup antigo das decisões | não | **sim**; e a escrita seguinte também falha por `HISTORY_REGRESSED` se o cliente tinha visto mais |
| Escrita sobre visão desatualizada | só por conflito de regra | **sim** (`HEAD_MISMATCH`) |
| Apagar só âncoras (≥ 2) | — | **sim** (mais de 1 sem âncora) |
| Apagar o último arquivo **ainda sem recibo** (pendente) | não | **não acusa — e não precisa**: nunca foi confirmado, nenhuma promessa foi feita (Emenda 1) |

## 4. O que NÃO é detectado (limites assumidos)
1. **Adulteração coordenada das duas pastas** (decisões e âncoras) por quem tem escrita em ambas — inclusive `root` na VPS. A defesa é a separação dos locais de gravação e dos backups; não há assinatura.
2. Apagar **uma** âncora e **nenhuma** decisão é indistinguível de uma queda no meio da gravação: vira uma decisão **PENDENTE** (não vale e não é sucesso; Emenda 1).
3. Apagar a **última** decisão **e** a **última** âncora ao mesmo tempo (as duas pastas) só é detectado se o cliente guardou o `head` (`expectedHead` ⇒ `HISTORY_REGRESSED`).
4. O hash é SHA-256 de conteúdo, **não assinatura** (não prova quem escreveu). Assinatura por HMAC foi avaliada e **não** adotada agora: não detecta truncamento nem restauração, e um aplicativo comprometido tem a chave.

## 5. Alternativas consideradas
- **Só `expectedHead`:** barato, mas leitores que não escrevem (6C, PDF) não detectam nada.
- **Só âncora:** detecta nas leituras, mas não protege contra escrita sobre visão velha.
- **HMAC das entradas:** ver 4.4.
- **Âncora no Supabase:** descartada (RLS pendente, sem staging).

## 6. Consequências operacionais
- Produção precisa de **dois** locais de gravação para o web: decisões e âncoras (ambos fora da raiz do contêiner, que é somente leitura). Só plano; `stack.yml` não foi alterado.
- Sem a variável de âncoras, as rotas respondem 503 (`ANCHOR_NOT_CONFIGURED`) e nada é gravado.
- A pasta de âncoras tem o mesmo tratamento das decisões: nunca apagar, nunca sobrescrever, backup independente.
- Recuperação após falha: nunca apagar arquivos para "destravar"; mover para quarentena e investigar (ver `onda6b-decisoes-humanas.md`, seção de recuperação).
- Na 6C o resultado de pontuação deve **fixar** o `head` das decisões usadas, para detectar divergência posterior.


---

## Emenda 1 (28/10/2026) — Protocolo de publicação: a decisão é PENDENTE até o recibo

### E1.1 Achado (BLOCKER) e reprodução
Cenário apontado na revisão: histórico íntegro até `d0010`/`a0010`; o servidor grava `d0011`; a gravação de `a0011` falha; a API responde **201** com `anchored:false`; antes de qualquer outra escrita `d0011` é excluído ou perdido; o armazenamento volta a mostrar `d0010` + `a0010`.

Confirmado por teste automatizado **antes** da correção (`tests/link-audit-decisions-recovery.test.ts`, os dois primeiros testes, vermelhos no código antigo):
1. a janela existia (`d0011` publicada, `a0011` ausente) e a resposta era **sucesso**;
2. o leitor devolvia o histórico como **íntegro** (`head` = 10, `anchors` 10/10, sem alarme) — a perda de `d0011` era invisível;
3. consequência: qualquer outro operador, sem o `head` da resposta perdida, gravava uma **outra** decisão no número 11, substituindo em silêncio a que o servidor tinha prometido.

Classificação: **BLOCKER**. Contradiz o objetivo do B1 (nenhuma exclusão silenciosa) e a própria tabela do §3 ("apagar o último arquivo: detectado"), que só valia depois do recibo. A janela não era curta: durava até a *próxima escrita* (que pode nunca vir), e o leitor tratava a cauda sem recibo como confirmada (`unanchored` era só um contador).

### E1.2 Causa
Duas falhas combinadas: (a) a **ordem** (decisão → recibo) devolvia sucesso **entre** os dois passos; (b) o **leitor** não distinguia "confirmada" (arquivo + recibo) de "publicada" (só o arquivo). Esconder o erro na resposta HTTP não resolveria: o problema é o que o servidor **promete** e o que o leitor **aceita**.

### E1.3 Alternativas avaliadas
| Opção | Veredito |
|---|---|
| **A.** Só mudar o status HTTP | Rejeitada: o leitor continuaria aceitando a cauda sem recibo como válida; esconde o erro. |
| **B.** Recibo/intenção **antes** da decisão (write-ahead) | Rejeitada: um recibo à frente do histórico é indistinguível de truncamento. Uma queda (ou `ENOSPC` na pasta de decisões) depois do recibo travaria a auditoria em `DECISIONS_TRUNCATED`, e recibos não podem ser apagados. Tornar "recibo à frente por 1" tolerável reabre exatamente o B1 para a última decisão. |
| **C.** Intenção durável + decisão + confirmação (3 arquivos) | Não adotada agora: mais estados e mais arquivos para provar a mesma coisa; só acrescentaria *autenticidade da cauda* (ver E1.7). Fica como evolução possível. |
| **D.** HMAC nas entradas | Não adotado (ADR §4.4): não detecta truncamento nem restauração. Seria a defesa específica contra cauda forjada. |
| **E.** Decisão → recibo, **sucesso só com os dois**, pendente não vale, reenvio idempotente | **Adotada.** Preserva os arquivos (formato v1 intacto, fixture de ouro inalterada) e a regra "nunca apagar". |

### E1.4 O protocolo
Estados de uma entrada `n`:
| Estado | Arquivos | Vale? | Perda é detectada? |
|---|---|---|---|
| **CONFIRMADA** | `dNNNN` **e** `aNNNN` (hash igual) | **sim** | **sim** quando o ARQUIVO da decisão some ou muda (recibo à frente do histórico = `DECISIONS_TRUNCATED`; hash diferente = `ANCHOR_MISMATCH`). **Exceção:** a remoção SÓ do recibo da última entrada é indistinguível de uma pendente (E1.7 item 5) |
| **PENDENTE** | só `dNNNN` (no máximo 1, a última) | **não** | não, e não precisa: nenhuma promessa foi feita sobre ela |
| (inexistente) | — | — | — |

**Escrita** (sob a trava por auditoria): (1) ler e verificar decisões + recibos; (2) reconhecer reenvio (E1.5); (3) se houver pendente e o pedido **não** for o reenvio dela → 409 `PENDING_UNCONFIRMED`, **nada** é gravado; (4) conferir `expectedHead` e as regras de domínio; (5) publicar `dNNNN` (atômico); (6) gravar `aNNNN` (até 3 tentativas imediatas; `EEXIST` só é aceito se o recibo existente for **idêntico** ao esperado); (7) **somente aqui** devolver sucesso. Se (6) falhar: **503 `ANCHOR_PENDING`** com o `head` **confirmado** e a pendente; nenhum campo de sucesso.

**Leitura:** `head`, `decisions`, `allDecisions`, `history` e `operatorRecords` são só os das **confirmadas**. A pendente vem à parte em `pending` (com `confirmed:false` e o registro enviado, para o autor reenviar) e a resposta traz `finalizable` (`false` enquanto houver pendente). A 6C **não pode finalizar** pontuação com `finalizable:false` e deve fixar o `head` confirmado. As âncoras são lidas **antes** das decisões e uma falha entre as duas pastas é relida uma vez antes de ser acusada (uma escrita concorrente não gera falso `DECISIONS_TRUNCATED`). Ao concluir uma pendente por reenvio o servidor **revalida** o que a gravação original já exigia: data nem posterior ao relógio do servidor nem anterior à da entrada anterior (monotonia), captura/revisão de relatório que **existem** no serviço de evidências (por existência: uma captura nova depois da gravação não invalida o reenvio legítimo) e contrato da 6A sobre o conjunto vigente; se algo não confere, ela continua pendente (409 `PENDING_UNCONFIRMED` com os motivos).

### E1.5 Reenvio idempotente
Um pedido é **reenvio** se a entrada logo depois da visão do operador (`expectedHead`) está encadeada a ela, é do **mesmo autor** e tem **exatamente a mesma operação** (criação: `record` normalizado + `supersedes`; revogação: `revokes` + `reason`). Hora, número, hash e `basis` não entram (o servidor os escolhe). Consequências:
- resposta perdida / `ANCHOR_PENDING` / queda: reenviar o mesmo corpo é **seguro**; nunca grava duas vezes (testes: 6 reenvios simultâneos gravam 1; reenviar 2× não altera nenhum arquivo);
- reenvio de pendente → grava só o recibo que faltava (**200**, `replayed:true`); reenvio de confirmada → **200**, sem gravar; `head` devolvido é sempre o **atual**;
- **outro operador**, outro conteúdo ou visão que não confere nunca é reenvio (cai nas regras normais: `HEAD_MISMATCH` etc.);
- reenviar não ressuscita nem reaplica: se a decisão foi revogada depois, o reenvio devolve a decisão com `status: REVOKED`.

### E1.6 Contrato (mudanças — só onde a falha exigia)
| Antes | Depois |
|---|---|
| 201 com `anchored:false` | **503 `ANCHOR_PENDING`** (`Retry-After: 5`, `head` confirmado, `pending`) |
| qualquer escrita "reparava" o recibo da cauda | **409 `PENDING_UNCONFIRMED`**; só o reenvio do autor conclui |
| `head`/`history`/`operatorRecords` incluíam a cauda sem recibo | só confirmadas; `pending` à parte |
| 201 sempre | 201 = decisão nova confirmada; **200** = reenvio (`replayed:true`) |
| `anchored: boolean` | `anchored: true` (constante: sucesso ⇒ arquivo + recibo) |
Inalterados: formato dos arquivos `dNNNN`/`aNNNN` (fixture de ouro v1), `expectedHead`, códigos de integridade, trava, unicidade por `link()` e a régua D3B.

### E1.7 Limites residuais (honestos)
1. **Disponibilidade vs. segurança:** uma pendente cujo autor não volta **bloqueia** novas escritas nessa auditoria (fail-closed, escolhido). Leituras continuam. Liberar: runbook em `onda6b-decisoes-humanas.md` §15.
2. **Cauda forjada** (quem só escreve na pasta de decisões): **CORREÇÃO (remediação do MAJOR-1, 6C-02):** o texto original afirmava que só o reenvio *idêntico* do suposto autor a confirmaria "e aí o conteúdo é o que ele próprio enviou". **Isso era falso**: o pedido que o autor reenvia é montado pela interface a partir do próprio arquivo, então uma cauda forjada citando o autor era CONFIRMADA quando ele a concluía (RV-04). A opção D (HMAC, chave do servidor fora das pastas) foi **adotada** (`onda6c-adr-prova-de-origem.md`): a conclusão de uma pendente exige a etiqueta de origem; sem ela, 409 `PENDING_ORIGIN_UNPROVEN`. Uma cauda forjada **continua podendo bloquear** as escritas até a quarentena, mas nunca vale.
3. Perda **coordenada** das duas pastas continua não detectada pela leitura isolada (§4.1); o `expectedHead` guardado pelo cliente a acusa (`HISTORY_REGRESSED`). A pendente não é "protegida": só confirmada o é.
4. Reenvio é reconhecido por **conteúdo**: dois envios idênticos sobre a mesma visão contam como um. É o comportamento desejado para idempotência. O cliente deve conferir `replayed` e `decision.status`: reenviar uma decisão que já foi revogada devolve 200 com `status: REVOKED` (não a recria).
5. **Recibo removido da última entrada confirmada:** é indistinguível de uma pendente. **CORREÇÃO (2ª revisão, 01/11/2026):** o texto original aceitava que, sendo uma REVOGAÇÃO, a decisão revogada "volta a aparecer vigente em `operatorRecords`" apenas **sinalizada** por `pending`/`finalizable:false`; **isso foi considerado inseguro** (a prévia aplicava a decisão e o remover-recibo "ressuscitava" a decisão) e **substituído**: a decisão alvo de uma operação pendente (revogação **ou** substituição) fica **EM DÚVIDA** (`AMBIGUOUS`): **fora** de `decisions`/`operatorRecords`, do motor e da prévia, e as escritas continuam bloqueadas. Aplicar a revogação pendente provisoriamente continua **rejeitado** (uma cauda forjada passaria a produzir efeito sem confirmação); a nova regra não aplica nem a revogação nem a decisão: **suspende ambas**. A defesa adicional é o `head` guardado fora do armazenamento e a testemunha do `decisionsHead` dos resultados confirmados (quando existe).
6. **Durabilidade:** "decisão e recibo duráveis" é o `fsync` de cada arquivo; o `fsync` do diretório (`syncDirectory`, compartilhado com as evidências) é *best-effort*. Numa queda de energia pode sobrar um recibo sem a decisão — isso é detectado (`DECISIONS_TRUNCATED`), mas o 2xx não garante o `fsync` do diretório.
7. A cauda forjada pode ter o mesmo conteúdo que o autor enviaria; a data (futura ou anterior à entrada anterior), a captura/revisão (inexistentes) e o contrato são revalidados na conclusão (uma pendente legítima com a data ligeiramente à frente de um relógio recuado por NTP fica bloqueada até o relógio alcançá-la; nunca é bypass), mas o conteúdo em si é o que o autor mandou. O texto de uma pendente (possivelmente forjada) é exibido em `pending`: a UI (6C) deve **escapar** todo texto livre.

### E1.8 Verificação
`tests/link-audit-decisions-recovery.test.ts`: reprodução do cenário (10 entradas); invariante "sucesso ⇒ perda detectável" em 4 modos de falha do recibo; **queda simulada após cada operação de disco** da criação e da revogação (a varredura vai até a gravação completa): histórico nunca ilegível, nenhum sucesso sem os dois arquivos, reenvio converge para exatamente uma decisão; matriz de truncamento (último, sufixos, todos, pasta inteira, última revogação) e restauração (só decisões, só recibos, as duas, arquivo re-selado); recibos removidos; pendente perdida; entrada forjada; idempotência; concorrência; fuzz determinístico (3 sementes × 160 passos) com modelo "nada prometido se perde ou é trocado". Mutação do protocolo: ver `onda6b-decisoes-humanas.md` §13.
