# Security Documentation

This directory holds security-related documentation for the project.

## Layout

- [`threats/`](threats/) — feature-level threat models (STRIDE)
  - [`_template.md`](threats/_template.md) — copy this to start a new threat model
- `policies/` — [CUSTOMIZE] add as needed (data retention, access control, incident response)
- `runbooks/` — [CUSTOMIZE] add as needed (security incident playbooks)

## When to write a threat model

Per the project's CLAUDE.md, run a quick STRIDE pass whenever the **attack
surface changes**:

- New public endpoint
- New third-party integration
- New sensitive data category (PII, PCI, credentials)
- New trust boundary
- Significant change to authn/authz flow

The `threat-modeler` subagent (`.claude/agents/threat-modeler.md`) can guide the
process. Save the output here as `docs/security/threats/<feature>.md`.

## Dados reais de cliente no repositório (política)

O repositório é **público**. Por decisão escrita do responsável (23/11/2026), os arquivos atuais foram saneados, o
histórico **não** foi reescrito (o que já foi publicado continua no histórico) e uma trava no CI impede que os dados
voltem.

- **Nada de dado real de cliente em arquivo versionado:** nome de empresa, CID, FID, placeId, endereço, telefone, site,
  cidade de um cliente, nem domínio/host/IP de produção, e-mail real ou caminho local de evidência privada.
- **Rótulos opacos:** a empresa vira `AUD-001` (em código, arquivo ou teste: `aud-001`); em documentos, identificadores
  viram marcadores como `<CID>`, `<FID>`, `<PLACE_ID>`, `<DOMINIO_PRODUCAO>`, `<EVIDENCIAS_PRIVADAS>`; em testes e
  fixtures, valores **sintéticos** e matematicamente consistentes (o CID é a 2ª metade do FID em decimal). O vínculo
  rótulo → dado real fica só no dossiê offline do responsável; não escreva tabela de correspondência em nenhum arquivo.
- **Ids novos de autorização e de auditoria são opacos** (ex.: `aud-002-autorizacao-01`), nunca derivados do nome da
  empresa, porque viram nomes de pasta, de arquivo e aparecem em logs e documentos.
- **Testes com a captura real** só a encontram por variáveis de ambiente definidas fora da árvore
  (`GMN_TEST_AUD001_BASE`, `GMN_TEST_AUD001_AUDIT`; ver `tests/helpers/link-audit-aud001-real-capture.ts`) e não fixam
  valores reais; sem a pasta, são ignorados.
- **Trava no CI:** `tests/repo-client-data-guard.test.ts` (job `test`) percorre os arquivos versionados e compara o
  SHA-256 com separação de domínio de cada token com uma lista fixa de hashes dos termos proibidos. A falha aponta
  arquivo:linha e o índice do termo, nunca o termo. Os hashes não escondem os termos (o histórico público já os contém):
  servem para não deixá-los em claro e impedir a volta. Para proibir um termo novo, calcule o hash fora da árvore e
  acrescente só o hash. Telefones são comparados só pelos dígitos e coordenadas com a precisão registrada.
- **O que o guardião não lê não entra:** PDF, documento de escritório (doc/docx/xls/xlsx/odt…), arquivo compactado,
  imagem (prints de painel são evidência de cliente), link simbólico, submódulo ou binário de tipo não reconhecido
  versionados fazem o CI falhar, salvo exceção explícita e justificada no próprio teste. Caminhos locais da máquina do
  responsável (backups, unidade externa, pastas de projeto) também viram marcadores, como `<DESTINO_BACKUP_LOCAL>` e
  `<UNIDADE_EXTERNA>`.

## See also

- [`SECURITY.md`](../../SECURITY.md) — vulnerability disclosure policy
- [`.claude/rules/security.md`](../../.claude/rules/security.md) — security rules Claude must follow
