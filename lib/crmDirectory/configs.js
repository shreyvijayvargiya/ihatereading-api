/**
 * Business CRM directory — Google search + scrape, no LLM.
 * 20 rotating keyword queries. Unique products hashed by domain → Firestore.
 */

export const CRM_COLLECTION = "business-crms";
export const CRM_STATE_COLLECTION = "businessCrmsState";
export const INTERVAL_MS = 10_000;

export const CRM_AGENT = {
	id: "business-crms",
	name: "Business CRM Directory",
	collection: CRM_COLLECTION,
	stateCollection: CRM_STATE_COLLECTION,
	queriesPerRun: Number(process.env.CRM_QUERIES_PER_RUN || "1"),
	scrapeListsPerRun: Number(process.env.CRM_SCRAPE_LISTS_PER_RUN || "2"),
	enrichPerRun: Number(process.env.CRM_ENRICH_PER_RUN || "4"),
	resolvePerRun: Number(process.env.CRM_RESOLVE_PER_RUN || "5"),
};

/** Direct-fetch pages that usually allow HTTP (Forbes/G2 often block). */
export const SEED_LIST_URLS = [
	"https://en.wikipedia.org/wiki/Comparison_of_CRM_systems",
];

/** Exactly 20 discovery queries — rotated by cursor each tick. */
export const CRM_QUERIES = [
	"best CRM software for business",
	"CRM software list comparison",
	"top CRM platforms for companies",
	"best CRM for small business",
	"enterprise CRM software vendors",
	"B2B CRM tools directory",
	"sales CRM software companies",
	"open source CRM software list",
	"CRM alternatives to Salesforce",
	"customer relationship management software list",
	"best CRM for startups",
	"industry specific CRM software vendors",
	"real estate CRM software list",
	"healthcare CRM software companies",
	"ecommerce CRM platforms list",
	"best CRM with email marketing",
	"site:g2.com CRM software",
	"site:capterra.com CRM",
	"comparison of CRM systems wikipedia",
	"best CRM software 2026 G2 Capterra",
];

/** SERP / list pages we scrape for outbound product websites (not stored as CRMs). */
export const DIRECTORY_HOST_RE =
	/g2\.com|capterra\.com|getapp\.com|softwareadvice\.com|trustradius\.com|selecthub\.com|gartner\.com|forrester\.com|wikipedia\.org|wikimedia\.org|wikidata\.org|mediawiki\.org|pcmag\.com|techradar\.com|forbes\.com|zapier\.com|softwareworld|crm\.org|saasworthy|sourceforge\.net|alternative\.to|producthunt\.com|crozdesk|saaslist|selectsoftwarereviews|softwaretestinghelp|guru99|techjockey|goodfirms\.co|softwareconnect|trustradius|techcrunch\.com|techtarget\.com|geekflare\.com|croclub\.com|businessnewsdaily|smallbiztrends|cnet\.com|zdnet\.com|theverge\.com|wired\.com|mashable\.com|businessinsider/i;

export const JUNK_HOST_RE =
	/google\.|youtube\.com|youtu\.be|facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|reddit\.com|pinterest\.com|tiktok\.com|quora\.com|medium\.com|substack\.com|amazon\.com|apple\.com|play\.google|bing\.com|duckduckgo\.com|yahoo\.com|wikimedia|wikidata|mediawiki/i;
