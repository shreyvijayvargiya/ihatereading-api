/**
 * Thin Composio SDK wrapper for LinkedIn / prospecting tool execution.
 *
 * Env:
 *   COMPOSIO_API_KEY (required — must be a valid project key from app.composio.dev)
 *   COMPOSIO_USER_ID (default "default")
 *   COMPOSIO_LINKEDIN_CONNECTED_ACCOUNT_ID (optional)
 *   COMPOSIO_WIZA_CONNECTED_ACCOUNT_ID (optional)
 *   COMPOSIO_LINKEDIN_SEARCH_TOOL (default WIZA_PROSPECT_SEARCH)
 *   COMPOSIO_LINKEDIN_TOOLKIT_VERSION / COMPOSIO_WIZA_TOOLKIT_VERSION (optional, format YYYYMMDD_NN)
 */

let _composio = null;
let _composioApiKey = null;

export function getComposioUserId() {
	return (
		process.env.COMPOSIO_USER_ID?.trim() ||
		process.env.COMPOSIO_ENTITY_ID?.trim() ||
		"default"
	);
}

export function getLinkedInSearchToolSlug() {
	const raw = (
		process.env.COMPOSIO_LINKEDIN_SEARCH_TOOL?.trim() ||
		"WIZA_PROSPECT_SEARCH"
	).toUpperCase();
	// People sometimes paste toolkit slug "wiza" — that is not a tool.
	if (raw === "WIZA" || raw === "LINKEDIN" || raw === "LEADIQ") {
		if (raw === "WIZA") return "WIZA_PROSPECT_SEARCH";
		if (raw === "LEADIQ") return "LEADIQ_SEARCH_PEOPLE";
		return "WIZA_PROSPECT_SEARCH";
	}
	return raw;
}

/** Composio versions are `20260615_00`, not `v20260615_00`. */
function normalizeToolkitVersion(raw) {
	const v = String(raw || "").trim();
	if (!v || v.toLowerCase() === "latest") return v.toLowerCase() === "latest" ? "latest" : "";
	return v.replace(/^v/i, "");
}

function toolkitVersionForSlug(slug) {
	const s = String(slug || "").toUpperCase();
	if (s.startsWith("WIZA_")) {
		return normalizeToolkitVersion(process.env.COMPOSIO_WIZA_TOOLKIT_VERSION);
	}
	if (s.startsWith("LEADIQ_")) {
		return normalizeToolkitVersion(process.env.COMPOSIO_LEADIQ_TOOLKIT_VERSION);
	}
	if (s.startsWith("LINKEDIN_")) {
		return normalizeToolkitVersion(process.env.COMPOSIO_LINKEDIN_TOOLKIT_VERSION);
	}
	return "";
}

function parseComposioError(err) {
	const msg = err?.message || String(err || "");
	const blob = (() => {
		try {
			return JSON.stringify(err?.cause || err || {});
		} catch {
			return msg;
		}
	})();
	const combined = `${msg}\n${blob}`;
	const lower = combined.toLowerCase();

	if (
		lower.includes("invalid api key") ||
		lower.includes("apikey_invalidapikey") ||
		/"code"\s*:\s*801/.test(combined)
	) {
		return {
			code: "INVALID_COMPOSIO_API_KEY",
			message:
				"COMPOSIO_API_KEY is invalid or revoked. Create a new key at https://app.composio.dev → Settings → API Keys, update .env, then restart the server.",
			raw: msg,
		};
	}

	if (
		lower.includes("insufficientpermissions") ||
		lower.includes("tool_execution") ||
		lower.includes("does not have the permissions") ||
		/"code"\s*:\s*812/.test(combined)
	) {
		return {
			code: "COMPOSIO_MISSING_TOOL_EXECUTION_PERMISSION",
			message:
				'COMPOSIO_API_KEY is missing "tool_execution" write permission. In https://app.composio.dev → Settings → API Keys, edit/create a key with tool_execution = write (or use a full-access/project owner key), then restart the server.',
			raw: combined.slice(0, 500),
		};
	}

	if (lower.includes("unable to retrieve tool with slug")) {
		return {
			code: "COMPOSIO_TOOL_NOT_FOUND",
			message:
				`${msg}. Use a tool slug like WIZA_PROSPECT_SEARCH (not the toolkit name "wiza"). Also check COMPOSIO_API_KEY permissions and toolkit version.`,
			raw: msg,
		};
	}
	return { code: "COMPOSIO_ERROR", message: msg, raw: combined.slice(0, 800) };
}

export async function getComposio() {
	const apiKey = process.env.COMPOSIO_API_KEY?.trim();
	if (!apiKey) {
		throw new Error(
			"COMPOSIO_API_KEY not configured. Add it to env to run LinkedIn lead tools.",
		);
	}
	if (!_composio || _composioApiKey !== apiKey) {
		const { Composio } = await import("@composio/core");
		const toolkitVersions = {};
		const linkedInVer = normalizeToolkitVersion(
			process.env.COMPOSIO_LINKEDIN_TOOLKIT_VERSION,
		);
		const wizaVer = normalizeToolkitVersion(
			process.env.COMPOSIO_WIZA_TOOLKIT_VERSION,
		);
		if (linkedInVer && linkedInVer !== "latest") {
			toolkitVersions.linkedin = linkedInVer;
		}
		if (wizaVer && wizaVer !== "latest") {
			toolkitVersions.wiza = wizaVer;
		}
		_composio = new Composio({
			apiKey,
			...(Object.keys(toolkitVersions).length > 0
				? { toolkitVersions }
				: {}),
		});
		_composioApiKey = apiKey;
	}
	return _composio;
}

function connectedAccountForTool(slug) {
	const s = String(slug || "").toUpperCase();
	if (s.startsWith("WIZA_")) {
		return (
			process.env.COMPOSIO_WIZA_CONNECTED_ACCOUNT_ID?.trim() ||
			process.env.COMPOSIO_LINKEDIN_CONNECTED_ACCOUNT_ID?.trim() ||
			undefined
		);
	}
	if (s.startsWith("LEADIQ_")) {
		return (
			process.env.COMPOSIO_LEADIQ_CONNECTED_ACCOUNT_ID?.trim() ||
			process.env.COMPOSIO_LINKEDIN_CONNECTED_ACCOUNT_ID?.trim() ||
			undefined
		);
	}
	return (
		process.env.COMPOSIO_LINKEDIN_CONNECTED_ACCOUNT_ID?.trim() || undefined
	);
}

/**
 * Probe Composio auth + toolkit access before burning search calls.
 * @returns {{ ok: boolean, code?: string, message?: string, toolkit?: string }}
 */
export async function checkComposioReady(toolSlug = getLinkedInSearchToolSlug()) {
	const apiKey = process.env.COMPOSIO_API_KEY?.trim();
	if (!apiKey) {
		return {
			ok: false,
			code: "MISSING_COMPOSIO_API_KEY",
			message: "COMPOSIO_API_KEY is not set",
		};
	}

	try {
		const res = await fetch("https://backend.composio.dev/api/v3/tools?limit=1", {
			headers: { "x-api-key": apiKey },
			signal: AbortSignal.timeout(15_000),
		});
		const body = await res.json().catch(() => ({}));
		if (res.status === 401 || body?.error?.slug === "APIKey_InvalidAPIKey") {
			return {
				ok: false,
				code: "INVALID_COMPOSIO_API_KEY",
				message:
					"COMPOSIO_API_KEY is invalid or revoked. Create a new key at https://app.composio.dev → Settings → API Keys, update .env, restart the server.",
			};
		}
		if (!res.ok) {
			return {
				ok: false,
				code: "COMPOSIO_HTTP_ERROR",
				message:
					body?.error?.message ||
					`Composio HTTP ${res.status}`,
			};
		}
	} catch (err) {
		return {
			ok: false,
			code: "COMPOSIO_NETWORK_ERROR",
			message: err?.message || String(err),
		};
	}

	const slug = String(toolSlug || "").toUpperCase();
	const toolkit = slug.startsWith("WIZA_")
		? "wiza"
		: slug.startsWith("LEADIQ_")
			? "leadiq"
			: slug.startsWith("LINKEDIN_")
				? "linkedin"
				: null;

	if (toolkit) {
		try {
			const composio = await getComposio();
			await composio.toolkits.get(toolkit);
		} catch (err) {
			const parsed = parseComposioError(err);
			if (parsed.code === "INVALID_COMPOSIO_API_KEY") {
				return { ok: false, ...parsed, toolkit };
			}
			return {
				ok: false,
				code: "COMPOSIO_TOOLKIT_UNAVAILABLE",
				message: `Toolkit "${toolkit}" is not available for this COMPOSIO_API_KEY (${err?.message || err}). Enable/connect it in the Composio dashboard for this project.`,
				toolkit,
			};
		}
	}

	// Listing tools can succeed while execute is forbidden — probe permissions.
	try {
		const probeSlug =
			String(toolSlug || "").toUpperCase().startsWith("WIZA_")
				? "WIZA_GET_CREDITS"
				: toolSlug;
		const probe = await executeComposioTool(probeSlug, {}, {});
		if (
			!probe.successful &&
			probe.code === "COMPOSIO_MISSING_TOOL_EXECUTION_PERMISSION"
		) {
			return {
				ok: false,
				code: probe.code,
				message: probe.error,
				toolkit: toolkit || undefined,
			};
		}
		if (
			!probe.successful &&
			probe.code === "INVALID_COMPOSIO_API_KEY"
		) {
			return {
				ok: false,
				code: probe.code,
				message: probe.error,
				toolkit: toolkit || undefined,
			};
		}
	} catch (err) {
		const parsed = parseComposioError(err);
		if (
			parsed.code === "COMPOSIO_MISSING_TOOL_EXECUTION_PERMISSION" ||
			parsed.code === "INVALID_COMPOSIO_API_KEY"
		) {
			return { ok: false, ...parsed, toolkit: toolkit || undefined };
		}
	}

	return { ok: true, toolkit: toolkit || undefined };
}

/**
 * Execute a Composio tool by slug.
 * @returns {{ successful: boolean, data: any, error: string|null, code?: string, raw: any }}
 */
export async function executeComposioTool(slug, arguments_ = {}, options = {}) {
	const composio = await getComposio();
	const userId = options.userId || getComposioUserId();
	const connectedAccountId =
		options.connectedAccountId || connectedAccountForTool(slug);
	const version =
		options.version ||
		toolkitVersionForSlug(slug) ||
		undefined;

	try {
		const result = await composio.tools.execute(slug, {
			userId,
			arguments: arguments_ || {},
			...(connectedAccountId ? { connectedAccountId } : {}),
			...(version && version !== "latest" ? { version } : {}),
			dangerouslySkipVersionCheck: true,
		});

		const successful =
			result?.successful === true ||
			result?.success === true ||
			(result?.error == null && result != null);

		const errMsg = result?.error ? String(result.error) : null;
		const parsed = errMsg ? parseComposioError({ message: errMsg }) : null;

		return {
			successful,
			data: result?.data ?? result,
			error: parsed?.message || errMsg,
			code: successful ? undefined : parsed?.code,
			raw: result,
		};
	} catch (err) {
		const parsed = parseComposioError(err);
		return {
			successful: false,
			data: null,
			error: parsed.message,
			code: parsed.code,
			raw: null,
		};
	}
}

/**
 * Map an agent search query object into Composio tool arguments.
 * Supports WIZA_PROSPECT_SEARCH and generic LinkedIn-style keyword queries.
 */
export function buildSearchToolArguments(query, toolSlug) {
	const slug = String(toolSlug || getLinkedInSearchToolSlug()).toUpperCase();
	const limit = Math.min(
		Math.max(Number(query?.limit) || 10, 1),
		Number(process.env.LINKEDIN_LEADS_MAX_PER_QUERY) || 25,
	);

	if (query?.arguments && typeof query.arguments === "object") {
		return normalizeWizaArguments(query.arguments, limit, slug);
	}

	if (slug === "WIZA_PROSPECT_SEARCH") {
		return {
			limit,
			filters: buildWizaFilters(query),
		};
	}

	if (slug === "LEADIQ_SEARCH_PEOPLE") {
		return {
			limit,
			...(query?.firstName ? { firstName: query.firstName } : {}),
			...(query?.lastName ? { lastName: query.lastName } : {}),
			...(query?.company ? { company: { name: query.company } } : {}),
			...(query?.q ? { fullName: query.q } : {}),
			...(query?.linkedinUrl ? { linkedinUrl: query.linkedinUrl } : {}),
		};
	}

	if (slug === "LINKEDIN_SEARCH_AD_TARGETING_ENTITIES") {
		return {
			query: query?.q || query?.keywords || query?.jobTitle || "",
			facet:
				query?.facet ||
				"urn:li:adTargetingFacet:titles",
			count: limit,
		};
	}

	return {
		query: query?.q || query?.keywords || "",
		limit,
		...(query?.jobTitle ? { jobTitle: query.jobTitle } : {}),
		...(query?.location ? { location: query.location } : {}),
		...(query?.company ? { company: query.company } : {}),
		...(query?.industry ? { industry: query.industry } : {}),
	};
}

function toStringArray(value) {
	if (value == null || value === "") return [];
	if (Array.isArray(value)) {
		return value.map((v) => String(v).trim()).filter(Boolean);
	}
	return String(value)
		.split(/[,|/]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Wiza filters require arrays + exact keys:
 * job_titles, locations, industries, companies, company_size, seniority_levels
 * (no free-text "keywords"; additionalProperties=false)
 */
function buildWizaFilters(query = {}) {
	const src =
		query.filters && typeof query.filters === "object" ? query.filters : {};
	const filters = {};

	const jobTitles = toStringArray(
		src.job_titles ||
			src.jobTitles ||
			src.job_title ||
			query.jobTitle ||
			query.title,
	);
	const locations = toStringArray(
		src.locations || src.location || query.location,
	);
	const industries = toStringArray(
		src.industries || src.industry || query.industry,
	);
	const companies = toStringArray(
		src.companies || src.company || query.company,
	);
	const companySize = toStringArray(
		src.company_size || src.companySize || query.companySize,
	);
	const seniority = toStringArray(
		src.seniority_levels || src.seniorityLevels || query.seniority,
	);

	// If LLM only gave keywords/q, map into job_titles (best available signal).
	if (
		jobTitles.length === 0 &&
		(query.keywords || query.q || src.keywords)
	) {
		jobTitles.push(
			...toStringArray(query.jobTitle || query.keywords || query.q).slice(
				0,
				3,
			),
		);
	}

	if (jobTitles.length) filters.job_titles = jobTitles;
	if (locations.length) filters.locations = locations;
	if (industries.length) filters.industries = industries;
	if (companies.length) filters.companies = companies;
	if (companySize.length) filters.company_size = companySize;
	if (seniority.length) filters.seniority_levels = seniority;

	if (Object.keys(filters).length === 0) {
		filters.job_titles = ["Founder"];
	}
	return filters;
}

function normalizeWizaArguments(arguments_, limit, slug) {
	if (slug !== "WIZA_PROSPECT_SEARCH") return arguments_;
	const filters = buildWizaFilters({
		filters: arguments_.filters,
		...arguments_,
	});
	return {
		limit: arguments_.limit || limit,
		filters,
	};
}

export function extractLeadsFromToolResult(result) {
	if (!result) return [];
	const data = result.data ?? result;
	const candidates = [];

	const pushArr = (arr) => {
		if (Array.isArray(arr)) candidates.push(...arr);
	};

	if (Array.isArray(data)) pushArr(data);
	else if (data && typeof data === "object") {
		pushArr(data.profiles);
		pushArr(data.results);
		pushArr(data.people);
		pushArr(data.leads);
		pushArr(data.prospects);
		pushArr(data.sample_profiles);
		pushArr(data.sampleProfiles);
		pushArr(data.data?.profiles);
		pushArr(data.data?.results);
		pushArr(data.data?.people);
		if (
			candidates.length === 0 &&
			(data.name ||
				data.full_name ||
				data.linkedin_url ||
				data.profile_url)
		) {
			candidates.push(data);
		}
	}

	return candidates.map(normalizeLead).filter(Boolean);
}

function normalizeLead(raw) {
	if (!raw || typeof raw !== "object") return null;
	const name =
		raw.full_name ||
		raw.fullName ||
		raw.name ||
		[raw.first_name || raw.firstName, raw.last_name || raw.lastName]
			.filter(Boolean)
			.join(" ") ||
		null;
	const title =
		raw.title || raw.job_title || raw.jobTitle || raw.headline || null;
	const company =
		raw.company ||
		raw.company_name ||
		raw.companyName ||
		raw.organization ||
		null;
	const location = raw.location || raw.geo || raw.region || null;
	const linkedinUrl =
		raw.linkedin_url ||
		raw.linkedinUrl ||
		raw.profile_url ||
		raw.profileUrl ||
		raw.url ||
		null;
	const email = raw.email || raw.work_email || raw.workEmail || null;

	if (!name && !linkedinUrl && !title) return null;

	return {
		name,
		title,
		company,
		location,
		linkedinUrl,
		email,
		raw,
	};
}
