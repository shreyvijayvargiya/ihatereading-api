import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, RefreshCw, Sparkles } from "lucide-react";
import { getGuide, getImagePlan, markImageGenerated, regenerateImagePrompt } from "../services/api.js";
import { useState } from "react";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Skeleton } from "../components/ui/skeleton.jsx";

function normalizeImages(data) {
  const raw = data?.images ?? data?.items ?? data?.plan ?? (Array.isArray(data) ? data : []);
  return Array.isArray(raw) ? raw : [];
}

export function GuideImagesPage() {
  const { slug } = useParams();
  const queryClient = useQueryClient();
  const [copiedId, setCopiedId] = useState(null);

  const guideQ = useQuery({ queryKey: ["guide", slug], queryFn: () => getGuide(slug) });
  const planQ = useQuery({ queryKey: ["image-plan", slug], queryFn: () => getImagePlan(slug) });

  const regenMutation = useMutation({
    mutationFn: (imageId) => regenerateImagePrompt(slug, imageId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["image-plan", slug] }),
  });

  const markMutation = useMutation({
    mutationFn: (imageId) => markImageGenerated(slug, imageId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["image-plan", slug] }),
  });

  const images = normalizeImages(planQ.data);
  const title = guideQ.data?.title || guideQ.data?.topic || slug;

  async function copyPrompt(image) {
    const id = image.id || image.imageId;
    const text = image.prompt || image.imagePrompt || "";
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  if (planQ.isLoading) return <Skeleton className="mx-auto h-64 max-w-4xl w-full" />;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Image plans</h1>
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          {title} ·{" "}
          <Link to={`/guides/${encodeURIComponent(slug)}`} className="underline">
            Back to guide
          </Link>
        </p>
      </div>

      {planQ.isError ? (
        <p className="text-sm text-red-600">{planQ.error.message}</p>
      ) : images.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-[hsl(var(--muted-foreground))]">
            No image plan yet for this guide.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {images.map((image) => {
            const id = image.id || image.imageId || image.slug;
            const generated = image.generated || image.status === "generated";
            return (
              <Card key={id}>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">{image.title || image.section || `Image ${id}`}</CardTitle>
                      <CardDescription>{image.placement || image.context || image.alt}</CardDescription>
                    </div>
                    {generated ? (
                      <Badge variant="success">Generated</Badge>
                    ) : (
                      <Badge variant="muted">Planned</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <pre className="whitespace-pre-wrap rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 p-3 text-xs">
                    {image.prompt || image.imagePrompt || "—"}
                  </pre>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => copyPrompt(image)}>
                      {copiedId === id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      Copy prompt
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={regenMutation.isPending}
                      onClick={() => regenMutation.mutate(id)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Regenerate prompt
                    </Button>
                    {!generated ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={markMutation.isPending}
                        onClick={() => markMutation.mutate(id)}
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        Mark generated
                      </Button>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
