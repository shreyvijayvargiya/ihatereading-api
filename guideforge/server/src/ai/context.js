import { AsyncLocalStorage } from "node:async_hooks";

/** Per-request LLM tracking context: { jobId, phase, label } */
export const llmContext = new AsyncLocalStorage();

export function runWithLlmContext(ctx, fn) {
  return llmContext.run(ctx || {}, fn);
}

export function getLlmContext() {
  return llmContext.getStore() || null;
}
