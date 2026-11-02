# Onda 6C — Modelo de ameaças da RECUPERAÇÃO de pendências e da fronteira de evidências

> **Status:** acompanha o ADR 6C-02 (`onda6c-adr-prova-de-origem.md`), o ADR 6C-03 (`onda6c-adr-proveniencia-evidencias.md`) e o runbook de chaves (`onda6c-runbook-chaves.md`); código **sem commit** até a revisão independente da rodada e a autorização do responsável. Revisado em 01/11/2026 conforme as decisões do responsável.
>
> **Regra:** cada afirmação "NÃO consegue" abaixo tem teste que a demonstra (coluna "Prova"); o que **não** está demonstrado está marcado como **limite**.

## 1. O que se protege

| Ativo | Por quê |
|---|---|
| **Decisão humana ACTIVE** (6B) | Alimenta o motor; tem **autoria** (quem decidiu o quê). |
| **Resultado confirmado** (6C, em especial PONTUADO) | Consumido pela Onda 7 (PDF) e pelo cliente; um índice indevido é o pior desfecho. |
| **Fatos que o motor recebe** (evidências) | Um resultado "com origem comprovada" sobre fatos fabricados é enganoso. |
| **Integridade do histórico** (cadeia + recibos) | Detecta perda/alteração do fim do histórico. |
| **Disponibilidade do processo web** | Um único processo atende todas as auditorias. |

## 2. Atores e fronteiras de confiança

- **Operador legítimo:** sessão (cookie assinado) + lista `GMN_OPERATOR_EMAILS`. Confiável para o que faz com a própria sessão; **pode ser induzido pela interface** a confirmar o que ela mostra.
- **Servidor web:** confiável; conhece a **chave de origem** (HMAC) e só a parte **pública** das chaves de atestação de coleta.
- **Quem atesta a coleta:** detém a **chave privada** Ed25519 **fora da VPS**.
- **Pastas de dados** (decisões, recibos das decisões, resultados, recibos dos resultados, evidências, manifestos): **não confiáveis quanto ao conteúdo**; quem escreve numa delas a controla por inteiro.
- **Fora de escopo:** sessão roubada; root no host com acesso à memória/ambiente do processo; comprometimento simultâneo das chaves **e** da pasta.

## 3. Cenário obrigatório e invariantes

**Atacante A1:** escreve em **apenas uma** pasta de dados; não tem a sessão de um operador, não controla as outras pastas e não tem segredos do servidor (chave de origem) nem a privada de atestação.

> **I1:** uma operação criada ou adulterada **somente nessa pasta** nunca se torna CONFIRMADA/ACTIVE/PONTUADA porque um operador acionou a recuperação.
> **I2:** uma operação pendente **nunca** faz uma decisão revogada/substituída voltar a ser tratada como vigente (fica **EM DÚVIDA**, fora do motor), e **nunca** habilita a finalização. **Remover ou mover um arquivo (pendente, recibo, quarentena) ou perder a testemunha NÃO reativa decisão**: se a testemunha (resultados selados) mostra retrocesso, divergência ou indisponibilidade, o histórico fica **NÃO RESOLVIDO** — zero decisões vigentes, motor sem decisões, nada finalizável, escritas recusadas. **LIMITE BLOQUEADOR:** sem nenhum resultado selado DEPOIS DA REVOGAÇÃO (um resultado selado entre a criação da decisão e a revogação NÃO protege — R4-MINOR-2) não há testemunha, e a quarentena manual de uma pendente `PROVEN` de revogação reativa a decisão sem que o sistema detecte (ADR 6C-02 §4.5).
> **I3:** fatos que só existem porque alguém escreveu na pasta de evidências **nunca** são tratados como autênticos nem finalizados.

## 4. Matriz: quem escreve onde × o que tenta × resultado

| # | Atacante / ação | Antes (bd7c4fb) | Depois | Prova |
|---|---|---|---|---|
| 1 | Pasta de **decisões**: forja `d000N` em nome de ANA; ANA usa "Reenviar" | **ACTIVE** (RV-04) | 409 `PENDING_ORIGIN_UNPROVEN`; bloqueia; autor/conteúdo ocultos | `link-audit-origin-protocol`, API, navegador B13a/b |
| 2 | Pasta de **resultados**: forja `s000N` PONTUADO; o autor nomeado "conclui" | **PONTUADO** (RV-01) | 409 `RESULT_PENDING_ORIGIN_UNPROVEN`; sem recibo | idem, B13c/d |
| 3 | Adultera pendente **legítima** (muda e **refaz o selo**) | Concluída | Recusada (`INVALID`) | protocolo |
| 4 | **Copia a etiqueta** de uma entrada legítima | n/a | Recusada | protocolo |
| 5 | Forja a **REVOGAÇÃO** de uma decisão vigente | Concluída | Recusada; a decisão fica **EM DÚVIDA** (não vigente, não revogada) | protocolo, `…revocation-receipt` |
| 6 | Arquivo **anterior** à proteção (sem etiqueta), pendente | Concluído | Recusado (`MISSING`): **não é confirmado automaticamente** | protocolo |
| 7 | Servidor **sem chave** / chave **desconhecida** / **revogada** / **vencida** | n/a | Recusado; escritas 503 | `…origin-keys`, protocolo, API |
| 8 | **Outro operador** tenta concluir | 409 | 409 e **não vê o conteúdo** | protocolo |
| 9 | Remove o **último recibo** de uma **REVOGAÇÃO** confirmada | Decisão revogada **voltava a ser vigente** (RV2-A3b) | Decisão **EM DÚVIDA**; fora do motor/prévia; `finalizable:false`; todos os perfis veem o problema; recuperação pelo autor (origem comprovada) | `…revocation-receipt` |
| 10 | Remove o último recibo havendo resultado selado depois | sem sinal | `RECEIPT_LOST_WITNESSED` (incidente) | `…revocation-receipt` |
| 10b | **Idem + move a pendente para a quarentena** (R3-MINOR-2) | decisão revogada **voltava a valer** | **`HISTORY_REGRESSED`: histórico NÃO resolvido**, zero decisões vigentes, motor sem decisões, escritas recusadas | `…revocation-receipt`, API, B16 |
| 10c | **Idem, mas SEM resultado selado POSTERIOR à revogação** (nenhum resultado; só resultados anteriores; ou todos os vestígios removidos) | decisão revogada volta a valer | **IGUAL (limite BLOQUEADOR)**: o sistema não detecta; a janela abre na revogação e fecha no próximo resultado selado. Antes do ataque a tela declara `unwitnessedAffecting > 0` | `…revocation-receipt`, `…witness-rotation` (travados como limite) |
| 10e | **Rotação de chave (R4-MINOR-1)** + recibo do resultado e da revogação removidos + `d0002` em quarentena; chave antiga **vencida / revogada / desconhecida / sem autenticador** | decisão revogada **voltava a ACTIVE e era FINALIZADA** (RV4-A7) | Resultado pendente vira **indício** que contradiz o histórico ⇒ **`UNTRUSTED`**: zero vigentes, escritas recusadas, nada finalizável. Aposentada **válida**: `HISTORY_REGRESSED` (continua testemunha) | `…witness-rotation` (matriz 6 situações de chave × 5 perdas de prova), B17 |
| 10f | **Dependência da testemunha ausente/relativa/sobreposta/inexistente/ilegível (INFO-1)** | `NOT_CONFIGURED` **não bloqueava** (lista mostrava a revogada como vigente; prévia `allowed=true`) | **Falha fechada** (`NOT_CONFIGURED`/`UNAVAILABLE`): nenhuma decisão vigente, escritas `409 DECISIONS_HISTORY_UNRESOLVED`, prévia não finalizável | `…decisions-api`, `…scoring-preview-api`, `…revocation-receipt`, B17 |
| 10g | Atacante só na pasta de **resultados** planta um pendente que contradiz o histórico | n/a | **Congela** a auditoria (`UNTRUSTED`): falha fechada **declarada** (disponibilidade); destravar exige conferência com backup independente | `…witness-rotation` |
| 10d | A cadeia de resultados (testemunha) é adulterada/ilegível | n/a | adulterada ⇒ `UNTRUSTED`; ilegível (EIO/EACCES/pasta ausente) ⇒ `UNAVAILABLE`: histórico NÃO resolvido (falha fechada) | `…revocation-receipt` |
| 11 | Remove o recibo **e** adultera o arquivo | Concluído | Recusado (`INVALID`; com testemunha, `DIVERGES`) | `…revocation-receipt` |
| 12 | Remove recibo do **meio** da cadeia | detectado | detectado (409, nenhum dado) | `…revocation-receipt` |
| 13 | **FIFO** com nome válido em qualquer pasta lida | **Processo travado** (DoS) | Recusado na hora (`ENOTFILE`) em decisões, recibos, resultados, recibos de resultados, evidências e manifestos | `link-audit-special-files`, B14 |
| 14 | Pasta de **evidências**: captura **nova** forjada pelo pipeline (integridade OK) | Virava resultado "com origem comprovada" (RV2-F1) | `EVIDENCE_NOT_SEALED`: prévia rotulada, **finalização recusada**, nada gravado | `link-audit-evidence-provenance`, rotas, B15 |
| 14b | Pasta de evidências: **apagar a captura/revisão mais recente** (R3-MINOR-1) | o passado autêntico passava a valer | `EVIDENCE_MISSING`: bloqueado, com as referências ausentes | `link-audit-evidence-provenance` |
| 14c | Legado: **reescrever `serper-status.json`** + `SHA256SUMS` (R3-MINOR-3) | suprimia o perfil sem perder `AUTHENTICATED` | `EVIDENCE_HASH_MISMATCH` | `link-audit-evidence-provenance` |
| 15 | Evidência existente **reescrita com selo refeito** | idem | `EVIDENCE_HASH_MISMATCH` | idem |
| 16 | Forja/edita/copia **manifesto** de coleta | n/a | `SEAL_INVALID` (sem a privada) | idem |
| 17 | **Chave de origem vazada** + escrita numa pasta | MAJOR-1 de novo | Rotação por comprometimento: o id vira `KEY_REVOKED`; nenhuma pendência dela é concluída | `…origin-keys` |

## 5. STRIDE do fluxo de recuperação (corrigido)

- **Spoofing** (afirmar autoria que não se tem): o campo "autor" do arquivo **não é prova**; vale a etiqueta do servidor **mais** a sessão autenticada, **para pendentes**.
- **Tampering:** selo + encadeamento + recibo detectam alteração **de confirmados**, **exceto** quem escreve dados **e** recibos coerentemente (limite §6.3). A etiqueta detecta forja/alteração de **pendentes**.
- **Repudiation — LIMITE:** o sistema **não garante** que "todo ACTIVE foi gravado pelo servidor": a etiqueta **não é reverificada** em registros **confirmados** (ADR 6C-02 §5). Quem escreve as duas pastas cria um confirmado sem etiqueta que a leitura aceita (RV2-W1). Recomendação: indicador não bloqueante de origem dos confirmados, e a Onda 7 deve exigir `PROVEN`. *(A redação anterior — "ACTIVE só existe se o servidor o gravou" — era mais forte que o código e foi removida.)*
- **Information disclosure:** o DTO da pendente não revela conteúdo/autor/desfecho quando a origem não é comprovada, nem conteúdo a quem não é o autor; mostra a **todos** apenas ids das decisões em dúvida e rótulos fixos.
- **Denial of service:** pendência forjada **continua bloqueando** a auditoria (aceito: integridade > disponibilidade; quarentena manual); remover manifestos/capturas bloqueia a finalização; FIFO tratado. A pendência de PDF (§8) é separada.
- **Elevation of privilege:** não há ACL por auditoria (todo operador autorizado lê/decide/finaliza qualquer auditoria) — limitação herdada.

## 6. Limites (declarados, sem inventar distinção)

### 6.1 MINOR-2 — "gravação interrompida" × "recibo removido" (revisado após a 3ª revisão)
No disco, a última entrada com etiqueta válida e sem recibo é **a mesma coisa** nos dois casos. **Antes** desta rodada o texto dizia que "nenhum dado diferencia" — **isso era forte demais**: o `decisionsHead` gravado num **resultado confirmado** (outra pasta) é uma **testemunha independente** quando existe um resultado finalizado **depois** da decisão (`RECEIPT_LOST_WITNESSED`). Ela **não resolve todos os casos**: sem resultado posterior, continua ambíguo. O que o sistema faz, demonstrado: nunca reativa a decisão revogada (I2), mostra o problema a todos, não finaliza, e só o autor com origem comprovada, **com confirmação explícita**, recria o recibo do **mesmo** conteúdo. **Risco residual aceito pelo responsável:** a indistinguibilidade universal, desde que falhe de forma segura.
**Proteção adicional para produção (não implementada):** guarda externa do `head` (`seq`+`sha256`) por auditoria, fora dos volumes; alerta quando um `head` conhecido some; ou a intenção durável (alternativa B do ADR 6C-02).

### 6.2 Escrita só na pasta de recibos
Pode remover o último recibo (§6.1) ou **criar o recibo de uma pendente legítima** sem ação do operador — e, com isso, **pular as reconferências da conclusão** (evidência ainda com os mesmos hashes, histórico, coleta autêntica): o servidor recusaria (`EVIDENCE_HASH_CHANGED`) a mesma conclusão, e o recibo plantado a confirma (o resultado aparece como `stale`). Não forja conteúdo. Autenticar os recibos acoplaria toda leitura à chave: **não adotado**.

### 6.3 Escrita nas **duas** pastas (dados + recibos)
Quem refaz dados **e** recibos coerentemente reescreve o histórico **confirmado** sem ser detectado — limite histórico da 6B/6C, só mitigado por backup independente e guarda externa do `head`. A chave de origem impede que esse atacante crie uma **pendência nova** que passe por legítima.

### 6.4 Replay de pendência ou manifesto **autêntico** antigo
Restaurar de backup um arquivo que o servidor **realmente** gravou (ou um manifesto realmente assinado) resulta em algo **autêntico**: é **atualidade**, não autenticidade. A pendência antiga exige ação do autor e passa pelas checagens (evidências, regressão do histórico, coleta autêntica); o resultado nasce marcado como histórico se o estado andou.

### 6.5 Comprometimento de chaves
- **Chave de origem:** quem a tem **e** escreve numa pasta volta ao cenário do MAJOR-1. Resposta: **rotação por comprometimento** (runbook §3), que **corta** a chave vazada (id revogado, material removido) e põe em quarentena as pendências dela. **Rotação planejada** (§2 do runbook) é outra coisa: a antiga só verifica, com validade explícita. Reassinar **não** reabilita.
- **Privada de atestação:** quem a tem atesta qualquer coisa. Resposta: remover a pública da lista (a finalização fecha) e reatestar só o que for conferido por fonte independente.

### 6.6 Pasta de evidências (R2-MINOR-1) — declarada **raiz NÃO confiável**
A integridade (SHA-256) **não** é autenticidade. Com o manifesto assinado, quem escreve só em evidências não consegue fabricar fatos **autênticos**. **Limites:** manifesto autêntico antigo (atualidade); dado falso **atestado** continua falso; janela entre coleta e atestação; custódia da chave privada. Detalhes e plano do lado produtor: ADR 6C-03.

## 7. MINOR-1 — arquivos especiais
`open()` bloqueante de um FIFO nunca retorna e prende uma thread do pool do libuv: poucos arquivos paralisam o I/O de arquivo do processo. O leitor compartilhado abre com `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, confere tipo e tamanho **no descritor** (`fstat`), lê com limite e **falha fechado**. Cobertura demonstrada (processo filho com `SIGKILL` externo): decisões, recibos das decisões, resultados, **recibos dos resultados**, evidências e manifestos. **Fora desta cobertura:** `src/lib/pdf/serve.ts` (§8).

## 8. Pendência de segurança FORA da Onda 6C — leitura de PDF (`src/lib/pdf/serve.ts`)
- **Achado (R2-INFO-3, reproduzido pelo revisor):** `resolvePdfDownload` lê o PDF com `fs.readFile` comum. Um FIFO com nome `.pdf` nas pastas de PDF paralisa o pool de I/O do processo (e o processo não encerra).
- **Quem pode plantar:** quem escreve nas pastas de PDF — que no `stack.yml` é um bind de **escrita** montado também pelo **Worker** (que processa conteúdo externo) — ou o administrador do host. Não é alcançável pela interface.
- **Gravidade:** **MÉDIA-BAIXA**, só **disponibilidade** (sem vazamento nem falsificação).
- **Decisão:** **não corrigida nesta rodada** (para não misturar uma alteração ampla do módulo PDF com a remediação). **Corrigir antes de qualquer publicação que exponha o download de PDF** (inclui a Onda 7): usar o mesmo leitor endurecido (`O_NONBLOCK` + `fstat` + limite de tamanho) e testar em processo filho. Registrada no checklist de produção.

## 9. Hipóteses de confiança (se falharem, o modelo deixa de valer)
1. A chave de origem permanece só no ambiente do processo web; a privada de atestação, fora da VPS.
2. A sessão do operador e a lista de operadores são confiáveis (Fase 5).
3. O disco respeita `link()` exclusivo e `fsync` (sem NFS/SMB não validados).
4. O relógio do servidor é monotônico o bastante (cadeia; validade de chaves aposentadas).

## 10. Pendências de produção associadas
Guarda externa do `head`; logs estruturados e alertas (conclusões de pendência, recusas por origem, 409 de integridade, incidentes de testemunha); procedimento de quarentena revisado; segredos provisionados e rotação **ensaiada**; **produtor** da prova de coleta (ADR 6C-03 §7); primeira implantação **já com esta versão**; correção do PDF antes de expor download. Ver `onda6c-checklist-producao.md`.
