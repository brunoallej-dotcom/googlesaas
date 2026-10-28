# Mapa do PDF: licenciamento, decisão e como autorizar

Atualizado em 16/10/2026. Documento da Fase 3 (dossiê PDF).

## Resumo

O PDF desenha o mapa em vetor a partir de **tiles vetoriais** (dados do OpenStreetMap, esquema OpenMapTiles). A integração de rede com o OpenFreeMap está **implementada, mas desligada por padrão**. Ela só funciona com uma autorização registrada no ambiente. Sem autorização, o PDF sai com os 49 pontos reais sobre uma grade georreferenciada (sem ruas e bairros) e um aviso claro. Nada é simulado para "parecer" um mapa.

## O que as políticas dizem (conferido em 16/10/2026)

### Servidor público do OpenStreetMap (`tile.openstreetmap.org`): NÃO usado

Fonte: <https://operations.osmfoundation.org/policies/tiles/>

- Uso previsto: visualização interativa por uma pessoa.
- "Bulk download ('scrape') tiles or offer prefetch features" é proibido; uso offline não é permitido.
- A política não trata de geração de mapas estáticos no servidor, e o que descreve desencoraja a busca automática fora de visualização ativa.
- "Commercial services ... should be especially aware that access may be withdrawn at any point."
- Disponibilidade "best-effort", sem SLA.

Conclusão: não serve para gerar PDFs de clientes. Por isso o projeto **não** usa esse servidor (o dashboard da Fase 2 usa para visualização interativa, que é o uso previsto).

### OpenFreeMap (`tiles.openfreemap.org`)

Fontes: <https://openfreemap.org/>, <https://openfreemap.org/tos/>, <https://github.com/hyperknot/openfreemap>

A favor:
- "Using our public instance is completely free: there are no limits on the number of map views or requests."
- Sem cadastro, sem chave de API. O site responde "Yes" à pergunta sobre uso comercial.
- Esquema OpenMapTiles sem modificações.

Pontos que **não** autorizam, por si só, a geração automática de PDFs:
- Termos de uso: proíbem coletar dados do serviço de forma automatizada, **exceto** "offline downloads" de até 3.000 tiles ou 50 MB por download, com no máximo 4 requisições paralelas e User-Agent único.
- O README lista "static image generation" entre o que o projeto **não** oferece.
- Os termos não tratam de renderização de PDFs por serviços comerciais.
- Serviço oferecido "AS-IS", sem SLA, podendo ser descontinuado sem aviso.

Atribuição exigida em mídia impressa: **OpenFreeMap © OpenMapTiles Data from OpenStreetMap** (a parte "OpenFreeMap" é opcional, mas está incluída). Dados do mapa: © colaboradores do OpenStreetMap, licença ODbL.

## Decisão

1. **Padrão (sem autorização):** `NoBasemap`. O PDF traz os 49 pontos reais em projeção Web Mercator, grade, escala, norte e a frase "Mapa-base (ruas e bairros) não incluído nesta emissão." Não envolve terceiros.
2. **Com autorização registrada:** `OpenFreeMapProvider`, com as salvaguardas abaixo.
3. **Pasta local de tiles (`local-dir`):** lê `z/x/y.pbf` de uma pasta sua. Serve para testes e para o futuro uso de um extrato licenciado ou hospedado por você (ver "Alternativas").

Salvaguardas do `OpenFreeMapProvider` (código em `src/lib/pdf/map/basemap.ts`, com testes em `tests/pdf-basemap.test.ts`):
- User-Agent próprio em todas as requisições.
- No máximo 4 requisições paralelas.
- Teto de **16 tiles por relatório** (o zoom é reduzido para respeitar o teto) e verificação adicional no provedor.
- Cache em disco por versão do tile: gerar o mesmo relatório de novo não busca nada da rede.
- Sem pré-carregamento e sem pirâmide de níveis de zoom.
- O host do modelo de URL lido do TileJSON é validado: só `https://tiles.openfreemap.org`.
- Qualquer falha cai no modo sem mapa-base, com aviso, e **nunca derruba o PDF**.

## Como autorizar (ação sua)

1. Peça confirmação **por escrito** a `info@openfreemap.org` de que a geração automática de PDFs de relatórios (um mapa de cerca de 4 a 9 tiles por auditoria, com cache) é permitida para uso comercial.
2. Guarde a resposta e anote uma referência curta (por exemplo, `email-AAAA-MM-DD`).
3. No `.env.local` (o assistente não altera esse arquivo), defina:
   ```
   GMN_PDF_BASEMAP=openfreemap
   GMN_PDF_BASEMAP_AUTH_REF=email-AAAA-MM-DD
   ```
4. Gere um PDF e confira se o mapa-base aparece com a atribuição.

Variáveis opcionais: `GMN_PDF_TILE_CACHE_DIR` (padrão `.cache/gmn-map-tiles`) e `GMN_PDF_TILES_USER_AGENT`. As variáveis estão documentadas, comentadas, em `.env.example`.

## Alternativas compatíveis (se a autorização não vier)

| Alternativa | O que exige | Observação |
|---|---|---|
| Extrato próprio (self-host) | O OpenFreeMap publica o planeta semanalmente em Btrfs e MBTiles; é preciso um extrato da região e um conversor para `z/x/y.pbf` | Sem terceiros em tempo de execução. Aponta-se `GMN_PDF_BASEMAP=local-dir` e `GMN_PDF_TILES_DIR`. A atribuição vem de `GMN_PDF_TILES_ATTRIBUTION` |
| Provedor pago com chave | Conta comercial (por exemplo MapTiler ou Stadia) e a chave no `.env.local` | Exigiria um novo provedor atrás da mesma interface `BasemapProvider`; o renderizador não muda |
| Captura pelo navegador do usuário | Rotina no dashboard que captura o mapa interativo da Fase 2 e o envia ao servidor | Uso interativo e iniciado por uma pessoa; quebra o fluxo totalmente automático do worker, então não foi implementada |
| Sem mapa-base | Nada | É o modo padrão atual |

## Tiles de teste neste repositório

`tests/fixtures/tiles/` contém **12 tiles** (zoom 14): 6 de Anápolis/GO e 6 de Goiânia/GO (estes últimos baixados em 16/10/2026), todos **baixados manualmente, em duas ocasiões únicas**, na exceção de download offline (User-Agent único, requisições sequenciais, bem abaixo de 3.000 tiles / 50 MB, sem custo). Servem apenas aos testes automatizados e aos PDFs de validação, sem rede em tempo de execução, e provam que o desenho do mapa não depende de uma cidade específica. Não são usados para relatórios de clientes. Atribuição em `tests/fixtures/tiles/ATTRIBUTION.md`.

**Comportamento padrão de produção:** sem `GMN_PDF_BASEMAP`, todo PDF sai **sem mapa-base** (grade georreferenciada com os pontos reais). Com `GMN_PDF_BASEMAP=local-dir`, só as áreas que têm tiles na pasta ganham ruas; as demais saem sem mapa-base e com aviso.

## Pendências

- Resposta do OpenFreeMap sobre uso comercial em PDFs automáticos.
- Decisão sobre qual alternativa adotar caso a resposta seja negativa.
