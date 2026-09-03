import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { fetchStatus } from "@/lib/api";
import { withPinnedTables } from "@/lib/catalog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatWhen } from "@/lib/utils";

export function StatusPage() {
	const q = useQuery({
		queryKey: ["dashboard-status"],
		queryFn: fetchStatus,
		refetchInterval: 5000,
	});

	if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading scraper status…</p>;
	if (q.error) {
		return (
			<Card>
				<CardContent className="p-6 text-sm">
					<p className="font-medium">Could not reach the API.</p>
					<p className="mt-1 text-muted-foreground">
						Start the Hono server with `npm run start` (port 3002), then refresh.
					</p>
					<p className="mt-2 font-mono text-xs">{String(q.error)}</p>
				</CardContent>
			</Card>
		);
	}

	const tables = withPinnedTables(q.data?.tables || []);
	const total = tables.reduce((n, t) => n + (t.count || 0), 0);
	const running = tables.filter((t) => t.run?.running).length;

	return (
		<div className="h-full overflow-auto">
			<p className="mb-5 text-sm text-muted-foreground">
				{running} running · {tables.length} monitors · {total.toLocaleString()} docs. Open a card to
				configure and start a run. Press ⌘K to search or TOGGLE an agent.
			</p>
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{tables.map((t) => {
					const on = Boolean(t.run?.running);
					const stats = t.run?.stats;
					return (
						<Link
							key={t.id}
							to="/scrapers/$tableId"
							params={{ tableId: t.id }}
							className="block"
						>
							<Card className="h-full transition-colors hover:bg-muted/60">
								<CardContent className="p-4">
									<div className="flex items-start justify-between gap-2">
										<p className="font-medium">{t.label}</p>
										<span
											className={`text-[11px] uppercase tracking-wide ${on ? "text-foreground" : "text-muted-foreground"}`}
										>
											{on ? (t.run?.loop ? "looping" : "running") : "idle"}
										</span>
									</div>
									<p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
									<ul className="mt-3 space-y-1 text-xs text-muted-foreground">
										<li>
											<span className="text-foreground">{(t.count || 0).toLocaleString()}</span>{" "}
											stored in <span className="font-mono">{t.collection}</span>
										</li>
										<li>
											fetched {(stats?.fetched || 0).toLocaleString()} · scraped{" "}
											{(stats?.scraped || 0).toLocaleString()} · failed{" "}
											{(stats?.failed || 0).toLocaleString()}
										</li>
										<li>latest {formatWhen(t.latestAt)}</li>
										<li className="font-mono">{t.cli}</li>
									</ul>
									<div className="mt-3">
										<Badge>{t.group}</Badge>
									</div>
								</CardContent>
							</Card>
						</Link>
					);
				})}
			</div>
		</div>
	);
}
