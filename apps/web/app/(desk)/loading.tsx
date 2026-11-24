// Shown the instant a nav link is clicked, while the next page's server data loads.
export default function Loading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full w-1/3 animate-[loadbar_1s_ease-in-out_infinite] rounded-full bg-primary/70" />
      </div>
      <div className="animate-pulse space-y-3">
        <div className="h-3 w-24 rounded-sm bg-muted" />
        <div className="h-6 w-56 rounded-sm bg-muted" />
        <div className="grid gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-20 rounded-md border bg-card/60" />)}</div>
        <div className="grid gap-3 lg:grid-cols-3"><div className="h-72 rounded-md border bg-card/60 lg:col-span-2" /><div className="h-72 rounded-md border bg-card/60" /></div>
      </div>
    </div>
  );
}
