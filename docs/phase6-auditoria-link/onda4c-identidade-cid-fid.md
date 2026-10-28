# Fase 6 · Onda 4C — Identidade CID/FID offline e plano da consulta Serper `/maps`

Status: implementada em 21/10/2026. **Nenhuma chamada ao Serper, nenhum crédito consumido, LIVE não executado, `.env.local` não lido nem alterado.** Metodologia: reconstrução `lumos-reconstruida-v1`; D3, D4, D5 pendentes.

## Problema
O link da TUVAPLAST COMÉRCIO traz só `fid = 0x0:0x3a3245f75b61e57e`. O coletor comparava o `fid` como texto exato; o prefixo `0x0` nunca bateria com o prefixo real devolvido pelo Serper, então a empresa não seria confirmada mesmo se aparecesse nos resultados.

## O que mudou
- **`src/lib/link-audit/identifiers.ts` (novo, puro, só BigInt):** `normalizeCid` (só dígitos ASCII, 1–20, `0 < valor ≤ 2^64−1`, zeros à esquerda removidos), `featureIdParts`, `deriveCidFromFeatureId` (2ª metade hexadecimal → decimal; o FID original não é alterado), `buildExpectedIdentity` (CID do link ou **derivado**, com a origem; `cid` e `fid` incompatíveis no link = conflito), `placeEntityCid` (CID de um resultado: `cid` informado e/ou derivado do `fid` dele; se discordam, o resultado é contraditório).
- **Casamento (`collector/maps-place.ts`):** a chave é o CID (BigInt). Prefixos diferentes do FID são equivalentes quando a 2ª metade é igual; `placeId` só casa por igualdade exata e **nunca é derivado**; contradição (CID, placeId ou o próprio resultado) ⇒ `AMBIGUOUS`; dois negócios distintos ⇒ `AMBIGUOUS`; **nome nunca confirma**. Resultado sem identificador comparável ⇒ identidade não confirmada.
- **Resultado e relatório:** `identityBasis` (CID esperado + origem `LINK`/`DERIVED_FROM_FID`; por qual identificador o perfil foi aceito) e a limitação "CID derivado do FID por conversão offline; não foi retornado por nenhuma API". `CompanyIdentity`, `MapsIdentifiers`, parser, snapshot e confirmação do operador **não mudam** (o CID derivado não entra na identidade).
- **Adaptador Serper:** `MapsSearchRequest.cid` opcional; o corpo só leva `cid` se o pedido trouxer (e só se for um CID válido). O coletor **nunca** o envia: o parâmetro `cid` de **entrada** do `/maps` não está confirmado em nenhuma fonte (`IDENTIFIER_PARAMS` segue desligado). A **saída** do `/maps` traz `cid` e `fid` (240/240 objetos de respostas antigas do projeto em `.data/migration` têm `cid` = decimal da 2ª metade do `fid`, todos acima de 2^53).
- **Custo:** 3 créditos por chamada do `/maps` (valor observado por fonte independente, informado pelo usuário; **não é preço oficial**) ⇒ ≈ US$ 0,0009–0,003; ressalva "conferir no painel antes do LIVE" no plano, na estimativa e na exigência de `--ack-cost` (agora: "você conferiu saldo e créditos no painel").
- **DRY_RUN:** mostra o FID original, o CID derivado (com a origem), a requisição exata sem chave e o critério de confirmação.

## Evidências da conversão
Pares públicos conferidos: Google (Places API) `0x6b12ae665e892fdd:0x3133f8d75a1ac251` ↔ `cid=3545450935484072529`; DataForSEO `28e48b1a90ccf57e` ↔ `2946633002421908862`; TUVAPLAST `0x3a3245f75b61e57e` ↔ **4193491131727734142**.

## TUVAPLAST COMÉRCIO (DRY_RUN)
- Requisição prevista: `POST https://google.serper.dev/maps`, cabeçalhos `X-API-KEY` (não exibida) e `Content-Type: application/json`, corpo `{"q":"TUVAPLAST COMÉRCIO","gl":"br","hl":"pt-br","page":1}` (sem `ll`: o link não tem coordenadas; sem cidade/UF: não informadas).
- Critério: o perfil só é aceito se um resultado trouxer o mesmo CID (campo `cid` ou 2ª metade do `fid` do próprio resultado) ou o mesmo `placeId`; contradições recusam; sem identificador comparável = não confirmado.
- Custo máximo: 1 chamada `/maps` × 3 créditos = **3 créditos (não confirmado)**; `/reviews` = 0; site até 8 requisições HTTP, sem custo de API.
- Limite de prontidão: a busca é só por nome (sem cidade/UF/coordenadas); se o perfil não estiver entre os resultados devolvidos, o resultado é "não localizado" com a chamada já gasta.

## Mecanismos preservados
Orçamento de 1 chamada `/maps`, `/reviews` = 0, travas de ambiente do LIVE, autorização única registrada antes da chamada, regra por empresa em 24 h, SIMULATED sem provedor real, DRY_RUN sem leitura de ambiente.

## Limites
Créditos por chamada e aceitação de `cid` como entrada do `/maps` não confirmados; derivação do CID depende da convenção do Google (documentada publicamente e consistente com 240 registros do projeto); o FID pode mudar com o tempo (por isso o prefixo é ignorado), o CID é a chave.

## Verificação
`npm test` 659/659, typecheck e build ok; `npm test` com captura de sockets/DNS/`fetch` externos: 0 tentativas; DRY_RUN real offline; `.env.local` inalterado; nenhuma pasta `.data/link-audit*` criada. Revisão independente (somente leitura): sem achados graves; corrigidos (1) limitação quando o CID do resultado é derivado do `fid` dele, (2) `identityBasis.matchedBy.provenCid` expõe o CID comprovado, (3) conflito `cid`×`fid` do link recusado antes de consumir a autorização LIVE (e sem requisição no DRY_RUN), (4) identificador inválido ao lado de um que casa recusa o perfil, (5) zeros à esquerda do `cid` do link contam como comprovados. Aceito: duplicatas do mesmo negócio por chaves diferentes (cid × placeId) resultam em `AMBIGUOUS` (falha segura).

## Atualização da Onda 4D (22/10/2026)
`provenIdentifiers` passou a significar "efetivamente comparado e confirmado" e o relatório ganhou o bloco `identifiers` (link × derivado × retornado × confirmado). Ver `onda4d-pos-live-resgate.md`.
