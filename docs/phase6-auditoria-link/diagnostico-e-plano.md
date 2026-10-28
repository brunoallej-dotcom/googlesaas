# Fase 6 — Auditoria por link · Diagnóstico técnico e plano de implementação (Rodada 2)

Status: **planejamento; nada implementado**. Escopo desta rodada: somente documentação. Sem código, migrations, Supabase, `.env.local`, Serper, APIs ou IA pagas.

## Contexto
A GMN continua como plataforma interna de prospecção. A Fase 6 acrescenta uma área independente: o operador cola o link de um perfil do Google Maps/GMN e recebe a auditoria do agente original (método Lumos + PDF de 12 páginas), sem misturar com os 21 critérios do Juiz nem com a grade 7x7. A Rodada 1 produziu achados, 20 conflitos, plano E0–E9 e 8 pendências (recuperados em `.data/resgate-wsl-20261019-230005/`). Esta rodada completou os 4 mapeamentos que faltavam.

Transparência: a tabela C-01…C-20 original não foi recuperada, só os achados. A numeração abaixo foi re-derivada desses achados (20 itens, todos com fonte); se o original reaparecer, prevalece o original.

---

## 1. O que já existe (confirmado no código)

### 1.1 Aba Auditorias e navegação
- Única página do painel: `src/app/page.tsx` (client). "Auditorias" **não é rota**: é âncora `#auditoria` no `NAV_ITEMS` (`src/components/dashboard/sidebar.tsx:29-37`, links `href="#…"` em `:121-139`); seção ativa via IntersectionObserver (`dashboard-shell.tsx:57-76`, `SECTION_IDS` `:10`).
- `AuditPanel` (`audit-panel.tsx`) mostra **uma** auditoria por vez (a do lead selecionado): progresso, retomar, nova coleta, categorias do Juiz, `EvidenceCoverage`, download `/api/audit/<id>/pdf` (`:199`). Não há listagem de `gmn_audits`.
- Disparo: `handleTriggerAuditPdf` (`page.tsx:141-206`) → `POST /api/audit/enqueue` (exige `leadId`) → BullMQ `gmn-audit-pipeline` → `audit-worker.ts` → `maestroOrchestrator`. Não existe formulário que receba URL.
- Segurança: `src/middleware.ts` protege tudo exceto login (nova rota fica protegida automaticamente); `requireOperator` (`src/lib/auth/require-operator.ts:12-23`) em toda API; bloqueio cross-origin em `guard.ts:48-64`.

### 1.2 Pipeline de PDF
- Motor: `pdfkit 0.16.0` (+fontkit). Sem HTML→PDF, sem pdfjs, sem renderizador PNG, sem bibliotecas Python de PDF, sem pdftoppm/mutool.
- Fontes: só Inter (4 pesos, `assets/fonts/`). Referências usam Arimo (Lumos) e DejaVu (Rio) — **não presentes**.
- Entrada: `renderReportPdf(ReportModel)` (`report-renderer.ts:41`); páginas variáveis (≥8); rodapé "Página N de M".
- Reutilizável sem acoplamento: `report-layout.ts` (`registerFonts`, `forceLatinScript`, `createSanitizer`, `Canvas`, `card`, `chip`, `progressBar`, `drawBullets`), `report-theme.ts` (`PAGE`, `FontSet`), `report-format.ts`, `countPdfPages` (`metadata-fix.ts:18`), `private-store.ts`, helpers de `serve.ts`. Algumas primitivas têm cores fixas.
- Acoplado ao Juiz (não reutilizar nem alterar): `report-model/evidence/metrics/narrative/plan/validation/source`, `report-pages*.ts`, `map/map-render.ts`, `diagrammer-agent.ts`, `download-chain.ts`, `regenerate.ts`.
- Persistência: `persistReportPdf` grava em `.data/audits` (flag `wx`, sem sobrescrever) e bucket privado `audits/<id>/…`, mas a URL é fixa `/api/audit/<id>/pdf` e os ponteiros ficam em `gmn_audits.diagrammer_payload/pdf_*`.
- Testes: runner `node --test` com **lista explícita** no package.json; extração de texto só por regex em `tests/pdf-render.test.ts:24`, que funciona apenas com fontes padrão e sem compressão.

### 1.3 Identificação, coleta e persistência
- **Não existe parser de link do Maps** (nenhuma ocorrência de `maps.app.goo.gl`, `g.page`, `!1s0x`, `cid=`, `place_id=`).
- Serper: `/maps` (prospecção 2 chamadas; grade 49) com casamento só por `placeId`/`cid` (`battlefield-agent.ts:434-446`); `/reviews` desligado por padrão, exige `fid` `0x…:0x…` (mesmo formato do segmento `!1s` de links longos), formato da resposta não confirmado. `/places` não usado. Sem contador de custo (apenas rate limit por operador).
- Serper não fornece: perfil reivindicado, atributos, serviços, fotos, vídeos, posts → hoje `UNKNOWN/NOT_VERIFIED`.
- `url-safety.ts` (bloqueio de IPs privados, DNS fixado, revalidação a cada redirecionamento) e `site-check.ts` (3 redirects, 512 KB, 8 s, parse só por regex) são reutilizáveis.
- Evidência: `EvidenceStatus` VERIFIED/PARTIALLY_VERIFIED/NOT_VERIFIED/SIMULATED (`src/lib/evidence/types.ts:16`); guarda contra simulado fora do demo (`guards.ts:28-39`). Sem zod para fatos.
- Banco: `gmn_audits.lead_id` NOT NULL FK; `gmn_leads.campaign_id` NOT NULL, `frontier_rank` 11–40. Resume recarrega o lead; a fila carrega o lead inteiro no payload. Migrations: 001, 002; `proposed/003_rls_hardening.sql` **não aplicada** (G5).
- Sem LLM no código (`LLM_*` só no `.env.example`).
- Cidade+UF: `src/lib/brazil-municipality.ts:24-48` (+ `head-prospector.ts:92-107`). Fora da prospecção, o PDF usa `parseCityState(addressRaw)` (`report-model.ts:189-193`).
- Achados colaterais (registrar, **não corrigir** na Fase 6): fallback DataForSEO ainda presente no código (`head-prospector.ts:387-456`, `battlefield-agent.ts:471-542`) apesar da regra "sem DataForSEO"; cidade da keyword da grade adivinhada por `businessName.split('-')` com padrão "Anápolis" (`maestro-orchestrator.ts:91-92`).

### 1.4 Material de referência (Rodada 1, preservado)
Pacote íntegro (SHA-256 = manifesto); PDFs de 12 págs A4, WeasyPrint 68; pesos 15/10/12/18/8/10/8/10/9 = 100; hierarquia Lumos PDF > Rio PDF > manual; JSON = exemplo. Medições completas em `.data/resgate-wsl-20261019-230005/achados-referencias.md`:
- Cores medidas: navy renderizado #03084C (manual #071044); fundo #F9F7F3/#F8F6F2 (manual #F2F4F8/#FFFFFF); bege #F4EFE7, sálvia #9EA28E, taupe #9E958C fora do manual.
- Lumos p4: 8/15, 5/10, 9/12, N/V(18), N/V(8), 7/10, 6/8, 6/10, 6/9 → 47/74 = 63,5 → 64; cobertura exibida 58%; confiança "baixa".
- Rio p4: 14, 7, 10, 17, 5, 8, 5, 10, 8 = 84/100 → 84 Forte; cobertura exibida 81%; confiança "média".
- Ocupação medida (fim do conteúdo, % da altura): Lumos p2–12 = 85, 91, 71, 70, 77, 67, 77, 97, 82, 72, 80; Rio p2–12 = 64, 68, 70, 61, 64, 66, 60, 73, 65, 58, 62.

## 2. Pontos de integração propostos
| Ponto | Proposta | Não tocar |
|---|---|---|
| Rota | `src/app/auditoria-link/page.tsx` (nova) | `page.tsx`, estado `auditsByLeadId`, polling |
| Navegação | `NavItem.href?` + 1 item; links existentes viram `/#secao` fora de `/`; `DashboardShell` com rótulo/ativo opcional | ids `auditoria/relatorios/concorrentes/leads/visao-geral/battlefield`, `SECTION_IDS` |
| API | `src/app/api/link-audit/*` com `requireOperator` | `/api/audit/*` |
| Execução | fila/tipo de job próprio (ou execução síncrona curta — D-10) | `gmn-audit-pipeline`, `BullMQAuditJobPayload`, maestro |
| Domínio | `src/lib/link-audit/*` (novo, puro) | `src/lib/evidence/criteria.ts`, `judge-scoring.ts` |
| PDF | `src/lib/link-audit/pdf/*` próprio, importando só primitivas genéricas | `report-*.ts` acoplados, `REPORT_COLORS` |
| Armazenamento | módulo próprio sobre `private-store.ts`, prefixo `link-audits/<id>/`, pasta `.data/link-audits/` | `persist.ts`, `download-chain.ts`, `gmn_audits.pdf_*` |
| Banco | `supabase/proposed/004_link_audits.sql` (tabela nova, sem FK para leads), não aplicada | 001/002, tabelas atuais |

Cuidados na navegação: links `#…` só funcionam em `/`; o cabeçalho assume `visao-geral` quando o observer não acha seção; `DashboardShell` precisa de `onLogout` na página nova para manter Logout e `SystemStatus`; `tests/middleware.test.ts` e qualquer teste que fixe a ordem de `NAV_ITEMS` devem continuar passando.

## 3. Conflitos C-01…C-20 (sem resolução por suposição)
| # | Conflito | Fontes | Decisão necessária |
|---|---|---|---|
| C-01 | Ordem das 12 páginas | manual §7 × guia §4 e ambos PDFs | qual estrutura vale |
| C-02 | Validações do manual §10 apontam páginas do próprio manual (p3 matemática, p8, p10, p11, p12) | manual §8, §10 × guia §4 | remapear validações |
| C-03 | Ocupação 55–82% × 65–85% | manual §6 × guia §5 | faixa |
| C-04 | ≥2 × ≥3 módulos por página | manual §6 × guia §5 | mínimo |
| C-05 | Referências deixam >1/3 em branco | Rio p5, p8, p11, p12; Lumos p7 × manual §6 | régua: regra ou referência |
| C-06 | Lumos p9 sem rodapé/numeração | Lumos p9 × guia §3 | tratar como defeito? |
| C-07 | JSON: soma 68/100 × base 54/75 × índice 72 × cobertura 78; sem pontos avaliados | JSON metadata/score_breakdown × manual §2 | JSON só exemplo de forma? |
| C-08 | Cobertura Lumos 58% (fórmula daria 74%) | Lumos p3–4 × manual §2 | fórmula |
| C-09 | Cobertura Rio 81% (fórmula daria 100%) | Rio p3–4 × manual §2 | fórmula |
| C-10 | JSON pontua Publicações N/V (3/8) | JSON × manual §3 | N/V exclui peso? |
| C-11 | Lumos pontua categorias/fotos/publicações N/V; publicações via LinkedIn | Lumos p3, p4, p7 × manual §3 | idem + externo ≠ nativo |
| C-12 | Rio pontua publicações/respostas/fotos não verificadas (5/8, 5/8, 8/10) | Rio p3–4 × manual §3 | idem |
| C-13 | Faixa 40–59 inexistente; sem regra de arredondamento, confiança, base zero | manual §2; Lumos p4; Rio p4; JSON | faixas e regras |
| C-14 | Concorrentes sem região/equivalência/fonte | Lumos p8, Rio p8 × manual §4 | campos mínimos |
| C-15 | Fontes sem URL | Lumos p12, Rio p12 × manual §9–10 | exigir URL |
| C-16 | Prioridades: P0–P3 com prazo × impacto/esforço sem prazo; JSON só P0–P2 | manual §7 × guia p9 × PDFs × JSON | modelo de prioridade |
| C-17 | Plano 30 dias: responsáveis exigidos × ausentes | manual §7 × guia p10 × PDFs × JSON | exigir? |
| C-18 | Logo `01_Logo_Oficial_Lumos.jpg` ausente; foto de capa sem origem/licença | guia §1 × pacote | fornecer ativos |
| C-19 | Paleta/fonte: navy medido #03084C e fundo #F9F7F3, bege/sálvia/taupe × manual #071044/#F2F4F8; Arimo × DejaVu × recomendação | manual §5 × PDFs | marca/paleta/fonte final |
| C-20 | Instruções originais e configuração de ferramentas não fornecidas | LEIA-ME passo 3 | fornecer |

Defeitos visuais das referências a não reproduzir (não são conflitos): elipses no lugar de círculos (Lumos p10); títulos encostando em boxes (Lumos p6, p8); corpo/rodapé do Rio aparentemente abaixo dos mínimos do manual §5.

## 4. Pendências P1–P8 (▲ = acréscimo desta rodada)
1. Regras de pontuação por critério/subcritério e "pontos avaliados" — ausentes.
2. Cobertura, N/V, faixa 40–59, arredondamento, confiança, base zero.
3. Ordem/conteúdo das 12 páginas e regra de densidade.
4. Concorrentes: seleção, quantidade, campos mínimos; fontes com URL. ▲ Origem dos concorrentes sem grade (a GMN só os obtém pela grade paga de 49 pontos, que não entra no relatório novo).
5. Prioridades P0–P3/prazo/esforço e responsáveis.
6. Marca final (Lumos/GMN/VRA), logo, foto, rodapé §11, fonte e paleta.
7. Instruções originais + ferramentas; texto narrativo exige IA? (não há LLM no código). ▲ Alternativa sem custo: texto montado por modelos fixos a partir de DADOS_TRAVADOS + edição/aprovação do operador.
8. Autorizações futuras: chamadas Serper de teste (link → cid/placeId/fid); migration nova (depende do G5/RLS); motor de PDF; ferramenta de render. ▲ Detalhado em D-08…D-13.

## 5. Decisões técnicas novas (recomendação entre parênteses)
- D-08 Motor de PDF: pdfkit existente (recomendado: sem dependência nova, primitivas prontas) × HTML→PDF (mais próximo do WeasyPrint, dependência nova).
- D-09 Fonte: incluir Arimo (Apache 2.0) em `assets/fonts/` para fidelidade à Lumos × Inter existente. Depende de C-19.
- D-10 Execução: fila BullMQ própria `gmn-link-audit` (recomendado; reaproveita o worker e isola o payload) × síncrona.
- D-11 Ferramentas de teste visual/texto: dependência de desenvolvimento (ex.: pdfjs-dist) × renderização offline via Windows.Data.Pdf (usada na Rodada 1, fora do `npm test`). Exige autorização.
- D-12 Link curto (`maps.app.goo.gl`, `g.page`): resolver redirecionamento (rede ao Google, gratuito, com allowlist de hosts Google + `url-safety`) × exigir link longo nesta fase.
- D-13 Navegação: item com rota + ajustes mínimos no shell (recomendado) × página isolada sem shell.

## 6. Plano E0–E9
> **Nota (20/10/2026):** este plano foi revisado no `E0-CONTRATO-DE-FIDELIDADE.md` v2 (seção 11, plano em ondas). A tabela abaixo é preservada como registro da Rodada 2; em divergência, vale o E0 v2, ainda não aprovado.

Cada etapa só após aprovação da regra correspondente. Nenhuma etapa usa Serper/IA paga sem autorização explícita.

| Etapa | Entrega | Depende de | Testes/aceitação |
|---|---|---|---|
| E0 | Copiar pacote para `docs/phase6-auditoria-link/` (Node `fs.copyFile`, conferir SHA-256); `regras-aprovadas.md` com versão da metodologia | respostas a C-01…C-20, P1–P7 | hashes = manifesto; cada regra cita fonte ou decisão do usuário |
| E1 | `src/lib/link-audit/`: tipos zod de DADOS_TRAVADOS + cálculo parametrizado + validação do manual §2 | E0 | `tests/link-audit-scoring.test.ts`: avaliados ≤ peso, obtidos ≤ avaliados, soma = base, cobertura, índice, faixa, base zero, N/V (conforme decisão) |
| E2 | `maps-link.ts`: classificar link (cid / `!1s0x…:0x…` / place_id / `@lat,lng` / curto / busca / genérico); identidade só por id, nunca por nome; confirmação do operador | E0, D-12 | `tests/link-audit-maps-link.test.ts` sem rede: válidos, ambíguos, busca, hosts não-Google, IP interno, redirect para fora → erro explícito |
| E3 | Modelo de evidência: valor + status + fonte URL + data + nativo/externo; externo não prova nativo; inacessível ≠ ausente | E1 | `tests/link-audit-evidence.test.ts` |
| E4 | Coleta (após autorização): Serper `/maps` por id; `site-check.ts`; `/reviews` opcional; conteúdo = dado, nunca instrução; custo registrado por auditoria; sem fallback DataForSEO; sem grade 49 | E2, E3, autorização Serper | mocks de transporte; teste "zero chamadas em modo teste"; contador de custo |
| E5 | Snapshot DADOS_TRAVADOS com SHA-256 + versão; texto aprovado pelo operador | E1, E3 | renderer só lê o snapshot; teste de ausência de rede e de recálculo; hash muda ⇒ PDF novo |
| E6 | `supabase/proposed/004_link_audits.sql` + rollback (não aplicada; RLS alinhado ao G5); armazenamento `link-audits/<id>/`; rota `/api/link-audit/[id]/pdf` | E5, G5, autorização de migration | teste local em `supabase/proposed/local-test`; download exige operador; nenhum ponteiro em `gmn_audits` |
| E7 | UI `/auditoria-link` + item na sidebar (D-13); job próprio (D-10) | E2, E6 | `tests/middleware.test.ts` passa; links antigos funcionam em `/` e fora dela; ordem atual de `NAV_ITEMS` preservada |
| E8 | PDF 12 páginas: tema e páginas próprios (D-08, D-09), cabeçalho 02–12, rodapé §11 conforme marca | E5, C-01…C-06, C-18, C-19 | 12 págs; rodapé 02–12; textos proibidos (manual §9); matemática do índice; concorrentes ⊂ auditoria; 4 semanas; URLs; render PNG × referências (grid, margens, tipografia mínima, ocupação, nº de módulos, sobreposição) via D-11 |
| E9 | Regressão | todas | `npm test` (todas as suítes atuais), `typecheck`, `build`, prospecção ponta a ponta em demo, `db:check`, `validate:recovery` com hashes iguais, PDFs históricos intactos |

## 7. Decisões que precisam de aprovação
1. C-01…C-06: estrutura e régua visual das 12 páginas (manual × guia/PDFs).
2. C-07…C-13: fórmula de cobertura, tratamento de N/V, faixas completas, arredondamento, confiança, base zero — e regras de pontos por critério (P1).
3. C-14…C-17: concorrentes (campos, origem sem grade), URLs de fontes, modelo de prioridades e responsáveis.
4. C-18, C-19: marca final, logo, foto de capa, paleta e fonte.
5. C-20/P7: instruções originais do agente e ferramentas; texto narrativo por modelos fixos ou IA (futura).
6. D-08…D-13: motor de PDF, fonte Arimo, fila própria, ferramenta de teste visual, links curtos, navegação.
7. Autorizações futuras: Serper de teste (E4), migration/G5 (E6), dependências novas (D-08/D-11).

Primeira etapa sugerida após as respostas: **E0** (cópia verificada do pacote + `regras-aprovadas.md`), sem código.
