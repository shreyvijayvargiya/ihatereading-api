/**
 * Submission page discovery, form analysis, field mapping and filling.
 */

import path from "node:path";

/* --------------------------- link discovery --------------------------- */

export function findSubmitCandidates(page) {
	return page.evaluate(() => {
		const vis = (el) => {
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			return r.width > 2 && r.height > 2 && cs.visibility !== "hidden" && cs.display !== "none";
		};
		const good =
			/\b(submit|add|list|launch|promote|get listed|new)\b.{0,25}\b(tool|product|startup|app|site|website|project|listing|saas|software|ai|directory|link|yours?)\b|\bsubmit\b|\bget listed\b|\blist your\b|\badd your\b|\bsuggest a\b/i;
		const bad = /feedback|newsletter|subscribe|log\s?in|sign\s?in|sign\s?up|pricing|contact|blog|careers|\bsponsor/i;
		const out = [];
		let i = 0;
		for (const el of document.querySelectorAll("a[href],button,[role=button]")) {
			if (!vis(el)) continue;
			const text = (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
			const href = el.href && /^https?:/.test(el.href) ? el.href : null;
			if (!text && !href) continue;
			let score = 0;
			if (good.test(text)) score += 3;
			if (href && /submit|add-?(tool|product|site|startup)|\/new\b|list-?your|get-?listed/i.test(new URL(href).pathname)) score += 3;
			if (/^submit/i.test(text)) score += 1;
			if (el.closest("header,nav")) score += 1;
			if (bad.test(text)) score -= 4;
			if (score <= 0) continue;
			el.setAttribute("data-da-cand", String(i));
			out.push({ idx: i++, text: text.slice(0, 80), href, score });
		}
		return out.sort((a, b) => b.score - a.score).slice(0, 12);
	});
}

/* ---------------------------- field analysis --------------------------- */

export function collectFields(page) {
	return page.evaluate(() => {
		const vis = (el) => {
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			return r.width > 2 && r.height > 2 && cs.visibility !== "hidden" && cs.display !== "none";
		};
		const clip = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
		const labelOf = (el) => {
			const parts = [];
			if (el.labels?.length) parts.push(...[...el.labels].map((l) => l.innerText));
			const aria = el.getAttribute("aria-label");
			if (aria) parts.push(aria);
			const lb = el.getAttribute("aria-labelledby");
			if (lb) parts.push(lb.split(/\s+/).map((i) => document.getElementById(i)?.innerText || "").join(" "));
			if (!parts.length) {
				let p = el.parentElement;
				for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
					const l = p.querySelector("label");
					if (l && !l.contains(el)) {
						parts.push(l.innerText);
						break;
					}
				}
			}
			return clip(parts.join(" "), 160);
		};

		const all = [...document.querySelectorAll("input,textarea,select")].filter((el) => {
			const t = (el.type || "").toLowerCase();
			if (["hidden", "submit", "button", "reset", "image", "search"].includes(t)) return false;
			if (el.disabled || el.readOnly) return false;
			if (el.closest("header,nav,footer")) return false;
			return t === "file" || vis(el);
		});

		const groups = new Map();
		for (const el of all) {
			const key = el.closest("form") || document.body;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(el);
		}
		const scored = [...groups.entries()].map(([root, els]) => ({
			root,
			els,
			auth: els.some((e) => e.type === "password"),
		}));
		scored.sort((a, b) => Number(a.auth) - Number(b.auth) || b.els.length - a.els.length);
		const chosen = scored[0];
		if (!chosen) return [];

		const fields = [];
		const seenRadio = new Set();
		let idx = 0;
		for (const el of chosen.els) {
			const type = (el.type || el.tagName).toLowerCase();
			if (type === "password") continue;
			el.setAttribute("data-da-idx", String(idx));
			const base = {
				idx,
				tag: el.tagName.toLowerCase(),
				type,
				name: el.name || "",
				id: el.id || "",
				label: labelOf(el),
				placeholder: el.getAttribute("placeholder") || "",
				required: el.required || el.getAttribute("aria-required") === "true",
				maxLength: el.maxLength > 0 ? el.maxLength : null,
			};
			if (type === "radio") {
				if (seenRadio.has(el.name)) {
					idx++;
					continue;
				}
				seenRadio.add(el.name);
				base.options = chosen.els
					.filter((r) => r.type === "radio" && r.name === el.name)
					.map((r, j) => {
						const ri = `${idx}-${j}`;
						r.setAttribute("data-da-radio", ri);
						return { value: r.value, text: labelOf(r) || r.value, radio: ri };
					});
			} else if (el.tagName === "SELECT") {
				base.options = [...el.options]
					.filter((o) => o.value !== "")
					.slice(0, 80)
					.map((o) => ({ value: o.value, text: clip(o.textContent, 80) }));
			}
			fields.push(base);
			idx++;
		}
		return fields;
	});
}

/* ----------------------------- field mapping ---------------------------- */

export const PRODUCT_KEYS = [
	"name",
	"website",
	"tagline",
	"description",
	"email",
	"tags",
	"category",
	"pricing",
	"github",
	"twitter",
	"contactName",
	"logo",
];

const RULES = [
	["logo", (f, h) => f.type === "file" && /logo|icon|avatar|image|screenshot|thumbnail|cover|upload/.test(h)],
	["github", (f, h) => /github|repo(sitory)?\b|source code/.test(h)],
	["twitter", (f, h) => /twitter|x\.com|\bx handle|\bx \(/.test(h)],
	["email", (f, h) => f.type === "email" || /e-?mail/.test(h)],
	["tags", (f, h) => /\btags?\b|keywords?|topics?/.test(h)],
	["category", (f, h) => /categor|industry|vertical|\btype\b/.test(h)],
	["pricing", (f, h) => /pric(e|ing)|\bplan\b|freemium/.test(h)],
	["tagline", (f, h) => /tagline|slogan|one[- ]?liner|short desc|headline|subtitle|summary|brief/.test(h)],
	["contactName", (f, h) => /your name|contact name|founder|submitter|full name|first name|maker|author/.test(h)],
	["description", (f, h) => f.tag === "textarea" || /descri|about|details|pitch|tell us|overview/.test(h)],
	["website", (f, h) => f.type === "url" || /\burl\b|website|web site|\blink\b|domain|homepage|\bsite\b/.test(h)],
	["name", (f, h) => /name|title|product|tool|app\b|startup|company|project/.test(h)],
];

const hay = (f) => [f.label, f.name, f.id, f.placeholder].join(" ").toLowerCase();

export function mapFieldsHeuristic(fields) {
	const map = {};
	const used = new Set();
	for (const f of fields) {
		if (f.type === "checkbox" || f.type === "radio") {
			if (f.type === "radio" && /pric|categor/.test(hay(f))) {
				map[f.idx] = /pric/.test(hay(f)) ? "pricing" : "category";
			}
			continue;
		}
		const h = hay(f);
		for (const [key, test] of RULES) {
			if (used.has(key) && key !== "tags") continue;
			if (test(f, h)) {
				map[f.idx] = key;
				used.add(key);
				break;
			}
		}
	}
	return map;
}

/** Stable signature so a stored mapping survives re-tagging after reloads. */
export const fieldSig = (f) => [f.type, f.name, f.id, f.label].join("|").toLowerCase();

export function productValue(product, key, field) {
	let v;
	switch (key) {
		case "tagline":
			v = product.tagline || (product.description || "").slice(0, 100);
			break;
		case "tags":
			v = Array.isArray(product.tags) ? product.tags.join(", ") : product.tags;
			break;
		case "github":
			v = product.githubRepo ? `https://github.com/${product.githubRepo.replace(/^https?:\/\/github\.com\//, "")}` : "";
			break;
		case "logo":
			v = product.logoPath;
			break;
		default:
			v = product[key];
	}
	if (v == null || v === "") return null;
	v = String(v);
	if (field?.maxLength && v.length > field.maxLength) v = v.slice(0, field.maxLength);
	return v;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function pickOption(options, wanted) {
	if (!options?.length || !wanted) return null;
	const w = norm(wanted);
	const exact = options.find((o) => norm(o.text) === w || norm(o.value) === w);
	if (exact) return exact;
	const partial = options.find((o) => norm(o.text).includes(w) || w.includes(norm(o.text)));
	if (partial) return partial;
	const words = new Set(w.split(" ").filter((x) => x.length > 2));
	let best = null;
	let bestScore = 0;
	for (const o of options) {
		const score = norm(o.text)
			.split(" ")
			.filter((x) => words.has(x)).length;
		if (score > bestScore) {
			best = o;
			bestScore = score;
		}
	}
	return best;
}

const CONSENT_RE = /agree|accept|terms|privacy|policy|consent|certify|confirm that|i am the (owner|founder)/i;

/**
 * Fill every mappable field. Returns what was filled / what was skipped.
 * @param {ReturnType<import("./browser.js").createBrowserTools>} tools
 */
export async function fillFields(tools, fields, mapping, product, log) {
	const filled = [];
	const unfilled = [];
	for (const f of fields) {
		const sel = `[data-da-idx="${f.idx}"]`;
		try {
			if (f.type === "checkbox") {
				const text = `${f.label} ${f.name}`;
				if (CONSENT_RE.test(text)) {
					await tools.click(sel, { settleAfter: false });
					filled.push({ idx: f.idx, label: f.label || f.name, key: "consent", value: "checked" });
				} else if (f.required) {
					unfilled.push({ label: f.label || f.name, reason: "checkbox needs a human decision" });
				}
				continue;
			}
			const key = mapping[f.idx];
			if (!key) {
				if (f.required) unfilled.push({ label: f.label || f.name || f.placeholder, reason: "no matching product field" });
				continue;
			}
			const value = productValue(product, key, f);
			if (value == null) {
				if (f.required) unfilled.push({ label: f.label || f.name, reason: `product.${key} not provided` });
				continue;
			}
			if (f.type === "file") {
				await tools.upload(sel, path.resolve(value));
			} else if (f.type === "radio") {
				const opt = pickOption(f.options, value);
				if (!opt) {
					unfilled.push({ label: f.label || f.name, reason: `no option matches "${value}"` });
					continue;
				}
				await tools.click(`[data-da-radio="${opt.radio}"]`, { settleAfter: false });
				filled.push({ idx: f.idx, label: f.label || f.name, key, value: opt.text });
				continue;
			} else if (f.tag === "select") {
				const opt = pickOption(f.options, value);
				if (!opt) {
					unfilled.push({ label: f.label || f.name, reason: `no option matches "${value}"` });
					continue;
				}
				await tools.select(sel, { value: opt.value });
				filled.push({ idx: f.idx, label: f.label || f.name, key, value: opt.text });
				continue;
			} else {
				await tools.type(sel, value);
			}
			filled.push({ idx: f.idx, label: f.label || f.name || f.placeholder, key, value: key === "logo" ? path.basename(value) : value });
		} catch (e) {
			log("warn", `could not fill "${f.label || f.name}": ${e.message.split("\n")[0]}`);
			unfilled.push({ label: f.label || f.name, reason: "fill failed" });
		}
	}
	return { filled, unfilled };
}

/** Read the live DOM values back for the preview card. */
export function readBack(page, fields) {
	return page.evaluate((fs) => {
		return fs
			.map((f) => {
				let el;
				if (f.type === "radio") el = document.querySelector(`[data-da-idx="${f.idx}"]`);
				else el = document.querySelector(`[data-da-idx="${f.idx}"]`);
				if (!el) return null;
				let value = "";
				if (f.type === "radio") {
					const checked = document.querySelector(`input[type=radio][name="${CSS.escape(el.name)}"]:checked`);
					value = checked ? checked.value : "";
				} else if (f.type === "checkbox") value = el.checked ? "checked" : "";
				else if (f.type === "file") value = el.files?.[0]?.name || "";
				else if (el.tagName === "SELECT") value = el.selectedOptions[0]?.textContent?.trim() || "";
				else value = el.value || "";
				return { label: f.label || f.name || f.placeholder || `field ${f.idx}`, value: value.slice(0, 500) };
			})
			.filter((x) => x && x.value !== "");
	}, fields);
}

/** Tags the best submit control with data-da-submit and returns its text (or null). */
export function markSubmitButton(page) {
	return page.evaluate(() => {
		const vis = (el) => {
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			return r.width > 2 && r.height > 2 && cs.visibility !== "hidden" && cs.display !== "none";
		};
		document.querySelectorAll("[data-da-submit]").forEach((e) => e.removeAttribute("data-da-submit"));
		const anchor = document.querySelector("[data-da-idx]");
		const scope = anchor?.closest("form") || document;
		const textRe = /submit|add|list|send|create|publish|launch|continue|next|post|save|register/i;
		const badRe = /cancel|back|reset|clear|log\s?in|sign\s?in|search|subscribe/i;
		const cands = [...scope.querySelectorAll("button,input[type=submit],[role=button],a.btn,a.button")].filter(vis);
		const label = (e) => (e.innerText || e.value || e.getAttribute("aria-label") || "").trim();
		const pick =
			cands.find((e) => (e.type === "submit" || (e.tagName === "BUTTON" && !e.type)) && !badRe.test(label(e))) ||
			cands.find((e) => textRe.test(label(e)) && !badRe.test(label(e)));
		if (!pick) return null;
		pick.setAttribute("data-da-submit", "1");
		return label(pick).slice(0, 60) || "submit";
	});
}
