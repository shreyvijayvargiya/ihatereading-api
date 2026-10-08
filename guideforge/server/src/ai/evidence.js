const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "your", "how",
  "what", "does", "are", "use", "using", "build", "like", "when", "then",
  "have", "will", "can", "not", "but", "its", "our", "you",
]);

function tokensOf(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9.+_-]+/)
    .filter((token) => token.length > 3 && !STOP.has(token));
}

function firstSentence(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const cut = clean.split(/(?<=[.!?])\s/)[0];
  return cut.slice(0, 280);
}

function sourceType(url) {
  const href = String(url || "").toLowerCase();
  if (href.includes("github.com")) return "github";
  if (href.includes("npmjs.com")) return "npm";
  if (href.includes("docs.") || href.includes("/docs") || href.includes("readthedocs")) return "documentation";
  return "web";
}

function categoryFor(url, title, text) {
  const blob = `${url} ${title} ${text}`.toLowerCase();
  if (blob.includes("github.com")) return "github";
  if (blob.includes("npm")) return "npm";
  if (/security|sandbox|prompt injection/.test(blob)) return "security";
  if (/postgres|sqlite|schema|database/.test(blob)) return "database";
  if (/monaco|vscode|editor|ui\b/.test(blob)) return "ui";
  if (/deploy|docker|kubernetes/.test(blob)) return "deployment";
  if (/\bapi\b|openapi/.test(blob)) return "api";
  if (/test|eval|benchmark/.test(blob)) return "testing";
  if (/cost|pricing|token/.test(blob)) return "costs";
  return "general";
}

/** Turn scraped pages into a small evidence list. Full page text stays out of later prompts. */
export function buildEvidenceStore(job) {
  const rows = [];
  const seen = new Set();
  const inputs = [...(job.evidence || []), ...(job.sources || [])];
  for (const item of inputs) {
    const url = item.url;
    if (!url || seen.has(url)) continue;
    const text = item.excerpt || item.content || item.snippet || "";
    if (String(text).trim().length < 40 && !item.title) continue;
    seen.add(url);
    rows.push({
      id: `ev_${String(rows.length + 1).padStart(3, "0")}`,
      category: categoryFor(url, item.title, text),
      claim: firstSentence(text) || item.title || url,
      source: url,
      sourceType: sourceType(url),
      relevance: 0.55,
      title: item.title || url,
      excerpt: String(text).replace(/\s+/g, " ").trim().slice(0, 700),
    });
  }
  return rows;
}

function contextMismatch(planText, evidence) {
  const plan = planText.toLowerCase();
  const blob = `${evidence.title} ${evidence.excerpt} ${evidence.source} ${evidence.claim}`.toLowerCase();
  if (/\bmonaco\b/.test(plan) && /editor|vscode|ide/.test(plan)) {
    if (!/editor|vscode|ide|monaco-editor/.test(blob)) return true;
  }
  return false;
}

/**
 * Pick evidence that shares meaningful terms with the section.
 * Unrelated pages (including a bare "monaco" country hit) stay out.
 */
export function getEvidenceForSection(plan, evidence, limit = 6) {
  const planText = [
    plan.title,
    plan.objective,
    plan.purpose,
    ...(plan.questionsToAnswer || []),
    ...(plan.requiredConcepts || []),
    ...(plan.researchCategories || []),
  ].join(" ");
  const tokens = tokensOf(planText);
  const ranked = [];
  for (const item of evidence || []) {
    if (contextMismatch(planText, item)) continue;
    const blob = `${item.title} ${item.claim} ${item.excerpt} ${item.category} ${item.source}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (blob.includes(token)) score += token.length > 6 ? 2 : 1;
    }
    if (score <= 0) continue;
    ranked.push({ item, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  const strong = ranked.filter((row) => row.score >= 3);
  const chosen = (strong.length ? strong : ranked).slice(0, limit);
  return chosen.map((row) => ({
    ...row.item,
    relevance: Math.min(0.99, 0.45 + row.score / 10),
  }));
}
