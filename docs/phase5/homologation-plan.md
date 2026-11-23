# Fase 5: plano de homologação real (PARA APROVAÇÃO; NADA EXECUTADO)

Atualizado em 16/10/2026. Este documento descreve o teste de ponta a ponta com Worker, Redis, Supabase e Serper reais. **Não será executado sem a sua aprovação expressa.** Simulação (mocks) e execução real ficam registradas separadamente; hoje só existe a simulação (326+ testes) e a validação de recuperação sem custo.

## 1. Objetivo
Provar, uma vez, com dados reais, que: o Worker processa uma auditoria completa; a trava contra duplicação funciona; o estado e o histórico ficam coerentes; o PDF novo nasce privado e baixa só autenticado; nada histórico é alterado.

## 2. Pré-requisitos (todos precisam estar verdes antes de pedir a execução)
| Item | Estado em 16/10/2026 |
|---|---|
| Login real funcionando | **OK** (você entrou) |
| Cadastro público desligado | **OK** |
| `npm run validate:recovery` sem falhas | **OK** (32/32) |
| `npm run db:check` sem problemas | **OK** |
| Backup local dos PDFs históricos | **OK** (`.data/backups/…`); cópia externa **recomendada** |
| G1 (bucket privado) | PENDENTE (recomendado antes, para o PDF novo já ter cópia durável) — **Atualização 07/11/2026: G1–G4 FEITOS** (`release-checklist.md`); G5 e G6 seguem pendentes |
| Redis (Upstash) acessível | OK na última verificação (`/api/system/health`) |
| `npm run worker:prod` disponível | OK |

## 3. Empresa e escopo
- **Lead:** *<CLIENTE_G>* (`<CIDADE>`, campanha "`<PALAVRA_CHAVE>`" de 16/10/2026, `#<N>`, id `<ID_DO_LEAD>`), domínio próprio. **Nenhuma** das 5 linhas dessa empresa (uma por campanha) tem auditoria: como a trava agora casa por empresa (`place_id`), a *<CLIENTE_F>* e as demais já auditadas seriam bloqueadas, como deve ser.
- **Palavra-chave:** "`<PALAVRA_CHAVE>`". Grade 7×7 (49 pontos), passo de 500 m, zoom 15.

## 4. Chamadas e custo
| Item | Quantidade | Custo |
|---|---|---|
| Serper Maps (um ponto da grade cada) | **49** (+ até 1 repetição por ponto se houver falha pontual; `BATTLEFIELD_POINT_RETRIES`) | **~49 créditos do seu plano** (até ~98 no pior caso de repetições) |
| Serper Reviews | **0** (desligado) | 0 |
| Verificação técnica do site | 3–5 requisições HTTP ao domínio da empresa | 0 |
| LLM / DataForSEO / GBP | **0** | 0 |
| Redis (Upstash) | poucas dezenas de comandos (fila + batimento) | dentro do plano |

## 5. O que será gravado
1 linha em `gmn_audits`; 1 rodada e 49 pontos do Battlefield; payloads de Reputação, Vitrine, Rivais, Juiz, Estrategista e Revisor; 1 PDF novo em `.data/audits/` (e no bucket privado, se o G1 estiver feito). **Nada histórico é alterado** (a validação de recuperação será repetida depois e deve continuar 100%).

## 6. Procedimento
1. Conferir: `/api/system/health` (Redis OK), fila vazia (`getJobCounts`), `npm run db:check`.
2. Ligar `npm run worker:prod` (indicador do cabeçalho muda para "Operação normal").
3. Na tela, abrir a campanha salva, **Gerar Auditoria** em *<CLIENTE_G>* (um clique; o segundo clique deve ser recusado com 409).
4. Acompanhar os estados: Aguardando → Em execução → Concluída (~30–60 s esperados).
5. Baixar o PDF pela rota autenticada; conferir o mapa sem ruas, 49 pontos e a faixa de cobertura de evidências.
6. Desligar o Worker.
7. Rodar: `npm run db:check`, `npm run validate:recovery`, `npm run rls:probe`.

## 7. Critérios
**Sucesso:** status `COMPLETED`; 49 pontos válidos (ou ilegíveis declarados); PDF baixável só com sessão e **bloqueado sem sessão**; **uma única** auditoria para a empresa+palavra-chave; segunda tentativa de gerar recebe 409; `db:check` e `validate:recovery` sem falhas; as 3 auditorias históricas inalteradas; créditos consumidos dentro do previsto.
**Abortar (parar o Worker) se:** custo por ponto acima do esperado; mais de uma auditoria criada; erro repetido do Serper; qualquer divergência nas auditorias históricas.

## 8. Contenção e reversão
- Parar: Ctrl+C no Worker; a auditoria aparece como **Interrompida**; **Retomar** reaproveita o que já foi gravado (sem repetir pagamentos).
- Nada histórico é tocado; a auditoria nova pode ser mantida ou descartada manualmente depois (não há exclusão automática).
- Créditos do Serper já gastos não são reembolsáveis; por isso o teste é de **uma** empresa.

## 9. Registro
O resultado será anotado em `final-validation-report.md` como **homologação real**, com data, créditos usados, ID da auditoria, hash do PDF e saídas dos comandos de verificação.
