import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getGuide } from "../services/api.js";
import { cn, formatDate } from "../lib/utils.js";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Skeleton } from "../components/ui/skeleton.jsx";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "research", label: "Research" },
  { id: "architecture", label: "Architecture" },
  { id: "apis", label: "APIs" },
  { id: "npm", label: "NPM" },
  { id: "github", label: "GitHub" },
  { id: "database", label: "Database" },
  { id: "roadmap", label: "Roadmap" },
  { id: "costs", label: "Costs" },
  { id: "images", label: "Images" },
  { id: "seo", label: "SEO/AEO" },
  { id: "final", label: "Final Guide" },
];

function pickSection(guide, tab) {
  const sections = guide?.sections || guide?.content || {};
  if (typeof sections === "string") return sections;
  const map = {
    overview: sections.overview ?? guide.summary ?? guide.description,
    research: sections.research ?? guide.research,
    architecture: sections.architecture,
    apis: sections.apis,
    npm: sections.npm,
    github: sections.github,
    database: sections.database,
    roadmap: sections.roadmap,
    costs: sections.costs,
    images: sections.images,
    seo: sections.seo ?? sections.seoAeo,
    final: sections.final ?? guide.markdown ?? guide.finalGuide,
  };
  const val = map[tab];
  if (val == null) return null;
  if (typeof val === "object") return JSON.stringify(val, null, 2);
  return String(val);
}

function renderContent(text) {
  if (!text) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))]">
        No content generated for this section yet.
      </p>
    );
  }
  return (
    <pre className="whitespace-pre-wrap rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 p-4 text-xs leading-relaxed">
      {text}
    </pre>
  );
}

export function GuideDetailPage() {
  const { slug } = useParams();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") || "overview";

  const onResearchRoute = location.pathname.endsWith("/research");

  const { data: guide, isLoading, isError, error } = useQuery({
    queryKey: ["guide", slug],
    queryFn: () => getGuide(slug),
  });

  const effectiveTab = onResearchRoute ? "research" : tab;

  function setTab(id) {
    const next = new URLSearchParams(searchParams);
    if (id === "overview") next.delete("tab");
    else next.set("tab", id);
    setSearchParams(next);
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl">
        <Skeleton className="mb-4 h-10 w-72" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (isError) {
    return <p className="text-red-600">{error.message}</p>;
  }

  const title = guide?.title || guide?.topic || slug;
  const status = guide?.status || "draft";

  return (
    <div className="mx-auto flex max-w-6xl gap-6">
      <nav className="hidden w-52 shrink-0 lg:block">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
          Sections
        </p>
        <ul className="space-y-0.5">
          {TABS.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "w-full rounded-md px-2.5 py-1.5 text-left text-sm text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]",
                  effectiveTab === t.id && "bg-[hsl(var(--muted))] font-medium text-[hsl(var(--foreground))]",
                )}
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-2 border-t border-[hsl(var(--border))] pt-4">
          <Link to={`/guides/${encodeURIComponent(slug)}/editor`}>
            <Button variant="outline" size="sm" className="w-full">
              Open editor
            </Button>
          </Link>
          <Link to={`/guides/${encodeURIComponent(slug)}/images`}>
            <Button variant="outline" size="sm" className="w-full">
              Image plans
            </Button>
          </Link>
        </div>
      </nav>

      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Updated {formatDate(guide.updatedAt || guide.createdAt)} ·{" "}
              <Badge variant={String(status).toLowerCase() === "completed" ? "success" : "muted"}>
                {status}
              </Badge>
            </p>
          </div>
          <div className="flex flex-wrap gap-2 lg:hidden">
            <select
              className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 text-sm"
              value={effectiveTab}
              onChange={(e) => setTab(e.target.value)}
            >
              {TABS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{TABS.find((t) => t.id === effectiveTab)?.label || "Section"}</CardTitle>
            <CardDescription>{slug}</CardDescription>
          </CardHeader>
          <CardContent>{renderContent(pickSection(guide, effectiveTab))}</CardContent>
        </Card>

        {effectiveTab === "images" ? (
          <Link to={`/guides/${encodeURIComponent(slug)}/images`}>
            <Button>Manage image plan</Button>
          </Link>
        ) : null}
      </div>
    </div>
  );
}
