# Fase 4: plano de implementação, riscos e pendências

Atualizado em 16/10/2026.

## Objetivo

Aumentar a cobertura real das auditorias, eliminar simulações em produção e garantir que todo resultado tenha uma fonte identificável. Não é meta tornar os 21 critérios verificados: é regra que **nenhum** seja apresentado como comprovado sem evidência suficiente.

## Ondas

| Onda | Entrega | Principais arquivos |
|---|---|---|
| 4.0 Auditoria das fontes | `evidence-audit.md` com os 21 critérios | `docs/phase4/evidence-audit.md` |
| 4.1 Eliminar simulações | Reputação, Vitrine, Battlefield, Rivais e Prospecção sem dados fictícios; demo só com `GMN_DEMO_MODE=true`; falhas estruturadas | `src/agents/{reputation,vitrine,battlefield,rivals,head-prospector}-agent.ts` |
| 4.2 Ampliar a coleta real | Verificação técnica do site com proteção SSRF; leitor de avaliações datadas (Serper Reviews, desligado); WhatsApp sem "confirmado por formato"; Vitrine sem provedor | `src/lib/url-safety.ts`, `src/lib/site-check.ts`, `src/lib/serper-reviews.ts` |
| 4.3 Proveniência | Modelo de evidência e persistência nos JSONB existentes | `src/lib/evidence/*` |
| 4.4 Agente Juiz | Score histórico, desempenho verificado, parcial à parte e cobertura; critérios 1, 3, 5, 6, 12–18 corrigidos | `src/agents/judge-agent.ts`, `src/lib/judge-scoring.ts`, `src/lib/evidence/criteria.ts` |
| 4.5 Battlefield | Índice de posição x média das posições conhecidas, com denominadores; mesma metodologia no dashboard e no PDF | `src/lib/battlefield-metrics.ts`, `src/lib/battlefield-map-adapter.ts` |
| 4.6 Concorrência e histórico | Comparação só entre rodadas compatíveis; rivais sem estimativas | `src/lib/history-compat.ts`, `src/agents/rivals-agent.ts`, `src/lib/supabase.ts` |
| 4.7 Recomendações | Ações geradas das evidências, classificadas, sem promessas | `src/lib/recommendations/index.ts`, `src/agents/strategist-agent.ts`, `src/agents/reviewer-agent.ts` |
| 4.8 Dashboard e PDF | Cobertura de evidências e nomenclatura corrigida, sem redesenho | `src/components/dashboard/*`, `src/lib/pdf/*` |

## Decisões

1. **Sem migration.** Evidências ficam nos JSONB existentes, com `schemaVersion`. Tabelas dedicadas ficam para depois e exigirão aprovação do SQL, da compatibilidade e da reversão.
2. **Fórmula histórica intacta.** O score histórico continua sendo a média ponderada normalizada pelos pesos. Critério sem base de pontuação (`scoreAwarded: null`) fica **fora do numerador e do denominador**: não é zero nem 100. Em auditorias anteriores todos os critérios têm nota e o resultado é idêntico ao original (teste de equivalência).
3. **Parcialmente verificado fica à parte.** Não entra no desempenho verificado nem na cobertura verificada.
4. **Classificação de saúde.** Com menos de 50% do peso verificado, `healthClassification` vira `INSUFFICIENT_EVIDENCE` (novo valor; consumidores existentes não o usam).
5. **Leads relidos do banco** não carregam a origem dos campos (não há coluna). Por isso reivindicação, atributos e serviços são tratados como NÃO VERIFICADOS por construção, e nota/avaliações iguais aos padrões antigos também.
6. **Modo demonstração** só por variável explícita; nada o ativa após falha.
7. **Reprocessamento sem duplicar e sem sobrescrever.** `npm run pdf:regenerate -- <auditId> [--reevaluate]` só lê o banco e grava fora do armazenamento oficial. `--reevaluate` reavalia o Juiz e o Estrategista **apenas para o PDF gerado** e não pode ser combinado com `--store`. Os jobs do BullMQ continuam usando `jobId = auditId`, que impede duplicidade.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Formato da resposta do Serper Reviews não confirmado | Leitor defensivo, desligado por padrão, fixtures identificadas como hipotéticas, 1 chamada de teste só com autorização |
| SSRF ao consultar sites de terceiros | Validação de URL, resolução DNS fixada, bloqueio de IPs internos/metadados em cada salto, no máximo 3 redirecionamentos, corpo e prazo limitados (13 testes) |
| Cobertura menor que a da Fase 3 | Aceito e documentado: a queda de 7 para 5 critérios verificados vem de remover aprovações indevidas (3 e 5) |
| Nota de lead 0/0 passa a aparecer no dashboard quando a coleta não traz nota | `provenance` marca como desconhecido; os critérios 10 e 11 ficam não verificados |
| Auditorias antigas com dados simulados ainda no banco | Preservadas; o PDF e o dashboard as identificam como simuladas |

## Decisão definitiva de infraestrutura (16/10/2026)

- **Não** usar DataForSEO nem Google Business Profile API. **Não** contratar novas APIs ou serviços pagos.
- Prioridade ao Serper já contratado; aproveitar ao máximo os dados reais existentes; verificações técnicas de sites públicos quando permitidas e sem serviços pagos.
- Informação que não puder ser comprovada é **NOT_VERIFIED**. Nenhum dado é simulado para aumentar a cobertura.
- Consultas que consumam créditos só com autorização expressa. `.env.local` não é modificado.

Consequências já aplicadas: o `VitrineAgent` não chama mais nenhum provedor (fotos, vídeos, datas de mídia e posts ficam não verificados); os documentos foram ajustados; DataForSEO e Business Profile saíram das pendências. Os ramos antigos de DataForSEO no Prospector e no Battlefield são caminhos dormentes (só executariam com credenciais reais, que não existem e não serão configuradas) e foram mantidos para não alterar o captador dos 10 leads nem o Battlefield.

## Ajustes finais (16/10/2026)

Pontuações separadas (armazenada × recalculada × verificada), critério 3 parcial, simulado legado × demonstração × fixture, PDFs de fixture identificados, guarda fail-closed no Maestro, `GMN_PDF_OUTPUT_DIR` para validar sem tocar em `public/audits`, e provas do mapa em outras cidades (6 tiles reais de Goiânia). Detalhes e resultados: `validation-report.md`.

## Estado das pendências

1. **Serper `/reviews` (única chamada que ainda depende de você).** Pode melhorar os critérios 12, 13 e 14 sem nova contratação, mas consome créditos do plano atual e o formato da resposta não está confirmado. Estimativa: **1 chamada** (página 1) para o lead da auditoria `859b4021…`. Só será feita com autorização expressa; nada foi chamado.
2. **Verificação técnica do site do lead: concluída** em 16/10/2026 (sem custo; ver `validation-report.md`).
3. **Critérios sem fonte possível dentro da decisão** (1, 2, 7, 8, 16, 17, 18, e 9 em parte): permanecem NÃO VERIFICADOS ou PARCIAIS; o PDF indica como validar manualmente.
4. **Mapa-base em produção:** o padrão é sem mapa-base. Com a pasta local, só Anápolis e Goiânia têm tiles. Ruas em qualquer cidade exigem a autorização do OpenFreeMap (pendente) ou um extrato próprio.
5. **Coordenadas do lead:** quando a listagem não traz latitude/longitude, o prospector usa o centro da cidade (não alterado; fase própria).
6. **Endpoints sem autenticação** (`/api/audit/*`, `/api/prospect`): nenhum endpoint novo foi criado; a lacuna continua.
7. **Validação operacional controlada:** falta executar UMA auditoria real pelo Worker (Redis/Upstash e Supabase reais), o que consome créditos do Serper (49 consultas) e grava em produção. Só com a sua autorização.
8. **ESLint não está instalado**; lint não executado.
