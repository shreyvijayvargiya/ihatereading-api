export default function cosineSimilarity(vecA, vecB) {
	if (!Array.isArray(vecA) || !Array.isArray(vecB)) return 0;
	if (vecA.length === 0 || vecB.length === 0) return 0;
	if (vecA.length !== vecB.length) return 0;
	const dot = vecA.reduce((acc, val, i) => acc + val * vecB[i], 0);
	const magA = Math.sqrt(vecA.reduce((acc, val) => acc + val * val, 0));
	const magB = Math.sqrt(vecB.reduce((acc, val) => acc + val * val, 0));
	if (magA === 0 || magB === 0) return 0;
	return dot / (magA * magB);
}
