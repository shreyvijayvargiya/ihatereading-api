/**
 * Claude toprated agent — tool loop over scrape APIs + Firestore tables.
 */

import { mergeOpenRouterUsage } from "../openRouterUsage.js";
import { DEFAULT_CHAT_MODEL, openRouterChatRaw } from "../openrouter.js";
import { CLAUDE_TOPRATED_TOOLS, executeTool, jsonSafe } from "./tools.js";

export const CLAUDE_TOPRATED = {
	id: "claude-toprated",
	name: "Claude toprated",
	model:
		process.env.CLAUDE_TOPRATED_MODEL ||
		process.env.OPENROUTER_MODEL ||
		DEFAULT_CHAT_MODEL,
	maxRounds: Number(process.env.CLAUDE_TOPRATED_MAX_ROUNDS || "12"),
};

export const SYSTEM_PROMPT = `You are Claude toprated, a research and data agent for ihatereading.

You have two job types:
1) Gather live public data with scrape tools (website, maps, LinkedIn, X, Instagram, YouTube, GitHub, Product Hunt, Google search).
2) Persist structured results in Firestore tables.

Tables:
- A table name is a new Firestore collection.
- Each row is a new document. Prefer stable ids (url, handle, place name) as row.id / docId.
- Use table_add_rows after you have real scraped fields — do not invent rows.
- Use table_edit_row and table_remove_row to maintain data.
- Tell the user the collection name and how many docs you wrote.

Rules:
- Call tools instead of guessing live facts (follower counts, addresses, stars, product descriptions).
- Prefer google_search to find URLs, then the matching dedicated scraper.
- LinkedIn pages often block; search first, scrape URL only if needed.
- Keep answers concise. After storing data, summarize columns + counts, not every row.
- Never claim you stored data unless a table_* tool succeeded.`;

function assistantText(message) {
	const c = message?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((p) => (typeof p === "string" ? p : p?.text || ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function normalizeMessages(input) {
	if (Array.isArray(input) && input.length) {
		return input
			.filter((m) => m && (m.role === "user" || m.role === "assistant"))
			.map((m) => ({
				role: m.role,
				content: typeof m.content === "string" ? m.content : String(m.content || ""),
			}))
			.filter((m) => m.content.trim());
	}
	return [];
}

/**
 * @param {{ message?: string, messages?: object[], baseUrl?: string, onEvent?: Function }} opts
 */
export async function runClaudeToprated({
	message,
	messages,
	baseUrl,
	onEvent,
} = {}) {
	const emit = typeof onEvent === "function" ? onEvent : async () => {};
	const history = normalizeMessages(messages);
	const userText = String(message || "").trim();
	if (userText) history.push({ role: "user", content: userText });
	if (!history.length) throw new Error("message is required");

	const chat = [
		{ role: "system", content: SYSTEM_PROMPT },
		...history,
	];

	let usage = null;
	const toolTrace = [];
	const tablesTouched = [];
	let finalText = "";
	const maxRounds = Math.max(1, Math.min(20, CLAUDE_TOPRATED.maxRounds));

	await emit({ type: "start", model: CLAUDE_TOPRATED.model });

	for (let round = 0; round < maxRounds; round++) {
		await emit({ type: "status", status: "thinking", round });
		const turn = await openRouterChatRaw({
			model: CLAUDE_TOPRATED.model,
			messages: chat,
			tools: CLAUDE_TOPRATED_TOOLS,
			temperature: 0.2,
			maxTokens: 8192,
			timeoutMs: 180_000,
		});
		usage = mergeOpenRouterUsage(usage, turn.usage);

		const msg = turn.message;
		chat.push({
			role: "assistant",
			content: msg.content ?? (msg.tool_calls?.length ? null : ""),
			...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
		});

		const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
		if (!calls.length) {
			finalText = assistantText(msg);
			break;
		}

		for (const call of calls) {
			const name = call.function?.name || call.name;
			const args = call.function?.arguments ?? call.arguments;
			const id = call.id || `call_${toolTrace.length}`;
			await emit({ type: "tool_call", id, name, arguments: args, round });
			let result;
			let ok = true;
			try {
				result = await executeTool(name, args, { baseUrl });
				if (name.startsWith("table_") && result?.collection) {
					tablesTouched.push({
						action: name,
						collection: result.collection,
						docIds: result.rows?.map((r) => r.docId) || result.docIds || [result.docId].filter(Boolean),
					});
					await emit({
						type: "table",
						action: name,
						collection: result.collection,
						docIds: tablesTouched[tablesTouched.length - 1].docIds,
					});
				}
			} catch (err) {
				ok = false;
				result = { error: err?.message || String(err) };
			}
			const content = jsonSafe(result);
			toolTrace.push({ id, name, ok, preview: content.slice(0, 400) });
			await emit({
				type: "tool_result",
				id,
				name,
				ok,
				result:
					content.length > 4000
						? { truncated: true, preview: content.slice(0, 4000) }
						: result,
			});
			chat.push({
				role: "tool",
				tool_call_id: id,
				content,
			});
		}
	}

	if (!finalText) {
		finalText =
			"I ran out of tool rounds before finishing. Ask me to continue from the last table or scrape.";
	}

	const done = {
		type: "done",
		message: finalText,
		model: CLAUDE_TOPRATED.model,
		usage,
		tools: toolTrace,
		tables: tablesTouched,
	};
	await emit(done);
	return done;
}
