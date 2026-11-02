# Onda 6C — Relatório do FECHAMENTO DE SEGURANÇA (correção dos cinco achados de código da 3ª revisão)

> **NOTA DE PRECISÃO (01/11/2026, 5ª revisão):** este relatório descreve o limite BLOQUEADOR de forma mais estreita do que ele é e a regra de procedimento só para pendência `PROVEN`. A forma exata: a janela abre na REVOGAÇÃO/SUBSTITUIÇÃO e só fecha no próximo resultado selado, e a regra vale para pendência de revogação/substituição **de qualquer origem**. Ver `onda6c-relatorio-r4minor1-info1.md` e ADR 6C-02 §4.5.

> **Data:** 01/11/2026. **Base:** `HEAD b1c7412e9ca111b9a540ebc7c83f71212bc5d776`; a remediação anterior (não commitada) foi **preservada integralmente** — nenhum reset, clean, stash destrutivo ou checkout forçado. Relatórios preservados: `onda6c-revisao-adversarial-seguranca.md`, `…-2.md`, `…-3.md`, `onda6c-relatorio-remediacao.md`, `…-2.md`.
> **Autorizado nesta etapa:** corrigir R3-MINOR-1..5 e verificar a documentação (R3-MINOR-6). **NÃO autorizado e NÃO feito:** commit (de código, documentação ou relatórios), encerramento da Onda 6C, deploy, produtor da prova de coleta, push/merge/rebase/tag, VPS/credenciais, D5, Onda 7.
> **A Onda 6C NÃO está encerrada.** Este relatório não a encerra.

## 0. Resumo executivo

1. **R3-MINOR-2 (prioridade máxima) — CORRIGIDO, com UM LIMITE declarado como BLOQUEADOR para produção.** A decisão revogada não volta a ACTIVE por quarentena, recibo removido, restauração parcial, falha de leitura da testemunha ou reinício **quando existe testemunha** (resultado selado depois da decisão): o histórico fica **NÃO RESOLVIDO** — zero decisões vigentes, motor sem decisões, nada finalizável, escritas recusadas, estado estruturado para todos. **Sem nenhum resultado selado depois da decisão não há testemunha** e a quarentena manual de uma pendente `PROVEN` de revogação **ainda reativa a decisão, sem que o sistema detecte** (travado em teste). Não declaro este item concluído por inteiro: **é BLOQUEADOR para produção** até haver um marcador durável (avaliado no ADR 6C-02 §4.6).
2. **R3-MINOR-1, 3, 4 e 5 — CORRIGIDOS** e demonstrados (manifesto bidirecional; `serper-status` legado atestado; estados de interface distintos por texto; aviso de recibo ausente a todos os perfis, com estado estruturado do servidor).
3. **R3-MINOR-6 (documentação) — verificada e corrigida**: cada afirmação passou a corresponder ao comportamento demonstrado; o limite do item 1 está dito sem exagero.
4. **Direção P1 registrada** com contrato e custódia (`onda6c-contrato-p1-atestacao.md`); **nada foi implementado**.
5. **P-1 a P-4** analisados individualmente (`onda6c-riscos-p1-p4.md`); **nenhum aceito**.

## 1. Causa e correção de cada R3-MINOR

| Item | Causa | Correção |
|---|---|---|
| **R3-MINOR-2** | A regra "nunca reativar" dependia do **arquivo pendente existir**; a testemunha era calculada pela **prévia** do 6C só quando havia pendente. Mover a pendente, ou uma falha de leitura das evidências, apagava a testemunha. | **A 6B passa a verificar a testemunha na origem** (`witness.ts`, puro, neutro): em toda leitura e escrita confere o histórico contra "cabeças conhecidas" fornecidas, **por injeção da camada de rotas**, por uma fonte independente (hoje, os resultados selados e o resultado pendente de origem comprovada). Retrocesso/divergência/fonte ilegível ⇒ **NÃO resolvido ⇒ falha fechada** em todos os consumidores (6B, prévia, finalização, conclusão de pendente, interface). A testemunha antiga no 6C foi **removida** (fonte única). |
| **R3-MINOR-1** | O verificador conferia **base ⊆ manifesto**, não o contrário: apagar a captura 2 deixava a 1 "autêntica e atual". | Verificação **bidirecional**: manifesto ⊆ base ⇒ `EVIDENCE_MISSING` (com até 5 referências ausentes, exibidas na tela como "dados podem ser de uma coleta anterior"). |
| **R3-MINOR-3** | O `serper-status.json` legado **decide** se há perfil (cobertura, `located`), mas não estava no manifesto. | Entra como artefato `legacy-status:cNNNN` com o hash **verificado**; o manifesto precisa cobri-lo. Os demais arquivos legados **não influenciam** a pontuação e não são atestados (dito). |
| **R3-MINOR-4** | A 5B e o painel da empresa mostravam "Verificada"/"Integridade OK" sem dizer que só a integridade local (SHA-256) estava em jogo. | Painel: selos por texto — **Integridade local verificada (SHA-256)**; **Origem da coleta autenticada** / **NÃO comprovada**; **Evidência adulterada ou ilegível** / **incompleta**; por evidência "origem autenticada/NÃO comprovada"; captura ausente avisa. 5B: badge "Verificada **no relatório**" e nota "não comprova quem coletou; a origem não é avaliada nesta tela". Design preservado; alteração mínima. |
| **R3-MINOR-5** | O aviso "interrompida × removido" no painel de **resultado** só aparecia ao autor. | DTO com estado **estruturado** (`receipt:'MISSING'`, `blocksFinalization:true`) e painel que mostra o aviso a **todos** os perfis (autor, outro operador, origem não comprovada), sem conteúdo privado e **nunca** como confirmação. |
| **R3-MINOR-6** | Texto mais forte que o código. | ADR 6C-02 (§4.5–4.6, §6–§8, §10), ADR 6C-03, modelo de ameaças, checklist, runbook e docs 6B corrigidos; o item `_PREVIOUS` do checklist removido. |
| INFO tratados | R3-INFO-2 (validador aceitava incoerência), -3 (botão com histórico divergente), -4 (teto de validade da chave aposentada; relógio inválido), -6 e a recusa de aninhamento "só léxica" (agora também por caminho real e contra **todas** as pastas), -7 (teste que passava pelo motivo errado). | Corrigidos e testados. R3-INFO-1/5/8/9 permanecem registrados. |

## 2. Arquivos (árvore **não commitada**: 58 modificados + 25 novos)

**Novos (src):** `src/lib/link-audit-decisions/witness.ts`. **Novos (docs):** `onda6c-contrato-p1-atestacao.md`, `onda6c-riscos-p1-p4.md`, este relatório (+ itens da rodada anterior). **Novos (testes):** `link-audit-decisions-revocation-receipt` (reescrito, 19), ampliações de `link-audit-evidence-provenance` (17), `link-audit-origin-keys`, `link-audit-decisions-api`, `link-audit-origin-protocol`, `link-audit-audit-page-{render,validators}`.
**Alterados (src):** `link-audit-decisions/{service,index}.ts`; `link-audit-scoring-runs/{preview,results,blockers,index}.ts`; `link-audit-evidence/{provenance,scoring-basis}.ts`; `link-audit-origin/index.ts`; `app/api/link-audit/{decisions,scoring}/shared.ts`; `components/link-audit/audit-page/{company-panel,decisions-panel,pending-panels,types,validators,labels,audit-detail-screen}.ts(x)`; `components/link-audit/stored-audit-detail.tsx`.
**Roteiros:** `scripts/browser/i7-homologacao.cjs` (B16 novo; rótulos), `tests/helpers/browser-seed-i6.ts` (auditoria `revoked`).
**Docs corrigidos:** ADR 6C-02/03, modelo de ameaças, runbook de chaves, checklist (§12 + BLOQUEADOR), spec 6C (Emenda 4), `NOTES.md`, 6B §15 (regra de quarentena), `deploy/hostinger/PROVA-DE-ORIGEM-E-DE-COLETA.md`. **`stack.yml`, `Dockerfile`, `docker-entrypoint.sh`, o coletor e `src/lib/link-audit/scoring/` NÃO foram tocados** (`git diff v1.0.1 -- src/lib/link-audit/scoring | wc -l` = **0**).

## 3. Testes de ataque — antes e depois

Provas das **três** revisões reexecutadas (cópias adaptadas e saídas em `~/gmn-review-evidence-2026-10-31/round4/`), conferindo **o motivo** da recusa:

| Prova | Antes | Agora (motivo conferido) |
|---|---|---|
| RV-01 / RV-04 (forja de pendente) | ataque funcionava | **barrado**: origem não comprovada, nada exposto |
| RV-02 (FIFO) | travava | responde na hora (`ENOTFILE`) |
| RV-03 (remoção de recibos/pastas) | passa | **continua** — limitação declarada (perda coordenada das duas subpastas) |
| RV2-A1/A2 (variantes de forja) | recusadas | recusadas |
| RV2-A3b (remoção do recibo da revogação) | decisão voltava a ACTIVE | `vigentes = []`, `finalizable=false` |
| RV2-A7 (serviço sem chave grava) | gravava confirmado sem etiqueta | `ORIGIN_KEY_NOT_CONFIGURED` |
| RV2-F1 (captura forjada) | finalizada | `NOT_FINALIZABLE` **com a política real** (a fixture-double autentica tudo e ainda mostra "CONFIRMADO": por isso a prova permanente usa a política real) |
| **RV3-A1** (quarentena da pendente) | **decisão revogada FINALIZADA (`appliedIds ["op-0001"]`)** | **Na fiação de produção:** `witness = HISTORY_REGRESSED`, `vigentes = []`, `applied = []`, bloqueio `DECISIONS_HISTORY_UNRESOLVED`, finalização `NOT_FINALIZABLE`. *Sem provedor de testemunha (harness original, ou servidor sem as pastas de resultados): igual a antes — é o LIMITE.* |
| **RV3-B1** (apagar captura 2) | `AUTHENTICATED` e finalizável | `UNAUTHENTICATED/EVIDENCE_MISSING` (`capture:c0002`, `report:c0002-r0001`), `NOT_FINALIZABLE` |
| **RV3-B2** (apagar revisão r0002) | `AUTHENTICATED` | `EVIDENCE_MISSING` (`report:c0001-r0002`) |
| **RV3-B3** (reescrever `serper-status`+`SHA256SUMS`) | `AUTHENTICATED`, perfil suprimido, `allowed true` | `EVIDENCE_HASH_MISMATCH`; integridade local segue OK (é o que o ataque explora); `allowed false` |
| **RV3-B4** (manifestos via link simbólico) | recusa só léxica | `PROOF_NOT_CONFIGURED` também via link simbólico (caminho real) |
| RV3-F1 (falso negativo da testemunha) | `NO_PENDING` com a evidência falhando | `RECEIPT_LOST_WITNESSED` com e sem falha das evidências (fonte única, na 6B) |
| RV3-G1 (sem testemunha + quarentena) | decisão aplicada e finalizada | **IGUAL — LIMITE BLOQUEADOR** (travado em teste) |
| RV3-E1 (teste com `'a'×64`) | passava por `INPUT_CHANGED` | corrigido: hash real ⇒ `NOT_FINALIZABLE ["DECISION_PENDING"]` |
| RV3-D, C | ok | ok |

**Testes permanentes novos do item prioritário** (`link-audit-decisions-revocation-receipt`): revogação confirmada + recibo removido; pendência movida para a quarentena; falha na leitura da testemunha (provedor que lança, resposta malformada, EIO, pasta inexistente); resultado selado adulterado; remoção e restauração parcial; reinício (serviço novo a cada leitura); recuperação legítima pelo autor; tentativa de finalização após perda de testemunha (com o hash real, motivo `DECISIONS_HISTORY_UNRESOLVED`); concorrência/idempotência; pendência de resultado como testemunha (e a forjada **não** é); API com operadores diferentes do autor; navegador B16a–i.

## 4. Suíte e navegador (executados agora, no ambiente isolado)

| | Baseline informada | Agora |
|---|---|---|
| Suíte completa | 1658 | **1675/1675, 0 falhas, 0 pulados** |
| `tsc --noEmit` | limpo | **limpo (exit 0)** |
| Build offline | limpo | **limpo** |
| Navegador I5 / I6 / I7 | 41 / 107 / 127 (+3 SKIPPED) | **41/41 · 107/107 · 136/136 (+3 SKIPPED, os mesmos)** |
| `scoring/` × `v1.0.1` | 0 linhas | **0 linhas** · `git diff --check` limpo |

## 5. Parecer da revisão independente (4ª rodada, focada nas cinco correções)

**Veredito: APROVADO COM RESSALVAS** — nenhum MAJOR/BLOCKER novo; **2 MINOR e 10 INFO**. Relatório integral: `onda6c-revisao-adversarial-4.md` (provas em `~/gmn-review-evidence-2026-10-31/round4/review4/`). **Limitações do revisor:** mesma família de modelo do implementador; sem `next build`, servidor ou navegador; corrida simulada de forma determinística. Rodou `tsc` (0) e a suíte (1675, 1674 aprovados, 1 pulado por falta de `.next` no instantâneo).

**Segundo o revisor, resolvidos:** R3-MINOR-1 (EVIDENCE_MISSING), R3-MINOR-3, R3-MINOR-5; R3-MINOR-2 **para os cenários de uma pasta** (quarentena ⇒ `HISTORY_REGRESSED`, zero vigentes, escritas e finalização recusadas, para todos os operadores e após reinício); R3-MINOR-4 na página Lumos e **parcial na 5B**; chaves e isolamento OK. O **LIMITE foi reproduzido** (revogada volta a valer e é finalizada sem testemunha). **Avaliação do revisor:** é **BLOQUEADOR para produção, não para encerrar a Onda** (reativar exige escrever em duas pastas ou um operador mover a pendente contra o aviso da tela; nada implantado; sem P1 toda finalização já responde `NOT_FINALIZABLE`), **com a condição de corrigir R4-MINOR-1 antes de qualquer rotação de chave em produção**. *(Essa avaliação é do revisor; a decisão é sua.)*

| ID | Sev. | Resumo | Estado |
|---|---|---|---|
| **R4-MINOR-1** | MINOR | **Rotação de chave apaga a testemunha do resultado pendente** (só pendente `PROVEN` conta): depois da rotação, remover os dois recibos e pôr as pendências em quarentena — como o runbook mandava — reativa a decisão (`CONFIRMADO s1 appliedIds ["op-0001"]`) | **Aberto (código).** Docs/runbook já corrigidos para proibir; correção sugerida: contar a cabeça de qualquer resultado pendente ou falhar fechado |
| **R4-MINOR-2** | MINOR | Documentação mais forte que o código ("depois da decisão" deve ser "depois da **revogação**"; "perder a testemunha não reativa"; "isso é exibido" com `NOT_CONFIGURED`; quarentena no runbook/orquestração) | **Corrigido agora** nos docs |
| INFO-1 | INFO | `NOT_CONFIGURED` **falha aberta** (sem `RESULTS_ANCHOR_DIR` a revogada aparece vigente; `knownHeads` é opcional) | Registrado no checklist ("configure sempre") |
| INFO-2 | INFO | Quem escreve só nos resultados **congela** as decisões (disponibilidade); sem caminho de recuperação documentado se o backup for anterior ao último resultado | Registrado |
| INFO-3 | INFO | Cabeças lidas **fora da trava**: uma escrita com cabeças desatualizadas é aceita; a leitura seguinte acusa `HISTORY_DIVERGES` | Registrado |
| INFO-4 | INFO | Validador da **prévia** aceita incoerências (histórico não resolvido com `applied` não vazio; coleta não autêntica sem bloqueio) | Registrado |
| INFO-5 | INFO | Painel de resultado pendente não recebe a testemunha (autor vê "Concluir"; o servidor recusa) | Registrado |
| INFO-6 | INFO | **5B** ainda diz "Integridade confirmada" e mostra "Verificada no relatório" em verde ao lado de fatos forjados | Registrado (R3-MINOR-4 parcial na 5B) |
| INFO-7..10 | INFO | Provedor que nunca responde; bind mount não detectado (plausível); testes `revocation-receipt:344-358` passam só porque o provedor é criado sem autenticador; limites de duas pastas | Registrado |

## 6. Contrato proposto para P1 e custódia da chave privada

Resumo (completo em `onda6c-contrato-p1-atestacao.md`; **nada implementado**): a chave privada Ed25519 fica sob controle administrativo, **fora da VPS, do servidor web, do WSL de desenvolvimento, do repositório e das pastas de dados**, em armazenamento criptográfico protegido ou meio criptografado com desbloqueio manual; o servidor recebe **só chaves públicas**. A assinatura prova que o custodiante autenticou **bytes exatos**; **não** prova origem junto ao Google/Serper — por isso P1 **não assina arquivos legados de procedência desconhecida**. Processo: exportar candidato (somente leitura) → **conferir a procedência** (execução LIVE autorizada, hash do corpo registrado em canal separado, fonte externa independente, relatório reproduzido; legado só com fonte independente) → aprovar (quatro olhos) → assinar offline (recusa se algo atestado mudou/sumiu ou se o candidato difere do aprovado) → entregar `seal-NNNN.json` → verificar → arquivar o **dossiê** (fonte e artefatos exatos). Decisões abertas: titular/suplente, dispositivo, política do legado real.

## 7. Situação individual de P-1 a P-4 (nenhum aceito)

Análise completa em `onda6c-riscos-p1-p4.md` (descrição original, consequência, fronteira de confiança, impede homologação/produção, mitigação mínima, teste). Resumo: **P-1** (juízo C2 × captura na gravação): não impede encerrar; impede só com coleta concorrente; mitigação = corpo da 6B com `basisCapture`. **P-2** (evidência fixada alterada só vira `stale`): não impede encerrar; recomendado antes do 1º resultado; mitigação = `evidenceIntegrity` em `list/get`. **P-3** (custo a frio): não impede, mas **esta rodada acrescentou leituras da cadeia de resultados** nas consultas de decisões/prévia — **exige medição**. **P-4** (`fsync` de diretório): não impede encerrar; exige requisito de FS e ensaio de queda.

## 8. Riscos residuais

**BLOQUEADORES PARA PRODUÇÃO:** (1) **janela sem testemunha** (R3-MINOR-2): sem resultado selado depois da decisão, a quarentena manual de uma pendente `PROVEN` de revogação reativa a decisão sem detecção — o sistema não impõe a regra de procedimento; (2) **produtor da prova de coleta inexistente** (finalização fechada); (3) mudanças de `stack.yml`/entrypoint para segredo e volumes não feitas; (4) primeira implantação já com esta versão; (5) FIFO em `src/lib/pdf/serve.ts` antes de expor PDF; (6) backups independentes, monitoramento e guarda externa do `head`; (7) custódia da chave de atestação indefinida.
**Residuais declarados (não bloqueantes isolados):** quem escreve as **duas** pastas (dados+recibos) reescreve o histórico confirmado sem detecção; replay de manifesto/pendência autêntica antiga (atualidade); atestar dado falso; janela entre coleta e atestação; um atacante que escreve **só nos resultados** pode **congelar** as decisões de uma auditoria (`UNAVAILABLE`/`REGRESSED`) — é **disponibilidade**, falha fechada; as rotas de decisões agora dependem da saúde da cadeia de resultados; o custo de leitura aumentou (P-3). **Aceitos pelo responsável:** apenas a indistinguibilidade *universal* de "interrompida × recibo removido", **desde que falhe de forma segura e nunca reative** — condição **demonstrada com testemunha ou com a pendente no lugar, não na janela sem testemunha**.

## 9. Git status

`HEAD` = `b1c7412e9ca111b9a540ebc7c83f71212bc5d776`, branch `feat/onda-6c-integracao`, sem remote. **58 modificados + 25 novos itens, TODOS não commitados** (código, testes, documentação e relatórios). Sem push/merge/rebase/tag/deploy. `git diff --check` limpo.

## 10. Parecer sobre o encerramento da Onda 6C

**Não recomendo o encerramento formal agora.** Os cinco achados de código estão corrigidos e demonstrados, mas **o invariante do item prioritário não é garantido sob o cenário de ameaça aprovado em todos os casos**: na janela sem testemunha a reativação indevida é possível e não detectada. Pela sua regra, isso é **BLOQUEADOR**, não "correção concluída". Para o encerramento recomendo, nesta ordem: (a) decidir entre **fechar a janela** (livro de cabeças em pasta própria ou guarda externa do `head`, mesma interface; ADR 6C-02 §4.6) ou **aceitar formalmente** o limite apenas para a fase de homologação com a regra de procedimento; (b) o parecer da 4ª revisão (§5) já foi dado (APROVADO COM RESSALVAS) e pede corrigir **R4-MINOR-1** antes de qualquer rotação de chave e as INFO-4/5/6 (validador da prévia, painel pendente, 5B); (c) decidir P-1/P-2 e a custódia/política do legado de P1; (d) só então autorizar o commit do conjunto e avaliar o encerramento — ou encerrar declarando que a **finalização em produção depende** do produtor P1 e do marcador durável.
