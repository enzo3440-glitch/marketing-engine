-- Style references for the Reel Engine (Content → Video Engine → References).
-- Links (IG/TikTok/YouTube) stay links; dropped files are measured by the engine (POST /refs/analyze).
alter table ops.reel_refs
  add column if not exists title text,
  add column if not exists source text not null default 'link' check (source in ('instagram','tiktok','youtube','link','file','watchlist')),
  add column if not exists metrics jsonb not null default '{}',
  add column if not exists added_at timestamptz not null default now();
