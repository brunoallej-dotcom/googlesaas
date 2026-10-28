# Fase 5: confiabilidade do Maestro e do Worker

Atualizado em 16/10/2026.

## Princípio
Uma auditoria custa **49 consultas pagas** ao Serper. Toda proteção abaixo existe para que nenhuma consulta paga seja repetida sem uma ação explícita do operador. As tentativas automáticas do Maestro continuam desligadas (`attempts: 1`).

## Camadas contra duplicação
| Camada | Mecanismo | Resultado |
|---|---|---|
| 1. Trava de enfileiramento | Redis `SET NX EX 120` por **empresa (`place_id`) + palavra-chave normalizada** (a mesma empresa vira um lead novo a cada campanha; casar por lead deixava passar duplicatas) | O segundo clique/aba simultânea recebe **409 `ALREADY_RUNNING`** |
| 2. Consulta ao banco | Auditorias da mesma empresa+palavra-chave: ativa ⇒ 409; concluída ⇒ 409 `ALREADY_COMPLETED` (a UI abre a existente e pede confirmação para nova coleta, `force`); parada com Battlefield gravado ⇒ 409 `RESUMABLE_EXISTS` | Nenhuma auditoria nova por engano |
| 3. Reivindicação atômica | `claimAudit`: `UPDATE … WHERE status='QUEUED'` (compare-and-set) | Job duplicado, segundo Worker ou reentrega **não executam nada** |
| 4. Sem regressão | `updateAuditProgress` não move `COMPLETED/FAILED` de volta a `RUNNING_*`, e `COMPLETED` nunca vira `FAILED` | Evento tardio não corrompe o estado |
| 5. Job travado | `maxStalledCount: 0` + `lockDuration: 120 s`: um job estagnado **falha** em vez de voltar à fila (que refaria as 49 consultas) | Perda controlada, sem gasto repetido |
| 6. Falha persistida | Evento `failed` do Worker grava `FAILED` + motivo (`handleJobFailure`) | A auditoria não fica "em andamento" para sempre |

## Redis e Supabase indisponíveis
- `enqueue` verifica o Redis (ping de 3 s) **antes** de gravar qualquer linha: sem Redis ⇒ **503 `REDIS_UNAVAILABLE`**, nada criado, nada cobrado (sem registros órfãos).
- Falha do banco ⇒ **503 `DATABASE_UNAVAILABLE`**; falha ao enfileirar depois de criar a linha ⇒ a linha é marcada `FAILED` e a trava é liberada.
- Mensagens ao cliente são genéricas, com `correlationId` para achar o detalhe (redigido) no log.

## Estado "Interrompida" (derivado)
O enum do banco **não mudou** (sem migration). `deriveAuditPhase` calcula: **Aguardando** (`QUEUED`), **Em execução**, **Concluída**, **Falhou** e **Interrompida** quando (a) não há atualização há `GMN_AUDIT_STALE_MINUTES` (padrão 15 min; a coleta dos 49 pontos é a etapa mais longa) ou (b) o Worker não dá sinal e passaram 2 min. O Worker publica `gmn:worker:heartbeat` (TTL 45 s, a cada 10 s). `GET /api/audit/<id>/status` devolve `phase`, `phaseReason`, `resumable`, `workerAlive`. A UI nunca inventa progresso: só mostra o que o servidor informa.

## Retomada segura
`POST /api/audit/<id>/resume` (somente ação do operador; só para `FAILED` ou interrompida **e com o Campo de Batalha de 49 pontos já gravado**; sem dados responde 409 `NOTHING_TO_RESUME`, porque "retomar" seria uma coleta nova de 49 consultas pagas): CAS devolve a linha a `QUEUED` **preservando todos os payloads**, enfileira com `resume: true` e id de job novo. O Maestro reaproveita **Reputação, Vitrine e Battlefield (49 pontos, mesma empresa)** já gravados; só as etapas faltantes rodam. Teste: retomada executa **0 chamadas** ao Serper. A verificação técnica do site (HTTP gratuito) é refeita.

## Operação
- `GMN_WORKER_CONCURRENCY` (1–10, padrão 3) e o limitador do Worker (10 jobs/min) continuam.
- Encerramento limpo em SIGINT/SIGTERM (`worker.close()`); o batimento é interrompido junto.
- Em desenvolvimento use `npm run worker:prod` (sem watch) para auditorias reais; `npm run worker` reinicia a cada edição de arquivo e **mataria um job em andamento**.

## Limites conhecidos
- O heartbeat prova que **algum** Worker está vivo, não que ele está processando aquele job; por isso a detecção também usa a idade da última atualização.
- Se o processo do Worker morrer no meio de uma etapa, a auditoria fica "em andamento" até o limite de inatividade e então aparece como Interrompida (retomável).
- O limitador de requisições é em memória (instância única).
