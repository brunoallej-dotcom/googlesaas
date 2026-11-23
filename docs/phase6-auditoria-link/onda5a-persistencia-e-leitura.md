# Fase 6 · Onda 5A — Persistência automática das evidências e contrato de leitura para a interface

Status: implementada em 22/10/2026. **Nenhuma chamada externa** (Serper, Google, site da AUD-001); nenhum crédito consumido; LIVE não executado; `.env.local` intocado; sem migrations, Supabase, Redis, pontuação Lumos, PDF, IA ou coleta pela interface. Metodologia: reconstrução `lumos-reconstruida-v1`; D3, D4, D5 pendentes.

## 1. Um único mecanismo de gravação
O serviço novo (`src/lib/link-audit-evidence/`) grava exclusivamente por `publishExclusive` (`src/lib/link-audit/snapshot-store.ts`), a rotina que a Onda 2 validou em `/mnt/d`: temporário exclusivo (`wx`) + `fsync` + somente leitura + `link()` exclusivo para o nome final (sem `link`, criação exclusiva do final; nunca substitui) + limpeza. Ela foi **extraída de `freezeSnapshot` sem mudar o comportamento** (40 testes de snapshot passam) e é usada pelos dois armazenamentos. O comando legado `link-audit:evidence` (pasta de trabalho + `rename`) continua só para capturas planas antigas; as novas coletas **não** o usam.

## 2. Layout (cada arquivo é imutável e publicado de uma vez)
```
<base>/<auditId>/c0001.capture.json         resposta ORIGINAL (bodyText exato, status, tentativas, créditos, pedido sem segredos, identidade de entrada)
<base>/<auditId>/c0001.site.json            observação do site (opcional)
<base>/<auditId>/c0001.report-r0001.json    relatório derivado (r0002… nunca sobrescrevem)
```
Todos trazem `schemaVersion`, `kind`, `methodologyVersion` (`lumos-reconstruida-v1`), data e `contentSha256` (SHA-256 do JSON canônico). **O hash detecta alteração acidental ou inconsistência; não é assinatura criptográfica de autenticidade.** `auditId` = id da autorização em minúsculas (8–64, `[a-z0-9_-]`). Duplicata (mesmo `bodySha256`) devolve a captura existente sem gravar outra; corrida entre escritores resolve-se por `link()` exclusivo (números distintos). O corpo é guardado como **texto UTF-8 decodificado** da resposta.

## 3. Falhas e segurança
- `STORAGE_FATAL` em **EIO/EROFS**: a base fica bloqueada para escrita (inclusive pré-voo, site e relatório) e nenhuma outra escrita é tentada; ENOSPC e afins são `WRITE_FAILED` (a base continua utilizável). Temporário órfão nunca vira captura (`.tmp-…` listado como órfão; limpeza só do padrão e com idade mínima).
- Segredos: toda gravação é varrida; o corpo bruto do provedor só é barrado por chave/cabeçalhos de autenticação (é a evidência original), o restante também pelos padrões de `redactSecrets`. Achou ⇒ `SECRET_DETECTED`, nada é gravado. Nunca se grava cabeçalho, cookie ou a chave.
- Base proibida em `public/`, `src/`, `.next/`, `node_modules/` do projeto; `auditId` com `..`, barra, maiúsculas ou pasta que seja symlink são recusados.
- **Pré-voo** (`checkStorage`): cria a base, resolve o caminho real, sonda `wx` + releitura + `link()` + remoção. Falhou ⇒ operação **bloqueada**.
- **Limites de `/mnt/d` (drvfs/9p):** sem metadados Linux (`chmod` e `0o600` sem efeito); `fsync`/`link()` de melhor esforço; a ACL do Windows **não é verificável pelo Node** (a pasta deve estar restrita antes — ver a Onda 4D); cópia no mesmo disco **não é backup independente**.

## 4. Integração automática (somente LIVE; todas as travas anteriores continuam)
1. `--evidence-dir` é **obrigatório** no LIVE (sem ele, recusa antes de ler o ambiente) e o **pré-voo roda antes de a autorização ser consumida**: armazenamento indisponível ⇒ `STORAGE_NOT_READY`, nada é gasto.
2. O provedor Serper entrega ao gancho `onCapture` (status, corpo, falha; **nunca cabeçalhos nem a chave**) logo após ler a resposta; a captura é gravada **imediatamente**, antes da verificação do site.
3. O resultado do site vira `cNNNN.site.json`; o relatório é gerado pelo **mesmo** `buildReportFromCapture` do replay offline e gravado como `rNNNN`. A saída do comando é o relatório **armazenado**.
4. Falha ao gravar a resposta paga ⇒ mensagem explícita ("A resposta paga NÃO foi persistida…") e **código de saída 5**; nunca silenciosa. Toda tentativa paga deixa rastro (também erro HTTP e falha de rede).

## 5. Contrato de leitura para a interface (sem endpoint)
`createEvidenceReader({ baseDir, authorize })` (`reader.ts`): `listAudits(actor)`, `getAudit(actor, auditId, {capture?, revision?})`, `listVersions(actor, auditId)`. Todo método exige `authorize(actor)` (falha fechada; erro ⇒ negado) e lança `EvidenceAccessError`. Uma rota futura deve: autenticar com `requireOperator`, passar o e-mail como `actor`, injetar `isOperatorAllowed` (`src/lib/auth/guard.ts`) e aplicar `api-limits`. As visões trazem: empresa, data da coleta, identificadores (link × derivado × retornado × confirmado), dados do perfil e do site (separados), evidências **verificadas × não verificadas** com origem/data/limitação, limitações, fonte (**Serper, intermediário; não é a API oficial do Google**), HTTP/tentativas/créditos, metodologia, `scoring: NOT_AVAILABLE_PENDING_D3`, integridade (aviso "hash ≠ assinatura") e o histórico de capturas/revisões. **O corpo bruto nunca sai** (nem existe nos tipos), nem caminhos do disco; tudo passa por `sanitizeForOutput`. Adaptador **LEGACY** (somente leitura) para a pasta plana da AUD-001 (inclui `report.v1-superseded.json` como revisão superada).

## 6. Verificação
`npm test` 728/728, typecheck e build ok; `npm test` com captura de sockets/DNS/`fetch` externos: 0 tentativas; pasta `<EVIDENCIAS_PRIVADAS>` e cópia em `C:` com SHA-256 **idênticos antes e depois**; leitura da captura real da AUD-001 (CID `<CID>`, 8 evidências verificadas, 11 não verificadas, HTTP 200, 1 tentativa, 3 créditos) sem modificar nada; hashes de produção alterados só nos arquivos previstos (prospecção, Juiz, `site-check`, `url-safety`, `serper-reviews`, `maps-link`, `snapshot.ts`, `canonical.ts` intactos); `.env.local` inalterado.

## 7. Riscos e limites
Corpo guardado como texto decodificado; lock em memória não coordena processos (a exclusividade vem do `link()`); ACL e backup independente fora do alcance do código; o comando de coleta LIVE agora exige `--evidence-dir` (mudança deliberada); a futura rota de leitura ainda precisa de autenticação, limitação e revisão; D3, D4, D5 e a coleta pela interface seguem abertas.

## 8. Revisão independente (subagente de contexto limpo, somente leitura)
Sem achados graves. Corrigidos (médios e baixos):
- **A resposta paga nunca é descartada por suspeita de segredo** (era o risco principal): a varredura da parte PRÓPRIA (link, identidade, pedido) roda no pré-voo, **antes de pagar** (e o link é gravado saneado, sem `ved`/`ictx`/tokens); no corpo do provedor a chave literal ecoada é trocada por `[REDACTED]` e padrões de autenticação em texto legítimo ("Cookie: …") só são **sinalizados** (`flags`).
- `--evidence-dir`: a raiz do projeto é fixa (`scripts/..`), não o diretório atual, e a comparação das pastas proibidas ignora a caixa (drvfs/Windows).
- Falhas depois do pagamento nunca somem: relatório não gerado vira **AVISO** (saída 4, captura preservada), resposta/relatório não gravados viram **ERRO** (saída 5); `collectEvidence` com falha após pagar devolve `persisted`; os códigos de saída estão documentados (0 ok · 1 uso · 2 link · 3 recusado antes de qualquer chamada · 4 falha/relatório não gerado · 5 persistência incompleta).
- O índice público do serviço exporta só o leitor autorizado (o `store`, que lê o corpo bruto, é interno ao runtime).
- Mensagens de erro nunca trazem caminhos do disco; o bloqueio fatal (EIO/EROFS) vale também por apelido/symlink da mesma pasta; a limpeza de órfãos respeita lock, bloqueio e idade mínima de 60 s.
- Leitor: relatório legado sem hash declarado deixa de contar como íntegro; `SHA256SUMS` hostil é deduplicado e limitado; pasta de auditoria que é symlink é recusada; métodos funcionam desestruturados.
- Pré-voo recusa `auditId` igual ao de uma pasta legada (não mistura formatos).
**Aceitos:** a máscara de `sanitizeForOutput` é ampla (chaves com `token`/`session`… saem `[REDACTED]`); lock em memória não coordena processos (a exclusividade vem do `link()`); o teste da captura real é ignorado quando a pasta não existe na máquina.

## Atualização da Onda 5B (22/10/2026)
O leitor passou a ser consumido por rotas de leitura autenticadas e pela área "Auditorias armazenadas"; novas regras no leitor: nada é exibido se qualquer arquivo da coleta não confere; symlink/arquivo na raiz é ignorado. Ver `onda5b-visualizacao-das-evidencias.md`.
