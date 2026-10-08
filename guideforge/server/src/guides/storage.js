import path from "node:path";
import {
  guideDir,
  readJson,
  writeJson,
  writeText,
  readText,
  listGuideSlugs,
  uniqueGuideSlug,
} from "../storage/filesystem.js";

export async function createGuideShell(job) {
  const slug = await uniqueGuideSlug(job.topic);
  const dir = guideDir(slug);
  const now = new Date().toISOString();
  const metadata = {
    slug,
    title: job.topic,
    description: job.description || "",
    keywords: [...(job.primaryKeywords || []), ...(job.secondaryKeywords || [])],
    audience: job.audience || [],
    status: "draft",
    researchStatus: "running",
    jobId: job.id,
    progress: 0,
    imageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(path.join(dir, "metadata.json"), metadata);
  await writeJson(path.join(dir, "status.json"), { status: "draft", updatedAt: now });
  await writeText(path.join(dir, "guide.md"), `# ${job.topic}\n\n_Research in progress..._\n`);
  return metadata;
}

export async function saveGuideArtifacts(slug, {
  metadata,
  markdown,
  research,
  sources,
  imagePlan,
  sections,
}) {
  const dir = guideDir(slug);
  if (metadata) await writeJson(path.join(dir, "metadata.json"), metadata);
  if (markdown != null) await writeText(path.join(dir, "guide.md"), markdown);
  if (research) {
    await writeJson(path.join(dir, "research.json"), research);
    await writeText(
      path.join(dir, "research.md"),
      `# Research — ${metadata?.title || slug}\n\n${research.summary || ""}\n`,
    );
  }
  if (sources) await writeJson(path.join(dir, "sources.json"), sources);
  if (imagePlan) {
    await writeJson(path.join(dir, "image-plan.json"), { images: imagePlan });
    await writeText(
      path.join(dir, "images", "plan.md"),
      imagePlan.map((img) => `## ${img.title}\n\n${img.prompt}\n`).join("\n"),
    );
  }
  if (sections) await writeJson(path.join(dir, "sections.json"), sections);
  await writeJson(path.join(dir, "status.json"), {
    status: metadata?.status || "draft",
    updatedAt: new Date().toISOString(),
  });
}

export async function getGuide(slug) {
  const dir = guideDir(slug);
  const metadata = await readJson(path.join(dir, "metadata.json"), null);
  if (!metadata) return null;
  const markdown = await readText(path.join(dir, "guide.md"), "");
  const research = await readJson(path.join(dir, "research.json"), {});
  const sources = await readJson(path.join(dir, "sources.json"), []);
  const imagePlan = await readJson(path.join(dir, "image-plan.json"), { images: [] });
  const sections = await readJson(path.join(dir, "sections.json"), {});
  return {
    ...metadata,
    markdown,
    finalGuide: markdown,
    research,
    sources,
    imagePlan,
    images: imagePlan.images || [],
    sections: {
      overview: sections.overview || metadata.description || research.summary || "",
      research: sections.research || research.summary || "",
      architecture: sections.architecture || research.architecture || "",
      apis: sections.apis || formatList(research.apis),
      npm: sections.npm || formatList(research.npm),
      github: sections.github || formatList(research.github),
      database: sections.database || research.database || "",
      roadmap: sections.roadmap || formatList(research.roadmap),
      costs: sections.costs || research.costs || "",
      images: (imagePlan.images || []).map((i) => `- ${i.title} (${i.status})`).join("\n"),
      seo: sections.seo || research.seoAeo || "",
      seoAeo: sections.seo || research.seoAeo || "",
      final: markdown,
      ...sections,
    },
  };
}

function formatList(items) {
  if (!items) return "";
  if (typeof items === "string") return items;
  return (Array.isArray(items) ? items : [])
    .map((item) => (typeof item === "string" ? `- ${item}` : `- ${JSON.stringify(item)}`))
    .join("\n");
}

export async function listGuides(filter = {}) {
  const slugs = await listGuideSlugs();
  const guides = [];
  for (const slug of slugs) {
    const meta = await readJson(path.join(guideDir(slug), "metadata.json"), null);
    if (!meta) continue;
    if (filter.status && String(meta.status).toLowerCase() !== String(filter.status).toLowerCase()) {
      continue;
    }
    if (filter.q) {
      const hay = `${meta.title} ${meta.description} ${(meta.keywords || []).join(" ")}`.toLowerCase();
      if (!hay.includes(String(filter.q).toLowerCase())) continue;
    }
    const imagePlan = await readJson(path.join(guideDir(slug), "image-plan.json"), { images: [] });
    guides.push({
      ...meta,
      imageCount: (imagePlan.images || []).length,
      imagesPlanned: (imagePlan.images || []).filter((i) => i.status === "planned").length,
    });
  }
  return guides.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function updateGuideMarkdown(slug, markdown) {
  const guide = await getGuide(slug);
  if (!guide) return null;
  const metadata = {
    ...guide,
    updatedAt: new Date().toISOString(),
  };
  delete metadata.markdown;
  delete metadata.finalGuide;
  delete metadata.research;
  delete metadata.sources;
  delete metadata.imagePlan;
  delete metadata.images;
  delete metadata.sections;
  await writeText(path.join(guideDir(slug), "guide.md"), markdown);
  await writeJson(path.join(guideDir(slug), "metadata.json"), metadata);
  return getGuide(slug);
}

export async function getImagePlan(slug) {
  const plan = await readJson(path.join(guideDir(slug), "image-plan.json"), null);
  return plan || { images: [] };
}

export async function saveImagePlan(slug, images) {
  await writeJson(path.join(guideDir(slug), "image-plan.json"), { images });
  const meta = await readJson(path.join(guideDir(slug), "metadata.json"), null);
  if (meta) {
    meta.imageCount = images.length;
    meta.updatedAt = new Date().toISOString();
    await writeJson(path.join(guideDir(slug), "metadata.json"), meta);
  }
  return { images };
}
