import { Hono } from "hono";
import {
  getGuide,
  listGuides,
  updateGuideMarkdown,
  getImagePlan,
  saveImagePlan,
} from "../guides/storage.js";
import { planImages } from "../ai/pipeline.js";

const guides = new Hono();

guides.get("/", async (c) => {
  const status = c.req.query("status");
  const q = c.req.query("q");
  const items = await listGuides({ status, q });
  return c.json({ guides: items });
});

guides.get("/:slug", async (c) => {
  const guide = await getGuide(c.req.param("slug"));
  if (!guide) return c.json({ error: "Guide not found" }, 404);
  return c.json(guide);
});

guides.patch("/:slug", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const slug = c.req.param("slug");
  if (body.markdown != null || body.content != null) {
    const updated = await updateGuideMarkdown(slug, body.markdown ?? body.content);
    if (!updated) return c.json({ error: "Guide not found" }, 404);
    return c.json(updated);
  }
  return c.json({ error: "No updatable fields" }, 400);
});

guides.put("/:slug", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const updated = await updateGuideMarkdown(c.req.param("slug"), body.markdown ?? body.content ?? "");
  if (!updated) return c.json({ error: "Guide not found" }, 404);
  return c.json(updated);
});

guides.get("/:slug/image-plan", async (c) => {
  const plan = await getImagePlan(c.req.param("slug"));
  return c.json(plan);
});

guides.get("/:slug/images", async (c) => {
  const plan = await getImagePlan(c.req.param("slug"));
  return c.json(plan);
});

guides.post("/:slug/images/:imageId/regenerate-prompt", async (c) => {
  const slug = c.req.param("slug");
  const imageId = c.req.param("imageId");
  const guide = await getGuide(slug);
  if (!guide) return c.json({ error: "Guide not found" }, 404);
  const plan = await getImagePlan(slug);
  const images = await planImages(
    { topic: guide.title, audience: guide.audience },
    guide.markdown || "",
  );
  const fresh = images.find((img) => img.id === imageId) || images[0];
  const next = (plan.images || []).map((img) =>
    img.id === imageId
      ? { ...img, prompt: fresh?.prompt || img.prompt, status: "planned" }
      : img,
  );
  await saveImagePlan(slug, next);
  return c.json({ images: next, image: next.find((i) => i.id === imageId) });
});

guides.post("/:slug/images/:imageId/generated", async (c) => {
  const slug = c.req.param("slug");
  const imageId = c.req.param("imageId");
  const plan = await getImagePlan(slug);
  const next = (plan.images || []).map((img) =>
    img.id === imageId ? { ...img, status: "generated", generatedAt: new Date().toISOString() } : img,
  );
  await saveImagePlan(slug, next);
  return c.json({ images: next });
});

export default guides;
