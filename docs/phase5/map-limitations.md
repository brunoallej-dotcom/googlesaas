# Fase 5: limitações da renderização cartográfica

Atualizado em 16/10/2026. Nada foi instalado e nenhum extrato foi baixado (decisão do usuário). O funcionamento atual foi preservado.

## Como funciona hoje
| Superfície | Mapa-base | Cobertura | Observações |
|---|---|---|---|
| **Tela** (Campo de Batalha, Leaflet) | OpenStreetMap público (`tile.openstreetmap.org`) | **Qualquer cidade** | Uso interativo e leve, com atribuição visível. Depende da política de uso do OSM (User-Agent/Referer do navegador). Se o OSM bloquear, os 49 marcadores continuam, sem ruas |
| **PDF** (padrão) | **Nenhum** | Qualquer cidade | Grade georreferenciada com os 49 pontos reais, legenda e o aviso "Mapa-base (ruas e bairros) não incluído nesta emissão". **Nunca se inventam ruas** |
| **PDF com mapa** (`GMN_PDF_BASEMAP=local-dir`) | Tiles locais de teste | **Só Anápolis e Goiânia** (6 tiles cada, zoom 14) | Fixtures de teste com atribuição; não é solução de produção |
| **PDF com mapa** (`mbtiles`) | Extrato próprio do OSM | Região do extrato | Provedor pronto e testado; **falta gerar o `.mbtiles`** (exige Java e ~1–2 GB de download, não feitos) |
| OpenFreeMap (rede) | — | — | **Desligado**: exige autorização escrita do provedor |

## Para outras cidades (ex.: Goiânia sem tiles de teste, Brasília, São Paulo)
- O PDF sai **sem mapa-base**, com os 49 pontos e o aviso impresso. Isso é correto, não é um defeito.
- Zoom da tela e posições dos marcadores não dependem do mapa-base.

## Limitações conhecidas
1. A tela depende de um servidor público de terceiros para o fundo do mapa; indisponibilidade ou bloqueio remove o fundo, não os dados.
2. **Regressão corrigida nesta rodada:** o cabeçalho `Referrer-Policy: no-referrer` (introduzido na Fase 5) fazia o OSM devolver o tile "403 Access blocked" no navegador. Agora é `strict-origin-when-cross-origin`; há teste que impede a volta e a verificação em navegador mostrou 12/12 tiles carregados.
3. PDF com ruas fora de Anápolis/Goiânia exige o extrato MBTiles (decisão e infraestrutura sua) e revisão jurídica das atribuições (ODbL + OpenMapTiles).
4. Zoom máximo do PDF: 14 (tamanho de tile/área); ruas pequenas podem não aparecer.
5. Sem rotas, endereços pesquisáveis ou geocodificação reversa: não fazem parte do produto.

## Evolução (sem custo recorrente, quando você decidir)
Instalar Java → baixar o extrato regional (Geofabrik, ODbL) → gerar `.mbtiles` com o Planetiler → `GMN_PDF_BASEMAP=mbtiles` (ver `basemap-mbtiles.md`).
