# GMN Intelligence Platform — patch unificado Maestro + WhatsApp

Este ZIP substitui o patch anterior `correcao-maestro-battlefield.zip`.
Ele inclui as correções do Maestro/Battlefield/BullMQ **e** a exibição do telefone e do WhatsApp na tabela.

## O que foi corrigido no WhatsApp

- O telefone do Google Maps (`phoneRaw` / `phoneE164`) aparece na coluna **Telefone / WhatsApp**.
- Quando existe um celular brasileiro válido, o botão **Testar no WhatsApp** abre `wa.me` com o número. Isso **não é confirmação** de conta ativa.
- Quando a ficha fornece um link público de WhatsApp reconhecido (`wa.me`, `wa.link`, `api.whatsapp.com`, `web.whatsapp.com`), a interface permite abri-lo. Links maliciosos ou não pertencentes a esses domínios são descartados.
- Telefones fixos são apresentados para ligação, mas NÃO recebem link de WhatsApp inventado (a menos que exista um link público na ficha).
- Status agora são mostrados em português: “Link WhatsApp informado”, “Celular — não confirmado”, “Telefone fixo” e “Sem número identificado”.
- Validação dos telefones brasileiros normaliza DDI e DDD e evita a classificação de números com quantidade de dígitos inválida.

**Observação:** o valor técnico `VERIFIED_WHATSAPP` é mantido para compatibilidade com o banco existente, mas, no código atual, ele significa “foi encontrado um link público”, não validação real de existência da conta. Para confirmar o uso ativo do WhatsApp seria necessário um processo de verificação apropriado; o Google Maps/Serper, isoladamente, não fornece essa confirmação.

## Correções já incluídas do Maestro e Battlefield

- A rota `/api/audit/enqueue` cria o registro `gmn_audits` antes de enviar o job, evitando falha de chave estrangeira na matriz Battlefield.
- Redis localhost não é mais ignorado ao escolher BullMQ.
- Worker carrega o `.env.local`, mantendo credenciais consistentes com o Next.js.
- O progresso e mensagens de erro são persistidos e apresentados no frontend.
- Payloads Battlefield e Diagrammer são gravados em colunas JSONB.
- Retries automáticos completos foram desativados para evitar duplicação do grid 7x7; o usuário pode tentar novamente manualmente.

## Instalação Windows / VS Code (Disco D:)

1. Pare **Next.js e Worker** com Ctrl+C nos dois terminais.
2. Faça backup de arquivos que você modificou manualmente em `src/app/page.tsx` ou `src/agents/head-prospector.ts`, porque o ZIP substitui os arquivos listados.
3. No PowerShell, execute:

```powershell
$project = '<PASTA_PROJETO_V100>'
Expand-Archive "$env:USERPROFILE\Downloads\correcao-maestro-battlefield-whatsapp.zip" -DestinationPath $project -Force
Set-Location $project
npm run typecheck
npm test
```

4. No Supabase do projeto configurado em `.env.local`, execute o SQL a seguir **uma única vez** (pode repetir por `IF NOT EXISTS`):

```sql
ALTER TABLE public.gmn_audits
  ADD COLUMN IF NOT EXISTS battlefield_payload JSONB,
  ADD COLUMN IF NOT EXISTS diagrammer_payload JSONB;
```

5. Verifique o Redis:

```powershell
Test-NetConnection 127.0.0.1 -Port 6379
```

6. Inicie `npm run dev` no terminal 1 e `npm run worker` no terminal 2.
7. Recarregue `http://localhost:3000`, capture leads novamente e confira a coluna **Telefone / WhatsApp**. Uma nova busca aplica também a análise de status atualizada.

Não é necessário `npm install`: nenhum pacote novo foi adicionado. O ZIP não inclui nem modifica `.env.local`, chaves de API, `node_modules` ou `.next`.

## Validação

- TypeScript (`npm run typecheck`): OK.
- Testes (`npm test`): **17 aprovados**, incluindo telefone celular, fixo, link público e rejeição de links suspeitos.
- Build de produção não foi concluído neste ambiente: a dependência nativa do Next.js para Linux não está instalada, e a rede não permite baixá-la. Execute `npm run build` no seu Windows para validar o build nativo.
- Integração end-to-end com seu Supabase, Serper, Redis e serviços externos deve ser testada no seu computador.
