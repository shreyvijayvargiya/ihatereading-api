/**
 * Parse Soccer Wiki England clubs listing HTML / markdown.
 * Table columns: logo | Club | Manager | League | Stadium | Location | Founded
 * Lower-tier rows often have empty manager/league — keep column positions.
 */

import { load } from "cheerio";
import { absoluteWikiUrl } from "./configs.js";

function clean(s) {
	return String(s || "")
		.replace(/\s+/g, " ")
		.trim();
}

export function clubIdFromUrl(url) {
	const m = String(url || "").match(/[?&]clubid=(\d+)/i);
	return m ? m[1] : "";
}

function namedSquadLink($, root) {
	const nodes = root.find('a[href*="squad.php"]').toArray();
	for (const el of nodes) {
		const href = $(el).attr("href") || "";
		if (!/clubid=/i.test(href)) continue;
		const name = clean($(el).text());
		if (name) return { href, name };
	}
	return { href: "", name: "" };
}

function cellLink($, td, needle) {
	const a = $(td).find(`a[href*="${needle}"]`).first();
	const text = clean(a.text());
	if (!text) return { text: "", href: "" };
	return { text, href: a.attr("href") || "" };
}

function clubRecord({
	clubId,
	name,
	wikiUrl,
	manager = "",
	managerUrl = "",
	league = "",
	leagueUrl = "",
	stadium = "",
	stadiumUrl = "",
	location = "",
	founded = null,
}) {
	return {
		clubId,
		name,
		title: name,
		wikiUrl,
		manager,
		managerUrl: managerUrl ? absoluteWikiUrl(managerUrl) : "",
		league,
		leagueUrl: leagueUrl ? absoluteWikiUrl(leagueUrl) : "",
		stadium,
		stadiumUrl: stadiumUrl ? absoluteWikiUrl(stadiumUrl) : "",
		location,
		founded: founded ? Number(founded) : null,
	};
}

export function parseClubsFromHtml(html) {
	const $ = load(String(html || ""));
	const clubs = [];
	const seen = new Set();

	$("table tr").each((_, tr) => {
		const row = $(tr);
		const tds = row.find("td");
		if (tds.length < 5) return;

		const named = namedSquadLink($, row);
		const href = named.href;
		const name = named.name;
		if (!href || !name) return;
		const wikiUrl = absoluteWikiUrl(href);
		const clubId = clubIdFromUrl(wikiUrl);
		if (!clubId || seen.has(clubId)) return;
		seen.add(clubId);

		const clubCol = tds.length >= 7 ? 1 : 0;
		const manager = cellLink($, tds.eq(clubCol + 1), "football-manager.php");
		const league = cellLink($, tds.eq(clubCol + 2), "league.php");
		const stadium = cellLink($, tds.eq(clubCol + 3), "stadium.php");
		const location = clean(tds.eq(clubCol + 4).text());
		const foundedRaw = clean(tds.eq(clubCol + 5).text());
		const founded = /^(18|19|20)\d{2}$/.test(foundedRaw)
			? Number(foundedRaw)
			: null;

		clubs.push(
			clubRecord({
				clubId,
				name,
				wikiUrl,
				manager: manager.text,
				managerUrl: manager.href,
				league: league.text,
				leagueUrl: league.href,
				stadium: stadium.text,
				stadiumUrl: stadium.href,
				location,
				founded,
			}),
		);
	});

	return clubs;
}

function markdownCells(line) {
	return line
		.split("|")
		.map((c) => clean(c.replace(/\[([^\]]*)\]\([^)]+\)/g, "$1").replace(/!/g, "")))
		.filter((c) => c !== "---");
}

export function parseClubsFromMarkdown(markdown) {
	const clubs = [];
	const seen = new Set();
	for (const line of String(markdown || "").split("\n")) {
		if (!/\|/.test(line) || /^\|[\s-|]+\|$/.test(line.trim())) continue;
		const wikiMatch = line.match(
			/\[([^\]]+)\]\(([^)]*squad\.php\?[^)]*clubid=\d+[^)]*)\)/i,
		);
		if (!wikiMatch) continue;
		const name = clean(wikiMatch[1].replace(/^!/, ""));
		if (!name || /^club$/i.test(name)) continue;
		const wikiUrl = absoluteWikiUrl(wikiMatch[2]);
		const clubId = clubIdFromUrl(wikiUrl);
		if (!clubId || seen.has(clubId)) continue;
		seen.add(clubId);

		const managerMatch = line.match(
			/\[([^\]]+)\]\(([^)]*football-manager\.php[^)]*)\)/i,
		);
		const leagueMatch = line.match(
			/\[([^\]]+)\]\(([^)]*league\.php\?[^)]*leagueid=(?!0\b)[^)]*)\)/i,
		);
		const stadiumMatch = line.match(/\[([^\]]+)\]\(([^)]*stadium\.php[^)]*)\)/i);
		const cells = markdownCells(line).filter(Boolean);
		const foundedIdx = cells.findIndex((c) => /^(18|19|20)\d{2}$/.test(c));
		const founded = foundedIdx >= 0 ? Number(cells[foundedIdx]) : null;

		clubs.push(
			clubRecord({
				clubId,
				name,
				wikiUrl,
				manager: managerMatch ? clean(managerMatch[1]) : "",
				managerUrl: managerMatch ? managerMatch[2] : "",
				league: leagueMatch ? clean(leagueMatch[1]) : "",
				leagueUrl: leagueMatch ? leagueMatch[2] : "",
				stadium: stadiumMatch ? clean(stadiumMatch[1]) : "",
				stadiumUrl: stadiumMatch ? stadiumMatch[2] : "",
				location: foundedIdx > 0 ? cells[foundedIdx - 1] : "",
				founded,
			}),
		);
	}
	return clubs;
}

export function parseClubsFromPlainTable(markdown) {
	const clubs = [];
	const seen = new Set();
	for (const line of String(markdown || "").split("\n")) {
		if (!/\|/.test(line) || /^\|[\s-|]+\|$/.test(line.trim())) continue;
		if (/Club\s*\|\s*Manager\s*\|\s*League/i.test(line)) continue;
		const cells = markdownCells(line);
		while (cells.length && !cells[0]) cells.shift();
		while (cells.length && !cells[cells.length - 1]) cells.pop();
		const foundedIdx = cells.findIndex((c) => /^(18|19|20)\d{2}$/.test(c));
		if (foundedIdx < 1) continue;
		const name = cells[0];
		if (!name || /^(club|manager|league|stadium)$/i.test(name)) continue;
		if (seen.has(name.toLowerCase())) continue;
		seen.add(name.toLowerCase());
		const beforeYear = cells.slice(1, foundedIdx);
		const location = beforeYear[beforeYear.length - 1] || "";
		const stadium = beforeYear[beforeYear.length - 2] || "";
		const league = beforeYear.length >= 3 ? beforeYear[beforeYear.length - 3] : "";
		const manager = beforeYear.length >= 4 ? beforeYear[0] : "";
		clubs.push(
			clubRecord({
				clubId: "",
				name,
				wikiUrl: "",
				manager,
				league,
				stadium,
				location,
				founded: Number(cells[foundedIdx]),
			}),
		);
	}
	return clubs;
}

export function parseClubsFromLinks(links = []) {
	const clubs = [];
	const seen = new Set();
	for (const l of links || []) {
		const href = typeof l === "string" ? l : l.href || l.url || l.link || "";
		const text = typeof l === "string" ? "" : clean(l.text || l.title || "");
		if (!/squad\.php/i.test(href) || !/clubid=/i.test(href) || !text) continue;
		if (/^club$/i.test(text)) continue;
		const wikiUrl = absoluteWikiUrl(href);
		const clubId = clubIdFromUrl(wikiUrl);
		if (!clubId || seen.has(clubId)) continue;
		seen.add(clubId);
		clubs.push(
			clubRecord({
				clubId,
				name: text,
				wikiUrl,
			}),
		);
	}
	return clubs;
}

function mergeClubs(...lists) {
	const byId = new Map();
	const byName = [];
	for (const list of lists) {
		for (const club of list || []) {
			if (club.clubId) {
				const prev = byId.get(club.clubId) || {};
				byId.set(club.clubId, {
					...prev,
					...Object.fromEntries(
						Object.entries(club).filter(([, v]) => v !== "" && v != null),
					),
					clubId: club.clubId,
				});
			} else if (club.name) {
				byName.push(club);
			}
		}
	}
	const named = new Set([...byId.values()].map((c) => c.name.toLowerCase()));
	for (const club of byName) {
		if (!named.has(club.name.toLowerCase())) {
			byId.set(`name:${club.name.toLowerCase()}`, club);
			named.add(club.name.toLowerCase());
		}
	}
	return [...byId.values()];
}

export function parseClubsPage(scrape = {}) {
	const html = String(
		scrape.html || scrape.data?.html || scrape.content?.html || "",
	);
	const markdown = String(scrape.markdown || scrape.data?.markdown || "");
	const links = scrape.links || scrape.data?.links || [];
	return mergeClubs(
		parseClubsFromHtml(html),
		parseClubsFromMarkdown(markdown),
		parseClubsFromLinks(links),
		parseClubsFromPlainTable(markdown),
	);
}
