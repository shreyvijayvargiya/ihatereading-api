/**
 * Local image generation via mlx-openai-server (Apple Silicon / MLX).
 * OpenAI-shaped POST /v1/images/generations — same client as OpenRouter, different base URL.
 *
 * Start the server: npm run mlx:images
 */

import OpenAI from "openai";

export const MLX_OPENAI_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
export const MLX_IMAGE_DEFAULT_MODEL = "local-image-generation-model";
export const MLX_IMAGE_DEFAULT_SIZE = "1024x1024";

export const MLX_IMAGE_CONFIGS = [
	"flux-schnell",
	"flux-dev",
	"flux-krea-dev",
	"flux2-klein-4b",
	"flux2-klein-9b",
];

export function mlxOpenAiBaseUrl(raw) {
	const s = String(
		raw || process.env.MLX_OPENAI_BASE_URL || MLX_OPENAI_DEFAULT_BASE_URL,
	)
		.trim()
		.replace(/\/$/, "");
	return s.endsWith("/v1") ? s : `${s}/v1`;
}

export function mlxOpenAiClient(opts = {}) {
	return new OpenAI({
		baseURL: mlxOpenAiBaseUrl(opts.baseURL),
		apiKey:
			opts.apiKey ||
			process.env.MLX_OPENAI_API_KEY?.trim() ||
			"not-needed",
		timeout: opts.timeoutMs || 180_000,
	});
}

function isConnRefused(err) {
	const msg = String(err?.message || err || "");
	const code = err?.code || err?.cause?.code;
	return (
		code === "ECONNREFUSED" ||
		/econnrefused|fetch failed|connect econnrefused/i.test(msg)
	);
}

function serverDownError(baseURL) {
	return new Error(
		`mlx-openai-server is not running at ${baseURL}. On this MacBook run: pip install mlx-openai-server && npm run mlx:images`,
	);
}

function b64ToBuffer(b64, mime = "image/png") {
	const raw = String(b64 || "").replace(/\s/g, "");
	if (!raw) throw new Error("Empty image base64 from mlx-openai-server");
	return { buffer: Buffer.from(raw, "base64"), mime };
}

function dataUrlToBuffer(dataUrl) {
	const s = String(dataUrl || "");
	const m = s.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
	if (m) return { buffer: Buffer.from(m[2], "base64"), mime: m[1] };
	throw new Error("Image URL was not a data URL");
}

async function urlToBuffer(url) {
	if (String(url).startsWith("data:")) return dataUrlToBuffer(url);
	const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
	if (!res.ok) throw new Error(`Image download HTTP ${res.status}`);
	const mime = res.headers.get("content-type") || "image/png";
	return { buffer: Buffer.from(await res.arrayBuffer()), mime };
}

async function firstImageFromOpenAiResponse(data) {
	const row = Array.isArray(data?.data) ? data.data[0] : null;
	if (!row) throw new Error("mlx-openai-server returned no image data");
	if (row.b64_json) return b64ToBuffer(row.b64_json, "image/png");
	if (row.url) {
		if (String(row.url).startsWith("data:")) return dataUrlToBuffer(row.url);
		return urlToBuffer(row.url);
	}
	throw new Error("mlx-openai-server image had neither b64_json nor url");
}

/**
 * Generate an image on the local mlx-openai-server (Flux schnell / dev / krea / klein).
 *
 * @param {{
 *   prompt: string,
 *   size?: string,
 *   model?: string,
 *   n?: number,
 *   timeoutMs?: number,
 *   baseURL?: string,
 * }} opts
 * @returns {Promise<{ buffer: Buffer, mime: string, model: string, backend: string }>}
 */
export async function generateImageUsingOpenAIServerLocally(opts = {}) {
	const prompt = String(opts.prompt || "").trim();
	if (!prompt) throw new Error("prompt is required");

	const baseURL = mlxOpenAiBaseUrl(opts.baseURL);
	const model =
		String(opts.model || process.env.MLX_IMAGE_MODEL || MLX_IMAGE_DEFAULT_MODEL).trim();
	const size = String(opts.size || process.env.MLX_IMAGE_SIZE || MLX_IMAGE_DEFAULT_SIZE);
	const n = Math.max(1, Math.min(4, Number(opts.n) || 1));
	const timeoutMs = Number(opts.timeoutMs) || 180_000;

	const body = {
		model,
		prompt,
		n,
		size,
		response_format: "b64_json",
	};

	try {
		const client = mlxOpenAiClient({ baseURL, timeoutMs });
		const response = await client.images.generate(body);
		const image = await firstImageFromOpenAiResponse(response);
		return { ...image, model, backend: "mlx-openai-server" };
	} catch (err) {
		if (isConnRefused(err)) throw serverDownError(baseURL);

		try {
			const res = await fetch(`${baseURL}/images/generations`, {
				method: "POST",
				signal: AbortSignal.timeout(timeoutMs),
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${process.env.MLX_OPENAI_API_KEY?.trim() || "not-needed"}`,
				},
				body: JSON.stringify(body),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok || data.error) {
				throw new Error(
					data.error?.message ||
						data.error ||
						`mlx-openai-server HTTP ${res.status}`,
				);
			}
			const image = await firstImageFromOpenAiResponse(data);
			return { ...image, model, backend: "mlx-openai-server" };
		} catch (fallbackErr) {
			if (isConnRefused(fallbackErr)) throw serverDownError(baseURL);
			throw fallbackErr?.message ? fallbackErr : err;
		}
	}
}

export async function pingMlxOpenAiServer(opts = {}) {
	const baseURL = mlxOpenAiBaseUrl(opts.baseURL);
	try {
		const res = await fetch(`${baseURL}/models`, {
			signal: AbortSignal.timeout(5_000),
			headers: {
				Authorization: `Bearer ${process.env.MLX_OPENAI_API_KEY?.trim() || "not-needed"}`,
			},
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			return { ok: false, baseURL, error: data.error?.message || `HTTP ${res.status}` };
		}
		return {
			ok: true,
			baseURL,
			models: Array.isArray(data.data) ? data.data.map((m) => m.id) : [],
		};
	} catch (err) {
		return {
			ok: false,
			baseURL,
			error: isConnRefused(err)
				? serverDownError(baseURL).message
				: err?.message || String(err),
		};
	}
}
