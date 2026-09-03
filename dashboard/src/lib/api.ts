export type DashboardField = {
	key: string;
	label: string;
	type: "checkbox" | "text" | "number";
	flag?: string;
	required?: boolean;
	placeholder?: string;
	help?: string;
};

export type RunStats = {
	stored: number;
	fetched: number;
	scraped: number;
	failed: number;
	ticks: number;
};

export type RunLog = { t: string; stream: string; line: string };

export type AgentRun = {
	id: string;
	running: boolean;
	loop: boolean;
	pid: number | null;
	startedAt: string | null;
	stoppedAt: string | null;
	exitCode: number | null;
	argv: string[];
	params: Record<string, unknown>;
	intervalMs: number;
	stats: RunStats;
	logs: RunLog[];
	fields: DashboardField[];
	kind?: string;
	help?: string | null;
};

export type DashboardTable = {
	id: string;
	label: string;
	group: string;
	collection: string;
	cli: string;
	http: string;
	description: string;
	count?: number;
	latestAt?: string | null;
	error?: string | null;
	fields?: DashboardField[];
	run?: AgentRun;
};

export type TablePage = {
	success: boolean;
	project: string;
	database: string;
	table: DashboardTable;
	count: number;
	docs: Record<string, unknown>[];
	nextCursor: string | null;
};

async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(`/api${path}`);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(text || `HTTP ${res.status}`);
	}
	return res.json();
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
	const res = await fetch(`/api${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
	}
	return data;
}

export function fetchStatus() {
	return getJson<{
		success: boolean;
		project: string;
		database: string;
		tables: DashboardTable[];
	}>("/dashboard/status");
}

export function fetchTable(id: string, cursor?: string, limit = 25, latest = false) {
	const q = new URLSearchParams({ limit: String(limit) });
	if (cursor) q.set("cursor", cursor);
	if (latest) q.set("latest", "1");
	return getJson<TablePage>(`/dashboard/tables/${id}?${q}`);
}

export function fetchAgent(id: string) {
	return getJson<{ success: boolean; table: DashboardTable; fields: DashboardField[]; run: AgentRun }>(
		`/dashboard/agents/${id}`,
	);
}

export function startAgent(id: string, body: Record<string, unknown>) {
	return postJson<{ success: boolean; run: AgentRun }>(`/dashboard/agents/${id}/start`, body);
}

export function stopAgent(id: string) {
	return postJson<{ success: boolean; run: AgentRun }>(`/dashboard/agents/${id}/stop`);
}

export function stopAllAgents() {
	return postJson<{ success: boolean }>("/dashboard/stop-all");
}

export function sendFounderEmail(id: string, body: Record<string, unknown> = {}) {
	return postJson<{ success: boolean; id: string; to?: string; emailId?: string }>(
		`/karyam-founders/send/${encodeURIComponent(id)}`,
		body,
	);
}

export function sendFounderEmails(body: Record<string, unknown> = {}) {
	return postJson<{
		success: boolean;
		sent: number;
		failed: number;
		results: { id: string; success: boolean; error?: string }[];
	}>("/karyam-founders/send", body);
}

export function fetchAutosendStatus() {
	return getJson<{
		success: boolean;
		configured: boolean;
		fromEmail: string;
		fromName: string;
	}>("/karyam-founders/autosend");
}
