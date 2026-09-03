/**
 * karyam.xyz agency Reddit monitor — RSS only, CLI/API triggered.
 */

import { getAgent } from "./configs.js";
import { runRssAgent } from "./core.js";

export async function runKaryamAgent(opts = {}) {
	const agent = getAgent("karyam");
	if (!agent) throw new Error("karyam agent config missing");
	return runRssAgent(agent, { llm: opts.llm, enrich: opts.enrich });
}
