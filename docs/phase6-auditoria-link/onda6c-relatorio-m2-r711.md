# Onda 6C — Relatório técnico: correção final do M2 e testes R7-11 (05/11/2026)

**Estado: SEM commit. Onda 6C NÃO encerrada. Parecer independente: BLOQUEAR COMMIT** (MAJOR D1, regressão desta rodada — ver `onda6c-revisao-adversarial-7c.md`). Autorização recebida: corrigir M2 e as lacunas de teste R7-11; sem commit, push, merge, rebase, tag, deploy, VPS, P1, D5 ou Onda 7. B1, M1 e M3 (aprovados) não foram refeitos. A árvore tem 103 entradas não commitadas (as 97 da etapa anterior preservadas + 7b + 3 arquivos de teste novos + 7c e este relatório); `git fsck --full` limpo.

## 1. Causa-raiz e correção do M2
**Causa:** o fsync da pasta da auditoria não persiste o NOME dela; quem persiste é o fsync do diretório-pai (a raiz). `publishLedgerRecord` só sincronizava a raiz quando a pasta da auditoria era criada naquele instante e, nos caminhos de falha (ENOSPC, conflito), descartava a falha de fsync já observada. Depois de uma falha e de um reinício, criação e revogação devolviam sucesso sem provar a raiz.
**Correção (`src/lib/link-audit-ledger/store.ts`, `service.ts`, `model.ts`, `ledger-port.ts`, `pending-panels.tsx`):**
1. A raiz é sincronizada em **toda publicação, antes de gravar** (fail-fast: falha ⇒ nada publicado, base travada, `DECISIONS_DURABILITY_UNKNOWN`).
2. **Precedência**: qualquer falha de fsync observada na publicação vale mais que ENOSPC/conflito/sucesso.
3. **Estado não resolvido**: com a base travada o livro é lido como `HISTORY_UNRESOLVED/DURABILITY_UNKNOWN` (nada vigente, nada finalizável), nunca "protegido" nem "vazio". Novo motivo, texto na tela; payload validado contra o validador estrito da tela.
4. Reenvios idempotentes: confirmada ⇒ `ledger.port.sync` (pasta + raiz, já da etapa anterior); pendente ⇒ pais das decisões e dos recibos; adoção e RECOVER já sincronizam livro + raiz.
**Custo medido** (150 publicações, ext4 do WSL): fsync da raiz ≈ **0,25 ms** contra ≈ **10 ms** por registro publicado (**≈ 2,5 %**); em tmpfs 0,26 ms contra 1,6 ms. Mantida a sincronização em toda publicação (sem cache: um cache por processo só ajudaria depois de um sucesso e não mudaria a garantia, mas acrescentaria estado compartilhado). Ressalva: a raiz dos testes tem uma só pasta de auditoria; o custo com milhares de auditorias não foi medido.

## 2. Reproduções adversariais (antes da correção ⇒ depois)
| Reprodução | Antes | Depois |
|---|---|---|
| C1: fsync da raiz falha numa gravação comum; reinício; CREATE/REVOKE/RECOVER | sucesso sem tocar a raiz | sem sucesso e **nada publicado**; após o reinício só conclui com a raiz sincronizada (`-m2`, processos reais) |
| C2: fsync da raiz falha junto com ENOSPC | `WRITE_FAILED`, base livre, 2ª tentativa com sucesso | `DECISIONS_DURABILITY_UNKNOWN`, base travada, 2ª tentativa recusada |
| Leitura depois da falha | `PROTECTED` | `HISTORY_UNRESOLVED/DURABILITY_UNKNOWN` |
| Reemissão de recibo repetida com o recibo falhando (política de 40 registros) | 33 reenvios ⇒ `EXHAUSTED` (0 revogações); ~39 ⇒ reenvio nem cabe e **a auditoria fica presa em `RECEIPT_REMOVED` mesmo com o disco curado** | máx. 1 `RECEIPT_REISSUED`; reenvio conclui; revogação e rotação seguem possíveis |

## 3. Mutantes R7-11 (relatório original nº 7 recuperado)
| Mutante | Situação | Teste |
|---|---|---|
| MA1 época A,B,A,B no meio da cadeia | **morto** | `-r711` (puro) |
| MB2 base não trava após falha de durabilidade | **morto** (falha INTERMITENTE em processo; 2ª tentativa recusada, reiniciado conclui) | `-r711`, `-m2` |
| MA12 reenvio de pendente ignora a durabilidade do recibo | **morto** | `-r711` |
| MA13 recibo fora do observador | **morto — NÃO é equivalente**: só aparece com falha intermitente DENTRO da gravação do recibo (o `syncStrict` seguinte teria sucesso sem ver o erro) | `-r711` |
| MA15 adoção sem `verifyTags`/`replay` | **morto** (CONFIRMED de forma idêntica com etiqueta de chave desconhecida) | `-r711` |
| MA16 adoção sem conferir `opId` | **EQUIVALENTE com condição**: `replayLedger` exige o mesmo `opId` entre INTENT e CONFIRMED (`SAME_FIELDS` em `model.ts`); o teste prova a recusa por ambas as camadas. Deixa de ser equivalente se a checagem de MA15 também for removida | `-r711` |
Extras mortos nesta rodada: pais das decisões/recibos no reenvio de pendente (F7/F8), pais na fase C, adoção (M20 — o teste R1c precisou isolar a pasta da auditoria porque o fail-fast da raiz passou a falhar antes), raiz em toda publicação, fail-fast, precedência, trava da base, estado `DURABILITY_UNKNOWN`, pulo da reemissão. **Bateria final: N01–N17 (15 mortos na 1ª rodada; N16 — fase C sem os pais — morto após o teste novo; N14 = MA16 equivalente) e M01–M24 (M06, M07 e M18 obsoletos por mudança do trecho, cobertos por N01/N16/N17; M20 reforçado e morto).** Cada mutação foi aplicada ao `src/` e restaurada, com conferência da árvore.
**Lacuna que o revisor ainda aponta (INFO):** MB2b — nenhum teste prova que falha em `syncLedgerDirectory` (RECOVER/replay/adoção) trava a base.

## 4. Avaliação da reserva de capacidade (RECEIPT_REISSUED e outros consumidores)
- **Reproduzido** (§2): reenvios repetidos com o recibo falhando esgotavam a reserva de revogação e de manutenção e travavam a auditoria. Classificado como achado a corrigir; corrigido com `reissue()` idempotente (mesma operação + mesmo hash de entrada depois do `CONFIRMED` ⇒ não grava outro registro). **Custo declarado:** remoções repetidas do mesmo recibo ficam registradas uma vez só.
- **O revisor reabriu como MAJOR (D1):** esse pulo devolve `OK` **sem sincronizar o livro**; depois de uma falha de fsync na publicação do `RECEIPT_REISSUED` e de um reinício, o reenvio conclui sem nunca provar o registro (reproduzido: `[]` fsyncs do livro). **Não corrigido (interrupção ordenada).**
- INTENT+ABORTED por tentativa falha: limitado a **1 tentativa por `staleOperationMs` (120 s)** (teste `-capacity-burn`); esgotar a reserva de 100 revogações exigiria ≈ 3,3 h de falha contínua do disco de decisões com retentativas. Não reproduzido. `RECEIPT_REISSUED` segue sem limite de CLASSE (D3, INFO): 1 por recibo removido, perto do limite pode deslocar a próxima revogação.
- A política de capacidade **não foi alterada**.

## 5. Testes finais (árvore final antes do parecer; código idêntico ao revisado)
`tsc` 0 erros; suíte completa isolada **1900/1900** (baseline 1888); build offline ok; Chromium **I5 41/41, I6 107/107, I7 171/171 (+3 SKIPPED)**, I7 repetido 5× isolado: 171/171 em todas; `git diff --check` limpo; `src/lib/link-audit/scoring/` com 0 diferenças contra `v1.0.1`. Testes novos: `-m2` (5), `-r711` (6), `-capacity-burn` (1) + ajustes em `-crash` e `-review7`.

## 6. Mudança de semântica a ratificar
Com a base do livro travada (fsync/EIO/EROFS neste processo) a **leitura** deixa de ser `PROTECTED` e passa a `HISTORY_UNRESOLVED/DURABILITY_UNKNOWN` para TODAS as auditorias daquela base até reiniciar (antes só as escritas paravam). Motivo: impedir que um resultado seja selado citando uma cabeça talvez não durável. Efeito: um único EIO congela a leitura protegida do volume do livro até o reinício (disponibilidade; falha fechada).

## 7. Riscos residuais
D1 (MAJOR, bloqueia o commit); janela pós-reinício (leitura não prova durabilidade; o revisor sugere sincronizar o livro antes de selar resultado — MINOR evitável); MB2b (teste); D3; livro fixo de 4000; ≈ 3,4 s por `list`/`revoke` com ~3990 registros; R7-08 (texto nativo/nome de arquivo em `DECISIONS_INTEGRITY`, 6B, INFO, não corrigido); queda de energia real e volume de produção não ensaiados; guarda externa e papel administrativo continuam bloqueadores de produção.

## 8. Recomendação
**BLOQUEAR COMMIT.** Próximo passo (aguarda autorização): corrigir D1 (sincronizar o livro no pulo da reemissão), escrever o teste T3 e o de MB2b, avaliar o `sync` antes de selar resultado, e re-verificar com o mesmo revisor.
