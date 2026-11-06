# ADR 6C-03 — Proveniência das EVIDÊNCIAS na fronteira com o Motor Lumos (R2-MINOR-1)

> **Status:** o **lado verificador** e o **bloqueio fail-safe** estão implementados na árvore de trabalho, **sem commit**. O **lado produtor** (quem assina a coleta) **NÃO foi implementado**: ele altera o pipeline de coleta e/ou introduz um passo operacional novo e, por decisão do responsável, **é apresentado aqui como plano de compatibilidade para análise** (§7). Até esse plano ser aprovado e executado, **nenhum resultado pode ser finalizado em produção** (por desenho). Origem: 2ª revisão independente (`onda6c-revisao-adversarial-2.md`, R2-MINOR-1) e decisão do responsável de 01/11/2026.

## 1. O problema

A 2ª revisão mostrou (RV2-F1) que quem escreve **somente** na pasta de evidências, usando o próprio pipeline de gravação (selo SHA-256 refeito, integridade "OK"), consegue que **fatos fabricados** (nome, telefone, endereço) cheguem ao mapeador e ao Motor Lumos e sejam gravados num resultado definitivo **com a etiqueta de origem do servidor**. A etiqueta de origem (ADR 6C-02) só diz que *o servidor gravou aquele resultado*; não diz que *os fatos usados são verdadeiros*. A decisão do responsável: **não aceitar** "o resultado tem prova de origem do servidor" como garantia da integridade dos dados.

## 2. Quatro noções que NÃO podem ser confundidas

| Noção | O que prova | Quem a atesta | O que NÃO prova | Onde é verificada | Teste que a demonstra |
|---|---|---|---|---|---|
| **Origem comprovada da operação** | O **servidor** gravou esta decisão/este resultado, nesta posição, com este autor (etiqueta HMAC, chave do servidor) | O processo web (chave fora das pastas) | Que os **fatos** usados no resultado são verdadeiros; que o registro continua o mesmo depois de **confirmado** (não é reverificada na leitura) | Na **conclusão de pendência** (store) e no DTO da pendente | `link-audit-origin-protocol`, `…-keys` |
| **Integridade do arquivo** | O arquivo **não mudou depois de selado** (SHA-256, encadeamento, recibo) | Ninguém: é um hash que **qualquer um recalcula** | **Quem** produziu o conteúdo; que o conteúdo é verdadeiro. Quem escreve na pasta sela o que quiser | Em toda leitura (leitor de evidências, decisões, resultados) | `link-audit-evidence-provenance` (RV2-F1: integridade OK, autenticidade não) |
| **Autenticidade da evidência** | O conteúdo **veio da coleta**: um **manifesto assinado (Ed25519)** por uma chave que **não está na pasta de evidências** atesta `ref → contentSha256` | Quem tem a **chave privada** (fora do servidor web) | Que a coleta em si estava correta (um dado falso **atestado** continua falso); a **atualidade** | Na **prévia** (fronteira com o motor), na **finalização** e na **conclusão de pendente** | `link-audit-evidence-provenance`, rotas, navegador B15 |
| **Atualidade** | A informação ainda vale **hoje** (`stale`, `decisionsChanged`, data de referência) | O motor/serviço, comparando o estado atual com o gravado | Autenticidade: um manifesto **autêntico antigo** continua autêntico (replay) | Nas listagens de resultados | testes de resultados (6C) |

## 3. Decisão

1. **Fronteira com o motor com falha fechada.** Qualquer base de evidências que **não** seja comprovadamente autêntica produz o bloqueio `EVIDENCE_PROVENANCE_UNPROVEN` na prévia. A **finalização** e a **conclusão de uma pendente** respondem `NOT_FINALIZABLE`; **nada é gravado**. A **prévia continua consultável** e rotulada ("Origem da coleta NÃO comprovada"). O padrão de produção (sem configuração) é a política **FECHADA**: não existe valor de configuração que "confie em tudo".
2. **Verificador do manifesto assinado** (`src/lib/link-audit-evidence/provenance.ts`): descrito em §4. É o **menor** mecanismo que impede quem só escreve na pasta de evidências de fabricar fatos autênticos **sem** alterar o formato das capturas, o coletor nem invalidar auditorias existentes.
3. **Legado:** uma captura **sem** prova independente **nunca** recebe autenticidade (`LEGACY_NO_SEAL`). Continua **consultável** pela interface existente, com a limitação sinalizada. **Sem migração silenciosa** e **sem autenticar retroativamente** dados não confiáveis: tornar uma coleta legada autêntica exige **ato explícito de quem tem a chave**, depois de uma verificação independente (§6).
4. **O lado produtor é um plano** (§7), não código desta rodada.

## 4. Desenho do verificador (implementado)

- **Manifesto** `seal-NNNN.json`, guardado numa **pasta própria** (`GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR`, somente leitura para o web, **nunca** a pasta de evidências nem aninhada nela — a configuração que viole isso é tratada como **fechada**): `{schemaVersion:1, kind:'LINK_AUDIT_EVIDENCE_SEAL', auditId, seq, sealedAt, keyId, entries:[{ref, contentSha256}…], signature}`. A assinatura é **Ed25519** sobre o JSON canônico do corpo.
- **Chaves públicas de ORDEM PEQUENA são recusadas** (8·A = identidade, ou encoding não canônico): com a identidade como "chave de confiança", o verificador do Node **aceita** uma assinatura universal (reproduzido; teste `link-audit-evidence-provenance`). A lista inteira vira inválida ⇒ política fechada.
- **Chaves de confiança** (`GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS`): apenas chaves **PÚBLICAS** (`<id>:<32 bytes em base64url>`), não secretas. O servidor web **não tem** a chave privada: comprometer o web **não** permite falsificar a coleta (por isso assimétrica; um HMAC com chave no web permitiria ao web forjar).
- **Regra de cobertura:** **toda** evidência que o leitor entrega à base (`capture:cNNNN`, `report:cNNNN-rNNNN`) e todo artefato que influencia a base (`legacy-status:cNNNN`) precisa estar no manifesto **com o mesmo `contentSha256`** que o leitor recalculou sobre os bytes lidos, **e nada que o manifesto atesta pode ter desaparecido**. O hash que o manifesto atesta, portanto, **não** é "recalculado depois de ler dado possivelmente adulterado": é comparado com um valor **assinado por quem o atacante da pasta de evidências não é**.
- **Seleção do manifesto:** o de **maior `seq`**; se ele for inválido **não se recua** para um mais antigo (o atacante não escolhe qual passado vale). Manifestos são **cumulativos**: o novo lista tudo que foi atestado até ali.
- **Vínculos:** `auditId` (um manifesto não migra de auditoria), `seq` (nome do arquivo = valor assinado), `keyId` conhecido, entradas **ordenadas e sem repetição**, esquema **estrito**, tamanho limitado, leitura sem seguir link e sem travar em FIFO.
- **Motivos** (códigos fixos, sem dados do arquivo): `PROOF_NOT_CONFIGURED`, `NO_SEAL`, `LEGACY_NO_SEAL`, `SEAL_INVALID`, `EVIDENCE_NOT_SEALED`, `EVIDENCE_MISSING`, `EVIDENCE_HASH_MISMATCH`, `VERIFICATION_ERROR`.

### O que isso resolve, caso a caso (todos testados)

| Ataque (só escreve na pasta de evidências) | Resultado |
|---|---|
| Acrescenta captura **nova** forjada pelo pipeline (RV2-F1) | Fora do manifesto ⇒ `EVIDENCE_NOT_SEALED` ⇒ finalização recusada, **nada gravado** |
| Reescreve um relatório **e refaz o selo SHA-256** | Hash difere do atestado ⇒ `EVIDENCE_HASH_MISMATCH` |
| Cria/edita um manifesto | Sem a chave privada a assinatura não confere ⇒ `SEAL_INVALID` |
| Copia o manifesto de **outra auditoria** | `auditId` assinado difere ⇒ `SEAL_INVALID` |
| Apaga o manifesto | `NO_SEAL` (fail-safe: o dano é **disponibilidade**, não falsificação) |
| **Apaga a captura/relatório mais recente** (o passado autêntico passaria a valer) | `EVIDENCE_MISSING` ⇒ bloqueado (R3-MINOR-1) |
| Reescreve o `serper-status.json` do legado (e o `SHA256SUMS`) | `EVIDENCE_HASH_MISMATCH` (R3-MINOR-3) |
| Troca a pasta de manifestos por link/FIFO | Falha fechada, sem travar |

### O que isso NÃO resolve (limites declarados)

- **Replay de manifesto autêntico antigo** (restaurar de backup a coleta e o manifesto antigos): é autêntico; trata-se de **atualidade** (`stale`/data de referência), não de autenticidade.
- **Quem tem a chave privada** de atestação pode atestar qualquer coisa (inclusive dado falso): custódia da chave e procedimento são o controle (§6, runbook de chaves).
- **Atestar um dado que já era falso** na origem (o Serper/o coletor entregou dado errado): a prova diz "veio da coleta", não "é verdade".
- **Janela entre a coleta e a atestação**: se o atacante escrever na pasta de evidências **antes** de o atestador conferir, o atestador pode atestar o dado forjado — por isso a atestação deve ser **imediata e conferida** (§7, fase 1) ou feita **pelo próprio coletor** (fase 3).
- **Apagar manifestos** impede a finalização (fail-safe). **Apagar capturas/revisões atestadas TAMBÉM bloqueia (R3-MINOR-1, corrigido em 01/11/2026):** a verificação é **bidirecional** — a base de hoje ⊆ manifesto **e** manifesto ⊆ base. Se o manifesto atesta `capture:c0002` e ela não existe mais, o resultado é `EVIDENCE_MISSING` (com as referências ausentes, no máximo 5), a finalização é bloqueada e a tela avisa que os dados exibidos "podem ser de uma coleta anterior e não devem ser tomados como a situação atual". **Limite que permanece:** quem escreve **as duas** pastas (evidências **e** manifestos) pode reverter ambas coerentemente a um estado antigo autêntico (atualidade, não autenticidade).
- **Cobertura do legado (R3-MINOR-3, corrigido):** o `serper-status.json` do layout legado **decide** se há perfil utilizável (cobertura, `located`); por isso entra na prova como artefato `legacy-status:cNNNN` com o hash **verificado**. Reescrevê-lo (e a linha do `SHA256SUMS`) mantém a integridade local "OK", **muda o perfil** e agora faz a base deixar de ser autêntica (`EVIDENCE_HASH_MISMATCH`); removê-lo falha já na integridade local. Os demais arquivos legados (`serper-attempts`, `summary`, `run-*`) **não influenciam** a pontuação e **não** são atestados.
- **Pasta de manifestos × outras pastas (R3-MINOR-6 / R3-INFO-6, corrigido):** não pode ser nem estar aninhada em nenhuma outra pasta de dados (evidências, decisões, recibos, resultados), conferido **lexicamente na configuração** e pelo **caminho real** (link simbólico) a cada verificação; sobreposição ⇒ política fechada.

## 5. Consequência operacional (leia antes de implantar)

Como **nenhum produtor existe em produção**, a política de produção é a **fechada** e, enquanto as fases 1–2 do §7 não forem executadas, **toda finalização e toda conclusão de pendente respondem `NOT_FINALIZABLE`**. A prévia, as evidências, as decisões e a consulta de resultados já gravados continuam funcionando. Isto é **proposital** (decisão do responsável: "até que a proveniência seja comprovável, a finalização deve falhar de forma segura") e **reversível** apenas pela via legítima (atestar), nunca por configuração.

## 6. Legado: auditorias e capturas já existentes

- **Nada é invalidado.** As coletas existentes (inclusive o legado real) continuam consultáveis; a tela mostra "Origem da coleta NÃO comprovada: coleta legada, sem manifesto assinado".
- **Nada é migrado em silêncio.** O código não escreve manifestos. Para tornar uma coleta existente finalizável, uma **pessoa com a chave privada** deve (a) conferir **por fonte independente** que a coleta é a esperada (por exemplo, comparar o `SHA256SUMS` do arquivo legado com a cópia de backup mantida fora do servidor, e conferir o provedor), (b) produzir o manifesto (§7, fase 1) e (c) entregá-lo à pasta de manifestos. O ato fica registrado (`sealedAt`, `keyId`, `seq`).
- **Resultados já gravados** não são reavaliados por esta regra (a gravação futura é que exige a prova). Nenhum resultado de produção existe hoje.

## 7. PLANO DE COMPATIBILIDADE do lado produtor — **DIREÇÃO P1 APROVADA (01/11/2026); NADA DISTO FOI IMPLEMENTADO**

> O responsável **aprovou P1 como direção arquitetural**, sujeita ao contrato técnico e à verificação de procedência, e **proibiu implementar o produtor nesta etapa**. O **contrato técnico, a custódia da chave privada e o procedimento de conferência antes da assinatura** estão em `onda6c-contrato-p1-atestacao.md`. Uma assinatura prova que o custodiante autenticou **bytes exatos**; **não** prova que a informação veio do Google ou da Serper — por isso P1 **não assina arquivos legados de procedência desconhecida**.

### Opções avaliadas

| Opção | O que faz | Prós | Contras / riscos |
|---|---|---|---|
| **P1 — Atestação pós-coleta por comando próprio** (recomendada como 1º passo) | Um comando novo (`link-audit:seal`), usado por quem tem a chave privada (estação do administrador, **fora da VPS**), lê a pasta de evidências (cópia ou montagem somente leitura), **mostra** o que será atestado (refs e hashes, data, captura, empresa), pede confirmação e escreve `seal-NNNN.json` na pasta de manifestos | **Não altera o coletor nem as capturas.** Chave privada nunca está na VPS. Primitiva `createEvidenceSeal` já pronta e testada. Serve também para o **legado** (ato explícito) | A atestação é um passo manual (risco de esquecimento; janela entre coleta e atestação); exige custódia segura da chave (arquivo protegido por senha, cartão/HSM) |
| **P2 — Serviço de atestação dedicado** | Um processo separado (outro usuário/contêiner, sem rede de entrada) com a chave, que atesta capturas recém-gravadas segundo regras (por exemplo, só as criadas por uma execução LIVE autorizada) | Elimina o passo manual | Chave passa a viver numa máquina online; nova superfície; precisa provar que só atesta coletas legítimas (volta ao problema de origem) |
| **P3 — O coletor assina** (`link-audit:collect` LIVE) | O próprio coletor, ao gravar captura/relatório, produz o manifesto | Prova **no momento da coleta**; sem janela | **Altera o pipeline de coleta** (mudança relevante, testes de coleta, o coletor passa a precisar da chave privada ⇒ ela vive onde a coleta roda) e deve ser feito com a Worker/CLI que já tem credenciais externas — risco maior de comprometimento da chave |

**Recomendação:** executar **P1** (fases 1–2); avaliar **P3** só depois de o ciclo P1 estar operando e de decidir onde a coleta roda. **P2** não recomendada agora.

### Fases propostas

| Fase | Entrega | Altera pipeline de coleta? | Altera contrato de captura? | Invalida histórico? |
|---|---|---|---|---|
| **0 (FEITA nesta rodada)** | Verificador + bloqueio fail-safe + rótulos + testes | Não | Não | Não |
| **1** | Comando `link-audit:seal` (usa `createEvidenceSeal`); procedimento do administrador; geração/custódia do par Ed25519 (privada fora da VPS); teste de ida e volta com o verificador | **Não** (comando novo) | Não | Não |
| **2** | Volume **somente leitura** de manifestos no `stack.yml` do web (nova pasta, 0700, uid 10001, backup próprio) e variáveis `GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR` / `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS`; roteiro de homologação em ambiente isolado | Não | Não | Não |
| **3 (opcional)** | Coletor assina na gravação (P3) | **Sim** | Não (manifesto fica fora da captura) | Não |
| **4 (opcional)** | Gravar `{keyId, seq do manifesto}` no **resultado** finalizado, para auditoria posterior | Não | Não (é o **resultado**, ainda sem produção) | Não — **muda o formato persistido do resultado**; exige nova rodada de aprovação |

### Compatibilidade e reversão
- **Capturas e auditorias existentes:** inalteradas. **Rollback:** remover a configuração devolve a política **fechada** (mais restritivo, nunca menos).
- **Formato persistido novo:** apenas o **manifesto** (arquivo novo, em pasta nova). Nenhum arquivo existente é reescrito.
- **Versão anterior do código:** ignora a pasta de manifestos (não a conhece); como a anterior não tinha o gate, a regressão de versão reabre o risco R2-MINOR-1 — **não fazer rollback para antes desta versão** depois que houver dados.
- **Rotação/comprometimento da chave de atestação:** runbook de chaves (`onda6c-runbook-chaves.md` §3).

### Decisões que preciso do responsável
1. Aprovar **P1** (fases 1–2) como caminho, ou indicar outra opção.
2. Onde fica a **custódia da chave privada** de atestação (quem, em que dispositivo, com que backup).
3. Política para o **legado real**: atestar (após conferência independente) ou deixá-lo permanentemente apenas consultável.
4. Se a fase 4 (gravar o manifesto no resultado) deve entrar antes do primeiro resultado de produção.

## 8. Alternativas rejeitadas

- **HMAC com a chave de origem do servidor** como prova de coleta: o servidor web **poderia forjar** a coleta; mistura "origem da operação" com "autenticidade da evidência".
- **Operador confirma na tela** ("confio nesta coleta"): o operador não tem como verificar o conteúdo; transfere a confiança ao atacante.
- **Confiar no `contentSha256` ou no `SHA256SUMS`:** são hashes que quem escreve na pasta refaz.
- **Assinar dentro de cada captura:** muda o contrato de captura e invalida o legado.
- **Banco externo (Supabase) como notário:** acopla a coleta a um serviço externo; fora do escopo e das restrições.
