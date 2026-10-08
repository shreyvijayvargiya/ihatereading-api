/**
 * Human action cards rendered by the dashboard.
 * actions[].id maps to POST /api/tasks/:id/<id>
 */

import { randomBytes } from "node:crypto";

const card = (type, title, message, actions, data = {}) => ({
	id: `card_${randomBytes(4).toString("hex")}`,
	type,
	title,
	message,
	actions,
	data,
	createdAt: new Date().toISOString(),
});

const APPROVE_DECLINE = [
	{ id: "approve", label: "Approve", style: "primary" },
	{ id: "decline", label: "Decline", style: "danger" },
];

const host = (u) => {
	try {
		return new URL(u).hostname;
	} catch {
		return u;
	}
};

export function loginCard(signals) {
	const provider = signals.login.provider;
	const hint = signals.login.blocked
		? " Google blocked this automated browser; set DIRECTORY_AGENT_CDP_URL (attach to your own Chrome) or DIRECTORY_AGENT_CHANNEL=chrome with DIRECTORY_AGENT_HEADLESS=false."
		: "";
	return card(
		"approval",
		`${provider ? `${provider} ` : ""}Login Required`,
		`Agent detected authentication requirement on ${host(signals.url)}. Approve to open the live browser and sign in yourself.${hint}`,
		APPROVE_DECLINE,
		{ kind: "login", provider, url: signals.url },
	);
}

export function captchaCard(signals) {
	return card(
		"approval",
		"CAPTCHA Required",
		`${signals.captcha.kind || "A challenge"} must be solved by a human on ${host(signals.url)}. Approve to open the live browser.`,
		APPROVE_DECLINE,
		{ kind: "captcha", url: signals.url },
	);
}

export function continueCard(task) {
	const kind = task.state === "WAITING_FOR_CAPTCHA" ? "solve the CAPTCHA" : "log in";
	return card(
		"continue",
		"Live browser open",
		`Use the live browser below to ${kind}, then click Continue. The agent resumes from where it paused.`,
		[
			{ id: "resume", label: "Continue", style: "primary" },
			{ id: "cancel", label: "Cancel task", style: "danger" },
		],
		{ live: true },
	);
}

export function badgeCard(badge, note) {
	return card(
		"badge",
		"Badge Verification Required",
		(note ? `${note}\n\n` : "") +
			"The directory needs proof of ownership. Add the badge below to your website or GitHub README, then click Approve to verify.",
		[
			{ id: "approve", label: "Approve (badge added)", style: "primary" },
			{ id: "decline", label: "Decline", style: "danger" },
		],
		{
			badgeCode: badge.badgeCode,
			instructions: badge.instructions,
			verificationUrl: badge.verificationUrl,
			allowForce: Boolean(note),
		},
	);
}

export function githubBadgeCard(badge, repo) {
	return card(
		"github_badge",
		"Add badge automatically?",
		`The agent can clone ${repo}, add the badge to the README, commit and push, then verify it.`,
		[
			{ id: "approve", label: "Add badge automatically", style: "primary" },
			{ id: "decline", label: "I'll add it myself", style: "secondary" },
		],
		{ badgeCode: badge.badgeCode, repo },
	);
}

export function previewCard(preview, warnings = []) {
	return card(
		"preview",
		"Submission Preview",
		"Review what will be submitted. Nothing is sent until you press Submit.",
		[
			{ id: "approve", label: "Submit", style: "primary" },
			{ id: "decline", label: "Cancel", style: "danger" },
		],
		{ summary: preview.summary, fields: preview.fields, warnings, directory: preview.directory },
	);
}

export function confirmationCard(conf) {
	return card(
		"confirmation",
		"Waiting for directory review",
		`Submitted to ${conf.directory}. Expected review: ${conf.expectedReviewDate?.slice(0, 10) || "unknown"}. The agent will check status automatically.`,
		[
			{ id: "check-status", label: "Check status now", style: "primary" },
			{ id: "cancel", label: "Close task", style: "secondary" },
		],
		{ ...conf },
	);
}
