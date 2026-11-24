-- Multi-ad campaigns (Launch → Campaigns): several creatives per campaign (desk videos and Instagram posts), one ad
-- each in the campaign's ad set, plus the desk videos sent to trial alongside it. Per-ad Meta ids live in meta.ads.
-- The old single `creative` column stays readable for existing rows.
alter table ops.ad_campaigns add column if not exists creatives jsonb not null default '[]';
alter table ops.ad_campaigns add column if not exists trials jsonb not null default '[]';
