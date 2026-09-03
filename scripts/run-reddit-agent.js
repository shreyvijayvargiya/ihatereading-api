#!/usr/bin/env node
/**
 * CLI for Reddit agents (does NOT start with npm run dev).
 * Default: scrape-only (no OpenRouter). Pass --llm to score.
 *
 * Usage:
 *   npm run reddit:agent -- karyam
 *   npm run reddit:agent -- ihatereading --llm
 *   npm run reddit:agent -- saas
 *   node scripts/run-reddit-agent.js saas --skip-google
 *   node scripts/run-reddit-agent.js list
 */

import "dotenv/config";
import { getAgent, listAgentIds, AGENTS } from "../lib/redditAgents/configs.js";
import { runKaryamAgent } from "../lib/redditAgents/karyam.js";
import { runIhatereadingAgent } from "../lib/redditAgents/ihatereading.js";
import { runSaasProblemsAgent } from "../lib/redditAgents/saasProblems.js";
import { runDirectoryIdeasAgent } from "../lib/redditAgents/directoryIdeas.js";
import { runScrapingProblemsAgent } from "../lib/redditAgents/scrapingProblems.js";
import { runBuildsaasAgent } from "../lib/redditAgents/buildsaas.js";
import { listAgentPosts } from "../lib/redditAgents/core.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "").toLowerCase();
const skipGoogle = args.includes("--skip-google");
const llm = args.includes("--llm") || args.includes("--enrich");

async function main() {
	if (!cmd || cmd === "help" || cmd === "--help") {
		console.log(`Reddit agents (manual / CLI only — never auto-scheduled)

Agents: ${listAgentIds().join(", ")}

Default is scrape-only (no OpenRouter). Pass --llm to score posts.

  npm run reddit:agent -- karyam
  npm run reddit:agent -- ihatereading
  npm run reddit:agent -- saas
  npm run reddit:agent -- directories
  npm run reddit:directories
  npm run reddit:scraping
  npm run reddit:agent -- scraping
  npm run reddit:buildsaas
  npm run reddit:agent -- buildsaas
  npm run reddit:agent -- saas --skip-google
  npm run reddit:agent -- saas --llm
  npm run reddit:agent -- list
  npm run reddit:agent -- relevant <agentId>

HTTP (server must be running):
  POST /reddit-agents/<id>/run
  POST /reddit-agents/<id>/run  { "llm": true }
  GET  /reddit-agents/<id>/relevant
`);
		process.exit(0);
	}

	if (cmd === "list") {
		for (const id of listAgentIds()) {
			const a = AGENTS[id];
			console.log(`- ${id}: ${a.name} (${(a.subreddits || []).length} subs)`);
		}
		process.exit(0);
	}

	if (cmd === "relevant") {
		const agentId = (args[1] || "").toLowerCase();
		if (!getAgent(agentId)) {
			console.error(`Unknown agent: ${agentId}`);
			process.exit(1);
		}
		const posts = await listAgentPosts(agentId, { minScore: 0, limit: 50 });
		console.log(JSON.stringify({ agentId, count: posts.length, posts }, null, 2));
		process.exit(0);
	}

	if (llm && !process.env.OPENROUTER_API_KEY?.trim()) {
		console.error("OPENROUTER_API_KEY is required with --llm / --enrich");
		process.exit(1);
	}

	const agent = getAgent(cmd);
	if (!agent) {
		console.error(`Unknown agent "${cmd}". Use: ${listAgentIds().join(", ")}`);
		process.exit(1);
	}

	console.log(
		`[cli] starting agent: ${agent.id} (${agent.name}) llm=${llm ? "on" : "off (scrape-only)"}`,
	);
	const baseUrl =
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		`http://127.0.0.1:${process.env.PORT || 3002}`;
	const runOpts = { skipGoogle, baseUrl, ...(llm ? { llm: true } : {}) };
	let summary;
	if (cmd === "karyam") summary = await runKaryamAgent(runOpts);
	else if (cmd === "ihatereading") summary = await runIhatereadingAgent(runOpts);
	else if (cmd === "saas") summary = await runSaasProblemsAgent(runOpts);
	else if (cmd === "directories")
		summary = await runDirectoryIdeasAgent(runOpts);
	else if (cmd === "scraping")
		summary = await runScrapingProblemsAgent(runOpts);
	else if (cmd === "buildsaas") summary = await runBuildsaasAgent(runOpts);
	else {
		console.error("No runner for", cmd);
		process.exit(1);
	}

	console.log(
		JSON.stringify(
			{
				success: true,
				agentId: summary.agentId,
				llm: summary.llm ?? llm,
				newPosts: summary.newPosts,
				relevantCount: summary.relevant?.length || 0,
				errors: summary.errors || [],
				relevant: (summary.relevant || []).slice(0, 20),
			},
			null,
			2,
		),
	);
}

main().catch((err) => {
	console.error("[cli] failed:", err?.message || err);
	process.exit(1);
});
