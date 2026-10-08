/**
 * OpenRouter writer agent — hook-specific article generation.
 */

import { openRouterChat } from "../../openrouter.js";
import { parseJsonFromLLM } from "../../geoPipeline/parseLlmJson.js";
const DEFAULT_WRITER_MODEL = "anthropic/claude-sonnet-4";
import { writerSystemPrompt } from "../prompts/writer.js";
import {
	airdropBountyWriterSystemPrompt,
	airdropBountyContextPreamble,
} from "../prompts/airdropbounty-writer.js";
import { isAirdropBountySite } from "../config/airdropbounty.js";
import { buildGenerationContext } from "./generation-context.js";
import { resolveBrandContext } from "./site-context.js";
import { log, slugify, truncate } from "../utils.js";

function writerModel() {
	return (
		process.env.CONTENT_INTEL_WRITER_MODEL?.trim() ||
		process.env.CONTENT_INTEL_MODEL?.trim() ||
		DEFAULT_WRITER_MODEL
	);
}

function useAirdropAgent(site, siteId, opts = {}) {
	if (opts.agent === "airdropbounty") return true;
	return isAirdropBountySite(siteId, site);
}

export async function generateArticle(site, topic, opts = {}) {
	const siteId = opts.siteId || site.id;
	const airdropMode = useAirdropAgent(site, siteId, opts);

	let brandContext = {};
	let existingContent = opts.existingContent || [];

	if (airdropMode) {
		brandContext = await resolveBrandContext(siteId, {
			baseUrl: opts.baseUrl,
			refresh: opts.refreshBrandContext,
		});
	}

	const contextPacket = buildGenerationContext({
		site: { ...site, brandContext },
		topic,
		brandContext,
		existingContent,
	});

	const systemPrompt = airdropMode
		? airdropBountyWriterSystemPrompt(topic.hook)
		: writerSystemPrompt(topic.hook);

	const userContent = airdropMode
		? `${airdropBountyContextPreamble()}\n\nCONTEXT JSON:\n${JSON.stringify(contextPacket, null, 2)}`
		: JSON.stringify(contextPacket);

	const { content } = await openRouterChat({
		model: writerModel(),
		jsonMode: true,
		temperature: airdropMode ? 0.45 : 0.35,
		maxTokens: 8000,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userContent },
		],
	});

	let parsed;
	const repairSchema = airdropMode
		? "title, description, slug, tags, bannerImage, content, internalLinks, externalLinks"
		: "title, description, slug, content, internalLinks, externalLinks";

	try {
		parsed = parseJsonFromLLM(content);
	} catch (err) {
		log("Writer retry", "repairing JSON");
		const { content: repair } = await openRouterChat({
			model: writerModel(),
			jsonMode: true,
			temperature: 0,
			maxTokens: 8000,
			messages: [
				{
					role: "system",
					content: `Fix the JSON. Return ONLY valid JSON with ${repairSchema}.`,
				},
				{ role: "user", content: truncate(content, 14000) },
			],
		});
		parsed = parseJsonFromLLM(repair);
	}

	const tags = Array.isArray(parsed.tags)
		? parsed.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
		: [];

	return {
		title: String(parsed.title || topic.title).trim(),
		description: String(parsed.description || "").trim(),
		slug: slugify(parsed.slug || parsed.title || topic.title),
		content: String(parsed.content || "").trim(),
		tags,
		bannerImage: String(parsed.bannerImage || "").trim(),
		internalLinks: parsed.internalLinks || [],
		externalLinks: parsed.externalLinks || [],
		hook: topic.hook,
	};
}
