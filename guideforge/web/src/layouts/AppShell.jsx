import { useMemo, useState } from "react";
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronRight,
  History,
  ImageIcon,
  LayoutDashboard,
  Moon,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
} from "lucide-react";
import { getGuides, getJobs } from "../services/api.js";
import { cn } from "../lib/utils.js";
import { useTheme } from "../lib/theme.jsx";
import { Input } from "../components/ui/input.jsx";
import { Button } from "../components/ui/button.jsx";
import { Separator } from "../components/ui/separator.jsx";
import { Badge } from "../components/ui/badge.jsx";

function NavItem({ to, end, icon: Icon, children, badge }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-[hsl(var(--foreground))]",
          isActive && "bg-[hsl(var(--sidebar-active))] text-[hsl(var(--foreground))] font-medium",
        )
      }
    >
      {Icon ? <Icon className="h-4 w-4 shrink-0 opacity-70" /> : null}
      <span className="flex-1 truncate">{children}</span>
      {badge != null && badge > 0 ? (
        <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1">
          {badge}
        </Badge>
      ) : null}
    </NavLink>
  );
}

function SidebarSection({ title, children }) {
  return (
    <div className="space-y-1">
      {title ? (
        <p className="px-2.5 text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          {title}
        </p>
      ) : null}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { resolved, setTheme } = useTheme();
  const [libraryQuery, setLibraryQuery] = useState(searchParams.get("q") || "");

  const { data: guidesData } = useQuery({
    queryKey: ["guides", "sidebar"],
    queryFn: () => getGuides(),
    staleTime: 30_000,
  });

  const { data: jobsData } = useQuery({
    queryKey: ["jobs", "active"],
    queryFn: () => getJobs({ status: "running" }),
    refetchInterval: 10_000,
  });

  const guides = useMemo(() => {
    const raw = guidesData?.guides ?? guidesData?.items ?? guidesData ?? [];
    return Array.isArray(raw) ? raw : [];
  }, [guidesData]);

  const activeJobs = useMemo(() => {
    const raw = jobsData?.jobs ?? jobsData?.items ?? jobsData ?? [];
    const list = Array.isArray(raw) ? raw : [];
    const done = new Set(["completed", "completed_with_warnings", "failed", "cancelled", "canceled"]);
    return list.filter((j) => !done.has(String(j.status).toLowerCase()));
  }, [jobsData]);

  const recentGuides = guides.slice(0, 8);

  function onSearchSubmit(e) {
    e.preventDefault();
    const q = libraryQuery.trim();
    navigate(q ? `/guides?q=${encodeURIComponent(q)}` : "/guides");
  }

  return (
    <div className="flex h-screen gap-2 overflow-hidden bg-[hsl(var(--background))] p-2">
      <aside className="mr-0 flex w-60 shrink-0 flex-col rounded-2xl border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar))] shadow-sm">
        <div className="border-b border-[hsl(var(--sidebar-border))] px-4 py-4">
          <Link to="/" className="block">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[hsl(var(--foreground))] text-[hsl(var(--background))]">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <p className="font-semibold leading-tight">GuideForge</p>
                <p className="text-[11px] text-[hsl(var(--muted-foreground))]">Research workspace</p>
              </div>
            </div>
          </Link>
        </div>

        <nav className="flex-1 space-y-4 overflow-y-auto p-3">
          <SidebarSection>
            <NavItem to="/" end icon={LayoutDashboard}>
              Dashboard
            </NavItem>
            <NavItem to="/new" icon={Plus}>
              New Guide
            </NavItem>
          </SidebarSection>

          <SidebarSection title="Research">
            <NavItem to="/research" icon={Search} badge={activeJobs.length}>
              Active / History
            </NavItem>
          </SidebarSection>

          <SidebarSection title="Guides">
            <NavItem to="/guides" end icon={BookOpen}>
              All
            </NavItem>
            <NavItem to="/guides?status=draft" icon={History}>
              Drafts
            </NavItem>
            <NavItem to="/guides?status=completed" icon={ChevronRight}>
              Completed
            </NavItem>
            {recentGuides.length > 0 ? (
              <div className="mt-2 space-y-0.5 border-t border-[hsl(var(--sidebar-border))] pt-2">
                {recentGuides.map((g) => {
                  const slug = g.slug || g.id;
                  const title = g.title || g.topic || slug;
                  return (
                    <NavLink
                      key={slug}
                      to={`/guides/${encodeURIComponent(slug)}`}
                      className={({ isActive }) =>
                        cn(
                          "block truncate rounded-md px-2.5 py-1 text-xs text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--sidebar-active))] hover:text-[hsl(var(--foreground))]",
                          isActive && "bg-[hsl(var(--sidebar-active))] text-[hsl(var(--foreground))]",
                        )
                      }
                      title={title}
                    >
                      {title}
                    </NavLink>
                  );
                })}
              </div>
            ) : null}
          </SidebarSection>

          <SidebarSection title="Assets">
            <NavItem to="/guides?tab=images" icon={ImageIcon}>
              Image Plans
            </NavItem>
          </SidebarSection>

          <Separator className="my-2" />

          <SidebarSection>
            <NavItem to="/settings" icon={Settings}>
              Settings
            </NavItem>
          </SidebarSection>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <header className="flex h-12 shrink-0 items-center gap-3 rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 shadow-sm">
          <form onSubmit={onSearchSubmit} className="relative max-w-md flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
            <Input
              value={libraryQuery}
              onChange={(e) => setLibraryQuery(e.target.value)}
              placeholder="Search your library"
              className="h-8 rounded-xl border-transparent bg-[hsl(var(--muted))]/50 pl-8 focus-visible:bg-[hsl(var(--card))]"
            />
          </form>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-xl"
            onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
            aria-label="Toggle theme"
          >
            {resolved === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </header>

        <main className="flex-1 overflow-y-auto rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]/40 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
