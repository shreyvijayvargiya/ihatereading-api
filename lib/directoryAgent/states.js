/**
 * Task state machine for the human-in-the-loop directory submission agent.
 */

export const STATES = Object.freeze({
	QUEUED: "QUEUED",
	RUNNING: "RUNNING",
	WAITING_FOR_LOGIN: "WAITING_FOR_LOGIN",
	WAITING_FOR_CAPTCHA: "WAITING_FOR_CAPTCHA",
	WAITING_FOR_BADGE: "WAITING_FOR_BADGE",
	WAITING_FOR_APPROVAL: "WAITING_FOR_APPROVAL",
	WAITING_FOR_CONFIRMATION: "WAITING_FOR_CONFIRMATION",
	COMPLETED: "COMPLETED",
	FAILED: "FAILED",
	CANCELLED: "CANCELLED",
});

export const WAITING_STATES = new Set([
	STATES.WAITING_FOR_LOGIN,
	STATES.WAITING_FOR_CAPTCHA,
	STATES.WAITING_FOR_BADGE,
	STATES.WAITING_FOR_APPROVAL,
	STATES.WAITING_FOR_CONFIRMATION,
]);

export const TERMINAL_STATES = new Set([
	STATES.COMPLETED,
	STATES.FAILED,
	STATES.CANCELLED,
]);

const ending = [STATES.FAILED, STATES.CANCELLED];

/** Waiting states only ever resume through RUNNING (or end). */
const ALLOWED = {
	[STATES.QUEUED]: [STATES.RUNNING, ...ending],
	[STATES.RUNNING]: [
		STATES.QUEUED,
		...WAITING_STATES,
		STATES.COMPLETED,
		...ending,
	],
	[STATES.WAITING_FOR_LOGIN]: [STATES.RUNNING, ...ending],
	[STATES.WAITING_FOR_CAPTCHA]: [STATES.RUNNING, ...ending],
	[STATES.WAITING_FOR_BADGE]: [STATES.RUNNING, ...ending],
	[STATES.WAITING_FOR_APPROVAL]: [STATES.RUNNING, ...ending],
	[STATES.WAITING_FOR_CONFIRMATION]: [
		STATES.RUNNING,
		STATES.COMPLETED,
		...ending,
	],
	[STATES.COMPLETED]: [],
	[STATES.FAILED]: [],
	[STATES.CANCELLED]: [],
};

export function canTransition(from, to) {
	return from === to || (ALLOWED[from] || []).includes(to);
}

export function statusFor(state) {
	if (state === STATES.QUEUED) return "queued";
	if (state === STATES.RUNNING) return "running";
	if (WAITING_STATES.has(state)) return "paused";
	if (state === STATES.COMPLETED) return "completed";
	if (state === STATES.FAILED) return "failed";
	return "cancelled";
}

export const isWaiting = (state) => WAITING_STATES.has(state);
export const isTerminal = (state) => TERMINAL_STATES.has(state);

/** States where the human may drive the live browser. */
export const LIVE_CONTROL_STATES = new Set([
	STATES.WAITING_FOR_LOGIN,
	STATES.WAITING_FOR_CAPTCHA,
	STATES.WAITING_FOR_BADGE,
	STATES.WAITING_FOR_APPROVAL,
]);

/** Max time a task may stay paused for human input (confirmation waits are exempt). */
export const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;
