# Project: GMN Intelligence Platform

> Project memory. Auto-loaded by Claude Code at startup.
> Keep concise and up to date. Extensive content goes in `docs/` and is referenced from here.
> Process rules (spec → waves → NOTES.md, models & delegation, agent teams,
> quality gate, conventions, Definition of Done) are global and load
> automatically from `~/.claude/bootstrap/GLOBAL.md`.
> This file only lists what is project-specific or overrides the global.

Internal tool (not a SaaS) for Google Business Profile prospecting, multi-agent
audits ("Maestro"), geographic intelligence (7x7 grid) and "link audit" (Phase 6).
Living project memory — status, waves, hard rules — is in `NOTES.md`; read it first.

---

## Stack

- **Language**: TypeScript (strict) on Node `>=22`
- **Frontend / API**: Next.js `^15.1.6` (App Router), React `^19`, Tailwind `^3.4`, Leaflet / react-leaflet
- **DB**: PostgreSQL via Supabase (`@supabase/supabase-js`); migrations in `supabase/migrations/`
- **Queue / cache**: BullMQ + Redis (ioredis) — audit Worker in `src/workers/audit-worker.ts`
- **Validation**: zod `4.6.7` (pinned)
- **PDF**: pdfkit
- **Tests**: Node built-in test runner (`node --test`) with `tests/register-typescript.cjs`; no ESLint installed
- **CI/CD**: GitHub Actions (`.github/workflows/ci.yml`: npm ci, typecheck, test, build, gitleaks; no lint job because ESLint is not installed)
- **Hosting**: Docker images (`gmn-web`, worker) deployed to a Hostinger VPS (`deploy/hostinger/`)

## Commands

- Dev: `npm run dev` (UI); `npm run worker` (Worker, watch) / `npm run worker:prod`
- Test: `npm test`
- Lint: `npm run lint` (`next lint`; ESLint is NOT installed — expect it to be unusable until added)
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Isolated run (no external network, empty env): `scripts/run-isolated.sh <command>` — use it for tests/build
- Diagnostics (no cost, read-only): `npm run db:check`, `npm run validate:recovery`, `npm run rls:probe`
- Coverage: not configured
- Deploy staging: not defined
- Deploy prod: **CI only**. Local production deploys are forbidden; `deploy/hostinger/` holds the runbooks.

## Folder structure

- `src/app/` — Next.js routes and API handlers
- `src/agents/` — Maestro multi-agent logic
- `src/workers/`, `src/queues/` — BullMQ Worker and queues
- `src/lib/` — domain/service modules; Phase 6 lives in `src/lib/link-audit*/` (pure, isolated modules)
- `src/components/`, `src/types/`, `src/data/`, `src/middleware.ts`
- `supabase/migrations/` — versioned DB migrations (applied ones are immutable); `supabase/proposed/` — not yet applied
- `tests/` — test files; new files must be added to the `test` script in `package.json`
- `scripts/` — operational CLIs
- `deploy/hostinger/` — Docker, stack and deployment runbooks
- `docs/specs/` — feature specs · `docs/plan/` — waves · `docs/adr/` — ADRs · `docs/api/` — contracts · `docs/security/` — threat models
- `docs/phase4/`, `docs/phase5/`, `docs/phase6-auditoria-link/` — existing per-phase docs (kept as is)

## Architecture rules

- Pre-bootstrap code does **not** follow Vertical Slice / DDD folders; don't reorganize it.
  For new features, keep modules small, pure where possible, and isolated from other areas
  (Phase 6 is deliberately isolated from prospecting, Judge, grid, campaigns, PDFs and RLS).
- **Security by Design**: never log PII; secrets only via env vars; validate every external input
  with zod at the boundary; auth fail-closed (Supabase Auth + `GMN_OPERATOR_EMAILS`).
- Hard project rules (from `NOTES.md`): never modify `.env.local` automatically; no paid Serper
  query without explicit authorization (one audit = 49 queries); never invent data — unproven =
  `NOT_VERIFIED`; stored historical Judge scores are never recalculated; nothing historical
  (PDFs, audits) is deleted/moved/overwritten without authorization; no new paid services.
- Do not read or print `.env*`. Dev variables live outside the tree (see `NOTES.md`).
- Redis port 6379 on the host belongs to another project: never use it.

## Anti-patterns (do not do)

- ❌ Business logic in route handlers or UI components
- ❌ Real external calls (Serper, Supabase, network) from tests or without written authorization
- ❌ Swallowing errors without structured logging (`src/lib/logger.ts`)
- ❌ `any` without a justifying comment
- ❌ Manual DB changes via console — always versioned migration files
- ❌ Editing an applied migration or a lockfile by hand
- ❌ Hardcoded user-facing strings outside the existing UI conventions (pt-BR)
