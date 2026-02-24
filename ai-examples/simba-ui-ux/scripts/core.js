// core.js
import fs from "fs";
import path from "path";

class BM25 {
	constructor(k1 = 1.5, b = 0.75) {
		this.k1 = k1;
		this.b = b;
		this.corpus = [];
		this.docLengths = [];
		this.avgdl = 0;
		this.idf = {};
		this.docFreqs = {};
		this.N = 0;
	}

	tokenize(text) {
		if (!text) return [];
		return text
			.toLowerCase()
			.replace(/[^\w\s]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 2);
	}

	fit(documents) {
		this.corpus = documents.map((doc) => this.tokenize(doc));
		this.N = this.corpus.length;
		if (this.N === 0) return;

		this.docLengths = this.corpus.map((doc) => doc.length);
		this.avgdl = this.docLengths.reduce((a, b) => a + b, 0) / this.N;

		// Calculate document frequencies and IDF
		for (const doc of this.corpus) {
			const seen = new Set();
			for (const word of doc) {
				if (!seen.has(word)) {
					this.docFreqs[word] = (this.docFreqs[word] || 0) + 1;
					seen.add(word);
				}
			}
		}

		for (const [word, freq] of Object.entries(this.docFreqs)) {
			this.idf[word] = Math.log((this.N - freq + 0.5) / (freq + 0.5) + 1);
		}
	}

	score(query) {
		const queryTokens = this.tokenize(query);
		const scores = [];

		for (let idx = 0; idx < this.corpus.length; idx++) {
			const doc = this.corpus[idx];
			let score = 0;
			const docLen = this.docLengths[idx];
			const termFreqs = {};

			for (const word of doc) {
				termFreqs[word] = (termFreqs[word] || 0) + 1;
			}

			for (const token of queryTokens) {
				if (this.idf[token]) {
					const tf = termFreqs[token] || 0;
					const idf = this.idf[token];
					const numerator = tf * (this.k1 + 1);
					const denominator =
						tf + this.k1 * (1 - this.b + (this.b * docLen) / this.avgdl);
					score += (idf * numerator) / denominator;
				}
			}

			scores.push([idx, score]);
		}

		return scores.sort((a, b) => b[1] - a[1]);
	}
}

export const DATA_DIR = path.join(process.cwd(), "ai-examples", "simba-ui-ux", "data");

const CSV_CONFIG = {
	product: "products.csv",
	style: "styles.csv",
	color: "colors.csv",
	chart: "charts.csv",
	landing: "landing.csv",
	ux: "ux-guidelines.csv",
	typography: "typography.csv",
	"web-interface": "web-interface.csv",
	section: "sections.csv",
};

function parseCSV(content) {
	const lines = content.split("\n").filter((line) => line.trim());
	if (lines.length === 0) return [];

	const parseLine = (line) => {
		const result = [];
		let current = "";
		let inQuotes = false;
		for (let i = 0; i < line.length; i++) {
			const char = line[i];
			if (char === '"') {
				inQuotes = !inQuotes;
			} else if (char === "," && !inQuotes) {
				result.push(current.trim());
				current = "";
			} else {
				current += char;
			}
		}
		result.push(current.trim());
		return result;
	};

	const headers = parseLine(lines[0]);
	return lines
		.slice(1)
		.map((line) => {
			const values = parseLine(line);
			return headers.reduce((obj, header, i) => {
				obj[header] = values[i] || "";
				return obj;
			}, {});
		});
}

export async function search(query, domain, maxResults = 3) {
	const filename = CSV_CONFIG[domain];
	if (!filename) throw new Error(`Invalid domain: ${domain}`);

	const filepath = path.join(DATA_DIR, filename);
	if (!fs.existsSync(filepath)) {
		return { results: [], query, domain, file: filename, count: 0 };
	}

	const content = fs.readFileSync(filepath, "utf-8");
	const data = parseCSV(content);

	const bm25 = new BM25();
	const documents = data.map((row) => Object.values(row).join(" "));
	bm25.fit(documents);

	const scores = bm25.score(query);
	const results = scores
		.slice(0, maxResults)
		.filter((s) => s[1] > 0)
		.map((s) => data[s[0]]);

	return {
		results,
		query,
		domain,
		file: filename,
		count: results.length,
	};
}

export async function searchStack(query, stack, maxResults = 5) {
	const filepath = path.join(DATA_DIR, "stacks", `${stack}.csv`);
	if (!fs.existsSync(filepath)) {
		return { results: [], query, stack, count: 0 };
	}

	const content = fs.readFileSync(filepath, "utf-8");
	const data = parseCSV(content);

	const bm25 = new BM25();
	const documents = data.map((row) => Object.values(row).join(" "));
	bm25.fit(documents);

	const scores = bm25.score(query);
	const results = scores
		.slice(0, maxResults)
		.filter((s) => s[1] > 0)
		.map((s) => data[s[0]]);

	return {
		results,
		query,
		stack,
		count: results.length,
	};
}
