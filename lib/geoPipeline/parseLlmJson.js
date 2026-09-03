/**
 * Parse JSON from OpenRouter responses (handles ```json fences and prose wrappers).
 */

export function parseJsonFromLLM(text) {
	let s = String(text || "").trim();
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

	return JSON.parse(s);
}
