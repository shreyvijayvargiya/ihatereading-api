import { Hono } from "hono";
import { createJob, getJob, listJobs } from "../storage/jobs.js";
import { enqueueResearchJob } from "../research/orchestrator.js";
import { splitKeywords } from "../utils/helpers.js";

const research = new Hono();

research.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const topic = String(body.topic || "").trim();
  if (!topic) return c.json({ error: "topic is required" }, 400);

  const primary = splitKeywords(
    body.keywords?.primary ?? body.primaryKeywords ?? [],
  );
  const secondary = splitKeywords(
    body.keywords?.secondary ?? body.secondaryKeywords ?? [],
  );

  const job = await createJob({
    topic,
    description: body.description || "",
    keywords: { primary, secondary },
    primaryKeywords: primary,
    secondaryKeywords: secondary,
    audience: Array.isArray(body.audience) ? body.audience : [],
    depth: body.depth || "deep",
    phases: body.phases || {},
  });

  enqueueResearchJob(job.id);
  return c.json({ jobId: job.id, id: job.id, status: "queued" }, 202);
});

research.get("/:id", async (c) => {
  const job = await getJob(c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

research.get("/:id/results", async (c) => {
  const job = await getJob(c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json({
    id: job.id,
    status: job.status,
    guideSlug: job.guideSlug,
    research: job.research,
    sources: job.sources,
    evidence: job.evidence,
    queries: job.queries,
    warnings: job.warnings,
  });
});

export default research;
export { listJobs };
