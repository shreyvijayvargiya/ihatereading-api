const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM = `You are a coding agent inside a jailed workspace.

Tools:
- fs_list / fs_read / fs_write / fs_remove — files stay inside this session folder
- shell — commands run with cwd=workspace (timeout 20s)
- http_request — public HTTP only
- react_preview — rebuilds the React iframe from src/main.jsx + src/App.jsx

Rules:
- Prefer tools over guessing. Write React to src/App.jsx then call react_preview.
- Keep answers short. After tools, say what changed and where to look.
- Never ask for secrets. Never try to leave the workspace.`;

function apiKey() {
	const key = process.env.OPENROUTER_API_KEY?.trim();
	if (!key) throw new Error("OPENROUTER_API_KEY is required for /v1/chat");
	return key;
}

function parseArgs(raw) {
	if (!raw) return {};
	if (typeof raw === "object") return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

export async function runAgentLoop({
	messages,
	tools,
	execute,
	onEvent,
	maxRounds = 8,
	model = process.env.SANDBOX_MODEL ||
		process.env.OPENROUTER_MODEL ||
		"anthropic/claude-sonnet-4",
}) {
	const emit = typeof onEvent === "function" ? onEvent : async () => {};
	const chat = [
		{ role: "system", content: SYSTEM },
		...messages.filter((m) => m && m.role && m.content),
	];

	for (let round = 0; round < maxRounds; round += 1) {
		const res = await fetch(CHAT_URL, {
			method: "POST",
			signal: AbortSignal.timeout(120_000),
			headers: {
				Authorization: `Bearer ${apiKey()}`,
				"Content-Type": "application/json",
				"HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || "https://localhost",
				"X-Title": process.env.OPENROUTER_APP_TITLE || "agent-sandbox",
			},
			body: JSON.stringify({
				model,
				messages: chat,
				tools,
				temperature: 0.2,
				max_tokens: 4096,
			}),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || data.error) {
			throw new Error(data.error?.message || `OpenRouter HTTP ${res.status}`);
		}
		const message = data.choices?.[0]?.message;
		if (!message) throw new Error("empty model message");

		const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
		chat.push(message);

		if (!toolCalls.length) {
			const text = typeof message.content === "string" ? message.content : "";
			await emit({ type: "text", text });
			await emit({ type: "done" });
			return { text, rounds: round + 1 };
		}

		for (const call of toolCalls) {
			const name = call.function?.name;
			const args = parseArgs(call.function?.arguments);
			await emit({ type: "tool", name, args });
			let result;
			try {
				result = await execute(name, args);
			} catch (err) {
				result = { error: err.message };
			}
			await emit({ type: "tool_result", name, result });
			chat.push({
				role: "tool",
				tool_call_id: call.id,
				content: JSON.stringify(result).slice(0, 24_000),
			});
		}
	}

	await emit({ type: "text", text: "Stopped after max tool rounds." });
	await emit({ type: "done" });
	return { text: "Stopped after max tool rounds.", rounds: maxRounds };
}
