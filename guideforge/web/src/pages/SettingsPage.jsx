import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { getSettings, updateSettings, getHealth } from "../services/api.js";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Textarea } from "../components/ui/textarea.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Skeleton } from "../components/ui/skeleton.jsx";

function flattenSettings(data) {
  if (!data || typeof data !== "object") return {};
  const { site, ...rest } = data;
  if (site && typeof site === "object") return { ...rest, ...site };
  return { ...rest };
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({});
  const [message, setMessage] = useState("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
  });

  const healthQ = useQuery({
    queryKey: ["health", "settings"],
    queryFn: getHealth,
    refetchInterval: 30_000,
  });
  const openRouter = healthQ.data?.openRouter;

  useEffect(() => {
    if (data) setForm(flattenSettings(data));
  }, [data]);

  const mutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setMessage("Settings saved.");
      setTimeout(() => setMessage(""), 3000);
    },
    onError: (err) => setMessage(err.message),
  });

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    mutation.mutate(form);
  }

  const fields = Object.keys(form).length
    ? Object.keys(form)
    : ["siteName", "siteUrl", "defaultAuthor", "researchModel", "writerModel", "imageStyle"];

  if (isLoading) return <Skeleton className="mx-auto h-64 max-w-2xl w-full" />;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-[hsl(var(--muted-foreground))]">Site configuration from the GuideForge API</p>
      </div>

      {isError ? <p className="text-sm text-red-600">{error.message}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>OpenRouter</CardTitle>
          <CardDescription>
            Add the API key only in <code className="text-xs">guideforge/server/.env</code> — not the Vite app, not the browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            File: <code className="rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 text-xs">guideforge/server/.env</code>
          </p>
          <pre className="overflow-x-auto rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 p-3 text-xs">
{`OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=openai/gpt-4o-mini`}
          </pre>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-[hsl(var(--muted-foreground))]">Chat status</span>
            {openRouter?.chatOk ? (
              <Badge variant="success">OK</Badge>
            ) : (
              <Badge variant="warning">{openRouter?.error || "checking…"}</Badge>
            )}
            {openRouter?.model ? (
              <span className="text-xs text-[hsl(var(--muted-foreground))]">model: {openRouter.model}</span>
            ) : null}
          </div>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Restart the GuideForge server after changing the key. A <code>User not found</code> error means the key is invalid or revoked.
          </p>
        </CardContent>
      </Card>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Site config</CardTitle>
            <CardDescription>Values are loaded and saved via PATCH /api/settings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {fields.map((key) => {
              const value = form[key] ?? "";
              const isLong = typeof value === "string" && value.length > 80;
              return (
                <div key={key} className="space-y-2">
                  <Label htmlFor={key}>{key}</Label>
                  {isLong || key.toLowerCase().includes("prompt") ? (
                    <Textarea
                      id={key}
                      value={String(value)}
                      onChange={(e) => setField(key, e.target.value)}
                    />
                  ) : (
                    <Input
                      id={key}
                      value={String(value)}
                      onChange={(e) => setField(key, e.target.value)}
                    />
                  )}
                </div>
              );
            })}
            {Object.keys(form).length === 0 && !isError ? (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                No settings returned yet. Submit to seed defaults on the server.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="mt-4 flex items-center gap-3">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save settings
          </Button>
          {message ? <span className="text-sm text-[hsl(var(--muted-foreground))]">{message}</span> : null}
        </div>
      </form>
    </div>
  );
}
