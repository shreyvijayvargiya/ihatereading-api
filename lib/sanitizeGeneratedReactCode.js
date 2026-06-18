/**
 * Post-process LLM-generated React for image-to-code: lucide-react only, no hallucinated icons.
 */

const REACT_ICONS_PKG_RE = /^react-icons(?:\/|$)/;
const LUCIDE_PKG = "lucide-react";

const FALLBACK_ICONS = [
	"Building2",
	"Box",
	"Circle",
	"Briefcase",
	"LayoutGrid",
	"Globe",
	"Star",
];
const DEFAULT_FALLBACK = "Building2";

/** Map hallucinated icon names to real lucide exports. */
const LUCIDE_IMPORT_ALIASES = {
	Pinterest: "Pin",
	WhatsApp: "MessageCircle",
	LinkedIn: "Linkedin",
	Twitter: "Twitter",
};

const EXTERNAL_IMG_TAG_RE =
	/<img\s+[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+["'][^>]*\/?>/gi;

const LUCIDE_NON_EXPORTS = new Set([
	"createLucideIcon",
	"Icon",
	"LucideIcon",
	"default",
	"icons",
]);

/** Curated fallback when lucide-react is not resolvable at runtime. */
const LUCIDE_FALLBACK_WHITELIST = new Set(
	`Activity,AirVent,AlarmClock,AlertCircle,AlertTriangle,ArrowDown,ArrowLeft,ArrowRight,ArrowUp,AtSign,Award,
BarChart2,BarChart3,Battery,Bell,Bookmark,Box,Briefcase,Building2,Calendar,CalendarDays,Camera,Check,
CheckCircle2,ChevronDown,ChevronLeft,ChevronRight,ChevronUp,ChevronsRight,Circle,Clipboard,Clock,Cloud,Code,
Code2,Cog,Compass,Copy,CreditCard,Database,DollarSign,Download,Droplet,Edit,Edit2,ExternalLink,Eye,EyeOff,
Facebook,File,FileText,Film,Filter,Flag,Folder,FolderOpen,Gift,GitBranch,Github,Globe,Grid3x3,Hand,Hash,
Headphones,Heart,HelpCircle,History,Home,Image,Inbox,Info,Instagram,Key,Laptop,Layers,LayoutDashboard,
LayoutGrid,Lightbulb,LineChart,Link,Link2,List,Loader2,Lock,LogIn,LogOut,Mail,Map,MapPin,Maximize2,Menu,
MessageCircle,MessageSquare,Mic,Minimize2,Minus,Monitor,Moon,MoreHorizontal,MoreVertical,Music,Navigation,
Package,Palette,Paperclip,Pause,PenLine,Pencil,Percent,Phone,PieChart,Pin,Play,Plus,Power,Printer,Radio,
RefreshCw,Rocket,Rss,Save,Search,Send,Server,Settings,Share2,Shield,ShoppingBag,ShoppingCart,Sidebar,Signal,
Sparkles,Star,StickyNote,Store,Sun,Table,Tablet,Tag,Target,Terminal,ThumbsUp,Ticket,Trash2,TrendingUp,Truck,Tv,
Twitter,Type,Umbrella,Upload,User,UserPlus,Users,Video,Wallet,Wifi,Wrench,X,Zap`
		.replace(/\s+/g, "")
		.split(","),
);

let cachedValidLucide = null;

function buildValidLucideSet(lucideModule) {
	const set = new Set(LUCIDE_FALLBACK_WHITELIST);
	if (!lucideModule) return set;
	for (const key of Object.keys(lucideModule)) {
		if (!/^[A-Z]/.test(key) || LUCIDE_NON_EXPORTS.has(key)) continue;
		set.add(key);
	}
	return set;
}

async function getValidLucideIcons() {
	if (cachedValidLucide) return cachedValidLucide;
	try {
		const lucideModule = await import("lucide-react");
		cachedValidLucide = buildValidLucideSet(lucideModule);
	} catch {
		cachedValidLucide = buildValidLucideSet(null);
	}
	return cachedValidLucide;
}

/** Prompt hint — icons must exist in lucide-react. */
export const IMAGE_TO_CODE_LUCIDE_POLICY = `ICONS (strict — enforced server-side):
- Import icons ONLY from "lucide-react". NEVER import from "react-icons" or any other icon package.
- Only use icon names that exist in lucide-react (e.g. User, Globe, Upload, ArrowUp, Link, Building2, Box, Circle, Sparkles, LineChart).
- For company logos / brand marks in screenshots: use a simple lucide icon (Building2, Box, Circle, Briefcase) plus the visible company name text — never invent Fa* or brand-specific icon names.
- Every icon in JSX must be imported from lucide-react in the same file.`;

const IMPORT_LINE_RE =
	/^import\s+(?:(\{([^}]+)\})|(\*\s+as\s+(\w+))|(\w+))\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm;

function parseNamedImports(specifier) {
	return specifier
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const asMatch = part.match(/^(\w+)\s+as\s+(\w+)$/);
			if (asMatch) return { imported: asMatch[1], local: asMatch[2] };
			return { imported: part, local: part };
		});
}

function pickFallback(index, validLucide) {
	for (let i = 0; i < FALLBACK_ICONS.length; i++) {
		const candidate = FALLBACK_ICONS[(index + i) % FALLBACK_ICONS.length];
		if (validLucide.has(candidate)) return candidate;
	}
	return validLucide.has(DEFAULT_FALLBACK) ? DEFAULT_FALLBACK : "Circle";
}

function replaceJsxSymbol(code, from, to) {
	if (from === to) return code;
	const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return code
		.replace(new RegExp(`<${escaped}(\\s|>|/)`, "g"), `<${to}$1`)
		.replace(new RegExp(`</${escaped}>`, "g"), `</${to}>`);
}

function removeImportLine(code, lineStart, lineEnd) {
	return code.slice(0, lineStart) + code.slice(lineEnd);
}

/**
 * @param {string} code
 * @returns {Promise<{ code: string, fixes: string[], changed: boolean }>}
 */
export async function sanitizeGeneratedReactCode(code) {
	const input = String(code ?? "");
	if (!input.trim()) {
		return { code: input, fixes: [], changed: false };
	}

	const validLucide = await getValidLucideIcons();
	const fixes = [];
	const replacementMap = new Map();
	let fallbackIdx = 0;

	const registerReplacement = (symbol) => {
		if (!symbol || replacementMap.has(symbol)) return;
		const aliased = LUCIDE_IMPORT_ALIASES[symbol];
		if (aliased && validLucide.has(aliased)) {
			replacementMap.set(symbol, aliased);
			fixes.push(`${symbol}→${aliased}`);
			return;
		}
		const fallback = pickFallback(fallbackIdx++, validLucide);
		replacementMap.set(symbol, fallback);
		fixes.push(`${symbol}→${fallback}`);
	};

	let output = input;
	const importMatches = [...input.matchAll(IMPORT_LINE_RE)];

	// Process imports from end to start so indices stay valid.
	for (let i = importMatches.length - 1; i >= 0; i--) {
		const match = importMatches[i];
		const full = match[0];
		const namedInner = match[2];
		const namespaceName = match[4];
		const defaultName = match[5];
		const pkg = match[6];
		const lineStart = match.index;
		const lineEnd = lineStart + full.length;

		if (REACT_ICONS_PKG_RE.test(pkg)) {
			if (namedInner) {
				for (const { local } of parseNamedImports(namedInner)) {
					registerReplacement(local);
				}
			} else if (defaultName) {
				registerReplacement(defaultName);
			} else if (namespaceName) {
				registerReplacement(namespaceName);
			}
			output = removeImportLine(output, lineStart, lineEnd);
			continue;
		}

		if (pkg === LUCIDE_PKG && namedInner) {
			const specs = parseNamedImports(namedInner);
			const kept = [];
			for (const { imported, local } of specs) {
				const resolved = LUCIDE_IMPORT_ALIASES[imported] || imported;
				if (validLucide.has(resolved)) {
					if (resolved !== imported) {
						replacementMap.set(local, resolved);
					}
					kept.push(
						local === imported || local === resolved
							? resolved
							: `${resolved} as ${local}`,
					);
				} else {
					registerReplacement(local);
				}
			}
			if (kept.length === 0) {
				output = removeImportLine(output, lineStart, lineEnd);
			} else {
				const newLine = `import { ${kept.join(", ")} } from '${LUCIDE_PKG}';`;
				output = output.slice(0, lineStart) + newLine + output.slice(lineEnd);
			}
		}
	}

	for (const [from, to] of replacementMap) {
		output = replaceJsxSymbol(output, from, to);
	}

	let replacedExternalImg = false;
	if (EXTERNAL_IMG_TAG_RE.test(output)) {
		EXTERNAL_IMG_TAG_RE.lastIndex = 0;
		output = output.replace(
			EXTERNAL_IMG_TAG_RE,
			'<div className="absolute inset-0 bg-gray-200 flex items-center justify-center"><User className="h-8 w-8 text-gray-400" /></div>',
		);
		replacedExternalImg = true;
		fixes.push("external-img→User-placeholder");
	}

	const unclosedImg = output.match(/<img\s[\s\S]*$/);
	if (
		unclosedImg &&
		/\bsrc\s*=\s*["']https?:\/\//i.test(unclosedImg[0])
	) {
		output = output.slice(0, unclosedImg.index).trimEnd();
		replacedExternalImg = true;
		fixes.push("truncated-unclosed-img");
	}

	// Strip DESIGN.md content if it leaked into the code buffer (client concat bug).
	const mdLeak = output.search(/\n#\s+[\w\s]+\n\n## Overview\b/);
	if (mdLeak > 0) {
		output = output.slice(0, mdLeak).trimEnd();
		fixes.push("stripped-leaked-design-md");
	}

	const lucideNeeded = new Set();
	for (const to of replacementMap.values()) lucideNeeded.add(to);
	if (replacedExternalImg || /<User[\s/>]/.test(output)) {
		lucideNeeded.add("User");
	}

	const lucideImportMatch = output.match(
		/^import\s+\{([^}]+)\}\s+from\s+['"]lucide-react['"]\s*;?\s*$/m,
	);
	if (lucideImportMatch) {
		for (const { local } of parseNamedImports(lucideImportMatch[1])) {
			if (validLucide.has(local)) lucideNeeded.add(local);
		}
		const sorted = [...lucideNeeded].sort();
		const newImport = `import { ${sorted.join(", ")} } from '${LUCIDE_PKG}';`;
		output = output.replace(lucideImportMatch[0], newImport);
	} else if (lucideNeeded.size > 0) {
		const sorted = [...lucideNeeded].sort();
		const newImport = `import { ${sorted.join(", ")} } from '${LUCIDE_PKG}';\n`;
		const reactImport = output.match(/^import\s+React[^\n]*\n/m);
		if (reactImport) {
			const insertAt = reactImport.index + reactImport[0].length;
			output =
				output.slice(0, insertAt) + newImport + output.slice(insertAt);
		} else {
			output = newImport + output;
		}
	}

	const changed = output !== input;
	return { code: output, fixes, changed };
}
