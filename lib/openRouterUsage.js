/**
 * Normalize OpenRouter chat/completions `usage` (tokens + optional USD `cost`).
 * @see https://openrouter.ai/docs/guides/guides/administration/usage-accounting
 */
export function normalizeOpenRouterUsage(raw) {
	if (!raw || typeof raw !== "object") {
		return {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			cost: 0,
			cost_details: null,
		};
	}
	const cost =
		typeof raw.cost === "number"
			? raw.cost
			: raw.cost != null
				? Number(raw.cost)
				: 0;
	return {
		prompt_tokens: raw.prompt_tokens ?? 0,
		completion_tokens: raw.completion_tokens ?? 0,
		total_tokens: raw.total_tokens ?? 0,
		cost: Number.isFinite(cost) ? cost : 0,
		cost_details: raw.cost_details ?? null,
	};
}

export function mergeOpenRouterUsage(a, b) {
	const x = normalizeOpenRouterUsage(a);
	const y = normalizeOpenRouterUsage(b);
	return {
		prompt_tokens: x.prompt_tokens + y.prompt_tokens,
		completion_tokens: x.completion_tokens + y.completion_tokens,
		total_tokens: x.total_tokens + y.total_tokens,
		cost: x.cost + y.cost,
		cost_details: null,
	};
}

export function toTokenUsageCamel(usage) {
	const u = normalizeOpenRouterUsage(usage);
	return {
		promptTokens: u.prompt_tokens,
		completionTokens: u.completion_tokens,
		totalTokens: u.total_tokens,
	};
}

/** Shape for video-translate GET responses. */
export function buildUsageResponseFields(mergedUsage) {
	const u = normalizeOpenRouterUsage(mergedUsage);
	return {
		usage: {
			prompt_tokens: u.prompt_tokens,
			completion_tokens: u.completion_tokens,
			total_tokens: u.total_tokens,
			cost: u.cost,
			...(u.cost_details != null && { cost_details: u.cost_details }),
		},
		tokenUsage: toTokenUsageCamel(u),
		priceUsd: u.cost,
	};
}
