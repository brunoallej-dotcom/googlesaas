# Implantação — prova de ORIGEM e prova de COLETA da Auditoria por Link

> **Status: SOMENTE DOCUMENTAÇÃO.** `stack.yml`, `Dockerfile` e `docker-entrypoint.sh` **NÃO foram alterados**; nada foi feito na VPS; **nenhum valor real** consta aqui (apenas nomes de variáveis e `<placeholders>`). Tudo abaixo é o que será **necessário** antes da primeira implantação do módulo. Referências: `docs/phase6-auditoria-link/onda6c-runbook-chaves.md`, `…-adr-prova-de-origem.md`, `…-adr-proveniencia-evidencias.md`, `…-checklist-producao.md`.

## 1. Variáveis (nomes) e onde ficam

| Nome | O que é | Segredo? | Onde |
|---|---|---|---|
| `GMN_LINK_AUDIT_ORIGIN_KEY` | Chave de ORIGEM: `<id>:<64 hex minúsculos de CSPRNG>` | **SIM** | `docker secret` → entrypoint → ambiente do **web** (nunca no Worker, nunca no `.env`) |
| `GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS` | Chaves **aposentadas** (rotação planejada): `<id>:<64 hex>:<AAAA-MM-DD>` | **SIM** (tem material) | idem, só durante a janela da rotação |
| `GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS` | **Ids** de chaves revogadas por comprometimento (sem material) | Não | `.env.production` |
| `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` | Chaves **públicas** de atestação de coleta: `<id>:<32 bytes base64url>` | Não | `.env.production` |
| `GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR` | Pasta **dos manifestos** de coleta (somente leitura para o web; separada da pasta de evidências) | Não | `stack.yml` (bind `:ro`) |

## 2. Como criar o segredo SEM expor o valor
- Gere o material **direto para o destino**, sem imprimir e sem gravar em arquivo comum nem em histórico do shell: por exemplo, canalize `openssl rand -hex 32` para o comando que cria o `docker secret` (o conteúdo do secret é `<id>:<hex>`; o `<id>` é um rótulo público como `ok-AAAA-MM-a`, **independente** do segredo).
- Registre **somente** o `<id>` e a data de criação no controle de mudanças. **Nunca** cole o valor em chat, ticket ou documento.
- Guarde uma cópia **cifrada** do segredo em cofre **separado dos dados** (perdê-lo torna inconcluíveis as pendências em andamento; o histórico confirmado segue legível).

## 3. Alterações de implantação NECESSÁRIAS (NÃO aplicadas nesta rodada)
1. **`docker-entrypoint.sh`:** hoje converte `*_FILE` em variáveis a partir de uma **lista fixa** (`SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY SERPER_API_KEY REDIS_URL`). Acrescentar `GMN_LINK_AUDIT_ORIGIN_KEY` (e, só na rotação, `GMN_LINK_AUDIT_ORIGIN_RETIRED_KEYS`) à lista — **somente no serviço web**.
2. **`stack.yml` (serviço web):** declarar o `docker secret` (externo) e a variável `GMN_LINK_AUDIT_ORIGIN_KEY_FILE: /run/secrets/<nome-do-secret>`; passar `GMN_LINK_AUDIT_EVIDENCE_TRUST_KEYS` e `GMN_LINK_AUDIT_ORIGIN_REVOKED_KEY_IDS` do `.env.production`; montar a pasta de manifestos **somente leitura** e definir `GMN_LINK_AUDIT_EVIDENCE_SEALS_DIR`. O **Worker não recebe** nenhuma destas variáveis.
3. **Pastas (host):** criar a pasta de manifestos (0700, uid 10001, **fora** da pasta de evidências e de qualquer outra), com backup próprio; escrita **só** por quem atesta (fora da VPS).
4. **Primeira implantação já com esta versão** (arquivos com `origin` não são lidos pela versão anterior; a versão anterior também não tem o bloqueio de proveniência).

## 4. Comportamento esperado (para a verificação pós-deploy)
- **Sem `GMN_LINK_AUDIT_ORIGIN_KEY` válida:** decisão, revogação e finalização respondem **503** `ORIGIN_KEY_NOT_CONFIGURED`; leituras funcionam.
- **Sem manifesto/chave pública de coleta:** a prévia responde 200 com "Origem da coleta NÃO comprovada"; **a finalização responde 409 `NOT_FINALIZABLE`** — **isto é o estado esperado enquanto o produtor da prova não existir** (ADR 6C-03, §5 e §7).
- **Configuração contraditória** (id revogado ainda com material; chave fraca; lista malformada): escritas **503** (falha fechada), sem mensagem que revele material.

## 4b. Testemunha do histórico de decisões (R3-MINOR-2)
As rotas de **decisões** e de **prévia** leem as pastas de **resultados** (`GMN_LINK_AUDIT_RESULTS_DIR`, `GMN_LINK_AUDIT_RESULTS_ANCHOR_DIR`) apenas para conferir o histórico. **Elas são OBRIGATÓRIAS para as decisões:** sem as variáveis (ou com caminho relativo, as duas iguais ou sobrepostas às demais pastas, inexistentes ou ilegíveis) o histórico fica **NÃO resolvido** — `NOT_CONFIGURED`/`UNAVAILABLE` — e o sistema **falha fechado**: nenhuma decisão vigente, escritas de decisão recusadas (`409 DECISIONS_HISTORY_UNRESOLVED`), nada finalizável; a tela diz o motivo e só a consulta informativa continua. Se a cadeia de resultados estiver ilegível/adulterada (`UNTRUSTED`), idem — restaurar o **par** do mesmo instante a partir do backup. **Rotação de chave:** um resultado pendente cuja origem a chave de hoje não comprova **não** é testemunha, mas é um **indício**; se ele contradiz o histórico de decisões, o estado é `UNTRUSTED` (falha fechada). **Não** mover arquivos de decisão **nem resultados pendentes** para a quarentena sem ler `witness.status` e sem fonte independente (6B §15 item 3; ADR 6C-02 §4.5).

## 5. Proibido
Valores reais em `.env.production`, no repositório, em imagem, em `docker inspect` compartilhado, em log ou em documentação; reassinar registros antigos; manter material de chave revogada na configuração.
