# Onda 6C — Runbook de CHAVES (prova de origem e prova de coleta)

> **Status:** procedimento documentado e **verificado por testes** (`tests/link-audit-origin-keys.test.ts`, `tests/link-audit-evidence-provenance.test.ts`). **Nada foi executado na VPS.** Este documento **nunca** contém valores reais: onde há valor, há `<placeholder>`. Quem executa gera o segredo na hora, **sem imprimir na tela nem registrar em histórico de shell**.

## 0. Duas famílias de chave (não confundir)

| | **Chave de ORIGEM** (HMAC-SHA-256) | **Chave de ATESTAÇÃO de coleta** (Ed25519) |
|---|---|---|
| Para quê | O servidor comprova que **ele** gravou uma decisão/um resultado pendente | Quem tem a chave privada atesta que as **evidências** vieram da coleta |
| Tipo | **Segredo** simétrico, só no processo **web** | Par **assimétrico**: a **privada** fica **fora da VPS**; o web só tem a **pública** |
| Variável | `GMN_LINK_AUDIT_ORIGIN_KEY` (+ `…_RETIRED_KEYS`, `…_REVOKED_KEY_IDS`) | `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` (só públicas) |
| Comprometida ⇒ | Quem tem a chave **e** escrita numa pasta volta ao cenário do MAJOR-1 (forja de pendência) | Quem tem a privada atesta o que quiser (falsifica a coleta) |
| Verifica na leitura de confirmados? | **Não** (só na conclusão de pendente) | **Sim**, a cada prévia/finalização |

## 1. Formato exigido da chave de ORIGEM

- Variável `GMN_LINK_AUDIT_ORIGIN_KEY` = `<id>:<64 hexadecimais minúsculos>`.
- **Material:** exatamente 32 bytes de um **CSPRNG**, em 64 hex minúsculos. Gerar assim (o valor **não** deve aparecer na tela): `openssl rand -hex 32` redirecionado direto ao destino do segredo (por exemplo, `docker secret create`).
- **Rejeitados pelo servidor (as escritas respondem 503 e nada é gravado):** senha humana; tamanho diferente de 64; maiúsculas; base64; espaço ou quebra de linha (inclusive `\r\n`); material degenerado (repetição de bloco curto, progressão `00 01 02…`, menos de 16 bytes distintos). O filtro é só **sanidade**: ele **não prova entropia**; a geração correta é de quem provisiona.
- **Identificador (`<id>`):** rótulo **público**, `[a-z0-9][a-z0-9-]{3,31}`, escolhido por quem provisiona e **independente do segredo** (por exemplo `ok-2026-11-a`). Ele é gravado em cada arquivo; **nada nele permite testar palpites do segredo offline**.
- **Segredo por arquivo:** hoje a leitura é por variável de ambiente. Na implantação, o `docker-entrypoint.sh` converte `*_FILE` em variáveis a partir de uma **lista fixa**; incluir `GMN_LINK_AUDIT_ORIGIN_KEY` nessa lista e o `docker secret` correspondente no `stack.yml` é uma **alteração de implantação ainda NÃO feita** (ver `deploy/hostinger/PROVA-DE-ORIGEM-E-DE-COLETA.md`).

## 2. ROTAÇÃO PLANEJADA da chave de origem (a antiga **não** foi comprometida)

Objetivo: trocar a chave **sem perder** pendências legítimas assinadas pela antiga.
1. Gerar a chave nova com `<id-novo>` diferente (nunca reutilizar um id).
2. Antes de trocar, **concluir (nunca mover)** as pendências em andamento (a tela lista as pendentes; o autor com origem comprovada conclui).
3. Configurar: `GMN_LINK_AUDIT_ORIGIN_KEY=<id-novo>:<material-novo>` e `GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS=<id-antigo>:<material-antigo>:<AAAA-MM-DD>` — a antiga **só verifica** (nunca assina) e **só até o fim do dia UTC** indicado. A data tem **teto de 93 dias** a partir de hoje (acima disso a configuração é recusada: uma aposentada "para sempre" seria uma segunda chave de assinatura) e um relógio inválido a trata como **vencida**. Escolher a data mais curta possível.
4. Reiniciar o web. Conferir: novas gravações saem com `kid = <id-novo>`; pendências antigas ainda concluem até a data.
5. Passada a data, a antiga vira `KEY_EXPIRED` (falha **explícita**): remover `…_RETIRED_KEYS` e **destruir** o material antigo.
- **Impacto sobre registros:** os **confirmados** continuam legíveis e válidos (não são reverificados na leitura). Pendências assinadas pela antiga e não concluídas até a data ficam **EM DÚVIDA** (não vigentes, não concluíveis): **conclua-as antes da data**. As de **criação simples** podem ir à quarentena; as de **revogação/substituição NUNCA** (restaure o recibo do backup independente — §6).

## 3. ROTAÇÃO POR COMPROMETIMENTO da chave de origem (a antiga **vazou**)

Objetivo: **cortar imediatamente** o uso da chave vazada para novas autenticações **e** para recuperações.
1. Gerar a chave nova e um `<id-novo>`.
2. Configurar: `GMN_LINK_AUDIT_ORIGIN_KEY=<id-novo>:<material-novo>`; **remover por completo** o material da chave vazada (**não** colocar em `…_RETIRED_KEYS`; a variável antiga `…_PREVIOUS` **não existe mais** e é ignorada); `GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS=<id-vazado>` (só o **id**, nunca o material).
3. Reiniciar. Manter o material do id revogado na configuração é **erro de configuração**: o servidor recusa (503) em vez de aceitar a chave vazada.
4. Efeito verificado por teste: etiquetas do id revogado dão `KEY_REVOKED` — **nenhuma pendência assinada por ela é concluída**, inclusive as **legítimas** (custo declarado).
5. **Apuração** das pendências afetadas (`onda6b-decisoes-humanas.md` §15 item 3): **não** mova pendência de **revogação/substituição** (ela continua sendo uma revogação mesmo com a etiqueta `KEY_REVOKED`) **nem resultado pendente**; só as de **criação simples** podem ir à quarentena. Compare o `head` guardado fora do servidor, os backups e os resultados confirmados para decidir o que foi legítimo e restaure o **par** do backup independente. Sem backup e com chave comprometida, a pendência fica **EM DÚVIDA** (a decisão alvo nunca vigente) — é deliberado.
- **Registros antigos NÃO voltam a ser confiáveis por serem reassinados.** Não existe, e não deve existir, ferramenta que reassine arquivos: uma etiqueta nova só atestaria que o servidor **de hoje** os viu, **sem fonte independente** (teste: "reassinar não torna confiável"). Qualquer reabilitação exige fonte independente (backup anterior ao incidente, testemunha externa) e decisão humana registrada, **fora do sistema**.
- **Confirmados** assinados pela chave vazada: o servidor não os reverifica na leitura; o recibo e o encadeamento continuam sendo a proteção. Se houver suspeita de que o atacante escreveu **duas** pastas, tratar como incidente (restaurar pares do mesmo instante a partir do backup).

## 4. Chave de ATESTAÇÃO de coleta (pública no servidor)

- **Formato no servidor:** `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS=<id>:<32 bytes da chave pública Ed25519 em base64url>[,<id>:<…>]`. É **pública** (não é segredo). Item malformado, id repetido ou lista vazia ⇒ política **FECHADA** (nada é autêntico).
- **Custódia da privada:** fora da VPS, protegida (senha/cartão/HSM), com backup cifrado separado. O servidor web **nunca** a recebe. (Decisão de custódia pendente do responsável: ADR 6C-03 §7.)
- **Rotação planejada:** adicionar a pública nova à lista (com id novo), atestar as auditorias com a nova, e só então remover a antiga. Manifestos assinados pela antiga continuam válidos **enquanto** a pública dela estiver na lista.
- **Comprometimento da privada:** **remover imediatamente** a pública comprometida da lista (isso torna **toda** coleta atestada só por ela **não autêntica**: a finalização fecha); gerar novo par; **reatestar** só o que for conferido por **fonte independente**. Manifestos não se "revogam" um a um: a confiança vem da **lista de chaves**.
- **Efeito sobre registros históricos:** resultados **já confirmados** não são reavaliados; novas prévias/finalizações dependem do manifesto válido.

## 5. O que o sistema NÃO faz (para ninguém supor)

- Não tem ferramenta de reassinatura.
- Não reverifica a origem de **registros confirmados** na leitura (somente de pendentes, ao concluir).
- Não rotaciona sozinho nem avisa expiração: o monitoramento externo ainda não existe (checklist de produção).
- Não distingue "gravação interrompida" de "recibo removido" sem a testemunha do `decisionsHead` (e ela só existe se houve resultado depois).

## 6. Rotação e testemunha do histórico (4ª revisão, R4-MINOR-1 — **corrigido** em 01/11/2026)
Depois de uma rotação, um resultado **pendente** (sem recibo) assinado pela chave antiga **não é mais testemunha** quando a origem dele já não é comprovada (aposentada **vencida**, **revogada**, desconhecida, ou servidor sem autenticador). Ele passa a ser um **indício**, e o sistema **não o esquece**:
- se o que o indício afirma **confere** com o histórico de decisões de hoje, é ignorado;
- se **contradiz** (uma posição que hoje falta, ou outra entrada), a testemunha é `UNTRUSTED` ⇒ **`DECISIONS_HISTORY_UNRESOLVED`**: nenhuma decisão vigente, nenhuma escrita, nada finalizável. **Nunca** se usa a chave comprometida para tornar a pendência confiável; reassinar não adianta.
- dentro da validade de uma aposentada (rotação **planejada**), a pendente continua **testemunha** (`PROVEN`).

**Procedimento (humano, fora do sistema):** (1) antes de rotacionar, **conclua** (nunca mova) as pendências de decisão e de resultado; (2) ao ver `UNTRUSTED`/`HISTORY_*`, **não** mova arquivos de decisão **nem o resultado pendente** para a quarentena: isso apaga o indício e, se ele era real, reabre a janela sem testemunha (ADR 6C-02 §4.5, **BLOQUEADOR**); e **nunca** mova pendência de **revogação/substituição**, qualquer que seja a origem — inclusive `KEY_REVOKED`/`KEY_EXPIRED`, que ao ver só o estado `UNWITNESSED` parece "inofensiva"; (2b) **finalize logo depois de revogar/substituir** — o próximo resultado selado é o que fecha a janela da revogação — **quando a finalização estiver habilitada (hoje fechada por desenho até existir o produtor da prova de coleta, P1)**; (3) confira as cabeças contra o **backup/relatório independente** e restaure o **par** do mesmo instante; (4) só então reative. A tela não oferece botão que contorne isso.
