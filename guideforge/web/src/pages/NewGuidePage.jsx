import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Rocket } from "lucide-react";
import { createResearchJob } from "../services/api.js";
import { cn } from "../lib/utils.js";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Textarea } from "../components/ui/textarea.jsx";
import { Label } from "../components/ui/label.jsx";
import { Checkbox } from "../components/ui/checkbox.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Badge } from "../components/ui/badge.jsx";

const AUDIENCE_OPTIONS = [
  "Beginner",
  "Intermediate",
  "Senior Engineer",
  "Founder",
  "AI Engineer",
  "Full Stack Developer",
];

const PHASE_OPTIONS = [
  { key: "searchDemand", label: "Search demand", desc: "Keywords, questions, and how people search this topic." },
  { key: "competitors", label: "Competitor / SERP research", desc: "What existing guides and products already cover." },
  { key: "productDecomposition", label: "Product decomposition", desc: "Break the product into systems and modules." },
  { key: "architecture", label: "Architecture research", desc: "System design, agent loops, and technical patterns." },
  { key: "apis", label: "API research", desc: "Provider APIs, auth, limits, and when to use them." },
  { key: "npm", label: "NPM package research", desc: "Libraries that map to real architectural needs." },
  { key: "github", label: "GitHub repository research", desc: "Open-source repos to learn from or fork." },
  { key: "ui", label: "UI library research", desc: "Editors, chat UIs, dashboards, and component stacks." },
  { key: "database", label: "Database schema research", desc: "Tables, relationships, and persistence design." },
  { key: "folderStructure", label: "Folder structure research", desc: "Production project layout and module boundaries." },
  { key: "costs", label: "Cost research", desc: "LLM, infra, and unit-economics assumptions." },
  { key: "buildVsBuy", label: "Build vs Buy", desc: "What to build, buy, or take from open source." },
  { key: "security", label: "Security", desc: "Auth, sandboxing, prompt injection, and secrets." },
  { key: "performance", label: "Performance", desc: "Caching, streaming, queues, and token efficiency." },
  { key: "testing", label: "Testing", desc: "Unit, integration, eval, and prompt regression tests." },
  { key: "deployment", label: "Deployment", desc: "Local setup, hosting, CI/CD, and ops basics." },
  { key: "seo", label: "SEO", desc: "Search-oriented structure and topical coverage." },
  { key: "aeo", label: "AEO", desc: "Answer-engine friendly definitions, FAQs, and tables." },
  { key: "internalLinks", label: "Internal iHateReading links", desc: "Verified related roadmaps and articles only." },
  { key: "images", label: "Image planning", desc: "Banner and diagram prompts for the final guide." },
];

const DEFAULT_PHASES = Object.fromEntries(PHASE_OPTIONS.map((p) => [p.key, true]));

export function NewGuidePage() {
  const navigate = useNavigate();
  const [topic, setTopic] = useState("");
  const [description, setDescription] = useState("");
  const [primaryKeywords, setPrimaryKeywords] = useState("");
  const [secondaryKeywords, setSecondaryKeywords] = useState("");
  const [audience, setAudience] = useState(["AI Engineer", "Full Stack Developer"]);
  const [phases, setPhases] = useState(DEFAULT_PHASES);
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: createResearchJob,
    onSuccess: (data) => {
      const id = data?.id || data?.jobId || data?.researchId;
      if (id) navigate(`/research/${encodeURIComponent(id)}`);
      else setError("Research started but no job id returned.");
    },
    onError: (err) => setError(err.message),
  });

  function toggleAudience(item) {
    setAudience((prev) =>
      prev.includes(item) ? prev.filter((a) => a !== item) : [...prev, item],
    );
  }

  function togglePhase(key) {
    setPhases((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!topic.trim()) {
      setError("Topic is required.");
      return;
    }
    mutation.mutate({
      topic: topic.trim(),
      description: description.trim(),
      primaryKeywords: primaryKeywords
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      secondaryKeywords: secondaryKeywords
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      audience,
      depth: "deep",
      phases,
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New Guide</h1>
        <p className="text-[hsl(var(--muted-foreground))]">
          Configure research parameters, then launch a multi-phase job.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Guide brief</CardTitle>
            <CardDescription>What should this guide cover?</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="topic">Topic *</Label>
              <Input
                id="topic"
                placeholder="How to Build an AI Coding Agent Like Cursor"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Goals, angle, and constraints for the guide..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="min-h-[100px]"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="primary">Primary keywords</Label>
                <Input
                  id="primary"
                  placeholder="AI coding agent, cursor clone"
                  value={primaryKeywords}
                  onChange={(e) => setPrimaryKeywords(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="secondary">Secondary keywords</Label>
                <Input
                  id="secondary"
                  placeholder="codebase indexing, RAG coding agent"
                  value={secondaryKeywords}
                  onChange={(e) => setSecondaryKeywords(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Audience</CardTitle>
            <CardDescription>Select all that apply</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {AUDIENCE_OPTIONS.map((item) => {
                const selected = audience.includes(item);
                return (
                  <button
                    key={item}
                    type="button"
                    onClick={() => toggleAudience(item)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      selected
                        ? "border-[hsl(var(--foreground))] bg-[hsl(var(--foreground))] text-[hsl(var(--background))]"
                        : "border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]",
                    )}
                  >
                    {item}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Research requirements</CardTitle>
            <CardDescription>
              Choose which research phases to run. Each phase gathers a different evidence type for the final guide.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {PHASE_OPTIONS.map(({ key, label, desc }) => (
              <label
                key={key}
                htmlFor={`phase-${key}`}
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-[hsl(var(--border))] px-3 py-2.5 hover:bg-[hsl(var(--muted))]/40"
              >
                <Checkbox
                  checked={phases[key]}
                  onCheckedChange={() => togglePhase(key)}
                  id={`phase-${key}`}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium">{label}</span>
                    {phases[key] ? (
                      <Badge variant="secondary" className="ml-auto shrink-0">
                        On
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="ml-auto shrink-0">
                        Off
                      </Badge>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs text-[hsl(var(--muted-foreground))]">{desc}</span>
                </span>
              </label>
            ))}
          </CardContent>
        </Card>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => navigate("/")}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Rocket className="h-4 w-4" />
                Start Research
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
