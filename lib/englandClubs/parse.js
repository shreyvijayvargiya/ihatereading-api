/**
 * Parse Soccer Wiki England clubs listing HTML / markdown.
 */

import { load } from "cheerio";
import { absoluteWikiUrl } from "./configs.js";

function clean(s) {
	return String(s || "")
		.replace(/\s+/g, " ")
		.trim();
}

function clubIdFromUrl(url) {
	const m = String(url || "").match(/[?&]clubid=(\d+)/i);
	return m ? m[1] : "";
}

function cellText($, el) {
	return clean($(el).text());
}

export function parseClubsFromHtml(html) {
	const $ = load(String(html || ""));
	const clubs = [];
	const seen = new Set();

	$("table tr").each((_, tr) => {
		const row = $(tr);
		const clubA = row.find('a[href*="squad.php"][href*="clubid="]').first();
		const href = clubA.attr("href") || "";
		const name = clean(clubA.text());
		if (!href || !name) return;
		const wikiUrl = absoluteWikiUrl(href);
		const clubId = clubIdFromUrl(wikiUrl);
		if (!clubId || seen.has(clubId)) return;
		seen.add(clubId);

		const managerA = row.find('a[href*="football-manager.php"]').first();
		const leagueA = row.find('a[href*="league.php"]').first();
		const stadiumA = row.find('a[href*="stadium.php"]').first();
		const tds = row.find("td").toArray();
		const texts = tds.map((td) => cellText($, td)).filter(Boolean);
		const foundedRaw = texts.find((t) => /^(18|19|20)\d{2}$/.test(t)) || "";
		const location =
			texts.find(
				(t) =>
					t !== name &&
					t !== clean(managerA.text()) &&
					t !== clean(leagueA.text()) &&
					t !== clean(stadiumA.text()) &&
					!/^(18|19|20)\d{2}$/.test(t) &&
					t.length > 2 &&
					t.length < 40,
			) || "";

		clubs.push({
			clubId,
			name,
			title: name,
			wikiUrl,
			manager: clean(managerA.text()),
			managerUrl: absoluteWikiUrl(managerA.attr("href")),
			league: clean(leagueA.text()),
			leagueUrl: absoluteWikiUrl(leagueA.attr("href")),
			stadium: clean(stadiumA.text()),
			stadiumUrl: absoluteWikiUrl(stadiumA.attr("href")),
			location,
			founded: foundedRaw ? Number(foundedRaw) : null,
		});
	});

	return clubs;
}

export function parseClubsFromMarkdown(markdown) {
	const lines = String(markdown || "").split("\n");
	const clubs = [];
	for (const line of lines) {
		if (!/\|/.test(line) || /^\|[\s-|]+\|$/.test(line.trim())) continue;
		const wikiMatch = line.match(/\[([^\]]+)\]\(([^)]*squad\.php\?[^)]*clubid=\d+[^)]*)\)/i);
		if (!wikiMatch) continue;
		const name = clean(wikiMatch[1]);
		const wikiUrl = absoluteWikiUrl(wikiMatch[2]);
		const clubId = clubIdFromUrl(wikiUrl);
		if (!name || !clubId) continue;

		const managerMatch = line.match(
			/\[([^\]]+)\]\(([^)]*football-manager\.php[^)]*)\)/i,
		);
		const leagueMatch = line.match(/\[([^\]]+)\]\(([^)]*league\.php[^)]*)\)/i);
		const stadiumMatch = line.match(/\[([^\]]+)\]\(([^)]*stadium\.php[^)]*)\)/i);
		const founded = line.match(/\b((?:18|19|20)\d{2})\b/);
		const cells = line
			.split("|")
			.map((c) => clean(c.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")))
			.filter(Boolean);

		const foundedIdx = cells.findIndex((c) => /^(18|19|20)\d{2}$/.test(c));
		clubs.push({
			clubId,
			name,
			title: name,
			wikiUrl,
			manager: managerMatch ? clean(managerMatch[1]) : cells[1] || "",
			managerUrl: managerMatch ? absoluteWikiUrl(managerMatch[2]) : "",
			league: leagueMatch ? clean(leagueMatch[1]) : cells[2] || "",
			leagueUrl: leagueMatch ? absoluteWikiUrl(leagueMatch[2]) : "",
			stadium: stadiumMatch ? clean(stadiumMatch[1]) : cells[3] || "",
			stadiumUrl: stadiumMatch ? absoluteWikiUrl(stadiumMatch[2]) : "",
			location: foundedIdx > 0 ? cells[foundedIdx - 1] : cells[4] || "",
			founded: founded ? Number(founded[1]) : null,
		});
	}
	return clubs;
}

export function parseClubsFromPlainTable(markdown) {
	const clubs = [];
	const seen = new Set();
	for (const line of String(markdown || "").split("\n")) {
		if (!/\|/.test(line) || /^\|[\s-|]+\|$/.test(line.trim())) continue;
		if (/^\|\s*\|?\s*Club\s*\|/i.test(line)) continue;
		const cells = line
			.split("|")
			.map((c) => c.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim())
			.filter((c) => c && c !== "---");
		if (cells.length < 5) continue;
		const foundedIdx = cells.findIndex((c) => /^(18|19|20)\d{2}$/.test(c));
		if (foundedIdx < 4) continue;
		const name = cells[0];
		if (!name || /^(club|manager|league)$/i.test(name) || seen.has(name.toLowerCase())) {
			continue;
		}
		seen.add(name.toLowerCase());
		clubs.push({
			clubId: "",
			name,
			title: name,
			wikiUrl: "",
			manager: cells[1] || "",
			managerUrl: "",
			league: cells[2] || "",
			leagueUrl: "",
			stadium: cells[3] || "",
			stadiumUrl: "",
			location: foundedIdx > 0 ? cells[foundedIdx - 1] : cells[4] || "",
			founded: Number(cells[foundedIdx]),
		});
	}
	return clubs;
}

export function parseClubsPage(scrape = {}) {
	const html = String(
		scrape.html || scrape.data?.html || scrape.content?.html || "",
	);
	const markdown = String(scrape.markdown || scrape.data?.markdown || "");
	let clubs = parseClubsFromHtml(html);
	if (!clubs.length) clubs = parseClubsFromMarkdown(markdown);
	if (!clubs.length) clubs = parseClubsFromPlainTable(markdown);
	return clubs;
}
