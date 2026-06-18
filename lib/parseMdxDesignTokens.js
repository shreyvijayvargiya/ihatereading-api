/**
 * Heuristic token extraction from Simba design MDX files.
 * Falls back to per-theme defaults when labels differ across MDX formats.
 */

const HEX = /#(?:[0-9A-Fa-f]{3,8})\b/g;

function firstHex(text, patterns) {
	for (const re of patterns) {
		const m = text.match(re);
		if (m) {
			const hex = m[1] || m[0].match(/#(?:[0-9A-Fa-f]{3,8})/)?.[0];
			if (hex) return normalizeHex(hex);
		}
	}
	return null;
}

function normalizeHex(hex) {
	if (!hex) return hex;
	if (hex.length === 4) {
		const c = hex.slice(1);
		return `#${c[0]}${c[0]}${c[1]}${c[1]}${c[2]}${c[2]}`;
	}
	return hex.toUpperCase();
}

function extractFontFamily(mdx) {
	const gf = mdx.match(
		/fonts\.googleapis\.com\/css2\?family=([^"'&]+)/i,
	);
	if (gf) {
		return gf[1].split(":")[0].replace(/\+/g, " ");
	}
	const fam = mdx.match(
		/(?:Family|font-family)[^`\n]*`([^`]+)`|font-family:\s*['"]?([^;'"\n]+)/i,
	);
	if (fam) return (fam[1] || fam[2]).trim().split(",")[0].trim();
	return null;
}

function detectRadiusStyle(mdx) {
	const lower = mdx.toLowerCase();
	if (
		/rounded-none|0px.*radius|radius.*0px|strictly rectangular|zero border radius|sharp 90-degree/i.test(
			mdx,
		)
	) {
		return "sharp";
	}
	if (/rounded-full|pill|9999px/i.test(mdx) && !/rounded-2xl|rounded-3xl/i.test(mdx)) {
		return "pill";
	}
	if (/clay|neomorphism|soft rounded|rounded-2xl|rounded-3xl/i.test(lower)) {
		return "soft";
	}
	return "default";
}

function detectMode(mdx) {
	if (
		/dark mode only|modern dark|background-base.*#0[0-5]/i.test(mdx) ||
		/#050506|#020203|#090014/i.test(mdx)
	) {
		return "dark";
	}
	return "light";
}

/** Per-theme fallbacks when MDX parsing is incomplete */
const THEME_FALLBACKS = {
	modernDark: {
		background: "#050506",
		foreground: "#EDEDEF",
		muted: "#8A8F98",
		accent: "#5E6AD2",
		border: "#1F1F23",
		surface: "#0A0A0C",
		radiusStyle: "soft",
		mode: "dark",
		fontFamily: "Inter",
		effect: "glow",
	},
	bauhaus: {
		background: "#F5F0E8",
		foreground: "#1A1A1A",
		muted: "#E8E0D4",
		accent: "#E63946",
		border: "#1A1A1A",
		surface: "#FFFFFF",
		radiusStyle: "sharp",
		fontFamily: "Archivo",
		effect: "hard",
	},
	newsprint: {
		background: "#F9F9F7",
		foreground: "#111111",
		muted: "#E5E5E0",
		accent: "#CC0000",
		border: "#111111",
		surface: "#FFFFFF",
		radiusStyle: "sharp",
		fontFamily: "Georgia",
		effect: "none",
	},
	techStyle: {
		background: "#0B1120",
		foreground: "#E2E8F0",
		muted: "#64748B",
		accent: "#38BDF8",
		border: "#1E293B",
		surface: "#111827",
		radiusStyle: "default",
		mode: "dark",
		fontFamily: "JetBrains Mono",
		effect: "glow",
	},
	monochrome: {
		background: "#FFFFFF",
		foreground: "#000000",
		muted: "#F4F4F4",
		accent: "#000000",
		border: "#000000",
		surface: "#FAFAFA",
		radiusStyle: "sharp",
		fontFamily: "Helvetica Neue",
		effect: "none",
	},
	flatDesign: {
		background: "#ECF0F1",
		foreground: "#2C3E50",
		muted: "#BDC3C7",
		accent: "#3498DB",
		border: "#BDC3C7",
		surface: "#FFFFFF",
		radiusStyle: "default",
		fontFamily: "Lato",
		effect: "none",
	},
	swissMinimilistic: {
		background: "#FFFFFF",
		foreground: "#000000",
		muted: "#F2F2F2",
		accent: "#FF3000",
		border: "#000000",
		surface: "#F2F2F2",
		radiusStyle: "sharp",
		fontFamily: "Inter",
		effect: "none",
	},
	luxury: {
		background: "#0C0C0C",
		foreground: "#F5F0E8",
		muted: "#8C7B6B",
		accent: "#C9A962",
		border: "#3D3530",
		surface: "#1A1714",
		radiusStyle: "soft",
		mode: "dark",
		fontFamily: "Cormorant Garamond",
		effect: "none",
	},
	geometric: {
		background: "#F8FAFC",
		foreground: "#0F172A",
		muted: "#E2E8F0",
		accent: "#6366F1",
		border: "#CBD5E1",
		surface: "#FFFFFF",
		radiusStyle: "sharp",
		fontFamily: "DM Sans",
		effect: "none",
	},
	clayMorphism: {
		background: "#E8EDF5",
		foreground: "#2D3748",
		muted: "#CBD5E0",
		accent: "#667EEA",
		border: "#E2E8F0",
		surface: "#F7FAFC",
		radiusStyle: "soft",
		fontFamily: "Nunito",
		effect: "clay",
	},
	vaporwave: {
		background: "#090014",
		foreground: "#E0E0E0",
		muted: "#2D1B4E",
		accent: "#FF00FF",
		accent2: "#00FFFF",
		border: "#2D1B4E",
		surface: "#1A103C",
		radiusStyle: "default",
		mode: "dark",
		fontFamily: "Orbitron",
		effect: "neon",
	},
	handDrawnSketch: {
		background: "#FFFEF9",
		foreground: "#2D2D2D",
		muted: "#F0EBE3",
		accent: "#E85D4C",
		border: "#2D2D2D",
		surface: "#FFFFFF",
		radiusStyle: "soft",
		fontFamily: "Caveat",
		effect: "sketch",
	},
	neomorphism: {
		background: "#E0E5EC",
		foreground: "#4A5568",
		muted: "#A3B1C6",
		accent: "#667EEA",
		border: "#E0E5EC",
		surface: "#E0E5EC",
		radiusStyle: "soft",
		fontFamily: "Poppins",
		effect: "neumorph",
	},
	neutral: {
		background: "#FDFCF8",
		foreground: "#2C2C24",
		muted: "#F0EBE5",
		accent: "#5D7052",
		border: "#DED8CF",
		surface: "#FFFFFF",
		radiusStyle: "soft",
		fontFamily: "Fraunces",
		effect: "organic",
	},
	maximilism: {
		background: "#1A0A2E",
		foreground: "#FFF5E6",
		muted: "#FF6B9D",
		accent: "#FFD700",
		accent2: "#FF1493",
		border: "#FF6B9D",
		surface: "#2D1B4E",
		radiusStyle: "default",
		mode: "dark",
		fontFamily: "Playfair Display",
		effect: "maximal",
	},
	terminal: {
		background: "#0D1117",
		foreground: "#00FF41",
		muted: "#484F58",
		accent: "#00FF41",
		border: "#30363D",
		surface: "#161B22",
		radiusStyle: "sharp",
		mode: "dark",
		fontFamily: "IBM Plex Mono",
		effect: "terminal",
	},
	kinectic: {
		background: "#000000",
		foreground: "#FFFFFF",
		muted: "#333333",
		accent: "#FF3366",
		border: "#FFFFFF",
		surface: "#111111",
		radiusStyle: "sharp",
		mode: "dark",
		fontFamily: "Syne",
		effect: "kinetic",
	},
	botanical: {
		background: "#F5F1E8",
		foreground: "#2C3E2C",
		muted: "#D4E4D4",
		accent: "#4A7C59",
		border: "#B8C9B8",
		surface: "#FFFFFF",
		radiusStyle: "soft",
		fontFamily: "Libre Baskerville",
		effect: "organic",
	},
	corporateTrust: {
		background: "#FFFFFF",
		foreground: "#1E3A5F",
		muted: "#E8EEF4",
		accent: "#2563EB",
		border: "#CBD5E1",
		surface: "#F8FAFC",
		radiusStyle: "default",
		fontFamily: "Source Sans 3",
		effect: "none",
	},
	industrial: {
		background: "#1C1C1C",
		foreground: "#E5E5E5",
		muted: "#4A4A4A",
		accent: "#F59E0B",
		border: "#404040",
		surface: "#2A2A2A",
		radiusStyle: "sharp",
		mode: "dark",
		fontFamily: "Roboto Condensed",
		effect: "industrial",
	},
	crypto: {
		background: "#0B0E17",
		foreground: "#E2E8F0",
		muted: "#1E293B",
		accent: "#8B5CF6",
		accent2: "#06B6D4",
		border: "#334155",
		surface: "#111827",
		radiusStyle: "default",
		mode: "dark",
		fontFamily: "Space Grotesk",
		effect: "glow",
	},
	material: {
		background: "#FAFAFA",
		foreground: "#212121",
		muted: "#E0E0E0",
		accent: "#6200EE",
		border: "#E0E0E0",
		surface: "#FFFFFF",
		radiusStyle: "default",
		fontFamily: "Roboto",
		effect: "material",
	},
	academia: {
		background: "#FDF6E3",
		foreground: "#2C1810",
		muted: "#E8DCC8",
		accent: "#8B4513",
		border: "#C4A882",
		surface: "#FFFBF5",
		radiusStyle: "default",
		fontFamily: "Merriweather",
		effect: "none",
	},
	neoBrutalism: {
		background: "#FFFDF5",
		foreground: "#000000",
		muted: "#FFD93D",
		accent: "#FF6B6B",
		accent2: "#C4B5FD",
		border: "#000000",
		surface: "#FFFFFF",
		radiusStyle: "sharp",
		fontFamily: "Space Grotesk",
		effect: "brutal",
	},
	ramp: {
		background: "#FFFFFF",
		foreground: "#0C0A08",
		muted: "#EDE8E5",
		accent: "#E7F056",
		border: "#D8D7D7",
		surface: "#F4F2F0",
		radiusStyle: "pill",
		fontFamily: "Inter",
		effect: "none",
	},
};

export function parseMdxDesignTokens(mdx, themeKey) {
	const fallback = THEME_FALLBACKS[themeKey] || THEME_FALLBACKS.neutral;
	const text = String(mdx || "");

	const background =
		firstHex(text, [
			/(?:\*\*)?Background(?:\s*\([^)]*\))?(?:\*\*)?[^#\n]*?(#[0-9A-Fa-f]{3,8})/i,
			/`background(?:-base|-deep)?`\s*\|\s*`(#[0-9A-Fa-f]{3,8})`/i,
			/Background \(Canvas\)[^#]*(#[0-9A-Fa-f]{3,8})/i,
		]) || fallback.background;

	const foreground =
		firstHex(text, [
			/(?:\*\*)?Foreground(?:\s*\([^)]*\))?(?:\*\*)?[^#\n]*?(#[0-9A-Fa-f]{3,8})/i,
			/`foreground(?:-muted)?`\s*\|\s*`(#[0-9A-Fa-f]{3,8})`/i,
		]) || fallback.foreground;

	const accent =
		firstHex(text, [
			/(?:\*\*)?(?:Accent|Primary(?:\s+Accent)?)(?:\s*\([^)]*\))?(?:\*\*)?[^#\n]*?(#[0-9A-Fa-f]{3,8})/i,
			/`accent(?:-bright)?`\s*\|\s*`(#[0-9A-Fa-f]{3,8})`/i,
			/Swiss Red[^#]*(#[0-9A-Fa-f]{3,8})/i,
		]) || fallback.accent;

	const muted =
		firstHex(text, [
			/(?:\*\*)?Muted(?:\s*\([^)]*\))?(?:\*\*)?[^#\n]*?(#[0-9A-Fa-f]{3,8})/i,
			/`muted(?:-foreground)?`\s*\|\s*`(#[0-9A-Fa-f]{3,8})/i,
		]) || fallback.muted;

	const border =
		firstHex(text, [
			/(?:\*\*)?Border(?:\s*\([^)]*\))?(?:\*\*)?[^#\n]*?(#[0-9A-Fa-f]{3,8})/i,
			/`border(?:-accent)?`\s*\|\s*`(#[0-9A-Fa-f]{3,8})/i,
		]) || fallback.border;

	const surface =
		firstHex(text, [
			/(?:\*\*)?(?:Surface|Card Background)(?:\s*\([^)]*\))?(?:\*\*)?[^#\n]*?(#[0-9A-Fa-f]{3,8})/i,
			/`surface`\s*\|\s*`(#[0-9A-Fa-f]{3,8})/i,
		]) || fallback.surface;

	const accent2 =
		firstHex(text, [
			/(?:Secondary|Tertiary|Secondary Accent)[^#\n]*?(#[0-9A-Fa-f]{3,8})/i,
		]) ||
		fallback.accent2 ||
		accent;

	const radiusStyle = detectRadiusStyle(text) || fallback.radiusStyle;
	const mode = detectMode(text) || fallback.mode || "light";
	const fontFamily = extractFontFamily(text) || fallback.fontFamily;
	const effect = fallback.effect || "none";

	return {
		background,
		foreground,
		muted,
		accent,
		accent2,
		border,
		surface,
		radiusStyle,
		mode,
		fontFamily,
		effect,
	};
}

export { THEME_FALLBACKS };
