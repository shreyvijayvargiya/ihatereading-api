import autocannon from "autocannon";
import { performance } from "perf_hooks";

// Resource monitoring
const startMemory = process.memoryUsage();
const startTime = performance.now();

// Test configuration
const testConfig = {
	url: "http://localhost:3001/scrape", // Adjust port if different
	connections: 5, // Number of concurrent connections
	amount: 100, // Exactly 100 requests
	pipelining: 1, // Number of pipelined requests per connection
	requests: [
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				url: "https://dev.to/shreyvijayvargiya/build-a-custom-saas-crm-in-hours-not-months-with-this-react-nextjs-template-14pd", // Test URL - you can change this
				includeImages: true, // Disable images for faster testing
				includeCache: false, // Disable cache for testing
				timeout: 15000, // Shorter timeout for testing
				includeSemanticContent: true,
				includeLinks: true,
				extractMetadata: true,
			}),
		},
	],
};

// Run the test
console.log("🚀 Starting autocannon load test for exactly 100 requests...");
console.log(`📊 Target: ${testConfig.url}`);
console.log(`🔗 Connections: ${testConfig.connections}`);
console.log(`📝 Total requests: ${testConfig.amount}`);

const instance = autocannon(testConfig, (err, result) => {
	if (err) {
		console.error("❌ Test failed:", err);
		process.exit(1);
	}

	console.log("\n📊 Test Results:");
	console.log("================");
	console.log(`🏃‍♂️  Total Requests: ${result.requests.total}`);
	console.log(`✅ Successful: ${result.requests.average} req/sec (avg)`);
	console.log(`⏱️  Latency: ${result.latency.average}ms (avg)`);
	console.log(`📈 Throughput: ${result.throughput.average} bytes/sec (avg)`);
	console.log(`❌ Errors: ${result.errors}`);
	console.log(`⏰ Duration: ${result.duration}s`);

	// Calculate requests per second
	const rps = result.requests.total / result.duration;
	console.log(`🚀 Requests/sec: ${rps.toFixed(2)}`);

	// Final resource summary
	console.log("\n💾 Final Resource Summary:");
	logResourceUsage();

	process.exit(0);
});

// Handle process termination
process.once("SIGINT", () => {
	console.log("\n⏹️  Stopping test...");
	instance.stop();
});

// Resource monitoring function
function logResourceUsage() {
	const currentMemory = process.memoryUsage();
	const currentTime = performance.now();
	const elapsedTime = (currentTime - startTime) / 1000; // seconds

	console.log("\n💾 Resource Usage:");
	console.log(`⏱️  Elapsed Time: ${elapsedTime.toFixed(2)}s`);
	console.log(
		`🧠 RSS Memory: ${(currentMemory.rss / 1024 / 1024).toFixed(2)} MB`,
	);
	console.log(
		`💻 Heap Used: ${(currentMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`,
	);
	console.log(
		`🗑️  Heap Total: ${(currentMemory.heapTotal / 1024 / 1024).toFixed(2)} MB`,
	);
	console.log(
		`📊 External: ${(currentMemory.external / 1024 / 1024).toFixed(2)} MB`,
	);

	// Calculate memory growth
	const rssGrowth = currentMemory.rss - startMemory.rss;
	const heapGrowth = currentMemory.heapUsed - startMemory.heapUsed;
	console.log(`📈 RSS Growth: ${(rssGrowth / 1024 / 1024).toFixed(2)} MB`);
	console.log(`📈 Heap Growth: ${(heapGrowth / 1024 / 1024).toFixed(2)} MB`);
}

// Real-time progress updates with resource monitoring
instance.on("tick", (results) => {
	if (results && results.requests && results.latency) {
		console.log(
			`📊 Progress: ${results.requests.total || 0}/${
				testConfig.amount
			} requests, ${results.requests.average || 0} req/sec, ${
				results.latency.average || 0
			}ms latency`,
		);

		// Log resources every 10 requests
		if (results.requests.total % 10 === 0) {
			logResourceUsage();
		}
	}
});

instance.on("done", (results) => {
	console.log("\n🎉 Test completed!");
});
