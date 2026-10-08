/** Rough USD rates per 1M tokens when OpenRouter does not return usage.cost */
const RATES_PER_M = {
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "openai/gpt-4o": { input: 2.5, output: 10 },
  "anthropic/claude-sonnet-4": { input: 3, output: 15 },
  "anthropic/claude-3.5-sonnet": { input: 3, output: 15 },
  "google/gemini-2.0-flash-001": { input: 0.1, output: 0.4 },
  default: { input: 0.5, output: 1.5 },
};

export function estimateCostUsd(model, promptTokens, completionTokens) {
  const key = String(model || "").toLowerCase();
  const rates =
    RATES_PER_M[key] ||
    Object.entries(RATES_PER_M).find(([k]) => key.includes(k.split("/").pop()))?.[1] ||
    RATES_PER_M.default;
  const input = (Number(promptTokens) || 0) / 1_000_000 * rates.input;
  const output = (Number(completionTokens) || 0) / 1_000_000 * rates.output;
  return Number((input + output).toFixed(6));
}

export function summarizeMessages(messages = []) {
  const system = messages.find((m) => m.role === "system")?.content || "";
  const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
  return {
    systemPreview: String(system).slice(0, 1200),
    promptPreview: String(user).slice(0, 4000),
    systemChars: String(system).length,
    promptChars: String(user).length,
  };
}

export function buildUsageRecord({
  label,
  phase,
  model,
  messages,
  usage,
  ok,
  error,
  latencyMs,
}) {
  const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
  const reportedCost = usage?.cost ?? usage?.total_cost ?? usage?.native_tokens_cost;
  const costUsd =
    reportedCost != null && Number.isFinite(Number(reportedCost))
      ? Number(Number(reportedCost).toFixed(6))
      : estimateCostUsd(model, promptTokens, completionTokens);

  const previews = summarizeMessages(messages);

  return {
    id: `llm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    label: label || phase || "chat",
    phase: phase || null,
    model: model || null,
    ok: Boolean(ok),
    error: error || null,
    latencyMs: latencyMs ?? null,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd,
    costEstimated: reportedCost == null,
    ...previews,
  };
}

export function rollupUsage(calls = []) {
  return {
    calls: calls.length,
    promptTokens: calls.reduce((a, c) => a + (c.promptTokens || 0), 0),
    completionTokens: calls.reduce((a, c) => a + (c.completionTokens || 0), 0),
    totalTokens: calls.reduce((a, c) => a + (c.totalTokens || 0), 0),
    costUsd: Number(calls.reduce((a, c) => a + (Number(c.costUsd) || 0), 0).toFixed(6)),
    failed: calls.filter((c) => !c.ok).length,
  };
}
