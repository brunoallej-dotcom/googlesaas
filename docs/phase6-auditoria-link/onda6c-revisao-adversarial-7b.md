# Onda 6C — Revisão independente nº 7b: re-verificação das correções pós-revisão (05/11/2026)

**Parecer: BLOQUEAR COMMIT.** O revisor independente reabriu **1 MAJOR** (M2, durabilidade do diretório-pai, incompleto na raiz do LIVRO). Pela regra do responsável o processo foi **interrompido**: nenhuma correção nova foi iniciada nesta etapa, nenhum código foi alterado antes nem depois da revisão. SEM commit; Onda 6C NÃO encerrada.

**Revisor:** o mesmo que identificou o BLOCKER e os três MAJOR da primeira rodada (contexto retomado), em instantâneo da árvore final (`review-r7b`); leu o código e os diffs pós-revisão antes de qualquer conclusão do implementador. Saída de revisor automatizado; não é aprovação do responsável.

## Parecer por correção

| Correção | Parecer independente | Observação |
|---|---|---|
| B1 — R7-09 (INTENT de relógio futuro) | **FECHADO** | Idade inteira; ABORTED durável; reinício só adia o prazo (nunca prende); duas instâncias ok; data inválida (NaN) segura |
| M1 — adoção de CONFIRMED alheio | **FECHADO** | Falha de fsync do dono ⇒ `DECISIONS_DURABILITY_UNKNOWN`; reenvio após reinício conclui sem duplicar |
| M2 — fsync do diretório pai | **NÃO FECHADO (MAJOR)** no LIVRO; 6B ok | `publishLedgerRecord` sincroniza a raiz do livro só quando a pasta da auditoria é criada naquele momento; criação e revogação normais nunca a ressincronizam depois de um reinício (C1); com EIO no fsync da raiz + ENOSPC na mesma publicação a falha de fsync é descartada e a base não trava (C2) |
| M3 — `RESULT_LEDGER_MISMATCH` espúrio | **FECHADO** | Citação forjada permanente: bloqueia em 97 ms sem gravar; alternada: 3 releituras, recusa em 204 ms, nada gravado |
| Contrato da tela | **Consistente** | Fases A, B, C, resposta do RECOVER e fecho descontado aceitos pelo validador estrito |

**Confirmação do implementador do achado C (leitura do código, `src/lib/link-audit-ledger/store.ts:110-117` e `:128-140`):** a sincronização da raiz está condicionada a `!hadDirectory` e o caminho de falha devolve `WRITE_FAILED` sem consultar `watch.failure()`. O achado é procedente. Não foi corrigido por ordem do responsável (não iniciar nova rodada).

## Riscos residuais classificados (sem aceite automático)

| Risco | Integridade | Disponibilidade | Recuperação legítima |
|---|---|---|---|
| `RECEIPT_REISSUED` sem limite de classe | nenhum | **ALTA no pior caso** (~214 tentativas falhas consomem as reservas de revogação e manutenção; exige escrita nos recibos ou disco cheio + reenvios) | **nenhuma** se a rotação estiver pendente e o livro cheio: chave antiga vence ⇒ `KEY_EXPIRED` sem procedimento administrativo |
| Reenvio de decisão já confirmada recusado por capacidade | nenhum | baixa | a lista mostra a decisão; o texto "nada foi gravado" é enganoso |
| Limite fixo de 4000 registros | preservada (falha fechada) | auditoria encerra em ~1863 decisões / 1965 entradas | nenhuma hoje (sem segmentação nem papel administrativo) |
| Custo ≈ 3,4 s com ~3990 registros | nenhum | cada escrita segura a trava ~3,5 s; risco de timeout em proxy | revogação no limite funciona, lenta |

Por isso o primeiro e o terceiro **não são "aceitáveis" sem condição**: ambos são **bloqueadores de produção** enquanto não existirem a reabertura/segmentação administrativa (spec §16.12) e um limite de classe para a reemissão. Não bloqueiam, por si, a decisão de commit local, mas ficam registrados.

## R7-08 e R7-11 (texto original recuperado em 05/11/2026)
O relatório original nº 7 foi recuperado (ver `onda6c-revisao-adversarial-7.md`, fim do arquivo). **R7-08** (texto nativo/nome de arquivo em `DECISIONS_INTEGRITY`): confirmado, INFO, pré-existente na 6B, **não corrigido**; não permite negação de serviço, autenticação indevida nem bloqueio de recuperação (só informação). **R7-11** (qualidade dos testes): dos sobreviventes originais, **MA1, MB2, MA12, MA13, MA15 e MA16 continuam sobrevivendo** aos testes do repositório (confirmado por duas rodadas independentes: a do revisor e a do implementador, em cópia da árvore); MA4 foi substituído pela política por classe e hoje é morto. (Anotação do implementador, fora do texto do revisor: o mutante C1 do revisor — folga da INTENT +2→+1 — é morto por `tests/link-audit-ledger-authority.test.ts`, que o revisor não rodou; o implementador o confirmou por mutação.) O código está correto nesses pontos; a lacuna é de teste. MA16 é equivalente (o replay já exige o mesmo `opId`); MA13 provavelmente equivalente. **Teste novo necessário (não feito):** época A,B,A,B; base travada após falha **intermitente**; reenvio de pendente com fsync do recibo e do pai das decisões; adoção com CONFIRMED de tag inválida.

## Lacunas de verificação declaradas
Queda de energia real e volume de produção; rotas HTTP/Next empacotado; dois relógios distintos entre processos reais; suíte completa pelo revisor (a suíte completa é do implementador, abaixo).

## Texto integral do revisor (sem alteração)

```
REVERIFICAÇÃO INDEPENDENTE (snapshot final review-r7b) — relatório

## Veredito curto
- Ainda há **1 MAJOR** em aberto: a correção de M2 está incompleta no LIVRO (item C).
- O BLOCKER B1 e os MAJOR M1 e M3 estão **corrigidos e reproduzidos como fechados**.
- Achei várias lacunas de teste (G): o código hoje está correto nesses pontos, mas a mutação inversa passa despercebida pelos testes do repositório.

## Como trabalhei e o que rodou
- Escrevi só na minha cópia (rv7b). Não toquei em ~/projects nem em /mnt/d, não acessei rede, Redis, Supabase nem VPS, e não fiz commit.
- Comparei a árvore inteira com `diff -ru review-r7 review-r7b`: o resultado bate com POST-REVIEW-src.diff. Mudaram store.ts da 6B e model.ts, observed.ts, service.ts e store.ts do livro. validators.ts não mudou.
- Provas novas: rv7b/tests/zz-r7b.test.ts (8/8; os testes de "DEFEITO" passam porque o defeito existe), zz-r7b-extra.test.ts (3/3), r7b-mut/run.py (15 mutantes).
- Rodada base dos testes do repositório sem mutação (review7, durability, clock, r6, stale-evidence, consistency, replay-durability): 40/40 passam.

## C) M2 — MAJOR, NÃO FECHADO para a raiz do LIVRO
A correção sincronizou os pais da 6B em toda gravação (decisions/store.ts:362, 455, 462) e acrescentou a raiz do livro em `syncLedgerDirectory`. Mas `publishLedgerRecord` continua sincronizando a raiz só quando a pasta da auditoria é criada naquele momento (link-audit-ledger/store.ts:110 e 117). Criação e revogação não chamam `ledger.port.sync`, então o caminho normal de escrita nunca ressincroniza a raiz do livro.

C1 (processo real, com reinício)
- Inscrição com o fsync da raiz falhando: {"ok":false}, mas o GENESIS ficou gravado.
- Depois do reinício, criação e revogação respondem ok:true.
- O registro de fsync mostra os pais da 6B (lad-dec, lad-anc) e a pasta da auditoria do livro, **nunca a raiz lad-led**.
- O teste R3 do repositório (review7.test.ts) passa só porque o mesmo registro inclui um RECOVER, e só o RECOVER sincroniza a raiz.

C2 (sem reinício)
- Se o fsync da raiz falha (EIO) junto com um ENOSPC na mesma publicação, o caminho de falha devolve WRITE_FAILED (store.ts:140) e descarta a falha de fsync já observada. A base não trava.
- A 2ª inscrição tem sucesso e a criação seguinte também, com 0 fsyncs bem-sucedidos da raiz.
- Isso contradiz a especificação §16.13 (6): "o diretório-pai é sincronizado em TODA gravação e retomada".

Impacto: se o nome da pasta da auditoria se perder numa queda, o livro some (ABSENT). A auditoria cai em LEGACY_READ_ONLY ou LEDGER_REMOVED_WITNESSED, permanente e sem caminho administrativo. A falha é fechada, mas um sucesso "durável" foi devolvido.

## A) B1 / R7-09 — corrigido; não consegui quebrar
- O teste R6 do repositório e o meu A3 (com performance.now real e com a prévia sem relógio) gravam o ABORTED com ageMs inteiro. O mutante que tira o Math.floor é morto (clock e review7).
- A1, reinício e duas instâncias: o prazo recomeça do zero depois do reinício (só adia, nunca prende). A instância antiga, já vencida, aborta; a nova aceita o ABORTED, o RECOVER dela é idempotente e a escrita volta a funcionar. O ABORTED gravado tem observed.ageMs=120000.
- A2, data inválida: Date.parse('2026-13-01…') dá NaN e cai no caminho da observação (inteiro ≥ 0). '2026-02-31' rola para março. Os registros são assinados pelo servidor e nowIso é validado, então não é explorável.
- A observação nunca dá idade maior que o tempo real decorrido, portanto não aborta operação viva antes do que o relógio de parede abortaria. Uma pendência só fica irrecuperável se o processo reiniciar a cada menos de 120 s (só adia).
- INFO A-1: com relógio pulando para frente (futuro → normal → futuro), quem manda é a idade pelo relógio de parede. Um processo com relógio adiantado em mais de 120 s pode abortar a fase A de outro processo vivo, o que leva a PUBLISHED_AFTER_ABORT. Isso já existia antes da correção. No mesmo processo é impossível, porque o withLock serializa as escritas. Não testei com dois relógios diferentes.
- INFO A-2: o ABORTED.recordedAt herda a hora futura (laterOf), então todas as operações seguintes também dependem da observação até o relógio real alcançar essa hora. Funciona, mas cada reinício reinicia os 120 s.
- INFO A-3 (não verificado): se o Next empacotar uma cópia de PROCESS_OBSERVATIONS por rota, a lista (GET) pode mostrar recoverable:true enquanto a rota do RECOVER ainda conta o seu próprio prazo. Isso atrasa a recuperação, não a impede.

## B) M1 — corrigido; não consegui quebrar
- R1 e R1c do repositório e o meu B1 (outro processo real conclui o CONFIRMED com o disco saudável, e o fsync do próprio dono falha depois da adoção): a 1ª resposta é DECISIONS_DURABILITY_UNKNOWN; o reenvio sem reiniciar continua UNKNOWN (base travada); depois do reinício o MESMO pedido conclui com replayed=true; o livro fica GENESIS, INTENT, CONFIRMED, sem duplicata. O mutante que remove o fsync na adoção é morto.

## D) M3 — corrigido sem mascarar adulteração
- A citação adiantada só provoca nova leitura dentro do revalidate (service.ts:287), limitada a 3 releituras.
- D1: resultado forjado citando ledgerSeq 999 de forma permanente. A lista mostra RESULT_LEDGER_MISMATCH; criação, revogação e RECOVER são recusados em 97 ms, sem gravar nada.
- D2: testemunha alternando, com a citação forjada só na releitura. A recusa vem em 204 ms, depois de 3 releituras; nada é gravado, nem CHECKPOINT.
- Um retrocesso real do livro é pego já na avaliação inicial (os resultados são lidos antes do livro). O mutante que desliga o citedAhead é morto (R2).
- INFO: sob gravação e selagem contínuas, mais de 3 corridas seguidas ainda podem gerar uma recusa espúria transitória (limitado). Não medi.

## E) Contrato com a tela — consistente
- Com payloads REAIS: fase C (HISTORY_UNRESOLVED/LEDGER_BEHIND com openOperation C e capacidade), resposta do RECOVER e operação aberta com fecho descontado (used 4, remaining 9, decisionsAvailable 1): o validador da tela aceita.
- O validador exige used + remaining = max e o nível coerente com as contagens; o servidor calcula o nível das mesmas contagens. Não achei combinação que quebre. ageMs é sempre inteiro.
- O teste de contrato do repositório usa a resposta REAL do servidor (fases A e B). Fase C e RECOVER não estavam cobertos; cobri em E1.
- limits.maxEntries com operação aberta subconta em 1 (conservador; não validado pela tela). Limite: não montei REVOKE_ONLY nem EXHAUSTED com operação aberta pelo serviço; avaliei pelo código.

## F) Riscos residuais (Integridade / Disponibilidade / Recuperação legítima)
1. RECEIPT_REISSUED sem limite de classe (reproduzido: 6 tentativas com ENOSPC geram 6 registros). Integridade: nenhum impacto. Disponibilidade: ALTA no pior caso — cerca de 214 tentativas falhas consomem a reserva de revogação e a de manutenção, levando a REVOKE_ONLY e depois EXHAUSTED (exige escrita nos recibos ou disco cheio, mais o autor reenviando). Recuperação: NENHUMA — com a rotação pendente e o livro cheio, a chave antiga vence, a auditoria cai em KEY_EXPIRED e fica HISTORY_UNRESOLVED sem procedimento administrativo.
2. Reenvio de decisão já confirmada recusado por capacidade. Integridade: nenhum impacto (nada é gravado). Disponibilidade: baixa. Recuperação: a lista mostra a decisão; o texto "Nada foi gravado" é enganoso e pode induzir a uma ação repetida.
3. Limite fixo de 4000 registros. Integridade preservada (falha fechada). Disponibilidade: auditoria encerrada em cerca de 1863 decisões ou 1965 entradas. Recuperação: nenhuma hoje (falta segmentação e o papel administrativo); com o livro 100% cheio a rotação é impossível.
4. Custo ~3,4 s (list 3373 ms, revoke 3475 ms com 3990 registros). Integridade: nenhum impacto. Disponibilidade: cada escrita segura a trava da auditoria cerca de 3,5 s; risco de timeout em proxy; leituras repetidas amplificam carga (limitador 30/min por operador). Recuperação: a revogação no limite funciona, só é lenta.

## G) R7-08 e R7-11 — não endereçados no repositório
R7-08 (INFO, confirmado): com chmod 000 em d0001.json, a lista responde DECISIONS_INTEGRITY com a mensagem "d0001.json: leitura: EACCES EACCES: permission denied, open '[caminho]'". Vem de decisions/service.ts:233 (o código está no conjunto DETAILED). Não sai caminho absoluto, mas saem nome de arquivo e texto nativo, o que contradiz o comentário em shared.ts:21.

R7-11 (mutantes rodados contra os testes do repositório):
- MA1 (época no meio da cadeia): SOBREVIVE (r6, keys, model, rotation). A cadeia A,B,A,B com B atual seria aceita. Código correto, lacuna de teste.
- MB2 (base do livro não trava após falha de durabilidade): SOBREVIVE. O teste "base travada" do r6 usa um FS que continua falhando, então não distingue.
- MA12 (remover a checagem de durabilidade do recibo no reenvio de pendente): SOBREVIVE. Lacuna real: é a linha que a correção de M2 tocou (store.ts:462) e nenhum teste a protege.
- F7 (tirar o pai das decisões do reenvio de pendente, store.ts:455): SOBREVIVE. Não é equivalente: nesse caminho nada mais sincroniza o pai das decisões. Lacuna de teste da própria correção de M2.
- MA13 (recibo sem observador): SOBREVIVE; provavelmente equivalente (o syncStrict observado roda logo depois).
- MA15 (adoção sem verifyTags/replay): SOBREVIVE. Defesa em profundidade sem teste negativo.
- C1 (folga da INTENT +2 → +1): SOBREVIVE (capacity, protocol, review6). Equivalente na prática: o prepare já impõe operationCost na mesma sessão.
- F1–F6 (as correções desta rodada): MORTOS, exceto F7. C2 (RECOVER sem fecho) e C3 (manutenção −1): MORTOS.
Os testes do outro revisor que matavam MA1, MA4, MA12, MA13 e MB2 (zz-rv7-keys, zz-rv7-kill) não estão no repositório. O MA4 original (reserva de 4) foi substituído pela política por classe.

## H) Outros
- MINOR (já relatado antes, segue aberto): o caminho de reemissão de recibo (prepare REISSUE_RECEIPT e reissue()) grava sem revalidate/witnessBlock. Hoje é benigno.
- Não achei outro BLOCKER.

## O que NÃO verifiquei
Queda de energia real ou o volume de produção (só injeção de falha e SIGKILL); rotas HTTP e Next empacotado; dois relógios diferentes entre processos reais; a suíte completa do repositório (só os arquivos citados).
```
