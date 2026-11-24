-- Ad campaign calendar (Calendar tab): Marketing Map ad concepts scheduled with a gallery reel, approved in the desk,
-- built in Meta paused and switched on on their start date by apps/web/lib/ad-campaigns.ts.
create table ops.ad_campaigns (
  id text primary key,
  title text not null,
  concept_id text,
  objective text not null default 'traffic' check (objective in ('app_installs','traffic','awareness')),
  starts_on date not null,
  ends_on date not null,
  daily_budget numeric not null check (daily_budget > 0),
  countries jsonb not null default '["US"]',
  age_min int not null default 18,
  age_max int not null default 65,
  primary_text text not null default '',
  headline text not null default '',
  cta text not null default 'DOWNLOAD',
  link text not null default '',
  creative jsonb,
  status text not null default 'planned' check (status in
    ('planned','pending_approval','rejected','building','ready','live','paused','ended','failed')),
  approval_id text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);

alter table ops.ad_campaigns enable row level security;
create policy ad_campaigns_by_role on ops.ad_campaigns for all to authenticated
  using (ops.my_role() in ('ceo','marketing')) with check (ops.my_role() in ('ceo','marketing'));
grant select, insert, update, delete on ops.ad_campaigns to authenticated;
grant all on ops.ad_campaigns to service_role;

alter table ops.approvals drop constraint if exists approvals_type_check;
alter table ops.approvals add constraint approvals_type_check
  check (type in ('fix_pr','post','outreach_email','ad_change','ad_launch','other'));
