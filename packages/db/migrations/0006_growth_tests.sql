-- Test Lab: trial reels → ads-only screen → scale, with every post/spend step approved in the desk.
create table ops.growth_tests (
  id text primary key,
  name text not null,
  stage text not null default 'trial' check (stage in ('trial','screen','scale','done')),
  plan jsonb not null default '{}',
  candidates jsonb not null default '[]',
  log jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table ops.growth_tests enable row level security;
create policy growth_tests_by_role on ops.growth_tests for all to authenticated
  using (ops.my_role() in ('ceo','marketing')) with check (ops.my_role() in ('ceo','marketing'));
grant select, insert, update, delete on ops.growth_tests to authenticated;
grant all on ops.growth_tests to service_role;

alter table ops.approvals drop constraint if exists approvals_type_check;
alter table ops.approvals add constraint approvals_type_check
  check (type in ('fix_pr','post','outreach_email','ad_change','ad_launch','optimize','other'));
