# P1 — Livro de manifestos (formato e conferência periódica)

> **Status:** formato definido na fatia **W5.1** (22/11/2026). Fonte: spec `docs/specs/link-audit-p1-attestation.md` §9 (livro e
> conferência como procedimento humano, RS-17; comando automático **não** adotado, §2), contrato do verificador `v2` §6 (as
> cabeças do fecho vêm do registro externo) e decisões D12, D15.2, D15.3 e D15.6(b).
>
> **Este arquivo é só o formato.** O livro preenchido fica **offline**, cifrado, junto dos dossiês, e nunca entra no repositório
> (público). Nomes reais e locais físicos aparecem só nele e no dossiê (spec §13.4).

## 0. Para que serve

1. **Registro externo da cadeia:** é de onde sai o `--expect-seq` do `sign` (nunca da pasta) e, com a pasta de recibos, as
   cabeças do fecho de aposentadoria (`close-key`). Se a pasta de manifestos do servidor perder, ganhar ou trocar um arquivo, o
   livro mostra.
2. **Controle humano de quem edita a lista de chaves**, que está fora da garantia (contrato do verificador `v2` §1): o livro
   guarda a lista esperada, e a conferência periódica a compara com a do servidor.
3. **Registro dos atos que o código não vê:** versões do Node, testes de restauração, revisões amostrais, destruição de chaves,
   incidentes.

Uma linha por evento, só acrescentada (nunca apagada nem reescrita; correção = linha nova que cita a anterior). Datas em UTC.

## 1. Chaves

| keyId | pública (base64url) | estado na lista | gerada em | cerimônia (dossiê) | cópias (`<MIDIA_1>`, `<MIDIA_2>`; locais só no dossiê) | `sha256sum` do arquivo cifrado | fecho fixado (`closureSha256`) | aposentada/revogada em | destruída em |
|---|---|---|---|---|---|---|---|---|---|
| `<KEY_ID>` | `<PUBLICA>` | `active` / `retired:<hash>` / `revoked` | `<DATA>` | `<ID_DO_DOSSIE>` | `<MIDIA_1>`, `<MIDIA_2>` | `<SHA256>` | `<HASH ou —>` | `<DATA ou —>` | `<DATA ou —>` |

A lista esperada do servidor é a concatenação dos itens desta tabela, na forma do `onda6c-runbook-chaves.md` §4. Itens
aposentados e revogados **permanecem** (teto de 16).

## 2. Manifestos assinados

Uma linha por `sign` com sucesso (cópia do recibo do passo 16 e o que veio depois):

| data | auditId | seq | keyId | sealSha256 | prevSealSha256 | `sha256sum` do arquivo entregue | packageSha256 | dossierSha256 | custodiante | approvedBy / operador | roleException | requiresLaterReview | node (`--version`) | artifactSha256 | entrega (id da execução do CI) | verificação pós-entrega |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<DATA>` | `<AUDITORIA>` | `<N>` | `<KEY_ID>` | `<HASH>` | `<HASH ou null>` | `<HASH>` | `<HASH>` | `<HASH>` | `CUST-01` | `<…>` / `<…>` | `<true/false>` | `<true/false>` | `<v22.x.y>` | `<HASH>` | `<ID>` | `<AUTHENTICATED / data>` |

O **próximo `--expect-seq`** de uma auditoria é o maior `seq` desta tabela para ela, mais 1 (`1` com `--first` se não houver
linha). O `sealSha256` (forma canônica) vem do recibo; o `sha256sum` do arquivo serve para a conferência sem ferramenta do §5,
porque a entrega é byte a byte.

## 3. Sessões de assinatura (D15.3)

| data | estação (rótulo) | E1–E8 do runbook do custodiante conferidos | `<NODE22> --version` | hash do artefato (`sha256sum -c` OK) | commit do artefato | sem rede conferido | manifestos assinados | observações |
|---|---|---|---|---|---|---|---|---|

## 4. Revisões amostrais trimestrais (D15.6(b))

Uma vez por trimestre: sortear **um dossiê ou 10 % dos dossiês do trimestre, o que for maior** (arredondando para cima), com
todos os de `requiresLaterReview: true` no universo do sorteio. O sorteio é registrado (método e resultado) para não ser
escolha de conveniência. Para cada dossiê sorteado, refazer a conferência do `p1-runbook-conferente.md` §2–§3 sobre os mesmos
bytes arquivados e comparar com o que foi registrado.

| trimestre | universo (n dossiês) | amostra (n) | método do sorteio | dossiês revisados (id) | revisor (rótulo) | revisor ≠ custodiante? | achados | ação |
|---|---|---|---|---|---|---|---|---|
| `<AAAA-Tn>` | `<n>` | `<max(1, ⌈n/10⌉)>` | `<…>` | `<ids>` | `<…>` | **não — titular, marcado** (enquanto não houver segunda pessoa) | `<…>` | `<…>` |

## 5. Conferência periódica contra o servidor (RS-17)

**Quando:** antes de cada sessão de assinatura (o runbook do custodiante, §7, exige a cópia conferida) e no mínimo uma vez por
trimestre, junto da revisão amostral. **Como:** sobre uma cópia somente leitura da pasta de manifestos do servidor e da lista
de chaves em uso:

1. para cada auditoria do livro, o `seal-NNNN.json` de maior `seq` existe no servidor e o `sha256sum` dele é igual ao anotado
   (§2);
2. nenhum manifesto no servidor ausente do livro (posição desconhecida: incidente; numa aposentadoria, é o que o `close-key` lista
   como `UNKNOWN_SEAL_ON_SERVER`);
3. nenhum manifesto do livro ausente do servidor (apagado ou recuado: incidente; a reversão a um estado antigo autêntico é
   atualidade, não autenticidade, e só o livro a mostra);
4. cada `_closures/<R>.json` com `sha256sum` igual ao `closureSha256` fixado (§1);
5. a lista de chaves do servidor igual à esperada (§1), item a item, inclusive estados e hashes de fecho.

| data | escopo (auditorias, fechos, lista) | divergências | ação / incidente | quem (rótulo) |
|---|---|---|---|---|

Divergência nunca se "corrige" no servidor à mão: vira incidente, com a decisão do responsável registrada.

## 6. Testes de restauração da chave (D15.2)

Na cerimônia da chave real e a cada 6 meses (procedimento no runbook do custodiante, §5):

| data | keyId | mídia | `sha256sum` igual | perfil do KDF conferido (§4.4) | frase abriu e pública igual à da lista | quem (rótulo) | observações |
|---|---|---|---|---|---|---|---|

## 7. Destruição de chaves

Chaves de ensaio (no fim de cada ensaio) e chaves reais aposentadas (depois do fecho fixado) ou revogadas:

| data | keyId | tipo (ensaio / real aposentada / real revogada) | cópias destruídas (estação, `<MIDIA_1>`, `<MIDIA_2>`) | método | estado na lista depois | frase destruída | quem (rótulo) |
|---|---|---|---|---|---|---|---|

## 8. Incidentes

| data | tipo (`SIGN_WRITE_UNCONFIRMED`, divergência do §5, perda de mídia, suspeita de comprometimento…) | o que se viu | o que foi preservado | decisão (quem) | encerramento |
|---|---|---|---|---|---|

Suspeita de comprometimento da chave: `revoked` na hora (`onda6c-runbook-chaves.md` §4), sem esperar a apuração.
