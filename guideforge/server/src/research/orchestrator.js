import path from "node:path";
import { budgets, getEnv } from "../config/env.js";
import { searchGoogle, scrapeUrl, scrapeMultiple } from "../scraper/client.js";
import { appendActivity, getJob, saveJob } from "../storage/jobs.js";
import { expandPhaseFlags, hostnameOf, nowIso, PHASE_DEFS } from "../utils/helpers.js";
import { planResearch, synthesizeEvidence, writeGuideMarkdown, planImages } from "../ai/pipeline.js";
import { composeGuide, injectImagePlaceholders } from "../ai/compose.js";
import { createGuideShell, saveGuideArtifacts } from "../guides/storage.js";
import { researchDir, writeJson } from "../storage/filesystem.js";
import { runWithLlmContext } from "../ai/context.js";

function cleanExcerpt(text) {
  return String(text || "")
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b(Skip to main content|Read in English|Edit|Cookie|Sign in|Subscribe)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function initPhases(enabled) {
  return PHASE_DEFS.map((def) => ({
    id: def.id,
    name: def.name,
    status: enabled[def.id] ? "pending" : "skipped",
    startedAt: null,
    completedAt: null,
    queries: [],
    urls: [],
    itemsFound: 0,
    notes: [],
    summary: enabled[def.id] ? "" : "Skipped by configuration",
    error: null,
  }));
}

async function touchPhase(job, phaseId, patch) {
  const phase = job.phases.find((p) => p.id === phaseId);
  if (!phase) return;
  Object.assign(phase, patch);
  job.currentPhase = phaseId;
  const runnable = job.phases.filter((p) => p.status !== "skipped");
  const done = runnable.filter((p) => ["completed", "failed"].includes(p.status)).length;
  job.progress = Math.min(99, Math.round((done / Math.max(1, runnable.length)) * 100));
  await saveJob(job);
}

async function startPhase(job, phaseId) {
  await touchPhase(job, phaseId, { status: "running", startedAt: nowIso(), summary: "Running…" });
  await appendActivity(job, `Phase started: ${phaseId}`);
  await saveJob(job);
}

async function completePhase(job, phaseId, summary, extras = {}) {
  await touchPhase(job, phaseId, {
    status: "completed",
    completedAt: nowIso(),
    summary,
    ...extras,
  });
  await appendActivity(job, `Phase completed: ${phaseId}`);
  await saveJob(job);
}

async function failPhase(job, phaseId, error) {
  job.warnings.push(`${phaseId}: ${error}`);
  await touchPhase(job, phaseId, {
    status: "failed",
    completedAt: nowIso(),
    error,
    summary: error,
  });
  await saveJob(job);
}

const RESEARCH_PHASE_IDS = [
  "searchDemand",
  "competitors",
  "productDecomposition",
  "architecture",
  "apis",
  "npm",
  "github",
  "ui",
  "database",
  "folderStructure",
  "costs",
  "security",
  "performance",
  "testing",
  "deployment",
  "seo",
  "aeo",
];

export function researchSubject(job) {
  const topic = String(job.topic || "").trim();
  const like = topic.match(/\blike\s+([A-Za-z0-9.+\- ]+?)\s*$/i);
  let anchor = like ? like[1].trim() : "";
  if (/^cursor$/i.test(anchor)) anchor = "Cursor IDE";
  const product = topic
    .replace(/^how to (build|create|make|design)\s+/i, "")
    .replace(/\s+like\s+.+$/i, "")
    .trim();
  const primary = (job.primaryKeywords || []).find(Boolean) || product || topic;
  return {
    product: product || primary,
    anchor,
    primary,
    named: anchor || product || primary,
  };
}

function tighten(query) {
  return String(query || "").replace(/\s+/g, " ").trim();
}

/** Three attempts of short, phase-specific queries. Later attempts are rewrites, not the same string. */
export function buildPhaseQueryAttempts(job, phaseId) {
  const s = researchSubject(job);
  const ide = s.anchor || s.named;
  const catalog = {
    searchDemand: [
      [`${s.product} developer questions`, `${ide} what users search`],
      [`${s.product} use cases`, `"${s.primary}" FAQ`],
      [`how developers use ${ide}`, `${s.product} pain points`],
    ],
    competitors: [
      [`${ide} alternatives`, `${s.product} vs GitHub Copilot`],
      [`Continue.dev vs Aider vs ${ide}`, `best ${s.product} tools`],
      [`${ide} competitors open source`, `Windsurf vs ${ide}`],
    ],
    productDecomposition: [
      [`${s.product} editor agent index tools`, `${ide} product features`],
      [`parts of a coding agent`, `${ide} chat apply edit`],
      [`${s.product} subsystems`, `AI coding assistant modules`],
    ],
    architecture: [
      [`${ide} architecture agent loop`, `${s.product} system design`],
      [`how coding agents call tools`, `${ide} context retrieval`],
      [`agent loop plan act observe`, `LLM coding agent architecture`],
    ],
    apis: [
      [`${s.product} OpenAI tool calling API`, `${ide} LLM API`],
      [`Anthropic tool use coding agent`, `OpenRouter API coding assistant`],
      [`GitHub API pull request agent`, `${s.product} API docs`],
    ],
    npm: [
      [`npm packages coding agent`, `monaco-editor npm AI assistant`],
      [`npm openai language server`, `npm tree-sitter embeddings`],
      [`npm ai sdk tool calling`, `npm vscode language server`],
    ],
    github: [
      [`Aider-AI aider github`, `cline github coding agent`],
      [`SWE-bench coding agent`, `aider.chat pair programming`],
      [`${ide} github repository`, `open source coding agent github`],
    ],
    ui: [
      [`${ide} chat UI editor layout`, `coding agent interface design`],
      [`monaco editor chat panel`, `VS Code webview agent UI`],
      [`AI code editor diff review UX`, `${s.product} interface`],
    ],
    database: [
      [`coding agent postgres schema`, `${s.product} threads checkpoints`],
      [`postgres chat messages embeddings`, `vector database code index`],
      [`sqlite vs postgres coding assistant`, `${s.product} data model`],
    ],
    folderStructure: [
      [`coding agent folder structure`, `${ide} repository layout`],
      [`vscode extension folder structure`, `typescript agent project layout`],
      [`monorepo apps packages agent server`, `${s.product} repo structure`],
    ],
    costs: [
      [`${s.product} LLM token cost`, `${ide} API pricing`],
      [`coding agent infrastructure cost`, `embedding index cost repository`],
      [`OpenAI API cost coding assistant`, `${s.product} cost estimate`],
    ],
    security: [
      [`coding agent sandbox security`, `prompt injection tool calling`],
      [`${ide} security model`, `AI agent filesystem sandbox`],
      [`secure tool execution LLM agent`, `${s.product} security`],
    ],
    performance: [
      [`coding agent latency streaming`, `${s.product} context caching`],
      [`incremental code embeddings performance`, `LLM agent streaming tokens`],
      [`${ide} indexing large repo`, `prompt cache coding agent`],
    ],
    testing: [
      [`coding agent benchmarks SWE-bench`, `${s.product} eval harness`],
      [`testing LLM tool calls`, `SWE-bench verified agent`],
      [`coding agent regression tests`, `${ide} evaluation`],
    ],
    deployment: [
      [`deploy coding agent docker`, `${s.product} hosting`],
      [`self host AI code editor`, `vscode server deployment`],
      [`${ide} self hosted`, `${s.product} production deployment`],
    ],
    seo: [
      [`${s.product} guide outline`, `how to build ${ide}`],
      [`${s.primary} tutorial structure`, `${s.product} article headings`],
      [`technical guide ${s.product}`, `${ide} comparison`],
    ],
    aeo: [
      [`what is ${ide}`, `${s.product} FAQ`],
      [`how does ${ide} work`, `${s.product} definition`],
      [`${ide} explained`, `${s.product} common questions`],
    ],
  };
  const rows = catalog[phaseId] || [[`${s.product} ${phaseId}`]];
  return rows.map((queries) => queries.map(tighten).filter((q) => q.length > 3));
}

function freshQueries(job, queries) {
  const seen = new Set((job.queries || []).map((q) => String(q.query || "").toLowerCase()));
  const out = [];
  for (const query of queries) {
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out.slice(0, 2);
}

function phaseResultSummary({ attempts, searchHits, scraped, discovered }) {
  if (!attempts) return "Not run.";
  if (searchHits === 0) {
    return `No search results after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}.`;
  }
  if (scraped === 0) {
    return `Found ${discovered} results, but no usable page text after ${attempts} ${attempts === 1 ? "attempt" : "attempts"}.`;
  }
  return `Found ${discovered} results and scraped ${scraped} ${scraped === 1 ? "page" : "pages"}.`;
}

async function searchAndScrape(job, queries, budget, deadline = Infinity) {
  const discovered = [];
  let searchHits = 0;
  for (const query of queries) {
    if (Date.now() >= deadline) break;
    if (job.queries.length >= budget.maxSearches) break;
    await appendActivity(job, `Generated query: "${query}"`);
    let results = [];
    try {
      results = await searchGoogle(query, { limit: 8 });
      searchHits += results.length;
      await appendActivity(job, `Search returned ${results.length} results`, { query });
    } catch (err) {
      job.warnings.push(`Search failed for "${query}": ${err.message}`);
      await appendActivity(job, `Search failed: ${err.message}`);
    }
    job.queries.push({
      query,
      timestamp: nowIso(),
      resultCount: results.length,
      status: results.length ? "ok" : "empty",
    });
    for (const row of results) {
      if (!row.url) continue;
      if (job.sources.some((s) => s.url === row.url)) continue;
      if (discovered.some((d) => d.url === row.url)) continue;
      discovered.push(row);
    }
    await saveJob(job);
  }

  const room = budget.maxUrls - job.scrapedUrls.length;
  const pick = discovered
    .filter((row) => !job.scrapedUrls.some((saved) => saved.url === row.url))
    .slice(0, Math.max(0, Math.min(room, 3)));
  if (!pick.length) return { discovered, scraped: 0, searchHits };

  await appendActivity(job, `Scraping ${pick.length} URLs in parallel`);
  job.status = "scraping";
  await saveJob(job);

  let pages = [];
  try {
    pages = await scrapeMultiple(pick.map((p) => p.url), { concurrency: 2, timeoutMs: 25_000 });
  } catch {
    for (const item of pick) {
      try {
        pages.push(await scrapeUrl(item.url, { timeoutMs: 20_000 }));
      } catch (err) {
        pages.push({ url: item.url, title: item.title, content: "", success: false, error: err.message });
      }
    }
  }

  let scraped = 0;
  for (const page of pages) {
    const meta = pick.find((p) => p.url === page.url) || {};
    const record = {
      url: page.url,
      title: page.title || meta.title || page.url,
      domain: hostnameOf(page.url),
      sourceType: "web",
      scrapeStatus: page.success ? "ok" : "failed",
      snippet: cleanExcerpt(meta.snippet || page.content).slice(0, 240),
      relevance: 0.55,
      content: cleanExcerpt(page.content).slice(0, 4000),
      error: page.error || null,
      scrapedAt: nowIso(),
    };
    job.scrapedUrls.push({
      url: record.url,
      title: record.title,
      domain: record.domain,
      status: record.scrapeStatus,
      scrapedAt: record.scrapedAt,
    });
    job.sources.push(record);
    if (page.success && record.content.length > 80) {
      scraped += 1;
      job.evidence.push({
        url: record.url,
        title: record.title,
        excerpt: record.content.slice(0, 700),
      });
    } else if (!page.success) {
      job.warnings.push(`Scrape failed: ${record.url}`);
    }
  }
  await saveJob(job);
  return { discovered, scraped, searchHits };
}

export async function runResearchJob(jobId) {
  let job = await getJob(jobId);
  if (!job) throw new Error("Job not found");

  const enabled = expandPhaseFlags(job.phasesEnabled);
  const budget = budgets[job.depth] || budgets.deep;
  job.status = "planning";
  job.startedAt = job.startedAt || nowIso();
  job.phases = initPhases(enabled);
  await saveJob(job);

  const guideMeta = await createGuideShell(job);
  job.guideSlug = guideMeta.slug;
  await saveJob(job);

  const env = getEnv();
  if (!env.openRouterKey) {
    job.warnings.push("OPENROUTER_API_KEY missing in guideforge/server/.env");
    await appendActivity(job, "WARNING: OpenRouter key missing — AI phases will use evidence fallback");
  } else {
    await appendActivity(job, `OpenRouter model: ${env.openRouterModel}`);
  }
  await saveJob(job);

  let plan = null;
  try {
    await startPhase(job, "planning");
    plan = await runWithLlmContext({ jobId: job.id, phase: "planning", label: "research-planner" }, () =>
      planResearch(job),
    );
    job = (await getJob(jobId)) || job;
    job.research = job.research || {};
    job.research.plan = plan;
    await completePhase(job, "planning", `${(plan.searchQueries || []).length} queries planned`, {
      itemsFound: (plan.searchQueries || []).length,
      notes: (plan.keyQuestions || []).slice(0, 8),
      queries: (plan.searchQueries || []).slice(0, 12),
    });
  } catch (err) {
    await failPhase(job, "planning", err.message);
    plan = { searchQueries: [job.topic], keyQuestions: [] };
  }

  const researchPhases = RESEARCH_PHASE_IDS.filter((id) => enabled[id]);
  const maxMinutes = budget.maxMinutes || 30;
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  await appendActivity(
    job,
    `Research window: ${maxMinutes} minutes, ${researchPhases.length} phases. Empty search or scrape results are retried with a new query.`,
  );
  await saveJob(job);

  for (const phaseId of researchPhases) {
    if (Date.now() >= deadline) break;

    await startPhase(job, phaseId);
    job.status = "searching";
    await saveJob(job);

    const attempts = buildPhaseQueryAttempts(job, phaseId);
    const queriesUsed = [];
    const discovered = [];
    let scraped = 0;
    let searchHits = 0;
    let attemptCount = 0;

    for (const candidate of attempts) {
      if (Date.now() >= deadline) break;
      const queries = freshQueries(job, candidate);
      if (!queries.length) continue;
      attemptCount += 1;
      if (attemptCount > 1) {
        const reason = searchHits === 0 ? "search returned 0 results" : "scrape returned no usable pages";
        await appendActivity(job, `Retrying ${phaseId}: ${reason}. New queries: ${queries.join(" | ")}`);
        await saveJob(job);
      }
      const result = await searchAndScrape(job, queries, budget, deadline);
      job = (await getJob(jobId)) || job;
      queriesUsed.push(...queries);
      searchHits += result.searchHits;
      scraped += result.scraped;
      for (const row of result.discovered) {
        if (!discovered.some((item) => item.url === row.url)) discovered.push(row);
      }
      if (result.searchHits > 0 && result.scraped > 0) break;
    }

    await completePhase(job, phaseId, phaseResultSummary({
      attempts: attemptCount,
      searchHits,
      scraped,
      discovered: discovered.length,
    }), {
      itemsFound: scraped,
      queries: queriesUsed,
      urls: discovered.slice(0, 8).map((d) => d.url),
      notes: discovered.slice(0, 5).map((d) => d.title).filter(Boolean),
    });
  }

  for (const id of researchPhases) {
    const phase = job.phases.find((p) => p.id === id);
    if (phase && (phase.status === "pending" || phase.status === "running")) {
      await touchPhase(job, id, {
        status: "skipped",
        completedAt: nowIso(),
        summary: `Not run. The ${maxMinutes} minute research window ended before this phase.`,
      });
      await appendActivity(job, `Phase not run (time window): ${id}`);
      await saveJob(job);
    }
  }

  let synthesis = {};
  try {
    await startPhase(job, "synthesis");
    job.status = "synthesizing";
    await saveJob(job);
    synthesis = await runWithLlmContext({ jobId: job.id, phase: "synthesis", label: "research-synthesizer" }, () =>
      synthesizeEvidence(job, {
        plan,
        sources: job.sources.slice(0, 40),
        evidence: job.evidence.slice(0, 60),
      }),
    );
    job = (await getJob(jobId)) || job;
    job.research = job.research || {};
    job.research.synthesis = synthesis;
    await completePhase(job, "synthesis", "Research synthesized", { itemsFound: job.evidence.length });
  } catch (err) {
    await failPhase(job, "synthesis", err.message);
  }

  let markdown = "";
  let composed = null;
  try {
    await startPhase(job, "writing");
    job.status = "writing";
    await saveJob(job);
    composed = await runWithLlmContext({ jobId: job.id, phase: "writing", label: "guide-writer" }, () =>
      composeGuide({
        job,
        synthesis,
        onProgress: async (patch = {}) => {
          job = (await getJob(jobId)) || job;
          if (patch.currentPhase) job.currentPhase = patch.currentPhase;
          if (patch.currentSection) job.currentSection = patch.currentSection;
          if (patch.currentSkill) job.currentSkill = patch.currentSkill;
          if (patch.currentPhase === "review") job.status = "reviewing";
          else job.status = "writing";
          if (patch.message) await appendActivity(job, patch.message);
          await saveJob(job);
        },
      }),
    );
    markdown = composed.markdown;
    job = (await getJob(jobId)) || job;
    job.research = job.research || {};
    job.research.blueprint = composed.blueprint;
    job.research.evidenceStore = composed.evidence;
    await saveJob(job);
    const passed = (composed.reviews || []).filter((review) => Number(review.score) >= 8).length;
    await completePhase(
      job,
      "writing",
      `Wrote ${composed.sections.length} sections (${markdown.length} chars)`,
      { itemsFound: composed.sections.length, notes: [`${passed} sections scored 8 or higher`] },
    );
  } catch (err) {
    await failPhase(job, "writing", err.message);
    try {
      markdown = await writeGuideMarkdown(job, synthesis, job.sources);
    } catch {
      markdown = `# ${job.topic}\n\n${job.description || ""}\n`;
    }
  }

  try {
    await startPhase(job, "review");
    job.status = "reviewing";
    await saveJob(job);
    if (!/## Sources/i.test(markdown)) {
      markdown += `\n\n## Sources\n\n${job.sources
        .slice(0, 25)
        .map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
        .join("\n")}\n`;
    }
    const reviewed = composed?.reviews?.length || 0;
    await completePhase(job, "review", reviewed ? `Reviewed ${reviewed} sections` : "Technical pass complete");
  } catch (err) {
    await failPhase(job, "review", err.message);
  }

  let images = [];
  if (enabled.images) {
    try {
      await startPhase(job, "images");
      job.status = "planning-images";
      await saveJob(job);
      images = await runWithLlmContext({ jobId: job.id, phase: "images", label: "image-planner" }, () =>
        planImages(job, markdown),
      );
      job = (await getJob(jobId)) || job;
      markdown = injectImagePlaceholders(markdown, images);
      await completePhase(job, "images", `${images.length} images planned`, { itemsFound: images.length });
    } catch (err) {
      await failPhase(job, "images", err.message);
    }
  }

  job = (await getJob(jobId)) || job;
  const metadata = {
    ...guideMeta,
    status: "completed",
    researchStatus: job.warnings.length || (job.llmUsage?.failed || 0) ? "completed_with_warnings" : "completed",
    progress: 100,
    imageCount: images.length,
    llmUsage: job.llmUsage || null,
    updatedAt: nowIso(),
  };

  await saveGuideArtifacts(job.guideSlug, {
    metadata,
    markdown,
    research: {
      summary: synthesis.summary || "",
      architecture: synthesis.architecture || "",
      apis: synthesis.apis || [],
      npm: synthesis.npm || [],
      github: synthesis.github || [],
      database: synthesis.database || "",
      roadmap: synthesis.roadmap || [],
      costs: synthesis.costs || "",
      seoAeo: synthesis.seoAeo || "",
      plan,
      blueprint: composed?.blueprint || null,
      evidenceStore: composed?.evidence || job.research?.evidenceStore || [],
      facts: synthesis.facts || [],
      unknowns: synthesis.unknowns || [],
      buildVsBuy: synthesis.buildVsBuy || [],
    },
    sources: job.sources,
    imagePlan: images,
    sections: {
      overview: synthesis.summary || job.description,
      research: synthesis.summary || "",
      architecture: synthesis.architecture || "",
      apis: synthesis.apis || [],
      npm: synthesis.npm || [],
      github: synthesis.github || [],
      database: synthesis.database || "",
      roadmap: synthesis.roadmap || [],
      costs: synthesis.costs || "",
      seo: synthesis.seoAeo || "",
      lessons: (composed?.sections || []).map((section) => ({
        id: section.id,
        title: section.title,
        markdown: section.markdown,
      })),
    },
  });

  await writeJson(path.join(researchDir, `${job.id}.json`), {
    jobId: job.id,
    guideSlug: job.guideSlug,
    research: job.research,
    sources: job.sources,
    evidence: job.evidence,
  });

  job.status = job.warnings.length ? "completed_with_warnings" : "completed";
  job.progress = 100;
  job.currentPhase = "completed";
  job.completedAt = nowIso();
  await appendActivity(job, "Research job completed");
  await saveJob(job);
  return job;
}

const running = new Set();

export function enqueueResearchJob(jobId) {
  if (running.has(jobId)) return;
  running.add(jobId);
  setImmediate(async () => {
    try {
      await runResearchJob(jobId);
    } catch (err) {
      console.error("[guideforge] job failed", jobId, err);
      const job = await getJob(jobId);
      if (job) {
        job.status = "failed";
        job.error = err.message;
        job.completedAt = nowIso();
        await appendActivity(job, `Job failed: ${err.message}`);
        await saveJob(job);
      }
    } finally {
      running.delete(jobId);
    }
  });
}
