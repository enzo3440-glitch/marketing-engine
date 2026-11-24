-- Content tab: Reel Engine contract tables (reel-engine/references/contract.md),
-- migrated CMO Desk research, and the Marketing Map (whiteboard).

create table ops.reel_clips (
  id text primary key,
  file text not null,                -- path under the engine's input/
  source text not null default 'upload' check (source in ('upload','link','folder')),
  kind text check (kind in ('oneshot','broll','talking','podcast','screen','reference')),
  star boolean not null default false,
  tags text[] not null default '{}',
  thumb text,
  quality numeric,
  duration numeric,
  talking_likely boolean,
  added_at timestamptz not null default now()
);

create table ops.reel_refs (
  id text primary key,
  format text not null,
  url text,
  file text,
  notes text
);

create table ops.reel_hooks (
  id text primary key,               -- h12
  text text not null,
  framework text,                    -- F1-F10
  source text not null check (source in ('claude','radar','owner','map')),
  status text not null default 'new' check (status in ('new','testing','winner','retired')),
  created_at timestamptz not null default now()
);

create table ops.reel_jobs (
  job_id text primary key,
  status text not null check (status in ('queued','rendering','done','error')),
  created_at timestamptz not null default now(),
  request jsonb not null,            -- matrix / variants JSON as sent
  manifest jsonb,
  error text,
  stub boolean not null default false
);

create table ops.reel_variants (
  id text not null,
  job_id text not null references ops.reel_jobs(job_id) on delete cascade,
  format text,
  hook_id text,
  hook text,
  grade text,
  music text,
  file text,
  bare text,
  poster text,
  caption text,
  duration numeric,
  warnings jsonb not null default '[]',
  tags jsonb not null default '{}',
  picked boolean not null default false,
  primary key (job_id, id)
);

create table ops.reel_posts (
  id bigserial primary key,
  job_id text not null,
  variant_id text not null,
  platform text not null check (platform in ('ig','tiktok')),
  url text,
  sound text,                        -- trending sound added in-app, when the _bare cut was posted
  posted_at timestamptz,
  views int, avg_watch_s numeric, likes int, comments int, shares int, saves int, follows int,
  updated_at timestamptz not null default now(),
  foreign key (job_id, variant_id) references ops.reel_variants(job_id, id) on delete cascade
);

-- CMO Desk migration ----------------------------------------------------------
create table ops.cmo_snapshots (
  id bigserial primary key,
  observed_at timestamptz,
  exported_at timestamptz,
  imported_at timestamptz not null default now(),
  snapshot jsonb not null            -- full Reel Radar snapshot, preserved verbatim
);

create table ops.cmo_recommendations (
  id text primary key,
  kind text not null check (kind in ('trend','watchlist','paid_decision','creative_test','agent')),
  title text not null,
  hook text,
  body text,
  evidence text,
  confidence text,
  signal text,
  sources jsonb not null default '[]',
  status text not null default 'new' check (status in ('new','accepted','dismissed')),
  created_at timestamptz not null default now()
);

-- Marketing Map: one document, optimistic concurrency by revision.
create table ops.marketing_maps (
  id text primary key default 'main',
  revision int not null default 1,
  doc jsonb not null,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['reel_clips','reel_refs','reel_hooks','reel_jobs','reel_variants','reel_posts',
                           'cmo_snapshots','cmo_recommendations','marketing_maps'] loop
    execute format('alter table ops.%I enable row level security', t);
    execute format('create policy %I on ops.%I for all to authenticated using (ops.my_role() in (''ceo'',''marketing'')) with check (ops.my_role() in (''ceo'',''marketing''))', t || '_by_role', t);
  end loop;
end $$;

grant select, insert, update, delete on all tables in schema ops to authenticated;
grant all on all tables in schema ops to service_role;
grant usage, select on all sequences in schema ops to authenticated, service_role;
