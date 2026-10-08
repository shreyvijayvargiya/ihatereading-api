import { chatJson, chat } from "./openrouter.js";
import { plannerSystem, plannerUser } from "./prompts/planner.js";
import { writerSystem, writerUser } from "./prompts/writer.js";
import { imagePlannerSystem, imagePlannerUser, generateImagePrompt } from "./prompts/images.js";

export { generateImagePrompt };

function topicTokens(job) {
  const base = String(job.topic || "").trim();
  const kws = [...(job.primaryKeywords || []), ...(job.secondaryKeywords || [])].filter(Boolean);
  return { base, kws, primary: kws[0] || base };
}

/** Deterministic high-signal queries when OpenRouter planning is unavailable */
export function buildFallbackQueries(job) {
  const { base, kws, primary } = topicTokens(job);
  const short = base
    .replace(/^how to build\s+/i, "")
    .replace(/\s+like\s+.+$/i, "")
    .trim();
  const product = short || primary || base;
  const queries = [
    `${product} architecture`,
    `${product} system design agent loop`,
    `${product} open source github`,
    `${product} tech stack typescript`,
    `${product} codebase indexing RAG`,
    `${product} LLM tool calling`,
    `${product} vscode extension monaco editor`,
    `${product} npm packages LSP`,
    `${product} cost LLM API tokens`,
    `${product} security sandbox prompt injection`,
    `site:github.com ${product}`,
    `"${primary}" architecture tutorial`,
    ...kws.slice(0, 6).flatMap((k) => [`${k} architecture`, `${k} open source`]),
  ];
  // de-dupe, keep order
  const seen = new Set();
  return queries.filter((q) => {
    const key = q.toLowerCase();
    if (seen.has(key) || key.length < 6) return false;
    seen.add(key);
    return true;
  });
}

function extractGithub(sources = []) {
  return sources
    .filter((s) => /github\.com\//i.test(s.url || ""))
    .map((s) => {
      const m = String(s.url).match(/github\.com\/([^/\s]+)\/([^/\s?#]+)/i);
      return {
        repository: m ? `${m[1]}/${m[2]}` : s.title,
        url: s.url,
        notes: (s.snippet || s.title || "").slice(0, 200),
        classification: "LEARN_FROM",
      };
    });
}

function extractNpmMentions(evidence = []) {
  const found = new Map();
  const re = /\b(?:npm\s+i(?:nstall)?\s+|from\s+['"]|require\(['"])(@?[\w.-]+\/[\w.-]+|[\w.-]+)['"]?/gi;
  for (const item of evidence) {
    const text = `${item.title || ""} ${item.excerpt || ""}`;
    let m;
    while ((m = re.exec(text))) {
      const pkg = m[1];
      if (!pkg || pkg.length < 2 || pkg.startsWith("http")) continue;
      if (["react", "from", "import", "the", "and"].includes(pkg.toLowerCase())) continue;
      if (!found.has(pkg)) found.set(pkg, { package: pkg, purpose: "Mentioned in research sources", notes: "Verify on npmjs.com" });
    }
  }
  // Common agent stack cues from evidence text
  const blob = evidence.map((e) => e.excerpt || "").join(" ").toLowerCase();
  const hints = [
    [/monaco|code editor/i, { package: "monaco-editor", purpose: "In-browser code editor" }],
    [/langchain|langgraph/i, { package: "@langchain/core", purpose: "Agent orchestration primitives" }],
    [/openai|chat\.completions/i, { package: "openai", purpose: "LLM API client" }],
    [/tree-sitter|ast/i, { package: "web-tree-sitter", purpose: "Parsing / indexing" }],
    [/vectordb|embeddings|pinecone|chroma/i, { package: "chromadb", purpose: "Vector store for code index (verify)" }],
  ];
  for (const [reHint, meta] of hints) {
    if (reHint.test(blob) && !found.has(meta.package)) found.set(meta.package, meta);
  }
  return [...found.values()].slice(0, 12);
}

function extractApiMentions(evidence = []) {
  const apis = [];
  const blob = evidence.map((e) => `${e.title} ${e.excerpt}`).join("\n");
  const checks = [
    [/OpenAI|Chat Completions/i, { provider: "OpenAI", purpose: "LLM completions / tools", docs: "https://platform.openai.com/docs" }],
    [/Anthropic|Claude/i, { provider: "Anthropic", purpose: "Claude models for coding agents", docs: "https://docs.anthropic.com" }],
    [/OpenRouter/i, { provider: "OpenRouter", purpose: "Multi-model LLM gateway", docs: "https://openrouter.ai/docs" }],
    [/GitHub (API|Copilot)|octokit/i, { provider: "GitHub API", purpose: "PRs and repository metadata", docs: "https://docs.github.com/en/rest" }],
  ];
  for (const [re, meta] of checks) {
    if (re.test(blob)) apis.push({ ...meta, pricing: "Pricing requires verification.", auth: "API key / OAuth — verify in docs" });
  }
  return apis;
}

function pickEvidenceBullets(evidence = [], limit = 8) {
  return evidence
    .filter((e) => (e.excerpt || "").length > 120)
    .slice(0, limit)
    .map((e) => `- From [${e.title || e.url}](${e.url}): ${String(e.excerpt).replace(/\s+/g, " ").slice(0, 280)}`);
}

function architectureFromEvidence(job, evidence = []) {
  const bullets = pickEvidenceBullets(evidence, 6);
  const systems = [
    "Editor / IDE shell (Monaco or VS Code fork)",
    "Chat + agent UI",
    "Agent loop (plan → tool call → observe → patch)",
    "Codebase index / embeddings / search",
    "LLM gateway (provider abstraction)",
    "Tools (read/write files, terminal, grep, apply patch)",
    "Context manager (windowing, summaries, RAG)",
    "Persistence (threads, checkpoints, secrets)",
  ];
  return [
    `Working model for **${job.topic}** based on scraped sources (not AI synthesis):`,
    "",
    ...systems.map((s) => `- ${s}`),
    "",
    "<!-- IMAGE: architecture-diagram -->",
    "",
    bullets.length ? "Evidence notes:" : "Limited page text extracted — deepen scrapes or fix OpenRouter for richer synthesis.",
    ...bullets,
  ].join("\n");
}

export async function planResearch(job) {
  try {
    const result = await chatJson({
      system: plannerSystem(),
      prompt: plannerUser(job),
      maxTokens: 1800,
    });
    const data = result.data || {};
    const fallback = buildFallbackQueries(job);
    const merged = [...(data.searchQueries || []), ...fallback];
    const seen = new Set();
    data.searchQueries = merged.filter((q) => {
      const k = String(q).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return data;
  } catch {
    const { base, kws } = topicTokens(job);
    return {
      productSummary: base,
      terminology: kws.slice(0, 8),
      keyQuestions: [
        `What subsystems make up ${base}?`,
        `How does the agent loop call tools and apply patches?`,
        `How is the codebase indexed for retrieval?`,
        `Which APIs, npm packages, and open-source repos are production-proven?`,
        `What are realistic cost drivers at prototype vs 1k users?`,
      ],
      searchQueries: buildFallbackQueries(job),
      systemsToResearch: [
        "editor",
        "agent loop",
        "tools",
        "code index",
        "LLM gateway",
        "UI",
        "security",
        "deployment",
      ],
      mode: "fallback",
    };
  }
}

export async function synthesizeEvidence(job, evidencePack) {
  try {
    const result = await chatJson({
      system: "Synthesize engineering research evidence into structured JSON. Do not invent packages, repos, or prices.",
      prompt: `TOPIC: ${job.topic}

EVIDENCE:
${JSON.stringify(evidencePack).slice(0, 24000)}

Return JSON. Keep every key. Do not invent package names, repositories, or prices.
{
  "summary": "",
  "architecture": "",
  "apis": [],
  "npm": [],
  "github": [],
  "database": "",
  "roadmap": [],
  "costs": "",
  "security": [],
  "seoAeo": "",
  "gaps": [],
  "facts": [],
  "patterns": [],
  "tools": [],
  "unknowns": [],
  "conflicts": [],
  "buildVsBuy": []
}`,
      maxTokens: 3500,
    });
    return result.data;
  } catch (err) {
    const sources = evidencePack.sources || [];
    const evidence = evidencePack.evidence || [];
    const github = extractGithub(sources);
    const npm = extractNpmMentions(evidence);
    const apis = extractApiMentions(evidence);
    const bullets = pickEvidenceBullets(evidence, 5);
    return {
      summary: [
        `Evidence-backed research packet for **${job.topic}** (${sources.length} sources, ${evidence.length} excerpts).`,
        `OpenRouter synthesis unavailable (${err.message}). Guide uses scraped evidence only — replace OPENROUTER_API_KEY in guideforge/server/.env to enable full AI writing.`,
        bullets.length ? "\nKey excerpts:\n" + bullets.join("\n") : "",
      ].join("\n"),
      architecture: architectureFromEvidence(job, evidence),
      apis,
      npm,
      github: github.length
        ? github
        : sources.slice(0, 8).map((s) => ({
            repository: s.title,
            url: s.url,
            notes: s.snippet || "",
            classification: "PRODUCTION_REFERENCE",
          })),
      database: [
        "Suggested persistence (verify against product needs):",
        "- `users` — auth identity",
        "- `workspaces` / `projects` — repo roots",
        "- `threads` — chat / agent sessions",
        "- `messages` — role, content, tool calls",
        "- `file_index` — path, hash, embedding ref",
        "- `checkpoints` — agent state snapshots",
        "- `secrets` — encrypted provider keys",
        "",
        "Indexes: (workspace_id, path), (thread_id, created_at). Prefer Postgres + object storage for blobs.",
      ].join("\n"),
      roadmap: [
        "Phase 1 — Chat + single-file edit loop with one LLM provider",
        "Phase 2 — Tool calling (read/write/grep) + patch apply",
        "Phase 3 — Codebase indexing + retrieval into context",
        "Phase 4 — Multi-file agent, terminal tools, checkpoints",
        "Phase 5 — Auth, billing meters, deployment, eval harness",
      ],
      costs: [
        "Cost drivers (verify current prices before publishing):",
        "- LLM tokens (input context dominates for coding agents)",
        "- Embeddings / vector store",
        "- Scraping / search if used at runtime",
        "- Hosting (API + workers + storage)",
        "",
        "Prototype: mostly LLM spend. 1k users: add caching, smaller models for routing, async jobs.",
        "Pricing requires verification against provider dashboards.",
      ].join("\n"),
      security: [
        "Sandbox tool execution and filesystem roots",
        "Never put raw user content into shell without allowlists",
        "Prompt-injection defenses on tool results",
        "Encrypt API keys at rest; short-lived tokens",
        "Rate limit agent loops and outbound SSRF",
      ],
      seoAeo: [
        "Lead with a direct definition of the product.",
        "Add comparison tables (build vs buy, editor choices).",
        "FAQ: how it works, what it costs, which stack to use.",
        "Name exact APIs/packages only when verified in sources.",
      ].join(" "),
      gaps: [
        err.message.includes("User not found")
          ? "OpenRouter key invalid — set OPENROUTER_API_KEY in guideforge/server/.env"
          : `AI unavailable: ${err.message}`,
        "Prefer official docs + GitHub READMEs over listicles when re-running",
      ],
      mode: "fallback",
      aiError: err.message,
    };
  }
}

function formatList(items, empty) {
  if (!items?.length) return empty;
  return items
    .map((a) => {
      if (typeof a === "string") return `- ${a}`;
      if (a.package) return `- **${a.package}** — ${a.purpose || a.notes || ""}`;
      if (a.provider) {
        return `- **${a.provider}** — ${a.purpose || ""}${a.docs ? ` · [docs](${a.docs})` : ""}${a.pricing ? `\n  - Pricing: ${a.pricing}` : ""}`;
      }
      if (a.repository || a.url) {
        return `- [${a.repository || a.title || a.url}](${a.url || "#"})${a.notes ? ` — ${a.notes}` : ""}${a.classification ? ` (${a.classification})` : ""}`;
      }
      return `- ${JSON.stringify(a)}`;
    })
    .join("\n");
}

export async function writeGuideMarkdown(job, synthesis, sources) {
  const sourceBlock = (sources || [])
    .slice(0, 30)
    .map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
    .join("\n");

  try {
    const result = await chat({
      system: writerSystem(job),
      prompt: writerUser({ job, synthesis, sourceBlock }),
      maxTokens: 7000,
      temperature: 0.35,
    });
    return result.content;
  } catch (err) {
    const audience = (job.audience || ["engineers"]).join(", ");
    const keywords = [...(job.primaryKeywords || []), ...(job.secondaryKeywords || [])].join(", ");
    return `# ${job.topic}

## What We Are Building

${job.description || job.topic}

**Audience:** ${audience || "engineers"}  
**Keywords:** ${keywords || "n/a"}

## What You Will Learn

- Product decomposition of an AI coding agent
- Architecture of the agent loop, tools, and code index
- Verified APIs, packages, and GitHub references from research
- A phased build roadmap and cost/security considerations

## Who This Is For

${audience || "Engineers and founders building AI developer tools."}

## Product Overview

${synthesis.summary || job.description || ""}

## How It Works

1. User states a coding goal in chat.
2. Agent plans steps and selects tools.
3. Tools read the codebase / run commands / apply patches.
4. Retrieved context + diffs feed the next LLM turn.
5. Loop continues until the task succeeds or hits budget limits.

## Core Features

- Chat-driven coding agent
- Codebase-aware context
- Tool calling (files, search, terminal)
- Patch / apply-edit pipeline
- Session persistence and checkpoints

## Architecture

${synthesis.architecture || "Requires verification."}

## System Architecture

See architecture section. Keep a thin LLM gateway, a deterministic tool layer, and an index/retrieval path separate from the UI.

## AI Architecture

- **Planner / router** — chooses tools and models
- **Context assembler** — files, RAG hits, conversation summary
- **Tool runtime** — sandboxed side effects
- **Evaluator** — optional checks before applying patches

## Technology Stack

Prefer stacks evidenced in sources. Do not invent versions. Typical candidates to verify: TypeScript, Node, Monaco/VS Code, Postgres, a vector store, OpenAI/Anthropic/OpenRouter.

## APIs

${formatList(synthesis.apis, "Requires verification from provider docs.")}

## NPM Packages

${formatList(synthesis.npm, "Requires verification — re-run with a valid OpenRouter key for curated package picks.")}

## Open Source GitHub Projects

${formatList(synthesis.github, "Requires verification.")}

## UI Stack

Relevant when building a Cursor-like product: editor surface, chat panel, file tree, diff viewer, command palette. Prefer established components (Monaco, shadcn/ui, Tailwind) over custom editors.

## Database Schema

${synthesis.database || "Requires verification."}

## Folder Structure

\`\`\`text
src/
├── agents/          # agent loop, planners
├── tools/           # file, grep, terminal, patch
├── index/           # chunking, embeddings, search
├── llm/             # provider gateway + prompts
├── api/             # HTTP routes
├── ui/              # editor + chat
├── db/              # schema + repos
└── workers/         # long-running jobs
\`\`\`

## Step-by-Step Build Roadmap

${(synthesis.roadmap || [])
  .map((r, i) => `### Phase ${i + 1}\n\n${typeof r === "string" ? r : JSON.stringify(r)}`)
  .join("\n\n")}

## Authentication & Security

${(synthesis.security || []).map((s) => `- ${s}`).join("\n") || "- Protect API keys and sandbox tools."}

## Performance

- Stream tokens to the UI
- Cache embeddings and retrieval hits
- Cap context windows; summarize old turns
- Run indexing and heavy tools as background jobs

## Testing

- Unit tests for tools and patch apply
- Golden transcript tests for the agent loop
- Prompt regression suite
- Security tests for path traversal / SSRF

## Deployment

- Local: API + web + worker
- Env: LLM keys, DB URL, storage
- Prefer cheap single-region deploy first; add queues later

## Cost Breakdown

${synthesis.costs || "Pricing requires verification."}

## Build vs Buy

| Component | Recommendation | Notes |
| --- | --- | --- |
| Editor | Buy/use Monaco or VS Code | Building an editor is rarely worth it |
| LLM | Buy APIs | Thin gateway you own |
| Index/search | Open source + hosted option | Start simple (SQLite/pgvector) |
| Agent loop | Build | Your product differentiation |

## What We Would Build First

Chat → tools → single-repo edits → then indexing.

## What We Would Add Later

Multi-repo, eval harness, billing meters, team workspaces.

## SEO/AEO Considerations

${synthesis.seoAeo || "Clear definitions, FAQs, comparison tables."}

## FAQ

**What is an AI coding agent?**  
An agent that plans coding work, calls tools against a codebase, and iterates until the task is done.

**Do I need to clone Cursor?**  
No — study public architectures and build a thinner product around the agent loop.

**What does it cost?**  
${typeof synthesis.costs === "string" ? "See Cost Breakdown — verify provider pricing." : "Pricing requires verification."}

## Sources

${sourceBlock}

---

_Guide assembled from research evidence. OpenRouter writer unavailable: ${err.message}. Add a valid key to \`guideforge/server/.env\` and re-run for full AI drafting._
`;
  }
}

export async function planImages(job, markdown) {
  try {
    const result = await chatJson({
      system: imagePlannerSystem(),
      prompt: imagePlannerUser(job, markdown),
      maxTokens: 2500,
    });
    const images = Array.isArray(result.data?.images) ? result.data.images : [];
    return images.map((img, index) => ({
      id: img.id || `image-${index + 1}`,
      type: img.type || "CONCEPT_EXPLANATION",
      section: img.section || "body",
      title: img.title || img.id || `Image ${index + 1}`,
      purpose: img.purpose || "",
      prompt: img.prompt || "",
      aspectRatio: img.aspectRatio || "16:9",
      status: "planned",
    }));
  } catch {
    return [
      {
        id: "banner",
        type: "BANNER",
        section: "hero",
        title: `${job.topic} banner`,
        purpose: "Guide hero image",
        prompt: generateImagePrompt({
          guide: job,
          section: "hero",
          imageType: "BANNER",
          surroundingContent: job.topic,
        }),
        aspectRatio: "16:9",
        status: "planned",
      },
      {
        id: "architecture-diagram",
        type: "ARCHITECTURE_DIAGRAM",
        section: "architecture",
        title: "System architecture",
        purpose: "Explain major subsystems",
        prompt: generateImagePrompt({
          guide: job,
          section: "architecture",
          imageType: "ARCHITECTURE_DIAGRAM",
          surroundingContent: String(markdown).slice(0, 1200),
        }),
        aspectRatio: "16:9",
        status: "planned",
      },
      {
        id: "agent-loop",
        type: "PROCESS_DIAGRAM",
        section: "how-it-works",
        title: "Agent loop",
        purpose: "Show plan → tool → observe → patch cycle",
        prompt: generateImagePrompt({
          guide: job,
          section: "agent-loop",
          phase: "Agent loop",
          imageType: "PROCESS_DIAGRAM",
          surroundingContent: "plan, tool call, observation, patch apply",
        }),
        aspectRatio: "16:9",
        status: "planned",
      },
    ];
  }
}
