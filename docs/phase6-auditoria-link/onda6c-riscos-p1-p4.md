# Onda 6C — Riscos P-1 a P-4 da 1ª revisão: análise individual (NENHUM é considerado aceito)

> **Status:** análise do implementador para decisão do responsável (01/11/2026). **Nenhum risco abaixo foi aceito** nem corrigido nesta etapa; a ausência de correção anterior **não** é aceite. As definições são **as do relatório original** (`onda6c-revisao-adversarial-seguranca.md`, linhas P-1 a P-4), citadas literalmente. As colunas "impede" são **recomendações**; a decisão é do responsável.

## P-1 — Vínculo C2 ↔ captura no instante da GRAVAÇÃO, não da exibição
- **Descrição original:** "`service.ts:543-547` calcula `basis` (captura mais recente) fora da trava e no momento do POST; o corpo do C2 (`{kind, subcriterionId, value, justification}`) não carrega a captura que o operador viu. Uma coleta nova entre a abertura da tela e o envio faria o juízo valer para uma categoria não vista. Exige coleta concorrente (hoje só por CLI); não reproduzido. Correção: enviar a fonte exibida (`profileSource.ref`) e recusar divergência (toca a 6B; decisão do responsável)."
- **Consequência:** **plausível, não reproduzida.** O juízo humano sobre a categoria (C2) é carimbado com a captura mais recente **no POST**; se uma coleta nova com categoria diferente entrar entre a abertura da tela e o envio, o juízo passa a valer (pela checagem `c2Binding` da prévia) para uma categoria que o operador **não viu**. O efeito é um índice calculado com um juízo humano que se refere a outra categoria.
- **Fronteira de confiança afetada:** **operador × servidor** (o que o operador viu × o que o servidor carimba como visto).
- **Impede a homologação da 6C?** **Não** (exige coleta concorrente; a coleta é um comando manual, sem rota HTTP).
- **Impede publicação em produção?** **Não impede a primeira implantação** se for adotada a regra de procedimento "não coletar enquanto houver tela de decisão aberta para a auditoria". **Impede** qualquer rotina em que a coleta rode concorrente com decisões (por exemplo, coleta agendada).
- **Mitigação mínima proposta:** o cliente envia a captura que a tela mostrou (`basisCapture`, igual a `profileSource.ref`); o servidor, dentro da trava, recusa com `409 BASIS_CHANGED` se a captura mais recente for diferente. **Toca o corpo da 6B** (precisa de aprovação). Alternativa sem mudar o contrato: procedimento + alerta.
- **Teste necessário:** (a) coleta nova simulada entre `list` e `POST` ⇒ POST recusado e nada gravado; (b) sem coleta nova ⇒ aceito e carimbado com a captura enviada; (c) `basisCapture` ausente/malformado ⇒ recusa; (d) regressão: decisões antigas (sem o campo) continuam legíveis.

## P-2 — Evidência trocada com selo refeito depois de um resultado aparece só como `stale:true`
- **Descrição original:** "aparece nas consultas só como `stale:true` (`results.ts:304-312`); o alarme `EVIDENCE_HASH_CHANGED` só surge na próxima finalização. Sugestão: rodar `changedPinnedEvidence` em `list/get` e expor um indicador de integridade distinto de 'desatualizado'."
- **Consequência:** **comprovada** pelo revisor 2 (RV2-F2): remover/trocar a captura que um resultado fixou só mostra `stale:true`, sem alarme. **Situação atual:** para coletas **atestadas** a *prévia* agora acusa `EVIDENCE_MISSING`/`EVIDENCE_HASH_MISMATCH`, mas as **consultas de resultados já gravados** continuam mostrando só "desatualizado".
- **Fronteira de confiança afetada:** **pasta de evidências × resultados selados** (a evidência que sustentou um resultado mudou depois).
- **Impede a homologação da 6C?** **Não.** **Impede produção?** **Não impede a implantação, mas recomendo corrigir antes do primeiro resultado de produção** (custo baixo; sem isso o operador pode tratar uma evidência adulterada como mera desatualização).
- **Mitigação mínima proposta:** em `list`/`get`, comparar as evidências fixadas pelo resultado (`changedPinnedEvidence`) com as de hoje e expor `evidenceIntegrity: OK | CHANGED | MISSING | UNAVAILABLE` (nunca `OK` quando não se conseguiu comparar), com rótulo próprio na interface.
- **Teste necessário:** resultado selado com captura fixada → (a) sem mudança ⇒ `OK`; (b) captura trocada com selo refeito ⇒ `CHANGED`; (c) captura removida ⇒ `MISSING`; (d) leitura indisponível ⇒ `UNAVAILABLE` (não `OK`); (e) o indicador é independente de `stale`.

## P-3 — Custo de verificação a frio
- **Descrição original:** "`verifyRunRecord` é síncrono (~6,7 ms/registro, número do implementador); 500 registros ⇒ ~3,4 s de laço de eventos bloqueado por consulta com cache frio; o cache (`VERIFIED_CAP = 4096`) é limpo inteiro ao encher. Exigiria milhares de finalizações de um operador interno; não reproduzido."
- **Consequência:** **plausível, não reproduzida e não medida.** Bloqueio do laço de eventos em consultas com cache frio. **Agravante desta rodada (a decidir):** a listagem de decisões e a prévia passaram a ler a cadeia de resultados para obter a testemunha (R3-MINOR-2), o que **multiplica** o número de verificações por requisição (mitigado pelo cache de verificação e pelo limite de 30 leituras/min por operador).
- **Fronteira de confiança afetada:** **disponibilidade do processo web** (um único processo atende todas as auditorias).
- **Impede a homologação da 6C?** **Não.** **Impede produção?** **Não impede**, mas **exige medição** com volume realista antes de confiar.
- **Mitigação mínima proposta:** medir (500 resultados sintéticos: latência p95 de `list`, de `GET decisões` e atraso do laço de eventos); se excessivo, cachear a testemunha por `(auditId, head)`, verificar de forma incremental ou fatiar o trabalho.
- **Teste necessário:** benchmark reproduzível sem rede com 500 resultados válidos sintéticos, com limites explícitos de latência e de atraso do laço de eventos; teste de que o cache não é limpo inteiro ao encher (ou de que a limpeza não degrada além do limite).

## P-4 — Durabilidade: `fsync` de diretório é *best-effort*
- **Descrição original:** "`fsync` do arquivo temporário antes do `link()` é real (`snapshot-store.ts:96-104`), mas o `fsync` do diretório é *best-effort* com erro ignorado (`snapshot-store.ts:385`) e a pasta da auditoria criada por `mkdir` nunca recebe `fsync` no diretório-pai. Em ext4 com journal ordenado isso é na prática durável; não é garantido por POSIX. A ordem resultado → recibo é correta (o pior caso após queda é falso `RESULT_TRUNCATED`, falha fechada)."
- **Consequência:** **plausível, não testada com queda real.** Após queda de energia, a entrada de diretório de um arquivo recém-publicado pode não ter persistido enquanto o recibo persistiu ⇒ falso `TRUNCATED` (falha **fechada**, restaura-se do backup). **Efeito desta rodada:** perder entradas de **resultados** pode agora deixar o histórico de **decisões** como `UNAVAILABLE`/`REGRESSED` (também fail-closed) até restaurar o par do mesmo instante. Soma-se o achado R2-INFO-6: `syncDirectory` abre sem `O_NONBLOCK|O_DIRECTORY`.
- **Fronteira de confiança afetada:** **aplicação × sistema de arquivos/hardware.**
- **Impede a homologação da 6C?** **Não.** **Impede produção?** **Não impede, mas exige** (a) requisito documentado de **sistema de arquivos local ext4/xfs, sem NFS/SMB/overlay não validado**, e (b) **ensaio de queda** em homologação.
- **Mitigação mínima proposta:** documentar o requisito; tratar a falha de `fsync` de diretório como falha de durabilidade (não sucesso) nos sistemas de arquivos conhecidos; abrir o diretório com `O_DIRECTORY|O_NONBLOCK`; `fsync` do diretório-pai ao criar a pasta da auditoria.
- **Teste necessário:** (a) FS injetado em que `syncDirectory` falha ⇒ a escrita **não** é reportada como durável; (b) varredura de quedas (`kill -9` em cada etapa do protocolo) também nos **resultados** e na recuperação com a testemunha (hoje existe para decisões); (c) ensaio em homologação com queda real.

---

## Quadro-resumo (recomendação do implementador; decisão do responsável)

| Risco | Impede encerrar a 6C? | Impede produção? | Ação mínima recomendada |
|---|---|---|---|
| **P-1** | Não | Só com coleta concorrente | Decidir: procedimento (aceitar com regra) **ou** correção no corpo da 6B |
| **P-2** | Não | Recomendado antes do 1º resultado | Indicador `evidenceIntegrity` em `list/get` |
| **P-3** | Não | Não, mas exige medição | Benchmark de 500 resultados; cachear a testemunha se necessário |
| **P-4** | Não | Exige requisito de FS e ensaio de queda | Documentar FS; testar falha de `fsync`; ensaio |
