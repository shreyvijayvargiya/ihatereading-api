/**
 * Parse CRM product names out of Wikipedia comparison tables.
 */

export function parseWikiCrmNames(html) {
	const names = [];
	const seen = new Set();
	const tables = String(html || "").match(/<table[^>]*wikitable[\s\S]*?<\/table>/gi) || [];
	for (const table of tables) {
		const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
		for (const row of rows.slice(1)) {
			const td = row.match(/<td[\s\S]*?<\/td>/i);
			if (!td) continue;
			let text = td[0]
				.replace(/<[^>]+>/g, " ")
				.replace(/\[[^\]]*\]/g, " ")
				.replace(/&amp;/g, "&")
				.replace(/&nbsp;/g, " ");
			text = text.replace(/\s+/g, " ").trim();
			if (!text || text.length > 80) continue;
			for (const part of text.split(/\s*\/\s*/)) {
				const n = part.trim();
				const k = n.toLowerCase();
				if (n.length < 2 || seen.has(k)) continue;
				seen.add(k);
				names.push(n);
			}
		}
	}
	return names;
}
