import { env, pipeline as hgpipeline } from "@huggingface/transformers";

env.useWebWorkers = false;
env.useFSCache = true;
env.useBrowserCache = false;
env.cacheDir =
	process.env.NODE_ENV === "production" ? "/tmp/hf-cache" : "./cache";

export async function createEmbeddingRecord(
	markdownContent,
	id,
	metadata = {},
	timestamp = new Date().toISOString()
) {
	// Get embedding with pooling and normalization for fixed-length vector
	const embeddingResult = await hgpipeline("embeddings", model, {
		cache_dir: "./cache",
		revision: "main",
		device: "cpu",
		dtype: "float32",
		subfolder: "onnx",
		use_external_data_format: true,
		model_file_name: "model.onnx",
	});

	// embeddingResult.data is Float32Array of vector values
	const embeddingVector = Array.from(embeddingResult.data); // Convert to plain array for storage

	return {
		id,
		content: markdownContent,
		vector: embeddingVector,
		metadata,
		timestamp,
	};
}

function chunkMarkdownByHeaders(markdown, maxChunkSize = 1000) {
	// Parse markdown into AST
	const tree = unified().use(remarkParse).parse(markdown);

	// Accumulate chunk nodes and metadata
	const chunks = [];
	let currentChunk = [];
	let currentSize = 0;

	function pushChunk() {
		if (currentChunk.length > 0) {
			const chunkRoot = { type: "root", children: currentChunk };
			const chunkMarkdown = unified().use(remarkStringify).stringify(chunkRoot);
			chunks.push(chunkMarkdown.trim());
			currentChunk = [];
			currentSize = 0;
		}
	}

	// Walk through top-level nodes grouping by size (approximate char length)
	for (const node of tree.children) {
		const nodeText = unified()
			.use(remarkStringify)
			.stringify({ type: "root", children: [node] });
		const nodeLength = nodeText.length;

		if (currentSize + nodeLength > maxChunkSize) {
			pushChunk();
		}

		currentChunk.push(node);
		currentSize += nodeLength;
	}

	// Push leftover chunk
	pushChunk();

	return chunks;
}

async function createMarkdownEmbeddingRecords(markdown, idPrefix = "chunk") {
	const chunks = chunkMarkdownByHeaders(markdown, 1000); // 1000 chars per chunk

	const embeddingRecords = [];
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const id = `${idPrefix}-${i}`;

		const embeddingRecord = await createEmbeddingRecord(chunk, id, {
			chunkIndex: i,
			totalChunks: chunks.length,
		});
		embeddingRecords.push(embeddingRecord);
	}

	return embeddingRecords;
}
