// Meta Marketing API client for the ad campaign calendar (apps/web/lib/ad-campaigns.ts): upload a reel, build
// campaign → ad set → creative → ad, switch campaigns on and off. Server-side only; the token never reaches a browser.
// Needs a Business Manager system-user token with ads_management + pages_read_engagement + instagram_basic.
import type { AdObjective } from "@engine/db";

export interface MetaAdsEnv {
  token: string; adAccount: string; pageId: string; igUserId: string; appId?: string; version: string;
  /** META_GRAPH_URL: only for pointing tests at a fake Graph API. */
  graph: string;
}

export interface MetaAccount { id: string; name: string; currency: string; timezone_name: string; account_status: number }

export class MetaApiError extends Error {}

/** Same objective → optimization mapping Ads Manager uses for these three goals. */
const GOAL: Record<AdObjective, { objective: string; optimization: string }> = {
  app_installs: { objective: "OUTCOME_APP_PROMOTION", optimization: "APP_INSTALLS" },
  traffic: { objective: "OUTCOME_TRAFFIC", optimization: "LINK_CLICKS" },
  awareness: { objective: "OUTCOME_AWARENESS", optimization: "REACH" },
};

export class MetaAds {
  private constructor(readonly env: MetaAdsEnv) {}

  /** Null until META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, META_PAGE_ID and META_IG_USER_ID are all set. */
  static fromEnv(e: Record<string, string | undefined>): MetaAds | null {
    const { META_ACCESS_TOKEN: token, META_AD_ACCOUNT_ID: acct, META_PAGE_ID: pageId, META_IG_USER_ID: igUserId } = e;
    if (!token || !acct || !pageId || !igUserId) return null;
    return new MetaAds({
      token, adAccount: acct.startsWith("act_") ? acct : `act_${acct}`, pageId, igUserId,
      appId: e.META_APP_ID || undefined, version: e.META_API_VERSION || "v24.0",
      graph: (e.META_GRAPH_URL || "https://graph.facebook.com").replace(/\/$/, ""),
    });
  }

  static missingEnv(e: Record<string, string | undefined>): string[] {
    return ["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID", "META_PAGE_ID", "META_IG_USER_ID"].filter((k) => !e[k]);
  }

  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, unknown> | FormData = {}, timeoutMs = 60_000): Promise<T> {
    const url = new URL(`${this.env.graph}/${this.env.version}/${path}`);
    let body: BodyInit | undefined;
    if (params instanceof FormData) body = params;
    else {
      const flat = Object.entries(params).filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)] as [string, string]);
      if (method !== "POST") flat.forEach(([k, v]) => url.searchParams.set(k, v));
      else body = new URLSearchParams(flat);
    }
    const res = await fetch(url, {
      cache: "no-store", // live numbers, never Next's data cache
      method, body, headers: { Authorization: `Bearer ${this.env.token}` }, signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; error_user_msg?: string; code?: number } };
    if (!res.ok || data.error) {
      const err = data.error;
      throw new MetaApiError(`Meta ${method} ${path.split("?")[0]}: ${err?.error_user_msg || err?.message || res.statusText}${err?.code ? ` (code ${err.code})` : ""}`);
    }
    return data;
  }

  /** The ad account the token points at; throws with Meta's message when the token or ids are wrong. */
  account(): Promise<MetaAccount> {
    return this.call("GET", this.env.adAccount, { fields: "id,name,currency,timezone_name,account_status" });
  }

  /** Read-only Graph GET (insights, Instagram media). "act" and "ig" in the path are replaced by the configured ids. */
  get<T>(path: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    const p = path.replace(/^act(?=\/|$)/, this.env.adAccount).replace(/^ig(?=\/|$)/, this.env.igUserId);
    return this.call("GET", p, params, timeoutMs);
  }

  /** Upload an mp4 (multipart) and wait until Meta has processed it. */
  async uploadVideo(name: string, mp4: Blob): Promise<string> {
    const fd = new FormData();
    fd.set("name", name);
    fd.set("source", mp4, name.endsWith(".mp4") ? name : `${name}.mp4`);
    const { id } = await this.call<{ id: string }>("POST", `${this.env.adAccount}/advideos`, fd, 10 * 60_000);
    const until = Date.now() + 10 * 60_000;
    while (Date.now() < until) {
      const v = await this.call<{ status?: { video_status?: string } }>("GET", id, { fields: "status" });
      if (v.status?.video_status === "ready") return id;
      if (v.status?.video_status === "error") throw new MetaApiError("Meta could not process the video");
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new MetaApiError("Meta is still processing the video after 10 minutes; retry the build");
  }

  /** Upload the poster frame as the video's thumbnail; returns its image hash. */
  async uploadImage(name: string, jpg: Blob): Promise<string> {
    const fd = new FormData();
    fd.set("filename", jpg, name);
    const r = await this.call<{ images: Record<string, { hash: string }> }>("POST", `${this.env.adAccount}/adimages`, fd, 2 * 60_000);
    const hash = Object.values(r.images ?? {})[0]?.hash;
    if (!hash) throw new MetaApiError("Meta returned no image hash for the thumbnail");
    return hash;
  }

  /**
   * The app an install ad promotes: the app registered in Meta (and usable by this ad account) whose store listing is
   * `storeUrl`, matched by the App Store id (".../id123") or the Play package ("?id=com.x"). META_APP_ID wins when it's
   * one of them. Null when the app isn't set up for ads in Meta yet.
   */
  async appFor(storeUrl: string): Promise<{ id: string; name: string } | null> {
    const key = /\/id(\d+)/.exec(storeUrl)?.[1] ?? /[?&]id=([\w.]+)/.exec(storeUrl)?.[1];
    const r = await this.call<{ data: { id: string; name: string; object_store_urls?: Record<string, string> }[] }>(
      "GET", `${this.env.adAccount}/advertisable_applications`, { fields: "id,name,object_store_urls" });
    const apps = r.data ?? [];
    const lists = (a: (typeof apps)[number]) => !!key && Object.values(a.object_store_urls ?? {}).some((u) => u.includes(key));
    const pick = apps.find((a) => a.id === this.env.appId && lists(a)) ?? apps.find(lists);
    return pick ? { id: pick.id, name: pick.name } : null;
  }

  /** Campaign shell, always PAUSED: the desk switches it on on the start date. An iOS app-install campaign is an iOS 14+
   * (SKAdNetwork) campaign, which Meta requires to measure installs on iPhones. */
  async createCampaign(name: string, goal: AdObjective, o: { ios?: boolean; dailyBudgetMinor?: number } = {}): Promise<string> {
    // with dailyBudgetMinor the campaign holds the budget (Advantage campaign budget): Meta moves it between the ad sets
    const budget = o.dailyBudgetMinor != null
      ? { daily_budget: String(o.dailyBudgetMinor), bid_strategy: "LOWEST_COST_WITHOUT_CAP" }
      : { is_adset_budget_sharing_enabled: false };
    const { id } = await this.call<{ id: string }>("POST", `${this.env.adAccount}/campaigns`, {
      name, objective: GOAL[goal].objective, status: "PAUSED", buying_type: "AUCTION",
      special_ad_categories: [], ...budget,
      // An iOS 14+ (SKAdNetwork) campaign refuses every install ad set until SKAdNetwork is configured for
      // the app in Events Manager, and Meta turns it on by default. Off unless META_SKAN=on: installs are then measured
      // from people who allow tracking, plus Meta's modeled installs.
      ...(goal === "app_installs" ? { is_skadnetwork_attribution: !!o.ios && (process.env.META_SKAN ?? "").toLowerCase() === "on" } : {}),
    });
    return id;
  }

  /** Ad set with its own daily budget and dates; Instagram placements only (the map's "Instagram ad-only" channel). */
  async createAdSet(o: {
    /** Omit for an ad set in a campaign that holds the budget itself. */
    name: string; campaignId: string; goal: AdObjective; dailyBudgetMinor?: number; startTime: string; endTime: string;
    countries: string[]; ageMin: number; ageMax: number; link: string; appId?: string;
  }): Promise<string> {
    const targeting: Record<string, unknown> = {
      geo_locations: { countries: o.countries }, age_min: o.ageMin, age_max: o.ageMax,
      publisher_platforms: ["instagram"], instagram_positions: ["reels", "story", "stream"],
    };
    let promoted: Record<string, unknown> | undefined;
    let destination: string | undefined;
    if (o.goal === "app_installs") {
      const appId = o.appId ?? this.env.appId;
      if (!appId) throw new MetaApiError("App install campaigns need the app registered in Meta");
      promoted = { application_id: appId, object_store_url: o.link };
      targeting.user_os = [/play\.google\.com/.test(o.link) ? "Android" : "iOS"];
    } else if (/apps\.apple\.com|play\.google\.com/.test(o.link)) {
      // clicks to the store: the ad set's destination is the app. Without it Meta refuses the App Store
      // link (1487810); an install campaign without SKAdNetwork only reaches iOS 14.4 and older, so clicks it is.
      const ios = /apps\.apple\.com/.test(o.link);
      targeting.user_os = [ios ? "iOS" : "Android"];
      const appId = o.appId ?? this.env.appId;
      if (appId) { promoted = { application_id: appId, object_store_url: o.link }; destination = "APP"; }
    }
    const { id } = await this.call<{ id: string }>("POST", `${this.env.adAccount}/adsets`, {
      name: o.name, campaign_id: o.campaignId, billing_event: "IMPRESSIONS", optimization_goal: GOAL[o.goal].optimization,
      ...(destination ? { destination_type: destination } : {}),
      ...(o.dailyBudgetMinor != null ? { daily_budget: String(o.dailyBudgetMinor), bid_strategy: "LOWEST_COST_WITHOUT_CAP" } : {}),
      start_time: o.startTime, end_time: o.endTime, targeting, promoted_object: promoted, status: "ACTIVE",
    });
    return id;
  }

  async createCreative(o: { name: string; videoId: string; imageHash: string; message: string; headline: string; cta: string; link: string }): Promise<string> {
    const { id } = await this.call<{ id: string }>("POST", `${this.env.adAccount}/adcreatives`, {
      name: o.name,
      object_story_spec: {
        page_id: this.env.pageId, instagram_user_id: this.env.igUserId,
        video_data: {
          video_id: o.videoId, image_hash: o.imageHash, message: o.message, title: o.headline,
          call_to_action: { type: o.cta, value: { link: o.link } },
        },
      },
    });
    return id;
  }

  /** PAUSED builds an ad that waits its turn: Meta reviews it now, so switching it on later is instant. */
  async createAd(name: string, adsetId: string, creativeId: string, status: "ACTIVE" | "PAUSED" = "ACTIVE"): Promise<string> {
    const { id } = await this.call<{ id: string }>("POST", `${this.env.adAccount}/ads`, {
      name, adset_id: adsetId, creative: { creative_id: creativeId }, status,
    });
    return id;
  }

  /** Ad creative that promotes an existing Instagram post or reel as-is (no new video upload). */
  async createCreativeFromInstagram(o: { name: string; igMediaId: string; cta: string; link: string }): Promise<string> {
    const { id } = await this.call<{ id: string }>("POST", `${this.env.adAccount}/adcreatives`, {
      name: o.name, object_id: this.env.pageId, instagram_user_id: this.env.igUserId, source_instagram_media_id: o.igMediaId,
      call_to_action: { type: o.cta, value: { link: o.link } },
    });
    return id;
  }

  async setCampaignStatus(campaignId: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
    await this.call("POST", campaignId, { status });
  }

  /** Switch any campaign, ad set or ad on or off. */
  async setStatus(id: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
    await this.call("POST", id, { status });
  }

  /** Change a campaign's daily budget (minor units); only for a campaign that holds its own budget. */
  async updateCampaignBudget(campaignId: string, dailyBudgetMinor: number): Promise<void> {
    await this.call("POST", campaignId, { daily_budget: String(dailyBudgetMinor) });
  }

  /** Change an ad set's daily budget (minor units) and/or end time. */
  async updateAdSet(adsetId: string, o: { dailyBudgetMinor?: number; endTime?: string }): Promise<void> {
    await this.call("POST", adsetId, { daily_budget: o.dailyBudgetMinor != null ? String(o.dailyBudgetMinor) : undefined, end_time: o.endTime });
  }

  /** Lifetime results of one campaign: spend, reach, clicks, 3-second video views (hook rate), landing-page views. */
  async campaignResults(campaignId: string): Promise<{ spend: number; impressions: number; clicks: number; videoViews: number; landingViews: number; installs: number }> {
    const r = await this.call<{ data: { spend?: string; impressions?: string; inline_link_clicks?: string; actions?: { action_type: string; value: string }[] }[] }>(
      "GET", `${campaignId}/insights`, { fields: "spend,impressions,inline_link_clicks,actions", date_preset: "maximum" });
    const d = r.data[0] ?? {};
    const act = (t: string) => Number(d.actions?.find((a) => a.action_type === t)?.value ?? 0);
    return {
      spend: Number(d.spend ?? 0), impressions: Number(d.impressions ?? 0), clicks: Number(d.inline_link_clicks ?? 0),
      videoViews: act("video_view"), landingViews: act("landing_page_view"), installs: act("mobile_app_install") || act("omni_app_install"),
    };
  }

  /**
   * One ad's (or ad set's, or campaign's) results for the live optimizer: the funnel from impression to install, plus
   * every app event Meta attributes (app_custom_event.*, mobile_app_*), so a feature's ads can be judged on what
   * people do in the app once the app's SDK sends events. preset: "maximum" (lifetime) or e.g. "last_3d".
   */
  async adResults(id: string, preset = "maximum"): Promise<{
    spend: number; impressions: number; clicks: number; videoViews: number; p25: number; p50: number; p100: number; installs: number;
    events: Record<string, number>;
    /** Meta's watch curve: % of plays still watching at each second (0-15 s one per second, then wider buckets). */
    curve: number[];
  }> {
    type Act = { action_type: string; value: string };
    const r = await this.call<{ data: { spend?: string; impressions?: string; inline_link_clicks?: string; actions?: Act[];
      video_p25_watched_actions?: Act[]; video_p50_watched_actions?: Act[]; video_p100_watched_actions?: Act[];
      video_play_curve_actions?: { action_type: string; value: number[] }[] }[] }>(
      "GET", `${id}/insights`, { fields: "spend,impressions,inline_link_clicks,actions,video_p25_watched_actions,video_p50_watched_actions,video_p100_watched_actions,video_play_curve_actions", date_preset: preset });
    const d = r.data[0] ?? {};
    const act = (t: string) => Number(d.actions?.find((a) => a.action_type === t)?.value ?? 0);
    const vid = (x?: Act[]) => Number(x?.find((a) => a.action_type === "video_view")?.value ?? x?.[0]?.value ?? 0);
    const events: Record<string, number> = {};
    for (const a of d.actions ?? []) if (/^(app_custom_event\.|mobile_app_|omni_app_|omni_activate|omni_complete_registration|app_install)/.test(a.action_type)) events[a.action_type] = Number(a.value);
    return {
      spend: Number(d.spend ?? 0), impressions: Number(d.impressions ?? 0), clicks: Number(d.inline_link_clicks ?? 0), videoViews: act("video_view"),
      p25: vid(d.video_p25_watched_actions), p50: vid(d.video_p50_watched_actions), p100: vid(d.video_p100_watched_actions),
      installs: act("mobile_app_install") || act("omni_app_install"), events,
      curve: (d.video_play_curve_actions?.[0]?.value ?? []).map(Number),
    };
  }

  /**
   * Money the account can actually spend: prepaid balance and room under the account spend cap (whichever is lower),
   * in account currency units. Null fields when Meta doesn't report them.
   */
  async funds(): Promise<{ currency: string; prepaid: boolean; balance: number | null; capRoom: number | null; usable: number | null; minDailyBudget: number }> {
    const a = await this.call<{ currency: string; is_prepay_account?: boolean; amount_spent?: string; spend_cap?: string; min_daily_budget?: number;
      funding_source_details?: { display_string?: string } }>("GET", this.env.adAccount,
      { fields: "currency,is_prepay_account,amount_spent,spend_cap,min_daily_budget,funding_source_details" });
    const cents = (s?: string) => (s != null && s !== "" ? Number(s) / 100 : null);
    const shown = a.funding_source_details?.display_string?.match(/([\d,]+(?:\.\d+)?)/)?.[1];
    const balance = a.is_prepay_account && shown ? Number(shown.replace(/,/g, "")) : null;
    const cap = cents(a.spend_cap), spent = cents(a.amount_spent) ?? 0;
    const capRoom = cap ? Math.max(0, cap - spent) : null;
    const usable = [balance, capRoom].filter((x): x is number => x != null).reduce((m, x) => Math.min(m, x), Infinity);
    return { currency: a.currency, prepaid: !!a.is_prepay_account, balance, capRoom, usable: Number.isFinite(usable) ? usable : null, minDailyBudget: (a.min_daily_budget ?? 100) / 100 };
  }

  /**
   * Publish a Reel from a local video (resumable upload to rupload.facebook.com, no public URL needed).
   * trial = shown to non-followers only, kept off the grid until you graduate it in the Instagram app.
   */
  /**
   * Post a reel. A trial reel must come from `videoUrl` (a public link): Instagram ignores trial_params on a resumable
   * upload and posts a normal reel, so a trial without a link is refused here.
   */
  async publishReel(o: { video?: Blob; videoUrl?: string; caption: string; trial: boolean }): Promise<{ mediaId: string; permalink: string | null }> {
    const ig = this.env.igUserId;
    if (o.trial && !o.videoUrl) throw new MetaApiError("A trial reel needs a public video link; nothing was sent");
    let container: string;
    if (o.videoUrl) {
      ({ id: container } = await this.call<{ id: string }>("POST", `${ig}/media`, {
        media_type: "REELS", video_url: o.videoUrl, caption: o.caption, share_to_feed: o.trial ? undefined : true,
        trial_params: o.trial ? { graduation_strategy: "MANUAL" } : undefined,
      }));
    } else {
      if (!o.video) throw new MetaApiError("No video to post");
      const r = await this.call<{ id: string; uri?: string }>("POST", `${ig}/media`, {
        media_type: "REELS", upload_type: "resumable", caption: o.caption, share_to_feed: true,
      });
      container = r.id;
      const up = await fetch(r.uri ?? `${this.env.graph.replace("graph.", "rupload.")}/ig-api-upload/${this.env.version}/${container}`, {
        method: "POST", body: o.video, signal: AbortSignal.timeout(10 * 60_000),
        headers: { Authorization: `OAuth ${this.env.token}`, offset: "0", file_size: String(o.video.size) },
      });
      if (!up.ok) throw new MetaApiError(`Instagram upload failed (${up.status}): ${(await up.text()).slice(0, 200)}`);
    }
    const until = Date.now() + 6 * 60_000;
    for (;;) {
      const s = await this.call<{ status_code?: string }>("GET", container, { fields: "status_code" });
      if (s.status_code === "FINISHED") break;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new MetaApiError(`Instagram couldn't process the reel (${s.status_code})`);
      if (Date.now() > until) throw new MetaApiError("Instagram is still processing the reel after 6 minutes; try again later");
      await new Promise((r) => setTimeout(r, 15_000));
    }
    // publish can fail with a transient error (code 1/2): retry, but first check the container didn't go out anyway
    let mediaId = "";
    for (let i = 0; ; i++) {
      try { ({ id: mediaId } = await this.call<{ id: string }>("POST", `${ig}/media_publish`, { creation_id: container })); break; }
      catch (e) {
        if (i >= 3 || !/\(code (1|2)\)|unexpected error|retry/i.test((e as Error).message)) throw e;
        await new Promise((r) => setTimeout(r, 30_000 * (i + 1)));
        const s = await this.call<{ status_code?: string }>("GET", container, { fields: "status_code" }).catch(() => ({ status_code: undefined }));
        if (s.status_code === "PUBLISHED") throw new MetaApiError("Instagram says this reel was published, but didn't return it; check the account before retrying");
      }
    }
    const m = await this.call<{ permalink?: string }>("GET", mediaId, { fields: "permalink" }).catch(() => ({ permalink: undefined }));
    return { mediaId, permalink: m.permalink ?? null };
  }

  /** Delete an Instagram post or reel (trial reels too) from the account. Meta's IG Media delete endpoint (Dec 2025);
   * needs instagram_manage_contents. Cannot be undone: the desk keeps the video file and the numbers. */
  async deleteMedia(mediaId: string): Promise<void> {
    await this.call<{ success?: boolean }>("DELETE", mediaId);
  }

  /** Reel results: reach, saves, shares, views and average watch time (ms). */
  /** A reel's results. skipRate: % of viewers who swiped away in the first seconds (Instagram's "skip rate"). */
  async reelResults(mediaId: string): Promise<{ reach: number; saves: number; shares: number; views: number; avgWatchMs: number | null;
    skipRate: number | null; likes: number; comments: number }> {
    let rows: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] = [];
    for (const metric of ["reach,saved,shares,views,ig_reels_avg_watch_time,reels_skip_rate,likes,comments", "reach,saved,shares,views,ig_reels_avg_watch_time", "reach,saved,shares,views", "reach,saved,shares"]) {
      try {
        rows = (await this.call<{ data: typeof rows }>("GET", `${mediaId}/insights`, { metric })).data;
        break;
      } catch { /* metric not available for this media; try fewer */ }
    }
    const v = (n: string) => { const r = rows.find((x) => x.name === n); return r ? (r.total_value?.value ?? r.values?.[0]?.value ?? 0) : null; };
    return { reach: v("reach") ?? 0, saves: v("saved") ?? 0, shares: v("shares") ?? 0, views: v("views") ?? 0, avgWatchMs: v("ig_reels_avg_watch_time"),
      skipRate: v("reels_skip_rate"), likes: v("likes") ?? 0, comments: v("comments") ?? 0 };
  }

  adsManagerUrl(campaignId?: string): string {
    const act = this.env.adAccount.replace(/^act_/, "");
    return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${act}${campaignId ? `&selected_campaign_ids=${campaignId}` : ""}`;
  }
}
