/**
 * AirdropBounty.events editorial + business context for blog generation.
 */

export const AIRDROPBOUNTY_SITE_IDS = ["airdropbounty-events", "airdropbounty"];

export const AIRDROPBOUNTY_BRAND = {
	name: "AirdropBounty",
	domain: "https://airdropbounty.events",
	tagline: "Discover, track, and claim the best crypto airdrops and bounty campaigns.",
	audience:
		"Crypto natives, DeFi users, bounty hunters, and beginners looking for legitimate free-token opportunities without getting scammed.",
	voice:
		"Sharp, trustworthy, energetic — like a savvy friend in crypto who explains fast without dumbing it down. Confident but never hypey.",
	tone: [
		"practical and action-oriented",
		"skeptical of scams by default",
		"clear step-by-step when teaching",
		"uses real crypto vocabulary naturally",
		"no corporate fluff or AI filler",
	],
	style: [
		"Short punchy intro that hooks the reader in 2 sentences",
		"Use H2/H3 sections with specific titles (never generic labels like 'Direct Answer' or 'Practical Takeaway')",
		"Mix bullets, numbered steps, and short paragraphs",
		"Include caution callouts for scams, gas fees, deadlines",
		"End with a crisp summary or next-step CTA — not a bloated conclusion",
	],
	contentPillars: [
		"airdrop discovery and eligibility",
		"bounty campaign walkthroughs",
		"wallet safety and scam avoidance",
		"DeFi/Web3 onboarding for claimers",
		"project comparisons and tool guides",
	],
	avoid: [
		"textbook FAQ templates with headings like 'Direct Answer', 'Explanation', 'Example', 'Important Caveat', 'Related Questions', 'Practical Takeaway'",
		"generic AI blog intros ('In today's rapidly evolving...')",
		"invented statistics or fake citations",
		"promising guaranteed profits",
		"encouraging sharing private keys or seed phrases",
	],
};

export function isAirdropBountySite(siteId, site = {}) {
	const id = String(siteId || "").toLowerCase();
	const domain = String(site.domain || "").toLowerCase();
	return (
		AIRDROPBOUNTY_SITE_IDS.some((s) => id.includes(s)) ||
		domain.includes("airdropbounty")
	);
}
