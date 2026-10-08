import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  ExternalLink,
  Globe,
  ListTree,
  Radio,
  Search,
} from "lucide-react";
import { getResearchJob } from "../services/api.js";
import { cn, formatDateTime } from "../lib/utils.js";
import { Badge } from "../components/ui/badge.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Skeleton } from "../components/ui/skeleton.jsx";
import { Button } from "../components/ui/button.jsx";

function isRunning(status) {
  const s = String(status || "").toLowerCase();
  return ![
    "completed",
    "completed_with_warnings",
    "failed",
    "cancelled",
    "canceled",
  ].includes(s);
}

function PhaseBlock({ phase, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const name = phase.name || phase.id || phase.phase || "Phase";
  const status = phase.status || "pending";
  return (
    <div className="rounded-md border border-[hsl(var(--border))]">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[hsl(var(--muted))]/40"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="font-medium flex-1">{name}</span>
        <Badge variant="muted">{status}</Badge>
      </button>
      {open ? (
        <div className="space-y-2 border-t border-[hsl(var(--border))] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">
          {phase.summary ? <p>{phase.summary}</p> : null}
          {phase.error ? <p className="text-red-600">{phase.error}</p> : null}
          {Array.isArray(phase.queries) && phase.queries.length > 0 ? (
            <div>
              <p className="mb-1 font-medium text-[hsl(var(--foreground))]">Queries</p>
              <ul className="list-disc space-y-0.5 pl-4">
                {phase.queries.map((q) => (
                  <li key={typeof q === "string" ? q : q.query}>{typeof q === "string" ? q : q.query}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {Array.isArray(phase.urls) && phase.urls.length > 0 ? (
            <div>
              <p className="mb-1 font-medium text-[hsl(var(--foreground))]">URLs</p>
              <ul className="list-disc space-y-0.5 pl-4">
                {phase.urls.slice(0, 8).map((u) => (
                  <li key={u} className="truncate">
                    {u}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {Array.isArray(phase.notes) && phase.notes.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-4">
              {phase.notes.slice(0, 6).map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ResearchJobPage() {
  const { id } = useParams();

  const { data: job, isLoading, isError, error } = useQuery({
    queryKey: ["research", id],
    queryFn: () => getResearchJob(id),
    refetchInterval: (query) => {
      const j = query.state.data;
      if (!j) return 2000;
      return isRunning(j.status) ? 2000 : false;
    },
  });

  const progress = job?.progress ?? job?.percentComplete ?? 0;
  const phases = job?.phases ?? job?.phaseLog ?? [];
  const queries = job?.queries ?? job?.queryLog ?? job?.searchQueries ?? [];
  const urls = job?.scrapedUrls ?? job?.urls ?? job?.sources ?? [];
  const activity = job?.activity ?? job?.events ?? job?.log ?? [];
  const llmCalls = job?.llmCalls ?? [];
  const llmUsage = job?.llmUsage ?? null;

  const guideSlug = job?.guideSlug || job?.slug;

  const statusLabel = useMemo(() => String(job?.status || "unknown"), [job]);
  const [openCallId, setOpenCallId] = useState(null);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto max-w-5xl">
        <p className="text-red-600">{error.message}</p>
        <Link to="/research" className="mt-4 inline-block">
          <Button variant="outline">Back to research</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
            <Radio className={cn("h-3.5 w-3.5", isRunning(job.status) && "text-amber-500 animate-pulse")} />
            Research console · {id}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {job.topic || job.title || "Research job"}
          </h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            Started {formatDateTime(job.createdAt || job.startedAt)} · Status{" "}
            <Badge variant={isRunning(job.status) ? "warning" : "secondary"}>{statusLabel}</Badge>
          </p>
        </div>
        {guideSlug ? (
          <Link to={`/guides/${encodeURIComponent(guideSlug)}`}>
            <Button variant="outline" size="sm">
              Open guide
            </Button>
          </Link>
        ) : null}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Progress</CardTitle>
          <CardDescription>
            Current phase: {job.currentPhase || job.phase || "—"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-2 flex justify-between text-xs text-[hsl(var(--muted-foreground))]">
            <span>{progress}%</span>
            {isRunning(job.status) ? <span className="text-amber-600">Live · polling every 2s</span> : null}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[hsl(var(--muted))]">
            <div
              className="h-full rounded-full bg-[hsl(var(--foreground))] transition-all duration-500"
              style={{ width: `${Math.min(100, Math.max(0, Number(progress) || 0))}%` }}
            />
          </div>
          {llmUsage ? (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-[hsl(var(--border))] px-2 py-1.5">
                <p className="text-[10px] text-[hsl(var(--muted-foreground))]">AI calls</p>
                <p className="font-semibold tabular-nums">{llmUsage.calls ?? 0}</p>
              </div>
              <div className="rounded-lg border border-[hsl(var(--border))] px-2 py-1.5">
                <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Tokens</p>
                <p className="font-semibold tabular-nums">{llmUsage.totalTokens ?? 0}</p>
              </div>
              <div className="rounded-lg border border-[hsl(var(--border))] px-2 py-1.5">
                <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Cost (USD)</p>
                <p className="font-semibold tabular-nums">${Number(llmUsage.costUsd || 0).toFixed(4)}</p>
              </div>
              <div className="rounded-lg border border-[hsl(var(--border))] px-2 py-1.5">
                <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Failed</p>
                <p className="font-semibold tabular-nums">{llmUsage.failed ?? 0}</p>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4" />
            AI API calls
          </CardTitle>
          <CardDescription>
            Prompt preview, tokens, and estimated USD per OpenRouter call
          </CardDescription>
        </CardHeader>
        <CardContent className="max-h-96 space-y-2 overflow-y-auto">
          {llmCalls.length === 0 ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              No AI calls yet. If OpenRouter key is invalid, calls will appear here as failed.
            </p>
          ) : (
            llmCalls.map((call) => {
              const open = openCallId === call.id;
              return (
                <div key={call.id} className="rounded-xl border border-[hsl(var(--border))]">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[hsl(var(--muted))]/40"
                    onClick={() => setOpenCallId(open ? null : call.id)}
                  >
                    {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    <span className="flex-1 font-medium">{call.label || call.phase || "chat"}</span>
                    <Badge variant={call.ok ? "success" : "warning"}>{call.ok ? "ok" : "fail"}</Badge>
                    <span className="tabular-nums text-[hsl(var(--muted-foreground))]">
                      {call.totalTokens || 0} tok
                    </span>
                    <span className="tabular-nums font-medium">
                      ${Number(call.costUsd || 0).toFixed(4)}
                      {call.costEstimated ? "~" : ""}
                    </span>
                  </button>
                  {open ? (
                    <div className="space-y-2 border-t border-[hsl(var(--border))] px-3 py-2 text-xs">
                      <p className="text-[hsl(var(--muted-foreground))]">
                        {formatDateTime(call.at)} · {call.model || "—"} · {call.latencyMs || 0}ms
                        {call.error ? <span className="text-red-600"> · {call.error}</span> : null}
                      </p>
                      <p>
                        prompt {call.promptTokens || 0} · completion {call.completionTokens || 0} · total{" "}
                        {call.totalTokens || 0}
                      </p>
                      {call.systemPreview ? (
                        <div>
                          <p className="mb-1 font-medium">System</p>
                          <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded-lg bg-[hsl(var(--muted))]/50 p-2">
                            {call.systemPreview}
                          </pre>
                        </div>
                      ) : null}
                      {call.promptPreview ? (
                        <div>
                          <p className="mb-1 font-medium">Prompt</p>
                          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-[hsl(var(--muted))]/50 p-2">
                            {call.promptPreview}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ListTree className="h-4 w-4" />
              Phases
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {Array.isArray(phases) && phases.length > 0 ? (
              phases.map((p, i) => (
                <PhaseBlock key={p.id || p.name || i} phase={p} defaultOpen={i === phases.length - 1} />
              ))
            ) : (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">No phase breakdown yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Search className="h-4 w-4" />
              Query log
            </CardTitle>
          </CardHeader>
          <CardContent className="max-h-64 space-y-2 overflow-y-auto text-xs">
            {Array.isArray(queries) && queries.length > 0 ? (
              queries.map((q, i) => (
                <div key={i} className="rounded border border-[hsl(var(--border))] px-2 py-1.5 font-mono">
                  {typeof q === "string" ? q : q.query || q.text || JSON.stringify(q)}
                </div>
              ))
            ) : (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">No queries logged yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4" />
              Scraped URLs
            </CardTitle>
          </CardHeader>
          <CardContent className="max-h-64 space-y-2 overflow-y-auto text-xs">
            {Array.isArray(urls) && urls.length > 0 ? (
              urls.map((u, i) => {
                const href = typeof u === "string" ? u : u.url || u.link;
                const title = typeof u === "object" ? u.title : null;
                return (
                  <a
                    key={i}
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-start gap-2 rounded border border-[hsl(var(--border))] px-2 py-1.5 hover:bg-[hsl(var(--muted))]/40"
                  >
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 opacity-60" />
                    <span className="break-all">
                      {title ? <span className="block font-medium text-[hsl(var(--foreground))]">{title}</span> : null}
                      {href}
                    </span>
                  </a>
                );
              })
            ) : (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">No URLs scraped yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Activity feed</CardTitle>
          </CardHeader>
          <CardContent className="max-h-64 space-y-2 overflow-y-auto text-xs">
            {Array.isArray(activity) && activity.length > 0 ? (
              activity.map((ev, i) => (
                <div key={i} className="border-l-2 border-[hsl(var(--border))] pl-2">
                  <p className="text-[hsl(var(--muted-foreground))]">
                    {formatDateTime(ev.at || ev.timestamp || ev.time)}
                  </p>
                  <p>{ev.message || ev.text || ev.type || JSON.stringify(ev)}</p>
                </div>
              ))
            ) : (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">Waiting for activity…</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
