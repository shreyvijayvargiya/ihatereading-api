import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FileText, Image, Loader2, Plus, Search } from "lucide-react";
import { getGuides, getJobs, getHealth } from "../services/api.js";
import { formatDate } from "../lib/utils.js";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Skeleton } from "../components/ui/skeleton.jsx";

function normalizeGuides(data) {
  const raw = data?.guides ?? data?.items ?? data ?? [];
  return Array.isArray(raw) ? raw : [];
}

function normalizeJobs(data) {
  const raw = data?.jobs ?? data?.items ?? data ?? [];
  return Array.isArray(raw) ? raw : [];
}

function statusBadge(status) {
  const s = String(status || "draft").toLowerCase();
  if (s === "completed" || s === "done") return <Badge variant="success">Completed</Badge>;
  if (s === "running" || s === "active") return <Badge variant="warning">Running</Badge>;
  return <Badge variant="muted">Draft</Badge>;
}

const howTo = [
  {
    step: "1",
    title: "Define your guide",
    body: "Set topic, keywords, and research depth on New Guide.",
  },
  {
    step: "2",
    title: "Run deep research",
    body: "Watch phases, queries, and sources in the live console.",
  },
  {
    step: "3",
    title: "Publish & illustrate",
    body: "Edit markdown, plan images, and export your final guide.",
  },
];

export function DashboardPage() {
  const guidesQ = useQuery({ queryKey: ["guides"], queryFn: () => getGuides() });
  const jobsQ = useQuery({ queryKey: ["jobs"], queryFn: () => getJobs() });
  const healthQ = useQuery({ queryKey: ["health"], queryFn: getHealth, retry: false });

  const guides = normalizeGuides(guidesQ.data);
  const jobs = normalizeJobs(jobsQ.data);

  const drafts = guides.filter((g) => String(g.status).toLowerCase() === "draft");
  const completed = guides.filter((g) =>
    ["completed", "done", "published"].includes(String(g.status).toLowerCase()),
  );
  const done = new Set(["completed", "completed_with_warnings", "failed", "cancelled", "canceled"]);
  const running = jobs.filter((j) => !done.has(String(j.status).toLowerCase()));
  const imagesPlanned = guides.reduce(
    (acc, g) => acc + (g.imageCount ?? g.imagesPlanned ?? g.imagePlanCount ?? 0),
    0,
  );

  const llmTotals = jobs.reduce(
    (acc, j) => {
      const u = j.llmUsage || {};
      acc.calls += u.calls || 0;
      acc.tokens += u.totalTokens || 0;
      acc.cost += Number(u.costUsd) || 0;
      return acc;
    },
    { calls: 0, tokens: 0, cost: 0 },
  );

  const stats = [
    { label: "Total Guides", value: guides.length },
    { label: "Research Running", value: running.length },
    { label: "Drafts", value: drafts.length },
    { label: "Completed", value: completed.length },
    { label: "Images Planned", value: imagesPlanned },
    { label: "AI spend (USD)", value: `$${llmTotals.cost.toFixed(3)}` },
  ];

  const recent = [...guides]
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
    .slice(0, 8);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-[hsl(var(--muted-foreground))]">
            Overview of guides, research jobs, and image plans.
            {healthQ.isSuccess ? (
              <span className="ml-2 text-emerald-600 dark:text-emerald-400">API online</span>
            ) : healthQ.isError ? (
              <span className="ml-2 text-amber-600">API unreachable</span>
            ) : null}
            {healthQ.data?.openRouter ? (
              healthQ.data.openRouter.chatOk ? (
                <span className="ml-2 text-emerald-600">· OpenRouter OK</span>
              ) : (
                <span className="ml-2 text-amber-600">
                  · OpenRouter: {healthQ.data.openRouter.error || "not ready"}
                </span>
              )
            ) : null}
          </p>
        </div>
        <Link to="/new">
          <Button>
            <Plus className="h-4 w-4" />
            New Guide
          </Button>
        </Link>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {howTo.map((item) => (
          <Card key={item.step} className="border-[hsl(var(--border))]">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[hsl(var(--muted))] text-xs font-semibold">
                  {item.step}
                </span>
                <CardTitle className="text-base">{item.title}</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>{item.body}</CardDescription>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map((s) => (
          <Card key={s.label} className="shadow-none">
            <CardContent className="p-4">
              <p className="text-xs text-[hsl(var(--muted-foreground))]">{s.label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {guidesQ.isLoading && jobsQ.isLoading ? "—" : s.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      {llmTotals.calls > 0 ? (
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          AI usage across jobs: {llmTotals.calls} calls · {llmTotals.tokens.toLocaleString()} tokens · $
          {llmTotals.cost.toFixed(4)}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>Latest guides</CardTitle>
              <CardDescription>Recently updated in your library</CardDescription>
            </div>
            <Link to="/guides">
              <Button variant="outline" size="sm">
                View all
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[hsl(var(--border))] text-left text-[hsl(var(--muted-foreground))]">
                    <th className="px-4 py-2 font-medium">Title</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Updated</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {guidesQ.isLoading ? (
                    Array.from({ length: 4 }).map((_, i) => (
                      <tr key={i} className="border-b border-[hsl(var(--border))]">
                        <td className="px-4 py-3" colSpan={4}>
                          <Skeleton className="h-4 w-full" />
                        </td>
                      </tr>
                    ))
                  ) : recent.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-[hsl(var(--muted-foreground))]">
                        No guides yet.{" "}
                        <Link to="/new" className="text-[hsl(var(--foreground))] underline">
                          Create your first guide
                        </Link>
                      </td>
                    </tr>
                  ) : (
                    recent.map((g) => {
                      const slug = g.slug || g.id;
                      return (
                        <tr key={slug} className="border-b border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]/40">
                          <td className="px-4 py-2.5 font-medium">{g.title || g.topic || slug}</td>
                          <td className="px-4 py-2.5">{statusBadge(g.status)}</td>
                          <td className="px-4 py-2.5 text-[hsl(var(--muted-foreground))]">
                            {formatDate(g.updatedAt || g.createdAt)}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <Link
                              to={`/guides/${encodeURIComponent(slug)}`}
                              className="inline-flex items-center text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                            >
                              Open <ArrowRight className="ml-1 h-3 w-3" />
                            </Link>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-4 w-4" />
              Active research
            </CardTitle>
            <CardDescription>Jobs currently in progress</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {jobsQ.isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : running.length === 0 ? (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">No active research jobs.</p>
            ) : (
              running.slice(0, 5).map((job) => {
                const id = job.id || job.jobId;
                return (
                  <Link
                    key={id}
                    to={`/research/${encodeURIComponent(id)}`}
                    className="block rounded-md border border-[hsl(var(--border))] p-3 transition-colors hover:bg-[hsl(var(--muted))]/50"
                  >
                    <p className="font-medium truncate">{job.topic || job.title || `Job ${id}`}</p>
                    <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                      {job.currentPhase || job.phase || "Research"} · {job.progress ?? 0}%
                      {job.llmUsage?.costUsd != null
                        ? ` · $${Number(job.llmUsage.costUsd).toFixed(3)} · ${job.llmUsage.totalTokens || 0} tok`
                        : ""}
                    </p>
                  </Link>
                );
              })
            )}
            <Link to="/research" className="block">
              <Button variant="outline" size="sm" className="w-full">
                <Search className="h-3.5 w-3.5" />
                Research history
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-3 text-xs text-[hsl(var(--muted-foreground))]">
        <FileText className="h-4 w-4" />
        <Image className="h-4 w-4" />
        <span>GuideForge research workspace</span>
      </div>
    </div>
  );
}
