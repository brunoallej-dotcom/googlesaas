# PROMPT DE ENTREGA AO CLAUDE CODE — INSTRUÇÕES RECONSTRUÍDAS DA AUDITORIA

Recebi uma **reconstrução documental do agente de Auditoria Pública de Google Business Profile** baseada nos cinco materiais aprovados, pois o prompt original do agente não está mais disponível.

No repositório da GMN, localize e leia **integralmente** estes arquivos que vou fornecer:

- `INSTRUCOES_MESTRAS_AGENTE_AUDITORIA_GBP_v1.md`
- `INSTRUCOES_EXECUTAVEIS_AGENTE_AUDITOR_GBP_v1.md`
- `LACUNAS_E_DECISOES_DE_FIDELIDADE.md`

Leia também as cinco referências originais já presentes no projeto e:

- `docs/phase6-auditoria-link/diagnostico-e-plano.md`
- `NOTES.md`
- demais instruções existentes no repositório.

**Objetivo da rodada: somente integrar essa reconstrução ao planejamento da E0. Não implementar a aplicação ainda.**

1. Trate o documento mestre como **hipótese formal de comportamento do agente**, não como prompt original recuperado. Preserve sua separação de `DOCUMENTADO`, `RECONSTRUÇÃO OPERACIONAL` e `PENDENTE DE APROVAÇÃO`.
2. Compare os 24 itens **R-01 a R-24** do anexo com os **C-01 a C-20** já criados por você. Mantenha os IDs originais do seu diagnóstico, não sobrescreva silenciosamente conflitos e não afirme correspondência sem evidência.
3. Corrija **somente a documentação** de E0 quando necessário, preservando links de fonte, pendências reais e decisões ainda não aprovadas.
4. Confirme que os nove pesos e as fórmulas do Manual estão refletidos, e que JSON/PDFs **não são usados como exemplos numéricos canônicos quando matematicamente inconsistentes**.
5. Prepare uma **matriz proposta de pontuação por subcritério, separadamente e rotulada `PROPOSTA — NÃO APROVADA`**, caso essa régua seja necessária ao plano, sem inventar que veio do agente original. Não ative um Índice Lumos automático ainda.
6. Mostre quais funcionalidades poderão ser feitas sem essa régua (ex.: parser seguro, modelo de evidência e UI isolada), e quais devem esperar aprovação (ex.: índice público e PDF final com nota).
7. Garanta em todo o plano que a prospecção, o Juiz, o mapa de 49 pontos, campanhas, relatórios antigos, autenticação e RLS da GMN não serão afetados.
8. Para qualquer custo de Serper, nova API de IA, migração real ou dependência paga, obtenha minha autorização expressa antes de executar.
9. Rode apenas verificações locais não invasivas úteis para conferir o material, se o WSL estiver estável. Em caso de EIO/EROFS, pare e comunique.

**Entregáveis:** uma atualização do documento de E0, tabela de convergências e conflitos, até cinco decisões prioritárias que preciso aprovar, e uma recomendação objetiva da primeira wave de implementação que poderá começar depois da minha autorização.

**Não escreva código de produção, não rode migrations e não faça chamadas pagas nesta rodada.**
