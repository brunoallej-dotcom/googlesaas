# Onda 6C — Relatório de REMEDIAÇÃO da revisão adversarial independente

> **Data:** 31/10/2026. **Natureza:** relatório COMPLEMENTAR. O relatório original do revisor (`onda6c-revisao-adversarial-seguranca.md`, commit **`b1c7412e9ca111b9a540ebc7c83f71212bc5d776`**) está **preservado sem alteração**, com o parecer do revisor: **BLOQUEADO — CORREÇÕES OBRIGATÓRIAS**.
> **Situação do código:** remediação implementada na árvore de trabalho, **SEM COMMIT** (não autorizado). Nenhum push, merge, rebase, tag, deploy; nada na VPS; nenhuma credencial real; nenhum `.env*` lido; Redis/Supabase/Serper de produção não acessados.
> **A Onda 6C NÃO está encerrada e este relatório não a encerra.**

## 1. Parecer resumido

| Item | Situação |
|---|---|
| **MAJOR-1** (pendente forjada vira confirmada) | **Corrigido no código; reproduzido antes e recusado depois.** Aguarda a confirmação do novo revisor independente (§7). |
| **MINOR-1** (FIFO trava o processo) | **Corrigido**; prova que **reprova o código antigo** (0/4) e **aprova o novo** (4/4). |
| **MINOR-2** (recibo removido × gravação interrompida) | **LIMITAÇÃO DECLARADA** — não é possível distinguir sem testemunha externa. Proteções adicionais implementadas e proposta de proteção de produção (§6). **Não corrigido por inteiro.** |
| P-1, P-3, P-4 | **Não tratados** nesta remediação (eram recomendações, não obrigatórias); continuam registrados. |
| P-2 | **Parcial:** a *conclusão* de pendente agora revalida as evidências fixadas (hashes); as *consultas* continuam mostrando só `stale`. |
| Nova revisão independente | **APROVADO COM RESSALVAS** (sem BLOCKER/MAJOR aberto; 4 MINOR e 6 INFO novos). Ver §7. |

**Posso recomendar o encerramento da Onda 6C?** **Ainda não; a decisão é do responsável.** A condição (1) — nenhum MAJOR/BLOCKER aberto na revisão independente — foi atendida (§7). Faltam: (2) o responsável decidir se os 4 MINOR novos (R2-MINOR-1…4) são corrigidos antes ou aceitos, e aceitar formalmente a limitação do MINOR-2 e os riscos residuais (§8); (3) autorização expressa do commit da remediação. Até lá: **Onda 6C em remediação, não encerrada.**

## 2. Causa-raiz do MAJOR-1 (resumo; detalhes no ADR 6C-02)

A conclusão de uma pendente exigia "mesmo autor + mesmo pedido", mas **ambos vivem na pasta controlada pelo atacante** e o pedido que o operador reenvia é **montado pela interface a partir do próprio arquivo**: a comparação era uma tautologia. SHA-256, encadeamento e `verifyRunRecord`/`pendingProblem` provam **autoconsistência**, não **procedência** (quem escreve na pasta os refaz). O recibo funciona como "cartório": ao gravá-lo, um arquivo forjado passa a confirmado. A interface agravava ao dizer "Foi você quem o gravou" a partir de um `isMine` derivado do campo do arquivo. Os documentos da 6B afirmavam "uma cauda forjada só consegue bloquear, nunca valer" — **falso** (corrigido nos docs).

## 3. Arquitetura da proteção

- **Prova de origem (HMAC-SHA-256)** — `src/lib/link-audit-origin/index.ts` (1 arquivo; só `node:crypto`, `zod`, `canonical`): etiqueta `origin = {v:1, kid, tag}` calculada **pelo servidor** com chave `GMN_LINK_AUDIT_ORIGIN_KEY` **fora de qualquer pasta de dados** (≥ 32 bytes, com variedade; derivada por HMAC com rótulo de versão; domínios `DECISION`/`RUN`; tempo constante; rotação via `…_PREVIOUS`, só para verificar). A etiqueta cobre o corpo inteiro (`auditId`, `seq`, `prevSha256`, autor, hora, conteúdo): não pode ser copiada para outra posição/auditoria/conteúdo.
- **Gravação:** `appendEntry` (6B) e `appendRun` (6C) assinam ao atribuir `seq`/`prev`. **Conclusão de pendente:** o armazenamento **recusa sem gravar** se a origem não for `PROVEN` (`ORIGIN_UNPROVEN`), antes de qualquer recibo.
- **Serviço de resultados (defesa em profundidade):** origem → o registro se explica (motor reexecutado) → evidências citadas existem com os mesmos hashes → histórico não regrediu (`HISTORY_REGRESSED`) → recibo. Reenvio de confirmado também exige que o registro se explique.
- **Rotas:** escritas sem chave válida ⇒ 503 `ORIGIN_KEY_NOT_CONFIGURED` e nada é gravado; leituras continuam (origem `UNVERIFIABLE`). Novos 409: `PENDING_ORIGIN_UNPROVEN` (6B) e `RESULT_PENDING_ORIGIN_UNPROVEN` (6C).
- **DTO:** a pendente traz `origin`, `originDetail`, `isMine` (só com origem comprovada **e** autor = sessão), `matchesCurrent`; conteúdo/autor/desfecho/cobertura só com origem comprovada; `record`/`reason` só para o autor (a v1 mostrava o registro a **qualquer** operador).
- **Interface:** nunca monta reenvio automático; só oferece concluir com `origin === 'PROVEN' && isMine`; mostra o que será concluído; avisa que "interrompida" e "recibo removido" são indistinguíveis; exige **caixa de confirmação marcada**; sem origem comprovada **não há botão, nem conteúdo, nem autor**. O validador do cliente recusa (falha fechada) respostas incoerentes.
- **Falha fechada:** sem chave / chave fraca / chave errada / sem etiqueta / adulterada ⇒ não conclui; nada é apagado, sobrescrito ou recriado em silêncio; pendência segue bloqueando até a quarentena.
- **Compatibilidade:** campo `origin` **aditivo e opcional**; `schemaVersion` permanece 1. **Arquivos com `origin` não são lidos pela imagem anterior** (esquema estrito) — como nada da 6B/6C está em produção, a **primeira implantação deve ser já com esta versão**. Pendências antigas (sem `origin`) **não são confirmadas automaticamente**.
- **FIFO (MINOR-1):** `nodeFsOps.readFile` abre com `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, confere tipo/tamanho **no descritor** (`fstat`), lê limitado a `size+1` (crescimento ⇒ `ECHANGED`) e falha fechado (`ENOTFILE`/`ETOOBIG`).

## 4. Arquivos alterados (árvore NÃO commitada: 46 modificados + 12 novos (inclui este relatório e o da 2ª revisão); `774+/186−` nos rastreados)

**Código novo:** `src/lib/link-audit-origin/index.ts`; `src/components/link-audit/audit-page/pending-panels.tsx`.
**Código alterado (`src/`):** `link-audit-decisions/{types,store,service}.ts`; `link-audit-scoring-runs/{results-types,results-store,results}.ts`; `link-audit/snapshot-store.ts`; `app/api/link-audit/{decisions,scoring}/shared.ts`; `components/link-audit/audit-page/{types,validators,controller,decisions-panel,finalization-panel,results-panel}.ts(x)`.
**Roteiros de navegador/`package.json`:** `scripts/browser/{harness,i6-navigation,i7-homologacao}.cjs`; `package.json` (3 testes registrados).
**Testes novos:** `tests/link-audit-origin-isolation.test.ts` (4), `tests/link-audit-origin-protocol.test.ts` (14), `tests/link-audit-special-files.test.ts` (4) + `tests/helpers/{link-audit-origin-fixtures,special-files-child}.ts` + `tests/fixtures/link-audit-storage/protocol-conformance-v2.json` (v1 congelada). **22 testes existentes** ajustados (fixtures assinam com a origem de teste; novos casos de rota, UI e validador).
**Docs:** ADR `onda6c-adr-prova-de-origem.md`, `onda6c-modelo-de-ameacas-recuperacao.md` (novos); correções em `onda6b-decisoes-humanas.md`, `onda6b-adr-ancora-externa.md`, `onda6c-integracao-orquestracao.md` (Emenda 2, risco 12), `onda6c-checklist-producao.md`, `NOTES.md`; comentários de `store.ts`/`results-store.ts` que prometiam "perda sempre detectável" corrigidos.
**Intocados:** `src/lib/link-audit/scoring/` (`git diff v1.0.1 -- src/lib/link-audit/scoring | wc -l` = **0**); a régua D3B; o relatório original; `stack.yml`/Dockerfile/migrations.

## 5. Evidências ANTES × DEPOIS

Provas do revisor (`~/gmn-review-evidence-2026-10-31/rv-01..04*`), reexecutadas **sem modificação** na árvore corrigida (ambiente isolado):

| Prova | ANTES (`bd7c4fb`) | DEPOIS (árvore corrigida) |
|---|---|---|
| **RV-01** resultado forjado em `results/` | `PONTUADO` provisório, cobertura 49, **confirmado** quando o autor nomeado reenvia | O teste **falha** (hipótese de ataque falsa): pendente `origin: UNPROVEN`, `originDetail: MISSING`, `isMine:false`, **desfecho/cobertura não expostos**; a UI não oferece "concluir" |
| **RV-04** decisão forjada em `decisions/` | decisão **ACTIVE** em nome de ANA | O teste **falha**: `vigentes = []`, `finalizable = false`; pendente `UNPROVEN`, conteúdo e autor ocultos. *Nota:* o pedido do RV-04 já nem consegue ser montado (o conteúdo não é exposto); o envio do conteúdo EXATO do arquivo é recusado com **409 `PENDING_ORIGIN_UNPROVEN`** (teste de protocolo e roteiro B13b) |
| **RV-02** FIFO (6B `d0001`, 6C `a0001`, pool) | **TRAVADO** nos 3 cenários | `CORRUPT` / `ANCHOR_INTEGRITY` com `ENOTFILE` **imediato**; leitura de arquivo comum responde (`ok`) |
| **RV-03** remoção de recibos/pastas | passa | **continua passando** — é o MINOR-2 / perda coordenada, **limitação declarada** (agora a pendente sai com `origin: PROVEN`; o reenvio do autor com origem comprovada recria o recibo do MESMO conteúdo) |

Teste de FIFO em processo filho com `SIGKILL` externo: **0/4 no código antigo ("o filho travou") → 4/4 no corrigido.** No navegador (B14): FIFO no lugar de `s0002.json` ⇒ **409 em 118 ms**, outra auditoria responde 200, e removido o FIFO a leitura volta ao normal.

**Roteiros de navegador (HTTP + UI reais, segredo de sessão e chave de origem fictícios e aleatórios):** B13a–d (pendências **forjadas** de decisão e resultado, em nome do operador autorizado): UI sem botão/conteúdo/autor; API 409; nenhum recibo; arquivo intacto; nada confirmado. B12 (recibo removido): 409 no detalhe e pendente com origem comprovada.

## 6. MINOR-2 — o que foi e o que NÃO foi resolvido

**Fato:** no disco, "gravação interrompida antes do recibo" e "recibo do último registro removido" são **idênticos** (arquivo `N` com etiqueta válida, recibos até `N−1`). A etiqueta prova que o **servidor gravou o arquivo** — verdadeiro nos dois casos. **Nenhum dado no armazenamento atual os distingue; é preciso uma testemunha externa.** Não foi inventada distinção.
**Feito:** o registro deixa de aparecer como confirmado; **não é recriado em silêncio** — só o autor autenticado, com origem comprovada, após **confirmação explícita** na tela (que descreve a ambiguidade), cria o recibo do **mesmo conteúdo**; se o arquivo também foi adulterado, **nada** é recriado; comentários de código e documentos que prometiam "perda sempre detectável" foram corrigidos.
**Proposta para produção (não implementada):** guarda externa do `head` (`seq` + `sha256` por auditoria) fora dos volumes; alerta quando um `head` conhecido some da leitura; logs estruturados/alertas de conclusões e recusas; e/ou o registro de intenção durável (alternativa B do ADR).

## 7. Nova revisão independente

**Parecer: APROVADO COM RESSALVAS.** Relatório integral preservado em `onda6c-revisao-adversarial-2.md` (provas em `~/gmn-review-evidence-2026-10-31/round2/`). Revisor: agente Claude Opus 5.5 separado, contexto limpo, código primeiro. **Limitação declarada pelo próprio revisor: é a mesma família de modelo do implementador (pontos cegos comuns possíveis) e não substitui revisão humana.** Não rodou `next build`, servidor real nem os roteiros de navegador; não testou queda de energia, NFS, réplicas reais.

- **MAJOR-1: RESOLVIDO para o atacante A1** (14 variantes de forja recusadas, conclusão direta ao servidor recusada em 9 variantes 6C e 5 da 6B, nenhum recibo criado; todos os pontos que gravam recibo foram enumerados). **MINOR-1: RESOLVIDO** (inclui recibo de resultado, diretório, link, soquete, 16 FIFOs simultâneos, arquivo que cresce; ≤ 0,23 s). **MINOR-2: PARCIAL.** P-1, P-3, P-4 abertos; **P-2 aberto e agora confirmado**.
- Suíte pelo revisor: 1621 testes, 1620 pass, 0 fail, 1 skip (teste do bundle de produção, pois o instantâneo dele não tinha `.next`; na minha execução, com build, 0 skip). `tsc` limpo. `scoring/` idêntico à `v1.0.1`.

**Achados novos (nenhum permite a A1 confirmar um registro que o servidor não gravou):**
- **R2-MINOR-1** — a pasta de **evidências** não está na prova de origem: quem escreve só nela, com uma captura selada pelo pipeline do coletor, faz fatos inventados irem a um resultado "com origem comprovada" (hoje só INCONCLUSIVO; em produção o volume é `:ro` no web). Não estava declarada como raiz de confiança. Correção: declarar no ADR/modelo; a médio prazo autenticar capturas.
- **R2-MINOR-2** — (a) o aviso "interrompida × removido" só aparece ao autor; (b) quem escreve só nos recibos e remove o recibo de uma **revogação** confirmada faz a decisão revogada voltar a valer (ACTIVE) e, se a quarentena mover a pendente, ela ressuscita; (c) na 6B o `decisions.head` gravado num resultado é uma testemunha existente que o sistema não usa — o §6.1 do modelo ("nenhum dado distingue") está **forte demais**.
- **R2-MINOR-3** — "ACTIVE só existe se o servidor gravou" (modelo §5) está acima do código: a leitura não confere a origem de registros **confirmados**, e `createDecisionService` sem chave grava entrada sem etiqueta (só as rotas impedem). Recomendado: verificar origem dos confirmados de forma não bloqueante e fazer a gravação recusar sem autenticador.
- **R2-MINOR-4** — rotação por **comprometimento** com `_PREVIOUS` mantém aceita a chave vazada; `isStrongKey` aceita chave previsível e o `kid` público permite palpite offline; `
` no segredo muda o `kid`.
- INFO: NFC×NFD não detectado; escritor só de recibos também pula as reconferências; `src/lib/pdf/serve.ts` (fora da 6C) trava com FIFO `.pdf`; UI não comprovada ainda mostra alvo/data do arquivo; `deploy/hostinger` não provisiona a chave; `syncDirectory` sem `O_NONBLOCK`.

**Estes achados NÃO foram corrigidos** (a instrução era parar após o relatório). O que muda a leitura do relatório: o §3/§6 do ADR e o §5/§6.1 do modelo de ameaças contêm as frases acima apontadas como fortes demais e **devem ser corrigidas** antes de qualquer commit.

## 8. Riscos residuais e implicações para produção

1. **MINOR-2** (§6) — sem guarda externa do `head`, a remoção do último recibo não é distinguível de gravação interrompida; escrita nas **duas** pastas (dados + recibos) continua sem detecção.
2. **Quem tem a chave de origem + escrita numa pasta** volta ao cenário do MAJOR-1: segredo só no serviço web, backup em cofre separado, rotação ensaiada.
3. Quem escreve **só na pasta de recibos** pode criar o recibo de uma pendente **legítima** (sem ação do operador); não forja conteúdo. Autenticar recibos não foi adotado (acoplaria toda leitura à chave).
4. **Pendência não comprovada bloqueia a auditoria** (integridade > disponibilidade): exige quarentena manual (`onda6b-decisoes-humanas.md` §15).
5. **Segredo novo obrigatório** (`GMN_LINK_AUDIT_ORIGIN_KEY`): o checklist que dizia "nenhum segredo novo" foi corrigido; sem ele as escritas respondem 503. **Formato não retrocompatível:** primeira implantação já com esta versão.
6. Persistem as pendências de produção: CSP Report-Only com `unsafe-inline`; limitadores em memória; 4 volumes com backup independente; monitoramento/alertas (inexistentes); rollback não ensaiado; sem leitor de tela real; cobertura Lumos < 40% sem a D5 (toda auditoria real sai INCONCLUSIVA); correção de contraste do dashboard aprovada e **não** implementada.
7. P-1, P-3, P-4 abertos; P-2 aberto (confirmado pela 2ª revisão); R2-MINOR-1…4 e INFO (§7) abertos.

## 9. Validação executada (ambiente isolado)

- `tsc --noEmit`: **limpo**. Suíte completa: **1621/1621** (baseline do checkpoint: 1590). Build offline: **ok**.
- Navegador: **I5 41/41; I6 107/107; I7 123/123 (+3 SKIPPED**, os mesmos: leitor de tela real, outros navegadores/dispositivo, `axe-core`).
- `git diff v1.0.1 -- src/lib/link-audit/scoring | wc -l` = **0**; `git diff --check` limpo; nenhum `.env*` lido ou criado.
- **Limitações desta validação:** é do implementador (não substitui o §7); os testes de UI são de renderização estática + roteiro de navegador headless, sem leitor de tela.

## 10. Git

`HEAD` = `b1c7412e9ca111b9a540ebc7c83f71212bc5d776` (docs: relatório original), antecedido por `bd7c4fbe3b746078cd45290d9ec486b86b1cf75a` (checkpoint I7) e `dab23bc` (I6). Branch `feat/onda-6c-integracao`, sem remote. A remediação (46 modificados + 12 novos, listados em §4) está **somente na árvore, não commitada**. Sem push/merge/rebase/tag/deploy.
