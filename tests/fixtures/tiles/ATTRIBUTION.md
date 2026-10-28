# Tiles de teste (fixture)

Doze tiles vetoriais (zoom 14) baixados **manualmente, em duas ocasiões únicas**, do OpenFreeMap
(https://openfreemap.org), na exceção de "download offline" dos termos do serviço (poucos tiles, muito
abaixo de 3.000 tiles / 50 MB, User-Agent próprio, requisições sequenciais, sem custo):

- **Anápolis/GO** (6 tiles: x 5963–5964, y 8944–8946): usados nos PDFs de exemplo da auditoria real.
- **Goiânia/GO** (6 tiles: x 5949–5951, y 8962–8963), baixados em 16/10/2026: provam que o desenho do
  mapa não depende de uma cidade específica.

Usados apenas por testes automatizados e para gerar PDFs de validação, sem rede em tempo de execução.
Não são usados para gerar relatórios de clientes. A geração automática de PDFs com tiles do
OpenFreeMap fica desligada por padrão (ver `docs/fase3-pdf-mapa-licenciamento.md`).

Atribuição exigida: OpenFreeMap © OpenMapTiles Data from OpenStreetMap.
Dados do mapa: © colaboradores do OpenStreetMap, licença ODbL (https://www.openstreetmap.org/copyright).
Esquema: OpenMapTiles (https://www.openmaptiles.org).
