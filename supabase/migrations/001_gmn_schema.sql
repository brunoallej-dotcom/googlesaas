-- ============================================================================
-- MIGRATION: 001_gmn_schema.sql
-- Sistema de Prospecção, Auditoria e Inteligência de Posicionamento GMN
-- Banco de Dados: PostgreSQL 15+ (Supabase)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Tabela de Campanhas de Prospecção (Head Agent)
CREATE TABLE IF NOT EXISTS public.prospecting_campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    city VARCHAR(120) NOT NULL,
    state_code VARCHAR(10) NOT NULL DEFAULT 'BR',
    niche_keyword VARCHAR(180) NOT NULL,
    center_lat DOUBLE PRECISION NOT NULL,
    center_lng DOUBLE PRECISION NOT NULL,
    total_captured INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_prospecting_campaigns_city_niche ON public.prospecting_campaigns(city, niche_keyword);

-- 2. Tabela de Leads Capturados na Fronteira (Final da 1ª Página / Início da 2ª Página)
CREATE TABLE IF NOT EXISTS public.gmn_leads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID NOT NULL REFERENCES public.prospecting_campaigns(id) ON DELETE CASCADE,
    place_id VARCHAR(128) NOT NULL,
    cid VARCHAR(64),
    feature_id VARCHAR(128),
    business_name VARCHAR(255) NOT NULL,
    primary_category VARCHAR(160) NOT NULL,
    secondary_categories TEXT[] NOT NULL DEFAULT '{}',
    frontier_rank INTEGER NOT NULL CHECK (frontier_rank BETWEEN 11 AND 40),
    frontier_page INTEGER NOT NULL CHECK (frontier_page IN (1, 2)),
    rating NUMERIC(3, 2) NOT NULL DEFAULT 0.00,
    total_reviews INTEGER NOT NULL DEFAULT 0,
    phone_raw VARCHAR(64),
    phone_e164 VARCHAR(32),
    whatsapp_status VARCHAR(32) NOT NULL CHECK (whatsapp_status IN ('VERIFIED_WHATSAPP', 'LIKELY_MOBILE_WHATSAPP', 'LANDLINE_ONLY', 'MISSING')),
    whatsapp_url TEXT,
    website_status VARCHAR(32) NOT NULL CHECK (website_status IN ('OWN_DOMAIN', 'SOCIAL_LINK_ONLY', 'MISSING')),
    website_url TEXT,
    address_raw TEXT,
    is_address_hidden BOOLEAN NOT NULL DEFAULT FALSE,
    is_service_area_business BOOLEAN NOT NULL DEFAULT FALSE,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    claimed_by_owner BOOLEAN NOT NULL DEFAULT FALSE,
    business_hours_configured BOOLEAN NOT NULL DEFAULT FALSE,
    attributes_count INTEGER NOT NULL DEFAULT 0,
    services_listed_count INTEGER NOT NULL DEFAULT 0,
    description_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(campaign_id, place_id)
);

CREATE INDEX idx_gmn_leads_place_id ON public.gmn_leads(place_id);
CREATE INDEX idx_gmn_leads_campaign_id ON public.gmn_leads(campaign_id);

-- 3. Tabela Principal de Auditorias Assíncronas (Orquestrador Maestro)
CREATE TABLE IF NOT EXISTS public.gmn_audits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    lead_id UUID NOT NULL REFERENCES public.gmn_leads(id) ON DELETE CASCADE,
    place_id VARCHAR(128) NOT NULL,
    bullmq_job_id VARCHAR(128),
    target_keyword VARCHAR(180) NOT NULL,
    interest_center_lat DOUBLE PRECISION NOT NULL,
    interest_center_lng DOUBLE PRECISION NOT NULL,
    grid_zoom VARCHAR(16) NOT NULL DEFAULT '15z',
    grid_step_meters INTEGER NOT NULL DEFAULT 500,
    status VARCHAR(32) NOT NULL DEFAULT 'QUEUED' CHECK (
        status IN (
            'QUEUED',
            'RUNNING_EXTRACTION',
            'RUNNING_RIVALS_AND_JUDGE',
            'RUNNING_STRATEGIST',
            'RUNNING_REVIEWER',
            'RUNNING_DIAGRAMMER',
            'COMPLETED',
            'FAILED'
        )
    ),
    progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
    current_agent VARCHAR(64) NOT NULL DEFAULT 'MAESTRO_INIT',
    reviewer_iterations INTEGER NOT NULL DEFAULT 0,
    reputation_payload JSONB,
    vitrine_payload JSONB,
    rivals_payload JSONB,
    judge_payload JSONB,
    strategist_payload JSONB,
    reviewer_audit_log JSONB,
    pdf_storage_path TEXT,
    pdf_download_url TEXT,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gmn_audits_lead_id ON public.gmn_audits(lead_id);
CREATE INDEX idx_gmn_audits_place_id_created ON public.gmn_audits(place_id, created_at DESC);

-- 4. Tabela de Rodadas Históricas do Campo de Batalha (Rastreamento Mensal de Evolução)
CREATE TABLE IF NOT EXISTS public.gmn_battlefield_rounds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    audit_id UUID NOT NULL UNIQUE REFERENCES public.gmn_audits(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES public.gmn_leads(id) ON DELETE CASCADE,
    place_id VARCHAR(128) NOT NULL,
    keyword_pure VARCHAR(180) NOT NULL,
    center_lat DOUBLE PRECISION NOT NULL,
    center_lng DOUBLE PRECISION NOT NULL,
    zoom_level VARCHAR(16) NOT NULL DEFAULT '15z',
    step_meters INTEGER NOT NULL DEFAULT 500,
    total_points INTEGER NOT NULL DEFAULT 49 CHECK (total_points = 49),
    valid_points_count INTEGER NOT NULL DEFAULT 0,
    unreadable_points_count INTEGER NOT NULL DEFAULT 0,
    green_top3_count INTEGER NOT NULL DEFAULT 0,
    yellow_top4_to_7_count INTEGER NOT NULL DEFAULT 0,
    red_rank8_to_20_count INTEGER NOT NULL DEFAULT 0,
    invisible_count INTEGER NOT NULL DEFAULT 0,
    average_position NUMERIC(5, 2) NOT NULL DEFAULT 21.00,
    top3_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    top7_percentage NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    invisibility_percentage NUMERIC(5, 2) NOT NULL DEFAULT 100.00,
    previous_round_id UUID REFERENCES public.gmn_battlefield_rounds(id) ON DELETE SET NULL,
    previous_green_top3_count INTEGER,
    green_points_delta INTEGER,
    previous_average_position NUMERIC(5, 2),
    average_position_delta NUMERIC(5, 2),
    executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_battlefield_rounds_place_keyword ON public.gmn_battlefield_rounds(place_id, keyword_pure, executed_at DESC);

-- 5. Tabela dos 49 Pontos Individuais da Matriz 7x7 do Campo de Batalha
CREATE TABLE IF NOT EXISTS public.gmn_battlefield_points (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    round_id UUID NOT NULL REFERENCES public.gmn_battlefield_rounds(id) ON DELETE CASCADE,
    point_index INTEGER NOT NULL CHECK (point_index BETWEEN 0 AND 48),
    row_index INTEGER NOT NULL CHECK (row_index BETWEEN 0 AND 6),
    col_index INTEGER NOT NULL CHECK (col_index BETWEEN 0 AND 6),
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    distance_from_center_meters NUMERIC(8, 2) NOT NULL,
    read_status VARCHAR(24) NOT NULL CHECK (read_status IN ('VALID', 'UNREADABLE')),
    attempts_made INTEGER NOT NULL DEFAULT 1 CHECK (attempts_made BETWEEN 1 AND 3),
    target_rank INTEGER, -- NULL quando invisível (>20) ou UNREADABLE
    visual_tier VARCHAR(24) NOT NULL CHECK (
        visual_tier IN ('GREEN_TOP3', 'YELLOW_TOP7', 'RED_8_TO_20', 'INVISIBLE', 'GRAY_UNREADABLE')
    ),
    leader_place_id VARCHAR(128),
    leader_business_name VARCHAR(255),
    leader_primary_category VARCHAR(160),
    leader_rating NUMERIC(3, 2),
    leader_total_reviews INTEGER,
    leader_is_directory_filtered BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(round_id, point_index)
);

CREATE INDEX idx_battlefield_points_round_id ON public.gmn_battlefield_points(round_id);

-- Trigger automática para atualização de updated_at
CREATE OR REPLACE FUNCTION public.trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_gmn_leads_updated_at
    BEFORE UPDATE ON public.gmn_leads
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_set_updated_at();

CREATE TRIGGER set_gmn_audits_updated_at
    BEFORE UPDATE ON public.gmn_audits
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_set_updated_at();
