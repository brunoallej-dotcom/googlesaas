# Pacote de reconstrução do agente — GMN Fase 6

## O que é

Reconstrução documentada das instruções do agente de auditoria a partir de:

1. `01_Dados_Exemplo_Auditoria_Lumos_v2.json`;
2. `02_Manual_Visual_e_Qualidade_Lumos_v2.md`;
3. `03_Guia_de_Espelhar_Modelos_Aprovados_Lumos.md`;
4. `04_Referencia_Principal_Lumos_Marketing.pdf`;
5. `05_Referencia_Secundaria_Rio_Radical.pdf`;
6. Decisões declaradas sobre a GMN na conversa.

O **prompt original do agente não foi recuperado**, logo não é possível garantir comportamento literalmente idêntico. A reconstrução é o documento mais fiel possível às regras **comprovadas**, com lacunas expressas.

## Arquivos entregues

- `INSTRUCOES_MESTRAS_AGENTE_AUDITORIA_GBP_v1.md`: documento principal e detalhado, com instruções do comportamento do agente e padrão de relatório;
- `INSTRUCOES_EXECUTAVEIS_AGENTE_AUDITOR_GBP_v1.md`: versão autocontida para configurar o agente ou orientar o Claude, com as ressalvas essenciais;
- `LACUNAS_E_DECISOES_DE_FIDELIDADE.md`: matemática conferida, divergências e decisões pendentes;
- `PROMPT_ENTREGA_CLAUDE_CODE_FASE6.md`: texto a colar no Claude Code após disponibilizar os arquivos;
- `LEIA_ME_PRIMEIRO.md`: este arquivo.

## Como usar

1. No Windows, extraia este ZIP em qualquer pasta de trabalho temporária.
2. Copie os **arquivos Markdown do pacote** para a pasta `docs/phase6-auditoria-link/` do projeto, **sem sobrescrever** as referências ou o diagnóstico já criado pelo Claude. O arquivo `LEIA_ME_PRIMEIRO.md` também pode ser copiado.
3. Abra o Claude Code na GMN e cole o conteúdo de `PROMPT_ENTREGA_CLAUDE_CODE_FASE6.md`.
4. Revise os bloqueios da E0 antes de autorizar pontuação automática, PDF final ou integrações pagas.

## Regra da integração

**Prospecção e auditoria são funcionalidades independentes.** A nova Auditoria por Link não usa a grade de 49 pontos e não reaproveita a pontuação de 21 critérios do Juiz atual.

## O que falta deliberadamente

- Régua exata de subpontuação e tratamento parcial;
- Faixa de classificação de 40 a 59, faixas de confiança e arredondamento completo;
- Logo e foto originais separados;
- Marca final do relatório;
- Seleção de concorrentes e integrações de coleta aprovadas.

Essas lacunas são reais nos documentos recebidos. O pacote não as preenche com regras inventadas.
