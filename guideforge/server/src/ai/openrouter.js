import { getEnv } from "../config/env.js";
import { getLlmContext } from "./context.js";
import { buildUsageRecord } from "./usage.js";
import { appendLlmCall } from "../storage/jobs.js";

function parseJsonLoose(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model did not return JSON");
  return JSON.parse(body.slice(start, end + 1));
}

async function recordCall(record) {
  const ctx = getLlmContext();
  const enriched = {
    ...record,
    phase: record.phase || ctx?.phase || null,
    label: record.label || ctx?.label || record.phase || "chat",
  };
  console.log(
    `[guideforge:llm] ${enriched.ok ? "ok" : "fail"} ${enriched.label} model=${enriched.model} tokens=${enriched.totalTokens} cost=$${enriched.costUsd}${enriched.costEstimated ? "~" : ""} ${enriched.latencyMs || 0}ms${enriched.error ? ` err=${enriched.error}` : ""}`,
  );
  if (ctx?.jobId) {
    try {
      await appendLlmCall(ctx.jobId, enriched);
    } catch (err) {
      console.warn("[guideforge:llm] failed to persist usage:", err.message);
    }
  }
  return enriched;
}

export async function chat({
  system,
  messages = [],
  prompt,
  temperature = 0.3,
  maxTokens = 4000,
  json = false,
  model,
  label,
} = {}) {
  const env = getEnv();
  if (!env.openRouterKey) {
    throw new Error("OPENROUTER_API_KEY is not set in guideforge/server/.env");
  }
  const msgs = [];
  if (system) msgs.push({ role: "system", content: system });
  if (prompt) msgs.push({ role: "user", content: prompt });
  msgs.push(...messages);

  const body = {
    model: model || env.openRouterModel,
    temperature,
    max_tokens: maxTokens,
    messages: msgs,
  };
  if (json) body.response_format = { type: "json_object" };

  const started = Date.now();
  const ctx = getLlmContext();
  let recorded = false;

  const finish = async (partial) => {
    recorded = true;
    return recordCall(
      buildUsageRecord({
        label: label || ctx?.label,
        phase: ctx?.phase,
        model: partial.model || body.model,
        messages: msgs,
        usage: partial.usage,
        ok: partial.ok,
        error: partial.error,
        latencyMs: Date.now() - started,
      }),
    );
  };

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ihatereading.in",
        "X-Title": "GuideForge",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.error) {
      const error = data.error?.message || data.error || `OpenRouter HTTP ${res.status}`;
      await finish({ ok: false, error: String(error), usage: data.usage, model: body.model });
      throw new Error(error);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      await finish({ ok: false, error: "Empty content", usage: data.usage, model: data.model || body.model });
      throw new Error("OpenRouter returned empty content");
    }

    const usageRecord = await finish({
      ok: true,
      usage: data.usage,
      model: data.model || body.model,
    });

    return {
      content: String(content),
      model: data.model || body.model,
      usage: data.usage || null,
      usageRecord,
    };
  } catch (err) {
    if (!recorded) {
      await finish({ ok: false, error: err.message, model: body.model });
    }
    throw err;
  }
}

export async function chatJson(options) {
  try {
    const result = await chat({ ...options, json: true });
    return { ...result, data: parseJsonLoose(result.content) };
  } catch (err) {
    if (/response_format|json_object|json mode/i.test(err.message)) {
      const result = await chat({ ...options, json: false });
      return { ...result, data: parseJsonLoose(result.content) };
    }
    throw err;
  }
}

export { parseJsonLoose };
