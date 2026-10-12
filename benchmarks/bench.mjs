// Times every server in servers.json for both situations.
// Usage: node benchmarks/bench.mjs [--runs 5] [--concurrency 10] [--simultaneous] [--only hono]
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(resolve(here, 'servers.json'), 'utf8'));
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const RUNS = Number(opt('runs', 5));
const CONC = Number(opt('concurrency', 10));
const SIMULTANEOUS = argv.includes('--simultaneous');
const only = opt('only', '');
const servers = cfg.servers.filter((s) => s.name.includes(only));
const { urls } = cfg;

const base = (s) => `http://localhost:${s.port}`;

async function timed(fn) {
	const t = performance.now();
	try {
		const res = await fn();
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		await res.arrayBuffer();
		return { ms: performance.now() - t };
	} catch (e) {
		return { ms: performance.now() - t, error: e.message };
	}
}

const callSingle = (s, url) => {
	const { method, path } = cfg.endpoints.single;
	return fetch(base(s) + path.replace('{url}', encodeURIComponent(url)), { method });
};
const callBulk = (s) => {
	const { method, path } = cfg.endpoints.bulk;
	return fetch(base(s) + path, {
		method,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ urls }),
	});
};

const pct = (arr, p) => {
	const a = [...arr].sort((x, y) => x - y);
	return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
};
const stats = (rs) => {
	const ok = rs.filter((r) => !r.error).map((r) => r.ms);
	return {
		ok: `${ok.length}/${rs.length}`,
		median: ok.length ? Math.round(pct(ok, 50)) : null,
		p95: ok.length ? Math.round(pct(ok, 95)) : null,
	};
};

async function benchServer(s) {
	const up = await fetch(base(s)).then(() => true, () => false);
	if (!up) return { name: s.name, error: 'not reachable' };

	await timed(() => callSingle(s, urls[0])); // warm-up (launches browser)

	// Situation 1: one request, one URL, sequential
	const s1 = [];
	for (let i = 0; i < RUNS; i++) s1.push(await timed(() => callSingle(s, urls[i % urls.length])));

	// Situation 2a: many single-URL requests in parallel
	const t2 = performance.now();
	const s2 = await Promise.all(
		Array.from({ length: CONC }, (_, i) => timed(() => callSingle(s, urls[i % urls.length])))
	);
	const s2Total = Math.round(performance.now() - t2);

	// Situation 2b: one bulk request with all URLs
	const s2b = await timed(() => callBulk(s));

	return {
		name: s.name,
		'S1 median ms': stats(s1).median,
		'S1 ok': stats(s1).ok,
		[`S2 x${CONC} wall ms`]: s2Total,
		'S2 p95 ms': stats(s2).p95,
		'S2 ok': stats(s2).ok,
		'bulk ms': s2b.error ? `ERR ${s2b.error}` : Math.round(s2b.ms),
	};
}

const rows = SIMULTANEOUS
	? await Promise.all(servers.map(benchServer))
	: await (async () => {
			const out = [];
			for (const s of servers) out.push(await benchServer(s));
			return out;
	  })();

console.log(`\nmode: ${SIMULTANEOUS ? 'all servers loaded simultaneously' : 'one server at a time'}, runs=${RUNS}, concurrency=${CONC}\n`);
console.table(rows);
