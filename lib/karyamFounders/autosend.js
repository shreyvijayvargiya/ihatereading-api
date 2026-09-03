/**
 * AutoSend transactional email client for Karyam founder outreach.
 * https://docs.autosend.com/api-reference/mails/send
 */

const AUTOSEND_BASE = "https://api.autosend.com/v1";

export function autosendConfig() {
	const apiKey = String(process.env.AUTOSEND_API_KEY || "").trim();
	const fromEmail =
		String(process.env.AUTOSEND_FROM_EMAIL || "").trim() ||
		"hello@karyam.xyz";
	const fromName =
		String(process.env.AUTOSEND_FROM_NAME || "").trim() || "Karyam";
	const projectId = String(process.env.AUTOSEND_PROJECT_ID || "").trim();
	return {
		configured: Boolean(apiKey),
		fromEmail,
		fromName,
		projectId: projectId || null,
	};
}

function headers() {
	const key = String(process.env.AUTOSEND_API_KEY || "").trim();
	if (!key) throw new Error("AUTOSEND_API_KEY is required");
	const h = {
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
	};
	const projectId = String(process.env.AUTOSEND_PROJECT_ID || "").trim();
	if (projectId) h["x-project-id"] = projectId;
	return h;
}

function toHtml(text) {
	const body = String(text || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n\n/g, "</p><p>")
		.replace(/\n/g, "<br/>");
	return `<p>${body}</p>`;
}

/**
 * Send one email via AutoSend.
 * @param {{
 *   to: string,
 *   toName?: string,
 *   subject: string,
 *   text?: string,
 *   html?: string,
 *   replyTo?: string,
 * }} payload
 */
export async function sendAutosendEmail(payload) {
	const cfg = autosendConfig();
	if (!cfg.configured) {
		throw new Error("AUTOSEND_API_KEY is not set");
	}
	const toEmail = String(payload.to || "").trim();
	if (!toEmail || !toEmail.includes("@")) {
		throw new Error("Recipient email is required");
	}
	const subject = String(payload.subject || "").trim();
	if (!subject) throw new Error("Subject is required");

	const html = payload.html || toHtml(payload.text || "");
	const text = payload.text || String(payload.html || "").replace(/<[^>]+>/g, " ");

	const body = {
		from: { email: cfg.fromEmail, name: cfg.fromName },
		to: { email: toEmail, name: payload.toName || "" },
		subject,
		html,
		text,
	};
	if (payload.replyTo) {
		body.replyTo = { email: payload.replyTo, name: cfg.fromName };
	}

	const res = await fetch(`${AUTOSEND_BASE}/mails/send`, {
		method: "POST",
		signal: AbortSignal.timeout(30_000),
		headers: headers(),
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.success === false) {
		throw new Error(
			data?.error?.message ||
				data?.message ||
				data?.error ||
				`AutoSend HTTP ${res.status}`,
		);
	}
	return {
		emailId: data?.data?.emailId || data?.emailId || null,
		message: data?.data?.message || data?.message || "queued",
		raw: data,
	};
}

export function defaultDraft(lead) {
	const name = lead.name || "there";
	const company = lead.company ? ` at ${lead.company}` : "";
	return {
		subject: company
			? `Quick note from karyam.xyz — ${lead.company}`
			: "Quick note from karyam.xyz",
		text: `Hi ${name}${company},

I'm reaching out from karyam.xyz — we build software, AI agents, mobile apps, websites, automations, CRM/ERP, and scraping APIs for founders who need a technical partner.

If you're looking for someone to ship a product, agent, or internal tool, happy to take a look and suggest a path.

Would a short call this week be useful?

— Karyam
https://karyam.xyz`,
	};
}
