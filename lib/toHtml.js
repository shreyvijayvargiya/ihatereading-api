import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkHtml from "remark-html";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

export default function toHtml(data) {
	if (!data || typeof data !== "object") {
		throw new Error("Invalid data provided for HTML conversion");
	}

	let html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n';
	html += '<meta charset="UTF-8">\n';
	html +=
		'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n';
	html += "<title>" + (data.title || "Scraped Content") + "</title>\n";
	html += "<style>\n";
	html +=
		'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }\n';
	html +=
		"h1, h2, h3, h4, h5, h6 { color: #333; margin-top: 30px; margin-bottom: 15px; }\n";
	html +=
		"h1 { font-size: 2.5em; border-bottom: 3px solid #007acc; padding-bottom: 10px; }\n";
	html +=
		"h2 { font-size: 2em; border-bottom: 2px solid #e1e1e1; padding-bottom: 8px; }\n";
	html += "h3 { font-size: 1.5em; color: #555; }\n";
	html += "h4, h5, h6 { font-size: 1.2em; color: #666; }\n";
	html += "p { margin-bottom: 15px; text-align: justify; }\n";
	html += "ul, ol { margin-bottom: 20px; padding-left: 30px; }\n";
	html += "li { margin-bottom: 8px; }\n";
	html +=
		"blockquote { border-left: 4px solid #007acc; margin: 20px 0; padding: 10px 20px; background: #f9f9f9; font-style: italic; }\n";
	html +=
		'code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-family: "Courier New", monospace; }\n';
	html +=
		"pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; margin: 20px 0; }\n";
	html += "table { width: 100%; border-collapse: collapse; margin: 20px 0; }\n";
	html +=
		"th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }\n";
	html += "th { background-color: #f2f2f2; font-weight: bold; }\n";
	html += "tr:nth-child(even) { background-color: #f9f9f9; }\n";
	html += "a { color: #007acc; text-decoration: none; }\n";
	html += "a:hover { text-decoration: underline; }\n";
	html +=
		"img { max-width: 100%; height: auto; border-radius: 5px; margin: 10px 0; }\n";
	html +=
		".metadata { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; }\n";
	html += ".metadata h3 { margin-top: 0; }\n";
	html += ".metadata p { margin: 5px 0; }\n";
	html +=
		".links-section, .images-section { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; }\n";
	html +=
		".source-url { background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0; }\n";
	html +=
		".timestamp { color: #666; font-size: 0.9em; text-align: center; margin-top: 40px; padding-top: 20px; border-top: 1px solid #e1e1e1; }\n";
	html += "</style>\n</head>\n<body>\n";

	// Add title if available
	if (data.title) {
		html += `<h1>${escapeHtml(data.title)}</h1>\n`;
	}

	// Add H1 headings if available
	if (data.content && data.content.h1 && Array.isArray(data.content.h1)) {
		data.content.h1.forEach((h) => {
			if (h && h.trim()) {
				html += `<h1>${escapeHtml(h.trim())}</h1>\n`;
			}
		});
	}

	// Add H2 headings if available
	if (data.content && data.content.h2 && Array.isArray(data.content.h2)) {
		data.content.h2.forEach((h) => {
			if (h && h.trim()) {
				html += `<h2>${escapeHtml(h.trim())}</h2>\n`;
			}
		});
	}

	// Add H3 headings if available
	if (data.content && data.content.h3 && Array.isArray(data.content.h3)) {
		data.content.h3.forEach((h) => {
			if (h && h.trim()) {
				html += `<h3>${escapeHtml(h.trim())}</h3>\n`;
			}
		});
	}

	// Add H4 headings if available
	if (data.content && data.content.h4 && Array.isArray(data.content.h4)) {
		data.content.h4.forEach((h) => {
			if (h && h.trim()) {
				html += `<h4>${escapeHtml(h.trim())}</h4>\n`;
			}
		});
	}

	// Add H5 headings if available
	if (data.content && data.content.h5 && Array.isArray(data.content.h5)) {
		data.content.h5.forEach((h) => {
			if (h && h.trim()) {
				html += `<h5>${escapeHtml(h.trim())}</h5>\n`;
			}
		});
	}

	// Add H6 headings if available
	if (data.content && data.content.h6 && Array.isArray(data.content.h6)) {
		data.content.h6.forEach((h) => {
			if (h && h.trim()) {
				html += `<h6>${escapeHtml(h.trim())}</h6>\n`;
			}
		});
	}

	// Add divs from semantic content if available
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.divs &&
		Array.isArray(data.content.semanticContent.divs)
	) {
		data.content.semanticContent.divs.forEach((div) => {
			if (div && div.trim()) {
				html += `<div>${escapeHtml(div.trim())}</div>\n`;
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
				html += `<span>${escapeHtml(el.trim())}</span>\n`;
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
				html += `<p>${escapeHtml(p.trim())}</p>\n`;
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
				html += `<p>${escapeHtml(p.trim())}</p>\n`;
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
				html += `<code>${escapeHtml(code.trim())}</code>\n`;
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
				html += `<pre><code>${escapeHtml(pre.trim())}</code></pre>\n`;
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
			if (table && Array.isArray(table)) {
				html += `<table>\n`;

				// Add table rows
				table.forEach((row, rowIndex) => {
					if (Array.isArray(row) && row.length > 0) {
						if (rowIndex === 0) {
							// First row as header
							html += "<thead>\n<tr>\n";
							row.forEach((cell) => {
								html += `<th>${escapeHtml(cell)}</th>\n`;
							});
							html += "</tr>\n</thead>\n";
						} else {
							// Data rows
							if (rowIndex === 1) html += "<tbody>\n";
							html += "<tr>\n";
							row.forEach((cell) => {
								html += `<td>${escapeHtml(cell)}</td>\n`;
							});
							html += "</tr>\n";
						}
					}
				});

				if (table.length > 1) html += "</tbody>\n";
				html += "</table>\n";
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
			if (Array.isArray(list)) {
				html += "<ul>\n";
				list.forEach((item) => {
					if (item && item.trim()) {
						html += `<li>${escapeHtml(item.trim())}</li>\n`;
					}
				});
				html += "</ul>\n";
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
			if (Array.isArray(list)) {
				html += "<ol>\n";
				list.forEach((item) => {
					if (item && item.trim()) {
						html += `<li>${escapeHtml(item.trim())}</li>\n`;
					}
				});
				html += "</ol>\n";
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
				html += `<blockquote>${escapeHtml(quote.trim())}</blockquote>\n`;
			}
		});
	}

	// Add horizontal rules if available
	if (data.content && data.content.hr && Array.isArray(data.content.hr)) {
		data.content.hr.forEach(() => {
			html += `<hr>\n`;
		});
	}

	// Add links if available
	if (data.content && data.content.links && Array.isArray(data.content.links)) {
		html += '<div class="links-section">\n';
		html += "<h2>Links</h2>\n<ul>\n";
		data.content.links.forEach((link) => {
			if (link && link.href && link.text) {
				html += `<li><a href="${escapeHtml(
					link.href
				)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
					link.text.trim()
				)}</a></li>\n`;
			}
		});
		html += "</ul>\n</div>\n";
	}

	// Add images if available
	if (
		data.content &&
		data.content.images &&
		Array.isArray(data.content.images)
	) {
		html += '<div class="images-section">\n';
		html += "<h2>Images</h2>\n";
		data.content.images.forEach((img) => {
			if (img && img.src) {
				const alt = img.alt || img.title || "Image";
				const width = img.width ? ` width="${img.width}"` : "";
				const height = img.height ? ` height="${img.height}"` : "";
				html += `<img src="${escapeHtml(img.src)}" alt="${escapeHtml(
					alt
				)}"${width}${height}>\n`;
			}
		});
		html += "</div>\n";
	}

	// Add metadata if available
	if (data.metadata && Object.keys(data.metadata).length > 0) {
		html += '<div class="metadata">\n<h3>Metadata</h3>\n';
		Object.entries(data.metadata).forEach(([key, value]) => {
			if (value) {
				html += `<p><strong>${escapeHtml(key)}:</strong> ${escapeHtml(
					value
				)}</p>\n`;
			}
		});
		html += "</div>\n";
	}

	// Add URL information
	if (data.url) {
		html += '<div class="source-url">\n';
		html += `<p><strong>Source URL:</strong> <a href="${escapeHtml(
			data.url
		)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
			data.url
		)}</a></p>\n`;
		html += "</div>\n";
	}

	// Add timestamp
	html += '<div class="timestamp">\n';
	html += `<p>Generated: ${new Date().toISOString()}</p>\n`;
	html += "</div>\n";

	html += "</body>\n</html>";
	return html;
}

// Enhanced function to process markdown content through remark for better parsing
export async function processMarkdownWithRemark(markdownContent) {
	if (!markdownContent || typeof markdownContent !== "string") {
		return markdownContent;
	}

	try {
		// Clean up the markdown content first
		let cleanedMarkdown = markdownContent
			// Remove excessive newlines (more than 2 consecutive)
			.replace(/\n{3,}/g, "\n\n")
			// Remove excessive spaces at line beginnings
			.replace(/^[ \t]+/gm, "")
			// Remove excessive spaces at line endings
			.replace(/[ \t]+$/gm, "")
			// Normalize spaces around headers
			.replace(/^#{1,6}\s*([^#\n]+?)\s*#*\s*$/gm, (match, content) => {
				const level = match.match(/^#{1,6}/)[0];
				return `${level} ${content.trim()}`;
			})
			// Clean up list formatting
			.replace(/^[\s]*[-*+]\s+/gm, "- ")
			.replace(/^[\s]*\d+\.\s+/gm, (match) => {
				const num = match.match(/\d+/)[0];
				return `${num}. `;
			})
			// Clean up code blocks
			.replace(/```\s*\n/g, "```\n")
			.replace(/\n\s*```/g, "\n```")
			// Clean up inline code
			.replace(/`\s+/g, "`")
			.replace(/\s+`/g, "`")
			// Clean up links
			.replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, "[$1]($2)")
			// Clean up emphasis
			.replace(/\*\s+([^*]+)\s+\*/g, "*$1*")
			.replace(/\*\*\s+([^*]+)\s+\*\*/g, "**$1**")
			// Remove empty lines between list items
			.replace(/(\n- [^\n]+\n)\n+(- [^\n]+)/g, "$1$2")
			// Clean up table formatting
			.replace(/\|\s*\|\s*\|\s*\n/g, "| | |\n")
			.replace(/\|\s*---\s*\|\s*\n/g, "| --- |\n");

		// Process through remark pipeline - simplified to avoid plugin conflicts
		const result = await unified()
			.use(remarkParse)
			.use(remarkGfm) // GitHub Flavored Markdown support
			.use(remarkBreaks) // Convert line breaks to <br>
			.use(remarkHtml, {
				// HTML output options
				allowDangerousHtml: false,
				allowDangerousProtocol: false,
				closeSelfClosing: true,
				entities: { useShortestReferences: true },
			})
			.process(cleanedMarkdown);

		return String(result);
	} catch (error) {
		console.error("Error processing markdown with remark:", error);
		// Fallback to original content if remark processing fails
		return markdownContent;
	}
}

// Function to create a clean markdown string from data for remark processing
export function createCleanMarkdown(data) {
	if (!data || typeof data !== "object") {
		return "";
	}

	let markdown = "";

	// Add title
	if (data.title) {
		markdown += `# ${data.title}\n\n`;
	}

	// Add headings in order
	["h1", "h2", "h3", "h4", "h5", "h6"].forEach((level) => {
		if (
			data.content &&
			data.content[level] &&
			Array.isArray(data.content[level])
		) {
			data.content[level].forEach((heading) => {
				if (heading && heading.trim()) {
					const prefix = "#".repeat(parseInt(level.slice(1)));
					markdown += `${prefix} ${heading.trim()}\n\n`;
				}
			});
		}
	});

	// Add paragraphs
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.paragraphs
	) {
		data.content.semanticContent.paragraphs.forEach((p) => {
			if (p && p.trim()) {
				markdown += `${p.trim()}\n\n`;
			}
		});
	}

	// Add lists
	if (data.content && data.content.semanticContent) {
		if (data.content.semanticContent.unorderedLists) {
			data.content.semanticContent.unorderedLists.forEach((list) => {
				if (Array.isArray(list)) {
					list.forEach((item) => {
						if (item && item.trim()) {
							markdown += `- ${item.trim()}\n`;
						}
					});
					markdown += "\n";
				}
			});
		}

		if (data.content.semanticContent.orderedLists) {
			data.content.semanticContent.orderedLists.forEach((list) => {
				if (Array.isArray(list)) {
					list.forEach((item, index) => {
						if (item && item.trim()) {
							markdown += `${index + 1}. ${item.trim()}\n`;
						}
					});
					markdown += "\n";
				}
			});
		}
	}

	// Add blockquotes
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.blockquotes
	) {
		data.content.semanticContent.blockquotes.forEach((quote) => {
			if (quote && quote.trim()) {
				markdown += `> ${quote.trim()}\n\n`;
			}
		});
	}

	// Add code blocks
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.preformatted
	) {
		data.content.semanticContent.preformatted.forEach((code) => {
			if (code && code.trim()) {
				markdown += `\`\`\`\n${code.trim()}\n\`\`\`\n\n`;
			}
		});
	}

	// Add tables
	if (
		data.content &&
		data.content.semanticContent &&
		data.content.semanticContent.tables
	) {
		data.content.semanticContent.tables.forEach((table) => {
			if (Array.isArray(table) && table.length > 0) {
				// Add headers
				if (table[0] && Array.isArray(table[0])) {
					markdown += `| ${table[0].join(" | ")} |\n`;
					markdown += `| ${table[0].map(() => "---").join(" | ")} |\n`;

					// Add data rows
					for (let i = 1; i < table.length; i++) {
						if (table[i] && Array.isArray(table[i])) {
							markdown += `| ${table[i].join(" | ")} |\n`;
						}
					}
					markdown += "\n";
				}
			}
		});
	}

	return markdown.trim();
}

// Helper function to escape HTML special characters
function escapeHtml(text) {
	if (typeof text !== "string") return text;

	const map = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#039;",
	};

	return text.replace(/[&<>"']/g, function (m) {
		return map[m];
	});
}
