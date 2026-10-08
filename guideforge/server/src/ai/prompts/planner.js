export function plannerSystem() {
  return `You are a research planner for engineering guides. Return compact JSON only.
Never invent search volumes, package names, or URLs.`;
}

export function plannerUser(job) {
  return `Plan research for this guide topic.

TOPIC: ${job.topic}
DESCRIPTION: ${job.description}
PRIMARY KEYWORDS: ${(job.primaryKeywords || []).join(", ")}
SECONDARY KEYWORDS: ${(job.secondaryKeywords || []).join(", ")}
AUDIENCE: ${(job.audience || []).join(", ")}
DEPTH: ${job.depth}

Return JSON:
{
  "productSummary": "",
  "terminology": [],
  "keyQuestions": [],
  "searchQueries": ["..."],
  "systemsToResearch": []
}`;
}
