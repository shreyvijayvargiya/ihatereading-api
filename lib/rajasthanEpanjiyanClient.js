/**
 * Rajasthan e-Panjiyan DLC (circle-rate) client.
 *
 * Talks to the same public citizen API the official portal uses:
 *   https://epanjiyan.rajasthan.gov.in/#/public/dlcrate
 *   POST https://mobileepanjiyan.rajasthan.gov.in/EpanjiyanAPI/api/DLCRate/*
 *
 * The portal encrypts JSON with AES-CBC using a key published in its
 * frontend bundle (`config.ds`). We replay that public client protocol.
 */

import crypto from "node:crypto";

export const RAJASTHAN_DLC_PORTAL_URL =
	"https://epanjiyan.rajasthan.gov.in/#/public/dlcrate";
export const RAJASTHAN_DLC_API_BASE =
	"https://mobileepanjiyan.rajasthan.gov.in/EpanjiyanAPI/api/";
export const RAJASTHAN_DLC_ORIGIN = "https://epanjiyan.rajasthan.gov.in";

/** Base64 `config.ds` from the public Angular bundle (citizen lookup). */
const DEFAULT_DS = "ZVBhbmppeWFuUEBzcw==";

function passphrase() {
	const ds = (
		process.env.RAJASTHAN_EPANJIYAN_DS || DEFAULT_DS
	).trim();
	return Buffer.from(ds, "base64").toString("utf8");
}

function aesKeyLatin1() {
	return crypto
		.createHash("sha256")
		.update(passphrase(), "utf8")
		.digest("hex")
		.substring(0, 16);
}

export function encryptEpanjiyanPayload(obj) {
	const key = Buffer.from(aesKeyLatin1(), "latin1");
	const ivStr = crypto.randomBytes(8).toString("hex");
	const iv = Buffer.from(ivStr, "latin1");
	const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
	const pt = JSON.stringify(obj ?? {});
	const encrypted = Buffer.concat([
		cipher.update(pt, "utf8"),
		cipher.final(),
	]).toString("base64");
	return { encrypted, IV: ivStr };
}

export function decryptEpanjiyanPayload(encrypted, ivStr) {
	if (!encrypted || !ivStr) {
		throw new Error("Missing encrypted payload from e-Panjiyan");
	}
	const key = Buffer.from(aesKeyLatin1(), "latin1");
	const iv = Buffer.from(String(ivStr), "latin1");
	const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
	const pt = Buffer.concat([
		decipher.update(Buffer.from(encrypted, "base64")),
		decipher.final(),
	]).toString("utf8");
	try {
		return JSON.parse(pt);
	} catch {
		return pt;
	}
}

async function postDlc(path, payload, { timeoutMs = 25_000 } = {}) {
	const url = `${RAJASTHAN_DLC_API_BASE}${path.replace(/^\//, "")}`;
	const res = await fetch(url, {
		method: "POST",
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			"User-Agent":
				"Mozilla/5.0 (compatible; ihatereading-api/dlc-rates; +https://epanjiyan.rajasthan.gov.in)",
			"Content-Type": "application/json",
			Accept: "application/json, text/plain, */*",
			Origin: RAJASTHAN_DLC_ORIGIN,
			Referer: `${RAJASTHAN_DLC_ORIGIN}/`,
			Authorization: "Bearer null",
			"X-Nonce": "",
			"X-Timestamp": new Date().toISOString(),
			"X-Request-Id": "",
			"X-Requested-With": "XMLHttpRequest",
		},
		body: JSON.stringify(encryptEpanjiyanPayload(payload ?? {})),
	});
	const raw = await res.text();
	let json;
	try {
		json = JSON.parse(raw);
	} catch {
		throw new Error(
			`e-Panjiyan ${path} returned non-JSON HTTP ${res.status}`,
		);
	}
	if (!res.ok && !json.encrypted) {
		throw new Error(
			json.title || json.message || `e-Panjiyan ${path} HTTP ${res.status}`,
		);
	}
	const decrypted = decryptEpanjiyanPayload(
		json.encrypted || json.Encrypted,
		json.iv || json.IV,
	);
	if (!decrypted || typeof decrypted !== "object") {
		throw new Error(`e-Panjiyan ${path} decrypt failed`);
	}
	if (Number(decrypted.status) !== 1) {
		const err = new Error(
			decrypted.message || `e-Panjiyan ${path} status ${decrypted.status}`,
		);
		err.code = "EPANJIYAN_STATUS";
		err.payload = decrypted;
		throw err;
	}
	return decrypted.dynamic;
}

export async function getDistricts() {
	const rows = await postDlc("DLCRate/GetDistrict", {});
	return (Array.isArray(rows) ? rows : []).map((row) => ({
		name: String(row.text || row.district || "").trim(),
		code: String(row.value || row.districtCode || "").trim(),
	}));
}

export async function getSros(districtCode) {
	const rows = await postDlc("DLCRate/GetSRO", {
		districtCode: String(districtCode),
	});
	return (Array.isArray(rows) ? rows : [])
		.map((row) => ({
			name: String(row.SRO || row.sro || row.text || "").trim(),
			code: String(row.SROCode || row.srocode || row.value || "").trim(),
		}))
		.filter((row) => row.name && row.code);
}

export async function getColonies(districtCode, areaType) {
	const rows = await postDlc("DLCRate/GetColony", {
		districtCode: String(districtCode),
		type: areaType,
	});
	return (Array.isArray(rows) ? rows : []).map((row) => {
		const name = String(row.text || row.Colony || "").trim();
		const code = String(row.value || row.ColonyCode || "").trim();
		const [colonyCode, sroCode] = code.split(",").map((p) => p.trim());
		return {
			name,
			baseName: name.replace(/\s*-\s*\([^)]+\)\s*$/, "").trim() || name,
			code,
			colonyCode: colonyCode || code,
			sroCode: sroCode || null,
		};
	});
}

export async function getDlcRates({
	districtCode,
	sroCode,
	areaType,
	colonyCode = "0",
}) {
	const path =
		colonyCode && colonyCode !== "0"
			? "DLCRate/GetColonyDLCRate"
			: "DLCRate/GetDLCRate";
	const rows = await postDlc(path, {
		districtCode: String(districtCode),
		srocode: String(sroCode),
		type: areaType,
		colonycode: String(colonyCode || "0"),
	});
	return Array.isArray(rows) ? rows : [];
}
