# Fase 4: proveniência e rastreabilidade dos dados

> **Decisão definitiva (16/10/2026):** sem DataForSEO, sem Google Business Profile API e sem novos serviços pagos. Fontes: Serper já contratado, dados reais das integrações existentes e verificações técnicas de sites públicos.

Atualizado em 16/10/2026.

## Princípio

Toda informação importante de uma auditoria carrega a sua origem: o valor observado, a fonte, o momento da coleta, o status da evidência, o que foi comprovado e o que **não** foi. Quando não há fonte real, o campo fica **indisponível** (`null` com motivo), nunca um número com aparência de real.

## Modelo de evidência (`src/lib/evidence/types.ts`)

```ts
type EvidenceStatus = 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'NOT_VERIFIED' | 'SIMULATED';

interface AuditEvidence {
  criterionId: number;            // 1 a 21
  status: EvidenceStatus;
  value: unknown;                 // resumo JSON-seguro (nunca a resposta integral do provedor)
  sourceProvider?: string;        // ex.: "Serper.dev (Google Maps)"
  sourceType?: string;            // ex.: "LISTAGEM_PUBLICA", "BUSCA_TERRITORIAL_49_PONTOS"
  sourceReference?: string;       // ex.: roundId do Battlefield, URL final do site
  collectedAt?: string;           // ISO 8601
  explanation: string;            // o que foi comprovado (ou por que não foi)
  limitations: readonly string[]; // o que a conclusão NÃO cobre
  confidence?: number;            // 0 a 1
}
```

Além disso: `Availability<T>` (disponível ou indisponível com motivo, provedor e data da tentativa), `ProviderFailure` (falha estruturada: provedor, operação, motivo, HTTP, tentativas, data) e `EvidenceBundle` (`schemaVersion`, evidências, falhas de provedor e o marcador `demo`).

## Onde cada coisa fica gravada (sem migration)

Nenhuma tabela, coluna ou migration foi criada. As evidências ficam dentro dos payloads JSONB que já existem em `gmn_audits`:

| Payload (coluna) | O que a Fase 4 acrescenta (campos opcionais) |
|---|---|
| `judge_payload` | `checklist21Items[].evidence`, `scoreSummary`, `evidenceBundle` (`schemaVersion: 1`, evidências persistíveis, `providerFailures`, `demo`) |
| `reputation_payload` | `reviewsAvailability` (estado, provedor, motivo, análise da amostra); indicadores nulos quando indisponíveis |
| `vitrine_payload` | `availability` (estado, motivo); contadores nulos: nenhuma fonte contratada informa fotos, vídeos nem publicações |
| `battlefield_payload` | `dataOrigin`, `methodVersion`, `rankIndexAverage`, `knownPositionAverage`, `outsideTop20Count`, `providerFailures` |
| `strategist_payload` | classificação, evidência, confiança, indicador e prazo em cada ação; `maintainNotes` |

**Compatibilidade.** Auditorias anteriores continuam sendo lidas exatamente como foram gravadas: nenhum campo novo é obrigatório. Para elas, a cobertura de evidências é **reavaliada em tempo de leitura**, de forma conservadora (a classe mais fraca entre a regra antiga e a atual), e a pontuação histórica gravada é preservada. Nada é reescrito no banco.

**Preparação para tabelas dedicadas (não implementadas).** Cada evidência já é um registro independente, com `criterionId`, `schemaVersion` do pacote e identificador da auditoria (`auditId`) disponíveis no contexto. Uma futura tabela `gmn_audit_evidence (audit_id, criterion_id, schema_version, status, value, source_*, collected_at, explanation, limitations, confidence)` pode ser preenchida a partir do JSONB por um script, sem mudar os produtores. Nenhuma migration foi escrita; quando for o momento, o SQL versionado, a verificação de compatibilidade e o plano de reversão serão apresentados antes de qualquer execução.

## Regras de armazenamento

- **Dados simulados nunca são persistidos como evidência real.** `toPersistableEvidence` remove evidências `SIMULATED` do pacote. No item do checklist, o critério fica marcado como simulado, sem valor e sem pontuação.
- Textos e nomes de clientes **não** são gravados (`recentReviewsSample` fica vazio); só os indicadores calculados.
- Nenhuma credencial é gravada. Mensagens de falha não incluem chaves.
- `value` guarda um resumo (contagens, estado, endereço comparado), nunca a resposta integral de um provedor.
- Cada evidência de origem externa traz `collectedAt`. A data da coleta territorial (`battlefield.executedAt`) e a data de geração do PDF continuam separadas.

## Fontes e termos dos provedores

| Fonte | Uso | Observações de licença e custo |
|---|---|---|
| Serper.dev Maps | Listagem pública e buscas por coordenada | Créditos por consulta (preço a confirmar na tabela do provedor). Respostas não são redistribuídas; só resumos são gravados. |
| Serper.dev Reviews | Avaliações datadas e respostas do dono (**desligado**) | Cada página é uma chamada paga (custo a confirmar). Formato da resposta **não confirmado**; nenhuma chamada real foi feita. |
| DataForSEO | **Descartado** (decisão de 16/10/2026) | Não será configurado; nenhum campo depende dele. |
| Verificação do site | Resposta HTTP, noindex, robots.txt, JSON-LD | Requisições públicas ao site do próprio lead; sem custo de API. Identificadas pelo User-Agent `GMN-Intelligence-Audit/1.0`. |
| Google Business Profile API | **Descartada** (decisão de 16/10/2026) | Não será integrada. Nunca se pedem senhas do Google nem se acessam áreas privadas. |

## Dados internos do perfil

Serviços, atributos, reivindicação, vídeos, datas de mídia e publicações só existem no painel do proprietário. Pela decisão de infraestrutura de 16/10/2026 não haverá integração para obtê-los: esses critérios permanecem **NÃO VERIFICADOS** e o relatório indica como o proprietário pode confirmá-los manualmente. Nada é simulado para aumentar a cobertura.

## Pontuações: armazenada × recalculada

- O **Score Juiz histórico** (ex.: 56,4%) só existe como valor **gravado** por auditorias anteriores à Fase 4 (metodologia original, 21 critérios, denominador 102). Nunca é recalculado: o relatório o lê de `judge_payload.overallScore` (ou de `ReportSourceData.storedJudge`, quando a ficha foi reavaliada só para o PDF).
- A **pontuação recalculada** (`scoreSummary.recalculatedScore`, `scoreMethod: 'PHASE4_SCORED_WEIGHT'`) usa a mesma média ponderada, mas só sobre critérios com pontuação; informa `denominatorWeight` e `scoredWeightPercent` e **não é comparável** ao histórico.
- O **desempenho nos critérios verificados** usa só critérios VERIFICADOS.
- Auditorias nativas da Fase 4 não têm score histórico: mostram apenas a recalculada e o desempenho verificado.

## Origem de dado simulado

| Origem | Como é identificado | Aparece como |
|---|---|---|
| Legado | Marcadores em payloads de auditorias anteriores à Fase 4 (`rev_<placeId>_`, `med_<placeId>_`, `ChIJ_RIVAL_DOMINATOR_*`, autores fictícios) e ausência dos campos `reviewsAvailability`/`availability` | SIMULADO (LEGADO) |
| Demonstração | `GMN_DEMO_MODE=true` (`evidenceBundle.demo`, `battlefield.dataOrigin: 'SIMULATED'`) | SIMULADO (DEMONSTRAÇÃO) e faixa roxa no PDF |
| Fixture de teste | `ReportSourceData.testFixture` (só `src/dev/*`) | SINTÉTICO (TESTE) e faixa roxa em todas as páginas |

Auditorias novas **nunca** carregam simulação fora da demonstração: a guarda do Maestro interrompe a auditoria se isso acontecer, e evidências simuladas nunca são persistidas.

## Modo demonstração

Dados simulados só existem com `GMN_DEMO_MODE=true` (definido pelo usuário; nunca por falha de coleta). Eles saem identificados: `battlefield.dataOrigin: 'SIMULATED'`, marcadores de id (`med_<placeId>_`, `ChIJ_RIVAL_DOMINATOR_`) e `evidenceBundle.demo: true`. Rodadas simuladas do Battlefield nunca são usadas como base de comparação histórica.
