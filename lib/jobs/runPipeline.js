/**
 * Orchestrates a full SEO/GEO research run.
 *
 * 1. Site audit (scrapefast + llms.txt + __NEXT_DATA__)
 * 2. Keyword research (after audit — needs real niche)
 * 3–5. Question mining, competitors, AI visibility (parallel)
 * 6. Blog synthesis
 */

import { FieldValue } from "firebase-admin/firestore";
import {
	createDoc,
	updateRun,
	getSiteProfile,
	persistSiteProfilePatch,
} from "../geoPipeline/collections.js";
import { runSiteAudit } from "./siteAudit.js";
import { runKeywordResearch } from "./keywords.js";
import { runQuestionMining } from "./questions.js";
import { runCompetitorTracking } from "./competitors.js";
import { runAiVisibility } from "./aiVisibility.js";
import { runBlogIdeaSynthesis } from "./synthesize.js";

function hostFromUrl(url) {
	try {
		return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
	} catch {
		return "";
	}
}

export async function createSiteProfile({ userId, url, niche = null, description = null }) {
	const domain = hostFromUrl(url);
	return createDoc("siteProfiles", {
		userId: userId || "anonymous",
		url,
		domain,
		niche: niche || null,
		description: description || null,
		techStack: [],
	});
}

export async function createResearchRun({ siteProfileId, triggerType = "manual" }) {
	return createDoc("researchRuns", {
		siteProfileId,
		triggerType,
		status: "queued",
		stage: "queued",
		startedAt: FieldValue.serverTimestamp(),
		completedAt: null,
		error: null,
	});
}

/**
 * @param {string} runId
 * @param {{ scrapeOptions?: object }} [options]
 */
export async function executeResearchRun(runId, options = {}) {
	const { getRun } = await import("../geoPipeline/collections.js");
	const run = await getRun(runId);
	if (!run) throw new Error(`Run not found: ${runId}`);

	const siteProfile = await getSiteProfile(run.siteProfileId);
	if (!siteProfile) throw new Error(`Site profile not found: ${run.siteProfileId}`);

	await updateRun(runId, { status: "running", stage: "starting", error: null });

	try {
		// Stage 1: audit MUST complete before keywords (SPA + llms.txt grounding)
		const auditResult = await runSiteAudit({
			runId,
			siteProfile,
			scrapeOptions: options.scrapeOptions,
		});

		await persistSiteProfilePatch(run.siteProfileId, {
			niche: auditResult.niche,
			techStack: auditResult.techStack,
			description: auditResult.audit?.description || siteProfile.description,
			siteSummary: auditResult.siteSummary,
		});

		const enrichedProfile = {
			...siteProfile,
			niche: auditResult.niche,
			techStack: auditResult.techStack,
			description: auditResult.audit?.description || siteProfile.description,
			siteSummary: auditResult.siteSummary,
		};

		// Stage 2: keywords grounded in audit (replace any stale rows from old runs)
		await runKeywordResearch({
			runId,
			siteProfile: enrichedProfile,
			audit: auditResult,
			replaceExisting: true,
		});

		// Stages 3-5 in parallel
		await Promise.all([
			runQuestionMining({
				runId,
				siteProfile: enrichedProfile,
				audit: auditResult,
				scrapeOptions: options.scrapeOptions,
			}),
			runCompetitorTracking({
				runId,
				siteProfile: enrichedProfile,
				audit: auditResult,
				scrapeOptions: options.scrapeOptions,
			}),
			runAiVisibility({
				runId,
				siteProfile: enrichedProfile,
				audit: auditResult,
			}),
		]);

		// Stage 6
		await runBlogIdeaSynthesis({
			runId,
			siteProfile: enrichedProfile,
			audit: auditResult,
		});

		await updateRun(runId, {
			status: "done",
			stage: "complete",
			completedAt: FieldValue.serverTimestamp(),
		});
	} catch (err) {
		console.error("[pipeline] run failed:", err);
		await updateRun(runId, {
			status: "failed",
			stage: "failed",
			error: err?.message || String(err),
			completedAt: FieldValue.serverTimestamp(),
		});
		throw err;
	}
}

/** Fire-and-forget background runner */
export function scheduleResearchRun(runId, options = {}) {
	setImmediate(() => {
		executeResearchRun(runId, options).catch((err) => {
			console.error("[pipeline] background run error:", err?.message || err);
		});
	});
}
