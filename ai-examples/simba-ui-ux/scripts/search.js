// search.js
import { search, searchStack } from "./core.js";
import { DesignSystemGenerator, formatAsciiBox } from "./design_system.js";

export async function generateDesignSystem(
	query,
	projectName,
	format = "json",
) {
	const generator = new DesignSystemGenerator();
	const designSystem = await generator.generate(query, projectName);

	if (format === "json") {
		return JSON.stringify(designSystem, null, 2);
	}

	// Return ASCII format if needed
	return formatAsciiBox(designSystem);
}

export async function getStackGuidelines(query, stack = "html-tailwind") {
	const result = await searchStack(query, stack, 5);
	return result;
}
