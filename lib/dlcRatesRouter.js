/**
 * Government DLC / circle-rate lookup (floor, not market).
 *
 * POST /dlc-rates   (GET with the same query params also works)
 *
 * Rajasthan is live. Other states (MP, UP, Karnataka, Maharashtra) return 501.
 *
 * Cascade: district → urban/rural → SRO → (optional colony/village) → rate table.
 * Primary source is the official e-Panjiyan JSON API. `/scrape` is used only
 * if that API is down or `forceScrape: true`.
 */

import { Hono } from "hono";
import {
	RAJASTHAN_DLC_PORTAL_URL,
	getColonies,
	getDistricts,
	getDlcRates,
	getSros,
} from "./rajasthanEpanjiyanClient.js";

export const dlcRatesRouter = new Hono();

const SUPPORTED_STATES = {
	rajasthan: {
		id: "rajasthan",
		name: "Rajasthan",
		portal: RAJASTHAN_DLC_PORTAL_URL,
		aliases: ["rj", "raj", "rajasthan"],
	},
};

const PLANNED_STATES = [
	{ id: "madhya_pradesh", name: "Madhya Pradesh", portal: "MPIGR" },
	{ id: "uttar_pradesh", name: "Uttar Pradesh", portal: "IGRSUP" },
	{ id: "karnataka", name: "Karnataka", portal: "Kaveri" },
	{ id: "maharashtra", name: "Maharashtra", portal: "IGR" },
];

const DISCLAIMER =
	"DLC / circle rates are the government minimum used for stamp duty — not market prices. In Rajasthan, listed market value is typically 20% to 100%+ above this floor.";

const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 400;
const OPTIONS_CAP = 200;
const SCRAPE_TIMEOUT_MS = 90_000;

function scrapeBaseUrl(c) {
	const envHint = (
		process.env.SCRAPE_API_BASE_URL ||
		process.env.INKGEST_SCRAPE_BASE_URL ||
		""
	).trim();
	if (envHint) return envHint.replace(/\/$/, "");
	try {
		const origin = new URL(c.req.url).origin;
		if (origin && origin !== "null") return origin;
	} catch {
		/* ignore */
	}
	return `http://127.0.0.1:${process.env.PORT || 3002}`;
}

function floorMeta() {
	return {
		rateKind: "government_floor",
		disclaimer: DISCLAIMER,
		sourceName: "Rajasthan e-Panjiyan DLC",
		sourceUrl: RAJASTHAN_DLC_PORTAL_URL,
	};
}

function normalizeState(raw) {
	const s = String(raw || "")
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	if (!s) return "";
	for (const spec of Object.values(SUPPORTED_STATES)) {
		if (spec.id === s || spec.aliases.includes(s)) return spec.id;
	}
	return s;
}

function normalizeAreaType(raw) {
	const s = String(raw || "")
		.trim()
		.toLowerCase();
	if (!s) return null;
	if (["urban", "u", "city", "nagar", "shahri", "municipal"].includes(s)) {
		return "Urban";
	}
	if (["rural", "r", "village", "gram", "gramin"].includes(s)) {
		return "Rural";
	}
	if (s === "urban") return "Urban";
	if (s === "rural") return "Rural";
	return null;
}

function compact(s) {
	return String(s || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
}

function matchByNameOrCode(items, raw, { nameKey = "name", codeKey = "code" } = {}) {
	const q = String(raw || "").trim();
	if (!q) return null;
	const cq = compact(q);
	const ql = q.toLowerCase();
	const exactCode = items.find((it) => {
		const code = String(it[codeKey] || "");
		if (code.toLowerCase() === ql) return true;
		const parts = code.split(",").map((p) => p.trim().toLowerCase());
		return parts.includes(ql);
	});
	if (exactCode) return exactCode;
	const exactName = items.find((it) => compact(it[nameKey]) === cq);
	if (exactName) return exactName;
	const exactBase = items.filter((it) => compact(it.baseName) === cq);
	if (exactBase.length === 1) return exactBase[0];
	const contains = items.filter(
		(it) =>
			compact(it[nameKey]).includes(cq) || compact(it.baseName).includes(cq),
	);
	if (contains.length === 1) return contains[0];
	return null;
}

function parseMoney(value) {
	if (value == null) return null;
	const s = String(value).trim();
	if (!s || /^n\/?a$/i.test(s) || s === "-" || s === "0") return null;
	const n = Number(s.replace(/,/g, ""));
	return Number.isFinite(n) && n > 0 ? n : null;
}

function useUnit(value) {
	const s = String(value || "").trim();
	return s && !/^n\/?a$/i.test(s) ? s : null;
}

function band(row, prefix) {
	return {
		baseRoadWidth: useUnit(row[`BaseRoadWidth${prefix}`]) || null,
		ft40to60: parseMoney(row[`${prefix}40_60Foot`]),
		ft61to99: parseMoney(row[`${prefix}61_99Foot`]),
		ft100Plus: parseMoney(row[`${prefix}Above100Foot`]),
	};
}

function landUseRates(row, prefix, extra = {}) {
	const exterior = parseMoney(row[`Exterior${prefix}`]);
	const interior = parseMoney(row[`Interior${prefix}`]);
	const unit = useUnit(row[`Unit${prefix}`]);
	const out = { exterior, interior, unit, ...extra };
	if (
		out.exterior == null &&
		out.interior == null &&
		!Object.values(extra).some((v) => v != null && v !== "")
	) {
		return null;
	}
	return out;
}

function normalizeRateRow(row, areaType) {
	const isRural = areaType === "Rural";
	const agricultural = isRural
		? landUseRates(row, "Agri", {
				irrigated: parseMoney(row.Irrigated),
				nonIrrigated: parseMoney(row.Non_Irrigated),
			})
		: landUseRates(row, "Agri");
	const residential = landUseRates(row, "Resi");
	const commercial = landUseRates(row, "Com");
	const industrial = landUseRates(row, "Ind");
	const institutional = landUseRates(row, "Ins");
	const mining = landUseRates(row, "Min");

	if (residential && !isRural) residential.roadWidth = band(row, "Resi");
	if (commercial && !isRural) commercial.roadWidth = band(row, "Com");

	const floorCandidates = [
		residential?.exterior,
		residential?.interior,
		commercial?.exterior,
		agricultural?.nonIrrigated,
		agricultural?.irrigated,
		agricultural?.exterior,
		industrial?.exterior,
	].filter((n) => typeof n === "number");

	return {
		district: row.district_name || null,
		sro: row.SroName || null,
		sroCode: row.srocode != null ? String(row.srocode) : null,
		zone: row.Zone || null,
		colony: row.Colony || null,
		village: row.Village || null,
		subdetails: row.Subdetails || null,
		locality: row.locality_name || null,
		khasraNo: row.khasra_no || null,
		fromHighway: row.FromHighway || null,
		isPeriphery: row.is_periphery || null,
		colonyCode: row.ColonyCode || null,
		floorRate: floorCandidates[0] ?? null,
		floorUnit:
			residential?.unit ||
			commercial?.unit ||
			agricultural?.unit ||
			null,
		rates: {
			residential,
			commercial,
			agricultural,
			industrial,
			institutional,
			mining,
		},
	};
}

function rowSearchText(row) {
	return compact(
		[
			row.colony,
			row.village,
			row.zone,
			row.sro,
			row.subdetails,
			row.locality,
			row.khasraNo,
		].join(" "),
	);
}

function compareToListed(rows, listedPrice, listedUnit) {
	const listed = Number(listedPrice);
	if (!Number.isFinite(listed) || listed <= 0) return null;
	const withFloor = rows.filter((r) => typeof r.floorRate === "number");
	if (!withFloor.length) return null;
	const sample = withFloor[0];
	const floor = sample.floorRate;
	const pct = ((listed - floor) / floor) * 100;
	return {
		listedPrice: listed,
		listedUnit: listedUnit || sample.floorUnit,
		comparedFloorRate: floor,
		comparedFloorUnit: sample.floorUnit,
		comparedAgainst: {
			colony: sample.colony,
			village: sample.village,
			zone: sample.zone,
			sro: sample.sro,
		},
		percentAboveDlc: Math.round(pct * 10) / 10,
		multipleOfDlc: Math.round((listed / floor) * 100) / 100,
		note:
			pct >= 0
				? `Listed ${Math.round(pct)}% above DLC (government floor).`
				: `Listed ${Math.abs(Math.round(pct))}% below DLC — unusual; verify the unit and plot.`,
	};
}

function nextField(missing) {
	return {
		status: "needs_selection",
		next: missing,
		...floorMeta(),
	};
}

function parseLimitOffset(body) {
	const limit = Math.min(
		MAX_LIMIT,
		Math.max(1, Number(body.limit) || DEFAULT_LIMIT),
	);
	const offset = Math.max(0, Number(body.offset) || 0);
	return { limit, offset };
}

function sliceOptions(items, limit = OPTIONS_CAP) {
	return {
		count: items.length,
		items: items.slice(0, limit),
		truncated: items.length > limit,
	};
}

async function scrapePortalFallback(c, reason) {
	const base = scrapeBaseUrl(c);
	const res = await fetch(`${base}/scrape`, {
		method: "POST",
		signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			url: RAJASTHAN_DLC_PORTAL_URL,
			timeout: 45000,
			includeSemanticContent: true,
			includeImages: false,
			includeLinks: true,
			extractMetadata: true,
		}),
	});
	const data = await res.json().catch(() => ({}));
	return {
		status: "scrape_fallback",
		success: data.success !== false && res.ok,
		reason,
		source: "scrape",
		...floorMeta(),
		scrape: {
			url: data.url || RAJASTHAN_DLC_PORTAL_URL,
			success: data.success !== false && res.ok,
			error: data.error || data.details || null,
			markdown: data.markdown || null,
			summary: data.summary || null,
		},
		hint: "Structured DLC tables come from the e-Panjiyan JSON API. Scrape fallback only captures the public portal page.",
	};
}

function readParams(c, body) {
	const q = {};
	try {
		const url = new URL(c.req.url);
		for (const [k, v] of url.searchParams.entries()) q[k] = v;
	} catch {
		/* ignore */
	}
	return { ...q, ...(body || {}) };
}

async function handleDlcRates(c) {
	const body = await c.req.json().catch(() => ({}));
	const params = readParams(c, body);
	const state = normalizeState(params.state || "rajasthan");
	const forceScrape =
		params.forceScrape === true || params.forceScrape === "true";
	const includeRaw =
		params.includeRaw === true || params.includeRaw === "true";
	const { limit, offset } = parseLimitOffset(params);

	if (!SUPPORTED_STATES[state]) {
		return c.json(
			{
				success: false,
				error: `State "${params.state || state}" is not wired yet. Rajasthan is live.`,
				code: "STATE_NOT_SUPPORTED",
				supportedStates: Object.values(SUPPORTED_STATES).map((s) => ({
					id: s.id,
					name: s.name,
				})),
				plannedStates: PLANNED_STATES,
			},
			501,
		);
	}

	if (forceScrape) {
		try {
			return c.json(await scrapePortalFallback(c, "forceScrape"));
		} catch (err) {
			return c.json(
				{
					success: false,
					error: err?.message || "Scrape fallback failed",
					code: "SCRAPE_FAILED",
					...floorMeta(),
				},
				502,
			);
		}
	}

	try {
		const districts = await getDistricts();
		const districtRaw =
			params.district || params.districtName || params.districtCode || "";
		if (!String(districtRaw).trim()) {
			return c.json({
				...nextField("district"),
				success: true,
				state,
				areaTypes: ["Urban", "Rural"],
				districts: sliceOptions(districts),
				message: "Select a Rajasthan district, then Urban or Rural.",
			});
		}

		const district = matchByNameOrCode(districts, districtRaw);
		if (!district) {
			const qn = compact(districtRaw);
			const suggestions = districts
				.filter((d) => compact(d.name).includes(qn) || d.code === String(districtRaw))
				.slice(0, 12);
			return c.json(
				{
					success: false,
					error: `Unknown district "${districtRaw}"`,
					code: "UNKNOWN_DISTRICT",
					suggestions,
					districts: sliceOptions(districts),
					...floorMeta(),
				},
				404,
			);
		}

		const areaType = normalizeAreaType(
			params.areaType || params.type || params.urbanRural || params.area,
		);
		if (!areaType) {
			return c.json({
				...nextField("areaType"),
				success: true,
				state,
				district,
				areaTypes: ["Urban", "Rural"],
				message:
					"Choose areaType: Urban (colony / zone) or Rural (village / RCA).",
			});
		}

		const sros = await getSros(district.code);
		const sroRaw = params.sro || params.sroName || params.sroCode || "";
		const colonyRaw = String(
			params.colony || params.village || params.colonyCode || "",
		).trim();

		let sro = matchByNameOrCode(sros, sroRaw);
		let colony = null;

		if (colonyRaw) {
			const colonies = await getColonies(district.code, areaType);
			colony = matchByNameOrCode(colonies, colonyRaw);
			if (!sro && colony?.sroCode) {
				sro =
					sros.find((item) => {
						const parts = String(item.code)
							.split(",")
							.map((p) => p.trim());
						return (
							item.code === colony.sroCode ||
							parts[0] === colony.sroCode ||
							parts.includes(colony.sroCode)
						);
					}) || { name: colony.name, code: colony.sroCode };
			}
		}

		if (!sro) {
			return c.json({
				...nextField("sro"),
				success: true,
				state,
				district,
				areaType,
				sros: sliceOptions(sros),
				message:
					areaType === "Urban"
						? "Select an SRO. Optionally pass colony to filter the rate table."
						: "Select an SRO. Optionally pass village/colony (RCA) to filter.",
			});
		}

		const colonyCode = colony?.code && colony.code !== "0" ? colony.code : "0";
		const rawRows = await getDlcRates({
			districtCode: district.code,
			sroCode: sro.code,
			areaType,
			colonyCode,
		});

		let rows = rawRows.map((row) => {
			const normalized = normalizeRateRow(row, areaType);
			if (includeRaw) normalized.raw = row;
			return normalized;
		});

		const filterQ = compact(
			params.filter || params.q || params.search || (colony ? "" : colonyRaw),
		);
		if (filterQ) {
			rows = rows.filter((row) => rowSearchText(row).includes(filterQ));
		}

		const total = rows.length;
		const page = rows.slice(offset, offset + limit);
		const listed = compareToListed(
			page,
			params.listedPrice ?? params.marketPrice,
			params.listedUnit,
		);

		return c.json({
			success: true,
			status: "ok",
			state,
			source: "rajasthan_epanjiyan_api",
			...floorMeta(),
			lookup: {
				district,
				areaType,
				sro,
				colony: colony
					? { name: colony.name, code: colony.code }
					: null,
				filter: filterQ || null,
			},
			rates: page,
			pagination: {
				total,
				offset,
				limit,
				hasMore: offset + page.length < total,
			},
			listedVsDlc: listed,
			message:
				total === 0
					? "No DLC rows for this selection."
					: `Government floor rates for ${district.name} / ${sro.name} (${areaType}).`,
		});
	} catch (err) {
		console.error("DLC rates error:", err);
		try {
			const fallback = await scrapePortalFallback(
				c,
				err?.message || "e-Panjiyan API failed",
			);
			return c.json(
				{
					...fallback,
					success: fallback.success,
					error: err?.message || "e-Panjiyan API failed",
					code: "EPANJIYAN_UNAVAILABLE",
				},
				fallback.success ? 200 : 502,
			);
		} catch (scrapeErr) {
			return c.json(
				{
					success: false,
					error: err?.message || "Failed to load DLC rates",
					scrapeError: scrapeErr?.message || null,
					code: "DLC_LOOKUP_FAILED",
					...floorMeta(),
				},
				502,
			);
		}
	}
}

dlcRatesRouter.post("/dlc-rates", handleDlcRates);
dlcRatesRouter.get("/dlc-rates", handleDlcRates);
