# Onda 6C — checklist de prontidão para PRODUÇÃO (I7)

> **Status: SOMENTE CHECKLIST. NADA deste documento foi executado ou aplicado.** `stack.yml`, `Dockerfile` e `docker-entrypoint.sh` **não foram alterados**; nada foi feito na VPS, no Redis, no Supabase ou no Serper; nenhuma imagem foi construída; nenhuma migration foi escrita ou executada. Cada item abaixo é uma ação **futura**, que exige autorização específica do responsável, em etapa de implantação própria (sugestão: "H3"), com **leitura primeiro** e uma alteração por vez. Estende, sem substituir, `deploy/hostinger/PLANO-DE-VOLUME-DE-DECISOES.md` (6B), `GUIA-DE-IMPLANTACAO.md`, `PLANO-DE-ROLLBACK.md`, `PLANO-DE-BACKUP-E-RESTAURACAO.md`, `VERIFICACAO-POS-DEPLOY.md` e `CHECKLIST-DE-SEGURANCA.md`.

## Pendências declaradas — NÃO omitir de nenhum parecer de prontidão
- **CSP em Report-Only**, com `'unsafe-inline'` (não bloqueia nada hoje).
- **Limitadores de requisição em memória** (por processo; zeram ao reiniciar).
- **Quatro volumes** de dados e recibos, **backup independente** de cada um (ainda não definido nem ensaiado).
- **Recuperação de pendências** (sem alerta externo).
- **Monitoramento** de integridade e de armazenamento (inexistente).
- **Testes de rollback** (não executados).
- **Revisão adversarial independente de segurança/integridade: NÃO CONCLUÍDA** (obrigatória antes do encerramento da Onda 6C).
- **Acessibilidade sem leitor de tela real** (e sem outros navegadores/dispositivo físico).
- **Cobertura do Lumos sem a D5:** toda auditoria real sai INCONCLUSIVA (teto 17% < mínimo 40%).
- Correção de contraste do dashboard (token `primary-strong`, `muted/60`, anéis de foco) **aprovada, ainda não implementada** (commit específico de acessibilidade).

## 0. Pré-condições (bloqueiam tudo o que vem depois)
- [ ] O responsável **autorizou por escrito** a etapa de implantação e o escopo (qual VPS, qual tag, quem opera, janela).
- [ ] O commit de homologação da 6C (I6), o checkpoint do I7 **e a revisão adversarial independente (hoje pendente)** foram **aprovados** pelo responsável; a tag de imagem a publicar aponta para um commit conhecido (`git rev-parse` registrado).
- [ ] A versão atual em produção é conhecida e a **imagem anterior está guardada** para rollback (tag e digest anotados).
- [ ] D5 (coleta que eleva a cobertura) **não** é pré-requisito: sem ela toda auditoria real sai INCONCLUSIVA (teto de 17% < 40%). Isso é o comportamento correto e deve estar **explícito para a equipe** antes do uso (ver §9).

## 1. Volumes separados — decisões, resultados e seus recibos
A 6C grava **três** conjuntos de dados novos, todos **imutáveis por convenção** (arquivos `0444`, cadeia de hashes) e **insubstituíveis** (decisões humanas com autoria; resultados selados). Cinco pastas distintas no total, **nenhuma dentro de outra**, nenhuma em `public/`, `src/`, `.next/` ou `node_modules/`; o código recusa a configuração que viole isso (a finalização responde 503).

| Papel | Variável (no serviço **web**) | Montagem | Observação |
|---|---|---|---|
| Evidências | `GMN_LINK_AUDIT_EVIDENCE_DIR=/data/evidence` | **`read_only: true`** (já existe) | não mudar |
| Decisões | `GMN_LINK_AUDIT_DECISIONS_DIR=/data/decisions` | leitura e escrita, só no web | 6B |
| Recibos das decisões | `GMN_LINK_AUDIT_DECISIONS_ANCHOR_DIR=/data/decision-anchors` | leitura e escrita, só no web, **outro disco/volume** | 6B |
| **Resultados** | `GMN_LINK_AUDIT_RESULTS_DIR=/data/results` | leitura e escrita, só no web | **6C (novo)** |
| **Recibos dos resultados** | `GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR=/data/result-anchors` | leitura e escrita, só no web, **outro disco/volume, backup próprio** | **6C (novo)** |

- [ ] As 4 pastas graváveis existem **no host** antes da implantação, com `uid:gid 10001:10001` e modo `0700` (`stat -c '%u:%g %a'` conferido); **o Worker não monta nenhuma delas**.
- [ ] Os dois volumes de **recibos** ficam em **disco/volume diferente** dos dados que ancoram (senão "mesmo disco não é backup independente": a perda do disco leva dados e prova juntos).
- [ ] Sem os volumes de resultados o sistema **falha fechado**: a prévia continua funcionando e a finalização responde 503 `RESULTS_NOT_CONFIGURED` / `RESULT_ANCHOR_NOT_CONFIGURED`. Publicar o código sem os volumes é seguro, apenas inoperante (coberto pelo teste de API `tests/link-audit-scoring-results-api.test.ts`, caso "sem pasta de resultados"; **não** foi exercitado em produção).
- [ ] Sem `GMN_LINK_AUDIT_DECISIONS_*`/`EVIDENCE_DIR` a própria prévia responde 503 (`DECISIONS_NOT_CONFIGURED`, `ANCHOR_NOT_CONFIGURED`, `EVIDENCE_NOT_CONFIGURED`).

## 2. Configuração de ambiente
- [ ] `GMN_OPERATOR_EMAILS` lista **somente** quem pode operar a auditoria (decide/finaliza). O e-mail do operador é gravado em cada decisão e em cada resultado (`finalizedBy`): é identidade de auditoria, **não** metadado descartável.
- [ ] O segredo que assina a sessão já existe em produção; **nenhum segredo novo** é criado pela 6C. Conferir que não aparece em log, imagem ou `docker inspect` compartilhado.
- [ ] Nenhum arquivo `.env*` entra na imagem nem na árvore de build (o `run-isolated.sh` já recusa a árvore com `.env*`).
- [ ] Nenhuma porta nova publicada; nenhuma chamada externa nova: a 6C **não usa** Serper, Google nem Supabase para pontuar (o motor roda localmente sobre evidências já preservadas).

## 3. Permissões
- [ ] Contêiner web não-root (uid 10001), `read_only: true` na raiz, `cap_drop: ALL` inalterados; só os binds graváveis acima.
- [ ] Modo `0700` nas pastas; os arquivos gravados pelo código saem `0444` (conferir por amostragem após o primeiro teste sintético).
- [ ] Ninguém além do uid 10001 (e do administrador, de forma consciente) escreve nessas pastas: **root pode alterar arquivos**; a cadeia de hashes e os recibos **detectam** (409 na leitura), não impedem. Alteração **coordenada** de dados e recibos só é detectada se o `head` de cada auditoria foi guardado fora (ver §4).

## 4. Backup e restauração (cada pasta com backup próprio e independente)
- [ ] Incluir **as quatro pastas graváveis** no `PLANO-DE-BACKUP-E-RESTAURACAO.md`, **cada uma com destino independente**, fora do disco da VPS, com `sha256sum` por arquivo, sem `--delete` e sem sobrescrever.
- [ ] Guardar junto, após cada resultado, o `head` (`seq` + `sha256`) de cada auditoria devolvido pela API de resultados e de decisões: é a única referência que detecta o **retrocesso coordenado** de dados + recibos.
- [ ] Restaurar **sempre os pares do mesmo instante** (decisões + recibos; resultados + recibos), em pasta nova, conferir lendo pela API (histórico que não confere devolve 409 e nenhum dado) e só então trocar o volume. **Nunca** apagar arquivos para "destravar" uma auditoria.
- [ ] Ensaiar a restauração em ambiente de teste **antes** de confiar no backup.

## 5. Recuperação de pendências
Duas falhas parciais **por desenho** são recuperáveis, nunca perdem dado e nunca aparecem como confirmadas:
- **Decisão sem recibo** (`ANCHOR_PENDING`): a decisão ainda **não vale**; o autor reenvia o **mesmo pedido** e conclui. Enquanto pendente, a auditoria não aceita novas decisões nem finalização.
- **Resultado sem recibo** (`RESULT_ANCHOR_PENDING`): o registro fica "gravado e NÃO confirmado" e **não conta** como resultado; o autor usa "Concluir a confirmação". Verificado no roteiro: sem recibo, o detalhe responde 409 e a lista mostra o registro como pendente.
- [ ] Alertar quando houver pendência com mais de N minutos (sugestão: 15) — hoje isso só é visível na tela; **monitoramento externo ainda não existe** (ver §6).
- [ ] Procedimento de quarentena (`onda6b-decisoes-humanas.md` §15) revisado pela equipe de operação.

## 6. Monitoramento
- [ ] **Espaço em disco** das quatro pastas e dos volumes de recibos (alerta em 80%). `ENOSPC`/`EIO`/`EROFS` bloqueiam escritas (após `EIO`/`EROFS` só reiniciar o serviço libera).
- [ ] **Taxa de respostas 5xx e 409** nas rotas `/api/link-audit/**` (409 em leitura = integridade quebrada: **incidente**, não ruído).
- [ ] **429** (limitadores por operador: prévia 20/min, leituras de evidências e de resultados 30/min, decisões 30/min leitura e 20/min escrita, finalização 6/min). O limitador é **em memória**: reiniciar o serviço o zera; com mais de uma réplica cada processo tem o seu.
- [ ] Logs sem corpo de requisição, sem justificativa de decisão e sem e-mail além do necessário; revisar o que o Next registra em erro 500.
- [ ] Um alerta de **volume de recibos inacessível** (o sintoma é `ANCHOR_PENDING` em série).

## 7. Compatibilidade com Docker Swarm
- [ ] Uma réplica do web hoje (`replicas: 1`). Com mais de uma, a gravação continua segura entre processos **desde que** o volume seja **um único diretório local compartilhado com semântica POSIX** (`link()` exclusivo + `fsync`). **Não usar NFS/SMB** sem validar `link()` e `fsync` num teste dedicado.
- [ ] Binds de host (`type: bind`) com o caminho **fixado a um nó** (restrição de placement) ou armazenamento compartilhado validado; um bind sem placement pode subir noutro nó **vazio** e a auditoria "perder" o histórico (a leitura acusaria o fim ausente apenas se o recibo estivesse noutro volume íntegro).
- [ ] `update_config` com `order: stop-first` para o web (evita dois processos gravando durante a troca) ou aceitar a convivência por conta do `link()` exclusivo; decidir e registrar.
- [ ] O Worker **não** monta os volumes novos e **não** importa os módulos de decisões/resultados (isolamento já coberto por testes estáticos).

## 8. Atualização e rollback
- [ ] Atualização: `GUIA-DE-IMPLANTACAO.md` (começa por `scale ...=0` do Worker; `docker stack rm` só com autorização separada). Implantar **primeiro com os volumes e sem usar**, validar o 503/200 esperado, só então liberar o uso.
- [ ] Rollback: voltar a **imagem anterior** (tag guardada). Os arquivos já gravados **permanecem** e são compatíveis: a versão anterior simplesmente não os lê (as rotas novas somem). **Nunca** apagar `decisions/`, `results/` ou recibos no rollback.
- [ ] Antes de qualquer migração futura do formato (`MAPPER_VERSION`, régua), planejar leitura de **ambos** os formatos; hoje o código recusa o que não reconhece (fecha em falha).
- [ ] **Não** alterar a régua D3B nem o diretório `scoring/` sem nova rodada de aprovação (o diretório é idêntico à tag `v1.0.1`).

## 9. Riscos conhecidos que a operação precisa saber
- **Toda auditoria real sai INCONCLUSIVA** enquanto D5 não existir: cobertura 11% (automático) e **teto de 17%** com UTM comprovado + decisão humana, **abaixo do mínimo de 40%**. A tela mostra "Auditoria inconclusiva — evidências insuficientes para gerar o índice Lumos" e **não** mostra índice. A equipe não deve interpretar isso como defeito, nem prometer nota ao cliente.
- **Resultado PONTUADO só existe com fixture rica** (testes); em produção, até D5, ele não ocorre.
- **Leitor de arquivos e limitações legadas:** a leitura **não segue links simbólicos** (`lstat`) e recusa arquivos acima de 2 MiB (`snapshot-store.ts`); coletas antigas (layout legado, `legacy: true`) são lidas com salvaguardas e exibidas como tal. Arquivos criados fora do código (cópia manual, `rsync` sem preservar modo) são recusados ou marcados; **nunca** copiar arquivos manualmente para dentro das pastas.
- **Imutabilidade é por convenção**, não por assinatura (ver §3).
- **Limitadores em memória** (ver §6) e **sessão** por cookie assinado: expirar no meio da tela leva ao login sem perder o que já foi gravado.
- **Acessibilidade:** não foi testada com leitor de tela real (NVDA/JAWS/VoiceOver), em outros navegadores nem em dispositivo físico (ver o relatório do I7). Não declarar conformidade WCAG completa.

## 10. Plano de teste ANTES de mudar a versão em produção
Tudo em **ambiente isolado primeiro**, depois, com autorização, numa **auditoria sintética criada para isso** (nunca sobre dados reais de cliente):
1. [ ] Suíte completa, `tsc` e build offline limpos no commit candidato (`scripts/run-isolated.sh …`).
2. [ ] Roteiros de navegador `scripts/browser/run.sh all` aprovados (I5, I6, I7) sobre **o mesmo commit** da imagem.
3. [ ] Revisão independente de segurança/integridade sem BLOCKER aberto.
4. [ ] Em **staging** (cópia isolada da pilha, sem dados reais, sem Serper): subir com os 4 volumes novos, rodar o fluxo ponta a ponta do I7 por uma pessoa da operação, **forçar** `ANCHOR_PENDING` (volume de recibos somente leitura) e recuperar, **forçar** `ENOSPC` e observar o alerta, **restaurar** um backup e ler.
5. [ ] Ensaio de **rollback** em staging (imagem anterior sobre os mesmos volumes, sem apagar nada).
6. [ ] Só então: janela de produção; **1)** volumes e variáveis, **2)** imagem nova com o Worker em 0, **3)** `VERIFICACAO-POS-DEPLOY.md` + itens de §1 (503/200), **4)** teste de escrita **apenas** numa auditoria sintética combinada, **5)** liberar o uso.
7. [ ] Pós-implantação (24 h): acompanhar §6; conferir que não há pendências nem 409.

## 11. O que este documento NÃO decide
Escolha de disco/destino dos recibos e dos backups, janela de manutenção, política de retenção e quem recebe os alertas são **decisões do responsável**; D5 e a Onda 7 (PDF) seguem **não autorizadas**.
