import { getEnv } from "../config/env.js";

async function post(path, body, { timeoutMs = 90_000 } = {}) {
  const env = getEnv();
  const url = `${env.scraperBase}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = { "Content-Type": "application/json" };
  if (env.scraperApiKey) headers.Authorization = `Bearer ${env.scraperApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.message || `Scraper HTTP ${res.status}`);
  }
  return data;
}

function isJunkSearchUrl(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) return true;
    if (host === "bing.com" || host.endsWith(".bing.com")) return true;
    if (u.pathname.includes("/y.js")) return true;
    if (u.searchParams.has("ad_domain") || u.searchParams.has("ad_provider")) return true;
    return false;
  } catch {
    return true;
  }
}

function unwrapDdgHref(href) {
  let out = href;
  const uddg = out.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try {
      out = decodeURIComponent(uddg[1]);
    } catch {
      /* keep */
    }
  }
  const u3 = out.match(/[?&]u3=([^&]+)/);
  if (u3) {
    try {
      out = decodeURIComponent(u3[1]);
    } catch {
      /* keep */
    }
  }
  return out;
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const QUERY_STOPWORDS = new Set([
  "how", "what", "does", "with", "from", "your", "this", "that", "into", "vs",
  "the", "and", "for", "best", "are", "you", "use", "using",
]);

function queryTokens(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/site:\S+/g, (match) => ` ${match.split(/[/:]+/).pop() || ""} `)
    .split(/[^a-z0-9.+]+/)
    .filter((token) => token.length > 3 && !QUERY_STOPWORDS.has(token));
}

function isOffTopic(query, row) {
  const url = String(row.url || "").toLowerCase();
  const blob = `${row.title || ""} ${url} ${row.snippet || ""}`.toLowerCase();
  let host = "";
  try {
    host = new URL(row.url).hostname.replace(/^www\./, "");
  } catch {
    return true;
  }
  if (host === "github.com" && /^\/(login|signup)?$/.test(new URL(row.url).pathname)) return true;
  if (host === "desktop.github.com") return true;
  if (/(^|\.)((tripadvisor|yelp|merriam-webster|cambridge|collinsdictionary)\.com|cambridge\.org)$/.test(host)) {
    return true;
  }
  const codingQuery = /agent|ide|coding|editor|github|npm|api|architecture|llm/.test(query.toLowerCase());
  if (codingQuery && /custom cursor|mouse pointer|cursor library|rw-designer|sweezy cursors/.test(blob)) {
    return true;
  }
  const tokens = queryTokens(query);
  if (tokens.length && !tokens.some((token) => blob.includes(token))) return true;
  return false;
}

function keepRelevant(query, rows, limit) {
  const kept = [];
  for (const row of rows) {
    const title = decodeEntities(row.title);
    const snippet = decodeEntities(row.snippet);
    const next = { ...row, title, snippet };
    if (!next.url || isJunkSearchUrl(next.url) || isOffTopic(query, next)) continue;
    if (kept.some((item) => item.url === next.url)) continue;
    kept.push(next);
    if (kept.length >= limit) break;
  }
  return kept;
}

function decodeBingRedirect(href) {
  const cleaned = String(href || "").replace(/&amp;/g, "&").trim();
  if (!cleaned) return "";
  try {
    const u = new URL(cleaned);
    const token = u.searchParams.get("u");
    if (token && token.startsWith("a1")) {
      const b64 = token.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const decoded = Buffer.from(padded, "base64").toString("utf8");
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
    if (/^https?:\/\//i.test(u.href) && !isJunkSearchUrl(u.href)) return u.href;
  } catch {
    /* ignore */
  }
  return /^https?:\/\//i.test(cleaned) && !isJunkSearchUrl(cleaned) ? cleaned : "";
}

/** Bing HTML SERP. Headless Google is usually a CAPTCHA and DuckDuckGo HTML is a bot wall. */
async function searchBing(query, limit = 8) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit}&setlang=en`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const re = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) && results.length < limit) {
    const resolved = decodeBingRedirect(match[1]);
    if (!resolved || isJunkSearchUrl(resolved)) continue;
    const title = decodeEntities(match[2].replace(/<[^>]+>/g, " "));
    const after = html.slice(match.index, match.index + 900);
    const snippet = decodeEntities((after.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "").replace(/<[^>]+>/g, " "));
    results.push({
      title: title || "Untitled",
      url: resolved,
      snippet,
      source: "bing",
    });
  }
  return keepRelevant(query, results, limit);
}

/** Lightweight DuckDuckGo HTML fallback when internal /google-search is down or empty */
async function searchDuckDuckGo(query, limit = 8) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const re =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) && results.length < limit) {
    let href = unwrapDdgHref(match[1]);
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    if (!href.startsWith("http") || isJunkSearchUrl(href)) continue;
    results.push({
      title: decodeEntities(title) || "Untitled",
      url: href,
      snippet: "",
      source: "duckduckgo",
    });
  }
  return keepRelevant(query, results, limit);
}

export async function searchGoogle(query, { limit = 8 } = {}) {
  const env = getEnv();
  let bingAnswered = false;
  try {
    const bing = await searchBing(query, limit);
    bingAnswered = true;
    return bing;
  } catch (err) {
    console.warn("[guideforge] bing search failed:", err.message);
  }
  let ddgFallback = [];
  try {
    ddgFallback = await searchDuckDuckGo(query, limit);
    if (ddgFallback.length) return ddgFallback;
  } catch (err) {
    console.warn("[guideforge] ddg search failed:", err.message);
  }
  if (bingAnswered) return [];
  try {
    const data = await post(env.googleSearchPath, { query, num: limit }, { timeoutMs: 18_000 });
    const rows = data.results || data.data?.results || [];
    const mapped = rows
      .slice(0, limit)
      .map((row) => ({
        title: row.title || "Untitled",
        url: row.link || row.url || "",
        snippet: row.description || row.snippet || "",
        source: "google",
      }))
      .filter((r) => r.url && !isJunkSearchUrl(r.url));
    const relevant = keepRelevant(query, mapped, limit);
    if (relevant.length) return relevant;
  } catch (err) {
    console.warn("[guideforge] google search failed:", err.message);
  }
  return keepRelevant(query, ddgFallback, limit);
}

export async function scrapeUrl(url, { timeoutMs = 45_000 } = {}) {
  const env = getEnv();
  try {
    const data = await post(env.scrapeUrlPath, { url }, { timeoutMs });
    const markdown = data.markdown || data.data?.markdown || data.summary || "";
    const title = data.data?.title || data.title || url;
    return {
      url,
      title,
      content: String(markdown).slice(0, 12000),
      success: data.success !== false && Boolean(markdown),
      raw: data,
    };
  } catch (err) {
    // Minimal direct fetch fallback for public pages
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "GuideForgeResearch/0.1" },
        signal: AbortSignal.timeout(20_000),
        redirect: "follow",
      });
      const html = await res.text();
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url)
        .replace(/\s+/g, " ")
        .trim();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 12000);
      return {
        url,
        title,
        content: text,
        success: text.length > 80,
        error: text.length > 80 ? null : err.message,
      };
    } catch (fallbackErr) {
      return {
        url,
        title: url,
        content: "",
        success: false,
        error: fallbackErr.message || err.message,
      };
    }
  }
}

export async function scrapeMultiple(urls, { concurrency = 3, timeoutMs = 40_000 } = {}) {
  const env = getEnv();
  try {
    const data = await post(
      env.scrapeMultiplePath,
      { urls, concurrency },
      { timeoutMs },
    );
    const rows = data.results || data.data || [];
    if (Array.isArray(rows) && rows.length) {
      return rows.map((row) => ({
        url: row.url,
        title: row.data?.title || row.title || row.url,
        content: String(row.markdown || row.data?.markdown || "").slice(0, 12000),
        success: row.success !== false,
      }));
    }
  } catch {
    /* fall through */
  }
  const out = [];
  for (const url of urls) {
    out.push(await scrapeUrl(url, { timeoutMs: Math.min(timeoutMs, 20_000) }));
  }
  return out;
}
