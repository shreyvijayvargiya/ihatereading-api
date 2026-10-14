/** Shared helpers for platform adapters. */

/**
 * Build an Error from a failed HTTP response. 4xx (except 408/429) are
 * marked `permanent` so the scheduler does not retry them.
 */
export async function httpError(res, label) {
	const text = await res.text().catch(() => "");
	const err = new Error(`${label} ${res.status}: ${text.slice(0, 300)}`);
	err.status = res.status;
	err.permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
	return err;
}

export function requireEnv(name) {
	const v = process.env[name]?.trim();
	if (!v) {
		const err = new Error(`${name} is not set`);
		err.permanent = true;
		throw err;
	}
	return v;
}
