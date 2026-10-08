/**
 * SSRF guard: the agent drives a real browser, so only public http(s) hosts are allowed.
 * Set DIRECTORY_AGENT_ALLOW_PRIVATE=1 for local testing.
 */

import dns from "node:dns/promises";
import net from "node:net";

export const allowPrivate = () => process.env.DIRECTORY_AGENT_ALLOW_PRIVATE === "1";

export function isPrivateAddress(addr) {
	if (net.isIPv4(addr)) {
		const [a, b] = addr.split(".").map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	if (net.isIPv6(addr)) {
		const l = addr.toLowerCase();
		if (l.startsWith("::ffff:")) return isPrivateAddress(l.slice(7));
		return l === "::1" || l === "::" || /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
	}
	return false;
}

/** Sync hostname check (used per browser request, no DNS). */
export function isPrivateHostLiteral(hostname) {
	const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
		return true;
	}
	return net.isIP(h) ? isPrivateAddress(h) : false;
}

export async function assertPublicHttpUrl(raw, label = "URL") {
	let u;
	try {
		u = new URL(raw);
	} catch {
		throw new Error(`${label} is not a valid URL`);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		throw new Error(`${label} must be http(s)`);
	}
	if (allowPrivate()) return u.href;
	if (isPrivateHostLiteral(u.hostname)) {
		throw new Error(`${label} points to a private host`);
	}
	if (!net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) {
		try {
			const addrs = await dns.lookup(u.hostname, { all: true });
			if (addrs.some((a) => isPrivateAddress(a.address))) {
				throw new Error(`${label} resolves to a private address`);
			}
		} catch (e) {
			if (/private/.test(e.message)) throw e;
			throw new Error(`${label} host could not be resolved`);
		}
	}
	return u.href;
}
