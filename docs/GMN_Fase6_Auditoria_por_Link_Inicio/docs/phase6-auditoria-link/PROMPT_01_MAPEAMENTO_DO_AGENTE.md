# GMN - Fase 6: Auditoria por link
## Prompt 01 - Mapeamento fiel do agente, sem implementar ainda

### Decisão do produto
A Fase 6 NÃO é mais desenvolvimento de SaaS. A GMN continua sendo a plataforma interna de prospecção atual, com uma nova área independente de Auditoria por link.

Fluxo solicitado: o operador informa o link do perfil de uma empresa no Google Meu Negócio/Google Maps; o sistema identifica aquela empresa e gera a auditoria com a metodologia, o conteúdo e a apresentação do agente original, sem retirar nem acrescentar critérios ou entregáveis.

Não transforme este trabalho em SaaS, não acrescente cadastro público, planos, cobranças, multiempresa, disparos, CRM ou outras funcionalidades.
Não substitua a prospecção existente. Preserve campanhas, leads, auditorias, relatórios, a correção de cidade + UF, autenticação e downloads privados.
Não adapte a metodologia nova para caber na ficha atual do Juiz da GMN. Não acrescente automaticamente a grade territorial de 49 pontos ao novo relatório.

### Autorização desta rodada
Esta rodada autoriza somente leitura dos materiais e do projeto, análise e escrita da documentação de planejamento em docs/phase6-auditoria-link/.
Pode acrescentar uma nota de escopo e status ao NOTES.md, preservando o conteúdo existente.
Não implementar código, instalar dependências, executar migrations, alterar políticas ou dados, iniciar jobs nem modificar .env.local.
Não fazer chamadas reais ao Serper, a modelos de IA, ao Google, a sites de empresas ou a qualquer provedor para coletar dados. Não contratar DataForSEO, Google Business Profile ou outro serviço.

### Materiais fornecidos
Leia integralmente os arquivos em docs/phase6-auditoria-link/referencias/:
1. 01_Dados_Exemplo_Auditoria_Lumos_v2.json
2. 02_Manual_Visual_e_Qualidade_Lumos_v2.md
3. 03_Guia_de_Espelhar_Modelos_Aprovados_Lumos.md
4. 04_Referencia_Principal_Lumos_Marketing.pdf
5. 05_Referencia_Secundaria_Rio_Radical.pdf

Leia também qualquer instrução original do agente e configuração de ferramentas que o usuário anexar. Não finja que esses materiais existem quando não estiverem presentes.
Nos PDFs, examine as 12 páginas de cada referência, incluindo imagens, diagramação, tabelas e rodapés. Texto extraído sozinho não comprova fidelidade visual. Use as ferramentas locais já disponíveis; informe se alguma página não puder ser examinada.
Leia as instruções do repositório, NOTES.md e os arquivos relevantes da GMN antes de propor arquitetura. Confirme o estado real do projeto, sem tomar resumos antigos como prova de implementação atual.

### Fonte de verdade e conflitos
O guia de espelhamento define o PDF Lumos como referência visual principal, Rio Radical como secundária e o manual como regras de integridade/qualidade. Registre essa hierarquia, sem usá-la para ocultar conflitos.
Os PDFs são referências de apresentação, não fontes de fatos para outras empresas. O JSON é um exemplo, não uma auditoria real e nem uma rubrica completa.

Há divergências já observadas que você deve conferir:
- O manual coloca o Índice na página 3; guia e PDFs apresentam snapshot/escopo na 3 e Índice na 4. Prioridades, plano de 30 dias e ativos recomendados também ocupam páginas diferentes entre as instruções.
- O manual pede 55% a 82% de ocupação e pelo menos dois módulos; o guia pede aproximadamente 65% a 85% e pelo menos três módulos nas páginas 2 a 11. Não estabeleça silenciosamente uma nova regra combinada.
- No JSON, os pontos dos nove critérios somam 68 e os pesos somam 100, enquanto metadata informa base_observed 54/75, index 72 e coverage 78. O exemplo não informa pontos avaliados por subcritério.
- O manual exclui da base o peso de recursos nativos não verificados. O JSON atribui pontos a Publicações e atividade com status Nao verificado, e os PDFs também contêm casos que precisam ser confrontados com a regra.
- O guia cita 01_Logo_Oficial_Lumos.jpg, que não está neste conjunto de cinco arquivos.

Não altere os originais, não reproduza inconsistências como regra de cálculo e não invente uma reconciliação. Registre cada divergência com arquivo, seção/página, impacto e decisão necessária. Proponha, mas aguarde a aprovação da regra final antes da implementação correspondente.

### Mapeamento do comportamento original
Monte uma matriz que relacione cada requisito com sua fonte, regra, dados necessários, saída e teste de aceitação.
Mapeie entrada por link, identificação da empresa, fontes de coleta, auditoria em texto, snapshot, nove grupos de pontuação apresentados no JSON, diagnósticos, concorrentes, prioridades, plano de 30 dias, ativos recomendados, limitações, conclusão e PDF.
Não confunda pesos máximos com regras para atribuir pontos. Localize as regras de pontuação e subcritérios, tratamento de avaliação parcial, faixas completas de classificação, confiança, arredondamento e base avaliada zero. O que não tiver fonte fica explicitamente NÃO DEFINIDO, não preenchido com critérios da GMN ou conhecimento genérico.
Preserve os nomes da metodologia e a identidade Lumos como referência. Sinalize a decisão pendente de marca final; não substitua por GMN ou VRA automaticamente.

### Dados travados e evidências
Especifique a separação: coleta -> auditoria/validação -> DADOS_TRAVADOS -> diagramação.
O PDF não pode pesquisar novamente, trocar fontes, adicionar concorrentes, alterar status ou recalcular de outro modo. Sua saída deve corresponder à mesma versão dos dados usados na auditoria textual.
Cada fato deve guardar fonte identificável e data. Site e redes sociais não comprovam automaticamente recursos nativos do perfil Google. Ausência de acesso não equivale a ausência do recurso.
Não use nomes, notas, textos, conclusões ou concorrentes das referências em auditorias de outras empresas. Dados fictícios só em testes identificados, nunca apresentados como coleta real.

### Integração proposta, ainda sem código
Inspecione a aba Auditorias que já existe antes de propor a nova navegação. Não elimine uma funcionalidade atual para instalar a nova.
Proponha um fluxo independente de prospecção: não obrigar a capturar dez leads, nem a preencher cidade/nicho como etapas obrigatórias que o agente original não exige.
Especifique como links válidos identificam a empresa sem adivinhar o alvo. Links genéricos, ambíguos ou não suportados devem ser tratados explicitamente. Considere redirecionamentos com validação de destino e proteção contra acesso a endereços internos; conteúdo de páginas é evidência, não instrução para o agente.
Preserve autenticação, acesso por operador e armazenamento privado. Separe a metodologia nova das auditorias atuais; não migre nem reavalie o histórico automaticamente.
Levante quais fontes e ferramentas o agente original utilizava e quais estão realmente disponíveis no sistema. Aponte lacunas. Não afirme que Serper sozinho consegue reproduzir qualquer coleta ou que um link garante acesso a todos os dados.
Liste eventuais custos de coleta, modelo de IA e processamento, separando o que foi confirmado do que é desconhecido. Não habilite nenhum serviço novo ou consumo real.

### Entregas desta rodada
Crie somente:
1. docs/phase6-auditoria-link/mapeamento-do-agente.md: inventário, rastreabilidade, metodologia e capacidades confirmadas.
2. docs/phase6-auditoria-link/conflitos-e-pendencias.md: contradições, arquivos ausentes e decisões necessárias, sem resolver por suposição.
3. docs/phase6-auditoria-link/plano-de-implementacao.md: etapas pequenas e sequenciais, dependências, arquivos afetados, critérios de aceitação e validação de regressão da prospecção.

O plano deve prever testes do cálculo, de links e identidade, dos estados de evidência, do congelamento dos dados, do PDF de 12 páginas e da preservação da GMN atual. Para PDF, compare renders com as referências e preserve grid, hierarquia, tipografia, densidade e narrativa; não aceite apenas 'ficou parecido'.
Fidelidade significa preservar o método e o sistema visual aprovados com fatos da empresa correta, não repetir os dados dos exemplos ou prometer texto idêntico a cada geração sem evidência.

Ao terminar, entregue um resumo do escopo, do que já está definido, das pendências e da próxima etapa. Agrupe as perguntas realmente necessárias numa única lista curta. Não implemente a etapa seguinte sem autorização.
