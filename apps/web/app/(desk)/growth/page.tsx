import { dailyTotals, getRepo, lagCorrelation, metricSeries } from "@engine/db";
import { DualAxis, LagBars } from "@/components/charts";
import { Badge, Card, CardBody, CardHeader, PageHeader, Table, Td, Th } from "@/components/ui";
import { requireArea } from "@/lib/auth";
import { daysAgo, fmt, parseRange } from "@/lib/utils";

const ARPU = 7.99;

export default async function GrowthPage({ searchParams }: { searchParams: { range?: string } }) {
  await requireArea("growth");
  const range = parseRange(searchParams.range);
  const since = daysAgo(range - 1);
  const repo = getRepo();
  const [metrics, ads, campaigns] = await Promise.all([repo.list("metrics_daily", { since }), repo.list("campaign_daily", { since }), repo.list("campaigns")]);

  const tot = (k: "impressions" | "clicks" | "installs" | "spend") => ads.reduce((a, r) => a + Number(r[k]), 0);
  const signups = metricSeries(metrics, "signups"), paid = metricSeries(metrics, "paid_conversions");
  const sum = (s: { value: number }[]) => s.reduce((a, b) => a + b.value, 0);
  const funnel = [
    { label: "Impressions", value: tot("impressions") }, { label: "Clicks", value: tot("clicks") }, { label: "Installs", value: tot("installs") },
    { label: "Signups", value: sum(signups) }, { label: "Paid", value: sum(paid) },
  ];
  const spendDaily = dailyTotals(ads, (r) => Number(r.spend));
  const sMap = new Map(signups.map((s) => [s.date, s.value]));
  const dual = spendDaily.map((d) => ({ date: d.date, spend: +d.value.toFixed(2), signups: sMap.get(d.date) ?? 0 }));
  const lags = lagCorrelation(spendDaily, signups);
  const best = [...lags].sort((a, b) => b.r - a.r)[0];

  // Signups and paid conversions are attributed to campaigns by install share (modeled, not click-level).
  const totalInstalls = tot("installs") || 1;
  const rows = campaigns.filter((c) => !c.id.startsWith("cmo-")).map((c) => {
    const r = ads.filter((a) => a.campaign_id === c.id);
    const spend = r.reduce((a, b) => a + Number(b.spend), 0), imp = r.reduce((a, b) => a + b.impressions, 0);
    const installs = r.reduce((a, b) => a + b.installs, 0), share = installs / totalInstalls;
    const attrPaid = sum(paid) * share;
    return { c, spend, imp, clicks: r.reduce((a, b) => a + b.clicks, 0), installs, cpm: imp ? (spend / imp) * 1000 : null, cpi: installs ? spend / installs : null, cac: attrPaid ? spend / attrPaid : null, roas: spend ? (attrPaid * ARPU * 12) / spend : null };
  }).sort((a, b) => b.spend - a.spend);
  const imported = campaigns.filter((c) => c.id.startsWith("cmo-"));

  return (
    <>
      <PageHeader title="Growth" description="Meta + TikTok campaigns correlated to signups and paid conversions." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Funnel" description={`Last ${range} days`} />
          <CardBody className="space-y-2.5">
            {funnel.map((f, i) => {
              const prev = funnel[i - 1]?.value;
              return (
                <div key={f.label}>
                  <div className="flex justify-between text-xs"><span>{f.label}</span><span className="num">{fmt.num(f.value)}{prev && f.value <= prev ? <span className="ml-2 text-muted-foreground">{fmt.pct(f.value / prev)}</span> : null}</span></div>
                  <div className="mt-1 h-2 rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${Math.max(2, Math.sqrt(f.value / funnel[0].value) * 100)}%` }} /></div>
                </div>
              );
            })}
            <p className="text-[11px] text-muted-foreground">Bar widths are √-scaled so late stages stay visible. Signups and paid count all sources (organic + paid), so no step rate is shown where they exceed paid installs.</p>
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Ad spend vs signups" description="Daily, all platforms" />
          <CardBody><DualAxis data={dual} bar="spend" line="signups" barLabel="Ad spend" lineLabel="Signups" /></CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Campaigns" description={`CAC and ROAS use paid conversions attributed by install share; ROAS assumes ${fmt.usd(ARPU, 2)}/mo × 12.`} />
          <Table>
            <thead><tr><Th>Campaign</Th><Th>Platform</Th><Th className="text-right">Spend</Th><Th className="text-right">CPM</Th><Th className="text-right">Installs</Th><Th className="text-right">CPI</Th><Th className="text-right">CAC</Th><Th className="text-right">ROAS</Th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.c.id}>
                <Td><div className="font-medium">{r.c.name}</div><div className="text-[11px] text-muted-foreground">{r.c.objective} · {r.c.status}</div></Td>
                <Td><Badge tone={r.c.platform === "meta" ? "primary" : "default"}>{r.c.platform}</Badge></Td>
                <Td className="num text-right">{fmt.usd(r.spend)}</Td><Td className="num text-right">{fmt.usd(r.cpm, 2)}</Td><Td className="num text-right">{fmt.num(r.installs)}</Td>
                <Td className="num text-right">{fmt.usd(r.cpi, 2)}</Td><Td className="num text-right">{fmt.usd(r.cac, 2)}</Td><Td className="num text-right">{r.roas == null ? "—" : `${r.roas.toFixed(2)}×`}</Td>
              </tr>
            ))}</tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Spend → signups lag" description={`Best at ${best?.lag}-day lag (r = ${best?.r})`} />
          <CardBody><LagBars data={lags} /></CardBody>
        </Card>
      </div>

      {imported.length > 0 && (
        <Card className="mt-4">
          <CardHeader title="Imported paid reports (CMO Desk)" description="Meta campaign CSV exports migrated from Reel Radar. Period totals; spend is reconstructed from reported CPC where missing." />
          <Table>
            <thead><tr><Th>Campaign</Th><Th>Period</Th><Th className="text-right">Follows</Th><Th className="text-right">Link clicks</Th><Th className="text-right">Spend (est.)</Th><Th className="text-right">Cost / follow</Th></tr></thead>
            <tbody>{imported.map((c) => {
              const m = c.meta as Record<string, number | string | null>;
              return (
                <tr key={c.id}><Td className="max-w-sm truncate">{c.name}</Td><Td className="whitespace-nowrap text-xs text-muted-foreground">{fmt.date(m.reportStart as string)} – {fmt.date(m.reportEnd as string)}</Td><Td className="num text-right">{fmt.num(m.follows as number)}</Td><Td className="num text-right">{fmt.num(m.linkClicks as number)}</Td><Td className="num text-right">{fmt.usd((m.spendUsd ?? m.estimatedSpendUsd) as number, 2)}</Td><Td className="num text-right">{fmt.usd(m.estimatedCostPerFollowUsd as number, 2)}</Td></tr>
              );
            })}</tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
