import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const prompts = {
	modernDark: {
    name: "modern-dark",
    prompt: await readFile(path.join(__dirname, "modern-dark-prompt.mdx"), "utf-8"),
  },
  bauhaus: {
    name: "bauhaus",
    prompt: await readFile(path.join(__dirname, "bauhaus-prompt.mdx"), "utf-8"),
  },
  newsprint: {
    name: "newsprint",
    prompt: await readFile(path.join(__dirname, "newsprint.mdx"), "utf-8"),
  },
  techStyle: {
    name: "tech-style",
    prompt: await readFile(path.join(__dirname, "tech-style.mdx"), "utf-8"),
  },
  monochrome: {
    name: "monochrome",
    prompt: await readFile(path.join(__dirname, "monochrome.mdx"), "utf-8"),
  },
  flatDesign: {
    name: "flat-design",
    prompt: await readFile(path.join(__dirname, "flat-design.mdx"), "utf-8"),
  },
  swissMinimilistic: {
    name: "swiss-minimilistic",
    prompt: await readFile(path.join(__dirname, "swiss-minimilistic.mdx"), "utf-8"),
  },
  luxury: {
    name: "luxury",
    prompt: await readFile(path.join(__dirname, "luxury.mdx"), "utf-8"),
  },
  geometric: {
    name: "geometric",
    prompt: await readFile(path.join(__dirname, "geometric.mdx"), "utf-8"),
  },
  clayMorphism: {
    name: "clay-morphism",
    prompt: await readFile(path.join(__dirname, "clay-morphism.mdx"), "utf-8"),
  },
  vaporwave: {
    name: "vaporwave",
    prompt: await readFile(path.join(__dirname, "vaporwave.mdx"), "utf-8"),
  },
  handDrawnSketch: {
    name: "hand-drawn-sketch",
    prompt: await readFile(path.join(__dirname, "hand-drawn-sketch.mdx"), "utf-8"),
  },
  neomorphism: {
    name: "neomorphism",
    prompt: await readFile(path.join(__dirname, "neomorphism.mdx"), "utf-8"),
  },
  neutral: {
    name: "neutral",
    prompt: await readFile(path.join(__dirname, "neutral.mdx"), "utf-8"),
  },
  maximilism: {
    name: "maximilism",
    prompt: await readFile(path.join(__dirname, "maximilism.mdx"), "utf-8"),
  },
  terminal: {
    name: "terminal",
    prompt: await readFile(path.join(__dirname, "terminal.mdx"), "utf-8"),
  },
  kinectic: {
    name: "kinectic",
    prompt: await readFile(path.join(__dirname, "kinectic.mdx"), "utf-8"),
  },
  botanical: {
    name: "botanical",
    prompt: await readFile(path.join(__dirname, "botanical.mdx"), "utf-8"),
  },
  corporateTrust: {
    name: "corporate-trust",
    prompt: await readFile(path.join(__dirname, "corporate-trust.mdx"), "utf-8"),
  },
  industrial: {
    name: "industrial",
    prompt: await readFile(path.join(__dirname, "industrial.mdx"), "utf-8"),
  },
  crypto: {
    name: "crypto",
    prompt: await readFile(path.join(__dirname, "crypto.mdx"), "utf-8"),
  },
  material: await readFile(path.join(__dirname, "material-prompt.mdx"), "utf-8"),
  academia: {
    name: "academia",
    prompt: await readFile(path.join(__dirname, "academia-prompt.mdx"), "utf-8"),
  },
  neoBrutalism: {
    name: "neo-brutalism",
    prompt: await readFile(path.join(__dirname, "neo-brutalism.mdx"), "utf-8"),
  },
};
