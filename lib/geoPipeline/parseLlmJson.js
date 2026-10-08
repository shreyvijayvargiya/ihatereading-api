/**
 * Parse JSON from OpenRouter responses (handles ```json fences and prose wrappers).
 */

function stripTrailingCommas(s) {
	return s.replace(/,\s*([\]}])/g, "$1");
}

/** Salvage string values from `"queries": [ "a", "b" ...` even when JSON is truncated. */
function salvageStringArray(s, key) {
	const match = s.match(new RegExp(`"${key}"\\s*:\\s*\\[`, "i"));
	if (!match) return null;

	const start = match.index + match[0].length;
	const strings = [];
	let i = start;

	while (i < s.length) {
		while (i < s.length && /[\s,]/.test(s[i])) i++;
		if (s[i] === "]") break;
		if (s[i] !== '"') {
			i++;
			continue;
		}
		i++;
		let buf = "";
		let escape = false;
		while (i < s.length) {
			const ch = s[i];
			if (escape) {
				buf += ch;
				escape = false;
				i++;
				continue;
			}
			if (ch === "\\") {
				escape = true;
				i++;
				continue;
			}
			if (ch === '"') {
				i++;
				if (buf.trim()) strings.push(buf.trim());
				break;
			}
			buf += ch;
			i++;
		}
	}

	return strings.length ? { [key]: strings } : null;
}

/** Salvage complete objects from a truncated `"topics"|"results": [ ...` array. */
function salvageObjectArray(s, key = "results") {
	const match = s.match(new RegExp(`"${key}"\\s*:\\s*\\[`, "i"));
	if (!match) return null;

	const start = match.index + match[0].length;
	const objects = [];
	let depth = 0;
	let objStart = -1;
	let inString = false;
	let escape = false;

	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (inString) {
			if (escape) escape = false;
			else if (ch === "\\") escape = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) objStart = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && objStart >= 0) {
				try {
					objects.push(JSON.parse(s.slice(objStart, i + 1)));
				} catch {
					/* skip malformed object */
				}
				objStart = -1;
			}
		}
	}

	return objects.length ? { [key]: objects } : null;
}

function tryParseJson(s) {
	try {
		return JSON.parse(s);
	} catch (err) {
		const fixed = stripTrailingCommas(s);
		if (fixed !== s) {
			try {
				return JSON.parse(fixed);
			} catch {
				/* fall through */
			}
		}
		const salvaged =
			salvageObjectArray(s, "results") ||
			salvageObjectArray(s, "topics") ||
			salvageStringArray(s, "queries");
		if (salvaged) return salvaged;
		throw err;
	}
}

/** Strip provider safety / prose prefixes before JSON parse. */
export function stripLlmProviderNoise(text) {
	return String(text || "")
		.replace(/^(User\s+Safety|Safety|Moderation)[^\n]*\n?/gim, "")
		.replace(/^Here(?:'s| is)[^\n{]*\n+/gim, "")
		.trim();
}

export function parseJsonFromLLM(text) {
	let s = stripLlmProviderNoise(text);
	if (!s) throw new Error("Empty LLM content");

	const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fence) s = fence[1].trim();

	const objFirst = s.indexOf("{");
	const objLast = s.lastIndexOf("}");
	const arrFirst = s.indexOf("[");
	const arrLast = s.lastIndexOf("]");

	if (objFirst !== -1 && objLast > objFirst) {
		if (arrFirst !== -1 && arrFirst < objFirst && arrLast > arrFirst) {
			s = s.slice(arrFirst, arrLast + 1);
		} else {
			s = s.slice(objFirst, objLast + 1);
		}
	} else if (arrFirst !== -1 && arrLast > arrFirst) {
		s = s.slice(arrFirst, arrLast + 1);
	}

	return tryParseJson(s);
}
