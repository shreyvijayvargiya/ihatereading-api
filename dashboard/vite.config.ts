import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { dashboardFirestorePlugin } from "./server/firestoreApi.js";

export default defineConfig({
	plugins: [react(), tailwindcss(), dashboardFirestorePlugin()],
	resolve: {
		alias: { "@": path.resolve(__dirname, "src") },
	},
	server: {
		port: 5173,
		open: "/",
		fs: { allow: [".."] },
		proxy: {
			"/api": {
				target: "http://127.0.0.1:3002",
				changeOrigin: true,
				rewrite: (p) => p.replace(/^\/api/, ""),
				bypass(req) {
					const url = req.url || "";
					if (
						url.startsWith("/api/dashboard/status") ||
						url.startsWith("/api/dashboard/tables/") ||
						url === "/api/dashboard" ||
						url.startsWith("/api/dashboard?")
					) {
						return url;
					}
				},
			},
		},
	},
});
