-- Run in Supabase SQL Editor ONCE after migration 001.
-- Preserve Battlefield grid and Diagrammer output between Next.js and the worker.
ALTER TABLE public.gmn_audits
  ADD COLUMN IF NOT EXISTS battlefield_payload JSONB,
  ADD COLUMN IF NOT EXISTS diagrammer_payload JSONB;
