async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.error || body.message || message;
    } catch {
      /* ignore */
    }
    throw new Error(message || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createResearchJob(payload) {
  return request("/api/research", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getResearchJob(id) {
  return request(`/api/research/${encodeURIComponent(id)}`);
}

export function getResearchResults(id) {
  return request(`/api/research/${encodeURIComponent(id)}/results`);
}

export function getGuides(params = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  if (params.q) q.set("q", params.q);
  const qs = q.toString();
  return request(`/api/guides${qs ? `?${qs}` : ""}`);
}

export function getGuide(slug) {
  return request(`/api/guides/${encodeURIComponent(slug)}`);
}

export function updateGuide(slug, payload) {
  return request(`/api/guides/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function getImagePlan(slug) {
  return request(`/api/guides/${encodeURIComponent(slug)}/image-plan`);
}

export function regenerateImagePrompt(slug, imageId) {
  return request(
    `/api/guides/${encodeURIComponent(slug)}/images/${encodeURIComponent(imageId)}/regenerate-prompt`,
    { method: "POST" },
  );
}

export function markImageGenerated(slug, imageId, payload = {}) {
  return request(
    `/api/guides/${encodeURIComponent(slug)}/images/${encodeURIComponent(imageId)}/generated`,
    { method: "POST", body: JSON.stringify(payload) },
  );
}

export function getJobs(params = {}) {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  const qs = q.toString();
  return request(`/api/jobs${qs ? `?${qs}` : ""}`);
}

export function getSettings() {
  return request("/api/settings");
}

export function updateSettings(payload) {
  return request("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function getHealth() {
  return request("/api/health");
}
