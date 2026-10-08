import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { dataRoot, guidesDir, jobsDir, researchDir, settingsPath, defaultSiteConfig } from "../config/env.js";

export async function ensureDataDirs() {
  await mkdir(jobsDir, { recursive: true });
  await mkdir(guidesDir, { recursive: true });
  await mkdir(researchDir, { recursive: true });
  await mkdir(path.dirname(settingsPath), { recursive: true });
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file);
}

export async function writeText(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

export async function readText(file, fallback = "") {
  try {
    return await readFile(file, "utf8");
  } catch {
    return fallback;
  }
}

export function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "guide";
}

export async function uniqueGuideSlug(title) {
  const base = slugify(title);
  let slug = base;
  let i = 2;
  while (true) {
    try {
      await readFile(path.join(guidesDir, slug, "metadata.json"));
      slug = `${base}-${i}`;
      i += 1;
    } catch {
      return slug;
    }
  }
}

export function jobPath(id) {
  return path.join(jobsDir, `${id}.json`);
}

export function guideDir(slug) {
  return path.join(guidesDir, slug);
}

export async function listGuideSlugs() {
  try {
    const entries = await readdir(guidesDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function listJobFiles() {
  try {
    const files = await readdir(jobsDir);
    return files.filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

export async function loadSettings() {
  const stored = await readJson(settingsPath, null);
  return { ...defaultSiteConfig, ...(stored || {}) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await writeJson(settingsPath, next);
  return next;
}

export { dataRoot, guidesDir, jobsDir, researchDir };
