// Deep pruning functions for markdown content optimization
// Designed to remove low-value content and improve LLM performance

/**
 * Remove navigation and boilerplate sections
 */
const pruneContentStructure = (markdown) => {
	return (
		markdown
			// Remove navigation sections
			.replace(/^#+\s*Navigation.*$/gm, "")
			.replace(/^#+\s*Menu.*$/gm, "")
			.replace(/^#+\s*Nav.*$/gm, "")
			.replace(/^#+\s*Header.*$/gm, "")

			// Remove footer sections
			.replace(/^#+\s*Footer.*$/gm, "")
			.replace(/^#+\s*Bottom.*$/gm, "")

			// Remove sidebar sections
			.replace(/^#+\s*Sidebar.*$/gm, "")
			.replace(/^#+\s*Widget.*$/gm, "")

			// Remove comment sections
			.replace(/^#+\s*Comments.*$/gm, "")
			.replace(/^#+\s*Discussion.*$/gm, "")

			// Remove related content sections
			.replace(/^#+\s*Related.*$/gm, "")
			.replace(/^#+\s*Popular.*$/gm, "")
			.replace(/^#+\s*Trending.*$/gm, "")
			.replace(/^#+\s*Recommended.*$/gm, "")

			// Remove social media sections
			.replace(/^#+\s*Share.*$/gm, "")
			.replace(/^#+\s*Social.*$/gm, "")
			.replace(/^#+\s*Follow.*$/gm, "")

			// Remove advertisement sections
			.replace(/^#+\s*Ad.*$/gm, "")
			.replace(/^#+\s*Advertisement.*$/gm, "")
			.replace(/^#+\s*Sponsored.*$/gm, "")

			// Remove legal/boilerplate sections
			.replace(/^#+\s*Legal.*$/gm, "")
			.replace(/^#+\s*Terms.*$/gm, "")
			.replace(/^#+\s*Privacy.*$/gm, "")
			.replace(/^#+\s*Disclaimer.*$/gm, "")
	);
};

/**
 * Remove semantic boilerplate content
 */
const pruneSemanticContent = (markdown) => {
	const lines = markdown.split("\n");
	const prunedLines = lines.filter((line) => {
		const trimmedLine = line.trim();

		// Remove boilerplate text
		if (
			trimmedLine.includes("© 2024") ||
			trimmedLine.includes("© 2023") ||
			trimmedLine.includes("© 2022") ||
			trimmedLine.includes("All rights reserved") ||
			trimmedLine.includes("Privacy Policy") ||
			trimmedLine.includes("Terms of Service") ||
			trimmedLine.includes("Cookie Policy") ||
			trimmedLine.includes("Accept Cookies") ||
			trimmedLine.includes("Cookie Settings")
		) {
			return false;
		}

		// Remove social media links
		if (
			trimmedLine.includes("Follow us on") ||
			trimmedLine.includes("Share this") ||
			trimmedLine.includes("Tweet this") ||
			trimmedLine.includes("Like us on") ||
			trimmedLine.includes("Connect with us")
		) {
			return false;
		}

		// Remove navigation links
		if (trimmedLine.includes("Home") && trimmedLine.includes("|")) return false;
		if (trimmedLine.includes("About") && trimmedLine.includes("|"))
			return false;
		if (trimmedLine.includes("Contact") && trimmedLine.includes("|"))
			return false;
		if (trimmedLine.includes("Services") && trimmedLine.includes("|"))
			return false;

		// Remove empty or very short lines
		if (trimmedLine.length < 10) {
			// Keep important short lines like headings
			if (trimmedLine.startsWith("#")) return true;
			if (trimmedLine.startsWith("**") && trimmedLine.endsWith("**"))
				return true;
			if (trimmedLine.startsWith("*") && trimmedLine.endsWith("*")) return true;
			return false;
		}

		return true;
	});

	return prunedLines.join("\n");
};

/**
 * Score content sections and remove low-scoring ones
 */
const pruneWithScoring = (markdown) => {
	const sections = markdown.split(/(?=^#+\s)/m);

	const scoredSections = sections.map((section) => {
		let score = 0;
		const lines = section.split("\n");

		// Higher score for main content
		if (section.includes("##") || section.includes("###")) score += 5;
		if (section.includes("**") || section.includes("*")) score += 3;
		if (section.includes("```")) score += 4; // Code blocks
		if (section.includes("[") && section.includes("]")) score += 2; // Links
		if (section.includes("`")) score += 2; // Inline code

		// Score based on content length (but not too long)
		const contentLength = section.replace(/^#+\s.*$/gm, "").trim().length;
		if (contentLength > 50 && contentLength < 1000) score += 3;
		else if (contentLength >= 1000) score += 1; // Very long sections might be verbose

		// Lower score for navigation/boilerplate
		if (section.toLowerCase().includes("navigation")) score -= 10;
		if (section.toLowerCase().includes("footer")) score -= 10;
		if (section.toLowerCase().includes("sidebar")) score -= 10;
		if (section.toLowerCase().includes("header")) score -= 8;
		if (section.includes("©") || section.includes("All rights")) score -= 15;
		if (section.toLowerCase().includes("menu")) score -= 8;
		if (section.toLowerCase().includes("widget")) score -= 8;

		// Bonus for technical content
		if (
			section.includes("function") ||
			section.includes("class") ||
			section.includes("method")
		)
			score += 2;
		if (
			section.includes("API") ||
			section.includes("endpoint") ||
			section.includes("parameter")
		)
			score += 2;
		if (
			section.includes("example") ||
			section.includes("code") ||
			section.includes("snippet")
		)
			score += 3;

		return { section, score };
	});

	// Keep only high-scoring sections
	const threshold = -2; // Allow some sections with slightly negative scores
	return scoredSections
		.filter(({ score }) => score > threshold)
		.map(({ section }) => section)
		.join("\n");
};

/**
 * Remove duplicate content
 */
const removeDuplicates = (markdown) => {
	const lines = markdown.split("\n");
	const seen = new Set();
	const uniqueLines = [];

	lines.forEach((line) => {
		const normalized = line.trim().toLowerCase();
		if (!seen.has(normalized) || line.trim().startsWith("#")) {
			seen.add(normalized);
			uniqueLines.push(line);
		}
	});

	return uniqueLines.join("\n");
};

/**
 * Clean up excessive formatting
 */
const cleanupFormatting = (markdown) => {
	return (
		markdown
			// Remove excessive newlines
			.replace(/\n{3,}/g, "\n\n")

			// Remove excessive whitespace
			.replace(/\s{2,}/g, " ")

			// Clean up list formatting
			.replace(/^\s*[-*+]\s*\s+/gm, "- ")
			.replace(/^\s*\d+\.\s*\s+/gm, (match) => match.replace(/\s+/, " "))

			// Clean up heading formatting
			.replace(/^(#+)\s*\s+/gm, "$1 ")

			// Remove empty lines between list items
			.replace(/(\n- .*\n)\n+(- .*)/g, "$1\n$2")

			// Clean up code blocks
			.replace(/```\s*\n/g, "```\n")
			.replace(/\n\s*```/g, "\n```")

			.trim()
	);
};

/**
 * Main deep pruning function
 */
const deepPruneMarkdown = async (markdown) => {
	if (!markdown || typeof markdown !== "string") {
		return markdown;
	}

	let pruned = markdown;

	try {
		// Step 1: Structural pruning
		pruned = pruneContentStructure(pruned);

		// Step 2: Semantic pruning
		pruned = pruneSemanticContent(pruned);

		// Step 3: Content scoring
		pruned = pruneWithScoring(pruned);

		// Step 4: Remove duplicates
		// pruned = removeDuplicates(pruned);

		// Step 5: Clean up formatting
		pruned = cleanupFormatting(pruned);

		// Step 6: Final validation
		if (pruned.length < 100) {
			console.warn("Warning: Pruned content is very short, returning original");
			return markdown;
		}

		return pruned;
	} catch (error) {
		console.warn("Warning: Error during markdown pruning:", error.message);
		return markdown; // Return original if pruning fails
	}
};

export default deepPruneMarkdown;
