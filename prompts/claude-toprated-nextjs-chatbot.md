# Cursor prompt — Next.js chatbot for Claude toprated

Paste this into Cursor in a Next.js App Router project (or a new one). Do not invent extra backend APIs — talk only to the existing ihatereading-api agent.

---

Build a simple full-page AI chatbot that streams from our Claude toprated agent.

## API (already live)

Base URL: `process.env.NEXT_PUBLIC_IHR_API_URL` (example `http://127.0.0.1:3002`).

`POST {API}/claude-toprated/chat`  
Headers: `Content-Type: application/json`  
Body:

```json
{
  "message": "latest user text",
  "messages": [{ "role": "user"|"assistant", "content": "..." }],
  "stream": true
}
```

Response is **SSE** (`text/event-stream`). Each line is `data: {json}\n\n`. Event `type` values:

- `start` — `{ model }`
- `status` — `{ status: "thinking", round }`
- `tool_call` — `{ id, name, arguments }`  (scrapers + Firestore table tools)
- `tool_result` — `{ id, name, ok, result }`
- `table` — `{ action, collection, docIds }` when a table was written
- `done` — `{ message, usage, tools, tables }`  (`message` is the assistant reply)
- `error` — `{ error }`

`GET {API}/claude-toprated` — agent info + tool names  
`GET {API}/claude-toprated/tables` — tables this agent created  
`GET {API}/claude-toprated/tables/:name` — rows in that collection

Do **not** use `EventSource` (GET-only). Use `fetch` + `ReadableStream` and parse SSE chunks.

## Product

One screen: ChatGPT-style thread.

- Textarea + Send. Enter submits, Shift+Enter newline.
- Keep `messages` in React state (`{ role, content }[]`). On send, append the user message, POST `message` plus prior `messages` (user+assistant only, no tool payloads).
- While streaming: show a “Thinking…” / current tool name chip (`scrape_maps`, `table_add_rows`, …). Append tool chips under the in-progress assistant bubble.
- On `done`, set assistant `content` to `event.message`. Show a small footer: collection names from `event.tables`, and token/cost from `event.usage` if present (`total_tokens`, `cost`).
- On `error`, show the error on that bubble; allow retry.
- Optional right drawer: fetch `/claude-toprated/tables` and list collection names; click one → `/claude-toprated/tables/:name` as a simple table (first 40 rows, `docId` + JSON fields).
- Tailwind, dark-friendly, no auth, no extra pages except optional `/` only.
- CORS is already enabled on the API. If you proxy, add `app/api/claude-toprated/chat/route.ts` that forwards POST to the API and pipes the SSE body through — useful to hide the API origin. Direct browser `fetch` to `NEXT_PUBLIC_IHR_API_URL` is also fine.

## SSE parser sketch

```ts
async function readSse(
  res: Response,
  onEvent: (e: any) => void,
) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()));
      } catch {}
    }
  }
}
```

## Copy

Placeholder: “Scrape maps, X, GitHub… then save as a Firestore table.”  
Example chips the user can click:  
- `Find 10 cafes in Jaipur and save them as collection jaipur-cafes`  
- `Scrape https://github.com/vercel/next.js and store repo stats`  
- `Look up @levelsio on X and Instagram, save one row in indie-hackers`

Ship a working `app/page.tsx` chatbot, not a design mock.
