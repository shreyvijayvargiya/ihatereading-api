import path from "node:path";
import { chat, chatJson } from "./openrouter.js";
import { buildEvidenceStore, getEvidenceForSection } from "./evidence.js";
import {
  blueprintSystem,
  blueprintUser,
  sectionPlanSystem,
  sectionPlanUser,
  sectionReviewSystem,
  sectionReviewUser,
  sectionReviseSystem,
  sectionReviseUser,
} from "./prompts/compose.js";
import { guideDir, readJson, readText, slugify, writeJson, writeText } from "../storage/filesystem.js";
import { detailSection } from "./section-agent.js";

const PASS_SCORE = 8;
const MAX_REVISIONS = 2;

function sectionCap(job) {
  const override = Number(process.env.GUIDEFORGE_SECTION_CAP || 0);
  if (override > 0) return override;
  if (job.depth === "quick") return 8;
  if (job.depth === "maximum") return 22;
  return 16;
}

function stripFences(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
  return (fenced ? fenced[1] : raw).trim();
}

function asHeading(title, markdown) {
  const body = stripFences(markdown);
  if (/^##\s+/m.test(body)) return body;
  return `## ${title}\n\n${body}`;
}

function headingSlug(title) {
  return slugify(title);
}

export function assembleGuide({ blueprint, written, sources }) {
  const title = blueprint?.title || "Guide";
  const goal = blueprint?.goal ? `${blueprint.goal}\n\n` : "";
  const toc = (written || [])
    .map((section, index) => `${index + 1}. [${section.title}](#${headingSlug(section.title)})`)
    .join("\n");
  const body = (written || [])
    .map((section) => asHeading(section.title, section.markdown))
    .join("\n\n");
  const sourceLines = (sources || [])
    .filter((source) => source.url)
    .slice(0, 25)
    .map((source, index) => `${index + 1}. [${source.title || source.url}](${source.url})`)
    .join("\n");
  return `# ${title}\n\n${goal}## Contents\n\n${toc}\n\n${body}\n\n## Sources\n\n${sourceLines}\n`;
}

export function injectImagePlaceholders(markdown, images) {
  let next = String(markdown || "");
  for (const image of images || []) {
    const id = image.id;
    if (!id) continue;
    const marker = `<!-- IMAGE: ${id} -->`;
    if (next.includes(marker)) continue;
    const needle = String(image.section || image.sectionId || image.title || "").toLowerCase();
    const lines = next.split("\n");
    let index = -1;
    if (needle.length > 3) {
      index = lines.findIndex(
        (line) => /^#{2,3}\s+/.test(line) && line.toLowerCase().includes(needle.slice(0, 28)),
      );
    }
    if (index < 0) index = lines.findIndex((line) => line.startsWith("## "));
    if (index >= 0) {
      lines.splice(index + 1, 0, "", marker);
      next = lines.join("\n");
    } else {
      next += `\n\n${marker}\n`;
    }
  }
  return next;
}

function fallbackBlueprint(job) {
  const topic = job.topic || "this system";
  const steps = [
    ["what-we-are-building", `What we are building`, `Define ${topic} and the outcome of the guide.`],
    ["mental-model", "Mental model", `Explain the core loop a developer should keep in mind for ${topic}.`],
    ["architecture", "System architecture", "Show how the major parts connect and what data moves between them."],
    ["core-internals", "Core internals", "Walk through the internal behavior that makes the system work."],
    ["interfaces", "Interfaces and APIs", "Name the boundaries, inputs, and outputs. Mark anything unverified."],
    ["data-model", "Data model", "Describe what must be stored and how records relate."],
    ["implementation", "Implementation sketch", "Show a concrete JavaScript sketch of the smallest working path."],
    ["production", "Production concerns", "Cover security, testing, deployment, and cost at a practical level."],
  ];
  return {
    title: topic,
    audience: (job.audience || []).join(", ") || "engineers",
    goal: `Give a developer enough structure to start a repository for ${topic}.`,
    difficulty: "intermediate",
    sections: steps.map(([id, title, purpose]) => ({
      id,
      title,
      purpose,
      dependencies: [],
      researchCategories: [],
      depth: "deep",
    })),
  };
}

function plansFromBlueprint(sections) {
  return sections.map((section) => ({
    sectionId: section.id,
    title: section.title,
    objective: section.purpose || section.title,
    purpose: section.purpose || "",
    questionsToAnswer: [
      `What is ${section.title} in this system?`,
      `Why is ${section.title} required?`,
      `How would a developer implement ${section.title}?`,
    ],
    requiredConcepts: section.researchCategories || [],
    requiredExamples: [],
    requiredCode: ["a short JavaScript sketch"],
    researchQueries: [],
    relatedSections: section.dependencies || [],
    avoidRepeating: [],
    depth: section.depth || "deep",
    researchCategories: section.researchCategories || [],
  }));
}

function fallbackSection(plan, evidence, error) {
  const notes = (evidence || [])
    .slice(0, 4)
    .map((item) => `- ${item.claim} ([${item.title}](${item.source}))`)
    .join("\n");
  return `## ${plan.title}

${plan.objective || plan.purpose || ""}

This section could not be fully drafted${error ? ` (${error})` : ""}. The notes below are limited to scraped evidence.

${notes || "- No scraped evidence was attached to this section. Treat implementation details as requiring verification."}
`;
}

async function loadComposeState(slug) {
  if (!slug) return { blueprint: null, status: { sections: {} } };
  const dir = guideDir(slug);
  const blueprint = await readJson(path.join(dir, "blueprint.json"), null);
  const status = await readJson(path.join(dir, "compose-status.json"), { sections: {} });
  return { blueprint, status: status || { sections: {} } };
}

async function saveComposeFile(slug, relativePath, data, asJson = true) {
  if (!slug) return;
  const file = path.join(guideDir(slug), relativePath);
  if (asJson) await writeJson(file, data);
  else await writeText(file, data);
}

export async function composeGuide({ job, synthesis, onProgress }) {
  const evidence = buildEvidenceStore(job);
  const slug = job.guideSlug;
  const saved = await loadComposeState(slug);
  let blueprint = saved.blueprint;
  const status = saved.status || { sections: {} };

  if (!blueprint?.sections?.length) {
    await onProgress?.({ currentSection: "blueprint", message: "Planning the guide blueprint" });
    try {
      const result = await chatJson({
        system: blueprintSystem(),
        prompt: blueprintUser({ job, synthesis: synthesis || {}, evidence }),
        maxTokens: 2200,
        temperature: 0.2,
        label: "guide-blueprint",
      });
      blueprint = result.data || {};
    } catch (err) {
      await onProgress?.({ message: `Blueprint fallback: ${err.message}` });
      blueprint = fallbackBlueprint(job);
    }
    if (!Array.isArray(blueprint.sections) || blueprint.sections.length === 0) {
      blueprint = fallbackBlueprint(job);
    }
    blueprint.sections = blueprint.sections
      .filter((section) => section && (section.title || section.id))
      .slice(0, sectionCap(job))
      .map((section, index) => ({
        ...section,
        id: slugify(section.id || section.title || `section-${index + 1}`),
        title: section.title || section.id,
        purpose: section.purpose || "",
        dependencies: section.dependencies || [],
        researchCategories: section.researchCategories || [],
        depth: section.depth || "deep",
      }));
    await saveComposeFile(slug, "blueprint.json", blueprint);
  }

  let plans = [];
  try {
    await onProgress?.({ currentSection: "section-plan", message: "Planning each section" });
    const planned = await chatJson({
      system: sectionPlanSystem(),
      prompt: sectionPlanUser({ job, blueprint }),
      maxTokens: 2800,
      temperature: 0.2,
      label: "section-planner",
    });
    plans = Array.isArray(planned.data?.plans) ? planned.data.plans : [];
  } catch (err) {
    await onProgress?.({ message: `Section planner fallback: ${err.message}` });
  }
  const byId = new Map(plans.map((plan) => [slugify(plan.sectionId || plan.title || ""), plan]));
  const sectionPlans = plansFromBlueprint(blueprint.sections).map((fallback) => {
    const match = byId.get(fallback.sectionId) || byId.get(slugify(fallback.title));
    return {
      ...fallback,
      ...(match || {}),
      sectionId: fallback.sectionId,
      title: fallback.title,
    };
  });
  await saveComposeFile(slug, "section-plans.json", { plans: sectionPlans });

  const written = [];
  const reviews = [];
  for (let index = 0; index < sectionPlans.length; index += 1) {
    const plan = sectionPlans[index];
    const fileStem = `${String(index + 1).padStart(2, "0")}-${plan.sectionId}`;
    const prior = status.sections?.[plan.sectionId];
    if (prior?.status === "completed" && slug) {
      const existing = await readText(path.join(guideDir(slug), "sections", `${fileStem}.md`), "");
      if (existing.trim()) {
        written.push({ id: plan.sectionId, title: plan.title, markdown: existing });
        reviews.push(prior.review || null);
        continue;
      }
    }

    const bundle = getEvidenceForSection(plan, evidence);
    const previousTitles = written.map((section) => section.title);
    const laterTitles = sectionPlans.slice(index + 1).map((section) => section.title);

    let markdown = "";
    let sectionError = null;
    let skillDigest = "";
    try {
      const detailed = await detailSection({
        job,
        blueprint,
        plan,
        evidenceStore: evidence,
        previousTitles,
        laterTitles,
        index,
        total: sectionPlans.length,
        onProgress,
      });
      markdown = asHeading(plan.title, detailed.markdown);
      skillDigest = JSON.stringify(detailed.skills || []).slice(0, 3000);
      if (detailed.failures?.length) {
        await onProgress?.({
          currentSection: plan.title,
          message: `Skill issues in ${plan.title}: ${detailed.failures.map((failure) => failure.skill).join(", ")}`,
        });
      }
      await saveComposeFile(slug, `sections/${fileStem}.context.json`, detailed.context);
      await saveComposeFile(slug, `sections/${fileStem}.skills.json`, {
        selectedSkills: detailed.selectedSkills,
        skills: detailed.skills,
        failures: detailed.failures,
      });
    } catch (err) {
      sectionError = err.message;
      markdown = fallbackSection(plan, bundle, err.message);
    }

    let review = null;
    let revisions = 0;
    while (revisions <= MAX_REVISIONS && !sectionError) {
      await onProgress?.({
        currentPhase: "review",
        currentSection: plan.title,
        message: `Reviewing section ${index + 1}/${sectionPlans.length}: ${plan.title}`,
      });
      try {
        const judged = await chatJson({
          system: sectionReviewSystem(),
          prompt: sectionReviewUser({ plan, markdown, evidence: bundle }),
          maxTokens: 700,
          temperature: 0.1,
          label: `section-review:${plan.sectionId}`,
        });
        review = judged.data || {};
        const orientation = /overview|what we are building|contents/i.test(`${plan.title} ${plan.objective || ""}`);
        if (!orientation && !/```/.test(markdown)) {
          review.needsRevision = true;
          review.implementationDetail = Math.min(Number(review.implementationDetail || 0), 5);
          review.score = Math.min(Number(review.score || 0), 7);
          review.issues = [...(review.issues || []), "Missing a fenced code example."];
        }
      } catch (err) {
        review = { score: PASS_SCORE, needsRevision: false, issues: [`Review skipped: ${err.message}`] };
        break;
      }
      const score = Number(review.score || 0);
      const failed = review.needsRevision === true || score < PASS_SCORE;
      if (!failed || revisions === MAX_REVISIONS) break;
      revisions += 1;
      await onProgress?.({
        currentPhase: "writing",
        currentSection: plan.title,
        message: `Revising section ${index + 1}/${sectionPlans.length}: ${plan.title} (${revisions}/${MAX_REVISIONS})`,
      });
      try {
        const revised = await chat({
          system: sectionReviseSystem(),
          prompt: sectionReviseUser({ plan, markdown, review, evidence: bundle, skillDigest }),
          maxTokens: 2200,
          temperature: 0.25,
          label: `section-revise:${plan.sectionId}`,
        });
        markdown = asHeading(plan.title, revised.content);
      } catch (err) {
        review.issues = [...(review.issues || []), `Revision failed: ${err.message}`];
        break;
      }
    }

    written.push({ id: plan.sectionId, title: plan.title, markdown });
    reviews.push(review);
    status.sections[plan.sectionId] = {
      status: sectionError ? "failed" : "completed",
      revisions,
      score: review?.score ?? null,
      error: sectionError,
      review,
    };
    await saveComposeFile(slug, `sections/${fileStem}.md`, markdown, false);
    await saveComposeFile(slug, `reviews/${fileStem}.json`, review || { error: sectionError });
    await saveComposeFile(slug, "compose-status.json", status);
  }

  const markdown = assembleGuide({ blueprint, written, sources: job.sources || [] });
  await saveComposeFile(slug, "guide.md", markdown, false);
  return {
    markdown,
    blueprint,
    sectionPlans,
    sections: written,
    reviews: reviews.filter(Boolean),
    evidence,
  };
}
