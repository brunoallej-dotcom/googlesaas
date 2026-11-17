# 0002. Autenticar a confirmação dos resultados da Auditoria por Link pelo livro de cabeças

- **Date**: 2026-11-16
- **Status**: Proposed
- **Deciders**: responsável pelo projeto
- **Tags**: security, link-audit, fase-6, p1

## Context

Um resultado da Auditoria por Link (Onda 6C) só vale quando existem o arquivo do resultado **e** o recibo, gravado em
outra pasta. Entre os dois ele fica **pendente**: existe, não vale e bloqueia a auditoria (ADR 6C-02,
`docs/phase6-auditoria-link/onda6c-adr-prova-de-origem.md` §1).

Pela API, só o autor conclui uma pendente: `finalizedBy` precisa ser o operador da sessão
(`src/lib/link-audit-scoring-runs/results.ts:451`). Antes de gravar o recibo, a conclusão ainda confere quatro coisas:
- a origem do arquivo pela etiqueta HMAC;
- que o registro se explica (o motor é reexecutado);
- que as evidências citadas continuam com os mesmos hashes;
- que o histórico de decisões não regrediu, além da barreira de durabilidade do livro (`results.ts:452–474`).

**O recibo, porém, não é autenticado.** É só SHA-256 (`RUN_ANCHORS`, `results-store.ts:82`, perfil genérico de
`link-audit-storage`). Por isso, quem escreve só na pasta de recibos de resultados pode fabricar o recibo de uma pendente
**legítima** de outro operador. O resultado vira confirmado sem ação de ninguém e sem as reconferências da conclusão.
O ADR 6C-02 declara esse limite (§8, linha "Recibos dos resultados"), e a revisão adversarial nº 8 o encontrou do lado
das decisões (M-1).

Para as **decisões**, o PR #19 fechou o mesmo achado com o livro de cabeças. Recibo presente sem `CONFIRMED` no livro
é a **fase C**, e a fase C só é concluída pelo autor (`onda6c-especificacao-livro-de-cabecas.md` §16.16). Os
resultados não passam pelo livro: o recibo basta.

Hoje o risco é **inalcançável**. A finalização responde `NOT_FINALIZABLE` enquanto não houver prova de coleta (o
produtor P1 não existe), então nenhuma pendente legítima de resultado chega a existir em produção. Ele passa a ser real
no **primeiro resultado de produção**. O responsável decidiu, em 16/11/2026, que este ADR é o portão de entrada da
onda P1.

Forças em jogo:
- A etiqueta de origem dos registros **confirmados** não é reverificada na leitura (ADR 6C-02 §5). De propósito: uma
  chave aposentada vence (`KEY_EXPIRED`) e, com reverificação, resultados antigos deixariam de valer.
- O livro já resolveu a rotação pela ordem da cadeia (época de chave, R6-06), com chave e pasta exclusivas.
- Só auditorias com livro `PROTECTED` podem finalizar (`preview.ts:163`): todo resultado de produção nasce numa
  auditoria com livro.
- Nada da 6B/6C foi implantado: a primeira implantação pode já sair com o formato novo, sem migrar dados reais.

## Decision

**A confirmação de um resultado passará pelo livro de cabeças, como a de uma decisão.** Cada finalização grava no livro
da auditoria duas marcas:
- `RUN_INTENT`, antes de publicar o arquivo do resultado;
- `RUN_CONFIRMED`, depois do recibo.

Recibo presente sem `RUN_CONFIRMED` é a **fase C do resultado**. A `RUN_CONFIRMED` dela só é gravada pelo autor
(e-mail da sessão igual a `finalizedBy`), com a origem `PROVEN` e **todas** as reconferências atuais da conclusão.
Qualquer outro operador recebe `RESULT_PENDING_UNCONFIRMED`, e nada é gravado.

Resultado ou recibo sem a `RUN_INTENT` correspondente, numa auditoria `PROTECTED`, é contradição com o livro: integridade
**não resolvida**, falha fechada, como as decisões hoje.

Antes do código, uma emenda à spec do livro (§16.17) fixa:
1. os tipos novos de registro e o domínio da etiqueta;
2. a classe de capacidade dos resultados dentro da política da §16.12;
3. as receitas de recuperação (fases A, B e C do resultado, espelho da §16.4);
4. a separação entre a **cabeça das decisões** e a cabeça do livro. O `ledgerHead` citado no resultado e as comparações
   de `INPUT_CHANGED` e da barreira de durabilidade continuam olhando só as operações de decisão; uma finalização não
   pode mudar a entrada de outra;
5. a ordem de leitura da §16.12, agora que resultado e livro se citam nos dois sentidos.

## Consequences

### Positive

- Quem escreve só na pasta de recibos de resultados **não** promove pendente alheia. A mensagem de `results.ts:88` ("só
  o autor, reenviando o mesmo pedido, o conclui") passa a valer também contra quem tem acesso ao armazenamento.
- Também fecha, para os resultados, o limite RV2-W1: quem escreve nas pastas de dados **e** de recibos não cria resultado
  confirmado sem a marca no livro, que tem pasta e chave próprias.
- Reaproveita um mecanismo que já passou por sete rodadas de revisão e pelo #19: chave exclusiva, época pela ordem da
  cadeia, exclusão mútua por `link()`, durabilidade observada. Não há segredo novo nem regra de rotação nova.
- As decisões e os resultados passam a obedecer à mesma regra, o que simplifica a explicação, os testes e o runbook.

### Negative

- O livro, que já é o módulo mais complexo da Fase 6, ganha mais responsabilidade: tipos de registro novos, uma classe
  de capacidade e receitas de recuperação para resultados.
- Cada finalização grava dois registros a mais no livro (custo de `fsync`), e a capacidade do livro passa a ser
  disputada por decisões e resultados.
- O livro vira ponto de congelamento também para os resultados: quem só escreve na pasta do livro trava a finalização.
  É falha fechada por desenho, a mesma consequência já declarada para as decisões (ADR 6C-02 §11).
- O formato persistido do livro muda (nova versão de esquema). Sem dados reais implantados, isso é aceitável agora e
  caro depois.

### Neutral / follow-ups

- **Não cobre:** quem tem a chave do livro **e** escreve nas pastas do livro e de recibos; rollback coordenado de todos
  os volumes. Os dois continuam dependendo da guarda externa do `head`, que segue bloqueadora de produção.
- **Testes primeiro** (critérios de aceite da onda R1 em `docs/plan/implementation-waves.md`):
  1. o recibo fabricado para a pendente legítima de outro operador **não** confirma o resultado (espelho do teste
     RV3A-1 das decisões);
  2. outro operador recebe `RESULT_PENDING_UNCONFIRMED`, e o reenvio do autor conclui após as reconferências;
  3. resultado sem `RUN_INTENT` falha fechado;
  4. o `ledgerHead` e o `INPUT_CHANGED` não mudam com a finalização;
  5. todas as mutações dos pontos novos morrem.
- Quando aceito, entrar no índice de `docs/adr/README.md` como Accepted e registrar no ADR 6C-02 §8 que a linha "Recibos
  dos resultados" foi fechada.

## Alternatives considered

**B. Etiqueta HMAC no recibo do resultado, verificada em toda leitura.** É uma mudança local, em `results-store` e no
perfil de recibo. Reabre, porém, o problema que o ADR 6C-02 §5 evitou de propósito: verificar na leitura depende das
chaves de hoje. Uma chave aposentada vencida invalidaria resultados antigos legítimos. Evitar isso exige reinventar, para
os recibos, a época pela ordem da cadeia que o livro já tem. Se usar a chave de origem, quem tiver essa chave e as duas
pastas forja um resultado confirmado. Se usar uma chave nova, surge mais um segredo para guardar e girar. Fica como
segunda opção, caso a emenda do livro se mostre grande demais.

**C. Repetir as reconferências da conclusão em toda leitura de resultado confirmado.** Isso cobre as reconferências
puladas, mas não prova que o autor agiu: uma pendente que o autor abandonou continuaria promovível. Além disso, reexecuta
o motor e relê as evidências a cada consulta. Rejeitada como solução; serve como defesa em profundidade.

**D. Manter o limite declarado** e confiar no procedimento (ninguém escreve na pasta de recibos) e na guarda externa
futura. Contraria a decisão do responsável de fechar o equivalente nas decisões (#19) e deixaria a mensagem da API
prometendo mais do que o sistema garante. Rejeitada.

**E. Assinar o recibo com a chave Ed25519 do P1.** Essa chave fica offline com o custodiante e atesta a **coleta**; ela
não participa da finalização online. Rejeitada: mistura finalidades e exigiria a chave no servidor.

## References

- Related ADRs: ADR-0001; ADR 6C-02 `docs/phase6-auditoria-link/onda6c-adr-prova-de-origem.md` (§1, §5, §8, §11); ADR 6C-03
  `docs/phase6-auditoria-link/onda6c-adr-proveniencia-evidencias.md`.
- Spec do livro: `docs/phase6-auditoria-link/onda6c-especificacao-livro-de-cabecas.md` (§16.4, §16.12, §16.16).
- Revisão adversarial nº 8: `docs/phase6-auditoria-link/onda6c-revisao-adversarial-8.md` (parte A, M-1).
- Spec do P1: `docs/specs/link-audit-p1-attestation.md`; plano: `docs/plan/implementation-waves.md`.
- Modelo de ameaças: `docs/security/threats/link-audit-ledger-e-resultados.md`.
