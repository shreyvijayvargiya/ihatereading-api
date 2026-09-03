/**
 * Google Maps lead agent config — Karyam local business outreach.
 * Add cities here — same agent/API/CLI; pass --city / body.city to run one location.
 */

/** Default Maps keywords (no LLM). Rotate 4 per tick. */
export const DEFAULT_MAPS_KEYWORDS = [
	"cafe",
	"restaurant",
	"salon",
	"clinic",
	"clothing store",
];

export const ALL_MAPS_KEYWORDS = [
	...DEFAULT_MAPS_KEYWORDS,
	"bakery",
	"hotel",
	"guest house",
	"spa",
	"gym",
	"jewellery shop",
	"electronics shop",
	"mobile shop",
	"optician",
	"dental clinic",
	"pharmacy",
	"coaching centre",
	"institute",
	"book store",
	"furniture store",
	"interior designer",
	"real estate agency",
	"travel agency",
	"event planner",
	"catering",
	"sweet shop",
	"cloud kitchen",
	"pet shop",
	"car wash",
	"auto repair",
	"printing shop",
	"photography studio",
	"wedding planner",
	"banquet hall",
	"supermarket",
	"grocery store",
];

export const MAPS_KARYAM_AGENT = {
	id: "karyam-local",
	name: "Karyam Google Maps Local Leads",
	agency: "https://karyam.xyz",
	collection: "mapsKaryamLeads",
	stateCollection: "mapsKaryamAgentState",
	relevanceMin: 4,
	scoreBatchSize: 12,
	queriesPerRun: Number(process.env.MAPS_KARYAM_QUERIES_PER_RUN || "4"),
	categories: DEFAULT_MAPS_KEYWORDS,
	allCategories: ALL_MAPS_KEYWORDS,
	cities: [
		{ id: "kota", name: "Kota", state: "Rajasthan", country: "India" },
		{ id: "jaipur", name: "Jaipur", state: "Rajasthan", country: "India" },
		{
			id: "bangalore",
			name: "Bangalore",
			state: "Karnataka",
			country: "India",
			aliases: ["bengaluru"],
		},
		{
			id: "mumbai",
			name: "Mumbai",
			state: "Maharashtra",
			country: "India",
			aliases: ["bombay"],
		},
		{
			id: "delhi",
			name: "New Delhi",
			state: "Delhi",
			country: "India",
			aliases: ["delhi", "new-delhi", "delhi-ncr", "ncr", "newdelhi"],
		},
		{
			id: "gurgaon",
			name: "Gurugram",
			state: "Haryana",
			country: "India",
			aliases: ["gurgaon", "gurugram"],
		},
		{ id: "noida", name: "Noida", state: "Uttar Pradesh", country: "India" },
		{ id: "pune", name: "Pune", state: "Maharashtra", country: "India" },
		{
			id: "hyderabad",
			name: "Hyderabad",
			state: "Telangana",
			country: "India",
		},
		{ id: "chennai", name: "Chennai", state: "Tamil Nadu", country: "India" },
		{
			id: "kolkata",
			name: "Kolkata",
			state: "West Bengal",
			country: "India",
			aliases: ["calcutta"],
		},
		{ id: "ahmedabad", name: "Ahmedabad", state: "Gujarat", country: "India" },
		{
			id: "sf",
			name: "San Francisco",
			state: "California",
			country: "USA",
			aliases: ["san francisco", "san-francisco"],
		},
		{
			id: "nyc",
			name: "New York",
			state: "New York",
			country: "USA",
			aliases: ["new york", "new-york", "york", "newyork", "ny"],
		},
		{
			id: "london",
			name: "London",
			state: "England",
			country: "UK",
		},
		{ id: "dubai", name: "Dubai", state: "Dubai", country: "UAE" },
		{
			id: "singapore",
			name: "Singapore",
			state: "Singapore",
			country: "Singapore",
			aliases: ["singapore-city"],
		},
	],
};

function normCityKey(s) {
	return String(s || "")
		.trim()
		.toLowerCase()
		.replace(/[\s._-]+/g, "");
}

function cityKeys(city) {
	return [city.id, city.name, ...(city.aliases || [])].map(normCityKey).filter(Boolean);
}

/** Match city by id, name, or alias (case-insensitive; spaces/hyphens ignored). */
export function resolveCity(input, config = MAPS_KARYAM_AGENT) {
	if (!input) return null;
	const raw = normCityKey(input);
	if (!raw) return null;
	return config.cities.find((c) => cityKeys(c).includes(raw)) || null;
}

/** Build full Maps search strings for every city × category. */
export function buildSearchQueries(config = MAPS_KARYAM_AGENT) {
	const out = [];
	for (const city of config.cities) {
		const country = city.country || "India";
		for (const cat of config.categories) {
			out.push({
				id: `${city.id}-${cat.replace(/\s+/g, "-")}`,
				cityId: city.id,
				city: city.name,
				state: city.state,
				country,
				category: cat,
				query: `${cat} in ${city.name} ${city.state} ${country}`,
			});
		}
	}
	return out;
}

/** Filter queries by city id/name/alias. */
export function filterQueriesByCity(queries, cityInput, config = MAPS_KARYAM_AGENT) {
	if (!cityInput) return queries;
	const resolved = resolveCity(cityInput, config);
	if (resolved) {
		return queries.filter((q) => q.cityId === resolved.id);
	}
	const c = String(cityInput).toLowerCase();
	return queries.filter(
		(q) =>
			q.cityId === c ||
			String(q.city || "").toLowerCase() === c ||
			String(q.id || "").startsWith(`${c}-`),
	);
}

export function getMapsAgent(id = "karyam-local") {
	if (id === "karyam-local" || id === "karyam") return MAPS_KARYAM_AGENT;
	return null;
}

export function listCityIds(config = MAPS_KARYAM_AGENT) {
	return config.cities.map((c) => c.id);
}
