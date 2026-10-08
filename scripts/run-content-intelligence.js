#!/usr/bin/env node
/**
 * Content Intelligence CLI — enroll, research (loop), list, approve, generate.
 *
 * Usage:
 *   npm run content:intelligence -- enroll --name "AirdropBounty" --domain https://airdropbounty.events
 *   npm run content:intelligence -- research --site airdropbounty-events
 *   npm run content:intelligence -- research --site airdropbounty-events --loop
 *   npm run content:intelligence -- list sites|topics|articles --site airdropbounty-events
 *   npm run content:intelligence -- approve --site airdropbounty-events --topic <id>
 *   npm run content:intelligence -- generate --site airdropbounty-events --topic <id>
 *   npm run content:intelligence -- generate-batch --site airdropbounty-events --limit 15
 *   npm run content:intelligence -- dashboard --site airdropbounty-events
 */

import "dotenv/config";
import { hasOpenRouterKey } from "../lib/useAi.js";
import { resolveResearchBaseUrl } from "../lib/contentResearch/http.js";
import {
	enrollSite,
	runResearch,
	runGenerate,
	runGenerateBatch,
	getDashboard,
	patchTopic,
	listSites,
	listTopics,
} from "../lib/content/orchestrator.js";
import { listArticles, resolveSite } from "../lib/content/services/firestore.js";
import { makeSiteId } from "../lib/content/utils.js";

const args = process.argv.slice(2);
const cmd = (args[0] || "help").toLowerCase();

function flag(name) {
	const i = args.indexOf(name);
	return i !== -1 ? args[i + 1] : undefined;
}

const hasLoop = args.includes("--loop");
const intervalMs = Number(process.env.CONTENT_INTEL_INTERVAL_MS || 8000);
const baseUrl =
	process.env.SCRAPE_API_BASE_URL ||
	process.env.INKGEST_SCRAPE_BASE_URL ||
	`http://127.0.0.1:${process.env.PORT || 3002}`;

function requireSite() {
	const siteId = flag("--site") || flag("--siteId");
	if (!siteId) {
		console.error("--site <siteId> is required");
		process.exit(1);
	}
	return siteId;
}

async function ensureSite(siteId) {
	const resolved = await resolveSite(siteId);
	if (resolved) return resolved.siteId;

	if (args.includes("--enroll-if-missing")) {
		const domain = flag("--domain");
		const name = flag("--name") || siteId;
		if (!domain) {
			console.error(
				`Site "${siteId}" not found. Use --enroll-if-missing with --domain https://...`,
			);
			process.exit(1);
		}
		const enrolled = await enrollSite({
			name,
			domain,
			description: flag("--description") || "",
			audience: flag("--audience") || "",
			contentGoals:
				flag("--goals")?.split(",").map((s) => s.trim()).filter(Boolean) || [],
			competitors:
				flag("--competitors")?.split(",").map((s) => s.trim()).filter(Boolean) ||
				[],
		});
		console.log(`[content-intel] enrolled siteId=${enrolled.siteId}`);
		return enrolled.siteId;
	}

	const expected = makeSiteId(
		"Site",
		siteId.includes(".") ? siteId : `https://${siteId.replace(/-/g, ".")}`,
	);
	console.error(
		`Site not found: "${siteId}".\n` +
			`  npm run content:intelligence -- list sites\n` +
			`  npm run content:intelligence -- enroll --name "AirdropBounty" --domain https://airdropbounty.events\n` +
			`  (siteId after enroll is usually "${expected}")`,
	);
	process.exit(1);
}

function isFatalLoopError(err) {
	const status = Number(err?.status);
	if (status === 404 || status === 400) return true;
	if (err?.code === "SITE_NOT_FOUND") return true;
	if (/Site not found/i.test(err?.message || "")) return true;
	if (/OPENROUTER_API_KEY/i.test(err?.message || "")) return true;
	return false;
}

function requireLlm() {
	if (!hasOpenRouterKey()) {
		console.error("OPENROUTER_API_KEY is required for research/generate");
		process.exit(1);
	}
}

async function cmdEnroll() {
	const body = {
		name: flag("--name"),
		domain: flag("--domain"),
		description: flag("--description") || "",
		audience: flag("--audience") || "",
		contentGoals: flag("--goals")?.split(",").map((s) => s.trim()).filter(Boolean) || [],
		competitors: flag("--competitors")?.split(",").map((s) => s.trim()).filter(Boolean) || [],
	};
	if (!body.name || !body.domain) {
		console.error("--name and --domain are required");
		process.exit(1);
	}
	const result = await enrollSite(body);
	console.log(JSON.stringify(result, null, 2));
}

async function cmdResearch() {
	requireLlm();
	const siteId = await ensureSite(requireSite());
	const limit = Math.min(30, Number(flag("--limit") || 30));
	console.log(`[content-intel] research site=${siteId} base=${baseUrl} limit=${limit}`);
	const summary = await runResearch(siteId, {
		baseUrl,
		limit,
		force: args.includes("--force"),
		refreshContent: !args.includes("--no-refresh"),
	});
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function cmdList() {
	const what = (args[1] || "topics").toLowerCase();
	if (what === "sites") {
		const sites = await listSites();
		console.log(JSON.stringify(sites, null, 2));
		return;
	}
	const siteId = requireSite();
	if (what === "topics") {
		const topics = await listTopics(siteId, {
			status: flag("--status"),
			hook: flag("--hook"),
		});
		console.log(JSON.stringify(topics, null, 2));
		return;
	}
	if (what === "articles") {
		const articles = await listArticles(siteId, Number(flag("--limit") || 50));
		console.log(JSON.stringify(articles, null, 2));
		return;
	}
	console.error("list targets: sites | topics | articles");
	process.exit(1);
}

async function cmdApprove() {
	const siteId = requireSite();
	const topicId = flag("--topic") || flag("--topicId");
	if (!topicId) {
		console.error("--topic <topicId> is required");
		process.exit(1);
	}
	const topic = await patchTopic(siteId, topicId, { status: "approved" });
	console.log(JSON.stringify(topic, null, 2));
}

async function cmdReject() {
	const siteId = requireSite();
	const topicId = flag("--topic") || flag("--topicId");
	if (!topicId) {
		console.error("--topic <topicId> is required");
		process.exit(1);
	}
	const topic = await patchTopic(siteId, topicId, { status: "rejected" });
	console.log(JSON.stringify(topic, null, 2));
}

async function cmdGenerate() {
	requireLlm();
	const siteId = requireSite();
	const topicId = flag("--topic") || flag("--topicId");
	if (!topicId) {
		console.error("--topic <topicId> is required");
		process.exit(1);
	}
	const result = await runGenerate(siteId, topicId, {
		baseUrl,
		force: args.includes("--force"),
	});
	console.log(JSON.stringify(result, null, 2));
}

async function cmdGenerateBatch() {
	requireLlm();
	const siteId = requireSite();
	const limit = Number(flag("--limit") || 15);
	const result = await runGenerateBatch(siteId, {
		baseUrl,
		limit,
		force: args.includes("--force"),
	});
	console.log(JSON.stringify(result, null, 2));
}

async function cmdDashboard() {
	const siteId = requireSite();
	const data = await getDashboard(siteId, {
		status: flag("--status"),
		hook: flag("--hook"),
	});
	console.log(JSON.stringify(data, null, 2));
}

function printHelp() {
	console.log(`Content Intelligence CLI

Firestore: content_sites/{siteId}/topics|articles|research

Commands:
  enroll       Create/update a site (--name, --domain, --description, --audience)
  research     Discover 30 topics (Google + Reddit via search + scrape + LLM)
  list         sites | topics | articles
  approve      Approve a topic for generation
  reject       Reject a topic
  generate     Generate one article for approved topic
  generate-batch  Generate up to 15 approved articles (concurrency 2)
  dashboard    Site stats + topics + articles

Flags:
  --site <siteId>     Site id (from enroll)
  --topic <topicId>   Topic document id
  --loop              Keep research running on interval (default 30min)
  --enroll-if-missing  Auto-enroll when --site missing (needs --domain --name)
  --force             Bypass cooldown / regenerate
  --limit <n>         Topic or batch limit
  --status pending    Filter list/dashboard
  --hook faq          Filter by hook

Env:
  OPENROUTER_API_KEY
  CONTENT_INTEL_INTERVAL_MS=8000
  CONTENT_INTEL_RESEARCH_MODEL / CONTENT_INTEL_WRITER_MODEL
  SCRAPE_API_BASE_URL=http://127.0.0.1:3002

Pilot:
  npm run dev
  npm run content:intelligence -- enroll --name "AirdropBounty" --domain https://airdropbounty.events --description "..." --audience "..."
  npm run content:intelligence -- research --site airdropbounty-events
  npm run content:intelligence -- dashboard --site airdropbounty-events
  npm run content:intelligence -- approve --site airdropbounty-events --topic <id>
  npm run content:intelligence -- generate-batch --site airdropbounty-events --limit 15
`);
}

async function main() {
	if (cmd === "help" || cmd === "--help") {
		printHelp();
		return;
	}

	if (cmd === "enroll") return cmdEnroll();

	if (cmd === "research") {
		if (hasLoop) {
			// Fail fast before entering infinite loop (missing site, missing API key, etc.)
			await cmdResearch();
			console.log(`[content-intel] loop every ${intervalMs}ms (Ctrl+C to stop)`);
			for (;;) {
				await new Promise((r) => setTimeout(r, intervalMs));
				try {
					await cmdResearch();
				} catch (err) {
					console.error("[content-intel] research tick failed:", err?.message || err);
					if (isFatalLoopError(err)) {
						console.error("[content-intel] fatal error — stopping loop");
						process.exit(1);
					}
				}
			}
		}
		return cmdResearch();
	}

	if (cmd === "list") return cmdList();
	if (cmd === "approve") return cmdApprove();
	if (cmd === "reject") return cmdReject();
	if (cmd === "generate") return cmdGenerate();
	if (cmd === "generate-batch" || cmd === "batch") return cmdGenerateBatch();
	if (cmd === "dashboard") return cmdDashboard();

	console.error(`Unknown command: ${cmd}`);
	printHelp();
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
