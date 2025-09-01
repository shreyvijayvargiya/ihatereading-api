export default function extractSemanticOrder(rootElement) {
	const content = [];

	const traverse = (element) => {
		// Skip elements that are clearly not content
		if (
			element.tagName === "SCRIPT" ||
			element.tagName === "STYLE" ||
			element.tagName === "NOSCRIPT" ||
			element.classList.contains("hidden") ||
			element.classList.contains("ad") ||
			element.classList.contains("advertisement")
		) {
			return;
		}

		// Process element based on type
		if (element.tagName.match(/^H[1-6]$/)) {
			const links = extractLinksFromElement(element);
			const level = parseInt(element.tagName[1]);
			const headingText = element.textContent.trim();
			// Better heading formatting with proper spacing
			const markdown = "\n" + "#".repeat(level) + " " + headingText + "\n";

			content.push({
				type: "heading",
				level: level,
				text: headingText,
				links: links,
				element: element,
				markdown: markdown,
			});
		} else if (element.tagName === "P") {
			const links = extractLinksFromElement(element);
			const paragraphText = element.textContent.trim();
			// Better paragraph formatting with proper spacing
			const markdown = paragraphText + "\n\n";

			content.push({
				type: "paragraph",
				text: paragraphText,
				links: links,
				element: element,
				markdown: markdown,
			});
		} else if (element.tagName === "UL" || element.tagName === "OL") {
			const listItems = Array.from(element.querySelectorAll("li"))
				.map((li) => {
					const links = extractLinksFromElement(li);
					const itemText = li.textContent.trim();
					return {
						text: itemText,
						links: links,
						markdown: "- " + itemText,
					};
				})
				.filter((item) => item.text.length > 0);

			if (listItems.length > 0) {
				const isOrdered = element.tagName === "OL";
				// Better list formatting with proper spacing
				const markdown =
					"\n" +
					listItems
						.map((item, index) => {
							return isOrdered ? `${index + 1}. ${item.text}` : item.markdown;
						})
						.join("\n") +
					"\n\n";

				content.push({
					type: "list",
					ordered: isOrdered,
					items: listItems,
					element: element,
					markdown: markdown,
				});
			}
		} else if (element.tagName === "TABLE") {
			// Extract table with structure
			const tableData = extractTableStructure(element);
			if (tableData.rows.length > 0) {
				const markdown = generateTableMarkdown(tableData);

				content.push({
					type: "table",
					...tableData,
					element: element,
					markdown: markdown,
				});
			}
		} else if (element.tagName === "PRE" || element.tagName === "CODE") {
			const links = extractLinksFromElement(element);
			const codeText = element.textContent.trim();
			const language = element.className.match(/language-(\w+)/)?.[1] || "";
			// Better code block formatting with proper spacing
			const markdown = language
				? `\n\`\`\`${language}\n${codeText}\n\`\`\`\n\n`
				: `\n\`\`\`\n${codeText}\n\`\`\`\n\n`;

			content.push({
				type: "code",
				text: codeText,
				language: language,
				links: links,
				element: element,
				markdown: markdown,
			});
		} else if (element.tagName === "BLOCKQUOTE") {
			const links = extractLinksFromElement(element);
			const quoteText = element.textContent.trim();
			// Better blockquote formatting with proper spacing
			const markdown = "\n> " + quoteText + "\n\n";

			content.push({
				type: "quote",
				text: quoteText,
				links: links,
				element: element,
				markdown: markdown,
			});
		} else if (element.tagName === "A") {
			// Only process standalone links (not inside other content elements)
			const parent = element.parentElement;
			const isInsideContentElement =
				parent &&
				(parent.tagName.match(/^H[1-6]$/) ||
					parent.tagName === "P" ||
					parent.tagName === "LI" ||
					parent.tagName === "BLOCKQUOTE" ||
					parent.tagName === "PRE" ||
					parent.tagName === "CODE");

			if (!isInsideContentElement) {
				const linkText = element.textContent.trim();
				const href = element.href;
				// Better link formatting
				const markdown = `[${linkText}](${href})`;

				content.push({
					type: "link",
					text: linkText,
					href: href,
					title: element.getAttribute("title") || "",
					target: element.getAttribute("target") || "",
					rel: element.getAttribute("rel") || "",
					element: element,
					markdown: markdown,
				});
			}
		} else if (element.tagName === "IMG") {
			// Only process standalone images (not inside other content elements)
			const parent = element.parentElement;
			const isInsideContentElement =
				parent &&
				(parent.tagName.match(/^H[1-6]$/) ||
					parent.tagName === "P" ||
					parent.tagName === "LI" ||
					parent.tagName === "BLOCKQUOTE" ||
					parent.tagName === "PRE" ||
					parent.tagName === "CODE");

			if (!isInsideContentElement) {
				const alt = element.alt || "";
				const src = element.src;
				const title = element.title || "";
				// Better image formatting with title and proper spacing
				let markdown = `\n![${alt}](${src})`;
				if (title) {
					markdown += ` "${title}"`;
				}
				markdown += "\n\n";

				content.push({
					type: "image",
					src: src,
					alt: alt,
					title: title,
					width: element.width || element.naturalWidth || "",
					height: element.height || element.naturalHeight || "",
					element: element,
					markdown: markdown,
				});
			}
		} else if (element.tagName === "STRONG" || element.tagName === "B") {
			const strongText = element.textContent.trim();
			const markdown = `**${strongText}**`;

			content.push({
				type: "strong",
				text: strongText,
				element: element,
				markdown: markdown,
			});
		} else if (element.tagName === "EM" || element.tagName === "I") {
			const emText = element.textContent.trim();
			const markdown = `*${emText}*`;

			content.push({
				type: "em",
				text: emText,
				element: element,
				markdown: markdown,
			});
		} else if (element.tagName === "S" || element.tagName === "STRIKE") {
			const strikeText = element.textContent.trim();
			const markdown = `~~${strikeText}~~`;

			content.push({
				type: "strike",
				text: strikeText,
				element: element,
				markdown: markdown,
			});
		} else if (element.tagName === "BR") {
			content.push({
				type: "lineBreak",
				element: element,
				markdown: "\n",
			});
		} else if (element.tagName === "HR") {
			content.push({
				type: "horizontalRule",
				element: element,
				markdown: "\n---\n\n",
			});
		} else if (
			element.tagName === "DIV" ||
			element.tagName === "SECTION" ||
			element.tagName === "ARTICLE"
		) {
			// Handle container elements by processing their children
			// but don't add them to content directly
			// This ensures proper nesting and structure
		}

		// Recursively process children (maintaining order)
		for (const child of element.children) {
			traverse(child);
		}
	};

	traverse(rootElement);
	return content;
}

// Helper function to extract table structure
function extractTableStructure(table) {
	const rows = Array.from(table.querySelectorAll("tr"));
	const tableData = {
		rows: [],
		headers: [],
	};

	rows.forEach((row, index) => {
		const cells = Array.from(row.querySelectorAll("td, th"));
		const rowData = cells
			.map((cell) => cell.textContent.trim())
			.filter((text) => text.length > 0);

		if (rowData.length > 0) {
			if (index === 0) {
				// First row might be headers
				tableData.headers = rowData;
			} else {
				tableData.rows.push(rowData);
			}
		}
	});

	return tableData;
}

// Helper function to generate markdown for tables
function generateTableMarkdown(tableData) {
	let markdown = "\n";

	// Add headers
	if (tableData.headers.length > 0) {
		markdown += "| " + tableData.headers.join(" | ") + " |\n";
		markdown += "| " + tableData.headers.map(() => "---").join(" | ") + " |\n";
	}

	// Add data rows
	tableData.rows.forEach((row) => {
		markdown += "| " + row.join(" | ") + " |\n";
	});

	return markdown + "\n";
}

// Helper function to extract links from any element
function extractLinksFromElement(element) {
	const links = Array.from(element.querySelectorAll("a[href]"));
	return links.map((link) => ({
		text: link.textContent.trim(),
		href: link.href,
		title: link.getAttribute("title") || "",
		target: link.getAttribute("target") || "",
		rel: link.getAttribute("rel") || "",
	}));
}

// Function to get complete markdown from extracted content
export function getCompleteMarkdown(content) {
	return content.map((item) => item.markdown || "").join("");
}

// Function to get content with both semantic data and markdown
export function extractSemanticContentWithMarkdown(rootElement) {
	const content = extractSemanticOrder(rootElement);
	const completeMarkdown = getCompleteMarkdown(content);

	return {
		content: content,
		markdown: completeMarkdown,
		wordCount: content.reduce(
			(count, item) => count + (item.text ? item.text.split(" ").length : 0),
			0
		),
		elementCount: content.length,
	};
}

// Enhanced function to get formatted markdown with better structure
export function getFormattedMarkdown(content) {
	let markdown = getCompleteMarkdown(content);

	// Clean up excessive newlines while maintaining structure
	markdown = markdown
		.replace(/\n{4,}/g, "\n\n\n") // Max 3 consecutive newlines
		.replace(/\n{3}/g, "\n\n") // Convert 3 newlines to 2
		.trim();

	// Ensure proper spacing around headings
	markdown = markdown
		.replace(/([^\n])\n(#+ )/g, "$1\n\n$2") // Space before headings
		.replace(/(#+ .*)\n([^\n])/g, "$1\n\n$2"); // Space after headings

	// Ensure proper spacing around lists
	markdown = markdown
		.replace(/([^\n])\n(- |\d+\. )/g, "$1\n\n$2") // Space before lists
		.replace(/(\n- .*\n|\n\d+\. .*\n)\n([^\n])/g, "$1\n\n$2"); // Space after lists

	// Ensure proper spacing around code blocks
	markdown = markdown
		.replace(/([^\n])\n(```)/g, "$1\n\n$2") // Space before code blocks
		.replace(/(```\n)\n([^\n])/g, "$1\n\n$2"); // Space after code blocks

	// Ensure proper spacing around blockquotes
	markdown = markdown
		.replace(/([^\n])\n(> )/g, "$1\n\n$2") // Space before blockquotes
		.replace(/(\n> .*\n)\n([^\n])/g, "$1\n\n$2"); // Space after blockquotes

	// Ensure proper spacing around tables
	markdown = markdown
		.replace(/([^\n])\n(\| )/g, "$1\n\n$2") // Space before tables
		.replace(/(\n\| .*\n)\n([^\n])/g, "$1\n\n$2"); // Space after tables

	return markdown;
}

// Function to get content with formatted markdown
export function extractSemanticContentWithFormattedMarkdown(rootElement) {
	const content = extractSemanticOrder(rootElement);
	const formattedMarkdown = getFormattedMarkdown(content);

	return {
		content: content,
		markdown: formattedMarkdown,
		rawMarkdown: getCompleteMarkdown(content),
		wordCount: content.reduce(
			(count, item) => count + (item.text ? item.text.split(" ").length : 0),
			0
		),
		elementCount: content.length,
	};
}

// Function to get content ready for LLM processing
// This integrates with your existing processMarkdownForLLM pipeline
export async function extractSemanticContentForLLM(
	rootElement,
	processMarkdownForLLM
) {
	try {
		// First get the formatted markdown from semantic extraction
		const semanticResult =
			extractSemanticContentWithFormattedMarkdown(rootElement);

		// Then process it through your existing remark pipeline
		if (processMarkdownForLLM && typeof processMarkdownForLLM === "function") {
			const processedMarkdown = await processMarkdownForLLM(
				semanticResult.markdown
			);

			return {
				...semanticResult,
				markdown: processedMarkdown,
				processed: true,
				processingMethod: "remark+deepPrune",
			};
		}

		// If no processing function provided, return the formatted markdown
		return {
			...semanticResult,
			processed: false,
			processingMethod: "semanticOnly",
		};
	} catch (error) {
		console.warn("Error processing markdown for LLM:", error.message);

		// Fallback to basic semantic extraction
		const fallbackResult = extractSemanticContentWithMarkdown(rootElement);
		return {
			...fallbackResult,
			processed: false,
			processingMethod: "fallback",
			error: error.message,
		};
	}
}

// Utility function to create a simple HTML string processor
export function createHTMLStringProcessor(processMarkdownForLLM) {
	return async function processHTMLString(htmlString) {
		try {
			// Create temporary DOM element
			const tempDiv = document.createElement("div");
			tempDiv.innerHTML = htmlString;

			// Process through semantic extractor and LLM pipeline
			return await extractSemanticContentForLLM(tempDiv, processMarkdownForLLM);
		} catch (error) {
			console.error("Error processing HTML string:", error);
			throw error;
		}
	};
}

// Utility function for Node.js environments (requires jsdom)
export function createNodeHTMLStringProcessor(processMarkdownForLLM) {
	return async function processHTMLStringNode(htmlString) {
		try {
			// This would require jsdom in Node.js environment
			const { JSDOM } = await import("jsdom");
			const dom = new JSDOM(htmlString);
			const rootElement = dom.window.document.body;

			// Process through semantic extractor and LLM pipeline
			return await extractSemanticContentForLLM(
				rootElement,
				processMarkdownForLLM
			);
		} catch (error) {
			console.error("Error processing HTML string in Node.js:", error);
			throw new Error(
				"For Node.js environments, please install jsdom: npm install jsdom"
			);
		}
	};
}
