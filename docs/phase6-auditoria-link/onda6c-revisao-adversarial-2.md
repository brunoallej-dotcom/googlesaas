# Onda 6C — Revisão adversarial INDEPENDENTE de segurança (2ª rodada) sobre a remediação do MAJOR-1

Data: 31/10/2026 · Objeto: `review-r2/proj/` (árvore corrigida, NÃO commitada; base `bd7c4fb` + `remediation-src.patch` + `untracked.txt`) · Revisor: agente Claude (Opus 5.5), subagente independente, sem acesso ao raciocínio do implementador. Mesma família de tecnologia do implementador ⇒ risco de pontos cegos correlacionados; **não substitui revisão humana**.

Ordem seguida: relatório original → código (`link-audit-origin`, stores, serviços, rotas, UI, `snapshot-store`) → experimentos próprios → por último os documentos do implementador (ADR 6C-02, modelo de ameaças, §15/§16 da 6B, checklist).

---

## 1. Veredito

**APROVADO COM RESSALVAS** — nenhum BLOCKER/MAJOR aberto: o MAJOR-1 está fechado para o atacante A1 nas pastas de decisões e de resultados (14 variantes de forja recusadas, nenhum recibo criado) e o MINOR-1 está fechado nos leitores da Auditoria por Link; restam 4 MINOR e 6 INFO (abaixo), nenhum dos quais permite a A1 tornar CONFIRMADO/ACTIVE/PONTUADO um registro que o servidor não gravou.

---

## 2. Achados desta rodada

Escala: BLOCKER · MAJOR · MINOR · INFO. "CONFIRMADO" = reproduzido por mim nesta rodada; "PLAUSÍVEL" = não reproduzido.

### R2-MINOR-1 — A pasta de EVIDÊNCIAS é uma raiz de confiança fora da prova de origem: fatos forjados ali viram resultado CONFIRMADO com etiqueta válida — CONFIRMADO (RV2-F1)

- **Onde:** `src/lib/link-audit-evidence/store.ts:117-127,372-452` (selo só SHA-256; `writeCapture` não exige nenhum segredo), `src/lib/link-audit-scoring-runs/results.ts:343-355` (`changedPinnedEvidence` só fixa evidência JÁ usada por resultado anterior), `results.ts:495` + `results-store.ts:326-327` (o servidor assina o que o mapeador produziu). Modelo de ameaças `onda6c-modelo-de-ameacas-recuperacao.md` §2 lista só as 4 pastas graváveis; a pasta de evidências não aparece como ator/limite.
- **Descrição:** quem escreve SÓ na pasta de evidências (sem chave, sem sessão) acrescenta uma captura nova com corpo inventado, selada pelo próprio pipeline do coletor (SHA-256 não autentica), mantendo CID/placeId. A prévia passa a usar os fatos forjados; um operador de boa-fé finaliza; o servidor grava e ASSINA o resultado (`origin` válido) e o recibo. Nada é `stale`, integridade `OK`.
- **Passos:** `rv2/zz-rv2-f-evidence.test.ts` (teste RV2-F1): `world()` real → `writeCapture`+`writeSiteObservation`+`writeReport` com `bodyText({title:'Padaria FORJADA pelo invasor', phoneNumber:'(11) 90000-1234', address:'Avenida Inventada, 999…'})` → `previewOver(w).evaluate` → `makeService(e, preview).finalize(...)`.
- **Saída obtida (`rv2/rv2-f.out`):**
  `fatos antes = {"name":"Padaria Exemplo (fictícia)","phone":"(62) 99999-0000",…} ; fatos agora = {"name":"Padaria FORJADA pelo invasor","phone":"(11) 90000-1234","address":{"raw":"Avenida Inventada, 999 - Outra Cidade - SP"}} ; desfecho = INCONCLUSIVO cobertura 11 finalizável = true bloqueios = []` → `finalização … ⇒ CONFIRMADO s1` → `registro gravado: origin presente = true ; profileSource = capture:c0002 ; telefone no input = "(11) 90000-1234"` → `lista ⇒ [[1,"INCONCLUSIVO",11,false]] integridade OK`.
- **Impacto:** fatos fabricados num resultado definitivo "com origem comprovada" (a etiqueta prova que o SERVIDOR gravou, não que os fatos são verdadeiros). Limitado hoje: o mapeador só emite 7 campos observados com `complete:false` ⇒ só INCONCLUSIVO (sem índice); em produção o volume de evidências é `:ro` no web (o escritor é o coletor). É o "SHA-256 é selo, não assinatura" já aceito na 1ª rodada, mas não declarado no novo modelo de ameaças, onde "origem comprovada" pode ser lido como autenticidade ponta a ponta. A Onda 7 (PDF) exibiria os fatos.
- **Correção sugerida:** declarar a pasta de evidências como raiz de confiança no modelo de ameaças/ADR ("a etiqueta não cobre a verdade das evidências"); a médio prazo, autenticar as capturas na coleta (chave do coletor fora do volume, ou recibo/manifesto da coleta fora da pasta de evidências) e a Onda 7 mostrar a proveniência (captura, data, hash).

### R2-MINOR-2 — MINOR-2 tratado só para o AUTOR; quem decide a quarentena não é avisado, e existe uma testemunha (6B) que o sistema não usa — CONFIRMADO (RV2-B1, RV2-A3b, RV2-W2)

- **Onde:** `src/components/link-audit/audit-page/pending-panels.tsx:107-109` e `:154-158` (ramo "outro operador": sem o aviso "interrompida × removido", que só existe nos ramos `isMine`, `:95-97` e `:142-144`); `onda6c-modelo-de-ameacas-recuperacao.md` §6.1 ("Não existe, no armazenamento atual, nenhum dado que diferencie…"); `onda6b-decisoes-humanas.md` §15 item 3.
- **Descrição:** (a) só o autor vê que a pendência pode ser um registro JÁ CONFIRMADO cujo recibo foi removido; outros operadores/administradores — justamente quem conduz a quarentena quando o autor não volta — veem apenas "Somente o autor pode concluí-lo". (b) Quem escreve só nos recibos das decisões remove o recibo de uma REVOGAÇÃO confirmada: a decisão revogada volta a aparecer vigente e é APLICADA na prévia (finalização bloqueada); se a quarentena "mover a pendente", a revogação some e a decisão ressuscita de fato. (c) Ao contrário do §6.1, na 6B há dado que distingue: o `decisions.head` gravado em um resultado (outra pasta) coincidiu exatamente com a "pendente" — o sistema não usa isso para alertar.
- **Passos / saídas:**
  - `rv2/zz-rv2-b-ui.test.tsx` (rodado como `proj/tests/zz-rv2-b-ui.test.tsx`, removido depois): `[RV2-B1] resultado/outro operador ⇒ "Resultado s0004 gravado e NÃO confirmado (sem recibo): ele não vale. Gravado por outro operador (origem comprovada pelo servidor). Somente o autor pode concluí-lo. …"`; `menciona "removido": resultado/outro = false ; decisão/outro = false` (autor: `true`).
  - `rv2/zz-rv2-a-origin-bypass.test.ts` (RV2-A3b): `recibo da REVOGAÇÃO removido ⇒ vigentes = [["op-0001","ACTIVE"]] pending = ["REVOKE","PROVEN",false] finalizable = false`; `prévia … ⇒ {"applied":["op-0001"],"allowed":false,"blockers":["DECISION_PENDING"]}`.
  - `rv2/zz-rv2-w-witness.test.ts` (RV2-W2): `decisão pendente = {"seq":2,"action":"REVOKE","origin":"PROVEN","entrySha256":"016917bc…"} ; head gravado no resultado s1 = {"seq":2,"sha256":"016917bc…"} ; coincide = true`; resultado s1 `{"stale":true,"decisionsChanged":true}`, integridade `OK`.
- **Impacto:** com erro operacional induzido (quarentena), um atacante de UMA pasta (recibos) apaga em definitivo o último resultado confirmado ou ressuscita uma decisão revogada. Exige pasta de recibos + ação humana; o runbook §15 item 3 manda comparar com o `head` externo (ainda não implementado). A remediação é honesta quanto à indistinguibilidade no arquivo em si, mas a tela não protege quem efetivamente faz a quarentena.
- **Correção sugerida:** mostrar o aviso de ambiguidade a TODOS os perfis (e no painel de resultados); quando `(pending.seq, pending.entrySha256)` de uma decisão coincidir com o `decisions.head` de algum resultado confirmado, sinalizar "recibo removido de decisão já confirmada — não mover para quarentena; restaurar o recibo"; ajustar o §6.1 ("na 6B, os resultados já testemunham parte dos casos").

### R2-MINOR-3 — Afirmação de não-repúdio mais forte que o código: a leitura NÃO confere a origem de registros CONFIRMADOS — CONFIRMADO (RV2-W1, RV2-A7)

- **Onde:** `onda6c-modelo-de-ameacas-recuperacao.md` §5 ("Repudiation: decisão/resultado ACTIVE só existe se o servidor o gravou em nome de uma sessão; a etiqueta cobre o autor"); ADR §4 "Onde não exige: leitura do histórico confirmado"; `store.ts:327` / `results-store.ts:327` (sem autenticador, a gravação nova sai SEM etiqueta e é confirmada normalmente; só as rotas impedem isso).
- **Descrição/saída:** RV2-W1 — quem escreve dados + recibos (limite declarado no §6.3) cria `d0001`+`a0001` sem etiqueta em nome de ANA: `vigentes = [["op-0001","ACTIVE","ana@empresa.com"]] origin no arquivo = undefined finalizable = true`, integridade `OK`, nenhum aviso. RV2-A7 — `createDecisionService` sem `origin`: `serviço SEM chave gravou entrada nova CONFIRMADA? true origin no arquivo = undefined`.
- **Impacto:** a frase do §5 é falsa para o atacante de duas pastas, para dados legados e para qualquer chamador futuro da biblioteca sem chave. Não é bypass de A1.
- **Correção sugerida:** corrigir o §5. Recomendação (barata, pois a 6B/6C nunca foi implantada e toda entrada de produção nascerá assinada): verificar a etiqueta também dos CONFIRMADOS em modo NÃO bloqueante (sinal "origem não comprovada" na lista/detalhe, sem impedir a leitura), fazer `appendEntry`/`appendRun` recusarem gravação nova sem autenticador (falha fechada na própria primitiva), e a Onda 7 exigir `PROVEN` no resultado que imprimir.

### R2-MINOR-4 — Procedimento de rotação por COMPROMETIMENTO mantém a chave vazada válida; chave previsível é aceita — CONFIRMADO (`rv2/key-checks.ts`)

- **Onde:** `onda6c-modelo-de-ameacas-recuperacao.md` §6.5 ("Resposta: … rotação (`…_PREVIOUS`)"), `onda6c-checklist-producao.md:44`; `src/lib/link-audit-origin/index.ts:71-74` (`isStrongKey`: ≥32 bytes e ≥12 caracteres distintos), `:62-65` (`kid` público derivado da chave).
- **Saída (`rv2/rv2-key.out`):** `forja assinada com a chave VAZADA depois da rotação com _PREVIOUS = PROVEN`; `chave humana previsível aceita = true` (`'GmnLinkAudit2026!GmnLinkAudit2026!'`); `chave achada por dicionário a partir só do kid = true (0.23 ms para 4 palpites)`; `kid(chave) === kid(chave+"\n") = false`.
- **Impacto:** seguindo o texto do §6.5 após um vazamento, o invasor continua produzindo pendências `PROVEN`. Chaves "humanas" passam na validação e o `kid` (gravado em todo arquivo) permite testar palpites offline (o próprio `tag` também permitiria; o `kid` só barateia). Uma quebra de linha no segredo muda o `kid` (réplicas divergentes).
- **Correção sugerida:** no procedimento, separar rotação de rotina (com `_PREVIOUS`) de comprometimento (SEM `_PREVIOUS`; pendências assinadas pela chave antiga vão para quarentena); exigir chave em base64/hex que decodifique para ≥32 bytes aleatórios (ou ao menos documentar o risco); aparar `\r\n` finais de forma consistente ou recusar.

### R2-INFO-1 — Selo e etiqueta cobrem o texto canônico (NFC), não os bytes — CONFIRMADO (RV2-A4)
`src/lib/link-audit/canonical.ts:30` normaliza para NFC; `files.ts:88` compara os bytes com `JSON.stringify` do próprio JSON (não com o NFC). Reescrever uma decisão CONFIRMADA (ou pendente) trocando NFC↔NFD passa sem alarme: `bytes mudaram = true ; leitura = OK, justificativa NFD=true`; pendente reescrita `origin = PROVEN`. Só muda a representação de texto canonicamente equivalente; sem impacto prático conhecido. Sugestão: exigir `text === text.normalize('NFC')` na leitura estrita, se se quiser "um registro = uma sequência de bytes".

### R2-INFO-2 — Quem escreve só nos RECIBOS confirma uma pendente legítima pulando também as reconferências da conclusão — CONFIRMADO (RV2-A3a)
Declarado no ADR §6 / modelo §6.2 ("sem ação do operador"), mas não que também pula a defesa em profundidade: o servidor recusaria a conclusão (`EVIDENCE_HASH_CHANGED`), e o recibo forjado a confirma (`results = [[1,"INCONCLUSIVO","bia@empresa.com",true]] pending = null integrity = OK`; só `stale:true`). Conteúdo é autêntico (gravado pelo servidor). Sugestão: completar o texto.

### R2-INFO-3 — Leitor bloqueante FORA da 6C no mesmo processo web — CONFIRMADO (`rv2/rv2-d-fifo.out`, cenário `pdf-serve-fifo`)
`src/lib/pdf/serve.ts:59-69` usa `fs.readFile` direto. FIFO `relatorio.pdf` na pasta de PDFs: `"race":"TRAVADO após 3 s"`, `process.exit(0)` não encerra, filho morto por SIGKILL (`exit=124`, 20 s). Fora do escopo da Onda (Fase 5), mesma classe do MINOR-1; sugere-se reutilizar o padrão de `nodeFsOps.readFile`.

### R2-INFO-4 — Detalhes de interface — CONFIRMADO por render (RV2-B1) / leitura
(a) Pendência NÃO comprovada de decisão ainda mostra `Revogação de op-0001 · 30/10/2026…` (dados do arquivo) logo antes de dizer que "o conteúdo e o autor indicados no arquivo não são exibidos" (`pending-panels.tsx:118,125`); e diz que "enquanto não for concluída, a decisão revogada ainda aparece como vigente" para algo que nunca será concluído. (b) `PendingDecisionPanel` usa `key={seq}` (`decisions-panel.tsx:50`), não o hash da entrada: a caixa marcada sobrevive à troca de uma pendência por outra no mesmo `seq` (teórico; o servidor só conclui o que veio no corpo). (c) `attachmentSha256` (campo opcional do contrato 6A) não é exibido entre os campos conferidos.

### R2-INFO-5 — Produção: a chave não está provisionada no deploy
`deploy/hostinger/*` não referencia `GMN_LINK_AUDIT_ORIGIN_KEY` (busca sem resultado); com as rotas, o efeito é 503 nas escritas (falha fechada). O checklist cobre; não há suporte a segredo por arquivo (`*_FILE`), e um segredo lido de arquivo costuma trazer `\n` (ver R2-MINOR-4).

### R2-INFO-6 — `syncDirectory` abre o diretório sem `O_NONBLOCK|O_DIRECTORY` — PLAUSÍVEL (não reproduzido)
`snapshot-store.ts:128-135`: só depois de uma publicação bem-sucedida e de `lstat` do diretório; trocar a pasta da auditoria por um FIFO exatamente nessa janela travaria uma thread. Corrida estreita, exige escrita na pasta-base. Sugestão: `O_RDONLY|O_DIRECTORY|O_NONBLOCK`.

---

## 3. Situação dos achados da 1ª rodada

| Achado | Situação | Evidência |
|---|---|---|
| **MAJOR-1** | **RESOLVIDO** para A1 nas pastas de decisões e de resultados | RV-01/RV-04 originais reexecutados: a pendente forjada agora sai `origin:"UNPROVEN","originDetail":"MISSING","isMine":false`, sem desfecho/autor/conteúdo (asserções "a UI ofereceria concluir" falham, `rv2/orig-rv-01*.out`, `orig-rv-04*.out`). Conclusão enviada DIRETO ao servidor (sem a UI) recusada em 9 variantes 6C e 5 variantes 6B, nenhum recibo criado (`rv2/rv2-a.out`, RV2-A1/A2). Todos os pontos que gravam recibo enumerados: `confirmReceipt` (`receipts.ts:214`) só é chamado em `results-store.ts:317` (pendente: exige `PROVEN` em `:314-315`) e `:355` (conteúdo recém-montado pelo servidor); `confirmAnchor` em `store.ts:316` (pendente: `PROVEN` em `:313-314`) e `:357`; `writeAnchor` sem chamadores. UI: `completePendingRun`/`resendListedPending` exigem `PROVEN && isMine` e só são acionados pelo botão com caixa marcada; nenhum reenvio automático a partir de dados do servidor. Pendente forjada nunca entra em `operatorRecords`/resultados (`finalizable:false`, `get` ⇒ 409). |
| **MINOR-1** | **RESOLVIDO** nos leitores da Auditoria por Link (resta R2-INFO-3 fora do escopo e R2-INFO-6 plausível) | RV-02 original agora responde na hora (`orig-rv-02-fifo.out`: `CORRUPT … ENOTFILE`, `ANCHOR_INTEGRITY … ENOTFILE`, leitura qualquer `respondeu: ok`, exit 0). Meus cenários (`rv2/rv2-d-fifo.out`), cada um concluído em ≤ 0,23 s medidos dentro do filho (16 FIFOs: 109 ms; 200 leituras do arquivo crescente: 226 ms): FIFO em captura (`readCapture`, `verifyAudit`, `listVersions`, `getIntegrity`, `getAudit`, `readScoringBasis`, e `writeCapture` segue para a captura 2), em relatório, em `SHA256SUMS` legado, no recibo de RESULTADO (não coberto pelo teste do implementador), diretório/link simbólico/soquete com nome válido (`ENOTFILE`/`ELOOP`/`ENXIO`), pasta da auditoria como FIFO ou link (`UNSAFE_PATH`), 16 FIFOs simultâneos com I/O do processo vivo, arquivo que cresce (`ECHANGED`/`ETOOBIG`). |
| **MINOR-2** | **PARCIALMENTE** | Comentário de código corrigido; ADR/modelo honestos quanto à indistinguibilidade; o autor vê o aviso e confirma explicitamente; o recibo recriado aponta para o MESMO conteúdo (teste do implementador, passou na minha execução da suíte; RV-03a reexecutado: `isMine:false` para outro operador, autor `ok replayed=true recovered=true`). Em aberto: R2-MINOR-2 (aviso só para o autor; testemunha da 6B não usada; caminho de ressurreição de revogação via quarentena). |
| **P-1** (vínculo C2 no instante da gravação) | **ABERTO** (não tratado; não reproduzido) | `createBodySchema` continua `{record, supersedes?, expectedHead}` (`types.ts:117`). |
| **P-2** (evidência fixada alterada só vira `stale`) | **ABERTO** — agora CONFIRMADO | RV2-F2: remoção da captura fixada por resultado confirmado ⇒ lista `{"stale":true,"decisionsChanged":false}`, integridade `OK`; o alarme só na próxima finalização: `EVIDENCE_HASH_CHANGED ["ausente: capture:c0002","ausente: report:c0002-r0001"]`. |
| **P-3** (custo de verificação a frio) | **ABERTO** (não tratado; não reproduzido) | — |
| **P-4** (fsync de diretório best-effort) | **ABERTO** (não tratado; não reproduzido) | `syncDirectory` inalterado. |

---

## 4. O que tentei e NÃO funcionou (cobertura)

Atacante A1 sem chave e sem sessão, conclusão enviada direto ao serviço/rota (sem a UI):
1. 6C: cópia literal de resultado assinado de OUTRA auditoria (mesmo `seq` 1, `prev` nulo) ⇒ `RESULT_INTEGRITY` (pertence a outra auditoria).
2. 6C: a mesma cópia com `auditId` reescrito e selo refeito ⇒ `INVALID` ⇒ `RESULT_PENDING_ORIGIN_UNPROVEN`.
3. 6C: sem etiqueta, autor = operador real ⇒ `MISSING` ⇒ recusado.
4. 6C: `kid` real (lido de arquivo legítimo) + `tag` aleatória ⇒ `INVALID`.
5. 6C: etiqueta feita com OUTRA chave (ex.: chave de homologação vazada) ⇒ `KEY_MISMATCH`.
6. 6C: pendente legítima com `finalizedAt` alterado (etiqueta mantida) ⇒ `INVALID`.
7. 6C: etiqueta do domínio `DECISION` com a chave verdadeira sobre o corpo do resultado (confusão de domínio) ⇒ `INVALID`.
8. 6C: `origin.v = 2` e `origin` com campo extra ⇒ esquema estrito ⇒ `RESULT_INTEGRITY` (bloqueia, não confirma).
9. 6B: cópia literal de `d0001` assinado de outra auditoria ⇒ `DECISIONS_INTEGRITY`; com `auditId` reescrito ⇒ `PENDING_ORIGIN_UNPROVEN`.
10. 6B: pendente legítima com `supersedes` trocado ⇒ `DECISIONS_INTEGRITY` (semântica); com `basis` trocada ⇒ `INVALID`; `kid` real + `tag` aleatória + valor C2 trocado ⇒ `INVALID`.
11. Corrida para tomar o número de uma escrita legítima com uma pendente forjada que casa `inputSha256`/`head` (análise de código): o pedido novo do operador é tratado como reenvio da pendente e recusado pela origem — só bloqueia.
12. Recibo pré-plantado para o próximo número (análise): leitura acusa `TRUNCATED`/`ANCHOR_MISMATCH` — só bloqueia.
13. Temporário assinado capturado numa corrida (`.tmp-*` com `link()` em EEXIST) e recolocado (análise): só ocupa a mesma posição com conteúdo realmente gravado pelo servidor para o mesmo autor; com recibo do vencedor já gravado ⇒ `ANCHOR_MISMATCH`.
14. `isMine` verdadeiro sem `PROVEN`: DTO (`service.ts` `toPending`, `results.ts:276-296`), validador do cliente (`originOk`) e controlador exigem `PROVEN` — sem caminho.
15. Vazamento da chave/etiqueta: `JSON.stringify(authenticator)` = `{"keyId":"…"}`; nenhuma rota/DTO projeta `origin`; nenhum `console`/log nos módulos; mensagens de erro de configuração sem a chave.
16. Chave fraca/só espaços/`_PREVIOUS` fraca ⇒ `ORIGIN_KEY_WEAK`/não configurada ⇒ escritas 503 (testes de API do implementador passaram na minha execução; RV2-A6).
17. Concorrência: 2 conclusões da mesma pendente + 1 finalização de outro operador no mesmo processo ⇒ 1 resultado, 1 recibo (RV2-A5). Multiprocesso (3 processos simultâneos, 10 rodadas, `rv2/rv2-race.out`): 10/10 rodadas com um único `s0001` e um único `a0001`; as 20 respostas dos dois processos do autor foram `ok` (um conclui; o outro adota o recibo já gravado ou vê o confirmado); o outro operador recebeu 4× `RESULT_PENDING_UNCONFIRMED` (chegou antes) e 6× `ok replayed` (chegou depois).
18. FIFO/diretório/link/soquete/arquivo crescente em todos os leitores da Auditoria por Link (seção 3).
19. Motor Lumos: `src/lib/link-audit/scoring/` é IDÊNTICO à tag `v1.0.1` (`git archive v1.0.1` do repositório de trabalho + `diff -r` ⇒ sem diferenças; SHA-256 do conjunto `801ac919…16dfb`) e não importa nenhum módulo novo.
20. Evidência adulterada antes da pontuação: hash trocado sem refazer o selo ⇒ leitor recusa (`HASH_MISMATCH`, coberto pela suíte); link simbólico ⇒ `ELOOP`/`UNSAFE_PATH`; **com selo refeito ⇒ aceito** (R2-MINOR-1).

---

## 5. Limitações desta revisão

- Não rodei `next build`, servidor Next ponta a ponta, nem os roteiros de navegador (`scripts/browser/*`, incl. B13/B14 citados pelo implementador); as rotas foram exercitadas só pelos testes de API da suíte e pela leitura de código.
- Não testei queda de energia real (durabilidade), NFS/SMB, várias réplicas reais atrás do Traefik, nem a rotação de chave com processos simultâneos de chaves diferentes (só a propriedade no módulo).
- A corrida da janela `fstat`→`read`/`syncDirectory` e a captura de temporários assinados foram analisadas, não exploradas.
- `npm audit` não executado (sem rede).
- Não li linha a linha o coletor (4A–4D) nem o leitor legado; a passada F concentrou-se no caminho evidência → base de pontuação → mapeador → motor → registro.
- Independência limitada (mesma família de modelo do implementador).

---

## 6. Comandos e saídas-chave

Todos dentro de `review-r2/proj` via `scripts/run-isolated.sh` (namespace sem rede, `env -i`, sem `.env*`). Provas em `review-r2/rv2/`; arquivos `zz-rv2-*` temporários em `proj/tests/` foram removidos (conferido: 0 arquivos `zz-` e nenhum arquivo do snapshot alterado).

| Comando | Resultado |
|---|---|
| `scripts/run-isolated.sh npx tsc --noEmit --incremental false` | `TSC_EXIT=0` (`rv2/tsc-and-suite.out`) |
| `scripts/run-isolated.sh npm test` | `# tests 1621 · # pass 1620 · # fail 0 · # skipped 1` (skip: bundle de produção sem `.next`), ~236 s, `SUITE_EXIT=0`. Os 3 testes novos (`link-audit-origin-protocol`, `link-audit-origin-isolation`, `link-audit-special-files`) estão no script `test` do `package.json` (conferido). |
| `… node --require ./tests/register-typescript.cjs --test rv2/zz-rv2-a-origin-bypass.test.ts` | 8/8; ver RV2-A1…A7 em `rv2/rv2-a.out` |
| `… --test rv2/zz-rv2-f-evidence.test.ts` | 2/2; `rv2/rv2-f.out` (R2-MINOR-1, P-2) |
| `… --test rv2/zz-rv2-w-witness.test.ts` | 2/2; `rv2/rv2-w.out` (R2-MINOR-2/3) |
| `… --test tests/zz-rv2-b-ui.test.tsx` (cópia temporária) | 1/1; `rv2/rv2-b.out` |
| `scripts/run-isolated.sh bash rv2/run-fifo.sh` (cada cenário em filho com `timeout -s KILL 20`) | 7 cenários (6B/6C/evidências/leitor compartilhado) falham fechado em ≤ 0,23 s, todos com saída 0; `pdf-serve-fifo` trava (fora do escopo; morto por SIGKILL) |
| `scripts/run-isolated.sh bash rv2/run-race.sh` | 10/10 rodadas multiprocesso com 1 resultado e 1 recibo; `rv2/rv2-race.out` |
| `… node … rv2/key-checks.ts` | `rv2/rv2-key.out` (R2-MINOR-4) |
| Provas originais reexecutadas (`zz-rv2-orig-*`, removidas) | RV-01 e RV-04 **falham** (o ataque não funciona mais); RV-03 passa (MINOR-2 continua: confirmado → pendente, agora `PROVEN`); RV-02 não trava mais |
| `git archive v1.0.1 src/lib/link-audit/scoring` + `diff -r` | idêntico |

Observação de Git (somente leitura no repositório de trabalho): `HEAD = b1c7412` (docs) sobre `bd7c4fb`, branch `feat/onda-6c-integracao`; nada foi commitado, enviado ou etiquetado por esta revisão.
