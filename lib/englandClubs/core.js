/**
 * England clubs — Firestore + optional Google / URL enrich (no LLM).
 */

import { FieldValue } from "firebase-admin/firestore";
import { firestore } from "../../config/firebase.js";
import { googleSearch } from "../contentResearch/http.js";
import { storeHashed } from "../hashedStore.js";
import { scrapeUrl } from "../scrapefast.js";
import {
	CLUBS_COLLECTION,
	CLUBS_STATE_COLLECTION,
	COUNTRY_ID,
	COUNTRY_NAME,
	ENGLAND_CLUBS_AGENT,
} from "./configs.js";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const JUNK_SITE =
	/soccerwiki|wikipedia|transfermarkt|sofascore|flashscore|skysports|bbc\.com|goal\.com|premierleague\.com|uefa\.com|fifa\.com|espn\.|fotmob|whoscored|90min|theathletic|reddit\.com|facebook\.com\/watch/i;

export function clubIdentity(club) {
	return [`eng`, club.clubId || club.wikiUrl || club.name];
}

export async function saveClub(club, { mode = "once" } = {}) {
	const identity = clubIdentity(club);
	return storeHashed(
		CLUBS_COLLECTION,
		identity,
		{
			...club,
			country: COUNTRY_NAME,
			countryId: COUNTRY_ID,
			fetchedAt: club.fetchedAt || new Date().toISOString(),
		},
		{ mode },
	);
}

export async function loadCursor() {
	const snap = await firestore
		.collection(CLUBS_STATE_COLLECTION)
		.doc(ENGLAND_CLUBS_AGENT.id)
		.get();
	const d = snap.data() || {};
	return {
		offset: Number(d.offset) || 0,
		done: Boolean(d.done),
		listed: Number(d.listed) || 0,
		pass: Number(d.pass) || 0,
	};
}

export async function saveCursor(patch) {
	await firestore
		.collection(CLUBS_STATE_COLLECTION)
		.doc(ENGLAND_CLUBS_AGENT.id)
		.set(
			{
				agentId: ENGLAND_CLUBS_AGENT.id,
				offset: patch.offset ?? 0,
				done: Boolean(patch.done),
				listed: Number(patch.listed) || 0,
				pass: Number(patch.pass) || 0,
				updatedAt: FieldValue.serverTimestamp(),
			},
			{ merge: true },
		);
}

export async function countClubs() {
	const snap = await firestore.collection(CLUBS_COLLECTION).count().get();
	return snap.data().count || 0;
}

export async function listClubs({ limit = 50 } = {}) {
	const snap = await firestore
		.collection(CLUBS_COLLECTION)
		.orderBy("fetchedAt", "desc")
		.limit(Math.min(200, Number(limit) || 50))
		.get()
		.catch(async () =>
			firestore.collection(CLUBS_COLLECTION).limit(Math.min(200, Number(limit) || 50)).get(),
		);
	return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function unique(arr) {
	return [...new Set((arr || []).map((s) => String(s).trim()).filter(Boolean))];
}

function hostOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

function pickOfficialUrl(results, clubName) {
	const needle = String(clubName || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
	for (const r of results || []) {
		const url = r.url || r.link || "";
		if (!url || JUNK_SITE.test(url)) continue;
		const host = hostOf(url);
		if (!host) continue;
		const compact = host.replace(/[^a-z0-9]+/g, "");
		if (needle && (compact.includes(needle.slice(0, 8)) || needle.includes(compact.slice(0, 8)))) {
			return url;
		}
	}
	for (const r of results || []) {
		const url = r.url || r.link || "";
		if (url && !JUNK_SITE.test(url)) return url;
	}
	return "";
}

function extractContacts(page, pageUrl) {
	const blob = [
		page.markdown,
		page.html,
		JSON.stringify(page.links || []),
	].join("\n");
	const emails = unique((blob.match(EMAIL_RE) || []).filter((e) => !/example\.com|sentry|wixpress/i.test(e)));
	const links = [];
	for (const l of page.links || []) {
		const href = typeof l === "string" ? l : l.href || l.url || l.link;
		if (href) links.push(href);
	}
	const urlRe =
		/https?:\/\/[^\s"'<>]+/gi;
	links.push(...(blob.match(urlRe) || []));
	const socials = { twitter: "", instagram: "", facebook: "", linkedin: "", youtube: "", tiktok: "" };
	for (const href of links) {
		const u = String(href);
		if (/twitter\.com\/|x\.com\//i.test(u) && !socials.twitter) socials.twitter = u.split("?")[0];
		else if (/instagram\.com\//i.test(u) && !socials.instagram) socials.instagram = u.split("?")[0];
		else if (/facebook\.com\//i.test(u) && !socials.facebook) socials.facebook = u.split("?")[0];
		else if (/linkedin\.com\//i.test(u) && !socials.linkedin) socials.linkedin = u.split("?")[0];
		else if (/youtube\.com\/|youtu\.be\//i.test(u) && !socials.youtube) socials.youtube = u.split("?")[0];
		else if (/tiktok\.com\//i.test(u) && !socials.tiktok) socials.tiktok = u.split("?")[0];
	}
	return {
		website: pageUrl || "",
		emails,
		email: emails[0] || "",
		socials,
		pageTitle: page.title || "",
	};
}

export async function enrichClub(club, { baseUrl } = {}) {
	const q = `"${club.name}" official website football club England`;
	const results = await googleSearch(q, {
		baseUrl,
		num: 8,
		country: "gb",
		language: "en",
	});
	const website = pickOfficialUrl(results, club.name);
	if (!website) {
		return { ...club, googleResults: (results || []).slice(0, 5) };
	}
	try {
		const row = await scrapeUrl(website, {
			baseUrl,
			timeoutMs: 60_000,
			includeImages: false,
		});
		const contacts = extractContacts(
			{
				markdown: String(row.markdown || "").slice(0, 40_000),
				html: String(row.html || row.data?.html || "").slice(0, 40_000),
				links: Array.isArray(row.data?.links) ? row.data.links : row.links || [],
				title: row.title || row.data?.title || "",
			},
			website,
		);
		return {
			...club,
			...contacts,
			enrichedAt: new Date().toISOString(),
		};
	} catch (err) {
		return {
			...club,
			website,
			enrichError: err?.message || String(err),
		};
	}
}
