import fetch from "node-fetch";

export async function fetchUnsplash(query) {
	const res = await fetch(
		`https://api.unsplash.com/search/photos?query=${encodeURIComponent(
			query,
		)}&per_page=10&orientation=landscape`,
		{
			headers: {
				Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`,
			},
		},
	);
	const data = await res.json();
	return (data.results || []).map((img) => ({
		url: img.urls.regular,
		width: img.width,
		height: img.height,
		alt: img.alt_description || "",
		tags: img.tags?.map((t) => t.title) || [],
		likes: img.likes || 0,
		source: "unsplash",
	}));
}
