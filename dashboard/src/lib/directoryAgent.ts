export type TaskSummary = {
	id: string;
	status: string;
	state: string;
	currentStep: string;
	approvalRequired: boolean;
	humanMessage: string | null;
	directoryUrl?: string;
	productName?: string;
	createdAt: string;
	updatedAt: string;
	pauseExpiresAt?: string | null;
	nextCheckAt?: string | null;
};

export type TaskCard = {
	id: string;
	type: string;
	title: string;
	message: string;
	actions: { id: string; label: string; style?: string }[];
	data?: Record<string, unknown>;
};

export type TaskLog = { ts: string; level: string; step: string; message: string };

export type TaskShot = { file: string; label: string; step: string; ts: string; url: string };

export type DirectoryTask = {
	id: string;
	status: string;
	state: string;
	currentStep: string;
	approvalRequired: boolean;
	humanMessage: string | null;
	error: string | null;
	liveSessionOpen: boolean;
	session: unknown;
	pauseExpiresAt: string | null;
	nextCheckAt: string | null;
	input: {
		directoryUrl: string;
		submissionUrl?: string;
		githubRepo?: string;
		product: {
			name: string;
			website: string;
			description: string;
			tagline?: string;
			email?: string;
			tags?: string[];
			category?: string;
			logoUrl?: string;
		};
	};
	data: {
		confirmation?: Record<string, string> | null;
		previewHash?: string;
	};
	card: TaskCard | null;
	logs: TaskLog[];
	screenshots: TaskShot[];
};

export type NewTaskInput = {
	directoryUrl: string;
	submissionUrl?: string;
	githubRepo?: string;
	product: DirectoryTask["input"]["product"];
};

const TOKEN_KEY = "da_token";

export function readAgentToken() {
	try {
		return localStorage.getItem(TOKEN_KEY) || "";
	} catch {
		return "";
	}
}

export function writeAgentToken(token: string) {
	try {
		localStorage.setItem(TOKEN_KEY, token);
	} catch {
		/* ignore */
	}
}

function authHeaders() {
	const token = readAgentToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
	const res = await fetch(path, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			...authHeaders(),
			...(opts.headers || {}),
		},
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const issues = Array.isArray(data.issues) ? data.issues.join("; ") : "";
		throw new Error(data.error || issues || res.statusText);
	}
	return data as T;
}

export function fetchTasks() {
	return request<{ tasks: TaskSummary[] }>("/api/tasks");
}

export function fetchTask(id: string) {
	return request<{ task: DirectoryTask }>(`/api/tasks/${id}`);
}

export function createTask(body: NewTaskInput) {
	return request<{ task: DirectoryTask }>("/api/tasks", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

export function taskAction(id: string, action: string, body: Record<string, unknown> = {}) {
	return request<{ task: DirectoryTask }>(`/api/tasks/${id}/${action}`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

export function eventsUrl() {
	const token = readAgentToken();
	return token ? `/api/tasks/events?token=${encodeURIComponent(token)}` : "/api/tasks/events";
}

export async function fetchAuthedBlob(url: string) {
	const res = await fetch(url, { headers: authHeaders() });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res;
}
