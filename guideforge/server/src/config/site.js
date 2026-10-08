/** Site profile — keep engine generic for extraction later */
export const siteConfig = {
  name: "iHateReading",
  domain: "ihatereading.in",
  contentStyle: "technical-founder",
  internalSearch: true,
  roadmaps: true,
};

/** Placeholder for verified internal content search (V1: no invented URLs) */
export async function searchInternalContent(query) {
  // Future: query iHateReading content index / filesystem.
  // Never invent URLs — return empty until a real source is wired.
  void query;
  return [];
}
