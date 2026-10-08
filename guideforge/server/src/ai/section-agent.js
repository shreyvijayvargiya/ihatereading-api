import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat, chatJson } from "./openrouter.js";
import { getEvidenceForSection } from "./evidence.js";
import { sectionWriterSystem, sectionWriterUser } from "./prompts/compose.js";

const skillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills");

const MATCHERS = {
  implementation: /implement|loop|index|tool|agent|editor|schema|scanner|retriev|context/,
  architecture: /architect|system|loop|flow|context|index|component|agent|tool/,
  "code-examples": /implement|code|api|loop|tool|editor|index|schema|agent|context/,
  "frontend-ui": /\bui\b|interface|chat|editor|frontend|layout|component|monaco/,
  "theme-ux": /theme|\bux\b|visual|dark mode|chat interface/,
  "api-design": /\bapi\b|endpoint|request|response|streaming/,
  database: /database|schema|postgres|sqlite|storage|persist/,
  "file-folder-structure": /folder|structure|repository|layout|files/,
  testing: /test|eval|benchmark|acceptance/,
  security: /security|sandbox|auth|injection|secret/,
  performance: /performance|latency|cache|token|stream/,
  production: /production|scale|observ|reliab/,
  tradeoffs: /tradeoff|versus|\bvs\b|alternative|build vs|buy/,
  deployment: /deploy|hosting|docker|environment/,
  cost: /cost|pricing|budget|spend/,
};

const RELATED = {
  deployment: ["production", "security", "cost"],
  database: ["tradeoffs"],
  "frontend-ui": ["theme-ux", "testing"],
  implementation: ["testing", "tradeoffs"],
  architecture: ["implementation"],
};

const PRIORITY = [
  "technical-explanation",
  "architecture",
  "implementation",
  "code-examples",
  "frontend-ui",
  "theme-ux",
  "api-design",
  "database",
  "file-folder-structure",
  "testing",
  "security",
  "performance",
  "production",
  "tradeoffs",
  "deployment",
  "cost",
];

let skillCache = null;

function parseSkill(fileText) {
  const match = String(fileText || "").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = {};
  let body = String(fileText || "").trim();
  if (match) {
    body = match[2].trim();
    for (const line of match[1].split("\n")) {
      const splitAt = line.indexOf(":");
      if (splitAt === -1) continue;
      meta[line.slice(0, splitAt).trim()] = line.slice(splitAt + 1).trim();
    }
  }
  return {
    id: meta.id,
    name: meta.name || meta.id,
    description: meta.description || "",
    appliesTo: String(meta.appliesTo || "").split(",").map((item) => item.trim()).filter(Boolean),
    body,
  };
}

export async function loadSkills() {
  if (skillCache) return skillCache;
  const files = (await readdir(skillsDir)).filter((name) => name.endsWith(".md"));
  const skills = [];
  for (const file of files) {
    const skill = parseSkill(await readFile(path.join(skillsDir, file), "utf8"));
    if (skill.id) skills.push(skill);
  }
  skillCache = skills;
  return skills;
}

function sectionBlob(plan) {
  return [
    plan.title,
    plan.purpose,
    plan.objective,
    ...(plan.questionsToAnswer || []),
    ...(plan.requiredConcepts || []),
    ...(plan.researchCategories || []),
  ].join(" ");
}

/** Pick a few skills for this section. Direct matches stay ahead of related fillers. */
export function selectSkills(plan, skills) {
  const blob = sectionBlob(plan).toLowerCase();
  const known = new Set(skills.map((skill) => skill.id));
  const direct = PRIORITY.filter((id) => id !== "technical-explanation" && MATCHERS[id]?.test(blob));
  const related = [];
  for (const id of direct) {
    for (const extra of RELATED[id] || []) {
      if (!direct.includes(extra) && !related.includes(extra)) related.push(extra);
    }
  }
  const selected = ["technical-explanation", ...direct, ...related];
  if (selected.length < 5 && !/overview|what we are building/i.test(blob)) {
    for (const id of ["architecture", "implementation", "code-examples", "tradeoffs"]) {
      if (!selected.includes(id)) selected.push(id);
    }
  }
  return selected.filter((id) => known.has(id)).slice(0, 6);
}

/** Section-scoped sources, including scraped page text when the job stored it. */
export function getRelevantResources(plan, job, evidenceStore) {
  const picked = getEvidenceForSection(plan, evidenceStore, 5);
  const byUrl = new Map((job.sources || []).concat(job.evidence || []).map((item) => [item.url, item]));
  return picked.map((item) => {
    const source = byUrl.get(item.source) || {};
    const content = source.content || source.excerpt || item.excerpt || item.claim || "";
    return {
      title: item.title,
      url: item.source,
      content: String(content).slice(0, 1500),
      sourceType: item.sourceType,
      relevance: item.relevance,
    };
  });
}

function buildSectionContext({ job, blueprint, plan, resources, previousTitles, laterTitles, index, total }) {
  return {
    guide: {
      title: blueprint?.title || job.topic,
      description: job.description || "",
      audience: blueprint?.audience || (job.audience || []).join(", "),
      goal: blueprint?.goal || "",
    },
    section: {
      id: plan.sectionId,
      title: plan.title,
      purpose: plan.objective || plan.purpose || "",
      position: `${index + 1}/${total}`,
      depth: plan.depth || "deep",
      questions: plan.questionsToAnswer || [],
      relatedSections: plan.relatedSections || [],
    },
    research: {
      findings: (job.research?.synthesis?.facts || job.research?.facts || []).slice(0, 8),
      architecture: job.research?.synthesis?.architecture || job.research?.architecture || "",
    },
    sources: resources,
    surroundingSections: {
      previous: previousTitles,
      next: laterTitles,
    },
  };
}

async function runSkill(skill, context) {
  const result = await chatJson({
    system: `${skill.body}\nReturn JSON only. Do not write the full guide section.`,
    prompt: `SECTION: ${context.section.title}
PURPOSE: ${context.section.purpose}
GUIDE: ${context.guide.title}

SOURCES:
${JSON.stringify(context.sources).slice(0, 4000)}

Return JSON:
{
  "skill": "${skill.id}",
  "sectionId": "${context.section.id}",
  "content": "",
  "implementationSteps": [],
  "files": [],
  "dependencies": [],
  "apis": [],
  "warnings": [],
  "testCases": [],
  "components": [],
  "flows": [],
  "comparisons": []
}`,
    maxTokens: 900,
    temperature: 0.2,
    label: `skill:${skill.id}:${context.section.id}`,
  });
  return { ...result.data, skill: skill.id, sectionId: context.section.id };
}

export async function detailSection({
  job,
  blueprint,
  plan,
  evidenceStore,
  previousTitles,
  laterTitles,
  index = 0,
  total = 1,
  onProgress,
}) {
  const skills = await loadSkills();
  const selected = selectSkills(plan, skills);
  const resources = getRelevantResources(plan, job, evidenceStore);
  const context = buildSectionContext({
    job,
    blueprint,
    plan,
    resources,
    previousTitles,
    laterTitles,
    index,
    total,
  });
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  await onProgress?.({
    currentPhase: "writing",
    currentSection: plan.title,
    currentSkill: selected.join(","),
    message: `Detailing ${plan.title} with ${selected.join(", ")}`,
  });
  const settled = await Promise.allSettled(selected.map((id) => runSkill(byId.get(id), context)));
  const skillResults = [];
  const failures = [];
  settled.forEach((item, skillIndex) => {
    if (item.status === "fulfilled") skillResults.push(item.value);
    else failures.push({ skill: selected[skillIndex], error: item.reason?.message || String(item.reason) });
  });

  await onProgress?.({
    currentPhase: "writing",
    currentSection: plan.title,
    currentSkill: "section-guide",
    message: `Writing section ${context.section.position}: ${plan.title}`,
  });

  try {
    const guided = await chat({
      system: `You write one engineering lesson from skill notes. Do not research.
Do not use filler such as "in today's world", "revolutionizing", or "leverage".
Distinguish existing product behavior from our proposed implementation.
Do not invent packages, repositories, or private APIs. If a source does not verify a claim, say so.
Use only the headings this section needs. Include a fenced code block unless this is a short opening overview.
You may insert <!-- IMAGE: kebab-id --> where a diagram teaches the flow.
Return Markdown only, starting with ## ${plan.title}`,
      prompt: `GUIDE: ${context.guide.title}
GOAL: ${context.guide.goal}
SECTION: ${plan.title}
PURPOSE: ${context.section.purpose}
EARLIER: ${(previousTitles || []).join(", ") || "none"}
LATER (do not explain these): ${(laterTitles || []).join(", ") || "none"}

SKILL NOTES:
${JSON.stringify(skillResults).slice(0, 9000)}

FAILED SKILLS:
${failures.map((failure) => `${failure.skill}: ${failure.error}`).join("\n") || "none"}

SOURCES:
${JSON.stringify(resources).slice(0, 3500)}`,
      maxTokens: 2600,
      temperature: 0.3,
      label: `section-guide:${plan.sectionId}`,
    });
    return {
      markdown: stripToHeading(plan.title, guided.content),
      skills: skillResults,
      failures,
      context,
      selectedSkills: selected,
    };
  } catch (err) {
    const draft = await chat({
      system: sectionWriterSystem(),
      prompt: sectionWriterUser({
        job,
        blueprint,
        plan,
        evidence: resources,
        previousTitles,
        laterTitles,
      }),
      maxTokens: 2200,
      temperature: 0.3,
      label: `section-writer:${plan.sectionId}`,
    });
    return {
      markdown: stripToHeading(plan.title, draft.content),
      skills: skillResults,
      failures: [...failures, { skill: "section-guide", error: err.message }],
      context,
      selectedSkills: selected,
    };
  }
}

function stripToHeading(title, markdown) {
  const raw = String(markdown || "").trim();
  const fenced = raw.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
  const body = (fenced ? fenced[1] : raw).trim();
  if (/^##\s+/m.test(body)) return body;
  return `## ${title}\n\n${body}`;
}
