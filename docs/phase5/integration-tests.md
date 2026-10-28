# Fase 5: testes de integração e homologação

Atualizado em 16/10/2026. Todos os testes automatizados usam **mocks/fixtures**: nenhuma rede, nenhum Serper, nenhum Redis/Supabase reais.

## Resultado da suíte
`npm test`: **343 testes, 343 aprovados, 0 falhas** (286 na Fase 4; 326 no meio da Fase 5; +17 no encerramento). `npm run typecheck`: sem erros. `npm run build`: compilado, 14 rotas + middleware. `.env.local`: hash idêntico ao do início.

## Matriz dos 16 cenários funcionais (com mocks)
| # | Cenário | Teste |
|---|---|---|
| 1 | Login válido (lista + senha) emite cookie `HttpOnly`/`SameSite=Strict` aceito pelo middleware | `middleware.test.ts` |
| 2 | Login inválido/e-mail fora da lista: respostas idênticas; fora da lista nem chega ao Supabase; limite de tentativas (429) | `middleware.test.ts` |
| 3 | Rotas e páginas sem sessão: 401/redirect; autenticação não configurada ⇒ 503 (falha fechada) | `middleware.test.ts`, `auth.test.ts` |
| 4 | PDF sem sessão (inclui `/audits/*`) ⇒ 401; ID inválido ⇒ 400; caminho fora das pastas recusado; nome sanitizado | `middleware.test.ts`, `pdf-render.test.ts` |
| 5 | Pipeline completo do Maestro (49 pontos, Juiz, Estrategista/Revisor, PDF) sem rede | `maestro-integration.test.ts` |
| 6 | Duplo clique/auditoria repetida: trava, 409 por ativa/concluída/retomável, `force` explícito | `worker-reliability.test.ts` |
| 7 | Redis indisponível ⇒ 503 genérico sem vazar detalhe; heartbeat distingue "Worker parado" de "Redis inacessível" | `auth.test.ts`, `worker-reliability.test.ts` |
| 8 | Supabase indisponível ⇒ 503 genérico; falhas internas não vazam mensagem | `auth.test.ts` |
| 9 | Worker ignora job duplicado/reentregue (claim) sem executar o pipeline | `worker-reliability.test.ts` |
| 10 | Job travado/falho persiste `FAILED`; falha ao gravar não derruba o Worker | `worker-reliability.test.ts` |
| 11 | Retomada reaproveita Reputação/Vitrine/Battlefield: **0 chamadas** ao Serper | `maestro-integration.test.ts` |
| 12 | Serper com falhas/respostas parciais: pontos ilegíveis fora do denominador; dados simulados bloqueados fora do modo demonstração | `maestro-integration.test.ts`, `phase4-agents.test.ts` |
| 13 | Histórico: campanha salva reaberta com os mesmos 10 leads sem consulta externa; "Resultado histórico recuperado" com data original | `phase5-ui-persistence.test.ts`, `completed-audits.test.ts` |
| 14 | PDF nunca sobrescreve (`-r2`, `-r3`); padrão privado `.data/audits`; nada vai ao Supabase sem bucket privado; sem URL pública | `pdf-render.test.ts` |
| 15 | PDF ausente é recomposto do banco, sem consultas externas e sem gravar | `maestro-integration.test.ts` |
| 16 | 49 marcadores/mapa: grade preservada; `MbtilesProvider` (TMS, gzip, atribuição, coordenadas inválidas) e contingência sem mapa-base | `battlefield-map-*.test.ts`, `pdf-mbtiles.test.ts`, `pdf-basemap.test.ts` |

Também cobertos: sessão (assinatura, adulteração, expiração, versão), allowlist e revogação imediata, bypass de dev só em loopback+development, `Origin` cruzada, redação de segredos (texto e objetos), limitador, estados da UI (Aguardando, Em execução, Concluída, Falhou, Interrompida, Histórico recuperado), seletor de campanhas, saúde sem expor valores.

## Validações fora da suíte (somente leitura, sem custo)
1. **HTTP real** no servidor de produção local: tabela completa em `security-review.md` §2 (401 sem sessão; PDF servido idêntico ao oficial com sessão válida; 403 cross-origin; 404 em `/dev/*`).
2. **Banco real**: `npm run db:check` ⇒ 6 auditorias, 80 leads, **nenhum problema** (place_id coerente, payloads completos, PDFs localizados). Dois PDFs históricos guardavam caminho do Windows (`D:\…`); a leitura agora os resolve pelo nome do arquivo dentro das pastas permitidas (sem mover nada).
3. **Saúde real**: `GET /api/system/health` ⇒ Redis OK, Supabase OK, fila `waiting 0 / active 0 / failed 0 / completed 3`, **Worker DOWN** (não estava rodando, como esperado).
4. `npm run pdf:migrate-plan` (simulação): 3 PDFs, 0,28 MB, todos expostos publicamente.

## Encerramento da Fase 5 (novos testes)
`pdf-private-store` (chave validada, upload sem sobrescrever, ordem de leitura privada → `public/audits`, cadeia local → bucket privado → recomposição), `pdf-migration` (Supabase falso: inventário, backup sem escrita em produção, cópia idempotente, bucket público recusado, fechar bucket só muda visibilidade, rollback), `rls-probe` (classificação "só RLS" × "sem privilégio", filtro impossível nas escritas, vazamento detectado), `dedup-place` (consulta por `place_id`), retomada só com dados (`NOTHING_TO_RESUME`), `Referrer-Policy`, estados da UI sem dados. Validações sem custo: `validate:recovery` (32/32), `db:check`, `rls:probe` (anon + token forjado), `pdf:migrate inventory/backup/verify-links`, verificação em navegador dos tiles do mapa.

## Teste operacional real: NÃO executado
Exige sua aprovação detalhada (ver `release-checklist.md`). Simulação e homologação real ficam registradas separadamente; hoje só a **simulação com mocks** foi feita.

## Não coberto / limites
- Login contra o Supabase Auth real (verificador simulado nos testes).
- Redis/BullMQ reais com Worker real (apenas lógica pura e fakes).
- Mapa-base com extrato MBTiles real (provedor testado com MBTiles sintético derivado de um tile real).
- ESLint não está instalado (`npm run lint` não é usado).
