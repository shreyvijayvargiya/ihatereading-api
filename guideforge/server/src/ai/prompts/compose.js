export function blueprintSystem() {
  return `You are a guide architect for engineering courses. Return JSON only.
Decide the sections this specific topic needs. Do not copy a fixed template.
Do not write the section bodies. Do not invent APIs, packages, or repositories.`;
}

export function blueprintUser({ job, synthesis, evidence }) {
  const depth = job.depth || "deep";
  const range = depth === "quick" ? "6 to 8" : depth === "maximum" ? "12 to 22" : "8 to 16";
  return `Design the lesson outline for this guide.

TOPIC: ${job.topic}
DESCRIPTION: ${job.description || ""}
AUDIENCE: ${(job.audience || []).join(", ") || "engineers"}
DEPTH: ${depth}

SYNTHESIS:
${JSON.stringify({
  summary: synthesis.summary,
  architecture: synthesis.architecture,
  facts: synthesis.facts,
  patterns: synthesis.patterns,
  tools: synthesis.tools,
  unknowns: synthesis.unknowns,
  buildVsBuy: synthesis.buildVsBuy,
  gaps: synthesis.gaps,
}).slice(0, 8000)}

EVIDENCE TITLES:
${(evidence || []).slice(0, 24).map((item) => `- ${item.title} (${item.source})`).join("\n")}

Choose ${range} sections. A simple topic stays near the low end. A system with many subsystems can use more.
Prefer a teaching order: what we are building, mental model, architecture, internals, data, interfaces, implementation, production concerns.
Skip sections you cannot ground in the topic.

Return JSON:
{
  "title": "",
  "audience": "",
  "goal": "",
  "difficulty": "intermediate",
  "sections": [
    {
      "id": "kebab-case",
      "title": "",
      "purpose": "",
      "dependencies": [],
      "researchCategories": [],
      "depth": "deep"
    }
  ]
}`;
}

export function sectionPlanSystem() {
  return `You plan individual engineering lessons. Return JSON only. Do not write the lessons.`;
}

export function sectionPlanUser({ job, blueprint }) {
  return `Create a lesson plan for every section.

TOPIC: ${job.topic}
BLUEPRINT:
${JSON.stringify(blueprint.sections || []).slice(0, 12000)}

Return JSON:
{
  "plans": [
    {
      "sectionId": "",
      "objective": "",
      "questionsToAnswer": [],
      "requiredConcepts": [],
      "requiredExamples": [],
      "requiredCode": [],
      "researchQueries": [],
      "relatedSections": [],
      "avoidRepeating": [],
      "depth": "deep"
    }
  ]
}

questionsToAnswer should be specific to that section, not generic SEO questions.`;
}

export function sectionWriterSystem() {
  return `You write one section of an engineering course in Markdown.
Use JavaScript for code unless the topic requires another language.
Use only the evidence you are given for package names, repositories, and APIs.
If something is not in the evidence, write "requires verification" instead of inventing it.
Do not write other sections. Do not add a table of contents. Start with a level-2 heading.`;
}

export function sectionWriterUser({ job, blueprint, plan, evidence, previousTitles, laterTitles }) {
  return `Write this section only.

TOPIC: ${job.topic}
DESCRIPTION: ${job.description || ""}
AUDIENCE: ${blueprint.audience || (job.audience || []).join(", ") || "engineers"}
GUIDE GOAL: ${blueprint.goal || ""}

SECTION: ${plan.title}
PURPOSE: ${plan.objective || plan.purpose || ""}
QUESTIONS: ${(plan.questionsToAnswer || []).join(" | ")}
CONCEPTS: ${(plan.requiredConcepts || []).join(", ")}
EXAMPLES TO INCLUDE: ${(plan.requiredExamples || []).join(", ")}
CODE TO INCLUDE: ${(plan.requiredCode || []).join(", ")}
DEPTH: ${plan.depth || "deep"}
DO NOT REPEAT: ${(plan.avoidRepeating || []).join(", ")}

EARLIER SECTIONS (titles only): ${(previousTitles || []).join(", ") || "none"}
LATER SECTIONS (do not explain these yet): ${(laterTitles || []).join(", ") || "none"}

EVIDENCE (only cite these sources):
${JSON.stringify(evidence || []).slice(0, 6000)}

Cover, when they apply to this section: what it is, why it exists, how it works, where it sits, inputs and outputs, the interface, an implementation sketch, packages from the evidence, a concrete code example, alternatives, tradeoffs, mistakes, and what changes in production.
A definition-only section fails review. Include at least one fenced JavaScript block that shows an input, a function, and an output, unless the section is only a one-paragraph orientation.
Cite evidence URLs inline when you use them. Do not claim a private API exists unless the evidence says so.

Return Markdown only, starting with ## ${plan.title}`;
}

export function sectionReviewSystem() {
  return `You review one engineering-guide section. Return JSON only. Do not rewrite the section.`;
}

export function sectionReviewUser({ plan, markdown, evidence }) {
  return `Review this single section.

SECTION: ${plan.title}
OBJECTIVE: ${plan.objective || plan.purpose || ""}
EVIDENCE URLS: ${(evidence || []).map((item) => item.source).join(", ")}

MARKDOWN:
${String(markdown || "").slice(0, 8000)}

Score 1-10. Set implementationDetail below 8 and needsRevision to true when the section is generic, has no fenced code block, or invents packages or APIs.
An opening orientation may skip code. Every other section needs a concrete sketch.

Return JSON:
{
  "score": 0,
  "technicalDepth": 0,
  "implementationDetail": 0,
  "evidenceCoverage": 0,
  "examples": 0,
  "repetition": 0,
  "accuracy": 0,
  "issues": [],
  "needsRevision": false
}`;
}

export function sectionReviseSystem() {
  return `You revise one Markdown section of an engineering guide.
Keep accurate details. Fix the listed issues. Do not invent packages, repositories, or APIs.
Return only the revised section, starting with a level-2 heading.`;
}

export function sectionReviseUser({ plan, markdown, review, evidence, skillDigest }) {
  return `Revise this section.

SECTION: ${plan.title}
ISSUES:
${(review.issues || []).map((issue) => `- ${issue}`).join("\n") || "- Add a concrete implementation sketch."}

EVIDENCE:
${JSON.stringify(evidence || []).slice(0, 4000)}

SKILL NOTES:
${String(skillDigest || "").slice(0, 3000)}

CURRENT MARKDOWN:
${String(markdown || "").slice(0, 8000)}

Return Markdown only.`;
}
