export default function DashboardLoading() {
  return (
    <main className="space-y-6 p-6 animate-pulse" aria-label="Loading dashboard">
      <div className="h-6 w-28 rounded bg-surface" />
      <div className="h-32 rounded-xl border border-border bg-surface" />
      <div className="h-24 rounded-xl border border-border bg-surface" />
    </main>
  );
}
