# Onda 6C — Revisão adversarial INDEPENDENTE de segurança e integridade

Data: 31/10/2026 · Objeto: snapshot do commit de referência `bd7c4fbe3b746078cd45290d9ec486b86b1cf75a` (sem `.git`, sem `node_modules`) · Modo: somente leitura sobre o snapshot; experimentos numa cópia de trabalho.

---

## 1. Identificação do agente revisor e declaração de independência

- **Revisor:** agente de IA Claude (modelo Opus 5.5, Anthropic), executado como subagente do Claude Code, com contexto próprio, sem acesso à conversa, ao raciocínio nem aos rascunhos do implementador.
- **Limitação de independência (declarada sem exagero nem minimização):** o implementador também é, segundo os próprios documentos, um agente da mesma família de tecnologia. Isso cria risco de **pontos cegos correlacionados** (mesmos hábitos de leitura, mesmas suposições sobre o que é "óbvio"). Esta revisão **não substitui** revisão humana. Também não tive o histórico Git: **não verifiquei** que `src/lib/link-audit/scoring/` é idêntico à `v1.0.1`, nem que `src/lib` e `src/app/api` não mudaram desde `dab23bc`.
- **Ordem do que consultei:**
  1. **Primeira passada (sem abrir `$SEALED`):** a especificação `docs/phase6-auditoria-link/onda6c-integracao-orquestracao.md` (§0–§25); autenticação e middleware; primitivas de armazenamento (`snapshot-store.ts`, `link-audit-storage/*`); resultados (`results-store.ts`, `results.ts`, `results-types.ts`, `results-verify.ts`); prévia e mapeador (`preview.ts`, `assemble.ts`, `audit-id-alias.ts`, `outcome.ts`, `criteria-sources.ts`); rotas (`scoring/*`, `decisions/*`, `evidence/shared.ts`, `body.ts`, `confirm`, `login`, `logout`), `rate-limit.ts`, `next.config.ts`; 6B (`store.ts`, `service.ts`, `types.ts`, `project.ts`); partes do leitor de evidências (`store.ts`, `legacy.ts`, `scoring-basis.ts`, `derive-url.ts`, `reader.ts`); interface (`controller.ts`, painéis, `audit-url.ts`, páginas); `deploy/hostinger/*`; docs 6B (§15–16) e ADR da âncora; ajudantes de teste. Escrevi testes adversariais próprios e os executei. **Os achados provisórios foram gravados neste arquivo (marcador "PRIMEIRA PASSADA ENCERRADA", 17h14 BRT) antes de abrir `$SEALED`.**
  2. **Segunda passada:** abri `$SEALED` (`onda6c-homologacao-i7.md`, `onda6c-checklist-producao.md`, `NOTES.md`, `scripts/browser/i7-homologacao.cjs`) só para confrontar conclusões e procurar o que não foi testado. Nenhum achado abaixo depende do conteúdo de `$SEALED`; ele só confirmou lacunas (seção 6 e 8).

## 2. Escopo realmente inspecionado (e o que NÃO foi)

**Inspecionado em profundidade:** E (resultados e recibos: gravação, recibo, pendente, reenvio, concorrência, limites, adulteração, durabilidade), C (decisões 6B: encadeamento, recibos, `expectedHead`, RECORD/REVOKE, pendentes, recuperação, autoria), A (sessão, guarda, middleware, ordem `requireOperator` × limitador × validação, autorização por recurso), D na parte de integração (mapeador, alias, `referenceDate`, vínculo C2, desfecho, `finalizable`, `verifyRunRecord`), F (validação de corpo/consulta, DTOs, mensagens de erro, CSRF, cabeçalhos, limitadores, sumidouros de XSS na UI, `?auditId=`), G (stack/Dockerfile/entrypoint e planos de volume).

**NÃO inspecionado ou só superficialmente:**
- Internos do motor `src/lib/link-audit/scoring/**` (só `na.ts` e o uso de `justification`); régua D3B não reavaliada.
- Coletor e provedores (Ondas 4A–4D), caminho de **escrita** de evidências (5A) e o leitor legado linha a linha (5B/I1) — confiei nas revisões anteriores, exceto onde citado.
- PDF, Supabase/RLS, worker, prospecção, dashboard fora da Auditoria por Link.
- **Não executei:** `tsc`, `next build`, roteiros de navegador (`scripts/browser`), `npm audit` (sem rede), servidor Next real ponta a ponta (as rotas foram exercitadas só pelos testes da suíte), queda de energia real (durabilidade só por leitura de código), várias réplicas reais (só os testes multiprocesso da suíte).

## 3. Arquivos e contratos analisados

- **Contratos/especificações:** `onda6c-integracao-orquestracao.md` (§9 M-1…M-12, §12 PONTUADO×INCONCLUSIVO, §13 finalização, §14 rotas, §15 persistência, §17 segurança, §18 concorrência, §22 riscos); `onda6b-decisoes-humanas.md` (§15 recuperação, §16 riscos); `onda6b-adr-ancora-externa.md` (Emenda 1, riscos); `deploy/hostinger/PLANO-DE-VOLUME-DE-DECISOES.md`.
- **Autenticação:** `src/middleware.ts`, `src/lib/auth/{guard,session,require-operator,operators,safe-next,login-deps}.ts`, `src/app/api/auth/{login,logout}/route.ts`, `src/lib/rate-limit.ts`, `next.config.ts`.
- **Armazenamento:** `src/lib/link-audit/snapshot-store.ts` (`nodeFsOps`, `publishExclusive`, `withLock`), `src/lib/link-audit-storage/{files,receipts}.ts`.
- **6C:** `src/lib/link-audit-scoring-runs/{results-store,results,results-types,results-verify,preview,assemble,audit-id-alias,outcome,criteria-sources}.ts`; `src/app/api/link-audit/scoring/**` e `body.ts`.
- **6B:** `src/lib/link-audit-decisions/{store,service,types,project}.ts`; `src/app/api/link-audit/decisions/**`.
- **Evidências:** `src/lib/link-audit-evidence/{store,legacy,reader,scoring-basis,derive-url}.ts` (partes); `src/app/api/link-audit/evidence/shared.ts` e `[auditId]/route.ts`; `confirm/route.ts`.
- **UI:** `src/components/link-audit/audit-page/{controller,finalization-panel,decisions-panel,results-panel,audit-detail-screen}.ts(x)`, `audit-url.ts`, `requested-audit-notice.tsx`, `src/app/auditoria-por-link/**/page.tsx`.
- **Deploy:** `deploy/hostinger/{stack.yml,Dockerfile,docker-entrypoint.sh,.env.production.example}`.
- **Testes/ajudantes (para reproduzir):** `tests/helpers/link-audit-{results,preview,decisions,scoring}-fixtures.ts`.

---

## 4. Vulnerabilidades confirmadas

Escala: BLOCKER · MAJOR · MINOR · INFO. "Confirmado" = reproduzido por teste nesta revisão ou demonstrado sem ambiguidade no código.

### MAJOR-1 — Pendente forjada numa única pasta vira registro CONFIRMADO quando o autor nomeado clica em "concluir/reenviar" (6C resultados **e** 6B decisões) — CONFIRMADO (RV-01, RV-04)

1. **Código responsável**
   - Servidor 6C: `src/lib/link-audit-scoring-runs/results.ts:379-392` (conclusão da pendente só confere: autor = `finalizedBy` do próprio arquivo, `explains()` = `verifyRunRecord` autoconsistente, e `pendingEvidenceProblems` = hashes das evidências citadas, `results.ts:314-318`). `results-verify.ts:157-238` não confere que os fatos do perfil são os que o mapeador produziria (só proíbe `reviews` e `complete:true` fora do website) nem que `decisions.head`/`operatorRecords` existem no histórico da 6B. Nenhuma checagem de `finalizedAt` ≤ relógio na conclusão.
   - Servidor 6B: `src/lib/link-audit-decisions/store.ts:201-206` (`findReplay`: mesmo autor + mesma operação) e `service.ts:400-416` (`pendingProblem`: só datas, existência de captura/relatório e contrato 6A).
   - Interface (o elo que anula a salvaguarda "só o autor conclui"): `controller.ts:147-151` (`completePendingRun` monta o pedido com `pending.decisionsHead` e `pending.inputSha256` **vindos do servidor**), `controller.ts:198-202` (num 409 `RESULT_PENDING_UNCONFIRMED` a tela entra em "reenviar" com o pedido da pendente), `controller.ts:355-366` (`resendListedPending` monta o corpo com `pending.record`/`pending.reason` **vindos do servidor**); `finalization-panel.tsx:35-38` afirma **"Foi você quem o gravou"** e oferece "Concluir a confirmação"; `decisions-panel.tsx:49-57` mostra só tipo/id/data/autor (não mostra valor nem justificativa) e oferece "Reenviar o mesmo pedido".
2. **Explorável?** Sim, com a pré-condição de **escrita privilegiada em UMA das pastas** (resultados OU decisões) — exatamente o atacante que o protocolo de recibos em pasta separada existe para conter. Não exige tocar na pasta de recibos.
3. **Demonstração (reproduzida)**
   - **RV-01 (6C):** sobre um `world()` real (evidências e decisões reais em pastas temporárias, prévia REAL, dados que só sustentam INCONCLUSIVO), gravei SÓ na pasta de resultados um `s0001.json` selado, com `finalizedBy = bia@empresa.com`, evidências e hashes REAIS e fatos de perfil FABRICADOS (endereço estruturado, horários, descrição, serviços, atributos, produtos, fotos, publicações etc., todos `complete:false`, sem `reviews`). Resultado: `verifyRunRecord` = `[]`; `list` ⇒ pendente `isMine:true`, `outcome:"PONTUADO"`; o pedido que a UI montaria (`{expectedHead: pending.decisionsHead, expectedInputSha256: pending.inputSha256}`) ⇒ `ok:true, replayed:true, recoveredPending:true`; `list` depois ⇒ **`s0001 PONTUADO PROVISORIO, cobertura 49 %`, índice 100 ("Referência local"), CONFIRMADO com recibo gravado pelo próprio servidor**; só `stale:true` denuncia.
   - **RV-04 (6B):** gravei SÓ na pasta de decisões um `d0001.json` (sem âncora) em nome de `ana@empresa.com` com juízo C2 `COMPATIBLE` e justificativa forjada. `list` ⇒ pendente, `finalizable:false`; reenvio por BIA ⇒ `PENDING_UNCONFIRMED`; reenvio por ANA com o corpo reconstruído do `pending` (o que `resendListedPending` faz) ⇒ **`ok, replayed=true, status=ACTIVE`**, `finalizable:true`.
4. **Consequência:** um registro **definitivo, ancorado e "verificado"** com fatos ou decisões que nenhum operador produziu — inclusive **PONTUADO**, o desfecho que a D6C-2 mais protege — e uma decisão humana com autoria falsa (não repúdio quebrado). A Onda 7 consumiria o `sNNNN` "verificado". A própria interface induz o operador ("Foi você quem o gravou"). Contradiz afirmações explícitas da documentação: 6B §16 risco 9 ("uma cauda forjada … só consegue **bloquear**, nunca valer"), ADR risco 2 ("o conteúdo é o que ele próprio enviou"), 6B §15 item 1 (que *recomenda* reenviar a partir de `pending.record`, invalidando a premissa do ADR) e o comentário `results-store.ts:40-43`. O risco 12 da 6C (§22.2) reconhece "valores de perfil fabricados", mas trata "a conclusão exige o autor" como mitigação — a UI a reduz a um clique sem conteúdo visível — e não menciona decisões forjadas nem PONTUADO.
5. **Gravidade: MAJOR.** Não é BLOCKER porque exige escrita privilegiada no volume; é MAJOR porque derrota, de forma reproduzível e com custo baixo, a propriedade central do protocolo de recibos (adulteração de uma pasta só ⇒ detectável/nunca confirmada) e porque a correção é pequena.
6. **Correção mínima proposta**
   - **Servidor 6C (obrigatória):** na conclusão de pendente (`results.ts:384-391`), antes do recibo: (a) re-derivar a entrada — `assembleScoringInput(basis_de_hoje, pendente.input.operatorRecords)` (as evidências já foram conferidas com os mesmos hashes) — e exigir `inputSha256` igual ao da pendente (prova que os fatos vieram do mapeador); (b) conferir que `pendente.decisions.head` existe em `decisions.history` com o mesmo `entrySha256` e que cada `operatorRecord` é idêntico (id, conteúdo, autor, data) a uma decisão de `allDecisions` vigente naquele head (derivável de `revokedAtSeq`/`supersededBy`); (c) `finalizedAt` ≤ relógio do servidor. Alternativa mais simples (troca disponibilidade por segurança): só concluir se `inputSha256` e `head` da pendente forem os da avaliação ATUAL; senão manter pendente e seguir o runbook de quarentena.
   - **Interface 6B/6C (obrigatória):** não montar reenvio a partir de dados do servidor sem exibir o conteúdo integral (6B: tipo, valor, justificativa/motivo escapados; 6C: desfecho, `inputSha256`, head) e exigir confirmação explícita; preferir o pedido guardado localmente na mesma sessão (`form.pendingRequest`, `flow.request`); trocar "Foi você quem o gravou" por "O arquivo indica você como autor — confira antes de concluir".
   - **Documentação (obrigatória):** corrigir 6B §16 risco 9, ADR risco 2, 6B §15 item 1, 6C §22.2 risco 12 e `results-store.ts:40-43`.
   - **Estrutural (recomendada, decisão do responsável):** autenticar entradas com chave do servidor fora do volume (HMAC — "opção D" do ADR) ou intenção durável ("opção C").
7. **Teste de regressão sugerido:** inverter RV-01 e RV-04: pendente forjada com fatos fabricados ⇒ conclusão recusada (`RESULT_INTEGRITY`/novo código) e nenhum recibo criado; pendente legítima (recibo falhou) ⇒ conclusão aceita; teste de UI: pendente sem pedido local ⇒ conteúdo exibido e confirmação exigida antes de qualquer envio.

### MINOR-1 — Arquivo especial (FIFO) com nome válido trava o leitor e esgota o pool de I/O do processo — CONFIRMADO (RV-02)

1. **Código:** `src/lib/link-audit/snapshot-store.ts:85-95` — `nodeFsOps.readFile` abre com `O_RDONLY | O_NOFOLLOW` **sem `O_NONBLOCK`** e só confere `isFile()` **depois** do `open`. `readSealedFile` (`link-audit-storage/files.ts:71-91`), `readReceipts` (`receipts.ts:133-135`), `readRunFiles` (`results-store.ts:148-150`), `readDecisions` (6B) e o leitor de evidências (`link-audit-evidence/store.ts:249`, `legacy.ts:51`) chamam o `open` sem `lstat` prévio.
2. **Explorável?** Sim, por quem escreve num volume de dados (privilegiado). Não há teste de FIFO na suíte (busca por `mkfifo`/`fifo` nos testes: nenhum).
3. **Demonstração:** `mkfifo <recibos>/<id>/a0001.json` e `mkfifo <decisões>/<id>/d0001.json`. `readLog` (6B) e `readRunLog` (6C) ⇒ **TRAVADO** após 1,5 s; com 4 aberturas presas, `fs.promises.readFile` de um arquivo qualquer ⇒ **TRAVADO** (pool do libuv, padrão 4 threads, esgotado); `process.exit(0)` **não encerra** o processo (o `timeout` teve de matá-lo: código 124). A primeira tentativa pelo `node --test` também ficou pendurada (código 143).
4. **Consequência:** indisponibilidade do **processo web inteiro** (todas as auditorias, todo I/O assíncrono de arquivo), com a trava por auditoria presa e o desligamento gracioso travado até o SIGKILL do Swarm (`stop_grace_period: 30s`). Diferente de apagar/alterar arquivos (que vira 409 só naquela auditoria). A checklist de produção do implementador afirma que arquivos estranhos "são recusados ou marcados" — o FIFO não é.
5. **Gravidade: MINOR** (disponibilidade; pré-condição privilegiada).
6. **Correção mínima:** acrescentar `O_NONBLOCK` às flags do `open` em `nodeFsOps.readFile` (sem efeito em arquivo comum; FIFO/dispositivo são recusados em seguida pelo `fstat`). Por ser primitiva compartilhada, reexecutar os testes de conformidade/diferencial do I0.
7. **Regressão:** criar FIFO com nome válido em cada pasta (evidências, decisões, âncoras, resultados, recibos) e exigir resposta 409/integridade em < 1 s, sem travar leituras de outras auditorias.

### MINOR-2 — Remover o último recibo rebaixa um resultado CONFIRMADO a "pendente" sem alarme — CONFIRMADO (RV-03a)

1. **Código:** `results-store.ts:185-188` + `receipts.ts:151-161` (`unanchored === 1` é sempre interpretado como pendente).
2. **Explorável?** Por quem escreve na pasta de recibos (privilegiado).
3. **Demonstração:** 1 resultado confirmado; apago `<recibos>/<id>/`; `list` ⇒ `results: 0`, `pending: {…, isMine:false}`, `integrity: "OK"`; outro operador ao finalizar o mesmo estado ⇒ `RESULT_PENDING_UNCONFIRMED`; o autor reconfirma (`replayed=true, recovered=true`). O roteiro I7 (B12) observou o mesmo e o tratou como esperado.
4. **Consequência:** o resultado definitivo some da lista sem alerta de integridade e a auditoria fica bloqueada para os demais operadores até o autor reaparecer; contradiz o comentário `results-store.ts:42` ("a perda de um resultado confirmado é sempre detectável"). É a mesma limitação documentada da 6B (risco 10), herdada.
5. **Gravidade: MINOR** (documentação mais forte que o código; disponibilidade).
6. **Correção mínima:** corrigir o texto; opcionalmente sinalizar pendente cuja `finalizedAt` é anterior ao último `head` guardado fora do armazenamento, ou acima de N minutos, como "possível recibo removido".
7. **Regressão:** o teste RV-03a com a asserção de que a resposta/UI indica "possível recibo removido".

> **Nota (INFO, mesmo teste, RV-03b):** apagar as **duas** subpastas da auditoria (`<resultados>/<id>` e `<recibos>/<id>`) apaga todo o histórico com `integrity:"OK"`. Está coberto pela limitação declarada ("quem altera as DUAS pastas não é detectado"); só a guarda externa do `head` mitiga.

### Plausíveis, NÃO demonstrados (registro honesto)

- **P-1 (MINOR) Vínculo C2 ↔ captura no instante da GRAVAÇÃO, não da exibição.** `service.ts:543-547` calcula `basis` (captura mais recente) fora da trava e no momento do POST; o corpo do C2 (`{kind, subcriterionId, value, justification}`) não carrega a captura que o operador viu. Uma coleta nova entre a abertura da tela e o envio faria o juízo valer para uma categoria não vista. Exige coleta concorrente (hoje só por CLI); não reproduzido. Correção: enviar a fonte exibida (`profileSource.ref`) e recusar divergência (toca a 6B; decisão do responsável).
- **P-2 (INFO) Evidência trocada com selo refeito depois de um resultado** aparece nas consultas só como `stale:true` (`results.ts:304-312`); o alarme `EVIDENCE_HASH_CHANGED` só surge na próxima finalização. Sugestão: rodar `changedPinnedEvidence` em `list/get` e expor um indicador de integridade distinto de "desatualizado".
- **P-3 (INFO) Custo de verificação a frio:** `verifyRunRecord` é síncrono (~6,7 ms/registro, número do implementador); 500 registros ⇒ ~3,4 s de laço de eventos bloqueado por consulta com cache frio; o cache (`VERIFIED_CAP = 4096`) é limpo inteiro ao encher. Exigiria milhares de finalizações de um operador interno; não reproduzido.
- **P-4 (INFO) Durabilidade:** `fsync` do arquivo temporário antes do `link()` é real (`snapshot-store.ts:96-104`), mas o `fsync` do diretório é *best-effort* com erro ignorado (`snapshot-store.ts:385`) e a pasta da auditoria criada por `mkdir` nunca recebe `fsync` no diretório-pai. Em ext4 com journal ordenado isso é na prática durável; não é garantido por POSIX. A ordem resultado → recibo é correta (o pior caso após queda é falso `RESULT_TRUNCATED`, falha fechada).

---

## 5. Testes adversariais executados NESTA revisão

Ambiente: cópia do snapshot em `review-final-work/proj` + symlink só de uso para `~/projects/gmn-intelligence-platform/node_modules`; todos os comandos via `scripts/run-isolated.sh` (namespace de rede vazio, `env -i`, recusa de `.env*`). O snapshot original não foi modificado (conferido por `diff -rq`: só os 4 arquivos `tests/rv-*.test.ts` e uma pasta `.data` criada pela suíte existem na cópia).

| # | Comando (na cópia) | Resultado real | O que provou |
|---|---|---|---|
| RV-01 | `scripts/run-isolated.sh node --require ./tests/register-typescript.cjs --test tests/rv-01-forged-pending.test.ts` | pass 1/1. Saída: `verifyRunRecord(forjado) = []`; pendente `isMine:true outcome:PONTUADO`; conclusão `{"ok":true,"replayed":true,"recovered":true,"changed":true}`; lista depois `PONTUADO PROVISORIO coverage 49 stale:true` | MAJOR-1 (6C) |
| RV-02 | `timeout 60 scripts/run-isolated.sh node --require ./tests/register-typescript.cjs tests/rv-02-fifo.test.ts` | `6B readLog … TRAVADO`; `6C readRunLog … TRAVADO`; `leitura … QUALQUER … TRAVADO (pool do libuv esgotado)`; processo não encerrou (exit 124). 1ª tentativa via `--test` pendurou (exit 143) | MINOR-1 |
| RV-03 | `… --test tests/rv-03-removal.test.ts` | pass 2/2. (a) `results:0, pending:{isMine:false}, integrity:"OK"`; outro operador `RESULT_PENDING_UNCONFIRMED`; autor `ok replayed=true recovered=true`. (b) `results:0, pending:null, integrity:"OK"` | MINOR-2 e nota INFO |
| RV-04 | `… --test tests/rv-04-forged-decision.test.ts` | pass 1/1. BIA `PENDING_UNCONFIRMED`; ANA `ok replayed=true status=ACTIVE`; vigentes `[["op-0001","JUDGEMENT","COMPATIBLE","ana@empresa.com"]]`, `finalizable=true` | MAJOR-1 (6B) |
| Suíte | `scripts/run-isolated.sh npm test` | **1590 testes: 1588 pass, 1 fail, 1 skip** (~254 s). Falha: `deploy-config.test.ts` "o exemplo de produção nasce com o Worker desligado" — causada pela **sanitização** do `.env.production.example` no snapshot (valores trocados por `<valor omitido no snapshot>`), não por código. Skip: verificação do bundle de produção (exige `next build`) | A suíte do snapshot roda nesta máquina; as rotas (401/403/415/413/400/409/429), concorrência multiprocesso e recuperação da própria suíte passaram nesta execução |

Os números históricos do implementador (1590/1590, APIs 87, concorrência 162, isolamento 61, Chromium I7 117) **não** são resultados meus.

---

## 6. Riscos residuais

**Aceitos e documentados (concordo que são aceitáveis para uma ferramenta interna, desde que a operação os conheça):**
- Adulteração/retrocesso **coordenado** das duas pastas (resultados+recibos; decisões+âncoras) não é detectado; só um `head` guardado fora do armazenamento o acusa (inclui o apagamento das duas subpastas, RV-03b).
- SHA-256 é selo, não assinatura (sem MAC com chave fora do volume).
- Sem ACL por auditoria: todo operador da lista lê, decide, revoga e finaliza qualquer auditoria.
- Pendente cujo autor não volta bloqueia a auditoria até quarentena manual (6B e 6C).
- Limite de 500 resultados por auditoria: ao atingi-lo, `RESULTS_LIMIT_REACHED` permanente (o reenvio do último continua 200); sem ferramenta de arquivamento.
- Janela inevitável entre a última releitura e o `link()` (registro verdadeiro sobre o estado que grava; `stale` depois).
- Pastas vazias criadas antes da avaliação (ruído limitado a 6/min por operador).
- Alias de `auditId` com SHA-256 truncado a 128 bits (suposição criptográfica razoável).
- `rawSha256` do website bruto (hash não salgado) gravado no registro interno; não sai por rota. Aceitável: só permitiria confirmar palpites de URL de baixa entropia.
- Teto de cobertura de 17 % com a coleta atual (produto: todo resultado real é INCONCLUSIVO).

**Declarados, mas com texto mais forte que o código (precisam de correção de documentação):** 6B §16 risco 9 e ADR risco 2 (ver MAJOR-1); comentário `results-store.ts:42` (ver MINOR-2).

**Não declarados antes desta revisão:** MAJOR-1 na extensão demonstrada (PONTUADO e decisões forjadas confirmáveis com um clique), MINOR-1 (FIFO), P-1 (vínculo C2 no instante da gravação).

**Limitações da arquitetura:** travas e limitadores em memória por processo (a segurança entre processos repousa no `link()` exclusivo, que é correto); leitura relê e reverifica tudo a cada consulta (custo linear no histórico); nenhuma trilha de auditoria fora dos próprios arquivos.

---

## 7. Avaliação de segurança das Ondas 6B e 6C (item a item)

**A. Autenticação e autorização — sólido, com ressalvas pré-existentes.**
- Verificado: middleware cobre tudo exceto login/logout e estáticos (`middleware.ts:13-40`); toda rota da área repete `requireOperator` e só depois limita a taxa (chave = e-mail autenticado; o limitador não é inundável por anônimos) e valida `auditId`/consulta (`scoring/shared.ts:65-93`, `decisions/shared.ts:75-102`). Sessão HMAC-SHA-256 via WebCrypto com `verify` em tempo constante, versão, `exp`, `iat` não futuro (`session.ts`); lista de operadores relida a cada requisição; cookie `HttpOnly; SameSite=Strict; Secure` em produção; bypass de desenvolvimento eliminado em build de produção e recusado pelo entrypoint; `dev@localhost` não passa no `operatorOf` (sem ponto no domínio) ⇒ não grava. Identidade do operador (autor, `finalizedBy`) só da sessão. Páginas são cascas de cliente (nenhum dado no servidor).
- Ressalvas: sessão **não revogável** (logout só apaga o cookie; token vale 12 h; revogar = tirar da lista ou girar a chave) e chave de sessão **derivada da service role do Supabase** — ambos pré-existentes (Fase 5), MINOR/INFO. Sem ACL por auditoria (documentado). `crossOriginViolation` aceita POST sem `Origin` e sem `Sec-Fetch-Site` (clientes não-navegador); para navegadores a combinação `SameSite=Strict` + `Origin` + exigência de `application/json` (415) fecha CSRF.

**B. Evidências e integridade — sólido no conteúdo; frágil a arquivos especiais.**
- Verificado: leitura estrita (bytes canônicos, hash sobre o JSON bruto, esquema, tamanho), `O_NOFOLLOW`, `lstat` de diretórios (symlink ⇒ inseguro), limites de tamanho, vínculo captura↔relatório e identidade por CID/placeId (I1); a 6C fixa os hashes das evidências já usadas (`EVIDENCE_HASH_CHANGED`, inclusive "ausente:").
- Falhas: **MINOR-1 (FIFO)**; P-2 (troca re-selada só vira `stale` nas consultas). Limitações herdadas do 5B (sidecar do legado fora do `SHA256SUMS`; cauda de capturas sem manifesto) continuam, parcialmente mitigadas pela fixação de hashes.

**C. Decisões humanas (6B) — protocolo correto contra pedidos alheios; falha contra cauda forjada + UI.**
- Verificado: encadeamento, sequência sem lacunas, nomes suspeitos, `replay` semântico (substituição só do mesmo tipo cobrindo todos os espaços, revogação só de vigente, conflitos de espaço), recibos em pasta separada lidos antes, `expectedHead` com `HEAD_MISMATCH`/`HISTORY_REGRESSED`, pendente nunca no estado, `finalizable:false` com pendente, reenvio idempotente só do mesmo autor e mesma operação, revalidação da pendente (datas, captura, contrato), reserva de 100 entradas para revogações, caracteres ocultos recusados, chaves de pontuação recusadas.
- Falha: **MAJOR-1** (RV-04). Observação: `recordedAt` aceita ISO sem milissegundos (`types.ts:37`) enquanto a monotonia compara texto; só afeta entradas forjadas (INFO). P-1 (vínculo C2).

**D. Motor Lumos (integração 6C) — sólido no caminho normal; o cliente NÃO induz PONTUADO.**
- Verificado: o mapeador só emite 7 campos observados (`assemble.ts:93`), `complete:false` em tudo exceto website com prova positiva de UTM conferida contra a captura (`assemble.ts:235-262`), sem `reviews` (M-4a; `assemble.ts:278` nem copia `informational`), `referenceDate` = dia da evidência mais recente (nunca do cliente ou relógio; evidência futura ⇒ recusa), alias verificável e separado do id de armazenamento, decisões fora do contrato (só C2 e N/A S4 BUSINESS_MODEL) retidas e bloqueantes, C2 de outra captura retido, desfecho derivado do resultado do motor (`outcome.ts:23-32`), `finalization.allowed` exige resultado, nenhum bloqueio, nenhuma retida, `finalizable` e nenhuma pendente (`preview.ts:331`), e a finalização reconfere tudo dentro da trava, inclusive o website no bruto e a impressão digital final. Teto real: 34 hp (17 %) ⇒ nenhum caminho de API produz PONTUADO.
- Falha: `verifyRunRecord` não impõe a política do mapeador (campos/formas permitidos) nem a proveniência das decisões ⇒ é o que torna MAJOR-1 capaz de produzir PONTUADO a partir de arquivo forjado.

**E. Resultados e recibos (I4) — ÁREA PRIORITÁRIA: mecânica correta; conclusão de pendente é o ponto fraco.**
- Escritas concorrentes: trava por auditoria em processo + `link()` exclusivo entre processos + releitura e reavaliação em conflito (até 5×); a suíte (multiprocesso) passou nesta execução. Correto.
- TOCTOU avaliação × selo × recibo: avaliação com leitura dupla concordante, reconferência de `expectedHead`/`expectedInputSha256`, bloqueios, website bruto, hashes fixados e releitura final da impressão digital antes do selo; resta só a janela documentada até o `link()`. O recibo só é escrito depois do resultado e o sucesso só depois do recibo. Correto.
- Resultados sem recibo: nunca aparecem como resultado; `get` de pendente ⇒ 409. Correto. **Mas** a conclusão tardia é o MAJOR-1.
- Recibos inconsistentes, truncamento, reescrita, lacuna, nomes suspeitos, restauração parcial: detectados (409 sem dados); remoção do último recibo ⇒ MINOR-2.
- Reenvio idempotente: reconhecido **antes** da avaliação, só contra o ÚLTIMO arquivo, por (`inputSha256`, `head`); confirmado ⇒ qualquer operador (não grava nada; equivale a uma leitura); pendente ⇒ só o autor (insuficiente, MAJOR-1).
- Limite de 500: ao atingir, novo ⇒ 409 permanente; reenvio do último ⇒ 200; um pedido velho recebe antes `HEAD_MISMATCH`. Travamento só por insider (exigiria ~500 mudanças de decisão). Aceitável com procedimento de arquivamento.
- Adulteração das pastas, retrocesso coordenado, remoção de resultados e âncoras: ver seção 6 e RV-03.
- Persistência: `wx` + `fsync` do temporário + `chmod 0444` + `link()` exclusivo (nunca `rename`, nunca caminho não atômico), recibo idem; `fsync` de diretório *best-effort* (P-4).
- Histórico × atual: `stale` (entrada), `decisionsChanged` (head/pendente/finalizável) e `stateChangedAfterFinalization` são distintos; `null` = sem comparação (só no mais recente). Coerente com a UI. Lacuna P-2.

**F. APIs e frontend — sólido.**
- Verificado: corpo da finalização estrito (objeto, só `expectedHead` e `expectedInputSha256`, Zod `.strict()`), 16 KB, `application/json` exato (415), qualquer consulta ⇒ 400, `seq` por regex; respostas `no-store, private`, `nosniff`, `Vary: Cookie`; erros com texto fixo, `issues` ≤ 10×300 já sem caminhos (`scrubPaths`), pendente sem e-mail (`isMine`), projeção pública por lista de campos (sem `input`, `rawSha256`, justificativas; `naRegistry.recordedBy` = `OPERATOR_RECORD`; em INCONCLUSIVO sem pontos, índice, confiança nem "(X de Y pontos)"); `finalizedBy` sai por contrato (interno). Nenhum `dangerouslySetInnerHTML`/`eval`; `href` só com `encodeURIComponent` e caminho fixo; `?auditId=` validado e não ecoado; `next` do login saneado. Limitadores por operador, com teto de chaves; 429 com `Retry-After` e respeitado pela UI. Nenhum log nos módulos (sem vazamento, mas sem trilha — seção 8).
- Ressalvas: CSP em **Report-Only** com `unsafe-inline` e **sem `report-uri`/`report-to`** (inerte: ninguém recebe os relatórios); limitadores em memória (zeram ao reiniciar; dobram durante o `start-first`). A rota `confirm` não tem limitador (não grava nem chama provedor; INFO).

**G. Riscos residuais declarados e deploy.**
- Os riscos 1–13 da 6C §22.2 e 1–11 da 6B §16 são, em geral, honestos; exceções: 6B risco 9 / ADR risco 2 (falsos diante da UI atual) e a mitigação do risco 12 da 6C (superestimada) — MAJOR-1.
- `stack.yml`: evidências `read_only`, raiz `read_only`, `cap_drop: ALL`, não-root, HSTS no Traefik, segredos por arquivo, entrypoint que recusa bypass/demo/`.env`. **Não há** volumes nem variáveis de decisões, recibos de decisões, resultados e recibos de resultados ⇒ em produção essas rotas respondem 503 (falha fechada, seguro e inoperante). `update_config.order: start-first` no web ⇒ dois processos atendem ao mesmo tempo durante a troca (seguro pelo `link()`, mas limitadores e trava de erro fatal ficam por processo). `PLANO-DE-VOLUME-DE-RESULTADOS.md`, previsto na especificação (§20, §23 I7), **não está no snapshot** (a checklist em `$SEALED` cobre o assunto, mas declara-se "não executada").

---

## 8. Avaliação de prontidão para PRODUÇÃO (separada da homologação funcional)

A homologação funcional (fluxo, estados, contrato) é assunto do implementador; aqui avalio só se é seguro operar. **Hoje a 6B/6C NÃO está pronta para produção**, independentemente do parecer da onda:
1. **MAJOR-1 sem correção** (pendentes forjadas confirmáveis).
2. **Volumes inexistentes no `stack.yml`** (4 pastas graváveis, recibos em disco/volume diferente, `0700`, uid 10001, só no web) e plano de volume de resultados ausente do repositório.
3. **Backup independente** das 4 pastas não definido nem ensaiado; **guarda externa do `head`** (única defesa contra retrocesso coordenado) não implementada.
4. **Sem trilha de auditoria nem alertas:** nenhum log em 6B/6C; adulteração (409), pendentes (`ANCHOR_PENDING`), `ENOSPC/EIO` só aparecem quando alguém abre a tela. Mínimo: log estruturado (sem conteúdo sensível) de finalizações, conclusões de pendente, 409 de integridade e 503 de armazenamento, com alerta.
5. **MINOR-1 (FIFO)** — corrigir antes de expor (uma linha) para não converter um incidente de volume em queda do processo e desligamento travado.
6. **Ordem de atualização:** decidir `stop-first` para o web ou registrar formalmente a convivência de dois processos.
7. **Rollback não ensaiado** (nem em staging).
8. **CSP** só em Report-Only e sem coletor; **limitadores em memória**; **sessão não revogável** — aceitáveis para piloto interno, se registrados.
9. `npm audit` não executado (sem rede); Next `15.5.28` (posterior às correções conhecidas de bypass de middleware).
10. Verificar no repositório real a falha de `deploy-config.test.ts` (aqui causada pela sanitização do snapshot).

---

## 9. Recomendações (ordenadas por criticidade)

1. **[MAJOR-1, obrigatório]** Servidor 6C: re-derivar a entrada e validar o `head`/decisões contra o histórico da 6B na conclusão de pendente (ou exigir igualdade com o estado atual); conferir `finalizedAt` ≤ relógio. UI 6B/6C: não reenviar a partir de dados do servidor sem exibir o conteúdo e pedir confirmação; remover "Foi você quem o gravou". Testes RV-01/RV-04 invertidos.
2. **[MAJOR-1, obrigatório]** Corrigir a documentação que promete mais do que o código (6B §15 item 1, §16 risco 9; ADR risco 2; 6C §22.2 risco 12; `results-store.ts:40-43`).
3. **[MINOR-1]** `O_NONBLOCK` em `nodeFsOps.readFile` + teste de FIFO em todas as pastas; reexecutar a conformidade do I0.
4. **[Produção]** Volumes, backups independentes, guarda externa do `head` por auditoria, logs/alertas mínimos, decisão `stop-first`, ensaio de rollback (checklist do implementador, que considero adequada como roteiro).
5. **[MINOR-2]** Corrigir o texto sobre perda detectável; sinalizar pendente suspeita de recibo removido.
6. **[P-1]** Avaliar enviar a fonte exibida no juízo C2 e recusar divergência (exige decisão sobre a 6B).
7. **[P-2]** Expor nas consultas um indicador de evidência fixada alterada, distinto de `stale`.
8. **[Estrutural]** Avaliar MAC das entradas com chave fora do volume (opção D do ADR) — resolve a classe inteira de caudas forjadas.
9. **[Higiene]** CSP com `report-to` antes de impor; revogação de sessão (lista de negação curta ou versão por operador); `recordedAt` com milissegundos obrigatórios; procedimento de arquivamento para o limite de 500.

## 10. Git status

Preenchido pelo solicitante, após o recebimento do relatório (verificações próprias, não do revisor):
- Commit de referência: `bd7c4fbe3b746078cd45290d9ec486b86b1cf75a` (`bd7c4fb`), branch `feat/onda-6c-integracao`; HEAD inalterado durante a revisão.
- `git status --short` antes de gravar este relatório: vazio (árvore limpa). Depois: somente este arquivo, **não rastreado e não commitado** (sem autorização).
- Nenhum arquivo de código foi modificado; sem push, merge, rebase, tag ou deploy.
- Verificações que o revisor declarou NÃO ter feito (por não ter o histórico Git), confirmadas pelo solicitante: `git diff v1.0.1 -- src/lib/link-audit/scoring` = 0 linhas; `git diff dab23bc HEAD --stat -- src/lib src/app/api` = vazio.
- A falha única da suíte no snapshot (`deploy-config.test.ts`) decorre da sanitização do `.env.production.example` aplicada pelo solicitante ao snapshot; a suíte do repositório real estava 1590/1590 (execução anterior, não repetida nesta revisão).
- Evidências de reprodução do revisor (testes `rv-01..04` e saídas) preservadas **fora do repositório**: `~/gmn-review-evidence-2026-10-31/` (os testes não foram adicionados ao projeto; `rv-02` trava o processo por desenho, rodar só com `timeout`).

## 11. Parecer final

**BLOQUEADO — CORREÇÕES OBRIGATÓRIAS**

Justificativa: **não há BLOCKER**. O caminho normal (cliente → API → mapeador → motor → selo → recibo) se mostrou sólido: autenticação antes de tudo, corpo estrito, nenhuma fonte de verdade vinda do cliente, mapeador restrito ao observado, M-4a, desfecho derivado do motor, reconferências dentro da trava, gravação atômica exclusiva e verificação integral em toda leitura. Há porém **um MAJOR confirmado por reprodução (MAJOR-1)**: uma pendente forjada em uma única pasta — resultado PONTUADO com fatos fabricados (6C) ou decisão em nome de outro operador (6B) — torna-se registro confirmado e ancorado com um clique do autor nomeado, guiado pela própria interface, o que contradiz garantias escritas da 6B e da 6C. Pela escala desta revisão, MAJOR deve ser corrigido antes do encerramento. As correções obrigatórias são pequenas e localizadas (recomendações 1 e 2); a 3 (FIFO) é fortemente recomendada no mesmo ciclo. Este parecer é técnico: a decisão de encerrar, ou de aceitar formalmente o MAJOR-1 como risco residual com a documentação corrigida, é do responsável.

---

## Apêndice — registro da primeira passada (conteúdo gravado neste arquivo antes de abrir `$SEALED`, 17h14 BRT; reproduzido aqui porque a versão final substituiu o rascunho)

- Confirmados por reprodução: RV-01 (pendente forjada 6C ⇒ PONTUADO confirmado; UI diz "Foi você quem o gravou"); RV-04 (decisão forjada 6B em nome de ANA ⇒ ACTIVE; contradiz 6B §16 risco 9); RV-02 (FIFO trava leitura e pool do libuv; `process.exit` não encerra); RV-03a (recibo removido ⇒ confirmado vira pendente com `integrity:OK`); RV-03b (duas subpastas removidas ⇒ histórico vazio sem alarme).
- Observados no código: `syncDirectory` best-effort e pasta-pai sem `fsync`; sessão sem revogação no logout (Fase 5); limite de 500 com travamento por insider; `start-first` no `stack.yml`; `PLANO-DE-VOLUME-DE-RESULTADOS.md` ausente e `stack.yml` sem volumes de decisões/resultados; nenhum log nos módulos 6B/6C; vínculo C2 no instante da gravação; troca de evidência re-selada só vira `stale` nas consultas.
- Achado adicional: o runbook da 6B (§15 item 1) recomenda reenviar a partir de `pending.record`, o que invalida a premissa do ADR (risco 2); o painel de pendente não mostra valor nem justificativa.
- Suíte completa isolada: 1 falha em `deploy-config.test.ts` atribuída à sanitização do `.env.production.example` no snapshot.

Arquivos de apoio desta revisão (na pasta de trabalho): `proj/tests/rv-01-forged-pending.test.ts`, `proj/tests/rv-02-fifo.test.ts`, `proj/tests/rv-03-removal.test.ts`, `proj/tests/rv-04-forged-decision.test.ts`; saídas `rv01.out`, `rv02.out`, `rv03.out`, `rv04.out`, `fullsuite.out`.
