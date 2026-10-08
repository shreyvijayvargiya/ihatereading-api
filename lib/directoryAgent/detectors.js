/**
 * In-page signal detection: auth walls, captchas, badge/ownership verification.
 * Everything runs inside the page via one evaluate() call and returns plain JSON.
 */

export function collectSignals(page) {
	return page.evaluate(() => {
		const vis = (el) => {
			if (!el || !el.getBoundingClientRect) return false;
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			return r.width > 2 && r.height > 2 && cs.visibility !== "hidden" && cs.display !== "none";
		};
		const clip = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
		const bodyText = document.body?.innerText || "";
		const lower = bodyText.toLowerCase();
		const href = location.href;

		/* ---------- form size (non-auth fields) ---------- */
		const fieldEls = [...document.querySelectorAll("input,textarea,select")].filter((el) => {
			const t = (el.type || "").toLowerCase();
			if (["hidden", "submit", "button", "reset", "image", "password", "search", "checkbox", "radio"].includes(t)) {
				return false;
			}
			if (el.closest("header,nav,footer")) return false;
			const form = el.closest("form");
			if (form && form.querySelector("input[type=password]")) return false;
			return t === "file" || vis(el);
		});
		const formFieldCount = fieldEls.length;

		/* ---------- login / oauth ---------- */
		const hasPassword = [...document.querySelectorAll("input[type=password]")].some(vis);
		const oauthRe =
			/(continue|sign\s?in|log\s?in|login|sign\s?up|signup|register)\s+(with|using|via)\s+(google|github|apple|facebook|twitter|x|linkedin|microsoft|discord)/i;
		const oauth = [];
		for (const el of document.querySelectorAll("a,button,[role=button]")) {
			if (!vis(el)) continue;
			const m = oauthRe.exec(clip(el.innerText || el.getAttribute("aria-label") || "", 80));
			if (m) oauth.push({ provider: m[3].toLowerCase(), text: clip(el.innerText, 60) });
		}
		for (const el of document.querySelectorAll(
			'a[href*="accounts.google.com"],a[href*="github.com/login"],a[href*="/auth/google"],a[href*="/auth/github"],a[href*="/oauth"]',
		)) {
			if (!vis(el)) continue;
			const h = el.href;
			const provider = /google/.test(h) ? "google" : /github/.test(h) ? "github" : "oauth";
			oauth.push({ provider, text: clip(el.innerText, 60) });
		}
		const loginLinks = [...document.querySelectorAll("a,button")]
			.filter(
				(el) =>
					vis(el) && /^(log\s?in|sign\s?in|login|signin|sign in \/ sign up)$/i.test(clip(el.innerText, 40)),
			)
			.map((el) => clip(el.innerText, 40))
			.slice(0, 5);

		const authHostRe =
			/accounts\.google\.com|github\.com\/(login|session)|appleid\.apple|login\.microsoftonline|facebook\.com\/(login|dialog)|discord\.com\/(login|oauth2)|linkedin\.com\/(login|uas|oauth)|(x|twitter)\.com\/i\/(flow|oauth)/i;
		const authPath = /(^|\/)(log-?in|sign-?in|signin|signup|sign-up|register|auth|authenticate|sso|oauth)(\/|$|\?)/i;
		const urlWall = authHostRe.test(href) || authPath.test(location.pathname);
		const phrase =
			/(sign|log)\s*in\s+(is\s+)?(required|to\s+(continue|submit|add|post|list|launch|access))|you\s+(must|need to|have to)\s+(be\s+)?(logged|signed)\s*in|please\s+(sign|log)\s*in|login\s+required|authentication\s+required|create an account to/i.test(
				bodyText,
			);
		const wall = urlWall || ((phrase || hasPassword || oauth.length > 0) && formFieldCount < 3);

		let provider = null;
		if (/accounts\.google\.com/.test(href)) provider = "Google";
		else if (/github\.com/.test(href)) provider = "GitHub";
		else if (/appleid\.apple/.test(href)) provider = "Apple";
		else if (/microsoftonline/.test(href)) provider = "Microsoft";
		else if (/facebook\.com/.test(href)) provider = "Facebook";
		else if (/linkedin\.com/.test(href)) provider = "LinkedIn";
		else if (oauth[0]) provider = oauth[0].provider.charAt(0).toUpperCase() + oauth[0].provider.slice(1);

		/* ---------- captcha ---------- */
		const frameVisible = (sel, minW = 50) =>
			[...document.querySelectorAll(sel)].some((f) => vis(f) && f.getBoundingClientRect().width >= minW);
		let captchaKind = null;
		if (frameVisible('iframe[src*="recaptcha/api2/anchor"],iframe[src*="recaptcha/api2/bframe"],iframe[src*="recaptcha/enterprise/anchor"]')) {
			captchaKind = "reCAPTCHA";
		} else if (frameVisible('iframe[src*="hcaptcha.com"]')) captchaKind = "hCaptcha";
		else if (
			frameVisible('iframe[src*="challenges.cloudflare.com"]') ||
			[...document.querySelectorAll(".cf-turnstile")].some(vis)
		) {
			captchaKind = "Cloudflare Turnstile";
		} else if (
			/just a moment|attention required|checking your browser/i.test(document.title) ||
			/verify you are human|checking if the site connection is secure/i.test(bodyText.slice(0, 1500))
		) {
			captchaKind = "Bot check";
		} else if ([...document.querySelectorAll(".g-recaptcha,.h-captcha")].some((e) => vis(e) && e.getBoundingClientRect().height > 20)) {
			captchaKind = "CAPTCHA";
		}

		/* ---------- badge / ownership verification ---------- */
		const strongBadgeRe =
			/verify\s+(your\s+)?(site\s+)?ownership|ownership\s+(proof|verification)|prove\s+(you\s+)?own|add\s+(our|the|this|a)\s+(\w+\s+)?badge|badge\s+(is\s+)?(required|needed)|place\s+(the|this|our)\s+badge|embed\s+(the|this|our)\s+badge|backlink\s+(is\s+)?required|verification\s+badge/i;
		const strong = strongBadgeRe.test(bodyText);
		const codeRe = /<(a|img|script)\b|!\[[^\]]*\]\([^)]+\)|\]\(https?:\/\/|href=/i;
		const codeNodes = [
			...document.querySelectorAll("pre,code,textarea[readonly],input[readonly],[data-clipboard-text],textarea"),
		];
		let badgeCode = null;
		for (const el of codeNodes) {
			const v = (el.value || el.getAttribute("data-clipboard-text") || el.innerText || "").trim();
			if (v.length > 10 && v.length < 2000 && codeRe.test(v)) {
				const ctx = clip(el.closest("section,div,form,li,p")?.innerText || "", 400).toLowerCase();
				if (/badge|verif|embed|backlink|widget/.test(ctx) || strong) {
					badgeCode = v;
					break;
				}
			}
		}
		const found = strong || Boolean(badgeCode);
		let instructions = "";
		let verifyButton = null;
		let verificationUrl = null;
		if (found) {
			const kw = /badge|verify|verification|ownership|backlink/i;
			const snippets = [];
			for (const el of document.querySelectorAll("p,li,h2,h3,h4,label,span,div")) {
				if (el.children.length > 3) continue;
				const t = clip(el.innerText, 300);
				if (t.length > 15 && kw.test(t) && !snippets.includes(t)) snippets.push(t);
				if (snippets.length >= 3) break;
			}
			instructions = snippets.join(" ").slice(0, 800);
			for (const el of document.querySelectorAll("a,button,input[type=submit]")) {
				const t = clip(el.innerText || el.value, 60);
				if (vis(el) && /^(verify|check|confirm|validate)\b|verify (badge|ownership|site)|check badge/i.test(t)) {
					verifyButton = t;
					if (el.href && /^https?:/.test(el.href)) verificationUrl = el.href;
					// Only tag controls that cannot navigate away or submit the directory form.
					const inert =
						(el.tagName === "BUTTON" && (el.type === "button" || !el.closest("form"))) ||
						(el.tagName === "A" && (!el.getAttribute("href") || /^(#|javascript:)/.test(el.getAttribute("href"))));
					if (inert) el.setAttribute("data-da-verify", "1");
					break;
				}
			}
		}

		return {
			url: href,
			title: document.title,
			text: bodyText.slice(0, 6000),
			formFieldCount,
			hasPassword,
			login: { wall, urlWall, phrase, provider, oauth: oauth.slice(0, 4), loginLinks },
			captcha: { found: Boolean(captchaKind), kind: captchaKind },
			badge: {
				found,
				strong,
				badgeCode,
				instructions,
				verificationUrl: verificationUrl || href,
				verifyButton,
			},
		};
	});
}
