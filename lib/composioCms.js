/**
 * Composio helpers: Notion + Google Docs OAuth links, Firestore connection map, CMS push.
 * Env: COMPOSIO_API_KEY, COMPOSIO_NOTION_AUTH_CONFIG_ID, COMPOSIO_GOOGLEDOCS_AUTH_CONFIG_ID,
 *      COMPOSIO_OAUTH_CALLBACK_URL (optional default callback for link()),
 *      optional pinned toolkit versions for manual tool execution:
 *      COMPOSIO_NOTION_TOOLKIT_VERSION, COMPOSIO_GOOGLEDOCS_TOOLKIT_VERSION (e.g. 20250909_00 from Composio).
 *      If omitted, executes with dangerouslySkipVersionCheck (allows "latest"; pin versions in production).
 *      Tool slug overrides: COMPOSIO_NOTION_CREATE_PAGE_TOOL, COMPOSIO_GOOGLEDOCS_CREATE_DOCUMENT_TOOL,
 *      COMPOSIO_GOOGLEDOCS_UPDATE_DOCUMENT_TOOL (defaults: *_MARKDOWN variants for full body content).
 */
import { Composio } from "@composio/core";
import { firestore } from "../config/firebase.js";
import { FieldValue } from "firebase-admin/firestore";

export const COMPOSIO_CONNECTIONS_COLL = "composioConnections";

const PLATFORMS = /** @type {const} */ (["notion", "googledocs"]);

/** @param {string} p */
export function isComposioPlatform(p) {
	return PLATFORMS.includes(/** @type {any} */ (p));
}

let _composio;

export function getComposio() {
	const key = process.env.COMPOSIO_API_KEY;
	if (!key?.trim()) {
		throw new Error("COMPOSIO_API_KEY is not configured");
	}
	if (!_composio) {
		_composio = new Composio({ apiKey: key.trim() });
	}
	return _composio;
}

/** @param {"notion"|"googledocs"} platform */
export function resolveAuthConfigId(platform) {
	const id =
		platform === "notion"
			? process.env.COMPOSIO_NOTION_AUTH_CONFIG_ID
			: process.env.COMPOSIO_GOOGLEDOCS_AUTH_CONFIG_ID;
	if (!id?.trim()) {
		throw new Error(
			platform === "notion"
				? "COMPOSIO_NOTION_AUTH_CONFIG_ID is not set"
				: "COMPOSIO_GOOGLEDOCS_AUTH_CONFIG_ID is not set",
		);
	}
	return id.trim();
}

/** @param {"notion"|"googledocs"} platform */
export function resolveToolSlugs(platform) {
	if (platform === "notion") {
		return {
			create:
				process.env.COMPOSIO_NOTION_CREATE_PAGE_TOOL?.trim() ||
				"NOTION_CREATE_PAGE",
			update:
				process.env.COMPOSIO_NOTION_UPDATE_PAGE_TOOL?.trim() ||
				"NOTION_UPDATE_PAGE",
		};
	}
	return {
		create:
			process.env.COMPOSIO_GOOGLEDOCS_CREATE_DOCUMENT_TOOL?.trim() ||
			"GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN",
		update:
			process.env.COMPOSIO_GOOGLEDOCS_UPDATE_DOCUMENT_TOOL?.trim() ||
			"GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN",
	};
}

/**
 * Map API opts to Composio Google Docs tool params (slug-dependent).
 * Plain GOOGLEDOCS_CREATE_DOCUMENT uses `text`; markdown tools use markdown_text / markdown.
 *
 * @param {string} slug
 * @param {"create"|"update"} action
 * @param {{ title?: string, content?: string, documentId?: string }} opts
 */
function googleDocsToolArguments(slug, action, opts) {
	const u = slug.toUpperCase();
	const markdownMode = u.includes("MARKDOWN");
	const title = opts.title?.trim() || "Untitled";
	const body = opts.content != null ? String(opts.content) : "";

	if (action === "create") {
		if (markdownMode) {
			return { title, markdown_text: body };
		}
		return { title, text: body };
	}

	const docId = opts.documentId?.trim() || "";
	if (markdownMode) {
		return { id: docId, markdown: body };
	}
	return {
		document_id: docId,
		title: opts.title,
		text: body,
	};
}

/** @param {"notion"|"googledocs"} platform */
function resolveToolExecuteOptions(platform) {
	const pinned =
		platform === "notion"
			? process.env.COMPOSIO_NOTION_TOOLKIT_VERSION?.trim()
			: process.env.COMPOSIO_GOOGLEDOCS_TOOLKIT_VERSION?.trim();
	if (pinned) return { version: pinned };
	return { dangerouslySkipVersionCheck: true };
}

const HTTPS_URL_RE = /https?:\/\/[^\s"'<>]+/g;

function trimTrailingPunctuation(url) {
	return url.replace(/[)\].,;"'`]+$/g, "");
}

function parseGoogleStyleRpcJson(text) {
	let summary = null;
	const links = [];
	let reason = null;
	try {
		const o = typeof text === "string" ? JSON.parse(text) : text;
		const err = o?.error;
		if (err?.message && typeof err.message === "string") summary = err.message;
		const details = err?.details;
		if (Array.isArray(details)) {
			for (const d of details) {
				if (d?.reason && typeof d.reason === "string") reason = d.reason;
				const activation =
					d?.metadata?.activationUrl || d?.metadata?.activation_url;
				if (typeof activation === "string") links.push(trimTrailingPunctuation(activation));
				if (Array.isArray(d?.links)) {
					for (const h of d.links) {
						if (h?.url && typeof h.url === "string")
							links.push(trimTrailingPunctuation(h.url));
					}
				}
			}
		}
	} catch {
		/* not JSON */
	}
	return { summary, links, reason };
}

/**
 * Build a client-friendly summary when composio.tools.execute returns successful: false.
 * Pulls human-readable messages and actionable URLs (e.g. Google Cloud "Enable API" links).
 *
 * @param {{ data?: Record<string, unknown>, error?: unknown, successful?: boolean, logId?: string }} result
 * @param {"notion"|"googledocs"} [platform]
 */
export function summarizeComposioToolFailure(result, platform) {
	const chunks = [];
	if (result?.error != null) chunks.push(String(result.error));
	const dm = result?.data && /** @type {any} */ (result.data).message;
	if (dm != null) chunks.push(String(dm));
	const httpErr = result?.data && /** @type {any} */ (result.data).http_error;
	if (httpErr != null) chunks.push(String(httpErr));

	let summary = null;
	let reason = null;
	const linkSet = new Set();

	for (const chunk of chunks) {
		const parsed = parseGoogleStyleRpcJson(chunk);
		if (parsed.summary) summary = parsed.summary;
		if (parsed.reason) reason = parsed.reason;
		for (const u of parsed.links) linkSet.add(u);
	}

	const blob = chunks.join("\n");
	for (const m of blob.matchAll(HTTPS_URL_RE)) {
		linkSet.add(trimTrailingPunctuation(m[0]));
	}

	const hints = [];
	if (!summary && typeof result?.error === "string") summary = result.error.trim();
	if (!summary && blob.trim()) summary = blob.trim().slice(0, 500);

	if (!summary) summary = "The integration returned an error (see details).";

	if (reason === "SERVICE_DISABLED" || /API has not been used|is disabled/i.test(summary)) {
		hints.push(
			"If Google rejected the request: open the link(s) below and enable the required API in Google Cloud, wait a few minutes, then retry.",
		);
	}
	if (platform === "googledocs") {
		hints.push(
			"Google Docs needs the Docs API enabled on the OAuth client's Cloud project.",
		);
	}
	if (platform === "notion") {
		hints.push("Confirm the Notion integration has access to the workspace/page.");
	}

	return {
		message: summary,
		links: [...linkSet],
		hints,
		reason,
		logId: result?.logId,
		retryable:
			reason !== "SERVICE_DISABLED" &&
			!/PERMISSION_DENIED|SERVICE_DISABLED/i.test(blob),
	};
}

/**
 * One document per user: { notion?: {...}, googledocs?: {...} }
 * @param {string} userId
 */
function userConnectionsRef(userId) {
	return firestore.collection(COMPOSIO_CONNECTIONS_COLL).doc(userId);
}

/**
 * @param {string} userId
 * @param {"notion"|"googledocs"} platform
 */
export async function getStoredConnection(userId, platform) {
	const snap = await userConnectionsRef(userId).get();
	const data = snap.data() || {};
	return data[platform] || null;
}

/**
 * @param {string} userId
 * @param {"notion"|"googledocs"} platform
 * @param {{ connectedAccountId: string, authConfigId?: string }} row
 */
export async function setStoredConnection(userId, platform, row) {
	await userConnectionsRef(userId).set(
		{
			[platform]: {
				connectedAccountId: row.connectedAccountId,
				authConfigId: row.authConfigId || null,
				updatedAt: new Date().toISOString(),
			},
			updatedAt: FieldValue.serverTimestamp(),
		},
		{ merge: true },
	);
}

/**
 * @param {string} userId
 * @param {"notion"|"googledocs"} platform
 */
export async function deleteStoredConnection(userId, platform) {
	await userConnectionsRef(userId).set(
		{
			[platform]: FieldValue.delete(),
			updatedAt: FieldValue.serverTimestamp(),
		},
		{ merge: true },
	);
}

/**
 * @param {string} userId
 * @param {"notion"|"googledocs"} platform
 * @param {string} [callbackUrl]
 */
export async function createComposioLink(userId, platform, callbackUrl) {
	const composio = getComposio();
	const authConfigId = resolveAuthConfigId(platform);
	const cb =
		(callbackUrl && String(callbackUrl).trim()) ||
		process.env.COMPOSIO_OAUTH_CALLBACK_URL?.trim() ||
		undefined;
	return composio.connectedAccounts.link(userId, authConfigId, {
		...(cb ? { callbackUrl: cb } : {}),
		allowMultiple: true,
	});
}

/**
 * Resolve ACTIVE connected account after OAuth — prefer explicit id else list.
 * @param {string} userId
 * @param {"notion"|"googledocs"} platform
 * @param {string} [connectedAccountId]
 */
export async function resolveActiveConnectedAccount(
	userId,
	platform,
	connectedAccountId,
) {
	const composio = getComposio();
	const authConfigId = resolveAuthConfigId(platform);
	if (connectedAccountId?.trim()) {
		const acc = await composio.connectedAccounts.get(connectedAccountId.trim());
		if (acc.status !== "ACTIVE") {
			throw new Error(`Connection not active yet (status: ${acc.status})`);
		}
		return { connectedAccountId: acc.id, authConfigId };
	}
	const list = await composio.connectedAccounts.list({
		userIds: [userId],
		authConfigIds: [authConfigId],
		statuses: ["ACTIVE"],
		limit: 5,
	});
	const first = list.items?.[0];
	if (!first?.id) {
		throw new Error(
			"No active Composio connection for this user and auth config — complete OAuth or pass connectedAccountId",
		);
	}
	return { connectedAccountId: first.id, authConfigId };
}

/**
 * @param {string} userId
 * @param {"notion"|"googledocs"} platform
 * @param {"create"|"update"} action
 * @param {{
 *   title?: string,
 *   content?: string,
 *   documentId?: string,
 *   notionParentId?: string,
 *   toolArguments?: Record<string, unknown>,
 * }} opts
 */
export async function executeCmsTool(userId, platform, action, opts) {
	const composio = getComposio();
	const conn = await getStoredConnection(userId, platform);
	if (!conn?.connectedAccountId) {
		throw new Error(
			`No saved ${platform} connection for this user — call POST /integrations/composio/connection first`,
		);
	}
	const slugs = resolveToolSlugs(platform);
	const slug = action === "update" ? slugs.update : slugs.create;
	const baseArgs =
		platform === "notion"
			? action === "update"
				? {
						page_id: opts.documentId,
						title: opts.title,
					}
				: {
						title: opts.title,
						content: opts.content,
						...(opts.notionParentId
							? { parent_id: opts.notionParentId }
							: {}),
					}
			: googleDocsToolArguments(slug, action, opts);

	const arguments_ = { ...baseArgs, ...(opts.toolArguments || {}) };

	if (
		action === "update" &&
		!arguments_.page_id &&
		!arguments_.document_id &&
		!arguments_.id
	) {
		throw new Error(
			"Updating requires documentId (Notion page_id / Google Docs document id)",
		);
	}

	return composio.tools.execute(slug, {
		userId,
		connectedAccountId: conn.connectedAccountId,
		arguments: arguments_,
		...resolveToolExecuteOptions(platform),
	});
}
