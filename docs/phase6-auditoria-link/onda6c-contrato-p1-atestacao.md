# Onda 6C — Contrato técnico do produtor P1 (atestação offline da coleta) e custódia da chave privada

> **Atualização 17/11/2026 (onda W0 do P1): CONTRATO APROVADO pelo responsável com os ajustes marcados "W0" abaixo** (decisões D1–D13 da spec `docs/specs/link-audit-p1-attestation.md` §13.1). A implementação segue `docs/plan/implementation-waves.md` (W1–W5). O texto original abaixo continua valendo onde não foi ajustado.
>
> **Status original: CONTRATO PROPOSTO — NADA DISTO FOI IMPLEMENTADO.** O responsável **aprovou a opção P1 como direção arquitetural** (01/11/2026), "sujeita ao contrato técnico e à verificação de procedência", e proibiu implementar o produtor nesta etapa. Este documento é o contrato para a próxima revisão. Não altera o coletor, `stack.yml`, `docker-entrypoint.sh`, volumes ou qualquer código. Complementa `onda6c-adr-proveniencia-evidencias.md` (lado verificador, já implementado) e `onda6c-runbook-chaves.md`.

## 1. O que a assinatura significa — e o que NÃO significa

| Afirmação | A assinatura prova? |
|---|---|
| "O custodiante autenticou **estes bytes exatos** (hashes) como a coleta da auditoria X" | **Sim** |
| "Quem escreve só na pasta de evidências **não** fabrica fatos que o sistema trate como autênticos" | **Sim** (o verificador exige o manifesto assinado) |
| "As informações foram **realmente fornecidas pelo Google ou pela Serper**" | **NÃO.** Nenhuma assinatura nossa prova a origem junto ao provedor |
| "Os dados do provedor são **verdadeiros**" | **NÃO** |
| "A coleta é **atual**" | **NÃO** (atualidade é outra noção) |

**Consequência de projeto:** a assinatura vale **exatamente o que vale a conferência feita antes dela**. Por isso P1 **não pode** "simplesmente assinar arquivos de procedência desconhecida": o valor de segurança está no **procedimento de conferência e aprovação** (§4), com **registro da fonte e dos artefatos exatos** (§5).

## 2. Custódia da chave privada Ed25519 (decisão do responsável)

- A chave privada fica sob **controle administrativo**, em **ambiente confiável separado da VPS e do servidor web**, **preferencialmente em armazenamento criptográfico protegido** (token/cartão de hardware com PIN, ou HSM) **ou, na falta, em meio criptografado com desbloqueio manual** (senha longa digitada por quem assina, nunca guardada junto).
- **Proibido** guardar a chave privada: no repositório; no workspace de desenvolvimento (WSL); em qualquer pasta de evidências, decisões, resultados, recibos ou manifestos; no serviço web, no Worker ou em qualquer contêiner/volume da VPS; em backups não cifrados; em chat, ticket ou documento.
- **O servidor de verificação recebe apenas as chaves públicas autorizadas** (`GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS`). Comprometer o servidor web **não** permite falsificar a coleta.
- **Geração:** em máquina limpa, offline, por quem será o custodiante; só a chave **pública** sai dela; o `<id>` da chave é um rótulo público (`ek-AAAAMM-a`).
- **Pessoas:** um **custodiante titular** e um **suplente** com procedimento de substituição documentado (a substituição **troca a chave**, não copia a privada). A pessoa que **confere** a procedência (§4) deve ser, sempre que possível, **diferente** de quem assina (quatro olhos).
- **Backup:** cópia cifrada da privada em local físico separado, com controle de acesso; teste de restauração anual.
- **Uso registrado:** cada assinatura gera um registro no dossiê (§5); a privada nunca é usada fora do procedimento.
- **Comprometimento/rotação:** `onda6c-runbook-chaves.md` §4 (remover a pública da lista fecha a finalização; reatestar só o que for conferido por fonte independente).
- ~~Decisões que continuam abertas: quem é o titular e o suplente; qual dispositivo; onde ficam os backups.~~ **W0 (17/11/2026):** regra das pessoas na D10 (titular = o responsável; suplente com **par próprio**; sem segunda pessoa, aceite formal antes da chave real); dispositivo na D11 (PKCS#8 cifrado em estação dedicada e sem rede primeiro; token só depois do teste da RS-15 e de exceção à RS-14); rotação na D8/D12. **Continuam abertos:** os nomes e o local dos backups, a registrar no runbook da W5.

## 3. Contrato técnico do processo (a implementar depois da aprovação deste contrato)

Etapas, todas **offline** em relação à VPS (a estação do custodiante não tem a chave pública nem privada do servidor web; ela só **lê** uma cópia dos dados):

1. **Exportar candidato.** Um comando novo, de **somente leitura**, sobre uma **cópia** da pasta de evidências da auditoria (ou montagem `:ro`), produz o **pacote candidato**: lista `ref → contentSha256` de **todas** as capturas, relatórios e artefatos que a base de pontuação usa (o mesmo conjunto que o leitor entrega: `capture:`, `report:`, `legacy-status:`), a integridade local (SHA-256) já verificada e o resumo (empresa, datas, número de capturas/revisões). **Não escreve nada** na pasta de evidências.
2. **Conferir a procedência** (§4), produzindo o **dossiê** (§5).
3. **Aprovar.** O conferente aprova (ou recusa) por escrito no dossiê.
4. **Assinar.** O custodiante, na estação confiável, desbloqueia a chave e assina o manifesto **cumulativo** (**W0: formato `v2`, D1** — `createEvidenceSealV2`, aditivo, ondas W3/W4; o `createEvidenceSeal` do `v1` continua só para leitura e testes; recusas completas na spec §5.5): `seq` = anterior + 1; `entries` = **o conjunto exato** (nada a mais, nada a menos). A ferramenta **recusa** assinar se: (a) alguma evidência já atestada no manifesto anterior mudou de hash ou sumiu; (b) o pacote inclui capturas **legadas sem dossiê de fonte**; (c) o candidato não é o mesmo que o conferente aprovou (hash do pacote aprovado ≠ hash do pacote a assinar); (d) a integridade local não está `OK`.
5. **Entregar.** O arquivo `seal-NNNN.json` (**não secreto**) vai à pasta de manifestos do servidor (por meio administrativo; o servidor só lê). **W0 (D7): o canal é o pipeline de CI**, nunca cópia manual; a assinatura conferida no servidor é o portão. Quem escreve no volume fica para a W5. O manifesto **não** carrega a chave privada nem dados pessoais.
6. **Verificar.** Depois da entrega, a prévia da auditoria deve mostrar "Origem da coleta autenticada" e `finalization.allowed` dependente apenas dos demais critérios; o resultado é anotado no dossiê.
7. **Arquivar** o dossiê no cofre (fora da VPS).

**Formato do manifesto:** o `v1` já implementado (cumulativo, conjunto exato, bidirecional). ~~Proposta para uma futura `v2`~~ **W0 (D1): `v2` decidido, antes do primeiro resultado de produção**, com `dossier` e `prevSealSha256` **dentro da parte assinada** (RS-10). Contrato próprio do verificador `v2` (onda W3) a aprovar antes do código; o `v1` continua legível.

**Invariantes de teste do produtor (critério de aceite):** o produtor deve ter testes que provem que ele (i) recusa assinar nos casos (a)–(d); (ii) nunca lê a pasta de evidências com escrita; (iii) produz um manifesto que o verificador aceita (ida e volta) e que **falha** se qualquer byte mudar; (iv) nunca imprime nem grava a chave privada; (v) funciona sem rede.

## 4. Conferência e aprovação da captura ANTES da assinatura

> Princípio: **assinar não cria procedência; registra uma conferência.** Sem fonte independente, o resultado correto é **"NÃO ATESTÁVEL"**: a coleta continua consultável, rotulada, e **não finalizável**.

### 4.1 Captura nova (execução LIVE autorizada)
O conferente verifica, **antes** de pedir a assinatura, e registra no dossiê:
1. **A execução autorizada existe:** a autorização usada (`used-authorizations`) corresponde à auditoria e à identidade confirmada (fingerprint), dentro da janela de validade, e foi consumida **uma vez**.
2. **O que o coletor imprimiu no fim da execução** (hash do corpo e identificadores), **registrado pelo operador que coletou em canal separado** (não na pasta de evidências), é **igual** ao `bodySha256` da captura.
3. **Coerência:** URL do provedor e consulta compatíveis com a identidade confirmada; `collectedAt` dentro da janela; resposta HTTP 2xx; corpo preservado.
4. **Fonte externa independente do provedor:** o consumo de créditos/chamadas no painel do provedor (Serper) coincide com a execução (mostra que **houve** a chamada; **não** prova o conteúdo).
5. **Relatórios derivados:** o relatório referencia (`captureSha256`) a captura atestada e **reproduz** quando o gerador do código é reexecutado offline sobre essa captura (determinístico): só se atesta o que reproduz.

### 4.2 Captura LEGADA (anterior à versão atual)
**Nunca assinar "como está".** Pré-requisito: **fonte independente** da procedência — uma cópia de backup **anterior ao incidente/uso**, guardada fora do servidor, cujos hashes (`SHA256SUMS`, `serper-body.json`, `serper-status.json`) **coincidem** com os atuais; **ou** registro externo da execução original (log, saída do coletor) com o mesmo hash; **e** conferência da identidade/da data. Sem isso: **NÃO ATESTÁVEL** (permanece consultável, nunca finalizável). Não se aceita "o SHA-256 confere" como fonte: ele é recalculável por quem escreve na pasta.

### 4.3 Qualquer captura
Se a integridade local não for `OK`; se a identidade divergir entre capturas; se houver captura/revisão **ausente** (lacuna) ou **a mais** sem explicação; se o conjunto candidato diferir do conjunto aprovado: **recusar**.

## 5. Dossiê de atestação (registro durável, fora da VPS)

**W0 (spec §5.5 e §9): o dossiê tem DUAS partes.** **(A) Dossiê de aprovação**, congelado **antes** da assinatura, cujo hash vai dentro do manifesto `v2`: pacote e seu hash, resultado das verificações, fonte, aprovação, observações e exceções. **(B) Registro de assinatura** (recibo), gerado **depois** pelo `sign` e arquivado ao lado, ligado ao dossiê: `seq`, `keyId`, `sealSha256`, data, custodiante e hash do artefato do `sign`. Os campos abaixo se distribuem assim; `seq`, `keyId` e o hash do manifesto pertencem à parte B (não podem estar num documento cujo hash o próprio manifesto assina).

Campos: `auditId`; lista exata `ref → contentSha256` (o pacote candidato e seu hash); **fonte** (tipo: execução LIVE | backup independente | registro externo; identificador da execução/do backup; data); resultado de **cada verificação** do §4; conferente, aprovador e custodiante (pessoas) e datas; número `seq` e `keyId` do manifesto; hash do manifesto assinado; observações e exceções (com justificativa). O dossiê é arquivado no cofre; **não** é lido pelo servidor.

## 6. O que NÃO muda (garantias de fronteira)

O coletor, o formato das capturas, `stack.yml`, `docker-entrypoint.sh` e os volumes de produção **não são tocados** por P1. A pasta de manifestos é um volume **novo, somente leitura para o web** (documento de implantação). O verificador já falha **fechado** sem manifesto. Auditorias históricas **não são invalidadas nem migradas**: apenas deixam de ser finalizáveis até serem atestadas por este procedimento.

## 7. Riscos residuais do próprio P1 (declarados)

1. **Janela entre a coleta e a atestação:** quem escreve na pasta de evidências nesse intervalo pode induzir o conferente a atestar dado adulterado — mitigada pelo §4.1 itens 2–3 e 5 (hash registrado em canal separado; reprodução do relatório). Só a fase 3 do ADR 6C-03 (o coletor assina) elimina a janela.
2. **Fator humano:** conferência negligente ⇒ atestado falso. Mitigação: quatro olhos, dossiê obrigatório e auditoria periódica dos dossiês.
3. **Disponibilidade:** a finalização depende de uma pessoa e de um dispositivo. Mitigação: suplente e procedimento de substituição.
4. **Manifesto autêntico antigo** (replay) é **atualidade**, não autenticidade.
5. **Não há atestado de que o provedor disse a verdade** (§1).

## 8. Perguntas ao responsável (para a próxima revisão)

1. Quem são o custodiante titular e o suplente? Que dispositivo (token de hardware, HSM, meio criptografado)? — **Respondida (W0): regra na D10, dispositivo na D11; nomes no runbook da W5.**
2. O conferente pode ser a mesma pessoa que opera a coleta, ou exige-se pessoa distinta? — **Parcial: a D4 trata conferente ≠ custodiante; o acúmulo operador/conferente gera `requiresLaterReview` (spec §13.3, a confirmar).**
3. Para o **legado real** (a coleta da TUVAPLAST): existe backup anterior independente ou registro externo? Se não, aceita-se que permaneça **NÃO ATESTÁVEL**? — **Respondida (D3): NÃO ATESTÁVEL; coleta LIVE nova sob autorização escrita específica (onda W6).**
4. A `v2` do manifesto (hash do dossiê dentro da parte assinada) deve entrar antes do primeiro resultado de produção? — **Respondida (D1): sim.**
5. Aprova que o comando de exportação do candidato seja entregue **antes** do comando de assinatura (fases separadas)? — **Respondida (D2): sim.**
