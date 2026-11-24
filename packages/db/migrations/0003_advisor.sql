-- Marketing Advisor feedback ledger: append-only, revision-checked
-- (packages/advisor/docs/integration.md §5). Scores are frozen before outcomes; events are never edited.
create table ops.advisor_events (
  id text primary key,                 -- caller-supplied event id (dedupe)
  revision int not null unique,        -- ledger revision after this event
  type text not null,                  -- score | publication | outcome | review | ...
  payload jsonb not null,
  recorded_at timestamptz not null default now()
);

alter table ops.advisor_events enable row level security;
create policy advisor_events_read on ops.advisor_events for select to authenticated using (ops.my_role() in ('ceo','marketing'));
create policy advisor_events_append on ops.advisor_events for insert to authenticated with check (ops.my_role() in ('ceo','marketing'));
-- No update/delete policy: the ledger is append-only for app users.

grant select, insert on ops.advisor_events to authenticated;
grant all on ops.advisor_events to service_role;
