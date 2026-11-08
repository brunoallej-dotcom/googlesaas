-- ============================================================================
-- SEED 100% FICTÍCIO DO LABORATÓRIO (homologação do G5/RLS)
-- Spec: docs/specs/g5-homologacao-funcional.md
--
-- SOMENTE para o projeto Supabase DESCARTÁVEL do laboratório. NUNCA rode na produção:
-- o próprio script se recusa (guarda 1), e também se recusa em qualquer banco que já tenha
-- linhas que não sejam deste seed (guarda 2).
--
-- COMO USAR: Supabase (projeto do LABORATÓRIO) → SQL Editor → New query → cole TODO este arquivo → Run.
-- Confira antes o nome e o identificador do projeto. Pré-requisito: migrations 001 e 002 aplicadas.
--
-- É UM ÚNICO bloco DO (atômico: qualquer erro desfaz tudo). Só INSERT ... ON CONFLICT DO NOTHING:
-- pode ser repetido sem duplicar. Sem UPDATE, DELETE, TRUNCATE, DDL nem GRANT.
--
-- Conteúdo (tudo inventado): 2 campanhas, 4 leads, 2 auditorias (FAILED, sem payload, para não gerar
-- ruído em db:check e validate:recovery), 2 rodadas e 98 pontos (49 por rodada). Todos os ids começam
-- com "1ab"; nomes e cidades terminam em "(LAB)"; URLs só em ".invalid"; telefones só zeros;
-- coordenadas no oceano, perto de (0,01; 0,01). Nenhuma empresa, pessoa ou lugar real.
--
-- Fórmula dos 49 pontos (i = 0..48; linha = i/7, coluna = i%7):
--   i = 48                  -> UNREADABLE, sem posição, GRAY_UNREADABLE, 3 tentativas
--   i % 10 = 9 (9,19,29,39) -> VALID, sem posição, INVISIBLE
--   demais                  -> posição (i%9)+1: 1..3 GREEN_TOP3, 4..7 YELLOW_TOP7, 8..9 RED_8_TO_20
--   => por rodada: verdes 15, amarelos 19, vermelhos 10, invisíveis 4, ilegíveis 1, válidos 48.
--      Agregados no cálculo do app (computeTerritoryRankMetrics): denominador = 48 pontos VÁLIDOS; average_position é o
--      ÍNDICE de posição, com "fora do Top 20" valendo 21: (221 + 4 x 21) / 48 = 6,35; top3 15/48 = 31,3%;
--      top7 34/48 = 70,8%; invisibilidade 4/48 = 8,3% (1 casa decimal, como o app grava).
-- Contagens esperadas depois de rodar: campanhas 2, leads 4, auditorias 2, rodadas 2, pontos 98.
-- ============================================================================
do $seed$
begin
  -- 1) Guarda: recusa o projeto de PRODUÇÃO (impressão digital dos buckets, medida nas auditorias de 17/10 e 07/11).
  if exists (
    select 1 from storage.buckets
    where (id = 'gmn-audit-pdfs' and created_at = '2026-10-15 15:43:13.881668+00')
       or (id = 'gmn-audit-pdfs-private' and created_at = '2026-10-16 23:42:25.477441+00')
  ) then
    raise exception 'SEED ABORTADO: este é o projeto de PRODUCAO (impressao digital dos buckets); nada foi alterado.';
  end if;

  -- 2) Guarda: recusa qualquer banco que já tenha linha que não seja deste seed (dados reais ou de outro teste).
  if exists (select 1 from public.prospecting_campaigns where id::text not like '1ab0c000-%')
     or exists (select 1 from public.gmn_leads where id::text not like '1ab01ead-%')
     or exists (select 1 from public.gmn_audits where id::text not like '1ab0a0d1-%')
     or exists (select 1 from public.gmn_battlefield_rounds where id::text not like '1ab0b0a4-%')
     or exists (select 1 from public.gmn_battlefield_points where id::text not like '1ab09017-%')
  then
    raise exception 'SEED ABORTADO: ha linhas que nao sao deste seed (dados reais ou de outro teste); nada foi alterado.';
  end if;

  -- 3) Campanhas
  insert into public.prospecting_campaigns (id, city, state_code, niche_keyword, center_lat, center_lng, total_captured, status) values
    ('1ab0c000-0000-4000-8000-000000000001', 'Cidade Fictícia Alfa (LAB)', 'XX', 'Categoria Fictícia (LAB)', 0.010000, 0.010000, 2, 'COMPLETED'),
    ('1ab0c000-0000-4000-8000-000000000002', 'Cidade Fictícia Beta (LAB)', 'XX', 'Serviço Fictício (LAB)', 0.020000, 0.020000, 2, 'COMPLETED')
  on conflict do nothing;

  -- 4) Leads (frontier_rank 11..40; frontier_page 1 ou 2; place_id único por campanha)
  insert into public.gmn_leads (id, campaign_id, place_id, cid, feature_id, business_name, primary_category, frontier_rank, frontier_page, rating, total_reviews, phone_raw, whatsapp_status, website_status, website_url, address_raw, latitude, longitude, description_text) values
    ('1ab01ead-0000-4000-8000-000000000001', '1ab0c000-0000-4000-8000-000000000001', 'LAB-FICT-PLACE-0001', 'LAB-FICT-CID-0001', 'LAB-FICT-FID-0001', 'Empresa Fictícia 01 (LAB)', 'Categoria Fictícia (LAB)', 11, 1, 4.20, 12, null, 'MISSING', 'MISSING', null, 'Rua Fictícia 01, Cidade Fictícia Alfa (LAB)', 0.010100, 0.010100, 'Registro fictício do laboratório; não representa nenhuma empresa real.'),
    ('1ab01ead-0000-4000-8000-000000000002', '1ab0c000-0000-4000-8000-000000000001', 'LAB-FICT-PLACE-0002', 'LAB-FICT-CID-0002', 'LAB-FICT-FID-0002', 'Empresa Fictícia 02 (LAB)', 'Categoria Fictícia (LAB)', 18, 1, 3.80, 7, '(00) 0000-0000', 'LANDLINE_ONLY', 'OWN_DOMAIN', 'https://empresa-ficticia-02.example.invalid', 'Rua Fictícia 02, Cidade Fictícia Alfa (LAB)', 0.009900, 0.010200, 'Registro fictício do laboratório; não representa nenhuma empresa real.'),
    ('1ab01ead-0000-4000-8000-000000000003', '1ab0c000-0000-4000-8000-000000000002', 'LAB-FICT-PLACE-0003', 'LAB-FICT-CID-0003', 'LAB-FICT-FID-0003', 'Empresa Fictícia 03 (LAB)', 'Serviço Fictício (LAB)', 25, 2, 4.50, 31, null, 'MISSING', 'SOCIAL_LINK_ONLY', 'https://rede-social.example.invalid/empresa-ficticia-03', 'Rua Fictícia 03, Cidade Fictícia Beta (LAB)', 0.020100, 0.019800, 'Registro fictício do laboratório; não representa nenhuma empresa real.'),
    ('1ab01ead-0000-4000-8000-000000000004', '1ab0c000-0000-4000-8000-000000000002', 'LAB-FICT-PLACE-0004', 'LAB-FICT-CID-0004', 'LAB-FICT-FID-0004', 'Empresa Fictícia 04 (LAB)', 'Serviço Fictício (LAB)', 33, 2, 4.00, 19, '(00) 0000-0000', 'LANDLINE_ONLY', 'OWN_DOMAIN', 'https://empresa-ficticia-04.example.invalid', 'Rua Fictícia 04, Cidade Fictícia Beta (LAB)', 0.019900, 0.020300, 'Registro fictício do laboratório; não representa nenhuma empresa real.')
  on conflict do nothing;

  -- 5) Auditorias FAILED sem payload (place_id igual ao do lead)
  insert into public.gmn_audits (id, lead_id, place_id, target_keyword, interest_center_lat, interest_center_lng, status, progress_percent, current_agent, error_message) values
    ('1ab0a0d1-0000-4000-8000-000000000001', '1ab01ead-0000-4000-8000-000000000001', 'LAB-FICT-PLACE-0001', 'Categoria Fictícia (LAB)', 0.010000, 0.010000, 'FAILED', 0, 'MAESTRO_INIT', 'Registro fictício do laboratório (sem coleta real).'),
    ('1ab0a0d1-0000-4000-8000-000000000002', '1ab01ead-0000-4000-8000-000000000003', 'LAB-FICT-PLACE-0003', 'Serviço Fictício (LAB)', 0.020000, 0.020000, 'FAILED', 0, 'MAESTRO_INIT', 'Registro fictício do laboratório (sem coleta real).')
  on conflict do nothing;

  -- 6) Rodadas (total_points = 49; agregados da fórmula do cabeçalho)
  insert into public.gmn_battlefield_rounds (id, audit_id, lead_id, place_id, keyword_pure, center_lat, center_lng, total_points, valid_points_count, unreadable_points_count, green_top3_count, yellow_top4_to_7_count, red_rank8_to_20_count, invisible_count, average_position, top3_percentage, top7_percentage, invisibility_percentage) values
    ('1ab0b0a4-0000-4000-8000-000000000001', '1ab0a0d1-0000-4000-8000-000000000001', '1ab01ead-0000-4000-8000-000000000001', 'LAB-FICT-PLACE-0001', 'categoria fictícia (lab)', 0.010000, 0.010000, 49, 48, 1, 15, 19, 10, 4, 6.35, 31.3, 70.8, 8.3),
    ('1ab0b0a4-0000-4000-8000-000000000002', '1ab0a0d1-0000-4000-8000-000000000002', '1ab01ead-0000-4000-8000-000000000003', 'LAB-FICT-PLACE-0003', 'serviço fictício (lab)', 0.020000, 0.020000, 49, 48, 1, 15, 19, 10, 4, 6.35, 31.3, 70.8, 8.3)
  on conflict do nothing;

  -- 7) Pontos: 49 por rodada, pela fórmula do cabeçalho (passo de 500 m ~ 0,0045 grau; ids 1ab09017-...-<rodada*100+i>)
  insert into public.gmn_battlefield_points (id, round_id, point_index, row_index, col_index, latitude, longitude, distance_from_center_meters, read_status, attempts_made, target_rank, visual_tier, leader_place_id, leader_business_name, leader_primary_category, leader_rating, leader_total_reviews)
  select
    ('1ab09017-0000-4000-8000-' || lpad((r.n * 100 + g.i)::text, 12, '0'))::uuid,
    r.id,
    g.i,
    g.i / 7,
    g.i % 7,
    (r.lat + ((g.i / 7) - 3) * 0.0045)::double precision,
    (r.lng + ((g.i % 7) - 3) * 0.0045)::double precision,
    round(sqrt((((g.i / 7) - 3) * 500) ^ 2 + (((g.i % 7) - 3) * 500) ^ 2)::numeric, 2),
    case when g.i = 48 then 'UNREADABLE' else 'VALID' end,
    case when g.i = 48 then 3 else 1 end,
    case when g.i = 48 or g.i % 10 = 9 then null else (g.i % 9) + 1 end,
    case
      when g.i = 48 then 'GRAY_UNREADABLE'
      when g.i % 10 = 9 then 'INVISIBLE'
      when (g.i % 9) + 1 <= 3 then 'GREEN_TOP3'
      when (g.i % 9) + 1 <= 7 then 'YELLOW_TOP7'
      else 'RED_8_TO_20'
    end,
    case when g.i = 48 then null else 'LAB-FICT-LEADER-' || lpad(g.i::text, 2, '0') end,
    case when g.i = 48 then null else 'Concorrente Fictício ' || lpad(g.i::text, 2, '0') || ' (LAB)' end,
    case when g.i = 48 then null else 'Categoria Fictícia (LAB)' end,
    case when g.i = 48 then null else 4.00 end,
    case when g.i = 48 then null else 10 end
  from (values (1, '1ab0b0a4-0000-4000-8000-000000000001'::uuid, 0.010000, 0.010000), (2, '1ab0b0a4-0000-4000-8000-000000000002'::uuid, 0.020000, 0.020000)) as r(n, id, lat, lng)
  cross join generate_series(0, 48) as g(i)
  on conflict do nothing;
end
$seed$;
