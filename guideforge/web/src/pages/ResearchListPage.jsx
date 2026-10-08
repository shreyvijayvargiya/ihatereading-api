import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getJobs } from "../services/api.js";
import { cn, formatDateTime } from "../lib/utils.js";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Skeleton } from "../components/ui/skeleton.jsx";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "running", label: "Active" },
  { id: "completed", label: "Completed" },
  { id: "failed", label: "Failed" },
];

function jobStatusBadge(status) {
  const s = String(status || "").toLowerCase();
  if (["running", "active", "in_progress"].includes(s)) return <Badge variant="warning">Running</Badge>;
  if (["completed", "done", "success"].includes(s)) return <Badge variant="success">Done</Badge>;
  if (["failed", "error"].includes(s)) return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="muted">{status || "Unknown"}</Badge>;
}

export function ResearchListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get("status") || "all";

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["jobs", filter],
    queryFn: () => getJobs(filter === "all" ? {} : { status: filter }),
  });

  const jobs = data?.jobs ?? data?.items ?? (Array.isArray(data) ? data : []);

  function setFilter(id) {
    if (id === "all") setSearchParams({});
    else setSearchParams({ status: id });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Research</h1>
        <p className="text-[hsl(var(--muted-foreground))]">Active jobs and history</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f.id
                ? "border-[hsl(var(--foreground))] bg-[hsl(var(--foreground))] text-[hsl(var(--background))]"
                : "border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isError ? (
        <p className="text-sm text-red-600">{error.message}</p>
      ) : isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : jobs.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-[hsl(var(--muted-foreground))]">
            No research jobs found.{" "}
            <Link to="/new" className="text-[hsl(var(--foreground))] underline">
              Start one
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const id = job.id || job.jobId;
            return (
              <Link key={id} to={`/research/${encodeURIComponent(id)}`}>
                <Card className="transition-colors hover:bg-[hsl(var(--muted))]/30">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="text-base">{job.topic || job.title || `Job ${id}`}</CardTitle>
                        <CardDescription>{formatDateTime(job.createdAt || job.startedAt)}</CardDescription>
                      </div>
                      {jobStatusBadge(job.status)}
                    </div>
                  </CardHeader>
                  <CardContent className="text-xs text-[hsl(var(--muted-foreground))]">
                    Phase: {job.currentPhase || job.phase || "—"} · Progress: {job.progress ?? 0}%
                    {job.guideSlug ? (
                      <>
                        {" "}
                        · Guide:{" "}
                        <span className="text-[hsl(var(--foreground))]">{job.guideSlug}</span>
                      </>
                    ) : null}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
