# Onda 6C — Revisão adversarial independente nº 8 (16/11/2026)

**Parecer: SEM BLOCKER nas duas partes.** Dois MAJOR novos (parte B), ambos reproduzidos pelo coordenador e corrigidos no PR #17. O MAJOR da parte A é uma **limitação já declarada** (ADR da prova de origem); o responsável decidiu fechá-la (PR #19). Critério 7 da §19.2 da spec 6C ("revisão adversarial independente do código final sem BLOCKER") **atendido**; a Onda 6C só será encerrada com aprovação formal do responsável depois dos merges das correções.

**Revisores:** dois agentes automatizados (Claude Sonnet), **sem contexto das revisões anteriores** e instruídos a não ler os relatórios nº 1–7d nem o checklist de produção (para não ancorar a análise). Trabalharam em cópias isoladas (worktrees) sobre a `main` em `7013b2a`; o código de produção da Fase 6 é o mesmo da `main` atual (os PRs #12 e #15 não alteram `src/lib/link-audit*`). Saída de revisor automatizado; não é aprovação do responsável.

**Registro incompleto:** os relatórios integrais dos revisores e o teste de prova da parte A ficavam numa pasta temporária que foi apagada quando a sessão caiu. Este documento guarda os **resumos entregues pelos revisores** e a **verificação do coordenador**; o teste de prova da parte A foi reconstruído como teste de regressão no PR #19 (`tests/link-audit-ledger-phase-c-author.test.ts`).

## Parte A — decisões humanas, livro de cabeças, recibos, prova de origem

Escopo: `src/lib/link-audit-storage/`, `src/lib/link-audit-origin/`, `src/lib/link-audit-ledger/`, `src/lib/link-audit-decisions/`, `src/app/api/link-audit/decisions/**`, `src/app/api/link-audit/body.ts`.

| Achado | Sev. (revisor) | Resumo | Verificação do coordenador | Destino |
|---|---|---|---|---|
| M-1 | MAJOR, provado | Recibo de decisão não é autenticado: quem escreve só na pasta de recibos forja o recibo de uma pendente legítima de outro operador; a escrita ou o `RECOVER` de qualquer operador grava o `CONFIRMED` e a decisão vira vigente sem o autor reenviar | Prova rodada (2/2). **Já declarada** em `onda6c-adr-prova-de-origem.md` (tabela) e `onda6c-modelo-de-ameacas-recuperacao.md` ("autenticar os recibos… não adotado"); o revisor recebeu uma invariante mais forte que a spec | **Fechado** por decisão do responsável: fase C só pelo autor (spec do livro §16.16; PR #19) |
| m-2 | MINOR, cálculo | Reserva de revogação (100) menor que o teto de decisões vigentes (200): perto do limite da classe RECORD, ≥ 99 decisões ficam irrevogáveis | Exige ≈ 1.800 decisões numa auditoria (na prática, INFO) | Registrado (capacidade, spec §16.12) |
| m-3 | MINOR, suspeito | Remover e devolver `d000N` durante a fase B leva a `PUBLISHED_AFTER_ABORT` permanente (negação de serviço, falha fechada) | Não provado | Registrado |
| m-4 | MINOR, leitura | Qualquer operador lê e-mail e justificativa de revogação no histórico | Provável decisão de projeto (trilha de auditoria) | Decisão do responsável pendente |
| m-5 | MINOR, leitura | Nos estados legado/inscrição/não resolvido o GET devolve 200 com histórico | Coerente com o contrato do livro (§16.2) | Sem ação |
| INFO | — | E/S de leitura antes da validação do `auditId` em `decisions/shared.ts`; `EMAIL_PATTERN` aceita C1 que o livro recusa (falha antes de publicar); pendência sem autor bloqueia sem saída (declarado §16.8) | — | Registrado |

Confirmado pelo revisor (leitura): leitura estrita (bytes canônicos, hash sobre o JSON bruto, `O_NOFOLLOW`/`O_NONBLOCK`/`fstat`, limite de tamanho); separação de domínios do HMAC e chaves distintas; remoção de revogação detectada (`HISTORY_REGRESSED`/`TRUNCATED`/`RECEIPT_REMOVED`); livro truncado ou apagado detectado; falha de fsync nunca vira sucesso; autor e hora do servidor; corpo `.strict()`; concorrência por `link()` exclusivo.

## Parte B — finalização de resultados, evidências com prova de coleta, rotas

Escopo: `src/lib/link-audit-scoring-runs/`, `src/lib/link-audit-evidence/`, rotas `scoring`, `evidence`, `parse`, `confirm`, `body.ts` e o uso da sessão.

| Achado | Sev. (revisor) | Resumo | Verificação do coordenador | Destino |
|---|---|---|---|---|
| MAJOR-1 | MAJOR, provado | Negação de serviço: `sanitizeForOutput` roda sobre relatórios inteiros (até 2 MB, textos sem limite) e regex quadráticas travam o processo web com um único GET | Reproduzido: 4k 33 ms, 8k 132 ms, 16k 559 ms; medição isolada achou **4** expressões quadráticas (consulta de link sem esquema, credencial em URL, JWT, pontuação final de link) | **Corrigido** no PR #17 (saída idêntica, provada por teste diferencial; teto de 4.096 caracteres) |
| MAJOR-2 | MAJOR, provado | `GET /api/link-audit/evidence/{auditId}` devolve o caminho da URL do website (`;jsessionid=…`), contra §19.2 item 5 | Reproduzido com `sanitizeUrl` | **Corrigido** no PR #17 (só esquema + host) |
| MINOR-1 | MINOR, provado | Em PONTUADO, critério `NOT_VERIFIED` sai com `obtainedHalfPoints: 0` | Viola §19.2 item 4 ("ausência nunca vira zero") na API | **Corrigido** no PR #18 (`null` para não avaliado) |
| MINOR-2 | MINOR, suspeito | Concluir resultado pendente pode dar recibo a um resultado já histórico (sinalizado por `stale`/`decisionsChanged`) | Comportamento declarado na spec | Consumidores futuros (Onda 7) devem exigir `stale == false` e `decisionsChanged == false` |
| MINOR-3 | MINOR, suspeito | Janela entre `fingerprintNow` e `link()` (decisões e evidências sem trava comum) | Declarado no código e na spec; detectável por `stale` | Registrado |
| MINOR-4 | MINOR, suspeito | `parse`/`confirm` sem limitador de taxa | Custo baixo (≤ 29 ms com 10k caracteres) | Registrado |
| MINOR-5 | MINOR, suspeito | Erros engolidos sem log estruturado; sem trilha de tentativas de finalização | Confirmado (0 usos do logger na Fase 6) | Spec `docs/specs/link-audit-observability.md` |
| INFO | — | Resultados selados não reverificam a prova de coleta atual nem gravam `keyId`/`seq` do manifesto (fase 4 do ADR 6C-03); origem HMAC de confirmados não reverificada (RV2-W1, declarado); leitura de resultados depende do `storageStatus` das evidências; limitadores em memória; em INCONCLUSIVO `tier` + `maxHalfPoints` permitem deduzir pontos por subcritério (decisão da spec) | — | Registrado |

Refutado pelo revisor (testado ou lido): vazamento de caminho absoluto no 409; bypass da prova de coleta escrevendo numa só pasta (cobertura bidirecional, maior `seq` sem recuo, chave de ordem pequena, `auditId`/`seq` assinados, sobreposição de pastas, `legacy-status`); escolha da `trust` e bloqueio `EVIDENCE_PROVENANCE_UNPROVEN`; corpo da finalização estrito; `dev@localhost` recusado; pendente forjada numa só pasta nunca vira confirmada.

## Não coberto pelas duas partes

Testes de queda real (SIGKILL) e de vários processos (só leitura do protocolo na parte A); disco cheio/EIO reais; rotação de chaves e `CHECKPOINT` sem prova adversarial; guarda externa (só adaptador sintético); a interface; rotas pelo runtime do Next (parte B testou serviços e auxiliares); a suíte completa.
