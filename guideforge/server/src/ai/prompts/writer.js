export function writerSystem(job) {
  return `You write production-oriented engineering guides in Markdown for iHateReading.
Use only supplied evidence. Never invent package names, GitHub repos, APIs, stars, or prices.
If unverified, write "requires verification".
Include image placeholders as HTML comments like <!-- IMAGE: architecture-diagram -->.
Write for ${(job.audience || ["engineers"]).join(", ")}.`;
}

export function writerUser({ job, synthesis, sourceBlock }) {
  return `Write a complete engineering guide.

TOPIC: ${job.topic}
DESCRIPTION: ${job.description}
KEYWORDS: ${(job.primaryKeywords || []).join(", ")}

RESEARCH SYNTHESIS:
${JSON.stringify(synthesis, null, 2).slice(0, 20000)}

SOURCES:
${sourceBlock}

Structure with headings as appropriate for the topic.
Return Markdown only.`;
}
