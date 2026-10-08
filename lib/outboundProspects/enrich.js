/**
 * Scrape websites for email + phone on outbound prospect leads.
 */

import { scrapeUrl } from "../scrapefast.js";
import {
	extractEmails,
	extractPhones,
	isJunkHost,
	mergeContactFields,
	normalizeUrl,
} from "./core.js";
import { contactsFromText } from "../karyamFounders/core.js";

function pageText(row) {
	return [
		row.markdown || "",
		row.title || row.data?.title || "",
	].join("\n");
}

async function scrapeContactsFromUrl(url, baseUrl) {
	const target = normalizeUrl(url);
	if (!target || isJunkHost(target)) {
		return { contacts: {}, error: "junk_or_empty" };
	}
	try {
		const row = await scrapeUrl(target, {
			baseUrl,
			timeoutMs: 45_000,
			includeImages: false,
			includeLinks: true,
		});
		const text = pageText(row);
		const contacts = contactsFromText(text, target);
		if (!contacts.emails?.length) {
			contacts.emails = extractEmails(text);
		}
		if (!contacts.phones?.length) {
			contacts.phones = extractPhones(text);
		}
		return { contacts, title: row.title || "" };
	} catch (err) {
		return { contacts: {}, error: err?.message || String(err) };
	}
}

/**
 * @param {object[]} leads
 * @param {{ baseUrl?: string, limit?: number }} opts
 */
export async function enrichLeads(leads, opts = {}) {
	const limit = opts.limit ?? leads.length;
	const out = [];

	for (const lead of leads.slice(0, limit)) {
		let enriched = { ...lead };
		const targets = [
			lead.website,
			lead.sourceUrl,
			lead.mapsUrl,
		].filter(Boolean);

		for (const url of targets) {
			const { contacts, error } = await scrapeContactsFromUrl(url, opts.baseUrl);
			if (contacts && Object.keys(contacts).length) {
				enriched = mergeContactFields(enriched, contacts);
			}
			if (enriched.email || enriched.phones?.length) break;
			if (error) enriched.enrichError = error;
		}

		enriched.enrichedAt = new Date().toISOString();
		enriched.hasContact = Boolean(
			enriched.email || enriched.phones?.length || enriched.phone,
		);
		out.push(enriched);
	}

	return out;
}
