# Onda 6C — Relatório técnico da RODADA FINAL de remediação (pós-2ª revisão independente)

> **Data:** 01/11/2026. **Base:** commit `b1c7412e9ca111b9a540ebc7c83f71212bc5d776` (relatório adversarial original). Complementa `onda6c-relatorio-remediacao.md` (rodada anterior) e **preserva** os relatórios das duas revisões (`onda6c-revisao-adversarial-seguranca.md`, `onda6c-revisao-adversarial-2.md`).
> **Autorização desta rodada:** remediação **sem commit** e **sem encerrar** a Onda 6C. **Nada** foi commitado, enviado, mesclado, marcado ou implantado; a VPS e credenciais de produção não foram tocadas; nenhum `.env*` foi lido (o modelo `deploy/hostinger/.env.production.example` foi **editado apenas por acréscimo de nomes de variáveis vazios**, sem ler valores); D5 e a Onda 7 não foram iniciadas; `src/lib/link-audit/scoring/` está idêntico à tag `v1.0.1` (`git diff v1.0.1 -- src/lib/link-audit/scoring | wc -l` = **0**).
> **A Onda 6C NÃO está encerrada e este relatório não a encerra.**

## 0. Resumo executivo (leia isto primeiro)

1. **Evidências falsificadas (decisão 1):** a integridade (SHA-256) **não** é mais tratada como autenticidade. Implementei o **lado verificador** de uma prova de coleta (manifesto assinado Ed25519 guardado **fora** da pasta de evidências) e um **bloqueio fail-safe**: sem prova, **nenhuma finalização** e nenhuma conclusão de pendente. Como **não existe produtor** da prova, **a finalização está fechada em produção por desenho**, até o plano do lado produtor (ADR 6C-03 §7) ser aprovado e executado. **Esta parte foi interrompida e apresentada como plano, como você pediu.**
2. **Revogação restaurada por remoção de recibo (decisão 2):** corrigida. A decisão afetada por uma operação **pendente** nunca volta a ser vigente: fica **EM DÚVIDA**, fora do motor e da prévia; todos os operadores veem o problema; a recuperação legítima foi preservada; o `decisionsHead` dos resultados confirmados funciona como **testemunha** quando existe (e **não** resolve todos os casos).
3. **Documentação (decisão 3):** ADR 6C-02 reescrito e modelo de ameaças corrigido; afirmações mais fortes que o código foram removidas.
4. **Chaves e rotação (decisão 4):** formato estrito, id independente do segredo, rotação **planejada** × por **comprometimento**; a variável `…_PREVIOUS` (que mantinha a chave vazada aceita) foi **removida**.
5. **Consequência que você precisa saber:** com o bloqueio de proveniência, **o fluxo de finalização só funciona quando há manifesto**. Em produção hoje não há. Os testes e os roteiros de navegador usam um par de chaves de teste que faz o papel de quem atesta.

## 1. Arquitetura final de segurança

| Camada | O que garante | Onde |
|---|---|---|
| **Origem da operação (HMAC)** | O servidor gravou aquela decisão/resultado; pendente só é concluída com origem comprovada; chaves com formato estrito, id público independente, rotação planejada × comprometimento | `src/lib/link-audit-origin/index.ts` |
| **Projeção segura de operação pendente** | Decisão revogada/substituída por operação pendente **não** é vigente (EM DÚVIDA); `finalizable:false`; ids visíveis a todos, conteúdo só ao autor com origem comprovada | `link-audit-decisions/service.ts` (`ambiguousTargets`) |
| **Testemunha independente** | `decisionsHead` de resultado confirmado ⇒ `RECEIPT_LOST_WITNESSED` / `HISTORY_DIVERGES_FROM_WITNESS` / `NOT_WITNESSED` | `link-audit-scoring-runs/results.ts` (`witnessDecisionReceipt`) |
| **Proveniência das evidências** | Manifesto Ed25519, chaves **públicas** de confiança, pasta separada, cobertura total, sem recuo ao manifesto antigo, chaves de ordem pequena recusadas; **padrão fechado** | `link-audit-evidence/provenance.ts`, `preview.ts`, `results.ts`, rotas |
| **Integridade do arquivo** | SHA-256, encadeamento, recibos (inalterado) | stores |
| **Leitura segura** | `O_NONBLOCK`+`fstat`+limite: FIFO/dispositivo/link falham fechado em decisões, recibos, resultados, recibos de resultados, evidências e manifestos | `snapshot-store.ts` |
| **Gravação** | Sem autenticador de origem, serviço e primitiva **recusam** (503 nas rotas) | `service.ts`, `results.ts`, stores |
| **Interface** | Sem botão de concluir sem origem comprovada; ambiguidade e testemunha mostradas a todos; rótulo "Origem da coleta (autenticidade)" distinto da integridade; validador do cliente falha fechado | `components/link-audit/audit-page/*` |

Detalhes e limites: `onda6c-adr-prova-de-origem.md`, `onda6c-adr-proveniencia-evidencias.md`, `onda6c-modelo-de-ameacas-recuperacao.md`, `onda6c-runbook-chaves.md`.

## 2. Arquivos modificados e criados (árvore **não commitada**: 55 modificados + 22 itens novos; `+1193/−229` nos rastreados)

**Código novo:** `src/lib/link-audit-evidence/provenance.ts` (verificador, política fechada, parser de chaves, rejeição de ordem pequena, `createEvidenceSeal`); `src/lib/link-audit-origin/index.ts` (reescrito: chaves, HKDF, vereditos `KEY_REVOKED`/`KEY_EXPIRED`); `src/components/link-audit/audit-page/pending-panels.tsx` (ambiguidade/testemunha a todos).
**Código alterado (`src/`):** `link-audit-decisions/{service,store,types}.ts`; `link-audit-scoring-runs/{preview,results,results-store,results-types,blockers}.ts`; `link-audit/snapshot-store.ts`; `app/api/link-audit/{decisions,scoring}/shared.ts`; `components/link-audit/audit-page/{audit-detail-screen,company-panel,controller,decisions-panel,finalization-panel,labels,results-panel,types,validators}.ts(x)`.
**Testes novos:** `link-audit-origin-keys` (6), `link-audit-decisions-revocation-receipt` (13), `link-audit-evidence-provenance` (10), + helpers `link-audit-evidence-provenance-fixtures`, `link-audit-origin-fixtures`, `special-files-child`; `protocol-conformance-v2.json` **regenerada**. **Testes ampliados:** `link-audit-origin-protocol` (14), `link-audit-special-files` (7 cenários de FIFO), `link-audit-scoring-results-api` (+2), `link-audit-audit-page-{render,validators}` e outros 20 ajustados ao novo comportamento.
**Roteiros de navegador:** `scripts/browser/{harness,i6-navigation,i7-homologacao}.cjs` (chaves de teste, pasta de manifestos, auditoria `unsealed`, B13/B14/B15), sementes `tests/helpers/browser-seed-i{5,6}.ts`.
**Implantação (só documentação/modelo):** `deploy/hostinger/PROVA-DE-ORIGEM-E-DE-COLETA.md` (novo), `.env.production.example` (acréscimo de **2 nomes de variáveis vazios**). **`stack.yml`, `Dockerfile` e `docker-entrypoint.sh` NÃO foram alterados.**
**Docs:** ADR 6C-03 (novo), runbook de chaves (novo), ADR 6C-02 (reescrito), modelo de ameaças (reescrito), checklist de produção (§12 novo), spec 6C (Emenda 3), docs 6B (correções do "revogada reaparece vigente"), `NOTES.md`.

## 3. Testes antes e depois

| | Antes (início desta rodada) | Depois |
|---|---|---|
| Suíte completa | 1621 aprovados | **1658 aprovados, 0 falhas, 0 pulados** (+37) |
| `tsc --noEmit` | limpo | **limpo (exit 0)** |
| Build offline (`--offline-fonts`) | limpo | **limpo** |
| Navegador I5 / I6 / I7 | 41 / 107 / 123 (+3 SKIPPED) | **41 / 107 / 127 (+3 SKIPPED)** (mesmos 3: leitor de tela real, outros navegadores/dispositivo, `axe-core`) |

*(Os números "antes" são os informados no pedido e na rodada anterior; os "depois" foram executados agora, no ambiente isolado, sobre a árvore final.)* Registro: 9 testes que descreviam o comportamento antigo (por exemplo, "a decisão revogada aparece vigente") foram **reescritos de propósito** para o comportamento novo, e a referência de conformidade v2 da 6B foi **regenerada** com conferência por máscara (só `kid`, hashes e o campo `ambiguousDecisionIds` mudam).

## 4. Resultado das provas adversariais

**Reexecução das provas originais (1ª revisão), sem modificação, na árvore final (ambiente isolado):**

| Prova | Resultado agora |
|---|---|
| RV-01 resultado forjado → PONTUADO | **Falha de forma esperada** (ataque barrado: pendente `UNPROVEN/MISSING`, nada exposto) |
| RV-04 decisão forjada → ACTIVE | **Falha de forma esperada** (`vigentes = []`, `finalizable=false`) |
| RV-02 FIFO | **Responde na hora** (`ENOTFILE`), pool intacto |
| RV-03 remoção de recibos/pastas | Continua "passando": **limitação declarada** (MINOR-2; perda coordenada das duas subpastas) |

**Provas da 2ª revisão (RV2), na árvore final:**

| Prova | Resultado | Leitura |
|---|---|---|
| RV2-A1/A2 variantes de forja (6C/6B) | recusadas (passam) | MAJOR-1 segue fechado |
| **RV2-A3b** remoção do recibo da **revogação** | **Falha de forma esperada**: `vigentes = []`, `pending=REVOKE/PROVEN`, `applied=[]`, `allowed=false` | **Corrigido** (decisão em dúvida) |
| RV2-A3a recibo plantado confirma pendente legítima | continua (passa) | **Limite declarado** (R2-INFO-2; modelo §6.2) |
| RV2-A4 NFC×NFD | continua (passa) | **INFO** (sem impacto prático conhecido) |
| RV2-A5 concorrência | passa | sem mudança |
| **RV2-A7** serviço sem chave grava confirmado sem etiqueta | **Falha de forma esperada**: `ORIGIN_KEY_NOT_CONFIGURED` | **Corrigido** (recusa sem autenticador) |
| **RV2-F1** captura forjada na pasta de evidências | Com o *double* das fixtures (autentica tudo) ainda "CONFIRMADO" — **isso é o double**; com a **política real** (manifesto assinado) a mesma prova dá **`NOT_FINALIZABLE`** e nada é gravado | **Corrigido** (prova permanente com a política real: `link-audit-evidence-provenance`). *Os fatos forjados ainda aparecem na **prévia**, rotulados "Origem da coleta NÃO comprovada".* |
| RV2-F2 (P-2) evidência fixada removida só vira `stale` | continua | **P-2 aberto** (§9) |
| RV2-W1 duas pastas criam ACTIVE sem etiqueta | continua | **Limite declarado** (confirmados não são reautenticados na leitura) |
| RV2-W2 testemunha do `decisions.head` | agora **usada** (`decisionsWitness`) | Implementado e testado |
| Chaves (rv2/key-checks): previsível aceita, palpite por `kid`, `_PREVIOUS` com chave vazada, `\n` muda o `kid` | **Todas corrigidas** (provas traduzidas para a nova API em `link-audit-origin-keys`) | A prova original usa a API removida e não roda como está |

**Navegador (HTTP+UI reais):** B13 (pendências **forjadas** de decisão e resultado recusadas), B14 (FIFO ⇒ 409 em ~0,1 s), **B15 (novo)**: coleta atestada ⇒ `AUTHENTICATED` e finalizável; coleta **sem manifesto** (integridade OK) ⇒ `UNAUTHENTICATED/NO_SEAL`, `finalization.allowed=false`, finalização pela API ⇒ **409 `NOT_FINALIZABLE`** com o bloqueio de proveniência e nada gravado, e a tela mostra "Origem da coleta NÃO comprovada" com o registro desabilitado.

## 5. Impacto sobre evidências legadas e formatos persistidos

- **Evidências e auditorias existentes:** **inalteradas** (nenhum arquivo é reescrito, nenhuma captura muda de contrato, nada é invalidado). Continuam **consultáveis** pela interface, agora com a ressalva "Origem da coleta NÃO comprovada: coleta legada, sem manifesto assinado".
- **Sem migração silenciosa:** o código **não** escreve manifestos. Tornar uma coleta (inclusive a legada real) finalizável exige **ato explícito de quem tem a chave privada**, depois de verificação independente (ADR 6C-03 §6).
- **Formatos novos (aditivos):** o manifesto `seal-NNNN.json` (pasta nova, somente leitura para o web); o campo opcional `origin` já existente nas entradas (**formato da etiqueta mudou dentro desta remediação**: id independente do segredo + HKDF; **nenhum arquivo do formato anterior existe fora da árvore de trabalho**); campos novos **nas respostas** (`ambiguousDecisionIds`, `decisionsWitness`, `evidence.provenance`) — não são persistidos.
- **Versão anterior do código:** não lê arquivos com `origin` (esquema estrito) e **não tem** o bloqueio de proveniência ⇒ **não fazer rollback para antes desta versão depois que houver dados**.
- **Resultados já gravados:** nenhum existe em produção; a regra de proveniência se aplica à **gravação** futura.

## 6. Procedimentos de rotação de chaves

Completos e verificados por teste em `onda6c-runbook-chaves.md`. Em resumo:
- **Planejada (a antiga NÃO vazou):** chave nova com id novo; concluir/quarentenar pendências; a antiga entra em `GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS=<id>:<hex>:<AAAA-MM-DD>` (**só verifica**, **validade obrigatória**, depois `KEY_EXPIRED`); depois remover e destruir.
- **Por comprometimento (a antiga vazou):** chave nova; **remover o material** da vazada (nunca em `RETIRED`); o **id** entra em `GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS`; etiquetas dela viram `KEY_REVOKED` — **nenhuma pendência dela é concluída** (inclusive as legítimas: custo declarado); manter o material de um id revogado é **erro de configuração** (503). **Reassinar não reabilita** (não há ferramenta, de propósito).
- **Chave de atestação de coleta:** só a **pública** está no servidor; comprometimento da privada ⇒ remover a pública da lista (a finalização fecha) e reatestar só o que for conferido por fonte independente.
- **Impacto sobre registros históricos e pendências:** confirmados **não** são reverificados na leitura (continuam válidos); pendências da chave revogada/vencida vão para quarentena.

## 7. Parecer da revisão independente (3ª rodada, focada nestas alterações)

**Veredito: APROVADO COM RESSALVAS** — **nenhum BLOCKER nem MAJOR aberto; 6 MINOR e 9 INFO**, todos reproduzidos pelo revisor. Relatório integral preservado em `onda6c-revisao-adversarial-3.md` (provas em `~/gmn-review-evidence-2026-10-31/round3/`). **Limitação declarada pelo próprio revisor:** é um agente da mesma família de modelo do implementador (pontos cegos comuns possíveis) e **não substitui revisão humana**; não rodou `next build`, servidor ponta a ponta nem navegador. Rodou `tsc` (0) e a suíte completa (1657 aprovados, 1 pulado por falta de `.next` no instantâneo).

**Resolvido, segundo o revisor:** (1) fabricação de fatos só na pasta de evidências (nem no padrão de produção nem com a política real é finalizável; selo refeito ⇒ `HASH_MISMATCH`; manifestos forjados ⇒ `SEAL_INVALID`; 14 chaves de ordem pequena recusadas); (2) revogação por remoção de recibo **enquanto a pendente existe**; (4) chaves e rotação; (5) endurecimento (gravação sem autenticador, FIFO em todos os leitores). **Parcial:** (3) documentação.

**Achados abertos (NÃO corrigidos; a documentação foi ajustada para não afirmar mais que o código):**

| ID | Sev. | Resumo | Impacto / atenuante | Correção sugerida |
|---|---|---|---|---|
| **R3-MINOR-1** | MINOR | O verificador confere base ⊆ manifesto, **não** manifesto ⊆ base: apagar a captura 2 (ou a revisão 2 do relatório) faz o passado autêntico (captura 1) valer, ainda `AUTHENTICATED` e finalizável | Escolhe **qual passado autêntico** vale; não fabrica fatos. Atenua: só se nenhum resultado anterior fixou a captura apagada; hoje só INCONCLUSIVO; evidências `:ro` no web | Exigir também manifesto ⊆ base (`EVIDENCE_MISSING`) |
| **R3-MINOR-2** | MINOR | A regra "nunca reativar" vale **só enquanto o arquivo pendente existe**: mover a pendente (o §15 item 3 da 6B manda fazê-lo na quarentena) ou uma falha de leitura das evidências devolve a decisão revogada ao motor; a testemunha só é consultada com pendente e a finalização não compara com os `decisionsHead` dos resultados | **Reativação indevida possível por ação manual/falha**, contradizendo o "nunca reativa" da decisão 2 | Prévia/finalização recusam quando o head atual está **atrás** (ou difere) de algum `decisions.head` confirmado; testemunha calculada das decisões e "indisponível" (não `NO_PENDING`) quando não calculável; §15 proibir mover pendente `PROVEN` de revogação |
| **R3-MINOR-3** | MINOR | Legado: `serper-status.json` fora do manifesto — reescrevê-lo (e a linha do `SHA256SUMS`) muda o perfil sem perder `AUTHENTICATED` | Suprime/habilita perfil de coleta legada atestada | Cobrir o hash do status no manifesto |
| **R3-MINOR-4** | MINOR | A tela 5B (`stored-audit-detail`) e o painel da empresa mostram fatos não autênticos como "Verificada"/"Integridade OK" sem marca por item | Nenhum registro é gravado; risco cresce com o PDF (Onda 7) | Rotular proveniência na 5B e por evidência |
| **R3-MINOR-5** | MINOR | O aviso "interrompida × removido" **não aparece no painel de resultado** para quem não é o autor (só nas decisões) | Quem conduz a quarentena de resultado órfão não é avisado | Replicar `PendingImpact` no painel de resultado |
| **R3-MINOR-6** | MINOR | Documentação mais forte que o código (apagar captura ≠ só DoS; "toda evidência"; aninhamento só léxico; "nunca reativa"; resultado sem aviso; linha do checklist ainda citando `_PREVIOUS`) | — | **JÁ CORRIGIDA nesta rodada** (ADRs, modelo, checklist) |

INFO relevantes: R3-INFO-1 pendente forjada tira decisão legítima da prévia (disponibilidade; finalização já bloqueada); R3-INFO-2 validador do cliente aceita respostas incoerentes (REVOKE de op-0001 com op-0001 `ACTIVE`); R3-INFO-3 com `HISTORY_DIVERGES_FROM_WITNESS` a tela diz "não conclua" e mostra o botão (o servidor não consulta a testemunha); R3-INFO-4 chave aposentada sem teto de validade, etiqueta não cobre o `kid`, `verify` lança com relógio inválido, filtro aceita `sha256("senha123")`; R3-INFO-5/6/7/8 maleabilidade inócua do manifesto, pasta de manifestos não comparada com decisões/resultados, um teste que passa por motivo errado (`revocation-receipt.test.ts:76`), `previewOver` autentica tudo em 15 arquivos de teste; R3-INFO-9 `used-authorizations.ts:69` e `pdf/serve.ts` (fora da 6C).

## 8. Situação individual dos quatro novos MINOR da 2ª revisão

| Item | Situação | Detalhe |
|---|---|---|
| **R2-MINOR-1** pasta de evidências fora da prova de origem | **Tratado (parcial por decisão)** | Verificador + bloqueio fail-safe **implementados e testados**; declarada raiz **não confiável** nos docs. **O produtor da prova é um plano aguardando aprovação** ⇒ finalização fechada em produção até lá |
| **R2-MINOR-2** resíduo do MINOR-2 | **Corrigido, com ressalvas da 3ª revisão** (R3-MINOR-2 e 5) | (a) aviso de ambiguidade a **todos** os perfis; (b) revogação por remoção de recibo **não ressuscita** (decisão em dúvida; teste permanente); (c) testemunha do `decisionsHead` **implementada** e o §6.1 do modelo corrigido |
| **R2-MINOR-3** não-repúdio acima do código | **Parcial** | Doc corrigida; gravação sem autenticador **recusada**. **Não implementados (recomendados):** verificação não bloqueante da origem dos **confirmados** e exigência de `PROVEN` na Onda 7 |
| **R2-MINOR-4** rotação e chave fraca | **Corrigido** | Formato estrito CSPRNG; id independente; planejada × comprometimento; `\r\n`/espaço rejeitados; `_PREVIOUS` removida |

Itens INFO: R2-INFO-1 (NFC) registrado; R2-INFO-2 (recibo plantado pula reconferências) **limite declarado**; **R2-INFO-3** (FIFO em `serve.ts`) **registrado como pendência fora da 6C** com gravidade MÉDIA-BAIXA; R2-INFO-4 (interface) **corrigido em parte** (chave pelo hash da entrada; pendência não comprovada não mostra alvo/data); R2-INFO-5 (`deploy/hostinger`) **documentação e modelo feitos; `stack.yml`/entrypoint pendentes de aprovação**; R2-INFO-6 (`syncDirectory`) registrado.

## 9. Situação de MINOR-2 e de P-1 a P-4 (definições exatas no relatório original)

- **MINOR-2:** a ambiguidade estrutural **permanece e foi aceita por você**, com a condição **atendida e testada**: falha segura, sem reativação indevida. Proteção adicional para produção (guarda externa do `head`) **continua sendo recomendação, não implementação**.
- **P-1 a P-4:** tabela completa (impacto, evidência, motivo de não correção, se impede encerrar/produção) no **checklist de produção §12.1**. Resumo: **P-1** (juízo C2 × captura na gravação) e **P-2** (evidência fixada alterada só vira `stale`) — **não impedem encerrar a onda**, **recomendadas antes de produção**; **P-3** (custo a frio) e **P-4** (`fsync` de diretório) — **não impedem**, exigem medição/ensaio e requisito de sistema de arquivos. **Nenhuma foi considerada aceita automaticamente; a decisão é sua.**

## 10. Riscos aceitos e riscos bloqueantes

**Aceitos (por você, nesta rodada):** indistinguibilidade *universal* de "gravação interrompida" × "recibo removido", **desde que falhe de forma segura e nunca permita a reativação indevida**. **Atenção:** a 3ª revisão mostrou que a segunda metade desta condição **só vale enquanto a pendente existe** (R3-MINOR-2): mover a pendente na quarentena reativa a revogação. Logo a condição que você impôs **ainda não está plenamente atendida**.
**Para você decidir (propostos como aceitáveis, não aceitos):** P-3, P-4 (com requisito de FS), R2-INFO-1/2, escrita nas duas pastas sem guarda externa do `head`.
**Bloqueantes para PRODUÇÃO:** (1) **produtor da prova de coleta inexistente** (finalização fechada); (2) alterações de `stack.yml`/entrypoint para o segredo e o volume de manifestos (não feitas); (3) primeira implantação já com esta versão; (4) **FIFO em `serve.ts`** antes de expor PDF; (5) backups independentes, monitoramento/alertas e guarda externa do `head` ausentes; (6) custódia da chave privada de atestação indefinida; (7) CSP/limitadores/rollback não ensaiado (inalterados).
**Bloqueantes para ENCERRAR a Onda 6C:** a 3ª revisão não deixou MAJOR/BLOCKER, mas **recomendo tratar R3-MINOR-2 antes de encerrar** (afeta diretamente a condição da decisão 2) e, de preferência, R3-MINOR-1/3/5; e **sua decisão** sobre P-1/P-2, R2-MINOR-3 e o plano do produtor.

## 11. Total de testes e resultado do build

**1658/1658** aprovados (0 falhas, 0 pulados); `tsc` limpo; build offline limpo; navegador **I5 41/41, I6 107/107, I7 127/127 (+3 SKIPPED)**.

## 12. Git status

`HEAD` = `b1c7412e9ca111b9a540ebc7c83f71212bc5d776`, branch `feat/onda-6c-integracao`, sem remote. **55 arquivos modificados + 22 itens novos, TODOS não commitados** (lista na §2). Sem push/merge/rebase/tag/deploy. `git diff --check` limpo.

## 13. Recomendação sobre o encerramento formal da Onda 6C

**Não recomendo encerrar agora.** O que o código demonstra está fechado e testado, mas a Onda tem um **efeito colateral deliberado e relevante**: **sem o produtor da prova de coleta a finalização fica inoperante**. Encerrar a 6C significaria aceitar uma onda cuja função central (finalizar) não opera em produção. Recomendo, nesta ordem: (a) decidir se corrijo antes **R3-MINOR-2** (obrigatório, em minha avaliação, para cumprir a decisão 2), **R3-MINOR-1, 3, 4 e 5** (pequenos); (b) você decidir o **plano do produtor** (ADR 6C-03 §7, opção P1) e a custódia da chave; (c) decidir P-1 e P-2; (d) autorizar o **commit** desta remediação como um conjunto; (e) só então avaliar o encerramento — ou encerrar com a finalização **explicitamente declarada como dependente da fase 1–2** do plano.
