# Fase 5: mapa-base sustentável, sem custo e sem servidores públicos

Atualizado em 16/10/2026.

## Situação
- Padrão de produção: **sem mapa-base** (os 49 pontos reais georreferenciados, legenda e aviso). Nunca se inventa rua ou bairro.
- Servidores públicos de tiles (OpenStreetMap, OpenFreeMap) **não** são usados para gerar PDFs: as políticas deles desencorajam/proíbem coleta automatizada. A integração OpenFreeMap segue desligada e só com autorização registrada.
- Solução sustentável implementada: **`MbtilesProvider`**, que lê um arquivo `.mbtiles` local (SQLite) com `node:sqlite` (nativo do Node 22, sem dependência nova), somente leitura, sem nenhuma chamada de rede.

## Licença e atribuição
Dados do OpenStreetMap: **ODbL**; uso comercial e geração do extrato próprio são permitidos desde que se **atribua** "© OpenStreetMap contributors". O esquema OpenMapTiles exige também "© OpenMapTiles". O provedor imprime a atribuição do arquivo (metadado `attribution`) ou, na falta, `© OpenStreetMap contributors, © OpenMapTiles`. Extratos de download em massa (Geofabrik) são o caminho previsto pelo projeto OSM para esse uso. **Pendência:** revisão jurídica final das atribuições antes de distribuir PDFs a clientes.

## Como gerar o extrato (decisão e execução SUA; não foi gerado)
Requisitos: **Java 21+** (não instalado nesta máquina), ~1 a 2 GB de download do extrato e algumas dezenas de minutos de CPU.
1. Baixe o extrato regional (ex.: Centro-Oeste) em `download.geofabrik.de` (arquivo `.osm.pbf`).
2. Baixe o Planetiler (Apache-2.0) e gere: `java -jar planetiler.jar --osm-path=centro-oeste.osm.pbf --output=goias.mbtiles --maxzoom=14` (esquema OpenMapTiles, tiles vetoriais MVT).
3. Defina no `.env.local`: `GMN_PDF_BASEMAP=mbtiles` e `GMN_PDF_MBTILES_PATH=./data/basemap/goias.mbtiles`.
4. Gere um PDF de teste com `npm run pdf:regenerate -- <auditId>` (sem `--store`) e confira o mapa.

Tamanho esperado: centenas de MB a poucos GB; mantenha o arquivo fora do repositório (a pasta `data/basemap/` já está no `.gitignore`).

## Comportamento de contingência
Arquivo ausente/ilegível/inválido ⇒ status `MISCONFIGURED`, **sem mapa-base**, aviso impresso no PDF e log; o PDF continua sendo gerado com os 49 pontos. Tile ausente numa área ⇒ aquela área sai sem ruas (nunca preenchida). Coordenadas ou zoom inválidos são recusados.

## Testes
`tests/pdf-mbtiles.test.ts`: leitura TMS (linha invertida), gzip, tile ausente, atribuição com HTML removido, coordenadas inválidas, arquivo inválido, seleção por ambiente e contingência.
