/**
 * Minimal graph runner for agent pipelines.
 *
 * Vocabulary:
 *   node   an async function (state) => patch      one step of work
 *   edge   what runs after a node                  decides the order
 *   state  one shared object                       every node reads it and returns a
 *                                                  "patch" of new values to merge in
 *
 * Edges (edges[nodeName]) can be:
 *   "next"                    always go to "next"
 *   null                      stop
 *   (state) => name | null    decide at runtime (branching / looping)
 *   parallel([a, b], "then")  run a and b at the same time, then continue at "then"
 *                             (also allowed as the return value of a function edge)
 *
 * Merging: by default a patch key overwrites the state key. For keys that several
 * nodes contribute to (like `warnings`), pass a reducer: reducers.warnings = (old, add) => [...old, ...add]
 */

export function parallel(nodes, then = null) {
	return { parallel: nodes, then };
}

export async function runGraph({
	nodes,
	edges,
	start,
	state = {},
	reducers = {},
	onStep,
	maxSteps = 50, // safety net: a buggy loop edge cannot run (and spend tokens) forever
}) {
	const trace = [];

	const merge = (patch) => {
		for (const [key, value] of Object.entries(patch || {})) {
			state[key] = reducers[key] ? reducers[key](state[key], value) : value;
		}
	};

	// Run one node against the current state, record timing, return its patch.
	async function exec(name) {
		const fn = nodes[name];
		if (!fn) throw new Error(`Graph: unknown node "${name}"`);
		const startedAt = performance.now();
		const patch = await fn(state);
		const step = { node: name, ms: Math.round(performance.now() - startedAt) };
		trace.push(step);
		onStep?.(step, state);
		return patch;
	}

	let current = start;
	let steps = 0;

	while (current) {
		if (++steps > maxSteps) throw new Error(`Graph: exceeded ${maxSteps} steps (loop?) at "${current}"`);

		const edge = edges[current];
		merge(await exec(current));

		// Work out where to go next.
		let next = typeof edge === "function" ? edge(state) : edge;

		if (next && typeof next === "object") {
			// Fan-out: all branches see the same state; their patches are merged afterwards, in order.
			const patches = await Promise.all(next.parallel.map(exec));
			patches.forEach(merge);
			next = next.then;
		}
		current = next ?? null;
	}

	return { state, trace };
}
