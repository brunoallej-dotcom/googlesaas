# GMN Intelligence Platform — Prospecção de Fronteira & Orquestrador Maestro

Arquitetura completa em **Next.js 15+ (App Router)**, **TypeScript Estrito**, **PostgreSQL (Supabase)** e **BullMQ (Redis)** para prospecção de fronteira, auditoria técnica multi-agente e inteligência georreferenciada de posicionamento no Google Meu Negócio (GMN).

---

## Estrutura de Diretórios Criada

```text
gmn-intelligence-platform/
├── package.json
├── tsconfig.json
├── next.config.ts
├── tailwind.config.ts
├── postcss.config.mjs
├── .env.example
├── supabase/
│   └── migrations/
│       └── 001_gmn_schema.sql          # Tabelas relacionais + Histórico Mensal da Grade 49 Pontos
└── src/
    ├── types/
    │   └── gmn.ts                      # Contratos TypeScript estritos entre os 8 agentes
    ├── lib/
    │   ├── logger.ts                   # Logger JSON estruturado com correlationId e latência
    │   ├── resilience.ts               # Retry (3x) com backoff exponencial, timeout e concorrência
    │   ├── redis.ts                    # Conexão singleton IORedis otimizada para BullMQ
    │   └── supabase.ts                 # Repositório PostgreSQL + cálculo histórico de evolução
    ├── agents/
    │   ├── head-prospector.ts          # Módulo 1: Head Agent (10 leads na fronteira 1ª/2ª pág)
    │   ├── reputation-agent.ts         # Agente 1: Nota, total reviews, % resposta e ritmo 30d
    │   ├── vitrine-agent.ts            # Agente 2: Fotos, vídeos, fotos de clientes, último post
    │   ├── battlefield-agent.ts        # Agente 3: Matriz 7x7 (49 pts), ID estrito, S/L cinza, histórico
    │   ├── rivals-agent.ts             # Agente 4: Dominadores reais (#1 da grade, sem diretórios)
    │   ├── judge-agent.ts              # Agente 5: Checklist 21 itens + Regra Exceção SAB (Endereço Oculto)
    │   ├── strategist-agent.ts         # Agente 6: Diagnóstico executivo e Ondas Táticas P0–P3
    │   ├── reviewer-agent.ts           # Agente 7: Auditoria matemática estrita contra ficha bruta
    │   ├── diagrammer-agent.ts         # Agente 8: Compilação de PDF de alta conversão (PDFKit)
    │   └── maestro-orchestrator.ts     # Orquestrador Maestro (paralelo controlado + loop Revisor)
    ├── queues/
    │   └── audit-queue.ts              # Fila assíncrona BullMQ (evita timeouts HTTP)
    ├── workers/
    │   └── audit-worker.ts             # Worker dedicado BullMQ em background
    └── app/
        ├── layout.tsx
        ├── page.tsx                    # Dashboard Operacional Next.js 15
        ├── globals.css
        └── api/
            ├── prospect/route.ts       # POST /api/prospect
            └── audit/
                ├── enqueue/route.ts    # POST /api/audit/enqueue
                └── [id]/
                    ├── status/route.ts # GET /api/audit/[id]/status
                    └── pdf/route.ts    # GET /api/audit/[id]/pdf
```

---

## Como Executar em Produção / Desenvolvimento Local

1. **Configurar variáveis de ambiente:**
   ```bash
   cp .env.example .env.local
   ```
2. **Aplicar a migration no Supabase (PostgreSQL):**
   Execute o conteúdo de `supabase/migrations/001_gmn_schema.sql` no SQL Editor do Supabase.
3. **Instalar dependências e iniciar o servidor Next.js 15 + Worker BullMQ:**
   ```bash
   npm install
   npm run dev
   # Em outro terminal para o processamento de filas BullMQ:
   npm run worker
   ```

---

## Correção da captura de leads (15/10/2026)

A captura agora remove resultados repetidos considerando `place_id` e `cid` entre todas
as posições da pesquisa, **inclusive quando a segunda página repete empresas da primeira**.
O algoritmo prioriza a faixa 15–28 e, quando precisa repor um resultado duplicado, pode
continuar até a posição 40. A campanha só é gravada se houver **10 estabelecimentos únicos
com identificador válido**. Se houver menos de 10, o sistema retorna uma mensagem explicativa
e não cria uma campanha vazia.

O Head Agent pode tentar DataForSEO quando a Serper retornar menos de dez resultados
únicos e DataForSEO estiver configurado. O Supabase mantém a restrição de unicidade;
**não é necessário executar migrations novas para essa correção**.

### Dados de demonstração

O projeto antigo podia retornar empresas fictícias automaticamente quando as APIs falhavam.
Agora isso é desligado por padrão. Para testar propositalmente com **dados simulados**,
configure `GMN_DEMO_MODE=true` no seu `.env.local`. Para prospecção real, remova a variável
ou use `GMN_DEMO_MODE=false` e configure a `SERPER_API_KEY` ou credenciais do DataForSEO.
Os dados simulados **não representam estabelecimentos reais**.

### Testes

```bash
npm install
npm run typecheck
npm test
npm run dev
# Em outro terminal, se usar auditoria assíncrona:
npm run worker
```

O arquivo `.env.local` não está incluído no ZIP corrigido. Mantenha o seu arquivo local,
sem compartilhá-lo publicamente. Não inclua `node_modules` ou `.next` em arquivos compartilhados.

### Observações de auditoria técnica (fora do escopo desta correção)

- No código original, `gmn_audits` recebe atualizações, mas a rota de enfileiramento
  não insere a auditoria antes de executá-la. A progressão via worker separado pode
  não ser refletida corretamente no dashboard; esse fluxo merece uma correção própria.
- O enfileirador original ignora Redis quando `REDIS_URL` contém `localhost`,
  executando fallback no processo web. Iniciar o Worker, isoladamente, não prova que
  jobs estejam chegando à fila.
- Alguns campos recebidos da Serper ainda usam valores padrão estimados quando a
  API omite metadados; trate esses campos como não verificados antes de comercializar auditorias.
