# Fase 5: checklist de liberação para uso interno

Legenda: **APROVADO** (feito e verificado), **PENDENTE** (depende de você/autorização), **BLOQUEADO** (depende de infraestrutura que não existe agora).

## Antes de usar no dia a dia
| Item | Estado | Quem |
|---|---|---|
| Desligar "Allow new users to sign up" no Supabase | **APROVADO** | Você (conferido) |
| Criar usuário(s) operador(es) no Supabase Auth | **APROVADO** | Você |
| `GMN_OPERATOR_EMAILS` no `.env.local` | **APROVADO** | Você |
| Primeiro login real | **APROVADO** | Você |
| Backup local dos PDFs históricos | **APROVADO** | Feito; copie para fora desta máquina |
| Rodar `rls-audit.sql` no SQL Editor e enviar o resultado | PENDENTE | Você |
| Iniciar `npm run worker:prod` quando for auditar | — | Operação |
| Criar bucket privado e `SUPABASE_PRIVATE_AUDIT_BUCKET` (opcional) | PENDENTE | Você |
| G1: bucket privado e cópia dos PDFs históricos | **APROVADO** | Executado e verificado em 16/10/2026 |
| G2: fechar o bucket público antigo | **APROVADO** | Executado e verificado em 16/10/2026 |
| G3: ponteiros dos 3 históricos no banco | **APROVADO** | Executado e verificado em 16/10/2026 |
| G4: originais de `public/audits` | **APROVADO** | Removidos e verificados em 17/10/2026 |
| Aplicar `003_rls_hardening.sql` (G5) | PENDENTE | Aguarda auditoria + autorização |
| Homologação real (G6) | PENDENTE | Plano em `homologation-plan.md` |
| Gerar extrato MBTiles (Java + download) | BLOQUEADO | Decisão/infra |
| Revisão jurídica das atribuições do mapa | PENDENTE | Você |

## Teste operacional real: PROPOSTA (não executado, aguarda sua aprovação)
- **Quando liberar:** depois dos 4 primeiros itens acima (login funcionando) e do Worker ligado.
- **Empresa:** *<CLIENTE_G>* (#16, campanha Anápolis / Clínica Odontológica de 16/10/2026, nenhuma auditoria). A *<CLIENTE_F>* seria bloqueada pela idempotência. Plano completo: `homologation-plan.md`.
- **Chamadas externas:** **49** consultas Serper Maps (grade 7×7, passo 500 m) + verificação técnica do site (HTTP público, gratuita). Reviews do Serper **desligado**. Sem LLM pago, sem DataForSEO.
- **Custo:** 49 créditos do plano atual do Serper (valor em reais conforme seu plano).
- **O que será gravado:** 1 linha em `gmn_audits`, 1 rodada e 49 pontos do Battlefield, payloads de Reputação/Vitrine/Rivais/Juiz/Estrategista/Revisor, 1 PDF novo em `.data/audits/` (e no bucket privado, se configurado). Nada histórico é alterado.
- **Riscos e mitigação:** duplicação ⇒ trava + 409 + `claimAudit` + `maxStalledCount: 0`; Worker cair no meio ⇒ estado Interrompida e **Retomar** sem repetir consultas; Redis fora ⇒ 503 antes de gravar.
- **Critério de sucesso:** status `COMPLETED`, 49 pontos válidos (ou ilegíveis explícitos), PDF baixável só autenticado e com mapa sem ruas, **uma única** auditoria para o lead, `npm run db:check` sem problemas, nenhuma linha órfã.
- **Contenção:** Ctrl+C no Worker; a auditoria aparece como Interrompida; nada é repetido automaticamente.
- **Registro:** o resultado será anotado em `final-validation-report.md` como **homologação real**, separada da simulação com mocks.

## Verificações técnicas
| Item | Estado |
|---|---|
| `npm test` 343/343 | APROVADO |
| `npm run typecheck` | APROVADO |
| `npm run build` | APROVADO |
| `.env.local` com hash idêntico | APROVADO |
| Acesso sem sessão bloqueado (HTTP real) | APROVADO |
| `npm audit` (9 avisos de toolchain, sem atualização) | APROVADO COM RESSALVA (risco aceito, ver `security-review.md`) |
