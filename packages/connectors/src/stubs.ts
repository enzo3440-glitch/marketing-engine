// Connectors that are wired into settings + agents but not implemented yet. Each test() reports
// not_configured until its env exists, and the TODO says exactly what sync() must do.
import { httpJson, missingEnv, notConfigured, type Connector, type ConnectorContext } from "./types";

function stub(ctx: ConnectorContext, def: Omit<Connector, "test" | "sync" | "implemented"> & { todo: string; probe?: () => Promise<void> }): Connector {
  return {
    ...def, implemented: false,
    async test() {
      const miss = missingEnv(ctx.env, def.requiredEnv);
      if (miss.length) return notConfigured(miss);
      if (def.probe) {
        await def.probe();
        return { status: "connected", detail: "Credentials valid; sync not implemented yet" };
      }
      return { status: "error", detail: `Credentials present; connector not implemented. TODO: ${def.todo}` };
    },
    async sync() {
      ctx.log?.(`${def.id}: stub, skipping. TODO: ${def.todo}`);
    },
  };
}

export const googleCloudConnector = (ctx: ConnectorContext) => stub(ctx, {
  id: "google_cloud", label: "Google Cloud billing", requiredEnv: ["GCP_BILLING_PROJECT", "GCP_BILLING_DATASET", "GOOGLE_APPLICATION_CREDENTIALS_JSON"],
  docs: "https://cloud.google.com/billing/docs/how-to/export-data-bigquery",
  // TODO: @google-cloud/bigquery; SELECT DATE(usage_start_time, 'Pacific/Honolulu') d, service.description, SUM(cost)
  //       FROM `${project}.${dataset}.gcp_billing_export_v1_*` WHERE usage_start_time >= @since GROUP BY 1,2
  //       → upsert api_spend(provider='google', model=service.description).
  todo: "query the BigQuery billing export grouped by day + service into api_spend (provider=google)",
});

export const appStoreConnector = (ctx: ConnectorContext) => stub(ctx, {
  id: "app_store_connect", label: "App Store Connect", requiredEnv: ["ASC_ISSUER_ID", "ASC_KEY_ID", "ASC_PRIVATE_KEY", "ASC_VENDOR_NUMBER"],
  docs: "https://developer.apple.com/documentation/appstoreconnectapi",
  // TODO: sign an ES256 JWT (iss=ASC_ISSUER_ID, kid=ASC_KEY_ID, aud=appstoreconnect-v1, exp<=20m) with the .p8 key (jose),
  //       GET /v1/salesReports?filter[reportType]=SALES&filter[frequency]=DAILY (gzip TSV) → metrics_daily installs,
  //       SUBSCRIPTION / SUBSCRIPTION_EVENT reports → paid_subs, paid_conversions, mrr.
  todo: "ES256 JWT from the .p8 key; daily SALES + SUBSCRIPTION reports into metrics_daily (installs, paid_subs, paid_conversions, mrr)",
});

export const metaConnector = (ctx: ConnectorContext) => stub(ctx, {
  id: "meta", label: "Meta Marketing API", requiredEnv: ["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"],
  docs: "https://developers.facebook.com/docs/marketing-api/insights",
  // TODO: GET /v21.0/act_{id}/insights?level=campaign&time_increment=1&fields=campaign_id,campaign_name,spend,impressions,clicks,actions
  //       → campaigns + campaign_daily (installs from actions[action_type=mobile_app_install]).
  //       Instagram media insights (saves, shares, reach) → content_items for posts the CMO import left unknown.
  todo: "campaign-level daily insights into campaigns/campaign_daily; IG media insights into content_items saves/shares",
  probe: async () => { await httpJson(`https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(ctx.env.META_ACCESS_TOKEN!)}`); },
});

export const tiktokConnector = (ctx: ConnectorContext) => stub(ctx, {
  id: "tiktok", label: "TikTok Marketing API", requiredEnv: ["TIKTOK_ACCESS_TOKEN", "TIKTOK_ADVERTISER_ID"],
  docs: "https://business-api.tiktok.com/portal/docs",
  // TODO: GET /open_api/v1.3/report/integrated/get/ report_type=BASIC, data_level=AUCTION_CAMPAIGN, dimensions=[campaign_id, stat_time_day],
  //       metrics=[spend, impressions, clicks, app_install] → campaigns + campaign_daily. Content Posting API needs app review.
  todo: "daily campaign report into campaigns/campaign_daily",
});

export const googleWorkspaceConnector = (ctx: ConnectorContext) => stub(ctx, {
  id: "google_workspace", label: "Gmail + Calendar", requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
  docs: "https://developers.google.com/workspace/gmail/api",
  // TODO: googleapis OAuth2 with the refresh token; calendar.events.list(primary, timeMin=-7d, timeMax=+14d) → calendar_events
  //       (is_own by attendee domain / keywords); gmail.users.messages.list(q='newer_than:2d -category:promotions') → inbox_items.
  todo: "OAuth refresh token; Calendar events into calendar_events, Gmail threads into inbox_items",
});
