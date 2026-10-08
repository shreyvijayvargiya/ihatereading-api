/**
 * Build rich context packets for blog generation (full Firestore objects).
 */

function serializeValue(value) {
	if (value == null) return value;
	if (typeof value === "object" && typeof value.toDate === "function") {
		try {
			return value.toDate().toISOString();
		} catch {
			return String(value);
		}
	}
	if (Array.isArray(value)) return value.map(serializeValue);
	if (typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, serializeValue(v)]),
		);
	}
	return value;
}

export function serializeDoc(doc) {
	if (!doc || typeof doc !== "object") return {};
	return serializeValue(doc);
}

export function buildGenerationContext({
	site,
	topic,
	brandContext,
	existingContent = [],
}) {
	const internalCandidates = topic.internalLinkCandidates || [];
	const externalCandidates =
		topic.externalLinkCandidates || topic.sources || [];

	return {
		_meta: {
			generatedFor: "airdropbounty-blog-agent",
			instruction:
				"Use every field below. The topic object is the full AI-researched brief from Firestore.",
		},
		site: serializeDoc(site),
		topic: serializeDoc(topic),
		brandContext: serializeDoc(brandContext || {}),
		researchSources: (topic.sources || []).map((s) => ({
			title: s.title,
			url: s.url,
			domain: s.domain,
			type: s.type,
		})),
		internalLinkCandidates: internalCandidates,
		externalLinkCandidates: externalCandidates.map((s) => ({
			title: s.title,
			url: s.url,
			domain: s.domain,
		})),
		existingSiteContentSample: (existingContent || []).slice(0, 8).map((p) => ({
			title: p.title,
			url: p.url,
			description: p.description,
		})),
	};
}
