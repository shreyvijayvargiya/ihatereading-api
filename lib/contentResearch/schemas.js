import { z } from "zod";

export const contentResearchRequestSchema = z.object({
	topic: z
		.string()
		.trim()
		.min(1, "Topic is required")
		.max(200, "Topic must be at most 200 characters"),
	count: z.coerce.number().int().min(5).max(20).optional().default(10),
	region: z.string().trim().max(64).optional().default("global"),
	language: z.string().trim().max(16).optional().default("en"),
});

export const SEARCH_INTENTS = [
	"informational",
	"commercial",
	"transactional",
	"navigational",
	"mixed",
];

export const CONTENT_TYPES = [
	"tutorial",
	"comparison",
	"list",
	"guide",
	"case-study",
	"news",
	"opinion",
];

export const PRIORITIES = ["high", "medium", "low"];
