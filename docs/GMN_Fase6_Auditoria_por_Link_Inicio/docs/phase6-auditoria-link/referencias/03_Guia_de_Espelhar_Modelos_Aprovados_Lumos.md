# Guia de Espelhamento dos Modelos Aprovados — Auditoria Lumos

Este arquivo orienta o GPT a reproduzir o sistema visual dos relatórios aprovados da Lumos sem copiar dados, nomes ou conclusões dos exemplos.

## 1. Hierarquia das referências

Use os arquivos desta forma:

1. `04_Referencia_Principal_Lumos_Marketing.pdf`
   - fonte visual principal;
   - define grid, densidade, hierarquia, cabeçalho, rodapé, cards, tabelas e narrativa.

2. `05_Referencia_Secundaria_Rio_Radical.pdf`
   - referência secundária;
   - mostra como adaptar o mesmo sistema para outro segmento, outra quantidade de dados e outra cobertura.

3. `02_Manual_Visual_e_Qualidade_Lumos_v2.md`
   - regras de integridade, matemática, qualidade e validação.

4. `01_Logo_Oficial_Lumos.jpg`
   - marca oficial.

Os PDFs são referências visuais, não fontes de dados da empresa auditada.

## 2. Regra de espelhamento

Espelhar significa reproduzir:

- proporções;
- organização;
- ritmo visual;
- hierarquia;
- densidade;
- linguagem dos cards;
- estilo das tabelas;
- uso de blocos azul-marinho;
- cabeçalhos e rodapés;
- narrativa de página a página.

Não significa copiar:

- textos;
- números;
- nomes;
- concorrentes;
- conclusões;
- fontes;
- datas;
- recomendações específicas.

## 3. DNA visual obrigatório

### Cabeçalho interno

Nas páginas 2 a 12:

- logotipo pequeno no canto superior esquerdo;
- nome LUMOS MARKETING ao lado;
- nome curto da seção no canto superior direito;
- linha divisória fina;
- bastante respiro, sem cabeçalho alto demais.

### Rodapé

- nome da metodologia ou aviso curto à esquerda;
- data/snapshot ao centro quando aplicável;
- número real da página à direita;
- página 2 deve mostrar 02, e a página 12 deve mostrar 12;
- nunca iniciar em 03 nem terminar em 13.

### Paleta

- azul-marinho dominante;
- branco;
- cinza muito claro;
- cinza de texto;
- pequenos acentos verde, dourado ou azul apenas para status e prioridade.

### Linguagem editorial

Cada página deve ter:

- título principal forte;
- uma tese ou leitura estratégica;
- evidências organizadas;
- conclusão visual curta.

Evitar páginas que sejam somente listas técnicas.

## 4. Mapa visual das 12 páginas

### Página 1 — Capa editorial

Espelhar a referência principal:

- faixa fotográfica ou visual na parte superior;
- bloco azul-marinho dominante;
- título em duas ou três linhas;
- subtítulo curto;
- metadados discretos no rodapé;
- sem cards flutuando para fora do grid;
- capa não deve parecer uma apresentação genérica.

### Página 2 — Resumo executivo

Usar:

- título editorial, não apenas “Resumo executivo”;
- um parágrafo de visão geral;
- quatro cards de indicadores;
- quatro cards de leitura estratégica;
- uma frase forte na parte inferior.

A página precisa responder:
- o que está forte;
- o que limita;
- qual é o risco;
- qual é a oportunidade central.

### Página 3 — Escopo e evidências

Usar:

- tabela de itens confirmados e não verificados;
- dois boxes inferiores, como “Modo da auditoria” e “Cobertura da evidência”;
- um bloco final de transparência.

Não transformar esta página em uma segunda página de pontuação.

### Página 4 — Índice Lumos

Usar:

- nota grande;
- cobertura;
- base observada;
- barras horizontais por critério;
- três cards de classificação na base;
- explicação curta da normalização.

A tabela ou gráfico deve fechar matematicamente.

### Página 5 — Fundamentos do perfil

Usar:

- três cards principais;
- checklist de categorias ou validações;
- dois boxes inferiores de consistência e ação;
- uma frase editorial forte.

### Página 6 — Posicionamento, serviços e conversão

Usar:

- grande box azul-marinho com a tese central;
- duas colunas de checklists;
- três cards: problema, impacto e ação;
- frase final em destaque.

### Página 7 — Reputação e atividade

Usar:

- três cards de status;
- checklist ou rotina recomendada;
- box azul-marinho inferior;
- temas prioritários em bloco lateral.

Quando dados nativos forem “Não verificado”, preencher com método de verificação e plano de ação, não com espaço vazio.

### Página 8 — Comparativo competitivo

Usar:

- tabela comparativa compacta;
- empresa analisada e concorrentes reais;
- leitura estratégica abaixo;
- frase editorial forte.

Somente usar concorrentes presentes e sustentados na auditoria escrita.

### Página 9 — Prioridades

Usar:

- linhas ou cards horizontais;
- etiquetas P0, P1, P2 e P3;
- impacto, esforço e prazo na lateral;
- dois boxes inferiores: alto impacto/baixa dificuldade e alto impacto/maior esforço.

### Página 10 — Plano de 30 dias

Usar:

- quatro etapas com círculos numerados;
- uma semana por bloco;
- ações específicas;
- meta do primeiro ciclo em box azul-marinho inferior.

### Página 11 — Ativos recomendados

Usar:

- três cards superiores;
- duas colunas inferiores com ideias e checklist;
- um box azul-marinho com a conclusão da página.

Adaptar os ativos ao segmento auditado.

### Página 12 — Veredito e metodologia

Usar:

- título de veredito;
- conclusão estratégica;
- dois boxes de próximos passos;
- limitações e fontes;
- frase final editorial;
- rodapé correto com página 12.

## 5. Densidade visual

Os modelos aprovados usam conteúdo compacto, mas respirado.

Regras:

- ocupar aproximadamente 65% a 85% da área útil;
- evitar metade inferior vazia;
- usar no mínimo três módulos visuais nas páginas 2 a 11;
- misturar cards, tabelas, barras e boxes;
- não usar a mesma composição em todas as páginas;
- títulos devem ser mais estratégicos que descritivos.

Exemplo melhor:

“O perfil precisa mostrar no Google a mesma força que já aparece nas redes”

Em vez de:

“Fotos, vídeos e publicações”

O título técnico pode aparecer como etiqueta de seção ou subtítulo.

## 6. Travamento dos dados

Antes de gerar o PDF, criar internamente um bloco chamado `DADOS_TRAVADOS`.

Esse bloco deve conter:

- empresa;
- cidade;
- data;
- Índice;
- classificação;
- Cobertura;
- Base Observada;
- tabela de critérios;
- status “Avaliado” ou “Não verificado”;
- concorrentes;
- fontes;
- prioridades.

Durante a geração:

- não pesquisar novamente;
- não alterar os dados travados;
- não adicionar concorrentes;
- não converter evidência externa em recurso nativo;
- não recalcular de forma diferente.

## 7. Validação comparativa

Antes de entregar, comparar visualmente o novo PDF com as duas referências e confirmar:

1. O relatório usa o mesmo sistema visual?
2. A capa possui o mesmo nível de acabamento?
3. As páginas têm densidade semelhante?
4. Há títulos editoriais fortes?
5. Cards e tabelas estão dentro do grid?
6. O rodapé está numerado corretamente?
7. A página 4 possui visual de dashboard?
8. A página 9 mostra prioridades com clareza?
9. A página 10 parece uma timeline real?
10. A página 12 possui veredito, limitações e fontes?

Se a resposta for “não” em qualquer item, refazer antes da entrega.
