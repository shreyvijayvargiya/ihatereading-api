/**
 * Programming magazine covers — YouTube + X educators by category/topic.
 * One agent; pass --category / --topic instead of cloning.
 */

export const MAGAZINE_CHANNELS = "dev-magazine-channels";
export const MAGAZINE_VIDEOS = "dev-magazine-videos";
export const MAGAZINE_STATE = "devMagazineAgentState";

export const MAGAZINE_AGENT = {
	id: "dev-magazine",
	name: "Programming magazine creators",
	channelsCollection: MAGAZINE_CHANNELS,
	videosCollection: MAGAZINE_VIDEOS,
	stateCollection: MAGAZINE_STATE,
	queriesPerRun: Number(process.env.MAGAZINE_QUERIES_PER_RUN || "3"),
	enrichPerRun: Number(process.env.MAGAZINE_ENRICH_PER_RUN || "8"),
	videosPerChannel: Number(process.env.MAGAZINE_VIDEOS_PER_CHANNEL || "10"),
	channelsForVideosPerRun: Number(
		process.env.MAGAZINE_VIDEO_CHANNELS_PER_RUN || "6",
	),
	scoreBatchSize: 8,
	relevanceMin: 3,
	minFollowers: Number(process.env.MAGAZINE_MIN_FOLLOWERS || "0"),
};

/** Magazine covers. Add topics here — same CLI (`--category` / `--topic`). */
export const MAGAZINE_CATEGORIES = [
	{
		id: "frontend",
		name: "Frontend",
		topics: [
			"html",
			"css",
			"svg",
			"animations",
			"graphics",
			"canva",
			"react",
			"nextjs",
			"vite",
			"svelte",
			"astro",
			"vercel",
			"cloudflare",
		],
	},
	{
		id: "backend",
		name: "Backend",
		topics: [
			"algorithms",
			"apis",
			"databases",
			"deployment",
			"hosting",
			"cli",
			"automation",
			"scraping",
			"compilers",
			"transpilers",
		],
	},
	{
		id: "mobile",
		name: "Mobile Development",
		topics: [
			"expo",
			"flutter",
			"react-native",
			"swift",
			"app-store",
			"play-store",
			"mac-apps",
			"ios",
			"gaming",
		],
	},
	{
		id: "databases",
		name: "Databases",
		topics: [
			"postgres",
			"mongodb",
			"redis",
			"mysql",
			"prisma",
			"supabase",
			"firebase",
			"elasticsearch",
			"sqlite",
		],
	},
	{
		id: "testing",
		name: "Testing",
		topics: [
			"jest",
			"pentest",
			"e2e",
			"testing-frameworks",
			"mobile-testing",
			"ai-testing",
			"ai-prompts",
		],
	},
	{
		id: "tools",
		name: "Tools",
		topics: [
			"prompts-directory",
			"tools-directory",
			"mac-apps",
			"github-apps",
			"saas",
		],
	},
	{
		id: "miscellaneous",
		name: "Miscellaneous",
		topics: [
			"investors",
			"investments",
			"hackathons",
			"conferences",
			"news",
			"awards",
			"public-appearances",
		],
	},
];

function norm(s) {
	return String(s || "")
		.trim()
		.toLowerCase()
		.replace(/[\s._]+/g, "-");
}

export function resolveCategory(input) {
	if (!input) return null;
	const raw = norm(input);
	return (
		MAGAZINE_CATEGORIES.find((c) => c.id === raw || norm(c.name) === raw) ||
		null
	);
}

export function resolveTopic(category, input) {
	if (!input || !category) return null;
	const raw = norm(input);
	return (category.topics || []).find((t) => norm(t) === raw) || null;
}

export function listCategoryIds() {
	return MAGAZINE_CATEGORIES.map((c) => c.id);
}

export function buildMagazineQueries() {
	const out = [];
	for (const cat of MAGAZINE_CATEGORIES) {
		for (const topic of cat.topics) {
			const label = topic.replace(/-/g, " ");
			out.push({
				id: `yt-${cat.id}-${topic}`,
				platform: "youtube",
				categoryId: cat.id,
				category: cat.name,
				topic,
				query: `${label} programming tutorial YouTube channel site:youtube.com/@`,
			});
			out.push({
				id: `yt-best-${cat.id}-${topic}`,
				platform: "youtube",
				categoryId: cat.id,
				category: cat.name,
				topic,
				query: `best ${label} ${cat.name} YouTube channels for developers`,
			});
			out.push({
				id: `x-${cat.id}-${topic}`,
				platform: "x",
				categoryId: cat.id,
				category: cat.name,
				topic,
				query: `${label} developer OR programmer site:x.com OR site:twitter.com`,
			});
		}
	}
	return out;
}

export const ALL_MAGAZINE_QUERIES = buildMagazineQueries();

export function filterMagazineQueries(
	queries = ALL_MAGAZINE_QUERIES,
	{ category, topic, platform } = {},
) {
	let out = queries;
	const cat = category ? resolveCategory(category) : null;
	if (category) {
		if (!cat) return [];
		out = out.filter((q) => q.categoryId === cat.id);
	}
	if (topic) {
		const t = norm(topic);
		out = out.filter((q) => norm(q.topic) === t);
	}
	if (platform) {
		const p = String(platform).toLowerCase();
		out = out.filter((q) => q.platform === p);
	}
	return out;
}
