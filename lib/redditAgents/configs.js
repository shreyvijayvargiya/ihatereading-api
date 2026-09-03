/**
 * Agent configs — karyam.xyz, ihatereading.in marketing, SaaS problem finder.
 */

export const AGENTS = {
	karyam: {
		id: "karyam",
		name: "Karyam Agency Monitor",
		site: "https://karyam.xyz",
		collection: "redditKaryamPosts",
		relevanceMin: 4,
		subreddits: [
			"forhire",
			"hireaworker",
			"slavelabour",
			"webdev",
			"reactjs",
			"reactnative",
			"FlutterDev",
			"androiddev",
			"iOSProgramming",
			"shopify",
			"Wordpress",
			"ecommerce",
			"startups",
			"entrepreneur",
			"smallbusiness",
			"SaaS",
			"web_design",
			"Frontend",
			"backend",
			"node",
			"API",
			"automation",
			"n8n",
			"nocode",
			"webscraping",
			"datascience",
			"learnprogramming",
		],
		scoreSystemPrompt: `You score Reddit posts for a software development agency client.

Agency: karyam.xyz — full-service software development agency.
We build: mobile apps, web apps, workflows/automation, websites, landing pages, ecommerce stores, plugins, APIs, SDKs, documentation sites, scrapers, integrations.

Score each post 1-5:
5 = someone needs an agency/dev to build something we do (hiring, RFPs, "looking for developer", "need an app/website/API/scraper")
4 = clear pain we can solve as a custom build (broken workflow, need ecommerce, need mobile app, need scraper/API)
3 = adjacent interest
1-2 = not a fit

Also set:
- "problemType": short label (e.g. "mobile_app", "ecommerce", "scraper", "api", "landing_page", "workflow", "plugin", "documentation")
- "solutionFit": one sentence how karyam.xyz could help
- "reason": short

Return ONLY JSON:
{ "results": [{ "permalink": "/r/...", "score": number, "reason": "short", "problemType": "", "solutionFit": "" }] }
Include every post. Use exact permalink strings.`,
	},

	ihatereading: {
		id: "ihatereading",
		name: "iHateReading Content Marketing",
		site: "https://ihatereading.in",
		collection: "redditIhatereadingPosts",
		relevanceMin: 4,
		subreddits: [
			"javascript",
			"reactjs",
			"reactnative",
			"nextjs",
			"webdev",
			"Frontend",
			"css",
			"HTML",
			"node",
			"typescript",
			"supabase",
			"Firebase",
			"clerk",
			"stripe",
			"fullStack",
			"learnprogramming",
			"webdevtutorials",
			"Programming",
			"coding",
			"AskProgramming",
			"cscareerquestions",
			"react",
			"tailwindcss",
			"vercel",
		],
		scoreSystemPrompt: `You score Reddit posts for iHateReading (ihatereading.in) — a developer-focused technical blog/publication.

Goal:
1) Find coding problems / questions where a helpful technical reply (and optionally linking a relevant blog) would help.
2) Only CODING topics: JavaScript, React, React Native, CSS, HTML, Next.js, Supabase, Clerk, Firebase, Stripe/payments, full-stack, TypeScript, Node.
3) Reject non-coding (career gossip without tech, politics, pure hiring spam, off-topic).

Score 1-5:
5 = specific coding problem/question we can answer with a tutorial-style reply
4 = good discussion of tools/stack pain (auth, payments, full-stack) where a blog could help
3 = weak tech signal
1-2 = not coding or not useful for content marketing

Also set:
- "problemType": e.g. "react_hooks", "firebase_auth", "stripe_integration", "css_layout"
- "marketingAngle": how a blog reply could help (no spammy tone)
- "reason": short

Return ONLY JSON:
{ "results": [{ "permalink": "/r/...", "score": number, "reason": "", "problemType": "", "marketingAngle": "" }] }
Include every post. Use exact permalinks.`,
	},

	buildsaas: {
		id: "buildsaas",
		name: "BuildSaaS boilerplate monitor",
		site: "https://www.buildsaas.dev",
		collection: "redditBuildsaasPosts",
		relevanceMin: 4,
		subreddits: [
			"SaaS",
			"startups",
			"Entrepreneur",
			"indiehackers",
			"SideProject",
			"IMadeThis",
			"nextjs",
			"webdev",
			"Firebase",
			"vercel",
			"supabase",
			"stripe",
			"smallbusiness",
			"EntrepreneurRideAlong",
			"nocode",
			"alphaandbetausers",
			"microsaas",
			"learnprogramming",
		],
		discoverQueries: [
			"site:reddit.com saas boilerplate OR starter kit Next.js",
			"site:reddit.com ShipFast OR MakerKit OR Supastarter alternative",
			"site:reddit.com looking for nextjs firebase saas template",
			"site:reddit.com polar.sh OR stripe subscription nextjs boilerplate",
			"site:reddit.com admin dashboard boilerplate nextjs",
			"site:reddit.com how to add auth payments blog to nextjs saas",
			"site:reddit.com launch saas without building from scratch",
		],
		scoreSystemPrompt: `You score Reddit posts for BuildSaaS (https://www.buildsaas.dev) — a Next.js SaaS boilerplate / starter kit.

Product: Next.js 15 Pages Router, Firebase Auth + Firestore, Polar.sh payments, Resend email, admin panel (blog, customers, invoices, cron, docs), Vercel deploy. Sell to solo founders who want to ship a SaaS without assembling auth/payments/admin/CMS themselves.

KEEP posts where someone:
- wants a SaaS boilerplate, starter kit, template, or "ShipFast-like" kit
- is adding auth, Polar/Stripe, admin, blog, email, or billing to a Next.js app and would rather buy a starter
- asks how to launch a SaaS / indie product faster (boilerplate is a fit)
- compares starter kits or is tired of wiring Firebase + payments + admin from scratch

REJECT: generic "what SaaS should I build", pure homework, agency hiring with no starter-kit intent, unrelated career posts, crypto.

Score 1-5:
5 = actively looking to buy/use a Next.js SaaS starter or named alternative
4 = clear pain assembling auth/payments/admin/blog that BuildSaaS solves
3 = weak "I want to start a SaaS" with no stack pain
1-2 = not a boilerplate buyer

Also set:
- "problemType": looking_for_boilerplate | auth_payments_setup | admin_cms | comparing_starters | launch_faster | other
- "solutionFit": one sentence how buildsaas.dev helps (no spam)
- "intent": buy | diy | research
- "reason": short

Return ONLY JSON:
{ "results": [{ "permalink": "/r/...", "score": 0, "reason": "", "problemType": "", "solutionFit": "", "intent": "" }] }
Include every post. Use exact permalinks.`,
	},

	saas: {
		id: "saas",
		name: "SaaS Problem Finder",
		site: null,
		collection: "redditSaasPosts",
		relevanceMin: 4,
		/** Seed subs — also discovers more via Google site:reddit.com */
		subreddits: [
			"SaaS",
			"startups",
			"Entrepreneur",
			"smallbusiness",
			"IndieBiz",
			"microsaas",
			"SideProject",
			"IMadeThis",
			"alphaandbetausers",
			"EntrepreneurRideAlong",
			"growmybusiness",
			"ProductManagement",
			"sales",
			"marketing",
			"freelance",
		],
		discoverQueries: [
			"site:reddit.com SaaS problem",
			"site:reddit.com looking for SaaS tool",
			"site:reddit.com alternative to expensive SaaS",
			"site:reddit.com I wish there was a tool for",
			"site:reddit.com micro SaaS idea pain",
			"site:reddit.com need automation for my business",
			"site:reddit.com billing subscription headache",
			"site:reddit.com CRM too expensive small business",
		],
		scoreSystemPrompt: `You score Reddit posts for SaaS problem discovery.

Context: Shrey is a full-stack software developer who can ship:
- simple landing pages / Gumroad digital products
- open-source GitHub tools
- subscription SaaS products
Any size of SaaS-related problem is interesting if it is a real user/business pain that software can fix.

INCLUDE: SaaS product pain, tooling gaps, workflow automation needs, billing/auth/onboarding issues for products, "I need a tool that…", expensive software complaints, indie hacker problems, B2B process pain.
EXCLUDE: pure coding homework, non-business personal issues, crypto pumps, hiring spam with no problem statement.

Score 1-5:
5 = clear SaaS-shaped problem with buying/building intent
4 = strong pain that could become landing page, template, OSS, or subscription product
3 = weak signal
1-2 = not SaaS-related

Also set:
- "problemType": short label
- "solutionFit": "landing_page" | "gumroad_template" | "subscription_saas" | "opensource_github" | "mixed"
- "reason": short problem summary

		Return ONLY JSON:
{ "results": [{ "permalink": "/r/...", "score": number, "reason": "", "problemType": "", "solutionFit": "" }] }
Include every post. Use exact permalinks.`,
	},

	scraping: {
		id: "scraping",
		name: "Scraping / data-collection problem finder",
		site: null,
		collection: "redditScrapingPosts",
		stateCollection: "redditScrapingAgentState",
		relevanceMin: 4,
		subsPerRun: Number(process.env.REDDIT_SCRAPING_SUBS_PER_RUN || "10"),
		queriesPerRun: Number(process.env.REDDIT_SCRAPING_QUERIES_PER_RUN || "3"),
		subreddits: [
			"webscraping",
			"scrapy",
			"datasets",
			"datascience",
			"dataengineering",
			"BigData",
			"MachineLearning",
			"LocalLLaMA",
			"LangChain",
			"ChatGPT",
			"OpenAI",
			"automation",
			"n8n",
			"selfhosted",
			"SEO",
			"forhire",
			"slavelabour",
			"python",
			"learnpython",
			"SaaS",
		],
		discoverQueries: [
			'site:reddit.com looking for a web scraper OR "need to scrape"',
			"site:reddit.com AI scraper agent OR AI scraping",
			"site:reddit.com data collection service OR crawl a website",
			'site:reddit.com "need a dataset" OR scrape leads directory',
			"site:reddit.com puppeteer OR playwright scrape blocked",
			"site:reddit.com firecrawl OR apify OR scrapy alternative",
			"site:reddit.com monitoring agent scrape prices OR listings",
			"site:reddit.com build a directory by scraping OR database of",
			"site:reddit.com hiring scraper OR looking for data engineer scrape",
			"site:reddit.com anti-bot captcha scrape at scale",
		],
		scoreSystemPrompt: `You score Reddit posts for SCRAPING and DATA-COLLECTION demand.

Keep posts where people:
- have a scraping problem (blocked, captcha, scale, selectors broke)
- want data collected: leads, listings, prices, directories, databases, datasets built by crawling
- look for scrapers, crawlers, monitoring agents, AI scraper agents, browser agents
- hire someone or a tool to scrape, crawl, or keep a dataset updated
- want a directory/database populated via scraping

Reject: homework with no real data goal, unrelated ML theory, memes, generic SaaS with no scrape/data angle.

Score 1-5:
5 = clear scrape / data-collection / AI-scraper-agent need (hire, buy, or DIY with a real target)
4 = strong pain (blocked scraper, need dataset/directory, monitoring crawl)
3 = weak adjacent signal
1-2 = not about scraping or data collection

Also set:
- "problemType": scrape_blocked | need_dataset | need_directory | ai_scraper_agent | monitoring | hiring_scraper | anti_bot | other
- "intent": hire | buy_tool | diy | dataset | directory | monitoring
- "tags": string[] (e.g. ["puppeteer","leads","serp"])
- "solutionFit": one line what a scraper/agent/directory would do
- "reason": short

Return ONLY JSON:
{ "results": [{ "permalink": "/r/...", "score": 0, "reason": "", "problemType": "", "intent": "", "tags": [], "solutionFit": "" }] }
Include every post. Use exact permalinks.`,
	},

	directories: {
		id: "directories",
		name: "Directory / aggregator idea finder",
		site: null,
		collection: "redditDirectoryPosts",
		stateCollection: "redditDirectoryAgentState",
		relevanceMin: 4,
		subsPerRun: Number(process.env.REDDIT_DIRECTORIES_SUBS_PER_RUN || "10"),
		queriesPerRun: Number(process.env.REDDIT_DIRECTORIES_QUERIES_PER_RUN || "3"),
		subreddits: [
			"web_design",
			"graphic_design",
			"logodesign",
			"design",
			"UI_Design",
			"webdev",
			"javascript",
			"reactjs",
			"SaaS",
			"startups",
			"entrepreneur",
			"ecommerce",
			"shopify",
			"marketing",
			"sales",
			"MachineLearning",
			"LocalLLaMA",
			"ChatGPT",
			"artificial",
			"OpenAI",
			"LangChain",
			"datasets",
			"datascience",
			"dataengineering",
			"webscraping",
			"SideProject",
			"IMadeThis",
			"InternetIsBeautiful",
			"nocode",
			"emailmarketing",
			"WordPress",
			"Frontend",
			"gamedev",
			"learnprogramming",
		],
		discoverQueries: [
			'site:reddit.com "is there a directory of"',
			"site:reddit.com looking for a collection of tools",
			"site:reddit.com awesome list OR aggregator website",
			"site:reddit.com alternative to Product Hunt OR AlternativeTo",
			"site:reddit.com kaggle dataset directory OR data collection",
			"site:reddit.com logo inspiration gallery OR logo collection",
			"site:reddit.com email template collection OR gallery",
			"site:reddit.com AI agents directory OR LLM tools list",
			"site:reddit.com SaaS alternatives list OR directory",
			"site:reddit.com CRM OR CMS directory of tools",
			"site:reddit.com best SDK list OR developer tools directory",
			"site:reddit.com ecommerce tools collection",
			"site:reddit.com image dataset OR icon pack collection",
			"site:reddit.com where can I find a list of",
		],
		scoreSystemPrompt: `You score Reddit posts for DIRECTORY / AGGREGATOR website ideas.

Goal: find what people want collected in one place so we know which directory site to build.

KEEP posts that ask for or discuss:
- aggregator / inspiration / collection / gallery / showcase websites
- "alternatives to" lists, comparisons, "is there a directory of X"
- directories, databases, catalogs, awesome-lists, tool lists
- data collections like Kaggle datasets, crawls, public databases
- lists of: design, development, AI, SDKs, agents, SaaS, ecommerce, CRM, CMS, graphics, logos, emails, images, templates

REJECT: pure hiring, homework, unrelated memes, generic "how do I code X" with no collection/directory intent.

Score 1-5:
5 = someone clearly wants a directory/collection/alternatives list we could ship
4 = strong "where do I find all the X" / inspiration gallery / dataset demand
3 = weak listicle-ish signal
1-2 = not a directory idea

Also set:
- "problemType": niche label (design, development, AI, SDK, agents, saas, ecommerce, crm, cms, graphics, logos, emails, images, datasets, other)
- "ideaTitle": short name of the directory to build (e.g. "AI agents directory", "logo inspiration gallery")
- "directoryCategory": same niche as problemType
- "tags": string[] of niches that apply
- "solutionFit": one line what the directory would contain
- "reason": short

Return ONLY JSON:
{ "results": [{ "permalink": "/r/...", "score": 0, "reason": "", "problemType": "", "ideaTitle": "", "directoryCategory": "", "tags": [], "solutionFit": "" }] }
Include every post. Use exact permalinks.`,
	},
};

export function getAgent(id) {
	const key = String(id || "")
		.trim()
		.toLowerCase();
	return AGENTS[key] || null;
}

export function listAgentIds() {
	return Object.keys(AGENTS);
}
