import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	RouterProvider,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import { Layout } from "@/components/Layout";
import { StatusPage } from "@/pages/StatusPage";
import { TablesPage } from "@/pages/TablesPage";
import { DocsPage } from "@/pages/DocsPage";
import { ScraperPage } from "@/pages/ScraperPage";
import "./index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const rootRoute = createRootRoute({
	component: Layout,
});

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: StatusPage,
});

const tablesIndexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/tables",
	component: TablesPage,
});

const tableRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/tables/$tableId",
	component: TablesPage,
});

const docsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/docs",
	component: DocsPage,
});

const scraperRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/scrapers/$tableId",
	component: ScraperPage,
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	tablesIndexRoute,
	tableRoute,
	docsRoute,
	scraperRoute,
]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</React.StrictMode>,
);
