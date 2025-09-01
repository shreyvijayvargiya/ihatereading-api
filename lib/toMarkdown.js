export default function toMarkdown(data) {
	if (!data || typeof data !== "object") {
		throw new Error("Invalid data provided for markdown conversion");
	}

	let md = "";

	// Add title if available
	if (data.title) {
		md += `# ${data.title}

`;
	}

	// Add H1 headings if available
	if (data.content && data.content.h1 && Array.isArray(data.content.h1)) {
		data.content.h1.forEach((h) => {
			if (h && h.trim()) {
				md += `# ${h.trim()}

`;
			}
		});
	}

	// Add H2 headings if available
	if (data.content && data.content.h2 && Array.isArray(data.content.h2)) {
		data.content.h2.forEach((h) => {
			if (h && h.trim()) {
				md += `## ${h.trim()}

`;
			}
		});
	}

	// Add H3 headings if available
	if (data.content && data.content.h3 && Array.isArray(data.content.h3)) {
		data.content.h3.forEach((h) => {
			if (h && h.trim()) {
				md += `### ${h.trim()}

`;
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
				md += `${div.trim()}

`;
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
				md += `${el.trim()}

`;
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
				md += `${p.trim()}

`;
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
				md += `${p.trim()}

`;
			}
		});
	}

	// Add code blocks if available
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.codeBlocks &&
		Array.isArray(data.content.semanticContent.codeBlocks)
	) {
		data.content.semanticContent.codeBlocks.forEach((code) => {
			if (code && code.trim()) {
				md += `\`${code.trim()}\`

`;
			}
		});
	}

	// Add pre-formatted code blocks if available
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.preformatted &&
		Array.isArray(data.content.semanticContent.preformatted)
	) {
		data.content.semanticContent.preformatted.forEach((pre) => {
			if (pre && pre.trim()) {
				md += `\`\`\`
${pre.trim()}
\`\`\`

`;
			}
		});
	}

	// Add tables if available
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.tables &&
		Array.isArray(data.content.semanticContent.tables)
	) {
		data.content.semanticContent.tables.forEach((table, tableIndex) => {
			if (table && table.rows && Array.isArray(table.rows)) {
				// Add table caption if available
				if (table.caption) {
					md += `**Table ${tableIndex + 1}: ${table.caption}**

`;
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
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.unorderedLists &&
		Array.isArray(data.content.semanticContent.unorderedLists)
	) {
		data.content.semanticContent.unorderedLists.forEach((list) => {
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
		data.content.semanticContent &&
		data.content.semanticContent.orderedLists &&
		Array.isArray(data.content.semanticContent.orderedLists)
	) {
		data.content.semanticContent.orderedLists.forEach((list) => {
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

	// Add blockquotes if available
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.blockquotes &&
		Array.isArray(data.content.semanticContent.blockquotes)
	) {
		data.content.semanticContent.blockquotes.forEach((quote) => {
			if (quote && quote.trim()) {
				md += `> ${quote.trim()}

`;
			}
		});
	}

	// Add horizontal rules if available
	if (data.content && data.content.hr && Array.isArray(data.content.hr)) {
		data.content.hr.forEach(() => {
			md += `---

`;
		});
	}

	// Add links if available
	if (data.links && Array.isArray(data.links)) {
		md += "## Links \n\n";
		data.links.forEach((link) => {
			if (link && link.href && link.text) {
				md += `- [${link.text.trim()}](${link.href})\n`;
			}
		});
		md += "\n";
	}

	// Add images if available
	if (data.images && Array.isArray(data.images)) {
		md += "## Images \n\n";
		data.images.forEach((img) => {
			if (img && img.url) {
				const alt = img.alt || img.title || "Image";
				md += `![${alt}](${img.url})\n\n`;
			}
		});
	}

	// Add metadata if available
	if (data.metadata) {
		md += "## Metadata \n\n";
		if (data.metadata.description) {
			md += `**Description:** ${data.metadata.description} \n\n`;
		}
		if (data.metadata.keywords) {
			md += `**Keywords:** ${
				Array.isArray(data.metadata.keywords)
					? data.metadata.keywords.join(", ")
					: data.metadata.keywords
			} \n\n`;
		}
		if (data.metadata.author) {
			md += `**Author:** ${
				data.metadata["og:author"] || data.metadata["author"]
			} \n\n`;
		}
		if (data.metadata.date) {
			md += `**Date:** ${data.metadata.date} \n\n`;
		}
	}

	// Add URL information
	if (data.url) {
		md += `**Source URL:** ${data.url} \n\n`;
	}

	// Add timestamp
	md += `**Generated:** ${new Date().toISOString()} \n\n`;

	return md.trim();
}
