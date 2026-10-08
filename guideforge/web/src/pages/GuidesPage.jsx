import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { getGuides } from "../services/api.js";
import { cn, formatDate } from "../lib/utils.js";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent } from "../components/ui/card.jsx";
import { Skeleton } from "../components/ui/skeleton.jsx";

const STATUS_CHIPS = [
  { param: null, label: "All" },
  { param: "draft", label: "Drafts" },
  { param: "completed", label: "Completed" },
];

function statusBadge(status) {
  const s = String(status || "draft").toLowerCase();
  if (s === "completed" || s === "done") return <Badge variant="success">Completed</Badge>;
  return <Badge variant="muted">Draft</Badge>;
}

export function GuidesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status");
  const q = searchParams.get("q") || "";

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["guides", status, q],
    queryFn: () => getGuides({ status: status || undefined, q: q || undefined }),
  });

  const guides = data?.guides ?? data?.items ?? (Array.isArray(data) ? data : []);

  function setStatus(param) {
    const next = new URLSearchParams(searchParams);
    if (param) next.set("status", param);
    else next.delete("status");
    setSearchParams(next);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Guides</h1>
          <p className="text-[hsl(var(--muted-foreground))]">
            {q ? `Results for “${q}”` : "Your research-backed guide library"}
          </p>
        </div>
        <Link to="/new">
          <Button>
            <Plus className="h-4 w-4" />
            New Guide
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_CHIPS.map((chip) => {
          const active = (chip.param || null) === (status || null);
          return (
            <button
              key={chip.label}
              type="button"
              onClick={() => setStatus(chip.param)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-[hsl(var(--foreground))] bg-[hsl(var(--foreground))] text-[hsl(var(--background))]"
                  : "border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]",
              )}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {isError ? (
        <p className="text-sm text-red-600">{error.message}</p>
      ) : isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : guides.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-[hsl(var(--muted-foreground))]">
            No guides match this filter.
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 text-left text-[hsl(var(--muted-foreground))]">
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {guides.map((g) => {
                const slug = g.slug || g.id;
                return (
                  <tr key={slug} className="border-b border-[hsl(var(--border))] last:border-0 hover:bg-[hsl(var(--muted))]/30">
                    <td className="px-4 py-3">
                      <Link
                        to={`/guides/${encodeURIComponent(slug)}`}
                        className="font-medium hover:underline"
                      >
                        {g.title || g.topic || slug}
                      </Link>
                      {g.description ? (
                        <p className="mt-0.5 line-clamp-1 text-xs text-[hsl(var(--muted-foreground))]">
                          {g.description}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">{statusBadge(g.status)}</td>
                    <td className="px-4 py-3 text-[hsl(var(--muted-foreground))]">
                      {formatDate(g.updatedAt || g.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
