export function imagePlannerSystem() {
  return `You plan technical images for engineering guides. Return JSON only.
Prefer clarity and teaching value over decoration. No meaningless AI art.`;
}

export function imagePlannerUser(job, markdown) {
  return `Create an image plan for this guide.

TOPIC: ${job.topic}

MARKDOWN (excerpt):
${String(markdown).slice(0, 12000)}

Return JSON:
{
  "images": [
    {
      "id": "banner",
      "type": "BANNER",
      "section": "hero",
      "title": "",
      "purpose": "",
      "prompt": "",
      "aspectRatio": "16:9",
      "status": "planned"
    }
  ]
}

Include: banner, architecture diagram, and 2-4 phase/process diagrams only when they teach something.
Each prompt must cover: subject, purpose, composition, elements, relationships, style, perspective, color, typography if needed, aspect ratio, things to avoid.`;
}

export function generateImagePrompt({ guide, section, phase, imageType, surroundingContent }) {
  const title = guide?.title || guide?.topic || "Engineering guide";
  return [
    `Subject: ${imageType || "CONCEPT_EXPLANATION"} for "${title}"`,
    `Purpose: Teach ${section || phase || "the core concept"} clearly`,
    `Visual explanation: ${String(surroundingContent || "").slice(0, 800)}`,
    `Composition: Clean technical diagram, left-to-right or top-down hierarchy`,
    `Elements: Labeled boxes, arrows showing data/control flow, minimal icons`,
    `Relationships: Show how components connect; avoid decorative clutter`,
    `Style: Neutral zinc palette, white/light background, crisp sans-serif labels`,
    `Perspective: Flat 2D schematic`,
    `Typography: Short readable labels, no paragraphs`,
    `Aspect ratio: 16:9`,
    `Avoid: fake logos, photoreal people, neon gradients, watermark text, illegible tiny labels`,
  ].join("\n");
}
