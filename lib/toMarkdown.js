export default function toMarkdown(data) {
	if (!data || typeof data !== "object") {
		throw new Error("Invalid data provided for markdown conversion");
	}

	let md = "";

	// Add title if available
	if (data.title) {
		md += `# ${data.title}\n\n`;
	}

	// Add H1 headings if available
	if (data.content && data.content.h1 && Array.isArray(data.content.h1)) {
		data.content.h1.forEach((h) => {
			if (h && h.trim()) {
				md += `# ${h.trim()}\n\n`;
			}
		});
	}

	// Add H2 headings if available
	if (data.content && data.content.h2 && Array.isArray(data.content.h2)) {
		data.content.h2.forEach((h) => {
			if (h && h.trim()) {
				md += `## ${h.trim()}\n\n`;
			}
		});
	}

	// Add H3 headings if available
	if (data.content && data.content.h3 && Array.isArray(data.content.h3)) {
		data.content.h3.forEach((h) => {
			if (h && h.trim()) {
				md += `### ${h.trim()}\n\n`;
			}
		});
	}

	// Add H4 headings if available
	if (data.content && data.content.h4 && Array.isArray(data.content.h4)) {
		data.content.h4.forEach((h) => {
			if (h && h.trim()) {
				md += `#### ${h.trim()}\n\n`;
			}
		});
	}

	// Add H5 headings if available
	if (data.content && data.content.h5 && Array.isArray(data.content.h5)) {
		data.content.h5.forEach((h) => {
			if (h && h.trim()) {
				md += `##### ${h.trim()}\n\n`;
			}
		});
	}

	// Add H6 headings if available
	if (data.content && data.content.h6 && Array.isArray(data.content.h6)) {
		data.content.h6.forEach((h) => {
			if (h && h.trim()) {
				md += `###### ${h.trim()}\n\n`;
			}
		});
	}

	// Fix: Add divs from semantic content if available
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.divs &&
		Array.isArray(data.content.semanticContent.divs)
	) {
		data.content.semanticContent.divs.forEach((div) => {
			if (div && div.trim()) {
				md += `${div.trim()}\n\n`;
			}
		});
	}

	// Add spans from semantic content if available
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.span &&
		Array.isArray(data.content.semanticContent.span)
	) {
		data.content.semanticContent.span.forEach((el) => {
			if (el && el.trim()) {
				md += `${el.trim()}\n\n`;
			}
		});
	}

	// Add paragraphs from semantic content if available
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.paragraphs &&
		Array.isArray(data.content.semanticContent.paragraphs)
	) {
		data.content.semanticContent.paragraphs.forEach((p) => {
			if (p && p.trim()) {
				md += `${p.trim()}\n\n`;
			}
		});
	}

	// Add regular paragraphs if available
	if (
		data.content &&
		data.content.paragraphs &&
		Array.isArray(data.content.paragraphs)
	) {
		data.content.paragraphs.forEach((p) => {
			if (p && p.trim()) {
				md += `${p.trim()}\n\n`;
			}
		});
	}

	// Add code blocks if available
	if (
		data.content &&
		data.content.code &&
		data.content.code.codeBlocks &&
		Array.isArray(data.content.code.codeBlocks)
	) {
		data.content.code.codeBlocks.forEach((code) => {
			if (code && code.trim()) {
				md += `\`${code.trim()}\`\n\n`;
			}
		});
	}

	// Add pre-formatted code blocks if available
	if (
		data.content &&
		data.content.code &&
		data.content.code.preBlocks &&
		Array.isArray(data.content.code.preBlocks)
	) {
		data.content.code.preBlocks.forEach((pre) => {
			if (pre && pre.trim()) {
				md += `\`\`\`\n${pre.trim()}\n\`\`\`\n\n`;
			}
		});
	}

	// Add tables if available
	if (
		data.content &&
		data.content.tables &&
		Array.isArray(data.content.tables)
	) {
		data.content.tables.forEach((table, tableIndex) => {
			if (table && table.rows && Array.isArray(table.rows)) {
				// Add table caption if available
				if (table.caption) {
					md += `**Table ${tableIndex + 1}: ${table.caption}**\n\n`;
				}

				// Create table header
				if (
					table.rows.length > 0 &&
					table.rows[0].headers &&
					table.rows[0].headers.length > 0
				) {
					md += `| ${table.rows[0].headers.join(" | ")} |\n`;
					md += `| ${table.rows[0].headers.map(() => "---").join(" | ")} |\n`;
				}

				// Add table rows
				table.rows.forEach((row) => {
					if (row.cells && Array.isArray(row.cells) && row.cells.length > 0) {
						md += `| ${row.cells.join(" | ")} |\n`;
					}
				});
				md += "\n";
			}
		});
	}

	// Add lists if available
	if (data.content && data.content.lists && Array.isArray(data.content.lists)) {
		data.content.lists.forEach((list) => {
			if (list && Array.isArray(list.items)) {
				list.items.forEach((item) => {
					if (item && item.trim()) {
						md += `- ${item.trim()}\n`;
					}
				});
				md += "\n";
			}
		});
	}

	// Add ordered lists if available
	if (
		data.content &&
		data.content.lists &&
		data.content.lists.ordered &&
		Array.isArray(data.content.lists.ordered)
	) {
		data.content.lists.ordered.forEach((list) => {
			if (list && Array.isArray(list.items)) {
				list.items.forEach((item, index) => {
					if (item && item.trim()) {
						md += `${index + 1}. ${item.trim()}\n`;
					}
				});
				md += "\n";
			}
		});
	}

	// Add unordered lists if available
	if (
		data.content &&
		data.content.lists &&
		data.content.lists.unordered &&
		Array.isArray(data.content.lists.unordered)
	) {
		data.content.lists.unordered.forEach((list) => {
			if (list && Array.isArray(list.items)) {
				list.items.forEach((item) => {
					if (item && item.trim()) {
						md += `- ${item.trim()}\n`;
					}
				});
				md += "\n";
			}
		});
	}

	// Add blockquotes if available
	if (
		data.content &&
		data.content.blockquotes &&
		Array.isArray(data.content.blockquotes)
	) {
		data.content.blockquotes.forEach((quote) => {
			if (quote && quote.trim()) {
				md += `> ${quote.trim()}\n\n`;
			}
		});
	}

	// Add horizontal rules if available
	if (data.content && data.content.hr && Array.isArray(data.content.hr)) {
		data.content.hr.forEach(() => {
			md += `---\n\n`;
		});
	}

	// Add links if available
	if (data.content && data.content.links && Array.isArray(data.content.links)) {
		md += "## Links\n\n";
		data.content.links.forEach((link) => {
			if (link && link.href && link.text) {
				md += `- [${link.text.trim()}](${link.href})\n`;
			}
		});
		md += "\n";
	}

	// Add images if available
	if (
		data.content &&
		data.content.images &&
		Array.isArray(data.content.images)
	) {
		md += "## Images\n\n";
		data.content.images.forEach((img) => {
			if (img && img.url) {
				const alt = img.alt || img.title || "Image";
				md += `![${alt}](${img.url})\n\n`;
			}
		});
	}

	// Add metadata if available
	if (data.meta) {
		md += "## Metadata\n\n";
		if (data.meta.description) {
			md += `**Description:** ${data.meta.description}\n\n`;
		}
		if (data.meta.keywords) {
			md += `**Keywords:** ${data.meta.keywords.join(", ")}\n\n`;
		}
		if (data.meta.author) {
			md += `**Author:** ${data.meta.author}\n\n`;
		}
		if (data.meta.date) {
			md += `**Date:** ${data.meta.date}\n\n`;
		}
	}

	// Add URL information
	if (data.url) {
		md += `**Source URL:** ${data.url}\n\n`;
	}

	// Add timestamp
	md += `**Generated:** ${new Date().toISOString()}\n\n`;

	return md.trim();
}
