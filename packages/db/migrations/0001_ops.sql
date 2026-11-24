-- Marketing Engine Desk core schema. All business data lives in schema `ops`.
create schema if not exists ops;
grant usage on schema ops to authenticated, service_role;

create table ops.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'eng' check (role in ('ceo','marketing','eng')),
  created_at timestamptz not null default now()
);

create table ops.integrations (
  provider text primary key,
  status text not null default 'not_configured' check (status in ('connected','error','not_configured')),
  last_sync_at timestamptz,
  last_error text,
  config jsonb not null default '{}'
);

create table ops.metrics_daily (
  date date not null,
  metric text not null,
  value numeric not null,
  source text not null,
  unique (date, metric, source)
);

create table ops.api_spend (
  id bigserial primary key,
  date date not null,
  provider text not null,
  model text not null,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  cost_usd numeric(12,4) not null default 0,
  unique (date, provider, model)
);

create table ops.incidents (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  severity text not null check (severity in ('info','warn','error','critical')),
  title text not null,
  body text,
  payload jsonb not null default '{}',
  fingerprint text unique,
  occurrences int not null default 1,
  users_affected int not null default 0,
  status text not null default 'open' check (status in ('open','triaged','fix_proposed','resolved','ignored')),
  proposed_fix jsonb,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  resolved_at timestamptz
);

create table ops.approvals (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('fix_pr','post','outreach_email','ad_change','other')),
  ref_table text,
  ref_id text,
  title text not null,
  summary text,
  preview jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending','approved','rejected','executed','failed')),
  created_by_agent text,
  decided_by uuid,
  decided_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now()
);

create table ops.campaigns (
  id text primary key,
  platform text not null check (platform in ('meta','tiktok')),
  external_id text,
  name text not null,
  status text,
  objective text,
  meta jsonb not null default '{}'
);

create table ops.campaign_daily (
  campaign_id text not null references ops.campaigns(id) on delete cascade,
  date date not null,
  spend numeric(12,2) not null default 0,
  impressions int not null default 0,
  clicks int not null default 0,
  installs int not null default 0,
  primary key (campaign_id, date)
);

create table ops.content_items (
  id text primary key,
  platform text not null check (platform in ('instagram','tiktok')),
  kind text not null check (kind in ('reel','trial_reel','post')),
  status text not null check (status in ('idea','draft','approved','scheduled','posted')),
  title text,
  caption text,
  media_url text,
  scheduled_at timestamptz,
  posted_at timestamptz,
  views int,
  likes int,
  saves int,
  shares int,
  attributed_signups int,
  source text not null default 'desk',
  meta jsonb not null default '{}'
);

create table ops.build_items (
  id text primary key,
  kind text not null check (kind in ('feature','bug','test')),
  title text not null,
  status text not null check (status in ('backlog','active','done')),
  priority int not null default 2,
  notes text
);

create table ops.capital_contacts (
  id text primary key,
  name text not null,
  org text,
  segment text not null check (segment in ('hit','warm','partnership','investor','mentor')),
  stage text not null,
  last_touch date,
  notes text
);

create table ops.fin_actuals (
  month date primary key,
  revenue numeric(12,2) not null default 0,
  paid_subs int not null default 0,
  mau int not null default 0,
  ad_spend numeric(12,2) not null default 0,
  api_spend numeric(12,2) not null default 0,
  infra_spend numeric(12,2) not null default 0,
  payroll numeric(12,2) not null default 0,
  other_opex numeric(12,2) not null default 0,
  cash_end numeric(14,2) not null default 0
);

create table ops.fin_scenarios (
  id text primary key,
  name text not null,
  assumptions jsonb not null
);

create table ops.calendar_events (
  id text primary key,
  external_id text,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  attendees jsonb not null default '[]',
  is_own boolean not null default false
);

create table ops.inbox_items (
  id text primary key,
  thread_id text,
  sender text,
  subject text,
  snippet text,
  importance int not null default 0,
  received_at timestamptz not null
);

create table ops.agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','ok','failed')),
  log text
);
create index agent_runs_agent_started on ops.agent_runs (agent, started_at desc);

-- Not in the original spec list; backs the /ops deploy log.
create table ops.deploys (
  id text primary key,
  service text not null,
  status text not null check (status in ('success','failed','building','crashed')),
  commit_message text,
  created_at timestamptz not null
);

-- Row level security -------------------------------------------------------
create or replace function ops.my_role() returns text
language sql stable security definer set search_path = ops as $$
  select role from ops.profiles where user_id = auth.uid()
$$;

do $$
declare
  t text;
  areas jsonb := '{
    "integrations":["eng"], "metrics_daily":["marketing","eng"], "api_spend":["eng"], "incidents":["eng"],
    "approvals":[], "campaigns":["marketing"], "campaign_daily":["marketing"], "content_items":["marketing"],
    "build_items":["eng"], "capital_contacts":[], "fin_actuals":[], "fin_scenarios":[],
    "calendar_events":["marketing"], "inbox_items":["marketing"], "agent_runs":["eng"], "deploys":["eng"]
  }';
begin
  for t in select jsonb_object_keys(areas) loop
    execute format('alter table ops.%I enable row level security', t);
    execute format(
      'create policy %I on ops.%I for all to authenticated using (ops.my_role() = ''ceo'' or ops.my_role() = any(array(select jsonb_array_elements_text(%L::jsonb)))) with check (ops.my_role() = ''ceo'' or ops.my_role() = any(array(select jsonb_array_elements_text(%L::jsonb))))',
      t || '_by_role', t, areas -> t, areas -> t);
  end loop;
end $$;

alter table ops.profiles enable row level security;
create policy profiles_self on ops.profiles for select to authenticated using (user_id = auth.uid() or ops.my_role() = 'ceo');
create policy profiles_ceo_write on ops.profiles for all to authenticated using (ops.my_role() = 'ceo') with check (ops.my_role() = 'ceo');

grant select, insert, update, delete on all tables in schema ops to authenticated;
grant all on all tables in schema ops to service_role;
grant usage, select on all sequences in schema ops to authenticated, service_role;
