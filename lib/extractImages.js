export default function extractImagesFromContent(content) {
	// Handle string input (JSON string)
	if (typeof content === "string") {
		try {
			content = JSON.parse(content);
		} catch (error) {
			console.error("Failed to parse JSON string:", error);
			return [];
		}
	}

	// If content is not object/array, return []
	if (typeof content !== "object" || content === null) {
		return [];
	}

	const images = [];

	// Helper to extract images from a string
	function extractImagesFromString(str, sourcePath) {
		const value = str.toLowerCase();

		// Check for image URLs with extensions
		const imageUrlMatch = value.match(
			/https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(jpg|jpeg|png|gif|svg|webp|bmp|tiff|tif|ico|avif|heic|heif|jfif|pjpeg|pjp)(\?[^\s<>"{}|\\^`\[\]]*)?/gi
		);

		if (imageUrlMatch) {
			imageUrlMatch.forEach((url) => {
				images.push({
					url: url,
					source: sourcePath,
					type: "url",
					extension: url.split(".").pop().split("?")[0].toLowerCase(),
				});
			});
		}

		// Check for base64 encoded images
		const base64Match = value.match(
			/data:image\/(jpeg|png|gif|svg\+xml|webp|bmp|tiff);base64,[a-zA-Z0-9+/=]+/gi
		);
		if (base64Match) {
			base64Match.forEach((base64) => {
				const typeMatch = base64.match(/data:image\/([^;]+)/);
				images.push({
					url: base64,
					source: sourcePath,
					type: "base64",
					extension: typeMatch ? typeMatch[1] : "unknown",
				});
			});
		}
	}

	// Recursive function to search through nested objects and arrays
	function searchForImages(obj, path = "") {
		if (Array.isArray(obj)) {
			obj.forEach((item, index) => {
				const currentPath = `${path}[${index}]`;
				if (typeof item === "string") {
					extractImagesFromString(item, currentPath);
				} else {
					searchForImages(item, currentPath);
				}
			});
		} else if (obj && typeof obj === "object") {
			Object.keys(obj).forEach((key) => {
				const currentPath = path ? `${path}.${key}` : key;
				const value = obj[key];
				if (typeof value === "string") {
					extractImagesFromString(value, currentPath);
				} else {
					searchForImages(value, currentPath);
				}
			});
		} else if (typeof obj === "string") {
			// Handles the case where the root content is a string (shouldn't happen after JSON.parse, but for completeness)
			extractImagesFromString(obj, path);
		}
	}

	// Start the search
	searchForImages(content);

	// Remove duplicates based on URL
	const uniqueImages = images.filter(
		(image, index, self) =>
			index === self.findIndex((img) => img.url === image.url)
	);

	return uniqueImages;
}

// Enhanced version that also extracts images from HTML content
export function extractImagesFromHTML(htmlContent) {
	if (typeof htmlContent !== "string") {
		return [];
	}

	const images = [];
	const imageExtensions = [
		".jpg",
		".jpeg",
		".png",
		".gif",
		".svg",
		".webp",
		".bmp",
		".tiff",
		".tif",
		".ico",
		".avif",
		".heic",
		".heif",
		".jfif",
		".pjpeg",
		".pjp",
	];

	// Extract img tags
	const imgTagRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
	let imgMatch;

	while ((imgMatch = imgTagRegex.exec(htmlContent)) !== null) {
		const src = imgMatch[1];
		if (src) {
			const extension = src.split(".").pop().split("?")[0].toLowerCase();
			if (
				imageExtensions.includes(`.${extension}`) ||
				src.startsWith("data:image/")
			) {
				images.push({
					url: src,
					source: "img_tag",
					type: src.startsWith("data:image/") ? "base64" : "url",
					extension: extension,
				});
			}
		}
	}

	// Extract background images from CSS
	const backgroundImageRegex =
		/background-image:\s*url\(["']?([^"')]+)["']?\)/gi;
	let bgMatch;

	while ((bgMatch = backgroundImageRegex.exec(htmlContent)) !== null) {
		const url = bgMatch[1];
		const extension = url.split(".").pop().split("?")[0].toLowerCase();
		if (imageExtensions.includes(`.${extension}`)) {
			images.push({
				url: url,
				source: "css_background",
				type: "url",
				extension: extension,
			});
		}
	}

	return images;
}

// Combined function that handles both content objects and HTML
export function extractAllImages(content, htmlContent = null) {
	const contentImages = extractImagesFromContent(content);
	const htmlImages = htmlContent ? extractImagesFromHTML(htmlContent) : [];

	// Combine and remove duplicates using a Set
	const seen = new Set();
	const allImages = [...contentImages, ...htmlImages];
	const uniqueImages = [];

	for (const image of allImages) {
		if (image && image.url && !seen.has(image.url)) {
			seen.add(image.url);
			uniqueImages.push(image);
		}
	}

	return uniqueImages;
}
