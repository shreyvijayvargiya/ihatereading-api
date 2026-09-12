export function uiHtml() {
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>agent sandbox</title>
  <style>
    :root {
      --bg: #0e110c;
      --panel: #161b13;
      --line: #2a3324;
      --ink: #e7ecd9;
      --mute: #8b9478;
      --accent: #d6f26a;
      --warn: #ffb4a8;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    header {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
    }
    header h1 {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin: 0;
    }
    header .meta { color: var(--mute); font-size: 12px; margin-left: auto; }
    header input, header button, textarea, .chat-form button {
      font: inherit;
      background: var(--panel);
      color: var(--ink);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 10px;
    }
    header button, .chat-form button {
      background: var(--accent);
      color: #182008;
      font-weight: 650;
      border: 0;
      cursor: pointer;
    }
    .grid {
      display: grid;
      grid-template-columns: 240px 1fr 1.15fr;
      grid-template-rows: 1fr 180px;
      height: calc(100% - 53px);
    }
    .files, .chat, .term { border-right: 1px solid var(--line); overflow: auto; }
    .preview { border-bottom: 1px solid var(--line); }
    .term { grid-column: 1 / 3; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #c5d1a8; }
    .files { padding: 12px; font-size: 13px; }
    .files button.file {
      display: block; width: 100%; text-align: left; background: none; border: 0;
      color: var(--ink); padding: 4px 0; cursor: pointer; font: inherit;
    }
    .files button.file:hover { color: var(--accent); }
    .chat { display: flex; flex-direction: column; min-height: 0; }
    .log { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .bubble { padding: 10px 12px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); white-space: pre-wrap; font-size: 13px; line-height: 1.45; }
    .bubble.user { background: #222818; }
    .bubble.tool { color: var(--mute); font-family: ui-monospace, monospace; font-size: 12px; }
    .chat-form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--line); }
    .chat-form textarea { flex: 1; min-height: 52px; resize: none; }
    iframe { width: 100%; height: 100%; border: 0; background: #111; }
    .code { margin: 0; padding: 12px; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; color: var(--mute); }
    @media (max-width: 960px) {
      .grid { grid-template-columns: 1fr; grid-template-rows: 180px 280px 360px 160px; }
      .term { grid-column: 1; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Agent sandbox</h1>
    <label>session <input id="session" value="default" size="12" /></label>
    <label>token <input id="token" type="password" size="10" placeholder="optional" /></label>
    <button id="refresh" type="button">refresh files</button>
    <button id="rebuild" type="button">rebuild react</button>
    <span class="meta">fs · shell · http · react · one /v1/exec RPC</span>
  </header>
  <div class="grid">
    <aside class="files" id="files"></aside>
    <section class="chat">
      <div class="log" id="log"></div>
      <form class="chat-form" id="form">
        <textarea id="prompt" placeholder="Ask the agent to edit files, curl an API, run a command, or render React…"></textarea>
        <button type="submit">run</button>
      </form>
    </section>
    <section class="preview"><iframe id="frame" title="react preview"></iframe></section>
    <pre class="term" id="term">shell + tool output\n</pre>
    <pre class="code" id="code">select a file</pre>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    const session = () => $("session").value.trim() || "default";
    const token = () => $("token").value.trim();
    const headers = () => {
      const h = {
        "content-type": "application/json",
        "x-sandbox-session": session(),
      };
      if (token()) h["x-sandbox-token"] = token();
      return h;
    };

    function addBubble(cls, text) {
      const el = document.createElement("div");
      el.className = "bubble " + cls;
      el.textContent = text;
      $("log").appendChild(el);
      $("log").scrollTop = $("log").scrollHeight;
    }

    async function exec(tool, input = {}) {
      const res = await fetch("/v1/exec", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ tool, input }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "exec failed");
      return data.result;
    }

    async function refreshFiles() {
      const result = await exec("fs_list", { path: "." });
      $("files").innerHTML = "<strong>workspace</strong>";
      for (const item of result.items || []) {
        const b = document.createElement("button");
        b.className = "file";
        b.type = "button";
        b.textContent = (item.type === "dir" ? "▸ " : "  ") + item.path;
        b.onclick = async () => {
          if (item.type === "dir") return;
          const file = await exec("fs_read", { path: item.path });
          $("code").textContent = file.content;
        };
        $("files").appendChild(b);
      }
    }

    function reloadPreview() {
      $("frame").src = "/preview?session=" + encodeURIComponent(session())
        + (token() ? "&token=" + encodeURIComponent(token()) : "")
        + "&t=" + Date.now();
    }

    $("refresh").onclick = () => refreshFiles().catch((e) => addBubble("tool", e.message));
    $("rebuild").onclick = async () => {
      const r = await exec("react_preview", {});
      $("term").textContent += "\\nreact_preview " + JSON.stringify(r);
      reloadPreview();
    };

    $("form").onsubmit = async (e) => {
      e.preventDefault();
      const message = $("prompt").value.trim();
      if (!message) return;
      $("prompt").value = "";
      addBubble("user", message);
      const res = await fetch("/v1/chat", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ message }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\\n\\n");
        buf = parts.pop();
        for (const part of parts) {
          const line = part.split("\\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "text") addBubble("assistant", ev.text || "");
          if (ev.type === "tool") {
            addBubble("tool", ev.name + " " + JSON.stringify(ev.args));
            $("term").textContent += "\\n$ " + ev.name;
          }
          if (ev.type === "tool_result") {
            $("term").textContent += "\\n" + JSON.stringify(ev.result).slice(0, 4000);
            $("term").scrollTop = $("term").scrollHeight;
          }
          if (ev.type === "error") addBubble("tool", ev.error);
        }
      }
      await refreshFiles();
      reloadPreview();
    };

    refreshFiles().catch(() => {});
    reloadPreview();
  </script>
</body>
</html>`;
}
