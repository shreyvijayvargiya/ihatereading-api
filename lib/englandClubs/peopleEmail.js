/**
 * Find public emails for club commercial staff via Google / LinkedIn / X SERP.
 * Never invents addresses — only emails that appear in search snippets or scraped pages.
 *
 * Roles: Head of Ticketing (HT), CMO, Marketing Head, other employees.
 */

import { clubGoogleSearch } from "./webSearch.js";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export const STAFF_ROLES = [
	{
		id: "ht",
		label: "Head of Ticketing",
		re: /\b(head of ticketing|ticketing (?:manager|director|head)|tickets? (?:manager|director)|box office manager|\bht\b)/i,
	},
	{
		id: "cmo",
		label: "CMO",
		re: /\b(cmo|chief marketing officer)\b/i,
	},
	{
		id: "marketingHead",
		label: "Marketing Head",
		re: /\b(head of marketing|marketing (?:director|manager|head|lead)|commercial (?:director|manager)|head of commercial)\b/i,
	},
	{
		id: "staff",
		label: "Employee",
		re: /\b(media (?:manager|officer)|press officer|communications (?:manager|director)|partnerships? (?:manager|director)|sales (?:manager|director)|staff|employee|coordinator|executive)\b/i,
	},
];

function unique(arr) {
	return [...new Set((arr || []).map((s) => String(s).trim()).filter(Boolean))];
}

function isJunkEmail(email) {
	return /noreply|no-reply|donotreply|sentry|wixpress|example\.com|privacy@|webmaster@|webpack|github\.|cloudflare|schema\.org|w3\.org|googleapis/i.test(
		email,
	);
}

function emailsFromText(text) {
	return unique(
		(String(text || "").match(EMAIL_RE) || [])
			.map((e) => e.toLowerCase())
			.filter((e) => !isJunkEmail(e)),
	);
}

export function classifyStaffRole(text) {
	const blob = String(text || "");
	for (const role of STAFF_ROLES) {
		if (role.re.test(blob)) return { id: role.id, label: role.label };
	}
	return { id: "", label: "" };
}

export function platformFromUrl(url) {
	const u = String(url || "").toLowerCase();
	if (/linkedin\.com/.test(u)) return "linkedin";
	if (/(?:twitter\.com|x\.com)\//.test(u)) return "x";
	return "google";
}

/**
 * A few targeted queries — Google, LinkedIn SERP, X SERP.
 * @param {string} name
 * @param {{ host?: string, location?: string }} [opts]
 */
export function peopleEmailQueries(name, opts = {}) {
	const club = String(name || "").trim();
	if (!club) return [];
	const host = String(opts.host || "")
		.replace(/^www\./, "")
		.toLowerCase();
	const loc = opts.location ? ` ${opts.location}` : "";
	const q = [
		`${club} "Head of Ticketing" OR HT email contact${loc}`,
		`${club} FC (CMO OR "chief marketing officer") email`,
		`${club} ("Head of Marketing" OR "Marketing Head" OR "Marketing Director") email`,
		`site:linkedin.com "${club}" ("Head of Marketing" OR CMO OR "Head of Ticketing" OR "Marketing Manager")`,
		`site:x.com OR site:twitter.com "${club}" (marketing OR ticketing OR CMO) (email OR contact)`,
	];
	if (host) {
		q.push(`"${host}" (marketing@ OR tickets@ OR ticketing@ OR commercial@ OR press@ OR media@)`);
	}
	return q;
}

function personNameFromLinkedInTitle(title) {
	const t = String(title || "")
		.replace(/\s*[\-|–]\s*LinkedIn.*$/i, "")
		.split(/\s[-–|]\s|\sat\s/i)[0]
		.replace(/\s*\(.*\)\s*$/, "")
		.trim();
	if (!t || t.length > 60) return "";
	if (!/^[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,3}$/.test(t)) return "";
	return t;
}

function personFromRow(row) {
	const title = String(row.title || "").replace(/\s+/g, " ");
	const snippet = String(row.snippet || row.description || "").replace(/\s+/g, " ");
	const url = String(row.url || row.link || "");
	const blob = `${title} ${snippet}`;
	const roleHit = classifyStaffRole(blob);
	let name = "";
	if (platformFromUrl(url) === "linkedin") name = personNameFromLinkedInTitle(title);
	if (!name) {
		name =
			blob.match(
				/\b([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,2})\b(?:\s*[-–,|]|,\s*)(?=head|director|manager|cmo|officer|marketing|ticketing|commercial)/i,
			)?.[1] || "";
	}
	const emails = emailsFromText(blob);
	if (!name && !roleHit.id && !emails.length) return null;
	return {
		name,
		role: roleHit.label || "",
		roleId: roleHit.id || (emails.length ? "staff" : ""),
		email: emails[0] || "",
		emails,
		source: url,
		platform: platformFromUrl(url),
		query: row.query || "",
	};
}

export function harvestPeopleFromResults(results) {
	const people = [];
	const emails = [];
	for (const row of results || []) {
		const blob = `${row.title || ""} ${row.snippet || row.description || ""} ${row.url || row.link || ""}`;
		for (const email of emailsFromText(blob)) emails.push(email);
		const person = personFromRow(row);
		if (!person) continue;
		const dup = people.find(
			(p) =>
				(p.email && person.email && p.email === person.email) ||
				(p.name && person.name && p.name.toLowerCase() === person.name.toLowerCase()),
		);
		if (dup) {
			if (!dup.email && person.email) dup.email = person.email;
			if (!dup.role && person.role) {
				dup.role = person.role;
				dup.roleId = person.roleId;
			}
			dup.emails = unique([...(dup.emails || []), ...(person.emails || [])]);
			continue;
		}
		people.push(person);
	}
	return { people, emails: unique(emails) };
}

async function searchQuery(query, opts = {}) {
	try {
		const rows = await clubGoogleSearch(query, {
			baseUrl: opts.baseUrl,
			num: 8,
		});
		return (rows || []).map((r) => ({ ...r, query }));
	} catch {
		return [];
	}
}

/**
 * Run the people-email queries, then 1–2 follow-ups for named LinkedIn/X people without an email.
 */
export async function searchClubPeopleEmails(clubName, opts = {}) {
	const queries = peopleEmailQueries(clubName, {
		host: opts.host,
		location: opts.location,
	});
	const settled = await Promise.all(queries.map((q) => searchQuery(q, opts)));
	const results = settled.flat();
	const harvested = harvestPeopleFromResults(results);

	const nameless = harvested.people.filter((p) => p.name && !p.email).slice(0, 2);
	const followUps = [];
	for (const p of nameless) {
		const q = `"${p.name}" "${clubName}" (email OR contact) (marketing OR ticketing OR CMO)`;
		followUps.push(searchQuery(q, opts));
	}
	const extra = (await Promise.all(followUps)).flat();
	const more = harvestPeopleFromResults(extra);

	const people = harvested.people;
	for (const p of more.people) {
		const dup = people.find(
			(x) =>
				x.name &&
				p.name &&
				x.name.toLowerCase() === p.name.toLowerCase(),
		);
		if (dup) {
			if (!dup.email && p.email) dup.email = p.email;
			dup.emails = unique([...(dup.emails || []), ...(p.emails || [])]);
		} else {
			people.push(p);
		}
	}

	const byRole = {
		ht: people.find((p) => p.roleId === "ht" && p.email) || people.find((p) => p.roleId === "ht") || null,
		cmo: people.find((p) => p.roleId === "cmo" && p.email) || people.find((p) => p.roleId === "cmo") || null,
		marketingHead:
			people.find((p) => p.roleId === "marketingHead" && p.email) ||
			people.find((p) => p.roleId === "marketingHead") ||
			null,
		staff: people.filter((p) => p.roleId === "staff" || (!p.roleId && p.email)).slice(0, 6),
	};

	const outreach =
		[byRole.ht, byRole.cmo, byRole.marketingHead, ...byRole.staff].find((p) => p?.email) ||
		null;

	return {
		queries: [...queries, ...nameless.map((p) => `"${p.name}" "${clubName}" email`)],
		results: [...results, ...extra],
		people,
		emails: unique([...harvested.emails, ...more.emails]),
		byRole,
		outreachEmail: outreach?.email || "",
		outreachName: outreach?.name || "",
		outreachRole: outreach?.role || "",
	};
}

export function mergeClubPeople(existing, incoming) {
	const people = [...(existing || [])];
	for (const p of incoming || []) {
		if (!p?.name && !p?.email) continue;
		const dup = people.find(
			(x) =>
				(x.email && p.email && x.email === p.email) ||
				(x.name && p.name && String(x.name).toLowerCase() === String(p.name).toLowerCase()),
		);
		if (dup) {
			if (!dup.email && p.email) dup.email = p.email;
			if (!dup.role && p.role) dup.role = p.role;
			dup.emails = unique([...(dup.emails || []), ...(p.emails || [])]);
			continue;
		}
		people.push(p);
	}
	return people.slice(0, 12);
}
