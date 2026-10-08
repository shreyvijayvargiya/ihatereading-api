import { randomUUID } from "node:crypto";
import { jobPath, readJson, writeJson, listJobFiles } from "../storage/filesystem.js";

export async function createJob(input) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    status: "queued",
    topic: input.topic,
    title: input.topic,
    description: input.description || "",
    keywords: input.keywords || { primary: [], secondary: [] },
    primaryKeywords: input.keywords?.primary || input.primaryKeywords || [],
    secondaryKeywords: input.keywords?.secondary || input.secondaryKeywords || [],
    audience: input.audience || [],
    depth: input.depth || "deep",
    phasesEnabled: input.phases || {},
    guideSlug: null,
    progress: 0,
    currentPhase: "queued",
    phases: [],
    queries: [],
    scrapedUrls: [],
    sources: [],
    activity: [],
    evidence: [],
    research: {},
    llmCalls: [],
    llmUsage: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      failed: 0,
    },
    warnings: [],
    error: null,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    completedAt: null,
  };
  await writeJson(jobPath(id), job);
  return job;
}

export async function getJob(id) {
  return readJson(jobPath(id), null);
}

export async function saveJob(job) {
  // Preserve LLM usage written concurrently by openrouter appendLlmCall
  const existing = await readJson(jobPath(job.id), null);
  if (existing?.llmCalls?.length) {
    const incoming = job.llmCalls?.length || 0;
    if (incoming < existing.llmCalls.length) {
      job.llmCalls = existing.llmCalls;
      job.llmUsage = existing.llmUsage;
    }
  }
  job.updatedAt = new Date().toISOString();
  await writeJson(jobPath(job.id), job);
  return job;
}

export async function appendActivity(job, message, meta = {}) {
  job.activity = job.activity || [];
  job.activity.push({
    at: new Date().toISOString(),
    message,
    ...meta,
  });
  if (job.activity.length > 400) job.activity = job.activity.slice(-400);
}

export async function appendLlmCall(jobId, record) {
  const job = await getJob(jobId);
  if (!job) return null;
  job.llmCalls = job.llmCalls || [];
  job.llmCalls.push(record);
  if (job.llmCalls.length > 200) job.llmCalls = job.llmCalls.slice(-200);
  const { rollupUsage } = await import("../ai/usage.js");
  job.llmUsage = rollupUsage(job.llmCalls);
  await appendActivity(
    job,
    `AI call ${record.ok ? "ok" : "failed"}: ${record.label} · ${record.totalTokens || 0} tok · $${record.costUsd}${record.costEstimated ? "~" : ""}`,
    {
      type: "llm",
      callId: record.id,
      costUsd: record.costUsd,
      totalTokens: record.totalTokens,
    },
  );
  await saveJob(job);
  return job;
}

export async function listJobs() {
  const files = await listJobFiles();
  const jobs = [];
  for (const file of files) {
    const job = await readJson(jobPath(file.replace(/\.json$/, "")), null);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
