import { Hono } from "hono";
import { listJobs } from "../storage/jobs.js";

const jobs = new Hono();

jobs.get("/", async (c) => {
  const status = c.req.query("status");
  let items = await listJobs();
  if (status) {
    const want = String(status).toLowerCase();
    const done = new Set(["completed", "completed_with_warnings", "failed", "cancelled", "canceled"]);
    if (want === "running" || want === "active") {
      items = items.filter((j) => !done.has(String(j.status).toLowerCase()));
    } else {
      items = items.filter((j) => String(j.status).toLowerCase() === want);
    }
  }
  return c.json({
    jobs: items.map((j) => ({
      id: j.id,
      topic: j.topic,
      title: j.title,
      status: j.status,
      progress: j.progress,
      currentPhase: j.currentPhase,
      guideSlug: j.guideSlug,
      llmUsage: j.llmUsage || null,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      completedAt: j.completedAt,
    })),
  });
});

export default jobs;
