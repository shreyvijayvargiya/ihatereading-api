export function nowIso() {
  return new Date().toISOString();
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function splitKeywords(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value || "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Map frontend phase toggles to orchestrator phase ids */
export function expandPhaseFlags(phases = {}) {
  let p = phases || {};
  if (Array.isArray(phases)) {
    p = Object.fromEntries(phases.map((name) => [name, true]));
  }
  const fromArray = Array.isArray(phases);
  const flag = (key, aliases = []) => {
    if (fromArray) {
      return p[key] === true || aliases.some((a) => p[a] === true);
    }
    if (key in p) return p[key] !== false && p[key] !== 0 && p[key] !== "false";
    for (const a of aliases) {
      if (a in p) return p[a] !== false && p[a] !== 0 && p[a] !== "false";
    }
    return true;
  };

  // Legacy simplified keys from earlier UI
  if (
    !("searchDemand" in p || "competitors" in p || "architecture" in p) &&
    ("discovery" in p || "competitive" in p || "technical" in p || "community" in p || "synthesis" in p)
  ) {
    return {
      planning: true,
      searchDemand: flag("discovery"),
      competitors: flag("competitive"),
      productDecomposition: flag("technical"),
      architecture: flag("technical"),
      apis: flag("technical"),
      npm: flag("technical"),
      github: flag("technical") || flag("community"),
      ui: flag("technical"),
      database: flag("technical"),
      folderStructure: flag("technical"),
      costs: flag("technical"),
      security: flag("technical"),
      performance: flag("technical"),
      testing: flag("technical"),
      deployment: flag("technical"),
      seo: flag("seo"),
      aeo: flag("seo"),
      internalLinks: true,
      images: flag("synthesis", ["images"]),
      synthesis: flag("synthesis"),
      writing: true,
      review: true,
    };
  }

  return {
    planning: true,
    searchDemand: flag("searchDemand"),
    competitors: flag("competitors"),
    productDecomposition: flag("productDecomposition"),
    architecture: flag("architecture"),
    apis: flag("apis"),
    npm: flag("npm"),
    github: flag("github"),
    ui: flag("ui"),
    database: flag("database"),
    folderStructure: flag("folderStructure"),
    costs: flag("costs"),
    security: flag("security"),
    performance: flag("performance"),
    testing: flag("testing"),
    deployment: flag("deployment"),
    seo: flag("seo"),
    aeo: flag("aeo"),
    internalLinks: flag("internalLinks"),
    images: flag("images"),
    synthesis: true,
    writing: true,
    review: true,
  };
}

export const PHASE_DEFS = [
  { id: "planning", name: "Research Planning" },
  { id: "searchDemand", name: "Search Demand" },
  { id: "competitors", name: "Competitor / SERP Research" },
  { id: "productDecomposition", name: "Product Decomposition" },
  { id: "architecture", name: "Architecture Research" },
  { id: "apis", name: "API Research" },
  { id: "npm", name: "NPM Research" },
  { id: "github", name: "GitHub Research" },
  { id: "ui", name: "UI Research" },
  { id: "database", name: "Database Design" },
  { id: "folderStructure", name: "Folder Structure" },
  { id: "costs", name: "Cost Research" },
  { id: "security", name: "Security" },
  { id: "performance", name: "Performance" },
  { id: "testing", name: "Testing" },
  { id: "deployment", name: "Deployment" },
  { id: "seo", name: "SEO" },
  { id: "aeo", name: "AEO" },
  { id: "synthesis", name: "Research Synthesis" },
  { id: "writing", name: "Guide Generation" },
  { id: "review", name: "Technical Review" },
  { id: "images", name: "Image Planning" },
];
