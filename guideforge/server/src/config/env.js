import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const serverRoot = path.resolve(__dirname, "../..");
export const dataRoot = path.join(serverRoot, "data");
export const jobsDir = path.join(dataRoot, "jobs");
export const guidesDir = path.join(dataRoot, "guides");
export const researchDir = path.join(dataRoot, "research");
export const imagesDir = path.join(dataRoot, "images");
export const settingsPath = path.join(dataRoot, "settings.json");
/** Canonical env file for GuideForge OpenRouter + scraper settings */
export const guideforgeEnvPath = path.join(serverRoot, ".env");

export const budgets = {
  quick: { maxSearches: 24, maxUrls: 18, maxMinutes: 30 },
  deep: { maxSearches: 102, maxUrls: 51, maxMinutes: 30 },
  maximum: { maxSearches: 120, maxUrls: 70, maxMinutes: 30 },
};

function readEnvFileValue(filePath, key) {
  try {
    if (!existsSync(filePath)) return "";
    const text = readFileSync(filePath, "utf8");
    const m = text.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
    return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "";
  } catch {
    return "";
  }
}

export function getEnv() {
  const keyFromProcess = process.env.OPENROUTER_API_KEY?.trim() || "";
  const keyFromFile = readEnvFileValue(guideforgeEnvPath, "OPENROUTER_API_KEY");
  return {
    port: Number(process.env.GUIDEFORGE_PORT || process.env.PORT || 8790),
    openRouterKey: keyFromProcess || keyFromFile || "",
    openRouterModel:
      process.env.OPENROUTER_MODEL?.trim() ||
      readEnvFileValue(guideforgeEnvPath, "OPENROUTER_MODEL") ||
      process.env.OPENROUTER_FREE_MODEL?.trim() ||
      "openai/gpt-4o-mini",
    openRouterEnvFile: guideforgeEnvPath,
    scraperBase: (process.env.SCRAPER_BASE_URL || "http://127.0.0.1:3002").replace(/\/$/, ""),
    googleSearchPath: process.env.GOOGLE_SEARCH_ENDPOINT || "/google-search",
    scrapeUrlPath: process.env.SCRAPE_URL_ENDPOINT || "/scrape",
    scrapeMultiplePath: process.env.SCRAPE_MULTIPLE_ENDPOINT || "/scrape-multiple",
    scraperApiKey: process.env.SCRAPER_API_KEY?.trim() || "",
  };
}

export const defaultSiteConfig = {
  name: "iHateReading",
  domain: "ihatereading.in",
  contentStyle: "technical-founder",
  internalSearch: true,
  roadmaps: true,
};
