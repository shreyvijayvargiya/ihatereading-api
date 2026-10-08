import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, Save } from "lucide-react";
import { getGuide, updateGuide } from "../services/api.js";
import { Button } from "../components/ui/button.jsx";
import { Textarea } from "../components/ui/textarea.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Skeleton } from "../components/ui/skeleton.jsx";

function extractMarkdown(guide) {
  if (!guide) return "";
  return (
    guide.markdown ||
    guide.finalGuide ||
    guide.content?.final ||
    (typeof guide.content === "string" ? guide.content : "") ||
    ""
  );
}

export function GuideEditorPage() {
  const { slug } = useParams();
  const queryClient = useQueryClient();
  const [markdown, setMarkdown] = useState("");
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const { data: guide, isLoading, isError, error } = useQuery({
    queryKey: ["guide", slug],
    queryFn: () => getGuide(slug),
  });

  useEffect(() => {
    if (guide) setMarkdown(extractMarkdown(guide));
  }, [guide]);

  const saveMutation = useMutation({
    mutationFn: (body) => updateGuide(slug, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["guide", slug] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  async function copyMarkdown() {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (isLoading) return <Skeleton className="mx-auto h-96 max-w-6xl w-full" />;
  if (isError) return <p className="text-red-600">{error.message}</p>;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Editor</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {guide?.title || slug} ·{" "}
            <Link to={`/guides/${encodeURIComponent(slug)}`} className="underline">
              Back to guide
            </Link>
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={copyMarkdown}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            Copy markdown
          </Button>
          <Button
            type="button"
            onClick={() => saveMutation.mutate({ markdown, finalGuide: markdown })}
            disabled={saveMutation.isPending}
          >
            <Save className="h-4 w-4" />
            {saved ? "Saved" : "Save"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Markdown</CardTitle>
          </CardHeader>
          <CardContent className="flex-1">
            <Textarea
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              className="min-h-[480px] font-mono text-xs"
            />
          </CardContent>
        </Card>
        <Card className="flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Preview</CardTitle>
          </CardHeader>
          <CardContent className="markdown-preview max-w-none flex-1 overflow-y-auto rounded-md border border-[hsl(var(--border))] p-4 text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown || "*Nothing to preview yet.*"}</ReactMarkdown>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
